const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  
  try {
    // Check ResAvenue hotels in database
    const resavenueHotels = await prisma.dvi_hotel.findMany({
      where: { resavenue_hotel_code: { not: null } }
    });

    console.log('\n=== ResAvenue Hotels in Database ===');
    console.log(`Total: ${resavenueHotels.length}`);
    resavenueHotels.forEach(h => {
      console.log(`  ${h.hotel_name} (${h.hotel_city}) - Code: ${h.resavenue_hotel_code}`);
    });

    // Check imported cities
    const importedHotels = await prisma.dvi_hotel.findMany({
      where: { hotel_code: { startsWith: 'RESAVENUE-' } }
    });

    console.log('\n=== Imported Revenue Manager Hotels ===');
    console.log(`Total: ${importedHotels.length}`);
    importedHotels.forEach(h => {
      console.log(`  ${h.hotel_name} (${h.hotel_city}) - ResAvenue Code: ${h.resavenue_hotel_code}`);
    });
  } finally {
    await prisma.$disconnect();
  }
})();
