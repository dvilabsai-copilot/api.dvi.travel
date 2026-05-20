const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  
  try {
    // Check route data structure
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: 36 },
      take: 2
    });

    console.log('\n=== Route Data Structure (First 2 Routes) ===');
    routes.forEach(r => {
      console.log(`  Route ${r.itinerary_route_ID}: location_name="${r.location_name}", location_id=${r.location_id}`);
    });

    // Now check which cities have ResAvenue hotels
    console.log('\n=== ResAvenue Hotels by City ===');
    const cities = ['Madurai', 'Rameswaram', 'Kumbakonam', 'Uthagamandalam', 'Thrissur', 'Vellore'];
    for (const city of cities) {
      const count = await prisma.dvi_hotel.count({
        where: {
          hotel_city: city,
          resavenue_hotel_code: { not: null },
          deleted: false,
          status: 1
        }
      });
      console.log(`  ${city}: ${count} hotels`);
    }

  } finally {
    await prisma.$disconnect();
  }
})();
