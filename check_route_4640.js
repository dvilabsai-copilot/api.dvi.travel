const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get all attraction rows for route 4640 (Day 3)
  const rows = await prisma.$queryRaw`
    SELECT route_hotspot_ID, item_type, hotspot_ID, hotspot_start_time, hotspot_end_time, hotspot_order
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4640 AND item_type = 4 AND deleted = 0
    ORDER BY hotspot_order ASC
  `;
  
  console.log('=== ALL DAY 3 ATTRACTIONS (Route 4640) ===');
  rows.forEach(row => {
    const start = new Date(row.hotspot_start_time);
    const end = new Date(row.hotspot_end_time);
    console.log(`Hotspot ID: ${row.hotspot_ID}, Order: ${row.hotspot_order}`);
    console.log(`  Start: ${row.hotspot_start_time} (UTC: ${start.getUTCHours()}:${String(start.getUTCMinutes()).padStart(2, '0')})`);
    console.log(`  End: ${row.hotspot_end_time} (UTC: ${end.getUTCHours()}:${String(end.getUTCMinutes()).padStart(2, '0')})`);
    console.log('');
  });
  
  await prisma.$disconnect();
}

main().catch(console.error);
