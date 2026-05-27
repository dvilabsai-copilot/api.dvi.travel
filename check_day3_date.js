const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get Day 3 route date
  const route = await prisma.dvi_itinerary_route_details.findFirst({
    where: { itinerary_route_ID: 4640 },
    select: { itinerary_route_date: true, location_name: true }
  });
  
  console.log('=== DAY 3 ROUTE INFO ===');
  console.log('Route ID: 4640');
  console.log('Date:', route.itinerary_route_date.toISOString());
  console.log('Day of week:', route.itinerary_route_date.getDay()); // 0=Sun, 1=Mon, ..., 6=Sat
  console.log('Location:', route.location_name);
  
  await prisma.$disconnect();
}

main().catch(console.error);
