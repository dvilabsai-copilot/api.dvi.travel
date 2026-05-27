const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find Mullakkal temple hotspot - broader search
  const temple = await prisma.$queryRaw`
    SELECT hotspot_ID, hotspot_location, hotspot_latitude, hotspot_longitude
    FROM dvi_hotspot_place
    WHERE LOWER(hotspot_location) LIKE '%mullakkal%'
       OR LOWER(hotspot_location) LIKE '%temple%'
       OR LOWER(hotspot_location) LIKE '%raja%'
  `;
  console.log('=== TEMPLE HOTSPOTS ===');
  console.log(JSON.stringify(temple, null, 2));

  if (temple && temple.length > 0) {
    for (const t of temple) {
      const hotspotId = t.hotspot_ID;
      
      // Get operating hours
      const timings = await prisma.$queryRaw`
        SELECT *
        FROM dvi_hotspot_timing
        WHERE hotspot_ID = ${hotspotId}
      `;
      console.log(`\n=== TIMINGS FOR ${t.hotspot_location} (ID: ${hotspotId}) ===`);
      console.log(JSON.stringify(timings, null, 2));
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
