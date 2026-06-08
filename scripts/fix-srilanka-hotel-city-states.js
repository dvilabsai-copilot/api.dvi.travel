require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function parseDatabaseConfig() {
  const defaults = {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'dvi_main',
  };

  if (process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      return {
        host: process.env.DB_HOST || url.hostname || defaults.host,
        port: Number(process.env.DB_PORT || url.port || defaults.port),
        user: process.env.DB_USER || decodeURIComponent(url.username || defaults.user),
        password: process.env.DB_PASSWORD || decodeURIComponent(url.password || defaults.password),
        database: process.env.DB_NAME || url.pathname.replace(/^\//, '') || defaults.database,
      };
    } catch (error) {
      console.warn('Failed to parse DATABASE_URL, falling back to DB_* env vars:', error.message);
    }
  }

  return {
    host: process.env.DB_HOST || defaults.host,
    port: Number(process.env.DB_PORT || defaults.port),
    user: process.env.DB_USER || defaults.user,
    password: process.env.DB_PASSWORD || defaults.password,
    database: process.env.DB_NAME || defaults.database,
  };
}

function ensureTmpDir() {
  const dir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeText(value) {
  return String(value ?? '').trim();
}

function normalizeWhitespace(value) {
  return sanitizeText(value).replace(/\s+/g, ' ');
}

function normalizeStateName(value) {
  const aliases = new Map([
    ['western', 'western province'],
    ['southern', 'southern province'],
    ['central', 'central province'],
    ['northern', 'northern province'],
    ['eastern', 'eastern province'],
    ['north western', 'north western province'],
    ['north-western', 'north western province'],
    ['north central', 'north central province'],
    ['north-central', 'north central province'],
    ['uva', 'uva province'],
    ['sabaragamuwa', 'sabaragamuwa province'],
  ]);

  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/,+$/g, '')
    .replace(/\s+/g, ' ');

  return aliases.get(normalized) || normalized;
}

function titleCaseWords(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatProvinceName(rawStateName) {
  const normalized = normalizeStateName(rawStateName);
  if (!normalized) return '';
  return titleCaseWords(normalized);
}

function normalizeQueryText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function markdownTable(rows, columns) {
  if (!rows.length) return '_No rows_';
  const header = `| ${columns.map((column) => column.label).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => (
    `| ${columns.map((column) => {
      const value = row?.[column.key];
      const text = value === null || value === undefined || value === '' ? '' : String(value);
      return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    }).join(' | ')} |`
  ));
  return [header, divider, ...body].join('\n');
}

function buildStateMap(stateRows) {
  const map = new Map();
  for (const row of stateRows) {
    const normalized = normalizeStateName(row.name);
    if (!normalized || map.has(normalized)) continue;
    map.set(normalized, {
      id: Number(row.id),
      name: String(row.name),
    });
  }
  return map;
}

function buildGeocodeCandidates(cityRow) {
  const cityName = sanitizeText(cityRow.city_name);
  const hotelPlace = sanitizeText(cityRow.sample_hotel_place);
  const hotelName = sanitizeText(cityRow.sample_hotel_name);
  const candidates = [];
  const seen = new Set();

  function push(query, source) {
    const normalized = normalizeQueryText(query);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ query: query.trim(), source });
  }

  if (cityName) push(`${cityName}, Sri Lanka`, 'city');
  if (cityName) push(`${cityName}, LK`, 'city_short');
  if (cityName && hotelPlace) push(`${cityName}, ${hotelPlace}, Sri Lanka`, 'city_place');
  if (cityName && hotelName) push(`${hotelName}, ${cityName}, Sri Lanka`, 'hotel_name');

  return candidates;
}

function extractGoogleState(result) {
  const components = Array.isArray(result?.address_components) ? result.address_components : [];
  let countryName = '';
  let countryCode = '';
  let rawStateName = '';

  for (const component of components) {
    const types = Array.isArray(component?.types) ? component.types : [];
    if (types.includes('country')) {
      countryName = sanitizeText(component.long_name);
      countryCode = sanitizeText(component.short_name).toUpperCase();
    }
    if (types.includes('administrative_area_level_1')) {
      rawStateName = sanitizeText(component.long_name || component.short_name);
    }
  }

  const isSriLanka = countryCode === 'LK' || normalizeQueryText(countryName) === 'sri lanka';
  return {
    isSriLanka,
    rawStateName,
    reference: sanitizeText(result?.place_id || result?.formatted_address),
    displayName: sanitizeText(result?.formatted_address),
  };
}

function extractNominatimState(result) {
  const address = result?.address || {};
  const countryCode = sanitizeText(address.country_code).toLowerCase();
  const rawStateName = sanitizeText(address.state || address.region || address.province);
  return {
    isSriLanka: countryCode === 'lk',
    rawStateName,
    reference: sanitizeText(result?.osm_id || result?.place_id),
    displayName: sanitizeText(result?.display_name),
  };
}

function parseGeocodeResults(provider, rawResults) {
  const uniqueStates = new Map();
  let sawSriLankaResult = false;
  let sawNonSriLankaResult = false;

  for (const result of Array.isArray(rawResults) ? rawResults : []) {
    const parsed = provider === 'google'
      ? extractGoogleState(result)
      : extractNominatimState(result);

    if (!parsed.isSriLanka) {
      sawNonSriLankaResult = true;
      continue;
    }

    sawSriLankaResult = true;
    if (!parsed.rawStateName) continue;

    const normalizedStateName = normalizeStateName(parsed.rawStateName);
    if (!normalizedStateName || uniqueStates.has(normalizedStateName)) continue;

    uniqueStates.set(normalizedStateName, {
      normalizedStateName,
      rawStateName: parsed.rawStateName,
      displayName: parsed.displayName,
      reference: parsed.reference,
    });
  }

  return {
    sawSriLankaResult,
    sawNonSriLankaResult,
    states: Array.from(uniqueStates.values()),
  };
}

async function fetchGoogleGeocode(query, apiKey) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('region', 'lk');
  url.searchParams.set('language', 'en');

  const response = await fetch(url);
  if (!response.ok) {
    return {
      ok: false,
      message: `HTTP ${response.status}`,
    };
  }

  const body = await response.json();
  if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
    return {
      ok: false,
      message: `${body.status}${body.error_message ? `: ${body.error_message}` : ''}`,
    };
  }

  return {
    ok: true,
    rawResults: Array.isArray(body.results) ? body.results : [],
  };
}

async function fetchNominatimGeocode(query, userAgent) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'lk');
  url.searchParams.set('limit', '5');

  const response = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      'Accept-Language': 'en',
    },
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `HTTP ${response.status}`,
    };
  }

  const body = await response.json();
  return {
    ok: true,
    rawResults: Array.isArray(body) ? body : [],
  };
}

async function fetchGeocode(query, options) {
  const normalizedQuery = normalizeQueryText(query);
  if (options.cache.has(normalizedQuery)) {
    return options.cache.get(normalizedQuery);
  }

  if (options.provider === 'nominatim') {
    const elapsed = Date.now() - options.lastFetchState.lastAt;
    if (options.lastFetchState.lastAt > 0 && elapsed < options.delayMs) {
      await sleep(options.delayMs - elapsed);
    }
  }

  let result;
  try {
    result = options.provider === 'google'
      ? await fetchGoogleGeocode(query, options.googleApiKey)
      : await fetchNominatimGeocode(query, options.userAgent);
  } catch (error) {
    result = {
      ok: false,
      message: error.message,
    };
  }

  options.cache.set(normalizedQuery, result);
  options.summary.distinctQueriesCalled += 1;
  options.lastFetchState.lastAt = Date.now();
  return result;
}

async function main() {
  const dbConfig = parseDatabaseConfig();
  const sriLankaCountryId = Number(process.env.SRI_LANKA_COUNTRY_ID || 206);
  const badSriLankaStateId = Number(process.env.BAD_SRI_LANKA_STATE_ID || 4327);
  const limit = Math.max(1, Number(process.env.LIMIT || 100));
  const dryRun = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const onlyCityId = sanitizeText(process.env.ONLY_CITY_ID);
  const onlyCityName = sanitizeText(process.env.ONLY_CITY_NAME);
  const onlyHotelId = sanitizeText(process.env.ONLY_HOTEL_ID);
  const geocodeDelayMs = Math.max(1100, Number(process.env.GEOCODE_DELAY_MS || 1200));
  const googleApiKey = sanitizeText(process.env.GOOGLE_MAPS_API_KEY);
  const requestedProvider = sanitizeText(process.env.GEOCODE_PROVIDER || 'nominatim').toLowerCase();
  const nominatimUserAgent = sanitizeText(
    process.env.NOMINATIM_USER_AGENT || 'DVI-SriLanka-State-Cleanup/1.0 (contact: kiran.phpfish@gmail.com)',
  );
  let provider = 'nominatim';

  if (requestedProvider === 'google') {
    if (googleApiKey) {
      provider = 'google';
    } else {
      console.warn(
        '[SriLankaStateFix] GEOCODE_PROVIDER=google was requested, but GOOGLE_MAPS_API_KEY is empty. Falling back to nominatim.',
      );
    }
  } else if (requestedProvider !== 'nominatim') {
    console.warn(
      `[SriLankaStateFix] Unknown GEOCODE_PROVIDER="${requestedProvider}". Falling back to nominatim.`,
    );
  }

  const pool = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
  });

  const summary = {
    dryRun,
    providerUsed: provider,
    citiesScanned: 0,
    citiesResolved: 0,
    citiesUpdated: 0,
    statesInserted: 0,
    hotelsUpdated: 0,
    geocodeFailed: 0,
    geocodeAmbiguous: 0,
    distinctQueriesCalled: 0,
    remainingSriLankaBadHotels: 0,
    remainingSriLankaBadCities: 0,
  };

  const geocodeCache = new Map();
  const lastFetchState = { lastAt: 0 };
  const actionRows = [];
  const mappingRows = [];
  const insertCandidates = [];

  async function logAction(entry) {
    const row = {
      city_id: entry.city_id ?? null,
      city_name: entry.city_name ?? null,
      old_state_id: entry.old_state_id ?? null,
      new_state_id: entry.new_state_id ?? null,
      new_state_name: entry.new_state_name ?? null,
      affected_hotels: entry.affected_hotels ?? null,
      geocode_provider: entry.geocode_provider ?? provider,
      geocode_query: entry.geocode_query ?? null,
      geocode_raw_state: entry.geocode_raw_state ?? null,
      action: entry.action,
      message: entry.message ?? null,
      dry_run: dryRun ? 1 : 0,
    };

    actionRows.push(row);
    console.log(
      `[${row.action}] city_id=${row.city_id ?? ''} city_name=${row.city_name ?? ''} old_state_id=${row.old_state_id ?? ''} new_state_id=${row.new_state_id ?? ''} message=${row.message ?? ''}`,
    );

    await pool.query(
      `INSERT INTO dvi_srilanka_geo_state_fix_log (
        city_id, city_name, old_state_id, new_state_id, new_state_name,
        affected_hotels, geocode_provider, geocode_query, geocode_raw_state,
        action, message, dry_run
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.city_id,
        row.city_name,
        row.old_state_id,
        row.new_state_id,
        row.new_state_name,
        row.affected_hotels,
        row.geocode_provider,
        row.geocode_query,
        row.geocode_raw_state,
        row.action,
        row.message,
        row.dry_run,
      ],
    );
  }

  async function ensureLogTable() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS dvi_srilanka_geo_state_fix_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        city_id BIGINT NULL,
        city_name VARCHAR(255) NULL,
        old_state_id INT NULL,
        new_state_id INT NULL,
        new_state_name VARCHAR(255) NULL,
        affected_hotels INT NULL,
        geocode_provider VARCHAR(50) NULL,
        geocode_query TEXT NULL,
        geocode_raw_state VARCHAR(255) NULL,
        action VARCHAR(100) NOT NULL,
        message TEXT NULL,
        dry_run TINYINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  }

  async function createBackupsIfNeeded() {
    if (dryRun) return;

    await pool.query(
      `CREATE TABLE IF NOT EXISTS dvi_hotel_srilanka_state_4327_backup AS
       SELECT
         hotel_id,
         hotel_name,
         hotel_country,
         hotel_state,
         hotel_city,
         hotel_place,
         hotel_address,
         hotel_pincode,
         hotel_mobile
       FROM dvi_hotel
       WHERE CAST(hotel_country AS UNSIGNED) = 206
         AND CAST(hotel_state AS UNSIGNED) = 4327`,
    );

    await pool.query(
      `CREATE TABLE IF NOT EXISTS dvi_cities_srilanka_state_4327_backup AS
       SELECT *
       FROM dvi_cities
       WHERE state_id = 4327`,
    );
  }

  async function resolveStateId(rawStateName, stateByNormalizedName) {
    const normalized = normalizeStateName(rawStateName);
    if (!normalized) return null;

    const matched = stateByNormalizedName.get(normalized);
    if (matched) return matched;

    const formattedName = formatProvinceName(rawStateName);
    if (dryRun) {
      insertCandidates.push({
        normalized,
        name: formattedName,
      });
      return null;
    }

    const [existingRows] = await pool.query(
      `SELECT id, name
       FROM dvi_states
       WHERE country_id = ?
         AND deleted = 0`,
      [sriLankaCountryId],
    );

    const refreshedStateMap = buildStateMap(existingRows);
    const existing = refreshedStateMap.get(normalized);
    if (existing) {
      stateByNormalizedName.clear();
      for (const [key, value] of refreshedStateMap.entries()) stateByNormalizedName.set(key, value);
      return existing;
    }

    const [insertResult] = await pool.query(
      `INSERT INTO dvi_states (name, country_id, createdby, deleted)
       VALUES (?, ?, 0, 0)`,
      [formattedName, sriLankaCountryId],
    );

    const inserted = {
      id: Number(insertResult.insertId),
      name: formattedName,
    };
    stateByNormalizedName.set(normalized, inserted);
    summary.statesInserted += 1;
    return inserted;
  }

  try {
    await ensureLogTable();
    await createBackupsIfNeeded();

    const [stateRows] = await pool.query(
      `SELECT id, name, country_id, deleted
       FROM dvi_states
       WHERE country_id = ?
         AND deleted = 0`,
      [sriLankaCountryId],
    );
    const stateByNormalizedName = buildStateMap(stateRows);

    let citySql = `
      SELECT
        c.id AS city_id,
        c.name AS city_name,
        c.state_id AS current_city_state_id,
        COUNT(DISTINCT h.hotel_id) AS affected_hotels,
        SUBSTRING_INDEX(
          GROUP_CONCAT(DISTINCT h.hotel_name ORDER BY h.hotel_name SEPARATOR ' || '),
          ' || ',
          3
        ) AS sample_hotel_names,
        MIN(NULLIF(TRIM(h.hotel_name), '')) AS sample_hotel_name,
        MIN(NULLIF(TRIM(h.hotel_place), '')) AS sample_hotel_place,
        MIN(NULLIF(TRIM(h.hotel_address), '')) AS sample_hotel_address,
        MIN(NULLIF(TRIM(h.hotel_pincode), '')) AS sample_hotel_pincode
      FROM dvi_hotel h
      INNER JOIN dvi_cities c
        ON h.hotel_city REGEXP '^[0-9]+$'
       AND c.id = CAST(h.hotel_city AS UNSIGNED)
      LEFT JOIN dvi_states cs
        ON cs.id = c.state_id
       AND cs.country_id = ?
       AND cs.deleted = 0
      WHERE CAST(h.hotel_country AS UNSIGNED) = ?
        AND (
          CAST(h.hotel_state AS UNSIGNED) = ?
          OR c.state_id = ?
          OR c.state_id IS NULL
          OR cs.id IS NULL
        )
    `;

    const cityParams = [
      sriLankaCountryId,
      sriLankaCountryId,
      badSriLankaStateId,
      badSriLankaStateId,
    ];

    if (onlyCityId) {
      citySql += ` AND c.id = ?`;
      cityParams.push(Number(onlyCityId));
    }

    if (onlyCityName) {
      citySql += ` AND LOWER(TRIM(c.name)) = LOWER(TRIM(?))`;
      cityParams.push(onlyCityName);
    }

    if (onlyHotelId) {
      citySql += ` AND h.hotel_id = ?`;
      cityParams.push(Number(onlyHotelId));
    }

    citySql += `
      GROUP BY c.id, c.name, c.state_id
      ORDER BY affected_hotels DESC, c.name ASC
      LIMIT ?
    `;
    cityParams.push(limit);

    const [cityRows] = await pool.query(citySql, cityParams);

    for (const cityRow of cityRows) {
      summary.citiesScanned += 1;

      const candidates = buildGeocodeCandidates(cityRow);
      const uniqueStates = new Map();
      let sawGeocodeError = false;
      let sawSriLankaResult = false;
      let sawNonSriLankaResult = false;

      for (const candidate of candidates) {
        const geocodeResult = await fetchGeocode(candidate.query, {
          provider,
          googleApiKey,
          userAgent: nominatimUserAgent,
          delayMs: geocodeDelayMs,
          cache: geocodeCache,
          lastFetchState,
          summary,
        });

        if (!geocodeResult.ok) {
          sawGeocodeError = true;
          continue;
        }

        const parsed = parseGeocodeResults(provider, geocodeResult.rawResults);
        if (parsed.sawSriLankaResult) sawSriLankaResult = true;
        if (parsed.sawNonSriLankaResult) sawNonSriLankaResult = true;

        for (const state of parsed.states) {
          if (!uniqueStates.has(state.normalizedStateName)) {
            uniqueStates.set(state.normalizedStateName, state);
          }
        }
      }

      const cityId = Number(cityRow.city_id);
      const cityName = sanitizeText(cityRow.city_name);
      const oldStateId = cityRow.current_city_state_id === null ? null : Number(cityRow.current_city_state_id);
      const geocodeQuery = candidates.map((candidate) => candidate.query).join(' || ');
      const uniqueStateList = Array.from(uniqueStates.values());

      if (uniqueStateList.length > 1) {
        summary.geocodeAmbiguous += 1;
        await logAction({
          action: 'SKIPPED_GEOCODE_AMBIGUOUS',
          city_id: cityId,
          city_name: cityName,
          old_state_id: oldStateId,
          affected_hotels: Number(cityRow.affected_hotels || 0),
          geocode_query: geocodeQuery,
          geocode_raw_state: uniqueStateList.map((state) => state.rawStateName).join(' | '),
          message: `Multiple province candidates: ${uniqueStateList.map((state) => state.rawStateName).join(', ')}`,
        });
        continue;
      }

      if (uniqueStateList.length === 0) {
        if (sawNonSriLankaResult && !sawSriLankaResult) {
          await logAction({
            action: 'SKIPPED_NON_SRI_LANKA_RESULT',
            city_id: cityId,
            city_name: cityName,
            old_state_id: oldStateId,
            affected_hotels: Number(cityRow.affected_hotels || 0),
            geocode_query: geocodeQuery,
            message: 'Geocoder returned results, but none were confirmed Sri Lanka rows',
          });
        } else if (sawGeocodeError) {
          summary.geocodeFailed += 1;
          await logAction({
            action: 'SKIPPED_GEOCODE_ERROR',
            city_id: cityId,
            city_name: cityName,
            old_state_id: oldStateId,
            affected_hotels: Number(cityRow.affected_hotels || 0),
            geocode_query: geocodeQuery,
            message: 'One or more geocode calls failed and no safe province could be resolved',
          });
        } else {
          summary.geocodeFailed += 1;
          await logAction({
            action: 'SKIPPED_NO_GEOCODE_STATE',
            city_id: cityId,
            city_name: cityName,
            old_state_id: oldStateId,
            affected_hotels: Number(cityRow.affected_hotels || 0),
            geocode_query: geocodeQuery,
            message: 'No usable Sri Lanka province found from geocoding',
          });
        }
        continue;
      }

      summary.citiesResolved += 1;
      const chosenState = uniqueStateList[0];
      let resolvedState = stateByNormalizedName.get(chosenState.normalizedStateName) || null;

      if (!resolvedState) {
        await logAction({
          action: dryRun ? 'DRY_STATE_INSERT' : 'STATE_INSERTED',
          city_id: cityId,
          city_name: cityName,
          old_state_id: oldStateId,
          new_state_name: formatProvinceName(chosenState.rawStateName),
          affected_hotels: Number(cityRow.affected_hotels || 0),
          geocode_query: geocodeQuery,
          geocode_raw_state: chosenState.rawStateName,
          message: dryRun
            ? `Would insert state "${formatProvinceName(chosenState.rawStateName)}"`
            : `Inserted state "${formatProvinceName(chosenState.rawStateName)}"`,
        });

        resolvedState = await resolveStateId(chosenState.rawStateName, stateByNormalizedName);
      }

      if (!resolvedState) {
        await logAction({
          action: 'SKIPPED_STATE_NOT_RESOLVED',
          city_id: cityId,
          city_name: cityName,
          old_state_id: oldStateId,
          affected_hotels: Number(cityRow.affected_hotels || 0),
          geocode_query: geocodeQuery,
          geocode_raw_state: chosenState.rawStateName,
          message: 'State ID not resolved in dry-run because insert was not executed',
        });

        mappingRows.push({
          city_id: cityId,
          city_name: cityName,
          province: formatProvinceName(chosenState.rawStateName),
          state_id: '(would insert)',
          affected_hotels: Number(cityRow.affected_hotels || 0),
          action: 'WOULD_INSERT_STATE',
        });
        continue;
      }

      mappingRows.push({
        city_id: cityId,
        city_name: cityName,
        province: resolvedState.name,
        state_id: resolvedState.id,
        affected_hotels: Number(cityRow.affected_hotels || 0),
        action: dryRun ? 'DRY_READY' : 'READY',
      });

      if (dryRun) {
        await logAction({
          action: 'DRY_CITY_UPDATE',
          city_id: cityId,
          city_name: cityName,
          old_state_id: oldStateId,
          new_state_id: resolvedState.id,
          new_state_name: resolvedState.name,
          affected_hotels: Number(cityRow.affected_hotels || 0),
          geocode_query: geocodeQuery,
          geocode_raw_state: chosenState.rawStateName,
          message: `Would update dvi_cities.state_id to ${resolvedState.id}`,
        });

        await logAction({
          action: 'DRY_HOTEL_UPDATE',
          city_id: cityId,
          city_name: cityName,
          old_state_id: oldStateId,
          new_state_id: resolvedState.id,
          new_state_name: resolvedState.name,
          affected_hotels: Number(cityRow.affected_hotels || 0),
          geocode_query: geocodeQuery,
          geocode_raw_state: chosenState.rawStateName,
          message: `Would update Sri Lanka hotels in city ${cityId} to hotel_state ${resolvedState.id}`,
        });
        continue;
      }

      const [cityUpdateResult] = await pool.query(
        `UPDATE dvi_cities
         SET state_id = ?
         WHERE id = ?
           AND (state_id = ? OR state_id IS NULL OR state_id NOT IN (SELECT id FROM dvi_states))`,
        [resolvedState.id, cityId, badSriLankaStateId],
      );

      if (Number(cityUpdateResult.affectedRows || 0) > 0) {
        summary.citiesUpdated += 1;
      }

      await logAction({
        action: 'CITY_UPDATED',
        city_id: cityId,
        city_name: cityName,
        old_state_id: oldStateId,
        new_state_id: resolvedState.id,
        new_state_name: resolvedState.name,
        affected_hotels: Number(cityRow.affected_hotels || 0),
        geocode_query: geocodeQuery,
        geocode_raw_state: chosenState.rawStateName,
        message: `Updated dvi_cities.state_id to ${resolvedState.id}`,
      });

      const [hotelUpdateResult] = await pool.query(
        `UPDATE dvi_hotel
         SET hotel_state = ?
         WHERE CAST(hotel_country AS UNSIGNED) = ?
           AND CAST(hotel_city AS UNSIGNED) = ?
           AND (CAST(hotel_state AS UNSIGNED) = ? OR hotel_state IS NULL OR hotel_state = '')`,
        [String(resolvedState.id), sriLankaCountryId, cityId, badSriLankaStateId],
      );

      summary.hotelsUpdated += Number(hotelUpdateResult.affectedRows || 0);

      await logAction({
        action: 'HOTELS_UPDATED',
        city_id: cityId,
        city_name: cityName,
        old_state_id: oldStateId,
        new_state_id: resolvedState.id,
        new_state_name: resolvedState.name,
        affected_hotels: Number(hotelUpdateResult.affectedRows || 0),
        geocode_query: geocodeQuery,
        geocode_raw_state: chosenState.rawStateName,
        message: `Updated ${Number(hotelUpdateResult.affectedRows || 0)} hotel rows`,
      });
    }

    const [[remainingHotelsRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel h
       LEFT JOIN dvi_states s
         ON s.id = CAST(h.hotel_state AS UNSIGNED)
        AND s.country_id = CAST(h.hotel_country AS UNSIGNED)
        AND s.deleted = 0
       WHERE CAST(h.hotel_country AS UNSIGNED) = ?
         AND (
           h.hotel_state IS NULL
           OR h.hotel_state = ''
           OR h.hotel_state NOT REGEXP '^[0-9]+$'
           OR s.id IS NULL
         )`,
      [sriLankaCountryId],
    );

    const [[remainingCitiesRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_cities c
       LEFT JOIN dvi_states s
         ON s.id = c.state_id
        AND s.country_id = ?
        AND s.deleted = 0
       WHERE c.id IN (
         SELECT DISTINCT CAST(h.hotel_city AS UNSIGNED)
         FROM dvi_hotel h
         WHERE CAST(h.hotel_country AS UNSIGNED) = ?
           AND h.hotel_city REGEXP '^[0-9]+$'
       )
         AND s.id IS NULL`,
      [sriLankaCountryId, sriLankaCountryId],
    );

    summary.remainingSriLankaBadHotels = Number(remainingHotelsRow.count || 0);
    summary.remainingSriLankaBadCities = Number(remainingCitiesRow.count || 0);

    const uniqueInsertCandidates = Array.from(
      new Map(insertCandidates.map((row) => [row.normalized, row])).values(),
    ).sort((a, b) => a.name.localeCompare(b.name));

    const report = {
      generatedAt: new Date().toISOString(),
      config: {
        database: dbConfig.database,
        host: dbConfig.host,
        port: dbConfig.port,
        sriLankaCountryId,
      badSriLankaStateId,
      limit,
      dryRun,
      requestedProvider,
      providerUsed: provider,
      onlyCityId,
      onlyCityName,
        onlyHotelId,
        geocodeDelayMs: provider === 'nominatim' ? geocodeDelayMs : 0,
      },
      summary,
      mappings: mappingRows,
      statesWouldBeInserted: uniqueInsertCandidates,
    };

    const tmpDir = ensureTmpDir();
    const jsonPath = path.join(tmpDir, 'srilanka-state-fix-report.json');
    const mdPath = path.join(tmpDir, 'srilanka-state-fix-report.md');

    const markdown = [
      '# Sri Lanka State Fix Report',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## Summary',
      '',
      `- dryRun: ${summary.dryRun}`,
      `- providerUsed: ${summary.providerUsed}`,
      `- citiesScanned: ${summary.citiesScanned}`,
      `- citiesResolved: ${summary.citiesResolved}`,
      `- citiesUpdated: ${summary.citiesUpdated}`,
      `- statesInserted: ${summary.statesInserted}`,
      `- hotelsUpdated: ${summary.hotelsUpdated}`,
      `- geocodeFailed: ${summary.geocodeFailed}`,
      `- geocodeAmbiguous: ${summary.geocodeAmbiguous}`,
      `- distinctQueriesCalled: ${summary.distinctQueriesCalled}`,
      `- remainingSriLankaBadHotels: ${summary.remainingSriLankaBadHotels}`,
      `- remainingSriLankaBadCities: ${summary.remainingSriLankaBadCities}`,
      '',
      '## Top Mappings',
      '',
      markdownTable(
        [...mappingRows]
          .sort((a, b) => b.affected_hotels - a.affected_hotels || a.city_name.localeCompare(b.city_name))
          .slice(0, 25),
        [
          { key: 'city_id', label: 'city_id' },
          { key: 'city_name', label: 'city_name' },
          { key: 'province', label: 'province' },
          { key: 'state_id', label: 'state_id' },
          { key: 'affected_hotels', label: 'affected_hotels' },
          { key: 'action', label: 'action' },
        ],
      ),
      '',
      '## States Would Be Inserted',
      '',
      markdownTable(
        uniqueInsertCandidates.map((row) => ({ state_name: row.name, normalized: row.normalized })),
        [
          { key: 'state_name', label: 'state_name' },
          { key: 'normalized', label: 'normalized' },
        ],
      ),
      '',
    ].join('\n');

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, markdown);

    console.log('\nSummary');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\nTop city -> province -> state_id mappings');
    for (const row of [...mappingRows]
      .sort((a, b) => b.affected_hotels - a.affected_hotels || a.city_name.localeCompare(b.city_name))
      .slice(0, 10)) {
      console.log(`- ${row.city_name} -> ${row.province} -> ${row.state_id} (${row.affected_hotels} hotels)`);
    }

    if (uniqueInsertCandidates.length) {
      console.log('\nStates that would be inserted');
      for (const row of uniqueInsertCandidates) {
        console.log(`- ${row.name}`);
      }
    }

    console.log(`\nWrote report files to:\n- ${jsonPath}\n- ${mdPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('fix-srilanka-hotel-city-states failed:', error);
  process.exitCode = 1;
});
