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
    const [scheduled] = await conn.query(
      `SELECT h.hotspot_ID, p.hotspot_name, h.arrival_time, h.departure_time, h.route_hotspot_order
       FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
       WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1 AND h.item_type = 4
       ORDER BY h.route_hotspot_order`,
      [routeId]
    );

    console.log(`=== SCHEDULED FOR ROUTE ${routeId} ===`);
    scheduled.forEach(h => {
        console.log(`Order ${h.route_hotspot_order}: ${h.hotspot_name} (${h.arrival_time} - ${h.departure_time})`);
    });

    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
