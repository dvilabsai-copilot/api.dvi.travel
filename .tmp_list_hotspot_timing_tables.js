const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  const [rows] = await c.execute(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='dvi_main' AND table_name LIKE '%hotspot%tim%' ORDER BY table_name",
  );
  console.log(rows);

  await c.end();
})();
