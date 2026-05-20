const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const hotspotIds = await p.dvi_itinerary_route_hotspot_details.findMany({ where: { itinerary_plan_ID: 268, deleted: 0 }, select: { route_hotspot_ID: true } });
  const ids = hotspotIds.map(r => Number(r.route_hotspot_ID));
  const actCount = await p.dvi_itinerary_route_activity_details.count({ where: { itinerary_plan_ID: 268, deleted: 0 } });
  const linkedActCount = await p.dvi_itinerary_route_activity_details.count({ where: { itinerary_plan_ID: 268, deleted: 0, route_hotspot_ID: { in: ids.length ? ids : [0] } } });
  console.log({ hotspotRows: ids.length, activityRows: actCount, linkedActivityRows: linkedActCount });
})();
