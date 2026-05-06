const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const quoteId = process.argv[2] || 'DVI20260320';

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

async function main() {
  const routes = await prisma.$queryRawUnsafe(`
    SELECT r.itinerary_route_ID AS route_id,
           r.itinerary_route_date AS route_date,
           r.location_name AS destination
    FROM dvi_itinerary_plan_details p
    JOIN dvi_itinerary_route_details r ON r.itinerary_plan_ID = p.itinerary_plan_ID
    WHERE p.itinerary_quote_ID = '${quoteId}'
      AND p.deleted = 0 AND r.deleted = 0
    ORDER BY r.itinerary_route_date
  `);

  console.log(`Quote ${quoteId} routes:`);
  for (const r of routes) {
    console.log(`  route_id=${r.route_id} date=${String(r.route_date).slice(0, 15)} destination=${r.destination}`);
  }

  const axisHotels = await prisma.dvi_hotel.findMany({
    where: { axisrooms_enabled: 1, deleted: { not: true } },
    select: { hotel_id: true, hotel_name: true, hotel_city: true },
  });

  const numericCityIds = Array.from(new Set(
    axisHotels
      .map(h => Number(String(h.hotel_city || '').trim()))
      .filter(n => Number.isFinite(n) && n > 0)
  ));

  const cities = numericCityIds.length
    ? await prisma.dvi_cities.findMany({
        where: { id: { in: numericCityIds }, deleted: 0, status: 1 },
        select: { id: true, name: true },
      })
    : [];

  const cityMap = new Map(cities.map(c => [Number(c.id), String(c.name || '')]));

  const routeDateStrings = routes.map(r => {
    const d = new Date(r.route_date);
    return d.toISOString().slice(0, 10);
  });

  for (const route of routes) {
    const routeToken = norm(route.destination);
    const routeDate = new Date(route.route_date);
    const routeDateIso = routeDate.toISOString().slice(0, 10);

    const cityHotels = axisHotels.filter(h => {
      const raw = String(h.hotel_city || '').trim();
      const num = Number(raw);
      const resolved = Number.isFinite(num) && num > 0 && cityMap.has(num)
        ? cityMap.get(num)
        : raw;
      return norm(resolved) === routeToken;
    });

    let hotelsWithAvail = 0;
    let hotelsWithRatePlan = 0;
    let hotelsWithOcc = 0;

    for (const h of cityHotels) {
      const hid = Number(h.hotel_id);

      const avail = await prisma.dvi_hotel_room_availability.count({
        where: {
          hotel_id: hid,
          source: 'axisrooms',
          free: { gt: 0 },
          start_date: { lte: routeDate },
          end_date: { gte: routeDate },
        },
      });
      if (avail > 0) hotelsWithAvail++;

      const rps = await prisma.dvi_hotel_room_rate_plan.count({
        where: {
          hotel_id: hid,
          axisrooms_room_id: { not: null },
          deleted: 0,
          status: 1,
        },
      });
      if (rps > 0) hotelsWithRatePlan++;

      const occ = await prisma.dvi_hotel_occupancy_rate.count({
        where: {
          hotel_id: hid,
          source: 'axisrooms',
          start_date: { lte: routeDate },
          end_date: { gte: routeDate },
        },
      });
      if (occ > 0) hotelsWithOcc++;
    }

    console.log(`\n[${routeDateIso}] ${route.destination}`);
    console.log(`  axis city-match hotels: ${cityHotels.length}`);
    console.log(`  with axis availability: ${hotelsWithAvail}`);
    console.log(`  with axis rate plans : ${hotelsWithRatePlan}`);
    console.log(`  with axis occupancy  : ${hotelsWithOcc}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
