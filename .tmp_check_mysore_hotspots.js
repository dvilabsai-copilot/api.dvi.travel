const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  const [rows1] = await c.execute(
    "SELECT COUNT(*) AS c FROM dvi_hotspot_place WHERE deleted=0 AND status=1 AND hotspot_location LIKE '%Mysore%'",
  );
  const [rows2] = await c.execute(
    "SELECT COUNT(*) AS c FROM dvi_hotspot_place WHERE deleted=0 AND status=1 AND hotspot_location LIKE '%Mysuru%'",
  );
  const [sample] = await c.execute(
    "SELECT hotspot_ID,hotspot_name,hotspot_location FROM dvi_hotspot_place WHERE deleted=0 AND status=1 AND (hotspot_location LIKE '%Mysore%' OR hotspot_location LIKE '%Mysuru%') LIMIT 20",
  );

  console.log('Mysore count:', rows1[0].c, 'Mysuru count:', rows2[0].c);
  console.log(sample);

  await c.end();
})();
