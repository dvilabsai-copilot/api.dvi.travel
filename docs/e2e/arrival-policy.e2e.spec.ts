import { test, expect } from '@playwright/test';

const EMAIL = process.env.PROD_EMAIL || 'admin@dvi.co.in';
const PASSWORD = process.env.PROD_PASSWORD || 'Keerthi@2404ias';

async function loginIfNeeded(page: import('@playwright/test').Page) {
  await page.goto('/create-itinerary?id=259', { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) {
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByRole('textbox').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    await page.goto('/create-itinerary?id=259', { waitUntil: 'domcontentloaded' });
  }
}

async function setCreateStartTimeAndSave(page: import('@playwright/test').Page, startTime: string) {
  const startTimeInput = page.locator('label:has-text("Start Time")').locator('xpath=following::input[@type="time"][1]');
  await expect(startTimeInput).toBeVisible();
  await startTimeInput.fill(startTime);

  await page.getByRole('button', { name: 'Save & Continue' }).click();
}

test.describe('Arrival Policy E2E', () => {
  test('Create itinerary: 06:00 shows confirmation modal and NO continues same-day flow', async ({ page }) => {
    await loginIfNeeded(page);

    await setCreateStartTimeAndSave(page, '06:00');

    const policyModalTitle = page.getByText('Previous-Day Hotel Billing Confirmation');
    await expect(policyModalTitle).toBeVisible();

    await page.getByRole('button', { name: 'No, keep same-day booking' }).click();

    await expect(policyModalTitle).not.toBeVisible();
    await expect(page.getByText('Optimize route for')).toBeVisible();
  });

  test('Create itinerary: 10:00 should not show confirmation modal', async ({ page }) => {
    await loginIfNeeded(page);

    await setCreateStartTimeAndSave(page, '10:00');

    await expect(page.getByText('Previous-Day Hotel Billing Confirmation')).not.toBeVisible();
    await expect(page.getByText('Optimize route for')).toBeVisible();
  });

  test('Details page: 13:30 no modal; 06:30 opens modal', async ({ page }) => {
    await page.goto('/itinerary-details/DVI202604230', { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/login')) {
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await page.getByRole('textbox').first().fill(EMAIL);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => !url.pathname.includes('/login'));
      await page.goto('/itinerary-details/DVI202604230', { waitUntil: 'domcontentloaded' });
    }

    await page.getByRole('button', { name: /Confirm Quotation/i }).click();

    const arrivalInput = page.getByPlaceholder('12-12-2025 9:00 AM').first();
    await expect(arrivalInput).toBeVisible();

    const currentArrival = (await arrivalInput.inputValue()).trim();
    const datePrefix = (currentArrival.match(/^(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/) || [])[1] || '15-04-2026';

    await arrivalInput.fill(`${datePrefix} 1:30 PM`);
    await expect(page.getByText('Previous-Day Hotel Billing Confirmation')).not.toBeVisible();

    await arrivalInput.fill(`${datePrefix} 6:30 AM`);
    await expect(page.getByText('Previous-Day Hotel Billing Confirmation')).toBeVisible();
  });
});
