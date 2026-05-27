/*
  Test script: login, then POST plan and GET details with auth token.
  Usage: HOTSPOT_MATRIX_AUTOBUILD=true BASE_URL=http://localhost:4006 tsx scripts/test-matrix-autobuild-auth.ts
*/

const BASE_URL = process.env.BASE_URL || 'http://localhost:4006';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';

const planPayload = {
  plan: {
    itinerary_plan_id: 381,
    agent_id: 8,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Cochin International Airport',
    departure_point: 'Cochin International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [3,4],
    hotel_facilities: [],
    trip_start_date: '2026-05-27T08:00:00+05:30',
    trip_end_date: '2026-05-30T20:00:00+05:30',
    pick_up_date_and_time: '2026-05-27T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 3,
    no_of_days: 4,
    budget: 25000,
    entry_ticket_required: 1,
    guide_for_itinerary: 1,
    nationality: 101,
    food_type: 0,
    meal_plan_code: 'EP',
    adult_count: 1,
    child_count: 0,
    infant_count: 0,
    special_instructions: 'Playwright manual insert verify 1775939068753'
  },
  routes: [
    { location_name: 'Cochin International Airport', next_visiting_location: 'Munnar', itinerary_route_date: '2026-05-27T00:00:00+05:30', no_of_days: 1, no_of_km: 73.48, direct_to_next_visiting_place: 1, via_route: '', via_routes: [] },
    { location_name: 'Munnar', next_visiting_location: 'Munnar', itinerary_route_date: '2026-05-28T00:00:00+05:30', no_of_days: 2, no_of_km: 1, direct_to_next_visiting_place: 0, via_route: '', via_routes: [] },
    { location_name: 'Munnar', next_visiting_location: 'Alleppey', itinerary_route_date: '2026-05-29T00:00:00+05:30', no_of_days: 3, no_of_km: 159, direct_to_next_visiting_place: 0, via_route: '', via_routes: [] },
    { location_name: 'Alleppey', next_visiting_location: 'Cochin International Airport', itinerary_route_date: '2026-05-30T00:00:00+05:30', no_of_days: 4, no_of_km: 105.58, direct_to_next_visiting_place: 0, via_route: '', via_routes: [] }
  ],
  vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
  travellers: [{ room_id: 1, traveller_type: 1 }],
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false
};

async function httpRequest({ method, path, headers = {}, body }: any) {
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: true, status: res.status, text, json };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function login() {
  const res = await httpRequest({ method: 'POST', path: '/api/v1/auth/login', body: { email: LOGIN_EMAIL, password: LOGIN_PASSWORD } });
  if (!res.ok) throw new Error(`Login request failed: ${String(res.error)}`);
  if (!res.json || (!res.json.accessToken && !res.json.token && !(res.json.data && (res.json.data.accessToken || res.json.data.token)))) {
    throw new Error(`Login did not return token: status=${res.status} json=${JSON.stringify(res.json)}`);
  }
  const token = res.json.accessToken || res.json.token || (res.json.data && (res.json.data.accessToken || res.json.data.token));
  return token;
}

async function main() {
  console.log('Logging in...');
  const token = await login();
  console.log('Token acquired, length=', token.length);

  console.log('Posting plan with auth token...');
  const post = await httpRequest({ method: 'POST', path: '/api/v1/itineraries/?type=itineary_basic_info', body: planPayload, headers: { Authorization: `Bearer ${token}` } });
  console.log('POST status:', post.status);
  if (post.json) console.log('POST json:', JSON.stringify(post.json).slice(0,500));

  console.log('GET details for DVI20260589 with auth...');
  const get = await httpRequest({ method: 'GET', path: '/api/v1/itineraries/details/DVI20260589', headers: { Authorization: `Bearer ${token}` } });
  console.log('GET status:', get.status);
  if (get.json) console.log('GET json keys:', Object.keys(get.json || {}).slice(0,50));
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
