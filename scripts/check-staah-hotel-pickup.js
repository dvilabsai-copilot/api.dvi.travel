const mysql = require('mysql2/promise');
const axios = require('axios');

(async () => {
  const quoteId = process.argv[2] || 'DVI20260589';
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  const conn = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'dvi_user', password: process.env.DB_PASS || 'myDvi123!', database: process.env.DB_NAME || 'dvi_main' });

  const [planRows] = await conn.query('SELECT itinerary_plan_ID, no_of_nights FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID=? LIMIT 1', [quoteId]);
  if (!planRows[0]) { console.log('Plan not found'); await conn.end(); return; }
  const planId = planRows[0].itinerary_plan_ID;
  console.log('Plan:', planId, 'Quote:', quoteId);

  const [hotelRows] = await conn.query('SELECT hotel_id,hotel_name,hotel_city,hotel_place,hotel_category,status,deleted,staah_enabled,staah_property_id FROM dvi_hotel WHERE hotel_id=44674');
  console.log('dvi_hotel[44674]:', hotelRows[0] || null);

  const [routes] = await conn.query('SELECT itinerary_route_ID,itinerary_route_date,next_visiting_location,no_of_days FROM dvi_itinerary_route_details WHERE itinerary_plan_id=? AND deleted=0 ORDER BY no_of_days ASC', [planId]);
  const routeDates = routes.map(r => new Date(r.itinerary_route_date).toISOString().split('T')[0]);
  const minDate = routeDates[0];
  const maxDate = routeDates[routeDates.length - 1];

  const propertyId = 'STAAHTESTHOTEL1';
  const [rps] = await conn.query('SELECT * FROM staah_rateplan WHERE staah_property_id=?', [propertyId]);
  const [inv] = await conn.query('SELECT * FROM staah_inventory WHERE staah_property_id=? AND start_date <= ? AND end_date >= ?', [propertyId, maxDate, minDate]);
  const [rates] = await conn.query('SELECT * FROM staah_rate WHERE staah_property_id=? AND start_date <= ? AND end_date >= ?', [propertyId, maxDate, minDate]);
  const [res] = await conn.query('SELECT * FROM staah_restriction WHERE staah_property_id=? AND start_date <= ? AND end_date >= ?', [propertyId, maxDate, minDate]);
  console.log('staah_rateplan rows:', rps.length);
  console.log(rps);
  console.log('staah_inventory overlap rows:', inv.length);
  console.log(inv);
  console.log('staah_rate overlap rows:', rates.length);
  console.log(rates);
  console.log('staah_restriction overlap rows:', res.length);
  console.log(res);

  const response = await axios.get(`${baseUrl}/api/v1/itineraries/hotel_details/${quoteId}`);
  const rows = response.data?.data?.hotel_rows || response.data?.hotel_rows || [];
  const routeMap = new Map();
  for (const row of rows) {
    const rid = Number(row.itinerary_route_ID || row.routeId || row.itineraryRouteId || 0);
    if (!routeMap.has(rid)) routeMap.set(rid, []);
    routeMap.get(rid).push(row);
  }
  console.log('API route count:', routeMap.size);
  for (const [rid, list] of routeMap.entries()) {
    console.log(`Route ${rid} hotels: ${list.length}`);
    for (const h of list) {
      console.log(`  - provider=${String(h.provider || '').toLowerCase()} hotelCode=${h.hotelCode} hotelName=${h.hotelName} price=${h.price} mealPlan=${h.mealPlan || '-'}`);
    }
  }
  const hit = rows.find(h => String(h.provider || '').toLowerCase() === 'staah' && String(h.hotelCode) === '44674');
  console.log('STAAH 44674 present:', !!hit);
  if (hit) console.log('Matched row:', { provider: hit.provider, hotelCode: hit.hotelCode, hotelName: hit.hotelName, price: hit.price, mealPlan: hit.mealPlan });

  if (!hit) {
    const stopsell = res.some(r => {
      const t = String(r.type || r.name || r.restriction_type || '').toLowerCase();
      const v = String(r.value || '').toLowerCase();
      return (t.includes('stopsell') || t.includes('stop_sell')) && ['1','true','yes','y'].includes(v);
    });
    if (!hotelRows[0] || Number(hotelRows[0].staah_enabled) !== 1) console.log('Reason: staah_enabled not set');
    else if (!inv.length) console.log('Reason: no inventory');
    else if (!rps.length) console.log('Reason: no rateplan');
    else if (!rates.length) console.log('Reason: no rate');
    else if (stopsell) console.log('Reason: stopsell restriction');
    else console.log('Reason: city mismatch / preferred filters / other upstream filter');
  }

  await conn.end();
})().catch(async (e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
