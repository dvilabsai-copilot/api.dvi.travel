const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'dvi_user',
        password: 'myDvi123!',
        database: 'dvi_main'
    });
    
    console.log('--- 1. DESCRIBE dvi_itinerary_route_details ---');
    const [cols] = await conn.query('DESCRIBE dvi_itinerary_route_details');
    console.log(cols.map(c => c.Field).join(', '));
    
    const planId = 380;
    console.log(`\n--- 2. Routes for plan ${planId} ---`);
    const [routes] = await conn.query(
      `SELECT itinerary_route_ID, no_of_days, itinerary_route_date, location_name, route_start_time, route_end_time 
       FROM dvi_itinerary_route_details 
       WHERE itinerary_plan_ID = ? 
       ORDER BY itinerary_route_ID`, [planId]
    );
    console.table(routes);
    
    if (routes.length > 0) {
      const routeIds = routes.map(r => r.itinerary_route_ID);
      
      console.log('\n--- 3 & 4. Grouped item counts and Hotspot counts (item_type=4) ---');
      const [counts] = await conn.query(
        `SELECT itinerary_route_ID, item_type, COUNT(*) as count 
         FROM dvi_itinerary_route_hotspot_details 
         WHERE itinerary_route_ID IN (?) AND deleted = 0 AND status = 1 
         GROUP BY itinerary_route_ID, item_type`, [routeIds]
      );
      console.table(counts);
      
      console.log('\n--- 5. First 20 rows for Route 4013 and 4073 ---');
      for (const rid of [4013, 4073]) {
        console.log(`\nRoute ID: ${rid}`);
        const [rows] = await conn.query(
          `SELECT itinerary_route_ID, hotspot_ID, item_type, arrival_time, departure_time, route_hotspot_order
           FROM dvi_itinerary_route_hotspot_details 
           WHERE itinerary_route_ID = ? AND deleted = 0 AND status = 1 
           ORDER BY route_hotspot_order LIMIT 20`, [rid]
        );
        console.table(rows);
      }
    }
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
