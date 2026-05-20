import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const tables = await prisma.$queryRawUnsafe("SELECT table_schema, table_name FROM information_schema.tables WHERE table_name LIKE '%stored%location%'");

    const stats = await prisma.$queryRawUnsafe(`
      SELECT 
        COUNT(*) as total_rows,
        COUNT(DISTINCT between_hotspot_id) as distinct_between_ids,
        COUNT(DISTINCT CONCAT(from_hotspot_id, '-', to_hotspot_id)) as distinct_route_pairs
      FROM hotspot_route_between_map
    `);

    const topPairs = await prisma.$queryRawUnsafe(`
      SELECT from_hotspot_id, to_hotspot_id, COUNT(*) as row_count
      FROM hotspot_route_between_map
      GROUP BY from_hotspot_id, to_hotspot_id
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `);

    const topIds = await prisma.$queryRawUnsafe(`
      SELECT between_hotspot_id, COUNT(*) as usage_count
      FROM hotspot_route_between_map
      GROUP BY between_hotspot_id
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `);

    const result = {
      tables,
      stats: stats[0],
      topPairs,
      topIds
    };

    console.log(JSON.stringify(result, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value, 2));

  } catch (error: any) {
    console.error(error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
