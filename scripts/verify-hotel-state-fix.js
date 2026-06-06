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
  const header = `| ${columns.map((c) => c.label).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => {
    return `| ${columns
      .map((c) => {
        const value = row?.[c.key];
        const text = value === null || value === undefined || value === '' ? '' : String(value);
        return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      })
      .join(' | ')} |`;
  });
  return [header, divider, ...body].join('\n');
}

async function main() {
  const badStateId = String(process.env.BAD_STATE_ID || '4222').trim();
  const dbConfig = parseDatabaseConfig();
  const pool = await mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
  });

  try {
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

    const [remainingBadRows] = await pool.query(
      `SELECT
         h.hotel_id,
         h.hotel_name,
         h.hotel_state,
         h.hotel_city,
         c.name AS city_name,
         c.state_id AS city_state_id,
         h.hotel_place,
         h.hotel_pincode
       FROM dvi_hotel h
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       WHERE h.hotel_state = ?
       ORDER BY c.name, h.hotel_name
       LIMIT 100`,
      [badStateId],
    );

    const [mismatchRows] = await pool.query(
      `SELECT
         h.hotel_id,
         h.hotel_name,
         h.hotel_state,
         hs.name AS hotel_state_name,
         h.hotel_city,
         c.name AS city_name,
         c.state_id AS city_state_id,
         cs.name AS city_state_name,
         h.hotel_pincode
       FROM dvi_hotel h
       LEFT JOIN dvi_states hs
         ON h.hotel_state REGEXP '^[0-9]+$'
        AND hs.id = CAST(h.hotel_state AS UNSIGNED)
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       LEFT JOIN dvi_states cs
         ON cs.id = c.state_id
       WHERE h.hotel_state REGEXP '^[0-9]+$'
         AND h.hotel_city REGEXP '^[0-9]+$'
         AND hs.id IS NOT NULL
         AND c.id IS NOT NULL
         AND cs.id IS NOT NULL
         AND CAST(h.hotel_state AS UNSIGNED) <> c.state_id
       LIMIT 100`,
    );

    const report = {
      generatedAt: new Date().toISOString(),
      config: {
        database: dbConfig.database,
        host: dbConfig.host,
        port: dbConfig.port,
        badStateId,
      },
      counts: {
        remainingHotelsWithBadState: Number(remainingHotelsRow.count || 0),
        remainingCitiesWithBadState: Number(remainingCitiesRow.count || 0),
      },
      remainingBadRows,
      mismatchRows,
    };

    const tmpDir = ensureTmpDir();
    const jsonPath = path.join(tmpDir, 'hotel-state-fix-verification.json');
    const mdPath = path.join(tmpDir, 'hotel-state-fix-verification.md');

    const markdown = [
      '# Hotel State Fix Verification',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## Counts',
      '',
      `- Remaining hotels with BAD_STATE_ID: ${report.counts.remainingHotelsWithBadState}`,
      `- Remaining cities with BAD_STATE_ID: ${report.counts.remainingCitiesWithBadState}`,
      '',
      '## Remaining Bad Rows',
      '',
      markdownTable(report.remainingBadRows, [
        { key: 'hotel_id', label: 'hotel_id' },
        { key: 'hotel_name', label: 'hotel_name' },
        { key: 'hotel_state', label: 'hotel_state' },
        { key: 'hotel_city', label: 'hotel_city' },
        { key: 'city_name', label: 'city_name' },
        { key: 'city_state_id', label: 'city_state_id' },
        { key: 'hotel_place', label: 'hotel_place' },
        { key: 'hotel_pincode', label: 'hotel_pincode' },
      ]),
      '',
      '## State/City Mismatch Rows',
      '',
      markdownTable(report.mismatchRows, [
        { key: 'hotel_id', label: 'hotel_id' },
        { key: 'hotel_name', label: 'hotel_name' },
        { key: 'hotel_state', label: 'hotel_state' },
        { key: 'hotel_state_name', label: 'hotel_state_name' },
        { key: 'hotel_city', label: 'hotel_city' },
        { key: 'city_name', label: 'city_name' },
        { key: 'city_state_id', label: 'city_state_id' },
        { key: 'city_state_name', label: 'city_state_name' },
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
  console.error('verify-hotel-state-fix failed:', error);
  process.exitCode = 1;
});
