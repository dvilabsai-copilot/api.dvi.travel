import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DEFAULT_MIN_DISTANCE_KM = 10;

type InputArgs = {
  apply: boolean;
  minDistanceKm: number;
  includeDeleted: boolean;
  batchSize: number;
};

type SourceSeed = {
  source_location: string;
  source_location_lattitude: string;
  source_location_longitude: string;
  source_location_city: string;
  source_location_state: string;
};

function usage() {
  console.log('Usage: npx tsx scripts/backfill-location-self-routes.ts [options]');
  console.log('');
  console.log('Creates missing self-routes (A -> A) in dvi_stored_locations.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                 Execute inserts. Without this flag, dry-run only.');
  console.log('  --min-distance-km <n>   Distance for self-routes. Default: 10');
  console.log('  --include-deleted       Include deleted rows while scanning source locations.');
  console.log('  --batch-size <n>        Insert rows per batch. Default: 200');
  console.log('  --help                  Show help text.');
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

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

function normalizeArgs(raw: Record<string, string | boolean>): InputArgs {
  const apply = Boolean(raw.apply);
  const includeDeleted = Boolean(raw['include-deleted']);
  const minDistanceKm = raw['min-distance-km']
    ? Number(raw['min-distance-km'])
    : DEFAULT_MIN_DISTANCE_KM;
  const batchSize = raw['batch-size'] ? Number(raw['batch-size']) : 200;

  if (!Number.isFinite(minDistanceKm) || minDistanceKm < 0) {
    throw new Error('Invalid --min-distance-km. It must be a non-negative number.');
  }

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Invalid --batch-size. It must be a positive integer.');
  }

  return {
    apply,
    minDistanceKm,
    includeDeleted,
    batchSize,
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function estimateDurationText(distanceKm: number): string {
  const averageSpeedKmPerHour = 25;
  const totalHours = distanceKm / averageSpeedKmPerHour;

  let hours = Math.floor(totalHours);
  let mins = Math.round((totalHours - hours) * 60);

  if (mins === 60) {
    hours += 1;
    mins = 0;
  }

  return `${hours} hours ${mins} mins`;
}

function splitIntoChunks<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function collectSourceSeeds(includeDeleted: boolean): Promise<SourceSeed[]> {
  const rows = await prisma.dvi_stored_locations.findMany({
    where: includeDeleted ? undefined : { deleted: 0 },
    select: {
      source_location: true,
      source_location_lattitude: true,
      source_location_longitude: true,
      source_location_city: true,
      source_location_state: true,
    },
    orderBy: { source_location: 'asc' },
  });

  const unique = new Map<string, SourceSeed>();

  for (const row of rows) {
    const seed: SourceSeed = {
      source_location: normalizeText(row.source_location),
      source_location_lattitude: normalizeText(row.source_location_lattitude),
      source_location_longitude: normalizeText(row.source_location_longitude),
      source_location_city: normalizeText(row.source_location_city),
      source_location_state: normalizeText(row.source_location_state),
    };

    if (!seed.source_location) continue;

    const key = [
      seed.source_location.toLowerCase(),
      seed.source_location_lattitude,
      seed.source_location_longitude,
      seed.source_location_city.toLowerCase(),
      seed.source_location_state.toLowerCase(),
    ].join('||');

    if (!unique.has(key)) {
      unique.set(key, seed);
    }
  }

  return Array.from(unique.values());
}

async function buildMissingSelfRoutes(
  seeds: SourceSeed[],
  minDistanceKm: number,
): Promise<Array<Record<string, unknown>>> {
  const locationNames = Array.from(new Set(seeds.map((seed) => seed.source_location)));

  const existing = await prisma.dvi_stored_locations.findMany({
    where: {
      deleted: 0,
      source_location: { in: locationNames },
      destination_location: { in: locationNames },
    },
    select: {
      source_location: true,
      destination_location: true,
    },
  });

  const pairSet = new Set(
    existing.map((row) => `${normalizeText(row.source_location)}||${normalizeText(row.destination_location)}`),
  );

  const rowsToInsert: Array<Record<string, unknown>> = [];

  for (const seed of seeds) {
    const pair = `${seed.source_location}||${seed.source_location}`;
    if (pairSet.has(pair)) {
      continue;
    }

    rowsToInsert.push({
      source_location: seed.source_location,
      source_location_lattitude: seed.source_location_lattitude,
      source_location_longitude: seed.source_location_longitude,
      source_location_city: seed.source_location_city,
      source_location_state: seed.source_location_state,
      destination_location: seed.source_location,
      destination_location_lattitude: seed.source_location_lattitude,
      destination_location_longitude: seed.source_location_longitude,
      destination_location_city: seed.source_location_city,
      destination_location_state: seed.source_location_state,
      distance: Number(minDistanceKm.toFixed(6)),
      duration: estimateDurationText(minDistanceKm),
      location_description: null,
      status: 1,
      deleted: 0,
      createdon: new Date(),
    });

    pairSet.add(pair);
  }

  return rowsToInsert;
}

async function applyInsert(rows: Array<Record<string, unknown>>, batchSize: number) {
  let inserted = 0;
  const chunks = splitIntoChunks(rows, batchSize);

  for (const chunk of chunks) {
    await prisma.dvi_stored_locations.createMany({
      data: chunk as any,
    });

    inserted += chunk.length;
    console.log(`Inserted ${inserted}/${rows.length} self-routes`);
  }
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));

  if (raw.help) {
    usage();
    process.exit(0);
  }

  const input = normalizeArgs(raw);
  const seeds = await collectSourceSeeds(input.includeDeleted);
  const rowsToInsert = await buildMissingSelfRoutes(seeds, input.minDistanceKm);

  const summary = {
    mode: input.apply ? 'apply' : 'dry-run',
    scannedSourceSeeds: seeds.length,
    missingSelfRoutes: rowsToInsert.length,
    minDistanceKm: input.minDistanceKm,
    batchSize: input.batchSize,
    includeDeleted: input.includeDeleted,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!rowsToInsert.length) {
    console.log('No missing self-routes found.');
    return;
  }

  console.log('Preview (first 20):');
  console.log(
    JSON.stringify(
      rowsToInsert.slice(0, 20).map((row) => ({
        source_location: row.source_location,
        destination_location: row.destination_location,
        distance: row.distance,
        duration: row.duration,
      })),
      null,
      2,
    ),
  );

  if (!input.apply) {
    console.log('Dry-run only. Re-run with --apply to execute inserts.');
    return;
  }

  await applyInsert(rowsToInsert, input.batchSize);
  console.log(`Completed. Inserted ${rowsToInsert.length} self-routes.`);
}

main()
  .catch((error) => {
    console.error('Failed to backfill location self-routes:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
