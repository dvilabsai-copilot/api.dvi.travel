const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const rows = await db.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: 379, itinerary_route_ID: 3966, deleted: 0 },
    orderBy: [{ hotspot_start_time: 'asc' }],
    select: { route_hotspot_ID: true, item_type: true, hotspot_ID: true, hotspot_order: true, hotspot_start_time: true, hotspot_end_time: true, hotspot_plan_own_way: true, allow_break_hours: true, allow_via_route: true, hotspot_travelling_distance: true }
  });
  console.log(JSON.stringify(rows, null, 2));
  await db.$disconnect();
})().catch(async (e) => { console.error(e.stack || e); try { await db.$disconnect(); } catch {} process.exit(1); });
