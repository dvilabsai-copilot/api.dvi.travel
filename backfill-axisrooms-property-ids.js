require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const PREFIX = 'AX_DVI_HOTEL_';

function usage() {
  console.log('Usage: node backfill-axisrooms-property-ids.js [options]');
  console.log('');
  console.log('Backfills dvi_hotel.axisrooms_property_id using the pattern AX_DVI_HOTEL_{hotel_id}.');
  console.log('');
  console.log('Options:');
  console.log('  --apply               Execute the updates. Without this flag, the script runs in dry-run mode.');
  console.log('  --only-missing        Update only rows where axisrooms_property_id is null or empty.');
  console.log('  --only-enabled        Update only rows where axisrooms_enabled = 1.');
  console.log('  --include-deleted     Include rows where deleted = 1. By default, deleted rows are skipped.');
  console.log('  --batch-size <n>      Number of rows to update per transaction batch. Default: 500');
  console.log('  --help                Show this help text.');
  console.log('');
  console.log('Examples:');
  console.log('  node backfill-axisrooms-property-ids.js');
  console.log('  node backfill-axisrooms-property-ids.js --apply');
  console.log('  node backfill-axisrooms-property-ids.js --apply --only-missing');
  console.log('  node backfill-axisrooms-property-ids.js --apply --only-enabled --batch-size 200');
}

function parseArgs(argv) {
  const out = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
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

function normalizeArgs(raw) {
  const apply = Boolean(raw.apply);
  const onlyMissing = Boolean(raw['only-missing']);
  const onlyEnabled = Boolean(raw['only-enabled']);
  const includeDeleted = Boolean(raw['include-deleted']);
  const batchSize = raw['batch-size'] ? Number(raw['batch-size']) : 500;

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Invalid --batch-size. It must be a positive integer.');
  }

  return {
    apply,
    onlyMissing,
    onlyEnabled,
    includeDeleted,
    batchSize,
  };
}

function buildWhere(input) {
  const where = {};

  if (!input.includeDeleted) {
    where.OR = [{ deleted: false }, { deleted: null }];
  }

  if (input.onlyEnabled) {
    where.axisrooms_enabled = 1;
  }

  if (input.onlyMissing) {
    where.AND = [{ OR: [{ axisrooms_property_id: null }, { axisrooms_property_id: '' }] }];
  }

  return where;
}

function buildTargetPropertyId(hotelId) {
  return `${PREFIX}${hotelId}`;
}

async function fetchCandidates(where) {
  const hotels = await prisma.dvi_hotel.findMany({
    where,
    select: {
      hotel_id: true,
      hotel_code: true,
      hotel_name: true,
      axisrooms_property_id: true,
      axisrooms_enabled: true,
      deleted: true,
    },
    orderBy: {
      hotel_id: 'asc',
    },
  });

  return hotels.map((hotel) => ({
    ...hotel,
    target_axisrooms_property_id: buildTargetPropertyId(hotel.hotel_id),
  }));
}

function splitIntoChunks(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function applyUpdates(rows, batchSize) {
  const chunks = splitIntoChunks(rows, batchSize);
  let updated = 0;

  for (const chunk of chunks) {
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.dvi_hotel.update({
          where: { hotel_id: row.hotel_id },
          data: { axisrooms_property_id: row.target_axisrooms_property_id },
        }),
      ),
    );

    updated += chunk.length;
    console.log(`Updated ${updated}/${rows.length} rows`);
  }
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  if (rawArgs.help) {
    usage();
    process.exit(0);
  }

  const input = normalizeArgs(rawArgs);
  const where = buildWhere(input);
  const candidates = await fetchCandidates(where);
  const rowsToChange = candidates.filter(
    (row) => row.axisrooms_property_id !== row.target_axisrooms_property_id,
  );

  const summary = {
    mode: input.apply ? 'apply' : 'dry-run',
    filters: {
      onlyMissing: input.onlyMissing,
      onlyEnabled: input.onlyEnabled,
      includeDeleted: input.includeDeleted,
      batchSize: input.batchSize,
    },
    scannedRows: candidates.length,
    rowsToChange: rowsToChange.length,
    unchangedRows: candidates.length - rowsToChange.length,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (rowsToChange.length === 0) {
    console.log('No rows need updating.');
    return;
  }

  const preview = rowsToChange.slice(0, 20).map((row) => ({
    hotel_id: row.hotel_id,
    hotel_code: row.hotel_code,
    hotel_name: row.hotel_name,
    current_axisrooms_property_id: row.axisrooms_property_id,
    target_axisrooms_property_id: row.target_axisrooms_property_id,
    axisrooms_enabled: row.axisrooms_enabled,
    deleted: row.deleted,
  }));

  console.log('Preview of rows to change (first 20):');
  console.log(JSON.stringify(preview, null, 2));

  if (!input.apply) {
    console.log('Dry-run only. Re-run with --apply to execute updates.');
    return;
  }

  await applyUpdates(rowsToChange, input.batchSize);
  console.log(`Completed. Updated ${rowsToChange.length} rows.`);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ success: false, message: error.message }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });