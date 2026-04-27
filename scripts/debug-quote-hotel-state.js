require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const quoteId = process.argv[2];
  if (!quoteId) throw new Error('Usage: node scripts/debug-quote-hotel-state.js <QUOTE_ID>');

  const m = process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!m) throw new Error('Invalid DATABASE_URL');

  const conn = await mysql.createConnection({
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    database: m[5],
  });

  const [planRows] = await conn.query(
    `SELECT itinerary_plan_ID, itinerary_quote_ID, itinerary_preference, no_of_days, no_of_nights, preferred_room_count,
            meal_plan_breakfast, meal_plan_lunch, meal_plan_dinner, meal_plan_code,
            trip_start_date_and_time, trip_end_date_and_time, deleted, status
     FROM dvi_itinerary_plan_details
     WHERE itinerary_quote_ID = ?
     ORDER BY itinerary_plan_ID DESC
     LIMIT 1`,
    [quoteId]
  );

  const plan = planRows[0];
  if (!plan) {
    console.log(JSON.stringify({ quoteId, found: false }, null, 2));
    await conn.end();
    return;
  }

  const [routes] = await conn.query(
    `SELECT itinerary_route_ID, location_id, location_name, itinerary_route_date, no_of_days, no_of_km, status, deleted
     FROM dvi_itinerary_route_details
     WHERE itinerary_plan_ID = ? AND deleted = 0
     ORDER BY itinerary_route_ID ASC`,
    [plan.itinerary_plan_ID]
  );

  const [hotelRows] = await conn.query(
    `SELECT itinerary_plan_hotel_details_ID, itinerary_route_id, group_type, hotel_id, hotel_code, total_hotel_cost, total_hotel_tax_amount, status, deleted
     FROM dvi_itinerary_plan_hotel_details
     WHERE itinerary_plan_id = ? AND deleted = 0
     ORDER BY group_type ASC, itinerary_route_id ASC`,
    [plan.itinerary_plan_ID]
  );

  const [activeHotelRows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM dvi_itinerary_plan_hotel_details
     WHERE itinerary_plan_id = ? AND deleted = 0 AND hotel_id > 0`,
    [plan.itinerary_plan_ID]
  );

  console.log(JSON.stringify({
    quoteId,
    plan,
    routeCount: routes.length,
    routes,
    hotelRowCount: hotelRows.length,
    activeHotelRowCount: Number(activeHotelRows[0]?.cnt || 0),
    sampleHotelRows: hotelRows.slice(0, 20),
  }, null, 2));

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
