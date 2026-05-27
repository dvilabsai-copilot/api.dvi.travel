const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get all segments for Day 3 route 4640
  const rows = await prisma.$queryRaw`
    SELECT route_hotspot_ID, item_type, hotspot_ID, hotspot_start_time, hotspot_end_time, hotspot_order
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4640 AND deleted = 0
    ORDER BY hotspot_order ASC
  `;
  
  console.log('=== DAY 3 FULL TIMELINE (Route 4640) ===');
  rows.forEach(row => {
    const start = new Date(row.hotspot_start_time);
    const end = new Date(row.hotspot_end_time);
    const type = row.item_type === 4 ? 'ATTRACTION' : row.item_type === 3 ? 'TRAVEL' : 'OTHER';
    console.log(`Order ${row.hotspot_order}: ${type} (Hotspot ${row.hotspot_ID})`);
    console.log(`  Time: ${start.getHours()}:${String(start.getMinutes()).padStart(2, '0')} - ${end.getHours()}:${String(end.getMinutes()).padStart(2, '0')} IST`);
    console.log('');
  });
  
  await prisma.$disconnect();
}

main().catch(console.error);
