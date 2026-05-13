const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    
    console.log("=== Plan for DVI20260588 ===");
    const [plans] = await conn.query("SELECT itinerary_plan_id FROM dvi_itinerary_plan_details WHERE itinerary_code = 'DVI20260588'");
    console.log('Plans:', plans);
    
    if (plans.length > 0) {
      const planId = plans[0].itinerary_plan_id;
      console.log(`\n=== Routes for Plan ${planId} ===`);
      const [routes] = await conn.query(
        `SELECT itinerary_route_id, day_number FROM dvi_itinerary_route_details WHERE itinerary_plan_id = ? ORDER BY day_number`,
        [planId]
      );
      console.table(routes);
      
      console.log(`\n=== Day 4 route details ===`);
      const [day4] = await conn.query(
        `SELECT * FROM dvi_itinerary_route_details WHERE itinerary_plan_id = ? AND day_number = 4`,
        [planId]
      );
      console.dir(day4, { depth: null });
    }
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
