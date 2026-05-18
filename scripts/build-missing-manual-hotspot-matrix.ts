import { PrismaClient } from '@prisma/client';

type RouteFitType = 'ON_ROUTE' | 'MINOR_DETOUR' | 'BACKTRACK' | 'OFF_ROUTE';

type HotspotMeta = {
  id: number;
  name: string;
  lat: number;
  lng: number;
};

type RouteLeg = {
  distanceKm: number;
  durationMin: number;
  coordinates: [number, number][];
};

const prisma = new PrismaClient();

const OSRM_BASE_URL = String(process.env.OSRM_BASE_URL || 'http://localhost:5000/route/v1/driving').trim();
const DESTINATION_CROSSING_RADIUS_METERS = Number(process.env.DESTINATION_CROSSING_RADIUS_METERS || 1200);
const DESTINATION_CROSSING_MAX_PROGRESS_RATIO = Number(process.env.DESTINATION_CROSSING_MAX_PROGRESS_RATIO || 0.9);

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

function parseCliArgs(): { planId: number; routeId: number; candidateHotspotId: number } {
  const args = process.argv.slice(2);
  const raw: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) continue;

    if (token.includes('=')) {
      const [k, v] = token.slice(2).split('=', 2);
      raw[k] = String(v || '').trim();
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      raw[key] = String(next).trim();
      i += 1;
    }
  }

  const planId = toInt(raw.planId || process.env.PLAN_ID, 0);
  const routeId = toInt(raw.routeId || process.env.ROUTE_ID, 0);
  const candidateHotspotId = toInt(raw.candidateHotspotId || process.env.CANDIDATE_HOTSPOT_ID, 0);

  if (!planId || !routeId || !candidateHotspotId) {
    throw new Error('Missing required input. Use --planId --routeId --candidateHotspotId (or PLAN_ID/ROUTE_ID/CANDIDATE_HOTSPOT_ID).');
  }

  return { planId, routeId, candidateHotspotId };
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusKm = 6371;
  const dLat = degToRad(lat2 - lat1);
  const dLng = degToRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function projectToMeters(lat: number, lng: number, refLat: number): { x: number; y: number } {
  const earthRadiusMeters = 6371000;
  const x = degToRad(lng) * earthRadiusMeters * Math.cos(degToRad(refLat));
  const y = degToRad(lat) * earthRadiusMeters;
  return { x, y };
}

function findNearestProgressOnRoute(
  point: { lat: number; lng: number },
  coordinates: [number, number][],
): { distanceMeters: number; progressRatio: number } {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return { distanceMeters: Number.POSITIVE_INFINITY, progressRatio: 0 };
  }

  let bestDistanceMeters = Number.POSITIVE_INFINITY;
  let bestProgressMeters = 0;
  let totalMeters = 0;
  let cumulativeMeters = 0;

  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const aLng = Number(coordinates[i][0]);
    const aLat = Number(coordinates[i][1]);
    const bLng = Number(coordinates[i + 1][0]);
    const bLat = Number(coordinates[i + 1][1]);

    const segmentMeters = haversineKm(aLat, aLng, bLat, bLng) * 1000;
    totalMeters += segmentMeters;

    const refLat = (point.lat + aLat + bLat) / 3;
    const p = projectToMeters(point.lat, point.lng, refLat);
    const a = projectToMeters(aLat, aLng, refLat);
    const b = projectToMeters(bLat, bLng, refLat);

    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;
    const vv = vx * vx + vy * vy;
    const t = vv === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));

    const projX = a.x + t * vx;
    const projY = a.y + t * vy;
    const dx = p.x - projX;
    const dy = p.y - projY;
    const distanceMeters = Math.sqrt(dx * dx + dy * dy);

    if (distanceMeters < bestDistanceMeters) {
      bestDistanceMeters = distanceMeters;
      bestProgressMeters = cumulativeMeters + (segmentMeters * t);
    }

    cumulativeMeters += segmentMeters;
  }

  return {
    distanceMeters: bestDistanceMeters,
    progressRatio: totalMeters > 0 ? bestProgressMeters / totalMeters : 0,
  };
}

function classifyRouteFit(params: {
  roadDetourKm: number;
  roadDetourRatio: number;
  candidateDistanceFromAbRouteMeters: number;
  crossesDestinationBeforeCandidate: boolean;
}): RouteFitType {
  if (params.crossesDestinationBeforeCandidate) return 'BACKTRACK';

  if (
    params.candidateDistanceFromAbRouteMeters <= 1500
    && params.roadDetourKm <= 0.5
  ) {
    return 'ON_ROUTE';
  }

  if (
    params.candidateDistanceFromAbRouteMeters <= 3000
    && params.roadDetourKm <= 5
    && params.roadDetourRatio <= 0.25
  ) {
    return 'MINOR_DETOUR';
  }

  return 'OFF_ROUTE';
}

function buildDecisionReason(routeFitType: RouteFitType): string {
  if (routeFitType === 'ON_ROUTE') {
    return 'Candidate is near route and adds negligible detour.';
  }
  if (routeFitType === 'MINOR_DETOUR') {
    return 'Candidate adds a minor acceptable detour.';
  }
  if (routeFitType === 'BACKTRACK') {
    return 'Route crosses destination before candidate; this insertion causes backtracking.';
  }
  return 'Candidate is off route and adds high detour.';
}

async function ensureHelperTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS hotspot_route_matrix (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      from_hotspot_id INT NOT NULL,
      to_hotspot_id INT NOT NULL,
      from_name TEXT NULL,
      to_name TEXT NULL,
      from_lat DOUBLE NULL,
      from_lng DOUBLE NULL,
      to_lat DOUBLE NULL,
      to_lng DOUBLE NULL,
      haversine_km DOUBLE NULL,
      osrm_distance_km DOUBLE NULL,
      osrm_duration_min DOUBLE NULL,
      route_coordinates LONGTEXT NULL,
      process_status ENUM('PENDING','DONE','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
      error_message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_hotspot_route_pair (from_hotspot_id, to_hotspot_id),
      KEY idx_hotspot_route_status (process_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS hotspot_route_between_map (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      from_hotspot_id INT NOT NULL,
      to_hotspot_id INT NOT NULL,
      between_hotspot_id INT NOT NULL,
      between_hotspot_name TEXT NULL,
      distance_from_route_meters DOUBLE NULL,
      detour_km DOUBLE NULL,
      detour_ratio DOUBLE NULL,
      route_fit_type VARCHAR(40) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_hotspot_route_between (from_hotspot_id, to_hotspot_id, between_hotspot_id),
      KEY idx_hotspot_route_between_fit (route_fit_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const requiredColumns: Array<[string, string]> = [
    ['ab_osrm_distance_km', 'DOUBLE NULL'],
    ['ac_osrm_distance_km', 'DOUBLE NULL'],
    ['cb_osrm_distance_km', 'DOUBLE NULL'],
    ['inserted_route_distance_km', 'DOUBLE NULL'],
    ['road_detour_km', 'DOUBLE NULL'],
    ['road_detour_ratio', 'DOUBLE NULL'],
    ['candidate_progress_on_ab_ratio', 'DOUBLE NULL'],
    ['destination_progress_on_ac_ratio', 'DOUBLE NULL'],
    ['candidate_distance_from_ab_route_meters', 'DOUBLE NULL'],
    ['destination_distance_from_ac_route_meters', 'DOUBLE NULL'],
    ['crosses_destination_before_candidate', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['route_decision_reason', 'TEXT NULL'],
  ];

  for (const [columnName, definition] of requiredColumns) {
    const existing = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
      SELECT COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'hotspot_route_between_map'
        AND COLUMN_NAME = ?
      LIMIT 1
    `, columnName);

    if (!existing.length) {
      await prisma.$executeRawUnsafe(`ALTER TABLE hotspot_route_between_map ADD COLUMN ${columnName} ${definition}`);
    }
  }
}

async function fetchHotspotMeta(ids: number[]): Promise<Map<number, HotspotMeta>> {
  const uniqueIds = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (uniqueIds.length === 0) return new Map<number, HotspotMeta>();

  const rows = await prisma.dvi_hotspot_place.findMany({
    where: { hotspot_ID: { in: uniqueIds }, deleted: 0 },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_latitude: true,
      hotspot_longitude: true,
    },
  });

  const map = new Map<number, HotspotMeta>();
  for (const row of rows) {
    const id = Number((row as any).hotspot_ID || 0);
    const lat = Number((row as any).hotspot_latitude);
    const lng = Number((row as any).hotspot_longitude);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    map.set(id, {
      id,
      name: String((row as any).hotspot_name || `Hotspot #${id}`),
      lat,
      lng,
    });
  }

  return map;
}

async function fetchOsrmRoute(from: HotspotMeta, to: HotspotMeta): Promise<RouteLeg> {
  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${OSRM_BASE_URL}/${coordinates}?overview=full&geometries=geojson&steps=false`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM request failed (${response.status}) for ${from.id}->${to.id}`);
  }

  const json: any = await response.json();
  const route = Array.isArray(json?.routes) ? json.routes[0] : null;
  const distanceKm = Number(route?.distance || 0) / 1000;
  const durationMin = Number(route?.duration || 0) / 60;
  const coords = Array.isArray(route?.geometry?.coordinates)
    ? route.geometry.coordinates.filter((x: any) => Array.isArray(x) && x.length === 2)
    : [];

  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || coords.length < 2) {
    throw new Error(`Invalid OSRM route for ${from.id}->${to.id}`);
  }

  return {
    distanceKm,
    durationMin: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0,
    coordinates: coords,
  };
}

async function getCachedLeg(fromId: number, toId: number): Promise<RouteLeg | null> {
  const rows = await prisma.$queryRawUnsafe<Array<any>>(`
    SELECT osrm_distance_km, osrm_duration_min, route_coordinates
    FROM hotspot_route_matrix
    WHERE from_hotspot_id = ?
      AND to_hotspot_id = ?
      AND process_status = 'DONE'
    ORDER BY updated_at DESC
    LIMIT 1
  `, Number(fromId), Number(toId));

  const row = rows[0];
  if (!row) return null;

  const distanceKm = Number(row.osrm_distance_km);
  const durationMin = Number(row.osrm_duration_min || 0);
  let coordinates: [number, number][] = [];
  if (row.route_coordinates) {
    try {
      const parsed = JSON.parse(String(row.route_coordinates));
      if (Array.isArray(parsed)) {
        coordinates = parsed.filter((x: any) => Array.isArray(x) && x.length === 2);
      }
    } catch {
      coordinates = [];
    }
  }

  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || coordinates.length < 2) return null;

  return {
    distanceKm,
    durationMin: Number.isFinite(durationMin) ? durationMin : 0,
    coordinates,
  };
}

async function upsertMatrixLeg(
  from: HotspotMeta,
  to: HotspotMeta,
  leg: RouteLeg | null,
  status: 'DONE' | 'FAILED',
  errorMessage: string | null,
): Promise<void> {
  const haversine = haversineKm(from.lat, from.lng, to.lat, to.lng);
  await prisma.$executeRawUnsafe(`
    INSERT INTO hotspot_route_matrix (
      from_hotspot_id,
      to_hotspot_id,
      from_name,
      to_name,
      from_lat,
      from_lng,
      to_lat,
      to_lng,
      haversine_km,
      osrm_distance_km,
      osrm_duration_min,
      route_coordinates,
      process_status,
      error_message,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      from_name = VALUES(from_name),
      to_name = VALUES(to_name),
      from_lat = VALUES(from_lat),
      from_lng = VALUES(from_lng),
      to_lat = VALUES(to_lat),
      to_lng = VALUES(to_lng),
      haversine_km = VALUES(haversine_km),
      osrm_distance_km = VALUES(osrm_distance_km),
      osrm_duration_min = VALUES(osrm_duration_min),
      route_coordinates = VALUES(route_coordinates),
      process_status = VALUES(process_status),
      error_message = VALUES(error_message),
      updated_at = NOW()
  `,
  from.id,
  to.id,
  from.name,
  to.name,
  from.lat,
  from.lng,
  to.lat,
  to.lng,
  Number(haversine.toFixed(6)),
  leg ? Number(leg.distanceKm.toFixed(6)) : null,
  leg ? Number(leg.durationMin.toFixed(6)) : null,
  leg ? JSON.stringify(leg.coordinates) : null,
  status,
  errorMessage,
  );
}

async function ensureLeg(from: HotspotMeta, to: HotspotMeta): Promise<RouteLeg> {
  const cached = await getCachedLeg(from.id, to.id);
  if (cached) return cached;

  try {
    const fetched = await fetchOsrmRoute(from, to);
    await upsertMatrixLeg(from, to, fetched, 'DONE', null);
    return fetched;
  } catch (error: any) {
    const message = String(error?.message || error || 'OSRM fetch failed');
    await upsertMatrixLeg(from, to, null, 'FAILED', message);
    throw new Error(`Failed to build matrix leg ${from.id}->${to.id}: ${message}`);
  }
}

async function upsertBetweenMapRow(params: {
  from: HotspotMeta;
  to: HotspotMeta;
  candidate: HotspotMeta;
  ab: RouteLeg;
  ac: RouteLeg;
  cb: RouteLeg;
  routeFitType: RouteFitType;
  roadDetourKm: number;
  roadDetourRatio: number;
  candidateDistanceFromAbRouteMeters: number;
  candidateProgressOnAbRatio: number;
  destinationDistanceFromAcRouteMeters: number;
  destinationProgressOnAcRatio: number;
  crossesDestinationBeforeCandidate: boolean;
  routeDecisionReason: string;
}): Promise<void> {
  const p = params;
  await prisma.$executeRawUnsafe(`
    INSERT INTO hotspot_route_between_map (
      from_hotspot_id,
      to_hotspot_id,
      between_hotspot_id,
      between_hotspot_name,
      distance_from_route_meters,
      candidate_distance_from_ab_route_meters,
      candidate_progress_on_ab_ratio,
      destination_distance_from_ac_route_meters,
      destination_progress_on_ac_ratio,
      crosses_destination_before_candidate,
      ab_osrm_distance_km,
      ac_osrm_distance_km,
      cb_osrm_distance_km,
      inserted_route_distance_km,
      road_detour_km,
      road_detour_ratio,
      route_decision_reason,
      route_fit_type,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      between_hotspot_name = VALUES(between_hotspot_name),
      distance_from_route_meters = VALUES(distance_from_route_meters),
      candidate_distance_from_ab_route_meters = VALUES(candidate_distance_from_ab_route_meters),
      candidate_progress_on_ab_ratio = VALUES(candidate_progress_on_ab_ratio),
      destination_distance_from_ac_route_meters = VALUES(destination_distance_from_ac_route_meters),
      destination_progress_on_ac_ratio = VALUES(destination_progress_on_ac_ratio),
      crosses_destination_before_candidate = VALUES(crosses_destination_before_candidate),
      ab_osrm_distance_km = VALUES(ab_osrm_distance_km),
      ac_osrm_distance_km = VALUES(ac_osrm_distance_km),
      cb_osrm_distance_km = VALUES(cb_osrm_distance_km),
      inserted_route_distance_km = VALUES(inserted_route_distance_km),
      road_detour_km = VALUES(road_detour_km),
      road_detour_ratio = VALUES(road_detour_ratio),
      route_decision_reason = VALUES(route_decision_reason),
      route_fit_type = VALUES(route_fit_type),
      updated_at = NOW()
  `,
  p.from.id,
  p.to.id,
  p.candidate.id,
  p.candidate.name,
  p.candidateDistanceFromAbRouteMeters,
  p.candidateDistanceFromAbRouteMeters,
  p.candidateProgressOnAbRatio,
  p.destinationDistanceFromAcRouteMeters,
  p.destinationProgressOnAcRatio,
  p.crossesDestinationBeforeCandidate ? 1 : 0,
  Number(p.ab.distanceKm.toFixed(6)),
  Number(p.ac.distanceKm.toFixed(6)),
  Number(p.cb.distanceKm.toFixed(6)),
  Number((p.ac.distanceKm + p.cb.distanceKm).toFixed(6)),
  Number(p.roadDetourKm.toFixed(6)),
  Number(p.roadDetourRatio.toFixed(6)),
  p.routeDecisionReason,
  p.routeFitType,
  );
}

async function main(): Promise<void> {
  const { planId, routeId, candidateHotspotId } = parseCliArgs();
  await ensureHelperTables();

  const routeRows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: Number(planId),
      itinerary_route_ID: Number(routeId),
      item_type: 4,
      deleted: 0,
      status: 1,
    },
    select: {
      hotspot_ID: true,
      hotspot_order: true,
    },
    orderBy: {
      hotspot_order: 'asc',
    },
  });

  const routeHotspotIds = routeRows
    .map((row: any) => Number(row?.hotspot_ID || 0))
    .filter((id: number) => Number.isFinite(id) && id > 0)
    .filter((id: number, idx: number, arr: number[]) => arr.indexOf(id) === idx)
    .filter((id: number) => id !== Number(candidateHotspotId));

  if (routeHotspotIds.length < 2) {
    throw new Error('Route has fewer than two active attraction hotspots. Cannot build matrix slots.');
  }

  const allMeta = await fetchHotspotMeta([...routeHotspotIds, Number(candidateHotspotId)]);
  const candidate = allMeta.get(Number(candidateHotspotId));
  if (!candidate) {
    throw new Error(`Candidate hotspot ${candidateHotspotId} is missing coordinates or does not exist.`);
  }

  const pairs: Array<{ from: HotspotMeta; to: HotspotMeta }> = [];
  for (let i = 0; i < routeHotspotIds.length - 1; i += 1) {
    const from = allMeta.get(Number(routeHotspotIds[i]));
    const to = allMeta.get(Number(routeHotspotIds[i + 1]));
    if (!from || !to) continue;
    pairs.push({ from, to });
  }

  if (pairs.length === 0) {
    throw new Error('No consecutive hotspot slot pairs found on route.');
  }

  console.log(`[START] planId=${planId} routeId=${routeId} candidateHotspotId=${candidateHotspotId} (${candidate.name})`);
  console.log(`[START] slotPairs=${pairs.length}`);

  let successCount = 0;
  let failedCount = 0;

  for (const pair of pairs) {
    try {
      const ab = await ensureLeg(pair.from, pair.to);
      const ac = await ensureLeg(pair.from, candidate);
      const cb = await ensureLeg(candidate, pair.to);

      const candidateOnAb = findNearestProgressOnRoute({ lat: candidate.lat, lng: candidate.lng }, ab.coordinates);
      const destinationOnAc = findNearestProgressOnRoute({ lat: pair.to.lat, lng: pair.to.lng }, ac.coordinates);

      const insertedDistanceKm = ac.distanceKm + cb.distanceKm;
      const roadDetourKm = Math.max(0, insertedDistanceKm - ab.distanceKm);
      const roadDetourRatio = ab.distanceKm > 0 ? roadDetourKm / ab.distanceKm : 0;
      const crossesDestinationBeforeCandidate =
        destinationOnAc.distanceMeters <= DESTINATION_CROSSING_RADIUS_METERS
        && destinationOnAc.progressRatio < DESTINATION_CROSSING_MAX_PROGRESS_RATIO;

      const routeFitType = classifyRouteFit({
        roadDetourKm,
        roadDetourRatio,
        candidateDistanceFromAbRouteMeters: candidateOnAb.distanceMeters,
        crossesDestinationBeforeCandidate,
      });

      const routeDecisionReason = buildDecisionReason(routeFitType);

      await upsertBetweenMapRow({
        from: pair.from,
        to: pair.to,
        candidate,
        ab,
        ac,
        cb,
        routeFitType,
        roadDetourKm,
        roadDetourRatio,
        candidateDistanceFromAbRouteMeters: candidateOnAb.distanceMeters,
        candidateProgressOnAbRatio: candidateOnAb.progressRatio,
        destinationDistanceFromAcRouteMeters: destinationOnAc.distanceMeters,
        destinationProgressOnAcRatio: destinationOnAc.progressRatio,
        crossesDestinationBeforeCandidate,
        routeDecisionReason,
      });

      successCount += 1;
      console.log(
        `[OK] ${pair.from.name} -> ${pair.to.name} | fit=${routeFitType} | AB=${ab.distanceKm.toFixed(2)}km AC=${ac.distanceKm.toFixed(2)}km CB=${cb.distanceKm.toFixed(2)}km detour=${roadDetourKm.toFixed(2)}km`,
      );
    } catch (error: any) {
      failedCount += 1;
      console.error(`[FAIL] ${pair.from.name} -> ${pair.to.name}: ${String(error?.message || error)}`);
    }
  }

  console.log(`[DONE] success=${successCount} failed=${failedCount} total=${pairs.length}`);
}

main()
  .catch((error) => {
    console.error('[ERROR]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
