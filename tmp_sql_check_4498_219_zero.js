const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      route_hotspot_ID,
      itinerary_route_ID,
      hotspot_ID,
      item_type,
      deleted,
      status,
      hotspot_start_time,
      hotspot_end_time,
      TIMESTAMPDIFF(MINUTE, hotspot_start_time, hotspot_end_time) AS duration_minutes
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4498
      AND hotspot_ID = 219
      AND item_type = 4
      AND deleted = 0
      AND TIMESTAMPDIFF(MINUTE, hotspot_start_time, hotspot_end_time) <= 0
    ORDER BY route_hotspot_ID DESC
  `);

  console.log(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
