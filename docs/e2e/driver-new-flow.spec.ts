import { expect, test, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_VENDOR_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';

async function maybeLogin(page: Page): Promise<void> {
  const signInHeading = page.getByRole('heading', { name: /sign\s*in/i }).first();

  if ((await signInHeading.count()) === 0) return;

  const labeledEmailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="Email" i]').first();
  const labeledPasswordInput = page.locator('input[type="password"], input[name="password"], input[placeholder*="Password" i]').first();

  let emailInput = labeledEmailInput;
  let passwordInput = labeledPasswordInput;

  if ((await labeledEmailInput.count()) === 0 || (await labeledPasswordInput.count()) === 0) {
    const textboxes = page.getByRole('textbox');
    const textboxCount = await textboxes.count();
    if (textboxCount < 2) return;
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

async function selectFirstComboOption(page: Page, comboIndex: number): Promise<void> {
  const combo = page.locator('[role="combobox"]').nth(comboIndex);
  await combo.click();
  await page.waitForTimeout(200);
  await page.locator('[role="option"]').first().click();
  await page.waitForTimeout(200);
}

async function ensureComboHasSelection(page: Page, comboIndex: number, placeholderText: RegExp): Promise<void> {
  const combo = page.locator('[role="combobox"]').nth(comboIndex);
  const current = (await combo.textContent())?.trim() ?? '';
  if (!current || placeholderText.test(current)) {
    await selectFirstComboOption(page, comboIndex);
  }
}

async function openFirstDriverInEdit(page: Page, baseURL: string | undefined): Promise<void> {
  await page.goto(`${baseURL}/driver`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);

  if (!page.url().includes('/driver')) {
    await page.goto(`${baseURL}/driver`, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.getByText(/List of Drivers|Drivers/i).first()).toBeVisible();
  const noDrivers = await page.getByText('No drivers found.').isVisible().catch(() => false);
  test.skip(noDrivers, 'Requires at least one existing driver record to run edit-tab validations.');

  await page.locator('button[title="Edit"]').first().click();
  await expect(page).toHaveURL(/\/driver\/\d+\/edit/);
  await expect(page.getByText(/Edit Driver|Add Driver/i).first()).toBeVisible();
}

test('driver basic tab required-field validation on add page', async ({ page, baseURL }) => {
  test.setTimeout(120000);

  const stamp = Date.now();
  const driverName = `PW Driver ${stamp}`;

  await page.goto(`${baseURL}/driver/new`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);

  if (!page.url().includes('/driver/new')) {
    await page.goto(`${baseURL}/driver/new`, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.getByText(/Add Driver/i).first()).toBeVisible();

  // Basic Info validation
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expect(page.getByText('Choose Vendor is required')).toBeVisible();
  await expect(page.getByText('Choose Vehicle Type is required')).toBeVisible();
  await expect(page.getByText('Driver Name is required')).toBeVisible();
  await expect(page.getByText('Primary Mobile Number is required')).toBeVisible();

  // Basic Info fill (minimum required fields)
  await ensureComboHasSelection(page, 0, /choose\s+vendor/i);
  await ensureComboHasSelection(page, 1, /choose\s+vehicle\s+type/i);

  await page.getByPlaceholder('Driver Name').fill(driverName);
  await page.getByPlaceholder('Primary Mobile Number').fill(`9${String(stamp).slice(-9)}`);

  await expect(page.getByRole('button', { name: /Save\s*&\s*Continue/i })).toBeVisible();
});

test('driver edit flow validates and fills all remaining tabs', async ({ page, baseURL }) => {
  test.setTimeout(180000);

  const stamp = Date.now();
  const feedbackText = `Playwright feedback ${stamp}`;

  await openFirstDriverInEdit(page, baseURL);

  // Step 2: Cost Details
  await page.getByRole('button', { name: /2\s*Cost Details/i }).click();
  await expect(page.getByPlaceholder('Driver Salary')).toBeVisible();

  await page.getByPlaceholder('Driver Salary').fill('1200');
  await page.getByPlaceholder('Food Cost').fill('250');
  await page.getByPlaceholder('Accommodation Cost').fill('400');
  await page.getByPlaceholder('Bhatta Cost').fill('300');
  await page.getByPlaceholder('Early Morning Charges').fill('150');
  await page.getByPlaceholder('Evening Charges').fill('200');

  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();

  // Step 3: Upload Documents validation + save
  await page.getByRole('button', { name: /3\s*Upload Document/i }).click();
  await expect(page.getByText(/Upload Documents/i).first()).toBeVisible();
  await page.getByRole('button', { name: /^\+\s*Upload$/i }).click();
  await expect(page.getByRole('heading', { name: /Document Upload/i })).toBeVisible();

  await page.getByRole('button', { name: /^Save$/i }).click();
  await expect(page.getByText('Document Type is required')).toBeVisible();
  await expect(page.getByText('Upload Document is required')).toBeVisible();

  await selectFirstComboOption(page, 0); // doc type inside modal
  await page.locator('input[type="file"]').last().setInputFiles({
    name: 'driver-document.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await page.getByRole('button', { name: /^Save$/i }).click();

  await expect(page.getByText('View').first()).toBeVisible();
  await page.getByRole('button', { name: /Skip\s*&\s*Continue/i }).click();

  // Step 4: Feedback & Review validation + save
  await page.getByRole('button', { name: /4\s*Feedback\s*&\s*Review/i }).click();
  await expect(page.getByText(/List of Reviews/i)).toBeVisible();
  await page.getByRole('button', { name: /^Save$/i }).first().click();
  await expect(page.getByText('Feedback is required')).toBeVisible();

  await page.getByRole('button', { name: 'Rate 4' }).click();
  await page.locator('textarea').first().fill(feedbackText);
  await page.getByRole('button', { name: /^Save$/i }).first().click();

  await expect(page.getByText(feedbackText).first()).toBeVisible();
  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();

  // Step 5: Preview verification and finish
  await page.getByRole('button', { name: /5\s*Preview/i }).click();
  await expect(page.getByText('Basic Info').first()).toBeVisible();
  await expect(page.getByText('Cost Details').first()).toBeVisible();
  await expect(page.getByText('Documents').first()).toBeVisible();
  await expect(page.getByText('Feedback & Reviews').first()).toBeVisible();

  await page.getByRole('button', { name: /^Finish$/i }).click();
  await expect(page).toHaveURL(/\/driver$/);
});

test('driver create flow fills required fields, finishes, and verifies list search', async ({ page, baseURL }) => {
  test.setTimeout(240000);

  const stamp = Date.now();
  const driverName = `PW Prod Driver ${stamp}`;
  const driverMobile = `9${String(stamp).slice(-9)}`;

  await page.goto(`${baseURL}/driver/new`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);

  if (!page.url().includes('/driver/new')) {
    await page.goto(`${baseURL}/driver/new`, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.getByText(/Add Driver/i).first()).toBeVisible();

  // Step 1: Basic Info (required fields)
  await ensureComboHasSelection(page, 0, /choose\s+vendor/i);
  await ensureComboHasSelection(page, 1, /choose\s+vehicle\s+type/i);
  await page.getByPlaceholder('Driver Name').fill(driverName);
  await page.getByPlaceholder('Primary Mobile Number').fill(driverMobile);
  await page.getByPlaceholder('License Number Format: CH03 78678555785').fill(`CH03 ${String(stamp).slice(-11)}`);
  const createBasicResponsePromise = page.waitForResponse(
    (resp) => resp.request().method() === 'POST' && /\/drivers(\?|$)/.test(resp.url()),
    { timeout: 60000 }
  );
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  const createBasicResponse = await createBasicResponsePromise.catch(() => null);
  if (createBasicResponse && !createBasicResponse.ok()) {
    const responseBody = await createBasicResponse.text().catch(() => '');
    throw new Error(
      `Basic save failed on POST /drivers. status=${createBasicResponse.status()} body=${responseBody}`
    );
  }
  await page.waitForLoadState('networkidle');

  const costStepTab = page.getByRole('button', { name: /2\s*Cost Details/i });
  await expect(costStepTab).not.toBeDisabled({ timeout: 60000 });
  await costStepTab.click();

  // Step 2: Cost Details (required fields)
  await expect(page.getByPlaceholder('Driver Salary')).toBeVisible({ timeout: 60000 });
  await page.getByPlaceholder('Driver Salary').fill('1200');
  await page.getByPlaceholder('Food Cost').fill('250');
  await page.getByPlaceholder('Accommodation Cost').fill('400');
  await page.getByPlaceholder('Bhatta Cost').fill('300');
  await page.getByPlaceholder('Early Morning Charges').fill('150');
  await page.getByPlaceholder('Evening Charges').fill('200');
  await page.getByRole('button', { name: /Save\s*&\s*Continue|Update\s*&\s*Continue/i }).click();

  // Step 3: Upload Documents (skip when optional)
  await expect(page.getByText(/Upload Document|Upload Documents/i).first()).toBeVisible();
  await page.getByRole('button', { name: /Skip\s*&\s*Continue/i }).click();

  // Step 4: Feedback & Review
  await expect(page.getByText(/List of Reviews/i)).toBeVisible();
  await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  const feedbackRequired = await page.getByText('Feedback is required').isVisible().catch(() => false);
  if (feedbackRequired) {
    const feedbackText = `Playwright create feedback ${stamp}`;
    await page.getByRole('button', { name: 'Rate 4' }).click();
    await page.locator('textarea').first().fill(feedbackText);
    await page.getByRole('button', { name: /^Save$/i }).first().click();
    await expect(page.getByText(feedbackText).first()).toBeVisible();
    await page.getByRole('button', { name: /Update\s*&\s*Continue/i }).click();
  }

  // Step 5: Preview + finish
  await expect(page.getByText('Basic Info').first()).toBeVisible();
  await page.getByRole('button', { name: /^Finish$/i }).click();
  await expect(page).toHaveURL(/\/driver$/);

  // Verify new driver appears in list search
  const searchInput = page
    .getByText(/^Search:$/i)
    .locator('xpath=..')
    .getByRole('textbox')
    .first();
  await expect(searchInput).toBeVisible();
  await searchInput.fill(driverName);
  await expect(page.getByRole('cell', { name: driverName }).first()).toBeVisible();
});
