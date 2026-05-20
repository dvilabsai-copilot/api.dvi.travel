const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.$queryRawUnsafe(`
SELECT room_ID, room_ref_code, deleted, status FROM dvi_hotel_rooms
WHERE hotel_id = 153
ORDER BY room_ID
`).then(rows => {
  console.log('Rooms for hotel 153:');
  rows.forEach(r => console.log(`  room_ID=${r.room_ID} ref=${r.room_ref_code} deleted=${r.deleted} status=${r.status}`));
  return p.$queryRawUnsafe(`SELECT COUNT(*) AS cnt FROM dvi_hotel_occupancy_rate WHERE hotel_id = 153`);
}).then(rows => {
  console.log('Total occupancy_rate rows for hotel 153:', rows[0].cnt);
  return p.$queryRawUnsafe(`SELECT hotel_id, room_id, rateplan_id, start_date, end_date, source FROM dvi_hotel_occupancy_rate WHERE hotel_id = 153 LIMIT 10`);
}).then(rows => {
  console.log('Sample occupancy_rate rows:', rows);
  p.$disconnect();
}).catch(e => { console.error(e); p.$disconnect(); });
