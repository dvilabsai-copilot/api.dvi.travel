const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const routes = await p.dvi_itinerary_route_details.findMany({ where: { itinerary_plan_ID: 268, deleted: 0, status: 1 }, orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }], select: { itinerary_route_ID: true, itinerary_route_date: true, route_start_time: true, route_end_time: true, location_name: true, next_visiting_location: true } });
  console.log('count', routes.length);
  console.log('last', routes[routes.length-1]);
})();
