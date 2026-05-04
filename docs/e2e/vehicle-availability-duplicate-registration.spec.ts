import { expect, test, type Locator, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_VENDOR_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';

async function maybeLogin(page: Page): Promise<void> {
  const signInHeading = page.getByRole('heading', { name: /sign\s*in/i }).first();
  if ((await signInHeading.count()) === 0) return;

  let emailInput = page.getByLabel(/email/i).first();
  let passwordInput = page.getByLabel(/password/i).first();

  if ((await emailInput.count()) === 0 || (await passwordInput.count()) === 0) {
    emailInput = page
      .locator('input[type="email"], input[name="email"], input[placeholder*="Email" i]')
      .first();
    passwordInput = page
      .locator('input[type="password"], input[name="password"], input[placeholder*="Password" i]')
      .first();
  }

  if ((await emailInput.count()) === 0 || (await passwordInput.count()) === 0) {
    const textboxes = page.getByRole('textbox');
    const count = await textboxes.count();
    if (count < 2) throw new Error('Login form inputs not found');
    emailInput = textboxes.nth(0);
    passwordInput = textboxes.nth(1);
  }

  await emailInput.fill(USER_EMAIL);
  await passwordInput.fill(USER_PASSWORD);

  const loginButton = page.getByRole('button', { name: /log\s*in|login|sign\s*in/i }).first();
  if ((await loginButton.count()) > 0) {
    await loginButton.click();
  } else {
    await passwordInput.press('Enter');
  }

  await page.waitForLoadState('networkidle');
}

async function ensureAuthenticatedSession(page: Page, baseURL: string): Promise<void> {
  const resp = await page.request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });

  if (resp.ok()) {
    const data = await resp.json().catch(() => ({}));
    if (data?.accessToken) {
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await page.evaluate((token: string) => {
        localStorage.setItem('accessToken', token);
      }, data.accessToken as string);
      return;
    }
  }

  // Fallback path keeps the spec usable even if auth API host differs.
  await page.goto(`${baseURL}/vehicle-availability`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);
}

async function waitForOptionCount(selectEl: Locator, minCount: number, timeoutMs = 12000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await selectEl.locator('option').count();
    if (count >= minCount) return true;
    await selectEl.page().waitForTimeout(250);
  }
  return false;
}

async function selectFirstOption(selectEl: Locator): Promise<string> {
  await expect
    .poll(async () => await selectEl.locator('option').count(), { timeout: 15000 })
    .toBeGreaterThan(1);

  const optionCount = await selectEl.locator('option').count();
  for (let i = 0; i < optionCount; i += 1) {
    const opt = selectEl.locator('option').nth(i);
    const value = (await opt.getAttribute('value')) ?? '';
    const label = ((await opt.textContent()) ?? '').trim();
    const isPlaceholder = /^choose\b/i.test(label) || /^select\b/i.test(label) || !label;

    if (value && !isPlaceholder) {
      await selectEl.selectOption(value);
      return value;
    }
  }

  throw new Error('Could not resolve a non-placeholder option value');
}

async function pickVendorWithDependencies(
  vehicleVendorSelect: Locator,
  branchSelect: Locator,
  typeSelect: Locator,
): Promise<string> {
  const vendorOptionCount = await vehicleVendorSelect.locator('option').count();

  for (let i = 0; i < vendorOptionCount; i += 1) {
    const opt = vehicleVendorSelect.locator('option').nth(i);
    const value = (await opt.getAttribute('value')) ?? '';
    const label = ((await opt.textContent()) ?? '').trim();
    const isPlaceholder = /^choose\b/i.test(label) || /^select\b/i.test(label) || !label;
    if (!value || isPlaceholder) continue;

    await vehicleVendorSelect.selectOption(value);
    const hasBranches = await waitForOptionCount(branchSelect, 2, 8000);
    const hasTypes = await waitForOptionCount(typeSelect, 2, 8000);

    if (hasBranches && hasTypes) return value;
  }

  throw new Error('No vendor found with branch + vehicle type options in Add Vehicle modal');
}

async function fillVehicleRequiredFields(modal: Locator, registrationNo: string): Promise<void> {
  await modal.getByPlaceholder('Registration Number').fill(registrationNo);
  await modal.getByPlaceholder('Search city / origin…').fill('Chennai');

  const dateInputs = modal.locator('input[type="date"]');
  await dateInputs.nth(0).fill('2027-12-31');
  await dateInputs.nth(1).fill('2026-01-01');
  await dateInputs.nth(2).fill('2027-12-31');
}

test('vehicle availability add vehicle blocks duplicate registration for same vendor', async ({ page, baseURL }) => {
  test.setTimeout(300000);

  if (!baseURL) throw new Error('baseURL is required for this e2e test');

  const stamp = Date.now();
  const registrationNo = `TN${String(stamp).slice(-6)}`;

  await ensureAuthenticatedSession(page, baseURL);
  await page.goto(`${baseURL}/vehicle-availability`, { waitUntil: 'domcontentloaded' });

  if (!page.url().includes('/vehicle-availability')) {
    await page.goto(`${baseURL}/vehicle-availability`, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.getByText(/Vehicle Availability Chart/i)).toBeVisible();

  // First create succeeds.
  await page.getByRole('button', { name: /^\+ Add Vehicle$/i }).click();
  const vehicleModal1 = page.locator('div[role="dialog"], .fixed').filter({
    has: page.getByText(/Add New Vehicle/i),
  }).first();
  await expect(vehicleModal1.getByText(/Add New Vehicle/i)).toBeVisible();

  const vendorSelect1 = vehicleModal1.locator('select').nth(0);
  const branchSelect1 = vehicleModal1.locator('select').nth(1);
  const typeSelect1 = vehicleModal1.locator('select').nth(2);

  const vendorValue = await pickVendorWithDependencies(vendorSelect1, branchSelect1, typeSelect1);
  await selectFirstOption(branchSelect1);
  await selectFirstOption(typeSelect1);

  await fillVehicleRequiredFields(vehicleModal1, registrationNo);

  const firstDupCheckResp = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'GET' &&
      /\/api\/v1\/vehicle-availability\/check-vehicle-duplication(\?|$)/.test(resp.url()),
    { timeout: 60000 },
  );

  const firstCreateResp = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'POST' &&
      /\/api\/v1\/vehicle-availability\/vehicles(\?|$)/.test(resp.url()),
    { timeout: 60000 },
  );

  await vehicleModal1.getByRole('button', { name: /^Save$/i }).click();

  const dupResp1 = await firstDupCheckResp;
  const dupBody1 = await dupResp1.json().catch(() => ({}));
  expect(dupResp1.ok()).toBeTruthy();
  expect(dupBody1?.success).toBeTruthy();

  const createResp1 = await firstCreateResp;
  if (!createResp1.ok()) {
    const body = await createResp1.text().catch(() => '');
    throw new Error(`First create failed unexpectedly: status=${createResp1.status()} body=${body}`);
  }

  await expect(vehicleModal1).toBeHidden({ timeout: 20000 });

  // Second create with same registration should fail at duplication check and not call create endpoint.
  await page.getByRole('button', { name: /^\+ Add Vehicle$/i }).click();
  const vehicleModal2 = page.locator('div[role="dialog"], .fixed').filter({
    has: page.getByText(/Add New Vehicle/i),
  }).first();
  await expect(vehicleModal2.getByText(/Add New Vehicle/i)).toBeVisible();

  const vendorSelect2 = vehicleModal2.locator('select').nth(0);
  const branchSelect2 = vehicleModal2.locator('select').nth(1);
  const typeSelect2 = vehicleModal2.locator('select').nth(2);

  await vendorSelect2.selectOption(vendorValue);
  await waitForOptionCount(branchSelect2, 2, 8000);
  await waitForOptionCount(typeSelect2, 2, 8000);
  await selectFirstOption(branchSelect2);
  await selectFirstOption(typeSelect2);

  await fillVehicleRequiredFields(vehicleModal2, registrationNo);

  let createAttemptCount = 0;
  const onRequest = (req: any) => {
    if (req.method() === 'POST' && /\/api\/v1\/vehicle-availability\/vehicles(\?|$)/.test(req.url())) {
      createAttemptCount += 1;
    }
  };
  page.on('request', onRequest);

  const secondDupCheckResp = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'GET' &&
      /\/api\/v1\/vehicle-availability\/check-vehicle-duplication(\?|$)/.test(resp.url()),
    { timeout: 60000 },
  );

  await vehicleModal2.getByRole('button', { name: /^Save$/i }).click();

  const dupResp2 = await secondDupCheckResp;
  const dupBody2 = await dupResp2.json().catch(() => ({}));
  expect(dupResp2.ok()).toBeTruthy();
  expect(dupBody2?.success).toBeFalsy();

  await expect(vehicleModal2.getByText('Vehicle registration number already exists for this vendor.')).toBeVisible();

  await page.waitForTimeout(1200);
  page.off('request', onRequest);
  expect(createAttemptCount).toBe(0);
});
