const mysql = require("mysql2/promise");
(async () => {
  const conn = await mysql.createConnection({ host: "localhost", user: "dvi_user", password: "myDvi123!", database: "dvi_main" });
  const [r] = await conn.query("SELECT itinerary_route_ID, created_at FROM dvi_itinerary_plan_route WHERE itinerary_route_ID IN (4110,4111,4112,4113,4114) ORDER BY itinerary_route_ID");
  r.forEach(row => console.log("route", row.itinerary_route_ID, "created_at:", row.created_at));
  await conn.end();
})().catch(console.error);
