import { expect, test, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_AGENT_USER ?? 'demo@dvi.co.in';
const USER_PASSWORD = process.env.E2E_AGENT_PASSWORD ?? 'Agent@12345';
const TOPUP_AMOUNT = process.env.E2E_RAZORPAY_TOPUP_AMOUNT ?? '1';

async function maybeLogin(page: Page): Promise<void> {
  const signInHeading = page.getByRole('heading', { name: /sign\s*in/i }).first();

  if ((await signInHeading.count()) === 0) return;

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"]').first();

  await emailInput.fill(USER_EMAIL);
  await passwordInput.fill(USER_PASSWORD);

  await page.getByRole('button', { name: /sign\s*in|login|log\s*in/i }).first().click();
  await page.waitForLoadState('networkidle');
}

async function completeRazorpaySandboxPayment(page: Page): Promise<void> {
  // Razorpay checkout renders inside an iframe overlay.
  const checkoutFrame = page.frameLocator('iframe[src*="razorpay.com"]');
  await expect(page.locator('iframe[src*="razorpay.com"]').first()).toBeVisible({ timeout: 30000 });

  const cardTab = checkoutFrame.getByText(/card/i).first();
  if (await cardTab.isVisible().catch(() => false)) {
    await cardTab.click();
  }

  const cardNumber = checkoutFrame
    .locator('input[name="card[number]"], input[autocomplete="cc-number"], input[placeholder*="Card number" i]')
    .first();
  await cardNumber.fill('4111 1111 1111 1111');

  const expiry = checkoutFrame
    .locator('input[name="card[expiry]"], input[autocomplete="cc-exp"], input[placeholder*="MM" i]')
    .first();
  await expiry.fill('12/30');

  const cvv = checkoutFrame
    .locator('input[name="card[cvv]"], input[autocomplete="cc-csc"], input[placeholder*="CVV" i]')
    .first();
  await cvv.fill('123');

  const holder = checkoutFrame
    .locator('input[name="card[name]"], input[placeholder*="name on card" i]')
    .first();
  if (await holder.isVisible().catch(() => false)) {
    await holder.fill('Playwright Agent');
  }

  await checkoutFrame
    .getByRole('button', { name: /pay|proceed|submit/i })
    .first()
    .click();

  // Some test flows ask for OTP in the same frame.
  const otpInput = checkoutFrame
    .locator('input[type="tel"], input[name="otp"], input[placeholder*="otp" i]')
    .first();
  if (await otpInput.isVisible().catch(() => false)) {
    await otpInput.fill('111111');
    await checkoutFrame.getByRole('button', { name: /submit|verify|continue/i }).first().click();
  }
}

test.describe('Razorpay sandbox local e2e', () => {
  test.setTimeout(240000);

  test('wallet top-up checkout and confirmation', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/wallet-history`, { waitUntil: 'domcontentloaded' });
    await maybeLogin(page);

    if (!page.url().includes('/wallet-history')) {
      await page.goto(`${baseURL}/wallet-history`, { waitUntil: 'domcontentloaded' });
    }

    await expect(page.getByRole('button', { name: /add cash wallet/i }).first()).toBeVisible();
    await page.getByRole('button', { name: /add cash wallet/i }).first().click();

    await page.locator('input#cash-topup-amount').fill(TOPUP_AMOUNT);

    const createOrderPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('/payments/razorpay/wallet-topup/create-order'),
      { timeout: 30000 },
    );

    await page.getByRole('button', { name: /^pay now$/i }).last().click();
    await createOrderPromise;

    await completeRazorpaySandboxPayment(page);

    await page.waitForURL(/\/payments\/success\?flow=wallet_topup/, { timeout: 120000 });
    await expect(page.getByText(/payment successful/i).first()).toBeVisible();
  });

  test('subscription renewal checkout and confirmation', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/subscription-history`, { waitUntil: 'domcontentloaded' });
    await maybeLogin(page);

    if (!page.url().includes('/subscription-history')) {
      await page.goto(`${baseURL}/subscription-history`, { waitUntil: 'domcontentloaded' });
    }

    const renewButton = page.getByRole('button', { name: /renew subscription/i }).first();
    await expect(renewButton).toBeVisible();

    const createOrderPromise = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes('/payments/razorpay/subscription-renewal/create-order'),
      { timeout: 30000 },
    );

    await renewButton.click();
    await createOrderPromise;

    await completeRazorpaySandboxPayment(page);

    await page.waitForURL(/\/payments\/success\?flow=subscription_renewal/, { timeout: 120000 });
    await expect(page.getByText(/payment successful/i).first()).toBeVisible();
  });
});
