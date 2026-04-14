const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const QUOTE_ID = 'DVI202604230';
const TARGET_HOTSPOT_ID = 13;
const TARGET_ROUTE_HOTSPOT_ID = 40060;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimeFromDateLike(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  let hh = d.getUTCHours();
  const mm = pad2(d.getUTCMinutes());
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${pad2(hh)}:${mm} ${ampm}`;
}

function toTimeHHMMSS(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function toMinutes(timeText) {
  if (!timeText) return null;
  const m = String(timeText).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hh !== 12) hh += 12;
  if (ampm === 'AM' && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function toAbsoluteWindow(startText, endText) {
  const start = toMinutes(startText);
  const endRaw = toMinutes(endText);
  if (start === null || endRaw === null) {
    return { start: null, end: null, wraps: null };
  }
  let end = endRaw;
  let wraps = false;
  if (end < start) {
    end += 24 * 60;
    wraps = true;
  }
  return { start, end, wraps };
}

function weekdayMonZero(dateObj) {
  const js = dateObj.getDay();
  return (js + 6) % 7;
}

function timingsForDayLabel(rows) {
  if (!rows.length) return 'N/A';
  return rows
    .map((r) => {
      if (Number(r.hotspot_open_all_time) === 1) return 'Open 24 Hours';
      if (Number(r.hotspot_closed) === 1) return 'Closed';
      return `${formatTimeFromDateLike(r.hotspot_start_time)} - ${formatTimeFromDateLike(r.hotspot_end_time)}`;
    })
    .join(', ');
}

async function fetchApiHotspotObject(quoteId, routeHotspotId, hotspotId) {
  const candidates = [
    process.env.ITINERARY_API_BASE,
    'http://localhost:4006/api/v1',
    'http://127.0.0.1:4006/api/v1',
    'http://localhost:3000/api/v1',
    'http://127.0.0.1:3000/api/v1',
    'https://api.dvi.travel/api/v1',
  ].filter(Boolean);

  for (const base of candidates) {
    const url = `${base.replace(/\/$/, '')}/itineraries/details/${encodeURIComponent(quoteId)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const body = await res.json();
      const days = Array.isArray(body?.days) ? body.days : [];
      for (const day of days) {
        const segments = Array.isArray(day?.segments) ? day.segments : [];
        const found = segments.find((s) => Number(s?.routeHotspotId) === routeHotspotId || (Number(s?.hotspotId) === hotspotId && s?.type === 'attraction'));
        if (found) {
          return { base, url, hotspot: found };
        }
      }
      return { base, url, hotspot: null, note: 'API reachable but hotspot not found in response' };
    } catch (_err) {
      // try next base
    }
  }

  return { base: null, url: null, hotspot: null, note: 'No reachable itinerary details API base' };
}

async function main() {
  try {
    const plan = await prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: QUOTE_ID, deleted: 0 },
      select: {
        itinerary_plan_ID: true,
        itinerary_quote_ID: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
      },
    });

    if (!plan) {
      console.log('[VisitTime][PROOF] Plan not found', { quoteId: QUOTE_ID });
      return;
    }

    const routeHotspot = await prisma.dvi_itinerary_route_hotspot_details.findUnique({
      where: { route_hotspot_ID: TARGET_ROUTE_HOTSPOT_ID },
    });

    if (!routeHotspot) {
      console.log('[VisitTime][PROOF] Route hotspot row not found', { routeHotspotId: TARGET_ROUTE_HOTSPOT_ID });
      return;
    }

    const route = await prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: routeHotspot.itinerary_route_ID },
    });

    const hotspot = await prisma.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: TARGET_HOTSPOT_ID },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_duration: true,
        hotspot_priority: true,
      },
    });

    const allTimings = await prisma.dvi_hotspot_timing.findMany({
      where: { hotspot_ID: TARGET_HOTSPOT_ID, deleted: 0, status: 1 },
      orderBy: [{ hotspot_timing_day: 'asc' }, { hotspot_start_time: 'asc' }],
    });

    const dayOfWeek = route?.itinerary_route_date ? weekdayMonZero(route.itinerary_route_date) : null;
    const dayTimings = dayOfWeek === null ? [] : allTimings.filter((t) => Number(t.hotspot_timing_day) === dayOfWeek);
    const openDayTimings = dayTimings.filter((t) => Number(t.hotspot_closed) !== 1);

    const dbVisitStart = formatTimeFromDateLike(routeHotspot.hotspot_start_time);
    const dbVisitEnd = formatTimeFromDateLike(routeHotspot.hotspot_end_time);
    const dbVisitTimeDisplay = `${dbVisitStart} - ${dbVisitEnd}`;

    const routeDayStart = formatTimeFromDateLike(route?.route_start_time);
    const routeDayEnd = formatTimeFromDateLike(route?.route_end_time);

    const visitStartMins = toMinutes(dbVisitStart);
    const visitEndMins = toMinutes(dbVisitEnd);
    const routeEndMins = toMinutes(routeDayEnd);
    const routeStartMins = toMinutes(routeDayStart);

    const visitWindow = toAbsoluteWindow(dbVisitStart, dbVisitEnd);
    const routeWindow = toAbsoluteWindow(routeDayStart, routeDayEnd);

    const visitStartsAfterRouteEnd =
      routeWindow.end !== null && visitWindow.start !== null
        ? visitWindow.start > routeWindow.end
        : null;

    const visitEndsAfterRouteDayEnd =
      routeWindow.end !== null && visitWindow.end !== null
        ? visitWindow.end > routeWindow.end
        : null;

    let isWithinAnyOpenWindow = null;
    if (openDayTimings.length > 0 && visitStartMins !== null && visitEndMins !== null) {
      isWithinAnyOpenWindow = openDayTimings.some((t) => {
        const tw = toAbsoluteWindow(
          formatTimeFromDateLike(t.hotspot_start_time),
          formatTimeFromDateLike(t.hotspot_end_time),
        );
        if (tw.start === null || tw.end === null || visitWindow.start === null || visitWindow.end === null) {
          return false;
        }
        return visitWindow.start >= tw.start && visitWindow.end <= tw.end;
      });
    }

    const apiData = await fetchApiHotspotObject(QUOTE_ID, TARGET_ROUTE_HOTSPOT_ID, TARGET_HOTSPOT_ID);

    console.log('[VisitTime][PROOF] Investigation Inputs', {
      quoteId: QUOTE_ID,
      planId: plan.itinerary_plan_ID,
      hotspotId: TARGET_HOTSPOT_ID,
      routeHotspotId: TARGET_ROUTE_HOTSPOT_ID,
    });

    console.log('[VisitTime][PROOF] Raw Route Hotspot DB Row', {
      table: 'dvi_itinerary_route_hotspot_details',
      primaryKey: routeHotspot.route_hotspot_ID,
      itinerary_plan_ID: routeHotspot.itinerary_plan_ID,
      itinerary_route_ID: routeHotspot.itinerary_route_ID,
      item_type: routeHotspot.item_type,
      hotspot_ID: routeHotspot.hotspot_ID,
      hotspot_order: routeHotspot.hotspot_order,
      hotspot_start_time: routeHotspot.hotspot_start_time,
      hotspot_end_time: routeHotspot.hotspot_end_time,
      hotspot_plan_own_way: routeHotspot.hotspot_plan_own_way,
      is_conflict: routeHotspot.is_conflict,
      conflict_reason: routeHotspot.conflict_reason,
      deleted: routeHotspot.deleted,
      status: routeHotspot.status,
    });

    console.log('[TimingValidation][PROOF] Route Day Window', {
      table: 'dvi_itinerary_route_details',
      itinerary_route_ID: route?.itinerary_route_ID,
      itinerary_plan_ID: route?.itinerary_plan_ID,
      itinerary_route_date: route?.itinerary_route_date,
      route_start_time: route?.route_start_time,
      route_end_time: route?.route_end_time,
      routeStartDisplay: routeDayStart,
      routeEndDisplay: routeDayEnd,
    });

    console.log('[TimingValidation][PROOF] Hotspot Timing Master', {
      table: 'dvi_hotspot_timing',
      hotspotId: TARGET_HOTSPOT_ID,
      routeDayMonZero: dayOfWeek,
      allRowsCount: allTimings.length,
      dayRowsCount: dayTimings.length,
      openDayRowsCount: openDayTimings.length,
      dayRows: dayTimings.map((t) => ({
        hotspot_timing_ID: t.hotspot_timing_ID,
        hotspot_timing_day: t.hotspot_timing_day,
        hotspot_start_time: t.hotspot_start_time,
        hotspot_end_time: t.hotspot_end_time,
        hotspot_closed: t.hotspot_closed,
        hotspot_open_all_time: t.hotspot_open_all_time,
      })),
      displayTimingsForRouteDay: timingsForDayLabel(dayTimings),
    });

    console.log('[VisitTime][PROOF] DB vs API Visit Time', {
      dbVisitTimeDisplay,
      dbVisitStart,
      dbVisitEnd,
      apiVisitTime: apiData.hotspot?.visitTime ?? null,
      apiTimings: apiData.hotspot?.timings ?? null,
      apiIsConflict: apiData.hotspot?.isConflict ?? null,
      apiRouteHotspotId: apiData.hotspot?.routeHotspotId ?? null,
      apiHotspotId: apiData.hotspot?.hotspotId ?? null,
      apiSourceBase: apiData.base,
      apiSourceUrl: apiData.url,
      apiNote: apiData.note || null,
    });

    console.log('[TimingValidation][PROOF] Comparison', {
      routeDayStartDisplay: routeDayStart,
      routeDayEndDisplay: routeDayEnd,
      routeWindow,
      visitWindow,
      visitStartsAfterRouteEnd,
      visitEndsAfterRouteDayEnd,
      visitInsideAnyHotspotOpenWindow: isWithinAnyOpenWindow,
      dbVisitTimeDisplay,
    });

    const origin = apiData.hotspot && apiData.hotspot.visitTime === dbVisitTimeDisplay
      ? 'DB stores the same value that API returned (read-through from hotspot_start_time/hotspot_end_time).'
      : 'API value differs from raw DB display or API not reachable; inspect transformation layer logs.';

    console.log('[VisitTime][PROOF] Origin Verdict', { origin });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[VisitTime][PROOF] Script failed', err);
  process.exit(1);
});
