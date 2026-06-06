require('dotenv').config();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStateName(value) {
  const aliases = new Map([
    ['orissa', 'odisha'],
    ['pondicherry', 'puducherry'],
    ['jammu and kashmir', 'jammu and kashmir'],
    ['jammu & kashmir', 'jammu and kashmir'],
    ['nct of delhi', 'delhi'],
  ]);

  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ');

  return aliases.get(normalized) || normalized;
}

function uniqueNonBlank(values) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    ),
  );
}

async function fetchPincodeInfo(pincode, cache, apiDelayMs, summary) {
  if (cache.has(pincode)) return cache.get(pincode);

  if (summary.distinctPincodesCalled > 0 && apiDelayMs > 0) {
    await sleep(apiDelayMs);
  }

  const url = `https://api.postalpincode.in/pincode/${encodeURIComponent(pincode)}`;
  let result;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      result = { ok: false, reason: 'API_HTTP_ERROR', message: `HTTP ${response.status}` };
    } else {
      const body = await response.json();
      const payload = Array.isArray(body) ? body[0] : body;
      const postOffices = Array.isArray(payload?.PostOffice) ? payload.PostOffice : [];
      const status = String(payload?.Status ?? '').trim();

      if (status.toLowerCase() !== 'success' || postOffices.length === 0) {
        result = {
          ok: false,
          reason: 'API_EMPTY',
          message: String(payload?.Message || 'No successful post office rows returned'),
        };
      } else {
        const rawStates = uniqueNonBlank(postOffices.map((row) => row?.State));
        const normalizedStates = uniqueNonBlank(rawStates.map((state) => normalizeStateName(state)));
        const districts = uniqueNonBlank(postOffices.map((row) => row?.District));

        if (normalizedStates.length !== 1) {
          result = {
            ok: false,
            reason: 'API_AMBIGUOUS',
            rawStates,
            normalizedStates,
            districts,
            message: `Expected exactly one state, got ${normalizedStates.length}`,
          };
        } else {
          result = {
            ok: true,
            apiStateName: rawStates[0] || normalizedStates[0],
            normalizedStateName: normalizedStates[0],
            apiDistrict: districts[0] || null,
            rawStates,
            districts,
          };
        }
      }
    }
  } catch (error) {
    result = { ok: false, reason: 'API_FETCH_FAILED', message: error.message };
  }

  cache.set(pincode, result);
  summary.distinctPincodesCalled += 1;
  return result;
}

async function main() {
  const dbConfig = parseDatabaseConfig();
  const badStateId = String(process.env.BAD_STATE_ID || '4222').trim();
  const limit = Math.max(1, Number(process.env.LIMIT || 5000));
  const apiDelayMs = Math.max(0, Number(process.env.API_DELAY_MS || 250));
  const dryRun = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const onlyPincode = String(process.env.ONLY_PINCODE || '').trim();
  const onlyHotelId = String(process.env.ONLY_HOTEL_ID || '').trim();

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
    apiFailed: 0,
    ambiguousPincodeStates: 0,
    stateNotMatchedInDb: 0,
    cityUpdateCandidates: 0,
    citiesUpdated: 0,
    citiesSkippedAmbiguous: 0,
    distinctPincodesCalled: 0,
    remainingBadHotels: 0,
  };

  const cityVotes = new Map();
  const pincodeCache = new Map();
  const logBuffer = [];

  async function ensureLogTable() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS dvi_hotel_pincode_state_fix_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        hotel_id BIGINT NULL,
        hotel_city VARCHAR(50) NULL,
        hotel_pincode VARCHAR(20) NULL,
        old_hotel_state VARCHAR(50) NULL,
        new_state_id INT NULL,
        new_state_name VARCHAR(255) NULL,
        api_state_name VARCHAR(255) NULL,
        api_district VARCHAR(255) NULL,
        action VARCHAR(80) NOT NULL,
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
      hotel_pincode: entry.hotel_pincode ?? null,
      old_hotel_state: entry.old_hotel_state ?? null,
      new_state_id: entry.new_state_id ?? null,
      new_state_name: entry.new_state_name ?? null,
      api_state_name: entry.api_state_name ?? null,
      api_district: entry.api_district ?? null,
      action: entry.action,
      message: entry.message ?? null,
      dry_run: dryRun ? 1 : 0,
    };

    logBuffer.push(record);
    console.log(
      `[${record.action}] hotel_id=${record.hotel_id ?? ''} pincode=${record.hotel_pincode ?? ''} city=${record.hotel_city ?? ''} message=${record.message ?? ''}`,
    );

    await pool.query(
      `INSERT INTO dvi_hotel_pincode_state_fix_log (
        hotel_id, hotel_city, hotel_pincode, old_hotel_state,
        new_state_id, new_state_name, api_state_name, api_district,
        action, message, dry_run
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.hotel_id,
        record.hotel_city,
        record.hotel_pincode,
        record.old_hotel_state,
        record.new_state_id,
        record.new_state_name,
        record.api_state_name,
        record.api_district,
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
        `CREATE TABLE IF NOT EXISTS dvi_hotel_4222_backup_before_pincode_fix AS
         SELECT hotel_id, hotel_name, hotel_state, hotel_city, hotel_pincode, hotel_place
         FROM dvi_hotel
         WHERE hotel_state = '4222'`,
      );

      await pool.query(
        `CREATE TABLE IF NOT EXISTS dvi_cities_4222_backup_before_pincode_fix AS
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

    const stateByNormalizedName = new Map();
    for (const row of stateRows) {
      const normalized = normalizeStateName(row.name);
      if (!stateByNormalizedName.has(normalized)) {
        stateByNormalizedName.set(normalized, { id: Number(row.id), name: String(row.name) });
      }
    }

    let sql = `
      SELECT
        h.hotel_id,
        h.hotel_name,
        h.hotel_state,
        h.hotel_city,
        h.hotel_pincode,
        h.hotel_place,
        c.state_id AS city_state_id
      FROM dvi_hotel h
      LEFT JOIN dvi_cities c
        ON h.hotel_city REGEXP '^[0-9]+$'
       AND c.id = CAST(h.hotel_city AS UNSIGNED)
      WHERE h.hotel_state = ?
        AND h.hotel_pincode IS NOT NULL
        AND TRIM(h.hotel_pincode) <> ''
        AND TRIM(h.hotel_pincode) REGEXP '^[0-9]{6}$'
    `;

    const params = [badStateId];

    if (onlyPincode) {
      sql += ` AND TRIM(h.hotel_pincode) = ?`;
      params.push(onlyPincode);
    }

    if (onlyHotelId) {
      sql += ` AND h.hotel_id = ?`;
      params.push(Number(onlyHotelId));
    }

    sql += ` ORDER BY TRIM(h.hotel_pincode) ASC, h.hotel_id ASC LIMIT ?`;
    params.push(limit);

    const [hotels] = await pool.query(sql, params);

    for (const hotel of hotels) {
      summary.hotelsScanned += 1;

      const pincode = String(hotel.hotel_pincode).trim();
      const apiInfo = await fetchPincodeInfo(pincode, pincodeCache, apiDelayMs, summary);

      if (!apiInfo.ok) {
        if (apiInfo.reason === 'API_AMBIGUOUS') {
          summary.ambiguousPincodeStates += 1;
          await logAction({
            action: 'SKIPPED_API_AMBIGUOUS',
            hotel_id: hotel.hotel_id,
            hotel_city: hotel.hotel_city,
            hotel_pincode: pincode,
            old_hotel_state: hotel.hotel_state,
            message: `${apiInfo.message}; states=${(apiInfo.rawStates || []).join(', ')}`,
          });
        } else {
          summary.apiFailed += 1;
          await logAction({
            action: 'SKIPPED_API_FAILED',
            hotel_id: hotel.hotel_id,
            hotel_city: hotel.hotel_city,
            hotel_pincode: pincode,
            old_hotel_state: hotel.hotel_state,
            message: apiInfo.message,
          });
        }
        continue;
      }

      const matchedState = stateByNormalizedName.get(apiInfo.normalizedStateName);
      if (!matchedState) {
        summary.stateNotMatchedInDb += 1;
        await logAction({
          action: 'SKIPPED_STATE_NOT_FOUND',
          hotel_id: hotel.hotel_id,
          hotel_city: hotel.hotel_city,
          hotel_pincode: pincode,
          old_hotel_state: hotel.hotel_state,
          api_state_name: apiInfo.apiStateName,
          api_district: apiInfo.apiDistrict,
          message: `No dvi_states match for normalized state "${apiInfo.normalizedStateName}"`,
        });
        continue;
      }

      summary.hotelUpdateCandidates += 1;

      if (dryRun) {
        await logAction({
          action: 'DRY_HOTEL_UPDATE',
          hotel_id: hotel.hotel_id,
          hotel_city: hotel.hotel_city,
          hotel_pincode: pincode,
          old_hotel_state: hotel.hotel_state,
          new_state_id: matchedState.id,
          new_state_name: matchedState.name,
          api_state_name: apiInfo.apiStateName,
          api_district: apiInfo.apiDistrict,
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
          action: 'HOTEL_UPDATED',
          hotel_id: hotel.hotel_id,
          hotel_city: hotel.hotel_city,
          hotel_pincode: pincode,
          old_hotel_state: hotel.hotel_state,
          new_state_id: matchedState.id,
          new_state_name: matchedState.name,
          api_state_name: apiInfo.apiStateName,
          api_district: apiInfo.apiDistrict,
          message: `Updated hotel_state to ${matchedState.id}`,
        });
      }

      const cityIdRaw = String(hotel.hotel_city ?? '').trim();
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
        await logAction({
          action: 'CITY_SKIPPED_AMBIGUOUS',
          message: `City ${cityId} has conflicting state votes: ${voteEntries
            .map(([stateId, count]) => `${stateId}(${count})`)
            .join(', ')}`,
          hotel_city: String(cityId),
        });
        continue;
      }

      const [newStateId] = voteEntries[0];
      const stateMeta = stateRows.find((row) => Number(row.id) === Number(newStateId));
      summary.cityUpdateCandidates += 1;

      if (dryRun) {
        await logAction({
          action: 'DRY_CITY_UPDATE',
          hotel_city: String(cityId),
          new_state_id: newStateId,
          new_state_name: stateMeta?.name ?? null,
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
          action: 'CITY_UPDATED',
          hotel_city: String(cityId),
          new_state_id: newStateId,
          new_state_name: stateMeta?.name ?? null,
          message: `Updated dvi_cities.state_id to ${newStateId}`,
        });
      }
    }

    const [[remainingRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel
       WHERE hotel_state = ?`,
      [badStateId],
    );

    summary.remainingBadHotels = Number(remainingRow.count || 0);

    console.log('\nSummary');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\nNotes');
    console.log('- Default mode is dry-run unless DRY_RUN=false is explicitly set.');
    console.log('- City rows are only updated when a single non-conflicting state wins for that city ID.');
    console.log(`- Log rows captured: ${logBuffer.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('fix-hotel-state-by-pincode failed:', error);
  process.exitCode = 1;
});
