const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw`
    SELECT
      bm.from_hotspot_id,
      bm.to_hotspot_id,
      bm.between_hotspot_id,
      bm.between_hotspot_name,
      bm.route_fit_type,
      bm.distance_from_route_meters,
      bm.detour_km,
      bm.detour_ratio,
      f.hotspot_name AS from_hotspot_name,
      t.hotspot_name AS to_hotspot_name,
      c.hotspot_name AS between_hotspot_actual_name
    FROM hotspot_route_between_map bm
    JOIN dvi_hotspot_place f ON f.hotspot_ID = bm.from_hotspot_id
    JOIN dvi_hotspot_place t ON t.hotspot_ID = bm.to_hotspot_id
    JOIN dvi_hotspot_place c ON c.hotspot_ID = bm.between_hotspot_id
    WHERE LOWER(TRIM(f.hotspot_name)) LIKE LOWER('%Cheeyappara%')
      AND LOWER(TRIM(t.hotspot_name)) LIKE LOWER('%Eravikulam%')
      AND LOWER(TRIM(c.hotspot_name)) LIKE LOWER('%Pothamedu%')
      AND bm.route_fit_type IN ('ON_ROUTE', 'MINOR_DETOUR')
    ORDER BY bm.distance_from_route_meters ASC
  `;

  console.log('Verification: Pothamedu between Cheeyappara -> Eravikulam');
  console.log(`Rows found: ${rows.length}`);

  if (!rows.length) {
    console.log('Result: NOT FOUND (currently treated as OFF_ROUTE / not feasible).');
    return;
  }

  console.log('Result: FOUND (manual insertion feasible).');
  console.log(JSON.stringify(rows.slice(0, 5), null, 2));
}

main()
  .catch((error) => {
    console.error('Verification script failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
