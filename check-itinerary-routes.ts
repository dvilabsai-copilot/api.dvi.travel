import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('\n🔍 CHECKING ITINERARY ROUTES FOR DVI20260521\n');

    // Find the plan first
    const plan = await prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: 'DVI20260521', deleted: 0 },
    });

    if (!plan) {
      console.log('❌ Itinerary DVI20260521 not found\n');
      return;
    }

    console.log(`✅ Found itinerary plan: ${plan.itinerary_plan_ID}\n`);

    // Get routes
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    console.log(`📍 Routes (${routes.length} total):\n`);
    console.log('┌───┬────────────────────────┬────────────────────────┬─────────────────────────┐');
    console.log('│ # │ Route ID               │ Location Name          │ Next Visiting Location  │');
    console.log('├───┼────────────────────────┼────────────────────────┼─────────────────────────┤');

    routes.forEach((route: any, idx) => {
      const locName = String(route.location_name || '').substring(0, 20).padEnd(20);
      const nextLoc = String(route.next_visiting_location || '[NULL]').substring(0, 21).padEnd(21);
      console.log(`│ ${String(idx + 1).padEnd(2)} │ ${String(route.itinerary_route_ID).padEnd(22)} │ ${locName} │ ${nextLoc} │`);
    });

    console.log('└───┴────────────────────────┴────────────────────────┴─────────────────────────┘\n');

    console.log('🏨 ResAvenue Hotels in DB:');
    const resavenueHotels = await prisma.dvi_hotel.findMany({
      where: {
        resavenue_hotel_code: { not: null },
        deleted: false,
        status: 1,
      },
      select: {
        hotel_name: true,
        hotel_city: true,
        resavenue_hotel_code: true,
      },
      distinct: ['hotel_city'],
      orderBy: { hotel_city: 'asc' },
    });

    resavenueHotels.forEach((hotel: any) => {
      console.log(`   - ${hotel.hotel_city} (${hotel.hotel_name})`);
    });

    console.log('\n✨ Matching Analysis:');
    const routeCities = new Set(routes.map((r: any) => r.next_visiting_location).filter(Boolean));
    const dbCities = new Set(resavenueHotels.map((h: any) => h.hotel_city));
    
    const matches = Array.from(routeCities).filter((city) => dbCities.has(city));
    const mismatches = Array.from(routeCities).filter((city) => !dbCities.has(city));

    if (matches.length > 0) {
      console.log(`   ✅ Matching cities: ${matches.join(', ')}`);
    }
    if (mismatches.length > 0) {
      console.log(`   ❌ NOT in DB: ${mismatches.join(', ')}`);
    }
    if (routeCities.size === 0) {
      console.log(`   ⚠️  No cities found in routes (next_visiting_location is NULL/empty!)`);
    }

    console.log('\n');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
