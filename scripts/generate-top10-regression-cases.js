#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const PROJECT_ROOT = path.join(__dirname, '..');
const REGRESSION_ROOT = path.join(__dirname, 'regression');
const TOP10_DIR = path.join(REGRESSION_ROOT, 'top10');
const MANIFEST_PATH = path.join(TOP10_DIR, 'manifest.json');
const CASE_ID_PREFIX = 'top10-case-';
const CASE_COUNT = 10;
const PLAN_ID_START = Number.parseInt(process.env.TOP10_PLAN_ID_START || '9501', 10);
const BASE_DATE = String(process.env.TOP10_BASE_DATE || '2026-12-01').trim();
const DEFAULT_BASE_TIME = '08:00:00';
const DEFAULT_END_TIME = '20:00:00';
const TZ_OFFSET = '+05:30';
const TOP10_DATABASE_NAME = String(process.env.TOP10_DATABASE_NAME || 'dvi_travels').trim() || 'dvi_travels';

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toPlainText(value) {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return toPlainText(value)
    .replace(/\s*,\s*/g, ', ')
    .replace(/,{2,}/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLabel(value) {
  return toPlainText(value);
}

function parseJsonArrayField(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    const parsed = safeJsonParse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed != null) return [parsed];

    return [trimmed];
  }

  return [value];
}

function coerceKmValue(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';

  const text = String(value).trim();
  if (!text) return '';

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;

  return text;
}

function isInvalidDate(value) {
  return !value || Number.isNaN(new Date(value).getTime());
}

function addDays(baseDate, offset) {
  const [year, month, day] = String(baseDate).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function atOffset(dateString, timeString) {
  return `${dateString}T${timeString}${TZ_OFFSET}`;
}

function compareNullableDates(a, b) {
  const aTime = a ? new Date(a).getTime() : Number.POSITIVE_INFINITY;
  const bTime = b ? new Date(b).getTime() : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return 0;
}

function comparePatterns(a, b) {
  if (b.frequency !== a.frequency) return b.frequency - a.frequency;
  if (b.uniqueLocationCount !== a.uniqueLocationCount) return b.uniqueLocationCount - a.uniqueLocationCount;
  if (b.routeCount !== a.routeCount) return b.routeCount - a.routeCount;
  if (b.directMixBonus !== a.directMixBonus) return b.directMixBonus - a.directMixBonus;
  if (b.directOnCount !== a.directOnCount) return b.directOnCount - a.directOnCount;
  if (a.sourcePlanId !== b.sourcePlanId) return a.sourcePlanId - b.sourcePlanId;
  return String(a.patternKey).localeCompare(String(b.patternKey));
}

function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    const dayA = Number(a.no_of_days || 0);
    const dayB = Number(b.no_of_days || 0);
    if (dayA !== dayB) return dayA - dayB;

    const dateDiff = compareNullableDates(a.itinerary_route_date, b.itinerary_route_date);
    if (dateDiff !== 0) return dateDiff;

    return Number(a.itinerary_route_ID || 0) - Number(b.itinerary_route_ID || 0);
  });
}

function buildPatternRecord(plan, routes) {
  const orderedRoutes = sortRoutes(routes);
  const chain = [];
  const chainDisplay = [];
  const routeSegments = [];
  let zeroOrBlankKmRoutes = 0;
  let directOnCount = 0;
  let directOffCount = 0;
  const uniqueLocations = new Set();
  const normalizedChainLocations = new Set();

  orderedRoutes.forEach((route, index) => {
    const source = normalizeLabel(route.location_name);
    const destination = normalizeLabel(route.next_visiting_location);
    if (index === 0) {
      chainDisplay.push(source);
      chain.push(normalizeText(source));
      normalizedChainLocations.add(normalizeText(source));
      uniqueLocations.add(normalizeText(source));
    }
    chainDisplay.push(destination);
    chain.push(normalizeText(destination));
    normalizedChainLocations.add(normalizeText(destination));
    uniqueLocations.add(normalizeText(destination));
    routeSegments.push({
      source,
      destination,
      direct: Number(route.direct_to_next_visiting_place || 0) === 1 ? 1 : 0,
      no_of_km: route.no_of_km,
    });
    if (Number(route.direct_to_next_visiting_place || 0) === 1) {
      directOnCount += 1;
    } else {
      directOffCount += 1;
    }

    const kmText = String(route.no_of_km ?? '').trim();
    if (!kmText || kmText === '0' || kmText === '0.0' || kmText === '0.00' || kmText === '0.000') {
      zeroOrBlankKmRoutes += 1;
    }
  });

  const patternKey = chain.join(' -> ');
  const routeChain = chainDisplay.length ? chainDisplay : [];
  const routeCount = orderedRoutes.length;
  const directMixBonus = directOnCount > 0 && directOffCount > 0 ? 50 : 0;
  const uniqueLocationCount = normalizedChainLocations.size;

  return {
    patternKey,
    routeChain,
    routeSegments,
    routeCount,
    uniqueLocations,
    uniqueLocationCount,
    directOnCount,
    directOffCount,
    directMixBonus,
    zeroOrBlankKmRoutes,
    representativePlan: plan,
    sourcePlanId: Number(plan.itinerary_plan_ID || 0),
    sourceQuoteId: String(plan.itinerary_quote_ID || '').trim(),
    sourcePlanCreatedOn: plan.createdon || null,
    sourcePlanUpdatedOn: plan.updatedon || null,
    frequency: 1,
  };
}

function frequencyScore(frequency, uniqueLocationCount, routeCount, directMixBonus) {
  return frequency * 1000 + uniqueLocationCount * 100 + routeCount * 10 + directMixBonus;
}

function computePatternScore(pattern, coveredLocations) {
  let newlyCoveredLocationCount = 0;
  let alreadyCoveredLocationCount = 0;
  for (const location of pattern.uniqueLocations) {
    if (coveredLocations.has(location)) {
      alreadyCoveredLocationCount += 1;
    } else {
      newlyCoveredLocationCount += 1;
    }
  }

  const baseScore = frequencyScore(
    pattern.frequency,
    pattern.uniqueLocationCount,
    pattern.routeCount,
    pattern.directMixBonus,
  );

  return {
    baseScore,
    newlyCoveredLocationCount,
    alreadyCoveredLocationCount,
    diversityScore: baseScore + newlyCoveredLocationCount * 500 - alreadyCoveredLocationCount * 25,
  };
}

function parseDatabaseName() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\/+/, '');
    return pathname || null;
  } catch {
    return null;
  }
}

function buildExplicitDatabaseUrl() {
  const overrideUrl = String(process.env.TOP10_DATABASE_URL || '').trim();
  if (overrideUrl) {
    return overrideUrl;
  }

  const raw = String(process.env.DATABASE_URL || '').trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    parsed.pathname = `/${TOP10_DATABASE_NAME}`;
    return parsed.toString();
  } catch {
    return raw;
  }
}

async function getTableColumns(prisma, tableName) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    TOP10_DATABASE_NAME,
    tableName,
  );
  return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row.COLUMN_NAME || '').toLowerCase()));
}

function buildSelectList(existingColumns, requestedColumns) {
  return requestedColumns
    .map((column) => {
      if (existingColumns.has(String(column).toLowerCase())) {
        return `\`${column}\``;
      }
      return `NULL AS \`${column}\``;
    })
    .join(',\n      ');
}

async function detectActiveDatabaseName(prisma) {
  try {
    const rows = await prisma.$queryRaw`SELECT DATABASE() AS dbName`;
    const dbName = Array.isArray(rows) && rows.length ? rows[0]?.dbName : null;
    if (dbName) {
      return String(dbName);
    }
  } catch {
    // Fall back to URL parsing below.
  }
  return parseDatabaseName();
}

function buildPlanPayload(plan, routes, generatedPlanId, caseMeta) {
  const orderedRoutes = sortRoutes(routes);
  const routeCount = orderedRoutes.length;
  const firstRoute = orderedRoutes[0] || {};
  const lastRoute = orderedRoutes[orderedRoutes.length - 1] || {};
  const tripStartDate = addDays(BASE_DATE, caseMeta.caseIndex);
  const tripEndDate = addDays(BASE_DATE, caseMeta.caseIndex + routeCount - 1);

  return {
    plan: {
      itinerary_plan_id: generatedPlanId,
      agent_id: Number(plan.agent_id || 126),
      staff_id: Number(plan.staff_id || 0),
      location_id: Number(plan.location_id || 0),
      arrival_point: normalizeLabel(plan.arrival_location) || normalizeLabel(firstRoute.location_name) || '',
      departure_point: normalizeLabel(plan.departure_location) || normalizeLabel(lastRoute.next_visiting_location) || '',
      itinerary_preference: Number(plan.itinerary_preference || 2),
      itinerary_type: Number(plan.itinerary_type || 2),
      preferred_hotel_category: parseJsonArrayField(plan.preferred_hotel_category),
      hotel_facilities: parseJsonArrayField(plan.hotel_facilities),
      trip_start_date: atOffset(tripStartDate, DEFAULT_BASE_TIME),
      trip_end_date: atOffset(tripEndDate, DEFAULT_END_TIME),
      pick_up_date_and_time: atOffset(tripStartDate, DEFAULT_BASE_TIME),
      arrival_type: Number(plan.arrival_type || 1),
      departure_type: Number(plan.departure_type || 1),
      no_of_nights: Math.max(0, routeCount - 1),
      no_of_days: routeCount,
      budget: Number(plan.expecting_budget || 15000),
      entry_ticket_required: Number(plan.entry_ticket_required || 0),
      guide_for_itinerary: Number(plan.guide_for_itinerary || 0),
      nationality: Number(plan.nationality || 101),
      food_type: Number(plan.food_type || 0),
      meal_plan_code: String(plan.meal_plan_code || 'CP').trim() || 'CP',
      meal_plan_breakfast: Number(plan.meal_plan_breakfast || 1),
      meal_plan_lunch: Number(plan.meal_plan_lunch || 0),
      meal_plan_dinner: Number(plan.meal_plan_dinner || 0),
      adult_count: Number(plan.total_adult || 2),
      child_count: Number(plan.total_children || 0),
      infant_count: Number(plan.total_infants || 0),
      special_instructions: `TOP10 production-derived case from source plan ${plan.itinerary_plan_ID} / quote ${String(plan.itinerary_quote_ID || '').trim() || '(missing)'}, frequency=${caseMeta.frequency}`,
    },
    routes: orderedRoutes.map((route, index) => {
      const routeDate = addDays(tripStartDate, index);
      return {
        location_name: normalizeLabel(route.location_name),
        next_visiting_location: normalizeLabel(route.next_visiting_location),
        itinerary_route_date: atOffset(routeDate, '00:00:00'),
        no_of_days: index + 1,
        no_of_km: coerceKmValue(route.no_of_km),
        direct_to_next_visiting_place: Number(route.direct_to_next_visiting_place || 0),
        via_route: '',
        via_routes: [],
      };
    }),
    vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  };
}

function compareSelectedCases(a, b) {
  if (b.frequency !== a.frequency) return b.frequency - a.frequency;
  if (b.uniqueLocationCount !== a.uniqueLocationCount) return b.uniqueLocationCount - a.uniqueLocationCount;
  if (b.routeCount !== a.routeCount) return b.routeCount - a.routeCount;
  if (b.directMixBonus !== a.directMixBonus) return b.directMixBonus - a.directMixBonus;
  return a.caseIndex - b.caseIndex;
}

async function main() {
  if (!fs.existsSync(TOP10_DIR)) {
    fs.mkdirSync(TOP10_DIR, { recursive: true });
  }

  for (const entry of fs.readdirSync(TOP10_DIR)) {
    if (/^top10-case-\d+\.json$/.test(entry) || entry === 'manifest.json') {
      fs.rmSync(path.join(TOP10_DIR, entry), { force: true });
    }
  }

  const explicitDatabaseUrl = buildExplicitDatabaseUrl();
  if (!explicitDatabaseUrl) {
    throw new Error('DATABASE_URL is missing and TOP10_DATABASE_URL was not provided.');
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: explicitDatabaseUrl,
      },
    },
  });
  const warnings = [];
  const validationErrors = [];
  let totalLocationIdZeroRoutes = 0;
  let totalZeroOrBlankKmRoutes = 0;

  const dbName = await detectActiveDatabaseName(prisma);
  warnings.push(`Generator connected explicitly to ${dbName || TOP10_DATABASE_NAME}`);

  const planColumns = await getTableColumns(prisma, 'dvi_itinerary_plan_details');
  const routeColumns = await getTableColumns(prisma, 'dvi_itinerary_route_details');

  const planSelect = buildSelectList(planColumns, [
    'itinerary_plan_ID',
    'itinerary_quote_ID',
    'agent_id',
    'staff_id',
    'location_id',
    'arrival_location',
    'departure_location',
    'itinerary_preference',
    'itinerary_type',
    'preferred_hotel_category',
    'hotel_facilities',
    'trip_start_date_and_time',
    'trip_end_date_and_time',
    'arrival_type',
    'departure_type',
    'expecting_budget',
    'entry_ticket_required',
    'guide_for_itinerary',
    'nationality',
    'food_type',
    'meal_plan_code',
    'meal_plan_breakfast',
    'meal_plan_lunch',
    'meal_plan_dinner',
    'total_adult',
    'total_children',
    'total_infants',
    'special_instructions',
    'createdon',
    'updatedon',
  ]);

  const routeSelect = buildSelectList(routeColumns, [
    'itinerary_plan_ID',
    'itinerary_route_ID',
    'location_id',
    'location_name',
    'itinerary_route_date',
    'no_of_days',
    'no_of_km',
    'direct_to_next_visiting_place',
    'next_visiting_location',
    'createdon',
    'updatedon',
  ]);

  const planRows = await prisma.$queryRawUnsafe(`
    SELECT
      ${planSelect}
    FROM dvi_itinerary_plan_details
    WHERE deleted = 0 AND status = 1
  `);

  const routeRows = await prisma.$queryRawUnsafe(`
    SELECT
      ${routeSelect}
    FROM dvi_itinerary_route_details
    WHERE deleted = 0 AND status = 1
  `);

  await prisma.$disconnect();

  const filteredPlans = planRows.filter((plan) => {
    const quoteId = String(plan.itinerary_quote_ID || '').trim().toUpperCase();
    if (!quoteId) return true;
    if (quoteId.startsWith('REGRESSION')) return false;
    if (quoteId.startsWith('TOP10')) return false;
    if (quoteId.startsWith('TEST')) return false;
    return true;
  });

  const routesByPlan = new Map();
  for (const route of routeRows) {
    const planId = Number(route.itinerary_plan_ID || 0);
    if (!routesByPlan.has(planId)) {
      routesByPlan.set(planId, []);
    }
    routesByPlan.get(planId).push(route);
  }

  const groupedPatterns = new Map();
  let totalSourceRoutes = 0;

  for (const plan of filteredPlans) {
    const planId = Number(plan.itinerary_plan_ID || 0);
    const routes = routesByPlan.get(planId) || [];
    const activeRoutes = sortRoutes(routes);
    if (activeRoutes.length < 2) {
      continue;
    }

    const invalidRouteNames = activeRoutes.filter((route) => !normalizeLabel(route.location_name) || !normalizeLabel(route.next_visiting_location));
    if (invalidRouteNames.length) {
      warnings.push(`Skipped plan ${planId} because ${invalidRouteNames.length} route rows had empty location names.`);
      continue;
    }

    totalSourceRoutes += activeRoutes.length;
    totalLocationIdZeroRoutes += activeRoutes.filter((route) => Number(route.location_id || 0) === 0).length;
    const pattern = buildPatternRecord(plan, activeRoutes);
    totalZeroOrBlankKmRoutes += pattern.zeroOrBlankKmRoutes;

    if (!groupedPatterns.has(pattern.patternKey)) {
      groupedPatterns.set(pattern.patternKey, {
        ...pattern,
        frequency: 0,
        sourcePlans: [],
      });
    }

    const record = groupedPatterns.get(pattern.patternKey);
    record.frequency += 1;
    record.sourcePlans.push({
      planId: Number(plan.itinerary_plan_ID || 0),
      quoteId: String(plan.itinerary_quote_ID || '').trim(),
      createdon: plan.createdon || null,
      updatedon: plan.updatedon || null,
      routeCount: activeRoutes.length,
      routeChain: pattern.routeChain,
      zeroOrBlankKmRoutes: pattern.zeroOrBlankKmRoutes,
      directOnCount: pattern.directOnCount,
      directOffCount: pattern.directOffCount,
    });
  }

  const patternList = [...groupedPatterns.values()].map((pattern) => {
    const representative = [...pattern.sourcePlans]
      .sort((a, b) => compareNullableDates(a.createdon, b.createdon) || compareNullableDates(a.updatedon, b.updatedon) || a.planId - b.planId)[0];
    const representativePlan = filteredPlans.find((plan) => Number(plan.itinerary_plan_ID || 0) === representative.planId) || pattern.representativePlan;
    return {
      ...pattern,
      representativePlan,
      sourcePlanId: representative.planId,
      sourceQuoteId: representative.quoteId,
      sourcePlanCreatedOn: representative.createdon || null,
      sourcePlanUpdatedOn: representative.updatedon || null,
      routeCount: representative.routeCount,
      routeChain: representative.routeChain,
      zeroOrBlankKmRoutes: representative.zeroOrBlankKmRoutes,
      directOnCount: pattern.directOnCount,
      directOffCount: pattern.directOffCount,
      directMixBonus: pattern.directMixBonus,
      uniqueLocations: pattern.uniqueLocations,
      uniqueLocationCount: pattern.uniqueLocationCount,
    };
  });

  patternList.sort(comparePatterns);

  if (!patternList.length) {
    throw new Error('No eligible route patterns found in the local database.');
  }

  warnings.push(`Active route rows with location_id = 0: ${totalLocationIdZeroRoutes}`);
  warnings.push(`Active route rows with zero/blank no_of_km: ${totalZeroOrBlankKmRoutes}`);

  const selected = [];
  const coveredLocations = new Set();
  const remaining = [...patternList];

  while (selected.length < CASE_COUNT && remaining.length > 0) {
    let ranked = remaining.map((pattern) => {
      const score = computePatternScore(pattern, coveredLocations);
      return {
        ...pattern,
        ...score,
      };
    });

    const hasNewCoverage = ranked.some((item) => item.newlyCoveredLocationCount > 0);
    ranked.sort((a, b) => {
      if (hasNewCoverage) {
        if (b.diversityScore !== a.diversityScore) return b.diversityScore - a.diversityScore;
      } else {
        if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
      }
      return comparePatterns(a, b);
    });

    const chosen = ranked[0];
    selected.push(chosen);
    for (const location of chosen.uniqueLocations) {
      coveredLocations.add(location);
    }

    const chosenKey = chosen.patternKey;
    const index = remaining.findIndex((pattern) => pattern.patternKey === chosenKey);
    if (index >= 0) {
      remaining.splice(index, 1);
    } else {
      break;
    }
  }

  if (selected.length < CASE_COUNT && patternList.length >= CASE_COUNT) {
    const usedKeys = new Set(selected.map((item) => item.patternKey));
    const extras = [...patternList]
      .filter((pattern) => !usedKeys.has(pattern.patternKey))
      .sort((a, b) => comparePatterns(a, b));
    for (const extra of extras) {
      if (selected.length >= CASE_COUNT) break;
      selected.push(extra);
    }
  }

  if (selected.length !== CASE_COUNT) {
    throw new Error(`Unable to select exactly ${CASE_COUNT} diverse patterns. Selected ${selected.length}.`);
  }

  const generatedPlanIds = new Set();
  const fileNames = [];
  const manifestCases = [];
  const coveredDisplayLocations = new Set();

  selected.forEach((pattern, index) => {
    const caseNumber = String(index + 1).padStart(2, '0');
    const caseId = `${CASE_ID_PREFIX}${caseNumber}`;
    const generatedPlanId = PLAN_ID_START + index;

    if (generatedPlanIds.has(generatedPlanId)) {
      validationErrors.push(`Duplicate generated plan id detected: ${generatedPlanId}`);
    }
    generatedPlanIds.add(generatedPlanId);

    const sourcePlanRow = pattern.representativePlan || filteredPlans.find((plan) => Number(plan.itinerary_plan_ID || 0) === pattern.sourcePlanId) || {};
    const casePayload = buildPlanPayload(sourcePlanRow, routesByPlan.get(pattern.sourcePlanId) || [], generatedPlanId, {
      caseIndex: index,
      frequency: pattern.frequency,
    });

    const orderedRoutes = casePayload.routes;
    if (!orderedRoutes.length || orderedRoutes.length < 2) {
      validationErrors.push(`${caseId}: payload.routes.length < 2`);
    }
    if (!casePayload?.plan) {
      validationErrors.push(`${caseId}: payload.plan missing`);
    }
    if (orderedRoutes.some((route) => !String(route.location_name || '').trim())) {
      validationErrors.push(`${caseId}: empty route location_name found`);
    }
    if (orderedRoutes.some((route) => !String(route.next_visiting_location || '').trim())) {
      validationErrors.push(`${caseId}: empty route next_visiting_location found`);
    }
    if (isInvalidDate(casePayload.plan.trip_start_date) || isInvalidDate(casePayload.plan.trip_end_date) || isInvalidDate(casePayload.plan.pick_up_date_and_time)) {
      validationErrors.push(`${caseId}: invalid plan date`);
    }
    if (orderedRoutes.some((route) => isInvalidDate(route.itinerary_route_date))) {
      validationErrors.push(`${caseId}: invalid route date`);
    }

    const sourceQuoteId = String(pattern.sourceQuoteId || sourcePlanRow?.itinerary_quote_ID || '').trim();
    const sourcePlanId = Number(pattern.sourcePlanId || sourcePlanRow?.itinerary_plan_ID || 0);
    const sourceRouteChain = pattern.routeChain;

    const sourceEvidence = {
      sourcePlanId,
      sourceQuoteId,
      frequency: pattern.frequency,
      uniqueLocationCount: pattern.uniqueLocationCount,
      routeCount: pattern.routeCount,
      routeChain: sourceRouteChain,
      sourcePlanCreatedOn: pattern.sourcePlanCreatedOn || null,
      sourcePlanUpdatedOn: pattern.sourcePlanUpdatedOn || null,
    };

    const description = `${sourceRouteChain[0] || 'Unknown'} -> ${sourceRouteChain[sourceRouteChain.length - 1] || 'Unknown'} (${pattern.frequency}x production pattern)`;
    const tags = [
      'top10',
      'production-derived',
      `frequency-${pattern.frequency}`,
      `routes-${pattern.routeCount}`,
      pattern.directOnCount > 0 && pattern.directOffCount > 0 ? 'direct-mix' : 'single-direct-mode',
    ];

    const caseJson = {
      caseId,
      description,
      tags,
      sourceEvidence,
      manualHotspot: null,
      payload: casePayload,
    };

    const fileName = `${caseId}.json`;
    const filePath = path.join(TOP10_DIR, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(caseJson, null, 2)}\n`, 'utf8');

    fileNames.push(fileName);
    manifestCases.push({
      caseId,
      file: fileName,
      sourcePlanId,
      sourceQuoteId,
      frequency: pattern.frequency,
      routeCount: pattern.routeCount,
      uniqueLocationCount: pattern.uniqueLocationCount,
      routeChain: sourceRouteChain,
      zeroOrBlankKmRoutes: pattern.zeroOrBlankKmRoutes,
      sourcePlanCreatedOn: pattern.sourcePlanCreatedOn || null,
      sourcePlanUpdatedOn: pattern.sourcePlanUpdatedOn || null,
    });

    for (const location of sourceRouteChain) {
      coveredDisplayLocations.add(location);
    }
  });

  const generatedFiles = fs
    .readdirSync(TOP10_DIR)
    .filter((name) => /^top10-case-\d+\.json$/.test(name))
    .sort();

  if (generatedFiles.length !== CASE_COUNT) {
    throw new Error(`Expected exactly ${CASE_COUNT} generated case files, found ${generatedFiles.length}.`);
  }

  const parsedCases = generatedFiles.map((file) => {
    const fullPath = path.join(TOP10_DIR, file);
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    return { file, parsed };
  });

  for (const { file, parsed } of parsedCases) {
    if (!parsed?.payload?.plan) {
      throw new Error(`${file} missing payload.plan`);
    }
    if (!Array.isArray(parsed?.payload?.routes) || parsed.payload.routes.length < 2) {
      throw new Error(`${file} has fewer than 2 routes`);
    }
    if (parsed.caseId !== path.basename(file, '.json')) {
      throw new Error(`${file} caseId mismatch`);
    }
    if (parsed.payload.routes.some((route) => !String(route.location_name || '').trim())) {
      throw new Error(`${file} has empty location_name`);
    }
    if (parsed.payload.routes.some((route) => !String(route.next_visiting_location || '').trim())) {
      throw new Error(`${file} has empty next_visiting_location`);
    }
    if (isInvalidDate(parsed.payload.plan.trip_start_date) || isInvalidDate(parsed.payload.plan.trip_end_date) || isInvalidDate(parsed.payload.plan.pick_up_date_and_time)) {
      throw new Error(`${file} has invalid plan dates`);
    }
    if (parsed.payload.routes.some((route) => isInvalidDate(route.itinerary_route_date))) {
      throw new Error(`${file} has invalid route dates`);
    }
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    // Written below, but keep the guard explicit for validation intent.
  }

  const totalPatternsFound = patternList.length;
  const manifest = {
    generatedAt: new Date().toISOString(),
    databaseName: dbName,
    totalSourcePlansScanned: filteredPlans.length,
    totalPatternsFound,
    selectedCases: manifestCases,
    coveredLocations: [...coveredDisplayLocations].sort((a, b) => String(a).localeCompare(String(b))),
    warnings,
  };

  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error('Manifest was not written.');
  }

  const manifestCheck = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (!manifestCheck?.selectedCases || manifestCheck.selectedCases.length !== CASE_COUNT) {
    throw new Error('Manifest validation failed.');
  }

  if (validationErrors.length) {
    throw new Error(`Validation errors:\n- ${validationErrors.join('\n- ')}`);
  }

  const summaryTable = selected.map((pattern, index) => ({
    caseId: `${CASE_ID_PREFIX}${String(index + 1).padStart(2, '0')}`,
    sourcePlanId: pattern.sourcePlanId,
    sourceQuoteId: pattern.sourceQuoteId || '(missing)',
    frequency: pattern.frequency,
    routeCount: pattern.routeCount,
    uniqueLocationCount: pattern.uniqueLocationCount,
    directOnCount: pattern.directOnCount,
    directOffCount: pattern.directOffCount,
    zeroOrBlankKmRoutes: pattern.zeroOrBlankKmRoutes,
    routeChain: pattern.routeChain.join(' -> '),
  }));

  console.log('\nSelected patterns');
  console.table(summaryTable);
  console.log('\nTop 10 case files written');
  console.log(fileNames.map((file) => path.join('scripts', 'regression', 'top10', file)).join('\n'));
  console.log('\nCovered locations');
  console.log([...coveredDisplayLocations].sort((a, b) => String(a).localeCompare(String(b))).join(' | '));
  if (warnings.length) {
    console.log('\nWarnings');
    console.log(warnings.map((warning) => `- ${warning}`).join('\n'));
  }
  console.log('\nManifest summary');
  console.log(JSON.stringify({
    generatedAt: manifest.generatedAt,
    databaseName: manifest.databaseName,
    totalSourcePlansScanned: manifest.totalSourcePlansScanned,
    totalPatternsFound: manifest.totalPatternsFound,
    selectedCases: manifest.selectedCases.length,
    coveredLocations: manifest.coveredLocations.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
