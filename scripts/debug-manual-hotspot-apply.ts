/**
 * Debug script: verify manual hotspot apply sanitization for matrix-safe apply.
 *
 * Tests:
 * 1) Mixed payload hotspotIds [219, 220] should not fail with exactly-one error;
 *    backend should ignore already-active hotspot and apply candidate.
 * 2) Single payload hotspotIds [220] should apply (or be idempotent if already applied).
 *
 * Usage:
 *   npx tsx scripts/debug-manual-hotspot-apply.ts
 */

const BASE_URL = 'http://127.0.0.1:4006/api/v1';
const PLAN_ID = 381;
const ROUTE_ID = 4341;
const EXISTING_MANUAL_ID = 219;
const NEW_CANDIDATE_ID = 220;

const AUTH_TOKEN = process.env.DVI_TEST_TOKEN || '';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';

function assertCheck(label: string, cond: boolean): void {
  if (cond) {
    console.log(`OK   ${label}`);
    return;
  }

  console.log(`FAIL ${label}`);
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
    const loginText = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${loginText}`);
  }

  const loginJson: any = await loginRes.json();
  const token = loginJson?.accessToken || loginJson?.token || loginJson?.data?.accessToken || loginJson?.data?.token || '';
  if (!token) throw new Error('Login succeeded but no token was returned');

  return token;
}

async function callApply(token: string, hotspotIds: number[]) {
  const url = `${BASE_URL}/itineraries/${PLAN_ID}/manual-hotspots/apply`;
  const payload = {
    routeId: ROUTE_ID,
    hotspotIds,
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
    forceConflictInsertion: false,
    matrixPreferredSlot: {
      fromHotspotId: 218,
      toHotspotId: 484,
      slotIndex: 2,
      source: 'BEST_FIT' as const,
    },
  };

  console.log('\n--- APPLY REQUEST ---');
  console.log(JSON.stringify(payload, null, 2));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await res.text();
  let body: any = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = { rawText };
  }

  console.log('status:', res.status);
  console.log('body:', JSON.stringify(body, null, 2));

  return { status: res.status, body };
}

function isInsertSuccess(code: string): boolean {
  return code === 'MANUAL_HOTSPOT_INSERTED_WITH_LOW_PRIORITY_REMOVAL' || code === 'MANUAL_HOTSPOT_INSERTED_WITH_MATRIX_SLOT';
}

async function main() {
  const token = await getToken();

  const mixed = await callApply(token, [EXISTING_MANUAL_ID, NEW_CANDIDATE_ID]);
  const mixedCode = String(mixed.body?.code || '');
  const mixedMessage = String(mixed.body?.message || mixed.body?.error?.message || '');

  assertCheck('mixed payload does not fail with exactly-one error', !mixedMessage.includes('exactly one selected manual hotspot'));
  assertCheck('mixed payload succeeds or is idempotent', mixed.body?.success === true || mixed.status === 201 || mixed.status === 200);
  assertCheck(
    'mixed payload inserts candidate or reports already exists',
    isInsertSuccess(mixedCode) || mixedCode === 'MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE',
  );

  const single = await callApply(token, [NEW_CANDIDATE_ID]);
  const singleCode = String(single.body?.code || '');
  const singleMessage = String(single.body?.message || single.body?.error?.message || '');

  assertCheck('single payload does not fail with exactly-one error', !singleMessage.includes('exactly one selected manual hotspot'));
  assertCheck('single payload succeeds or is idempotent', single.body?.success === true || single.status === 201 || single.status === 200);
  assertCheck(
    'single payload inserts candidate or reports already exists',
    isInsertSuccess(singleCode) || singleCode === 'MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE',
  );

  console.log('\nPASS apply sanitization behavior verified.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
