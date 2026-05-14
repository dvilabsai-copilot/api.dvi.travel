const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'dvi_user',
        password: 'myDvi123!',
        database: 'dvi_main'
    });
    const planId = 380;
    const [routes] = await conn.query(
      `SELECT r.itinerary_route_ID, r.no_of_days, r.itinerary_route_date, r.location_name, l.source_city_id, l.destination_city_id
       FROM dvi_itinerary_route_details r
       LEFT JOIN dvi_stored_locations l ON r.location_id = l.location_ID
       WHERE r.itinerary_plan_ID = ?
       ORDER BY r.itinerary_route_ID`, [planId]
    );
    console.log('=== ROUTES ===');
    console.table(routes);
    if (routes.length > 0) {
      const routeIds = routes.map(r => r.itinerary_route_ID);
      const [counts] = await conn.query(
        `SELECT itinerary_route_ID, item_type, COUNT(*) as count 
         FROM dvi_itinerary_route_hotspot_details 
         WHERE itinerary_route_ID IN (?) AND deleted = 0 AND status = 1 
         GROUP BY itinerary_route_ID, item_type`, [routeIds]
      );
      console.log('=== ITEM COUNTS ===');
      console.table(counts);
      for (const rid of routeIds) {
        const [rows] = await conn.query(
          `SELECT h.itinerary_route_ID, h.hotspot_ID, h.item_type, h.arrival_time, h.departure_time, h.route_hotspot_order, p.hotspot_name
           FROM dvi_itinerary_route_hotspot_details h
           LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
           WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1
           ORDER BY h.route_hotspot_order LIMIT 10`, [rid]
        );
        console.log(`\nRoute ID: ${rid}`);
        console.table(rows);
      }
    }
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
