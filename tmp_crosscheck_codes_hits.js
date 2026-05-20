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
    `SELECT quote_id, plan_id, route_id, hotel_code, provider, hotel_name, check_in_date, check_out_date, synced_at
     FROM dvi_itinerary_hotel_search_cache
     WHERE deleted=0 AND hotel_code IN (${placeholders})
     ORDER BY synced_at DESC
     LIMIT 100`,
    codes
  );

  const [bookingHits] = await c.query(
    `SELECT itinerary_plan_ID, itinerary_route_ID, tbo_hotel_code, check_in_date, check_out_date, createdon
     FROM tbo_hotel_booking_confirmation
     WHERE deleted=0 AND tbo_hotel_code IN (${placeholders})
     ORDER BY createdon DESC
     LIMIT 100`,
    codes
  );

  console.log(JSON.stringify({ cacheHitCount: cacheHits.length, cacheHits, bookingHitCount: bookingHits.length, bookingHits }, null, 2));
  await c.end();
})();
