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
      hotspot_plan_own_way,
      deleted,
      hotspot_start_time,
      hotspot_end_time,
      TIMESTAMPDIFF(MINUTE, hotspot_start_time, hotspot_end_time) AS duration_minutes,
      updatedon
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_route_ID = 4498
      AND deleted = 0
    ORDER BY hotspot_order ASC, route_hotspot_ID ASC
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
