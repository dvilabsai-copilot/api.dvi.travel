const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const names = ['Madurai', 'Rameswaram', 'Kodaikanal', 'Thekkady', 'Munnar', 'Chennai International Airport'];

async function main() {
  const rows = await prisma.dvi_cities.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true, tbo_city_code: true, hobse_city_code: true },
  });
  console.log(rows);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
