const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.dvi_agent.findMany({
    where: { deleted: 0 },
    select: { agent_ID: true, agent_name: true, total_cash_wallet: true, total_coupon_wallet: true },
    orderBy: { total_cash_wallet: 'desc' },
    take: 20,
  });
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
