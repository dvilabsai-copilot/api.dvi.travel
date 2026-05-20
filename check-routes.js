const {PrismaClient} = require('./node_modules/@prisma/client');
const p = new PrismaClient();
p.dvi_itinerary_route_details.findMany({
  where: { itinerary_route_ID: { in: [3108, 3109, 3110, 3111] } },
  select: { itinerary_route_ID: true, itinerary_route_date: true }
}).then(rows => {
  rows.forEach(r => {
    const d = new Date(r.itinerary_route_date);
    const jsDay = d.getUTCDay();
    const dbDay = (jsDay + 6) % 7;
    const jsNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dbNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    console.log('Route', r.itinerary_route_ID, '| Date:', r.itinerary_route_date, '| Actual day:', jsNames[jsDay], '| DB day key:', dbDay, '(' + dbNames[dbDay] + ')');
  });
  p.$disconnect();
});
