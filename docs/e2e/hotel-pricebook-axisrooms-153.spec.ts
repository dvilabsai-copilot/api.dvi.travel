import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_HOTEL_USER ?? process.env.E2E_VENDOR_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD =
  process.env.E2E_HOTEL_PASSWORD ?? process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';

const HOTEL_ID = Number(process.env.E2E_AXIS_HOTEL_ID ?? '153');
const ROOM_REF_CODE = process.env.E2E_AXIS_ROOM_REF_CODE ?? 'DVIRHON666981';
const ROOM_TITLE = process.env.E2E_AXIS_ROOM_TITLE ?? 'Executive';
const RATEPLAN_ID = process.env.E2E_AXIS_RATEPLAN_ID ?? 'CP_PLAN';
const START_DATE = process.env.E2E_AXIS_START_DATE ?? '2026-05-05';
const END_DATE = process.env.E2E_AXIS_END_DATE ?? '2026-05-06';

const SINGLE_PRICE = process.env.E2E_AXIS_SINGLE_PRICE ?? '3111';
const DOUBLE_PRICE = process.env.E2E_AXIS_DOUBLE_PRICE ?? '3222';
const EXTRA_BED = process.env.E2E_AXIS_EXTRA_BED ?? '777';

const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';

async function tryLogin(request: APIRequestContext, loginUrl: string) {
  return request.post(loginUrl, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });
}

async function seedAuthTokens(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
): Promise<string> {
  let loginRes;
  let lastErrorText = '';

  const attempts = [`${API_BASE_URL}/auth/login`, `${baseURL}/api/v1/auth/login`];
  for (const loginUrl of attempts) {
    try {
      loginRes = await tryLogin(request, loginUrl);
      if (loginRes.ok()) break;
      const text = await loginRes.text().catch(() => '');
      lastErrorText = `url=${loginUrl} status=${loginRes.status()} body=${text}`;
    } catch (error) {
      lastErrorText = `url=${loginUrl} error=${String((error as Error)?.message || error)}`;
    }
  }

  if (!loginRes || !loginRes.ok()) {
    throw new Error(`Auth login failed for all endpoints: ${lastErrorText}`);
  }

  const json = (await loginRes.json()) as { accessToken?: string; token?: string };
  const token = String(json?.accessToken || json?.token || '').trim();
  if (!token) {
    throw new Error('Auth login succeeded but access token was missing');
  }

  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
    window.localStorage.setItem('token', t);
  }, token);

  return token;
}

function parseISODate(value: string): Date {
  const dt = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return dt;
}

test('hotel 153 pricebook update persists occupancy pricing for target room and rate plan', async ({
  page,
  request,
  baseURL,
}) => {
  parseISODate(START_DATE);
  parseISODate(END_DATE);

  const token = await seedAuthTokens(page, request, String(baseURL));

  await page.goto(`${baseURL}/hotels/${HOTEL_ID}/edit?tab=pricebook`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(page).toHaveURL(new RegExp(`/hotels/${HOTEL_ID}/edit\\?tab=pricebook`, 'i'));
  await expect(page.getByText(/Hotel Price Book/i)).toBeVisible();

  const roomSection = page.locator('div.border.rounded-xl.bg-white.shadow-sm').filter({ hasText: 'Room Details' }).first();

  await expect(roomSection).toBeVisible();

  const roomDateInputs = roomSection.locator('input[type="date"]');
  await expect(roomDateInputs).toHaveCount(2);
  await roomDateInputs.nth(0).fill(START_DATE);
  await expect(roomDateInputs.nth(0)).toHaveValue(START_DATE);
  await roomDateInputs.nth(1).fill(END_DATE);
  await expect(roomDateInputs.nth(1)).toHaveValue(END_DATE);

  const roomSelect = roomSection.locator('select').nth(0);
  await expect(roomSelect).toBeVisible();
  await roomSelect.selectOption({ label: `${ROOM_REF_CODE} - ${ROOM_TITLE}` });

  const ratePlanSelect = roomSection.locator('select').nth(1);
  await expect(ratePlanSelect).toBeVisible();
  await ratePlanSelect.selectOption(RATEPLAN_ID);

  const singleInput = roomSection.locator('input[placeholder="Enter SINGLE"]');
  const doubleInput = roomSection.locator('input[placeholder="Enter DOUBLE"]');
  const extraBedInput = roomSection.locator('input[placeholder="Enter EXTRABED"]');

  await singleInput.fill(SINGLE_PRICE);
  await expect(singleInput).toHaveValue(SINGLE_PRICE);

  await doubleInput.fill(DOUBLE_PRICE);
  await expect(doubleInput).toHaveValue(DOUBLE_PRICE);

  await extraBedInput.fill(EXTRA_BED);
  await expect(extraBedInput).toHaveValue(EXTRA_BED);

  await roomSection.screenshot({ path: 'test-results/axisrooms-room-filled-before-save.png' });

  const saveRequest = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      /\/api\/v1\/hotels\/\d+\/rooms\/pricebook\/bulk/i.test(res.url()) &&
      res.status() >= 200 &&
      res.status() < 300,
    { timeout: 30000 },
  );

  await roomSection.getByRole('button', { name: /^Update$/i }).click();
  await saveRequest;

  await expect(page.getByText(/Room price book saved successfully\./i)).toBeVisible({
    timeout: 30000,
  });

  const currentDayViewResponse = await request.get(
    `${API_BASE_URL}/hotels/${HOTEL_ID}/pricebook/current-day-view?date=${START_DATE}&roomId=189&rateplanId=${RATEPLAN_ID}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  expect(currentDayViewResponse.ok()).toBeTruthy();

  const currentDayView = (await currentDayViewResponse.json()) as {
    rooms?: Array<{ roomName?: string; price?: number }>;
    extras?: Array<{ bedType?: string; price?: number }>;
  };

  expect(currentDayView.rooms?.some((row) => row.roomName === ROOM_TITLE && Number(row.price) === Number(DOUBLE_PRICE))).toBeTruthy();
  expect(currentDayView.extras?.some((row) => /extra bed/i.test(String(row.bedType)) && Number(row.price) === Number(EXTRA_BED))).toBeTruthy();
});
