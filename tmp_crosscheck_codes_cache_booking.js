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

  const [cacheHits] = await c.query(
    `SELECT itinerary_quote_id, itinerary_plan_id, createdon, LEFT(raw_response, 500) AS preview
     FROM dvi_itinerary_hotel_search_cache
     WHERE deleted=0 AND (
       raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%') OR raw_response LIKE CONCAT('%', ?, '%')
     )
     ORDER BY createdon DESC
     LIMIT 20`,
    codes
  );

  const [tboBookingHits] = await c.query(
    `SELECT booking_id, itinerary_quote_id, hotel_code, city_code, hotel_name, createdon
     FROM tbo_hotel_booking_confirmation
     WHERE hotel_code IN (${placeholders})
     ORDER BY createdon DESC
     LIMIT 20`,
    codes
  );

  console.log(JSON.stringify({ cacheHitCount: cacheHits.length, cacheHits, tboBookingHitCount: tboBookingHits.length, tboBookingHits }, null, 2));
  await c.end();
})();
