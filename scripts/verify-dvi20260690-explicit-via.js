const DEFAULT_BASE_URL = 'http://127.0.0.1:4006';
const BUILD_PATH = '/api/v1/itineraries/?type=itineary_basic_info';

const REQUEST_PAYLOAD = {
  plan: {
    itinerary_plan_id: 9629,
    agent_id: 126,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Cochin International Airport',
    departure_point: 'Cochin International Airport',
    itinerary_preference: 2,
    itinerary_type: 2,
    preferred_hotel_category: [],
    hotel_facilities: [],
    trip_start_date: '2026-06-17T08:00:00+05:30',
    trip_end_date: '2026-06-24T20:00:00+05:30',
    pick_up_date_and_time: '2026-06-17T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 7,
    no_of_days: 8,
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
      next_visiting_location: 'Cochin',
      itinerary_route_date: '2026-06-17T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 1,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Cochin',
      next_visiting_location: 'Munnar',
      itinerary_route_date: '2026-06-18T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 124,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [
        {
          itinerary_via_location_ID: 63,
          itinerary_via_location_name: 'Athirappilly Water Falls, Pariyaram, Kerala',
        },
      ],
    },
    {
      location_name: 'Munnar',
      next_visiting_location: 'Munnar',
      itinerary_route_date: '2026-06-19T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 1,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Munnar',
      next_visiting_location: 'Thekkady',
      itinerary_route_date: '2026-06-20T00:00:00+05:30',
      no_of_days: 4,
      no_of_km: 97.1,
      direct_to_next_visiting_place: 1,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Thekkady',
      next_visiting_location: 'Alleppey',
      itinerary_route_date: '2026-06-21T00:00:00+05:30',
      no_of_days: 5,
      no_of_km: 138,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Alleppey',
      next_visiting_location: 'Kumarakom, Kerala, India',
      itinerary_route_date: '2026-06-22T00:00:00+05:30',
      no_of_days: 6,
      no_of_km: 32.7,
      direct_to_next_visiting_place: 1,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Kumarakom, Kerala, India',
      next_visiting_location: 'Kumarakom, Kerala, India',
      itinerary_route_date: '2026-06-23T00:00:00+05:30',
      no_of_days: 7,
      no_of_km: 1,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Kumarakom, Kerala, India',
      next_visiting_location: 'Cochin International Airport',
      itinerary_route_date: '2026-06-24T00:00:00+05:30',
      no_of_days: 8,
      no_of_km: 50.1,
      direct_to_next_visiting_place: 1,
      via_route: '',
      via_routes: [],
    },
  ],
  vehicles: [
    { vehicle_type_id: 1, vehicle_count: 1 },
    { vehicle_type_id: 23, vehicle_count: 1 },
    { vehicle_type_id: 20, vehicle_count: 1 },
    { vehicle_type_id: 21, vehicle_count: 1 },
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

function verifyDay2(details) {
  const day2 = (details?.days || []).find((day) => Number(day?.dayNumber || 0) === 2);
  if (!day2) {
    return { ok: false, reason: 'Day 2 not found in itinerary details', day2: null };
  }

  const segments = Array.isArray(day2.segments) ? day2.segments : [];
  const attractionNames = segments
    .filter((segment) => segment?.type === 'attraction')
    .map((segment) => String(segment?.name || '').trim());
  const forbidden = attractionNames.filter((name) =>
    /Santa Cruz|Kerala Folklore/i.test(name),
  );
  const hasAthirappilly = attractionNames.some((name) => /Athirapp/i.test(name));
  const hasCheeyappara = attractionNames.some((name) => /Cheeyappara/i.test(name));
  const hasValara = attractionNames.some((name) => /Valara/i.test(name));
  const athirappillyIndex = attractionNames.findIndex((name) => /Athirapp/i.test(name));
  const cheeyapparaIndex = attractionNames.findIndex((name) => /Cheeyappara/i.test(name));
  const valaraIndex = attractionNames.findIndex((name) => /Valara/i.test(name));

  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: `Day 2 still contains forbidden source-city attractions: ${forbidden.join(', ')}`,
      day2,
    };
  }

  if (!hasAthirappilly || !hasCheeyappara || !hasValara) {
    return {
      ok: false,
      reason: `Day 2 is missing expected via/corridor attractions. Found=${attractionNames.join(', ')}`,
      day2,
    };
  }

  if (!(athirappillyIndex < cheeyapparaIndex && cheeyapparaIndex < valaraIndex)) {
    return {
      ok: false,
      reason: `Day 2 attraction order is wrong. Expected Athirappilly -> Cheeyappara -> Valara, found=${attractionNames.join(' -> ')}`,
      day2,
    };
  }

  return { ok: true, reason: 'Day 2 contains Athirappilly, Cheeyappara, and Valara', day2 };
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

  console.log('[verify-dvi20260690-explicit-via] POST', buildUrl);
  const buildResult = await fetchJson(buildUrl, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify(payload),
  });

  console.log('[verify-dvi20260690-explicit-via] build status', buildResult.response.status);
  if (!buildResult.response.ok) {
    console.error(buildResult.text);
    process.exit(1);
  }

  const quoteId = extractQuoteId(buildResult.data);
  if (!quoteId) {
    console.error('[verify-dvi20260690-explicit-via] missing quoteId in build response');
    process.exit(1);
  }

  const detailsUrl = `${baseUrl}/api/v1/itineraries/details/${encodeURIComponent(quoteId)}`;

  let detailsResult = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log('[verify-dvi20260690-explicit-via] GET attempt', attempt, detailsUrl);
    detailsResult = await fetchJson(detailsUrl, {
      method: 'GET',
      headers: commonHeaders,
    });

    if (!detailsResult.response.ok) {
      console.error(detailsResult.text);
      process.exit(1);
    }

    const verification = verifyDay2(detailsResult.data);
    const summary = summarizeDay(verification.day2);
    console.log('[verify-dvi20260690-explicit-via] Day 2 summary', JSON.stringify(summary, null, 2));

    if (verification.ok) {
      console.log('[verify-dvi20260690-explicit-via] verification passed');
      return;
    }

    console.log('[verify-dvi20260690-explicit-via] verification pending:', verification.reason);
    await sleep(1500);
  }

  const finalVerification = verifyDay2(detailsResult?.data);
  console.error('[verify-dvi20260690-explicit-via] verification failed:', finalVerification.reason);
  process.exit(1);
}

main().catch((error) => {
  console.error('[verify-dvi20260690-explicit-via] fatal', error?.stack || error?.message || String(error));
  process.exit(1);
});
