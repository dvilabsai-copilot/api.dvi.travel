#!/usr/bin/env node

require('dotenv').config();

const mysql = require('mysql2/promise');

const PLAN_ID = Number(process.env.PLAN_ID || process.argv[2] || 9309);

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

function hotspotLocationMatchesCity(hotspotLocation, targetCity) {
  const targetKey = canonicalCityKey(targetCity);
  if (!targetKey) return false;
  const parts = String(hotspotLocation || '')
    .split('|')
    .map((part) => canonicalCityKey(part))
    .filter(Boolean);
  if (!parts.length) return false;
  return parts.some((part) =>
    part === targetKey ||
    part.startsWith(`${targetKey} `) ||
    part.includes(` ${targetKey} `) ||
    part.endsWith(` ${targetKey}`),
  );
}

function printHeader(title) {
  console.log(`\n${'='.repeat(100)}`);
  console.log(title);
  console.log('='.repeat(100));
}

function buildInitialCandidates(allHotspots, route) {
  const source = String(route.location_name || '');
  const destination = String(route.next_visiting_location || '');
  const sourceKey = canonicalCityKey(source);
  const destinationKey = canonicalCityKey(destination);
  const isIntercityNonDirect =
    sourceKey &&
    destinationKey &&
    sourceKey !== destinationKey &&
    Number(route.direct_to_next_visiting_place || 0) !== 1;

  const rows = [];
  for (const hotspot of allHotspots) {
    const hotspotId = Number(hotspot.hotspot_ID || 0);
    const hotspotLocation = String(hotspot.hotspot_location || '').trim();
    const hotspotToLocation = String(hotspot.hotspot_to_location || hotspotLocation || '').trim();
    const hotspotLocationKey = canonicalCityKey(hotspotLocation);
    const hotspotToLocationKey = canonicalCityKey(hotspotToLocation);
    const isRouteSpecific =
      hotspotLocationKey !== '' &&
      hotspotToLocationKey !== '' &&
      hotspotLocationKey !== hotspotToLocationKey;

    const sourceMatch = hotspotLocationMatchesCity(hotspotLocation, source);
    const destinationMatch = hotspotLocationMatchesCity(hotspotLocation, destination);
    const routeToMatch = hotspotLocationMatchesCity(hotspotToLocation, destination);

    if (isRouteSpecific) {
      if (isIntercityNonDirect && sourceMatch && routeToMatch) {
        rows.push({
          hotspotId,
          hotspotName: String(hotspot.hotspot_name || ''),
          hotspot_location: hotspotLocation,
          hotspot_to_location: hotspotToLocation,
          matched_bucket: 'en_route',
          sourceMatch,
          destinationMatch,
          enrouteMatch: sourceMatch && routeToMatch,
          viaRouteMatch: false,
          betweenMapMatch: false,
          routeFitType: '',
          reason: 'route_specific_en_route_bucket',
        });
      }
      continue;
    }

    if (sourceMatch) {
      rows.push({
        hotspotId,
        hotspotName: String(hotspot.hotspot_name || ''),
        hotspot_location: hotspotLocation,
        hotspot_to_location: hotspotToLocation,
        matched_bucket: 'source',
        sourceMatch,
        destinationMatch,
        enrouteMatch: false,
        viaRouteMatch: false,
        betweenMapMatch: false,
        routeFitType: '',
        reason: 'source_bucket_match',
      });
    }

    if (destinationMatch) {
      rows.push({
        hotspotId,
        hotspotName: String(hotspot.hotspot_name || ''),
        hotspot_location: hotspotLocation,
        hotspot_to_location: hotspotToLocation,
        matched_bucket: 'destination',
        sourceMatch,
        destinationMatch,
        enrouteMatch: false,
        viaRouteMatch: false,
        betweenMapMatch: false,
        routeFitType: '',
        reason: 'destination_bucket_match',
      });
    }
  }

  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.hotspotId}:${row.matched_bucket}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const conn = await mysql.createConnection({
    ...parseDbUrl(process.env.DATABASE_URL),
    dateStrings: true,
  });

  try {
    const [routes] = await conn.query(
      `SELECT itinerary_route_ID, no_of_days, location_name, next_visiting_location, direct_to_next_visiting_place, location_id, route_start_time, route_end_time
       FROM dvi_itinerary_route_details
       WHERE itinerary_plan_ID = ? AND deleted = 0
       ORDER BY no_of_days ASC, itinerary_route_ID ASC`,
      [PLAN_ID],
    );

    const day2Route = routes.find((route) => Number(route.no_of_days || 0) === 2);
    if (!day2Route) {
      throw new Error(`No day-2 route found for plan ${PLAN_ID}`);
    }

    const [hotspot294Rows] = await conn.query(
      `SELECT hotspot_ID, hotspot_name, hotspot_location, hotspot_to_location, status, deleted
       FROM dvi_hotspot_place
       WHERE hotspot_ID = 294`,
    );

    const [allHotspots] = await conn.query(
      `SELECT hotspot_ID, hotspot_name, hotspot_location, hotspot_to_location, status, deleted
       FROM dvi_hotspot_place
       WHERE status = 1 AND deleted = 0`,
    );

    const initialCandidates = buildInitialCandidates(allHotspots, day2Route);

    const [persistedDay2Rows] = await conn.query(
      `SELECT rh.itinerary_route_ID, rh.item_type, rh.hotspot_order, rh.hotspot_ID, rh.hotspot_start_time, rh.hotspot_end_time,
              hp.hotspot_name, hp.hotspot_location, hp.hotspot_to_location
       FROM dvi_itinerary_route_hotspot_details rh
       LEFT JOIN dvi_hotspot_place hp ON hp.hotspot_ID = rh.hotspot_ID
       WHERE rh.itinerary_plan_ID = ? AND rh.itinerary_route_ID = ? AND rh.deleted = 0
       ORDER BY rh.hotspot_order ASC, rh.route_hotspot_ID ASC`,
      [PLAN_ID, Number(day2Route.itinerary_route_ID || 0)],
    );

    const [tiruvannamalaiHotspots] = await conn.query(
      `SELECT hotspot_ID, hotspot_name, hotspot_location, hotspot_to_location
       FROM dvi_hotspot_place
       WHERE status = 1 AND deleted = 0
         AND (
           hotspot_location LIKE '%Tiruvannamalai%'
           OR hotspot_to_location LIKE '%Tiruvannamalai%'
         )`,
    );

    const tiruvIds = tiruvannamalaiHotspots.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0);
    const matrixSql = tiruvIds.length
      ? `SELECT id, from_hotspot_id, from_hotspot_name, from_hotspot_location,
                to_hotspot_id, to_hotspot_name, to_hotspot_location,
                between_hotspot_id, between_hotspot_name, route_fit_type,
                candidate_distance_from_ab_route_meters, road_detour_km, road_detour_ratio
         FROM hotspot_route_between_map
         WHERE between_hotspot_id = 294 AND to_hotspot_id IN (${tiruvIds.map(() => '?').join(',')})
         ORDER BY id ASC
         LIMIT 40`
      : null;
    const [matrixRows] = matrixSql ? await conn.query(matrixSql, tiruvIds) : [[]];

    const selectedAttractionRows = persistedDay2Rows
      .filter((row) => Number(row.item_type || 0) === 4)
      .map((row) => ({
        hotspotId: Number(row.hotspot_ID || 0),
        hotspotName: String(row.hotspot_name || ''),
        hotspot_location: String(row.hotspot_location || ''),
        hotspot_to_location: String(row.hotspot_to_location || ''),
        sourceMatch: hotspotLocationMatchesCity(row.hotspot_location, day2Route.location_name),
        destinationMatch: hotspotLocationMatchesCity(row.hotspot_location, day2Route.next_visiting_location),
        enrouteMatch:
          hotspotLocationMatchesCity(row.hotspot_location, day2Route.location_name) &&
          hotspotLocationMatchesCity(row.hotspot_to_location, day2Route.next_visiting_location),
        viaRouteMatch: false,
        betweenMapMatch: Number(row.hotspot_ID || 0) === 294,
      }));

    printHeader(`CASE-09 LOCATION CONTAMINATION DEBUG :: PLAN ${PLAN_ID}`);
    console.log(`Day 2 route ID: ${Number(day2Route.itinerary_route_ID || 0)}`);
    console.log(`Route        : ${String(day2Route.location_name || '')} -> ${String(day2Route.next_visiting_location || '')}`);

    printHeader('ROUTE LIST');
    console.table(routes.map((route) => ({
      routeId: Number(route.itinerary_route_ID || 0),
      day: Number(route.no_of_days || 0),
      source: String(route.location_name || ''),
      destination: String(route.next_visiting_location || ''),
      direct: Number(route.direct_to_next_visiting_place || 0),
      locationId: Number(route.location_id || 0),
      start: String(route.route_start_time || ''),
      end: String(route.route_end_time || ''),
    })));

    printHeader('HOTSPOT 294 MASTER');
    console.table(hotspot294Rows);

    printHeader('DAY 2 INITIAL NORMAL CANDIDATES');
    console.table(initialCandidates.map((row) => ({
      hotspotId: row.hotspotId,
      hotspotName: row.hotspotName,
      matched_bucket: row.matched_bucket,
      sourceMatch: row.sourceMatch,
      destinationMatch: row.destinationMatch,
      enrouteMatch: row.enrouteMatch,
      reason: row.reason,
    })));

    const initial294 = initialCandidates.filter((row) => Number(row.hotspotId) === 294);
    printHeader('DAY 2 INITIAL CANDIDATE CHECK FOR 294');
    if (!initial294.length) {
      console.log('Hotspot 294 does NOT appear in the initial normal source/destination/en-route candidate set.');
    } else {
      console.table(initial294);
    }

    printHeader('DAY 2 PERSISTED ROUTE HOTSPOTS');
    console.table(persistedDay2Rows.map((row) => ({
      itemType: Number(row.item_type || 0),
      order: Number(row.hotspot_order || 0),
      hotspotId: Number(row.hotspot_ID || 0),
      hotspotName: String(row.hotspot_name || ''),
      start: String(row.hotspot_start_time || ''),
      end: String(row.hotspot_end_time || ''),
    })));

    printHeader('DAY 2 SELECTED ATTRACTIONS WITH LOCATION CHECKS');
    console.table(selectedAttractionRows);

    printHeader('MATRIX ROWS FOR 294 TOWARD TIRUVANNAMALAI HOTSPOTS');
    console.table(matrixRows.map((row) => ({
      id: Number(row.id || 0),
      fromId: Number(row.from_hotspot_id || 0),
      fromName: String(row.from_hotspot_name || ''),
      toId: Number(row.to_hotspot_id || 0),
      toName: String(row.to_hotspot_name || ''),
      routeFitType: String(row.route_fit_type || ''),
      detourKm: row.road_detour_km == null ? null : Number(row.road_detour_km),
      distanceFromRouteMeters: row.candidate_distance_from_ab_route_meters == null ? null : Number(row.candidate_distance_from_ab_route_meters),
    })));

    printHeader('WHY 294 WAS CONSIDERED VALID');
    console.log([
      '1. Hotspot 294 is not part of the initial normal Day 2 candidate fetch for Kanchipuram -> Tiruvannamalai.',
      '2. It does persist on Day 2 as an attraction row, so it was introduced later in scheduling.',
      '3. hotspot_route_between_map contains ON_ROUTE rows for 294 that point toward Tiruvannamalai destination hotspots.',
      '4. The matrix path can therefore append 294 unless the candidate itself is revalidated against the current route.',
      '5. Because hotspot 294 is Chennai-only in master data, it should be rejected by the normal candidate compatibility gate for this route.',
    ].join('\n'));
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
