const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:8080';
const API_BASE = 'http://127.0.0.1:4006/api/v1';
const LOGIN_EMAIL = 'admin@dvi.co.in';
const LOGIN_PASSWORD = 'Keerthi@2404ias';
const START_URL = `${BASE_URL}/itinerary-details/DVI20260660`;

async function loginAndGetToken() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed: ${res.status} ${text}`);
  }

  const payload = await res.json();
  const token =
    payload?.accessToken ||
    payload?.token ||
    payload?.data?.accessToken ||
    payload?.data?.token ||
    '';

  if (!token) {
    throw new Error('No token returned from login');
  }

  return token;
}

async function firstVisible(page, selectors, timeoutMs = 3000) {
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    try {
      if (await el.isVisible({ timeout: timeoutMs })) return el;
    } catch (_) {}
  }
  return null;
}

async function ensureLoggedIn(page) {
  const emailInput = await firstVisible(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[name="username"]',
  ]);

  if (!emailInput) return;

  const passwordInput = await firstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="password" i]',
  ]);

  if (!passwordInput) return;

  await emailInput.fill(LOGIN_EMAIL);
  await passwordInput.fill(LOGIN_PASSWORD);
  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
  ]);
  if (submit) await submit.click();
  else await passwordInput.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

(async () => {
  const token = await loginAndGetToken();
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  await page.addInitScript((authToken) => {
    localStorage.setItem('accessToken', authToken);
  }, token);

  const interesting = [
    '/api/v1/itineraries/details/',
    '/api/v1/itineraries/',
    '/vehicle-build-status',
    '/vehicle-build-sync',
    '/permit-build-sync',
    '/auth/login',
  ];

  page.on('request', (request) => {
    const url = request.url();
    if (interesting.some((part) => url.includes(part))) {
      console.log('[REQ]', request.method(), url);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (interesting.some((part) => url.includes(part))) {
      console.log('[RES]', response.status(), url);
    }
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    if (interesting.some((part) => url.includes(part))) {
      console.log('[FAIL]', request.method(), url, request.failure()?.errorText || 'unknown');
    }
  });

  console.log('OPEN', START_URL);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn(page);
  await page.waitForTimeout(4000);

  console.log('STEP 1: click Back to List');
  const backBtn = page.getByRole('button', { name: /back to list/i }).first();
  await backBtn.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2500);

  console.log('URL AFTER BACK', page.url());

  console.log('STEP 2: wait for Save & Continue');
  const saveBtn = page.getByRole('button', { name: /save & continue/i }).first();
  await saveBtn.waitFor({ state: 'visible', timeout: 15000 });
  await saveBtn.click();
  await page.waitForTimeout(1000);

  console.log('STEP 3: click Proceed with same Route');
  const proceedBtn = page.getByRole('button', { name: /proceed with same route/i }).first();
  await proceedBtn.waitFor({ state: 'visible', timeout: 15000 });
  await proceedBtn.click();

  for (let i = 0; i < 30; i++) {
    const titleVisible = await page.locator('text=/Building itinerary details/i').isVisible().catch(() => false);
    const pageText = await page.locator('body').innerText().catch(() => '');
    console.log(`[TICK ${i}] url=${page.url()} loading=${titleVisible} hasDetail=${/Tour Itinerary Plan/i.test(pageText)} hasVehicleStatus=${/vehicle/i.test(pageText)}`);
    await page.waitForTimeout(2000);
  }

  await browser.close();
})();
