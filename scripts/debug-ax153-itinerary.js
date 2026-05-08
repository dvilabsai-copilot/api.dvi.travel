const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({host:'localhost',user:'dvi_user',password:'myDvi123!',database:'dvi_main'});
  const quoteId = process.argv[2] || 'DVI20260523';

  const [p] = await c.query('SELECT * FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID=? LIMIT 1', [quoteId]);
  if (!p[0]) { console.log('NO PLAN found for', quoteId); await c.end(); return; }
  const plan = p[0];
  const pid = plan.itinerary_plan_ID;
  console.log('PLAN:', JSON.stringify({ itinerary_plan_ID: pid, quote: plan.itinerary_quote_ID, nights: plan.no_of_nights, meal: plan.meal_plan_code, adults: plan.total_adult, children: plan.total_children, start: plan.trip_start_date_and_time }));

  const [routeCols] = await c.query('DESCRIBE dvi_itinerary_route_details');
  const rcNames = routeCols.map(x => x.Field);
  console.log('route cols:', rcNames.join(', '));

  const [routes] = await c.query('SELECT * FROM dvi_itinerary_route_details WHERE itinerary_plan_id=? ORDER BY no_of_days', [pid]);
  routes.forEach(r => console.log('ROUTE:', JSON.stringify(r)));

  // Check hotel 153 availability data
  const [h] = await c.query('SELECT hotel_id,hotel_name,axisrooms_property_id,axisrooms_enabled FROM dvi_hotel WHERE hotel_id=153');
  console.log('HOTEL 153:', JSON.stringify(h[0]));

  // Check if hotel 153 rooms exist
  const [rooms] = await c.query('SELECT room_id,rateplan_id,axisrooms_room_id FROM dvi_hotel_room_rate_plan WHERE hotel_id=153 AND deleted=0');
  console.log('RATE PLANS 153:', JSON.stringify(rooms));

  // Check availability for Munnar route date (day 5 = 2026-05-13)
  const munnarRoute = routes.find(r => r.location_name && r.location_name.toLowerCase().includes('munnar'));
  if (munnarRoute) {
    const dateStr = new Date(munnarRoute.itinerary_route_date).toISOString().split('T')[0];
    console.log('Munnar route date:', dateStr, '(day', munnarRoute.no_of_days, ')');
    // Start date for hotel search = previous night
    const prevDate = new Date(munnarRoute.itinerary_route_date);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = prevDate.toISOString().split('T')[0];
    console.log('checking availability for check-in date (night before):', prevDateStr);
    const [avail] = await c.query('SELECT room_id,start_date,end_date,available_count,source FROM dvi_hotel_room_availability WHERE hotel_id=153 ORDER BY start_date LIMIT 10');
    console.log('AVAILABILITY hotel 153:', JSON.stringify(avail));
  }

  // Check what hotel is linked to location in itinerary_hotel_search_cache around Munnar
  const locationNames = routes.map(r => r.location_name || r.destination_location || '').filter(Boolean);
  console.log('route locations:', locationNames);
  if (locationNames.length > 0) {
    const [cache] = await c.query('SELECT * FROM dvi_itinerary_hotel_search_cache WHERE itinerary_plan_id=? LIMIT 5', [pid]);
    console.log('SEARCH CACHE:', JSON.stringify(cache));
  }

  await c.end();
})().catch(e => console.error('ERR:', e.message));
