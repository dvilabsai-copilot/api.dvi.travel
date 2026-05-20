/*
 * Repro script: clones the structure of DVI20260320
 * (Chennai → Madurai → Rameswaram → Munnar → Chennai)
 * with fresh dates starting today+3 to avoid past-date issues.
 *
 * Usage (from api.dvi.travel folder):
 *   node docs/scripts/create-repro-DVI20260320.js
 *   BASE_URL=http://127.0.0.1:4006 TOKEN=<jwt> node docs/scripts/create-repro-DVI20260320.js
 */

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4006';
const TOKEN =
  process.env.TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc2ODI2NTEsImV4cCI6MTc3ODI4NzQ1MX0.7pWoIL-8qRkUXDb24aLdCM0no5DVBrjTONv9LyMZjwU';

// Shift dates: original was 2026-05-10..13 (IST). Use today+3 as start.
function buildDates() {
  const start = new Date();
  start.setDate(start.getDate() + 3);
  start.setHours(8, 0, 0, 0);

  const toISO = (d) => d.toISOString().replace('Z', '+05:30').replace(/\.\d{3}/, '');

  const day = (offset) => {
    const d = new Date(start);
    d.setDate(d.getDate() + offset);
    return d;
  };

  return {
    tripStart: toISO(start),              // day 0 = depart Chennai
    tripEnd: (() => { const e = day(3); e.setHours(20,0,0,0); return toISO(e); })(),
    routeDates: [
      toISO(day(0)),  // Chennai → Madurai  (day 1)
      toISO(day(1)),  // Madurai → Rameswaram (day 2)
      toISO(day(2)),  // Rameswaram → Munnar (day 3)
      toISO(day(3)),  // Munnar → Chennai   (day 4)
    ],
  };
}

const dates = buildDates();

const createPayload = {
  plan: {
    agent_id: 126,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Chennai International Airport',
    departure_point: 'Chennai International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [2],
    hotel_facilities: [],
    trip_start_date: dates.tripStart,
    trip_end_date: dates.tripEnd,
    pick_up_date_and_time: dates.tripStart,
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 3,
    no_of_days: 4,
    budget: 40000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 101,   // IN
    food_type: 0,
    meal_plan_code: 'CP',
    meal_plan_breakfast: 1,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 2,
    child_count: 0,
    infant_count: 0,
    special_instructions: 'Repro of DVI20260320 - Chennai/Madurai/Rameswaram/Munnar',
  },
  routes: [
    {
      location_name: 'Chennai International Airport',
      next_visiting_location: 'Madurai',
      itinerary_route_date: dates.routeDates[0],
      no_of_days: 1,
      no_of_km: 436,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Madurai',
      next_visiting_location: 'Rameswaram',
      itinerary_route_date: dates.routeDates[1],
      no_of_days: 2,
      no_of_km: 173,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Rameswaram',
      next_visiting_location: 'Munnar',
      itinerary_route_date: dates.routeDates[2],
      no_of_days: 3,
      no_of_km: 332,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Munnar',
      next_visiting_location: 'Chennai International Airport',
      itinerary_route_date: dates.routeDates[3],
      no_of_days: 4,
      no_of_km: 147,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
  ],
  vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
  travellers: [
    { room_id: 1, traveller_type: 1 },
    { room_id: 1, traveller_type: 1 },
  ],
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false,
};

async function requestJson(url, { method = 'GET', body } = {}) {
  const headers = { Accept: '*/*', Authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  console.log(`\n[REQUEST] ${method} ${url}`);
  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let json;
  try { json = rawText ? JSON.parse(rawText) : null; } catch (e) { json = { rawText }; }

  console.log(`[RESPONSE] ${response.status} ${response.statusText}`);
  return { ok: response.ok, status: response.status, json };
}

function getQuoteId(json) {
  const paths = ['data.quote_id','data.quoteId','data.quote_ID','quote_id','quoteId','quote_ID','data.itinerary_quote_id','itinerary_quote_id'];
  for (const path of paths) {
    const parts = path.split('.');
    let curr = json;
    for (const p of parts) { curr = curr?.[p]; }
    if (curr) return String(curr);
  }
  return null;
}

async function run() {
  console.log('='.repeat(90));
  console.log('Creating repro itinerary for DVI20260320');
  console.log('Route: Chennai → Madurai → Rameswaram → Munnar → Chennai');
  console.log('Trip dates:', dates.tripStart, '→', dates.tripEnd);
  console.log('='.repeat(90));

  // Step 1: Create itinerary
  const createRes = await requestJson(`${BASE_URL}/api/v1/itineraries`, {
    method: 'POST',
    body: createPayload,
  });

  if (!createRes.ok) {
    console.error('❌ Create failed:', JSON.stringify(createRes.json, null, 2));
    process.exit(1);
  }

  const quoteId = getQuoteId(createRes.json);
  if (!quoteId) {
    console.error('❌ Could not find quote ID in response:', JSON.stringify(createRes.json, null, 2));
    process.exit(1);
  }

  console.log('\n✅ Created itinerary:', quoteId);

  // Step 2: Fetch details to confirm
  console.log('\n='.repeat(90));
  console.log(`Fetching details for ${quoteId}...`);
  const detailsRes = await requestJson(`${BASE_URL}/api/v1/itineraries/details/${quoteId}`);

  if (!detailsRes.ok) {
    console.error('❌ Details fetch failed:', JSON.stringify(detailsRes.json, null, 2));
    process.exit(1);
  }

  const d = detailsRes.json;
  console.log('\n✅ Itinerary summary:');
  console.log(`  Quote ID   : ${d.quoteId || quoteId}`);
  console.log(`  Date range : ${d.dateRange || 'N/A'}`);
  console.log(`  Nights     : ${d.nightCount ?? 'N/A'}`);
  console.log(`  Adults     : ${d.adults ?? 'N/A'}`);
  console.log(`  Days       : ${Array.isArray(d.days) ? d.days.length : 'N/A'}`);

  // Step 3: Fetch hotel-details to verify hotel availability
  console.log('\n='.repeat(90));
  console.log(`Fetching hotel-details for ${quoteId}...`);
  const hotelRes = await requestJson(`${BASE_URL}/api/v1/itineraries/hotel_details/${quoteId}`);

  if (!hotelRes.ok) {
    console.error('❌ Hotel fetch failed:', JSON.stringify(hotelRes.json, null, 2));
  } else {
    const hotels = hotelRes.json;
    const rows = Array.isArray(hotels) ? hotels : hotels?.data || [];
    const byRoute = {};
    for (const h of rows) {
      const key = `${h.routeId}:${h.destination}`;
      if (!byRoute[key]) byRoute[key] = { total: 0, providers: {} };
      byRoute[key].total++;
      const p = String(h.provider || 'unknown');
      byRoute[key].providers[p] = (byRoute[key].providers[p] || 0) + 1;
    }
    console.log('\n✅ Hotels by route:');
    for (const [key, val] of Object.entries(byRoute)) {
      console.log(`  Route ${key}: ${val.total} hotels - providers: ${JSON.stringify(val.providers)}`);
    }
    if (Object.keys(byRoute).length === 0) {
      console.log('  (no hotels returned)');
    }
  }

  console.log('\n='.repeat(90));
  console.log(`✅ Done. New repro quote: ${quoteId}`);
  console.log(`   Frontend URL: http://localhost:8080/itinerary-details/${quoteId}`);
  console.log('='.repeat(90));
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
