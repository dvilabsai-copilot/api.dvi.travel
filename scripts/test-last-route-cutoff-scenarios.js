require('dotenv').config();

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const TOKEN = process.env.ITINERARY_BEARER_TOKEN || '';
const QUOTE_ID = process.env.QUOTE_ID || 'DVI202604230';
const START_HOUR = Number(process.env.START_HOUR || 13);
const END_HOUR = Number(process.env.END_HOUR || 21);
const RESTORE_PLAN_END_HOUR = process.env.RESTORE_PLAN_END_HOUR
  ? Number(process.env.RESTORE_PLAN_END_HOUR)
  : null;

function toHms(totalSeconds) {
  const normalized = ((totalSeconds % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDisplayTime(hms) {
  if (!hms) return null;
  const [hourText, minuteText] = String(hms).split(':');
  const hour = Number(hourText);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${String(hour12).padStart(2, '0')}:${minuteText} ${suffix}`;
}

function getDepartureBufferSeconds(departureType) {
  switch (Number(departureType || 0)) {
    case 1:
      return 2 * 3600;
    case 2:
      return 1 * 3600;
    default:
      return 0;
  }
}

function buildUtcDateWithHour(dateValue, hour) {
  const date = new Date(dateValue);
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hour,
    0,
    0,
    0,
  ));
}

function extractDays(payload) {
  if (Array.isArray(payload?.days)) return payload.days;
  if (Array.isArray(payload?.data?.days)) return payload.data.days;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function rebuildLastRoute(planId, routeId) {
  await fetchJson(`${API_BASE}/itineraries/${planId}/routes/${routeId}/rebuild-hotspots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
  });
}

async function run() {
  if (!TOKEN) {
    throw new Error('Set ITINERARY_BEARER_TOKEN before running this script.');
  }

  if (!Number.isInteger(START_HOUR) || !Number.isInteger(END_HOUR) || START_HOUR > END_HOUR) {
    throw new Error(`Invalid hour range: START_HOUR=${START_HOUR}, END_HOUR=${END_HOUR}`);
  }

  const plan = await prisma.dvi_itinerary_plan_details.findFirst({
    where: {
      itinerary_quote_ID: QUOTE_ID,
      deleted: 0,
      status: 1,
    },
    orderBy: { itinerary_plan_ID: 'desc' },
    select: {
      itinerary_plan_ID: true,
      itinerary_quote_ID: true,
      trip_end_date_and_time: true,
      departure_type: true,
    },
  });

  if (!plan) {
    throw new Error(`Plan not found for quote ${QUOTE_ID}`);
  }

  if (!(plan.trip_end_date_and_time instanceof Date)) {
    throw new Error(`Plan ${plan.itinerary_plan_ID} does not have trip_end_date_and_time set`);
  }

  const lastRoute = await prisma.dvi_itinerary_route_details.findFirst({
    where: {
      itinerary_plan_ID: Number(plan.itinerary_plan_ID),
      deleted: 0,
      status: 1,
    },
    orderBy: [
      { no_of_days: 'desc' },
      { itinerary_route_date: 'desc' },
      { itinerary_route_ID: 'desc' },
    ],
    select: {
      itinerary_route_ID: true,
      route_start_time: true,
      route_end_time: true,
      itinerary_route_date: true,
      location_name: true,
      next_visiting_location: true,
    },
  });

  if (!lastRoute) {
    throw new Error(`No active routes found for plan ${plan.itinerary_plan_ID}`);
  }

  const originalPlanEnd = new Date(plan.trip_end_date_and_time);
  const originalRouteStart = lastRoute.route_start_time ? new Date(lastRoute.route_start_time) : new Date(Date.UTC(1970, 0, 1, 8, 0, 0));
  const originalRouteEnd = lastRoute.route_end_time ? new Date(lastRoute.route_end_time) : new Date(Date.UTC(1970, 0, 1, 20, 0, 0));
  const departureBufferSeconds = getDepartureBufferSeconds(plan.departure_type);
  const results = [];
  const restorePlanEnd = Number.isInteger(RESTORE_PLAN_END_HOUR)
    ? buildUtcDateWithHour(originalPlanEnd, RESTORE_PLAN_END_HOUR)
    : originalPlanEnd;
  const restoreRouteEnd = Number.isInteger(RESTORE_PLAN_END_HOUR)
    ? new Date(Date.UTC(1970, 0, 1, RESTORE_PLAN_END_HOUR - departureBufferSeconds / 3600, 0, 0))
    : originalRouteEnd;

  console.log(`Quote      : ${QUOTE_ID}`);
  console.log(`Plan ID    : ${plan.itinerary_plan_ID}`);
  console.log(`Route ID   : ${lastRoute.itinerary_route_ID}`);
  console.log(`Buffer     : ${departureBufferSeconds / 3600} hour(s)`);
  console.log(`Route      : ${lastRoute.location_name} -> ${lastRoute.next_visiting_location}`);
  console.log('');

  try {
    for (let hour = START_HOUR; hour <= END_HOUR; hour += 1) {
      const scenarioPlanEnd = buildUtcDateWithHour(originalPlanEnd, hour);
      const cutoffSeconds = hour * 3600 - departureBufferSeconds;
      const cutoffHms = toHms(cutoffSeconds);

      await prisma.dvi_itinerary_plan_details.update({
        where: { itinerary_plan_ID: Number(plan.itinerary_plan_ID) },
        data: { trip_end_date_and_time: scenarioPlanEnd },
      });

      await prisma.dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: Number(lastRoute.itinerary_route_ID) },
        data: {
          route_start_time: originalRouteStart,
          route_end_time: new Date(Date.UTC(1970, 0, 1, hour - departureBufferSeconds / 3600, 0, 0)),
        },
      });

      await rebuildLastRoute(Number(plan.itinerary_plan_ID), Number(lastRoute.itinerary_route_ID));

      const details = await fetchJson(`${API_BASE}/itineraries/details/${QUOTE_ID}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
        },
      });
      const days = extractDays(details);
      const apiLastDay = days[days.length - 1] || null;

      const refreshedRoute = await prisma.dvi_itinerary_route_details.findUnique({
        where: { itinerary_route_ID: Number(lastRoute.itinerary_route_ID) },
        select: { route_end_time: true },
      });

      const returnRow = await prisma.dvi_itinerary_route_hotspot_details.findFirst({
        where: {
          itinerary_route_ID: Number(lastRoute.itinerary_route_ID),
          item_type: 7,
          deleted: 0,
          status: 1,
        },
        orderBy: { hotspot_order: 'desc' },
        select: {
          hotspot_start_time: true,
          hotspot_end_time: true,
        },
      });

      const lastAttraction = await prisma.dvi_itinerary_route_hotspot_details.findFirst({
        where: {
          itinerary_route_ID: Number(lastRoute.itinerary_route_ID),
          item_type: 4,
          deleted: 0,
          status: 1,
        },
        orderBy: { hotspot_end_time: 'desc' },
        select: {
          hotspot_end_time: true,
        },
      });

      const apiEndTime = apiLastDay?.endTime || null;
      const dbRouteEnd = refreshedRoute?.route_end_time
        ? toHms(
            refreshedRoute.route_end_time.getUTCHours() * 3600 +
              refreshedRoute.route_end_time.getUTCMinutes() * 60 +
              refreshedRoute.route_end_time.getUTCSeconds(),
          )
        : null;

      results.push({
        planEnd: toHms(hour * 3600),
        expectedCutoff: cutoffHms,
        apiDayEnd: apiEndTime,
        apiExpected: formatDisplayTime(cutoffHms),
        dbRouteEnd,
        lastAttractionEnd: lastAttraction?.hotspot_end_time
          ? toHms(
              lastAttraction.hotspot_end_time.getUTCHours() * 3600 +
                lastAttraction.hotspot_end_time.getUTCMinutes() * 60 +
                lastAttraction.hotspot_end_time.getUTCSeconds(),
            )
          : null,
        returnStart: returnRow?.hotspot_start_time
          ? toHms(
              returnRow.hotspot_start_time.getUTCHours() * 3600 +
                returnRow.hotspot_start_time.getUTCMinutes() * 60 +
                returnRow.hotspot_start_time.getUTCSeconds(),
            )
          : null,
        returnEnd: returnRow?.hotspot_end_time
          ? toHms(
              returnRow.hotspot_end_time.getUTCHours() * 3600 +
                returnRow.hotspot_end_time.getUTCMinutes() * 60 +
                returnRow.hotspot_end_time.getUTCSeconds(),
            )
          : null,
        matchesApiCutoff: apiEndTime === formatDisplayTime(cutoffHms),
      });
    }
  } finally {
    await prisma.dvi_itinerary_plan_details.update({
      where: { itinerary_plan_ID: Number(plan.itinerary_plan_ID) },
      data: { trip_end_date_and_time: restorePlanEnd },
    });

    await prisma.dvi_itinerary_route_details.update({
      where: { itinerary_route_ID: Number(lastRoute.itinerary_route_ID) },
      data: {
        route_start_time: originalRouteStart,
        route_end_time: restoreRouteEnd,
      },
    });

    await rebuildLastRoute(Number(plan.itinerary_plan_ID), Number(lastRoute.itinerary_route_ID));
  }

  console.table(results);

  const failed = results.filter((row) => !row.matchesApiCutoff);
  if (failed.length > 0) {
    console.error('\nCutoff mismatches detected:');
    console.table(failed);
    process.exitCode = 1;
    return;
  }

  console.log('\nAll scenarios matched the expected cutoff.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });