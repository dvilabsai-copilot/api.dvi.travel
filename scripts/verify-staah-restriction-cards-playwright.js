const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOGIN_EMAIL = 'admin@dvi.co.in';
const LOGIN_PASSWORD = 'Keerthi@2404ias';
const FRONTEND_BASE = 'http://localhost:8080';
const API_BASE = 'http://127.0.0.1:4006/api/v1';
const HEADLESS = String(process.env.HEADLESS || 'true').trim().toLowerCase() !== 'false';

const DEFAULT_QUOTES = [
  'DVI202606111',
  'DVI202606112',
  'DVI202606113',
  'DVI202606114',
  'DVI202606115',
  'DVI202606116',
];
const QUOTES = String(process.env.QUOTES || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const ACTIVE_QUOTES = QUOTES.length > 0 ? QUOTES : DEFAULT_QUOTES;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function firstVisible(page, selectors, timeoutMs) {
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

async function autoLoginIfNeeded(page) {
  const labeledEmailInput = page.getByLabel(/email/i).first();
  const labeledPasswordInput = page.getByLabel(/password/i).first();
  let emailInput = null;
  let passwordInput = null;

  try {
    if (await labeledEmailInput.isVisible({ timeout: 2500 })) {
      emailInput = labeledEmailInput;
    }
  } catch (_) {
    // fall through
  }

  try {
    if (await labeledPasswordInput.isVisible({ timeout: 2500 })) {
      passwordInput = labeledPasswordInput;
    }
  } catch (_) {
    // fall through
  }

  if (!emailInput) {
    emailInput = await firstVisible(
      page,
      [
        'input[type="email"]',
        'input[name="email"]',
        'input[id="email"]',
        'input[name="username"]',
        'input[placeholder*="email" i]',
      ],
      2500,
    );
  }

  if (!passwordInput) {
    passwordInput = await firstVisible(
      page,
      [
        'input[type="password"]',
        'input[name="password"]',
        'input[id="password"]',
        'input[placeholder*="password" i]',
      ],
      2500,
    );
  }

  if (!emailInput) {
    const textboxes = page.locator('input:not([type="hidden"]):not([type="password"])');
    if ((await textboxes.count()) > 0) {
      emailInput = textboxes.first();
    }
  }

  if (!passwordInput) {
    const passwords = page.locator('input[type="password"]');
    if ((await passwords.count()) > 0) {
      passwordInput = passwords.first();
    }
  }

  if (!emailInput || !passwordInput) {
    return false;
  }

  await emailInput.fill(LOGIN_EMAIL);
  await passwordInput.fill(LOGIN_PASSWORD);

  const submitButton = await firstVisible(
    page,
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

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return true;
}

async function fetchToken() {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: LOGIN_EMAIL,
      password: LOGIN_PASSWORD,
    }),
  });
  const json = await response.json().catch(() => ({}));
  const token = json.accessToken || json.token || json.data?.accessToken || json.data?.token || '';
  if (!token) {
    throw new Error(`Unable to login via API. status=${response.status}`);
  }
  return token;
}

async function fetchHotelDetails(token, quoteId) {
  const response = await fetch(`${API_BASE}/itineraries/hotel_details/${quoteId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`hotel_details failed for ${quoteId}. status=${response.status}`);
  }
  return json;
}

async function ensureQuotePageLoaded(page, quoteId) {
  await page.goto(`${FRONTEND_BASE}/itinerary-details/${quoteId}`, { waitUntil: 'domcontentloaded' });
  const loggedIn = await autoLoginIfNeeded(page);
  if (loggedIn) {
    await page.goto(`${FRONTEND_BASE}/itinerary-details/${quoteId}`, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.locator(`text=${quoteId}`).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function expandHotelListRow(page, restrictedHotel) {
  const dayLabel = String(restrictedHotel.day || '').trim() || 'Day 1';
  const row = page.locator('tbody tr').filter({ hasText: dayLabel }).first();
  await row.waitFor({ state: 'visible', timeout: 15000 });
  await row.click();
  await page.waitForTimeout(2500);
}

async function clickRecommendedTabIfNeeded(page, restrictedHotel) {
  const targetGroupType = Number(restrictedHotel.groupType || 0);
  if (!targetGroupType || targetGroupType === 1) {
    return;
  }

  const tab = page.getByText(new RegExp(`Recommended\\s*#${targetGroupType}\\b`, 'i')).first();
  if (await tab.count()) {
    await tab.click();
    await page.waitForTimeout(1500);
  }
}

async function assertRestrictedCard(page, restrictedHotel, quoteId) {
  const hotelName = String(restrictedHotel.hotelName || '').trim();
  const message = String(restrictedHotel.availabilityMessage || '').trim();

  await clickRecommendedTabIfNeeded(page, restrictedHotel);

  const heading = page.getByRole('heading', { name: new RegExp(escapeRegex(hotelName), 'i') }).first();
  await heading.waitFor({ state: 'visible', timeout: 15000 });

  const card = heading.locator('xpath=ancestor::div[contains(@class,"bg-white") and contains(@class,"rounded-lg")][1]');

  await card.getByText(/Restricted/i).first().waitFor({ state: 'visible', timeout: 10000 });

  const restrictedButton = card.getByRole('button', { name: /^Restricted$/i }).first();
  await restrictedButton.waitFor({ state: 'visible', timeout: 10000 });
  const disabled = await restrictedButton.isDisabled();
  if (!disabled) {
    throw new Error(`${quoteId}: restricted button is not disabled for ${hotelName}`);
  }

  if (message) {
    const shortMessage = message.length > 80 ? message.slice(0, 80) : message;
    await card.getByText(new RegExp(escapeRegex(shortMessage), 'i')).first().waitFor({ state: 'visible', timeout: 10000 }).catch(async () => {
      await card.getByText(new RegExp(escapeRegex(message.split('.')[0]), 'i')).first().waitFor({ state: 'visible', timeout: 10000 });
    });
  }
}

async function assertNoRestrictedCards(page, quoteId) {
  await page.waitForTimeout(1500);
  const restrictedButtons = page.getByRole('button', { name: /^Restricted$/i });
  const count = await restrictedButtons.count();
  if (count > 0) {
    throw new Error(`${quoteId}: expected no restricted cards, but found ${count}`);
  }
}

async function run() {
  const token = await fetchToken();
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const outputDir = path.join(process.cwd(), 'playwright-artifacts', 'staah-restrictions');
  fs.mkdirSync(outputDir, { recursive: true });

  const results = [];

  try {
    for (const quoteId of ACTIVE_QUOTES) {
      const details = await fetchHotelDetails(token, quoteId);
      const restrictedHotels = Array.isArray(details.restrictedHotels) ? details.restrictedHotels : [];
      const result = {
        quoteId,
        restrictedHotelCount: restrictedHotels.length,
        status: 'passed',
        notes: [],
      };

      try {
        await ensureQuotePageLoaded(page, quoteId);

        if (restrictedHotels.length === 0) {
          await assertNoRestrictedCards(page, quoteId);
          result.notes.push('No restricted hotels expected; none shown in UI.');
        } else {
          for (const restrictedHotel of restrictedHotels) {
            await expandHotelListRow(page, restrictedHotel);
            await assertRestrictedCard(page, restrictedHotel, quoteId);
          }
          result.notes.push(`Verified ${restrictedHotels.length} restricted card(s) with disabled action.`);
        }
      } catch (error) {
        result.status = 'failed';
        result.notes.push(error instanceof Error ? error.message : String(error));
        result.notes.push(`URL: ${page.url()}`);
        const screenshotPath = path.join(outputDir, `${quoteId}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        result.notes.push(`Screenshot: ${screenshotPath}`);
      }

      results.push(result);
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => result.status !== 'passed');
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[verify-staah-restriction-cards-playwright] failed:', error);
  process.exit(1);
});
