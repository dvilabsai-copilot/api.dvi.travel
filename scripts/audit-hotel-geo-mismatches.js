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

function numberFromRow(row, key) {
  return Number(row?.[key] ?? 0);
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
    namedPlaceholders: false,
  });

  try {
    const [[badHotelsRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel
       WHERE hotel_state = ?`,
      [badStateId],
    );

    const [[badCitiesRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_cities
       WHERE state_id = ?`,
      [Number(badStateId)],
    );

    const [[badHotelsWithPincodeRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel
       WHERE hotel_state = ?
         AND hotel_pincode IS NOT NULL
         AND TRIM(hotel_pincode) <> ''
         AND TRIM(hotel_pincode) REGEXP '^[0-9]{6}$'`,
      [badStateId],
    );

    const [groupedBadHotels] = await pool.query(
      `SELECT
         h.hotel_city,
         c.name AS city_name,
         h.hotel_pincode,
         COUNT(*) AS hotel_count
       FROM dvi_hotel h
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       WHERE h.hotel_state = ?
       GROUP BY h.hotel_city, c.name, h.hotel_pincode
       ORDER BY hotel_count DESC, c.name ASC, h.hotel_pincode ASC
       LIMIT 500`,
      [badStateId],
    );

    const [sampleBadRows] = await pool.query(
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
       ORDER BY h.hotel_id ASC
       LIMIT 100`,
      [badStateId],
    );

    const [[nonNumericStateRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel
       WHERE hotel_state IS NOT NULL
         AND TRIM(hotel_state) <> ''
         AND TRIM(hotel_state) NOT REGEXP '^[0-9]+$'`,
    );

    const [[nonNumericCityRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel
       WHERE hotel_city IS NOT NULL
         AND TRIM(hotel_city) <> ''
         AND TRIM(hotel_city) NOT REGEXP '^[0-9]+$'`,
    );

    const [[missingStateRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel h
       LEFT JOIN dvi_states s
         ON h.hotel_state REGEXP '^[0-9]+$'
        AND s.id = CAST(h.hotel_state AS UNSIGNED)
        AND s.deleted = 0
       WHERE h.hotel_state IS NOT NULL
         AND TRIM(h.hotel_state) <> ''
         AND h.hotel_state REGEXP '^[0-9]+$'
         AND s.id IS NULL`,
    );

    const [[missingCityRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel h
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       WHERE h.hotel_city IS NOT NULL
         AND TRIM(h.hotel_city) <> ''
         AND h.hotel_city REGEXP '^[0-9]+$'
         AND c.id IS NULL`,
    );

    const [[missingCityStateRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel h
       JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       LEFT JOIN dvi_states s
         ON s.id = c.state_id
        AND s.deleted = 0
       WHERE s.id IS NULL`,
    );

    const [[mismatchRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM dvi_hotel h
       JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       WHERE h.hotel_state REGEXP '^[0-9]+$'
         AND CAST(h.hotel_state AS UNSIGNED) <> c.state_id`,
    );

    const [mismatchSample] = await pool.query(
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
        AND hs.deleted = 0
       LEFT JOIN dvi_cities c
         ON h.hotel_city REGEXP '^[0-9]+$'
        AND c.id = CAST(h.hotel_city AS UNSIGNED)
       LEFT JOIN dvi_states cs
         ON cs.id = c.state_id
        AND cs.deleted = 0
       WHERE h.hotel_state REGEXP '^[0-9]+$'
         AND h.hotel_city REGEXP '^[0-9]+$'
         AND c.id IS NOT NULL
         AND CAST(h.hotel_state AS UNSIGNED) <> c.state_id
       ORDER BY h.hotel_id ASC
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
        hotelsWithBadState: numberFromRow(badHotelsRow, 'count'),
        citiesWithBadState: numberFromRow(badCitiesRow, 'count'),
        hotelsWithBadStateAndValidPincode: numberFromRow(badHotelsWithPincodeRow, 'count'),
      },
      anomalyCounts: {
        hotelsWithNonNumericState: numberFromRow(nonNumericStateRow, 'count'),
        hotelsWithNonNumericCity: numberFromRow(nonNumericCityRow, 'count'),
        hotelsWithStateIdMissingInStates: numberFromRow(missingStateRow, 'count'),
        hotelsWithCityIdMissingInCities: numberFromRow(missingCityRow, 'count'),
        hotelsWhereCityStateIdMissingInStates: numberFromRow(missingCityStateRow, 'count'),
        hotelsWhereStateDoesNotMatchCityState: numberFromRow(mismatchRow, 'count'),
      },
      groupedBadHotels,
      sampleBadRows,
      mismatchSample,
    };

    const tmpDir = ensureTmpDir();
    const jsonPath = path.join(tmpDir, 'hotel-geo-audit-report.json');
    const mdPath = path.join(tmpDir, 'hotel-geo-audit-report.md');

    const markdown = [
      '# Hotel Geo Audit Report',
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## Config',
      '',
      `- Database: ${report.config.database}`,
      `- Host: ${report.config.host}:${report.config.port}`,
      `- BAD_STATE_ID: ${report.config.badStateId}`,
      '',
      '## Core Counts',
      '',
      `- Hotels with bad state: ${report.counts.hotelsWithBadState}`,
      `- Cities with bad state: ${report.counts.citiesWithBadState}`,
      `- Bad-state hotels with valid 6-digit pincode: ${report.counts.hotelsWithBadStateAndValidPincode}`,
      '',
      '## Anomaly Counts',
      '',
      `- Hotels with non-numeric state: ${report.anomalyCounts.hotelsWithNonNumericState}`,
      `- Hotels with non-numeric city: ${report.anomalyCounts.hotelsWithNonNumericCity}`,
      `- Hotels whose state ID does not exist in dvi_states: ${report.anomalyCounts.hotelsWithStateIdMissingInStates}`,
      `- Hotels whose city ID does not exist in dvi_cities: ${report.anomalyCounts.hotelsWithCityIdMissingInCities}`,
      `- Hotels whose city exists but city.state_id does not exist in dvi_states: ${report.anomalyCounts.hotelsWhereCityStateIdMissingInStates}`,
      `- Hotels whose hotel_state does not match city.state_id: ${report.anomalyCounts.hotelsWhereStateDoesNotMatchCityState}`,
      '',
      '## Grouped Bad Hotels',
      '',
      markdownTable(report.groupedBadHotels, [
        { key: 'hotel_city', label: 'hotel_city' },
        { key: 'city_name', label: 'city_name' },
        { key: 'hotel_pincode', label: 'hotel_pincode' },
        { key: 'hotel_count', label: 'hotel_count' },
      ]),
      '',
      '## Sample Bad Rows',
      '',
      markdownTable(report.sampleBadRows, [
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
      '## Sample State/City Mismatches',
      '',
      markdownTable(report.mismatchSample, [
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
    console.log(`\nWrote audit report to:\n- ${jsonPath}\n- ${mdPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('audit-hotel-geo-mismatches failed:', error);
  process.exitCode = 1;
});
