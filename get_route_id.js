const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'dvi_user',
        password: 'myDvi123!',
        database: 'dvi_main'
    });
    const [rows] = await conn.query(
        "SELECT itinerary_route_id, itinerary_day_no, location_name FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = (SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = 'DVI20260589') ORDER BY itinerary_day_no"
    );
    console.log(JSON.stringify(rows));
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
