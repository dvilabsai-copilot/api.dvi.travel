require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const m = process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c = await mysql.createConnection({
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    database: m[5],
  });

  const sql = `
    SELECT
      b.tbo_hotel_code,
      COALESCE(t.hotel_name, 'Unknown') AS hotel_name,
      COALESCE(t.city_name, 'Unknown') AS city_name,
      COUNT(*) AS booking_count,
      MAX(b.createdon) AS latest_seen,
      SUM(CASE WHEN b.mandatory_supplements IS NOT NULL AND JSON_LENGTH(b.mandatory_supplements) > 0 THEN 1 ELSE 0 END) AS with_mandatory_supplements,
      SUM(CASE WHEN b.rate_conditions IS NOT NULL AND JSON_LENGTH(b.rate_conditions) > 0 THEN 1 ELSE 0 END) AS with_rate_conditions
    FROM tbo_hotel_booking_confirmation b
    LEFT JOIN tbo_hotel_master t ON t.tbo_hotel_code = b.tbo_hotel_code
    WHERE b.deleted = 0
      AND (
        (b.mandatory_supplements IS NOT NULL AND JSON_LENGTH(b.mandatory_supplements) > 0)
        OR
        (b.rate_conditions IS NOT NULL AND JSON_LENGTH(b.rate_conditions) > 0)
      )
    GROUP BY b.tbo_hotel_code, t.hotel_name, t.city_name
    ORDER BY latest_seen DESC
    LIMIT 20
  `;

  const [rows] = await c.query(sql);
  console.log(JSON.stringify(rows, null, 2));
  await c.end();
})();
