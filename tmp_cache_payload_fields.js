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
      quote_id,
      plan_id,
      route_id,
      hotel_code,
      provider,
      hotel_name,
      check_in_date,
      synced_at,
      CASE WHEN full_payload LIKE '%mandatorySupplements%' THEN 1 ELSE 0 END AS hasMandatorySupplementsKey,
      CASE WHEN full_payload LIKE '%supplementSummary%' THEN 1 ELSE 0 END AS hasSupplementSummaryKey,
      CASE WHEN full_payload LIKE '%rateConditions%' THEN 1 ELSE 0 END AS hasRateConditionsKey,
      CASE WHEN full_payload LIKE '%amenities%' THEN 1 ELSE 0 END AS hasAmenitiesKey,
      CASE WHEN full_payload LIKE '%inclusions%' THEN 1 ELSE 0 END AS hasInclusionsKey
    FROM dvi_itinerary_hotel_search_cache
    WHERE deleted=0
      AND (
        full_payload LIKE '%mandatorySupplements%'
        OR full_payload LIKE '%supplementSummary%'
        OR full_payload LIKE '%rateConditions%'
        OR full_payload LIKE '%amenities%'
        OR full_payload LIKE '%inclusions%'
      )
    ORDER BY synced_at DESC
    LIMIT 30
  `;

  const [rows] = await c.query(sql);
  console.log(JSON.stringify({count: rows.length, rows}, null, 2));
  await c.end();
})();
