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

async function main() {
  const dbConfig = parseDatabaseConfig();
  const sriLankaCountryId = Number(process.env.SRI_LANKA_COUNTRY_ID || 206);

  const pool = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
  });

  try {
    const [hotelsWithStateNotFound] = await pool.query(
      `SELECT
         h.hotel_state,
         h.hotel_country,
         COUNT(*) AS cnt
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
         )
       GROUP BY h.hotel_state, h.hotel_country
       ORDER BY cnt DESC`,
      [sriLankaCountryId],
    );

    const [citiesWithStateNotFound] = await pool.query(
      `SELECT
         c.state_id,
         COUNT(*) AS cnt
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
       AND s.id IS NULL
       GROUP BY c.state_id
       ORDER BY cnt DESC`,
      [sriLankaCountryId, sriLankaCountryId],
    );

    const [sampleMismatches] = await pool.query(
      `SELECT
         h.hotel_id,
         h.hotel_name,
         h.hotel_country,
         h.hotel_state,
         hs.name AS hotel_state_name,
         h.hotel_city,
         c.name AS city_name,
         c.state_id AS city_state_id,
         cs.name AS city_state_name,
         h.hotel_place,
         h.hotel_address,
         h.hotel_pincode
       FROM dvi_hotel h
       LEFT JOIN dvi_states hs
         ON hs.id = CAST(h.hotel_state AS UNSIGNED)
        AND hs.country_id = ?
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       LEFT JOIN dvi_states cs
         ON cs.id = c.state_id
        AND cs.country_id = ?
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
       LIMIT 200`,
      [sriLankaCountryId, sriLankaCountryId, sriLankaCountryId],
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
        sriLankaHotelStateNotFoundGroups: hotelsWithStateNotFound.length,
        sriLankaCityStateNotFoundGroups: citiesWithStateNotFound.length,
        sampleMismatchRows: sampleMismatches.length,
      },
      hotelsWithStateNotFound,
      citiesWithStateNotFound,
      sampleMismatches,
    };

    const tmpDir = ensureTmpDir();
    const jsonPath = path.join(tmpDir, 'srilanka-state-fix-verification.json');
    const mdPath = path.join(tmpDir, 'srilanka-state-fix-verification.md');

    const markdown = [
      '# Sri Lanka State Fix Verification',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## Counts',
      '',
      `- sriLankaHotelStateNotFoundGroups: ${report.counts.sriLankaHotelStateNotFoundGroups}`,
      `- sriLankaCityStateNotFoundGroups: ${report.counts.sriLankaCityStateNotFoundGroups}`,
      `- sampleMismatchRows: ${report.counts.sampleMismatchRows}`,
      '',
      '## Sri Lanka Hotels With State Not Found',
      '',
      markdownTable(report.hotelsWithStateNotFound, [
        { key: 'hotel_state', label: 'hotel_state' },
        { key: 'hotel_country', label: 'hotel_country' },
        { key: 'cnt', label: 'cnt' },
      ]),
      '',
      '## Sri Lanka Cities With State Not Found',
      '',
      markdownTable(report.citiesWithStateNotFound, [
        { key: 'state_id', label: 'state_id' },
        { key: 'cnt', label: 'cnt' },
      ]),
      '',
      '## Sample Mismatches',
      '',
      markdownTable(report.sampleMismatches, [
        { key: 'hotel_id', label: 'hotel_id' },
        { key: 'hotel_name', label: 'hotel_name' },
        { key: 'hotel_state', label: 'hotel_state' },
        { key: 'hotel_state_name', label: 'hotel_state_name' },
        { key: 'hotel_city', label: 'hotel_city' },
        { key: 'city_name', label: 'city_name' },
        { key: 'city_state_id', label: 'city_state_id' },
        { key: 'city_state_name', label: 'city_state_name' },
        { key: 'hotel_place', label: 'hotel_place' },
        { key: 'hotel_pincode', label: 'hotel_pincode' },
      ]),
      '',
    ].join('\n');

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, markdown);

    console.log(JSON.stringify(report, null, 2));
    console.log(`\nWrote verification report to:\n- ${jsonPath}\n- ${mdPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('verify-srilanka-hotel-city-states failed:', error);
  process.exitCode = 1;
});
