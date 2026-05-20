require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const [rows] = await conn.query(`
    SELECT
      h.hotel_id,
      h.hotel_name,
      h.axisrooms_property_id,
      MAX(l.received_at) AS last_sync,
      COUNT(*) AS event_count
    FROM dvi_hotel h
    JOIN axisrooms_inbound_log l
      ON l.axisrooms_property_id COLLATE utf8mb4_unicode_ci = h.axisrooms_property_id COLLATE utf8mb4_unicode_ci
    WHERE h.axisrooms_property_id IS NOT NULL
      AND (
        JSON_EXTRACT(l.payload, '$.synthetic_backfill') IS NULL
        OR JSON_EXTRACT(l.payload, '$.synthetic_backfill') = false
      )
      AND (h.deleted = 0 OR h.deleted IS NULL)
    GROUP BY h.hotel_id, h.hotel_name, h.axisrooms_property_id
    ORDER BY last_sync DESC
  `);

  console.log('real inbound mapped hotels =', rows.length);
  console.table(rows);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
