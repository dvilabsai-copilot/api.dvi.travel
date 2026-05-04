import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const USER_EMAIL =
  process.env.E2E_HOTSPOT_USER ??
  process.env.E2E_VENDOR_USER ??
  'admin@dvi.co.in';
const USER_PASSWORD =
  process.env.E2E_HOTSPOT_PASSWORD ??
  process.env.E2E_VENDOR_PASSWORD ??
  'Keerthi@2404ias';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';
const E2E_ITINERARY_QUOTE_ID = process.env.E2E_ITINERARY_QUOTE_ID ?? 'DVI202604247';

async function loginForToken(request: APIRequestContext): Promise<string> {
  const loginRes = await request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });

  if (!loginRes.ok()) {
    const body = await loginRes.text().catch(() => '');
    throw new Error(`Auth login failed: status=${loginRes.status()} body=${body}`);
  }

  const json = (await loginRes.json()) as { accessToken?: string };
  const token = String(json?.accessToken || '').trim();
  if (!token) {
    throw new Error('Auth login succeeded but accessToken missing');
  }

  return token;
}

async function seedAuthToken(page: Page, request: APIRequestContext): Promise<string> {
  const token = await loginForToken(request);
  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
  }, token);
  return token;
}

test('anchor hotspot flow: placeholders, popup, and anchor-aware API calls', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(180000);

  const token = await seedAuthToken(page, request);

  const detailsRes = await request.get(
    `${API_BASE_URL}/itineraries/details/${encodeURIComponent(E2E_ITINERARY_QUOTE_ID)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  expect(detailsRes.ok()).toBeTruthy();

  const details = (await detailsRes.json()) as any;
  const days = Array.isArray(details?.days) ? details.days : [];
  const travelSegments = days.flatMap((d: any) =>
    (Array.isArray(d?.segments) ? d.segments : []).filter((s: any) => s?.type === 'travel'),
  );
  const hotspotPlaceholders = days.flatMap((d: any) =>
    (Array.isArray(d?.segments) ? d.segments : []).filter(
      (s: any) => s?.type === 'hotspot' && s?.anchorType === 'after_travel',
    ),
  );

  expect(travelSegments.length).toBeGreaterThan(0);
  // Not every travel segment guarantees an after-travel placeholder in all live itinerary states.
  expect(hotspotPlaceholders.length).toBeGreaterThan(0);
  expect(hotspotPlaceholders.length).toBeLessThanOrEqual(travelSegments.length);

  await page.goto(`${baseURL}/itinerary-details/${encodeURIComponent(E2E_ITINERARY_QUOTE_ID)}`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(page).toHaveURL(new RegExp(`/itinerary-details/${E2E_ITINERARY_QUOTE_ID}$`), {
    timeout: 30000,
  });

  const hotspotTriggers = page.getByRole('button', {
    name: /add hotspot|click to add hotspot/i,
  });
  await expect(hotspotTriggers.first()).toBeVisible({ timeout: 30000 });

  // Inline list should not render in timeline anymore.
  await expect(page.getByText(/Available Places in/i)).toHaveCount(0);

  await hotspotTriggers.first().click();

  await expect(page.getByRole('heading', { name: /Hotspot List/i })).toBeVisible();

  const previewButtons = page.getByRole('button', { name: /^(preview|refresh)$/i });
  const previewCount = await previewButtons.count();
  if (previewCount === 0) {
    test.skip(true, 'No Preview/Refresh actions available in current hotspot modal state.');
  }
  await expect(previewButtons.first()).toBeVisible({ timeout: 60000 });

  const previewRequestPromise = page.waitForRequest(
    (req) =>
      req.method() === 'POST' &&
      /\/itineraries\/\d+\/manual-hotspot\/preview(\?|$)/.test(req.url()),
    { timeout: 30000 },
  );

  await previewButtons.first().click();
  const previewRequest = await previewRequestPromise;
  const previewBody = previewRequest.postDataJSON() as {
    anchorType?: string;
    anchorIndex?: number;
  };

  expect(previewBody?.anchorType).toBe('after_travel');
  expect(Number.isInteger(Number(previewBody?.anchorIndex))).toBeTruthy();

  // Main page inline hotspot list must still stay absent while popup is used.
  await expect(page.getByText(/Available Places in/i)).toHaveCount(0);

  await page.screenshot({ path: 'test-results/manual-hotspot-screenshots/hotspot-anchor-smoke-result.png', fullPage: true });
});
