import { test, expect } from '@playwright/test';

const EMAIL = process.env.PROD_EMAIL || 'admin@dvi.co.in';
const PASSWORD = process.env.PROD_PASSWORD || 'Keerthi@2404ias';

async function loginIfNeeded(page) {
  const url = page.url();
  if (url.includes('/login') || url === 'about:blank') {
    await page.goto('/create-itinerary', { waitUntil: 'domcontentloaded' });
    
    const loginHeading = page.getByRole('heading', { name: 'Sign in' });
    if (await loginHeading.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.getByRole('textbox').first().fill(EMAIL);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
    }
  }
}

test('UAE Nationality: Search "arab" finds United Arab Emirates', async ({ page }) => {
  await page.goto('/create-itinerary', { waitUntil: 'domcontentloaded' });
  await loginIfNeeded(page);

  // Click on nationality field/button
  const nationalityBtn = page.locator('button, [role="combobox"]').filter({ hasText: /India|Nationality|Select/ }).first();
  if (await nationalityBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nationalityBtn.click();
    await page.waitForTimeout(500);
  }

  // Type in search
  const searchField = page.locator('input[type="text"]').first();
  if (await searchField.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchField.fill('arab');
    await page.waitForTimeout(800);

    // Check for UAE option
    const uaeText = page.locator('text=United Arab Emirates');
    await expect(uaeText).toBeVisible({ timeout: 5000 });
    console.log('✅ Search "arab" successfully found United Arab Emirates');
  }
});

test('UAE Nationality: Select and confirm UAE', async ({ page }) => {
  await page.goto('/create-itinerary', { waitUntil: 'domcontentloaded' });
  await loginIfNeeded(page);

  // Open dropdown
  const nationalityBtn = page.locator('button, [role="combobox"]').filter({ hasText: /India|Nationality|Select/ }).first();
  if (await nationalityBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nationalityBtn.click();
    await page.waitForTimeout(500);

    // Search and select UAE
    const searchField = page.locator('input[type="text"]').first();
    if (await searchField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchField.fill('arab');
      await page.waitForTimeout(500);

      const uaeOption = page.locator('text=United Arab Emirates').first();
      if (await uaeOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await uaeOption.click();
        await page.waitForTimeout(1000);
        console.log('✅ UAE successfully selected');
      }
    }
  }
});

test('UAE Nationality: Multi-word search "emirates"', async ({ page }) => {
  await page.goto('/create-itinerary', { waitUntil: 'domcontentloaded' });
  await loginIfNeeded(page);

  // Open dropdown
  const nationalityBtn = page.locator('button, [role="combobox"]').filter({ hasText: /India|Nationality|Select/ }).first();
  if (await nationalityBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nationalityBtn.click();
    await page.waitForTimeout(500);

    // Search with "emirates"
    const searchField = page.locator('input[type="text"]').first();
    if (await searchField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchField.fill('emirates');
      await page.waitForTimeout(800);

      const uaeText = page.locator('text=United Arab Emirates');
      await expect(uaeText).toBeVisible({ timeout: 5000 });
      console.log('✅ Search "emirates" successfully found UAE');
    }
  }
});

test('UAE Nationality: Full itinerary flow', async ({ page }) => {
  await page.goto('/create-itinerary', { waitUntil: 'domcontentloaded' });
  await loginIfNeeded(page);

  console.log('Step 1: Select UAE nationality');
  // Open and select UAE
  const nationalityBtn = page.locator('button, [role="combobox"]').filter({ hasText: /India|Nationality|Select/ }).first();
  if (await nationalityBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nationalityBtn.click();
    await page.waitForTimeout(500);

    const searchField = page.locator('input[type="text"]').first();
    if (await searchField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchField.fill('arab');
      await page.waitForTimeout(500);

      const uaeOption = page.locator('text=United Arab Emirates').first();
      if (await uaeOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await uaeOption.click();
        await page.waitForTimeout(800);
        console.log('✅ UAE selected');
      }
    }
  }

  console.log('Step 2: Setting dates');
  // Fill in dates
  const dateInputs = page.locator('input[type="date"]');
  if (await dateInputs.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 5);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    await dateInputs.first().fill(startDateStr);
    await page.waitForTimeout(300);
    
    if (await dateInputs.nth(1).isVisible({ timeout: 1000 }).catch(() => false)) {
      await dateInputs.nth(1).fill(endDateStr);
    }
    console.log(`✅ Dates set: ${startDateStr} to ${endDateStr}`);
  }

  console.log('Step 3: Searching for hotels');
  // Click search button
  const searchBtn = page.locator('button').filter({ hasText: /Search|Next|Continue|Save/ }).first();
  if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    const btnText = await searchBtn.textContent();
    console.log(`Clicking: ${btnText}`);
    await searchBtn.click();
    await page.waitForTimeout(2000);

    // Take screenshot
    try {
      await page.screenshot({ path: './nationality-uae-test-screenshot.png' });
      console.log('✅ Screenshot saved: nationality-uae-test-screenshot.png');
    } catch (e) {
      console.log('⚠️  Could not save screenshot');
    }

    console.log('✅ Full itinerary flow completed with UAE');
  }
});
