const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  const [availByDay] = await c.query(
    "SELECT DATE(received_at) AS d, source, COUNT(*) AS cnt FROM dvi_hotel_room_availability WHERE hotel_id=153 GROUP BY DATE(received_at), source ORDER BY d DESC, source"
  );
  console.log('availability by day/source:', JSON.stringify(availByDay));

  const [occByDay] = await c.query(
    "SELECT DATE(received_at) AS d, source, COUNT(*) AS cnt FROM dvi_hotel_occupancy_rate WHERE hotel_id=153 GROUP BY DATE(received_at), source ORDER BY d DESC, source"
  );
  console.log('occupancy by day/source:', JSON.stringify(occByDay));

  const [recentAvail] = await c.query(
    "SELECT room_id,start_date,end_date,free,source,received_at FROM dvi_hotel_room_availability WHERE hotel_id=153 AND DATE(received_at) >= DATE_SUB(CURDATE(), INTERVAL 2 DAY) ORDER BY received_at DESC LIMIT 30"
  );
  console.log('recent availability rows:', JSON.stringify(recentAvail));

  const [recentOcc] = await c.query(
    "SELECT room_id,rateplan_id,start_date,end_date,source,received_at FROM dvi_hotel_occupancy_rate WHERE hotel_id=153 AND DATE(received_at) >= DATE_SUB(CURDATE(), INTERVAL 2 DAY) ORDER BY received_at DESC LIMIT 30"
  );
  console.log('recent occupancy rows:', JSON.stringify(recentOcc));

  await c.end();
})().catch((e) => {
  console.error('ERR:', e.message || e);
  process.exit(1);
});
