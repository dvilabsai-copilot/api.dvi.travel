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

  const [d1] = await c.query('DESCRIBE dvi_itinerary_hotel_search_cache');
  const [d2] = await c.query('DESCRIBE tbo_hotel_booking_confirmation');
  console.log('CACHE');
  console.log(JSON.stringify(d1, null, 2));
  console.log('BOOKING');
  console.log(JSON.stringify(d2, null, 2));
  await c.end();
})();
