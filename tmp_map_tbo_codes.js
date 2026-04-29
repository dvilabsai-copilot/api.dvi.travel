require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const codes = ['1376565','1345318','1345320','1200255','1128760','1250333','1078234','1347149','1358855','1345321','1108025','1356271','1267547'];
  const m = process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c = await mysql.createConnection({
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    database: m[5],
  });

  const placeholders = codes.map(() => '?').join(',');
  const sql = `
    SELECT
      h.hotel_id,
      h.hotel_name,
      h.hotel_code,
      h.tbo_hotel_code,
      h.hotel_city,
      h.hotel_state,
      h.hotel_country,
      h.status,
      h.deleted
    FROM dvi_hotel h
    WHERE h.deleted = 0
      AND (
        h.tbo_hotel_code IN (${placeholders})
        OR h.hotel_code IN (${placeholders})
      )
    ORDER BY h.hotel_name ASC
  `;

  const [rows] = await c.query(sql, [...codes, ...codes]);

  const matchedCodes = new Set();
  for (const r of rows) {
    if (r.tbo_hotel_code && codes.includes(String(r.tbo_hotel_code))) matchedCodes.add(String(r.tbo_hotel_code));
    if (r.hotel_code && codes.includes(String(r.hotel_code))) matchedCodes.add(String(r.hotel_code));
  }

  const missing = codes.filter((x) => !matchedCodes.has(x));

  console.log(JSON.stringify({ totalRequested: codes.length, found: rows.length, missingCount: missing.length, missing, rows }, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
