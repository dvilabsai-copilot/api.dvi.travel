const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    
    console.log("=== Finding Plan for DVI20260588 ===");
    const [plans] = await conn.query(
      "SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = 'DVI20260588'"
    );
    console.log('Plan result:', plans);
    
    if (plans.length > 0) {
      const planId = plans[0].itinerary_plan_ID;
      console.log(`\nPlan ID: ${planId}`);
      
      console.log(`\n=== All routes for Plan ${planId} ===`);
      const [routes] = await conn.query(
        `SELECT itinerary_route_ID, day_number FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY day_number`,
        [planId]
      );
      console.table(routes);
      
      console.log(`\n=== Hotspots currently on route 4008 ===`);
      const [hotspots] = await conn.query(
        `SELECT COUNT(*) as count FROM dvi_itinerary_route_hotspot_details WHERE itinerary_route_ID = 4008 AND deleted = 0 AND status = 1`
      );
      console.log('Hotspot count on route 4008:', hotspots[0].count);
    }
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
