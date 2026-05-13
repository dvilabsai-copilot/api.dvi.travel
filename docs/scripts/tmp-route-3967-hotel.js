const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const routeHotel = await db.dvi_itinerary_route_hotel_details.findMany({
    where: { itinerary_plan_ID: 379, itinerary_route_ID: 3967, deleted: 0 },
    orderBy: { route_hotel_details_id: 'asc' }
  });
  const planHotel = await db.dvi_itinerary_hotel_details.findMany({
    where: { itinerary_plan_ID: 379, deleted: 0 },
    orderBy: [{ itinerary_hotel_route_day: 'asc' }, { itinerary_hotel_details_id: 'asc' }]
  });
  console.log(JSON.stringify({ routeHotel, planHotel }, null, 2));
  await db.$disconnect();
})().catch(async (e) => { console.error(e.stack || e); try { await db.$disconnect(); } catch {} process.exit(1); });
