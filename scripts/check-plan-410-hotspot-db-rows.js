const mysql = require('mysql2/promise');

const PLAN_ID = Number(process.env.PLAN_ID || 410);

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'dvi_user',
    password: process.env.DB_PASS || 'myDvi123!',
    database: process.env.DB_NAME || 'dvi_main',
    dateStrings: true,
  });

  const [routes] = await conn.query(
    `SELECT itinerary_route_ID, itinerary_route_date, no_of_days, location_name, next_visiting_location, direct_to_next_visiting_place
     FROM dvi_itinerary_route_details
     WHERE itinerary_plan_ID = ? AND deleted = 0 AND status = 1
     ORDER BY itinerary_route_date, itinerary_route_ID`,
    [PLAN_ID],
  );

  console.log('ROUTES_FOR_PLAN', PLAN_ID);
  console.table(routes);

  const [rows] = await conn.query(
    `SELECT
      r.itinerary_route_ID,
      r.itinerary_route_date,
      r.no_of_days,
      r.location_name,
      r.next_visiting_location,
      r.direct_to_next_visiting_place,
      h.hotspot_order,
      h.item_type,
      h.hotspot_ID,
      hp.hotspot_name,
      h.hotspot_start_time,
      h.hotspot_end_time,
      h.deleted,
      h.status
    FROM dvi_itinerary_route_details r
    LEFT JOIN dvi_itinerary_route_hotspot_details h
      ON h.itinerary_route_ID = r.itinerary_route_ID
      AND h.deleted = 0
      AND h.status = 1
    LEFT JOIN dvi_hotspot_place hp
      ON hp.hotspot_ID = h.hotspot_ID
    WHERE r.itinerary_plan_ID = ?
      AND r.deleted = 0
      AND r.status = 1
    ORDER BY r.itinerary_route_date, r.itinerary_route_ID, h.hotspot_order`,
    [PLAN_ID],
  );

  console.log('HOTSPOT_ROWS_FOR_PLAN', PLAN_ID);
  console.table(rows);
  const day2 = rows.filter((r) => Number(r.no_of_days || 0) === 2 && Number(r.item_type || 0) === 4);
  const ids = day2.map((r) => Number(r.hotspot_ID || 0));
  const required = [228];
  const forbidden = [245, 243, 241, 357];
  const requiredMissing = required.filter((id) => !ids.includes(id));
  const forbiddenPresent = forbidden.filter((id) => ids.includes(id));
  console.log('DIRECT_ON_DAY2_ITEM_TYPE_4_ROWS');
  console.table(day2.map((r) => ({
    itinerary_route_ID: r.itinerary_route_ID,
    no_of_days: r.no_of_days,
    direct_to_next_visiting_place: r.direct_to_next_visiting_place,
    hotspot_order: r.hotspot_order,
    hotspot_ID: r.hotspot_ID,
    hotspot_name: r.hotspot_name,
    hotspot_start_time: r.hotspot_start_time,
    hotspot_end_time: r.hotspot_end_time,
  })));
  console.log('DIRECT_ON_DAY2_VALIDATION', { required, forbidden, requiredMissing, forbiddenPresent });

  await conn.end();
  if (requiredMissing.length > 0 || forbiddenPresent.length > 0) process.exit(2);
})();
