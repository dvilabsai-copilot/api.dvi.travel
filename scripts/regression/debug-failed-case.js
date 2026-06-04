#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CASE_ID = String(process.env.CASE_ID || process.argv[2] || '').trim();
const ROOT = path.join(__dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'tmp', 'regression-results');
const CASES_DIR = path.join(ROOT, 'scripts', 'regression');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseDbUrl(url) {
  const match = String(url || '').match(/mysql:\/\/([^:]+):([^@]+)@([^:@/]+):(\d+)\/([^?]+)/);
  if (!match) {
    throw new Error('DATABASE_URL not set or not a valid mysql:// URL');
  }
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
    .replace(/[^a-z0-9]+/gi, ' ')
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
  if (Number.isNaN(date.getTime())) {
    const text = String(value).trim();
    const match = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
    return match ? match[1] : text;
  }
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
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
  if (normalizedClose <= openMinutes) {
    normalizedClose += 24 * 60;
  }
  return { open: openMinutes, close: normalizedClose };
}

function normalizeVisitWindow(startMinutes, endMinutes) {
  if (startMinutes == null || endMinutes == null) return null;
  let normalizedEnd = endMinutes;
  if (normalizedEnd <= startMinutes) {
    normalizedEnd += 24 * 60;
  }
  return { start: startMinutes, end: normalizedEnd };
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

function timingFitsWindow(timings, routeDate, startTime, endTime, options = {}) {
  if (!timings.length) return { fits: true, reason: 'No timing rows; treated as always open' };
  const day = jsDateToHotspotTimingDay(routeDate);
  const dayRows = timings.filter((row) => Number(row.hotspot_timing_day) === day && Number(row.status || 0) === 1 && Number(row.deleted || 0) === 0);
  const activeRows = timings.filter((row) => Number(row.status || 0) === 1 && Number(row.deleted || 0) === 0);
  const rowsToCheck = dayRows.length ? dayRows : (options.fallbackToAnyDayWhenMissing ? activeRows : []);
  if (!rowsToCheck.length) {
    return { fits: true, reason: `No timing row for timingDay=${day}; treated as unknown/open` };
  }
  if (rowsToCheck.some((row) => Number(row.hotspot_open_all_time || 0) === 1)) {
    return { fits: true, reason: 'Open all day' };
  }
  const visitWindow = normalizeVisitWindow(hmsToMinutes(startTime), hmsToMinutes(endTime));
  if (!visitWindow) {
    return { fits: false, reason: 'Scheduled visit time missing' };
  }
  const fitRow = rowsToCheck.find((row) => {
    const normalized = normalizeTimingWindow(hmsToMinutes(row.hotspot_start_time), hmsToMinutes(row.hotspot_end_time));
    if (!normalized) return false;
    return visitWindow.start >= normalized.open - 0.01 && visitWindow.end <= normalized.close + 0.01;
  });
  return fitRow
    ? { fits: true, reason: `Fits ${toHms(fitRow.hotspot_start_time)}-${toHms(fitRow.hotspot_end_time)}` }
    : {
        fits: false,
        reason: `Outside ${rowsToCheck.map((row) => `${toHms(row.hotspot_start_time)}-${toHms(row.hotspot_end_time)}`).join(', ')}`,
      };
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

function printSection(title) {
  console.log(`\n${'='.repeat(90)}`);
  console.log(title);
  console.log('='.repeat(90));
}

async function main() {
  if (!CASE_ID) {
    fail('Usage: CASE_ID=regression-case-01 node scripts/regression/debug-failed-case.js');
  }

  const resultPath = path.join(RESULTS_DIR, `${CASE_ID}.json`);
  const casePath = path.join(CASES_DIR, `${CASE_ID}.json`);
  if (!fs.existsSync(resultPath)) fail(`Missing result file: ${resultPath}`);
  if (!fs.existsSync(casePath)) fail(`Missing case file: ${casePath}`);

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const caseDef = JSON.parse(fs.readFileSync(casePath, 'utf8'));
  const planId = Number(result.planId || caseDef?.payload?.plan?.itinerary_plan_id || 0);
  const quoteId = String(result.quoteId || '').trim();

  const conn = await mysql.createConnection({
    ...parseDbUrl(process.env.DATABASE_URL),
    dateStrings: false,
  });

  try {
    printSection(`FAILED CASE DEBUG :: ${CASE_ID}`);
    console.log(`Plan ID : ${planId}`);
    console.log(`Quote ID: ${quoteId}`);
    console.log(`Desc    : ${String(caseDef.description || '')}`);

    const [routeRows] = await conn.query(
      `SELECT
         itinerary_route_ID,
         itinerary_route_date,
         no_of_days,
         location_name,
         next_visiting_location,
         direct_to_next_visiting_place,
         route_start_time,
         route_end_time,
         excluded_hotspot_ids
       FROM dvi_itinerary_route_details
       WHERE itinerary_plan_ID = ? AND deleted = 0
       ORDER BY no_of_days ASC, itinerary_route_ID ASC`,
      [planId],
    );

    const [hotspotRows] = await conn.query(
      `SELECT
         rh.route_hotspot_ID,
         rh.itinerary_route_ID,
         rh.item_type,
         rh.hotspot_order,
         rh.hotspot_ID,
         rh.hotspot_start_time,
         rh.hotspot_end_time,
         rh.hotspot_plan_own_way,
         rh.is_conflict,
         rh.conflict_reason,
         hp.hotspot_name,
         hp.hotspot_location,
         hp.hotspot_to_location
       FROM dvi_itinerary_route_hotspot_details rh
       LEFT JOIN dvi_hotspot_place hp ON hp.hotspot_ID = rh.hotspot_ID
       WHERE rh.itinerary_plan_ID = ? AND rh.deleted = 0
       ORDER BY rh.itinerary_route_ID ASC, rh.hotspot_order ASC, rh.route_hotspot_ID ASC`,
      [planId],
    );

    const hotspotIds = [...new Set(hotspotRows.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0))];
    const [timingRows] = hotspotIds.length
      ? await conn.query(
          `SELECT hotspot_ID, hotspot_timing_day, hotspot_open_all_time, hotspot_start_time, hotspot_end_time, status, deleted
           FROM dvi_hotspot_timing
           WHERE hotspot_ID IN (${hotspotIds.map(() => '?').join(',')})`,
          hotspotIds,
        )
      : [[]];

    const [allHotspots] = await conn.query(
      `SELECT hotspot_ID, hotspot_name, hotspot_location, hotspot_to_location, status, deleted
       FROM dvi_hotspot_place
       WHERE deleted = 0 AND status = 1`,
    );

    const timingsByHotspot = new Map();
    for (const row of timingRows) {
      const hotspotId = Number(row.hotspot_ID || 0);
      if (!timingsByHotspot.has(hotspotId)) timingsByHotspot.set(hotspotId, []);
      timingsByHotspot.get(hotspotId).push(row);
    }

    const rowsByRoute = new Map();
    for (const row of hotspotRows) {
      const routeId = Number(row.itinerary_route_ID || 0);
      if (!rowsByRoute.has(routeId)) rowsByRoute.set(routeId, []);
      rowsByRoute.get(routeId).push(row);
    }

    printSection('ROUTE LIST');
    console.table(
      routeRows.map((route) => {
        const routeId = Number(route.itinerary_route_ID || 0);
        const rows = rowsByRoute.get(routeId) || [];
        const counts = rows.reduce((acc, row) => {
          const key = `t${Number(row.item_type || 0)}`;
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {});
        return {
          day: Number(route.no_of_days || 0),
          routeId,
          from: String(route.location_name || ''),
          to: String(route.next_visiting_location || ''),
          direct: Number(route.direct_to_next_visiting_place || 0),
          routeStart: toHms(route.route_start_time),
          routeEnd: toHms(route.route_end_time),
          itemType1: counts.t1 || 0,
          itemType4: counts.t4 || 0,
          itemType5: counts.t5 || 0,
          itemType6: counts.t6 || 0,
          itemType7: counts.t7 || 0,
        };
      }),
    );

    printSection('HOTSPOTS ROUTE-WISE');
    for (const route of routeRows) {
      const routeId = Number(route.itinerary_route_ID || 0);
      const rows = (rowsByRoute.get(routeId) || []).filter((row) => Number(row.item_type || 0) === 4);
      console.log(`Day ${Number(route.no_of_days || 0)} | Route ${routeId} | ${route.location_name} -> ${route.next_visiting_location}`);
      if (!rows.length) {
        console.log('  (none)');
        continue;
      }
      for (const row of rows) {
        console.log(
          `  - ${Number(row.hotspot_ID || 0)} | ${String(row.hotspot_name || '')} | ${toHms(row.hotspot_start_time)}-${toHms(row.hotspot_end_time)} | loc=${String(row.hotspot_location || '')}`,
        );
      }
    }

    const activeVisitRows = hotspotRows.filter((row) => Number(row.item_type || 0) === 4);
    const duplicateMap = new Map();
    for (const row of activeVisitRows) {
      const hotspotId = Number(row.hotspot_ID || 0);
      if (!hotspotId) continue;
      if (!duplicateMap.has(hotspotId)) duplicateMap.set(hotspotId, []);
      duplicateMap.get(hotspotId).push(row);
    }

    printSection('DUPLICATE HOTSPOT SOURCE ROUTE/DAY');
    const duplicateRows = [...duplicateMap.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([hotspotId, rows]) => ({
        hotspotId,
        hotspotName: String(rows[0]?.hotspot_name || ''),
        routes: rows
          .map((row) => {
            const route = routeRows.find((r) => Number(r.itinerary_route_ID || 0) === Number(row.itinerary_route_ID || 0));
            return `day ${Number(route?.no_of_days || 0)} route ${Number(row.itinerary_route_ID || 0)}`;
          })
          .join(' | '),
        locations: rows.map((row) => String(row.hotspot_location || '')).join(' | '),
      }));
    if (!duplicateRows.length) {
      console.log('No duplicates.');
    } else {
      console.table(duplicateRows);
    }

    printSection('EMPTY ROUTES WITH CANDIDATE HOTSPOT COUNT');
    for (const route of routeRows) {
      const routeId = Number(route.itinerary_route_ID || 0);
      const rows = rowsByRoute.get(routeId) || [];
      const visitRows = rows.filter((row) => Number(row.item_type || 0) === 4);
      const hasOperationalRows = rows.some((row) => [1, 5, 6].includes(Number(row.item_type || 0)));
      if (!hasOperationalRows || visitRows.length > 0) continue;

      const matching = allHotspots.filter((hotspot) =>
        matchesLocation(hotspot.hotspot_location, route.location_name) ||
        matchesLocation(hotspot.hotspot_to_location, route.location_name) ||
        matchesLocation(hotspot.hotspot_location, route.next_visiting_location) ||
        matchesLocation(hotspot.hotspot_to_location, route.next_visiting_location),
      );

      const usedElsewhereIds = new Set(activeVisitRows.map((row) => Number(row.hotspot_ID || 0)));
      const excludedIds = new Set(parseExcludedHotspotIds(route.excluded_hotspot_ids));
      const unused = matching.filter((hotspot) => !usedElsewhereIds.has(Number(hotspot.hotspot_ID || 0)));
      const nonExcluded = unused.filter((hotspot) => !excludedIds.has(Number(hotspot.hotspot_ID || 0)));
      const routeWindowFit = nonExcluded.filter((hotspot) =>
        routeWindowCanIntersect(
          timingsByHotspot.get(Number(hotspot.hotspot_ID || 0)) || [],
          route.itinerary_route_date,
          route.route_start_time,
          route.route_end_time,
        ),
      );

      console.log(
        `Day ${Number(route.no_of_days || 0)} | Route ${routeId} | ${route.location_name} -> ${route.next_visiting_location}`,
      );
      console.log(
        `  matchingCandidates=${matching.length} | unusedCandidates=${unused.length} | nonExcludedCandidates=${nonExcluded.length} | routeWindowFitUnused=${routeWindowFit.length} | excludedOnRoute=${unused.length - nonExcluded.length} | closedForRouteDay=${nonExcluded.length - routeWindowFit.length}`,
      );
      if (routeWindowFit.length) {
        console.log(
          `  sample route-window-fit unused: ${routeWindowFit.slice(0, 8).map((hotspot) => `${Number(hotspot.hotspot_ID)}:${String(hotspot.hotspot_name || '')}`).join(', ')}`,
        );
      } else if (nonExcluded.length) {
        console.log(
          `  sample unused but timing-blocked: ${nonExcluded.slice(0, 8).map((hotspot) => `${Number(hotspot.hotspot_ID)}:${String(hotspot.hotspot_name || '')}`).join(', ')}`,
        );
      } else if (unused.length) {
        console.log('  all unused candidates were excluded on this route.');
      } else {
        console.log('  no unused matching hotspot remains in master data for this route.');
      }
    }

    printSection('INVALID CARRY-FORWARD / LOCATION MISMATCH DETAILS');
    const mismatchRows = [];
    for (const row of activeVisitRows) {
      const route = routeRows.find((item) => Number(item.itinerary_route_ID || 0) === Number(row.itinerary_route_ID || 0));
      if (!route) continue;
      const sourceMatch =
        matchesLocation(row.hotspot_location, route.location_name) ||
        matchesLocation(row.hotspot_to_location, route.location_name);
      const destinationMatch =
        matchesLocation(row.hotspot_location, route.next_visiting_location) ||
        matchesLocation(row.hotspot_to_location, route.next_visiting_location);
      if (sourceMatch || destinationMatch) continue;
      mismatchRows.push({
        day: Number(route.no_of_days || 0),
        routeId: Number(route.itinerary_route_ID || 0),
        route: `${String(route.location_name || '')} -> ${String(route.next_visiting_location || '')}`,
        hotspotId: Number(row.hotspot_ID || 0),
        hotspotName: String(row.hotspot_name || ''),
        hotspotLocation: String(row.hotspot_location || ''),
        hotspotToLocation: String(row.hotspot_to_location || ''),
        scheduled: `${toHms(row.hotspot_start_time)}-${toHms(row.hotspot_end_time)}`,
      });
    }
    if (!mismatchRows.length) {
      console.log('No location mismatches.');
    } else {
      console.table(mismatchRows);
    }

    printSection('OPERATING-HOUR VIOLATION DETAILS');
    const operatingRows = [];
    for (const row of activeVisitRows) {
      const route = routeRows.find((item) => Number(item.itinerary_route_ID || 0) === Number(row.itinerary_route_ID || 0));
      if (!route) continue;
      const fit = timingFitsWindow(
        timingsByHotspot.get(Number(row.hotspot_ID || 0)) || [],
        route.itinerary_route_date,
        row.hotspot_start_time,
        row.hotspot_end_time,
        { fallbackToAnyDayWhenMissing: Number(row.hotspot_plan_own_way || 0) === 1 },
      );
      if (fit.fits) continue;
      operatingRows.push({
        day: Number(route.no_of_days || 0),
        routeId: Number(route.itinerary_route_ID || 0),
        hotspotId: Number(row.hotspot_ID || 0),
        hotspotName: String(row.hotspot_name || ''),
        scheduled: `${toHms(row.hotspot_start_time)}-${toHms(row.hotspot_end_time)}`,
        reason: fit.reason,
      });
    }
    if (!operatingRows.length) {
      console.log('No operating-hour violations.');
    } else {
      console.table(operatingRows);
    }

    printSection('RUNNER FAILURE SNAPSHOT');
    console.table(
      (Array.isArray(result.failures) ? result.failures : []).map((failure, index) => ({
        seq: index + 1,
        label: String(failure.label || ''),
        routeId: failure.routeId ?? null,
        hotspotId: failure.hotspotId ?? null,
        detail: String(failure.detail || ''),
      })),
    );
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
