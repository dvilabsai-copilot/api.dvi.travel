const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection({ host: 'localhost', user: 'dvi_user', password: 'myDvi123!', database: 'dvi_main' });
    const [routes] = await conn.query("SELECT * FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = 381 ORDER BY itinerary_day_no");
    console.table(routes.map(r => ({ Day: r.itinerary_day_no, RouteID: r.itinerary_route_ID, Location: r.location_name, SourceCity: r.source_city_id, DestCity: r.destination_city_id })));
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
