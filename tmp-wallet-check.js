require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.dvi_agent.findMany({
    select: { agent_ID: true, total_cash_wallet: true },
    orderBy: { total_cash_wallet: 'desc' },
    take: 10,
  });
  console.log(JSON.stringify(rows, null, 2));
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  try { await p.$disconnect(); } catch {}
  process.exit(1);
});
