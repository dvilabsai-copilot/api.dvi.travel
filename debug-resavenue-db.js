const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkResavenueHotels() {
  try {
    console.log('\n🏨 Checking ResAvenue hotels in database...\n');

    // Check total ResAvenue hotels
    const totalResavenue = await prisma.dvi_hotel.count({
      where: {
        resavenue_hotel_code: { not: null },
        status: 1,
        deleted: false,
      }
    });
    console.log(`Total ResAvenue hotels: ${totalResavenue}`);

    // Get cities with ResAvenue hotels
    const hotels = await prisma.dvi_hotel.findMany({
      where: {
        resavenue_hotel_code: { not: null },
        status: 1,
        deleted: false,
      },
      select: {
        hotel_city: true,
        hotel_name: true,
        resavenue_hotel_code: true,
        hotel_category: true,
      },
      orderBy: { hotel_city: 'asc' },
    });

    const cityCounts = {};
    hotels.forEach(h => {
      cityCounts[h.hotel_city] = (cityCounts[h.hotel_city] || 0) + 1;
    });

    console.log('\nResAvenue hotels by city:');
    Object.entries(cityCounts).forEach(([city, count]) => {
      console.log(`  ${city}: ${count} hotels`);
    });

    console.log('\nAll ResAvenue hotels:');
    hotels.forEach(h => {
      console.log(`  - ${h.hotel_name} (${h.hotel_city}, Code: ${h.resavenue_hotel_code}, Category: ${h.hotel_category}*)`);
    });

    // Check what the itinerary routes are for plan 313
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: 313, deleted: 0 },
      select: {
        itinerary_route_ID: true,
        next_visiting_location: true,
        location_name: true,
        itinerary_route_date: true,
      },
      orderBy: { itinerary_route_date: 'asc' },
    });

    console.log('\nRoutes for plan 313:');
    routes.forEach((r, idx) => {
      console.log(`  Route ${idx + 1}: ID=${r.itinerary_route_ID}, Location="${r.next_visiting_location}" (${r.location_name}), Date=${r.itinerary_route_date}`);
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkResavenueHotels();
