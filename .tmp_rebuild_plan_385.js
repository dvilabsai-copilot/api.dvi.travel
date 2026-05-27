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

(async () => {
  const plan = await prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_plan_ID: TARGET_PLAN_ID, deleted: 0, status: 1 },
  });
  if (!plan) throw new Error(`Plan ${TARGET_PLAN_ID} not found`);

  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: TARGET_PLAN_ID, deleted: 0, status: 1 },
    orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }],
  });

  const vias = await prisma.dvi_itinerary_via_route_details.findMany({
    where: { itinerary_plan_ID: TARGET_PLAN_ID, deleted: 0, status: 1 },
    orderBy: [{ itinerary_route_ID: 'asc' }, { itinerary_via_route_ID: 'asc' }],
  });

  const viaByRoute = new Map();
  for (const v of vias) {
    const rid = Number(v.itinerary_route_ID || 0);
    if (!viaByRoute.has(rid)) viaByRoute.set(rid, []);
    viaByRoute.get(rid).push({
      itinerary_via_location_ID: Number(v.itinerary_via_location_ID || 0),
      itinerary_via_location_name: String(v.itinerary_via_location_name || '').trim(),
    });
  }

  const vehicles = await prisma.dvi_itinerary_plan_vehicle_details.findMany({
    where: { itinerary_plan_ID: TARGET_PLAN_ID, deleted: 0, status: 1 },
    orderBy: { vehicle_details_ID: 'asc' },
  });

  const travellers = await prisma.dvi_itinerary_traveller_details.findMany({
    where: { itinerary_plan_ID: TARGET_PLAN_ID, deleted: 0, status: 1 },
    orderBy: { traveller_details_ID: 'asc' },
  });

  const toIso = (v) => (v ? new Date(v).toISOString() : new Date().toISOString());

  const payload = {
    plan: {
      itinerary_plan_id: Number(plan.itinerary_plan_ID),
      agent_id: Number(plan.agent_id || 0),
      staff_id: Number(plan.staff_id || 0),
      location_id: Number(plan.location_id || 0),
      arrival_point: String(plan.arrival_location || ''),
      departure_point: String(plan.departure_location || ''),
      itinerary_preference: Number(plan.itinerary_preference || 3),
      itinerary_type: Number(plan.itinerary_type || 2),
      preferred_hotel_category: Array.isArray(plan.preferred_hotel_category) ? plan.preferred_hotel_category.map(Number) : [2],
      hotel_facilities: Array.isArray(plan.hotel_facilities) ? plan.hotel_facilities.map(String) : [],
      trip_start_date: toIso(plan.trip_start_date || plan.trip_start_date_and_time || plan.pick_up_date_and_time),
      trip_end_date: toIso(plan.trip_end_date || plan.trip_end_date_and_time || plan.pick_up_date_and_time),
      pick_up_date_and_time: toIso(plan.pick_up_date_and_time || plan.trip_start_date || plan.trip_start_date_and_time),
      arrival_type: Number(plan.arrival_type || 1),
      departure_type: Number(plan.departure_type || 1),
      no_of_nights: Number(plan.no_of_nights || 0),
      no_of_days: Number(plan.no_of_days || routes.length || 1),
      budget: Number(plan.budget || 0),
      entry_ticket_required: Number(plan.entry_ticket_required || 0),
      guide_for_itinerary: Number(plan.guide_for_itinerary || 0),
      nationality: Number(plan.nationality || 0),
      food_type: Number(plan.food_type || 0),
      adult_count: Number(plan.total_adult || 0),
      child_count: Number(plan.total_children || 0),
      infant_count: Number(plan.total_infants || 0),
      special_instructions: String(plan.special_instructions || ''),
    },
    routes: routes.map((r) => ({
      itinerary_route_id: Number(r.itinerary_route_ID || 0),
      location_name: String(r.location_name || ''),
      next_visiting_location: String(r.next_visiting_location || ''),
      itinerary_route_date: toIso(r.itinerary_route_date),
      no_of_days: Number(r.no_of_days || 1),
      no_of_km: r.no_of_km == null ? '' : String(r.no_of_km),
      direct_to_next_visiting_place: Number(r.direct_to_next_visiting_place || 0),
      via_route: '',
      route_start_time: r.route_start_time ? String(r.route_start_time).slice(11, 19) : undefined,
      route_end_time: r.route_end_time ? String(r.route_end_time).slice(11, 19) : undefined,
      via_routes: viaByRoute.get(Number(r.itinerary_route_ID || 0)) || [],
    })),
    vehicles:
      vehicles.length > 0
        ? vehicles.map((v) => ({
            vehicle_details_id: Number(v.vehicle_details_ID || 0),
            vehicle_type_id: Number(v.vehicle_type_id || 0),
            vehicle_count: Number(v.vehicle_count || 1),
          }))
        : [{ vehicle_type_id: 20, vehicle_count: 1 }],
    travellers:
      travellers.length > 0
        ? travellers.map((t) => ({
            room_id: Number(t.room_id || 1),
            traveller_type: Number(t.traveller_type || 1),
            traveller_age: t.traveller_age != null ? String(t.traveller_age) : undefined,
            child_bed_type: t.child_bed_type != null ? Number(t.child_bed_type) : undefined,
          }))
        : [{ room_id: 1, traveller_type: 1 }],
  };

  console.log(`Rebuilding plan ${TARGET_PLAN_ID}, quote ${plan.itinerary_quote_ID}`);
  const resp = await postJson(`${API_BASE}/itineraries`, payload);
  console.log('Status:', resp.status);
  console.log(JSON.stringify(resp.body, null, 2));
})();
