import { PrismaClient } from '@prisma/client';

const DEPLOYMENT_BACKUP_PREFIX = 'dvi_hotel_meal_price_book_backup_codex_';
const DEPLOYMENT_BACKUP_NAME = new RegExp(
  `^${DEPLOYMENT_BACKUP_PREFIX}[0-9]{8}$`,
);

export function isDeploymentBackupTableName(value: string): boolean {
  return DEPLOYMENT_BACKUP_NAME.test(value);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT TABLE_NAME AS table_name
      FROM information_schema.tables
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME LIKE ${`${DEPLOYMENT_BACKUP_PREFIX}%`}
      ORDER BY TABLE_NAME
    `;

    for (const table of tables) {
      if (!isDeploymentBackupTableName(table.table_name)) {
        throw new Error(
          `Refusing to drop unexpected deployment backup table: ${table.table_name}`,
        );
      }

      await prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS \`${table.table_name}\``,
      );
      console.log(`Removed temporary deployment backup table: ${table.table_name}`);
    }

    if (tables.length === 0) {
      console.log('No temporary deployment backup tables found.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
