const DEFAULT_BASE_URL = 'http://127.0.0.1:4006';
const BUILD_PATH = '/api/v1/itineraries/?type=itineary_basic_info';

const REQUEST_PAYLOAD = {
  plan: {
    itinerary_plan_id: 0,
    agent_id: 126,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Cochin International Airport',
    departure_point: 'Munnar',
    itinerary_preference: 2,
    itinerary_type: 2,
    preferred_hotel_category: [],
    hotel_facilities: [],
    trip_start_date: '2026-06-17T08:00:00+05:30',
    trip_end_date: '2026-06-17T20:00:00+05:30',
    pick_up_date_and_time: '2026-06-17T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 0,
    no_of_days: 1,
    budget: 15000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 101,
    food_type: 0,
    meal_plan_breakfast: 0,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 2,
    child_count: 0,
    infant_count: 0,
    special_instructions: '',
  },
  routes: [
    {
      location_name: 'Cochin International Airport',
      next_visiting_location: 'Munnar',
      itinerary_route_date: '2026-06-17T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 124,
      direct_to_next_visiting_place: 0,
      via_route: 'Athirappilly Water Falls, Pariyaram, Kerala',
      via_routes: [
        {
          itinerary_via_location_ID: 63,
          itinerary_via_location_name: 'Athirappilly Water Falls, Pariyaram, Kerala',
        },
      ],
    },
  ],
  vehicles: [
    { vehicle_type_id: 1, vehicle_count: 1 },
  ],
  travellers: [
    { room_id: 1, traveller_type: 1 },
    { room_id: 1, traveller_type: 1 },
  ],
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false,
};

function getBaseUrl() {
  return String(process.env.DVI_API_BASE_URL || process.env.BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
}

function getToken() {
  const token = String(
    process.env.DVI_BEARER_TOKEN ||
    process.env.REGRESSION_BEARER_TOKEN ||
    '',
  ).trim();

  if (!token) {
    throw new Error('Missing DVI_BEARER_TOKEN');
  }

  return token;
}

function getPayload() {
  const payload = JSON.parse(JSON.stringify(REQUEST_PAYLOAD));
  const overrideRaw = process.env.ITINERARY_PLAN_ID_OVERRIDE ?? process.env.PLAN_ID_OVERRIDE;
  if (overrideRaw !== undefined) {
    const override = Number(overrideRaw);
    if (Number.isFinite(override) && override >= 0) {
      payload.plan.itinerary_plan_id = override;
    }
  }
  return payload;
}

function extractQuoteId(buildData) {
  return String(
    buildData?.quoteId ||
    buildData?.data?.quoteId ||
    buildData?.response?.quoteId ||
    '',
  ).trim();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  return { response, text, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeDay(day) {
  const segments = Array.isArray(day?.segments) ? day.segments : [];
  return segments.map((segment) => {
    if (segment?.type === 'attraction') return `attraction:${segment?.name || ''}`;
    if (segment?.type === 'travel') return `travel:${segment?.from || ''}->${segment?.to || ''}`;
    if (segment?.type === 'checkin') return `checkin:${segment?.hotelName || ''}@${segment?.time || ''}`;
    return `${segment?.type || 'unknown'}:${segment?.title || segment?.text || ''}`;
  });
}

function verifyDay1(details) {
  const day1 = (details?.days || []).find((day) => Number(day?.dayNumber || 0) === 1);
  if (!day1) {
    return { ok: false, reason: 'Day 1 not found in itinerary details', day1: null };
  }

  const segments = Array.isArray(day1.segments) ? day1.segments : [];
  const attractionNames = segments
    .filter((segment) => segment?.type === 'attraction')
    .map((segment) => String(segment?.name || '').trim());

  const forbidden = attractionNames.filter((name) =>
    /Chinese Fishing|Kathakali|Marine Drive|Folklore|Santa Cruz/i.test(name),
  );
  const hasAthirappilly = attractionNames.some((name) => /Athirapp/i.test(name));
  const hasCheeyappara = attractionNames.some((name) => /Cheeyappara/i.test(name));
  const hasValara = attractionNames.some((name) => /Valara/i.test(name));
  const sightseeingDistance = Number.parseFloat(String(day1?.sightseeingDistance || '0').replace(/[^\d.]/g, '')) || 0;
  const viaRouteIds = Array.isArray(day1?.viaRoutes) ? day1.viaRoutes.map((route) => Number(route?.id || 0)) : [];

  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: `Day 1 still contains forbidden source-city attractions: ${forbidden.join(', ')}`,
      day1,
      viaRouteIds,
    };
  }

  if (!hasAthirappilly || !hasCheeyappara || !hasValara) {
    return {
      ok: false,
      reason: `Day 1 is missing expected via/corridor attractions. Found=${attractionNames.join(', ')}`,
      day1,
      viaRouteIds,
    };
  }

  if (!(sightseeingDistance > 0)) {
    return {
      ok: false,
      reason: `Day 1 sightseeing distance is not positive. sightseeingDistance=${day1?.sightseeingDistance}`,
      day1,
      viaRouteIds,
    };
  }

  return {
    ok: true,
    reason: 'Day 1 contains Athirappilly, Cheeyappara, and Valara without source-city leakage',
    day1,
    viaRouteIds,
  };
}

async function main() {
  const baseUrl = getBaseUrl();
  const token = getToken();
  const payload = getPayload();
  const commonHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const buildUrl = `${baseUrl}${BUILD_PATH}`;
  console.log('[verify-day1-airport-munnar-via] POST', buildUrl);

  const buildResult = await fetchJson(buildUrl, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify(payload),
  });

  console.log('[verify-day1-airport-munnar-via] build status', buildResult.response.status);
  if (!buildResult.response.ok) {
    console.error(buildResult.text);
    process.exit(1);
  }

  const quoteId = extractQuoteId(buildResult.data);
  if (!quoteId) {
    console.error('[verify-day1-airport-munnar-via] missing quoteId in build response');
    process.exit(1);
  }

  const detailsUrl = `${baseUrl}/api/v1/itineraries/details/${encodeURIComponent(quoteId)}`;

  let detailsResult = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log('[verify-day1-airport-munnar-via] GET attempt', attempt, detailsUrl);
    detailsResult = await fetchJson(detailsUrl, {
      method: 'GET',
      headers: commonHeaders,
    });

    if (!detailsResult.response.ok) {
      console.error(detailsResult.text);
      process.exit(1);
    }

    const verification = verifyDay1(detailsResult.data);
    const summary = summarizeDay(verification.day1);
    console.log('[verify-day1-airport-munnar-via] Day 1 summary', JSON.stringify(summary, null, 2));
    console.log('[verify-day1-airport-munnar-via] Day 1 viaRoutes', JSON.stringify(verification.viaRouteIds));

    if (verification.ok) {
      console.log('[verify-day1-airport-munnar-via] verification passed:', verification.reason);
      return;
    }

    console.log('[verify-day1-airport-munnar-via] verification pending:', verification.reason);
    await sleep(1500);
  }

  const finalVerification = verifyDay1(detailsResult?.data);
  console.error('[verify-day1-airport-munnar-via] verification failed:', finalVerification.reason);
  process.exit(1);
}

main().catch((error) => {
  console.error('[verify-day1-airport-munnar-via] fatal', error?.stack || error?.message || String(error));
  process.exit(1);
});
