/**
 * Debug script: prove which preview payload branch drives manual hotspot slot UI.
 *
 * Usage:
 *   npx ts-node -P tsconfig.json scripts/debug-manual-hotspot-preview-fit.ts
 *
 * Optional env:
 *   DVI_TEST_TOKEN=<jwt>
 */

const BASE_URL = 'http://127.0.0.1:4006/api/v1';
const PLAN_ID = 381;
const ROUTE_ID = 4320;
const HOTSPOT_ID = 219;
const AUTH_TOKEN = process.env.DVI_TEST_TOKEN || '';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';

function assert(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  OK  ${label}`);
    return;
  }
  console.log(`  FAIL ${label}`);
  throw new Error(`Assertion failed: ${label}`);
}

function hasInvalidEndpoint(slot: any, hotspotId: number): boolean {
  if (!slot) return false;
  return Number(slot?.fromHotspotId) === hotspotId || Number(slot?.toHotspotId) === hotspotId;
}

function findIndexByText(rows: any[], textNeedle: string): number {
  const needle = textNeedle.toLowerCase();
  return rows.findIndex((row) => String(row?.text || row?.name || '').toLowerCase().includes(needle));
}

function findAttractionIndexByText(rows: any[], textNeedle: string): number {
  const needle = textNeedle.toLowerCase();
  return rows.findIndex((row) => {
    const type = String(row?.type || '').toLowerCase();
    if (type !== 'attraction') return false;
    return String(row?.text || row?.name || '').toLowerCase().includes(needle);
  });
}

async function main() {
  let token = AUTH_TOKEN;
  if (!token) {
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
    if (!loginRes.ok) {
      const loginText = await loginRes.text();
      throw new Error(`Login failed: ${loginRes.status} ${loginText}`);
    }

    const loginJson: any = await loginRes.json();
    token = loginJson?.accessToken || loginJson?.token || loginJson?.data?.accessToken || loginJson?.data?.token || '';
    if (!token) {
      throw new Error('Login succeeded but no token was returned');
    }
  }

  const url = `${BASE_URL}/itineraries/${PLAN_ID}/manual-hotspot/preview`;
  const payload = {
    routeId: ROUTE_ID,
    hotspotId: HOTSPOT_ID,
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
    selectedHotspotIds: [HOTSPOT_ID],
  };

  console.log('=== REQUEST ===');
  console.log('POST', url);
  console.log(JSON.stringify(payload, null, 2));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.log('HTTP ERROR', res.status, text);
    process.exit(1);
  }

  const response: any = await res.json();

  console.log('\n=== RAW BRANCH PROBE ===');
  console.log('response.manualInsertionFit =', JSON.stringify(response?.manualInsertionFit ?? null, null, 2));
  console.log('response.resolution?.manualInsertionFit =', JSON.stringify(response?.resolution?.manualInsertionFit ?? null, null, 2));
  console.log('response.data?.manualInsertionFit =', JSON.stringify(response?.data?.manualInsertionFit ?? null, null, 2));
  console.log('response.data?.resolution?.manualInsertionFit =', JSON.stringify(response?.data?.resolution?.manualInsertionFit ?? null, null, 2));
  console.log('response.slotInsights =', JSON.stringify(response?.slotInsights ?? null, null, 2));
  console.log('response.resolution?.slotInsights =', JSON.stringify(response?.resolution?.slotInsights ?? null, null, 2));
  console.log('response.data?.resolution?.slotInsights =', JSON.stringify(response?.data?.resolution?.slotInsights ?? null, null, 2));

  const manualInsertionFit =
    response?.manualInsertionFit
    ?? response?.resolution?.manualInsertionFit
    ?? response?.data?.manualInsertionFit
    ?? response?.data?.resolution?.manualInsertionFit
    ?? null;

  console.log('\n=== NORMALIZED manualInsertionFit ===');
  console.log('manualInsertionFit.selectedHotspotId =', manualInsertionFit?.selectedHotspotId ?? null);
  console.log('manualInsertionFit.requestedSlot =', JSON.stringify(manualInsertionFit?.requestedSlot ?? null, null, 2));
  console.log('manualInsertionFit.bestSlot =', JSON.stringify(manualInsertionFit?.bestSlot ?? null, null, 2));
  console.log('manualInsertionFit.chosenSlot =', JSON.stringify(manualInsertionFit?.chosenSlot ?? null, null, 2));
  console.log('manualInsertionFit.chosenSlotSource =', manualInsertionFit?.chosenSlotSource ?? null);
  console.log('manualInsertionFit.allSlotResults =', JSON.stringify(manualInsertionFit?.allSlotResults ?? null, null, 2));

  const allSlotResults: any[] = Array.isArray(manualInsertionFit?.allSlotResults)
    ? manualInsertionFit.allSlotResults
    : [];

  console.log('\n--- allSlotResults audit ---');
  console.log('count =', allSlotResults.length);
  for (const row of allSlotResults) {
    console.log(
      `${row?.slotIndex}: ${row?.fromName} → ${row?.toName} | ${row?.routeFitType} | detour=${row?.roadDetourKm} | routePossible=${row?.routePossible} | timingPossible=${row?.timingPossible} | prioritySafe=${row?.prioritySafe} | selectedAsBest=${row?.selectedAsBest} | routeReason=${row?.routeDecisionReason} | timingReason=${row?.timingDecisionReason} | finalReason=${row?.finalDecisionReason}`,
    );
  }

  const fullTimeline: any[] = Array.isArray(response?.fullTimeline)
    ? response.fullTimeline
    : (Array.isArray(response?.routeTimeline) ? response.routeTimeline : []);
  console.log('\n--- fullTimeline summary ---');
  console.log('count =', fullTimeline.length);
  fullTimeline.forEach((row: any, index: number) => {
    const kind = String(row?.type || '').toLowerCase();
    const hotspotId = Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0);
    const label = row?.text || row?.name || row?.type || '';
    console.log(
      `${index}: previewOrder=${row?.previewOrder ?? 'NA'} | matrixPreviewOrder=${row?.matrixPreviewOrder ?? 'NA'} | type=${kind || 'NA'} | text=${label} | hotspotId=${hotspotId} | timeRange=${row?.timeRange || ''} | isMatrixSplitTravel=${row?.isMatrixSplitTravel === true} | matrixTravelLeg=${row?.matrixTravelLeg || 'NA'} | isMatrixPositioned=${row?.isMatrixPositioned === true} | conflict=${row?.isConflict === true}`,
    );
  });

  console.log('\n--- final rows (requested fields) ---');
  fullTimeline.forEach((row: any, index: number) => {
    console.log(JSON.stringify({
      index,
      matrixPreviewOrder: row?.matrixPreviewOrder ?? row?.previewOrder ?? null,
      type: row?.type || row?.item_type || null,
      text: row?.text || row?.name || null,
      timeRange: row?.timeRange || null,
      fromName: row?.fromName || null,
      toName: row?.toName || null,
      distance: row?.distance || (row?.matrixDistanceKm != null ? `${Number(row.matrixDistanceKm).toFixed(1)} km` : null),
      duration: row?.duration || (row?.matrixDurationMin != null ? `${Math.max(1, Math.round(Number(row.matrixDurationMin)))} Min` : null),
      isMatrixSplitTravel: row?.isMatrixSplitTravel === true,
      matrixTravelLeg: row?.matrixTravelLeg || null,
      locationId: row?.locationId ?? row?.hotspot_ID ?? row?.hotspotId ?? null,
    }));
  });

  const cheeyapparaIdx = findAttractionIndexByText(fullTimeline, 'cheeyappara');
  const aToCIdx = fullTimeline.findIndex((row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'A_TO_C');
  const pothameduIdx = fullTimeline.findIndex((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === HOTSPOT_ID);
  const cToBIdx = fullTimeline.findIndex((row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'C_TO_B');
  const eravikulamIdx = findAttractionIndexByText(fullTimeline, 'eravikulam');
  const roseIdx = findAttractionIndexByText(fullTimeline, 'rose garden');
  const photoIdx = findAttractionIndexByText(fullTimeline, 'photo view');
  const mattupettyIdx = findAttractionIndexByText(fullTimeline, 'mattupetty');
  const echoIdx = findAttractionIndexByText(fullTimeline, 'echo point');
  const hotelIdx = fullTimeline.findIndex((row: any) => {
    const type = String(row?.type || '').toLowerCase();
    const text = String(row?.text || row?.name || '').toLowerCase();
    return type === 'hotel' || text.includes('check-in at hotel') || text.includes('travel to hotel');
  });

  const travelToEravikulamRows = fullTimeline
    .map((row: any, index: number) => ({ row, index }))
    .filter(({ row }) => String(row?.text || row?.name || '').toLowerCase().includes('travel to eravikulam'));

  console.log('\n--- order indices ---');
  console.log({
    cheeyapparaIdx,
    aToCIdx,
    pothameduIdx,
    cToBIdx,
    eravikulamIdx,
    roseIdx,
    photoIdx,
    mattupettyIdx,
    echoIdx,
    hotelIdx,
  });

  console.log('\n=== ASSERTIONS ===');
  assert('1) manualInsertionFit must exist', !!manualInsertionFit);
  assert('2) selectedHotspotId must be 219', Number(manualInsertionFit?.selectedHotspotId) === HOTSPOT_ID);
  assert(
    '3) allSlotResults must not contain fromHotspotId === 219',
    allSlotResults.every((row: any) => Number(row?.fromHotspotId) !== HOTSPOT_ID),
  );
  assert(
    '4) allSlotResults must not contain toHotspotId === 219',
    allSlotResults.every((row: any) => Number(row?.toHotspotId) !== HOTSPOT_ID),
  );
  assert(
    '5) bestSlot must not contain fromHotspotId === 219 or toHotspotId === 219',
    !hasInvalidEndpoint(manualInsertionFit?.bestSlot, HOTSPOT_ID),
  );
  assert(
    '6) chosenSlot must not contain fromHotspotId === 219 or toHotspotId === 219',
    !hasInvalidEndpoint(manualInsertionFit?.chosenSlot, HOTSPOT_ID),
  );
  assert(
    '7) bestSlot should be Cheeyappara -> Eravikulam with MINOR_DETOUR or ON_ROUTE',
    String(manualInsertionFit?.bestSlot?.fromName || '').toLowerCase().includes('cheeyappara')
      && String(manualInsertionFit?.bestSlot?.toName || '').toLowerCase().includes('eravikulam')
      && (
        manualInsertionFit?.bestSlot?.routeFitType === 'MINOR_DETOUR'
        || manualInsertionFit?.bestSlot?.routeFitType === 'ON_ROUTE'
      ),
  );
  assert(
    '8) allSlotResults must include Eravikulam -> Munnar Rose Garden as OFF_ROUTE',
    allSlotResults.some((row: any) =>
      String(row?.fromName || '').toLowerCase().includes('eravikulam')
      && String(row?.toName || '').toLowerCase().includes('munnar rose garden')
      && row?.routeFitType === 'OFF_ROUTE',
    ),
  );

  assert('9) core order: Cheeyappara < A_TO_C < Pothamedu < C_TO_B < Eravikulam < Rose < Photo < Mattupetty < Echo < Hotel',
    cheeyapparaIdx >= 0
      && aToCIdx > cheeyapparaIdx
      && pothameduIdx > aToCIdx
      && cToBIdx > pothameduIdx
      && eravikulamIdx > cToBIdx
      && roseIdx > eravikulamIdx
      && photoIdx > roseIdx
      && mattupettyIdx > photoIdx
      && echoIdx > mattupettyIdx
      && hotelIdx > echoIdx,
  );

  assert('10) hotel index is after all attractions',
    hotelIdx >= 0 && !fullTimeline.slice(hotelIdx + 1).some((row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction';
    }),
  );

  assert('11) echo point appears before hotel', echoIdx >= 0 && hotelIdx > echoIdx);

  assert('12) only one travel row to Eravikulam exists', travelToEravikulamRows.length === 1);

  assert('13) no duplicate travel-to-Eravikulam row labels',
    travelToEravikulamRows.length <= 1,
  );

  const aToCRow = aToCIdx >= 0 ? fullTimeline[aToCIdx] : null;
  const cToBRow = cToBIdx >= 0 ? fullTimeline[cToBIdx] : null;
  assert('14) A_TO_C split row has matrixDistanceKm 39.257',
    aToCRow && Number(aToCRow?.matrixDistanceKm).toFixed(3) === '39.257',
  );
  assert('15) C_TO_B split row has matrixDistanceKm 16.7963',
    cToBRow && Number(cToBRow?.matrixDistanceKm).toFixed(4) === '16.7963',
  );

  assert('16) matrixPreviewOrder is sequential',
    fullTimeline.every((row: any, idx: number) => Number(row?.matrixPreviewOrder ?? row?.previewOrder) === idx),
  );

  // ── Fix 8: timing continuity assertions ──────────────────────────────────
  // Helper: parse HH:MM start from timeRange "HH:MM - HH:MM"
  function parseStart(timeRange: string | null | undefined): string | null {
    if (!timeRange) return null;
    return (String(timeRange).split(' - ')[0] || '').trim() || null;
  }
  function parseEnd(timeRange: string | null | undefined): string | null {
    if (!timeRange) return null;
    return (String(timeRange).split(' - ')[1] || '').trim() || null;
  }

  const cheeyapparaRow = cheeyapparaIdx >= 0 ? fullTimeline[cheeyapparaIdx] : null;
  const pothameduRow = pothameduIdx >= 0 ? fullTimeline[pothameduIdx] : null;

  const cheeyapparaEnd = parseEnd(cheeyapparaRow?.timeRange);
  const aToCStart = parseStart(aToCRow?.timeRange);
  const aToCEnd = parseEnd(aToCRow?.timeRange);
  const pothameduStart = parseStart(pothameduRow?.timeRange);
  const pothameduEnd = parseEnd(pothameduRow?.timeRange);
  const cToBStart = parseStart(cToBRow?.timeRange);
  const cToBEnd = parseEnd(cToBRow?.timeRange);

  const eravikulamRow = eravikulamIdx >= 0 ? fullTimeline[eravikulamIdx] : null;
  const eravikulamStart = parseStart(eravikulamRow?.timeRange);

  console.log('\n--- timing continuity probe ---');
  console.log('cheeyapparaEnd      :', cheeyapparaEnd);
  console.log('aToCStart           :', aToCStart, '  (must equal cheeyapparaEnd)');
  console.log('aToCEnd             :', aToCEnd);
  console.log('pothameduStart      :', pothameduStart, '  (must equal aToCEnd)');
  console.log('pothameduEnd        :', pothameduEnd);
  console.log('cToBStart           :', cToBStart, '  (must equal pothameduEnd)');
  console.log('cToBEnd             :', cToBEnd);
  console.log('eravikulamStart     :', eravikulamStart, '  (must equal cToBEnd)');
  console.log('manualInsertionFit.finalArrivalTime :', manualInsertionFit?.finalArrivalTime);
  console.log('manualInsertionFit.exceedsDayEnd    :', manualInsertionFit?.exceedsDayEnd);
  console.log('manualInsertionFit.dayOverflowMinutes:', manualInsertionFit?.dayOverflowMinutes);
  console.log('lowPriorityRemovalPlanPreview:', JSON.stringify(manualInsertionFit?.lowPriorityRemovalPlanPreview ?? null, null, 2));

  assert('17) A_TO_C travel starts at Cheeyappara end — no gap, no double-advance',
    !!cheeyapparaEnd && !!aToCStart && cheeyapparaEnd === aToCStart,
  );

  assert('18) Pothamedu (C) starts immediately after A_TO_C travel ends',
    !!aToCEnd && !!pothameduStart && aToCEnd === pothameduStart,
  );

  assert('19) C_TO_B travel starts immediately after Pothamedu ends',
    !!pothameduEnd && !!cToBStart && pothameduEnd === cToBStart,
  );

  assert('20) Eravikulam starts immediately after C_TO_B travel ends',
    !!cToBEnd && !!eravikulamStart && cToBEnd === eravikulamStart,
  );

  assert('21) A_TO_C does NOT start at 12:53 (regression guard: old double-advance bug)',
    aToCStart !== '12:53',
  );

  assert('22) Pothamedu does NOT start at 13:56 (regression guard: old double-advance bug)',
    pothameduStart !== '13:56' && pothameduStart !== '12:53',
  );

  // ── overflow / low-priority removal plan assertions ───────────────────────
  const lowPriPlan = manualInsertionFit?.lowPriorityRemovalPlanPreview;
  if (manualInsertionFit?.exceedsDayEnd === true) {
    console.log('\n--- overflow detected, checking removal plan ---');
    assert('23) lowPriorityRemovalPlanPreview must exist when exceedsDayEnd=true',
      !!lowPriPlan,
    );
    if (lowPriPlan?.resolved === true) {
      const plannedRemovals: any[] = Array.isArray(lowPriPlan?.plannedRemovals) ? lowPriPlan.plannedRemovals : [];
      const selectedPriority = 4; // Pothamedu is P4 (manual hotspot priority)
      assert('24) All removed hotspots must have priority > selected manual priority (P4)',
        plannedRemovals.every((row: any) => Number(row?.priority || 0) > selectedPriority),
      );
      assert('25) No P1/P2/P3 hotspots removed',
        plannedRemovals.every((row: any) => Number(row?.priority || 0) > 3),
      );
      assert('26) Selected hotspot (219) not in removal list',
        plannedRemovals.every((row: any) => Number(row?.id || 0) !== HOTSPOT_ID),
      );
      assert('27) finalOverflowMinutes must be 0 when resolved',
        Number(lowPriPlan?.finalOverflowMinutes || 0) === 0,
      );
    }
  } else {
    console.log('\nRoute does not overflow day end — removal plan assertions skipped.');
  }

  console.log('\nAll assertions passed.');
}

main().catch((err) => {
  console.error('FAILED:', err?.message || err);
  process.exit(1);
});
