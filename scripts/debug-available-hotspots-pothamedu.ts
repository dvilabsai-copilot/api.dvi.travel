/**
 * Debug available-hotspots behavior for Pothamedu (hotspot 219).
 *
 * Usage:
 *   npx ts-node -P tsconfig.json scripts/debug-available-hotspots-pothamedu.ts
 *
 * Optional env:
 *   PLAN_ID=381 ROUTE_ID=4321 HOTSPOT_ID=219
 *   API_BASE_URL=http://127.0.0.1:4006/api/v1
 *   DVI_TEST_TOKEN=<jwt>
 *   LOGIN_EMAIL=admin@dvi.co.in LOGIN_PASSWORD=...
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PLAN_ID = Number(process.env.PLAN_ID || 381);
const ROUTE_ID = Number(process.env.ROUTE_ID || 4321);
const HOTSPOT_ID = Number(process.env.HOTSPOT_ID || 219);
const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const AUTH_TOKEN = process.env.DVI_TEST_TOKEN || '';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';

type AbsentReason =
  | 'ACTIVE_THIS_ROUTE'
  | 'ACTIVE_OTHER_ROUTE'
  | 'EXCLUDED_BY_ROUTE'
  | 'NOT_IN_LOCATION_POOL'
  | 'FILTERED_BY_QUERY'
  | 'DELETED_OR_INACTIVE_MASTER'
  | 'UNKNOWN';

async function getToken(): Promise<string> {
  if (AUTH_TOKEN) return AUTH_TOKEN;

  const res = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Login failed: ${res.status} ${txt}`);
  }

  const json: any = await res.json();
  const token = json?.accessToken || json?.token || json?.data?.accessToken || json?.data?.token || '';
  if (!token) throw new Error('No token in login response');
  return token;
}

function printHeader(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function runRequestedSql(): Promise<void> {
  printHeader('SQL #2 - HOTSPOT 219 ROWS');
  const rows2 = await prisma.$queryRawUnsafe<any[]>(`
SELECT
  route_hotspot_ID,
  itinerary_plan_ID,
  itinerary_route_ID,
  hotspot_ID,
  item_type,
  hotspot_plan_own_way,
  hotspot_order,
  hotspot_start_time,
  hotspot_end_time,
  status,
  deleted
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = ${PLAN_ID}
  AND hotspot_ID = ${HOTSPOT_ID}
ORDER BY itinerary_route_ID, deleted, status, route_hotspot_ID;
  `);
  console.table(rows2);

  printHeader('SQL #3 - ROUTE EXCLUDED IDS');
  const rows3 = await prisma.$queryRawUnsafe<any[]>(`
SELECT
  itinerary_route_ID,
  location_name,
  next_visiting_location,
  excluded_hotspot_ids
FROM dvi_itinerary_route_details
WHERE itinerary_plan_ID = ${PLAN_ID}
ORDER BY itinerary_route_ID;
  `);
  console.table(rows3);
}

async function main() {
  await runRequestedSql();

  printHeader('CONTEXT');
  const route = await prisma.dvi_itinerary_route_details.findFirst({
    where: { itinerary_route_ID: ROUTE_ID, deleted: 0 },
  });
  if (!route) throw new Error(`Route ${ROUTE_ID} not found.`);

  const planId = Number((route as any).itinerary_plan_ID || 0);
  const excludedIds = new Set<number>(((route as any).excluded_hotspot_ids as number[]) || []);

  const location = await prisma.dvi_stored_locations.findFirst({
    where: { location_ID: Number((route as any).location_id || 0), deleted: 0 },
  });

  const sourceName = String((location as any)?.source_location || '');
  const destName = String((location as any)?.destination_location || '');
  const directDestination = Number((route as any).direct_to_next_visiting_place || 0) === 1;

  const allPlanAddedRows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: planId,
      deleted: 0,
      status: 1,
      item_type: 4,
    },
    select: {
      hotspot_ID: true,
      itinerary_route_ID: true,
      route_hotspot_ID: true,
    },
  });

  const thisRouteAddedIds = new Set<number>(
    allPlanAddedRows
      .filter((r: any) => Number(r.itinerary_route_ID) === ROUTE_ID)
      .map((r: any) => Number(r.hotspot_ID || 0))
      .filter((id: number) => id > 0),
  );

  const otherRouteAddedIds = new Set<number>(
    allPlanAddedRows
      .filter((r: any) => Number(r.itinerary_route_ID) !== ROUTE_ID)
      .map((r: any) => Number(r.hotspot_ID || 0))
      .filter((id: number) => id > 0),
  );

  const hotspotMaster: any = await prisma.dvi_hotspot_place.findFirst({
    where: { hotspot_ID: HOTSPOT_ID },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_location: true,
      status: true,
      deleted: true,
    },
  });

  const hotspotLocation = String(hotspotMaster?.hotspot_location || '');
  const inSourcePool = sourceName ? hotspotLocation.includes(sourceName) : false;
  const inDestPool = destName ? hotspotLocation.includes(destName) : false;
  const inLocationPool = directDestination ? inDestPool : (inSourcePool || inDestPool);

  const token = await getToken();
  const response = await fetch(`${API_BASE_URL}/itineraries/hotspots/available/${ROUTE_ID}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`getAvailableHotspots failed: ${response.status} ${txt}`);
  }

  const available: any[] = await response.json();
  const pothameduRow = available.find((row: any) => Number(row?.id || 0) === HOTSPOT_ID) || null;

  printHeader('DEBUG SNAPSHOT');
  console.log(JSON.stringify({
    routeId: ROUTE_ID,
    planId,
    thisRouteAddedIds: Array.from(thisRouteAddedIds).sort((a, b) => a - b),
    otherRouteAddedIds: Array.from(otherRouteAddedIds).sort((a, b) => a - b),
    excludedHotspotIds: Array.from(excludedIds).sort((a, b) => a - b),
    hotspot219: {
      appearsInAllPlanAddedRows: allPlanAddedRows.some((r: any) => Number(r?.hotspot_ID || 0) === HOTSPOT_ID),
      appearsInThisRouteAddedIds: thisRouteAddedIds.has(HOTSPOT_ID),
      appearsInOtherRouteAddedIds: otherRouteAddedIds.has(HOTSPOT_ID),
      appearsInExcludedHotspotIds: excludedIds.has(HOTSPOT_ID),
      appearsInFinalResponse: !!pothameduRow,
    },
  }, null, 2));

  printHeader('API RESULT');
  if (pothameduRow) {
    console.log('[PRESENT] Pothamedu returned from getAvailableHotspots');
    console.log(JSON.stringify(pothameduRow, null, 2));
    return;
  }

  let reason: AbsentReason = 'UNKNOWN';
  if (thisRouteAddedIds.has(HOTSPOT_ID)) {
    reason = 'ACTIVE_THIS_ROUTE';
  } else if (otherRouteAddedIds.has(HOTSPOT_ID)) {
    reason = 'ACTIVE_OTHER_ROUTE';
  } else if (excludedIds.has(HOTSPOT_ID)) {
    reason = 'EXCLUDED_BY_ROUTE';
  } else if (!hotspotMaster || Number(hotspotMaster.deleted || 0) !== 0 || Number(hotspotMaster.status || 0) !== 1) {
    reason = 'DELETED_OR_INACTIVE_MASTER';
  } else if (!inLocationPool) {
    reason = 'NOT_IN_LOCATION_POOL';
  } else {
    // No search query is used in this script, but keep enum parity with requested reasons.
    reason = 'UNKNOWN';
  }

  console.log(`[ABSENT] Pothamedu missing from getAvailableHotspots. reason=${reason}`);
  console.log(JSON.stringify({
    reason,
    hotspotMaster,
    poolCheck: {
      directDestination,
      sourceName,
      destName,
      hotspotLocation,
      inSourcePool,
      inDestPool,
      inLocationPool,
    },
  }, null, 2));
}

main()
  .catch((err) => {
    console.error('[ERROR]', err?.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
