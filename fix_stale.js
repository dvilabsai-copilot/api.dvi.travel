const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');

  // Show rows we're about to delete
  const [preview] = await conn.query(
    "SELECT id, rate_plan_id, date_from, date_to, occupancy_rates, source FROM dvi_hotel_occupancy_rate WHERE id IN (525, 528, 534)"
  );
  console.log('=== Rows to delete ===');
  preview.forEach(r => console.log('ID ' + r.id + ': ' + r.rate_plan_id + ' | ' + r.date_from + '->' + r.date_to + ' | ' + r.occupancy_rates + ' [' + r.source + ']'));

  // Delete the stale test rows
  const [result] = await conn.query(
    "DELETE FROM dvi_hotel_occupancy_rate WHERE id IN (525, 528, 534)"
  );
  console.log('\nDeleted ' + result.affectedRows + ' stale test rows.');

  // Also check room 190 stale row 679 (SINGLE:1, EXTRABED:1)
  const [preview2] = await conn.query(
    "SELECT id, room_id, rate_plan_id, date_from, date_to, occupancy_rates FROM dvi_hotel_occupancy_rate WHERE id = 679"
  );
  if (preview2.length) {
    console.log('\nRoom 190 stale row 679: ' + JSON.stringify(preview2[0]));
    const [r2] = await conn.query("DELETE FROM dvi_hotel_occupancy_rate WHERE id = 679");
    console.log('Deleted row 679 (' + r2.affectedRows + ' rows).');
  }

  // Verify: CP_PLAN rows still covering 2026-05-17 for room 189
  const [remaining] = await conn.query(
    "SELECT id, rate_plan_id, date_from, date_to, occupancy_rates FROM dvi_hotel_occupancy_rate WHERE hotel_id=153 AND room_id=189 AND date_from <= '2026-05-17' AND date_to >= '2026-05-17' ORDER BY rate_plan_id, id"
  );
  console.log('\n=== Remaining occupancy rows covering 2026-05-17 (room 189) ===');
  remaining.forEach(r => console.log('ID ' + r.id + ': ' + r.rate_plan_id + ' | ' + r.date_from + '->' + r.date_to + ' | ' + r.occupancy_rates));

  await conn.end();
})().catch(e=>console.error(e));
