const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host: 'localhost', user: 'dvi_user', password: 'myDvi123!', database: 'dvi_main' });
  const planId = 380;
  
  // Get current route IDs for plan 380
  const [routes] = await conn.query(
    `SELECT r.itinerary_route_ID, r.no_of_days, r.location_name, r.route_start_time, r.route_end_time, l.source_city_id, l.destination_city_id
     FROM dvi_itinerary_route_details r
     LEFT JOIN dvi_stored_locations l ON r.location_id = l.location_ID
     WHERE r.itinerary_plan_ID = ? ORDER BY r.itinerary_route_ID`, [planId]
  );
  console.log('Current routes for plan 380:');
  routes.forEach(r => console.log(`  Route ${r.itinerary_route_ID} Day${r.no_of_days}: ${r.location_name} | ${r.route_start_time}-${r.route_end_time} | src=${r.source_city_id} dst=${r.destination_city_id}`));
  
  // Get item_type=4 counts per route
  const routeIds = routes.map(r => r.itinerary_route_ID);
  for (const rid of routeIds) {
    const [items] = await conn.query(
      `SELECT h.item_type, COUNT(*) as cnt, GROUP_CONCAT(p.hotspot_name ORDER BY h.route_hotspot_order) as names
       FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
       WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1
       GROUP BY h.item_type`, [rid]
    );
    const attractions = items.find(i => i.item_type === 4);
    if (attractions) console.log(`  Route ${rid}: ${attractions.cnt} attractions => ${attractions.names}`);
    else console.log(`  Route ${rid}: 0 attractions`);
  }
  await conn.end();
})().catch(console.error);
