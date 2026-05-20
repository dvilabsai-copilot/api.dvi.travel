const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const routes = await db.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: 379, deleted: 0 },
    select: { itinerary_route_ID: true, itinerary_route_date: true, location_name: true, next_visiting_location: true }
  });
  console.log(JSON.stringify(routes, null, 2));
  await db.$disconnect();
})().catch(async (e) => { console.error(e.stack || e); try { await db.$disconnect(); } catch {} process.exit(1); });
