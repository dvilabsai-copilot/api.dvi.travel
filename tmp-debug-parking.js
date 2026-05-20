const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const pc = await p.dvi_itinerary_route_hotspot_parking_charge.count({ where: { itinerary_plan_ID: 268 } });
  console.log({ parkingRows: pc });
})();
