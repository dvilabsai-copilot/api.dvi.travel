const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const sql = `
    SELECT
      pd.itinerary_plan_ID,
      pd.itinerary_quote_ID,
      rd.itinerary_route_ID,
      rd.location_name,
      rd.next_visiting_location,
      vr.itinerary_via_location_name,
      rd.itinerary_route_date
    FROM dvi_itinerary_plan_details pd
    JOIN dvi_itinerary_route_details rd
      ON rd.itinerary_plan_ID = pd.itinerary_plan_ID
      AND rd.deleted = 0
      AND rd.status = 1
    JOIN dvi_itinerary_via_route_details vr
      ON vr.itinerary_plan_ID = pd.itinerary_plan_ID
      AND vr.itinerary_route_ID = rd.itinerary_route_ID
      AND vr.deleted = 0
      AND vr.status = 1
    WHERE pd.deleted = 0
      AND pd.status = 1
      AND LOWER(TRIM(SUBSTRING_INDEX(rd.location_name, '|', 1))) = LOWER(TRIM(SUBSTRING_INDEX(rd.next_visiting_location, '|', 1)))
      AND (
        LOWER(vr.itinerary_via_location_name) LIKE '%mysore%'
        OR LOWER(vr.itinerary_via_location_name) LIKE '%bangalore%'
        OR LOWER(vr.itinerary_via_location_name) LIKE '%bengaluru%'
      )
    ORDER BY pd.itinerary_plan_ID DESC
    LIMIT 20
  `;

  const rows = await prisma.$queryRawUnsafe(sql);
  console.log(JSON.stringify(rows, null, 2));
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
