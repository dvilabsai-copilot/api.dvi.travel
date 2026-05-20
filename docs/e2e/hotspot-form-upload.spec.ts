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

async function seedAuthToken(page: Page, request: APIRequestContext): Promise<void> {
  const loginRes = await request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text().catch(() => '');
    throw new Error(`Auth login failed: status=${loginRes.status()} body=${body}`);
  }

  const json = (await loginRes.json()) as { accessToken?: string };
  const token = String(json?.accessToken || '').trim();
  if (!token) throw new Error('Auth login succeeded but accessToken missing');

  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
  }, token);
}

test('hotspot create form: fill fields, upload image, and save successfully', async ({ page, baseURL, request }) => {
  test.setTimeout(180000);

  const stamp = Date.now();
  const hotspotName = `PW Hotspot ${stamp}`;

  await seedAuthToken(page, request);
  await page.goto(`${baseURL}/hotspots/new`, { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveURL(/\/hotspots\/new/i, { timeout: 20000 });

  await expect(page.locator('#name')).toBeVisible();

  await page.locator('#name').fill(hotspotName);
  await page.locator('#type').fill('Sightseeing');

  await page.locator('#adultCost').fill('150');
  await page.locator('#childCost').fill('100');
  await page.locator('#infantCost').fill('0');
  await page.locator('#foreignAdultCost').fill('300');
  await page.locator('#foreignChildCost').fill('200');
  await page.locator('#foreignInfantCost').fill('0');

  await page.locator('#rating').fill('4.5');
  await page.locator('#priority').fill('1');
  await page.locator('#latitude').fill('11.4064');
  await page.locator('#longitude').fill('76.6932');
  await page.locator('#duration').fill('01:30');

  await page.locator('#landmark').fill('Playwright Landmark');
  await page.locator('#address').fill('Playwright Test Address, Ooty');
  await page.locator('#description').fill('Hotspot created by Playwright E2E test');

  await page.locator('#hotspotLocation').fill('Ooty');
  const locationOption = page.getByRole('button', { name: /^Ooty$/i }).first();
  if (await locationOption.isVisible().catch(() => false)) {
    await locationOption.click();
  } else {
    await page.locator('#hotspotLocation').press('Enter');
  }

  await page.locator('input[type="file"][accept*="image/"]').first().setInputFiles({
    name: 'hotspot-test-image.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="140" viewBox="0 0 220 140">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" stop-color="#0ea5e9"/>' +
          '<stop offset="100%" stop-color="#22c55e"/>' +
        '</linearGradient></defs>' +
        '<rect width="220" height="140" fill="url(#g)"/>' +
        '<circle cx="44" cy="44" r="24" fill="#ffffff" fill-opacity="0.85"/>' +
        '<rect x="24" y="92" width="172" height="24" rx="6" fill="#111827" fill-opacity="0.8"/>' +
        '<text x="110" y="109" text-anchor="middle" font-family="Arial" font-size="12" fill="#ffffff">Playwright Hotspot</text>' +
      '</svg>',
      'utf8'
    ),
  });

  await page.locator('#videoUrl').fill('https://example.com/hotspot-video');

  const saveResponsePromise = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'POST' && /\/hotspots\/form(\?|$)/.test(resp.url()),
    { timeout: 60000 }
  );
  const galleryResponsePromise = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'POST' && /\/hotspots\/\d+\/gallery\/upload(\?|$)/.test(resp.url()),
    { timeout: 60000 }
  );

  await page.getByRole('button', { name: /^Save$/i }).click();

  const saveResponse = await saveResponsePromise;
  if (!saveResponse.ok()) {
    const body = await saveResponse.text().catch(() => '');
    throw new Error(`Hotspot save failed: status=${saveResponse.status()} body=${body}`);
  }

  const galleryResponse = await galleryResponsePromise;
  if (!galleryResponse.ok()) {
    const body = await galleryResponse.text().catch(() => '');
    throw new Error(`Hotspot gallery upload failed: status=${galleryResponse.status()} body=${body}`);
  }

  await expect(page).toHaveURL(/\/hotspots$/i, { timeout: 60000 });
});
