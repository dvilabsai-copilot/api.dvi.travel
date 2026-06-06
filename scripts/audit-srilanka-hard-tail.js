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

async function main() {
  const dbConfig = parseDatabaseConfig();
  const sriLankaCountryId = Number(process.env.SRI_LANKA_COUNTRY_ID || 206);

  const pool = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
  });

  try {
    await ensureManualMapTable(pool);

    const [groupedByCity] = await pool.query(
      `SELECT
         c.id AS city_id,
         c.name AS city_name,
         c.state_id AS current_city_state_id,
         cs.name AS current_city_state_name,
         COUNT(*) AS hotel_count,
         SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT h.hotel_name ORDER BY h.hotel_name SEPARATOR ' || '), ' || ', 5) AS sample_hotel_names,
         SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT NULLIF(TRIM(h.hotel_place), '') ORDER BY h.hotel_place SEPARATOR ' || '), ' || ', 5) AS sample_hotel_place,
         SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT NULLIF(TRIM(h.hotel_address), '') ORDER BY h.hotel_address SEPARATOR ' || '), ' || ', 3) AS sample_hotel_address,
         SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT NULLIF(TRIM(h.hotel_pincode), '') ORDER BY h.hotel_pincode SEPARATOR ' || '), ' || ', 5) AS sample_hotel_pincode
       FROM dvi_hotel h
       LEFT JOIN dvi_states hs
         ON hs.id = CAST(h.hotel_state AS UNSIGNED)
        AND hs.country_id = ?
        AND hs.deleted = 0
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       LEFT JOIN dvi_states cs
         ON cs.id = c.state_id
        AND cs.country_id = ?
        AND cs.deleted = 0
       WHERE CAST(h.hotel_country AS UNSIGNED) = ?
         AND (
           h.hotel_state IS NULL
           OR h.hotel_state = ''
           OR h.hotel_state NOT REGEXP '^[0-9]+$'
           OR hs.id IS NULL
           OR c.state_id IS NULL
           OR cs.id IS NULL
           OR CAST(h.hotel_state AS UNSIGNED) <> c.state_id
         )
       GROUP BY c.id, c.name, c.state_id, cs.name
       ORDER BY hotel_count DESC, city_name ASC`,
      [sriLankaCountryId, sriLankaCountryId, sriLankaCountryId],
    );

    const [remainingHotelRows] = await pool.query(
      `SELECT
         h.hotel_id,
         h.hotel_name,
         h.hotel_country,
         h.hotel_state,
         h.hotel_city,
         c.name AS city_name,
         c.state_id AS city_state_id,
         h.hotel_place,
         h.hotel_address,
         h.hotel_pincode
       FROM dvi_hotel h
       LEFT JOIN dvi_states hs
         ON hs.id = CAST(h.hotel_state AS UNSIGNED)
        AND hs.country_id = ?
        AND hs.deleted = 0
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       LEFT JOIN dvi_states cs
         ON cs.id = c.state_id
        AND cs.country_id = ?
        AND cs.deleted = 0
       WHERE CAST(h.hotel_country AS UNSIGNED) = ?
         AND (
           h.hotel_state IS NULL
           OR h.hotel_state = ''
           OR h.hotel_state NOT REGEXP '^[0-9]+$'
           OR hs.id IS NULL
           OR c.state_id IS NULL
           OR cs.id IS NULL
           OR CAST(h.hotel_state AS UNSIGNED) <> c.state_id
         )
       ORDER BY city_name ASC, h.hotel_id ASC`,
      [sriLankaCountryId, sriLankaCountryId, sriLankaCountryId],
    );

    const [logActionGroups] = await pool.query(
      `SELECT
         latest.city_id,
         latest.city_name,
         latest.action AS last_action,
         latest.geocode_raw_state,
         latest.message,
         latest.affected_hotels
       FROM dvi_srilanka_geo_state_fix_log latest
       INNER JOIN (
         SELECT city_id, MAX(id) AS max_id
         FROM dvi_srilanka_geo_state_fix_log
         WHERE city_id IS NOT NULL
         GROUP BY city_id
       ) grouped
         ON grouped.max_id = latest.id
       WHERE latest.city_id IN (
         SELECT DISTINCT CAST(h.hotel_city AS UNSIGNED)
         FROM dvi_hotel h
         LEFT JOIN dvi_states hs
           ON hs.id = CAST(h.hotel_state AS UNSIGNED)
          AND hs.country_id = ?
          AND hs.deleted = 0
         LEFT JOIN dvi_cities c
           ON h.hotel_city REGEXP '^[0-9]+$'
          AND c.id = CAST(h.hotel_city AS UNSIGNED)
         LEFT JOIN dvi_states cs
           ON cs.id = c.state_id
          AND cs.country_id = ?
          AND cs.deleted = 0
         WHERE CAST(h.hotel_country AS UNSIGNED) = ?
           AND (
             h.hotel_state IS NULL
             OR h.hotel_state = ''
             OR h.hotel_state NOT REGEXP '^[0-9]+$'
             OR hs.id IS NULL
             OR c.state_id IS NULL
             OR cs.id IS NULL
             OR CAST(h.hotel_state AS UNSIGNED) <> c.state_id
           )
       )
       ORDER BY latest.affected_hotels DESC, latest.city_name ASC`,
      [sriLankaCountryId, sriLankaCountryId, sriLankaCountryId],
    );

    const [sriLankaStates] = await pool.query(
      `SELECT id, name, country_id, deleted
       FROM dvi_states
       WHERE country_id = ?
       ORDER BY name, id`,
      [sriLankaCountryId],
    );

    const report = {
      generatedAt: new Date().toISOString(),
      config: {
        database: dbConfig.database,
        host: dbConfig.host,
        port: dbConfig.port,
        sriLankaCountryId,
      },
      counts: {
        groupedCityCount: groupedByCity.length,
        remainingHotelRows: remainingHotelRows.length,
        loggedCityCount: logActionGroups.length,
        sriLankaStateRows: sriLankaStates.length,
      },
      groupedByCity,
      remainingHotelRows,
      logActionGroups,
      sriLankaStates,
    };

    const tmpDir = ensureTmpDir();
    const jsonPath = path.join(tmpDir, 'srilanka-hard-tail-report.json');
    const mdPath = path.join(tmpDir, 'srilanka-hard-tail-report.md');

    const markdown = [
      '# Sri Lanka Hard-Tail Audit',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## Counts',
      '',
      `- groupedCityCount: ${report.counts.groupedCityCount}`,
      `- remainingHotelRows: ${report.counts.remainingHotelRows}`,
      `- loggedCityCount: ${report.counts.loggedCityCount}`,
      `- sriLankaStateRows: ${report.counts.sriLankaStateRows}`,
      '',
      '## Remaining Sri Lanka Bad Hotels Grouped By City',
      '',
      markdownTable(report.groupedByCity, [
        { key: 'city_id', label: 'city_id' },
        { key: 'city_name', label: 'city_name' },
        { key: 'current_city_state_id', label: 'current_city_state_id' },
        { key: 'current_city_state_name', label: 'current_city_state_name' },
        { key: 'hotel_count', label: 'hotel_count' },
        { key: 'sample_hotel_names', label: 'sample_hotel_names' },
        { key: 'sample_hotel_place', label: 'sample_hotel_place' },
        { key: 'sample_hotel_pincode', label: 'sample_hotel_pincode' },
      ]),
      '',
      '## Remaining Sri Lanka Bad Hotel Rows',
      '',
      markdownTable(report.remainingHotelRows, [
        { key: 'hotel_id', label: 'hotel_id' },
        { key: 'hotel_name', label: 'hotel_name' },
        { key: 'hotel_country', label: 'hotel_country' },
        { key: 'hotel_state', label: 'hotel_state' },
        { key: 'hotel_city', label: 'hotel_city' },
        { key: 'city_name', label: 'city_name' },
        { key: 'city_state_id', label: 'city_state_id' },
        { key: 'hotel_place', label: 'hotel_place' },
        { key: 'hotel_pincode', label: 'hotel_pincode' },
      ]),
      '',
      '## Last Logged Action Per Remaining City',
      '',
      markdownTable(report.logActionGroups, [
        { key: 'city_id', label: 'city_id' },
        { key: 'city_name', label: 'city_name' },
        { key: 'last_action', label: 'last_action' },
        { key: 'geocode_raw_state', label: 'geocode_raw_state' },
        { key: 'message', label: 'message' },
        { key: 'affected_hotels', label: 'affected_hotels' },
      ]),
      '',
      '## Existing Sri Lanka States',
      '',
      markdownTable(report.sriLankaStates, [
        { key: 'id', label: 'id' },
        { key: 'name', label: 'name' },
        { key: 'country_id', label: 'country_id' },
        { key: 'deleted', label: 'deleted' },
      ]),
      '',
    ].join('\n');

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, markdown);

    console.log(JSON.stringify(report, null, 2));
    console.log(`\nWrote hard-tail report to:\n- ${jsonPath}\n- ${mdPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('audit-srilanka-hard-tail failed:', error);
  process.exitCode = 1;
});
