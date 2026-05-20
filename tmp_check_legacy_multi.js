const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT confirmed_itinerary_plan_ID,itinerary_plan_ID,itinerary_quote_ID,status,deleted FROM dvi_travels.dvi_confirmed_itinerary_plan_details WHERE itinerary_plan_ID IN (?,?) OR confirmed_itinerary_plan_ID IN (?,?) ORDER BY itinerary_plan_ID',
    40377,
    40010,
    40377,
    40010,
  );
  console.log(rows);
}

main().catch(console.error).finally(async () => prisma.$disconnect());
