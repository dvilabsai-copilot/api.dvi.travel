const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.dvi_hotel.findMany({
    where: {
      resavenue_hotel_code: { not: null },
      deleted: false,
    },
    select: {
      hotel_id: true,
      hotel_name: true,
      hotel_city: true,
      hotel_code: true,
      resavenue_hotel_code: true,
      status: true,
    },
    orderBy: { hotel_id: 'asc' },
  });

  console.log('Total rows with resavenue_hotel_code:', rows.length);
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
