const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');

  const [h] = await conn.query(`SELECT * FROM dvi_hotspot_place WHERE hotspot_ID = 675`);
  console.log('=== HOTSPOT 675 ===');
  console.dir(h[0], { depth: null });

  const [timing] = await conn.query(`SELECT * FROM dvi_hotspot_timing WHERE hotspot_id = 675`);
  console.log('\n=== TIMING RECORDS ===');
  console.dir(timing, { depth: null });

  const [used] = await conn.query(`SELECT itinerary_route_ID, hotspot_start_time, hotspot_end_time FROM dvi_itinerary_route_hotspot_details WHERE hotspot_ID = 675 AND itinerary_plan_ID = 380 AND deleted = 0`);
  console.log('\n=== HOTSPOT 675 USAGE IN PLAN 380 ===');
  console.dir(used, { depth: null });

  const [route] = await conn.query(`SELECT * FROM dvi_itinerary_route_details WHERE itinerary_route_ID = 4068`);
  console.log('\n=== ROUTE 4068 DETAILS ===');
  if (route[0]) console.dir(route[0], { depth: null }); else console.log('Route 4068 not found.');

  const [sched] = await conn.query(`SELECT h.hotspot_ID, p.hotspot_name, h.hotspot_start_time, h.hotspot_end_time, h.route_hotspot_order FROM dvi_itinerary_route_hotspot_details h LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID WHERE h.itinerary_route_ID = 4068 AND h.deleted = 0 ORDER BY h.route_hotspot_order`);
  console.log('\n=== SCHEDULED ON ROUTE 4068 ===');
  console.dir(sched, { depth: null });

  const [city] = await conn.query(`SELECT city_ID, hotspot_name, hotspot_location, hotspot_priority, hotspot_duration FROM dvi_hotspot_place WHERE hotspot_ID = 675`);
  console.log('\n=== HOTSPOT 675 CITY/LOCATION ===');
  console.dir(city[0], { depth: null });

  if (route[0]) {
    const [r4068] = await conn.query(`SELECT source_city_id, destination_city_id FROM dvi_stored_locations WHERE location_ID = ?`, [route[0].location_id]);
    console.log('\n=== ROUTE 4068 CITY IDs ===');
    console.dir(r4068[0], { depth: null });
  }

  const [plan] = await conn.query(`SELECT excluded_hotspot_ids FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = 380`);
  console.log('\n=== PLAN 380 EXCLUDED HOTSPOT IDs ===');
  console.log(plan[0]?.excluded_hotspot_ids);

  const [allUsed] = await conn.query(`SELECT DISTINCT hotspot_ID FROM dvi_itinerary_route_hotspot_details WHERE itinerary_plan_ID = 380 AND itinerary_route_ID != 4068 AND deleted = 0 AND item_type = 4`);
  console.log('\n=== ALL HOTSPOT IDs USED ON OTHER ROUTES (plan 380, excluding 4068) ===');
  console.log(allUsed.map(r => r.hotspot_ID).join(', '));

  await conn.end();
})().catch(e => console.error(e));
