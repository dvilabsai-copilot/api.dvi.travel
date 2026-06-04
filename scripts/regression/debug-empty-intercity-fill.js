#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CASE_ID = String(process.env.CASE_ID || process.argv[2] || '').trim();
const ROUTE_ID = Number(process.env.ROUTE_ID || process.argv[3] || 0);
const ROOT = path.join(__dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'tmp', 'regression-results');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseDbUrl(url) {
  const match = String(url || '').match(/mysql:\/\/([^:]+):([^@]+)@([^:@/]+):(\d+)\/([^?]+)/);
  if (!match) throw new Error('DATABASE_URL not set or invalid');
  return {
    host: match[3],
    port: Number(match[4]),
    user: decodeURIComponent(match[1]),
    password: decodeURIComponent(match[2]),
    database: match[5],
  };
}

function normalize(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/[^a-z0-9|]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function canonicalCityKey(value) {
  return normalize(value).split(' ').filter(Boolean).join(' ');
}

function matchesLocation(hotspotLocation, routeLocation) {
  const hotspotKey = canonicalCityKey(hotspotLocation);
  const routeKey = canonicalCityKey(routeLocation);
  if (!hotspotKey || !routeKey) return false;
  return hotspotKey.includes(routeKey) || routeKey.includes(hotspotKey);
}

function toHms(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
  }
  const text = String(value).trim();
  const match = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
  return match ? match[1] : text;
}

function hmsToMinutes(value) {
  const hms = toHms(value);
  if (!hms) return null;
  const match = hms.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3] || 0) / 60;
}

function jsDateToHotspotTimingDay(dateValue) {
  const date = new Date(dateValue);
  return (date.getUTCDay() + 6) % 7;
}

function normalizeTimingWindow(openMinutes, closeMinutes) {
  if (openMinutes == null || closeMinutes == null) return null;
  let normalizedClose = closeMinutes;
  if (normalizedClose <= openMinutes) normalizedClose += 24 * 60;
  return { open: openMinutes, close: normalizedClose };
}

function normalizeVisitWindow(startMinutes, endMinutes) {
  if (startMinutes == null || endMinutes == null) return null;
  let normalizedEnd = endMinutes;
  if (normalizedEnd <= startMinutes) normalizedEnd += 24 * 60;
  return { start: startMinutes, end: normalizedEnd };
}

function routeWindowCanIntersect(timings, routeDate, routeStart, routeEnd) {
  if (!timings.length) return true;
  const day = jsDateToHotspotTimingDay(routeDate);
  const dayRows = timings.filter((row) => Number(row.hotspot_timing_day) === day && Number(row.status || 0) === 1 && Number(row.deleted || 0) === 0);
  if (!dayRows.length) return true;
  if (dayRows.some((row) => Number(row.hotspot_open_all_time || 0) === 1)) return true;
  const routeWindow = normalizeVisitWindow(hmsToMinutes(routeStart), hmsToMinutes(routeEnd));
  if (!routeWindow) return false;
  return dayRows.some((row) => {
    const normalized = normalizeTimingWindow(hmsToMinutes(row.hotspot_start_time), hmsToMinutes(row.hotspot_end_time));
    if (!normalized) return false;
    return routeWindow.start < normalized.close && routeWindow.end > normalized.open;
  });
}

function parseExcludedHotspotIds(value) {
  if (Array.isArray(value)) return value.map((id) => Number(id)).filter((id) => id > 0);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((id) => Number(id)).filter((id) => id > 0);
    } catch {
      return [];
    }
  }
  return [];
}

function classifyBucket(hotspot, route) {
  const source = String(route.location_name || '');
  const destination = String(route.next_visiting_location || '');
  const location = String(hotspot.hotspot_location || '');
  const toLocation = String(hotspot.hotspot_to_location || hotspot.hotspot_location || '');
  const sourceMatch = matchesLocation(location, source) || matchesLocation(toLocation, source);
  const destinationMatch = matchesLocation(location, destination) || matchesLocation(toLocation, destination);
  const masterFromKey = canonicalCityKey(location);
  const masterToKey = canonicalCityKey(toLocation);

  if (sourceMatch && destinationMatch && masterFromKey && masterToKey && masterFromKey !== masterToKey) {
    return 'en_route';
  }
  if (sourceMatch) return 'source';
  if (destinationMatch) return 'destination';
  return 'other';
}

function printSection(title) {
  console.log(`\n${'='.repeat(88)}`);
  console.log(title);
  console.log('='.repeat(88));
}

async function main() {
  if (!CASE_ID || !ROUTE_ID) {
    fail('Usage: CASE_ID=regression-case-01 ROUTE_ID=4825 node scripts/regression/debug-empty-intercity-fill.js');
  }

  const resultPath = path.join(RESULTS_DIR, `${CASE_ID}.json`);
  if (!fs.existsSync(resultPath)) fail(`Missing result file: ${resultPath}`);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const planId = Number(result.planId || 0);
  if (!planId) fail(`Missing planId in ${resultPath}`);

  const conn = await mysql.createConnection({
    ...parseDbUrl(process.env.DATABASE_URL),
    dateStrings: false,
  });

  try {
    const [[route]] = await conn.query(
      `SELECT itinerary_route_ID, itinerary_plan_ID, itinerary_route_date, no_of_days, location_name, next_visiting_location,
              direct_to_next_visiting_place, route_start_time, route_end_time, excluded_hotspot_ids
       FROM dvi_itinerary_route_details
       WHERE itinerary_plan_ID = ? AND itinerary_route_ID = ? AND deleted = 0`,
      [planId, ROUTE_ID],
    );

    if (!route) fail(`Route ${ROUTE_ID} not found for plan ${planId}`);

    const [routeRows] = await conn.query(
      `SELECT rh.route_hotspot_ID, rh.item_type, rh.hotspot_ID, rh.hotspot_order, rh.hotspot_start_time, rh.hotspot_end_time,
              hp.hotspot_name, hp.hotspot_location, hp.hotspot_to_location
       FROM dvi_itinerary_route_hotspot_details rh
       LEFT JOIN dvi_hotspot_place hp ON hp.hotspot_ID = rh.hotspot_ID
       WHERE rh.itinerary_plan_ID = ? AND rh.itinerary_route_ID = ? AND rh.deleted = 0
       ORDER BY rh.hotspot_order ASC, rh.route_hotspot_ID ASC`,
      [planId, ROUTE_ID],
    );

    const [storedLocRows] = await conn.query(
      `SELECT location_ID, source_location, destination_location, source_location_lattitude, source_location_longitude,
              destination_location_lattitude, destination_location_longitude
       FROM dvi_stored_locations
       WHERE deleted = 0 AND status = 1
         AND (
           location_ID = ?
           OR source_location = ?
           OR destination_location = ?
         )
       ORDER BY location_ID ASC
       LIMIT 10`,
      [route.location_id || 0, route.location_name || '', route.next_visiting_location || ''],
    );

    const [allRouteVisits] = await conn.query(
      `SELECT hotspot_ID
       FROM dvi_itinerary_route_hotspot_details
       WHERE itinerary_plan_ID = ? AND item_type = 4 AND deleted = 0`,
      [planId],
    );

    const usedHotspotIds = new Set(allRouteVisits.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0));
    const excludedIds = new Set(parseExcludedHotspotIds(route.excluded_hotspot_ids));

    const [allCandidates] = await conn.query(
      `SELECT hotspot_ID, hotspot_name, hotspot_location, hotspot_to_location, hotspot_priority, status, deleted
       FROM dvi_hotspot_place
       WHERE status = 1 AND deleted = 0`,
    );

    const [timingRows] = await conn.query(
      `SELECT hotspot_ID, hotspot_timing_day, hotspot_open_all_time, hotspot_start_time, hotspot_end_time, status, deleted
       FROM dvi_hotspot_timing
       WHERE hotspot_ID IN (${allCandidates.map(() => '?').join(',')})`,
      allCandidates.map((row) => Number(row.hotspot_ID || 0)),
    );

    const timingsByHotspot = new Map();
    for (const row of timingRows) {
      const hotspotId = Number(row.hotspot_ID || 0);
      if (!timingsByHotspot.has(hotspotId)) timingsByHotspot.set(hotspotId, []);
      timingsByHotspot.get(hotspotId).push(row);
    }

    const matching = allCandidates.filter((hotspot) => {
      const location = String(hotspot.hotspot_location || '');
      const toLocation = String(hotspot.hotspot_to_location || hotspot.hotspot_location || '');
      return (
        matchesLocation(location, route.location_name) ||
        matchesLocation(toLocation, route.location_name) ||
        matchesLocation(location, route.next_visiting_location) ||
        matchesLocation(toLocation, route.next_visiting_location)
      );
    });

    const used = matching.filter((hotspot) => usedHotspotIds.has(Number(hotspot.hotspot_ID || 0)));
    const unused = matching.filter((hotspot) => !usedHotspotIds.has(Number(hotspot.hotspot_ID || 0)));
    const excluded = unused.filter((hotspot) => excludedIds.has(Number(hotspot.hotspot_ID || 0)));
    const nonExcluded = unused.filter((hotspot) => !excludedIds.has(Number(hotspot.hotspot_ID || 0)));
    const timingFit = nonExcluded.filter((hotspot) =>
      routeWindowCanIntersect(
        timingsByHotspot.get(Number(hotspot.hotspot_ID || 0)) || [],
        route.itinerary_route_date,
        route.route_start_time,
        route.route_end_time,
      ),
    );

    printSection(`EMPTY INTERCITY DEBUG :: ${CASE_ID} :: ROUTE ${ROUTE_ID}`);
    console.log(`Plan ID : ${planId}`);
    console.log(`Quote ID: ${String(result.quoteId || '')}`);
    console.log(`Day     : ${Number(route.no_of_days || 0)}`);
    console.log(`Route   : ${String(route.location_name || '')} -> ${String(route.next_visiting_location || '')}`);
    console.log(`Direct  : ${Number(route.direct_to_next_visiting_place || 0)}`);
    console.log(`LocationId: ${Number(route.location_id || 0)}`);
    console.log(`Window  : ${toHms(route.route_start_time)} - ${toHms(route.route_end_time)}`);
    printSection('ACTIVE ROUTE ROWS');
    console.table(routeRows.map((row) => ({
      order: Number(row.hotspot_order || 0),
      itemType: Number(row.item_type || 0),
      hotspotId: Number(row.hotspot_ID || 0),
      hotspotName: String(row.hotspot_name || ''),
      start: toHms(row.hotspot_start_time),
      end: toHms(row.hotspot_end_time),
    })));

    printSection('STORED LOCATION LOOKUP');
    console.table(storedLocRows.map((row) => ({
      locationId: Number(row.location_ID || 0),
      source: String(row.source_location || ''),
      destination: String(row.destination_location || ''),
      sourceLat: row.source_location_lattitude == null ? null : Number(row.source_location_lattitude),
      sourceLon: row.source_location_longitude == null ? null : Number(row.source_location_longitude),
      destLat: row.destination_location_lattitude == null ? null : Number(row.destination_location_lattitude),
      destLon: row.destination_location_longitude == null ? null : Number(row.destination_location_longitude),
    })));

    printSection('CANDIDATE COUNTS');
    console.table([{
      matchingCandidates: matching.length,
      usedCandidates: used.length,
      unusedCandidates: unused.length,
      excludedCandidates: excluded.length,
      timingFitCandidates: timingFit.length,
    }]);

    const renderCandidates = (rows) => rows.map((hotspot) => {
      const hotspotId = Number(hotspot.hotspot_ID || 0);
      const timings = timingsByHotspot.get(hotspotId) || [];
      return {
        hotspotId,
        hotspotName: String(hotspot.hotspot_name || ''),
        bucket: classifyBucket(hotspot, route),
        priority: Number(hotspot.hotspot_priority ?? 0),
        location: String(hotspot.hotspot_location || ''),
        toLocation: String(hotspot.hotspot_to_location || hotspot.hotspot_location || ''),
        timing: timings.length
          ? timings
              .filter((row) => Number(row.status || 0) === 1 && Number(row.deleted || 0) === 0)
              .map((row) => Number(row.hotspot_open_all_time || 0) === 1
                ? `day${Number(row.hotspot_timing_day)}:open_all_day`
                : `day${Number(row.hotspot_timing_day)}:${toHms(row.hotspot_start_time)}-${toHms(row.hotspot_end_time)}`)
              .join(' | ')
          : 'no_timing_rows',
      };
    });

    printSection('UNUSED CANDIDATES');
    console.table(renderCandidates(unused));

    printSection('TIMING-FIT UNUSED CANDIDATES');
    console.table(renderCandidates(timingFit));

    printSection('EXCLUDED CANDIDATES');
    if (!excluded.length) {
      console.log('None');
    } else {
      console.table(renderCandidates(excluded));
    }

    printSection('ALREADY-USED CANDIDATES');
    if (!used.length) {
      console.log('None');
    } else {
      console.table(renderCandidates(used));
    }
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
