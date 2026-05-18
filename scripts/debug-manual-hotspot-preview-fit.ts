/**
 * Debug script for manual hotspot preview fit behavior.
 * Auto-detects matrix-missing vs matrix-available mode.
 *
 * Usage:
 *   npx tsx scripts/debug-manual-hotspot-preview-fit.ts --planId 381 --routeId 4341 --candidateHotspotId 220
 */

const BASE_URL = 'http://127.0.0.1:4006/api/v1';

function toInt(raw: string | undefined, fallback = 0): number {
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  return fallback;
}

function parseArgs(): { planId: number; routeId: number; candidateHotspotId: number } {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) continue;

    if (token.includes('=')) {
      const [k, v] = token.slice(2).split('=', 2);
      parsed[k] = String(v || '').trim();
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = String(next).trim();
      i += 1;
    }
  }

  const planId = toInt(parsed.planId || process.env.PLAN_ID, 0);
  const routeId = toInt(parsed.routeId || process.env.ROUTE_ID, 0);
  const candidateHotspotId = toInt(parsed.candidateHotspotId || process.env.CANDIDATE_HOTSPOT_ID, 0);

  if (!planId || !routeId || !candidateHotspotId) {
    throw new Error('Missing required input. Use --planId --routeId --candidateHotspotId');
  }

  return { planId, routeId, candidateHotspotId };
}

function assertCheck(label: string, condition: boolean): void {
  if (condition) {
    console.log(`OK   ${label}`);
    return;
  }

  console.log(`FAIL ${label}`);
  throw new Error(`Assertion failed: ${label}`);
}

function parseEndMinutes(timeRange: string | null | undefined): number | null {
  if (!timeRange) return null;
  const parts = String(timeRange).split('-').map((x) => x.trim());
  const endText = parts.length > 1 ? parts[1] : parts[0];
  const match = endText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hh = Number(match[1]);
  const mm = Number(match[2]);
  const ap = String(match[3]).toUpperCase();
  if (ap === 'AM' && hh === 12) hh = 0;
  if (ap === 'PM' && hh !== 12) hh += 12;
  return hh * 60 + mm;
}

async function loginAndGetToken(): Promise<string> {
  const existing = String(process.env.DVI_TEST_TOKEN || '').trim();
  if (existing) return existing;

  const email = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
  const password = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';

  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Login failed: ${response.status} ${text}`);
  }

  const json: any = await response.json();
  const token = json?.accessToken || json?.token || json?.data?.accessToken || json?.data?.token || '';
  if (!token) throw new Error('Login succeeded but no token returned.');

  return String(token);
}

function namesContain(haystack: any, needle: string): boolean {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

async function main() {
  const { planId, routeId, candidateHotspotId } = parseArgs();
  const token = await loginAndGetToken();

  const payload = {
    routeId,
    hotspotId: candidateHotspotId,
    selectedHotspotIds: [candidateHotspotId],
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
  };

  const response = await fetch(`${BASE_URL}/itineraries/${planId}/manual-hotspot/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = null;
  }

  if (!response.ok) {
    console.log(rawText);
    throw new Error(`Preview failed: ${response.status}`);
  }

  const fit = json?.manualInsertionFit || json?.resolution?.manualInsertionFit || null;
  const validation = json?.validation || json?.resolution?.validation || null;
  const fullTimeline: any[] = Array.isArray(json?.fullTimeline)
    ? json.fullTimeline
    : (Array.isArray(json?.routeTimeline) ? json.routeTimeline : []);

  console.log('--- summary ---');
  console.log('code:', json?.code || null);
  console.log('requiresMatrixBuild:', fit?.requiresMatrixBuild ?? null);
  console.log('routeFitAvailable:', fit?.routeFitAvailable ?? null);
  console.log('canApply:', fit?.canApply ?? null);
  console.log('chosenSlot:', fit?.chosenSlot || null);
  console.log('selectedManualPriority:', fit?.selectedManualPriority ?? null);
  console.log('validation:', validation || null);

  assertCheck('manualInsertionFit exists', !!fit);

  const matrixMissing = fit?.requiresMatrixBuild === true;

  if (matrixMissing) {
    console.log('mode: MATRIX_MISSING');
    const slots: any[] = Array.isArray(fit?.allSlotResults) ? fit.allSlotResults : [];

    assertCheck('bestSlot null when matrix missing', fit?.bestSlot == null);
    assertCheck('chosenSlot null when matrix missing', fit?.chosenSlot == null);
    assertCheck('canApply false when matrix missing', fit?.canApply === false);
    assertCheck('preview validation blocks apply', validation?.readyToApply === false);
    assertCheck('preview validation requires matrix build', validation?.requiresMatrixBuild === true);

    const selectedRows = fullTimeline.filter((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === Number(candidateHotspotId));
    assertCheck('candidate not injected into preview timeline', selectedRows.length === 0);

    if (slots.length > 0) {
      const allUnknown = slots.every((row: any) => String(row?.routeFitType || '').toUpperCase() === 'UNKNOWN');
      const noBest = slots.every((row: any) => row?.selectedAsBest !== true);
      assertCheck('all slots unknown in matrix-missing mode', allUnknown);
      assertCheck('no selectedAsBest in matrix-missing mode', noBest);
    }

    console.log('PASS matrix-missing behavior verified.');
    return;
  }

  console.log('mode: MATRIX_AVAILABLE');

  const chosenSlot = fit?.chosenSlot || null;
  const chosenType = String(chosenSlot?.routeFitType || '').toUpperCase();
  const lowPriorityPlan = fit?.lowPriorityRemovalPlanPreview || null;

  assertCheck('requiresMatrixBuild false in matrix-available mode', fit?.requiresMatrixBuild !== true);
  assertCheck('chosenSlot exists', !!chosenSlot);
  assertCheck('chosenSlot route fit is feasible', chosenType === 'ON_ROUTE' || chosenType === 'MINOR_DETOUR');
  assertCheck('selectedManualPriority is Manual/P4', Number(fit?.selectedManualPriority || 0) === 4);

  const slotFrom = String(chosenSlot?.fromName || '');
  const slotTo = String(chosenSlot?.toName || '');
  assertCheck('chosenSlot from is Eravikulam (case-insensitive contains)', namesContain(slotFrom, 'eravikulam'));
  assertCheck('chosenSlot to is Photo view point (case-insensitive contains)', namesContain(slotTo, 'photo'));

  const initialOverflowMinutes = Number(lowPriorityPlan?.originalOverflowMinutes || 0);
  assertCheck('initial overflow > 0', initialOverflowMinutes > 0);
  assertCheck('lowPriorityRemovalPlanPreview resolved', lowPriorityPlan?.resolved === true);

  const plannedRemovals: any[] = Array.isArray(lowPriorityPlan?.plannedRemovals) ? lowPriorityPlan.plannedRemovals : [];
  const candidateHotspots: any[] = Array.isArray(lowPriorityPlan?.candidates) ? lowPriorityPlan.candidates : [];
  const attempts: any[] = Array.isArray(lowPriorityPlan?.simulationAttempts) ? lowPriorityPlan.simulationAttempts : [];
  const singleAttempts = attempts.filter((row: any) => Number(row?.removedCount || 0) === 1);
  const validAttempts = attempts.filter((row: any) => row?.valid === true);
  const minValidCount = validAttempts.length > 0
    ? Math.min(...validAttempts.map((row: any) => Number(row?.removedCount || 0)))
    : null;
  const singleValidExists = singleAttempts.some((row: any) => row?.valid === true);

  console.log('candidateHotspots:', JSON.stringify(candidateHotspots, null, 2));
  console.log('simulationAttempts:', JSON.stringify(attempts, null, 2));
  console.log('size1Attempts:', JSON.stringify(singleAttempts, null, 2));
  console.log('plannedRemovals:', JSON.stringify(plannedRemovals, null, 2));

  assertCheck('plannedRemovals non-empty', plannedRemovals.length > 0);
  assertCheck('algorithm is MIN_REMOVALS_COMBINATION_SEARCH', String(lowPriorityPlan?.algorithm || '') === 'MIN_REMOVALS_COMBINATION_SEARCH');
  assertCheck('every planned removal priority > 4', plannedRemovals.every((row: any) => Number(row?.priority || 0) > 4));
  assertCheck('no planned removal priority <= 4', plannedRemovals.every((row: any) => Number(row?.priority || 0) > 4));
  assertCheck('no manual P4 hotspot removed', plannedRemovals.every((row: any) => Number(row?.priority || 0) !== 4));
  assertCheck('planned removals do not include Pothamedu', plannedRemovals.every((row: any) => !namesContain(row?.name, 'pothamedu')));
  assertCheck('planned removals do not include Cheeyappara', plannedRemovals.every((row: any) => !namesContain(row?.name, 'cheeyappara')));
  assertCheck('planned removals do not include Eravikulam', plannedRemovals.every((row: any) => !namesContain(row?.name, 'eravikulam')));
  assertCheck('simulationAttempts include single-candidate attempts', singleAttempts.length > 0);

  if (minValidCount !== null) {
    assertCheck('plannedRemovals length equals minimum valid count', plannedRemovals.length === minValidCount);
  }

  if (singleValidExists) {
    assertCheck('single-candidate fit yields one planned removal', plannedRemovals.length === 1);
  }

  const removedNames = new Set<string>(plannedRemovals.map((row: any) => String(row?.name || '').trim().toLowerCase()).filter(Boolean));
  const timelineNames = fullTimeline.map((row: any) => String(row?.text || row?.name || '').trim().toLowerCase());
  const removalLeak = Array.from(removedNames.values()).some((name: string) => timelineNames.some((rowName: string) => rowName.includes(name)));
  assertCheck('final timeline does not contain planned removal hotspots', removalLeak === false);

  const hotelRow = fullTimeline.find((row: any) => {
    const type = String(row?.type || '').toLowerCase();
    const text = String(row?.text || row?.name || '').toLowerCase();
    return type === 'hotel' || text.includes('check-in at hotel');
  });
  const hotelEnd = parseEndMinutes(hotelRow?.timeRange || null);
  console.log('final hotel time:', hotelRow?.timeRange || null);
  console.log('chosen planned removals:', JSON.stringify(plannedRemovals, null, 2));
  assertCheck('final hotel/check-in <= 8 PM', hotelEnd !== null && hotelEnd <= (20 * 60));

  assertCheck('timelineSource is LOW_PRIORITY_REMOVAL_FINAL_TIMELINE', String(fit?.timelineSource || '') === 'LOW_PRIORITY_REMOVAL_FINAL_TIMELINE');

  console.log('PASS matrix-available overflow-removal behavior verified.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
