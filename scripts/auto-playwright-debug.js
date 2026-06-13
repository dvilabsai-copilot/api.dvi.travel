const { chromium } = require('playwright');

(async () => {
  const LOGIN_EMAIL = 'admin@dvi.co.in';
  const LOGIN_PASSWORD = 'Keerthi@2404ias';
  const TARGET_URL = 'http://localhost:8080/itinerary-details/DVI20260660';
  const API_URL = 'http://localhost:4006/api/v1/itineraries/hotel_details/DVI20260321';

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  async function firstVisible(selectors, timeoutMs) {
    for (const selector of selectors) {
      const el = page.locator(selector).first();
      try {
        if (await el.isVisible({ timeout: timeoutMs })) {
          return el;
        }
      } catch (_) {
        // try next selector
      }
    }
    return null;
  }

  async function autoLoginIfNeeded() {
    const emailInput = await firstVisible(
      [
        'input[type="email"]',
        'input[name="email"]',
        'input[id="email"]',
        'input[name="username"]',
        'input[placeholder*="email" i]',
      ],
      2500,
    );

    const passwordInput = await firstVisible(
      [
        'input[type="password"]',
        'input[name="password"]',
        'input[id="password"]',
        'input[placeholder*="password" i]',
      ],
      2500,
    );

    if (!emailInput || !passwordInput) {
      console.log('LOGIN: form not detected, continuing without login step');
      return;
    }

    console.log('LOGIN: form detected, submitting credentials');
    await emailInput.fill(LOGIN_EMAIL);
    await passwordInput.fill(LOGIN_PASSWORD);

    const submitButton = await firstVisible(
      [
        'button[type="submit"]',
        'button:has-text("Login")',
        'button:has-text("Log In")',
        'button:has-text("Sign in")',
        'button:has-text("Sign In")',
        'input[type="submit"]',
      ],
      1500,
    );

    if (submitButton) {
      await submitButton.click();
    } else {
      await passwordInput.press('Enter');
    }

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    console.log('LOGIN: submitted');
  }

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/itineraries/hotel_details')) {
      console.log('===== FRONTEND REQUEST =====');
      console.log('METHOD:', request.method());
      console.log('URL:', url);
      console.log('');
    }
  });

  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/v1/itineraries/hotel_details')) {
      console.log('===== FRONTEND RESPONSE =====');
      console.log('STATUS:', response.status());
      console.log('URL:', url);
      console.log('');
    }
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/itineraries/hotel_details')) {
      console.log('===== FRONTEND RESPONSE =====');
      console.log('STATUS: FAILED');
      console.log('URL:', url);
      console.log('REASON:', request.failure() ? request.failure().errorText : 'Unknown');
      console.log('');
    }
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await autoLoginIfNeeded();
  try {
    await page.evaluate(async (apiUrl) => {
      try {
        await fetch(apiUrl, { method: 'GET', credentials: 'include' });
      } catch (_) {
        // ignore browser fetch errors; listeners still log request/response failures
      }
    }, API_URL);
  } catch (_) {
    // page may close if app redirects/navigation happens during automation
  }

  await page.waitForTimeout(5000);
  await page.reload();
  try {
    await page.evaluate(async (apiUrl) => {
      try {
        await fetch(apiUrl, { method: 'GET', credentials: 'include' });
      } catch (_) {
        // ignore browser fetch errors; listeners still log request/response failures
      }
    }, API_URL);
  } catch (_) {
    // page may close if app redirects/navigation happens during automation
  }
  await page.waitForTimeout(10000);

  await browser.close();
})();
