/**
 * Test script: verify manualInsertionFit in manual hotspot preview response.
 *
 * Usage:
 *   npx ts-node -P tsconfig.json scripts/test-manual-hotspot-preview-fit.ts
 *
 * Target: Plan 381, Route 4320, candidate Pothamedu View Point (ID=219)
 */

const BASE_URL = 'http://localhost:4006/api/v1';
const PLAN_ID = 381;
const ROUTE_ID = 4320;
const HOTSPOT_ID = 219;

// Set DVI_TEST_TOKEN env var to pass a JWT, or leave empty to try without auth
const AUTH_TOKEN = process.env.DVI_TEST_TOKEN || '';

async function main() {
  const url = `${BASE_URL}/itineraries/${PLAN_ID}/manual-hotspot/preview`;
  const body = {
    routeId: ROUTE_ID,
    hotspotId: HOTSPOT_ID,
    selectedHotspotIds: [HOTSPOT_ID],
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
  };

  console.log('\n=== Manual Hotspot Preview Fit Test ===');
  console.log('URL:', url);
  console.log('Body:', JSON.stringify(body, null, 2));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('HTTP error', res.status, text);
    process.exit(1);
  }

  const data: any = await res.json();
  const fit = data?.manualInsertionFit;

  if (!fit) {
    console.error('\n[FAIL] manualInsertionFit is MISSING from response!');
    console.log('Response keys:', Object.keys(data || {}));
    process.exit(1);
  }

  console.log('\n✅ manualInsertionFit is present');
  console.log('\n--- selectedHotspot ---');
  console.log(`  ID: ${fit.selectedHotspotId}  Name: ${fit.selectedHotspotName}`);

  console.log('\n--- requestedSlot ---');
  if (fit.requestedSlot) {
    const rs = fit.requestedSlot;
    console.log(`  ${rs.fromName} → ${rs.toName}`);
    console.log(`  routeFitType: ${rs.routeFitType}`);
    console.log(`  label: ${rs.label}`);
    console.log(`  roadDetourKm: ${rs.roadDetourKm}`);
    console.log(`  reason: ${rs.decisionReason}`);
  } else {
    console.log('  null');
  }

  console.log('\n--- bestSlot ---');
  if (fit.bestSlot) {
    const bs = fit.bestSlot;
    console.log(`  [${bs.slotIndex}] ${bs.fromName} → ${bs.toName}`);
    console.log(`  routeFitType: ${bs.routeFitType}`);
    console.log(`  label: ${bs.label}`);
    console.log(`  roadDetourKm: ${bs.roadDetourKm}  ratio: ${bs.roadDetourRatio}`);
    console.log(`  abOsrmDistanceKm: ${bs.abOsrmDistanceKm}`);
    console.log(`  acOsrmDistanceKm: ${bs.acOsrmDistanceKm}  cbOsrmDistanceKm: ${bs.cbOsrmDistanceKm}`);
    console.log(`  reason: ${bs.decisionReason}`);
  } else {
    console.log('  null');
  }

  console.log('\n--- chosenSlot ---');
  const cs = fit.chosenSlot;
  console.log(`  source: ${fit.chosenSlotSource}`);
  console.log(`  ${cs.fromName || '?'} → ${cs.toName || '?'}`);
  console.log(`  routeFitType: ${cs.routeFitType}`);
  console.log(`  label: ${cs.label}`);

  console.log('\n--- allSlotResults ---');
  console.log(`  total: ${fit.allSlotResults?.length ?? 0}`);
  const allRows = fit.allSlotResults || [];
  allRows.forEach((s: any, i: number) => {
    console.log(`  [${i}] slotIndex=${s.slotIndex} | ${s.fromName} → ${s.toName} | ${s.routeFitType} | detour=${s.roadDetourKm} km | reason=${s.routeDecisionReason}`);
  });

  if (fit.warning) {
    console.log(`\n⚠️  Warning: ${fit.warning}`);
  }

  console.log('\n--- Hotspot 219 position in fullTimeline ---');
  const timeline: any[] = data?.fullTimeline || [];
  const found = timeline.filter((row: any) => {
    const id = Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0);
    return id === HOTSPOT_ID;
  });
  if (found.length > 0) {
    found.forEach((row: any, i: number) => {
      console.log(`  [${i}] type=${row.type} text=${row.text} timeRange=${row.timeRange} hotspot_order=${row.hotspot_order}`);
    });
  } else {
    console.log('  *** Hotspot 219 NOT FOUND in fullTimeline ***');
  }

  // Validation assertions
  console.log('\n=== Assertions ===');
  let passed = 0;
  let failed = 0;
  const assert = (label: string, cond: boolean) => {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.log(`  ❌ ${label}`); failed++; }
  };

  assert('manualInsertionFit exists', !!fit);
  assert('selectedHotspotId = 219', fit.selectedHotspotId === HOTSPOT_ID);
  assert('allSlotResults has entries', (fit.allSlotResults?.length ?? 0) > 0);
  assert('bestSlot exists', !!fit.bestSlot);
  assert('bestSlot is MINOR_DETOUR or ON_ROUTE for Pothamedu',
    fit.bestSlot?.routeFitType === 'MINOR_DETOUR' || fit.bestSlot?.routeFitType === 'ON_ROUTE');
  assert('bestSlot.fromName includes Cheeyappara or known hotspot', !!fit.bestSlot?.fromName);
  assert('allSlotResults contains an OFF_ROUTE entry',
    (fit.allSlotResults || []).some((s: any) => s.routeFitType === 'OFF_ROUTE'));
  assert('no allSlotResults row has fromHotspotId === selectedHotspotId',
    (fit.allSlotResults || []).every((s: any) => Number(s.fromHotspotId) !== HOTSPOT_ID));
  assert('no allSlotResults row has toHotspotId === selectedHotspotId',
    (fit.allSlotResults || []).every((s: any) => Number(s.toHotspotId) !== HOTSPOT_ID));
  assert('requestedSlot.routeFitType = MATRIX_UNAVAILABLE (anchor=0 = hotel segment)',
    fit.requestedSlot?.routeFitType === 'MATRIX_UNAVAILABLE');
  assert('chosenSlotSource is BEST_FIT or REQUESTED_SLOT',
    fit.chosenSlotSource === 'BEST_FIT' || fit.chosenSlotSource === 'REQUESTED_SLOT');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
