/**
 * Debug script: verify matrix-best-slot apply flow for manual hotspots.
 *
 * Usage:
 *   npx ts-node -P tsconfig.json scripts/debug-manual-hotspot-apply.ts
 *
 * Optional env:
 *   DVI_TEST_TOKEN=<jwt>
 *   LOGIN_EMAIL=<email>
 *   LOGIN_PASSWORD=<password>
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
  if (!token) {
    throw new Error('Login succeeded but no token was returned');
  }

  return token;
}

async function main() {
  const token = await getToken();

  const url = `${BASE_URL}/itineraries/${PLAN_ID}/manual-hotspots/apply`;
  const payload = {
    routeId: ROUTE_ID,
    hotspotIds: [HOTSPOT_ID],
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
    forceConflictInsertion: false,
    matrixPreferredSlot: {
      fromHotspotId: 228,
      toHotspotId: 218,
      slotIndex: 0,
      source: 'BEST_FIT',
    },
  };

  console.log('=== REQUEST ===');
  console.log('POST', url);
  console.log(JSON.stringify(payload, null, 2));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const rawText = await res.text();
  let response: any = null;
  try {
    response = rawText ? JSON.parse(rawText) : null;
  } catch {
    response = { rawText };
  }

  console.log('\n=== RESPONSE STATUS ===');
  console.log('HTTP', res.status);

  console.log('\n=== RESPONSE BODY ===');
  console.log(JSON.stringify(response, null, 2));

  const resolution = response?.resolution || null;
  const validation = resolution?.validation || response?.validation || null;

  console.log('\n=== ASSERTIONS ===');
  assert('1) HTTP 201 expected for successful apply', res.status === 201);
  assert('2) success should be true', response?.success === true);
  assert('3) inserted should be true', response?.inserted === true);
  assert('4) validation.readyToApply should be true', validation?.readyToApply === true);
  assert('5) validation.requiresPriorityConfirmation should be false', validation?.requiresPriorityConfirmation === false);
  assert(
    '6) removedTopPriorityHotspots should be empty',
    Array.isArray(resolution?.removedTopPriorityHotspots) && resolution.removedTopPriorityHotspots.length === 0,
  );
  assert(
    '7) topPriorityAffected should be empty',
    Array.isArray(resolution?.topPriorityAffected) && resolution.topPriorityAffected.length === 0,
  );

  console.log('\nAll assertions passed.');
}

main().catch((err) => {
  console.error('FAILED:', err?.message || err);
  process.exit(1);
});
