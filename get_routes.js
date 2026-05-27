const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const routes = await prisma.$queryRaw`
    SELECT itinerary_route_ID, no_of_days, location_name, itinerary_route_date
    FROM dvi_itinerary_route_details
    WHERE itinerary_plan_ID = 381 AND deleted = 0
    ORDER BY no_of_days ASC
  `;
  console.log(JSON.stringify(routes, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
