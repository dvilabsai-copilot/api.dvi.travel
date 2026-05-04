/*
 * Repro script for itinerary creation/details debugging against production.
 * Usage:
 *   node run-itinerary-repro-prod.js
 *   BASE_URL=https://dvi.travel/api/v1 TOKEN=... node run-itinerary-repro-prod.js
 */

const RAW_BASE_URL = process.env.BASE_URL || 'https://dvi.travel/api/v1';
const BASE_URL = RAW_BASE_URL.replace(/\/api\/v1\/?$/, '');
const TOKEN =
  process.env.TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc4NjIwOTAsImV4cCI6MTc3ODQ2Njg5MH0.4WdHaB7cTf7ILWYA1YB4wdWFQ_huezTqh_OGd4Wdo6s';
const DETAILS_ID_FALLBACK = process.env.DETAILS_ID || 'DVI202604247';

const createPayload = {
  plan: {

    agent_id: 8,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Chennai International Airport',
    departure_point: 'Chennai International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [2],
    hotel_facilities: [],
    trip_start_date: '2026-05-13T08:00:00+05:30',
    trip_end_date: '2026-05-16T20:00:00+05:30',
    pick_up_date_and_time: '2026-05-13T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 3,
    no_of_days: 4,
    budget: 15000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 229,
    food_type: 0,
    meal_plan_code: 'CP',
    meal_plan_breakfast: 1,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 2,
    child_count: 2,
    infant_count: 0,
    special_instructions: '',
  },
  routes: [
    {
      location_name: 'Chennai International Airport',
      next_visiting_location: 'Chennai',
      itinerary_route_date: '2026-05-13T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 16.61,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Chennai',
      next_visiting_location: 'Mahabalipuram',
      itinerary_route_date: '2026-05-14T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 52.07,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Mahabalipuram',
      next_visiting_location: 'Pondicherry',
      itinerary_route_date: '2026-05-15T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 86.57,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Pondicherry',
      next_visiting_location: 'Chennai International Airport',
      itinerary_route_date: '2026-05-16T00:00:00+05:30',
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
    { room_id: 1, traveller_type: 2, traveller_age: '7', child_bed_type: 1 },
    { room_id: 2, traveller_type: 1 },
    { room_id: 2, traveller_type: 2, traveller_age: '6', child_bed_type: 1 },
  ],
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false,
};

function logHeader(title) {
  console.log('\n' + '='.repeat(90));
  console.log(title);
  console.log('='.repeat(90));
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function pick(obj, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let curr = obj;
    let ok = true;
    for (const part of parts) {
      if (!isObject(curr) && !Array.isArray(curr)) {
        ok = false;
        break;
      }
      curr = curr[part];
      if (curr === undefined) {
        ok = false;
        break;
      }
    }
    if (ok) return curr;
  }
  return undefined;
}

function getQuoteId(createResponseJson) {
  const candidates = [
    'data.quote_id',
    'data.quoteId',
    'data.quote_ID',
    'quote_id',
    'quoteId',
    'quote_ID',
    'data.itinerary_quote_id',
    'itinerary_quote_id',
  ];
  const value = pick(createResponseJson, candidates);
  return value ? String(value) : null;
}

async function requestJson(url, { method = 'GET', body } = {}) {
  const started = Date.now();
  const headers = {
    Accept: '*/*',
    Authorization: `Bearer ${TOKEN}`,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  console.log(`[REQUEST] ${method} ${url}`);
  if (body !== undefined) {
    console.log('[REQUEST BODY]');
    console.log(JSON.stringify(body, null, 2));
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let json;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    json = { parseError: String(error), rawText };
  }

  const ms = Date.now() - started;
  console.log(`[RESPONSE] ${response.status} ${response.statusText} (${ms} ms)`);
  console.log('[RESPONSE BODY]');
  console.log(JSON.stringify(json, null, 2));

  return { ok: response.ok, status: response.status, json };
}

function findWaitingMentions(root) {
  const hits = [];
  const queue = [{ value: root, path: '$' }];

  while (queue.length > 0) {
    const { value, path } = queue.shift();

    if (typeof value === 'string') {
      const text = value.toLowerCase();
      if (text.includes('expect a waiting time') || text.includes('waiting time of approximately')) {
        hits.push({ path, value });
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        queue.push({ value: value[i], path: `${path}[${i}]` });
      }
      continue;
    }

    if (isObject(value)) {
      const type = String(value.type || '').toLowerCase();
      const title = String(value.title || value.name || value.location || '').toLowerCase();
      const description = String(value.description || value.message || value.text || '').toLowerCase();
      if (
        type === 'break' ||
        title.includes('waiting') ||
        description.includes('waiting')
      ) {
        hits.push({ path, value });
      }

      for (const [k, v] of Object.entries(value)) {
        queue.push({ value: v, path: `${path}.${k}` });
      }
    }
  }

  return hits;
}

function summarizeHotelDays(data) {
  const planDays = Array.isArray(data?.data?.plan_days) ? data.data.plan_days : [];
  const summary = [];

  for (const day of planDays) {
    const dayLabel = day?.day ?? day?.day_no ?? 'unknown';
    const dateLabel = day?.date ?? day?.plan_date ?? day?.itinerary_date ?? 'unknown-date';
    const hotels = Array.isArray(day?.hotels) ? day.hotels : [];
    const hotelNames = hotels.map((hotel) => hotel?.hotel_name || hotel?.name || hotel?.title || 'Unnamed hotel');
    summary.push({ dayLabel, dateLabel, hotelCount: hotels.length, hotelNames });
  }

  return summary;
}

function printSummary(detailsJson) {
  logHeader('DETAILS SUMMARY');
  const waitingMentions = findWaitingMentions(detailsJson);
  const hotelSummary = summarizeHotelDays(detailsJson);

  console.log(`Waiting mentions: ${waitingMentions.length}`);
  waitingMentions.slice(0, 20).forEach((hit, index) => {
    console.log(`  ${index + 1}. ${hit.path}`);
    console.log(`     ${typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value)}`);
  });

  console.log(`\nHotel day summary (${hotelSummary.length} day entries):`);
  hotelSummary.forEach((entry) => {
    console.log(
      `  Day ${entry.dayLabel} | ${entry.dateLabel} | hotels=${entry.hotelCount} | ${entry.hotelNames.join(' ; ')}`
    );
  });
}

function analyzeTimelineIssues(detailsJson) {
  const issues = [];
  const planDays = Array.isArray(detailsJson?.data?.plan_days) ? detailsJson.data.plan_days : [];

  for (let i = 0; i < planDays.length; i++) {
    const day = planDays[i];
    const hotels = Array.isArray(day?.hotels) ? day.hotels : [];
    if (hotels.length > 1) {
      issues.push(`Day ${day?.day ?? i + 1} has multiple hotels (${hotels.length})`);
    }

    const activities = Array.isArray(day?.activities) ? day.activities : [];
    for (const activity of activities) {
      const title = String(activity?.title || activity?.name || '').toLowerCase();
      if (title.includes('waiting')) {
        issues.push(`Day ${day?.day ?? i + 1} contains waiting activity: ${activity?.title || activity?.name}`);
      }
    }
  }

  return issues;
}

function printIssueSummary(detailsJson) {
  logHeader('TIMELINE ISSUE SUMMARY');
  const issues = analyzeTimelineIssues(detailsJson);
  if (issues.length === 0) {
    console.log('No timeline consistency issues detected by automated checks.');
    return;
  }

  console.log(`Detected ${issues.length} potential issue(s):`);
  for (let i = 0; i < issues.length; i++) {
    console.log(`${i + 1}. ${issues[i]}`);
  }
}

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Use Node.js 18+ to run this script.');
  }

  logHeader('STEP 1: CREATE ITINERARY (POST)');
  const createUrl = `${BASE_URL}/api/v1/itineraries/?type=itineary_basic_info`;
  const createResult = await requestJson(createUrl, { method: 'POST', body: createPayload });
  if (!createResult.ok) {
    throw new Error(`Create API failed with status ${createResult.status}`);
  }

  const createdQuoteId = getQuoteId(createResult.json);
  const detailsId = createdQuoteId || DETAILS_ID_FALLBACK;
  console.log(`\n[INFO] Using details id: ${detailsId}`);
  if (!createdQuoteId) {
    console.log(`[INFO] Create response had no quote id, fallback used: ${DETAILS_ID_FALLBACK}`);
  }

  logHeader('STEP 2: FETCH DETAILS (GET)');
  const detailsUrl = `${BASE_URL}/api/v1/itineraries/details/${detailsId}`;
  const detailsResult = await requestJson(detailsUrl, { method: 'GET' });
  if (!detailsResult.ok) {
    throw new Error(`Details API failed with status ${detailsResult.status}`);
  }

  printSummary(detailsResult.json);
  printIssueSummary(detailsResult.json);

  logHeader('DONE');
  console.log('Repro complete. Review response + waiting summary above.');
}

main().catch((error) => {
  console.error('\n[ERROR]', error.message || error);
  process.exit(1);
});