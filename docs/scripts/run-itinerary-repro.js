/*
 * Repro script for itinerary creation/details debugging.
 * Usage:
 *   node run-itinerary-repro.js
 *   BASE_URL=http://127.0.0.1:4006 TOKEN=... node run-itinerary-repro.js
 */

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4006';
const TOKEN =
  process.env.TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc2ODI2NTEsImV4cCI6MTc3ODI4NzQ1MX0.7pWoIL-8qRkUXDb24aLdCM0no5DVBrjTONv9LyMZjwU';
const DETAILS_ID_FALLBACK = process.env.DETAILS_ID || 'DVI202604247';

const createPayload = {
  // Itinerary through Madurai + Rameswaram — cities with ResAvenue hotels:
  //   Madurai  -> Poppys Hotel Madurai         (resavenue_hotel_code: 18)
  //   Rameswaram -> Vinayaga by Poppys          (resavenue_hotel_code: 20)
  plan: {
    agent_id: 8,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Madurai',
    departure_point: 'Madurai',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [3],
    hotel_facilities: [],
    trip_start_date: '2026-06-15T08:00:00+05:30',
    trip_end_date: '2026-06-17T20:00:00+05:30',
    pick_up_date_and_time: '2026-06-15T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 2,
    no_of_days: 3,
    budget: 30000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 99,
    food_type: 0,
    meal_plan_code: 'CP',
    meal_plan_breakfast: 1,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 2,
    child_count: 0,
    infant_count: 0,
    special_instructions: 'ResAvenue hotel test - Madurai/Rameswaram',
  },
  routes: [
    {
      location_name: 'Madurai',
      next_visiting_location: 'Rameswaram',
      itinerary_route_date: '2026-06-15T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 163,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Rameswaram',
      next_visiting_location: 'Madurai',
      itinerary_route_date: '2026-06-16T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 163,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Madurai',
      next_visiting_location: 'Madurai',
      itinerary_route_date: '2026-06-17T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 0,
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

function printSummary(detailsJson) {
  logHeader('WAITING/BREAK SUMMARY');
  const hits = findWaitingMentions(detailsJson);
  if (hits.length === 0) {
    console.log('No waiting/break mentions found in details response.');
    return;
  }

  console.log(`Found ${hits.length} waiting/break-related nodes:`);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    console.log(`\n[${i + 1}] Path: ${hit.path}`);
    if (typeof hit.value === 'string') {
      console.log(hit.value);
    } else {
      console.log(JSON.stringify(hit.value, null, 2));
    }
  }
}

function parseClockToMinutes(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3].toUpperCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (meridiem === 'PM') hour += 12;
  return hour * 60 + minute;
}

function parseTimeRangeMinutes(timeRange) {
  if (!timeRange || typeof timeRange !== 'string') return null;
  const [startRaw, endRaw] = timeRange.split('-').map((s) => s.trim());
  if (!startRaw || !endRaw) return null;
  const start = parseClockToMinutes(startRaw);
  const end = parseClockToMinutes(endRaw);
  if (start == null || end == null) return null;
  let diff = end - start;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function parseDurationLabelMinutes(label) {
  if (!label || typeof label !== 'string') return null;
  const text = label.toLowerCase();
  const hMatch = text.match(/(\d+)\s*hours?/);
  const mMatch = text.match(/(\d+)\s*min/);
  const h = hMatch ? Number(hMatch[1]) : 0;
  const m = mMatch ? Number(mMatch[1]) : 0;
  const total = h * 60 + m;
  return Number.isFinite(total) ? total : null;
}

function getDaysFromDetails(detailsJson) {
  const paths = ['data.days', 'days', 'data.itinerary.days', 'itinerary.days'];
  for (const path of paths) {
    const value = pick(detailsJson, path.split('.').map((p) => p).join('.') ? [path] : []);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function analyzeTimelineIssues(detailsJson) {
  const issues = [];
  const days = getDaysFromDetails(detailsJson);

  for (const day of days) {
    const dayNumber = Number(day?.dayNumber || 0);
    const segments = Array.isArray(day?.segments) ? day.segments : [];
    const dayEndMinutes = parseClockToMinutes(String(day?.endTime || '').trim());

    const hasStart = segments.some((seg) => String(seg?.type || '').toLowerCase() === 'start');
    if (!hasStart) {
      issues.push(`Day ${dayNumber}: missing start segment`);
    }

    for (const seg of segments) {
      const type = String(seg?.type || '').toLowerCase();
      if (type !== 'travel') continue;

      const rangeMinutes = parseTimeRangeMinutes(seg?.timeRange);
      const durationMinutes = parseDurationLabelMinutes(seg?.duration);
      const from = String(seg?.from || '').trim() || 'UnknownFrom';
      const to = String(seg?.to || '').trim() || 'UnknownTo';

      if (rangeMinutes != null && durationMinutes != null) {
        const delta = Math.abs(rangeMinutes - durationMinutes);
        if (delta >= 15) {
          issues.push(
            `Day ${dayNumber}: travel ${from} -> ${to} has timeRange ${rangeMinutes} min but duration ${durationMinutes} min (delta ${delta} min)`,
          );
        }
      }

      if (rangeMinutes === 0 && durationMinutes != null && durationMinutes > 0) {
        issues.push(
          `Day ${dayNumber}: zero-length travel timeRange for ${from} -> ${to} but duration is ${durationMinutes} min`,
        );
      }

      if (dayEndMinutes != null && typeof seg?.timeRange === 'string') {
        const parts = seg.timeRange.split('-').map((s) => s.trim());
        if (parts.length === 2) {
          const endMin = parseClockToMinutes(parts[1]);
          if (endMin != null && endMin > dayEndMinutes + 5) {
            issues.push(
              `Day ${dayNumber}: travel ${from} -> ${to} ends after day end (${parts[1]} > ${day.endTime})`,
            );
          }
        }
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

  // ─── STEP 3: Fetch hotel options (ResAvenue + TBO) for this itinerary ───
  logHeader('STEP 3: FETCH HOTEL DETAILS (ResAvenue + TBO)');
  const hotelDetailsUrl = `${BASE_URL}/api/v1/itineraries/hotel_details/${detailsId}`;
  console.log('[INFO] Fetching hotel packages — this may take 30-60s while calling live APIs...');
  const hotelDetailsResult = await requestJson(hotelDetailsUrl, { method: 'GET' });

  if (!hotelDetailsResult.ok) {
    console.error(`[ERROR] hotel_details failed: HTTP ${hotelDetailsResult.status}`);
  } else {
    // Summarize what providers returned hotels
    const hd = hotelDetailsResult.json;
    const routes = hd?.routes || hd?.data?.routes || [];
    if (routes.length === 0) {
      console.log('[INFO] No routes found in hotel_details response. Raw response above.');
    } else {
      console.log(`\n[HOTEL SUMMARY] ${routes.length} route(s) returned hotel options:\n`);
      for (const route of routes) {
        const city = route.city || route.locationName || route.destination || '(city?)';
        const hotels = route.hotels || route.hotelOptions || route.results || [];
        console.log(`  Route: ${city} — ${hotels.length} hotel(s)`);
        for (const h of hotels) {
          const provider = h.provider || h.source || '?';
          const name = h.hotelName || h.name || h.hotel_name || '(no name)';
          const price = h.price || h.totalPrice || h.minPrice || '?';
          console.log(`    [${provider}] ${name} — ₹${price}`);
        }
      }
    }

    // Also check packages (TBO returns grouped packages)
    const packages = hd?.packages || hd?.data?.packages || [];
    if (packages.length > 0) {
      console.log(`\n[HOTEL PACKAGES] ${packages.length} package(s) found:`);
      for (const pkg of packages) {
        console.log(`  Package: ${pkg.label || pkg.type || pkg.category || 'Unknown'} — ₹${pkg.totalPrice || pkg.price || '?'}`);
        const pkgHotels = pkg.hotels || [];
        for (const h of pkgHotels) {
          const provider = h.provider || h.source || '?';
          const name = h.hotelName || h.name || '(no name)';
          console.log(`    [${provider}] ${name}`);
        }
      }
    }
  }

}

main().catch((error) => {
  console.error('\n[ERROR]', error.message || error);
  process.exit(1);
});
