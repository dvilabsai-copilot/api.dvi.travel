const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get Day 3 scheduled segments for hotspot 487
  const segments = await prisma.$queryRaw`
    SELECT *
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4636 AND hotspot_ID = 487 AND deleted = 0
    ORDER BY hotspot_order ASC
  `;
  console.log('=== DAY 3 SCHEDULED SEGMENTS FOR HOTSPOT 487 ===');
  console.log(JSON.stringify(segments, null, 2));

  // Get all Day 3 segments to see the full timeline
  const allSegments = await prisma.$queryRaw`
    SELECT rh.*, h.hotspot_location, h.hotspot_priority
    FROM dvi_itinerary_route_hotspot_details rh
    JOIN dvi_hotspot_place h ON rh.hotspot_ID = h.hotspot_ID
    WHERE rh.itinerary_route_ID = 4636 AND rh.deleted = 0
    ORDER BY rh.hotspot_order ASC
  `;
  console.log('\n=== ALL DAY 3 SEGMENTS ===');
  console.log(JSON.stringify(allSegments, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
