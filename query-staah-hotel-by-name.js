const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const hotelName = 'STAAHTESTHOTEL1';

async function main() {
  const rows = await prisma.dvi_hotel.findMany({
    where: {
      hotel_name: hotelName,
    },
    select: {
      hotel_id: true,
      hotel_name: true,
      hotel_code: true,
      hotel_city: true,
      staah_property_id: true,
      staah_enabled: true,
      status: true,
      deleted: true,
    },
    orderBy: { hotel_id: 'asc' },
  });

  console.log('Matches for hotel_name =', hotelName);
  console.log('Total matches:', rows.length);
  console.table(rows);
}

main()
  .catch((error) => {
    console.error('Query failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
