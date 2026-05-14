const mysql = require("mysql2/promise");
(async () => {
 const conn = await mysql.createConnection("mysql://dvi_user:myDvi123!@localhost:3306/dvi_main");
 const [rows] = await conn.query("SELECT itinerary_route_ID, no_of_days, location_name, next_visiting_location, route_start_time, route_end_time, source_city_id, destination_city_id FROM dvi_itinerary_route_details WHERE itinerary_plan_ID=380 ORDER BY no_of_days");
 console.table(rows);
 await conn.end();
})().catch(console.error);
