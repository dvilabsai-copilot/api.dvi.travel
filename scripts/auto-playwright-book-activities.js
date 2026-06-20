const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');

const LOGIN_EMAIL = 'admin@dvi.co.in';
const LOGIN_PASSWORD = 'Keerthi@2404ias';
const FRONTEND_URL = 'http://localhost:8080/book-activities';
const API_BASE_URL = 'http://localhost:4006/api/v1';
const HEADLESS = String(process.env.PW_HEADLESS || '').toLowerCase() === 'true';
const ARTIFACT_DIR = path.join(__dirname, '..', 'playwright-artifacts');

const BOOKING_TEST_DATA = {
  destination: 'Munnar',
  activitySearch: 'Adventure',
  activityType: 'Adventure',
  availableDate: '2026-06-30',
  unavailableDate: '2026-07-31',
  guestName: 'Playwright Test Guest',
  age: '30',
  phone: '9999999999',
  altPhone: '8888888888',
  email: 'playwright.test@example.com',
  nationality: 'IN',
  panNo: 'ABCDE1234F',
  passportNo: 'P1234567',
  guests: '1',
  remarks: 'Automated Playwright test booking',
};

const EXPECTED_ACTIVITY_ENDPOINTS = [
  '/api/v1/activities/storefront',
  '/api/v1/activities/storefront/categories',
  '/api/v1/activities/storefront/locations',
  '/api/v1/activities/storefront/agents',
  '/api/v1/activities/storefront/wishlist',
  '/api/v1/activities/storefront/bookings',
];

async function loginForToken() {
  const apiContext = await request.newContext();
  try {
    const loginRes = await apiContext.post(`${API_BASE_URL}/auth/login`, {
      data: { email: LOGIN_EMAIL, password: LOGIN_PASSWORD },
    });
    if (!loginRes.ok()) {
      const body = await loginRes.text().catch(() => '');
      throw new Error(`Auth login failed: status=${loginRes.status()} body=${body}`);
    }
    const json = await loginRes.json();
    const token = String(json?.accessToken || json?.token || '').trim();
    if (!token) {
      throw new Error('Auth login succeeded but accessToken missing');
    }
    return token;
  } finally {
    await apiContext.dispose();
  }
}

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function parseInr(text) {
  const cleaned = String(text || '').replace(/[^0-9.\\-]/g, '');
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function sanitizeFilename(input) {
  return String(input || 'artifact').replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-');
}

(async () => {
  ensureArtifactDir();

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  const failedRequests = [];
  const consoleErrors = [];
  const pageErrors = [];
  const activityResponses = [];
  const appBugs = [];
  let selectedAgentName = null;
  let screenshotPath = null;
  let loginSucceeded = false;
  let categoriesLoaded = false;
  let searchWorked = false;
  let modalOpened = false;
  let walletVisible = false;
  let passengerDetailsFilled = false;
  let confirmClicked = false;
  let bookingApiSucceeded = false;
  let wishlistWorked = false;
  let myBookingsWorked = false;
  let dateFilterWorked = false;
  let insufficientWalletReached = false;
  let bookingRequestStatus = null;
  let sidebarLoaded = false;

  function isIgnorableConsoleError(text) {
    return /favicon|chrome-extension|net::err_blocked_by_client/i.test(text);
  }

  async function firstVisible(selectors, timeoutMs = 2500) {
    for (const selector of selectors) {
      const el = page.locator(selector).first();
      try {
        if (await el.isVisible({ timeout: timeoutMs })) return el;
      } catch (_) {
        // try next selector
      }
    }
    return null;
  }

  async function waitForAnyVisible(selectors, label, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await firstVisible(selectors, 400);
      if (found) {
        console.log(`WAIT: ${label} visible`);
        return found;
      }
      await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function clickFirstVisible(selectors, label) {
    const target = await waitForAnyVisible(selectors, label);
    await target.click();
    console.log(`CLICK: ${label}`);
    return target;
  }

  async function fillFirstVisible(selectors, value, label) {
    const target = await waitForAnyVisible(selectors, label);
    await target.fill('');
    await target.fill(String(value));
    console.log(`FILL: ${label}`);
    return target;
  }

  async function selectFirstNonEmptyOption(selectors, label, preferredValue) {
    for (const selector of selectors) {
      const target = page.locator(selector).first();
      try {
        if (!(await target.isVisible({ timeout: 1200 }))) continue;
        const options = await target.locator('option').evaluateAll((nodes) =>
          nodes.map((node) => ({
            value: node.getAttribute('value') || '',
            text: (node.textContent || '').trim(),
          })),
        );
        const preferredOption =
          options.find((option) => option.value && option.value === preferredValue) ||
          options.find((option) => option.value && !/select/i.test(option.text));
        if (!preferredOption) continue;
        await target.selectOption(preferredOption.value);
        console.log(`SELECT: ${label} -> ${preferredOption.text}`);
        return preferredOption;
      } catch (_) {
        // try next selector
      }
    }

    for (const selector of selectors) {
      const target = page.locator(selector).first();
      try {
        if (!(await target.isVisible({ timeout: 1200 }))) continue;
        await target.click();
        const option = await firstVisible(
          [
            '[role="option"]:not(:has-text("Select"))',
            '.select__option',
            'li[role="option"]',
          ],
          2500,
        );
        if (!option) break;
        const text = (await option.textContent())?.trim() || 'option';
        await option.click();
        console.log(`SELECT: ${label} -> ${text}`);
        return { text, value: text };
      } catch (_) {
        // try next selector
      }
    }

    throw new Error(`No selectable option found for ${label}`);
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
      console.log('LOGIN: form not detected, checking route state');
      if (page.url().includes('/login')) {
        console.log('LOGIN: route is /login, using token fallback');
        const token = await loginForToken();
        await page.addInitScript((t) => {
          window.localStorage.setItem('accessToken', t);
        }, token);
        await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      }
      loginSucceeded = !page.url().includes('/login');
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
    await page.waitForTimeout(1500);
    loginSucceeded = !page.url().includes('/login');
    console.log(`LOGIN: submitted, success=${loginSucceeded}`);
  }

  async function selectActivityTypeFilter(labelText) {
    const selects = page.locator('.ba-search-panel select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const select = selects.nth(i);
      const options = await select.locator('option').allTextContents();
      if (options.some((text) => text.trim().toLowerCase() === labelText.toLowerCase())) {
        await select.selectOption({ label: labelText });
        console.log(`SELECT: activity type -> ${labelText}`);
        return;
      }
    }
    throw new Error(`Activity type filter not found for ${labelText}`);
  }

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/activities/storefront')) {
      console.log(`API REQUEST: ${request.method()} ${url}`);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/v1/activities/storefront')) {
      const item = {
        url,
        method: response.request().method(),
        status: response.status(),
      };
      activityResponses.push(item);
      console.log(`API RESPONSE: ${item.status} ${item.method} ${item.url}`);
      if (/\/activities\/storefront\/bookings$/i.test(url)) {
        bookingRequestStatus = item.status;
        bookingApiSucceeded = response.ok();
      }
    }
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure() ? request.failure().errorText : 'Unknown';
    console.log(`REQUEST FAILED: ${request.method()} ${url} -> ${failure}`);
    failedRequests.push({ url, method: request.method(), reason: failure });
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      console.log(`CONSOLE ERROR: ${text}`);
      if (!isIgnorableConsoleError(text)) {
        consoleErrors.push(text);
      }
    }
  });

  page.on('pageerror', (error) => {
    console.log(`PAGE ERROR: ${error.message}`);
    pageErrors.push(error.message);
  });

  async function pickAgentWithWallet() {
    const agentInput = page
      .locator('.ba-modal-section')
      .filter({ hasText: 'Agent Wallet' })
      .locator('.ba-agent-combobox input')
      .first();

    await agentInput.waitFor({ state: 'visible', timeout: 10000 });
    await agentInput.click();
    const firstAgentOption = page.locator('.ba-agent-option').first();
    await firstAgentOption.waitFor({ state: 'visible', timeout: 10000 });

    const firstAgentText = ((await firstAgentOption.textContent()) || '').trim();
    if (!/₹|rs\.?|inr/i.test(firstAgentText)) {
      throw new Error(`First agent option did not show wallet balance: ${firstAgentText}`);
    }

    const firstAgentName = (await firstAgentOption.locator('.ba-agent-option-name').textContent())?.trim() || '';
    if (!firstAgentName) {
      throw new Error('First searchable agent option did not expose an agent name');
    }

    await agentInput.fill(firstAgentName.slice(0, Math.min(4, firstAgentName.length)));
    console.log(`FILL: agent search -> ${firstAgentName}`);
    await firstAgentOption.waitFor({ state: 'visible', timeout: 10000 });
    await firstAgentOption.click();
    selectedAgentName = firstAgentName;
    console.log(`SELECT: agent dropdown -> ${firstAgentName}`);

    const walletCard = await waitForAnyVisible(
      ['text=Wallet Balance', '.ba-wallet-card'],
      'wallet balance card',
      5000,
    );
    walletVisible = !!walletCard;
    const walletText = ((await walletCard.textContent()) || '').trim();
    const afterBookingValue = parseInr(walletText.match(/After booking:\s*([^\n]+)/i)?.[1] || '');
    if (afterBookingValue < 0 && !/After booking:\s*₹?\s*0/i.test(walletText)) {
      insufficientWalletReached = true;
      throw new Error(`Highest wallet agent was still insufficient for booking: ${walletText}`);
    }
  }

  try {
    console.log(`NAVIGATE: ${FRONTEND_URL}`);
    await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
    await autoLoginIfNeeded();

    if (page.url().includes('/login')) {
      throw new Error('Login page remained visible after autoLoginIfNeeded');
    }

    await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const sidebar = await waitForAnyVisible(
      [
        'aside',
        'nav',
        'text=Confirmed Itinerary',
      ],
      'sidebar or main nav',
    );
    sidebarLoaded = !!sidebar;

    await waitForAnyVisible(['text=Book Activities'], 'Book Activities title');
    await waitForAnyVisible(['text=Discover. Book.'], 'Discover. Book. heading');
    await waitForAnyVisible(['text=Experience More!'], 'Experience More! heading');

    const signInButton = page.getByRole('button', { name: /sign in/i }).first();
    if (await signInButton.isVisible().catch(() => false)) {
      throw new Error('Unexpected Sign In button is visible on Book Activities admin page');
    }

    const layoutMetrics = await page.evaluate(() => {
      const pageEl = document.querySelector('.book-activities-page');
      const shellEl = document.querySelector('.book-activities-shell');
      const cardEl = document.querySelector('.ba-storefront-card');
      const contentAreaEl =
        pageEl?.parentElement ||
        document.querySelector('main.relative.flex-1.min-h-0.w-full > div') ||
        document.querySelector('main.relative.flex-1.min-h-0.w-full');
      const viewportWidth = window.innerWidth;
      const contentRect = contentAreaEl ? contentAreaEl.getBoundingClientRect() : null;
      const shellRect = shellEl ? shellEl.getBoundingClientRect() : null;
      const cardRect = cardEl ? cardEl.getBoundingClientRect() : null;
      const pageRect = pageEl ? pageEl.getBoundingClientRect() : null;
      return {
        viewportWidth,
        contentWidth: contentRect ? contentRect.width : 0,
        shellWidth: shellRect ? shellRect.width : 0,
        cardWidth: cardRect ? cardRect.width : 0,
        pageWidth: pageRect ? pageRect.width : 0,
      };
    });
    console.log('LAYOUT:', layoutMetrics);
    if (layoutMetrics.cardWidth && layoutMetrics.contentWidth) {
      const ratio = layoutMetrics.cardWidth / layoutMetrics.contentWidth;
      if (ratio < 0.95) {
        const bug = `Book Activities page appears too narrow inside admin content area: ratio=${ratio.toFixed(2)}`;
        appBugs.push(bug);
        console.log(`APP BUG: ${bug}`);
      }
    }

    const destinationInput = page.locator('.ba-location-combobox input[placeholder*="Search destination" i]').first();
    await destinationInput.waitFor({ state: 'visible', timeout: 10000 });
    await destinationInput.fill('');
    await destinationInput.fill(BOOKING_TEST_DATA.destination);
    console.log('FILL: destination filter');
    const destinationOption = page
      .locator('.ba-location-option')
      .filter({ hasText: BOOKING_TEST_DATA.destination })
      .first();
    await destinationOption.waitFor({ state: 'visible', timeout: 10000 });
    const destinationOptionText = ((await destinationOption.textContent()) || '').trim();
    if (destinationOptionText.includes('|')) {
      throw new Error(`Destination autosuggest still shows pipe-heavy text: ${destinationOptionText}`);
    }
    await destinationOption.click();
    console.log(`SELECT: destination option -> ${BOOKING_TEST_DATA.destination}`);
    await selectActivityTypeFilter(BOOKING_TEST_DATA.activityType);
    categoriesLoaded = true;

    const filterDateInput = page.locator('.ba-search-panel input[type="date"]').first();
    await filterDateInput.fill('');
    await clickFirstVisible(
      [
        'button:has-text("Search Activities")',
        'button:has-text("Search")',
      ],
      'Search Activities button',
    );
    searchWorked = true;

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const activityCardsWithoutDate = await page.locator('.ba-activity-card').count();
    console.log(`RESULT: activity cards without date = ${activityCardsWithoutDate}`);
    if (activityCardsWithoutDate < 1) {
      throw new Error('Expected at least one visible activity for destination/category search without date');
    }

    await filterDateInput.fill(BOOKING_TEST_DATA.availableDate);
    console.log(`FILL: availability date -> ${BOOKING_TEST_DATA.availableDate}`);
    await clickFirstVisible(
      [
        'button:has-text("Search Activities")',
        'button:has-text("Search")',
      ],
      'Search Activities button',
    );
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const filteredCardCount = await page.locator('.ba-activity-card').count();
    const pageText = await page.locator('body').innerText();
    const selectedDateEmptyVisible = pageText.includes('No activities are available for the selected date.');
    if (
      /Paragliding|Scuba Diving|Taj Mahal Tour|Jeep Safari\s*$|Kayaking/m.test(pageText) &&
      selectedDateEmptyVisible
    ) {
      throw new Error('Fallback sample activities appeared during selected-date empty state');
    }
    if (filteredCardCount === 0 && !selectedDateEmptyVisible) {
      throw new Error('Expected selected-date empty state when no activities were returned');
    }

    if (!selectedDateEmptyVisible && filteredCardCount > 0) {
      const cardTexts = await page.locator('.ba-activity-card').allInnerTexts();
      const invalidCard = cardTexts.find((text) => !/munnar/i.test(text));
      if (invalidCard) {
        throw new Error(`Non-Munnar activity appeared after selected-date search: ${invalidCard}`);
      }
    }
    console.log(
      `RESULT: selected-date filter -> emptyState=${selectedDateEmptyVisible} cards=${filteredCardCount}`,
    );
    dateFilterWorked = selectedDateEmptyVisible || filteredCardCount >= 0;

    await filterDateInput.fill('');
    await clickFirstVisible(
      [
        'button:has-text("Search Activities")',
        'button:has-text("Search")',
      ],
      'Search Activities button',
    );
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const activityCard = await waitForAnyVisible(
      [
        '.ba-activity-card',
        'article:has(button:has-text("Book Now"))',
        'button:has-text("Book Now")',
      ],
      'activity cards',
      15000,
    );
    if (!activityCard) {
      throw new Error('No visible activities were available to book');
    }

    const firstActivityCard = page.locator('.ba-activity-card').first();
    const firstWishlistButton = firstActivityCard.locator('.ba-wishlist').first();
    await firstWishlistButton.click();
    console.log('CLICK: wishlist heart');
    await waitForAnyVisible(['text=/added to wishlist|removed from wishlist/i', '[data-sonner-toast]'], 'wishlist toast', 10000);

    const wishlistCount = page.locator('.ba-header-count').first();
    await wishlistCount.waitFor({ state: 'visible', timeout: 10000 });
    const wishlistCountText = ((await wishlistCount.textContent()) || '').trim();
    if (!wishlistCountText || Number(wishlistCountText) < 1) {
      throw new Error(`Wishlist count did not increase as expected: ${wishlistCountText}`);
    }
    wishlistWorked = true;

    await clickFirstVisible(['button:has-text("Wishlist")'], 'Wishlist header button');
    await waitForAnyVisible(['text=Shortlisted activities ready for booking', '.ba-mini-card'], 'wishlist panel');
    const wishlistEmpty = await firstVisible(['text=No wishlist items yet'], 1500);
    if (wishlistEmpty) {
      await clickFirstVisible(['.ba-side-panel .ba-modal-close'], 'Wishlist close button');
      await firstWishlistButton.click();
      console.log('CLICK: wishlist heart again to re-add item');
      await waitForAnyVisible(['text=/added to wishlist|removed from wishlist/i', '[data-sonner-toast]'], 'wishlist toast', 10000);
      await clickFirstVisible(['button:has-text("Wishlist")'], 'Wishlist header button');
      await waitForAnyVisible(['.ba-mini-card'], 'wishlist item card', 10000);
    }
    const wishlistBookButton = page.locator('.ba-side-panel .ba-mini-card-actions .ba-confirm-button').first();
    await wishlistBookButton.waitFor({ state: 'visible', timeout: 10000 });
    await wishlistBookButton.click();
    console.log('CLICK: Wishlist Book Now');
    modalOpened = true;
    await waitForAnyVisible(
      [
        'text=Confirm Activity Booking',
        'text=Primary Passenger Details',
        'text=Agent Wallet',
      ],
      'booking modal',
      10000,
    );

    const passengerSection = page.locator('.ba-modal-section').filter({ hasText: 'Primary Passenger Details' });
    const travelSection = page.locator('.ba-modal-section').filter({ hasText: 'Travel Details' });

    await pickAgentWithWallet();

    await passengerSection.locator('select').first().selectOption('Mr');
    console.log('SELECT: salutation -> Mr');
    await passengerSection.locator('input[placeholder*="guest name" i]').fill(BOOKING_TEST_DATA.guestName);
    console.log('FILL: guest name');
    await passengerSection.locator('input[placeholder="Age"]').fill(BOOKING_TEST_DATA.age);
    console.log('FILL: age');
    await passengerSection.locator('input[placeholder*="Enter contact no" i]').fill(BOOKING_TEST_DATA.phone);
    console.log('FILL: primary contact');
    await passengerSection.locator('input[placeholder*="Alternative contact no" i]').fill(BOOKING_TEST_DATA.altPhone);
    console.log('FILL: alternative contact');
    await passengerSection.locator('input[placeholder*="Enter email" i]').fill(BOOKING_TEST_DATA.email);
    console.log('FILL: email');
    await passengerSection.locator('input[placeholder="IN"]').fill(BOOKING_TEST_DATA.nationality);
    console.log('FILL: nationality');
    await passengerSection.locator('input[placeholder="ABCDE1234F"]').fill(BOOKING_TEST_DATA.panNo);
    console.log('FILL: pan number');
    await passengerSection.locator('input[placeholder*="Passport no" i]').fill(BOOKING_TEST_DATA.passportNo);
    console.log('FILL: passport');
    await travelSection.locator('input[type="date"]').fill(tomorrowIso());
    console.log('FILL: activity date');
    await travelSection.locator('select').first().selectOption(BOOKING_TEST_DATA.guests);
    console.log(`SELECT: guest count -> ${BOOKING_TEST_DATA.guests}`);
    await travelSection.locator('input[placeholder*="Special request" i]').fill(BOOKING_TEST_DATA.remarks);
    console.log('FILL: remarks');
    passengerDetailsFilled = true;

    const confirmButton = await waitForAnyVisible(
      [
        'button:has-text("Confirm & Deduct")',
        'button:has-text("Confirming")',
      ],
      'Confirm & Deduct button',
    );
    const confirmText = ((await confirmButton.textContent()) || '').trim();
    if (!/Confirm\s*&\s*Deduct/i.test(confirmText) && !/Confirming/i.test(confirmText)) {
      throw new Error(`Unexpected confirm button text: ${confirmText}`);
    }

    const bookingResponsePromise = page.waitForResponse(
      (response) =>
        /\/api\/v1\/activities\/storefront\/bookings$/i.test(response.url()) &&
        response.request().method() === 'POST',
      { timeout: 20000 },
    );

    await confirmButton.click();
    confirmClicked = true;
    console.log('CLICK: Confirm & Deduct');

    const bookingResponse = await bookingResponsePromise;
    bookingRequestStatus = bookingResponse.status();
    bookingApiSucceeded = bookingResponse.ok();
    console.log(`BOOKING API: status=${bookingRequestStatus}`);

    if (!bookingResponse.ok()) {
      const responseText = await bookingResponse.text().catch(() => '');
      throw new Error(`Booking API failed: ${bookingResponse.status()} ${responseText}`);
    }

    const successToast = await firstVisible(
      [
        'text=/Activity booking confirmed/i',
        '[data-sonner-toast]',
      ],
      10000,
    );
    if (!successToast) {
      console.log('INFO: success toast not found, relying on successful booking API response');
    }

    await page.waitForTimeout(1500);
    const modalStillVisible = await firstVisible(
      [
        'text=Confirm Activity Booking',
        'text=Primary Passenger Details',
      ],
      1200,
    );
    if (modalStillVisible) {
      throw new Error('Booking modal remained open after successful booking');
    }

    await clickFirstVisible(['button:has-text("My Bookings")'], 'My Bookings header button');
    await waitForAnyVisible(['text=My Activity Bookings', '.ba-booking-list', '.ba-empty-state'], 'My Bookings panel');
    const bookingSearchInput = await waitForAnyVisible(
      ['input[placeholder*="Search booking" i]'],
      'My Bookings search input',
    );
    await bookingSearchInput.fill(BOOKING_TEST_DATA.guestName);
    await clickFirstVisible(
      ['.ba-panel-toolbar .ba-confirm-button', 'button:has-text("Search")'],
      'My Bookings search button',
    );
    await waitForAnyVisible(
      [`text=${BOOKING_TEST_DATA.guestName}`, '.ba-booking-row'],
      'new booking row',
      10000,
    );
    myBookingsWorked = true;

    console.log('RESULT: Book Activities flow completed successfully');
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    screenshotPath = path.join(
      ARTIFACT_DIR,
      sanitizeFilename(`book-activities-failure-${stamp}.png`),
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error(`FAILURE: ${error.message}`);
    if (screenshotPath) console.error(`SCREENSHOT: ${screenshotPath}`);
    throw error;
  } finally {
    const relevantFailedRequests = failedRequests.filter((item) =>
      EXPECTED_ACTIVITY_ENDPOINTS.some((endpoint) => item.url.includes(endpoint)),
    );

    console.log('SUMMARY:', {
      loginSucceeded,
      sidebarLoaded,
      categoriesLoaded,
      searchWorked,
      dateFilterWorked,
      modalOpened,
      selectedAgentName,
      walletVisible,
      wishlistWorked,
      myBookingsWorked,
      passengerDetailsFilled,
      confirmClicked,
      bookingApiSucceeded,
      bookingRequestStatus,
      insufficientWalletReached,
      appBugs,
      consoleErrorCount: consoleErrors.length,
      pageErrorCount: pageErrors.length,
      relevantFailedRequestCount: relevantFailedRequests.length,
      screenshotPath,
    });

    await browser.close();

    if (consoleErrors.length) {
      throw new Error(`Unexpected console errors detected: ${consoleErrors.join(' | ')}`);
    }

    if (pageErrors.length) {
      throw new Error(`Unexpected page errors detected: ${pageErrors.join(' | ')}`);
    }

    if (relevantFailedRequests.length) {
      throw new Error(
        `Unexpected failed activity API requests detected: ${JSON.stringify(relevantFailedRequests)}`,
      );
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
