const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Check booking rule logs for plan 381
  const logs = await prisma.$queryRaw`
    SELECT * FROM dvi_booking_rule_logs
    WHERE itinerary_plan_ID = 381
    ORDER BY createdon DESC
    LIMIT 100
  `;
  console.log('=== BOOKING RULE LOGS FOR PLAN 381 ===');
  console.log(JSON.stringify(logs, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
