const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.$queryRawUnsafe("SELECT itinerary_plan_ID, itinerary_route_ID, location_name, itinerary_route_date FROM dvi_itinerary_route_details WHERE location_name LIKE '%Bangalore%' ORDER BY itinerary_route_ID DESC LIMIT 20");
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
})();
