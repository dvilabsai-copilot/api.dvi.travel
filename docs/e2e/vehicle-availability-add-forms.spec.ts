import { expect, test, type Locator, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_VENDOR_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';

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

async function selectFirstOption(selectEl: Locator): Promise<void> {
  await expect
    .poll(async () => await selectEl.locator('option').count(), { timeout: 15000 })
    .toBeGreaterThan(1);

  const optionCount = await selectEl.locator('option').count();
  let pickedValue: string | null = null;

  for (let i = 0; i < optionCount; i += 1) {
    const opt = selectEl.locator('option').nth(i);
    const value = (await opt.getAttribute('value')) ?? '';
    const label = ((await opt.textContent()) ?? '').trim();

    const isPlaceholder = /^choose\b/i.test(label) || /^select\b/i.test(label) || !label;
    if (value && !isPlaceholder) {
      pickedValue = value;
      break;
    }
  }

  if (!pickedValue) {
    throw new Error('Could not resolve a non-placeholder option value');
  }
  await selectEl.selectOption(pickedValue);
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

test('vehicle availability add forms: validate and submit add driver/add vehicle', async ({ page, baseURL }) => {
  test.setTimeout(240000);

  const stamp = Date.now();
  const driverName = `PW VA Driver ${stamp}`;
  const driverMobile = `9${String(stamp).slice(-9)}`;
  const registrationNo = `TN${String(stamp).slice(-6)}`;

  await page.goto(`${baseURL}/vehicle-availability`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);

  if (!page.url().includes('/vehicle-availability')) {
    await page.goto(`${baseURL}/vehicle-availability`, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.getByText(/Vehicle Availability Chart/i)).toBeVisible();

  // -------------------------
  // Add Driver modal
  // -------------------------
  await page.getByRole('button', { name: /^\+ Add Driver$/i }).click();

  const driverModal = page.locator('div[role="dialog"], .fixed').filter({
    has: page.getByText(/Add New Driver/i),
  }).first();

  await expect(driverModal.getByText(/Add New Driver/i)).toBeVisible();

  await driverModal.getByRole('button', { name: /^Save$/i }).click();
  await expect(driverModal.getByText('Please choose Vendor.')).toBeVisible();

  const driverVendorSelect = driverModal.locator('select').nth(0);
  const driverTypeSelect = driverModal.locator('select').nth(1);

  await selectFirstOption(driverVendorSelect);
  await selectFirstOption(driverTypeSelect);

  await driverModal.getByPlaceholder('Driver Name').fill(driverName);
  await driverModal.getByPlaceholder('Primary Mobile Number').fill(driverMobile);

  const createDriverResp = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'POST' &&
      /\/api\/v1\/vehicle-availability\/drivers(\?|$)/.test(resp.url()),
    { timeout: 60000 },
  );

  await driverModal.getByRole('button', { name: /^Save$/i }).click();

  const driverResp = await createDriverResp;
  if (!driverResp.ok()) {
    const body = await driverResp.text().catch(() => '');
    throw new Error(`Add Driver failed: status=${driverResp.status()} body=${body}`);
  }

  await expect(driverModal).toBeHidden({ timeout: 15000 });

  // -------------------------
  // Add Vehicle modal
  // -------------------------
  await page.getByRole('button', { name: /^\+ Add Vehicle$/i }).click();

  const vehicleModal = page.locator('div[role="dialog"], .fixed').filter({
    has: page.getByText(/Add New Vehicle/i),
  }).first();

  await expect(vehicleModal.getByText(/Add New Vehicle/i)).toBeVisible();

  await vehicleModal.getByRole('button', { name: /^Save$/i }).click();
  await expect(vehicleModal.getByText('Please choose Vendor.')).toBeVisible();

  const vehicleVendorSelect = vehicleModal.locator('select').nth(0);
  const branchSelect = vehicleModal.locator('select').nth(1);
  const typeSelect = vehicleModal.locator('select').nth(2);

  const vendorOptionCount = await vehicleVendorSelect.locator('option').count();
  let vendorWithDepsSelected = false;
  for (let i = 0; i < vendorOptionCount; i += 1) {
    const opt = vehicleVendorSelect.locator('option').nth(i);
    const value = (await opt.getAttribute('value')) ?? '';
    const label = ((await opt.textContent()) ?? '').trim();
    const isPlaceholder = /^choose\b/i.test(label) || /^select\b/i.test(label) || !label;
    if (!value || isPlaceholder) continue;

    await vehicleVendorSelect.selectOption(value);

    const hasBranches = await waitForOptionCount(branchSelect, 2, 8000);
    const hasTypes = await waitForOptionCount(typeSelect, 2, 8000);
    if (hasBranches && hasTypes) {
      vendorWithDepsSelected = true;
      break;
    }
  }

  if (!vendorWithDepsSelected) {
    throw new Error('No vendor found with branch + vehicle type options in Add Vehicle modal');
  }

  await selectFirstOption(branchSelect);
  await selectFirstOption(typeSelect);

  await vehicleModal.getByPlaceholder('Registration Number').fill(registrationNo);
  await vehicleModal.getByPlaceholder('Search city / origin…').fill('Chennai');

  const dateInputs = vehicleModal.locator('input[type="date"]');
  await dateInputs.nth(0).fill('2027-12-31');
  await dateInputs.nth(1).fill('2026-01-01');
  await dateInputs.nth(2).fill('2027-12-31');

  const createVehicleResp = page.waitForResponse(
    (resp) =>
      resp.request().method() === 'POST' &&
      /\/api\/v1\/vehicle-availability\/vehicles(\?|$)/.test(resp.url()),
    { timeout: 60000 },
  );

  await vehicleModal.getByRole('button', { name: /^Save$/i }).click();

  const vehicleResp = await createVehicleResp;
  if (!vehicleResp.ok()) {
    const body = await vehicleResp.text().catch(() => '');
    throw new Error(`Add Vehicle failed: status=${vehicleResp.status()} body=${body}`);
  }

  await expect(vehicleModal).toBeHidden({ timeout: 15000 });

  // Smoke check chart still visible after both creates.
  await expect(page.getByText(/Vehicle Availability Chart/i)).toBeVisible();
});
