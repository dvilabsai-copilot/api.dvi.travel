import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';
const QUOTE_ID = process.env.E2E_ITINERARY_QUOTE_ID ?? 'DVI202604247';
const USER_EMAIL =
  process.env.E2E_HOTSPOT_USER ??
  process.env.PROD_EMAIL ??
  'admin@dvi.co.in';
const USER_PASSWORD =
  process.env.E2E_HOTSPOT_PASSWORD ??
  process.env.PROD_PASSWORD ??
  'Keerthi@2404ias';

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

async function seedAuthToken(page: Page, request: APIRequestContext): Promise<void> {
  const token = await loginForToken(request);
  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
  }, token);
}

async function openHotspotModal(page: Page): Promise<void> {
  const trigger = page
    .getByRole('button', { name: /add hotspot|click to add hotspot/i })
    .first();

  await expect(trigger).toBeVisible({ timeout: 30000 });
  await trigger.click();

  await expect(page.getByRole('heading', { name: /hotspot list/i })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/proposed timeline/i)).toBeVisible({ timeout: 30000 });
}

async function waitForHotspotListReady(page: Page): Promise<boolean> {
  const actionButtons = page.getByRole('button', { name: /^(preview|refresh)$/i });
  const count = await actionButtons.count();
  if (count === 0) {
    return false;
  }
  await expect(actionButtons.first()).toBeVisible({ timeout: 90000 });
  return true;
}

async function clickPreviewForHotspot(page: Page, name: string): Promise<void> {
  const card = page.locator('div').filter({ hasText: new RegExp(name, 'i') }).first();
  await expect(card).toBeVisible({ timeout: 20000 });

  const button = card.getByRole('button', { name: /^(preview|refresh)$/i }).first();
  const hasButton = await button.isVisible().catch(() => false);
  if (!hasButton) {
    return;
  }

  const previewResponsePromise = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'POST' &&
      /\/itineraries\/\d+\/manual-hotspot\/preview(\?|$)/.test(resp.url()),
    { timeout: 60000 },
  );

  await button.click();
  const previewResponse = await previewResponsePromise;
  expect(previewResponse.ok(), `Preview failed for ${name}`).toBeTruthy();
}

function countContaining(values: string[], text: string): number {
  const needle = text.toLowerCase();
  return values.filter((v) => v.toLowerCase().includes(needle)).length;
}

test('itinerary hotspot modal must not duplicate core timeline rows for multi-select preview', async ({ page, request, baseURL }) => {
  test.setTimeout(240000);

  await seedAuthToken(page, request);

  await page.goto(`${baseURL}/itinerary-details/${encodeURIComponent(QUOTE_ID)}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page).toHaveURL(new RegExp(`/itinerary-details/${QUOTE_ID}$`), { timeout: 30000 });

  await openHotspotModal(page);
  const isReady = await waitForHotspotListReady(page);
  if (!isReady) {
    test.skip(true, 'No Preview/Refresh actions available in current hotspot modal state.');
  }

  const guindyCard = page.locator('div').filter({ hasText: /Guindy snake park/i }).first();
  await expect(guindyCard).toBeVisible({ timeout: 20000 });
  await expect(guindyCard.getByText(/selected/i).first()).toBeVisible({ timeout: 10000 });

  // In this itinerary state Guindy is preselected when modal opens; preview Santhome to test cumulative timeline.
  await clickPreviewForHotspot(page, 'Santhome Cathedral Basilica');

  const proposedPane = page
    .locator('div')
    .filter({ hasText: /proposed timeline/i })
    .first();

  await expect(proposedPane).toBeVisible({ timeout: 15000 });

  const paneText = await proposedPane.innerText();
  const lines = paneText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  expect(lines.some((line) => /guindy snake park/i.test(line))).toBeTruthy();
  expect(lines.some((line) => /santhome cathedral basilica/i.test(line))).toBeTruthy();

  const refreshmentCount = countContaining(lines, 'Refreshment / Buffer');
  const travelToHotelCount = countContaining(lines, 'Travel to Hotel');
  const hotelStayCount = countContaining(lines, 'Hotel Stay');

  expect(refreshmentCount, `Duplicate refreshment rows found. Lines: ${JSON.stringify(lines)}`).toBeLessThanOrEqual(1);
  expect(travelToHotelCount, `Duplicate travel-to-hotel rows found. Lines: ${JSON.stringify(lines)}`).toBeLessThanOrEqual(1);
  expect(hotelStayCount, `Duplicate hotel rows found. Lines: ${JSON.stringify(lines)}`).toBeLessThanOrEqual(1);

  await page.screenshot({ path: 'test-results/manual-hotspot-screenshots/hotspot-modal-regression-result.png', fullPage: true });
});
