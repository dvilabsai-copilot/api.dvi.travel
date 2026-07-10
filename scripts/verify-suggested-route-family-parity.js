const fs = require('fs');
const path = require('path');

const API_BASE_URL = process.env.ROUTE_PARITY_API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const AUTH_TOKEN =
  process.env.ROUTE_PARITY_JWT_TOKEN ||
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODMxOTQxNzMsImV4cCI6MTc4Mzc5ODk3M30.YKoeQHCI9qIpV33Nn27pqP_ArqtuNkXanrhzHhxyPg4';

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
  {
    arrival: 'Chennai International Airport',
    departure: 'Pondicherry',
    startDate: '29/11/2026',
    endDate: '01/12/2026',
    noOfDays: 3,
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
    payload?.data?.itinerary_quote_ID,
    payload?.result?.quoteId,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return candidates[0] || '';
}

function extractRouteFamilyBaseQuoteId(payload, quoteId) {
  const candidates = [
    payload?.routeFamilyBaseQuoteId,
    payload?.route_family_base_quote_id,
    payload?.data?.routeFamilyBaseQuoteId,
    payload?.result?.routeFamilyBaseQuoteId,
    quoteId,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const raw = candidates[0] || '';
  const match = raw.match(/^(.*)-R\d+$/i);
  return match?.[1] ? String(match[1]).trim() : raw;
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

  const routes = Array.isArray(response.data?.routes) ? response.data.routes : [];
  return routes;
}

function buildCreatePayload(candidate, route, routeIndex, routeCount, routeFamilyBaseQuoteId) {
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
      special_instructions: 'Route family parity verification',
      route_variant_index: routeIndex,
      route_variant_count: routeCount,
      route_family_base_quote_id: routeFamilyBaseQuoteId || undefined,
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
  console.log('=== VERIFY SUGGESTED ROUTE FAMILY PARITY ===');
  console.log(`Base URL: ${API_BASE_URL}`);

  let selectedCandidate = null;
  let suggestedRoutes = [];

  for (const candidate of ROUTE_REQUEST_CANDIDATES) {
    const routes = await fetchSuggestedRoutes(candidate);
    console.log(
      `Suggestion probe ${candidate.arrival} -> ${candidate.departure} (${candidate.noOfDays} days): ${routes.length} route(s)`,
    );

    if (routes.length > 1) {
      selectedCandidate = candidate;
      suggestedRoutes = routes;
      break;
    }
  }

  assert(selectedCandidate, 'Could not find any route suggestion candidate with multiple routes.');
  assert(suggestedRoutes.length > 1, 'Need at least 2 suggested routes to verify route family parity.');

  console.log(
    `Using suggestion set: ${selectedCandidate.arrival} -> ${selectedCandidate.departure} with ${suggestedRoutes.length} route variants`,
  );

  const createdQuotes = [];
  const createdPlans = [];
  const createdPayloads = [];
  let routeFamilyBaseQuoteId = '';

  for (let index = 0; index < suggestedRoutes.length; index += 1) {
    const route = suggestedRoutes[index];
    const payload = buildCreatePayload(
      selectedCandidate,
      route,
      index + 1,
      suggestedRoutes.length,
      routeFamilyBaseQuoteId,
    );

    createdPayloads.push(payload);

    const createResponse = await callJson(
      `${API_BASE_URL}/itineraries/?type=itineary_basic_info`,
      {
        method: 'POST',
        headers: {
          Authorization: AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    assert(
      createResponse.ok,
      `Create failed for Route ${index + 1}: ${JSON.stringify(createResponse.data)}`,
    );

    const quoteId = extractQuoteId(createResponse.data);
    const planId = Number(createResponse.data?.planId || 0);
    const baseQuoteId = extractRouteFamilyBaseQuoteId(createResponse.data, quoteId);

    assert(quoteId, `Missing quoteId in create response for Route ${index + 1}.`);
    assert(planId > 0, `Missing planId in create response for Route ${index + 1}.`);
    assert(baseQuoteId, `Missing routeFamilyBaseQuoteId for Route ${index + 1}.`);

    if (!routeFamilyBaseQuoteId) {
      routeFamilyBaseQuoteId = baseQuoteId;
    }

    assert(
      quoteId === `${routeFamilyBaseQuoteId}-R${index + 1}`,
      `Expected Route ${index + 1} quote to be ${routeFamilyBaseQuoteId}-R${index + 1}, got ${quoteId}`,
    );

    createdQuotes.push(quoteId);
    createdPlans.push(planId);

    console.log(`Created Route ${index + 1}: planId=${planId}, quoteId=${quoteId}`);
  }

  const detailResults = [];

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
      `Details failed for ${quoteId}: ${JSON.stringify(detailsResponse.data)}`,
    );

    const details = detailsResponse.data || {};
    const routeOptions = Array.isArray(details.routeOptions) ? details.routeOptions : [];
    const siblingQuotes = routeOptions
      .map((item) => String(item?.quoteId || item?.quotationNo || item?.itinerary_quote_ID || '').trim())
      .filter(Boolean);

    assert(
      String(details.routeFamilyBaseQuoteId || '').trim() === routeFamilyBaseQuoteId,
      `Details routeFamilyBaseQuoteId mismatch for ${quoteId}`,
    );
    assert(
      Number(details.routeVariantIndex || 0) === index + 1,
      `Details routeVariantIndex mismatch for ${quoteId}`,
    );
    assert(
      routeOptions.length === createdQuotes.length,
      `Expected ${createdQuotes.length} routeOptions for ${quoteId}, got ${routeOptions.length}`,
    );
    assert(
      JSON.stringify([...siblingQuotes].sort()) === JSON.stringify([...createdQuotes].sort()),
      `Sibling quote set mismatch for ${quoteId}: ${JSON.stringify(siblingQuotes)}`,
    );

    const expectedRouteChain = createdPayloads[index].routes.map((routeItem) => ({
      dayNo: Number(routeItem.no_of_days || 0),
      source: String(routeItem.location_name || '').trim(),
      next: String(routeItem.next_visiting_location || '').trim(),
    }));

    const actualRouteChain = normalizeDetailsRouteChain(details);
    assert(
      actualRouteChain.length === expectedRouteChain.length,
      `Route day count mismatch for ${quoteId}: expected ${expectedRouteChain.length}, got ${actualRouteChain.length}`,
    );

    for (let dayIndex = 0; dayIndex < expectedRouteChain.length; dayIndex += 1) {
      const expected = expectedRouteChain[dayIndex];
      const actual = actualRouteChain[dayIndex];
      assert(
        expected.dayNo === actual.dayNo &&
          expected.source === actual.source &&
          expected.next === actual.next,
        `Route chain mismatch for ${quoteId} day ${dayIndex + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }

    detailResults.push({
      quoteId,
      routeOptions,
      actualRouteChain,
    });

    console.log(`Verified details for ${quoteId}: ${routeOptions.length} sibling route option(s)`);
  }

  const outDir = path.join(process.cwd(), 'test', 'verification-logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(
    outDir,
    `suggested-route-family-parity-${routeFamilyBaseQuoteId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );

  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        apiBaseUrl: API_BASE_URL,
        routeFamilyBaseQuoteId,
        selectedCandidate,
        createdQuotes,
        createdPlans,
        detailResults,
      },
      null,
      2,
    ),
  );

  console.log(`Saved verification log: ${outFile}`);
  console.log('RESULT: PASS');
}

main().catch((error) => {
  console.error('RESULT: FAIL');
  console.error(error?.message || error);
  process.exit(1);
});
