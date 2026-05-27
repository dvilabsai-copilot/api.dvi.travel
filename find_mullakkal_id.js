const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get Day 3 route hotspots
  const routeHotspots = await prisma.$queryRaw`
    SELECT h.hotspot_ID, h.hotspot_location, h.hotspot_priority
    FROM dvi_itinerary_route_hotspot_details rh
    JOIN dvi_hotspot_place h ON rh.hotspot_ID = h.hotspot_ID
    WHERE rh.itinerary_route_ID = 4636 AND rh.deleted = 0
    ORDER BY rh.hotspot_order ASC
  `;
  console.log('=== DAY 3 ROUTE HOTSPOTS (Route ID: 4636) ===');
  console.log(JSON.stringify(routeHotspots, null, 2));

  // Find priority 3 temple (hotspot ID 487)
  const priority3Temple = routeHotspots.find(h => h.hotspot_priority === 3);
  if (priority3Temple) {
    console.log('\n=== PRIORITY 3 TEMPLE FOUND ===');
    console.log(`Hotspot ID: ${priority3Temple.hotspot_ID}`);
    console.log(`Location: ${priority3Temple.hotspot_location}`);
    console.log(`Priority: ${priority3Temple.hotspot_priority}`);

    // Get its timings
    const timings = await prisma.$queryRaw`
      SELECT *
      FROM dvi_hotspot_timing
      WHERE hotspot_ID = ${priority3Temple.hotspot_ID}
    `;
    console.log('\n=== PRIORITY 3 TEMPLE TIMINGS ===');
    console.log(JSON.stringify(timings, null, 2));
  }

  // Also get full hotspot details for ID 487
  const hotspotDetails = await prisma.$queryRaw`
    SELECT * FROM dvi_hotspot_place WHERE hotspot_ID = 487
  `;
  console.log('\n=== HOTSPOT 487 FULL DETAILS ===');
  console.log(JSON.stringify(hotspotDetails, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
