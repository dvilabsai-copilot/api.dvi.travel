const pc = require('@prisma/client');
const p = new pc.PrismaClient();
p.dvi_hotel.findMany({
  where: { hotel_category: 2 },
  select: { hotel_id: true, hotel_code: true, hotel_name: true, hotel_city: true },
  take: 10,
  orderBy: { hotel_id: 'desc' }
}).then(rows => {
  console.log('Total sample (last 10):');
  rows.forEach(r => console.log(r.hotel_id, '|', r.hotel_code, '|', r.hotel_name.substring(0,40), '|', r.hotel_city));
  return p.dvi_hotel.count({ where: { hotel_category: 2 } });
}).then(count => {
  console.log('Total HOBSE hotels (category 2):', count);
  p.$disconnect();
}).catch(e => { console.error(e.message); p.$disconnect(); });
