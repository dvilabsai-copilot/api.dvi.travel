const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host: 'localhost', user: 'dvi_user', password: 'myDvi123!', database: 'dvi_main' });
  const planId = 380;
  const [routes] = await conn.query(
    `SELECT itinerary_route_ID, no_of_days, location_name, route_start_time, route_end_time
     FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY itinerary_route_ID`, [planId]
  );
  console.log('Plan 380 routes:');
  routes.forEach(r => console.log(`  Route ${r.itinerary_route_ID} Day${r.no_of_days}: ${r.location_name} | ${r.route_start_time}-${r.route_end_time}`));
  const routeIds = routes.map(r => r.itinerary_route_ID);
  for (const rid of routeIds) {
    const [items] = await conn.query(
      `SELECT h.item_type, COUNT(*) as cnt, GROUP_CONCAT(p.hotspot_name ORDER BY h.route_hotspot_order SEPARATOR ' | ') as names
       FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
       WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1
       GROUP BY h.item_type`, [rid]
    );
    const a = items.find(i => i.item_type === 4);
    console.log(`  -> Route ${rid}: ${a ? a.cnt + ' attractions: ' + a.names : '0 attractions'}`);
  }
  await conn.end();
})().catch(console.error);
