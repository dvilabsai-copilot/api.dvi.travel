import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

type ProcessStatus = 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
type RouteFitType = 'ON_ROUTE' | 'MINOR_DETOUR' | 'BACKTRACK' | 'OFF_ROUTE';

type RawArgs = Record<string, string | boolean>;

type Hotspot = {
  id: number;
  name: string;
  location: string | null;
  lat: number;
  lng: number;
};

type MatrixRow = {
  osrmDistanceKm: number;
  osrmDurationMin: number | null;
  coordinates: [number, number][];
};

type OsrmRoute = {
  distanceKm: number;
  durationMin: number;
  coordinates: [number, number][];
};

type BetweenRow = {
  fromHotspotId: number;
  fromHotspotName: string;
  fromHotspotLocation: string | null;
  toHotspotId: number;
  toHotspotName: string;
  toHotspotLocation: string | null;
  betweenHotspotId: number;
  betweenHotspotName: string;
  distanceFromRouteMeters: number;
  candidateDistanceFromAbRouteMeters: number;
  candidateProgressOnAbRatio: number;
  destinationDistanceFromAcRouteMeters: number;
  destinationProgressOnAcRatio: number;
  crossesDestinationBeforeCandidate: boolean;
  abOsrmDistanceKm: number;
  acOsrmDistanceKm: number;
  cbOsrmDistanceKm: number;
  insertedRouteDistanceKm: number;
  roadDetourKm: number;
  roadDetourRatio: number;
  routeDecisionReason: string;
  routeFitType: RouteFitType;
};

type InputArgs = {
  location: string;
  likePattern: string;
  targetDb: string;
  apply: boolean;
  buildBetweenMap: boolean;
  includeOffRoute: boolean;
  limitPairs?: number;
  limitBetween?: number;
  osrmDelayMs: number;
  osrmBaseUrl: string;
  maxHaversineKm: number;
  maxCandidateHaversineKm: number;
  maxNearRouteMeters: number;
  maxInsertDetourKm: number;
  maxInsertDetourRatio: number;
  destinationCrossingRadiusMeters: number;
  destinationCrossingMaxProgressRatio: number;
};

type RunSummary = {
  targetDb: string;
  location: string;
  likePattern: string;
  hotspotsMatched: number;
  validHotspots: number;
  directPairsPossible: number;
  directPairsProcessed: number;
  directPairsSkippedExistingDone: number;
  directPairsSkippedHaversine: number;
  directPairsDone: number;
  directPairsFailed: number;
  betweenModeEnabled: boolean;
  betweenCandidatesChecked: number;
  betweenSkippedHaversine: number;
  betweenSkippedMissingAB: number;
  matrixLegsBuiltForBetween: number;
  betweenRowsInserted: number;
  onRouteRowsInserted: number;
  minorDetourRowsInserted: number;
  backtrackRowsInserted: number;
  offRouteRowsInserted: number;
  failed: number;
  osrmCalls: number;
};

type ProgressOnRoute = {
  distanceMeters: number;
  progressMeters: number;
  progressRatio: number;
  segmentIndex: number;
};

const prisma = new PrismaClient();
const DB_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

function usage(): void {
  console.log('Usage: npx tsx scripts/build-location-hotspot-matrix.ts --location <text> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --location <text>                   Required. Location keyword for LIKE query.');
  console.log('  --target-db <db>                    Default: env TARGET_DB_NAME or dvi_main');
  console.log('  --apply                             Enable DB writes. Default is dry-run.');
  console.log('  --build-between-map                 Build hotspot_route_between_map rows.');
  console.log('  --include-off-route                 Insert OFF_ROUTE rows too (default false).');
  console.log('  --limit-pairs <n>                   Optional max direct A->B pairs to process.');
  console.log('  --limit-between <n>                 Optional max A->C->B candidate checks.');
  console.log('  --osrm-delay-ms <n>                 Default: env OSRM_DELAY_MS or 500');
  console.log('  --max-haversine-km <n>              Default: 100');
  console.log('  --max-candidate-haversine-km <n>    Default: 80');
  console.log('  --help                              Show this help.');
  console.log('');
  console.log('Environment defaults:');
  console.log('  OSRM_BASE_URL (default: http://localhost:5000/route/v1/driving)');
  console.log('  OSRM_DELAY_MS (default: 500)');
  console.log('  MAX_NEAR_ROUTE_METERS (default: 1500)');
  console.log('  MAX_INSERT_DETOUR_KM (default: 5)');
  console.log('  MAX_INSERT_DETOUR_RATIO (default: 0.25)');
  console.log('  DESTINATION_CROSSING_RADIUS_METERS (default: 1200)');
  console.log('  DESTINATION_CROSSING_MAX_PROGRESS_RATIO (default: 0.90)');
}

function parseArgs(argv: string[]): RawArgs {
  const out: RawArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    if (token.includes('=')) {
      const [k, v] = token.slice(2).split('=', 2);
      out[k] = v ?? true;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }

    out[key] = next;
    i += 1;
  }

  return out;
}

function toNumberOrDefault(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value: ${raw}`);
  }
  return value;
}

function toOptionalPositiveInt(raw: string | undefined, fieldName: string): number | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
}

function validateDbName(name: string): string {
  if (!DB_NAME_REGEX.test(name)) {
    throw new Error(`Invalid database name: "${name}". Allowed: letters, numbers, underscore.`);
  }
  return name;
}

function normalizeName(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function parseCoordinate(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;

  return parsed;
}

function normalizeArgs(raw: RawArgs): InputArgs {
  const locationRaw = typeof raw.location === 'string' ? raw.location.trim() : '';
  if (!locationRaw) {
    throw new Error('Missing required --location argument.');
  }

  const targetDb = validateDbName(
    typeof raw['target-db'] === 'string' && raw['target-db'].trim()
      ? raw['target-db'].trim()
      : (process.env.TARGET_DB_NAME?.trim() || 'dvi_main'),
  );

  const osrmDelayMsValue =
    typeof raw['osrm-delay-ms'] === 'string' && raw['osrm-delay-ms'].trim() !== ''
      ? Number(raw['osrm-delay-ms'])
      : toNumberOrDefault(process.env.OSRM_DELAY_MS, 500);

  if (!Number.isInteger(osrmDelayMsValue) || osrmDelayMsValue < 0) {
    throw new Error('--osrm-delay-ms must be a non-negative integer.');
  }

  const maxHaversineKm =
    typeof raw['max-haversine-km'] === 'string' && raw['max-haversine-km'].trim() !== ''
      ? Number(raw['max-haversine-km'])
      : 100;

  if (!Number.isFinite(maxHaversineKm) || maxHaversineKm <= 0) {
    throw new Error('--max-haversine-km must be a positive number.');
  }

  const maxCandidateHaversineKm =
    typeof raw['max-candidate-haversine-km'] === 'string' && raw['max-candidate-haversine-km'].trim() !== ''
      ? Number(raw['max-candidate-haversine-km'])
      : 80;

  if (!Number.isFinite(maxCandidateHaversineKm) || maxCandidateHaversineKm <= 0) {
    throw new Error('--max-candidate-haversine-km must be a positive number.');
  }

  const maxNearRouteMeters = toNumberOrDefault(process.env.MAX_NEAR_ROUTE_METERS, 1500);
  const maxInsertDetourKm = toNumberOrDefault(process.env.MAX_INSERT_DETOUR_KM, 5);
  const maxInsertDetourRatio = toNumberOrDefault(process.env.MAX_INSERT_DETOUR_RATIO, 0.25);
  const destinationCrossingRadiusMeters = toNumberOrDefault(process.env.DESTINATION_CROSSING_RADIUS_METERS, 1200);
  const destinationCrossingMaxProgressRatio = toNumberOrDefault(
    process.env.DESTINATION_CROSSING_MAX_PROGRESS_RATIO,
    0.9,
  );

  if (maxNearRouteMeters <= 0) {
    throw new Error('MAX_NEAR_ROUTE_METERS must be > 0.');
  }

  if (maxInsertDetourKm < 0) {
    throw new Error('MAX_INSERT_DETOUR_KM must be >= 0.');
  }

  if (maxInsertDetourRatio < 0) {
    throw new Error('MAX_INSERT_DETOUR_RATIO must be >= 0.');
  }

  if (destinationCrossingRadiusMeters <= 0) {
    throw new Error('DESTINATION_CROSSING_RADIUS_METERS must be > 0.');
  }

  if (destinationCrossingMaxProgressRatio <= 0 || destinationCrossingMaxProgressRatio >= 1) {
    throw new Error('DESTINATION_CROSSING_MAX_PROGRESS_RATIO must be > 0 and < 1.');
  }

  const likePattern = `%${locationRaw}%`;

  return {
    location: locationRaw,
    likePattern,
    targetDb,
    apply: Boolean(raw.apply),
    buildBetweenMap: Boolean(raw['build-between-map']),
    includeOffRoute: Boolean(raw['include-off-route']),
    limitPairs: toOptionalPositiveInt(typeof raw['limit-pairs'] === 'string' ? raw['limit-pairs'] : undefined, '--limit-pairs'),
    limitBetween: toOptionalPositiveInt(
      typeof raw['limit-between'] === 'string' ? raw['limit-between'] : undefined,
      '--limit-between',
    ),
    osrmDelayMs: osrmDelayMsValue,
    osrmBaseUrl: process.env.OSRM_BASE_URL?.trim() || 'http://localhost:5000/route/v1/driving',
    maxHaversineKm,
    maxCandidateHaversineKm,
    maxNearRouteMeters,
    maxInsertDetourKm,
    maxInsertDetourRatio,
    destinationCrossingRadiusMeters,
    destinationCrossingMaxProgressRatio,
  };
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
  args: InputArgs,
): {
  crossesDestinationBeforeCandidate: boolean;
  destinationProgressOnAcRatio: number;
  destinationDistanceFromAcRouteMeters: number;
} {
  const bOnAc = findNearestProgressOnRoute(destinationPoint, routeAcCoordinates);
  const crossesDestinationBeforeCandidate =
    bOnAc.distanceMeters <= args.destinationCrossingRadiusMeters &&
    bOnAc.progressRatio < args.destinationCrossingMaxProgressRatio;

  return {
    crossesDestinationBeforeCandidate,
    destinationProgressOnAcRatio: bOnAc.progressRatio,
    destinationDistanceFromAcRouteMeters: bOnAc.distanceMeters,
  };
}

function classifyRouteFit(
  candidateDistanceFromAbRouteMeters: number,
  roadDetourKm: number,
  roadDetourRatio: number,
  args: InputArgs,
): RouteFitType {
  if (candidateDistanceFromAbRouteMeters > args.maxNearRouteMeters * 2) {
    return 'OFF_ROUTE';
  }

  if (candidateDistanceFromAbRouteMeters <= args.maxNearRouteMeters && roadDetourKm <= 3 && roadDetourRatio <= 0.15) {
    return 'ON_ROUTE';
  }

  if (
    candidateDistanceFromAbRouteMeters <= args.maxNearRouteMeters * 2 &&
    roadDetourKm <= args.maxInsertDetourKm &&
    roadDetourRatio <= args.maxInsertDetourRatio
  ) {
    return 'MINOR_DETOUR';
  }

  return 'OFF_ROUTE';
}

function buildRouteDecisionReason(routeFitType: RouteFitType): string {
  if (routeFitType === 'ON_ROUTE') {
    return 'Candidate is near AB route and has minimal road detour.';
  }
  if (routeFitType === 'MINOR_DETOUR') {
    return 'Candidate is near AB route with acceptable road detour.';
  }
  if (routeFitType === 'BACKTRACK') {
    return 'Route to candidate crosses destination before candidate; candidate is after destination.';
  }
  return 'Candidate is too far from route corridor or detour constraints.';
}

function parseRouteCoordinates(raw: string | null): [number, number][] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item): item is [number, number] =>
        Array.isArray(item) && item.length === 2 && Number.isFinite(item[0]) && Number.isFinite(item[1]),
    );
  } catch {
    return [];
  }
}

async function ensureHelperTablesForDb(targetDb: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`${targetDb}\`.\`hotspot_route_matrix\` (
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
    CREATE TABLE IF NOT EXISTS \`${targetDb}\`.\`hotspot_route_between_map\` (
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

  const routeFitTypeColumn = await prisma.$queryRawUnsafe<Array<{ data_type: string }>>(
    `
      SELECT DATA_TYPE AS data_type
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'hotspot_route_between_map'
        AND COLUMN_NAME = 'route_fit_type'
      LIMIT 1
    `,
    targetDb,
  );

  if (routeFitTypeColumn.length && String(routeFitTypeColumn[0].data_type).toLowerCase() === 'enum') {
    await prisma.$executeRawUnsafe(
      `
        ALTER TABLE \`${targetDb}\`.\`hotspot_route_between_map\`
        MODIFY COLUMN route_fit_type VARCHAR(40) NOT NULL
      `,
    );
  }

  const columnsToEnsure: Array<[string, string]> = [
    ['from_hotspot_name', 'TEXT NULL'],
    ['from_hotspot_location', 'TEXT NULL'],
    ['to_hotspot_name', 'TEXT NULL'],
    ['to_hotspot_location', 'TEXT NULL'],
    ['between_hotspot_name', 'TEXT NULL'],
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

  for (const [columnName, columnDefinition] of columnsToEnsure) {
    const exists = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `
        SELECT COLUMN_NAME AS column_name
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = 'hotspot_route_between_map'
          AND COLUMN_NAME = ?
        LIMIT 1
      `,
      targetDb,
      columnName,
    );

    if (!exists.length) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE \`${targetDb}\`.\`hotspot_route_between_map\` ADD COLUMN ${columnName} ${columnDefinition}`,
      );
    }
  }
}

async function fetchLocationHotspots(args: InputArgs): Promise<{
  allMatches: number;
  validHotspots: Hotspot[];
  invalidCount: number;
}> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      hotspot_ID: number;
      hotspot_name: string | null;
      hotspot_location: string | null;
      hotspot_latitude: string | number | null;
      hotspot_longitude: string | number | null;
      deleted: number | null;
      status: number | null;
    }>
  >(
    `
      SELECT
        hotspot_ID,
        hotspot_name,
        hotspot_location,
        hotspot_latitude,
        hotspot_longitude,
        deleted,
        status
      FROM \`${args.targetDb}\`.\`dvi_hotspot_place\`
      WHERE deleted = 0
        AND hotspot_location NOT LIKE ?
      ORDER BY hotspot_ID ASC
    `,
    args.likePattern,
  );

  const valid: Hotspot[] = [];
  let invalid = 0;

  for (const row of rows) {
    const id = Number(row.hotspot_ID);
    if (!Number.isInteger(id) || id <= 0) {
      invalid += 1;
      continue;
    }

    const lat = parseCoordinate(row.hotspot_latitude);
    const lng = parseCoordinate(row.hotspot_longitude);

    if (lat === null || lng === null) {
      invalid += 1;
      continue;
    }

    valid.push({
      id,
      name: normalizeName(row.hotspot_name) || `Hotspot-${id}`,
      location: normalizeName(row.hotspot_location) || null,
      lat,
      lng,
    });
  }

  return {
    allMatches: rows.length,
    validHotspots: valid,
    invalidCount: invalid,
  };
}

async function getDoneMatrixRowForDb(targetDb: string, fromHotspotId: number, toHotspotId: number): Promise<MatrixRow | null> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      osrm_distance_km: number | null;
      osrm_duration_min: number | null;
      route_coordinates: string | null;
      process_status: ProcessStatus;
    }>
  >(
    `
      SELECT osrm_distance_km, osrm_duration_min, route_coordinates, process_status
      FROM \`${targetDb}\`.\`hotspot_route_matrix\`
      WHERE from_hotspot_id = ?
        AND to_hotspot_id = ?
        AND process_status = 'DONE'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    fromHotspotId,
    toHotspotId,
  );

  const row = rows[0];
  if (!row) return null;

  const distanceKm = Number(row.osrm_distance_km);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return null;
  }

  const coordinates = parseRouteCoordinates(row.route_coordinates);

  return {
    osrmDistanceKm: distanceKm,
    osrmDurationMin: row.osrm_duration_min !== null && Number.isFinite(Number(row.osrm_duration_min))
      ? Number(row.osrm_duration_min)
      : null,
    coordinates,
  };
}

async function upsertRouteMatrixStatusForDb(
  targetDb: string,
  from: Hotspot,
  to: Hotspot,
  payload: {
    haversineKmValue: number;
    processStatus: ProcessStatus;
    osrmDistanceKm?: number | null;
    osrmDurationMin?: number | null;
    routeCoordinatesJson?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO \`${targetDb}\`.\`hotspot_route_matrix\` (
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
    Number(payload.haversineKmValue.toFixed(6)),
    payload.osrmDistanceKm ?? null,
    payload.osrmDurationMin ?? null,
    payload.routeCoordinatesJson ?? null,
    payload.processStatus,
    payload.errorMessage ?? null,
  );
}

function buildOsrmUrl(baseUrl: string, from: Hotspot, to: Hotspot): string {
  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const query = 'overview=full&geometries=geojson&steps=false';
  return `${baseUrl}/${coordinates}?${query}`;
}

async function fetchOsrmRouteWithRetry(
  from: Hotspot,
  to: Hotspot,
  args: InputArgs,
  summary: RunSummary,
): Promise<OsrmRoute> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await sleep(args.osrmDelayMs);
    summary.osrmCalls += 1;

    const url = buildOsrmUrl(args.osrmBaseUrl, from, to);
    const response = await fetch(url);

    if (!response.ok) {
      const isRetriable = response.status === 429 || response.status >= 500;
      const body = await response.text();

      if (isRetriable && attempt < maxAttempts) {
        const backoffMs = Math.pow(2, attempt - 1) * 1000;
        console.warn(
          `OSRM retry for ${from.id}->${to.id}, attempt ${attempt}/${maxAttempts}, status=${response.status}, backoff=${backoffMs}ms`,
        );
        await sleep(backoffMs);
        continue;
      }

      throw new Error(`OSRM failed for ${from.id}->${to.id}. status=${response.status}, body=${body.slice(0, 300)}`);
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
        `OSRM route missing for ${from.id}->${to.id}. code=${payload.code ?? 'unknown'} message=${payload.message ?? 'n/a'}`,
      );
    }

    return {
      distanceKm: Number(((route.distance ?? 0) / 1000).toFixed(6)),
      durationMin: Number(((route.duration ?? 0) / 60).toFixed(6)),
      coordinates,
    };
  }

  throw new Error(`OSRM retry exhausted for ${from.id}->${to.id}`);
}

async function ensureRouteLegForDb(
  targetDb: string,
  from: Hotspot,
  to: Hotspot,
  args: InputArgs,
  summary: RunSummary,
  requireCoordinates: boolean,
  countAsBetweenBuild: boolean,
): Promise<MatrixRow> {
  const existing = await getDoneMatrixRowForDb(targetDb, from.id, to.id);
  if (existing && (!requireCoordinates || existing.coordinates.length > 1)) {
    return existing;
  }

  if (!args.apply) {
    throw new Error(`Missing DONE matrix leg ${from.id}->${to.id} in dry-run mode.`);
  }

  const haversineKmValue = haversineKm(from.lat, from.lng, to.lat, to.lng);

  await upsertRouteMatrixStatusForDb(targetDb, from, to, {
    haversineKmValue,
    processStatus: 'PENDING',
  });

  try {
    const route = await fetchOsrmRouteWithRetry(from, to, args, summary);

    await upsertRouteMatrixStatusForDb(targetDb, from, to, {
      haversineKmValue,
      processStatus: 'DONE',
      osrmDistanceKm: route.distanceKm,
      osrmDurationMin: route.durationMin,
      routeCoordinatesJson: JSON.stringify(route.coordinates),
      errorMessage: null,
    });

    if (countAsBetweenBuild) {
      summary.matrixLegsBuiltForBetween += 1;
    }

    return {
      osrmDistanceKm: route.distanceKm,
      osrmDurationMin: route.durationMin,
      coordinates: route.coordinates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await upsertRouteMatrixStatusForDb(targetDb, from, to, {
      haversineKmValue,
      processStatus: 'FAILED',
      osrmDistanceKm: null,
      osrmDurationMin: null,
      routeCoordinatesJson: null,
      errorMessage: message,
    });

    throw error;
  }
}

async function upsertBetweenMapRowForDb(targetDb: string, row: BetweenRow): Promise<void> {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO \`${targetDb}\`.\`hotspot_route_between_map\` (
        from_hotspot_id,
        from_hotspot_name,
        from_hotspot_location,
        to_hotspot_id,
        to_hotspot_name,
        to_hotspot_location,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        from_hotspot_name = VALUES(from_hotspot_name),
        from_hotspot_location = VALUES(from_hotspot_location),
        to_hotspot_name = VALUES(to_hotspot_name),
        to_hotspot_location = VALUES(to_hotspot_location),
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
    row.fromHotspotId,
    row.fromHotspotName,
    row.fromHotspotLocation,
    row.toHotspotId,
    row.toHotspotName,
    row.toHotspotLocation,
    row.betweenHotspotId,
    row.betweenHotspotName,
    row.distanceFromRouteMeters,
    row.candidateDistanceFromAbRouteMeters,
    row.candidateProgressOnAbRatio,
    row.destinationDistanceFromAcRouteMeters,
    row.destinationProgressOnAcRatio,
    row.crossesDestinationBeforeCandidate ? 1 : 0,
    row.abOsrmDistanceKm,
    row.acOsrmDistanceKm,
    row.cbOsrmDistanceKm,
    row.insertedRouteDistanceKm,
    row.roadDetourKm,
    row.roadDetourRatio,
    row.routeDecisionReason,
    row.routeFitType,
  );
}

function initializeSummary(args: InputArgs): RunSummary {
  return {
    targetDb: args.targetDb,
    location: args.location,
    likePattern: args.likePattern,
    hotspotsMatched: 0,
    validHotspots: 0,
    directPairsPossible: 0,
    directPairsProcessed: 0,
    directPairsSkippedExistingDone: 0,
    directPairsSkippedHaversine: 0,
    directPairsDone: 0,
    directPairsFailed: 0,
    betweenModeEnabled: args.buildBetweenMap,
    betweenCandidatesChecked: 0,
    betweenSkippedHaversine: 0,
    betweenSkippedMissingAB: 0,
    matrixLegsBuiltForBetween: 0,
    betweenRowsInserted: 0,
    onRouteRowsInserted: 0,
    minorDetourRowsInserted: 0,
    backtrackRowsInserted: 0,
    offRouteRowsInserted: 0,
    failed: 0,
    osrmCalls: 0,
  };
}

async function runDirectMatrixBuild(args: InputArgs, hotspots: Hotspot[], summary: RunSummary): Promise<void> {
  const pairLimit = args.limitPairs;
  let stop = false;

  for (const from of hotspots) {
    if (stop) break;

    for (const to of hotspots) {
      if (from.id === to.id) continue;

      summary.directPairsPossible += 1;

      if (pairLimit && summary.directPairsProcessed >= pairLimit) {
        stop = true;
        break;
      }

      const haversineValue = haversineKm(from.lat, from.lng, to.lat, to.lng);
      if (haversineValue > args.maxHaversineKm) {
        summary.directPairsSkippedHaversine += 1;
        continue;
      }

      const existing = await getDoneMatrixRowForDb(args.targetDb, from.id, to.id);
      if (existing) {
        summary.directPairsSkippedExistingDone += 1;
        continue;
      }

      summary.directPairsProcessed += 1;

      if (!args.apply) {
        console.log(
          `DRY-RUN DIRECT would build ${from.id}->${to.id} haversine=${haversineValue.toFixed(3)}km location=${args.location}`,
        );
        continue;
      }

      try {
        await ensureRouteLegForDb(args.targetDb, from, to, args, summary, true, false);
        summary.directPairsDone += 1;
      } catch (error) {
        summary.directPairsFailed += 1;
        summary.failed += 1;

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`DIRECT FAIL ${from.id}->${to.id}: ${message}`);
      }
    }
  }
}

async function runBetweenMapBuild(args: InputArgs, hotspots: Hotspot[], summary: RunSummary): Promise<void> {
  const betweenLimit = args.limitBetween;
  let stop = false;

  for (const from of hotspots) {
    if (stop) break;

    for (const to of hotspots) {
      if (from.id === to.id) continue;
      if (stop) break;

      const ab = await getDoneMatrixRowForDb(args.targetDb, from.id, to.id);
      if (!ab || ab.coordinates.length < 2) {
        summary.betweenSkippedMissingAB += 1;
        continue;
      }

      for (const candidate of hotspots) {
        if (candidate.id === from.id || candidate.id === to.id) continue;

        if (betweenLimit && summary.betweenCandidatesChecked >= betweenLimit) {
          stop = true;
          break;
        }

        summary.betweenCandidatesChecked += 1;

        const acHaversine = haversineKm(from.lat, from.lng, candidate.lat, candidate.lng);
        const cbHaversine = haversineKm(candidate.lat, candidate.lng, to.lat, to.lng);

        if (acHaversine > args.maxCandidateHaversineKm || cbHaversine > args.maxCandidateHaversineKm) {
          summary.betweenSkippedHaversine += 1;
          continue;
        }

        let ac: MatrixRow;
        let cb: MatrixRow;

        try {
          ac = await ensureRouteLegForDb(args.targetDb, from, candidate, args, summary, true, true);
          cb = await ensureRouteLegForDb(args.targetDb, candidate, to, args, summary, false, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          if (!args.apply) {
            console.log(
              `DRY-RUN BETWEEN skip ${from.id}->${candidate.id}->${to.id}: missing matrix leg (${message})`,
            );
          } else {
            console.warn(`BETWEEN LEG FAIL ${from.id}->${candidate.id}->${to.id}: ${message}`);
            summary.failed += 1;
          }
          continue;
        }

        const candidateOnAb = findNearestProgressOnRoute({ lat: candidate.lat, lng: candidate.lng }, ab.coordinates);

        const insertedRouteDistanceKm = ac.osrmDistanceKm + cb.osrmDistanceKm;
        const roadDetourKm = Math.max(0, insertedRouteDistanceKm - ab.osrmDistanceKm);
        const roadDetourRatio = ab.osrmDistanceKm > 0 ? roadDetourKm / ab.osrmDistanceKm : Number.POSITIVE_INFINITY;

        const backtrack = detectBacktrackByRouteOrder({ lat: to.lat, lng: to.lng }, ac.coordinates, args);

        let routeFitType: RouteFitType;
        if (backtrack.crossesDestinationBeforeCandidate) {
          routeFitType = 'BACKTRACK';
        } else if (roadDetourKm > args.maxInsertDetourKm || roadDetourRatio > args.maxInsertDetourRatio) {
          routeFitType = 'OFF_ROUTE';
        } else {
          routeFitType = classifyRouteFit(candidateOnAb.distanceMeters, roadDetourKm, roadDetourRatio, args);
        }

        const routeDecisionReason = buildRouteDecisionReason(routeFitType);

        if (routeFitType === 'OFF_ROUTE' && !args.includeOffRoute) {
          continue;
        }

        const row: BetweenRow = {
          fromHotspotId: from.id,
          fromHotspotName: from.name,
          fromHotspotLocation: from.location,
          toHotspotId: to.id,
          toHotspotName: to.name,
          toHotspotLocation: to.location,
          betweenHotspotId: candidate.id,
          betweenHotspotName: candidate.name,
          distanceFromRouteMeters: Number(candidateOnAb.distanceMeters.toFixed(3)),
          candidateDistanceFromAbRouteMeters: Number(candidateOnAb.distanceMeters.toFixed(3)),
          candidateProgressOnAbRatio: Number(candidateOnAb.progressRatio.toFixed(6)),
          destinationDistanceFromAcRouteMeters: Number(backtrack.destinationDistanceFromAcRouteMeters.toFixed(3)),
          destinationProgressOnAcRatio: Number(backtrack.destinationProgressOnAcRatio.toFixed(6)),
          crossesDestinationBeforeCandidate: backtrack.crossesDestinationBeforeCandidate,
          abOsrmDistanceKm: Number(ab.osrmDistanceKm.toFixed(6)),
          acOsrmDistanceKm: Number(ac.osrmDistanceKm.toFixed(6)),
          cbOsrmDistanceKm: Number(cb.osrmDistanceKm.toFixed(6)),
          insertedRouteDistanceKm: Number(insertedRouteDistanceKm.toFixed(6)),
          roadDetourKm: Number(roadDetourKm.toFixed(6)),
          roadDetourRatio: Number(roadDetourRatio.toFixed(6)),
          routeDecisionReason,
          routeFitType,
        };

        if (!args.apply) {
          console.log(
            `DRY-RUN BETWEEN would upsert ${from.id}->${candidate.id}->${to.id} fit=${routeFitType} detour=${row.roadDetourKm.toFixed(3)}km ratio=${row.roadDetourRatio.toFixed(4)}`,
          );
          continue;
        }

        await upsertBetweenMapRowForDb(args.targetDb, row);
        summary.betweenRowsInserted += 1;

        if (routeFitType === 'ON_ROUTE') {
          summary.onRouteRowsInserted += 1;
        } else if (routeFitType === 'MINOR_DETOUR') {
          summary.minorDetourRowsInserted += 1;
        } else if (routeFitType === 'BACKTRACK') {
          summary.backtrackRowsInserted += 1;
        } else if (routeFitType === 'OFF_ROUTE') {
          summary.offRouteRowsInserted += 1;
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const raw = parseArgs(process.argv.slice(2));

  if (raw.help) {
    usage();
    return;
  }

  const args = normalizeArgs(raw);
  const summary = initializeSummary(args);

  console.log(`Mode: ${args.apply ? 'apply' : 'dry-run'}`);
  console.log(`targetDb: ${args.targetDb}`);
  console.log(`location input: ${args.location}`);
  console.log(`LIKE pattern: ${args.likePattern}`);
  console.log(`OSRM base: ${args.osrmBaseUrl}`);

  await ensureHelperTablesForDb(args.targetDb);

  const hotspotResult = await fetchLocationHotspots(args);
  summary.hotspotsMatched = hotspotResult.allMatches;
  summary.validHotspots = hotspotResult.validHotspots.length;

  console.log(`total DB matches: ${hotspotResult.allMatches}`);
  console.log(`valid coordinate hotspot count: ${hotspotResult.validHotspots.length}`);
  console.log(`skipped invalid coordinate count: ${hotspotResult.invalidCount}`);

  if (!hotspotResult.validHotspots.length) {
    console.log('No valid hotspots found for location filter. Nothing to process.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  await runDirectMatrixBuild(args, hotspotResult.validHotspots, summary);

  if (args.buildBetweenMap) {
    await runBetweenMapBuild(args, hotspotResult.validHotspots, summary);
  }

  console.log('Final summary:');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`build-location-hotspot-matrix failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// Examples:
// Dry run Chennai direct matrix only
// npx tsx scripts/build-location-hotspot-matrix.ts --location chennai --target-db dvi_main
//
// Apply Chennai direct matrix only
// npx tsx scripts/build-location-hotspot-matrix.ts --location chennai --target-db dvi_main --apply
//
// Dry run Chennai direct + between map
// npx tsx scripts/build-location-hotspot-matrix.ts --location chennai --target-db dvi_main --build-between-map
//
// Apply Chennai direct + between map
// npx tsx scripts/build-location-hotspot-matrix.ts --location chennai --target-db dvi_main --build-between-map --apply
//
// Apply with larger radius
// npx tsx scripts/build-location-hotspot-matrix.ts --location chennai --target-db dvi_main --max-haversine-km 150 --max-candidate-haversine-km 100 --build-between-map --apply
