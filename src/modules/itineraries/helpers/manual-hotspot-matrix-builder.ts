import { PrismaService } from '../../../prisma.service';

type RouteFitType = 'ON_ROUTE' | 'MINOR_DETOUR' | 'BACKTRACK' | 'OFF_ROUTE';

type HotspotMeta = {
  id: number;
  name: string;
  location: string | null;
  lat: number;
  lng: number;
};

type MatrixEndpointType = 'HOTSPOT' | 'CITY';

type MatrixEndpoint = {
  endpointType: MatrixEndpointType;
  id: number;
  name: string;
  location: string | null;
  lat: number;
  lng: number;
  hotspotId?: number | null;
  locationId?: number | null;
};

type RouteLeg = {
  distanceKm: number;
  durationMin: number;
  coordinates: [number, number][];
};

type SlotResultRow = {
  fromHotspotId: number;
  fromName: string;
  toHotspotId: number;
  toName: string;
  slotContext?: string;
  routeFitType?: string;
  abDistanceKm?: number;
  acDistanceKm?: number;
  cbDistanceKm?: number;
  roadDetourKm?: number;
  error?: string;
};

export type ManualHotspotMatrixBuildResult = {
  success: boolean;
  planId: number;
  routeId: number;
  candidateHotspotId: number;
  candidateName: string;
  slotPairs: number;
  successCount: number;
  failedCount: number;
  rows: SlotResultRow[];
  osrmSource: string;
  publicDemoWarning: boolean;
  hasAnyMatrixData: boolean;
  hasFeasibleMatrixSlot: boolean;
  allSlotsAreOffRouteOrBacktrack: boolean;
  nextPreviewExpectedState: 'FEASIBLE_PREVIEW' | 'NO_FEASIBLE_ROUTE_SLOT';
  code?: string;
  message?: string;
  skipped?: boolean;
};

export type ManualHotspotMatrixBuildParams = {
  planId: number;
  routeId: number;
  candidateHotspotId: number;
  userId?: number;
};

export type ManualHotspotMatrixBuildOptions = {
  osrmBaseUrl?: string;
  osrmDelayMs?: number;
  osrmTimeoutMs?: number;
  destinationCrossingRadiusMeters?: number;
  destinationCrossingMaxProgressRatio?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
};

const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
const shouldLogVerboseTiming = (): boolean =>
  String(process.env.FIT_HERE_VERBOSE_TIMING || '').trim() === '1';

function toFinitePositive(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

async function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureHelperTables(prisma: PrismaService): Promise<void> {
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
      from_hotspot_name TEXT NULL,
      from_hotspot_location TEXT NULL,
      from_hotspot_id INT NOT NULL,
      to_hotspot_name TEXT NULL,
      to_hotspot_location TEXT NULL,
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
    ['from_hotspot_name', 'TEXT NULL'],
    ['from_hotspot_location', 'TEXT NULL'],
    ['to_hotspot_name', 'TEXT NULL'],
    ['to_hotspot_location', 'TEXT NULL'],
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
    ['from_endpoint_type', `VARCHAR(30) NOT NULL DEFAULT 'HOTSPOT'`],
    ['from_location_id', 'INT NULL'],
    ['from_location_name', 'TEXT NULL'],
    ['from_lat', 'DOUBLE NULL'],
    ['from_lng', 'DOUBLE NULL'],
    ['to_endpoint_type', `VARCHAR(30) NOT NULL DEFAULT 'HOTSPOT'`],
    ['to_location_id', 'INT NULL'],
    ['to_location_name', 'TEXT NULL'],
    ['to_lat', 'DOUBLE NULL'],
    ['to_lng', 'DOUBLE NULL'],
    ['slot_context', `VARCHAR(50) NOT NULL DEFAULT 'HOTSPOT_TO_HOTSPOT'`],
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

  const slotContextIndex = await prisma.$queryRawUnsafe<Array<{ index_name: string }>>(`
    SELECT INDEX_NAME AS index_name
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hotspot_route_between_map'
      AND INDEX_NAME = 'idx_hotspot_between_endpoint_context'
    LIMIT 1
  `);

  if (!slotContextIndex.length) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE hotspot_route_between_map
      ADD INDEX idx_hotspot_between_endpoint_context (slot_context)
    `);
  }
}

function hotspotToEndpoint(hotspot: HotspotMeta): MatrixEndpoint {
  return {
    endpointType: 'HOTSPOT',
    id: hotspot.id,
    hotspotId: hotspot.id,
    locationId: null,
    name: hotspot.name,
    location: hotspot.location,
    lat: hotspot.lat,
    lng: hotspot.lng,
  };
}

function endpointStorageHotspotId(endpoint: MatrixEndpoint): number {
  if (endpoint.endpointType === 'HOTSPOT') {
    return Number(endpoint.hotspotId || endpoint.id || 0);
  }

  const locationId = Number(endpoint.locationId || endpoint.id || 0);
  return locationId > 0 ? -locationId : 0;
}

async function fetchRouteCityEndpoints(params: {
  prisma: PrismaService;
  planId: number;
  routeId: number;
}): Promise<{ sourceEndpoint: MatrixEndpoint | null; destinationEndpoint: MatrixEndpoint | null }> {
  const { prisma, routeId } = params;

  const route = await prisma.dvi_itinerary_route_details.findFirst({
    where: {
      itinerary_plan_ID: Number(params.planId),
      itinerary_route_ID: Number(routeId),
      deleted: 0,
    },
    select: {
      location_id: true,
      location_name: true,
      next_visiting_location: true,
    },
  });

  const locationId = Number(route?.location_id || 0);
  if (!locationId) {
    return { sourceEndpoint: null, destinationEndpoint: null };
  }

  const storedLocationStartedAt = Date.now();
  const storedLocation = await prisma.dvi_stored_locations.findFirst({
    where: {
      location_ID: BigInt(locationId),
      deleted: 0,
      status: 1,
    },
    select: {
      location_ID: true,
      source_location: true,
      source_location_lattitude: true,
      source_location_longitude: true,
      destination_location: true,
      destination_location_lattitude: true,
      destination_location_longitude: true,
    },
  });
  if (shouldLogVerboseTiming()) {
    console.log('[StoredLocations][timing]', {
      caller: 'manual-hotspot-matrix-builder.resolveRouteCityEndpoints',
      planId: Number(params.planId),
      routeId: Number(routeId),
      locationId: String(locationId),
      elapsedMs: Date.now() - storedLocationStartedAt,
      found: !!storedLocation,
    });
  }

  if (!storedLocation) {
    return { sourceEndpoint: null, destinationEndpoint: null };
  }

  const buildEndpoint = (
    kind: 'source' | 'destination',
    fallbackName: string,
  ): MatrixEndpoint | null => {
    const name = String(
      kind === 'source'
        ? storedLocation.source_location || fallbackName
        : storedLocation.destination_location || fallbackName,
    ).trim();
    const lat = Number(
      kind === 'source'
        ? storedLocation.source_location_lattitude
        : storedLocation.destination_location_lattitude,
    );
    const lng = Number(
      kind === 'source'
        ? storedLocation.source_location_longitude
        : storedLocation.destination_location_longitude,
    );

    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      endpointType: 'CITY',
      id: Number(storedLocation.location_ID),
      locationId: Number(storedLocation.location_ID),
      hotspotId: null,
      name,
      location: name,
      lat,
      lng,
    };
  };

  const sourceEndpoint = buildEndpoint('source', String(route?.location_name || '').trim());
  const destinationEndpoint = buildEndpoint('destination', String(route?.next_visiting_location || '').trim());

  return {
    sourceEndpoint,
    destinationEndpoint: destinationEndpoint || sourceEndpoint,
  };
}

async function fetchHotspotMeta(prisma: PrismaService, ids: number[]): Promise<Map<number, HotspotMeta>> {
  const uniqueIds = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (uniqueIds.length === 0) return new Map<number, HotspotMeta>();

  const startedAt = Date.now();
  const rows = await prisma.dvi_hotspot_place.findMany({
    where: { hotspot_ID: { in: uniqueIds }, deleted: 0 },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_location: true,
      hotspot_latitude: true,
      hotspot_longitude: true,
    },
  });
  if (shouldLogVerboseTiming()) {
    console.log('[HotspotPlace][timing]', {
      caller: 'manual-hotspot-matrix-builder.fetchHotspotMeta',
      hotspotIdCount: uniqueIds.length,
      elapsedMs: Date.now() - startedAt,
      found: rows.length > 0,
      count: rows.length,
    });
  }

  const map = new Map<number, HotspotMeta>();
  for (const row of rows) {
    const id = Number((row as any).hotspot_ID || 0);
    const lat = Number((row as any).hotspot_latitude);
    const lng = Number((row as any).hotspot_longitude);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    map.set(id, {
      id,
      name: String((row as any).hotspot_name || `Hotspot #${id}`),
      location: String((row as any).hotspot_location || '').trim() || null,
      lat,
      lng,
    });
  }

  return map;
}

async function fetchOsrmRoute(params: {
  from: { id: number; lat: number; lng: number; name: string };
  to: { id: number; lat: number; lng: number; name: string };
  osrmBaseUrl: string;
  timeoutMs: number;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}): Promise<RouteLeg> {
  const { from, to, osrmBaseUrl, timeoutMs, logger } = params;
  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${osrmBaseUrl}/${coordinates}?overview=full&geometries=geojson&steps=false`;

  logger.log(`[OSRM] ${from.id}->${to.id} ${url}`);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
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
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`OSRM request timeout (${timeoutMs}ms) for ${from.id}->${to.id}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchEndpointRoute(params: {
  from: MatrixEndpoint;
  to: MatrixEndpoint;
  osrmBaseUrl: string;
  osrmTimeoutMs: number;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}): Promise<RouteLeg> {
  return fetchOsrmRoute({
    from: {
      id: Number(params.from.hotspotId || params.from.locationId || params.from.id || 0),
      lat: params.from.lat,
      lng: params.from.lng,
      name: params.from.name,
    },
    to: {
      id: Number(params.to.hotspotId || params.to.locationId || params.to.id || 0),
      lat: params.to.lat,
      lng: params.to.lng,
      name: params.to.name,
    },
    osrmBaseUrl: params.osrmBaseUrl,
    timeoutMs: params.osrmTimeoutMs,
    logger: params.logger,
  });
}

async function getCachedLeg(prisma: PrismaService, fromId: number, toId: number): Promise<RouteLeg | null> {
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
  prisma: PrismaService,
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

async function ensureLeg(params: {
  prisma: PrismaService;
  from: HotspotMeta;
  to: HotspotMeta;
  osrmBaseUrl: string;
  osrmDelayMs: number;
  osrmTimeoutMs: number;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}): Promise<RouteLeg> {
  const { prisma, from, to, osrmBaseUrl, osrmDelayMs, osrmTimeoutMs, logger } = params;

  const cached = await getCachedLeg(prisma, from.id, to.id);
  if (cached) return cached;

  try {
    const fetched = await fetchOsrmRoute({
      from,
      to,
      osrmBaseUrl,
      timeoutMs: osrmTimeoutMs,
      logger,
    });
    await upsertMatrixLeg(prisma, from, to, fetched, 'DONE', null);
    await sleep(osrmDelayMs);
    return fetched;
  } catch (error: any) {
    const message = String(error?.message || error || 'OSRM fetch failed');
    await upsertMatrixLeg(prisma, from, to, null, 'FAILED', message);
    throw new Error(`Failed to build matrix leg ${from.id}->${to.id}: ${message}`);
  }
}

async function upsertBetweenMapRow(prisma: PrismaService, params: {
  from: MatrixEndpoint;
  to: MatrixEndpoint;
  candidate: MatrixEndpoint;
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
  slotContext?: string;
}): Promise<void> {
  const p = params;
  await prisma.$executeRawUnsafe(`
    INSERT INTO hotspot_route_between_map (
      from_hotspot_name,
      from_hotspot_location,
      from_hotspot_id,
      to_hotspot_name,
      to_hotspot_location,
      to_hotspot_id,
      between_hotspot_id,
      between_hotspot_name,
      from_endpoint_type,
      from_location_id,
      from_location_name,
      from_lat,
      from_lng,
      to_endpoint_type,
      to_location_id,
      to_location_name,
      to_lat,
      to_lng,
      slot_context,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      from_hotspot_name = VALUES(from_hotspot_name),
      from_hotspot_location = VALUES(from_hotspot_location),
      to_hotspot_name = VALUES(to_hotspot_name),
      to_hotspot_location = VALUES(to_hotspot_location),
      between_hotspot_name = VALUES(between_hotspot_name),
      from_endpoint_type = VALUES(from_endpoint_type),
      from_location_id = VALUES(from_location_id),
      from_location_name = VALUES(from_location_name),
      from_lat = VALUES(from_lat),
      from_lng = VALUES(from_lng),
      to_endpoint_type = VALUES(to_endpoint_type),
      to_location_id = VALUES(to_location_id),
      to_location_name = VALUES(to_location_name),
      to_lat = VALUES(to_lat),
      to_lng = VALUES(to_lng),
      slot_context = VALUES(slot_context),
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
  p.from.name,
  p.from.location,
  endpointStorageHotspotId(p.from),
  p.to.name,
  p.to.location,
  endpointStorageHotspotId(p.to),
  Number(p.candidate.hotspotId || p.candidate.id || 0),
  p.candidate.name,
  p.from.endpointType,
  p.from.locationId ?? null,
  p.from.endpointType === 'CITY' ? p.from.name : null,
  p.from.lat,
  p.from.lng,
  p.to.endpointType,
  p.to.locationId ?? null,
  p.to.endpointType === 'CITY' ? p.to.name : null,
  p.to.lat,
  p.to.lng,
  String(p.slotContext || 'HOTSPOT_TO_HOTSPOT'),
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

type SingleCitySlot = {
  from: MatrixEndpoint;
  candidate: MatrixEndpoint;
  to: MatrixEndpoint;
  slotContext: 'CITY_TO_HOTSPOT' | 'HOTSPOT_TO_CITY' | 'CITY_TO_CITY';
};

async function buildSingleHotspotCityEndpointMatrix(params: {
  prisma: PrismaService;
  planId: number;
  routeId: number;
  candidate: MatrixEndpoint;
  existingHotspot: MatrixEndpoint;
  sourceCityEndpoint: MatrixEndpoint;
  destinationCityEndpoint: MatrixEndpoint;
  osrmBaseUrl: string;
  osrmDelayMs: number;
  osrmTimeoutMs: number;
  destinationCrossingRadiusMeters: number;
  destinationCrossingMaxProgressRatio: number;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}): Promise<ManualHotspotMatrixBuildResult & Record<string, any>> {
  const slots: SingleCitySlot[] = [
    {
      from: params.sourceCityEndpoint,
      candidate: params.candidate,
      to: params.existingHotspot,
      slotContext: 'CITY_TO_HOTSPOT',
    },
    {
      from: params.existingHotspot,
      candidate: params.candidate,
      to: params.destinationCityEndpoint,
      slotContext: 'HOTSPOT_TO_CITY',
    },
  ];

  let successCount = 0;
  let failedCount = 0;
  const rows: SlotResultRow[] = [];

  for (const slot of slots) {
    try {
      const ab = slot.from.endpointType === 'HOTSPOT' && slot.to.endpointType === 'HOTSPOT'
        ? await ensureLeg({
            prisma: params.prisma,
            from: {
              id: Number(slot.from.hotspotId || slot.from.id || 0),
              name: slot.from.name,
              location: slot.from.location,
              lat: slot.from.lat,
              lng: slot.from.lng,
            },
            to: {
              id: Number(slot.to.hotspotId || slot.to.id || 0),
              name: slot.to.name,
              location: slot.to.location,
              lat: slot.to.lat,
              lng: slot.to.lng,
            },
            osrmBaseUrl: params.osrmBaseUrl,
            osrmDelayMs: params.osrmDelayMs,
            osrmTimeoutMs: params.osrmTimeoutMs,
            logger: params.logger,
          })
        : await fetchEndpointRoute({
            from: slot.from,
            to: slot.to,
            osrmBaseUrl: params.osrmBaseUrl,
            osrmTimeoutMs: params.osrmTimeoutMs,
            logger: params.logger,
          });

      await sleep(params.osrmDelayMs);

      const ac = slot.from.endpointType === 'HOTSPOT' && slot.candidate.endpointType === 'HOTSPOT'
        ? await ensureLeg({
            prisma: params.prisma,
            from: {
              id: Number(slot.from.hotspotId || slot.from.id || 0),
              name: slot.from.name,
              location: slot.from.location,
              lat: slot.from.lat,
              lng: slot.from.lng,
            },
            to: {
              id: Number(slot.candidate.hotspotId || slot.candidate.id || 0),
              name: slot.candidate.name,
              location: slot.candidate.location,
              lat: slot.candidate.lat,
              lng: slot.candidate.lng,
            },
            osrmBaseUrl: params.osrmBaseUrl,
            osrmDelayMs: params.osrmDelayMs,
            osrmTimeoutMs: params.osrmTimeoutMs,
            logger: params.logger,
          })
        : await fetchEndpointRoute({
            from: slot.from,
            to: slot.candidate,
            osrmBaseUrl: params.osrmBaseUrl,
            osrmTimeoutMs: params.osrmTimeoutMs,
            logger: params.logger,
          });

      await sleep(params.osrmDelayMs);

      const cb = slot.candidate.endpointType === 'HOTSPOT' && slot.to.endpointType === 'HOTSPOT'
        ? await ensureLeg({
            prisma: params.prisma,
            from: {
              id: Number(slot.candidate.hotspotId || slot.candidate.id || 0),
              name: slot.candidate.name,
              location: slot.candidate.location,
              lat: slot.candidate.lat,
              lng: slot.candidate.lng,
            },
            to: {
              id: Number(slot.to.hotspotId || slot.to.id || 0),
              name: slot.to.name,
              location: slot.to.location,
              lat: slot.to.lat,
              lng: slot.to.lng,
            },
            osrmBaseUrl: params.osrmBaseUrl,
            osrmDelayMs: params.osrmDelayMs,
            osrmTimeoutMs: params.osrmTimeoutMs,
            logger: params.logger,
          })
        : await fetchEndpointRoute({
            from: slot.candidate,
            to: slot.to,
            osrmBaseUrl: params.osrmBaseUrl,
            osrmTimeoutMs: params.osrmTimeoutMs,
            logger: params.logger,
          });

      const candidateOnAb = findNearestProgressOnRoute(
        { lat: slot.candidate.lat, lng: slot.candidate.lng },
        ab.coordinates,
      );

      const destinationOnAc = findNearestProgressOnRoute(
        { lat: slot.to.lat, lng: slot.to.lng },
        ac.coordinates,
      );

      const insertedDistanceKm = ac.distanceKm + cb.distanceKm;
      const roadDetourKm = Math.max(0, insertedDistanceKm - ab.distanceKm);
      const roadDetourRatio = ab.distanceKm > 0 ? roadDetourKm / ab.distanceKm : 0;

      const crossesDestinationBeforeCandidate =
        destinationOnAc.distanceMeters <= params.destinationCrossingRadiusMeters
        && destinationOnAc.progressRatio <= params.destinationCrossingMaxProgressRatio;

      const routeFitType = classifyRouteFit({
        roadDetourKm,
        roadDetourRatio,
        candidateDistanceFromAbRouteMeters: candidateOnAb.distanceMeters,
        crossesDestinationBeforeCandidate,
      });

      const routeDecisionReason =
        `${buildDecisionReason(routeFitType)} Single-hotspot city endpoint slot: ${slot.from.name} -> ${slot.candidate.name} -> ${slot.to.name}.`;

      await upsertBetweenMapRow(params.prisma, {
        from: slot.from,
        to: slot.to,
        candidate: slot.candidate,
        ab,
        ac,
        cb,
        candidateDistanceFromAbRouteMeters: candidateOnAb.distanceMeters,
        candidateProgressOnAbRatio: candidateOnAb.progressRatio,
        destinationDistanceFromAcRouteMeters: destinationOnAc.distanceMeters,
        destinationProgressOnAcRatio: destinationOnAc.progressRatio,
        crossesDestinationBeforeCandidate,
        roadDetourKm,
        roadDetourRatio,
        routeDecisionReason,
        routeFitType,
        slotContext: slot.slotContext,
      });

      rows.push({
        fromHotspotId: Number(slot.from.hotspotId || 0),
        fromName: slot.from.name,
        toHotspotId: Number(slot.to.hotspotId || 0),
        toName: slot.to.name,
        slotContext: slot.slotContext,
        routeFitType,
        abDistanceKm: Number(ab.distanceKm.toFixed(3)),
        acDistanceKm: Number(ac.distanceKm.toFixed(3)),
        cbDistanceKm: Number(cb.distanceKm.toFixed(3)),
        roadDetourKm: Number(roadDetourKm.toFixed(3)),
      });

      successCount += 1;
    } catch (error: any) {
      failedCount += 1;
      rows.push({
        fromHotspotId: Number(slot.from.hotspotId || 0),
        fromName: slot.from.name,
        toHotspotId: Number(slot.to.hotspotId || 0),
        toName: slot.to.name,
        slotContext: slot.slotContext,
        error: error?.message || String(error),
      });
    }
  }

  const hasAnyMatrixData = successCount > 0;
  const hasFeasibleMatrixSlot = rows.some((row: any) => {
    const fit = String(row?.routeFitType || '').toUpperCase();
    return fit === 'ON_ROUTE' || fit === 'MINOR_DETOUR';
  });

  return {
    success: hasAnyMatrixData,
    skipped: false,
    code: hasAnyMatrixData
      ? 'SINGLE_HOTSPOT_CITY_MATRIX_BUILT'
      : 'SINGLE_HOTSPOT_CITY_MATRIX_FAILED',
    message: hasAnyMatrixData
      ? 'Single-hotspot matrix built using city endpoint.'
      : 'Single-hotspot city endpoint matrix failed.',
    planId: params.planId,
    routeId: params.routeId,
    candidateHotspotId: Number(params.candidate.hotspotId || params.candidate.id),
    candidateName: params.candidate.name,
    cityEndpointName: params.sourceCityEndpoint.name,
    existingHotspotName: params.existingHotspot.name,
    slotPairs: slots.length,
    successCount,
    failedCount,
    rows,
    osrmSource: params.osrmBaseUrl,
    publicDemoWarning: params.osrmBaseUrl.includes('router.project-osrm.org'),
    hasAnyMatrixData,
    hasFeasibleMatrixSlot,
    allSlotsAreOffRouteOrBacktrack: hasAnyMatrixData && !hasFeasibleMatrixSlot,
    nextPreviewExpectedState: hasFeasibleMatrixSlot ? 'FEASIBLE_PREVIEW' : 'NO_FEASIBLE_ROUTE_SLOT',
  };
}

async function buildEmptyRouteCityEndpointMatrix(params: {
  prisma: PrismaService;
  planId: number;
  routeId: number;
  candidate: MatrixEndpoint;
  sourceEndpoint: MatrixEndpoint;
  destinationEndpoint: MatrixEndpoint;
  osrmBaseUrl: string;
  osrmDelayMs: number;
  osrmTimeoutMs: number;
  destinationCrossingRadiusMeters: number;
  destinationCrossingMaxProgressRatio: number;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}): Promise<any> {
  const slot: SingleCitySlot = {
    from: params.sourceEndpoint,
    candidate: params.candidate,
    to: params.destinationEndpoint,
    slotContext: 'CITY_TO_CITY',
  };

  let successCount = 0;
  let failedCount = 0;
  const rows: SlotResultRow[] = [];

  try {
    const ab = await fetchEndpointRoute({
      from: slot.from,
      to: slot.to,
      osrmBaseUrl: params.osrmBaseUrl,
      osrmTimeoutMs: params.osrmTimeoutMs,
      logger: params.logger,
    });

    await sleep(params.osrmDelayMs);

    const ac = await fetchEndpointRoute({
      from: slot.from,
      to: slot.candidate,
      osrmBaseUrl: params.osrmBaseUrl,
      osrmTimeoutMs: params.osrmTimeoutMs,
      logger: params.logger,
    });

    await sleep(params.osrmDelayMs);

    const cb = await fetchEndpointRoute({
      from: slot.candidate,
      to: slot.to,
      osrmBaseUrl: params.osrmBaseUrl,
      osrmTimeoutMs: params.osrmTimeoutMs,
      logger: params.logger,
    });

    const candidateOnAb = findNearestProgressOnRoute(
      { lat: slot.candidate.lat, lng: slot.candidate.lng },
      ab.coordinates,
    );

    const destinationOnAc = findNearestProgressOnRoute(
      { lat: slot.to.lat, lng: slot.to.lng },
      ac.coordinates,
    );

    const insertedDistanceKm = ac.distanceKm + cb.distanceKm;
    const roadDetourKm = Math.max(0, insertedDistanceKm - ab.distanceKm);
    const roadDetourRatio = ab.distanceKm > 0 ? roadDetourKm / ab.distanceKm : 0;

    const crossesDestinationBeforeCandidate =
      destinationOnAc.distanceMeters <= params.destinationCrossingRadiusMeters
      && destinationOnAc.progressRatio <= params.destinationCrossingMaxProgressRatio;

    const routeFitType = classifyRouteFit({
      roadDetourKm,
      roadDetourRatio,
      candidateDistanceFromAbRouteMeters: candidateOnAb.distanceMeters,
      crossesDestinationBeforeCandidate,
    });

    const routeDecisionReason =
      `${buildDecisionReason(routeFitType)} Empty-route city endpoint slot: ${slot.from.name} -> ${slot.candidate.name} -> ${slot.to.name}.`;

    await upsertBetweenMapRow(params.prisma, {
      from: slot.from,
      to: slot.to,
      candidate: slot.candidate,
      ab,
      ac,
      cb,
      candidateDistanceFromAbRouteMeters: candidateOnAb.distanceMeters,
      candidateProgressOnAbRatio: candidateOnAb.progressRatio,
      destinationDistanceFromAcRouteMeters: destinationOnAc.distanceMeters,
      destinationProgressOnAcRatio: destinationOnAc.progressRatio,
      crossesDestinationBeforeCandidate,
      roadDetourKm,
      roadDetourRatio,
      routeDecisionReason,
      routeFitType,
      slotContext: slot.slotContext,
    });

    rows.push({
      fromHotspotId: endpointStorageHotspotId(slot.from),
      fromName: slot.from.name,
      toHotspotId: endpointStorageHotspotId(slot.to),
      toName: slot.to.name,
      slotContext: slot.slotContext,
      routeFitType,
      abDistanceKm: Number(ab.distanceKm.toFixed(3)),
      acDistanceKm: Number(ac.distanceKm.toFixed(3)),
      cbDistanceKm: Number(cb.distanceKm.toFixed(3)),
      roadDetourKm: Number(roadDetourKm.toFixed(3)),
    } as any);

    successCount += 1;
  } catch (error: any) {
    failedCount += 1;
    rows.push({
      fromHotspotId: endpointStorageHotspotId(slot.from),
      fromName: slot.from.name,
      toHotspotId: endpointStorageHotspotId(slot.to),
      toName: slot.to.name,
      slotContext: slot.slotContext,
      error: error?.message || String(error),
    } as any);
  }

  const hasAnyMatrixData = successCount > 0;
  const hasFeasibleMatrixSlot = rows.some((row: any) => {
    const fit = String(row?.routeFitType || '').toUpperCase();
    return fit === 'ON_ROUTE' || fit === 'MINOR_DETOUR';
  });

  return {
    success: hasAnyMatrixData,
    skipped: false,
    code: hasAnyMatrixData
      ? 'EMPTY_ROUTE_CITY_MATRIX_BUILT'
      : 'EMPTY_ROUTE_CITY_MATRIX_FAILED',
    message: hasAnyMatrixData
      ? 'Matrix built using city endpoint for first hotspot insertion.'
      : 'City endpoint matrix failed for first hotspot insertion.',
    planId: params.planId,
    routeId: params.routeId,
    candidateHotspotId: Number(params.candidate.hotspotId || params.candidate.id),
    candidateName: params.candidate.name,
    cityEndpointName: params.sourceEndpoint.name,
    slotPairs: 1,
    successCount,
    failedCount,
    rows,
    osrmSource: params.osrmBaseUrl,
    publicDemoWarning: params.osrmBaseUrl.includes('router.project-osrm.org'),
    hasAnyMatrixData,
    hasFeasibleMatrixSlot,
    allSlotsAreOffRouteOrBacktrack: hasAnyMatrixData && !hasFeasibleMatrixSlot,
    nextPreviewExpectedState: hasFeasibleMatrixSlot
      ? 'FEASIBLE_PREVIEW'
      : 'NO_FEASIBLE_ROUTE_SLOT',
  };
}

export async function buildMissingManualHotspotMatrix(params: {
  prisma: PrismaService;
  input: ManualHotspotMatrixBuildParams;
  options?: ManualHotspotMatrixBuildOptions;
}): Promise<ManualHotspotMatrixBuildResult> {
  const { prisma, input } = params;
  const opts = params.options || {};

  const planId = Number(input.planId || 0);
  const routeId = Number(input.routeId || 0);
  const candidateHotspotId = Number(input.candidateHotspotId || 0);

  if (!Number.isInteger(planId) || planId <= 0) {
    throw new Error('Invalid planId. Expected positive integer.');
  }
  if (!Number.isInteger(routeId) || routeId <= 0) {
    throw new Error('Invalid routeId. Expected positive integer.');
  }
  if (!Number.isInteger(candidateHotspotId) || candidateHotspotId <= 0) {
    throw new Error('Invalid candidateHotspotId. Expected positive integer.');
  }

  const osrmBaseUrl = String(opts.osrmBaseUrl || process.env.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL).trim();
  const osrmDelayMs = toFinitePositive(opts.osrmDelayMs ?? process.env.OSRM_DELAY_MS, 800);
  const osrmTimeoutMs = toFinitePositive(opts.osrmTimeoutMs ?? process.env.OSRM_TIMEOUT_MS, 20000);
  const destinationCrossingRadiusMeters = toFinitePositive(
    opts.destinationCrossingRadiusMeters ?? process.env.DESTINATION_CROSSING_RADIUS_METERS,
    1200,
  );
  const destinationCrossingMaxProgressRatio = toFinitePositive(
    opts.destinationCrossingMaxProgressRatio ?? process.env.DESTINATION_CROSSING_MAX_PROGRESS_RATIO,
    0.9,
  );
  const logger = opts.logger || console;

  await ensureHelperTables(prisma);

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

  const allMeta = await fetchHotspotMeta(prisma, [...routeHotspotIds, Number(candidateHotspotId)]);
  const candidate = allMeta.get(Number(candidateHotspotId));
  if (!candidate) {
    throw new Error(`Candidate hotspot ${candidateHotspotId} is missing coordinates or does not exist.`);
  }

  if (routeHotspotIds.length === 0) {
    const cityEndpoints = await fetchRouteCityEndpoints({
      prisma,
      planId: Number(planId),
      routeId: Number(routeId),
    });

    const sourceEndpoint = cityEndpoints.sourceEndpoint || cityEndpoints.destinationEndpoint;
    const destinationEndpoint = cityEndpoints.destinationEndpoint || cityEndpoints.sourceEndpoint;

    if (!sourceEndpoint || !destinationEndpoint) {
      return {
        success: false,
        skipped: true,
        code: 'CITY_ENDPOINT_NOT_FOUND_FOR_EMPTY_ROUTE_MATRIX',
        message: 'Cannot build matrix because route city endpoint was not found in dvi_stored_locations.',
        planId: Number(planId),
        routeId: Number(routeId),
        candidateHotspotId: Number(candidateHotspotId),
        activeRouteHotspotCount: routeHotspotIds.length,
      } as any;
    }

    return await buildEmptyRouteCityEndpointMatrix({
      prisma,
      planId: Number(planId),
      routeId: Number(routeId),
      candidate: hotspotToEndpoint(candidate),
      sourceEndpoint,
      destinationEndpoint,
      osrmBaseUrl,
      osrmDelayMs,
      osrmTimeoutMs,
      destinationCrossingRadiusMeters,
      destinationCrossingMaxProgressRatio,
      logger,
    });
  }

  if (routeHotspotIds.length === 1) {
    const existingHotspot = allMeta.get(Number(routeHotspotIds[0]));
    if (!existingHotspot) {
      throw new Error(`Existing route hotspot ${routeHotspotIds[0]} is missing coordinates or does not exist.`);
    }

    const cityEndpoints = await fetchRouteCityEndpoints({
      prisma,
      planId: Number(planId),
      routeId: Number(routeId),
    });

    const sourceCityEndpoint = cityEndpoints.sourceEndpoint || cityEndpoints.destinationEndpoint;
    const destinationCityEndpoint = cityEndpoints.destinationEndpoint || cityEndpoints.sourceEndpoint;

    if (!sourceCityEndpoint || !destinationCityEndpoint) {
      return {
        success: false,
        skipped: true,
        code: 'CITY_ENDPOINT_NOT_FOUND_FOR_SINGLE_HOTSPOT_MATRIX',
        message: 'Cannot build single-hotspot matrix because route city endpoint was not found in dvi_stored_locations.',
        planId: Number(planId),
        routeId: Number(routeId),
        candidateHotspotId: Number(candidateHotspotId),
        activeRouteHotspotCount: routeHotspotIds.length,
      } as any;
    }

    return await buildSingleHotspotCityEndpointMatrix({
      prisma,
      planId: Number(planId),
      routeId: Number(routeId),
      candidate: hotspotToEndpoint(candidate),
      existingHotspot: hotspotToEndpoint(existingHotspot),
      sourceCityEndpoint,
      destinationCityEndpoint,
      osrmBaseUrl,
      osrmDelayMs,
      osrmTimeoutMs,
      destinationCrossingRadiusMeters,
      destinationCrossingMaxProgressRatio,
      logger,
    });
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

  logger.log(`[MATRIX_BUILD_START] planId=${planId} routeId=${routeId} candidateHotspotId=${candidateHotspotId} (${candidate.name})`);
  logger.log(`[MATRIX_BUILD_START] slotPairs=${pairs.length} osrm=${osrmBaseUrl}`);

  let successCount = 0;
  let failedCount = 0;
  const rows: SlotResultRow[] = [];

  for (const pair of pairs) {
    try {
      const ab = await ensureLeg({ prisma, from: pair.from, to: pair.to, osrmBaseUrl, osrmDelayMs, osrmTimeoutMs, logger });
      const ac = await ensureLeg({ prisma, from: pair.from, to: candidate, osrmBaseUrl, osrmDelayMs, osrmTimeoutMs, logger });
      const cb = await ensureLeg({ prisma, from: candidate, to: pair.to, osrmBaseUrl, osrmDelayMs, osrmTimeoutMs, logger });

      const candidateOnAb = findNearestProgressOnRoute({ lat: candidate.lat, lng: candidate.lng }, ab.coordinates);
      const destinationOnAc = findNearestProgressOnRoute({ lat: pair.to.lat, lng: pair.to.lng }, ac.coordinates);

      const insertedDistanceKm = ac.distanceKm + cb.distanceKm;
      const roadDetourKm = Math.max(0, insertedDistanceKm - ab.distanceKm);
      const roadDetourRatio = ab.distanceKm > 0 ? roadDetourKm / ab.distanceKm : 0;
      const crossesDestinationBeforeCandidate =
        destinationOnAc.distanceMeters <= destinationCrossingRadiusMeters
        && destinationOnAc.progressRatio < destinationCrossingMaxProgressRatio;

      const routeFitType = classifyRouteFit({
        roadDetourKm,
        roadDetourRatio,
        candidateDistanceFromAbRouteMeters: candidateOnAb.distanceMeters,
        crossesDestinationBeforeCandidate,
      });

      const routeDecisionReason = buildDecisionReason(routeFitType);

      await upsertBetweenMapRow(prisma, {
        from: hotspotToEndpoint(pair.from),
        to: hotspotToEndpoint(pair.to),
        candidate: hotspotToEndpoint(candidate),
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
        slotContext: 'HOTSPOT_TO_HOTSPOT',
      });

      successCount += 1;
      rows.push({
        fromHotspotId: pair.from.id,
        fromName: pair.from.name,
        toHotspotId: pair.to.id,
        toName: pair.to.name,
        routeFitType,
        abDistanceKm: Number(ab.distanceKm.toFixed(3)),
        acDistanceKm: Number(ac.distanceKm.toFixed(3)),
        cbDistanceKm: Number(cb.distanceKm.toFixed(3)),
        roadDetourKm: Number(roadDetourKm.toFixed(3)),
      });

      logger.log(
        `[MATRIX_BUILD_OK] ${pair.from.name} -> ${pair.to.name} | fit=${routeFitType} | AB=${ab.distanceKm.toFixed(2)}km AC=${ac.distanceKm.toFixed(2)}km CB=${cb.distanceKm.toFixed(2)}km detour=${roadDetourKm.toFixed(2)}km`,
      );
    } catch (error: any) {
      failedCount += 1;
      const errorMsg = String(error?.message || error || 'Unknown matrix build error');
      rows.push({
        fromHotspotId: pair.from.id,
        fromName: pair.from.name,
        toHotspotId: pair.to.id,
        toName: pair.to.name,
        error: errorMsg,
      });
      logger.error(`[MATRIX_BUILD_FAIL] ${pair.from.name} -> ${pair.to.name}: ${errorMsg}`);
    }
  }

  logger.log(`[MATRIX_BUILD_DONE] success=${successCount} failed=${failedCount} total=${pairs.length}`);

  const hasFeasibleMatrixSlot = rows.some((row) =>
    ['ON_ROUTE', 'MINOR_DETOUR'].includes(String(row.routeFitType || '').toUpperCase())
  );

  return {
    success: failedCount === 0,
    planId,
    routeId,
    candidateHotspotId,
    candidateName: candidate.name,
    slotPairs: pairs.length,
    successCount,
    failedCount,
    rows,
    osrmSource: osrmBaseUrl,
    publicDemoWarning: osrmBaseUrl.includes('router.project-osrm.org'),
    hasAnyMatrixData: successCount > 0,
    hasFeasibleMatrixSlot,
    allSlotsAreOffRouteOrBacktrack: successCount > 0 && !hasFeasibleMatrixSlot,
    nextPreviewExpectedState: hasFeasibleMatrixSlot
      ? 'FEASIBLE_PREVIEW'
      : 'NO_FEASIBLE_ROUTE_SLOT',
  };
}
