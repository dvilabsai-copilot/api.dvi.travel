const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  
  try {
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: 36 },
      select: {
        itinerary_route_ID: true,
        location_name: true,
        next_visiting_location: true,
        itinerary_route_date: true
      },
      take: 10
    });

    console.log('\n=== Route Destinations ===');
    routes.forEach(r => {
      console.log(`Route ${r.itinerary_route_ID}:`);
      console.log(`  location_name: "${r.location_name}"`);
      console.log(`  next_visiting_location: "${r.next_visiting_location}"`);
      console.log(`  date: "${r.itinerary_route_date}"`);
    });

  } finally {
    await prisma.$disconnect();
  }
})();
