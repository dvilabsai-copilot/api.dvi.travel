const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'dvi_user',
        password: 'myDvi123!',
        database: 'dvi_main'
    });
    
    const routeId = 4013;
    const [hotspots] = await conn.query(
      `SELECT h.hotspot_ID, p.hotspot_name, h.arrival_time, h.departure_time, h.route_hotspot_order, h.item_type
       FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
       WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1
       ORDER BY h.route_hotspot_order`,
      [routeId]
    );
    
    console.log(`\nRoute 4013 Hotspots after rebuild:`);
    console.table(hotspots.map(h => ({
      ID: h.hotspot_ID,
      Name: h.hotspot_name || (h.item_type === 1 ? 'START' : h.item_type === 2 ? 'END' : 'Unknown'),
      Type: h.item_type,
      Arrival: h.arrival_time,
      Departure: h.departure_time,
      Order: h.route_hotspot_order
    })));
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
