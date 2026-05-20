const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  const input = '2026-05-13T00:00:00+05:30';
  const routeDate = new Date(input);
  const dateOnly = new Date(routeDate.toISOString().split('T')[0]);

  console.log('input:', input);
  console.log('routeDateUtc:', routeDate.toISOString());
  console.log('dateOnlyUsedByService:', dateOnly.toISOString());

  const [avail] = await c.query(
    'SELECT room_id,start_date,end_date,free,source FROM dvi_hotel_room_availability WHERE hotel_id=153 AND start_date<=? AND end_date>=? ORDER BY room_id,start_date',
    [dateOnly, dateOnly],
  );
  console.log('availabilityRowsForUsedDate:', JSON.stringify(avail));

  const [occ] = await c.query(
    "SELECT room_id,rateplan_id,start_date,end_date,source FROM dvi_hotel_occupancy_rate WHERE hotel_id=153 AND source='axisrooms' AND start_date<=? AND end_date>=? ORDER BY room_id,rateplan_id,start_date",
    [dateOnly, dateOnly],
  );
  console.log('axisOccRowsForUsedDate:', JSON.stringify(occ));

  await c.end();
})().catch((e) => {
  console.error('ERR:', e.message || e);
  process.exit(1);
});
