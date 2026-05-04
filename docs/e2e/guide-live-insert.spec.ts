import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_VENDOR_USER ?? 'admin@dvi.co.in';
const ADMIN_PASSWORD = process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';

test.use({
  launchOptions: {
    slowMo: 350,
  },
});

test.describe.configure({ mode: 'serial' });

let createdGuideId = 0;
let createdGuideName = '';
let createdGuideEmail = '';
let createdGuideFeedback = '';

async function maybeLogin(page: Page): Promise<void> {
  const signInHeading = page.getByRole('heading', { name: /sign\s*in/i }).first();
  if ((await signInHeading.count()) === 0) return;

  const labeledEmailInput = page
    .locator('input[type="email"], input[name="email"], input[placeholder*="Email" i]')
    .first();
  const labeledPasswordInput = page
    .locator('input[type="password"], input[name="password"], input[placeholder*="Password" i]')
    .first();

  let emailInput = labeledEmailInput;
  let passwordInput = labeledPasswordInput;

  if ((await labeledEmailInput.count()) === 0 || (await labeledPasswordInput.count()) === 0) {
    const textboxes = page.getByRole('textbox');
    const textboxCount = await textboxes.count();
    if (textboxCount < 2) return;
    emailInput = textboxes.nth(0);
    passwordInput = textboxes.nth(1);
  }

  await emailInput.fill(ADMIN_EMAIL);
  await page.waitForTimeout(500);
  await passwordInput.fill(ADMIN_PASSWORD);
  await page.waitForTimeout(500);

  const loginButton = page.getByRole('button', { name: /log\s*in|login|sign\s*in/i }).first();
  if ((await loginButton.count()) > 0) {
    await loginButton.click();
  } else {
    await passwordInput.press('Enter');
  }
  await page.waitForLoadState('networkidle');
}

function fieldByLabel(page: Page, label: RegExp) {
  const labelNode = page.locator('label', { hasText: label }).first();
  return labelNode.locator('xpath=ancestor::div[1]');
}

async function fillInputByLabel(page: Page, label: RegExp, value: string): Promise<void> {
  const input = fieldByLabel(page, label).locator('input').first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await page.waitForTimeout(500);
}

async function fillDateByLabel(page: Page, label: RegExp, value: string): Promise<void> {
  const input = fieldByLabel(page, label).locator('input').first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press('Tab');
  await page.waitForTimeout(500);
}

async function selectFirstOptionByLabel(page: Page, label: RegExp, allowEmpty = false): Promise<void> {
  const combo = fieldByLabel(page, label).locator('[role="combobox"]').first();
  await expect(combo).toBeVisible();

  for (let i = 0; i < 12; i++) {
    await combo.click();
    const options = page.getByRole('option');
    const count = await options.count();
    if (count > 0) {
      await options.first().click();
      await page.waitForTimeout(500);
      return;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  if (!allowEmpty) {
    throw new Error(`No options available for ${label}`);
  }
}

async function selectFirstTokenPickerOptionByLabel(
  page: Page,
  label: RegExp,
  allowEmpty = false,
): Promise<void> {
  const trigger = fieldByLabel(page, label).locator('button[type="button"]').first();
  await expect(trigger).toBeVisible();
  await trigger.click();

  const options = page.locator('div.max-h-64.overflow-auto button');
  const count = await options.count();
  if (count > 0) {
    await options.first().click();
    await page.waitForTimeout(400);
    return;
  }

  if (!allowEmpty) {
    throw new Error(`No token-picker options available for ${label}`);
  }
}

async function selectOptionByLabelAndText(
  page: Page,
  label: RegExp,
  optionText: RegExp,
  allowFallbackFirst = false,
): Promise<void> {
  const combo = fieldByLabel(page, label).locator('[role="combobox"]').first();
  await expect(combo).toBeVisible();

  for (let i = 0; i < 12; i++) {
    await combo.click();
    const desired = page.getByRole('option', { name: optionText }).first();
    if ((await desired.count()) > 0) {
      await desired.click();
      await page.waitForTimeout(500);
      return;
    }
    const options = page.getByRole('option');
    const count = await options.count();
    if (allowFallbackFirst && count > 0) {
      await options.first().click();
      await page.waitForTimeout(500);
      return;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  throw new Error(`Option ${optionText} not found for ${label}`);
}

async function selectNonZeroGstByLabel(page: Page, label: RegExp): Promise<void> {
  const combo = fieldByLabel(page, label).locator('[role="combobox"]').first();
  await expect(combo).toBeVisible();
  await combo.click();

  const options = page.getByRole('option');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = ((await option.textContent()) ?? '').trim();
    const numeric = Number((text.match(/\d+(?:\.\d+)?/) ?? [''])[0]);
    if (Number.isFinite(numeric) && numeric > 0) {
      await option.click();
      await page.waitForTimeout(500);
      return;
    }
  }

  if (count > 0) {
    await options.first().click();
    await page.waitForTimeout(500);
  }
}

async function expectToast(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible();
}

function toLocalYyyyMmDd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function loginForToken(request: APIRequestContext, apiBase: string): Promise<string> {
  const res = await request.post(`${apiBase}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok(), `Admin login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const json = (await res.json()) as { accessToken?: string };
  const token = String(json?.accessToken ?? '').trim();
  expect(token).toBeTruthy();
  return token;
}

async function cleanupCreatedGuides(
  request: APIRequestContext,
  apiBase: string,
  token: string,
): Promise<number> {
  const listRes = await request.get(`${apiBase}/guides?size=5000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.ok(), `Guide list fetch failed: ${listRes.status()} ${await listRes.text()}`).toBeTruthy();

  const body = (await listRes.json()) as any;
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const targets = rows
    .map((r) => ({
      id: Number(r?.modify ?? r?.id ?? r?.guide_id ?? 0),
      name: String(r?.guide_name ?? r?.name ?? ''),
      email: String(r?.guide_email ?? r?.email ?? ''),
    }))
    .filter(
      (r) =>
        r.id > 0 &&
        (/^Live Guide\s+/i.test(r.name) || /@example\.com$/i.test(r.email)),
    );

  let deleted = 0;
  for (const row of targets) {
    const delRes = await request.delete(`${apiBase}/guides/${row.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (delRes.ok()) {
      deleted += 1;
    }
  }
  return deleted;
}

test('live visible guide insertion', async ({ page, baseURL, request }) => {
  test.setTimeout(420000);

  const stamp = Date.now();
  const guideName = `Live Guide ${stamp}`;
  const guideEmail = `live.guide.${stamp}@example.com`;
  const guideMobile = `9${String(stamp).slice(-9)}`;

  const apiBase = 'http://127.0.0.1:4006/api/v1';
  const token = await loginForToken(request, apiBase);
  const deletedCount = await cleanupCreatedGuides(request, apiBase, token);
  console.log(`Deleted old auto-created guides: ${deletedCount}`);
  await page.addInitScript((t: string) => {
    window.localStorage.setItem('accessToken', t);
  }, token);

  await page.goto(`${baseURL}/guide`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);
  await expect(page.getByText(/List of Guide/i).first()).toBeVisible();

  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Add Guide/i }).click();
  await expect(page.getByText(/Add Guide/i).first()).toBeVisible();

  // Start from a clean form state to make inline validation checks deterministic.
  await fillInputByLabel(page, /^Guide Name\s*\*/i, '');
  await fillInputByLabel(page, /^Primary Mobile Number\s*\*/i, '');
  await fillInputByLabel(page, /^Email ID\s*\*/i, '');
  await fillInputByLabel(page, /^Password\s*\*/i, '');
  await fillInputByLabel(page, /^Alternative Mobile Number$/i, '');
  await fillInputByLabel(page, /^Emergency Mobile Number$/i, '');
  await fillInputByLabel(page, /^Aadhar Card No$/i, '');
  await fillInputByLabel(page, /^Experience$/i, '');

  // Inline validations in order
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Guide Name Required');

  await fillInputByLabel(page, /^Guide Name\s*\*/i, guideName);
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Guide Gender Required');

  await selectFirstOptionByLabel(page, /^Gender\s*\*/i);
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Guide Primart Mobile no Required');

  await fillInputByLabel(page, /^Primary Mobile Number\s*\*/i, guideMobile);
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Email ID Required');

  await fillInputByLabel(page, /^Email ID\s*\*/i, guideEmail);
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Role Required');

  await fillInputByLabel(page, /^Password\s*\*/i, 'Guide@12345');
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Role Required');

  await selectFirstOptionByLabel(page, /^Role\s*\*/i);
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Language Proficiency Required');

  await selectFirstOptionByLabel(page, /^Language Proficiency\s*\*/i);
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Guide Slot Required');

  // Fill all remaining fields
  await fillDateByLabel(page, /^Date of Birth$/i, '15/08/1994');
  await selectFirstOptionByLabel(page, /^Blood Group\s*\*/i);
  await fillInputByLabel(page, /^Alternative Mobile Number$/i, '9123456780');
  await fillInputByLabel(page, /^Emergency Mobile Number$/i, guideMobile);
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Emeregency mobile number and primary mobile number should not be same');
  await fillInputByLabel(page, /^Emergency Mobile Number$/i, '9234567890');

  await fillInputByLabel(page, /^Aadhar Card No$/i, '123456789012');
  await fillInputByLabel(page, /^Experience$/i, '5');

  await selectOptionByLabelAndText(page, /^Country$/i, /^India$/i, true);
  await selectOptionByLabelAndText(page, /^State$/i, /^Telangana$/i, true);
  await selectOptionByLabelAndText(page, /^City$/i, /^Hyderabad$/i, true);
  await selectFirstOptionByLabel(page, /^GST Type\s*\*/i);
  await selectNonZeroGstByLabel(page, /^GST%\s*\*/i);

  await page.getByLabel(/Slot 1: 9 AM to 1 PM/i).check();
  await page.getByLabel(/Slot 2: 9 AM to 4 PM/i).check();
  await page.waitForTimeout(300);

  await fillInputByLabel(page, /^Bank Name$/i, 'State Bank of India');
  await fillInputByLabel(page, /^Branch Name$/i, 'Chennai Main');
  await fillInputByLabel(page, /^IFSC Code$/i, 'SBIN0001234');
  await fillInputByLabel(page, /^Account Number$/i, '12345678901');
  await fillInputByLabel(page, /^Confirm Account Number$/i, '99999999999');
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expectToast(page, 'Account number and confirm account number should be same');
  await fillInputByLabel(page, /^Confirm Account Number$/i, '12345678901');

  await page.getByLabel(/^Hotspot$/i).check();
  await page.waitForTimeout(400);
  await selectFirstTokenPickerOptionByLabel(page, /^Hotspot Place\s*\*/i, true);
  await expect(page.getByRole('heading', { name: /Guide Prefered For/i })).toBeVisible();

  const saveBasicResp = page.waitForResponse(
    (resp) => {
      const method = resp.request().method();
      const url = resp.url();
      return ['POST', 'PUT'].includes(method) && /\/api\/v1\/guides(\/\d+)?$/i.test(url);
    },
    { timeout: 30000 },
  );

  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  const basicResp = await saveBasicResp;
  expect(basicResp.ok(), `Basic save failed: ${basicResp.status()} ${await basicResp.text()}`).toBeTruthy();
  await page.waitForTimeout(1200);
  await expectToast(page, 'Guide Basic Details Added');
  await expect(page).toHaveURL(/\/guide\/\d+\/edit/);
  const urlMatch = page.url().match(/\/guide\/(\d+)\/edit/i);
  createdGuideId = Number(urlMatch?.[1] ?? 0);
  createdGuideName = guideName;
  createdGuideEmail = guideEmail;

  // Step 2: Pricebook
  const startDateInput = page.getByPlaceholder('Start Date');
  const endDateInput = page.getByPlaceholder('End date');
  await expect(startDateInput).toBeVisible();
  await expect(endDateInput).toBeVisible();

  const today = new Date();
  const nextYear = new Date(today);
  nextYear.setFullYear(today.getFullYear() + 1);

  await expect(startDateInput).toHaveValue(toLocalYyyyMmDd(today));
  await expect(endDateInput).toHaveValue(toLocalYyyyMmDd(nextYear));

  await startDateInput.fill('2026-05-03');
  await page.waitForTimeout(500);
  await endDateInput.fill('2026-05-01');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Update(\s*&\s*Continue)?/i }).first().click();
  await expectToast(page, 'End Date must be on or after Start Date');

  await startDateInput.fill('2026-05-01');
  await page.waitForTimeout(500);
  await endDateInput.fill('2026-05-03');
  await page.waitForTimeout(500);
  const prices = page.locator('input[placeholder="Enter Price"]');
  const priceCount = await prices.count();
  for (let i = 0; i < priceCount; i++) {
    await prices.nth(i).fill(String(1000 + i * 100));
  }
  await page.waitForTimeout(500);

  const pricebookResp = page.waitForResponse(
    (resp) => /\/api\/v1\/guides\/\d+\/pricebook$/i.test(resp.url()) && ['PATCH', 'PUT'].includes(resp.request().method()),
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: /Update(\s*&\s*Continue)?/i }).first().click();
  const pbResp = await pricebookResp;
  expect(pbResp.ok(), `Pricebook save failed: ${pbResp.status()} ${await pbResp.text()}`).toBeTruthy();
  await expectToast(page, 'Guide Price Book Details Updated Successfully');
  await expect(page.getByText(/List of Reviews/i)).toBeVisible();
  await page.waitForTimeout(1000);

  // Step 3: Reviews
  await page.getByRole('button', { name: /^Save$/i }).click();
  await expectToast(page, 'Rating is Required');

  await page.getByRole('combobox').first().click();
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: /4 Stars/i }).click();
  await page.waitForTimeout(500);

  await page.getByRole('button', { name: /^Save$/i }).click();
  await expectToast(page, 'Description is Required');

  const feedback = `Live review ${stamp}`;
  createdGuideFeedback = feedback;
  const feedbackAnchor = page.getByText(/^Feedback\s*\*/i).first();
  const feedbackBox = feedbackAnchor.locator('xpath=following::textarea[1]');
  await feedbackBox.fill(feedback);
  await page.waitForTimeout(500);

  const reviewResp = page.waitForResponse(
    (resp) => /\/api\/v1\/guides\/\d+\/reviews$/i.test(resp.url()) && resp.request().method() === 'POST',
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: /^Save$/i }).click();
  const rvResp = await reviewResp;
  expect(rvResp.ok(), `Review save failed: ${rvResp.status()} ${await rvResp.text()}`).toBeTruthy();
  await expectToast(page, 'Feedback Details Created Successfully');
  await expect(page.getByText(feedback).first()).toBeVisible();
  await page.waitForTimeout(900);

  // Step 4: Preview + Confirm
  await page.getByRole('button', { name: /Skip and Continue/i }).click();
  await expect(page.getByText(/Basic Info/i).first()).toBeVisible();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /Confirm/i }).click();
  await expectToast(page, 'Guide saved successfully');
  await page.waitForTimeout(1500);

  // Verify in list
  await page.goto(`${baseURL}/guide`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/List of Guide/i).first()).toBeVisible();
  const search = page.getByText(/^Search:$/i).locator('xpath=..').getByRole('textbox').first();
  await search.fill(guideName);
  await page.waitForTimeout(1200);
  await expect(page.locator('tr', { hasText: guideName }).first()).toBeVisible();

  const finalUrl = page.url();
  console.log(`Live run finished at URL: ${finalUrl}`);
});

test('edit existing guide shows hotspot and pricebook values', async ({ page, baseURL, request }) => {
  test.setTimeout(240000);
  test.skip(!createdGuideName, 'No created guide context available from previous test');

  const apiBase = 'http://127.0.0.1:4006/api/v1';
  const token = await loginForToken(request, apiBase);
  await page.addInitScript((t: string) => {
    window.localStorage.setItem('accessToken', t);
  }, token);

  await page.goto(`${baseURL}/guide`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);
  await expect(page.getByText(/List of Guide/i).first()).toBeVisible();

  const search = page.getByText(/^Search:$/i).locator('xpath=..').getByRole('textbox').first();
  await search.fill(createdGuideName);
  await page.waitForTimeout(1200);

  const row = page.locator('tr', { hasText: createdGuideName }).first();
  await expect(row).toBeVisible();
  await row.locator('button').nth(1).click();
  await expect(page).toHaveURL(/\/guide\/\d+\/edit/i);

  await expect(page.getByRole('heading', { name: /Guide Prefered For/i })).toBeVisible();
  await expect(page.getByLabel(/^Hotspot$/i)).toBeChecked();
  await expect(page.getByText(/Select hotspot/i).first()).not.toBeVisible();

  await page.getByText(/^Pricebook$/i).first().click();
  await page.waitForTimeout(1000);

  const prices = page.locator('input[placeholder="Enter Price"]');
  await expect(prices.first()).toBeVisible();
  const firstValue = await prices.first().inputValue();
  expect(firstValue.trim().length).toBeGreaterThan(0);

  if (createdGuideId > 0) {
    await expect(page).toHaveURL(new RegExp(`/guide/${createdGuideId}/edit`, 'i'));
  }
});

test('api verifies all guide steps inserted', async ({ request }) => {
  test.setTimeout(120000);
  test.skip(!createdGuideId, 'No created guide id available from previous test');

  const apiBase = 'http://127.0.0.1:4006/api/v1';
  const token = await loginForToken(request, apiBase);

  const res = await request.get(`${apiBase}/guides/${createdGuideId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `Guide get failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = (await res.json()) as any;

  // Step 1 (basic + preferred-for)
  expect(Number(body?.id ?? 0)).toBe(createdGuideId);
  expect(String(body?.name ?? '')).toBe(createdGuideName);
  expect(String(body?.email ?? '')).toBe(createdGuideEmail);
  expect(Boolean(body?.preferredFor?.hotspot)).toBeTruthy();
  expect(Array.isArray(body?.hotspotPlaces)).toBeTruthy();
  expect((body?.hotspotPlaces ?? []).length).toBeGreaterThan(0);

  // Step 2 (pricebook)
  expect(Number(body?.pricebook?.pax1to5?.slot1 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax1to5?.slot2 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax1to5?.slot3 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax6to14?.slot1 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax6to14?.slot2 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax6to14?.slot3 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax15to40?.slot1 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax15to40?.slot2 ?? 0)).toBeGreaterThan(0);
  expect(Number(body?.pricebook?.pax15to40?.slot3 ?? 0)).toBeGreaterThan(0);

  // Step 3 (reviews)
  expect(Array.isArray(body?.reviews)).toBeTruthy();
  expect((body?.reviews ?? []).length).toBeGreaterThan(0);
  const hasFeedback = (body?.reviews ?? []).some((r: any) =>
    String(r?.description ?? '').includes(createdGuideFeedback),
  );
  expect(hasFeedback).toBeTruthy();
});
