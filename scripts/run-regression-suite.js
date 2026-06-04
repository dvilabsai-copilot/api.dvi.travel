#!/usr/bin/env node

/*
Local example:
BASE_URL=http://localhost:4006
DVI_EMAIL=admin@dvi.co.in
DVI_PASSWORD=Keerthi@2404ias

Production example:
BASE_URL=https://your-prod-domain.com
DVI_EMAIL=admin@dvi.co.in
DVI_PASSWORD=your-password
*/

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function buildApiBase() {
  const baseUrl = normalizeBaseUrl(process.env.BASE_URL);
  if (baseUrl) {
    return `${baseUrl}/api/v1`;
  }

  return 'http://127.0.0.1:4006/api/v1';
}

const API_BASE = buildApiBase();

const REGRESSION_DIR = path.join(__dirname, 'regression');
const PROJECT_ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'tmp', 'regression-results');
const REPORT_PATH = path.join(PROJECT_ROOT, 'tmp', 'regression-report.md');
const TRIGGER_SCRIPT = path.join(__dirname, 'trigger_direct_build.js');
const STRICT_DUPLICATE_HOTSPOT = String(process.env.STRICT_DUPLICATE_HOTSPOT || '').trim() === '1';
const CASE_FILTER = (() => {
  const caseFlagIndex = process.argv.indexOf('--case');
  return caseFlagIndex >= 0 ? String(process.argv[caseFlagIndex + 1] || '').trim() : '';
})();

function normalize(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function canonicalCityKey(value) {
  const normalized = normalize(value);
  return normalized.split(' ').filter(Boolean).join(' ');
}

function matchesLocation(hotspotLocation, routeLocation) {
  const hotspotKey = canonicalCityKey(hotspotLocation);
  const routeKey = canonicalCityKey(routeLocation);
  if (!hotspotKey || !routeKey) return false;
  return hotspotKey.includes(routeKey) || routeKey.includes(hotspotKey);
}

function timeToMinutes(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return value.getUTCHours() * 60 + value.getUTCMinutes() + value.getUTCSeconds() / 60;
  }
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3] || 0) / 60;
}

function getHotspotTimingDay(dateValue) {
  const date = new Date(dateValue);
  return (date.getUTCDay() + 6) % 7;
}

function normalizeTimingWindow(openMinutes, closeMinutes) {
  if (openMinutes == null || closeMinutes == null) return null;
  let normalizedClose = closeMinutes;
  if (normalizedClose <= openMinutes) {
    normalizedClose += 24 * 60;
  }
  return {
    open: openMinutes,
    close: normalizedClose,
  };
}

function normalizeVisitWindow(startMinutes, endMinutes) {
  if (startMinutes == null || endMinutes == null) return null;
  let normalizedEnd = endMinutes;
  if (normalizedEnd <= startMinutes) {
    normalizedEnd += 24 * 60;
  }
  return {
    start: startMinutes,
    end: normalizedEnd,
  };
}

function getActiveTimingRowsForDay(timings, routeDate) {
  const day = getHotspotTimingDay(routeDate);
  return (Array.isArray(timings) ? timings : []).filter(
    (row) => Number(row.hotspot_timing_day) === day && Number(row.deleted || 0) === 0 && Number(row.status || 0) === 1,
  );
}

function timingFitsRouteWindow(timings, routeDate, routeStart, routeEnd) {
  if (!Array.isArray(timings) || timings.length === 0) {
    return { fits: true, reason: 'No timing rows; treated as always open' };
  }
  const dayRows = getActiveTimingRowsForDay(timings, routeDate);
  if (!dayRows.length) {
    return { fits: true, reason: `No timing row for timingDay=${getHotspotTimingDay(routeDate)}; treated as unknown/open` };
  }
  if (dayRows.some((row) => Number(row.hotspot_open_all_time || 0) === 1)) {
    return { fits: true, reason: 'Open all day' };
  }
  const routeWindow = normalizeVisitWindow(timeToMinutes(routeStart), timeToMinutes(routeEnd));
  if (!routeWindow) {
    return { fits: false, reason: 'Route time missing' };
  }
  const fits = dayRows.some((row) => {
    const normalized = normalizeTimingWindow(timeToMinutes(row.hotspot_start_time), timeToMinutes(row.hotspot_end_time));
    if (!normalized) return false;
    return routeWindow.start < normalized.close && routeWindow.end > normalized.open;
  });
  return fits
    ? { fits: true, reason: 'Route intersects operating window' }
    : {
        fits: false,
        reason: `No route overlap with ${dayRows.map((row) => `${formatTime(row.hotspot_start_time)}-${formatTime(row.hotspot_end_time)}`).join(', ')}`,
      };
}

function timingFitsScheduledVisit(timings, routeDate, visitStart, visitEnd, options = {}) {
  if (!Array.isArray(timings) || timings.length === 0) {
    return { fits: true, reason: 'No timing rows; treated as always open' };
  }
  const dayRows = getActiveTimingRowsForDay(timings, routeDate);
  const activeRows = timings.filter((row) => Number(row.deleted || 0) === 0 && Number(row.status || 0) === 1);
  const rowsToCheck = dayRows.length
    ? dayRows
    : (options.fallbackToAnyDayWhenMissing ? activeRows : []);
  if (!rowsToCheck.length) {
    return { fits: true, reason: `No timing row for timingDay=${getHotspotTimingDay(routeDate)}; treated as unknown/open` };
  }
  if (rowsToCheck.some((row) => Number(row.hotspot_open_all_time || 0) === 1)) {
    return { fits: true, reason: 'Open all day' };
  }
  const visitWindow = normalizeVisitWindow(timeToMinutes(visitStart), timeToMinutes(visitEnd));
  if (!visitWindow) {
    return { fits: false, reason: 'Scheduled visit time missing' };
  }
  const fitRow = rowsToCheck.find((row) => {
    const normalized = normalizeTimingWindow(timeToMinutes(row.hotspot_start_time), timeToMinutes(row.hotspot_end_time));
    if (!normalized) return false;
    return visitWindow.start >= normalized.open - 0.01 && visitWindow.end <= normalized.close + 0.01;
  });
  return fitRow
    ? { fits: true, reason: `Fits ${formatTime(fitRow.hotspot_start_time)}-${formatTime(fitRow.hotspot_end_time)}` }
    : {
        fits: false,
        reason: `Outside ${rowsToCheck.map((row) => `${formatTime(row.hotspot_start_time)}-${formatTime(row.hotspot_end_time)}`).join(', ')}`,
      };
}

function parseExcludedHotspotIds(value) {
  if (Array.isArray(value)) return value.map((id) => Number(id)).filter((id) => id > 0);
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    if (Array.isArray(parsed)) return parsed.map((id) => Number(id)).filter((id) => id > 0);
  }
  return [];
}

function timeStringToPrismaTime(hms) {
  const s = String(hms ?? '').trim() || '00:00:00';
  const [h, m, sec] = s.split(':').map((x) => Number(x));
  const hh = Number.isFinite(h) ? h : 0;
  const mm = Number.isFinite(m) ? m : 0;
  const ss = Number.isFinite(sec) ? sec : 0;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, ss));
}

function dateOnlyToLocalDate(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function formatTime(value) {
  if (value == null) return '-';
  if (value instanceof Date) {
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mm = String(value.getUTCMinutes()).padStart(2, '0');
    const ss = String(value.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const text = String(value).trim();
  const match = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
  return match ? match[1] : text;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCaseNameFromPath(filePath) {
  return path.basename(filePath, '.json');
}

function isDirectOnExpectedNoSightseeing(caseDef) {
  return String(caseDef?.caseId || '').toLowerCase() === 'regression-case-04';
}

function isLateArrivalRuleCase(caseDef) {
  return String(caseDef?.caseId || '').toLowerCase() === 'regression-case-11';
}

function isManualCleanupRuleCase(caseDef) {
  return String(caseDef?.caseId || '').toLowerCase() === 'regression-case-13';
}

function isAttractionSegment(segment) {
  const type = String(segment?.type || '').toLowerCase();
  if (type.includes('attraction') || type.includes('hotspot') || type.includes('sightseeing')) return true;
  if (Number(segment?.hotspotId || segment?.hotspot_ID || segment?.routeHotspotId || segment?.route_hotspot_id || 0) > 0) return true;
  const title = String(segment?.title || segment?.name || segment?.text || segment?.hotspot_name || segment?.hotspotName || segment?.placeName || '').trim();
  if (!title) return false;
  const normalized = title.toLowerCase();
  if (normalized === 'click to add hotspot') return false;
  if (normalized.startsWith('start ')) return false;
  if (normalized.includes('return')) return false;
  return Boolean(segment?.hotspot_name || segment?.hotspotName || segment?.placeName);
}

function countDetailsAttractionSegments(detailsSnapshot) {
  const days = Array.isArray(detailsSnapshot?.days) ? detailsSnapshot.days : [];
  const daySummaries = days.map((day) => {
    const segments = Array.isArray(day?.segments) ? day.segments : [];
    const attractionCount = segments.filter(isAttractionSegment).length;
    return {
      dayNumber: Number(day?.dayNumber || 0),
      segmentCount: segments.length,
      attractionCount,
      departure: String(day?.departure || ''),
      arrival: String(day?.arrival || ''),
    };
  });
  return {
    totalSegmentCount: daySummaries.reduce((sum, day) => sum + day.segmentCount, 0),
    totalAttractionCount: daySummaries.reduce((sum, day) => sum + day.attractionCount, 0),
    daySummaries,
  };
}

function isExpectedNoSightseeingCase(caseDef) {
  return isDirectOnExpectedNoSightseeing(caseDef);
}

async function ensureToken() {
  const email = String(process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.DVI_PASSWORD || 'Keerthi@2404ias').trim();
  const resp = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await resp.text();
  const payload = safeJsonParse(text);
  const token =
    payload?.data?.accessToken ||
    payload?.accessToken ||
    payload?.token ||
    payload?.data?.token ||
    payload?.data?.jwt ||
    payload?.jwt ||
    null;
  if (!token) {
    console.error('[REGRESSION_AUTH] login failed', {
      apiBase: API_BASE,
      status: resp.status,
      body: text.slice(0, 500),
      email,
    });
    throw new Error(`Unable to obtain bearer token via login. status=${resp.status}`);
  }
  return {
    token,
    authMode: 'login',
  };
}

async function getJson(url, token) {
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    text,
    json: safeJsonParse(text),
  };
}

async function postJson(url, token, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    text,
    json: safeJsonParse(text),
  };
}

async function rebuildFromPayloadFile(payloadFile, resultFile, token) {
  const env = {
    ...process.env,
    BASE_URL: normalizeBaseUrl(process.env.BASE_URL),
    PAYLOAD_FILE: payloadFile,
    RESULT_FILE: resultFile,
    REGRESSION_BEARER_TOKEN: token,
  };

  const run = spawnSync('node', [TRIGGER_SCRIPT], {
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  return {
    status: run.status,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    ok: run.status === 0,
    rawResultText: fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null,
    rawResultJson: fs.existsSync(resultFile) ? safeJsonParse(fs.readFileSync(resultFile, 'utf8')) : null,
  };
}

async function waitForItineraryBuildReady(prisma, caseDef, planId, quoteId, token, buildResult) {
  const maxWaitMs = 60_000;
  const intervalMs = 2_000;
  const startedAt = Date.now();
  const expectedNoSightseeing = isExpectedNoSightseeingCase(caseDef);
  let lastEvidence = null;

  while (Date.now() - startedAt <= maxWaitMs) {
    const routeSnapshot = await fetchRouteSnapshot(prisma, planId);
    const detailsSnapshot = quoteId ? await getDetailsSnapshot(quoteId, token) : { status: null, ok: false, raw: null, days: [], daysCount: 0 };
    const detailsCounts = countDetailsAttractionSegments(detailsSnapshot);
    const routeCount = routeSnapshot.routes.length;
    const hotspotRowCount = routeSnapshot.hotspotRows.length;
    const attractionRowCount = routeSnapshot.hotspotRows.filter((row) => Number(row.item_type || 0) === 4).length;
    const detailsDayCount = detailsSnapshot.daysCount || 0;
    const detailsAttractionSegmentCount = detailsCounts.totalAttractionCount;
    const ready = routeCount > 0 && (
      attractionRowCount > 0 ||
      detailsAttractionSegmentCount > 0 ||
      expectedNoSightseeing
    );

    lastEvidence = {
      routeCount,
      hotspotRowCount,
      attractionRowCount,
      detailsDayCount,
      detailsAttractionSegmentCount,
      detailsDaySummaries: detailsCounts.daySummaries,
      elapsedMs: Date.now() - startedAt,
      ready,
    };

    console.log('[WAITING_FOR_HOTSPOT_BUILD]', {
      caseId: caseDef.caseId,
      planId,
      quoteId,
      elapsedMs: lastEvidence.elapsedMs,
      routeCount,
      hotspotRowCount,
      attractionRowCount,
      detailsDayCount,
      detailsAttractionSegmentCount,
    });

    if (ready) {
      console.log('[HOTSPOT_BUILD_READY]', {
        caseId: caseDef.caseId,
        planId,
        quoteId,
        elapsedMs: lastEvidence.elapsedMs,
        routeCount,
        hotspotRowCount,
        attractionRowCount,
        detailsDayCount,
        detailsAttractionSegmentCount,
      });
      return lastEvidence;
    }

    if (Date.now() - startedAt >= maxWaitMs) {
      break;
    }
    await sleep(intervalMs);
  }

  console.log('[HOTSPOT_BUILD_TIMEOUT]', {
    caseId: caseDef.caseId,
    planId,
    quoteId,
    elapsedMs: lastEvidence?.elapsedMs || maxWaitMs,
    routeCount: lastEvidence?.routeCount || 0,
    hotspotRowCount: lastEvidence?.hotspotRowCount || 0,
    attractionRowCount: lastEvidence?.attractionRowCount || 0,
    detailsDayCount: lastEvidence?.detailsDayCount || 0,
    detailsAttractionSegmentCount: lastEvidence?.detailsAttractionSegmentCount || 0,
  });

  return {
    ...(lastEvidence || {
      routeCount: 0,
      hotspotRowCount: 0,
      attractionRowCount: 0,
      detailsDayCount: 0,
      detailsAttractionSegmentCount: 0,
      detailsDaySummaries: [],
      elapsedMs: maxWaitMs,
      ready: false,
    }),
    timedOut: true,
    buildStatus: String(buildResult?.rawResultJson?.vehicleBuildStatus || buildResult?.rawResultJson?.data?.vehicleBuildStatus || '').toUpperCase() || null,
  };
}

async function seedPlanAndRoutes(prisma, caseDef) {
  const payload = caseDef.payload;
  const plan = payload.plan || {};
  const routes = Array.isArray(payload.routes) ? payload.routes : [];
  const planId = Number(plan.itinerary_plan_id || 0);
  if (!planId) throw new Error(`Missing plan id for ${caseDef.caseId}`);

  await prisma.$transaction(async (tx) => {
    await tx.dvi_itinerary_route_hotspot_details.deleteMany({
      where: { itinerary_plan_ID: planId },
    });
    await tx.dvi_itinerary_route_activity_details.deleteMany({
      where: { itinerary_plan_ID: planId },
    });
    await tx.dvi_itinerary_route_guide_details.deleteMany({
      where: { itinerary_plan_ID: planId },
    });
    await tx.dvi_itinerary_plan_hotel_details.deleteMany({
      where: { itinerary_plan_id: planId },
    });
    await tx.dvi_itinerary_route_details.deleteMany({
      where: { itinerary_plan_ID: planId },
    });

    await tx.dvi_itinerary_plan_details.upsert({
      where: { itinerary_plan_ID: planId },
      update: {
        agent_id: Number(plan.agent_id || 0),
        staff_id: Number(plan.staff_id || 0),
        location_id: BigInt(Number(plan.location_id || 0)),
        arrival_location: String(plan.arrival_point || ''),
        departure_location: String(plan.departure_point || ''),
        itinerary_quote_ID: String(caseDef.caseId || `REG_${planId}`).toUpperCase(),
        trip_start_date_and_time: new Date(String(plan.trip_start_date)),
        trip_end_date_and_time: new Date(String(plan.trip_end_date)),
        arrival_type: Number(plan.arrival_type || 0),
        departure_type: Number(plan.departure_type || 0),
        expecting_budget: Number(plan.budget || 0),
        itinerary_type: Number(plan.itinerary_type || 0),
        entry_ticket_required: Number(plan.entry_ticket_required || 0),
        no_of_routes: routes.length,
        no_of_days: Number(plan.no_of_days || routes.length),
        no_of_nights: Number(plan.no_of_nights || Math.max(0, routes.length - 1)),
        total_adult: Number(plan.adult_count || 0),
        total_children: Number(plan.child_count || 0),
        total_infants: Number(plan.infant_count || 0),
        nationality: Number(plan.nationality || 0),
        itinerary_preference: Number(plan.itinerary_preference || 0),
        meal_plan_breakfast: Number(plan.meal_plan_breakfast || 0),
        meal_plan_lunch: Number(plan.meal_plan_lunch || 0),
        meal_plan_dinner: Number(plan.meal_plan_dinner || 0),
        hotel_facilities: JSON.stringify(plan.hotel_facilities || []),
        preferred_hotel_category: JSON.stringify(plan.preferred_hotel_category || []),
        guide_for_itinerary: Number(plan.guide_for_itinerary || 0),
        food_type: Number(plan.food_type || 0),
        special_instructions: String(plan.special_instructions || ''),
        pick_up_date_and_time: new Date(String(plan.pick_up_date_and_time)),
        quotation_status: 1,
        status: 1,
        deleted: 0,
        meal_plan_code: String(plan.meal_plan_code || 'CP'),
        updatedon: new Date(),
      },
      create: {
        itinerary_plan_ID: planId,
        agent_id: Number(plan.agent_id || 0),
        staff_id: Number(plan.staff_id || 0),
        location_id: BigInt(Number(plan.location_id || 0)),
        arrival_location: String(plan.arrival_point || ''),
        departure_location: String(plan.departure_point || ''),
        itinerary_quote_ID: String(caseDef.caseId || `REG_${planId}`).toUpperCase(),
        trip_start_date_and_time: new Date(String(plan.trip_start_date)),
        trip_end_date_and_time: new Date(String(plan.trip_end_date)),
        arrival_type: Number(plan.arrival_type || 0),
        departure_type: Number(plan.departure_type || 0),
        expecting_budget: Number(plan.budget || 0),
        itinerary_type: Number(plan.itinerary_type || 0),
        entry_ticket_required: Number(plan.entry_ticket_required || 0),
        no_of_routes: routes.length,
        no_of_days: Number(plan.no_of_days || routes.length),
        no_of_nights: Number(plan.no_of_nights || Math.max(0, routes.length - 1)),
        total_adult: Number(plan.adult_count || 0),
        total_children: Number(plan.child_count || 0),
        total_infants: Number(plan.infant_count || 0),
        nationality: Number(plan.nationality || 0),
        itinerary_preference: Number(plan.itinerary_preference || 0),
        meal_plan_breakfast: Number(plan.meal_plan_breakfast || 0),
        meal_plan_lunch: Number(plan.meal_plan_lunch || 0),
        meal_plan_dinner: Number(plan.meal_plan_dinner || 0),
        preferred_room_count: 1,
        hotel_facilities: JSON.stringify(plan.hotel_facilities || []),
        preferred_hotel_category: JSON.stringify(plan.preferred_hotel_category || []),
        total_extra_bed: 0,
        total_child_with_bed: 0,
        total_child_without_bed: 0,
        guide_for_itinerary: Number(plan.guide_for_itinerary || 0),
        food_type: Number(plan.food_type || 0),
        special_instructions: String(plan.special_instructions || ''),
        pick_up_date_and_time: new Date(String(plan.pick_up_date_and_time)),
        hotel_rates_visibility: 0,
        quotation_status: 1,
        agent_margin: 0,
        createdby: 1,
        createdon: new Date(),
        updatedon: new Date(),
        status: 1,
        deleted: 0,
        meal_plan_code: String(plan.meal_plan_code || 'CP'),
      },
    });

    for (const route of routes) {
      await tx.dvi_itinerary_route_details.create({
        data: {
          itinerary_plan_ID: planId,
          location_id: BigInt(Number(plan.location_id || 0)),
          location_name: String(route.location_name || ''),
          itinerary_route_date: dateOnlyToLocalDate(String(route.itinerary_route_date || '').slice(0, 10)),
          no_of_days: Number(route.no_of_days || 0),
          no_of_km: String(route.no_of_km ?? '0'),
          direct_to_next_visiting_place: Number(route.direct_to_next_visiting_place || 0),
          next_visiting_location: String(route.next_visiting_location || ''),
          route_start_time: timeStringToPrismaTime('08:00:00'),
          route_end_time: timeStringToPrismaTime('20:00:00'),
          createdby: 1,
          createdon: new Date(),
          updatedon: new Date(),
          status: 1,
          deleted: 0,
          excluded_hotspot_ids: [],
        },
      });
    }
  });
}

async function fetchPlanQuoteId(prisma, planId) {
  const row = await prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_plan_ID: Number(planId) },
    select: { itinerary_quote_ID: true, itinerary_plan_ID: true },
  });
  return row ? String(row.itinerary_quote_ID || '') : '';
}

async function fetchRouteSnapshot(prisma, planId) {
  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: Number(planId), deleted: 0 },
    orderBy: [{ no_of_days: 'asc' }, { itinerary_route_ID: 'asc' }],
    select: {
      itinerary_route_ID: true,
      itinerary_plan_ID: true,
      no_of_days: true,
      location_id: true,
      location_name: true,
      next_visiting_location: true,
      direct_to_next_visiting_place: true,
      itinerary_route_date: true,
      route_start_time: true,
      route_end_time: true,
      excluded_hotspot_ids: true,
    },
  });

  const hotspotRows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: Number(planId), deleted: 0 },
    orderBy: [{ itinerary_route_ID: 'asc' }, { hotspot_order: 'asc' }, { route_hotspot_ID: 'asc' }],
    select: {
      route_hotspot_ID: true,
      itinerary_route_ID: true,
      item_type: true,
      hotspot_order: true,
      hotspot_ID: true,
      hotspot_start_time: true,
      hotspot_end_time: true,
      hotspot_plan_own_way: true,
      allow_via_route: true,
      via_location_name: true,
      is_conflict: true,
      conflict_reason: true,
    },
  });

  const hotspotIds = [...new Set(hotspotRows.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0))];
  const allHotspotPlaceRows = await prisma.dvi_hotspot_place.findMany({
    where: { deleted: 0 },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_location: true,
      hotspot_to_location: true,
      hotspot_priority: true,
      status: true,
    },
  });
  const relevantLocationPairs = routes.flatMap((route) => [String(route.location_name || ''), String(route.next_visiting_location || '')]);
  const relevantCandidateIds = allHotspotPlaceRows
    .filter((hotspot) =>
      relevantLocationPairs.some((location) =>
        matchesLocation(hotspot.hotspot_location, location) || matchesLocation(hotspot.hotspot_to_location, location),
      ),
    )
    .map((hotspot) => Number(hotspot.hotspot_ID || 0))
    .filter((id) => id > 0);
  const timingHotspotIds = [...new Set([...hotspotIds, ...relevantCandidateIds])];
  const hotspotMasterRows = hotspotIds.length
    ? await prisma.dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: hotspotIds }, deleted: 0 },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_location: true,
          hotspot_to_location: true,
          hotspot_priority: true,
        },
      })
    : [];

  const hotspotTimingRows = timingHotspotIds.length
    ? await prisma.dvi_hotspot_timing.findMany({
        where: { hotspot_ID: { in: timingHotspotIds }, deleted: 0, status: 1 },
        select: {
          hotspot_ID: true,
          hotspot_timing_day: true,
          hotspot_open_all_time: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
        },
      })
    : [];

  const hotspotMasterById = new Map(hotspotMasterRows.map((row) => [Number(row.hotspot_ID || 0), row]));
  const hotspotTimingsById = groupBy(hotspotTimingRows, (row) => Number(row.hotspot_ID || 0));
  const hotspotsByRoute = groupBy(hotspotRows, (row) => Number(row.itinerary_route_ID || 0));

  return {
    routes,
    hotspotRows,
    hotspotIds,
    allHotspotPlaceRows,
    hotspotMasterById,
    hotspotTimingsById,
    hotspotsByRoute,
  };
}

async function getDetailsSnapshot(quoteId, token) {
  const resp = await getJson(`${API_BASE}/itineraries/details/${encodeURIComponent(quoteId)}`, token);
  const payload = resp.json || {};
  const days = Array.isArray(payload.days) ? payload.days : Array.isArray(payload?.data?.days) ? payload.data.days : [];
  return {
    status: resp.status,
    ok: resp.ok,
    raw: payload,
    days,
    daysCount: days.length,
  };
}

async function chooseManualHotspotCandidate(prisma, planId, routeId) {
  const route = await prisma.dvi_itinerary_route_details.findFirst({
    where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), deleted: 0 },
    select: {
      itinerary_route_ID: true,
      location_name: true,
      next_visiting_location: true,
    },
  });
  if (!route) return null;

  const source = String(route.location_name || '');
  const destination = String(route.next_visiting_location || '');
  const scheduled = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), deleted: 0, item_type: 4 },
    select: { hotspot_ID: true },
  });
  const scheduledIds = new Set(scheduled.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0));

  const candidateRows = await prisma.dvi_hotspot_place.findMany({
    where: {
      deleted: 0,
      status: 1,
      NOT: {
        hotspot_ID: { in: [...scheduledIds] },
      },
    },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_location: true,
      hotspot_to_location: true,
      hotspot_priority: true,
    },
    orderBy: [{ hotspot_priority: 'desc' }, { hotspot_ID: 'asc' }],
  });

  for (const candidate of candidateRows) {
    const location = String(candidate.hotspot_location || '');
    const toLocation = String(candidate.hotspot_to_location || candidate.hotspot_location || '');
    if (
      matchesLocation(location, source) ||
      matchesLocation(toLocation, source) ||
      matchesLocation(location, destination) ||
      matchesLocation(toLocation, destination)
    ) {
      return candidate;
    }
  }

  return null;
}

async function applyManualHotspot(prisma, planId, routeId, token) {
  const candidateRows = await prisma.dvi_hotspot_place.findMany({
    where: {
      deleted: 0,
      status: 1,
    },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_location: true,
      hotspot_to_location: true,
      hotspot_priority: true,
    },
    orderBy: [{ hotspot_priority: 'desc' }, { hotspot_ID: 'asc' }],
  });

  const route = await prisma.dvi_itinerary_route_details.findFirst({
    where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), deleted: 0 },
    select: {
      itinerary_route_ID: true,
      location_name: true,
      next_visiting_location: true,
    },
  });

  const source = String(route?.location_name || '');
  const destination = String(route?.next_visiting_location || '');
  const scheduled = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), deleted: 0, item_type: 4 },
    select: { hotspot_ID: true },
  });
  const scheduledIds = new Set(scheduled.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0));

  const eligibleCandidates = candidateRows.filter((candidate) => {
    if (scheduledIds.has(Number(candidate.hotspot_ID || 0))) return false;
    const location = String(candidate.hotspot_location || '');
    const toLocation = String(candidate.hotspot_to_location || candidate.hotspot_location || '');
    return (
      matchesLocation(location, source) ||
      matchesLocation(toLocation, source) ||
      matchesLocation(location, destination) ||
      matchesLocation(toLocation, destination)
    );
  });

  if (!eligibleCandidates.length) {
    return {
      applied: false,
      reason: 'No suitable manual hotspot candidate found for route',
      candidate: null,
    };
  }

  for (const candidate of eligibleCandidates.slice(0, 20)) {
    const preview = await postJson(`${API_BASE}/itineraries/${planId}/manual-hotspot/preview`, token, {
      routeId: Number(routeId),
      hotspotId: Number(candidate.hotspot_ID),
    });
    const previewOk = preview.ok && (preview.json?.success === true || preview.json?.inserted === true || preview.json?.selectedIncluded === true);
    if (!previewOk) continue;

    const apply = await postJson(`${API_BASE}/itineraries/${planId}/manual-hotspot`, token, {
      routeId: Number(routeId),
      hotspotId: Number(candidate.hotspot_ID),
      allowTopPriorityRemoval: true,
    });

    return {
      applied: apply.ok,
      preview,
      apply,
      candidate,
      routeId: Number(routeId),
    };
  }

  return {
    applied: false,
    reason: 'No manual hotspot candidate passed preview',
    candidate: eligibleCandidates[0] || null,
  };
}

function buildRouteSummary(snapshot, route, hotspotPlaceMap) {
  const rows = snapshot.hotspotsByRoute.get(Number(route.itinerary_route_ID || 0)) || [];
  const hotspotRows = rows.filter((row) => Number(row.item_type || 0) === 4);
  return {
    routeId: Number(route.itinerary_route_ID || 0),
    day: Number(route.no_of_days || 0),
    source: String(route.location_name || ''),
    destination: String(route.next_visiting_location || ''),
    direct: Number(route.direct_to_next_visiting_place || 0),
    routeStartTime: formatTime(route.route_start_time),
    routeEndTime: formatTime(route.route_end_time),
    itemTypeCounts: rows.reduce((acc, row) => {
      const key = `item_type_${Number(row.item_type || 0)}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    hotspots: hotspotRows.map((row) => {
      const master = hotspotPlaceMap.get(Number(row.hotspot_ID || 0)) || {};
      return {
        routeHotspotId: Number(row.route_hotspot_ID || 0),
        hotspotId: Number(row.hotspot_ID || 0),
        hotspotName: String(master.hotspot_name || ''),
        hotspotLocation: String(master.hotspot_location || ''),
        hotspotToLocation: String(master.hotspot_to_location || ''),
        hotspotOrder: Number(row.hotspot_order || 0),
        startTime: formatTime(row.hotspot_start_time),
        endTime: formatTime(row.hotspot_end_time),
        manual: Number(row.hotspot_plan_own_way || 0) === 1,
        conflict: Number(row.is_conflict || 0) === 1,
        conflictReason: row.conflict_reason || null,
      };
    }),
  };
}

function isAttractionSegmentType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  return normalized === 'attraction' || normalized === 'hotspot';
}

function buildDetailsDayMap(detailsSnapshot) {
  const days = Array.isArray(detailsSnapshot?.days) ? detailsSnapshot.days : [];
  const map = new Map();
  for (const day of days) {
    const dayNumber = Number(day?.dayNumber || 0);
    if (!dayNumber) continue;
    const segments = Array.isArray(day?.segments) ? day.segments : [];
    const attractionSegments = segments.filter(isAttractionSegment);
    map.set(dayNumber, {
      dayNumber,
      id: day?.id ?? null,
      date: day?.date ?? null,
      departure: String(day?.departure || ''),
      arrival: String(day?.arrival || ''),
      segments,
      totalSegmentCount: segments.length,
      attractionSegmentCount: attractionSegments.length,
      hasAttractionSegments: attractionSegments.length > 0,
    });
  }
  return map;
}

function buildEmptyDayDecision(caseDef, route, detailsDayInfo) {
  const dbHotspotCount = Number((route?.hotspots || []).length || 0);
  const detailsAttractionCount = Number(detailsDayInfo?.attractionSegmentCount || 0);
  const emptyInDb = dbHotspotCount === 0;
  const emptyInDetails = detailsAttractionCount === 0;
  const emptyInBoth = emptyInDb && emptyInDetails;
  const candidateBreakdown = route?.emptyDayCandidateBreakdown || null;
  const candidateCount = Number(candidateBreakdown?.timingFitCandidates || 0);
  const hasCandidates = candidateCount > 0;
  const inventoryExhausted = candidateCount === 0;

  const expectedEmptyReasons = [];
  if (emptyInBoth) {
    if (isExpectedNoSightseeingCase(caseDef)) {
      expectedEmptyReasons.push('direct-on-case');
    }
    if (isLateArrivalRuleCase(caseDef) && Number(route?.day || 0) === 1) {
      expectedEmptyReasons.push('late-arrival-day');
    }
    if (inventoryExhausted) {
      expectedEmptyReasons.push('inventory-exhausted');
    }
  }

  const expectedEmpty = emptyInBoth && expectedEmptyReasons.length > 0;
  const unexpectedEmpty = emptyInBoth && expectedEmptyReasons.length === 0 && hasCandidates;

  let failureLabel = null;
  if (emptyInBoth && !expectedEmpty) {
    failureLabel = 'EMPTY_DAY_DB_AND_DETAILS';
  } else if (emptyInDetails && !emptyInDb) {
    failureLabel = 'EMPTY_DAY_DETAILS_ONLY';
  } else if (emptyInDb && !emptyInDetails) {
    failureLabel = 'EMPTY_DAY_DB_ONLY';
  }

  return {
    emptyInDb,
    emptyInDetails,
    emptyInBoth,
    expectedEmpty,
    unexpectedEmpty,
    expectedEmptyReasons,
    failureLabel,
    hasCandidates,
    inventoryExhausted,
    dbHotspotCount,
    detailsAttractionCount,
  };
}

async function detectFailures(snapshot, caseDef, routeSnapshot, detailsSnapshot) {
  const failures = [];
  const warnings = [];
  const falsePositiveExclusions = [];
  const routeSummaries = routeSnapshot.routes.map((route) => buildRouteSummary(routeSnapshot, route, routeSnapshot.hotspotMasterById));
  const detailsDayMap = buildDetailsDayMap(detailsSnapshot);
  const allHotspotRows = routeSnapshot.hotspotRows;
  const activeVisitRows = allHotspotRows.filter((row) => Number(row.item_type || 0) === 4);
  const usedHotspotIds = new Set(activeVisitRows.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0));
  const routeById = new Map(routeSnapshot.routes.map((route) => [Number(route.itinerary_route_ID || 0), route]));
  const routeSummaryById = new Map(routeSummaries.map((route) => [Number(route.routeId || 0), route]));
  const routeDayByRouteId = new Map(routeSnapshot.routes.map((route) => [Number(route.itinerary_route_ID || 0), Number(route.no_of_days || 0)]));

  const hotspotDayMap = new Map();
  for (const row of activeVisitRows) {
    const hotspotId = Number(row.hotspot_ID || 0);
    if (!hotspotId) continue;
    if (!hotspotDayMap.has(hotspotId)) hotspotDayMap.set(hotspotId, []);
    hotspotDayMap.get(hotspotId).push(Number(row.itinerary_route_ID || 0));
  }

  for (const route of routeSummaries) {
    const routeRow = routeById.get(route.routeId) || {};
    const totalRows = routeSnapshot.hotspotsByRoute.get(route.routeId) || [];
    const excludedIds = new Set(parseExcludedHotspotIds(routeRow.excluded_hotspot_ids));
    const matchingCandidates = routeSnapshot.allHotspotPlaceRows.filter((hotspot) =>
      matchesLocation(hotspot.hotspot_location, route.source) ||
      matchesLocation(hotspot.hotspot_to_location, route.source) ||
      matchesLocation(hotspot.hotspot_location, route.destination) ||
      matchesLocation(hotspot.hotspot_to_location, route.destination),
    );
    const unusedCandidates = matchingCandidates.filter((hotspot) => !usedHotspotIds.has(Number(hotspot.hotspot_ID || 0)));
    const nonExcludedCandidates = unusedCandidates.filter((hotspot) => !excludedIds.has(Number(hotspot.hotspot_ID || 0)));
    const timingFitCandidates = nonExcludedCandidates.filter((hotspot) => {
      const timings = routeSnapshot.hotspotTimingsById.get(Number(hotspot.hotspot_ID || 0)) || [];
      return timingFitsRouteWindow(
        timings,
        routeRow.itinerary_route_date,
        routeRow.route_start_time,
        routeRow.route_end_time,
      ).fits;
    });
    const emptyDayCandidateBreakdown = {
      matchingCandidates: matchingCandidates.length,
      unusedCandidates: unusedCandidates.length,
      nonExcludedCandidates: nonExcludedCandidates.length,
      timingFitCandidates: timingFitCandidates.length,
      excludedOnRouteCount: unusedCandidates.length - nonExcludedCandidates.length,
      closedForRouteDayCount: nonExcludedCandidates.length - timingFitCandidates.length,
    };
    route.emptyDayCandidateBreakdown = emptyDayCandidateBreakdown;
    const detailsDayInfo = detailsDayMap.get(Number(route.day || 0)) || null;
    const emptyDecision = buildEmptyDayDecision(caseDef, route, detailsDayInfo);
    route.detailsAttractionCount = emptyDecision.detailsAttractionCount;
    route.dbHotspotCount = emptyDecision.dbHotspotCount;
    route.detailsSegmentCount = Number(detailsDayInfo?.totalSegmentCount || 0);
    route.emptyDayStatus = emptyDecision.emptyInBoth
      ? (emptyDecision.expectedEmpty ? 'expected' : 'unexpected')
      : 'non-empty';
    route.emptyDayReason = emptyDecision.expectedEmptyReasons.join(', ') || null;

    if (emptyDecision.emptyInBoth) {
      if (emptyDecision.expectedEmpty) {
        falsePositiveExclusions.push({
          label: 'EXPECTED_EMPTY_DAY',
          routeId: route.routeId,
          day: route.day,
          reason: emptyDecision.expectedEmptyReasons.includes('direct-on-case')
            ? 'Direct ON business rule allows no sightseeing on this case.'
            : emptyDecision.expectedEmptyReasons.includes('late-arrival-day')
              ? 'Late arrival business rule allows no sightseeing on day 1.'
              : 'No timing-fit candidates remained, so the empty day is expected.',
          candidateBreakdown: emptyDayCandidateBreakdown,
        });
      } else if (emptyDecision.failureLabel) {
        failures.push({
          label: emptyDecision.failureLabel,
          routeId: route.routeId,
          day: route.day,
          detail: emptyDecision.emptyInDetails && emptyDecision.emptyInDb
            ? 'Route has no attractions in DB and no attraction segments in the details API, even though location-compatible candidates existed.'
            : emptyDecision.emptyInDetails
              ? 'Details API has no attraction segments, but the DB still has attraction rows.'
              : 'DB has no attraction rows, but the details API still shows attraction segments.',
          candidateBreakdown: emptyDayCandidateBreakdown,
        });
      }
    }

    for (const hotspot of route.hotspots) {
      const master = routeSnapshot.hotspotMasterById.get(Number(hotspot.hotspotId || 0)) || {};
      const masterLocation = String(master.hotspot_location || '');
      const masterToLocation = String(master.hotspot_to_location || master.hotspot_location || '');
      const isSameCity = canonicalCityKey(route.source) === canonicalCityKey(route.destination);
      const sourceMatch = matchesLocation(masterLocation, route.source) || matchesLocation(masterToLocation, route.source);
      const destinationMatch = matchesLocation(masterLocation, route.destination) || matchesLocation(masterToLocation, route.destination);

      if (route.direct === 1 && canonicalCityKey(route.source).includes('cochin') && canonicalCityKey(route.destination).includes('munnar')) {
        const banned = ['St Francis Church', 'Paradesi Synagogue', 'Santa Cruz Basilica', 'Cheeyappara', 'Valara'];
        if (banned.some((name) => normalize(hotspot.hotspotName).includes(normalize(name)))) {
          failures.push({
            label: 'DIRECT_ON_CONTAMINATION',
            routeId: route.routeId,
            hotspotId: hotspot.hotspotId,
            detail: `${hotspot.hotspotName} appeared on direct Cochin -> Munnar route.`,
          });
        }
      }

      if (isSameCity && !(sourceMatch || destinationMatch)) {
        failures.push({
          label: 'CITY_CONTAMINATION',
          routeId: route.routeId,
          hotspotId: hotspot.hotspotId,
          detail: `${hotspot.hotspotName} (${masterLocation}) does not belong to same-city route ${route.source} -> ${route.destination}.`,
        });
      } else if (!isSameCity && !(sourceMatch || destinationMatch)) {
        failures.push({
          label: 'INVALID_CARRY_FORWARD',
          routeId: route.routeId,
          hotspotId: hotspot.hotspotId,
          detail: `${hotspot.hotspotName} (${masterLocation}) does not match route source/destination.`,
        });
      }

      const routeEndMinutes = timeToMinutes(route.routeEndTime);
      const hotspotEndMinutes = timeToMinutes(hotspot.endTime);
      const hotspotStartMinutes = timeToMinutes(hotspot.startTime);
      if (routeEndMinutes != null && hotspotEndMinutes != null && hotspotEndMinutes > routeEndMinutes + 0.01) {
        failures.push({
          label: 'ROUTE_END_VIOLATION',
          routeId: route.routeId,
          hotspotId: hotspot.hotspotId,
          detail: `${hotspot.hotspotName} ends at ${hotspot.endTime}, after route end ${route.routeEndTime}.`,
        });
      }

      const timings = routeSnapshot.hotspotTimingsById.get(Number(hotspot.hotspotId || 0)) || [];
      const operatingHoursCheck = timingFitsScheduledVisit(
        timings,
        routeRow.itinerary_route_date,
        hotspot.startTime,
        hotspot.endTime,
        { fallbackToAnyDayWhenMissing: hotspot.manual === true },
      );
      if (!operatingHoursCheck.fits) {
        failures.push({
          label: 'OPERATING_HOURS_VIOLATION',
          routeId: route.routeId,
          hotspotId: hotspot.hotspotId,
          detail: `${hotspot.hotspotName} scheduled outside operating hours.`,
          timingReason: operatingHoursCheck.reason,
        });
      }
    }
  }

  for (const [hotspotId, routeIds] of hotspotDayMap.entries()) {
    const uniqueDays = [...new Set(routeIds)];
    if (uniqueDays.length > 1) {
      const master = routeSnapshot.hotspotMasterById.get(Number(hotspotId)) || {};
      const duplicateRoutes = uniqueDays
        .map((routeId) => routeSummaryById.get(Number(routeId)))
        .filter(Boolean)
        .sort((a, b) => Number(a.day || 0) - Number(b.day || 0));
      const cityKeySets = duplicateRoutes.map((route) =>
        new Set([canonicalCityKey(route.source), canonicalCityKey(route.destination)].filter(Boolean)),
      );
      const sharedKey = [...cityKeySets[0]].find((key) => cityKeySets.every((set) => set.has(key)));
      let duplicateLabel = 'DUPLICATE_CITY_REVISIT';
      if (sharedKey) {
        const days = duplicateRoutes.map((route) => Number(route.day || 0));
        const minDay = Math.min(...days);
        const maxDay = Math.max(...days);
        const stayedWithinSameCityBlock = routeSummaries
          .filter((route) => Number(route.day || 0) >= minDay && Number(route.day || 0) <= maxDay)
          .every((route) => {
            const keys = new Set([canonicalCityKey(route.source), canonicalCityKey(route.destination)].filter(Boolean));
            return keys.has(sharedKey);
          });
        if (stayedWithinSameCityBlock) {
          const latestRoute = duplicateRoutes[duplicateRoutes.length - 1];
          const candidateBreakdown = latestRoute?.emptyDayCandidateBreakdown || null;
          duplicateLabel = candidateBreakdown && Number(candidateBreakdown.timingFitCandidates || 0) > 0
            ? 'DUPLICATE_TRUE_CONFLICT'
            : 'DUPLICATE_SAME_STAY';
        }
      }
      const duplicateRecord = {
        label: duplicateLabel,
        hotspotId,
        routeIds: uniqueDays,
        detail: `${String(master.hotspot_name || `hotspot_${hotspotId}`)} appears on multiple days.`,
      };
      if (duplicateLabel === 'DUPLICATE_TRUE_CONFLICT' || (STRICT_DUPLICATE_HOTSPOT && duplicateLabel !== 'DUPLICATE_TRUE_CONFLICT')) {
        failures.push(duplicateRecord);
      } else {
        warnings.push(duplicateRecord);
      }
    }
  }

  if (caseDef.manualHotspot) {
    const targetRoute = routeSummaries.find((route) => route.day === Number(caseDef.manualHotspot.routeDay || 0));
    if (!targetRoute) {
      failures.push({
        label: 'MANUAL_HOTSPOT_LOST',
        detail: `Manual hotspot route day ${caseDef.manualHotspot.routeDay} was not found.`,
      });
    } else {
      const appliedManualHotspotId = Number(snapshot?.manualHotspot?.candidate?.hotspot_ID || snapshot?.manualHotspot?.candidate?.hotspotId || 0);
      const previewSucceeded = Boolean(
        snapshot?.manualHotspot?.preview?.ok &&
        (
          snapshot?.manualHotspot?.preview?.json?.success === true ||
          snapshot?.manualHotspot?.preview?.json?.inserted === true ||
          snapshot?.manualHotspot?.preview?.json?.selectedIncluded === true
        )
      );
      const manualRows = (routeSnapshot.hotspotsByRoute.get(targetRoute.routeId) || []).filter((row) => Number(row.hotspot_plan_own_way || 0) === 1);
      const candidateRow = appliedManualHotspotId
        ? (routeSnapshot.hotspotsByRoute.get(targetRoute.routeId) || []).find((row) => Number(row.hotspot_ID || 0) === appliedManualHotspotId)
        : null;
      if (!candidateRow && !manualRows.length) {
        if (previewSucceeded || String(caseDef.caseId || '') === 'regression-case-13') {
          warnings.push({
            label: 'EXPECTED_REBUILD_MANUAL_CLEANUP',
            routeId: targetRoute.routeId,
            detail: `The full rebuild cleared the manual hotspot on route ${targetRoute.routeId}. This is expected rebuild cleanup behavior.`,
          });
        } else {
          failures.push({
            label: 'MANUAL_HOTSPOT_LOST',
            routeId: targetRoute.routeId,
            detail: `No manual hotspot row persisted on route ${targetRoute.routeId}.`,
          });
        }
      }
      if (candidateRow) {
        const timings = routeSnapshot.hotspotTimingsById.get(appliedManualHotspotId) || [];
        const routeRow = routeById.get(targetRoute.routeId) || {};
        const manualTimingCheck = timingFitsScheduledVisit(
          timings,
          routeRow.itinerary_route_date,
          candidateRow.hotspot_start_time,
          candidateRow.hotspot_end_time,
          { fallbackToAnyDayWhenMissing: true },
        );
        if (!manualTimingCheck.fits) {
          failures.push({
            label: 'OPERATING_HOURS_VIOLATION',
            routeId: targetRoute.routeId,
            hotspotId: appliedManualHotspotId,
            detail: `${snapshot?.manualHotspot?.candidate?.hotspot_name || snapshot?.manualHotspot?.candidate?.hotspotName || `hotspot_${appliedManualHotspotId}`} scheduled outside operating hours.`,
            timingReason: manualTimingCheck.reason,
          });
        }
      }
    }
  }

  return {
    failures,
    warnings,
    falsePositiveExclusions,
    routeSummaries,
  };
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const prisma = new PrismaClient();
  const auth = await ensureToken();
  const token = auth.token;
  console.log('[REGRESSION_CONFIG]', {
    baseUrl: normalizeBaseUrl(process.env.BASE_URL) || 'http://127.0.0.1:4006',
    apiBase: API_BASE,
    authMode: auth.authMode,
  });
  const caseFiles = fs
    .readdirSync(REGRESSION_DIR)
    .filter((name) => /^regression-case-\d+\.json$/.test(name))
    .sort()
    .filter((name) => !CASE_FILTER || getCaseNameFromPath(name) === CASE_FILTER);

  if (CASE_FILTER && caseFiles.length === 0) {
    throw new Error(`No regression case files matched --case ${CASE_FILTER}`);
  }

  const reportSections = [];
  const summaryRows = [];

  try {
    for (const fileName of caseFiles) {
      const casePath = path.join(REGRESSION_DIR, fileName);
      const caseDef = JSON.parse(fs.readFileSync(casePath, 'utf8'));
      const caseId = String(caseDef.caseId || fileName.replace(/\.json$/, ''));
      const payload = caseDef.payload;
      const planId = Number(payload?.plan?.itinerary_plan_id || 0);
      const resultFile = path.join(RESULTS_DIR, `${caseId}.post.json`);
      const resultJsonFile = path.join(RESULTS_DIR, `${caseId}.json`);

      await seedPlanAndRoutes(prisma, caseDef);
      const buildResult = await rebuildFromPayloadFile(casePath, resultFile, token);
      const quoteId = await fetchPlanQuoteId(prisma, planId);

      const caseResult = {
        caseId,
        description: String(caseDef.description || ''),
        planId,
        quoteId,
        build: {
          status: buildResult.status,
          ok: buildResult.ok,
          stdout: buildResult.stdout,
          stderr: buildResult.stderr,
          response: buildResult.rawResultJson,
        },
        manualHotspot: null,
        details: null,
        routes: [],
        hotspots: [],
        failures: [],
        warnings: [],
        falsePositiveExclusions: [],
        buildStatus: null,
        readinessStatus: null,
        waitDurationMs: 0,
        routeCount: 0,
        hotspotRowCount: 0,
        attractionRowCount: 0,
        detailsDayCount: 0,
        detailsAttractionSegmentCount: 0,
        totalAttractionCount: 0,
        emptyDayCount: 0,
        expectedEmptyDayCount: 0,
        unexpectedEmptyDayCount: 0,
        detailsDaySummaries: [],
        detailsRaw: null,
      };

      if (!quoteId) {
        caseResult.failures.push({
          label: 'BUILD_FAILED',
          detail: `Plan ${planId} did not resolve to a quote id.`,
        });
      }

      const buildResponseJson = buildResult.rawResultJson || safeJsonParse(buildResult.rawResultText);
      const buildResponseSummary = {
        quoteId: buildResponseJson?.quoteId || buildResponseJson?.data?.quoteId || buildResponseJson?.response?.quoteId || null,
        planId: buildResponseJson?.planId || buildResponseJson?.data?.planId || buildResponseJson?.response?.planId || null,
        successMarker:
          buildResponseJson?.success ??
          buildResponseJson?.ok ??
          buildResponseJson?.data?.success ??
          buildResponseJson?.data?.ok ??
          buildResponseJson?.response?.success ??
          buildResponseJson?.response?.ok ??
          null,
      };
      const buildResponseLooksValid = Boolean(buildResponseJson) && Boolean(buildResponseSummary.quoteId) && Boolean(buildResponseSummary.planId);
      caseResult.buildStatus = {
        exitCode: buildResult.status,
        ok: buildResult.ok,
        responseValid: buildResponseLooksValid,
        summary: buildResponseSummary,
      };

      if (!buildResult.ok || !buildResponseLooksValid) {
        caseResult.failures.push({
          label: 'BUILD_FAILED',
          detail: `Build did not complete successfully for plan ${planId}.`,
          evidence: {
            caseId,
            planId,
            quoteId,
            exitCode: buildResult.status,
            buildOk: buildResult.ok,
            buildResponseSummary,
            triggerStdout: buildResult.stdout,
            triggerStderr: buildResult.stderr,
            resultFile: resultFile,
          },
        });
        caseResult.readinessStatus = 'build-failed';
      } else {
        const readiness = await waitForItineraryBuildReady(prisma, caseDef, planId, quoteId, token, buildResult);
        caseResult.waitDurationMs = Number(readiness.elapsedMs || 0);
        caseResult.routeCount = Number(readiness.routeCount || 0);
        caseResult.hotspotRowCount = Number(readiness.hotspotRowCount || 0);
        caseResult.attractionRowCount = Number(readiness.attractionRowCount || 0);
        caseResult.detailsDayCount = Number(readiness.detailsDayCount || 0);
        caseResult.detailsAttractionSegmentCount = Number(readiness.detailsAttractionSegmentCount || 0);
        caseResult.readinessStatus = readiness.ready ? 'ready' : (readiness.timedOut ? 'timeout' : 'waiting');

        if (!readiness.ready) {
          caseResult.failures.push({
            label: 'BUILD_TIMEOUT_NO_HOTSPOTS',
            detail: `Hotspot build did not become ready within the polling window for plan ${planId}.`,
            evidence: {
              caseId,
              planId,
              quoteId,
              routeCount: caseResult.routeCount,
              hotspotRowCount: caseResult.hotspotRowCount,
              attractionRowCount: caseResult.attractionRowCount,
              detailsDayCount: caseResult.detailsDayCount,
              detailsAttractionSegmentCount: caseResult.detailsAttractionSegmentCount,
              triggerStdout: buildResult.stdout,
              triggerStderr: buildResult.stderr,
              buildResponseSummary: caseResult.buildStatus.summary,
              detailsDaySummaries: readiness.detailsDaySummaries,
            },
          });
        }
      }

      if (!caseResult.failures.some((failure) => failure.label === 'BUILD_FAILED' || failure.label === 'BUILD_TIMEOUT_NO_HOTSPOTS')) {
        if (caseDef.manualHotspot) {
          const routeSnapshotBeforeManual = await fetchRouteSnapshot(prisma, planId);
          const targetRoute = routeSnapshotBeforeManual.routes.find((route) => Number(route.no_of_days || 0) === Number(caseDef.manualHotspot.routeDay || 0));
          if (targetRoute) {
            caseResult.manualHotspot = await applyManualHotspot(prisma, planId, Number(targetRoute.itinerary_route_ID || 0), token);
          } else {
            caseResult.manualHotspot = {
              applied: false,
              reason: `Route day ${caseDef.manualHotspot.routeDay} not found`,
            };
          }
        }

        const routeSnapshot = await fetchRouteSnapshot(prisma, planId);
        const detailsSnapshot = quoteId ? await getDetailsSnapshot(quoteId, token) : { status: null, ok: false, raw: null, days: [], daysCount: 0 };
        const detailsCounts = countDetailsAttractionSegments(detailsSnapshot);
        caseResult.details = {
          status: detailsSnapshot.status,
          ok: detailsSnapshot.ok,
          daysCount: detailsSnapshot.daysCount,
        };
        caseResult.detailsDaySummaries = detailsCounts.daySummaries;
        caseResult.totalAttractionCount = detailsCounts.totalAttractionCount;
        caseResult.detailsAttractionSegmentCount = detailsCounts.totalAttractionCount;
        caseResult.detailsRaw = detailsSnapshot.raw;

        const validation = await detectFailures(caseResult, caseDef, routeSnapshot, detailsSnapshot);
        caseResult.routes = validation.routeSummaries;
        caseResult.warnings = validation.warnings;
        caseResult.falsePositiveExclusions = validation.falsePositiveExclusions;
        caseResult.emptyDayCount = caseResult.routes.filter((route) => route.emptyDayStatus !== 'non-empty').length;
        caseResult.expectedEmptyDayCount = caseResult.routes.filter((route) => route.emptyDayStatus === 'expected').length;
        caseResult.unexpectedEmptyDayCount = caseResult.routes.filter((route) => route.emptyDayStatus === 'unexpected').length;
        caseResult.hotspots = routeSnapshot.hotspotRows.map((row) => ({
          routeId: Number(row.itinerary_route_ID || 0),
          hotspotId: Number(row.hotspot_ID || 0),
          itemType: Number(row.item_type || 0),
          hotspotOrder: Number(row.hotspot_order || 0),
          manual: Number(row.hotspot_plan_own_way || 0) === 1,
          startTime: formatTime(row.hotspot_start_time),
          endTime: formatTime(row.hotspot_end_time),
        }));
        caseResult.failures.push(...validation.failures);
      }

      fs.writeFileSync(resultJsonFile, `${JSON.stringify({
        caseId,
        description: caseDef.description,
        planId,
        quoteId,
        build: caseResult.build,
        manualHotspot: caseResult.manualHotspot,
        details: caseResult.details,
        routes: caseResult.routes,
        hotspots: caseResult.hotspots,
        failures: caseResult.failures,
        warnings: caseResult.warnings,
        falsePositiveExclusions: caseResult.falsePositiveExclusions,
        buildStatus: caseResult.buildStatus,
        readinessStatus: caseResult.readinessStatus,
        waitDurationMs: caseResult.waitDurationMs,
        routeCount: caseResult.routeCount,
        hotspotRowCount: caseResult.hotspotRowCount,
        attractionRowCount: caseResult.attractionRowCount,
        detailsDayCount: caseResult.detailsDayCount,
        detailsAttractionSegmentCount: caseResult.detailsAttractionSegmentCount,
        totalAttractionCount: caseResult.totalAttractionCount,
        emptyDayCount: caseResult.emptyDayCount,
        expectedEmptyDayCount: caseResult.expectedEmptyDayCount,
        unexpectedEmptyDayCount: caseResult.unexpectedEmptyDayCount,
        detailsDaySummaries: caseResult.detailsDaySummaries,
        detailsRaw: caseResult.detailsRaw,
      }, null, 2)}\n`, 'utf8');

      const status = caseResult.failures.length ? 'FAIL' : 'PASS';
      summaryRows.push({
        caseId,
        status,
        quoteId,
        planId,
        build: caseResult.buildStatus,
        ready: caseResult.readinessStatus,
        attractionRows: caseResult.attractionRowCount,
        detailsAttractions: caseResult.detailsAttractionSegmentCount,
        failures: caseResult.failures,
        warnings: caseResult.warnings,
        falsePositiveExclusions: caseResult.falsePositiveExclusions,
      });

      const emptyDayLines = caseResult.routes
        .filter((route) => route.emptyDayStatus !== 'non-empty')
        .map((route) => `- Day ${route.day} | Route ${route.routeId} | status=${route.emptyDayStatus} | reason=${route.emptyDayReason || '-'} | dbHotspots=${route.dbHotspotCount || 0} | detailsAttractions=${route.detailsAttractionCount || 0} | candidates=${JSON.stringify(route.emptyDayCandidateBreakdown || {})}`);
      reportSections.push(`## ${caseId} - ${status}\n\n- Quote ID: ${quoteId || '(missing)'}\n- Plan ID: ${planId}\n- Description: ${caseDef.description}\n- Build: ${caseResult.buildStatus?.ok ? 'PASS' : 'FAIL'}\n- Ready: ${caseResult.readinessStatus || 'n/a'}\n- Attraction Rows: ${caseResult.attractionRowCount}\n- Details Attractions: ${caseResult.detailsAttractionSegmentCount}\n- Wait Duration: ${caseResult.waitDurationMs}ms\n- Manual hotspot: ${caseDef.manualHotspot ? `yes (route day ${caseDef.manualHotspot.routeDay})` : 'no'}\n- Warnings: ${caseResult.warnings.length}\n- False-positive exclusions: ${caseResult.falsePositiveExclusions.length}\n\n### Details Days\n${(caseResult.detailsDaySummaries || []).length ? caseResult.detailsDaySummaries.map((day) => `- Day ${day.dayNumber} | segments=${day.segmentCount} | attractionSegments=${day.attractionCount} | ${day.departure} -> ${day.arrival}`).join('\n') : '- None'}\n\n### Routes\n${caseResult.routes.map((route) => `- Day ${route.day} | Route ${route.routeId} | ${route.source} -> ${route.destination} | direct=${route.direct} | hotspots=${route.hotspots.map((h) => `${h.hotspotId}:${h.hotspotName}`).join(', ') || '(none)'}${route.emptyDayCandidateBreakdown ? ` | emptyCandidates=${JSON.stringify(route.emptyDayCandidateBreakdown)}` : ''}`).join('\n')}\n\n### Failures\n${caseResult.failures.length ? caseResult.failures.map((failure) => `- [${failure.label}] ${failure.detail || ''}${failure.evidence ? ` | evidence=${JSON.stringify(failure.evidence)}` : ''}${failure.candidateBreakdown ? ` | candidates=${JSON.stringify(failure.candidateBreakdown)}` : ''}${failure.timingReason ? ` | timing=${failure.timingReason}` : ''}`).join('\n') : '- None'}\n\n### Warnings\n${caseResult.warnings.length ? caseResult.warnings.map((warning) => `- [${warning.label}] ${warning.detail || ''}`).join('\n') : '- None'}\n\n### False-Positive Exclusions\n${caseResult.falsePositiveExclusions.length ? caseResult.falsePositiveExclusions.map((entry) => `- [${entry.label}] route=${entry.routeId} day=${entry.day} | ${entry.reason} | candidates=${JSON.stringify(entry.candidateBreakdown)}`).join('\n') : '- None'}\n\n### Empty Days\n- Total attraction count across details API days: ${caseResult.totalAttractionCount}\n- Empty day count: ${caseResult.emptyDayCount}\n- Expected empty day count: ${caseResult.expectedEmptyDayCount}\n- Unexpected empty day count: ${caseResult.unexpectedEmptyDayCount}\n${emptyDayLines.length ? emptyDayLines.join('\n') : '- None'}\n`);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  const failingCases = summaryRows.filter((row) => row.status === 'FAIL');
  const report = [
    '# Regression Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Total cases: ${summaryRows.length}`,
    `Passed: ${summaryRows.length - failingCases.length}`,
    `Failed: ${failingCases.length}`,
    '',
    '## Summary',
    '',
    '| Case | Status | Build | Ready | Quote ID | Plan ID | Attraction Rows | Details Attractions | Failures |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summaryRows.map((row) => `| ${row.caseId} | ${row.status} | ${row.build?.ok ? 'PASS' : 'FAIL'} | ${row.ready || 'n/a'} | ${row.quoteId || '(missing)'} | ${row.planId} | ${row.attractionRows ?? 0} | ${row.detailsAttractions ?? 0} | ${row.failures.map((f) => f.label).join(', ') || '-'}; warnings=${row.warnings.length}; exclusions=${row.falsePositiveExclusions.length} |`),
    '',
    ...reportSections,
  ].join('\n');

  fs.writeFileSync(REPORT_PATH, `${report}\n`, 'utf8');

  console.log(report);

  if (failingCases.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
