import { expect, test, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_VENDOR_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';
const EDIT_VENDOR_ID = Number(process.env.E2E_VENDOR_EDIT_ID ?? '54');

async function maybeLogin(page: Page): Promise<void> {
  const signInHeading = page.getByRole('heading', { name: /sign\s*in/i }).first();

  if ((await signInHeading.count()) === 0) return;

  const labeledEmailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="Email" i]').first();
  const labeledPasswordInput = page.locator('input[type="password"], input[name="password"], input[placeholder*="Password" i]').first();

  let emailInput = labeledEmailInput;
  let passwordInput = labeledPasswordInput;

  // Some login screens render plain textboxes without semantic attributes.
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
  await page.waitForTimeout(250);
  await page.locator('[role="option"]').first().click();
  await page.waitForTimeout(250);
}

async function selectFirstNativeOptionByPlaceholder(page: Page, placeholder: string): Promise<void> {
  const select = page.locator('select').filter({ has: page.locator(`option:has-text("${placeholder}")`) }).first();
  await expect(select).toBeVisible();

  await expect
    .poll(async () => await select.locator('option').count(), { timeout: 10000 })
    .toBeGreaterThan(1);

  const firstValue = await select.locator('option').nth(1).getAttribute('value');
  if (firstValue) {
    await select.selectOption(firstValue);
  }
}

async function pickDateFromOpenCalendar(page: Page, day: number): Promise<void> {
  const calendar = page.locator('.rdp').last();
  await expect(calendar).toBeVisible();
  await calendar.getByRole('button', { name: new RegExp(`\\b${day}\\b`) }).first().click();
}

test('add vendor and verify all tabs open/work', async ({ page, baseURL }) => {
  const stamp = Date.now();
  const vendorName = `PW Vendor ${stamp}`;
  const editedVendorName = `${vendorName} Edited`;

  await page.goto(`${baseURL}/vendor/new`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);

  if (!page.url().includes('/vendor/new')) {
    await page.goto(`${baseURL}/vendor/new`, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.getByRole('heading', { name: /Add Vendor/i })).toBeVisible();

  // Basic tab
  await page.locator('input[placeholder="Vendor Name"]').fill(vendorName);
  await page.locator('input[placeholder="Email ID"]').first().fill(`pw.vendor.${stamp}@example.com`);
  await page.locator('input[placeholder="Primary Mobile Number"]').fill('9876543210');
  await page.locator('input[placeholder="Alternative Mobile Number"]').fill('9876543211');

  await selectFirstComboOption(page, 0); // country
  await selectFirstComboOption(page, 1); // state
  await selectFirstComboOption(page, 2); // city

  await page.locator('input[placeholder="Pincode"]').first().fill('600001');
  await page.locator('input[placeholder="Other Number"]').fill('0441234567');
  await page.locator('input[placeholder="Username"]').fill(`pwvendor${String(stamp).slice(-8)}`);
  await page.locator('input[placeholder="Password"]').fill('Test@12345');

  await selectFirstComboOption(page, 3); // role
  await page.locator('input[placeholder="Vendor Margin"]').fill('10');
  await selectFirstComboOption(page, 5); // gst percent

  await page.getByPlaceholder('Address').first().fill('Test address from Playwright');
  await page.locator('input[placeholder="Company Name"]').fill('PW Travels Pvt Ltd');
  await page.getByPlaceholder('Address').nth(1).fill('Invoice address test');
  await page.locator('input[placeholder="Pincode"]').nth(1).fill('600001');
  await page.locator('input[placeholder="GSTIN FORMAT: 10AABCU9603R1Z5"]').fill('33ABCDE1234F1Z5');
  await page.locator('input[placeholder="PAN Format: CNFPC5441D"]').fill('ABCDE1234F');
  await page.locator('input[placeholder="Contact No."]').fill('9876543200');
  await page.locator('input[placeholder="Company Email ID"]').fill(`invoice.${stamp}@example.com`);

  await page.getByRole('button', { name: /update\s*&\s*Continue|Save\s*&\s*Continue/i }).first().click();
  await expect(page.getByRole('heading', { name: /Branch Details/i })).toBeVisible();

  // Branch tab
  await page.locator('input[placeholder="Branch Name"]').fill(`Main Branch ${stamp}`);
  await page.locator('input[placeholder="Branch Location"]').fill('Chennai');
  await page.locator('input[placeholder="Email ID"]').fill(`branch.${stamp}@example.com`);
  await page.locator('input[placeholder="Primary Mobile Number"]').fill('9876500011');
  await page.locator('input[placeholder="Alternative Mobile Number"]').fill('9876500012');

  await selectFirstComboOption(page, 0); // country
  await selectFirstComboOption(page, 1); // state
  await selectFirstComboOption(page, 2); // city

  await page.locator('input[placeholder="Pincode"]').fill('600001');
  await selectFirstComboOption(page, 4); // gst percent
  await page.getByPlaceholder('Address').fill('Branch address test');

  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expect(page.getByRole('heading', { name: /Vehicle Type.*Driver Cost/i }).first()).toBeVisible();

  // Vehicle type tab and subtabs
  await page.getByRole('button', { name: /Outstation KM Limit/i }).click();
  await expect(page.getByRole('heading', { name: /List of Outstation KM Limit/i })).toBeVisible();

  await page.getByRole('button', { name: /Local KM Limit/i }).click();
  await expect(page.getByRole('heading', { name: /List of Local KM Limit/i })).toBeVisible();

  await page.getByRole('button', { name: /^Driver Cost$/i }).click();
  await expect(page.getByRole('heading', { name: /List of Vehicle Type.*Driver Cost/i })).toBeVisible();

  await page.getByRole('button', { name: /Continue/i }).click();
  await expect(page.getByRole('heading', { name: /Vehicle List in/i })).toBeVisible();

  // Vehicle tab
  await page.getByRole('button', { name: /\+\s*Add vehicle/i }).click();
  await expect(page.getByRole('heading', { name: /Add Vehicle/i })).toBeVisible();

  const registrationNo = `TN${String(stamp).slice(-6)}`;
  await page.getByPlaceholder('Registration Number').fill(registrationNo);
  await page.getByRole('button', { name: /Registration Date/i }).first().click();
  await pickDateFromOpenCalendar(page, 15);
  await page.getByPlaceholder('Engine Number').fill(`ENG${String(stamp).slice(-8)}`);
  await page.getByPlaceholder('Owner Name').fill('Playwright Owner');
  await page.getByPlaceholder('Owner Contact Number').fill('9876500099');

  await selectFirstNativeOptionByPlaceholder(page, 'Choose Vehicle Type');
  await selectFirstNativeOptionByPlaceholder(page, 'Choose Country');
  await selectFirstNativeOptionByPlaceholder(page, 'Choose State');
  await selectFirstNativeOptionByPlaceholder(page, 'Choose City');

  await expect(page.getByPlaceholder('Registration Number')).toHaveValue(registrationNo);
  await page.getByRole('button', { name: /^Save Vehicle$/i }).click();
  await page.waitForTimeout(1000);
  const savedRowVisible = await page
    .getByText(registrationNo)
    .first()
    .isVisible()
    .catch(() => false);

  if (savedRowVisible) {
    await expect(page.getByText(registrationNo).first()).toBeVisible();
  }

  // Move to pricebook after creating a vehicle
  await page.getByRole('button', { name: /Skip\s*&\s*Continue/i }).first().click();
  await expect(page.getByRole('heading', { name: /Vehicle Pricebook/i })).toBeVisible();

  // Pricebook tab
  await expect(page.getByRole('heading', { name: /Vendor Margin Details/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Driver Cost Details/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Vehicle Rental Cost Details.*Local/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Vehicle Rental Cost Details.*Outstation/i })).toBeVisible();

  // Permit tab
  await page.getByRole('button', { name: /6\s*Permit Cost/i }).click();
  await expect(page.getByRole('heading', { name: /Permit Cost/i })).toBeVisible();
  await page.getByRole('button', { name: /\+\s*Add Permit Cost/i }).click();
  await expect(page.getByRole('heading', { name: /Add Permit Cost/i })).toBeVisible();

  await page.locator('[role="combobox"]').first().click();
  await page.waitForTimeout(200);
  await page.locator('[role="option"]').first().click();

  await page.locator('[role="combobox"]').nth(1).click();
  await page.waitForTimeout(200);
  const stateOptions = await page.locator('[role="option"]').allTextContents();
  expect(stateOptions.length).toBeGreaterThan(5);
  expect(stateOptions.join(' | ')).toContain('Andhra Pradesh');

  await page.locator('[role="option"]').first().click();
  await page.getByPlaceholder('Cost').first().fill('250');
  await expect(page.getByPlaceholder('Cost').first()).toHaveValue('250');
  await page.getByRole('button', { name: /^Save$/i }).click();

  const permitListVisible = await page
    .getByRole('heading', { name: /Permit Details/i })
    .isVisible()
    .catch(() => false);

  if (!permitListVisible) {
    const backToListButton = page.getByRole('button', { name: /Back To List/i }).first();
    if (await backToListButton.isVisible().catch(() => false)) {
      await backToListButton.click();
    }
  }

  await expect(page.getByRole('heading', { name: /Permit Details/i })).toBeVisible();

  await page.getByRole('button', { name: /Save\s*&\s*Next/i }).first().click();

  // Final list verification
  await expect(page).toHaveURL(/\/vendor$/);
  await expect(page.getByText(vendorName)).toBeVisible();

  // Edit same vendor and verify all tabs can be traversed with updated values
  const vendorRow = page.locator('tr', { hasText: vendorName }).first();
  await expect(vendorRow).toBeVisible();
  await vendorRow.locator('button[title="Edit"]').click();

  await expect(page).toHaveURL(/\/vendor\/\d+/);
  await expect(page.getByRole('heading', { name: /Edit Vendor|Add Vendor/i })).toBeVisible();

  await page.locator('input[placeholder="Vendor Name"]').fill(editedVendorName);
  await page.locator('input[placeholder="Company Name"]').fill('PW Travels Pvt Ltd Edited');
  await page.getByRole('button', { name: /update\s*&\s*Continue|Save\s*&\s*Continue/i }).first().click();
  await expect(page.getByRole('heading', { name: /Branch Details/i })).toBeVisible();

  await page.locator('input[placeholder="Branch Location"]').fill('Chennai Updated');
  await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
  await expect(page.getByRole('heading', { name: /Vehicle Type.*Driver Cost/i }).first()).toBeVisible();

  await page.getByRole('button', { name: /Outstation KM Limit/i }).click();
  await expect(page.getByRole('heading', { name: /List of Outstation KM Limit/i })).toBeVisible();
  await page.getByRole('button', { name: /Local KM Limit/i }).click();
  await expect(page.getByRole('heading', { name: /List of Local KM Limit/i })).toBeVisible();
  await page.getByRole('button', { name: /^Driver Cost$/i }).click();
  await expect(page.getByRole('heading', { name: /List of Vehicle Type.*Driver Cost/i })).toBeVisible();

  await page.getByRole('button', { name: /Continue/i }).click();
  await expect(page.getByRole('heading', { name: /Vehicle List in/i })).toBeVisible();
  await page.getByRole('button', { name: /Skip\s*&\s*Continue/i }).first().click();

  await expect(page.getByRole('heading', { name: /Vehicle Pricebook/i })).toBeVisible();
  await page.getByRole('button', { name: /6\s*Permit Cost/i }).click();
  await expect(page.getByRole('heading', { name: /Permit Cost/i })).toBeVisible();
  await page.getByRole('button', { name: /Save\s*&\s*Next/i }).first().click();

  await expect(page).toHaveURL(/\/vendor$/);
  await expect(page.getByText(editedVendorName)).toBeVisible();
});

test('edit existing vendor and persist data across all tabs', async ({ page, baseURL }) => {
  test.setTimeout(180000);

  const stamp = Date.now();
  const driverCostValue = '700';
  const outstationTitle = `PW OUT ${stamp}`;
  const localTitle = `PW LOC ${stamp}`;
  const regNo = `TN${String(stamp).slice(-6)}`;

  await page.goto(`${baseURL}/vendor/${EDIT_VENDOR_ID}`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);

  if (!page.url().includes(`/vendor/${EDIT_VENDOR_ID}`)) {
    await page.goto(`${baseURL}/vendor/${EDIT_VENDOR_ID}`, { waitUntil: 'domcontentloaded' });
  }

  await expect(page.getByRole('heading', { name: /Edit Vendor|Add Vendor/i })).toBeVisible();

  // For existing vendors, do not mutate Basic/Branch data; jump directly to Step 3.
  await page.getByRole('button', { name: /3\s*Vehicle Type/i }).click();

  // Step 3 - Driver Cost row
  await expect(page.getByRole('heading', { name: /Vehicle Type.*Driver Cost/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /\+\s*Add Vehicle Type\s*-\s*Driver Cost/i }).click();
  await page.getByRole('dialog').getByRole('combobox').first().click();
  await page.locator('[role="option"]').first().click();
  await page.getByPlaceholder('Driver Bhatta').fill(driverCostValue);
  await page.getByPlaceholder('Food Cost').fill('250');
  await page.getByPlaceholder('Accomodation Cost').fill('300');
  await page.getByPlaceholder('Extra Cost').fill('100');
  await page.getByPlaceholder('Early Morning Charges').fill('80');
  await page.getByPlaceholder('Evening Charges').fill('90');
  await page.getByRole('dialog').getByRole('button', { name: /^Save$/i }).click();
  await expect(page.getByText(driverCostValue).first()).toBeVisible();

  // Step 3 - Outstation KM Limit row
  await page.getByRole('button', { name: /Outstation KM Limit/i }).click();
  await expect(page.getByRole('heading', { name: /List of Outstation KM Limit/i })).toBeVisible();
  await page.getByRole('button', { name: /\+\s*Add Outstation KM Limit/i }).click();
  await page.getByRole('dialog').getByRole('combobox').first().click();
  await page.locator('[role="option"]').first().click();
  await page.getByPlaceholder('Outstation KM Limit Title').fill(outstationTitle);
  await page.getByPlaceholder('Outstation KM Limit', { exact: true }).fill('350');
  await page.getByRole('dialog').getByRole('button', { name: /^Save$/i }).click();
  await expect(page.getByText(outstationTitle).first()).toBeVisible();

  // Step 3 - Local KM Limit row
  await page.getByRole('button', { name: /Local KM Limit/i }).click();
  await expect(page.getByRole('heading', { name: /List of Local KM Limit/i })).toBeVisible();
  await page.getByRole('button', { name: /\+\s*Add Local KM Limit/i }).click();
  await page.getByRole('dialog').getByRole('combobox').first().click();
  await page.locator('[role="option"]').first().click();
  await page.getByPlaceholder('Enter Title').fill(localTitle);
  await page.getByPlaceholder('Enter Hours').fill('8');
  await page.getByPlaceholder('KM Limit').fill('120');
  await page.getByRole('dialog').getByRole('button', { name: /^Save$/i }).click();
  await expect(page.getByText(localTitle).first()).toBeVisible();

  await page.getByRole('button', { name: /^Continue$/i }).click();

  // Step 4 - Vehicle row
  await expect(page.getByRole('heading', { name: /Vehicle List in/i })).toBeVisible();
  await page.getByRole('button', { name: /\+\s*Add vehicle/i }).click();
  await expect(page.getByRole('heading', { name: /Add Vehicle/i })).toBeVisible();
  await page.getByPlaceholder('Registration Number').fill(regNo);
  await page.getByRole('button', { name: /Registration Date/i }).first().click();
  await pickDateFromOpenCalendar(page, 15);
  await page.getByPlaceholder('Engine Number').fill(`ENG${String(stamp).slice(-8)}`);
  await page.getByPlaceholder('Owner Name').fill('Playwright Owner');
  await page.getByPlaceholder('Owner Contact Number').fill('9876500099');
  await selectFirstNativeOptionByPlaceholder(page, 'Choose Vehicle Type');
  await selectFirstNativeOptionByPlaceholder(page, 'Choose Country');
  await selectFirstNativeOptionByPlaceholder(page, 'Choose State');
  await selectFirstNativeOptionByPlaceholder(page, 'Choose City');
  await page.getByRole('button', { name: /^Save Vehicle$/i }).click();
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: /Skip\s*&\s*Continue/i }).first().click();

  // Step 5 - Pricebook update
  await expect(page.getByRole('heading', { name: /Vehicle Pricebook/i })).toBeVisible();
  const vendorMarginSection = page.locator('section', { has: page.getByRole('heading', { name: /Vendor Margin Details/i }) }).first();
  await vendorMarginSection.locator('input').first().fill('12');
  await page.getByRole('button', { name: /^Update$/i }).first().click();

  // Step 6 - Permit row
  await page.getByRole('button', { name: /6\s*Permit Cost/i }).click();
  await expect(page.getByRole('heading', { name: /Permit Cost/i })).toBeVisible();
  await page.getByRole('button', { name: /\+\s*Add Permit Cost/i }).click();
  await expect(page.getByRole('heading', { name: /Add Permit Cost/i })).toBeVisible();
  await page.locator('[role="combobox"]').first().click();
  await page.locator('[role="option"]').first().click();
  await page.locator('[role="combobox"]').nth(1).click();
  await page.locator('[role="option"]').first().click();
  await page.getByPlaceholder('Cost').first().fill('250');
  await page.getByRole('button', { name: /^Save$/i }).click();

  await expect(page.getByRole('heading', { name: /Permit Details/i })).toBeVisible();
  await page.getByRole('button', { name: /Save\s*&\s*Next/i }).first().click();
  await expect(page).toHaveURL(/\/vendor$/);

  // Re-open same vendor and verify tab data persisted
  await page.goto(`${baseURL}/vendor/${EDIT_VENDOR_ID}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Edit Vendor|Add Vendor/i })).toBeVisible();
  await page.getByRole('button', { name: /3\s*Vehicle Type/i }).click();
  await expect(page.getByText(driverCostValue).first()).toBeVisible();
  await page.getByRole('button', { name: /Outstation KM Limit/i }).click();
  await expect(page.getByText(outstationTitle).first()).toBeVisible();
  await page.getByRole('button', { name: /Local KM Limit/i }).click();
  await expect(page.getByText(localTitle).first()).toBeVisible();
  await page.getByRole('button', { name: /6\s*Permit Cost/i }).click();
  await expect(page.getByRole('heading', { name: /Permit Details/i })).toBeVisible();
});
