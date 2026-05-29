const { PrismaClient } = require('@prisma/client');
const fs = require('fs/promises');

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PLAN_ID = Number(process.env.PLAN_ID || 386);
const QUOTE_ID = process.env.QUOTE_ID || 'DVI20260594';
const jsonSafe = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2);

const POST_PAYLOAD = {
  plan: {
    itinerary_plan_id: 386,
    agent_id: 126,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Chennai International Airport',
    departure_point: 'Chennai International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [3, 4],
    hotel_facilities: [],
    trip_start_date: '2026-06-02T08:00:00+05:30',
    trip_end_date: '2026-06-04T20:00:00+05:30',
    pick_up_date_and_time: '2026-06-02T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 2,
    no_of_days: 3,
    budget: 15000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 101,
    food_type: 0,
    meal_plan_code: 'EP',
    meal_plan_breakfast: 0,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 1,
    child_count: 0,
    infant_count: 0,
    special_instructions: 'DEBUG duplicate vehicle and MUV zero build trace'
  },
  routes: [
    {
      location_name: 'Chennai International Airport',
      next_visiting_location: 'Chennai',
      itinerary_route_date: '2026-06-02T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 16.61,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    },
    {
      location_name: 'Chennai',
      next_visiting_location: 'Chennai',
      itinerary_route_date: '2026-06-03T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 33,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    },
    {
      location_name: 'Chennai',
      next_visiting_location: 'Chennai International Airport',
      itinerary_route_date: '2026-06-04T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 33,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    }
  ],
  vehicles: [
    { vehicle_type_id: 1, vehicle_count: 1 },
    { vehicle_type_id: 23, vehicle_count: 1 }
  ],
  travellers: [{ room_id: 1, traveller_type: 1 }],
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false
};

async function runSnapshot(prisma, planId) {
  const vehicleDetailRows = await prisma.$queryRawUnsafe(`SELECT
  itinerary_plan_vendor_vehicle_details_ID,
  itinerary_plan_vendor_eligible_ID,
  itinerary_route_id,
  itinerary_route_date,
  vehicle_type_id,
  vendor_vehicle_type_id,
  vehicle_id,
  total_pickup_km,
  total_running_km,
  total_siteseeing_km,
  total_drop_km,
  total_travelled_km,
  vehicle_rental_charges,
  total_vehicle_amount,
  deleted,
  status
FROM dvi_itinerary_plan_vendor_vehicle_details
WHERE itinerary_plan_id = ?
ORDER BY itinerary_plan_vendor_eligible_ID, itinerary_route_date, itinerary_plan_vendor_vehicle_details_ID;`, planId);

  const duplicateGroups = await prisma.$queryRawUnsafe(`SELECT
  itinerary_plan_vendor_eligible_ID,
  itinerary_route_id,
  COUNT(*) AS row_count
FROM dvi_itinerary_plan_vendor_vehicle_details
WHERE itinerary_plan_id = ?
GROUP BY itinerary_plan_vendor_eligible_ID, itinerary_route_id
HAVING COUNT(*) > 1;`, planId);

  const eligibleRows = await prisma.$queryRawUnsafe(`SELECT
  itinerary_plan_vendor_eligible_ID,
  itinerary_plan_id,
  vendor_id,
  vendor_branch_id,
  vehicle_type_id,
  vendor_vehicle_type_id,
  vehicle_id,
  total_vehicle_qty,
  itineary_plan_assigned_status,
  deleted,
  status
FROM dvi_itinerary_plan_vendor_eligible_list
WHERE itinerary_plan_id = ?
ORDER BY itinerary_plan_vendor_eligible_ID;`, planId);

  let requestedVehicleRows;
  try {
    requestedVehicleRows = await prisma.$queryRawUnsafe(`SELECT
    itinerary_plan_vehicle_details_ID,
    itinerary_plan_id,
    vehicle_type_id,
    no_of_vehicles,
    deleted,
    status
  FROM dvi_itinerary_plan_vehicle_details
  WHERE itinerary_plan_id = ?
  ORDER BY itinerary_plan_vehicle_details_ID;`, planId);
  } catch (_) {
    requestedVehicleRows = await prisma.$queryRawUnsafe(`SELECT *
    FROM dvi_itinerary_plan_vehicle_details
    WHERE itinerary_plan_id = ?
    ORDER BY itinerary_plan_id, vehicle_type_id;`, planId);
  }

  let vendorVehicleTypeRows;
  try {
    vendorVehicleTypeRows = await prisma.$queryRawUnsafe(`SELECT
    vendor_vehicle_type_ID,
    vendor_id,
    vehicle_type_id,
    vehicle_type_name,
    status,
    deleted
  FROM vendor_vehicle_type
  WHERE vehicle_type_id IN (1, 23)
  ORDER BY vehicle_type_id, vendor_vehicle_type_ID;`);
  } catch (_) {
    vendorVehicleTypeRows = await prisma.$queryRawUnsafe(`SELECT *
  FROM dvi_vendor_vehicle_types
  WHERE vehicle_type_id IN (1, 23)
  ORDER BY vehicle_type_id, vendor_vehicle_type_ID;`);
  }

  let timeLimitRows;
  try {
    timeLimitRows = await prisma.$queryRawUnsafe(`SELECT
    time_limit_id,
    vendor_id,
    vendor_vehicle_type_id,
    time_limit_title,
    hours_limit,
    km_limit,
    deleted,
    status
  FROM dvi_time_limit
  WHERE vendor_vehicle_type_id IN (
    SELECT vendor_vehicle_type_ID
    FROM vendor_vehicle_type
    WHERE vehicle_type_id IN (1, 23)
  )
  ORDER BY vendor_vehicle_type_id, time_limit_id;`);
  } catch (_) {
    timeLimitRows = await prisma.$queryRawUnsafe(`SELECT
    time_limit_id,
    vendor_id,
    vendor_vehicle_type_id,
    time_limit_title,
    hours_limit,
    km_limit,
    deleted,
    status
  FROM dvi_time_limit
  WHERE vendor_vehicle_type_id IN (
    SELECT vendor_vehicle_type_ID
    FROM dvi_vendor_vehicle_types
    WHERE vehicle_type_id IN (1, 23)
  )
  ORDER BY vendor_vehicle_type_id, time_limit_id;`);
  }

  const localPricebookRows = await prisma.$queryRawUnsafe(`SELECT
  *
FROM dvi_vehicle_local_pricebook
WHERE vendor_id IN (
  SELECT DISTINCT vendor_id
  FROM dvi_itinerary_plan_vendor_eligible_list
  WHERE itinerary_plan_id = ?
)
AND vendor_branch_id IN (
  SELECT DISTINCT vendor_branch_id
  FROM dvi_itinerary_plan_vendor_eligible_list
  WHERE itinerary_plan_id = ?
)
AND deleted = 0
AND status = 1
ORDER BY vendor_id, vendor_branch_id, vehicle_type_id, time_limit_id;`, planId, planId);

  return {
    generatedAt: new Date().toISOString(),
    planId,
    vehicleDetailRows,
    duplicateGroups,
    eligibleRows,
    requestedVehicleRows,
    vendorVehicleTypeRows,
    timeLimitRows,
    localPricebookRows,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('This script uses local auth token. Do not commit token or output files.');
  if (!AUTH_TOKEN) {
    console.error('AUTH_TOKEN env var is required. Aborting.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const before = await runSnapshot(prisma, PLAN_ID);
    await fs.writeFile('tmp_two_vehicle_before_snapshot.json', jsonSafe(before));

    const postRes = await fetch(`${API_BASE_URL}/itineraries/?type=itineary_basic_info`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: '*/*',
      },
      body: JSON.stringify(POST_PAYLOAD),
    });
    const postBodyText = await postRes.text();
    let postBody;
    try { postBody = JSON.parse(postBodyText); } catch { postBody = { raw: postBodyText }; }
    await fs.writeFile('tmp_two_vehicle_post_response.json', jsonSafe({ status: postRes.status, ok: postRes.ok, body: postBody }));

    const pollStart = Date.now();
    let lastCount = 0;
    while (Date.now() - pollStart <= 60000) {
      const rows = await prisma.$queryRawUnsafe(
        'SELECT COUNT(*) AS c FROM dvi_itinerary_plan_vendor_vehicle_details WHERE itinerary_plan_id = ? AND deleted = 0 AND status = 1',
        PLAN_ID,
      );
      const count = Number(rows?.[0]?.c ?? 0);
      lastCount = count;
      if (count > 0) break;
      await sleep(2000);
    }

    const after = await runSnapshot(prisma, PLAN_ID);
    after.polling = { lastCount, waitedMs: Date.now() - pollStart };
    await fs.writeFile('tmp_two_vehicle_after_snapshot.json', jsonSafe(after));

    const getRes = await fetch(`${API_BASE_URL}/itineraries/details/${QUOTE_ID}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Accept: '*/*',
      },
    });
    const getBodyText = await getRes.text();
    let getBody;
    try { getBody = JSON.parse(getBodyText); } catch { getBody = { raw: getBodyText }; }
    await fs.writeFile('tmp_two_vehicle_get_details_response.json', jsonSafe({ status: getRes.status, ok: getRes.ok, body: getBody }));

    const vehicles = Array.isArray(getBody?.body?.vehicles)
      ? getBody.body.vehicles
      : (Array.isArray(getBody?.vehicles) ? getBody.vehicles : []);

    const muvEligible = after.eligibleRows.find((r) => Number(r.vehicle_type_id) === 23);
    const muvDetailRows = after.vehicleDetailRows.filter((r) => Number(r.vehicle_type_id) === 23);

    const summaryLines = [
      `Requested vehicle rows: ${after.requestedVehicleRows.length}`,
      `Eligible rows: ${after.eligibleRows.length}`,
      `Vehicle detail row count: ${after.vehicleDetailRows.length}`,
      `Duplicate groups: ${after.duplicateGroups.length}`,
      'GET vehicles summary:',
      ...vehicles.map((v) => `- ${String(v.vehicleTypeName || '')} | vendorEligibleId=${Number(v.vendorEligibleId || 0)} | isAssigned=${Boolean(v.isAssigned)} | dayWisePricingCount=${Array.isArray(v.dayWisePricing) ? v.dayWisePricing.length : 0} | totalAmount=${Number(v.totalAmount || 0)}`),
      'MUV diagnosis:',
      `- eligible row exists ${muvEligible ? 'yes' : 'no'}`,
      `- calc rows inserted ${muvDetailRows.length > 0 ? 'yes' : 'no'}`,
      '- skip zero cost seen in logs? check tmp_two_vehicle_runtime_logs.txt',
    ];

    await fs.writeFile('tmp_two_vehicle_summary.txt', summaryLines.join('\n'));
    console.log(summaryLines.join('\n'));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
