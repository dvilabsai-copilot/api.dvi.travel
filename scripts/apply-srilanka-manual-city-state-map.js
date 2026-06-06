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

function normalizeText(value) {
  return String(value ?? '').trim();
}

async function ensureManualMapTable(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS dvi_srilanka_manual_city_state_fix_map (
      city_id BIGINT NOT NULL PRIMARY KEY,
      city_name VARCHAR(255) NOT NULL,
      state_name VARCHAR(255) NOT NULL,
      reason VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

async function createBackupsIfNeeded(pool, sriLankaCountryId, cityIds) {
  if (!cityIds.length) return;

  const hotelBackupTable = 'dvi_hotel_srilanka_manual_map_backup';
  const cityBackupTable = 'dvi_cities_srilanka_manual_map_backup';
  const cityPlaceholders = cityIds.map(() => '?').join(', ');

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${hotelBackupTable} AS
     SELECT *
     FROM dvi_hotel
     WHERE 1 = 0`,
  );

  await pool.query(
    `INSERT INTO ${hotelBackupTable}
     SELECT *
     FROM dvi_hotel
     WHERE CAST(hotel_country AS UNSIGNED) = ?
       AND hotel_city REGEXP '^[0-9]+$'
       AND CAST(hotel_city AS UNSIGNED) IN (${cityPlaceholders})
       AND hotel_id NOT IN (SELECT hotel_id FROM ${hotelBackupTable})`,
    [sriLankaCountryId, ...cityIds],
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${cityBackupTable} AS
     SELECT *
     FROM dvi_cities
     WHERE 1 = 0`,
  );

  await pool.query(
    `INSERT INTO ${cityBackupTable}
     SELECT *
     FROM dvi_cities
     WHERE id IN (${cityPlaceholders})
       AND id NOT IN (SELECT id FROM ${cityBackupTable})`,
    cityIds,
  );
}

async function fetchRemainingCounts(pool, sriLankaCountryId) {
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

  return {
    remainingSriLankaBadHotels: Number(remainingHotelsRow.count || 0),
    remainingSriLankaBadCities: Number(remainingCitiesRow.count || 0),
  };
}

async function main() {
  const dbConfig = parseDatabaseConfig();
  const sriLankaCountryId = Number(process.env.SRI_LANKA_COUNTRY_ID || 206);
  const dryRun = normalizeText(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';

  const pool = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      database: dbConfig.database,
      host: dbConfig.host,
      port: dbConfig.port,
      sriLankaCountryId,
      dryRun,
    },
    summary: {
      dryRun,
      mapRows: 0,
      cityUpdatesPlanned: 0,
      hotelUpdatesPlanned: 0,
      citiesUpdated: 0,
      hotelsUpdated: 0,
      stoppedForValidation: false,
      validationErrors: 0,
      remainingSriLankaBadHotels: 0,
      remainingSriLankaBadCities: 0,
    },
    validationErrors: [],
    mappings: [],
  };

  try {
    await ensureManualMapTable(pool);

    const [mapRows] = await pool.query(
      `SELECT city_id, city_name, state_name, reason, created_at
       FROM dvi_srilanka_manual_city_state_fix_map
       ORDER BY city_name, city_id`,
    );

    report.summary.mapRows = mapRows.length;

    if (!mapRows.length) {
      Object.assign(report.summary, await fetchRemainingCounts(pool, sriLankaCountryId));
    } else {
      for (const mapRow of mapRows) {
        const cityId = Number(mapRow.city_id);
        const expectedCityName = normalizeText(mapRow.city_name);
        const expectedStateName = normalizeText(mapRow.state_name);

        const [cityRows] = await pool.query(
          `SELECT id, name, state_id
           FROM dvi_cities
           WHERE id = ?`,
          [cityId],
        );

        if (!cityRows.length) {
          report.validationErrors.push({
            city_id: cityId,
            city_name: expectedCityName,
            state_name: expectedStateName,
            reason: 'City id not found in dvi_cities',
          });
          continue;
        }

        const actualCity = cityRows[0];
        if (normalizeText(actualCity.name) !== expectedCityName) {
          report.validationErrors.push({
            city_id: cityId,
            city_name: expectedCityName,
            actual_city_name: actualCity.name,
            state_name: expectedStateName,
            reason: 'Mapped city_name does not match dvi_cities.name',
          });
          continue;
        }

        const [stateRows] = await pool.query(
          `SELECT id, name
           FROM dvi_states
           WHERE country_id = ?
             AND deleted = 0
             AND LOWER(TRIM(name)) = LOWER(TRIM(?))`,
          [sriLankaCountryId, expectedStateName],
        );

        if (!stateRows.length) {
          report.validationErrors.push({
            city_id: cityId,
            city_name: expectedCityName,
            state_name: expectedStateName,
            reason: 'state_name not found in dvi_states for Sri Lanka',
          });
          continue;
        }

        if (stateRows.length > 1) {
          report.validationErrors.push({
            city_id: cityId,
            city_name: expectedCityName,
            state_name: expectedStateName,
            reason: 'Multiple Sri Lanka states matched state_name',
          });
          continue;
        }

        const targetState = stateRows[0];

        const [[hotelCountRow]] = await pool.query(
          `SELECT COUNT(*) AS count
           FROM dvi_hotel
           WHERE CAST(hotel_country AS UNSIGNED) = ?
             AND hotel_city REGEXP '^[0-9]+$'
             AND CAST(hotel_city AS UNSIGNED) = ?
             AND (
               hotel_state IS NULL
               OR hotel_state = ''
               OR hotel_state NOT REGEXP '^[0-9]+$'
               OR CAST(hotel_state AS UNSIGNED) <> ?
             )`,
          [sriLankaCountryId, cityId, Number(targetState.id)],
        );

        const cityNeedsUpdate = Number(actualCity.state_id || 0) !== Number(targetState.id);

        report.mappings.push({
          city_id: cityId,
          city_name: expectedCityName,
          current_city_state_id: actualCity.state_id,
          target_state_id: Number(targetState.id),
          target_state_name: targetState.name,
          reason: mapRow.reason,
          planned_city_update: cityNeedsUpdate ? 1 : 0,
          planned_hotel_updates: Number(hotelCountRow.count || 0),
        });
      }

      if (report.validationErrors.length) {
        report.summary.stoppedForValidation = true;
        report.summary.validationErrors = report.validationErrors.length;
        Object.assign(report.summary, await fetchRemainingCounts(pool, sriLankaCountryId));
      } else {
        report.summary.cityUpdatesPlanned = report.mappings.reduce(
          (sum, row) => sum + Number(row.planned_city_update || 0),
          0,
        );
        report.summary.hotelUpdatesPlanned = report.mappings.reduce(
          (sum, row) => sum + Number(row.planned_hotel_updates || 0),
          0,
        );

        if (!dryRun) {
          const cityIds = report.mappings.map((row) => Number(row.city_id));
          await createBackupsIfNeeded(pool, sriLankaCountryId, cityIds);

          for (const row of report.mappings) {
            const [cityUpdateResult] = await pool.query(
              `UPDATE dvi_cities
               SET state_id = ?
               WHERE id = ?
                 AND (state_id IS NULL OR state_id <> ?)`,
              [row.target_state_id, row.city_id, row.target_state_id],
            );

            report.summary.citiesUpdated += Number(cityUpdateResult.affectedRows || 0);

            const [hotelUpdateResult] = await pool.query(
              `UPDATE dvi_hotel
               SET hotel_state = ?
               WHERE CAST(hotel_country AS UNSIGNED) = ?
                 AND hotel_city REGEXP '^[0-9]+$'
                 AND CAST(hotel_city AS UNSIGNED) = ?
                 AND (
                   hotel_state IS NULL
                   OR hotel_state = ''
                   OR hotel_state NOT REGEXP '^[0-9]+$'
                   OR CAST(hotel_state AS UNSIGNED) <> ?
                 )`,
              [String(row.target_state_id), sriLankaCountryId, row.city_id, row.target_state_id],
            );

            report.summary.hotelsUpdated += Number(hotelUpdateResult.affectedRows || 0);
          }
        }

        Object.assign(report.summary, await fetchRemainingCounts(pool, sriLankaCountryId));
      }
    }

    const tmpDir = ensureTmpDir();
    const jsonPath = path.join(tmpDir, 'srilanka-manual-map-apply-report.json');
    const mdPath = path.join(tmpDir, 'srilanka-manual-map-apply-report.md');

    const markdown = [
      '# Sri Lanka Manual Map Apply Report',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## Summary',
      '',
      `- dryRun: ${report.summary.dryRun}`,
      `- mapRows: ${report.summary.mapRows}`,
      `- cityUpdatesPlanned: ${report.summary.cityUpdatesPlanned}`,
      `- hotelUpdatesPlanned: ${report.summary.hotelUpdatesPlanned}`,
      `- citiesUpdated: ${report.summary.citiesUpdated}`,
      `- hotelsUpdated: ${report.summary.hotelsUpdated}`,
      `- stoppedForValidation: ${report.summary.stoppedForValidation}`,
      `- validationErrors: ${report.summary.validationErrors}`,
      `- remainingSriLankaBadHotels: ${report.summary.remainingSriLankaBadHotels}`,
      `- remainingSriLankaBadCities: ${report.summary.remainingSriLankaBadCities}`,
      '',
      '## Validation Errors',
      '',
      markdownTable(report.validationErrors, [
        { key: 'city_id', label: 'city_id' },
        { key: 'city_name', label: 'city_name' },
        { key: 'actual_city_name', label: 'actual_city_name' },
        { key: 'state_name', label: 'state_name' },
        { key: 'reason', label: 'reason' },
      ]),
      '',
      '## Manual Mappings',
      '',
      markdownTable(report.mappings, [
        { key: 'city_id', label: 'city_id' },
        { key: 'city_name', label: 'city_name' },
        { key: 'current_city_state_id', label: 'current_city_state_id' },
        { key: 'target_state_id', label: 'target_state_id' },
        { key: 'target_state_name', label: 'target_state_name' },
        { key: 'planned_city_update', label: 'planned_city_update' },
        { key: 'planned_hotel_updates', label: 'planned_hotel_updates' },
        { key: 'reason', label: 'reason' },
      ]),
      '',
    ].join('\n');

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, markdown);

    console.log(JSON.stringify(report, null, 2));
    console.log(`\nWrote manual-map apply report to:\n- ${jsonPath}\n- ${mdPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('apply-srilanka-manual-city-state-map failed:', error);
  process.exitCode = 1;
});
