/*
 * Repro itinerary create payload and check hotel-details response for TBO hotels.
 * Usage:
 *   node repro_itinerary_create_and_tbo_check.js
 *   TOKEN=... node repro_itinerary_create_and_tbo_check.js
 */

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4006';
const TOKEN =
  process.env.TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc2ODI2NTEsImV4cCI6MTc3ODI4NzQ1MX0.7pWoIL-8qRkUXDb24aLdCM0no5DVBrjTONv9LyMZjwU';

const payload = {
  plan: {
    itinerary_plan_id: 292,
    agent_id: 8,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Chennai International Airport',
    departure_point: 'Chennai International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [2],
    hotel_facilities: [],
    trip_start_date: '2026-05-03T08:00:00+05:30',
    trip_end_date: '2026-05-06T20:00:00+05:30',
    pick_up_date_and_time: '2026-05-03T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 3,
    no_of_days: 4,
    budget: 15000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 229,
    food_type: 0,
    meal_plan_breakfast: 0,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 3,
    child_count: 1,
    infant_count: 0,
    special_instructions: '',
  },
  routes: [
    {
      location_name: 'Chennai International Airport',
      next_visiting_location: 'Chennai',
      itinerary_route_date: '2026-05-03T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 16.61,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Chennai',
      next_visiting_location: 'Mahabalipuram',
      itinerary_route_date: '2026-05-04T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 52.07,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Mahabalipuram',
      next_visiting_location: 'Pondicherry',
      itinerary_route_date: '2026-05-05T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 86.57,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Pondicherry',
      next_visiting_location: 'Chennai International Airport',
      itinerary_route_date: '2026-05-06T00:00:00+05:30',
      no_of_days: 4,
      no_of_km: 40.17,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
  ],
  vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
  travellers: [
    { room_id: 1, traveller_type: 1 },
    { room_id: 1, traveller_type: 2, traveller_age: '6', child_bed_type: 1 },
    { room_id: 2, traveller_type: 1 },
    { room_id: 2, traveller_type: 1 },
  ],
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false,
};

function deepFindFirstString(node, keys) {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const queue = [node];
  while (queue.length > 0) {
    const curr = queue.shift();
    if (!curr || typeof curr !== 'object') continue;
    for (const [k, v] of Object.entries(curr)) {
      if (wanted.has(String(k).toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) {
        return String(v);
      }
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return null;
}

function collectObjects(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectObjects(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    out.push(node);
    for (const value of Object.values(node)) collectObjects(value, out);
  }
  return out;
}

async function requestJson(url, options) {
  const started = Date.now();
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    ms: Date.now() - started,
    json,
  };
}

async function main() {
  const createUrl = `${BASE_URL}/api/v1/itineraries/?type=itineary_basic_info`;

  console.log('--- CREATE REQUEST ---');
  console.log(createUrl);

  const createRes = await requestJson(createUrl, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  console.log('--- CREATE RESPONSE ---');
  console.log(`Status: ${createRes.status} ${createRes.statusText} (${createRes.ms} ms)`);
  console.log(JSON.stringify(createRes.json, null, 2));

  const itineraryId = deepFindFirstString(createRes.json, [
    'itinerary_id',
    'itineraryId',
    'itinerary_code',
    'itineraryCode',
    'code',
    'dvi_code',
  ]) || process.env.FALLBACK_ITINERARY_ID || 'DVI202604247';

  const hotelDetailsUrl = `${BASE_URL}/api/v1/itineraries/hotel_details/${encodeURIComponent(itineraryId)}?page=1&pageSize=50`;

  console.log('--- HOTEL DETAILS REQUEST ---');
  console.log(hotelDetailsUrl);

  const hotelRes = await requestJson(hotelDetailsUrl, {
    method: 'GET',
    headers: {
      accept: '*/*',
      authorization: `Bearer ${TOKEN}`,
    },
  });

  console.log('--- HOTEL DETAILS RESPONSE ---');
  console.log(`Status: ${hotelRes.status} ${hotelRes.statusText} (${hotelRes.ms} ms)`);

  const allObjects = collectObjects(hotelRes.json);
  const hotelLike = allObjects.filter((obj) => {
    const provider = String(obj.provider || obj.source || '').toLowerCase();
    const hasHotelCode = 'hotelCode' in obj || 'hotel_code' in obj;
    const hasName = 'hotelName' in obj || 'hotel_name' in obj;
    return provider || hasHotelCode || hasName;
  });

  const tboHotels = hotelLike.filter((obj) => {
    const provider = String(obj.provider || obj.source || obj.vendor || '').toLowerCase();
    return provider.includes('tbo');
  });

  console.log(
    JSON.stringify(
      {
        createStatus: createRes.status,
        createOk: createRes.ok,
        checkedItineraryId: itineraryId,
        hotelDetailsStatus: hotelRes.status,
        hotelDetailsOk: hotelRes.ok,
        totalHotelLikeObjects: hotelLike.length,
        totalTboHotelObjects: tboHotels.length,
        sampleTboHotels: tboHotels.slice(0, 3),
      },
      null,
      2,
    ),
  );

  if (!createRes.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FAILED:', err?.stack || String(err));
  process.exit(1);
});
