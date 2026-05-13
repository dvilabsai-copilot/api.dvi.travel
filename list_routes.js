const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    const planId = 380;
    
    // Get all routes for plan 380
    const [routes] = await conn.query(
      `SELECT * FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY itinerary_day_no`,
      [planId]
    );
    
    console.log(`=== ROUTES FOR PLAN ${planId} ===`);
    for (const r of routes) {
        console.log(`Day ${r.itinerary_day_no}: ID ${r.itinerary_route_ID}, Location: ${r.location_name}`);
    }
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
