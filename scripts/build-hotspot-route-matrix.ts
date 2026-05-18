import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type ProcessStatus = 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
type RouteFitType = 'ON_ROUTE' | 'MINOR_DETOUR' | 'BACKTRACK' | 'OFF_ROUTE';

type RawArgs = Record<string, string | boolean>;

type InputArgs = {
  apply: boolean;
  retryFailed: boolean;
  rebuildDone: boolean;
  limit: number;
};

type Config = {
  osrmBaseUrl: string;
  osrmDelayMs: number;
  maxPairHaversineKm: number;
  maxNearRouteMeters: number;
  maxInsertDetourKm: number;
  maxInsertDetourRatio: number;
  batchLimit: number;
  hotspotNameFilter?: string;
  fromHotspotId?: number;
  toHotspotId?: number;
  betweenHotspotId?: number;
  destinationCrossingRadiusMeters: number;
  destinationCrossingMaxProgressRatio: number;
};

type Hotspot = {
  id: number;
  name: string;
  lat: number;
  lng: number;
};

type Pair = {
  from: Hotspot;
  to: Hotspot;
};

type OsrmRoute = {
  distanceKm: number;
  durationMin: number;
  coordinates: [number, number][];
};

type BetweenCandidate = {
  fromHotspotId: number;
  toHotspotId: number;
  betweenHotspotId: number;
  betweenHotspotName: string;
  distanceFromRouteMeters: number;
  roadDetourKm: number;
  roadDetourRatio: number;
  acOsrmDistanceKm: number;
  cbOsrmDistanceKm: number;
  abOsrmDistanceKm: number;
  insertedRouteDistanceKm: number;
  candidateProgressOnAbRatio: number;
  destinationProgressOnAcRatio: number;
  candidateDistanceFromAbRouteMeters: number;
  destinationDistanceFromAcRouteMeters: number;
  crossesDestinationBeforeCandidate: boolean;
  routeDecisionReason: string;
  routeFitType: RouteFitType;
};

type ExistingStatusRow = {
  from_hotspot_id: number;
  to_hotspot_id: number;
  process_status: ProcessStatus;
};

type RunSummary = {
  mode: 'dry-run' | 'apply';
  retryFailed: boolean;
  rebuildDone: boolean;
  eligibleHotspots: number;
  candidatePairsScanned: number;
  queuedPairs: number;
  skippedExistingDone: number;
  skippedExistingFailed: number;
  processed: number;
  done: number;
  skippedDistance: number;
  failed: number;
  pendingMarked: number;
  onRouteRowsInserted: number;
  minorDetourRowsInserted: number;
  osrmCalls: number;
  startedAt: string;
  completedAt?: string;
};

function usage() {
  console.log('Usage: npx tsx scripts/build-hotspot-route-matrix.ts [options]');
  console.log('');
  console.log('Builds hotspot pair route matrix and between-hotspot feasibility map.');
  console.log('');
  console.log('Default mode is DRY RUN (no matrix/map writes).');
  console.log('');
  console.log('Options:');
  console.log('  --apply             Enable DB writes for matrix and between-map rows.');
  console.log('  --retry-failed      Reprocess rows that are currently FAILED.');
  console.log('  --rebuild-done      Reprocess rows that are already DONE.');
  console.log('  --limit <n>         Override BATCH_LIMIT for this run.');
  console.log('  --limit=<n>         Same as above.');
  console.log('  --help              Show help text.');
  console.log('');
  console.log('Environment controls:');
  console.log('  OSRM_BASE_URL (default: http://localhost:5000/route/v1/driving)');
  console.log('  OSRM_DELAY_MS (default: 1500)');
  console.log('  MAX_PAIR_HAVERSINE_KM (default: 50)');
  console.log('  MAX_NEAR_ROUTE_METERS (default: 1500)');
  console.log('  MAX_INSERT_DETOUR_KM (default: 5)');
  console.log('  MAX_INSERT_DETOUR_RATIO (default: 0.25)');
  console.log('  BATCH_LIMIT (default: 100)');
  console.log('  HOTSPOT_NAME_FILTER (optional, case-insensitive contains filter)');
  console.log('  FROM_HOTSPOT_ID (optional integer)');
  console.log('  TO_HOTSPOT_ID (optional integer)');
  console.log('  BETWEEN_HOTSPOT_ID (optional integer to narrow candidate C)');
  console.log('  DESTINATION_CROSSING_RADIUS_METERS (default: 1200)');
  console.log('  DESTINATION_CROSSING_MAX_PROGRESS_RATIO (default: 0.90)');
}

function parseArgs(argv: string[]): RawArgs {
  const out: RawArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    if (token.includes('=')) {
      const [key, value] = token.slice(2).split('=', 2);
      out[key] = value ?? true;
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }

    out[key] = next;
    index += 1;
  }

  return out;
}

function toNumberOrDefault(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number value: ${raw}`);
  }
  return value;
}

function toOptionalInt(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected positive integer, got: ${raw}`);
  }
  return value;
}

function buildConfig(): Config {
  const config: Config = {
    osrmBaseUrl: process.env.OSRM_BASE_URL?.trim() || 'http://localhost:5000/route/v1/driving',
    osrmDelayMs: toNumberOrDefault(process.env.OSRM_DELAY_MS, 1500),
    maxPairHaversineKm: toNumberOrDefault(process.env.MAX_PAIR_HAVERSINE_KM, 50),
    maxNearRouteMeters: toNumberOrDefault(process.env.MAX_NEAR_ROUTE_METERS, 1500),
    maxInsertDetourKm: toNumberOrDefault(process.env.MAX_INSERT_DETOUR_KM, 5),
    maxInsertDetourRatio: toNumberOrDefault(process.env.MAX_INSERT_DETOUR_RATIO, 0.25),
    batchLimit: toNumberOrDefault(process.env.BATCH_LIMIT, 100),
    hotspotNameFilter: process.env.HOTSPOT_NAME_FILTER?.trim() || undefined,
    fromHotspotId: toOptionalInt(process.env.FROM_HOTSPOT_ID),
    toHotspotId: toOptionalInt(process.env.TO_HOTSPOT_ID),
    betweenHotspotId: toOptionalInt(process.env.BETWEEN_HOTSPOT_ID),
    destinationCrossingRadiusMeters: toNumberOrDefault(process.env.DESTINATION_CROSSING_RADIUS_METERS, 1200),
    destinationCrossingMaxProgressRatio: toNumberOrDefault(process.env.DESTINATION_CROSSING_MAX_PROGRESS_RATIO, 0.90),
  };

  if (!Number.isInteger(config.osrmDelayMs) || config.osrmDelayMs < 0) {
    throw new Error('OSRM_DELAY_MS must be a non-negative integer.');
  }

  if (!Number.isInteger(config.batchLimit) || config.batchLimit <= 0) {
    throw new Error('BATCH_LIMIT must be a positive integer.');
  }

  if (config.maxPairHaversineKm <= 0) {
    throw new Error('MAX_PAIR_HAVERSINE_KM must be > 0.');
  }

  if (config.maxNearRouteMeters <= 0) {
    throw new Error('MAX_NEAR_ROUTE_METERS must be > 0.');
  }

  if (config.maxInsertDetourKm < 0) {
    throw new Error('MAX_INSERT_DETOUR_KM must be >= 0.');
  }

  if (config.maxInsertDetourRatio < 0) {
    throw new Error('MAX_INSERT_DETOUR_RATIO must be >= 0.');
  }

  if (config.destinationCrossingRadiusMeters <= 0) {
    throw new Error('DESTINATION_CROSSING_RADIUS_METERS must be > 0.');
  }

  if (config.destinationCrossingMaxProgressRatio <= 0 || config.destinationCrossingMaxProgressRatio >= 1) {
    throw new Error('DESTINATION_CROSSING_MAX_PROGRESS_RATIO must be > 0 and < 1.');
  }

  return config;
}

function normalizeArgs(raw: RawArgs, config: Config): InputArgs {
  const apply = Boolean(raw.apply);
  const retryFailed = Boolean(raw['retry-failed']);
  const rebuildDone = Boolean(raw['rebuild-done']);

  const limitValue = raw.limit;
  const limit =
    typeof limitValue === 'string' && limitValue.trim() !== ''
      ? Number(limitValue)
      : config.batchLimit;

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Invalid --limit. It must be a positive integer.');
  }

  return {
    apply,
    retryFailed,
    rebuildDone,
    limit,
  };
}

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseCoordinate(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusKm = 6371;

  const dLat = degToRad(lat2 - lat1);
  const dLng = degToRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function projectToMeters(lat: number, lng: number, refLat: number): { x: number; y: number } {
  const earthRadiusMeters = 6371000;
  const x = degToRad(lng) * earthRadiusMeters * Math.cos(degToRad(refLat));
  const y = degToRad(lat) * earthRadiusMeters;
  return { x, y };
}

function pointToSegmentDistanceMeters(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;

  const vv = vx * vx + vy * vy;
  if (vv === 0) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
  const projX = a.x + t * vx;
  const projY = a.y + t * vy;

  const dx = p.x - projX;
  const dy = p.y - projY;
  return Math.sqrt(dx * dx + dy * dy);
}

function shortestDistancePointToPolylineMeters(
  pointLat: number,
  pointLng: number,
  polyline: [number, number][],
): number {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) {
    return haversineKm(pointLat, pointLng, polyline[0][1], polyline[0][0]) * 1000;
  }

  const refLat = pointLat;
  const p = projectToMeters(pointLat, pointLng, refLat);
  let best = Number.POSITIVE_INFINITY;

  for (let index = 0; index < polyline.length - 1; index += 1) {
    const a = projectToMeters(polyline[index][1], polyline[index][0], refLat);
    const b = projectToMeters(polyline[index + 1][1], polyline[index + 1][0], refLat);
    const distance = pointToSegmentDistanceMeters(p, a, b);
    if (distance < best) {
      best = distance;
    }
  }

  return best;
}

function classifyRouteFit(
  distanceFromRouteMeters: number,
  roadDetourKm: number,
  roadDetourRatio: number,
  config: Config,
): RouteFitType {
  if (distanceFromRouteMeters > config.maxNearRouteMeters * 2) {
    return 'OFF_ROUTE';
  }

  if (distanceFromRouteMeters <= config.maxNearRouteMeters && roadDetourKm <= 3 && roadDetourRatio <= 0.15) {
    return 'ON_ROUTE';
  }

  if (
    distanceFromRouteMeters <= config.maxNearRouteMeters * 2 &&
    roadDetourKm <= config.maxInsertDetourKm &&
    roadDetourRatio <= config.maxInsertDetourRatio
  ) {
    return 'MINOR_DETOUR';
  }

  return 'OFF_ROUTE';
}

function pairKey(fromId: number, toId: number): string {
  return `${fromId}:${toId}`;
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

  const routeFitTypeColumn = await prisma.$queryRaw<Array<{ data_type: string; column_type: string }>>(Prisma.sql`
    SELECT DATA_TYPE AS data_type, COLUMN_TYPE AS column_type
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hotspot_route_between_map'
      AND COLUMN_NAME = 'route_fit_type'
    LIMIT 1
  `);

  if (routeFitTypeColumn.length && routeFitTypeColumn[0].data_type.toLowerCase() === 'enum') {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE hotspot_route_between_map
      MODIFY COLUMN route_fit_type VARCHAR(40) NOT NULL
    `);
  }

  const columnsToEnsure = [
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
  ] as const;

  for (const [columnName, columnDefinition] of columnsToEnsure) {
    const existing = await prisma.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
      SELECT COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'hotspot_route_between_map'
        AND COLUMN_NAME = ${columnName}
      LIMIT 1
    `);

    if (!existing.length) {
      await prisma.$executeRawUnsafe(`ALTER TABLE hotspot_route_between_map ADD COLUMN ${columnName} ${columnDefinition}`);
    }
  }
}

async function fetchHotspots(config: Config): Promise<Hotspot[]> {
  const rows = await prisma.dvi_hotspot_place.findMany({
    where: { deleted: 0 },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_latitude: true,
      hotspot_longitude: true,
    },
    orderBy: { hotspot_ID: 'asc' },
  });

  const normalized: Hotspot[] = [];

  for (const row of rows) {
    const lat = parseCoordinate(row.hotspot_latitude);
    const lng = parseCoordinate(row.hotspot_longitude);
    if (lat === null || lng === null) continue;

    const name = normalizeName(row.hotspot_name) || `Hotspot-${row.hotspot_ID}`;
    if (config.hotspotNameFilter) {
      const needle = config.hotspotNameFilter.toLowerCase();
      if (!name.toLowerCase().includes(needle)) {
        continue;
      }
    }

    normalized.push({
      id: row.hotspot_ID,
      name,
      lat,
      lng,
    });
  }

  return normalized;
}

async function loadExistingStatuses(config: Config, hotspotIds: number[]): Promise<Map<string, ProcessStatus>> {
  if (!hotspotIds.length) return new Map<string, ProcessStatus>();

  let whereClause = Prisma.sql`WHERE from_hotspot_id IN (${Prisma.join(hotspotIds)}) AND to_hotspot_id IN (${Prisma.join(hotspotIds)})`;

  if (config.fromHotspotId) {
    whereClause = Prisma.sql`${whereClause} AND from_hotspot_id = ${config.fromHotspotId}`;
  }

  if (config.toHotspotId) {
    whereClause = Prisma.sql`${whereClause} AND to_hotspot_id = ${config.toHotspotId}`;
  }

  const rows = await prisma.$queryRaw<ExistingStatusRow[]>(Prisma.sql`
    SELECT from_hotspot_id, to_hotspot_id, process_status
    FROM hotspot_route_matrix
    ${whereClause}
  `);

  const map = new Map<string, ProcessStatus>();
  for (const row of rows) {
    map.set(pairKey(row.from_hotspot_id, row.to_hotspot_id), row.process_status);
  }

  return map;
}

function selectPairs(
  hotspots: Hotspot[],
  statuses: Map<string, ProcessStatus>,
  input: InputArgs,
  config: Config,
  summary: RunSummary,
): Pair[] {
  const selected: Pair[] = [];

  for (const from of hotspots) {
    if (config.fromHotspotId && from.id !== config.fromHotspotId) continue;

    for (const to of hotspots) {
      if (from.id === to.id) continue;
      if (config.toHotspotId && to.id !== config.toHotspotId) continue;

      summary.candidatePairsScanned += 1;

      const status = statuses.get(pairKey(from.id, to.id));
      if (status === 'DONE' && !input.rebuildDone) {
        summary.skippedExistingDone += 1;
        continue;
      }

      if (status === 'FAILED' && !input.retryFailed) {
        summary.skippedExistingFailed += 1;
        continue;
      }

      selected.push({ from, to });
      if (selected.length >= input.limit) {
        return selected;
      }
    }
  }

  return selected;
}

async function upsertRouteMatrixStatus(
  pair: Pair,
  payload: {
    haversineKm: number;
    processStatus: ProcessStatus;
    osrmDistanceKm?: number | null;
    osrmDurationMin?: number | null;
    routeCoordinatesJson?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  await prisma.$executeRaw`
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
    ) VALUES (
      ${pair.from.id},
      ${pair.to.id},
      ${pair.from.name},
      ${pair.to.name},
      ${pair.from.lat},
      ${pair.from.lng},
      ${pair.to.lat},
      ${pair.to.lng},
      ${payload.haversineKm},
      ${payload.osrmDistanceKm ?? null},
      ${payload.osrmDurationMin ?? null},
      ${payload.routeCoordinatesJson ?? null},
      ${payload.processStatus},
      ${payload.errorMessage ?? null},
      NOW(),
      NOW()
    )
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
  `;
}

type RouteMatrixLeg = {
  osrmDistanceKm: number;
  osrmDurationMin: number | null;
  coordinates: [number, number][];
};

type ProgressOnRoute = {
  distanceMeters: number;
  progressMeters: number;
  progressRatio: number;
  segmentIndex: number;
};

async function getRouteMatrixLeg(fromHotspotId: number, toHotspotId: number): Promise<RouteMatrixLeg | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      osrm_distance_km: number | null;
      osrm_duration_min: number | null;
      route_coordinates: string | null;
    }>
  >(Prisma.sql`
    SELECT osrm_distance_km, osrm_duration_min, route_coordinates
    FROM hotspot_route_matrix
    WHERE from_hotspot_id = ${fromHotspotId}
      AND to_hotspot_id = ${toHotspotId}
      AND process_status = 'DONE'
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  const row = rows[0];
  if (!row || typeof row.osrm_distance_km !== 'number' || !Number.isFinite(row.osrm_distance_km)) {
    return null;
  }

  let coordinates: [number, number][] = [];
  if (row.route_coordinates) {
    try {
      const parsed = JSON.parse(row.route_coordinates) as unknown;
      if (Array.isArray(parsed)) {
        coordinates = parsed.filter(
          (item): item is [number, number] =>
            Array.isArray(item) && item.length === 2 && Number.isFinite(item[0]) && Number.isFinite(item[1]),
        );
      }
    } catch {
      coordinates = [];
    }
  }

  return {
    osrmDistanceKm: row.osrm_distance_km,
    osrmDurationMin: row.osrm_duration_min,
    coordinates,
  };
}

async function ensureRouteLeg(
  from: Hotspot,
  to: Hotspot,
  config: Config,
  input: InputArgs,
  summary: RunSummary,
  requireCoordinates: boolean,
): Promise<RouteMatrixLeg> {
  const cached = await getRouteMatrixLeg(from.id, to.id);
  if (cached && (!requireCoordinates || cached.coordinates.length > 1)) {
    return cached;
  }

  if (!input.apply) {
    throw new Error(`Missing stored route leg for ${from.id}->${to.id} in dry-run mode.`);
  }

  const pair: Pair = { from, to };
  const haversineKmValue = haversineKm(from.lat, from.lng, to.lat, to.lng);

  await upsertRouteMatrixStatus(pair, {
    haversineKm: Number(haversineKmValue.toFixed(6)),
    processStatus: 'PENDING',
  });
  summary.pendingMarked += 1;

  const route = await fetchOsrmRouteWithRetry(pair, config, summary);

  await upsertRouteMatrixStatus(pair, {
    haversineKm: Number(haversineKmValue.toFixed(6)),
    processStatus: 'DONE',
    osrmDistanceKm: route.distanceKm,
    osrmDurationMin: route.durationMin,
    routeCoordinatesJson: JSON.stringify(route.coordinates),
    errorMessage: null,
  });

  console.log(`LEG DONE ${from.id}->${to.id} distance=${route.distanceKm.toFixed(2)}km duration=${route.durationMin.toFixed(1)}min`);

  return {
    osrmDistanceKm: route.distanceKm,
    osrmDurationMin: route.durationMin,
    coordinates: route.coordinates,
  };
}

function findNearestProgressOnRoute(point: { lat: number; lng: number }, coordinates: [number, number][]): ProgressOnRoute {
  if (!coordinates.length) {
    return {
      distanceMeters: Number.POSITIVE_INFINITY,
      progressMeters: 0,
      progressRatio: 0,
      segmentIndex: -1,
    };
  }

  if (coordinates.length === 1) {
    const distanceMeters = haversineKm(point.lat, point.lng, coordinates[0][1], coordinates[0][0]) * 1000;
    return {
      distanceMeters,
      progressMeters: 0,
      progressRatio: 0,
      segmentIndex: 0,
    };
  }

  let bestDistanceMeters = Number.POSITIVE_INFINITY;
  let bestProgressMeters = 0;
  let bestSegmentIndex = -1;
  let cumulativeMeters = 0;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const aLng = coordinates[index][0];
    const aLat = coordinates[index][1];
    const bLng = coordinates[index + 1][0];
    const bLat = coordinates[index + 1][1];

    const segmentLengthMeters = haversineKm(aLat, aLng, bLat, bLng) * 1000;
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
      bestProgressMeters = cumulativeMeters + segmentLengthMeters * t;
      bestSegmentIndex = index;
    }

    cumulativeMeters += segmentLengthMeters;
  }

  const totalLengthMeters = cumulativeMeters;

  return {
    distanceMeters: bestDistanceMeters,
    progressMeters: bestProgressMeters,
    progressRatio: totalLengthMeters > 0 ? bestProgressMeters / totalLengthMeters : 0,
    segmentIndex: bestSegmentIndex,
  };
}

function detectBacktrackByRouteOrder(
  destinationPoint: { lat: number; lng: number },
  routeAcCoordinates: [number, number][],
  config: Config,
): {
  crossesDestinationBeforeCandidate: boolean;
  destinationProgressOnAcRatio: number;
  destinationDistanceFromAcRouteMeters: number;
} {
  const bOnAc = findNearestProgressOnRoute(destinationPoint, routeAcCoordinates);
  const crossesDestinationBeforeCandidate =
    bOnAc.distanceMeters <= config.destinationCrossingRadiusMeters &&
    bOnAc.progressRatio < config.destinationCrossingMaxProgressRatio;

  return {
    crossesDestinationBeforeCandidate,
    destinationProgressOnAcRatio: bOnAc.progressRatio,
    destinationDistanceFromAcRouteMeters: bOnAc.distanceMeters,
  };
}

async function replaceBetweenMapRows(
  pair: Pair,
  rows: BetweenCandidate[],
  scopedBetweenHotspotId?: number,
): Promise<{ onRouteInserted: number; minorDetourInserted: number }> {
  if (scopedBetweenHotspotId) {
    await prisma.$executeRaw`
      DELETE FROM hotspot_route_between_map
      WHERE from_hotspot_id = ${pair.from.id}
        AND to_hotspot_id = ${pair.to.id}
        AND between_hotspot_id = ${scopedBetweenHotspotId}
    `;
  } else {
    await prisma.$executeRaw`
      DELETE FROM hotspot_route_between_map
      WHERE from_hotspot_id = ${pair.from.id} AND to_hotspot_id = ${pair.to.id}
    `;
  }

  let onRouteInserted = 0;
  let minorDetourInserted = 0;

  for (const row of rows) {
    await prisma.$executeRaw`
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
      ) VALUES (
        ${row.fromHotspotId},
        ${row.toHotspotId},
        ${row.betweenHotspotId},
        ${row.betweenHotspotName},
        ${row.distanceFromRouteMeters},
        ${row.candidateDistanceFromAbRouteMeters},
        ${row.candidateProgressOnAbRatio},
        ${row.destinationDistanceFromAcRouteMeters},
        ${row.destinationProgressOnAcRatio},
        ${row.crossesDestinationBeforeCandidate ? 1 : 0},
        ${row.abOsrmDistanceKm},
        ${row.acOsrmDistanceKm},
        ${row.cbOsrmDistanceKm},
        ${row.insertedRouteDistanceKm},
        ${row.roadDetourKm},
        ${row.roadDetourRatio},
        ${row.routeDecisionReason},
        ${row.routeFitType},
        NOW(),
        NOW()
      )
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
    `;

    if (row.routeFitType === 'ON_ROUTE') {
      onRouteInserted += 1;
    } else if (row.routeFitType === 'MINOR_DETOUR') {
      minorDetourInserted += 1;
    }
  }

  return { onRouteInserted, minorDetourInserted };
}

function buildOsrmUrl(baseUrl: string, from: Hotspot, to: Hotspot): string {
  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const query = 'overview=full&geometries=geojson&steps=false';
  return `${baseUrl}/${coordinates}?${query}`;
}

async function fetchOsrmRouteWithRetry(
  pair: Pair,
  config: Config,
  summary: RunSummary,
): Promise<OsrmRoute> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await sleep(config.osrmDelayMs);
    summary.osrmCalls += 1;

    const url = buildOsrmUrl(config.osrmBaseUrl, pair.from, pair.to);
    const response = await fetch(url);

    if (!response.ok) {
      const isRetriable = response.status === 429 || response.status >= 500;
      const body = await response.text();

      if (isRetriable && attempt < maxAttempts) {
        const backoffMs = Math.pow(2, attempt - 1) * 1000;
        console.warn(
          `OSRM retry for pair ${pair.from.id}->${pair.to.id}, attempt ${attempt}/${maxAttempts}, status=${response.status}, backoff=${backoffMs}ms`,
        );
        await sleep(backoffMs);
        continue;
      }

      throw new Error(
        `OSRM failed for ${pair.from.id}->${pair.to.id}. status=${response.status}, body=${body.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: [number, number][] };
      }>;
      message?: string;
    };

    const route = payload.routes?.[0];
    const coordinates = route?.geometry?.coordinates;

    if (!route || !coordinates || !coordinates.length) {
      throw new Error(
        `OSRM route missing for ${pair.from.id}->${pair.to.id}. code=${payload.code ?? 'unknown'} message=${
          payload.message ?? 'n/a'
        }`,
      );
    }

    return {
      distanceKm: Number(((route.distance ?? 0) / 1000).toFixed(6)),
      durationMin: Number(((route.duration ?? 0) / 60).toFixed(6)),
      coordinates,
    };
  }

  throw new Error(`OSRM retry exhausted for ${pair.from.id}->${pair.to.id}`);
}

async function evaluateBetweenHotspots(
  pair: Pair,
  route: OsrmRoute,
  hotspots: Hotspot[],
  config: Config,
  input: InputArgs,
  summary: RunSummary,
): Promise<BetweenCandidate[]> {
  const rows: BetweenCandidate[] = [];

  const abOsrmDistanceKm = route.distanceKm;

  for (const candidate of hotspots) {
    if (candidate.id === pair.from.id || candidate.id === pair.to.id) {
      continue;
    }

    if (config.betweenHotspotId && candidate.id !== config.betweenHotspotId) {
      continue;
    }

    const candidateOnAb = findNearestProgressOnRoute(
      { lat: candidate.lat, lng: candidate.lng },
      route.coordinates,
    );

    let acLeg: RouteMatrixLeg;
    let cbLeg: RouteMatrixLeg;

    try {
      acLeg = await ensureRouteLeg(pair.from, candidate, config, input, summary, true);
      cbLeg = await ensureRouteLeg(candidate, pair.to, config, input, summary, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Skipping candidate ${candidate.id} for ${pair.from.id}->${pair.to.id} because leg resolution failed: ${message}`,
      );
      continue;
    }

    const insertedRouteDistanceKm = acLeg.osrmDistanceKm + cbLeg.osrmDistanceKm;
    const roadDetourKm = Math.max(0, insertedRouteDistanceKm - abOsrmDistanceKm);
    const roadDetourRatio = abOsrmDistanceKm > 0 ? roadDetourKm / abOsrmDistanceKm : Number.POSITIVE_INFINITY;

    const backtrack = detectBacktrackByRouteOrder({ lat: pair.to.lat, lng: pair.to.lng }, acLeg.coordinates, config);

    let routeFitType: RouteFitType;
    let routeDecisionReason: string;

    if (backtrack.crossesDestinationBeforeCandidate) {
      routeFitType = 'BACKTRACK';
      routeDecisionReason =
        'Route to candidate crosses destination before candidate; candidate is after destination.';
    } else if (roadDetourKm > config.maxInsertDetourKm || roadDetourRatio > config.maxInsertDetourRatio) {
      routeFitType = 'OFF_ROUTE';
      routeDecisionReason = 'Candidate adds too much road detour.';
    } else if (
      candidateOnAb.distanceMeters <= config.maxNearRouteMeters &&
      roadDetourKm <= 3 &&
      roadDetourRatio <= 0.15
    ) {
      routeFitType = 'ON_ROUTE';
      routeDecisionReason = 'Candidate is near AB route and has minimal road detour.';
    } else if (
      candidateOnAb.distanceMeters <= config.maxNearRouteMeters * 2 &&
      roadDetourKm <= config.maxInsertDetourKm &&
      roadDetourRatio <= config.maxInsertDetourRatio
    ) {
      routeFitType = 'MINOR_DETOUR';
      routeDecisionReason = 'Candidate is near AB route with acceptable road detour.';
    } else {
      routeFitType = 'OFF_ROUTE';
      routeDecisionReason = 'Candidate is too far from route corridor or detour constraints.';
    }

    if (config.betweenHotspotId && candidate.id === config.betweenHotspotId) {
      console.log(
        `CANDIDATE ${pair.from.id}->${candidate.id}->${pair.to.id} fit=${routeFitType} distance_from_ab=${candidateOnAb.distanceMeters.toFixed(
          3,
        )} ac=${acLeg.osrmDistanceKm.toFixed(4)} cb=${cbLeg.osrmDistanceKm.toFixed(4)} ab=${abOsrmDistanceKm.toFixed(
          4,
        )} inserted=${insertedRouteDistanceKm.toFixed(4)} road_detour_km=${roadDetourKm.toFixed(6)} road_detour_ratio=${roadDetourRatio.toFixed(
          6,
        )} destination_on_ac_distance=${backtrack.destinationDistanceFromAcRouteMeters.toFixed(
          3,
        )} destination_on_ac_ratio=${backtrack.destinationProgressOnAcRatio.toFixed(6)} crosses_destination_before_candidate=${
          backtrack.crossesDestinationBeforeCandidate
        } reason=${routeDecisionReason}`,
      );
    }

    rows.push({
      fromHotspotId: pair.from.id,
      toHotspotId: pair.to.id,
      betweenHotspotId: candidate.id,
      betweenHotspotName: candidate.name,
      distanceFromRouteMeters: Number(candidateOnAb.distanceMeters.toFixed(3)),
      roadDetourKm: Number(roadDetourKm.toFixed(6)),
      roadDetourRatio: Number(roadDetourRatio.toFixed(6)),
      acOsrmDistanceKm: Number(acLeg.osrmDistanceKm.toFixed(6)),
      cbOsrmDistanceKm: Number(cbLeg.osrmDistanceKm.toFixed(6)),
      abOsrmDistanceKm: Number(abOsrmDistanceKm.toFixed(6)),
      insertedRouteDistanceKm: Number(insertedRouteDistanceKm.toFixed(6)),
      candidateProgressOnAbRatio: Number(candidateOnAb.progressRatio.toFixed(6)),
      destinationProgressOnAcRatio: Number(backtrack.destinationProgressOnAcRatio.toFixed(6)),
      candidateDistanceFromAbRouteMeters: Number(candidateOnAb.distanceMeters.toFixed(3)),
      destinationDistanceFromAcRouteMeters: Number(backtrack.destinationDistanceFromAcRouteMeters.toFixed(3)),
      crossesDestinationBeforeCandidate: backtrack.crossesDestinationBeforeCandidate,
      routeDecisionReason,
      routeFitType,
    });
  }

  return rows;
}

function printConfig(input: InputArgs, config: Config) {
  console.log(
    JSON.stringify(
      {
        mode: input.apply ? 'apply' : 'dry-run',
        retryFailed: input.retryFailed,
        rebuildDone: input.rebuildDone,
        limit: input.limit,
        env: {
          osrmBaseUrl: config.osrmBaseUrl,
          osrmDelayMs: config.osrmDelayMs,
          maxPairHaversineKm: config.maxPairHaversineKm,
          maxNearRouteMeters: config.maxNearRouteMeters,
          maxInsertDetourKm: config.maxInsertDetourKm,
          maxInsertDetourRatio: config.maxInsertDetourRatio,
          batchLimit: config.batchLimit,
          hotspotNameFilter: config.hotspotNameFilter ?? null,
          fromHotspotId: config.fromHotspotId ?? null,
          toHotspotId: config.toHotspotId ?? null,
          betweenHotspotId: config.betweenHotspotId ?? null,
          destinationCrossingRadiusMeters: config.destinationCrossingRadiusMeters,
          destinationCrossingMaxProgressRatio: config.destinationCrossingMaxProgressRatio,
        },
      },
      null,
      2,
    ),
  );
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  if (rawArgs.help) {
    usage();
    process.exit(0);
  }

  const config = buildConfig();
  const input = normalizeArgs(rawArgs, config);
  printConfig(input, config);

  await ensureHelperTables();

  const hotspots = await fetchHotspots(config);
  const hotspotIds = hotspots.map((item) => item.id);

  const summary: RunSummary = {
    mode: input.apply ? 'apply' : 'dry-run',
    retryFailed: input.retryFailed,
    rebuildDone: input.rebuildDone,
    eligibleHotspots: hotspots.length,
    candidatePairsScanned: 0,
    queuedPairs: 0,
    skippedExistingDone: 0,
    skippedExistingFailed: 0,
    processed: 0,
    done: 0,
    skippedDistance: 0,
    failed: 0,
    pendingMarked: 0,
    onRouteRowsInserted: 0,
    minorDetourRowsInserted: 0,
    osrmCalls: 0,
    startedAt: new Date().toISOString(),
  };

  if (!hotspots.length) {
    summary.completedAt = new Date().toISOString();
    console.log('No eligible hotspots found with valid coordinates and filters.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const existingStatuses = await loadExistingStatuses(config, hotspotIds);
  const pairs = selectPairs(hotspots, existingStatuses, input, config, summary);
  summary.queuedPairs = pairs.length;

  if (!pairs.length) {
    summary.completedAt = new Date().toISOString();
    console.log('No pairs selected after applying filters and resume rules.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Processing ${pairs.length} pairs with concurrency=1`);

  for (const pair of pairs) {
    summary.processed += 1;

    const pairHaversineKm = haversineKm(pair.from.lat, pair.from.lng, pair.to.lat, pair.to.lng);
    if (pairHaversineKm > config.maxPairHaversineKm) {
      summary.skippedDistance += 1;

      if (input.apply) {
        await upsertRouteMatrixStatus(pair, {
          haversineKm: Number(pairHaversineKm.toFixed(6)),
          processStatus: 'SKIPPED',
          errorMessage: `Skipped: haversine ${pairHaversineKm.toFixed(3)}km > MAX_PAIR_HAVERSINE_KM ${
            config.maxPairHaversineKm
          }`,
        });
      }

      console.log(
        `[${summary.processed}/${pairs.length}] SKIPPED ${pair.from.id}->${pair.to.id} (${pairHaversineKm.toFixed(
          2,
        )}km haversine)` ,
      );
      continue;
    }

    if (input.apply) {
      await upsertRouteMatrixStatus(pair, {
        haversineKm: Number(pairHaversineKm.toFixed(6)),
        processStatus: 'PENDING',
      });
      summary.pendingMarked += 1;
    }

    try {
      const abLeg = await ensureRouteLeg(pair.from, pair.to, config, input, summary, true);
      const route: OsrmRoute = {
        distanceKm: abLeg.osrmDistanceKm,
        durationMin: abLeg.osrmDurationMin ?? 0,
        coordinates: abLeg.coordinates,
      };
      const betweenRows = await evaluateBetweenHotspots(pair, route, hotspots, config, input, summary);

      const routeCoordinatesJson = JSON.stringify(route.coordinates);

      if (input.apply) {
        await upsertRouteMatrixStatus(pair, {
          haversineKm: Number(pairHaversineKm.toFixed(6)),
          processStatus: 'DONE',
          osrmDistanceKm: route.distanceKm,
          osrmDurationMin: route.durationMin,
          routeCoordinatesJson,
          errorMessage: null,
        });

        const inserted = await replaceBetweenMapRows(pair, betweenRows, config.betweenHotspotId);
        summary.onRouteRowsInserted += inserted.onRouteInserted;
        summary.minorDetourRowsInserted += inserted.minorDetourInserted;
      } else {
        const onRouteCount = betweenRows.filter((item) => item.routeFitType === 'ON_ROUTE').length;
        const minorDetourCount = betweenRows.filter((item) => item.routeFitType === 'MINOR_DETOUR').length;
        summary.onRouteRowsInserted += onRouteCount;
        summary.minorDetourRowsInserted += minorDetourCount;
      }

      summary.done += 1;

      const onRouteCount = betweenRows.filter((item) => item.routeFitType === 'ON_ROUTE').length;
      const minorDetourCount = betweenRows.filter((item) => item.routeFitType === 'MINOR_DETOUR').length;

      console.log(
        `[${summary.processed}/${pairs.length}] DONE ${pair.from.id}->${pair.to.id} distance=${route.distanceKm.toFixed(
          2,
        )}km duration=${route.durationMin.toFixed(1)}min onRoute=${onRouteCount} minorDetour=${minorDetourCount}`,
      );
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);

      if (input.apply) {
        await upsertRouteMatrixStatus(pair, {
          haversineKm: Number(pairHaversineKm.toFixed(6)),
          processStatus: 'FAILED',
          errorMessage: message.slice(0, 2000),
        });
      }

      console.error(`[${summary.processed}/${pairs.length}] FAILED ${pair.from.id}->${pair.to.id} ${message}`);
    }
  }

  summary.completedAt = new Date().toISOString();
  console.log('Run summary:');
  console.log(JSON.stringify(summary, null, 2));

  if (!input.apply) {
    console.log('Dry-run complete. Re-run with --apply to persist matrix and between-map rows.');
  }
}

main()
  .catch((error) => {
    console.error('Hotspot matrix build failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });






