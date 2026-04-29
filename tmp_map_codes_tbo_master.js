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
      t.tbo_hotel_code,
      t.hotel_name,
      t.city_name,
      t.tbo_city_code,
      t.star_rating,
      t.status,
      h.hotel_id AS mapped_hotel_id,
      h.hotel_name AS mapped_hotel_name,
      h.hotel_city AS mapped_hotel_city
    FROM tbo_hotel_master t
    LEFT JOIN dvi_hotel h
      ON h.tbo_hotel_code COLLATE utf8mb4_unicode_ci = t.tbo_hotel_code
      AND h.deleted = 0
    WHERE t.tbo_hotel_code IN (${placeholders})
    ORDER BY t.city_name, t.hotel_name
  `;

  const [rows] = await c.query(sql, codes);
  const foundCodes = rows.map(r => String(r.tbo_hotel_code));
  const missing = codes.filter(code => !foundCodes.includes(code));

  console.log(JSON.stringify({ totalRequested: codes.length, foundInTboMaster: rows.length, missingCount: missing.length, missing, rows }, null, 2));
  await c.end();
})();
