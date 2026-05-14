const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const quote = "DVI20260587";
  const planRows = await p.$queryRawUnsafe(`SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = "${quote}" AND status=1 AND deleted=0 LIMIT 1`);
  const planId = Number((planRows?.[0] || {}).itinerary_plan_ID || 0);
  console.log("planId", planId);
  if (!planId) return;

  const dayRows = await p.$queryRawUnsafe(`
    SELECT
      r.itinerary_route_ID,
      DATE(r.itinerary_route_date) AS route_date,
      r.location_name,
      v.itinerary_plan_vendor_vehicle_details_ID,
      vb.vendor_branch_name,
      v.vendor_id,
      v.vehicle_id,
      v.vendor_vehicle_type_id,
      v.time_limit_id,
      tl.time_limit_title,
      tl.hours_limit,
      tl.km_limit,
      v.total_travelled_km,
      v.total_extra_km,
      v.extra_km_rate,
      v.total_extra_km_charges
    FROM dvi_itinerary_route_details r
    JOIN dvi_itinerary_plan_vendor_vehicle_details v ON v.itinerary_route_id = r.itinerary_route_ID
    LEFT JOIN dvi_vendor_branches vb ON vb.vendor_branch_id = v.vendor_branch_id
    LEFT JOIN dvi_time_limit tl ON tl.time_limit_id = v.time_limit_id
    WHERE r.itinerary_plan_ID = ${planId}
      AND DATE(r.itinerary_route_date) = "2026-05-19"
      AND r.status=1 AND r.deleted=0
      AND v.status=1 AND v.deleted=0
    ORDER BY vb.vendor_branch_name, v.itinerary_plan_vendor_vehicle_details_ID
  `);

  console.log(JSON.stringify(dayRows, null, 2));
})();
