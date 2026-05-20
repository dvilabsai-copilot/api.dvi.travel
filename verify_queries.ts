import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  try {
    const q1 = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS seed_count FROM dvi_main.hotspot_popular_pair_seed');
    const q2 = await prisma.$queryRawUnsafe('SELECT process_status, COUNT(*) AS cnt FROM dvi_main.hotspot_route_matrix GROUP BY process_status');
    const q3 = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS popular_done_count FROM dvi_main.hotspot_route_matrix m INNER JOIN dvi_main.hotspot_popular_pair_seed s ON s.from_hotspot_id = m.from_hotspot_id AND s.to_hotspot_id = m.to_hotspot_id WHERE m.process_status = \'DONE\'');
    console.log(JSON.stringify({ seed_count: q1, process_status_counts: q2, popular_done_count: q3 }, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
main();
