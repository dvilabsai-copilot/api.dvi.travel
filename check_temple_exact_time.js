const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get exact temple attraction row (item_type 4) for Day 3
  const templeRow = await prisma.$queryRaw`
    SELECT route_hotspot_ID, item_type, hotspot_ID, hotspot_start_time, hotspot_end_time, hotspot_order
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4636 AND hotspot_ID = 487 AND item_type = 4 AND deleted = 0
  `;
  console.log('=== TEMPLE ATTRACTION ROW (item_type 4) ===');
  console.log(JSON.stringify(templeRow, null, 2));

  // Also get the travel row (item_type 3) for the temple
  const travelRow = await prisma.$queryRaw`
    SELECT route_hotspot_ID, item_type, hotspot_ID, hotspot_start_time, hotspot_end_time, hotspot_order
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4636 AND hotspot_ID = 487 AND item_type = 3 AND deleted = 0
  `;
  console.log('\n=== TEMPLE TRAVEL ROW (item_type 3) ===');
  console.log(JSON.stringify(travelRow, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
