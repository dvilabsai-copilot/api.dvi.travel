const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({host:'localhost',user:'root',password:'',database:'dvi_main'});
  
  const [[plan]] = await c.query('SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_plan_no = ? LIMIT 1', ['DVI20260588']);
  if (!plan) { console.log('Plan not found'); await c.end(); return; }
  const planId = plan.itinerary_plan_ID;
  console.log('Plan ID:', planId);

  const [rows] = await c.query(
    'SELECT time_limit_id, travel_type, itinerary_route_date, itinerary_route_location_from, itinerary_route_location_to FROM dvi_itinerary_plan_vendor_vehicle_details WHERE itinerary_plan_id = ? ORDER BY itinerary_route_date',
    [planId]
  );
  console.log('Vehicle details:', JSON.stringify(rows, null, 2));

  // Check dvi_time_limit for vendors in this plan
  const [eligibles] = await c.query(
    'SELECT vendor_id, vendor_vehicle_type_id, itineary_plan_assigned_status FROM dvi_itinerary_plan_vendor_eligible_list WHERE itinerary_plan_id = ? AND deleted = 0',
    [planId]
  );
  console.log('Eligible vendors:', JSON.stringify(eligibles, null, 2));

  for (const e of eligibles) {
    const [slabs] = await c.query(
      'SELECT time_limit_id, time_limit_title FROM dvi_time_limit WHERE vendor_id = ? AND vendor_vehicle_type_id = ? AND deleted = 0 AND status = 1',
      [e.vendor_id, e.vendor_vehicle_type_id]
    );
    console.log(`Slabs for vendor ${e.vendor_id} / vvt ${e.vendor_vehicle_type_id}:`, JSON.stringify(slabs));
  }

  await c.end();
})();
