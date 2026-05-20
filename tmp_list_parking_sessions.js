const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  const rows = await prisma.dvi_tempcsv.groupBy({
    by: ['sessionID'],
    where: { csvtype: 4 },
    _count: { _all: true },
    _max: { temp_id: true },
    orderBy: { _max: { temp_id: 'desc' } },
    take: 15,
  });

  const out = [];
  for (const r of rows) {
    const s = r.sessionID;
    const stats = await prisma.dvi_tempcsv.groupBy({
      by: ['status'],
      where: { csvtype: 4, sessionID: s },
      _count: { _all: true },
    });
    out.push({ sessionID: s, total: r._count._all, statusBreakdown: stats });
  }

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
