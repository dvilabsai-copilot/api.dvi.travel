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

  const [d1] = await c.query('DESCRIBE dvi_hotel');
  const [d2] = await c.query('SHOW TABLES LIKE "%city%"');
  console.log('DESCRIBE dvi_hotel');
  console.log(JSON.stringify(d1, null, 2));
  console.log('CITY TABLES');
  console.log(JSON.stringify(d2, null, 2));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
