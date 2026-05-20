const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.wallet_transactions.groupBy({ by: ['agent_id'], _sum: { balance: true } });
  rows.sort((a,b) => (b._sum.balance || 0) - (a._sum.balance || 0));
  console.log(JSON.stringify(rows.slice(0, 20), null, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
