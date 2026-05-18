/**
 * Debug script: validate matrix-safe manual hotspot apply does not corrupt other routes.
 *
 * Usage:
 *   npx ts-node -P tsconfig.json scripts/debug-manual-hotspot-apply-matrix-safe.ts
 */

import { PrismaClient } from '@prisma/client';

const BASE_URL = 'http://127.0.0.1:4006/api/v1';
const PLAN_ID = 381;
const TARGET_ROUTE_ID = Number(process.env.TARGET_ROUTE_ID || 4321);
const CONTROL_ROUTE_ID = Number(process.env.CONTROL_ROUTE_ID || 4322);
const HOTSPOT_ID = Number(process.env.HOTSPOT_ID || 219);
const FROM_HOTSPOT_ID = Number(process.env.FROM_HOTSPOT_ID || 228);
const TO_HOTSPOT_ID = Number(process.env.TO_HOTSPOT_ID || 218);
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';
const AUTH_TOKEN = process.env.DVI_TEST_TOKEN || '';

const prisma = new PrismaClient();

function assert(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  OK  ${label}`);
    return;
  }
  console.log(`  FAIL ${label}`);
  throw new Error(`Assertion failed: ${label}`);
}

async function getToken(): Promise<string> {
  if (AUTH_TOKEN) return AUTH_TOKEN;

  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });

  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${text}`);
  }

  const json: any = await loginRes.json();
  const token = json?.accessToken || json?.token || json?.data?.accessToken || json?.data?.token || '';
  if (!token) {
    throw new Error('Login succeeded but no token was returned');
  }
  return token;
}

async function getRouteAttractions(routeId: number): Promise<Array<{ hotspotId: number; name: string; order: number }>> {
  const rows: any[] = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: PLAN_ID,
      itinerary_route_ID: routeId,
      item_type: 4,
      deleted: 0,
      status: 1,
    },
    select: {
      hotspot_ID: true,
      hotspot_order: true,
    },
    orderBy: [
      { hotspot_order: 'asc' },
      { route_hotspot_ID: 'asc' },
    ],
  });

  const hotspotIds = Array.from(new Set(rows.map((r: any) => Number(r?.hotspot_ID || 0)).filter((id: number) => id > 0)));
  const masters: any[] = hotspotIds.length > 0
    ? await prisma.dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: hotspotIds } },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
        },
      })
    : [];

  const nameById = new Map<number, string>();
  for (const m of masters || []) {
    nameById.set(Number(m?.hotspot_ID || 0), String(m?.hotspot_name || `Hotspot #${m?.hotspot_ID || 0}`));
  }

  return rows.map((r: any) => ({
    hotspotId: Number(r?.hotspot_ID || 0),
    order: Number(r?.hotspot_order || 0),
    name: nameById.get(Number(r?.hotspot_ID || 0)) || `Hotspot #${r?.hotspot_ID || 0}`,
  }));
}

async function getPriorityByHotspotIds(hotspotIds: number[]): Promise<Map<number, number>> {
  if (!hotspotIds.length) return new Map<number, number>();
  const masters: any[] = await prisma.dvi_hotspot_place.findMany({
    where: {
      hotspot_ID: { in: hotspotIds },
      deleted: 0,
    },
    select: {
      hotspot_ID: true,
      hotspot_priority: true,
    },
  });

  const out = new Map<number, number>();
  for (const m of masters || []) {
    const id = Number(m?.hotspot_ID || 0);
    if (!id) continue;
    const p = Number(m?.hotspot_priority || 0);
    out.set(id, Number.isFinite(p) && p > 0 ? p : 4);
  }
  return out;
}

async function getActiveRoutesForHotspot(hotspotId: number): Promise<number[]> {
  const rows: Array<{ itinerary_route_ID: number }> = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: PLAN_ID,
      hotspot_ID: hotspotId,
      item_type: 4,
      deleted: 0,
      status: 1,
    },
    select: {
      itinerary_route_ID: true,
    },
  });

  return Array.from(
    new Set(
      rows
        .map((row) => Number(row?.itinerary_route_ID || 0))
        .filter((id) => id > 0),
    ),
  );
}

function printRoute(label: string, rows: Array<{ hotspotId: number; name: string; order: number }>) {
  console.log(`\n${label} (${rows.length})`);
  for (const row of rows) {
    console.log(`  ${row.order}. ${row.name} [${row.hotspotId}]`);
  }
}

function hasSubsequence(hotspotIds: number[], pattern: number[]): boolean {
  if (pattern.length === 0) return true;
  for (let i = 0; i <= hotspotIds.length - pattern.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pattern.length; j += 1) {
      if (hotspotIds[i + j] !== pattern[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

async function main() {
  const token = await getToken();
  const activeRoutesForSelected = await getActiveRoutesForHotspot(HOTSPOT_ID);
  const isCrossRouteSelection =
    activeRoutesForSelected.length > 0 &&
    !activeRoutesForSelected.includes(TARGET_ROUTE_ID);

  console.log('\n=== PRECHECK ===');
  console.log('active routes for selected hotspot:', activeRoutesForSelected);
  console.log('target route:', TARGET_ROUTE_ID);
  console.log('cross-route selection:', isCrossRouteSelection);

  const targetBefore = await getRouteAttractions(TARGET_ROUTE_ID);
  const controlBefore = await getRouteAttractions(CONTROL_ROUTE_ID);

  printRoute(`Target route before [${TARGET_ROUTE_ID}]`, targetBefore);
  printRoute(`Control route before [${CONTROL_ROUTE_ID}]`, controlBefore);

  const url = `${BASE_URL}/itineraries/${PLAN_ID}/manual-hotspots/apply`;
  const payload = {
    routeId: TARGET_ROUTE_ID,
    hotspotIds: [HOTSPOT_ID],
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
    forceConflictInsertion: false,
    matrixPreferredSlot: {
      fromHotspotId: FROM_HOTSPOT_ID,
      toHotspotId: TO_HOTSPOT_ID,
      slotIndex: 0,
      source: 'BEST_FIT',
    },
  };

  console.log('\n=== APPLY REQUEST ===');
  console.log(JSON.stringify(payload, null, 2));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = { raw };
  }

  console.log('\n=== APPLY RESPONSE ==='); console.log(JSON.stringify(body, null, 2));
  console.log('HTTP', res.status);
  console.log('success:', body?.success);
  console.log('inserted:', body?.inserted);
  console.log('code:', body?.code);
  console.log('message:', body?.message);

  const targetAfter = await getRouteAttractions(TARGET_ROUTE_ID);
  const controlAfter = await getRouteAttractions(CONTROL_ROUTE_ID);

  printRoute(`Target route after [${TARGET_ROUTE_ID}]`, targetAfter);
  printRoute(`Control route after [${CONTROL_ROUTE_ID}]`, controlAfter);

  const targetAfterIds = targetAfter.map((r) => r.hotspotId);
  const targetBeforeIds = targetBefore.map((r) => r.hotspotId);
  const controlBeforeIds = controlBefore.map((r) => r.hotspotId);
  const controlAfterIds = controlAfter.map((r) => r.hotspotId);
  const chosenSlotSource = String(body?.manualInsertionFit?.chosenSlotSource || '').toUpperCase();
  const bestSlotRouteFitType = String(body?.manualInsertionFit?.bestSlot?.routeFitType || '').toUpperCase();
  const isMatrixSafeSuccessPath =
    chosenSlotSource === 'BEST_FIT' &&
    (bestSlotRouteFitType === 'ON_ROUTE' || bestSlotRouteFitType === 'MINOR_DETOUR');

  console.log('\n=== ASSERTIONS ===');
  if (isCrossRouteSelection) {
    assert('1) HTTP 409 for cross-route matrix-safe guard', res.status === 409);
    assert('2) response.success false for cross-route matrix-safe guard', body?.success === false);
    assert('3) code MATRIX_SAFE_SLOT_INVALID for cross-route matrix-safe guard', body?.code === 'MATRIX_SAFE_SLOT_INVALID');
    assert('4) Target route exact hotspot order unchanged on rejection', JSON.stringify(targetAfterIds) === JSON.stringify(targetBefore.map((r) => r.hotspotId)));
    assert('5) Control route exact hotspot order unchanged on rejection', JSON.stringify(controlBeforeIds) === JSON.stringify(controlAfterIds));
  } else {
    assert('1) HTTP 201', res.status === 201);
    assert('2) response.success true', body?.success === true);
    assert('3) response.inserted true', body?.inserted === true);
    if (isMatrixSafeSuccessPath) {
      assert(
        '4) code is matrix-slot or low-priority-removal matrix success',
        body?.code === 'MANUAL_HOTSPOT_INSERTED_WITH_MATRIX_SLOT'
          || body?.code === 'MANUAL_HOTSPOT_INSERTED_WITH_LOW_PRIORITY_REMOVAL',
      );
      assert(`5) Target route order contains ${FROM_HOTSPOT_ID} -> ${HOTSPOT_ID} -> ${TO_HOTSPOT_ID}`,
        hasSubsequence(targetAfterIds, [FROM_HOTSPOT_ID, HOTSPOT_ID, TO_HOTSPOT_ID]));
      assert('6) Control route exact hotspot order unchanged', JSON.stringify(controlBeforeIds) === JSON.stringify(controlAfterIds));

      if (body?.code === 'MANUAL_HOTSPOT_INSERTED_WITH_LOW_PRIORITY_REMOVAL') {
        const removed = Array.isArray(body?.resolution?.removedOptionalHotspots)
          ? body.resolution.removedOptionalHotspots
          : [];
        const removedIds = removed
          .map((row: any) => Number(row?.id || 0))
          .filter((id: number) => id > 0);
        const priorityMap = await getPriorityByHotspotIds(Array.from(new Set([HOTSPOT_ID, ...removedIds])));
        const selectedPriority = Number(priorityMap.get(HOTSPOT_ID) || 4);

        assert('7) Removed list does not include selected hotspot', !removedIds.includes(HOTSPOT_ID));
        assert(
          '8) Removed hotspots are lower-priority than selected hotspot',
          removedIds.every((id: number) => Number(priorityMap.get(id) || 4) > selectedPriority),
        );
      }

      const controlHadFrom = controlBeforeIds.includes(FROM_HOTSPOT_ID);
      const controlHadTo = controlBeforeIds.includes(TO_HOTSPOT_ID);
      if (!controlHadFrom) {
        assert(`9) Control route does not gain hotspot ${FROM_HOTSPOT_ID}`, !controlAfterIds.includes(FROM_HOTSPOT_ID));
      }
      if (!controlHadTo) {
        assert(`10) Control route does not gain hotspot ${TO_HOTSPOT_ID}`, !controlAfterIds.includes(TO_HOTSPOT_ID));
      }
    } else {
      assert('4) matrix-safe code is not emitted for non-BEST_FIT/non-route-fit apply', body?.code !== 'MANUAL_HOTSPOT_INSERTED_WITH_MATRIX_SLOT');
      assert('5) Control route exact hotspot order unchanged in fallback apply', JSON.stringify(controlBeforeIds) === JSON.stringify(controlAfterIds));
      assert('6) Target route remains stable or includes selected hotspot after fallback apply',
        JSON.stringify(targetAfterIds) === JSON.stringify(targetBeforeIds) || targetAfterIds.includes(HOTSPOT_ID));
      console.log('Info: fallback apply path detected', {
        chosenSlotSource,
        bestSlotRouteFitType,
        responseCode: body?.code,
      });
    }
  }

  console.log('\nAll assertions passed.');
}

main()
  .catch((error) => {
    console.error('FAILED:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

