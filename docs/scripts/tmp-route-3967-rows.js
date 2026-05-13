const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const rows = await db.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: 379, itinerary_route_ID: 3967, deleted: 0 },
    orderBy: [{ hotspot_order: 'asc' }, { route_hotspot_ID: 'asc' }]
  });
  console.log(JSON.stringify(rows.map(r => ({
    route_hotspot_ID: r.route_hotspot_ID,
    hotspot_order: r.hotspot_order,
    item_type: r.item_type,
    hotspot_ID: r.hotspot_ID,
    hotspot_name: r.hotspot_name,
    start: r.hotspot_start_time,
    end: r.hotspot_end_time,
    distance: r.hotspot_distance,
    duration: r.hotspot_travel_duration,
    ownWay: r.hotspot_plan_own_way,
    allowBreak: r.allow_break_hours
  })), null, 2));
  await db.$disconnect();
})().catch(async (e) => { console.error(e.stack || e); try { await db.$disconnect(); } catch {} process.exit(1); });
