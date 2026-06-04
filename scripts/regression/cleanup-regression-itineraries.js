#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { PrismaClient, Prisma } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'tmp', 'regression-results');

const REGRESSION_QUOTE_PATTERNS = [
  /^regression-case-\d+$/i,
  /^reg_case_\d+$/i,
  /^top10-case-\d+$/i,
];

const BLOCKED_QUOTE_PREFIXES = ['DVI', 'DVI20', 'LIVE', 'PROD'];

const PLAN_DELETE_TABLES = [
  { label: 'dvi_itinerary_route_hotspot_parking_charge', model: 'dvi_itinerary_route_hotspot_parking_charge', table: 'dvi_itinerary_route_hotspot_parking_charge', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_route_activity_details', model: 'dvi_itinerary_route_activity_details', table: 'dvi_itinerary_route_activity_details', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_route_guide_details', model: 'dvi_itinerary_route_guide_details', table: 'dvi_itinerary_route_guide_details', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_route_hotspot_details', model: 'dvi_itinerary_route_hotspot_details', table: 'dvi_itinerary_route_hotspot_details', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_route_hotspot_entry_cost_details', model: 'dvi_itinerary_route_hotspot_entry_cost_details', table: 'dvi_itinerary_route_hotspot_entry_cost_details', column: 'itinerary_plan_id' },
  { label: 'dvi_itinerary_via_route_details', model: 'dvi_itinerary_via_route_details', table: 'dvi_itinerary_via_route_details', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_plan_route_permit_charge', model: 'dvi_itinerary_plan_route_permit_charge', table: 'dvi_itinerary_plan_route_permit_charge', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_plan_hotel_room_amenities', model: 'dvi_itinerary_plan_hotel_room_amenities', table: 'dvi_itinerary_plan_hotel_room_amenities', column: 'itinerary_plan_id' },
  { label: 'dvi_itinerary_plan_hotel_room_details', model: 'dvi_itinerary_plan_hotel_room_details', table: 'dvi_itinerary_plan_hotel_room_details', column: 'itinerary_plan_id' },
  { label: 'dvi_itinerary_plan_hotel_details', model: 'dvi_itinerary_plan_hotel_details', table: 'dvi_itinerary_plan_hotel_details', column: 'itinerary_plan_id' },
  { label: 'dvi_itinerary_plan_vendor_vehicle_details', model: 'dvi_itinerary_plan_vendor_vehicle_details', table: 'dvi_itinerary_plan_vendor_vehicle_details', column: 'itinerary_plan_id' },
  { label: 'dvi_itinerary_plan_vendor_eligible_list', model: 'dvi_itinerary_plan_vendor_eligible_list', table: 'dvi_itinerary_plan_vendor_eligible_list', column: 'itinerary_plan_id' },
  { label: 'dvi_itinerary_plan_vehicle_details', model: 'dvi_itinerary_plan_vehicle_details', table: 'dvi_itinerary_plan_vehicle_details', column: 'itinerary_plan_id' },
  { label: 'dvi_itinerary_traveller_details', model: 'dvi_itinerary_traveller_details', table: 'dvi_itinerary_traveller_details', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_route_details', model: 'dvi_itinerary_route_details', table: 'dvi_itinerary_route_details', column: 'itinerary_plan_ID' },
  { label: 'dvi_itinerary_plan_details', model: 'dvi_itinerary_plan_details', table: 'dvi_itinerary_plan_details', column: 'itinerary_plan_ID' },
];

function isRegressionQuoteId(value) {
  const text = String(value ?? '').trim();
  return REGRESSION_QUOTE_PATTERNS.some((pattern) => pattern.test(text));
}

function isBlockedQuoteId(value) {
  const upper = String(value ?? '').trim().toUpperCase();
  return BLOCKED_QUOTE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function formatDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function normalizePlanId(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function extractCandidatesFromJsonNode(node, results) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) extractCandidatesFromJsonNode(item, results);
    return;
  }

  if ('planId' in node || 'quoteId' in node) {
    const planId = normalizePlanId(node.planId);
    const quoteId = String(node.quoteId ?? '').trim();
    if (planId && quoteId) {
      results.push({ planId, quoteId, source: 'tmp/regression-results' });
    }
  }

  for (const value of Object.values(node)) {
    extractCandidatesFromJsonNode(value, results);
  }
}

function loadSecondaryCandidates() {
  const candidates = [];
  if (!fs.existsSync(RESULTS_DIR)) {
    return candidates;
  }

  const stack = [RESULTS_DIR];
  while (stack.length) {
    const currentDir = stack.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        extractCandidatesFromJsonNode(parsed, candidates);
      } catch {
        // Ignore malformed result files; discovery should stay best-effort.
      }
    }
  }

  return candidates;
}

async function fetchPlanSummaries(prisma) {
  const primaryRows = await prisma.dvi_itinerary_plan_details.findMany({
    where: {
      itinerary_quote_ID: { not: null },
    },
    select: {
      itinerary_plan_ID: true,
      itinerary_quote_ID: true,
      createdon: true,
      status: true,
      deleted: true,
    },
    orderBy: [{ createdon: 'desc' }, { itinerary_plan_ID: 'desc' }],
  });

  return primaryRows.filter((row) => isRegressionQuoteId(row.itinerary_quote_ID) && !isBlockedQuoteId(row.itinerary_quote_ID));
}

async function fetchPlanRowById(prisma, planId) {
  if (!planId) return null;
  return prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_plan_ID: Number(planId) },
    select: {
      itinerary_plan_ID: true,
      itinerary_quote_ID: true,
      createdon: true,
      status: true,
      deleted: true,
    },
  });
}

async function fetchPlanRowByQuoteId(prisma, quoteId) {
  const normalizedQuoteId = String(quoteId ?? '').trim();
  if (!normalizedQuoteId) return null;
  return prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_quote_ID: normalizedQuoteId },
    select: {
      itinerary_plan_ID: true,
      itinerary_quote_ID: true,
      createdon: true,
      status: true,
      deleted: true,
    },
  });
}

async function discoverRegressionPlans(prisma) {
  const primaryRows = await fetchPlanSummaries(prisma);
  const plansById = new Map();

  for (const row of primaryRows) {
    plansById.set(Number(row.itinerary_plan_ID), {
      planId: Number(row.itinerary_plan_ID),
      quoteId: String(row.itinerary_quote_ID || '').trim(),
      createdon: row.createdon,
      status: row.status,
      deleted: row.deleted,
      source: 'db-primary',
    });
  }

  const secondaryCandidates = loadSecondaryCandidates();
  for (const candidate of secondaryCandidates) {
    if (plansById.has(candidate.planId)) continue;
    const dbRow = await fetchPlanRowById(prisma, candidate.planId);
    if (!dbRow) continue;
    const quoteId = String(dbRow.itinerary_quote_ID || '').trim();
    if (!isRegressionQuoteId(quoteId) || isBlockedQuoteId(quoteId)) continue;
    plansById.set(Number(dbRow.itinerary_plan_ID), {
      planId: Number(dbRow.itinerary_plan_ID),
      quoteId,
      createdon: dbRow.createdon,
      status: dbRow.status,
      deleted: dbRow.deleted,
      source: 'results-verified',
    });
  }

  return [...plansById.values()].sort((a, b) => a.planId - b.planId);
}

async function discoverRegressionPlansForQuoteId(prisma, quoteId) {
  const row = await fetchPlanRowByQuoteId(prisma, quoteId);
  if (!row) return [];
  const normalizedQuoteId = String(row.itinerary_quote_ID || '').trim();
  if (!isRegressionQuoteId(normalizedQuoteId) || isBlockedQuoteId(normalizedQuoteId)) {
    return [];
  }
  return [{
    planId: Number(row.itinerary_plan_ID),
    quoteId: normalizedQuoteId,
    createdon: row.createdon,
    status: row.status,
    deleted: row.deleted,
    source: 'db-quote',
  }];
}

function getModelDelegate(client, modelName) {
  const delegate = client[modelName];
  return delegate && typeof delegate.count === 'function' && typeof delegate.deleteMany === 'function' ? delegate : null;
}

async function countRows(client, tableMeta, planIds) {
  if (!planIds.length) return 0;
  const delegate = getModelDelegate(client, tableMeta.model);
  if (delegate) {
    return delegate.count({
      where: {
        [tableMeta.column]: { in: planIds },
      },
    });
  }

  const rows = await client.$queryRaw(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${Prisma.raw(tableMeta.table)} WHERE ${Prisma.raw(tableMeta.column)} IN (${Prisma.join(planIds)})`,
  );
  const value = Array.isArray(rows) && rows[0] ? rows[0].count : 0;
  return Number(value || 0);
}

async function deleteRows(client, tableMeta, planIds) {
  if (!planIds.length) return 0;
  const delegate = getModelDelegate(client, tableMeta.model);
  if (delegate) {
    const result = await delegate.deleteMany({
      where: {
        [tableMeta.column]: { in: planIds },
      },
    });
    return Number(result?.count || 0);
  }

  const result = await client.$executeRaw(
    Prisma.sql`DELETE FROM ${Prisma.raw(tableMeta.table)} WHERE ${Prisma.raw(tableMeta.column)} IN (${Prisma.join(planIds)})`,
  );
  return Number(result || 0);
}

async function gatherRouteAndHotspotCounts(prisma, planIds) {
  if (!planIds.length) return new Map();
  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: { in: planIds }, deleted: 0 },
    select: { itinerary_plan_ID: true },
  });
  const hotspots = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: { in: planIds }, deleted: 0 },
    select: { itinerary_plan_ID: true },
  });
  const routeCounts = new Map();
  const hotspotCounts = new Map();
  for (const row of routes) {
    const key = Number(row.itinerary_plan_ID);
    routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
  }
  for (const row of hotspots) {
    const key = Number(row.itinerary_plan_ID);
    hotspotCounts.set(key, (hotspotCounts.get(key) || 0) + 1);
  }
  return { routeCounts, hotspotCounts };
}

function printMatchedPlans(plans, routeCounts, hotspotCounts) {
  if (!plans.length) {
    console.log('0 regression plans found');
    return;
  }

  console.log('Matched regression itineraries:');
  for (const plan of plans) {
    const planId = Number(plan.planId);
    console.log(
      [
        `- Plan ID: ${planId}`,
        `Quote ID: ${plan.quoteId}`,
        `Created Date: ${formatDate(plan.createdon)}`,
        `Status: ${plan.status}`,
        `Route Count: ${routeCounts.get(planId) || 0}`,
        `Hotspot Count: ${hotspotCounts.get(planId) || 0}`,
      ].join(' | '),
    );
  }
}

function printTableCounts(header, counts) {
  console.log(header);
  for (const entry of counts) {
    console.log(`- ${entry.label}: ${entry.count}`);
  }
}

async function cleanupRegressionItineraries({ apply = false } = {}) {
  const quoteIdIndex = process.argv.indexOf('--quote-id');
  const explicitQuoteId = quoteIdIndex >= 0 ? String(process.argv[quoteIdIndex + 1] || '').trim() : '';
  const prisma = new PrismaClient();
  try {
    const plans = explicitQuoteId
      ? await discoverRegressionPlansForQuoteId(prisma, explicitQuoteId)
      : await discoverRegressionPlans(prisma);
    const planIds = plans.map((plan) => Number(plan.planId)).filter((id) => Number.isFinite(id) && id > 0);

    const { routeCounts, hotspotCounts } = await gatherRouteAndHotspotCounts(prisma, planIds);
    printMatchedPlans(plans, routeCounts, hotspotCounts);

    if (!plans.length) {
      return { plans, deleted: false, tableCounts: [] };
    }

    const tableCounts = [];
    for (const tableMeta of PLAN_DELETE_TABLES) {
      const count = await countRows(prisma, tableMeta, planIds);
      tableCounts.push({ label: tableMeta.label, count });
    }

    printTableCounts('Row counts by table:', tableCounts);

    if (!apply) {
      console.log('DRY RUN ONLY. Re-run with --apply to delete.');
      console.log('No deletion performed.');
      return { plans, deleted: false, tableCounts };
    }

    const deletedCounts = await prisma.$transaction(async (tx) => {
      const counts = [];
      for (const tableMeta of PLAN_DELETE_TABLES) {
        const deleted = await deleteRows(tx, tableMeta, planIds);
        counts.push({ label: tableMeta.label, count: deleted });
      }
      return counts;
    });

    printTableCounts('Deleted counts by table:', deletedCounts);
    return { plans, deleted: true, tableCounts: deletedCounts };
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  await cleanupRegressionItineraries({ apply });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[REGRESSION_CLEANUP] Failed:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanupRegressionItineraries,
  discoverRegressionPlans,
  discoverRegressionPlansForQuoteId,
  isRegressionQuoteId,
  isBlockedQuoteId,
};
