const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const plan = await p.dvi_itinerary_plan_details.findFirst({ where: { itinerary_plan_ID: 268 }, select: { trip_end_date_and_time: true, departure_type: true } });
  const route = await p.dvi_itinerary_route_details.findFirst({ where: { itinerary_plan_ID: 268, itinerary_route_ID: 2075 }, select: { route_start_time: true, route_end_time: true, location_name: true, next_visiting_location: true } });
  console.log({ plan, route });
})();
