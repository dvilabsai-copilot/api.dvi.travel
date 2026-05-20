require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const m = process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c = await mysql.createConnection({
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    database: m[5],
  });

  const q = "SELECT iphrd.itinerary_plan_id, iphrd.itinerary_route_id, iphd.hotel_id, hl.hotel_name, hc.city_name, iphrd.amenities, iphrd.inclusions, iphrd.rate_conditions, iphrd.supplement_summary FROM dvi_itinerary_plan_hotel_room_details iphrd INNER JOIN dvi_itinerary_plan_hotel_details iphd ON iphd.itinerary_plan_id=iphrd.itinerary_plan_id AND iphd.itinerary_route_id=iphrd.itinerary_route_id AND iphd.group_type=iphrd.group_type AND iphd.deleted=0 INNER JOIN dvi_hotel_list hl ON hl.hotel_id=iphd.hotel_id LEFT JOIN dvi_hotel_city hc ON hc.city_id=hl.city_id WHERE iphrd.deleted=0 AND (COALESCE(NULLIF(TRIM(iphrd.amenities),''),'')<>'' OR COALESCE(NULLIF(TRIM(iphrd.inclusions),''),'')<>'' OR COALESCE(NULLIF(TRIM(iphrd.rate_conditions),''),'')<>'' OR COALESCE(NULLIF(TRIM(iphrd.supplement_summary),''),'')<>'') ORDER BY iphrd.updatedon DESC LIMIT 40";
  const [rows] = await c.query(q);
  console.log(JSON.stringify(rows, null, 2));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
