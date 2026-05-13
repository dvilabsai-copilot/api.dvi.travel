const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
  
  const [ootypairs] = await conn.query(`
    SELECT source_location, destination_location, distance_km, travel_time 
    FROM dvi_hotspot_distance_cache
    WHERE (source_location LIKE '%Ooty%' OR destination_location LIKE '%Ooty%')
    LIMIT 20
  `);
  console.log('Ooty distance cache entries:', ootypairs.length);
  console.table(ootypairs);
  
  // Also check what route-end buffer env var is set
  const [glob] = await conn.query('SELECT * FROM dvi_global_settings WHERE status=1 AND deleted=0 LIMIT 1');
  console.log('\nGlobal settings keys:', glob[0] ? Object.keys(glob[0]).join(', ') : 'none');

  await conn.end();
})().catch(e => console.error(e));
