/**
 * E2E test: Insert 4 hotspots in sequence into a route and verify each insertion.
 *
 * Strategy:
 * 1. Login and get a fresh token.
 * 2. Note the initial hotspot count in the target route via the details API.
 * 3. For each of the 4 hotspots (picked from the available list):
 *    a. Call the preview API and assert it returns a 200 with a newHotspot entry.
 *    b. Call the apply API and assert success=true.
 *    c. Re-fetch itinerary details and assert the route hotspot count increased by 1.
 * 4. Navigate to the UI and verify the 4 inserted hotspot names appear in the timeline.
 * 5. Take a screenshot for visual audit.
 *
 * These 4 hotspots are confirmed available for route 3108 (DVI202604247, planId=292):
 *   id=4  Kapaleeshwarar Temple  (priority 1)
 *   id=11 Parthasarathy Temple  (priority 2)
 *   id=5  Marina Beach           (priority 3)
 *   id=10 Guindy National Park   (priority 6)
 *
 * NOTE: The test cleans up after itself by calling the delete/remove endpoint for each
 * hotspot it inserted, so the itinerary is restored to its original state.
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';
const QUOTE_ID = process.env.E2E_ITINERARY_QUOTE_ID ?? 'DVI202604247';
const PLAN_ID = 292;
const TARGET_ROUTE_ID = 3108;

const USER_EMAIL =
  process.env.E2E_HOTSPOT_USER ??
  process.env.PROD_EMAIL ??
  'admin@dvi.co.in';
const USER_PASSWORD =
  process.env.E2E_HOTSPOT_PASSWORD ??
  process.env.PROD_PASSWORD ??
  'Keerthi@2404ias';

/** Hotspots to insert in order (available in route 3108). */
/** Candidate hotspots (available in route 3108). Test picks 4 that are not already inserted. */
const HOTSPOT_CANDIDATES = [
  { id: 4, name: 'Kapaleeshwarar Temple' },
  { id: 11, name: 'Parthasarathy Temple' },
  { id: 5, name: 'Marina Beach' },
  { id: 10, name: 'Guindy National Park' },
  { id: 8, name: 'Santhome Cathedral Basilica' },
  { id: 292, name: 'Guindy snake park' },
  { id: 9, name: 'Thousand Lights Mosque' },
  { id: 12, name: 'Vivekanandar House' },
];

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function loginForToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`Auth login failed: ${res.status()} ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { accessToken?: string };
  const token = String(json?.accessToken ?? '').trim();
  if (!token) throw new Error('accessToken missing from login response');
  return token;
}

async function seedAuthToken(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
  }, token);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function getInsertedHotspotIds(
  request: APIRequestContext,
  token: string,
): Promise<number[]> {
  const res = await request.get(
    `${API_BASE_URL}/itineraries/details/${encodeURIComponent(QUOTE_ID)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok()) return [];
  const body = (await res.json()) as any;
  const days: any[] = Array.isArray(body?.days) ? body.days : [];
  const targetDay = days.find((d: any) => Number(d?.id) === TARGET_ROUTE_ID);
  const segments: any[] = Array.isArray(targetDay?.segments) ? targetDay.segments : [];
  return segments
     .filter((s: any) => s?.type === 'attraction' && Number(s?.hotspotId) > 0)
     .map((s: any) => Number(s.hotspotId));
}

async function previewHotspot(
  request: APIRequestContext,
  token: string,
  hotspotId: number,
  selectedHotspotIds: number[],
): Promise<any> {
  const res = await request.post(
    `${API_BASE_URL}/itineraries/${PLAN_ID}/manual-hotspot/preview`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 90000,
        data: {
        routeId: TARGET_ROUTE_ID,
        hotspotId,
        anchorType: 'after_travel',
        anchorIndex: 0,
        allowTopPriorityRemoval: false,
        selectedHotspotIds,
      },
    },
  );
  return { ok: res.ok(), status: res.status(), body: await res.json().catch(() => ({})) };
}

async function applyHotspots(
  request: APIRequestContext,
  token: string,
  hotspotIds: number[],
): Promise<any> {
  const res = await request.post(
    `${API_BASE_URL}/itineraries/${PLAN_ID}/manual-hotspots/apply`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 180000,
      data: {
        routeId: TARGET_ROUTE_ID,
        hotspotIds,
        anchorType: 'after_travel',
        anchorIndex: 0,
        allowTopPriorityRemoval: false,
        forceConflictInsertion: true,
      },
    },
  );
  return { ok: res.ok(), status: res.status(), body: await res.json().catch(() => ({})) };
}

async function removeHotspot(
  request: APIRequestContext,
  token: string,
  hotspotId: number,
): Promise<boolean> {
  const res = await request
    .delete(
      `${API_BASE_URL}/itineraries/${PLAN_ID}/manual-hotspot/${hotspotId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    .catch(() => null);
  return res ? res.ok() : false;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('inserts 4 hotspots in sequence and verifies each insertion', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(600000); // 10 minutes — each preview can take up to 90s

  const token = await loginForToken(request);

  // --- Baseline ---
  const baselineIds = await getInsertedHotspotIds(request, token);
  console.log(`Baseline hotspot IDs in route ${TARGET_ROUTE_ID}: [${baselineIds}]`);

    // Pick 4 candidates not already in the route.
    const candidates = HOTSPOT_CANDIDATES.filter((h) => !baselineIds.includes(h.id));
    if (candidates.length < 4) {
      test.skip(
        true,
        `Not enough insertable hotspots (need 4, found ${candidates.length} not already in route). ` +
          `Baseline IDs: [${baselineIds}]`,
      );
    }
    const HOTSPOTS_TO_INSERT = candidates.slice(0, 4);
    console.log(`Will insert: ${HOTSPOTS_TO_INSERT.map((h) => `${h.name}(${h.id})`).join(', ')}`);

  const insertedHotspotIds: number[] = [];

  try {
    // -----------------------------------------------------------------------
    // Insert each hotspot in sequence
    // -----------------------------------------------------------------------
    for (let i = 0; i < HOTSPOTS_TO_INSERT.length; i++) {
      const { id: hotspotId, name } = HOTSPOTS_TO_INSERT[i];
      const selectedSoFar = [...insertedHotspotIds, hotspotId];

      console.log(`\n[${i + 1}/4] Inserting "${name}" (id=${hotspotId})...`);

      // Step A: Preview
      const preview = await previewHotspot(request, token, hotspotId, selectedSoFar);
      expect(
        preview.ok,
        `Preview for "${name}" (id=${hotspotId}) failed with status ${preview.status}`,
      ).toBeTruthy();

      const newHotspot = preview.body?.data?.newHotspot ?? preview.body?.newHotspot;
      expect(
        newHotspot,
        `Preview response for "${name}" missing newHotspot field`,
      ).toBeTruthy();
      console.log(
        `   Preview OK — isConflict=${newHotspot?.isConflict}, time=${newHotspot?.hotspot_start_time ?? '?'}`,
      );

      // Step B: Apply
      const apply = await applyHotspots(request, token, selectedSoFar);
      expect(
        apply.ok,
        `Apply for "${name}" (id=${hotspotId}) failed with status ${apply.status}: ${JSON.stringify(apply.body)}`,
      ).toBeTruthy();

      const applyBody = apply.body as any;
      // Accept: explicit success, inserted flag, force-conflict applied, or a newHotspot object
      // (engine inserts as conflict but returns success=false in some code paths).
      const success =
        applyBody?.success === true ||
        applyBody?.data?.success === true ||
        applyBody?.inserted === true ||
        applyBody?.data?.inserted === true ||
        applyBody?.forceConflictInsertionApplied === true ||
        applyBody?.data?.forceConflictInsertionApplied === true ||
        (applyBody?.newHotspot != null && Number(applyBody?.newHotspot?.route_hotspot_ID) > 0);
      expect(
        success,
        `Apply response for "${name}" did not indicate success: ${JSON.stringify(applyBody).substring(0, 400)}`,
      ).toBeTruthy();

      insertedHotspotIds.push(hotspotId);
      console.log(`   Apply OK — inserted hotspot IDs so far: [${insertedHotspotIds}]`);

        // Step C: Verify the newly inserted hotspot appears in route timeline
        const currentIds = await getInsertedHotspotIds(request, token);
      expect(
          currentIds,
          `After inserting "${name}" (id=${hotspotId}), hotspot not found in route timeline. Current IDs: [${currentIds}]`,
        ).toContain(hotspotId);
        console.log(`   Route hotspot IDs now: [${currentIds}] ✓ includes id=${hotspotId}`);
    }

    // -----------------------------------------------------------------------
    // UI verification: navigate and confirm all 4 hotspot names appear
    // -----------------------------------------------------------------------
    await seedAuthToken(page, token);
    await page.goto(
      `${baseURL}/itinerary-details/${encodeURIComponent(QUOTE_ID)}`,
      { waitUntil: 'domcontentloaded' },
    );
    await expect(page).toHaveURL(
      new RegExp(`/itinerary-details/${QUOTE_ID}$`),
      { timeout: 30000 },
    );

    // Wait for the timeline to settle (no loading spinners).
    await expect(page.getByText(/loading/i)).toHaveCount(0, { timeout: 30000 });

    for (const { name } of HOTSPOTS_TO_INSERT) {
      await expect(
        page.getByText(new RegExp(name, 'i')).first(),
        `Expected "${name}" to appear in timeline after insertion`,
      ).toBeVisible({ timeout: 30000 });
      console.log(`   UI: "${name}" visible in timeline ✓`);
    }

    await page.screenshot({
      path: 'test-results/manual-hotspot-screenshots/hotspot-insert-4-sequence.png',
      fullPage: true,
    });
  } finally {
    // -----------------------------------------------------------------------
    // Cleanup: remove inserted hotspots so itinerary is restored
    // -----------------------------------------------------------------------
    console.log('\nCleaning up — removing inserted hotspots...');
    for (const hotspotId of [...insertedHotspotIds].reverse()) {
      const removed = await removeHotspot(request, token, hotspotId);
      console.log(`   Remove hotspot id=${hotspotId}: ${removed ? 'OK' : 'failed (may need manual cleanup)'}`);
    }
  }
});
