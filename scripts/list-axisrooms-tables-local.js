require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await conn.query("SHOW TABLES LIKE 'axisrooms%'");
  console.table(rows);
  await conn.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
