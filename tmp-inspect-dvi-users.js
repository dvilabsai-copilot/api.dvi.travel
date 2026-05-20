const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

(async () => {
  const columns = await prisma.$queryRawUnsafe(
    "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dvi_users' ORDER BY ORDINAL_POSITION"
  );

  const indexes = await prisma.$queryRawUnsafe(
    "SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dvi_users' ORDER BY INDEX_NAME,SEQ_IN_INDEX"
  );

  const source = await prisma.dvi_users.findFirst({
    where: { useremail: 'admin@dvi.co.in' },
    orderBy: { userID: 'asc' },
  });

  console.log(
    JSON.stringify(
      { columns, indexes, source },
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
