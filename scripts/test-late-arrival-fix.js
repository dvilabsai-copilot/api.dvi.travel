/**
 * Test: Late Arrival Day 1 - No Sightseeing Fix
 * Plan: DVI202604228 (planId 266, route 1872)
 * Arrival: 11:35 PM → should have NO sightseeing on Day 1
 *
 * Steps:
 *   1. PATCH route times to set arrival 23:35 (triggers rebuild)
 *   2. GET itinerary details and assert Day 1 has no attraction segments
 */

const API_BASE = 'http://127.0.0.1:4006/api/v1';
const TOKEN = process.env.ITINERARY_BEARER_TOKEN || '';
const QUOTE_ID = 'DVI202604228';
const PLAN_ID = 266;
const ROUTE_ID = 1872;

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
};

async function triggerRebuild() {
  // Step 1a: PATCH route times (HH:MM:SS required) to persist 23:35 start
  console.log('\n[1a] PATCH route times to 23:35:00 ...');
  const patchRes = await fetch(`${API_BASE}/itineraries/${PLAN_ID}/route/${ROUTE_ID}/times`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      startTime: '23:35:00',
      endTime: '20:00:00',
    }),
  });
  const patchBody = await patchRes.json().catch(() => ({}));
  console.log('    PATCH Status:', patchRes.status);
  if (!patchRes.ok) {
    console.log('    PATCH error:', JSON.stringify(patchBody, null, 2));
  } else {
    console.log('    Rebuild summary:', JSON.stringify(patchBody?.rebuildSummary ?? '(none)', null, 2));
  }

  if (patchRes.ok) return true;

  // Step 1b: Fallback - use direct rebuild endpoint if PATCH failed
  console.log('\n[1b] Fallback: POST rebuild-hotspots for route', ROUTE_ID, '...');
  const rebuildRes = await fetch(`${API_BASE}/itineraries/${PLAN_ID}/routes/${ROUTE_ID}/rebuild-hotspots`, {
    method: 'POST',
    headers,
  });
  const rebuildBody = await rebuildRes.json().catch(() => ({}));
  console.log('    Rebuild Status:', rebuildRes.status);
  console.log('    Rebuild result:', JSON.stringify(rebuildBody?.summary ?? rebuildBody, null, 2));
  return rebuildRes.ok;
}

async function checkDay1() {
  console.log('\n[2] GET /itineraries/details/' + QUOTE_ID + ' ...');
  const res = await fetch(`${API_BASE}/itineraries/details/${QUOTE_ID}`, { headers });
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }

  const payload = body?.data ?? body;
  const days = Array.isArray(payload?.days) ? payload.days : [];
  const day1 = days.find((d) => Number(d?.dayNumber) === 1) || days[0] || null;
  const segments = Array.isArray(day1?.segments) ? day1.segments : [];

  console.log('    HTTP status:', res.status);
  console.log('    Day 1 startTime:', day1?.startTime ?? 'N/A');
  console.log('    Total segments:', segments.length);
  console.log('');

  const attractions = segments.filter((s) => s.type === 'attraction');
  const travels = segments.filter((s) => s.type === 'travel');
  const checkins = segments.filter((s) => s.type === 'checkin');
  const starts = segments.filter((s) => s.type === 'start');

  console.log('--- Segment Breakdown ---');
  console.log('  start    :', starts.length);
  console.log('  travel   :', travels.length);
  console.log('  checkin  :', checkins.length);
  console.log('  attraction:', attractions.length, attractions.length === 0 ? '✅ NONE (correct!)' : '❌ STILL HAS SIGHTSEEING (bug!)');
  console.log('');

  console.log('--- Full Day 1 Segment List ---');
  segments.forEach((s, i) => {
    const label =
      s.type === 'travel' ? `${s.from} → ${s.to}` :
      s.type === 'attraction' ? s.name :
      s.type === 'checkin' ? `Check-in: ${s.hotelName}` :
      s.type === 'start' ? s.title :
      s.type === 'return' ? 'Return' : s.type;
    const time = s.timeRange ?? s.time ?? s.visitTime ?? '';
    console.log(`  ${i + 1}. [${s.type}] ${label} ${time}`);
  });

  const passed = attractions.length === 0;
  console.log('');
  console.log(passed
    ? '✅ PASS: Day 1 has no sightseeing (late arrival correctly handled)'
    : '❌ FAIL: Day 1 still has ' + attractions.length + ' attraction(s) scheduled');

  return passed;
}

(async () => {
  if (!TOKEN) {
    console.error('ERROR: Set ITINERARY_BEARER_TOKEN env variable before running.');
    process.exit(1);
  }

  try {
    await triggerRebuild();
    // Small wait for rebuild to complete
    await new Promise((r) => setTimeout(r, 1500));
    const passed = await checkDay1();
    process.exit(passed ? 0 : 1);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
