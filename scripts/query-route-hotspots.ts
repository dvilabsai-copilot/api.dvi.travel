import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const routeIds = [4694, 4695, 4696, 4697];
  for (const rid of routeIds) {
    console.log('\nRoute ID:', rid);
    const rows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: { itinerary_route_ID: rid, item_type: 4, deleted: 0 },
      orderBy: { hotspot_order: 'asc' },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        is_conflict: true,
        conflict_reason: true,
      },
    });
    console.log('Count:', rows.length);
    for (const r of rows) {
      console.log(JSON.stringify(r));
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
