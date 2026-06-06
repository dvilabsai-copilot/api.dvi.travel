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

function normalizeStateName(value) {
  const aliases = new Map([
    ['orissa', 'odisha'],
    ['pondicherry', 'puducherry'],
    ['jammu and kashmir', 'jammu and kashmir'],
    ['jammu & kashmir', 'jammu and kashmir'],
    ['nct of delhi', 'delhi'],
    ['delhi ncr', 'delhi'],
  ]);

  const normalized = sanitizeText(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ');

  return aliases.get(normalized) || normalized;
}

function normalizeQueryText(value) {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function uniqueNonBlank(values) {
  return Array.from(
    new Set(
      values
        .map((value) => sanitizeText(value))
        .filter(Boolean),
    ),
  );
}

function markdownTable(rows, columns) {
  if (!rows.length) return '_No rows_';
  const header = `| ${columns.map((column) => column.label).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => {
    return `| ${columns
      .map((column) => {
        const value = row?.[column.key];
        const text = value === null || value === undefined || value === '' ? '' : String(value);
        return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      })
      .join(' | ')} |`;
  });
  return [header, divider, ...body].join('\n');
}

function buildGeocodeCandidates(row) {
  const cityName = sanitizeText(row.city_name);
  const hotelPlace = sanitizeText(row.hotel_place);
  const hotelName = sanitizeText(row.hotel_name);
  const candidates = [];
  const seen = new Set();

  function pushCandidate(query, source, trustLevel) {
    const normalized = normalizeQueryText(query);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ query: query.trim(), source, trustLevel });
  }

  if (cityName && hotelPlace && normalizeQueryText(cityName) !== normalizeQueryText(hotelPlace)) {
    pushCandidate(`${cityName}, ${hotelPlace}, India`, 'city_place', 'high');
  }

  if (cityName) {
    pushCandidate(`${cityName}, India`, 'city', 'high');
  }

  if (hotelPlace && normalizeQueryText(hotelPlace) !== normalizeQueryText(cityName)) {
    pushCandidate(`${hotelPlace}, India`, 'place', 'high');
  }

  if (hotelName && cityName) {
    pushCandidate(`${hotelName}, ${cityName}, India`, 'hotel_name', 'low');
  }

  return candidates;
}

function parseGeocodeResults(results) {
  const states = [];
  const seenStates = new Set();
  let sawResult = false;
  let sawIndiaResult = false;

  for (const result of Array.isArray(results) ? results : []) {
    sawResult = true;
    const address = result?.address || {};
    const countryCode = String(address.country_code ?? '').trim().toLowerCase();
    if (countryCode !== 'in') continue;
    sawIndiaResult = true;

    const rawStateName = sanitizeText(address.state || address.region || '');
    if (!rawStateName) continue;

    const normalizedStateName = normalizeStateName(rawStateName);
    if (!normalizedStateName || seenStates.has(normalizedStateName)) continue;
    seenStates.add(normalizedStateName);
    states.push({
      normalizedStateName,
      rawStateName,
    });
  }

  if (states.length > 1) {
    return {
      status: 'ambiguous',
      states,
      sawResult,
      sawIndiaResult,
    };
  }

  if (states.length === 1) {
    return {
      status: 'ok',
      states,
      sawResult,
      sawIndiaResult,
    };
  }

  if (sawResult && !sawIndiaResult) {
    return {
      status: 'non_india',
      states: [],
      sawResult,
      sawIndiaResult,
    };
  }

  return {
    status: 'none',
    states: [],
    sawResult,
    sawIndiaResult,
  };
}

async function fetchGeocode(query, cache, summary, delayMs, userAgent, lastFetchState) {
  if (cache.has(query)) return cache.get(query);

  const elapsed = Date.now() - lastFetchState.lastAt;
  if (lastFetchState.lastAt > 0 && elapsed < delayMs) {
    await sleep(delayMs - elapsed);
  }

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'in');

  let result;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept-Language': 'en',
      },
    });

    if (!response.ok) {
      result = {
        ok: false,
        reason: 'GEOCODE_HTTP_ERROR',
        message: `HTTP ${response.status}`,
      };
    } else {
      const body = await response.json();
      result = {
        ok: true,
        rawResults: Array.isArray(body) ? body : [],
      };
    }
  } catch (error) {
    result = {
      ok: false,
      reason: 'GEOCODE_FETCH_FAILED',
      message: error.message,
    };
  }

  cache.set(query, result);
  summary.distinctQueriesCalled += 1;
  lastFetchState.lastAt = Date.now();
  return result;
}

function buildStateMap(stateRows) {
  const map = new Map();
  for (const row of stateRows) {
    const normalized = normalizeStateName(row.name);
    if (!map.has(normalized)) {
      map.set(normalized, {
        id: Number(row.id),
        name: String(row.name),
      });
    }
  }
  return map;
}

function topCounts(rows, keyGetter, limit = 10) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyGetter(row);
    if (!key) continue;
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

async function main() {
  const dbConfig = parseDatabaseConfig();
  const badStateId = String(process.env.BAD_STATE_ID || '4222').trim();
  const limit = Math.max(1, Number(process.env.LIMIT || 200));
  const geocodeDelayMs = Math.max(1100, Number(process.env.GEOCODE_DELAY_MS || 1200));
  const dryRun = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const onlyCityId = String(process.env.ONLY_CITY_ID || '').trim();
  const onlyHotelId = String(process.env.ONLY_HOTEL_ID || '').trim();
  const onlyCityName = String(process.env.ONLY_CITY_NAME || '').trim();
  const userAgent = String(
    process.env.NOMINATIM_USER_AGENT ||
      'DVI-Hotel-State-Cleanup/1.0 (contact: kiran.phpfish@gmail.com)',
  );

  const pool = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
  });

  const summary = {
    dryRun,
    hotelsScanned: 0,
    hotelUpdateCandidates: 0,
    hotelsUpdated: 0,
    geocodeFailed: 0,
    geocodeAmbiguous: 0,
    stateNotMatchedInDb: 0,
    cityUpdateCandidates: 0,
    citiesUpdated: 0,
    citiesSkippedAmbiguous: 0,
    distinctQueriesCalled: 0,
    remainingBadHotels: 0,
    remainingBadCities: 0,
  };

  const geocodeCache = new Map();
  const cityVotes = new Map();
  const lastFetchState = { lastAt: 0 };
  const logBuffer = [];
  const failedRows = [];
  const ambiguousCityRows = [];

  async function ensureLogTable() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS dvi_hotel_city_geocode_fix_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        hotel_id BIGINT NULL,
        hotel_city VARCHAR(50) NULL,
        city_name VARCHAR(255) NULL,
        hotel_place VARCHAR(255) NULL,
        hotel_pincode VARCHAR(20) NULL,
        old_hotel_state VARCHAR(50) NULL,
        new_state_id INT NULL,
        new_state_name VARCHAR(255) NULL,
        geocode_state_name VARCHAR(255) NULL,
        geocode_query TEXT NULL,
        action VARCHAR(100) NOT NULL,
        message TEXT NULL,
        dry_run TINYINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  }

  async function logAction(entry) {
    const record = {
      hotel_id: entry.hotel_id ?? null,
      hotel_city: entry.hotel_city ?? null,
      city_name: entry.city_name ?? null,
      hotel_place: entry.hotel_place ?? null,
      hotel_pincode: entry.hotel_pincode ?? null,
      old_hotel_state: entry.old_hotel_state ?? null,
      new_state_id: entry.new_state_id ?? null,
      new_state_name: entry.new_state_name ?? null,
      geocode_state_name: entry.geocode_state_name ?? null,
      geocode_query: entry.geocode_query ?? null,
      action: entry.action,
      message: entry.message ?? null,
      dry_run: dryRun ? 1 : 0,
    };

    logBuffer.push(record);
    console.log(
      `[${record.action}] hotel_id=${record.hotel_id ?? ''} city=${record.hotel_city ?? ''} pincode=${record.hotel_pincode ?? ''} message=${record.message ?? ''}`,
    );

    await pool.query(
      `INSERT INTO dvi_hotel_city_geocode_fix_log (
        hotel_id, hotel_city, city_name, hotel_place, hotel_pincode,
        old_hotel_state, new_state_id, new_state_name,
        geocode_state_name, geocode_query,
        action, message, dry_run
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.hotel_id,
        record.hotel_city,
        record.city_name,
        record.hotel_place,
        record.hotel_pincode,
        record.old_hotel_state,
        record.new_state_id,
        record.new_state_name,
        record.geocode_state_name,
        record.geocode_query,
        record.action,
        record.message,
        record.dry_run,
      ],
    );
  }

  try {
    await ensureLogTable();

    if (!dryRun) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS dvi_hotel_4222_backup_before_city_geocode_fix AS
         SELECT hotel_id, hotel_name, hotel_state, hotel_city, hotel_pincode, hotel_place, hotel_address
         FROM dvi_hotel
         WHERE hotel_state = '4222'`,
      );

      await pool.query(
        `CREATE TABLE IF NOT EXISTS dvi_cities_4222_backup_before_city_geocode_fix AS
         SELECT *
         FROM dvi_cities
         WHERE state_id = 4222`,
      );
    }

    const [stateRows] = await pool.query(
      `SELECT id, name
       FROM dvi_states
       WHERE deleted = 0`,
    );
    const stateByNormalizedName = buildStateMap(stateRows);

    let sql = `
      SELECT
        h.hotel_id,
        h.hotel_name,
        h.hotel_state,
        h.hotel_city,
        h.hotel_place,
        h.hotel_address,
        h.hotel_pincode,
        c.name AS city_name,
        c.state_id AS city_state_id
      FROM dvi_hotel h
      INNER JOIN dvi_cities c
        ON h.hotel_city REGEXP '^[0-9]+$'
       AND c.id = CAST(h.hotel_city AS UNSIGNED)
      WHERE h.hotel_state = ?
        AND (
          c.state_id = ?
          OR h.hotel_state = ?
        )
    `;

    const params = [badStateId, Number(badStateId), badStateId];

    if (onlyCityId) {
      sql += ` AND c.id = ?`;
      params.push(Number(onlyCityId));
    }

    if (onlyHotelId) {
      sql += ` AND h.hotel_id = ?`;
      params.push(Number(onlyHotelId));
    }

    if (onlyCityName) {
      sql += ` AND LOWER(TRIM(c.name)) = LOWER(TRIM(?))`;
      params.push(onlyCityName);
    }

    sql += ` ORDER BY c.name ASC, h.hotel_id ASC LIMIT ?`;
    params.push(limit);

    const [hotels] = await pool.query(sql, params);

    for (const hotel of hotels) {
      summary.hotelsScanned += 1;

      const cityName = sanitizeText(hotel.city_name);
      const hotelPlace = sanitizeText(hotel.hotel_place);
      const hotelName = sanitizeText(hotel.hotel_name);
      const geocodeCandidates = buildGeocodeCandidates(hotel);
      const primaryStates = new Map();
      const nameStates = new Map();
      const triedQueries = [];
      let sawGeocodeError = false;
      let sawNonIndiaResult = false;
      let sawAmbiguousQuery = false;

      for (const candidate of geocodeCandidates) {
        const geocodeResult = await fetchGeocode(
          candidate.query,
          geocodeCache,
          summary,
          geocodeDelayMs,
          userAgent,
          lastFetchState,
        );

        triedQueries.push(candidate.query);

        if (!geocodeResult.ok) {
          sawGeocodeError = true;
          continue;
        }

        const parsed = parseGeocodeResults(geocodeResult.rawResults);

        if (parsed.status === 'ambiguous') {
          sawAmbiguousQuery = true;
          continue;
        }

        if (parsed.status === 'non_india') {
          sawNonIndiaResult = true;
          continue;
        }

        if (parsed.status === 'ok' && parsed.states.length === 1) {
          const state = parsed.states[0];
          if (candidate.source === 'hotel_name') {
            nameStates.set(state.normalizedStateName, state);
          } else {
            primaryStates.set(state.normalizedStateName, state);
          }
        }
      }

      const primaryStateNames = Array.from(primaryStates.keys());
      const nameStateNames = Array.from(nameStates.keys());

      let chosenState = null;
      if (primaryStateNames.length === 1) {
        chosenState = primaryStates.get(primaryStateNames[0]);
      }

      const geocodeQueryText = geocodeCandidates.map((candidate) => candidate.query).join(' || ');

      if (!chosenState) {
        const reasonParts = [];
        if (sawAmbiguousQuery || primaryStateNames.length > 1) {
          summary.geocodeAmbiguous += 1;
          reasonParts.push(
            `Primary geocode states: ${primaryStateNames.join(', ') || 'none'}`,
          );
          await logAction({
            action: 'SKIPPED_GEOCODE_AMBIGUOUS',
            hotel_id: hotel.hotel_id,
            hotel_city: hotel.hotel_city,
            city_name: cityName,
            hotel_place: hotelPlace,
            hotel_pincode: hotel.hotel_pincode,
            old_hotel_state: hotel.hotel_state,
            geocode_query: geocodeQueryText,
            message: reasonParts.join('; '),
          });
        } else if (sawGeocodeError) {
          summary.geocodeFailed += 1;
          await logAction({
            action: 'SKIPPED_GEOCODE_ERROR',
            hotel_id: hotel.hotel_id,
            hotel_city: hotel.hotel_city,
            city_name: cityName,
            hotel_place: hotelPlace,
            hotel_pincode: hotel.hotel_pincode,
            old_hotel_state: hotel.hotel_state,
            geocode_query: geocodeQueryText,
            message: 'One or more geocode requests failed',
          });
          failedRows.push({ hotel_pincode: hotel.hotel_pincode, reason: 'GEOCODE_ERROR' });
        } else if (sawNonIndiaResult && primaryStateNames.length === 0 && nameStateNames.length === 0) {
          summary.geocodeFailed += 1;
          await logAction({
            action: 'SKIPPED_NON_INDIA_RESULT',
            hotel_id: hotel.hotel_id,
            hotel_city: hotel.hotel_city,
            city_name: cityName,
            hotel_place: hotelPlace,
            hotel_pincode: hotel.hotel_pincode,
            old_hotel_state: hotel.hotel_state,
            geocode_query: geocodeQueryText,
            message: 'Geocoder returned results, but none were India rows with a usable state',
          });
          failedRows.push({ hotel_pincode: hotel.hotel_pincode, reason: 'NON_INDIA' });
        } else {
          summary.geocodeFailed += 1;
          await logAction({
            action: 'SKIPPED_NO_GEOCODE_STATE',
            hotel_id: hotel.hotel_id,
            hotel_city: hotel.hotel_city,
            city_name: cityName,
            hotel_place: hotelPlace,
            hotel_pincode: hotel.hotel_pincode,
            old_hotel_state: hotel.hotel_state,
            geocode_query: geocodeQueryText,
            message: nameStateNames.length === 1 && primaryStateNames.length === 0
              ? 'Only hotel_name query found a state; skipping without corroboration'
              : 'No reliable geocode state found',
          });
          failedRows.push({ hotel_pincode: hotel.hotel_pincode, reason: 'NO_STATE' });
        }
        continue;
      }

      const matchedState = stateByNormalizedName.get(chosenState.normalizedStateName);
      if (!matchedState) {
        summary.stateNotMatchedInDb += 1;
        await logAction({
          action: 'SKIPPED_STATE_NOT_FOUND',
          hotel_id: hotel.hotel_id,
          hotel_city: hotel.hotel_city,
          city_name: cityName,
          hotel_place: hotelPlace,
          hotel_pincode: hotel.hotel_pincode,
          old_hotel_state: hotel.hotel_state,
          geocode_state_name: chosenState.rawStateName,
          geocode_query: geocodeQueryText,
          message: `No dvi_states match for normalized state "${chosenState.normalizedStateName}"`,
        });
        continue;
      }

      summary.hotelUpdateCandidates += 1;

      if (dryRun) {
        await logAction({
          action: 'DRY_HOTEL_GEOCODE_UPDATE',
          hotel_id: hotel.hotel_id,
          hotel_city: hotel.hotel_city,
          city_name: cityName,
          hotel_place: hotelPlace,
          hotel_pincode: hotel.hotel_pincode,
          old_hotel_state: hotel.hotel_state,
          new_state_id: matchedState.id,
          new_state_name: matchedState.name,
          geocode_state_name: chosenState.rawStateName,
          geocode_query: geocodeQueryText,
          message: `Would update hotel_state to ${matchedState.id}`,
        });
      } else {
        const [updateResult] = await pool.query(
          `UPDATE dvi_hotel
           SET hotel_state = ?
           WHERE hotel_id = ?
             AND hotel_state = ?`,
          [String(matchedState.id), hotel.hotel_id, badStateId],
        );

        if (Number(updateResult.affectedRows || 0) > 0) {
          summary.hotelsUpdated += 1;
        }

        await logAction({
          action: 'HOTEL_GEOCODE_UPDATED',
          hotel_id: hotel.hotel_id,
          hotel_city: hotel.hotel_city,
          city_name: cityName,
          hotel_place: hotelPlace,
          hotel_pincode: hotel.hotel_pincode,
          old_hotel_state: hotel.hotel_state,
          new_state_id: matchedState.id,
          new_state_name: matchedState.name,
          geocode_state_name: chosenState.rawStateName,
          geocode_query: geocodeQueryText,
          message: `Updated hotel_state to ${matchedState.id}`,
        });
      }

      const cityIdRaw = sanitizeText(hotel.hotel_city);
      if (/^[0-9]+$/.test(cityIdRaw)) {
        const cityId = Number(cityIdRaw);
        if (!cityVotes.has(cityId)) cityVotes.set(cityId, new Map());
        const votes = cityVotes.get(cityId);
        votes.set(matchedState.id, Number(votes.get(matchedState.id) || 0) + 1);
      }
    }

    for (const [cityId, votes] of cityVotes.entries()) {
      const voteEntries = Array.from(votes.entries());
      if (voteEntries.length !== 1) {
        summary.citiesSkippedAmbiguous += 1;
        const message = `City ${cityId} has conflicting state votes: ${voteEntries
          .map(([stateId, count]) => `${stateId}(${count})`)
          .join(', ')}`;
        ambiguousCityRows.push({ city_id: cityId, votes: voteEntries.map(([stateId, count]) => `${stateId}(${count})`).join(', ') });
        await logAction({
          action: 'CITY_SKIPPED_AMBIGUOUS',
          hotel_city: String(cityId),
          geocode_query: null,
          message,
        });
        continue;
      }

      const [newStateId] = voteEntries[0];
      const stateMeta = stateRows.find((row) => Number(row.id) === Number(newStateId));
      summary.cityUpdateCandidates += 1;

      if (dryRun) {
        await logAction({
          action: 'DRY_CITY_GEOCODE_UPDATE',
          hotel_city: String(cityId),
          new_state_id: newStateId,
          new_state_name: stateMeta?.name ?? null,
          geocode_query: null,
          message: `Would update dvi_cities.state_id to ${newStateId}`,
        });
      } else {
        const [updateResult] = await pool.query(
          `UPDATE dvi_cities
           SET state_id = ?
           WHERE id = ?
             AND state_id = ?`,
          [newStateId, cityId, Number(badStateId)],
        );

        if (Number(updateResult.affectedRows || 0) > 0) {
          summary.citiesUpdated += 1;
        }

        await logAction({
          action: 'CITY_GEOCODE_UPDATED',
          hotel_city: String(cityId),
          new_state_id: newStateId,
          new_state_name: stateMeta?.name ?? null,
          geocode_query: null,
          message: `Updated dvi_cities.state_id to ${newStateId}`,
        });
      }
    }

    const [[remainingHotelsRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel
       WHERE hotel_state = ?`,
      [badStateId],
    );

    const [[remainingCitiesRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_cities
       WHERE state_id = ?`,
      [Number(badStateId)],
    );

    summary.remainingBadHotels = Number(remainingHotelsRow.count || 0);
    summary.remainingBadCities = Number(remainingCitiesRow.count || 0);

    const failedPincodeCounts = topCounts(failedRows, (row) => sanitizeText(row.hotel_pincode), 20);

    const report = {
      generatedAt: new Date().toISOString(),
      config: {
        database: dbConfig.database,
        host: dbConfig.host,
        port: dbConfig.port,
        badStateId,
        limit,
        geocodeDelayMs,
        dryRun,
        onlyCityId,
        onlyHotelId,
        onlyCityName,
      },
      summary,
      ambiguousCities: ambiguousCityRows,
      topFailedPincodes: failedPincodeCounts,
    };

    const tmpDir = ensureTmpDir();
    const jsonPath = path.join(tmpDir, 'hotel-city-geocode-fix-report.json');
    const mdPath = path.join(tmpDir, 'hotel-city-geocode-fix-report.md');

    const markdown = [
      '# Hotel City Geocode Fix Report',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## Summary',
      '',
      `- dryRun: ${summary.dryRun}`,
      `- hotelsScanned: ${summary.hotelsScanned}`,
      `- hotelUpdateCandidates: ${summary.hotelUpdateCandidates}`,
      `- hotelsUpdated: ${summary.hotelsUpdated}`,
      `- geocodeFailed: ${summary.geocodeFailed}`,
      `- geocodeAmbiguous: ${summary.geocodeAmbiguous}`,
      `- stateNotMatchedInDb: ${summary.stateNotMatchedInDb}`,
      `- cityUpdateCandidates: ${summary.cityUpdateCandidates}`,
      `- citiesUpdated: ${summary.citiesUpdated}`,
      `- citiesSkippedAmbiguous: ${summary.citiesSkippedAmbiguous}`,
      `- distinctQueriesCalled: ${summary.distinctQueriesCalled}`,
      `- remainingBadHotels: ${summary.remainingBadHotels}`,
      `- remainingBadCities: ${summary.remainingBadCities}`,
      '',
      '## Ambiguous Cities',
      '',
      markdownTable(report.ambiguousCities, [
        { key: 'city_id', label: 'city_id' },
        { key: 'votes', label: 'votes' },
      ]),
      '',
      '## Top Failed Pincodes',
      '',
      markdownTable(report.topFailedPincodes, [
        { key: 'key', label: 'hotel_pincode' },
        { key: 'count', label: 'count' },
      ]),
      '',
    ].join('\n');

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, markdown);

    console.log('\nSummary');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\nNotes');
    console.log('- Default mode is dry-run unless DRY_RUN=false is explicitly set.');
    console.log('- Hotel name queries are only used as corroboration, never as the sole source of truth.');
    console.log('- City rows are only updated when a single non-conflicting state wins for that city ID.');
    console.log(`- Log rows captured: ${logBuffer.length}`);
    console.log(`\nWrote report files to:\n- ${jsonPath}\n- ${mdPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('fix-hotel-state-by-city-geocode failed:', error);
  process.exitCode = 1;
});
