const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.PROD_API_BASE_URL || 'https://dvi.travel/api/v1';
const EMAIL = process.env.PROD_EMAIL || 'admin@dvi.co.in';
const PASSWORD = process.env.PROD_PASSWORD || 'Keerthi@2404ias';

const OUT_DIR = path.join(process.cwd(), 'verification-e2e', 'automation', 'artifacts');

function isoWithOffset(date) {
  return new Date(date).toISOString().replace('Z', '+05:30');
}

function pickToken(body) {
  return (
    body?.access_token ||
    body?.accessToken ||
    body?.token ||
    body?.data?.access_token ||
    body?.data?.accessToken ||
    null
  );
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, ok: res.ok, body };
}

function buildCreatePayload() {
  const now = new Date();
  const tripStart = new Date(now);
  tripStart.setDate(now.getDate() + 20);

  const tripEnd = new Date(tripStart);
  tripEnd.setDate(tripStart.getDate() + 1);

  return {
    plan: {
      itinerary_plan_id: 0,
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: 'Madurai',
      departure_point: 'Chennai',
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: isoWithOffset(tripStart),
      trip_end_date: isoWithOffset(tripEnd),
      pick_up_date_and_time: isoWithOffset(tripStart),
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: 1,
      no_of_days: 2,
      budget: 25000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: 'Automated smoke check: Madurai itinerary + TBO verification',
    },
    routes: [
      {
        location_name: 'Madurai',
        next_visiting_location: 'Chennai',
        itinerary_route_date: isoWithOffset(tripStart),
        no_of_days: 1,
        no_of_km: '',
        direct_to_next_visiting_place: 1,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Chennai',
        next_visiting_location: 'Chennai',
        itinerary_route_date: isoWithOffset(tripEnd),
        no_of_days: 2,
        no_of_km: '',
        direct_to_next_visiting_place: 1,
        via_route: '',
        via_routes: [],
      },
    ],
    vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
  };
}

function getQuoteId(createBody) {
  return (
    createBody?.quoteId ||
    createBody?.itinerary_quote_ID ||
    createBody?.plan?.itinerary_quote_ID ||
    createBody?.data?.quoteId ||
    null
  );
}

function getLatestRows(latestBody) {
  if (Array.isArray(latestBody?.data)) return latestBody.data;
  if (Array.isArray(latestBody?.rows)) return latestBody.rows;
  return [];
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const result = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    checks: {},
    pass: false,
  };

  const login = await fetchJson(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const token = pickToken(login.body);
  result.checks.login = {
    status: login.status,
    ok: login.ok,
    tokenPresent: Boolean(token),
  };

  if (!login.ok || !token) {
    result.error = 'Login failed';
    result.loginBody = login.body;
    fs.writeFileSync(path.join(OUT_DIR, 'live-itinerary-smoke-result.json'), JSON.stringify(result, null, 2));
    console.log('FAIL: Login failed');
    process.exit(1);
  }

  const createPayload = buildCreatePayload();
  const create = await fetchJson(`${BASE_URL}/itineraries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(createPayload),
  });

  const quoteId = getQuoteId(create.body);
  result.checks.createItinerary = {
    status: create.status,
    ok: create.ok,
    quoteId,
    expectedArrival: createPayload.plan.arrival_point,
  };

  const latest = await fetchJson(`${BASE_URL}/itineraries/latest?start=0&length=10`, {
    headers: { authorization: `Bearer ${token}` },
  });

  const latestRows = getLatestRows(latest.body);
  const top = latestRows[0] || {};
  const topQuoteId = top.itinerary_quote_ID || top.quoteId || top.itinerary_quote_id || null;
  const topArrival = top.arrival_location || top.arrival_point || top.source_location || null;

  result.checks.latestItinerary = {
    status: latest.status,
    ok: latest.ok,
    count: latestRows.length,
    topQuoteId,
    topArrival,
  };

  const targetQuoteId = quoteId || topQuoteId;
  const hotelDetails = await fetchJson(`${BASE_URL}/itineraries/hotel_details/${encodeURIComponent(targetQuoteId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  const hotels = Array.isArray(hotelDetails.body?.hotels) ? hotelDetails.body.hotels : [];
  const providers = [...new Set(hotels.map((h) => String(h.provider || '').toLowerCase()).filter(Boolean))];

  result.checks.hotelDetails = {
    status: hotelDetails.status,
    ok: hotelDetails.ok,
    quoteId: targetQuoteId,
    hotelCount: hotels.length,
    providers,
    hasTboHotels: providers.includes('tbo'),
    sampleHotels: hotels.slice(0, 5).map((h) => ({
      name: h.hotelName || h.name || null,
      provider: h.provider || null,
    })),
  };

  const tboSearch = await fetchJson(`${BASE_URL}/hotels/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cityCode: 'Madurai',
      checkInDate: createPayload.plan.trip_start_date.slice(0, 10),
      checkOutDate: createPayload.plan.trip_end_date.slice(0, 10),
      roomCount: 1,
      guestCount: 2,
      guestNationality: 'IN',
      providers: ['tbo'],
    }),
  });

  const tboHotels = Array.isArray(tboSearch.body?.data?.hotels) ? tboSearch.body.data.hotels : [];
  const tboProviders = tboSearch.body?.data?.filters?.providers || [];

  result.checks.directTboSearch = {
    status: tboSearch.status,
    ok: tboSearch.ok,
    totalResults: tboSearch.body?.data?.totalResults ?? tboHotels.length,
    providers: tboProviders,
    sampleHotels: tboHotels.slice(0, 5).map((h) => h.hotelName || h.name || null),
  };

  result.pass = Boolean(
    result.checks.login.ok &&
      result.checks.createItinerary.ok &&
      result.checks.latestItinerary.ok &&
      result.checks.hotelDetails.ok &&
      result.checks.hotelDetails.hasTboHotels,
  );

  fs.writeFileSync(path.join(OUT_DIR, 'live-itinerary-smoke-result.json'), JSON.stringify(result, null, 2));

  if (!result.pass) {
    console.log('FAIL: Smoke check failed. See artifacts file.');
    process.exit(1);
  }

  console.log('PASS: Smoke check passed.');
  console.log(JSON.stringify({
    quoteId: result.checks.createItinerary.quoteId,
    latestTopQuoteId: result.checks.latestItinerary.topQuoteId,
    hotelProviders: result.checks.hotelDetails.providers,
    tboSearchResults: result.checks.directTboSearch.totalResults,
  }, null, 2));
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
