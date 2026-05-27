const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get all attraction rows for Day 3
  const rows = await prisma.$queryRaw`
    SELECT route_hotspot_ID, item_type, hotspot_ID, hotspot_start_time, hotspot_end_time, hotspot_order
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4636 AND item_type = 4 AND deleted = 0
    ORDER BY hotspot_order ASC
  `;
  
  console.log('=== ALL DAY 3 ATTRACTIONS ===');
  rows.forEach(row => {
    console.log(`Hotspot ID: ${row.hotspot_ID}, Order: ${row.hotspot_order}`);
    console.log(`  Start: ${row.hotspot_start_time}`);
    console.log(`  End: ${row.hotspot_end_time}`);
    console.log('');
  });
  
  await prisma.$disconnect();
}

main().catch(console.error);
