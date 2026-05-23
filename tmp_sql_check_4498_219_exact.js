const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      route_hotspot_ID,
      itinerary_plan_ID,
      itinerary_route_ID,
      hotspot_ID,
      item_type,
      hotspot_order,
      hotspot_start_time,
      hotspot_end_time,
      hotspot_traveling_time,
      TIMESTAMPDIFF(MINUTE, hotspot_start_time, hotspot_end_time) AS duration_minutes,
      is_conflict,
      conflict_reason,
      updatedon,
      deleted,
      status
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4498
      AND hotspot_ID = 219
      AND item_type = 4
      AND deleted = 0
    ORDER BY route_hotspot_ID DESC
    LIMIT 10
  `);

  console.log(JSON.stringify(rows, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
