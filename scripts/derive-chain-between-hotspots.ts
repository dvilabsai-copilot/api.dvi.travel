import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

type RawArgs = Record<string, string | boolean>;

type InputArgs = {
  targetDb: string;
  apply: boolean;
  force: boolean;
  limitChains?: number;
  maxLocationRouteKm: number;
  minBetweenCount: number;
};

type Pair = {
  fromHotspotId: number;
  toHotspotId: number;
};

type Chain = {
  a: number;
  c: number;
  b: number;
};

type MatrixLeg = {
  fromHotspotId: number;
  toHotspotId: number;
  osrmDistanceKm: number;
  osrmDurationMin: number | null;
};

type BetweenSeedRow = {
  betweenHotspotId: number;
  betweenHotspotName: string | null;
  routeFitType: string | null;
  insertedRouteDistanceKm: number | null;
  candidateProgressOnAbRatio: number | null;
  createdAt: Date | null;
};

type HotspotRef = {
  hotspotId: number;
  hotspotName: string;
  hotspotLocation: string | null;
};

type DerivedSummary = {
  targetDb: string;
  apply: boolean;
  force: boolean;
  totalPairsLoaded: number;
  chainsDiscovered: number;
  chainsProcessed: number;
  chainsSkippedExisting: number;
  chainsSkippedMissingMatrixLegs: number;
  chainsSkippedOverDistance: number;
  chainsSkippedLowBetweenCount: number;
  derivedCandidatesTotal: number;
  rowsDryRun: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkippedExisting: number;
  candidatesSkippedMissingHotspot: number;
  failed: number;
};

type DerivedRowPayload = {
  fromHotspotId: number;
  fromHotspotName: string;
  fromHotspotLocation: string | null;
  toHotspotId: number;
  toHotspotName: string;
  toHotspotLocation: string | null;
  betweenHotspotId: number;
  betweenHotspotName: string;
  acOsrmDistanceKm: number;
  cbOsrmDistanceKm: number;
  insertedRouteDistanceKm: number;
  chainHotspotIds: string;
};

type WritePlan = {
  insertSql: string;
  upsertSql: string;
  extractValues: (row: DerivedRowPayload) => unknown[];
};

const prisma = new PrismaClient();
const DB_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

function usage(): void {
  console.log('Usage: npx tsx scripts/derive-chain-between-hotspots.ts [options]');
  console.log('');
  console.log('Derive missing A->B between-hotspot rows by stitching existing A->C and C->B route intelligence.');
  console.log('');
  console.log('Options:');
  console.log('  --target-db <db>              Default: dvi_main');
  console.log('  --apply                       Execute INSERT/UPDATE on derived table. Default is dry-run.');
  console.log('  --force                       Update existing derived rows when duplicate key exists.');
  console.log('  --limit-chains <n>            Optional max number of chains to process after filtering.');
  console.log('  --max-location-route-km <n>   Skip chains where A-C + C-B exceeds this km. Default: 500');
  console.log('  --min-between-count <n>       Minimum (A-C between + C-B between) count. Default: 1');
  console.log('  --help                        Show this help.');
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

function validateDbName(name: string): string {
  if (!DB_NAME_REGEX.test(name)) {
    throw new Error(`Invalid database name: "${name}". Allowed: letters, numbers, underscore.`);
  }
  return name;
}

function toOptionalPositiveInt(raw: string | undefined, fieldName: string): number | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
}

function toPositiveNumberOrDefault(raw: string | undefined, fallback: number, fieldName: string): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return value;
}

function normalizeArgs(raw: RawArgs): InputArgs {
  const targetDb = validateDbName(
    typeof raw['target-db'] === 'string' && raw['target-db'].trim() !== ''
      ? raw['target-db'].trim()
      : 'dvi_main',
  );

  const limitChains = toOptionalPositiveInt(
    typeof raw['limit-chains'] === 'string' ? raw['limit-chains'] : undefined,
    '--limit-chains',
  );

  const maxLocationRouteKm = toPositiveNumberOrDefault(
    typeof raw['max-location-route-km'] === 'string' ? raw['max-location-route-km'] : undefined,
    500,
    '--max-location-route-km',
  );

  const minBetweenCountRaw =
    typeof raw['min-between-count'] === 'string' && raw['min-between-count'].trim() !== ''
      ? Number(raw['min-between-count'])
      : 1;

  if (!Number.isInteger(minBetweenCountRaw) || minBetweenCountRaw < 0) {
    throw new Error('--min-between-count must be a non-negative integer.');
  }

  return {
    targetDb,
    apply: Boolean(raw.apply),
    force: Boolean(raw.force),
    limitChains,
    maxLocationRouteKm,
    minBetweenCount: minBetweenCountRaw,
  };
}

function chainKey(a: number, c: number, b: number): string {
  return `${a}:${c}:${b}`;
}

function pairKey(fromHotspotId: number, toHotspotId: number): string {
  return `${fromHotspotId}:${toHotspotId}`;
}

function formatNullableNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(3);
}

async function ensureDerivedTable(targetDb: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS \`${targetDb}\`.\`hotspot_route_between_derived_map\` LIKE \`${targetDb}\`.\`hotspot_route_between_map\``,
  );

  await ensureColumnExists(
    targetDb,
    'hotspot_route_between_derived_map',
    'chain_hotspot_ids',
    'TEXT NULL',
  );

  await ensureColumnExists(
    targetDb,
    'hotspot_route_between_derived_map',
    'derived_source',
    "VARCHAR(50) NULL DEFAULT 'AUTO_DISCOVERED_CHAIN'",
  );

  await ensureRouteFitTypeColumn(targetDb, 'hotspot_route_between_derived_map');
}

async function ensureRouteFitTypeColumn(targetDb: string, tableName: string): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ data_type: string }>>(
    `SELECT DATA_TYPE AS data_type
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND COLUMN_NAME = 'route_fit_type'
     LIMIT 1`,
    targetDb,
    tableName,
  );

  if (!rows.length) return;

  if (String(rows[0].data_type).toLowerCase() === 'enum') {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`${targetDb}\`.\`${tableName}\` MODIFY COLUMN route_fit_type VARCHAR(40) NOT NULL`,
    );
  }
}

async function ensureColumnExists(
  targetDb: string,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT COLUMN_NAME AS column_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    targetDb,
    tableName,
    columnName,
  );

  if (rows.length) return;

  await prisma.$executeRawUnsafe(
    `ALTER TABLE \`${targetDb}\`.\`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`,
  );
}

async function fetchDestinationColumns(targetDb: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT COLUMN_NAME AS column_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'hotspot_route_between_derived_map'`,
    targetDb,
  );

  return new Set(rows.map((row) => String(row.column_name)));
}

function buildWritePlan(targetDb: string, columns: Set<string>): WritePlan {
  const tableRef = `\`${targetDb}\`.\`hotspot_route_between_derived_map\``;

  const orderedWritableColumns = [
    'from_hotspot_id',
    'from_hotspot_name',
    'from_hotspot_location',
    'to_hotspot_id',
    'to_hotspot_name',
    'to_hotspot_location',
    'between_hotspot_id',
    'between_hotspot_name',
    'distance_from_route_meters',
    'candidate_distance_from_ab_route_meters',
    'candidate_progress_on_ab_ratio',
    'destination_distance_from_ac_route_meters',
    'destination_progress_on_ac_ratio',
    'crosses_destination_before_candidate',
    'ab_osrm_distance_km',
    'ac_osrm_distance_km',
    'cb_osrm_distance_km',
    'inserted_route_distance_km',
    'detour_km',
    'detour_ratio',
    'road_detour_km',
    'road_detour_ratio',
    'route_fit_type',
    'route_decision_reason',
    'chain_hotspot_ids',
    'derived_source',
    'created_at',
    'updated_at',
  ].filter((columnName) => columns.has(columnName));

  if (!orderedWritableColumns.includes('from_hotspot_id') || !orderedWritableColumns.includes('to_hotspot_id') || !orderedWritableColumns.includes('between_hotspot_id')) {
    throw new Error('Derived table is missing one or more key columns required for writes.');
  }

  const valueExpressionByColumn = new Map<string, string>();
  for (const columnName of orderedWritableColumns) {
    if (columnName === 'created_at' || columnName === 'updated_at') {
      valueExpressionByColumn.set(columnName, 'NOW()');
    } else {
      valueExpressionByColumn.set(columnName, '?');
    }
  }

  const extractValues = (row: DerivedRowPayload): unknown[] => {
    const rowValues = new Map<string, unknown>([
      ['from_hotspot_id', row.fromHotspotId],
      ['from_hotspot_name', row.fromHotspotName],
      ['from_hotspot_location', row.fromHotspotLocation],
      ['to_hotspot_id', row.toHotspotId],
      ['to_hotspot_name', row.toHotspotName],
      ['to_hotspot_location', row.toHotspotLocation],
      ['between_hotspot_id', row.betweenHotspotId],
      ['between_hotspot_name', row.betweenHotspotName],
      ['distance_from_route_meters', null],
      ['candidate_distance_from_ab_route_meters', null],
      ['candidate_progress_on_ab_ratio', null],
      ['destination_distance_from_ac_route_meters', null],
      ['destination_progress_on_ac_ratio', null],
      ['crosses_destination_before_candidate', 0],
      ['ab_osrm_distance_km', null],
      ['ac_osrm_distance_km', Number(row.acOsrmDistanceKm.toFixed(6))],
      ['cb_osrm_distance_km', Number(row.cbOsrmDistanceKm.toFixed(6))],
      ['inserted_route_distance_km', Number(row.insertedRouteDistanceKm.toFixed(6))],
      ['detour_km', null],
      ['detour_ratio', null],
      ['road_detour_km', null],
      ['road_detour_ratio', null],
      ['route_fit_type', 'DERIVED_CHAIN'],
      ['route_decision_reason', 'Auto-derived by stitching existing route pairs A->C and C->B.'],
      ['chain_hotspot_ids', row.chainHotspotIds],
      ['derived_source', 'AUTO_DISCOVERED_CHAIN'],
    ]);

    const values: unknown[] = [];
    for (const columnName of orderedWritableColumns) {
      if (columnName === 'created_at' || columnName === 'updated_at') continue;
      values.push(rowValues.get(columnName) ?? null);
    }
    return values;
  };

  const insertColumnsSql = orderedWritableColumns.map((columnName) => `\`${columnName}\``).join(', ');
  const insertValuesSql = orderedWritableColumns.map((columnName) => valueExpressionByColumn.get(columnName)).join(', ');

  const insertSql = `INSERT INTO ${tableRef} (${insertColumnsSql}) VALUES (${insertValuesSql})`;

  const keyColumns = new Set(['from_hotspot_id', 'to_hotspot_id', 'between_hotspot_id', 'created_at']);
  const updateClauses: string[] = [];

  for (const columnName of orderedWritableColumns) {
    if (keyColumns.has(columnName)) continue;

    if (columnName === 'updated_at') {
      updateClauses.push('`updated_at` = NOW()');
      continue;
    }

    updateClauses.push(`\`${columnName}\` = VALUES(\`${columnName}\`)`);
  }

  const upsertSql = `${insertSql} ON DUPLICATE KEY UPDATE ${updateClauses.join(', ')}`;

  return {
    insertSql,
    upsertSql,
    extractValues,
  };
}

async function fetchDistinctRoutePairs(targetDb: string): Promise<Pair[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ from_hotspot_id: number; to_hotspot_id: number }>>(
    `SELECT DISTINCT from_hotspot_id, to_hotspot_id
     FROM \`${targetDb}\`.\`hotspot_route_between_map\``,
  );

  return rows
    .map((row) => ({
      fromHotspotId: Number(row.from_hotspot_id),
      toHotspotId: Number(row.to_hotspot_id),
    }))
    .filter((row) => Number.isInteger(row.fromHotspotId) && Number.isInteger(row.toHotspotId));
}

function discoverChains(pairs: Pair[]): Chain[] {
  const adjacency = new Map<number, Set<number>>();

  for (const pair of pairs) {
    if (!adjacency.has(pair.fromHotspotId)) {
      adjacency.set(pair.fromHotspotId, new Set<number>());
    }
    adjacency.get(pair.fromHotspotId)?.add(pair.toHotspotId);
  }

  const seen = new Set<string>();
  const chains: Chain[] = [];

  for (const pair of pairs) {
    const a = pair.fromHotspotId;
    const c = pair.toHotspotId;
    const nextStops = adjacency.get(c);
    if (!nextStops) continue;

    nextStops.forEach((b) => {
      if (a === b) return;
      if (a === c || c === b) return;

      const key = chainKey(a, c, b);
      if (seen.has(key)) return;
      seen.add(key);

      chains.push({ a, c, b });
    });
  }

  return chains;
}

async function fetchExistingDerivedPairKeys(targetDb: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ from_hotspot_id: number; to_hotspot_id: number }>>(
    `SELECT DISTINCT from_hotspot_id, to_hotspot_id
     FROM \`${targetDb}\`.\`hotspot_route_between_derived_map\``,
  );

  const out = new Set<string>();
  for (const row of rows) {
    out.add(pairKey(Number(row.from_hotspot_id), Number(row.to_hotspot_id)));
  }
  return out;
}

async function fetchPreferredDoneMatrixLeg(targetDb: string, from: number, to: number): Promise<MatrixLeg | null> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      from_hotspot_id: number;
      to_hotspot_id: number;
      osrm_distance_km: number | null;
      osrm_duration_min: number | null;
    }>
  >(
    `SELECT from_hotspot_id, to_hotspot_id, osrm_distance_km, osrm_duration_min
     FROM \`${targetDb}\`.\`hotspot_route_matrix\`
     WHERE process_status = 'DONE'
       AND (
         (from_hotspot_id = ? AND to_hotspot_id = ?)
         OR
         (from_hotspot_id = ? AND to_hotspot_id = ?)
       )
     ORDER BY
       CASE
         WHEN from_hotspot_id = ? AND to_hotspot_id = ? THEN 0
         ELSE 1
       END
     LIMIT 1`,
    from,
    to,
    to,
    from,
    from,
    to,
  );

  const row = rows[0];
  if (!row) return null;

  const distanceKm = Number(row.osrm_distance_km);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return null;
  }

  const durationMinRaw = row.osrm_duration_min;
  const durationMin = durationMinRaw !== null && Number.isFinite(Number(durationMinRaw)) ? Number(durationMinRaw) : null;

  return {
    fromHotspotId: Number(row.from_hotspot_id),
    toHotspotId: Number(row.to_hotspot_id),
    osrmDistanceKm: distanceKm,
    osrmDurationMin: durationMin,
  };
}

async function fetchBetweenRowsForPairEitherDirection(
  targetDb: string,
  from: number,
  to: number,
): Promise<BetweenSeedRow[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      between_hotspot_id: number;
      between_hotspot_name: string | null;
      route_fit_type: string | null;
      inserted_route_distance_km: number | null;
      candidate_progress_on_ab_ratio: number | null;
      created_at: Date | null;
    }>
  >(
    `SELECT
       between_hotspot_id,
       between_hotspot_name,
       route_fit_type,
       inserted_route_distance_km,
       candidate_progress_on_ab_ratio,
       created_at
     FROM \`${targetDb}\`.\`hotspot_route_between_map\`
     WHERE
       (from_hotspot_id = ? AND to_hotspot_id = ?)
       OR
       (from_hotspot_id = ? AND to_hotspot_id = ?)
     ORDER BY candidate_progress_on_ab_ratio ASC, id ASC`,
    from,
    to,
    to,
    from,
  );

  return rows.map((row) => ({
    betweenHotspotId: Number(row.between_hotspot_id),
    betweenHotspotName: row.between_hotspot_name,
    routeFitType: row.route_fit_type,
    insertedRouteDistanceKm: row.inserted_route_distance_km !== null ? Number(row.inserted_route_distance_km) : null,
    candidateProgressOnAbRatio:
      row.candidate_progress_on_ab_ratio !== null ? Number(row.candidate_progress_on_ab_ratio) : null,
    createdAt: row.created_at,
  }));
}

function buildOrderedCandidates(chain: Chain, acRows: BetweenSeedRow[], cbRows: BetweenSeedRow[]): number[] {
  const orderedIds: number[] = [];

  for (const row of acRows) {
    orderedIds.push(row.betweenHotspotId);
  }

  orderedIds.push(chain.c);

  for (const row of cbRows) {
    orderedIds.push(row.betweenHotspotId);
  }

  const seen = new Set<number>();
  const unique: number[] = [];

  for (const hotspotId of orderedIds) {
    if (!Number.isInteger(hotspotId) || hotspotId <= 0) continue;
    if (hotspotId === chain.a || hotspotId === chain.b) continue;
    if (seen.has(hotspotId)) continue;
    seen.add(hotspotId);
    unique.push(hotspotId);
  }

  return unique;
}

async function fetchHotspotRefs(targetDb: string, hotspotIds: number[]): Promise<Map<number, HotspotRef>> {
  const uniqueIds = Array.from(new Set(hotspotIds)).filter((id) => Number.isInteger(id) && id > 0);
  if (!uniqueIds.length) {
    return new Map<number, HotspotRef>();
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      hotspot_ID: number;
      hotspot_name: string | null;
      hotspot_location: string | null;
    }>
  >(
    `SELECT hotspot_ID, hotspot_name, hotspot_location
     FROM \`${targetDb}\`.\`dvi_hotspot_place\`
     WHERE deleted = 0
       AND hotspot_ID IN (${placeholders})`,
    ...uniqueIds,
  );

  const out = new Map<number, HotspotRef>();
  for (const row of rows) {
    const hotspotId = Number(row.hotspot_ID);
    if (!Number.isInteger(hotspotId) || hotspotId <= 0) continue;

    out.set(hotspotId, {
      hotspotId,
      hotspotName: String(row.hotspot_name ?? '').trim() || `Hotspot-${hotspotId}`,
      hotspotLocation: String(row.hotspot_location ?? '').trim() || null,
    });
  }

  return out;
}

async function fetchExistingDerivedBetweenIdsForPair(
  targetDb: string,
  fromHotspotId: number,
  toHotspotId: number,
): Promise<Set<number>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ between_hotspot_id: number }>>(
    `SELECT between_hotspot_id
     FROM \`${targetDb}\`.\`hotspot_route_between_derived_map\`
     WHERE from_hotspot_id = ?
       AND to_hotspot_id = ?`,
    fromHotspotId,
    toHotspotId,
  );

  const out = new Set<number>();
  for (const row of rows) {
    out.add(Number(row.between_hotspot_id));
  }
  return out;
}

async function processChains(args: InputArgs): Promise<DerivedSummary> {
  const summary: DerivedSummary = {
    targetDb: args.targetDb,
    apply: args.apply,
    force: args.force,
    totalPairsLoaded: 0,
    chainsDiscovered: 0,
    chainsProcessed: 0,
    chainsSkippedExisting: 0,
    chainsSkippedMissingMatrixLegs: 0,
    chainsSkippedOverDistance: 0,
    chainsSkippedLowBetweenCount: 0,
    derivedCandidatesTotal: 0,
    rowsDryRun: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkippedExisting: 0,
    candidatesSkippedMissingHotspot: 0,
    failed: 0,
  };

  await ensureDerivedTable(args.targetDb);

  const destinationColumns = await fetchDestinationColumns(args.targetDb);
  const writePlan = buildWritePlan(args.targetDb, destinationColumns);

  const pairs = await fetchDistinctRoutePairs(args.targetDb);
  summary.totalPairsLoaded = pairs.length;

  const chains = discoverChains(pairs);
  summary.chainsDiscovered = chains.length;

  const existingPairKeys = !args.force ? await fetchExistingDerivedPairKeys(args.targetDb) : new Set<string>();

  const candidateChains: Chain[] = [];
  for (const chain of chains) {
    if (!args.force && existingPairKeys.has(pairKey(chain.a, chain.b))) {
      summary.chainsSkippedExisting += 1;
      continue;
    }
    candidateChains.push(chain);
  }

  const limitedChains = args.limitChains ? candidateChains.slice(0, args.limitChains) : candidateChains;

  for (const chain of limitedChains) {
    summary.chainsProcessed += 1;

    console.log(`AUTO CHAIN START ${chain.a}->${chain.c}->${chain.b}`);

    try {
      const acLeg = await fetchPreferredDoneMatrixLeg(args.targetDb, chain.a, chain.c);
      const cbLeg = await fetchPreferredDoneMatrixLeg(args.targetDb, chain.c, chain.b);

      if (!acLeg || !cbLeg) {
        summary.chainsSkippedMissingMatrixLegs += 1;
        console.log('A-C distance: n/a');
        console.log('C-B distance: n/a');
        console.log('totalDistance: n/a');
        console.log('A-C between count: 0');
        console.log('C-B between count: 0');
        console.log('total unique candidates: 0');
        console.log('inserted count: 0');
        console.log('skipped existing row count: 0');
        console.log('updated count: 0');
        continue;
      }

      const totalDistance = acLeg.osrmDistanceKm + cbLeg.osrmDistanceKm;

      console.log(`A-C distance: ${formatNullableNumber(acLeg.osrmDistanceKm)} km`);
      console.log(`C-B distance: ${formatNullableNumber(cbLeg.osrmDistanceKm)} km`);
      console.log(`totalDistance: ${formatNullableNumber(totalDistance)} km`);

      if (totalDistance > args.maxLocationRouteKm) {
        summary.chainsSkippedOverDistance += 1;
        console.log('A-C between count: 0');
        console.log('C-B between count: 0');
        console.log('total unique candidates: 0');
        console.log('inserted count: 0');
        console.log('skipped existing row count: 0');
        console.log('updated count: 0');
        continue;
      }

      const acBetweenRows = await fetchBetweenRowsForPairEitherDirection(args.targetDb, chain.a, chain.c);
      const cbBetweenRows = await fetchBetweenRowsForPairEitherDirection(args.targetDb, chain.c, chain.b);

      const combinedBetweenCount = acBetweenRows.length + cbBetweenRows.length;

      console.log(`A-C between count: ${acBetweenRows.length}`);
      console.log(`C-B between count: ${cbBetweenRows.length}`);

      if (combinedBetweenCount < args.minBetweenCount) {
        summary.chainsSkippedLowBetweenCount += 1;
        console.log('total unique candidates: 0');
        console.log('inserted count: 0');
        console.log('skipped existing row count: 0');
        console.log('updated count: 0');
        continue;
      }

      const orderedCandidates = buildOrderedCandidates(chain, acBetweenRows, cbBetweenRows);
      summary.derivedCandidatesTotal += orderedCandidates.length;

      console.log(`total unique candidates: ${orderedCandidates.length}`);

      if (!orderedCandidates.length) {
        console.log('inserted count: 0');
        console.log('skipped existing row count: 0');
        console.log('updated count: 0');
        continue;
      }

      const hotspotMap = await fetchHotspotRefs(args.targetDb, [chain.a, chain.b, chain.c, ...orderedCandidates]);
      const fromHotspot = hotspotMap.get(chain.a);
      const toHotspot = hotspotMap.get(chain.b);
      const chainHotspot = hotspotMap.get(chain.c);

      if (!fromHotspot || !toHotspot || !chainHotspot) {
        summary.failed += 1;
        console.warn(`CHAIN SKIP missing hotspot metadata for ${chain.a}->${chain.c}->${chain.b}`);
        console.log('inserted count: 0');
        console.log('skipped existing row count: 0');
        console.log('updated count: 0');
        continue;
      }

      let insertedCount = 0;
      let updatedCount = 0;
      let skippedExistingRows = 0;

      const existingBetweenIds = args.apply && !args.force
        ? await fetchExistingDerivedBetweenIdsForPair(args.targetDb, chain.a, chain.b)
        : new Set<number>();

      for (const candidateId of orderedCandidates) {
        const candidateHotspot = hotspotMap.get(candidateId);

        if (!candidateHotspot) {
          summary.candidatesSkippedMissingHotspot += 1;
          console.warn(`DERIVED WARN missing hotspot details for candidate ${candidateId} in chain ${chain.a}->${chain.c}->${chain.b}`);
          continue;
        }

        const rowPayload: DerivedRowPayload = {
          fromHotspotId: chain.a,
          fromHotspotName: fromHotspot.hotspotName,
          fromHotspotLocation: fromHotspot.hotspotLocation,
          toHotspotId: chain.b,
          toHotspotName: toHotspot.hotspotName,
          toHotspotLocation: toHotspot.hotspotLocation,
          betweenHotspotId: candidateId,
          betweenHotspotName: candidateHotspot.hotspotName,
          acOsrmDistanceKm: acLeg.osrmDistanceKm,
          cbOsrmDistanceKm: cbLeg.osrmDistanceKm,
          insertedRouteDistanceKm: totalDistance,
          chainHotspotIds: `${chain.a},${chain.c},${chain.b}`,
        };

        if (!args.apply) {
          summary.rowsDryRun += 1;
          console.log(`DERIVED DRY-RUN ${chain.a}->${candidateId}->${chain.b} via ${chain.c}`);
          continue;
        }

        if (!args.force && existingBetweenIds.has(candidateId)) {
          summary.rowsSkippedExisting += 1;
          skippedExistingRows += 1;
          console.log(`DERIVED SKIP EXISTING ${chain.a}->${candidateId}->${chain.b}`);
          continue;
        }

        const values = writePlan.extractValues(rowPayload);

        if (args.force) {
          await prisma.$executeRawUnsafe(writePlan.upsertSql, ...values);
          updatedCount += 1;
          summary.rowsUpdated += 1;
          console.log(`DERIVED UPDATE ${chain.a}->${candidateId}->${chain.b}`);
        } else {
          await prisma.$executeRawUnsafe(writePlan.insertSql, ...values);
          insertedCount += 1;
          summary.rowsInserted += 1;
          console.log(`DERIVED INSERT ${chain.a}->${candidateId}->${chain.b}`);
        }
      }

      if (!args.apply) {
        console.log(`candidate list: [${orderedCandidates.join(', ')}]`);
      }

      console.log(`inserted count: ${insertedCount}`);
      console.log(`skipped existing row count: ${skippedExistingRows}`);
      console.log(`updated count: ${updatedCount}`);
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`AUTO CHAIN FAIL ${chain.a}->${chain.c}->${chain.b}: ${message}`);
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const raw = parseArgs(process.argv.slice(2));

  if (raw.help) {
    usage();
    return;
  }

  const args = normalizeArgs(raw);

  console.log(`targetDb: ${args.targetDb}`);
  console.log(`apply mode: ${args.apply}`);
  console.log(`force mode: ${args.force}`);
  console.log(`maxLocationRouteKm: ${args.maxLocationRouteKm}`);
  console.log(`limitChains: ${args.limitChains ?? null}`);
  console.log(`minBetweenCount: ${args.minBetweenCount}`);

  const summary = await processChains(args);

  console.log('Final summary:');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`derive-chain-between-hotspots failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
