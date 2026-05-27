const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get raw TIME values from database using $queryRaw
  const rows = await prisma.$queryRaw`
    SELECT route_hotspot_ID, hotspot_ID, hotspot_start_time, hotspot_end_time, hotspot_order
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4640 AND item_type = 4 AND deleted = 0
    ORDER BY hotspot_order ASC
  `;
  
  console.log('=== RAW DATABASE VALUES (Route 4640) ===');
  rows.forEach(row => {
    console.log(`Hotspot ID: ${row.hotspot_ID}, Order: ${row.hotspot_order}`);
    console.log(`  hotspot_start_time (raw): ${row.hotspot_start_time}`);
    console.log(`  hotspot_end_time (raw): ${row.hotspot_end_time}`);
    console.log('');
  });
  
  await prisma.$disconnect();
}

main().catch(console.error);
