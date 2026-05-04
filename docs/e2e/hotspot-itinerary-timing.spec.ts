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
const E2E_ITINERARY_QUOTE_ID = process.env.E2E_ITINERARY_QUOTE_ID ?? '';

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

async function fillRequiredHotspotFields(page: Page, hotspotName: string): Promise<void> {
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

  await page.locator('#videoUrl').fill('https://example.com/hotspot-video');
}

test('hotspot opening-hours flags persist when day has no explicit slots', async ({
  page,
  baseURL,
  request,
}) => {
  test.setTimeout(180000);

  const stamp = Date.now();
  const hotspotName = `PW Timing Persist ${stamp}`;

  await seedAuthToken(page, request);
  await page.goto(`${baseURL}/hotspots/new`, { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveURL(/\/hotspots\/new/i, { timeout: 20000 });
  await expect(page.locator('#name')).toBeVisible();

  await fillRequiredHotspotFields(page, hotspotName);

  const mondayLabel = page
    .locator('div.capitalize.font-medium', { hasText: /^monday$/i })
    .first();
  await expect(mondayLabel).toBeVisible();

  const mondayRow = mondayLabel.locator('xpath=ancestor::div[contains(@class,"grid")][1]');
  const mondaySwitches = mondayRow.getByRole('switch');

  await expect(mondaySwitches).toHaveCount(2);

  const open24Switch = mondaySwitches.nth(0);
  const closed24Switch = mondaySwitches.nth(1);

  await expect(open24Switch).toHaveAttribute('aria-checked', 'false');
  await expect(closed24Switch).toHaveAttribute('aria-checked', 'false');

  await closed24Switch.click();
  await expect(closed24Switch).toHaveAttribute('aria-checked', 'true');

  const saveResponsePromise = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'POST' && /\/hotspots\/form(\?|$)/.test(resp.url()),
    { timeout: 60000 },
  );

  await page.getByRole('button', { name: /^Save$/i }).click();

  const saveResponse = await saveResponsePromise;
  if (!saveResponse.ok()) {
    const body = await saveResponse.text().catch(() => '');
    throw new Error(`Hotspot save failed: status=${saveResponse.status()} body=${body}`);
  }

  const saveJson = (await saveResponse.json()) as { id?: number };
  const hotspotId = Number(saveJson?.id || 0);
  expect(hotspotId).toBeGreaterThan(0);

  await expect(page).toHaveURL(/\/hotspots$/i, { timeout: 60000 });

  await page.goto(`${baseURL}/hotspots/${hotspotId}/edit`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(page).toHaveURL(new RegExp(`/hotspots/${hotspotId}/edit$`));

  const mondayLabelEdit = page
    .locator('div.capitalize.font-medium', { hasText: /^monday$/i })
    .first();
  await expect(mondayLabelEdit).toBeVisible();

  const mondayRowEdit = mondayLabelEdit.locator('xpath=ancestor::div[contains(@class,"grid")][1]');
  const mondaySwitchesEdit = mondayRowEdit.getByRole('switch');

  await expect(mondaySwitchesEdit).toHaveCount(2);
  await expect(mondaySwitchesEdit.nth(0)).toHaveAttribute('aria-checked', 'false');
  await expect(mondaySwitchesEdit.nth(1)).toHaveAttribute('aria-checked', 'true');
});

test('itinerary details include hotspot visit timing fields and render them', async ({
  page,
  baseURL,
  request,
}) => {
  test.skip(!E2E_ITINERARY_QUOTE_ID, 'Set E2E_ITINERARY_QUOTE_ID to run itinerary timing validation test.');
  test.setTimeout(180000);

  const token = await loginForToken(request);
  const apiRes = await request.get(`${API_BASE_URL}/itineraries/details/${encodeURIComponent(E2E_ITINERARY_QUOTE_ID)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!apiRes.ok()) {
    const body = await apiRes.text().catch(() => '');
    throw new Error(`Itinerary details API failed: status=${apiRes.status()} body=${body}`);
  }

  const details = (await apiRes.json()) as any;
  const days = Array.isArray(details?.days) ? details.days : [];
  const attractionSegments: any[] = [];
  for (const day of days) {
    const segments = Array.isArray(day?.segments) ? day.segments : [];
    for (const seg of segments) {
      if (seg?.type === 'attraction') attractionSegments.push(seg);
    }
  }

  expect(attractionSegments.length).toBeGreaterThan(0);
  for (const seg of attractionSegments) {
    expect(typeof seg.visitTime === 'string' || seg.visitTime === null).toBeTruthy();
    expect(seg.timings === undefined || typeof seg.timings === 'string').toBeTruthy();
  }

  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
  }, token);

  await page.goto(`${baseURL}/itinerary-details/${encodeURIComponent(E2E_ITINERARY_QUOTE_ID)}`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(page).toHaveURL(new RegExp(`/itinerary-details/${E2E_ITINERARY_QUOTE_ID}$`), {
    timeout: 30000,
  });

  // Attraction cards render an "Add Activity" trigger and visit-time text.
  await expect(page.getByText(/Add Activity/i).first()).toBeVisible({ timeout: 30000 });

  const annotationFromApi = attractionSegments.find((seg) =>
    typeof seg?.visitTime === 'string' &&
    /(opens at|outside operating hours|closed on this day)/i.test(seg.visitTime),
  );

  if (annotationFromApi?.visitTime) {
    await expect(page.getByText(annotationFromApi.visitTime, { exact: false }).first()).toBeVisible();
  }
});
