const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const rows = await p.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: 268, item_type: 4, deleted: 0 },
    select: {
      itinerary_route_ID: true,
      route_hotspot_ID: true,
      hotspot_ID: true,
      hotspot_order: true,
      hotspot_plan_own_way: true,
      hotspot_start_time: true,
    },
  });
  const manual = rows.filter((r) => Number(r.hotspot_plan_own_way || 0) === 1);
  const placeholders = manual.filter((r) =>
    Number(r.hotspot_order || 0) === 999 ||
    (r.hotspot_start_time && new Date(r.hotspot_start_time).getTime() === new Date("1970-01-01T00:00:00Z").getTime())
  );
  console.log("total", rows.length, "manual", manual.length, "manualPlaceholders", placeholders.length);

  const byRoute = {};
  for (const r of rows) {
    byRoute[r.itinerary_route_ID] = (byRoute[r.itinerary_route_ID] || 0) + 1;
  }
  console.log("routeCounts", byRoute);

  console.log(
    "lastRouteRows",
    rows
      .filter((r) => Number(r.itinerary_route_ID) === 2075)
      .map((r) => ({
        hotspotId: r.hotspot_ID,
        order: r.hotspot_order,
        manual: r.hotspot_plan_own_way,
        start: r.hotspot_start_time,
      }))
  );
})();
