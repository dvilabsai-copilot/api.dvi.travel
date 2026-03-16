const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.$queryRawUnsafe("SELECT itinerary_route_ID, itinerary_plan_ID, location_name, next_visiting_location, itinerary_route_date FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = 21 ORDER BY itinerary_route_ID");
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
})();
