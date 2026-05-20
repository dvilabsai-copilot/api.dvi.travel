const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  
  try {
    // Check the routes for plan 36 via dvi_itinerary_route_details
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: 36 },
      take: 3
    });

    console.log('\n=== Routes for Plan 36 ===');
    routes.forEach(r => {
      console.log(`  Route ${r.itinerary_route_id}: CityID=${r.destination_city_id}, City=${r.destination_city}`);
    });
    
    // Check city mapping in dvi_cities
    console.log('\n=== City Name Mapping ===');
    const cities = await prisma.dvi_cities.findMany({
      where: {
        name: { in: ['Rameswaram', 'Kumbakonam', 'Madurai', 'Thrissur', 'Uthagamandalam', 'Vellore'] }
      },
      select: {
        tbo_city_code: true,
        name: true
      }
    });
    cities.forEach(c => {
      console.log(`  ${c.name}: TBO Code = ${c.tbo_city_code}`);
    });

  } finally {
    await prisma.$disconnect();
  }
})();
