const mysql = require('mysql2/promise');

async function run() {
  const url = process.env.PROD_DATABASE_URL;
  if (!url) throw new Error('Missing PROD_DATABASE_URL');
  const conn = await mysql.createConnection(url);
  try {
    const [rows] = await conn.query("SHOW TABLES LIKE 'dvi_hotel%'");
    const tables = rows.map((r) => Object.values(r)[0]);
    console.log(JSON.stringify(tables, null, 2));
  } finally {
    await conn.end();
  }
}

run().catch((e) => {
  console.error('list-prod-tables failed:', e.message || e);
  process.exit(1);
});
