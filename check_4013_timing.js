const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'dvi_user',
        password: 'myDvi123!',
        database: 'dvi_main'
    });
    
    const [route] = await conn.query(
      `SELECT itinerary_route_ID, location_name, route_start_time, route_end_time, no_of_km 
       FROM dvi_itinerary_route_details WHERE itinerary_route_ID = 4013`
    );
    
    const r = route[0];
    console.log('=== ROUTE 4013 TIMING ===');
    console.log(`Location: ${r.location_name}`);
    console.log(`Start time: ${r.route_start_time}`);
    console.log(`End time: ${r.route_end_time}`);
    console.log(`KM: ${r.no_of_km}`);
    
    const [hotspots] = await conn.query(
      `SELECT h.hotspot_ID, p.hotspot_name, h.arrival_time, h.departure_time
       FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
       WHERE h.itinerary_route_ID = 4013 AND h.deleted = 0 AND h.status = 1 AND h.item_type = 4
       ORDER BY h.arrival_time`
    );
    
    console.log(`\nScheduled hotspots: ${hotspots.length}`);
    hotspots.forEach(h => {
      console.log(`  ${h.hotspot_name}: ${h.arrival_time} - ${h.departure_time}`);
    });
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
