const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const q = "DVI20260587";
  const planRows = await p.$queryRawUnsafe(`SELECT itinerary_plan_ID FROM dvi_itinerary_plan WHERE itinerary_ref_no = "${q}" LIMIT 1`);
  const planId = Number((planRows?.[0] || {}).itinerary_plan_ID || 0);
  if (!planId) {
    console.log("PLAN_NOT_FOUND");
    return;
  }

  console.log("planId", planId);

  const sql = `
    SELECT
      r.itinerary_route_ID,
      DATE(r.itinerary_route_date) AS route_date,
      r.route_location_to,
      v.vendor_id,
      vb.vendor_branch_name,
      v.vendor_vehicle_type_id,
      v.vehicle_id,
      v.time_limit_id,
      tl.time_limit_title,
      tl.hours_limit,
      tl.km_limit,
      v.total_running_km,
      v.total_siteseeing_km,
      v.total_travelled_km,
      v.total_extra_km,
      v.extra_km_rate,
      v.total_extra_km_charges
    FROM dvi_itinerary_route r
    JOIN dvi_itinerary_plan_vendor_vehicle_details v
      ON v.itinerary_route_id = r.itinerary_route_ID
    LEFT JOIN dvi_vendor_branch vb
      ON vb.vendor_branch_id = v.vendor_branch_id
    LEFT JOIN dvi_time_limit tl
      ON tl.time_limit_id = v.time_limit_id
    WHERE r.itinerary_plan_ID = ${planId}
      AND DATE(r.itinerary_route_date) = "2026-05-19"
    ORDER BY vb.vendor_branch_name, v.itinerary_plan_vendor_vehicle_details_ID
  `;

  const rows = await p.$queryRawUnsafe(sql);
  console.log(JSON.stringify(rows, null, 2));

  const slabRows = await p.$queryRawUnsafe(`
    SELECT time_limit_id, time_limit_title, hours_limit, km_limit
    FROM dvi_time_limit
    WHERE time_limit_id IN (
      SELECT DISTINCT time_limit_id
      FROM dvi_itinerary_plan_vendor_vehicle_details
      WHERE itinerary_route_id IN (
        SELECT itinerary_route_ID
        FROM dvi_itinerary_route
        WHERE itinerary_plan_ID = ${planId} AND DATE(itinerary_route_date) = "2026-05-19"
      )
    )
    ORDER BY time_limit_id
  `);
  console.log("SLABS", JSON.stringify(slabRows, null, 2));
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await p.$disconnect();
  });
