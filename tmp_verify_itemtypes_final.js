const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async()=>{
  const rows = await p.$queryRawUnsafe(`
    SELECT itinerary_plan_ID, itinerary_route_ID, item_type, COUNT(*) cnt
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_plan_ID IN (288,289)
      AND itinerary_route_ID IN (2790,2799)
      AND deleted=0
    GROUP BY itinerary_plan_ID, itinerary_route_ID, item_type
    ORDER BY itinerary_plan_ID, itinerary_route_ID, item_type
  `);
  console.table(rows);
  await p.$disconnect();
})().catch(async e=>{console.error(e); await p.$disconnect(); process.exit(1);});
