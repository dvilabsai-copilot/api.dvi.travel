const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');

  console.log('=== Rate plans for hotel 153 ===');
  const [rp] = await conn.query('SELECT hotel_rate_plan_id, room_id, rateplan_id, rateplan_name, axisrooms_room_id, status, deleted FROM dvi_hotel_room_rate_plan WHERE hotel_id=153 AND deleted=0 AND status=1 ORDER BY room_id, rateplan_id');
  console.table(rp);

  console.log('\n=== CP_PLAN rows for room 189 covering 2026-05-17 ===');
  const [rows] = await conn.query(
    "SELECT id, hotel_id, room_id, rate_plan_id, date_from, date_to, occupancy_rates, source FROM dvi_hotel_occupancy_rate WHERE hotel_id=153 AND room_id=189 AND rate_plan_id='CP_PLAN' AND date_from <= '2026-05-17' AND date_to >= '2026-05-17' ORDER BY id"
  );
  rows.forEach(r => console.log('ID ' + r.id + ': ' + r.date_from + ' -> ' + r.date_to + ' | ' + r.source + ' | ' + r.occupancy_rates));

  await conn.end();
})().catch(e=>console.error(e));
