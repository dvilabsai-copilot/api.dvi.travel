import { test, expect, type Page } from '@playwright/test';

const BASE_URL     = process.env.E2E_BASE_URL       ?? 'http://localhost:8081';
const ADMIN_EMAIL  = process.env.E2E_VENDOR_USER     ?? 'admin@dvi.co.in';
const ADMIN_PWD    = process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';

// Use guide id=42 (Anjaly) which is visible in the screenshots
const GUIDE_ID = process.env.E2E_GUIDE_ID ?? '42';

test.use({ launchOptions: { slowMo: 200 } });
test.describe.configure({ mode: 'serial' });

async function login(page: Page) {
  const heading = page.getByRole('heading', { name: /sign\s*in/i }).first();
  if ((await heading.count()) === 0) return;

  await page.getByRole('textbox').first().fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').first().fill(ADMIN_PWD);
  await page.getByRole('button', { name: /sign\s*in/i }).first().click();
  await page.waitForLoadState('networkidle');
}

test.describe('Guide Pricebook – save and display', () => {
  test('entering prices and clicking Update saves values and shows them in the read-only table', async ({ page }) => {
    // ── 1. Navigate to Step 2 (Pricebook) for the test guide
    await page.goto(`${BASE_URL}/guide/${GUIDE_ID}/edit`);
    await page.waitForLoadState('networkidle');
    await login(page);
    // Always re-navigate after login (SPA may redirect to dashboard)
    await page.goto(`${BASE_URL}/guide/${GUIDE_ID}/edit`);
    await page.waitForLoadState('networkidle');
    // Wait until the Guide Basic Info step content is visible
    await expect(page.getByText('Guide Basic Info', { exact: false }).first()).toBeVisible({ timeout: 15000 });

    // Step 2 stepper tab – scoped to the tab bar to avoid matching the sidebar 'Pricebook Export' nav item
    await page.locator('div.border-b button').filter({ hasText: /pricebook/i }).first().click();
    await page.waitForTimeout(500);

    // ── 2. Set date range: 2026-04-01 → 2026-04-30
    const startInput = page.locator('input[type="date"]').nth(0);
    const endInput   = page.locator('input[type="date"]').nth(1);

    await startInput.fill('2026-04-01');
    await endInput.fill('2026-04-30');
    await page.waitForTimeout(800); // let the display table load

    // ── 3. Verify read-only table is now visible (date range selected)
    await expect(page.getByText('Current Price Schedule')).toBeVisible({ timeout: 8000 });

    // wait for the table to render (even with No Price cells)
    const tableFirstRow = page.locator('table').last().locator('tbody tr').first();
    await expect(tableFirstRow).toBeVisible({ timeout: 8000 });

    // ── 4. Enter prices in all 9 input fields
    const priceValues: Record<string, string> = {
      pax1_slot1: '111',
      pax1_slot2: '222',
      pax1_slot3: '333',
      pax2_slot1: '444',
      pax2_slot2: '555',
      pax2_slot3: '666',
      pax3_slot1: '777',
      pax3_slot2: '888',
      pax3_slot3: '999',
    };

    // Price inputs are plain <Input> elements with placeholder "Enter Price"
    const priceInputs = page.locator('input[placeholder="Enter Price"]');
    await expect(priceInputs).toHaveCount(9, { timeout: 5000 });

    // Row order: pax1-slot1, pax1-slot2, pax1-slot3 | pax2-... | pax3-...
    const orderedValues = Object.values(priceValues);
    for (let i = 0; i < orderedValues.length; i++) {
      await priceInputs.nth(i).fill('');
      await priceInputs.nth(i).fill(orderedValues[i]);
    }

    // ── 5. Register listeners BEFORE clicking so we don't miss fast responses
    const patchWaiter = page.waitForResponse(
      (r) => r.url().includes(`/guides/${GUIDE_ID}/pricebook`) && r.request().method() === 'PATCH',
      { timeout: 15000 }
    );
    // GET refresh fires synchronously after PATCH resolves – register now
    const getRefreshWaiter = page.waitForResponse(
      (r) => r.url().includes(`/guides/${GUIDE_ID}/pricebook`) && r.request().method() === 'GET',
      { timeout: 15000 }
    );

    await page.getByRole('button', { name: /^update$/i }).first().click();
    const patchResponse = await patchWaiter;

    expect(patchResponse.status(), 'PATCH /pricebook should return 2xx').toBeLessThan(300);

    // ── 6. Wait for GET fetch to refresh display table
    await getRefreshWaiter;

    // ── 7. Success toast should appear
    await expect(page.getByText(/price book details updated successfully/i)).toBeVisible({ timeout: 8000 });

    // ── 8. Price inputs should be cleared after save (PHP parity)
    for (let i = 0; i < 9; i++) {
      await expect(priceInputs.nth(i)).toHaveValue('');
    }

    // ── 9. The display table should now show the saved prices
    // We expect to find ₹ 111.00 for 1-5 Pax / 9AM-1PM in at least one column
    const displayTable = page.locator('table').last();

    await expect(displayTable.getByText('₹ 111.00').first()).toBeVisible({ timeout: 8000 });
    await expect(displayTable.getByText('₹ 222.00').first()).toBeVisible({ timeout: 5000 });
    await expect(displayTable.getByText('₹ 999.00').first()).toBeVisible({ timeout: 5000 });

    // Also verify pax labels and slot labels are in the table
    await expect(displayTable.getByText('1-5 Pax').first()).toBeVisible();
    await expect(displayTable.getByText('6-14 Pax').first()).toBeVisible();
    await expect(displayTable.getByText('15-40 Pax').first()).toBeVisible();
    await expect(displayTable.getByText('9AM-1PM').first()).toBeVisible();
    await expect(displayTable.getByText('6PM-9PM').first()).toBeVisible();

    // ── 10. Set a second date range with different prices to test update
    await startInput.fill('2026-05-01');
    await endInput.fill('2026-05-15');
    await page.waitForTimeout(800);

    // table should refresh (No Price for new unset range)
    await expect(page.getByText('Current Price Schedule')).toBeVisible({ timeout: 5000 });
  });

  test('table is hidden on page load with no dates selected', async ({ page }) => {
    await page.goto(`${BASE_URL}/guide/${GUIDE_ID}/edit`);
    await page.waitForLoadState('networkidle');
    await login(page);
    await page.goto(`${BASE_URL}/guide/${GUIDE_ID}/edit`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Guide Basic Info', { exact: false }).first()).toBeVisible({ timeout: 15000 });

    await page.locator('div.border-b button').filter({ hasText: /pricebook/i }).first().click();
    await page.waitForTimeout(500);

    // Date inputs should be empty
    const startInput = page.locator('input[type="date"]').nth(0);
    const endInput   = page.locator('input[type="date"]').nth(1);
    await expect(startInput).toHaveValue('');
    await expect(endInput).toHaveValue('');

    // "Current Price Schedule" heading should NOT be visible until dates are selected
    const scheduleHeader = page.getByText('Current Price Schedule');
    await expect(scheduleHeader).not.toBeVisible();

    // Fill dates → table appears
    await startInput.fill('2026-06-01');
    await endInput.fill('2026-06-30');
    await page.waitForTimeout(800);
    await expect(scheduleHeader).toBeVisible({ timeout: 8000 });
  });
});
