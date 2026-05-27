const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function test() {
  // Query the temple row directly from Prisma
  const row = await prisma.dvi_itinerary_route_hotspot_details.findFirst({
    where: {
      itinerary_route_ID: 4636,
      hotspot_ID: 487,
      item_type: 4,
      deleted: 0
    },
    select: {
      hotspot_start_time: true,
      hotspot_end_time: true
    }
  });

  console.log('=== PRISMA DIRECT QUERY ===');
  console.log('hotspot_start_time:', row.hotspot_start_time);
  console.log('Type:', typeof row.hotspot_start_time);
  console.log('toISOString():', row.hotspot_start_time.toISOString());
  console.log('getUTCHours():', row.hotspot_start_time.getUTCHours());
  console.log('getHours():', row.hotspot_start_time.getHours());
  
  await prisma.$disconnect();
}

test().catch(console.error);
