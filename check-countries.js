require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    const m = process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
    const c = await mysql.createConnection({
      host: m[3],
      port: Number(m[4]),
      user: decodeURIComponent(m[1]),
      password: decodeURIComponent(m[2]),
      database: m[5],
    });

    // First get schema
    const [schema] = await c.query(`DESCRIBE dvi_countries`);
    console.log('dvi_countries columns:', schema.map(s => s.Field).join(', '));
    
    // Then run appropriate query
    const [rows] = await c.query(
      `SELECT * FROM dvi_countries LIMIT 5`
    );
    
    console.log('\nFirst 5 rows:');
    console.log(JSON.stringify(rows, null, 2));
    
    // Look for India and UAE
    const [specific] = await c.query(
      `SELECT id, shortname, name FROM dvi_countries WHERE shortname IN ('IN', 'AE') OR name LIKE '%ndia%' OR name LIKE '%mira%'`
    );
    
    console.log('Testing Nationalities:');
    console.log(JSON.stringify(specific, null, 2));

    await c.end();
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
