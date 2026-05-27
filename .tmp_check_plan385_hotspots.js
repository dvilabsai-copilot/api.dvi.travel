const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  const [routes] = await c.execute(
    'SELECT itinerary_route_ID,no_of_days,location_name,next_visiting_location FROM dvi_itinerary_route_details WHERE itinerary_plans_id=? ORDER BY itinerary_route_ID',
    [385],
  );
  console.log('ROUTES', routes);

  const [via] = await c.execute(
    'SELECT itinerary_route_id,itinerary_via_route_id,itinerary_via_location_name,via_route_name FROM dvi_itinerary_via_route_details WHERE itinerary_plans_id=? ORDER BY itinerary_via_route_id',
    [385],
  );
  console.log('VIA', via);

  const [rhs] = await c.execute(
    'SELECT itinerary_route_ID,route_hotspot_id,hotspot_name,hotspot_location,hotspot_city_order,route_hotspot_order FROM dvi_itinerary_route_hotspot_details WHERE itinerary_plans_id=? ORDER BY itinerary_route_ID,route_hotspot_order',
    [385],
  );
  console.log('ROUTE_HOTSPOTS_COUNT', rhs.length);
  console.log(rhs);

  await c.end();
})();
