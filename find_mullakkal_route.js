const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find Mullakkal temple (hotspot ID 487) in the itinerary
  const rows = await prisma.$queryRaw`
    SELECT itinerary_route_ID, hotspot_ID, hotspot_start_time, hotspot_end_time, hotspot_order
    FROM dvi_itinerary_route_hotspot_details
    WHERE hotspot_ID = 487 AND item_type = 4 AND deleted = 0
  `;
  
  console.log('=== MULLAKKAL TEMPLE ROUTES ===');
  console.log(JSON.stringify(rows, null, 2));
  
  await prisma.$disconnect();
}

main().catch(console.error);
