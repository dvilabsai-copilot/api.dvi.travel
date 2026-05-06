const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const quoteId = process.argv[2] || 'DVI20260320';

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT p.itinerary_plan_ID,
           p.itinerary_quote_ID,
           p.no_of_nights,
           r.itinerary_route_ID,
           r.itinerary_route_date,
           r.location_name,
           r.next_visiting_location
    FROM dvi_itinerary_plan_details p
    JOIN dvi_itinerary_route_details r ON r.itinerary_plan_ID = p.itinerary_plan_ID
    WHERE p.itinerary_quote_ID = '${quoteId}'
      AND p.deleted = 0 AND r.deleted = 0
    ORDER BY r.itinerary_route_date
  `);

  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
