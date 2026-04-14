const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:4006/api/v1';
const EMAIL = process.env.E2E_EMAIL || process.env.PROD_EMAIL || 'admin@dvi.co.in';
const PASSWORD = process.env.E2E_PASSWORD || process.env.PROD_PASSWORD || 'Keerthi@2404ias';
const SERVER_LOG_PATH = process.env.SERVER_LOG_PATH || path.join(process.cwd(), 'hotspot-debug-server.log');
const OUT_DIR = path.join(process.cwd(), 'verification-e2e', 'automation', 'artifacts');
const OUT_FILE = path.join(OUT_DIR, `south-india-hotspot-analysis-${Date.now()}.json`);

function isoWithOffset(date, hour = 9, minute = 0) {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString().replace('Z', '+05:30');
}

function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const found = deepFind(v, keys);
      if (found != null) return found;
    }
  }
  return null;
}

function getQuoteId(body) {
  return deepFind(body, ['quoteId', 'quote_id', 'itinerary_quote_ID', 'itinerary_quote_id']);
}

function getPlanId(body) {
  return Number(deepFind(body, ['planId', 'itinerary_plan_ID', 'itinerary_plan_id'])) || 0;
}

function pickToken(body) {
  return deepFind(body, ['access_token', 'accessToken', 'token']);
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
  return { ok: res.ok, status: res.status, body };
}

function parseHotspotEvalLogs(chunkText) {
  const rows = [];
  const lines = String(chunkText || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('[HOTSPOT_CANDIDATE_EVAL]')) continue;
    const idx = line.indexOf('[HOTSPOT_CANDIDATE_EVAL]');
    const payload = line.slice(idx + '[HOTSPOT_CANDIDATE_EVAL]'.length).trim();
    if (!payload) continue;
    try {
      rows.push(JSON.parse(payload));
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

function getLogCursorSafe(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf16le');
    return String(text).split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function readLogChunkFromCursor(filePath, startLineCursor) {
  try {
    const lines = String(fs.readFileSync(filePath, 'utf16le')).split(/\r?\n/);
    return lines.slice(startLineCursor).join('\n');
  } catch {
    return '';
  }
}

function buildPayload(scenario, baseDate) {
  const tripStart = new Date(baseDate);
  const tripEnd = new Date(baseDate);
  tripEnd.setDate(tripEnd.getDate() + 5);

  const routes = scenario.routePattern.map((r, idx) => {
    const day = new Date(baseDate);
    day.setDate(day.getDate() + idx);
    return {
      location_name: r.from,
      next_visiting_location: r.to,
      itinerary_route_date: isoWithOffset(day, 0, 0),
      no_of_days: idx + 1,
      no_of_km: '',
      direct_to_next_visiting_place: r.direct ? 1 : 0,
      via_route: '',
      via_routes: (r.via || []).map((name, i) => ({
        itinerary_via_location_ID: 9000 + i,
        itinerary_via_location_name: name,
      })),
    };
  });

  return {
    plan: {
      itinerary_plan_id: 0,
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: scenario.arrival,
      departure_point: scenario.departure,
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: isoWithOffset(tripStart, 8, 0),
      trip_end_date: isoWithOffset(tripEnd, 20, 0),
      pick_up_date_and_time: isoWithOffset(tripStart, 9, 0),
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: 5,
      no_of_days: 6,
      budget: 45000,
      entry_ticket_required: 1,
      guide_for_itinerary: 1,
      nationality: 101,
      food_type: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: `Hotspot determinism debug :: ${scenario.name}`,
    },
    routes,
    vehicles: [{ vehicle_type_id: scenario.vehicleTypeId, vehicle_count: 1 }],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
  };
}

function extractSelectedHotspots(detailsBody) {
  const days = deepFind(detailsBody, ['days']) || [];
  const selected = [];
  for (const day of days) {
    const segments = Array.isArray(day?.segments) ? day.segments : [];
    for (const segment of segments) {
      const type = String(segment?.type || '').toLowerCase();
      const hotspotId = Number(segment?.hotspotId || segment?.hotspot_ID || segment?.locationId || 0) || 0;
      if (!hotspotId) continue;
      if (type !== 'attraction' && type !== 'hotspot' && type !== 'sightseeing') continue;
      selected.push({
        dayId: Number(day?.id || 0) || 0,
        dayNumber: Number(day?.dayNumber || 0) || 0,
        name: segment?.name || segment?.text || `Hotspot ${hotspotId}`,
        hotspotId,
        priority: Number(segment?.priority || segment?.hotspot_priority || 0) || 0,
        visitTime: segment?.visitTime || segment?.timeRange || '',
        isMustVisit: Number(segment?.priority || segment?.hotspot_priority || 0) > 0,
      });
    }
  }
  return selected;
}

function summarizeRun({ scenario, runIndex, payload, quoteId, planId, detailsBody, evalLogs, routeIdsFromCreate }) {
  const days = deepFind(detailsBody, ['days']) || [];
  const routeIds = new Set((routeIdsFromCreate || []).map((x) => Number(x || 0)).filter(Boolean));
  const runLogs = evalLogs.filter((row) => routeIds.has(Number(row.routeId || 0)));
  const selected = extractSelectedHotspots(detailsBody);

  const selectedOrder = selected.map((s) => ({
    hotspotId: s.hotspotId,
    name: s.name,
    priority: s.priority,
    visitTime: s.visitTime,
    isMustVisit: s.isMustVisit,
    dayNumber: s.dayNumber,
  }));

  const expectedPriorityOrder = [...selected]
    .sort((a, b) => {
      const ap = a.priority === 0 ? 9999 : a.priority;
      const bp = b.priority === 0 ? 9999 : b.priority;
      if (ap !== bp) return ap - bp;
      return a.hotspotId - b.hotspotId;
    })
    .map((s) => ({ hotspotId: s.hotspotId, name: s.name, priority: s.priority }));

  const rejected = runLogs
    .filter((r) => !r.selected)
    .map((r) => ({
      hotspotId: r.hotspotId,
      name: r.name,
      priority: r.priority,
      rejectedReason: r.rejectedReason || r.rejectedReasons || null,
    }));

  const priority1Logs = runLogs.filter((r) => Number(r.priority || 0) === 1);
  const priority1Fetched = priority1Logs.length > 0;
  const priority1Selected = priority1Logs.some((r) => r.selected === true);
  const priority1Rejected = priority1Logs.some((r) => r.selected === false);

  return {
    scenario: scenario.name,
    runIndex,
    quoteId,
    planId,
    routeDetails: {
      source: payload.plan.arrival_point,
      destination: payload.plan.departure_point,
      dates: {
        tripStart: payload.plan.trip_start_date,
        tripEnd: payload.plan.trip_end_date,
      },
      vehicle: payload.vehicles[0],
      keyConfig: {
        itineraryPreference: payload.plan.itinerary_preference,
        entryTicketRequired: payload.plan.entry_ticket_required,
        guideForItinerary: payload.plan.guide_for_itinerary,
        noOfNights: payload.plan.no_of_nights,
      },
      routePattern: scenario.routePattern,
    },
    selectedHotspots: selectedOrder,
    priorityOrder: {
      expectedPriorityOrder,
      actualSelectedOrder: selectedOrder.map((s) => ({
        hotspotId: s.hotspotId,
        name: s.name,
        priority: s.priority,
      })),
      priority1Fetched,
      priority1Selected,
      priority1Rejected,
    },
    rejectedHotspots: rejected,
    candidateLogsCount: runLogs.length,
  };
}

async function loginAndGetToken() {
  const login = await fetchJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!login.ok) {
    throw new Error(`Login failed with status ${login.status}`);
  }
  const token = pickToken(login.body);
  if (!token) {
    throw new Error('Login succeeded but token missing');
  }
  return token;
}

async function runOneScenarioRun({ token, scenario, runIndex, payload, logStartCursor }) {
  const create = await fetchJson(`${API_BASE}/itineraries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!create.ok) {
    throw new Error(`Create itinerary failed (${scenario.name} run ${runIndex}) status=${create.status}`);
  }

  const quoteId = String(getQuoteId(create.body) || '');
  const routeIdsFromCreate = Array.isArray(create.body?.routeIds) ? create.body.routeIds : [];
  if (!quoteId) {
    throw new Error(`Quote ID missing (${scenario.name} run ${runIndex})`);
  }

  const details = await fetchJson(`${API_BASE}/itineraries/details/${encodeURIComponent(quoteId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });

  if (!details.ok) {
    throw new Error(`Details fetch failed (${scenario.name} run ${runIndex}) status=${details.status}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const logChunk = readLogChunkFromCursor(SERVER_LOG_PATH, logStartCursor);
  const evalLogs = parseHotspotEvalLogs(logChunk);
  const planId = getPlanId(details.body) || Number(deepFind(details.body, ['itinerary_plan_ID', 'itinerary_plan_id'])) || 0;

  return summarizeRun({
    scenario,
    runIndex,
    payload,
    quoteId,
    planId,
    detailsBody: details.body,
    evalLogs,
    routeIdsFromCreate,
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const scenarios = [
    {
      name: 'TN-Coast-Chennai-Mahabalipuram-Pondicherry',
      arrival: 'Chennai',
      departure: 'Chennai',
      vehicleTypeId: 1,
      routePattern: [
        { from: 'Chennai', to: 'Mahabalipuram', direct: 0 },
        { from: 'Mahabalipuram', to: 'Pondicherry', direct: 0 },
        { from: 'Pondicherry', to: 'Pondicherry', direct: 0 },
        { from: 'Pondicherry', to: 'Pondicherry', direct: 0 },
        { from: 'Pondicherry', to: 'Chennai', direct: 0 },
        { from: 'Chennai', to: 'Chennai', direct: 1 },
      ],
    },
    {
      name: 'Kerala-Trivandrum-Munnar-Alleppey',
      arrival: 'Trivandrum',
      departure: 'Kochi',
      vehicleTypeId: 1,
      routePattern: [
        { from: 'Trivandrum', to: 'Munnar', direct: 0 },
        { from: 'Munnar', to: 'Munnar', direct: 0 },
        { from: 'Munnar', to: 'Alleppey', direct: 0 },
        { from: 'Alleppey', to: 'Alleppey', direct: 0 },
        { from: 'Alleppey', to: 'Kochi', direct: 0 },
        { from: 'Kochi', to: 'Kochi', direct: 1 },
      ],
    },
    {
      name: 'Karnataka-Bengaluru-Mysuru-Ooty',
      arrival: 'Bengaluru',
      departure: 'Coimbatore',
      vehicleTypeId: 1,
      routePattern: [
        { from: 'Bengaluru', to: 'Mysuru', direct: 0 },
        { from: 'Mysuru', to: 'Mysuru', direct: 0 },
        { from: 'Mysuru', to: 'Ooty', direct: 0 },
        { from: 'Ooty', to: 'Ooty', direct: 0 },
        { from: 'Ooty', to: 'Coimbatore', direct: 0 },
        { from: 'Coimbatore', to: 'Coimbatore', direct: 1 },
      ],
    },
    {
      name: 'AP-Telangana-Tirupati-Hyderabad',
      arrival: 'Tirupati',
      departure: 'Tirupati',
      vehicleTypeId: 1,
      routePattern: [
        { from: 'Tirupati', to: 'Hyderabad', direct: 0 },
        { from: 'Hyderabad', to: 'Hyderabad', direct: 0 },
        { from: 'Hyderabad', to: 'Hyderabad', direct: 0 },
        { from: 'Hyderabad', to: 'Tirupati', direct: 0 },
        { from: 'Tirupati', to: 'Tirupati', direct: 0 },
        { from: 'Tirupati', to: 'Tirupati', direct: 1 },
      ],
    },
    {
      name: 'Mixed-Chennai-Tirupati-Hyderabad-Mahabalipuram',
      arrival: 'Chennai',
      departure: 'Chennai',
      vehicleTypeId: 1,
      routePattern: [
        { from: 'Chennai', to: 'Tirupati', direct: 0 },
        { from: 'Tirupati', to: 'Hyderabad', direct: 0 },
        { from: 'Hyderabad', to: 'Hyderabad', direct: 0 },
        { from: 'Hyderabad', to: 'Mahabalipuram', direct: 0 },
        { from: 'Mahabalipuram', to: 'Chennai', direct: 0 },
        { from: 'Chennai', to: 'Chennai', direct: 1 },
      ],
    },
  ];

  const token = await loginAndGetToken();
  const allRuns = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    const scenarioBaseDate = new Date('2026-05-10T00:00:00+05:30');
    scenarioBaseDate.setDate(scenarioBaseDate.getDate() + i * 8);

    const payload = buildPayload(scenario, scenarioBaseDate);

    for (let runIndex = 1; runIndex <= 2; runIndex++) {
      const logStartCursor = getLogCursorSafe(SERVER_LOG_PATH);
      const result = await runOneScenarioRun({
        token,
        scenario,
        runIndex,
        payload,
        logStartCursor,
      });
      allRuns.push(result);
      console.log(`[RUN_OK] ${scenario.name} :: run ${runIndex} :: quote=${result.quoteId}`);
    }
  }

  const grouped = {};
  for (const run of allRuns) {
    if (!grouped[run.scenario]) grouped[run.scenario] = [];
    grouped[run.scenario].push(run);
  }

  const repeatability = Object.entries(grouped).map(([scenario, runs]) => {
    const [a, b] = runs;
    const aSel = JSON.stringify((a?.selectedHotspots || []).map((x) => [x.hotspotId, x.visitTime]));
    const bSel = JSON.stringify((b?.selectedHotspots || []).map((x) => [x.hotspotId, x.visitTime]));
    return {
      scenario,
      deterministic: aSel === bSel,
      run1Quote: a?.quoteId || null,
      run2Quote: b?.quoteId || null,
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    serverLogPath: SERVER_LOG_PATH,
    totalRuns: allRuns.length,
    runs: allRuns,
    repeatability,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
  console.log(`ARTIFACT ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('FAILED', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
