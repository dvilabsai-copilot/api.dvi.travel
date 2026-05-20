const mysql = require('mysql2/promise');

mysql.createConnection({
  host: 'localhost',
  user: 'dvi_user',
  password: 'myDvi123!',
  database: 'dvi_main',
}).then(async (conn) => {
  const [rows] = await conn.query(
    "SELECT agent_id,nationality,trip_start_date_and_time,trip_end_date_and_time,no_of_nights,no_of_days,total_adult,total_children,total_infants,arrival_location,departure_location,meal_plan_code,expecting_budget,preferred_hotel_category,itinerary_plan_ID,itinerary_type,itinerary_preference,meal_plan_breakfast,meal_plan_lunch,meal_plan_dinner,preferred_room_count FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID='DVI20260320' LIMIT 1"
  );
  const row = rows[0];
  console.log('plan:', JSON.stringify(row, null, 2));

  const [rrows] = await conn.query(
    'SELECT location_name,next_visiting_location,itinerary_route_date,no_of_days,no_of_km,direct_to_next_visiting_place FROM dvi_itinerary_route_details WHERE itinerary_plan_ID=? ORDER BY no_of_days',
    [row.itinerary_plan_ID]
  );
  console.log('routes:', JSON.stringify(rrows, null, 2));

  const [trows] = await conn.query(
    'SELECT room_id,traveller_type,traveller_age FROM dvi_itinerary_traveller_details WHERE itinerary_plan_ID=?',
    [row.itinerary_plan_ID]
  );
  console.log('travellers:', JSON.stringify(trows, null, 2));
  await conn.end();
}).catch((e) => console.error(e));
