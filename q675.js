const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');

  const [h] = await conn.query('SELECT hotspot_ID, hotspot_name, hotspot_location, city_ID, hotspot_duration, hotspot_priority FROM dvi_hotspot_place WHERE hotspot_ID = 675');
  console.log('=== HOTSPOT 675 ===');
  console.dir(h[0], { depth: null });

  const [timing] = await conn.query('SELECT * FROM dvi_hotspot_timing WHERE hotspot_id = 675');
  console.log('\n=== TIMING ===');
  console.dir(timing, { depth: null });

  const [usedInPlan] = await conn.query('SELECT itinerary_route_ID, hotspot_start_time FROM dvi_itinerary_route_hotspot_details WHERE hotspot_ID = 675 AND itinerary_plan_ID = 380 AND deleted = 0');
  console.log('\n=== USED IN PLAN 380 ===');
  console.dir(usedInPlan, { depth: null });

  const [plan] = await conn.query('SELECT excluded_hotspot_ids FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = 380');
  const excluded = (plan[0]?.excluded_hotspot_ids || '').split(',').map(Number).filter(Boolean);
  console.log('\n=== EXCLUDED IDs IN PLAN 380 ===');
  console.log(excluded);
  console.log('Is 675 excluded?', excluded.includes(675));

  const [allUsedOther] = await conn.query('SELECT DISTINCT hotspot_ID FROM dvi_itinerary_route_hotspot_details WHERE itinerary_plan_ID = 380 AND itinerary_route_ID != 4068 AND deleted = 0 AND item_type = 4');
  const usedOtherIds = allUsedOther.map(r => r.hotspot_ID);
  console.log('\n=== ALL HOTSPOT IDs ON OTHER ROUTES (plan 380, not route 4068) ===');
  console.log(usedOtherIds.join(', '));
  console.log('Is 675 in used-on-other-routes?', usedOtherIds.includes(675));

  const [route] = await conn.query('SELECT route_start_time, route_end_time, no_of_km, source_city_id, destination_city_id FROM dvi_itinerary_route_details WHERE itinerary_route_ID = 4068');
  console.log('\n=== ROUTE 4068 ===');
  console.dir(route[0], { depth: null });

  const [sched] = await conn.query('SELECT h.hotspot_ID, p.hotspot_name, h.hotspot_start_time, h.hotspot_end_time FROM dvi_itinerary_route_hotspot_details h LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID WHERE h.itinerary_route_ID = 4068 AND h.deleted = 0 ORDER BY h.hotspot_order');
  console.log('\n=== SCHEDULED ON 4068 ===');
  console.dir(sched, { depth: null });

  const [r4068loc] = await conn.query('SELECT rd.location_id, rd.source_city_id, rd.destination_city_id FROM dvi_itinerary_route_details rd WHERE rd.itinerary_route_ID = 4068');
  const loc = r4068loc[0];
  console.log('\n=== ROUTE 4068 CITY IDs ===');
  console.dir(loc, { depth: null });

  if (loc) {
    const [cityMatch] = await conn.query('SELECT hotspot_ID, hotspot_name FROM dvi_hotspot_place WHERE hotspot_ID = 675 AND (city_ID = ? OR city_ID = ?)', [loc.source_city_id, loc.destination_city_id]);
    console.log('\n=== IS 675 IN ROUTE CITY POOL? ===');
    console.log(cityMatch.length > 0 ? 'YES - in pool' : 'NO - city_ID mismatch, NOT in pool');
  }

  await conn.end();
})().catch(e => console.error(e));
