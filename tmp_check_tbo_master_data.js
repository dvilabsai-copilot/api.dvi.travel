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

  const [cnt] = await c.query('SELECT COUNT(*) AS c FROM tbo_hotel_master');
  const [sample] = await c.query('SELECT tbo_hotel_code, hotel_name, city_name FROM tbo_hotel_master ORDER BY id DESC LIMIT 10');
  const [likeHit] = await c.query("SELECT tbo_hotel_code, hotel_name, city_name FROM tbo_hotel_master WHERE tbo_hotel_code LIKE '13%' LIMIT 10");
  console.log(JSON.stringify({ count: cnt[0].c, sample, likeHit }, null, 2));
  await c.end();
})();
