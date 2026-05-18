/* eslint-disable no-console */

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const QUOTE_ID = process.env.QUOTE_ID || 'DVI20260589';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const HOTEL_LABEL = (process.env.HOTEL_LABEL || 'MUNNAR QUEEN').trim();

const EXPECTED_LEGS = [
  'MUNNAR QUEEN -> Cheeyappara Waterfalls',
  'Cheeyappara Waterfalls -> Pothamedu View Point',
  'Pothamedu View Point -> Eravikulam National Park',
  'Eravikulam National Park -> Photo view point',
  'Photo view point -> Mattupetty Dam & Lake',
  'Mattupetty Dam & Lake -> Echo Point',
  'Echo Point -> MUNNAR QUEEN',
];

function normalize(value) {
  return String(value || '').trim();
}

function canonicalStopName(value) {
  return normalize(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .trim();
}

function normalizeKey(value) {
  return canonicalStopName(value).toLowerCase();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function getDayTravelLegs(day) {
  const segments = Array.isArray(day?.segments) ? day.segments : [];
  return segments
    .filter((seg) => String(seg?.type || '').toLowerCase() === 'travel')
    .map((seg) => ({
      from: normalize(seg?.from),
      to: normalize(seg?.to),
      text: normalize(seg?.text),
      timeRange: normalize(seg?.timeRange),
    }));
}

function findTargetDay(days) {
  const targetAttractions = new Set([
    'cheeyappara waterfalls',
    'pothamedu view point',
    'eravikulam national park',
    'photo view point',
    'mattupetty dam & lake',
    'echo point',
  ]);

  let best = null;
  let bestScore = -1;

  for (const day of days) {
    const segments = Array.isArray(day?.segments) ? day.segments : [];
    const attractionNames = segments
      .filter((seg) => String(seg?.type || '').toLowerCase() === 'attraction')
      .map((seg) => normalizeKey(seg?.name));

    const score = attractionNames.filter((name) => targetAttractions.has(name)).length;
    if (score > bestScore) {
      bestScore = score;
      best = day;
    }
  }

  return best;
}

async function main() {
  const url = `${API_BASE_URL}/itineraries/details/${QUOTE_ID}`;
  const headers = {
    Accept: 'application/json',
  };

  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }

  console.log(`[Request] GET ${url}`);
  const response = await fetch(url, { headers });
  assert(response.ok, `Details API failed: HTTP ${response.status}`);

  const payload = await response.json();
  const days = Array.isArray(payload?.days) ? payload.days : [];
  assert(days.length > 0, 'No days in details response.');

  const day = findTargetDay(days);
  assert(day, 'Unable to locate target day with expected attractions.');

  const segments = Array.isArray(day?.segments) ? day.segments : [];
  const travelLegs = getDayTravelLegs(day);

  console.log(`[Day] dayNumber=${day.dayNumber} routeId=${day.id}`);
  console.log('[Travel Legs]');
  travelLegs.forEach((leg, idx) => {
    console.log(`  [${idx}] ${leg.from} -> ${leg.to} (${leg.timeRange})`);
  });

  // Rule assertions:
  // 1) Non-final travel before attraction must point to immediate next attraction.
  // 2) Non-final travel must not point to hotel/city label.
  // 3) Final travel-to-hotel may point to hotel label.
  let finalTravelIndex = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (String(segments[i]?.type || '').toLowerCase() === 'travel') {
      finalTravelIndex = i;
      break;
    }
  }

  segments.forEach((seg, idx) => {
    if (String(seg?.type || '').toLowerCase() !== 'travel') return;

    const to = normalize(seg?.to);
    const nextStop = segments.slice(idx + 1).find((row) => {
      const t = String(row?.type || '').toLowerCase();
      return t === 'attraction' || t === 'checkin';
    });

    if (!nextStop) return;

    const nextType = String(nextStop?.type || '').toLowerCase();
    const nextName = canonicalStopName(nextType === 'attraction' ? nextStop?.name : nextStop?.hotelName);
    const isFinalTravel = idx === finalTravelIndex;

    if (nextType === 'attraction') {
      assert(
        normalizeKey(to) === normalizeKey(nextName),
        `Travel at index ${idx} points to "${to}" but immediate next attraction is "${nextName}".`,
      );

      assert(
        normalizeKey(to) !== normalizeKey(HOTEL_LABEL),
        `Travel at index ${idx} incorrectly points to hotel label "${HOTEL_LABEL}" before attraction.`,
      );
    }

    if (nextType === 'checkin' && isFinalTravel) {
      assert(
        normalizeKey(to) === normalizeKey(nextName) || normalizeKey(to) === normalizeKey(HOTEL_LABEL),
        `Final travel-to-hotel mismatch: got "${to}", expected "${nextName}" or "${HOTEL_LABEL}".`,
      );
    }
  });

  const actualLegStrings = travelLegs.map((leg) => `${leg.from} -> ${leg.to}`);
  assert(
    actualLegStrings.length >= EXPECTED_LEGS.length,
    `Not enough travel legs. Expected at least ${EXPECTED_LEGS.length}, got ${actualLegStrings.length}.`,
  );

  for (let i = 0; i < EXPECTED_LEGS.length; i += 1) {
    assert(
      normalizeKey(actualLegStrings[i]) === normalizeKey(EXPECTED_LEGS[i]),
      `Leg mismatch at index ${i}: expected "${EXPECTED_LEGS[i]}", got "${actualLegStrings[i]}".`,
    );
  }

  console.log('[PASS] Confirmed itinerary travel labels match expected sequence and guard rules.');
}

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});
