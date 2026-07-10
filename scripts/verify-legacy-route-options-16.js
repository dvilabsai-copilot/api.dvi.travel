const fs = require('fs');
const path = require('path');

const API_BASE_URL = process.env.ROUTE_PARITY_API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const AUTH_TOKEN =
  process.env.ROUTE_PARITY_JWT_TOKEN ||
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODMxOTQxNzMsImV4cCI6MTc4Mzc5ODk3M30.YKoeQHCI9qIpV33Nn27pqP_ArqtuNkXanrhzHhxyPg4';

const FIXTURE_OUTPUT_PATH = path.join(
  'C:',
  'wamp64',
  'www',
  'dvi_fullstack',
  'dvi_frontend',
  'tests',
  'e2e',
  'generated',
  'legacy-route-options-16.json',
);

const ROUTE_REQUEST_CANDIDATES = [
  {
    arrival: 'Chennai International Airport',
    departure: 'Chennai International Airport',
    startDate: '14/07/2026',
    endDate: '17/07/2026',
    noOfDays: 4,
  },
  {
    arrival: 'Madurai Airport',
    departure: 'Trivandrum, Domestic Airport',
    startDate: '01/07/2026',
    endDate: '05/07/2026',
    noOfDays: 5,
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toIsoFromDdMmYyyy(dateText, timeText) {
  const [day, month, year] = String(dateText || '').split('/').map(Number);
  const [hours, minutes] = String(timeText || '12:00').split(':').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+05:30`;
}

function extractQuoteId(payload) {
  const candidates = [
    payload?.quoteId,
    payload?.itinerary_quote_ID,
    payload?.itinerary_quote_id,
    payload?.quotationNo,
    payload?.quotation_no,
    payload?.quote_id,
    payload?.data?.quoteId,
    payload?.result?.quoteId,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return candidates[0] || '';
}

function mapSuggestionDaysToPayloadRoutes(route) {
  return (Array.isArray(route?.days) ? route.days : []).map((day, index) => ({
    location_name: String(day?.sourceLocation || '').trim(),
    next_visiting_location: String(day?.nextLocation || '').trim(),
    itinerary_route_date: toIsoFromDdMmYyyy(day?.date, '00:00'),
    no_of_days: Number(day?.dayNo || index + 1),
    no_of_km: 0,
    direct_to_next_visiting_place: day?.directVisit ? 1 : 0,
    via_route: String(day?.viaRoute || '').trim(),
    via_routes: [],
  }));
}

async function callJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function fetchSuggestedRoutes(candidate) {
  const response = await callJson(`${API_BASE_URL}/itineraries/default-route-suggestions/v2`, {
    method: 'POST',
    headers: {
      Authorization: AUTH_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      _no_of_route_days: candidate.noOfDays,
      _arrival_location: candidate.arrival,
      _departure_location: candidate.departure,
      _formattedStartDate: candidate.startDate,
      _formattedEndDate: candidate.endDate,
    }),
  });

  if (!response.ok) {
    throw new Error(`Route suggestions failed with status ${response.status}: ${JSON.stringify(response.data)}`);
  }

  return Array.isArray(response.data?.routes) ? response.data.routes : [];
}

function buildLegacyCreatePayload(candidate, route, optionIndex) {
  return {
    plan: {
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: candidate.arrival,
      departure_point: candidate.departure,
      itinerary_preference: 2,
      itinerary_type: 2,
      preferred_hotel_category: [],
      hotel_facilities: [],
      trip_start_date: toIsoFromDdMmYyyy(candidate.startDate, '12:00'),
      trip_end_date: toIsoFromDdMmYyyy(candidate.endDate, '12:00'),
      pick_up_date_and_time: toIsoFromDdMmYyyy(candidate.startDate, '12:00'),
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: Math.max(candidate.noOfDays - 1, 0),
      no_of_days: candidate.noOfDays,
      budget: 15000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: `Legacy route option ${optionIndex}`,
    },
    routes: mapSuggestionDaysToPayloadRoutes(route),
    vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  };
}

function normalizeDetailsRouteChain(details) {
  const days = Array.isArray(details?.days) ? details.days : [];
  return days.map((day, index) => ({
    dayNo: Number(day?.dayNumber || index + 1),
    source: String(day?.departure || '').trim(),
    next: String(day?.arrival || '').trim(),
  }));
}

async function main() {
  console.log('=== VERIFY LEGACY ROUTE OPTIONS 16 ===');
  console.log(`Base URL: ${API_BASE_URL}`);

  let selectedCandidate = null;
  let suggestedRoutes = [];

  for (const candidate of ROUTE_REQUEST_CANDIDATES) {
    const routes = await fetchSuggestedRoutes(candidate);
    console.log(
      `Suggestion probe ${candidate.arrival} -> ${candidate.departure} (${candidate.noOfDays} days): ${routes.length} route(s)`,
    );

    if (routes.length > 0) {
      selectedCandidate = candidate;
      suggestedRoutes = routes;
      break;
    }
  }

  assert(selectedCandidate, 'Could not find any suggestion candidate for legacy route option verification.');
  assert(suggestedRoutes.length > 0, 'No suggested routes available to create legacy route options.');

  const targetCount = 16;
  const createdQuotes = [];
  const createdPlans = [];
  const expectedRouteChains = [];

  for (let index = 0; index < targetCount; index += 1) {
    const route = suggestedRoutes[index % suggestedRoutes.length];
    const payload = buildLegacyCreatePayload(selectedCandidate, route, index + 1);
    expectedRouteChains.push(
      payload.routes.map((routeItem) => ({
        dayNo: Number(routeItem.no_of_days || 0),
        source: String(routeItem.location_name || '').trim(),
        next: String(routeItem.next_visiting_location || '').trim(),
      })),
    );

    const createResponse = await callJson(`${API_BASE_URL}/itineraries/?type=itineary_basic_info`, {
      method: 'POST',
      headers: {
        Authorization: AUTH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    assert(
      createResponse.ok,
      `Legacy create failed for Route ${index + 1}: ${JSON.stringify(createResponse.data)}`,
    );

    const quoteId = extractQuoteId(createResponse.data);
    const planId = Number(createResponse.data?.planId || 0);

    assert(quoteId, `Missing quoteId in legacy create response for Route ${index + 1}.`);
    assert(planId > 0, `Missing planId in legacy create response for Route ${index + 1}.`);

    createdQuotes.push(quoteId);
    createdPlans.push(planId);

    console.log(`Created legacy Route ${index + 1}: planId=${planId}, quoteId=${quoteId}`);
  }

  const routeOptions = createdQuotes.map((quoteId, index) => ({
    quoteId,
    label: `Route ${index + 1}`,
  }));

  for (let index = 0; index < createdQuotes.length; index += 1) {
    const quoteId = createdQuotes[index];
    const detailsResponse = await callJson(`${API_BASE_URL}/itineraries/details/${encodeURIComponent(quoteId)}`, {
      method: 'GET',
      headers: {
        Authorization: AUTH_TOKEN,
      },
    });

    assert(
      detailsResponse.ok,
      `Legacy details failed for ${quoteId}: ${JSON.stringify(detailsResponse.data)}`,
    );

    const actualRouteChain = normalizeDetailsRouteChain(detailsResponse.data || {});
    const expectedRouteChain = expectedRouteChains[index];
    assert(
      actualRouteChain.length === expectedRouteChain.length,
      `Legacy route day count mismatch for ${quoteId}: expected ${expectedRouteChain.length}, got ${actualRouteChain.length}`,
    );

    for (let dayIndex = 0; dayIndex < expectedRouteChain.length; dayIndex += 1) {
      const expected = expectedRouteChain[dayIndex];
      const actual = actualRouteChain[dayIndex];
      assert(
        expected.dayNo === actual.dayNo &&
          expected.source === actual.source &&
          expected.next === actual.next,
        `Legacy route chain mismatch for ${quoteId} day ${dayIndex + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  const fixture = {
    generatedAt: new Date().toISOString(),
    apiBaseUrl: API_BASE_URL,
    selectedCandidate,
    primaryQuoteId: createdQuotes[0],
    quotes: createdQuotes,
    routeOptions,
    storageMap: Object.fromEntries(
      createdQuotes.map((quoteId) => [
        `itinerary-route-options:${quoteId}`,
        JSON.stringify(routeOptions),
      ]),
    ),
  };

  fs.mkdirSync(path.dirname(FIXTURE_OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_OUTPUT_PATH, JSON.stringify(fixture, null, 2));

  console.log(`Saved legacy fixture: ${FIXTURE_OUTPUT_PATH}`);
  console.log('RESULT: PASS');
}

main().catch((error) => {
  console.error('RESULT: FAIL');
  console.error(error?.message || error);
  process.exit(1);
});
