const http = require('http');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const API_BASE = 'http://127.0.0.1:4006/api/v1';
const TOKEN = process.env.PROD_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzYwMTI5MDcsImV4cCI6MTc3NjYxNzcwN30.PHwy7Jtwy-i0sM_8P_UGILlQPwLhd4MAywdfzOYxZ0w';
const TARGET_PLAN_ID = 385;

function postJson(url, body) {
  const data = JSON.stringify(body);
  const u = new URL(url);
  const opts = {
    hostname: u.hostname,
    port: Number(u.port || 80),
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      Authorization: `Bearer ${TOKEN}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const asNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const asIso = (v) => {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

(async () => {
  const planRows = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM dvi_itinerary_plan_details
    WHERE itinerary_plan_ID = ${TARGET_PLAN_ID}
    LIMIT 1
  `);
  const plan = planRows[0];
  if (!plan) throw new Error(`Plan ${TARGET_PLAN_ID} not found`);

  const routes = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM dvi_itinerary_route_details
    WHERE itinerary_plan_ID = ${TARGET_PLAN_ID}
      AND deleted = 0
      AND status = 1
    ORDER BY itinerary_route_date ASC, itinerary_route_ID ASC
  `);

  const vias = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM dvi_itinerary_via_route_details
    WHERE itinerary_plan_ID = ${TARGET_PLAN_ID}
      AND deleted = 0
      AND status = 1
    ORDER BY itinerary_route_ID ASC, itinerary_via_route_ID ASC
  `);

  const vehicles = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM dvi_itinerary_plan_vehicle_details
    WHERE itinerary_plan_id = ${TARGET_PLAN_ID}
    ORDER BY vehicle_details_ID ASC
  `);

  const travellers = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM dvi_itinerary_traveller_details
    WHERE itinerary_plan_ID = ${TARGET_PLAN_ID}
      AND deleted = 0
      AND status = 1
    ORDER BY traveller_details_ID ASC
  `);

  const viaByRoute = new Map();
  for (const v of vias) {
    const rid = asNum(v.itinerary_route_ID, 0);
    if (!viaByRoute.has(rid)) viaByRoute.set(rid, []);
    viaByRoute.get(rid).push({
      itinerary_via_location_ID: asNum(v.itinerary_via_location_ID, 0),
      itinerary_via_location_name: String(v.itinerary_via_location_name || '').trim(),
    });
  }

  const payload = {
    plan: {
      itinerary_plan_id: asNum(plan.itinerary_plan_ID, 0),
      agent_id: asNum(plan.agent_id, 0),
      staff_id: asNum(plan.staff_id, 0),
      location_id: asNum(plan.location_id, 0),
      arrival_point: String(plan.arrival_location || ''),
      departure_point: String(plan.departure_location || ''),
      itinerary_preference: asNum(plan.itinerary_preference, 3),
      itinerary_type: asNum(plan.itinerary_type, 2),
      preferred_hotel_category: Array.isArray(plan.preferred_hotel_category)
        ? plan.preferred_hotel_category.map((x) => asNum(x, 0)).filter((x) => x > 0)
        : [2],
      hotel_facilities: Array.isArray(plan.hotel_facilities)
        ? plan.hotel_facilities.map((x) => String(x))
        : [],
      trip_start_date: asIso(plan.trip_start_date || plan.trip_start_date_and_time || plan.pick_up_date_and_time),
      trip_end_date: asIso(plan.trip_end_date || plan.trip_end_date_and_time || plan.pick_up_date_and_time),
      pick_up_date_and_time: asIso(plan.pick_up_date_and_time || plan.trip_start_date || plan.trip_start_date_and_time),
      arrival_type: asNum(plan.arrival_type, 1),
      departure_type: asNum(plan.departure_type, 1),
      no_of_nights: asNum(plan.no_of_nights, 0),
      no_of_days: asNum(plan.no_of_days, routes.length || 1),
      budget: asNum(plan.budget, 0),
      entry_ticket_required: asNum(plan.entry_ticket_required, 0),
      guide_for_itinerary: asNum(plan.guide_for_itinerary, 0),
      nationality: asNum(plan.nationality, 0),
      food_type: asNum(plan.food_type, 0),
      adult_count: asNum(plan.total_adult, 0),
      child_count: asNum(plan.total_children, 0),
      infant_count: asNum(plan.total_infants, 0),
      special_instructions: String(plan.special_instructions || ''),
    },
    routes: routes.map((r) => ({
      itinerary_route_id: asNum(r.itinerary_route_ID, 0),
      location_name: String(r.location_name || ''),
      next_visiting_location: String(r.next_visiting_location || ''),
      itinerary_route_date: asIso(r.itinerary_route_date),
      no_of_days: asNum(r.no_of_days, 1),
      no_of_km: r.no_of_km == null ? '' : String(r.no_of_km),
      direct_to_next_visiting_place: asNum(r.direct_to_next_visiting_place, 0),
      via_route: '',
      route_start_time: r.route_start_time ? String(r.route_start_time).slice(11, 19) : undefined,
      route_end_time: r.route_end_time ? String(r.route_end_time).slice(11, 19) : undefined,
      via_routes: viaByRoute.get(asNum(r.itinerary_route_ID, 0)) || [],
    })),
    vehicles:
      vehicles.length > 0
        ? vehicles.map((v) => ({
            vehicle_details_id: asNum(v.vehicle_details_ID, 0),
            vehicle_type_id: asNum(v.vehicle_type_id, 0),
            vehicle_count: asNum(v.vehicle_count, 1),
          }))
        : [{ vehicle_type_id: 20, vehicle_count: 1 }],
    travellers:
      travellers.length > 0
        ? travellers.map((t) => ({
            room_id: asNum(t.room_id, 1),
            traveller_type: asNum(t.traveller_type, 1),
            traveller_age: t.traveller_age == null ? undefined : String(t.traveller_age),
            child_bed_type: t.child_bed_type == null ? undefined : asNum(t.child_bed_type, 0),
          }))
        : [{ room_id: 1, traveller_type: 1 }],
  };

  console.log(`Rebuilding plan ${TARGET_PLAN_ID}, quote ${String(plan.itinerary_quote_ID || '')}`);
  const resp = await postJson(`${API_BASE}/itineraries`, payload);
  console.log('Status:', resp.status);
  console.log(JSON.stringify(resp.body, null, 2));
})();
