const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.dvi_confirmed_itinerary_plan_details.findMany({
    where: { itinerary_plan_ID: { in: [40377, 40010] } },
    select: { itinerary_plan_ID: true, itinerary_quote_ID: true, status: true, deleted: true },
    orderBy: { itinerary_plan_ID: 'asc' },
  });
  console.log(rows);
}

main().catch(console.error).finally(async () => prisma.$disconnect());
