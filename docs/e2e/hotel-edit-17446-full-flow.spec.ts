import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const USER_EMAIL =
  process.env.E2E_HOTEL_USER ??
  process.env.E2E_VENDOR_USER ??
  'admin@dvi.co.in';
const USER_PASSWORD =
  process.env.E2E_HOTEL_PASSWORD ??
  process.env.E2E_VENDOR_PASSWORD ??
  'Keerthi@2404ias';

const HOTEL_ID = Number(process.env.E2E_HOTEL_EDIT_ID ?? '17446');
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';
const VISUAL_PAUSE_MS = Number(process.env.E2E_VISUAL_PAUSE_MS ?? '2500');

async function seedAuthTokens(page: Page, request: APIRequestContext): Promise<void> {
  const loginRes = await request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });

  if (!loginRes.ok()) {
    const body = await loginRes.text().catch(() => '');
    throw new Error(`Auth login failed: status=${loginRes.status()} body=${body}`);
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
}

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isoToDmy(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

async function visualPause(page: Page, label: string) {
  if (!Number.isFinite(VISUAL_PAUSE_MS) || VISUAL_PAUSE_MS <= 0) return;
  console.log(`[visual-pause] ${label} (${VISUAL_PAUSE_MS}ms)`);
  await page.waitForTimeout(VISUAL_PAUSE_MS);
}

async function ensureTab(page: Page, baseURL: string, hotelId: number, tab: string) {
  const regex = new RegExp(`/hotels/${hotelId}/edit\\?tab=${tab}`, 'i');
  const current = page.url();
  if (!regex.test(current)) {
    await page.goto(`${baseURL}/hotels/${hotelId}/edit?tab=${tab}`, {
      waitUntil: 'domcontentloaded',
    });
  }
  await expect(page).toHaveURL(regex);
}

async function setDateValue(locator: ReturnType<Page['locator']>, value: string) {
  try {
    await locator.click();
    await locator.fill(value);
    await locator.press('Tab');
  } catch {
    await locator.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
}

test('hotel edit 17446: all tabs validation + upload + preview + save progression', async ({
  page,
  baseURL,
  request,
}) => {
  test.setTimeout(240000);

  await seedAuthTokens(page, request);

  const editUrl = `${baseURL}/hotels/${HOTEL_ID}/edit?tab=basic`;
  await page.goto(editUrl, { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveURL(new RegExp(`/hotels/${HOTEL_ID}/edit\\?tab=basic`, 'i'));
  await expect(page.getByText(/Edit Hotel - Basic Details|Basic Details/i).first()).toBeVisible();
  await visualPause(page, 'Loaded Basic tab');

  // ------------------------
  // 1) BASIC: validation + save
  // ------------------------
  const hotelName = page.locator('input[placeholder="Enter the Hotel Name"]').first();
  await hotelName.fill('');
  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  await expect(page.getByText(/^Required$/i).first()).toBeVisible();

  await hotelName.fill(`PW Hotel ${Date.now()}`);
  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();

  await ensureTab(page, baseURL!, HOTEL_ID, 'rooms');
  await expect(page.getByText(/^Rooms$/i).first()).toBeVisible();
  await visualPause(page, 'Moved to Rooms tab');

  // ------------------------
  // 2) ROOMS: validation + image upload + save
  // ------------------------
  const firstRoomTitle = page.locator('input[placeholder="Enter the Room Title"]').first();
  const firstRoomType = page.locator('input[placeholder*="Type room type"]').first();
  const originalTitle = await firstRoomTitle.inputValue();

  await firstRoomTitle.fill('');
  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  await expect(
    page.getByText(/Room\s*1:\s*(Room Type|Room Title) is required/i),
  ).toBeVisible();

  await firstRoomType.fill('1');
  await firstRoomTitle.fill(originalTitle || 'Playwright Room');

  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgA3jR04AAAAASUVORK5CYII=',
    'base64',
  );
  await page.locator('input[type="file"]').first().setInputFiles({
    name: `room-gallery-${Date.now()}.png`,
    mimeType: 'image/png',
    buffer: pngBuffer,
  });

  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  await expect(page).toHaveURL(new RegExp(`/hotels/${HOTEL_ID}/edit\\?tab=amenities`, 'i'));
  await expect(page.getByText(/^Amenities$/i).first()).toBeVisible();
  await visualPause(page, 'Moved to Amenities tab');

  // ------------------------
  // 3) AMENITIES: validation + save
  // ------------------------
  const firstAmenityTitle = page.locator('input[placeholder="Enter Amenities Title"]').first();
  const originalAmenityTitle = await firstAmenityTitle.inputValue();

  await firstAmenityTitle.fill('');
  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  await expect(page.getByText(/Amenities\s*1:\s*Amenities Title is required/i)).toBeVisible();

  await firstAmenityTitle.fill(originalAmenityTitle || 'Playwright Amenity');
  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  await expect(page).toHaveURL(new RegExp(`/hotels/${HOTEL_ID}/edit\\?tab=pricebook`, 'i'));
  await expect(page.getByText(/Hotel Price Book/i)).toBeVisible();
  await visualPause(page, 'Moved to PriceBook tab');

  // ------------------------
  // 4) PRICEBOOK: validations + section updates
  // ------------------------
  const updateButtons = page.getByRole('button', { name: /^Update$/i });
  await expect(updateButtons).toHaveCount(4);

  // Hotel details update
  await updateButtons.nth(0).click();
  await expect(page.getByText(/Hotel details updated successfully\./i)).toBeVisible();

  // Meal validation: missing dates
  await updateButtons.nth(1).click();
  await expect(
    page.getByText(
      /Start date and End date should be required|Start date should be required|End date should be required/i,
    ),
  ).toBeVisible();

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = tomorrowIso();
  const todayDmy = isoToDmy(today);
  const tomorrowDmy = isoToDmy(tomorrow);
  let dateInputs = page.locator('input[placeholder="dd-mm-yyyy"]');
  let dateValueStart = todayDmy;
  let dateValueEnd = tomorrowDmy;
  if ((await dateInputs.count()) < 6) {
    dateInputs = page.locator('input[type="date"]');
    dateValueStart = today;
    dateValueEnd = tomorrow;
  }
  await expect(dateInputs).toHaveCount(6);

  // Meal dates + price
  await setDateValue(dateInputs.nth(0), dateValueStart);
  await setDateValue(dateInputs.nth(1), dateValueEnd);
  await expect(dateInputs.nth(0)).toHaveValue(dateValueStart);
  await expect(dateInputs.nth(1)).toHaveValue(dateValueEnd);
  await page.locator('input[placeholder="Enter Breakfast Cost"]').fill('150');
  await updateButtons.nth(1).click();
  await expect(page.getByText(/Meal details saved successfully\./i)).toBeVisible();

  // Amenities validation: missing dates/charges
  await updateButtons.nth(2).click();
  await expect(
    page.getByText(
      /Start date and End date should be required|Please enter at least one price for the amenities/i,
    ),
  ).toBeVisible();

  await setDateValue(dateInputs.nth(2), dateValueStart);
  await setDateValue(dateInputs.nth(3), dateValueEnd);
  await expect(dateInputs.nth(2)).toHaveValue(dateValueStart);
  await expect(dateInputs.nth(3)).toHaveValue(dateValueEnd);
  await page.locator('input[placeholder="Hours Charge"]').first().fill('75');
  await updateButtons.nth(2).click();
  await expect(page.getByText(/Amenities price book saved successfully\./i)).toBeVisible();

  // Room validation: at least one price + dates
  const roomPriceInput = page.locator('input[placeholder="Enter the Room Price"]').first();
  await expect(roomPriceInput).toBeVisible({ timeout: 30000 });
  await roomPriceInput.fill('1200');
  await updateButtons.nth(3).click();
  await expect(
    page.getByText(
      /Start date and End date should be required|Start date should be required|End date should be required/i,
    ),
  ).toBeVisible();

  await setDateValue(dateInputs.nth(4), dateValueStart);
  await setDateValue(dateInputs.nth(5), dateValueEnd);
  await expect(dateInputs.nth(4)).toHaveValue(dateValueStart);
  await expect(dateInputs.nth(5)).toHaveValue(dateValueEnd);
  await updateButtons.nth(3).click();
  await expect(page.getByText(/Room price book saved successfully\./i)).toBeVisible();

  await page.getByRole('button', { name: /^Continue$/i }).click();
  await ensureTab(page, baseURL!, HOTEL_ID, 'reviews');
  await visualPause(page, 'Moved to Reviews tab');

  // ------------------------
  // 5) REVIEWS: validation + save
  // ------------------------
  await expect(page.getByText(/Review\s*&\s*Feedback/i).first()).toBeVisible();

  const feedback = page.locator('#review_description');
  await feedback.fill('');
  await page.getByRole('button', { name: /^Save$/i }).click();
  await expect(
    page.getByText(/Rating is required|Review Description Required/i).first(),
  ).toBeVisible();

  await page.locator('#hotel_rating').selectOption('5');
  await feedback.fill(`Playwright review check for hotel ${HOTEL_ID} at ${Date.now()}`);
  await page.getByRole('button', { name: /^Save$/i }).click();
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20000 });

  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  await ensureTab(page, baseURL!, HOTEL_ID, 'preview');
  await visualPause(page, 'Moved to Preview tab');

  // ------------------------
  // 6) PREVIEW: verify sections visible
  // ------------------------
  await expect(page.getByText(/^Preview$/i).first()).toBeVisible();
  await expect(page.getByText(/^Basic Info$/i).first()).toBeVisible();
  await expect(page.getByText(/^Rooms$/i).first()).toBeVisible();
  await expect(page.getByText(/^Amenities$/i).first()).toBeVisible();
  await expect(page.getByText(/^List of Reviews$/i).first()).toBeVisible();
  await visualPause(page, 'Preview assertions complete');

  await page.getByRole('button', { name: /^Back$/i }).click();
  await ensureTab(page, baseURL!, HOTEL_ID, 'reviews');
});
