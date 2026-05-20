const { chromium } = require('playwright');

const DEFAULT_URL = 'https://dvi.travel/itinerary-details/DVI20260525';

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function extractQuoteId(url) {
  const match = String(url || '').match(/\/itinerary-details\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

async function loadRouteDayMapFromApi(page, url) {
  const quoteId = extractQuoteId(url);
  if (!quoteId) return {};

  const apiBase = String(process.env.DVI_API_BASE || 'https://dvi.travel/api/v1').replace(/\/+$/, '');

  return page.evaluate(async ({ quoteId, apiBase }) => {
    try {
      const token =
        localStorage.getItem('accessToken') ||
        localStorage.getItem('token') ||
        localStorage.getItem('authToken') ||
        '';
      if (!token) return {};

      const res = await fetch(`${apiBase}/itineraries/details/${encodeURIComponent(quoteId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return {};

      const details = await res.json();
      const days = Array.isArray(details?.days) ? details.days : [];
      const out = {};
      for (const d of days) {
        const dayNumber = Number(d?.dayNumber || 0);
        const routeId = Number(d?.id || 0);
        if (dayNumber > 0 && routeId > 0) {
          out[dayNumber] = routeId;
        }
      }
      return out;
    } catch {
      return {};
    }
  }, { quoteId, apiBase });
}

async function chooseProviderForDay(page, dayNumber, providerName) {
  const dayRegex = new RegExp(`\\bDay\\s*${dayNumber}\\b`, 'i');
  const row = page
    .locator('table tbody tr')
    .filter({ hasText: dayRegex })
    .first();

  await row.waitFor({ state: 'visible', timeout: 20000 });
  await row.click();

  const expanded = row
    .locator('xpath=following-sibling::tr[1]')
    .first();
  await expanded.waitFor({ state: 'visible', timeout: 15000 });

  const providerRegex = new RegExp(providerName, 'i');
  const providerBadge = expanded.locator('span').filter({ hasText: providerRegex }).first();
  const found = await providerBadge.isVisible({ timeout: 10000 }).catch(() => false);

  if (!found) {
    const labels = (await expanded.locator('span').allTextContents())
      .map((t) => String(t || '').trim())
      .filter((t) => /tbo|resavenue|hobse|axisrooms/i.test(t));
    throw new Error(
      `Provider ${providerName} not found in Day ${dayNumber} expanded options. Available badges: ${labels.join(', ')}`,
    );
  }

  const card = providerBadge.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  const selectedButton = card.getByRole('button', { name: /^Selected$/i }).first();
  if (await selectedButton.isVisible().catch(() => false)) {
    console.log(`[HOTEL SELECT] Day ${dayNumber}: ${providerName} already selected.`);
    return;
  }

  const chooseButton = card.getByRole('button', { name: /^Choose$/i }).first();
  await chooseButton.waitFor({ state: 'visible', timeout: 10000 });
  await chooseButton.click();

  const confirmDialogBtn = page.getByRole('button', { name: /^Confirm$/i }).first();
  if (await confirmDialogBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await confirmDialogBtn.click();
  }

  await page.waitForTimeout(800);
  console.log(`[HOTEL SELECT] Day ${dayNumber}: selected provider ${providerName}.`);
}

async function loadPassengerSeedFromApi(page, url) {
  const quoteId = extractQuoteId(url);
  if (!quoteId) return null;

  const apiBase = String(process.env.DVI_API_BASE || 'https://dvi.travel/api/v1').replace(/\/+$/, '');

  const seed = await page.evaluate(async ({ quoteId, apiBase }) => {
    try {
      const token =
        localStorage.getItem('accessToken') ||
        localStorage.getItem('token') ||
        localStorage.getItem('authToken') ||
        '';

      if (!token) return null;

      const headers = { Authorization: `Bearer ${token}` };

      const detailsRes = await fetch(`${apiBase}/itineraries/details/${encodeURIComponent(quoteId)}`, { headers });
      if (!detailsRes.ok) return null;
      const details = await detailsRes.json();

      const planId = Number(details?.planId || 0);
      if (!planId) return null;

      const editRes = await fetch(`${apiBase}/itineraries/edit/${planId}`, { headers });
      if (!editRes.ok) return null;
      const edit = await editRes.json();

      const travellers = Array.isArray(edit?.travellers) ? edit.travellers : [];
      const sorted = [...travellers].sort((a, b) => Number(a?.traveller_details_ID || 0) - Number(b?.traveller_details_ID || 0));

      const adults = sorted.filter((t) => Number(t?.traveller_type || 0) === 1);
      const children = sorted.filter((t) => Number(t?.traveller_type || 0) === 2);
      const infants = sorted.filter((t) => Number(t?.traveller_type || 0) === 3);

      const toAge = (v, fallback, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return String(Math.max(min, Math.min(max, Math.trunc(n))));
      };

      return {
        planId,
        primaryAdultAge: adults[0] ? toAge(adults[0]?.traveller_age, 34, 18, 120) : null,
        additionalAdultAges: adults.slice(1).map((a) => toAge(a?.traveller_age, 35, 19, 120)),
        childAges: children.map((c) => toAge(c?.traveller_age, 7, 2, 11)),
        infantAges: infants.map((i) => toAge(i?.traveller_age, 2, 0, 5)),
      };
    } catch {
      return null;
    }
  }, { quoteId, apiBase });

  return seed;
}

async function maybeLogin(page) {
  const email = process.env.DVI_EMAIL || 'admin@dvi.co.in';
  const candidatePasswords = [
    process.env.DVI_PASSWORD,
    'Keerthi@2404ias',
    'Admin@123',
  ].filter(Boolean);

  const signInButton = page.getByRole('button', { name: /sign in|login/i }).first();

  const resolveLoginInputs = async () => {
    const emailByType = page.locator('input[type="email"]').first();
    if (await emailByType.isVisible().catch(() => false)) {
      return { emailInput: emailByType, passwordInput: page.locator('input[type="password"]').first() };
    }

    const emailByLabel = page.getByLabel(/email/i).first();
    const passwordByLabel = page.getByLabel(/password/i).first();
    if (
      await emailByLabel.isVisible().catch(() => false) &&
      await passwordByLabel.isVisible().catch(() => false)
    ) {
      return { emailInput: emailByLabel, passwordInput: passwordByLabel };
    }

    const visibleInputs = page.locator('input:visible');
    const count = await visibleInputs.count();
    if (count >= 2) {
      return { emailInput: visibleInputs.nth(0), passwordInput: visibleInputs.nth(1) };
    }

    throw new Error('Unable to locate login input fields.');
  };

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const atLogin = page.url().includes('/login') || await signInButton.isVisible().catch(() => false);
    if (!atLogin) {
      const hasAppShell = await page.getByRole('button', { name: /confirm quotation|back to list|logout/i }).first().isVisible().catch(() => false);
      if (hasAppShell) return;
      await page.waitForTimeout(700);
      continue;
    }

    for (const password of candidatePasswords) {
      const { emailInput, passwordInput } = await resolveLoginInputs();
      await emailInput.fill(email);
      await passwordInput.fill(String(password));
      await signInButton.click();
      await page.waitForTimeout(1500);

      const stillLogin = page.url().includes('/login') || await signInButton.isVisible().catch(() => false);
      if (!stillLogin) {
        await page.waitForLoadState('networkidle');
        return;
      }
    }

    break;
  }

  throw new Error('Login failed. Set DVI_EMAIL and DVI_PASSWORD env values for your current credentials.');
}

async function openConfirmationModal(page) {
  const heading = page.getByRole('heading', { name: 'Primary Guest Details - Adult 1' });
  if (await heading.isVisible().catch(() => false)) return;

  // Wait for itinerary details action area to become interactive.
  await page.getByRole('button', { name: /confirm quotation|back to list/i }).first().waitFor({ state: 'visible', timeout: 45000 });

  // Primary action in this screen.
  const confirmQuotation = page.getByRole('button', { name: /confirm quotation/i }).first();
  if (await confirmQuotation.isVisible({ timeout: 15000 }).catch(() => false)) {
    await confirmQuotation.click();
    if (await heading.isVisible({ timeout: 10000 }).catch(() => false)) return;
  }

  // Fallback: scan possible confirm actions with a retry window.
  const candidates = [/confirmation/i, /confirm booking/i, /^confirm$/i, /confirm/i];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const name of candidates) {
      const btn = page.getByRole('button', { name }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        if (await heading.isVisible({ timeout: 5000 }).catch(() => false)) return;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error('Could not open confirmation modal (Primary Guest Details heading not found).');
}

async function fillByLabel(modal, labelText, value, type = 'input') {
  const label = modal.locator('label', { hasText: labelText }).first();
  await label.waitFor({ state: 'visible', timeout: 5000 });
  const field = label.locator(`xpath=following-sibling::${type}[1]`);
  await field.fill(value);
}

async function setNationalityIfEditable(input, desiredNationality, scopeLabel) {
  const normalizedDesired = String(desiredNationality || 'IN').trim().toUpperCase() || 'IN';
  const editable = await input.isEditable().catch(() => false);

  if (editable) {
    await input.fill(normalizedDesired);
    return normalizedDesired;
  }

  const lockedValue = String((await input.inputValue().catch(() => '')) || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(lockedValue) && lockedValue !== normalizedDesired) {
    console.log(
      `[FORM] ${scopeLabel} nationality is locked as ${lockedValue}; requested ${normalizedDesired}. Keeping locked value.`,
    );
  }

  return /^[A-Z]{2}$/.test(lockedValue) ? lockedValue : normalizedDesired;
}

async function fillPassengerCard(modal, nameLabel, nameValue, ageValue, nationality = 'IN', overwriteAge = true) {
  const nameLabelLocator = modal.locator('label', { hasText: nameLabel }).first();
  await nameLabelLocator.waitFor({ state: 'visible', timeout: 5000 });

  const nameInput = nameLabelLocator.locator('xpath=following-sibling::input[1]');
  await nameInput.fill(nameValue);

  const card = nameLabelLocator.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  if (overwriteAge) {
    await card.getByPlaceholder('Age').first().fill(ageValue);
  }
  const nationalityInput = card.getByPlaceholder('IN').first();
  await setNationalityIfEditable(nationalityInput, nationality, nameLabel);
}

async function normalizePassengerRows(modal, labelPrefix, addButtonRegex, desiredCount) {
  const labelMatcher = new RegExp(`^${labelPrefix}\\s+\\d+\\s+Name$`, 'i');

  const getLabels = () =>
    modal
      .locator('label')
      .filter({ hasText: labelMatcher });

  let currentCount = await getLabels().count();

  while (currentCount > desiredCount) {
    const lastLabel = getLabels().nth(currentCount - 1);
    const card = lastLabel.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    const deleteButton = card.getByRole('button').last();
    await deleteButton.click();
    await modal.page().waitForTimeout(80);
    currentCount = await getLabels().count();
  }

  while (currentCount < desiredCount) {
    await modal.getByRole('button', { name: addButtonRegex }).first().click();
    await modal.page().waitForTimeout(80);
    currentCount = await getLabels().count();
  }
}

async function readExpectedCount(modal, key) {
  const messages = await modal.locator('p.text-red-600').allTextContents();
  const text = messages.join(' | ');
  let regex;

  if (key === 'adult') regex = /Expected\s+(\d+)\s+adult/i;
  if (key === 'child') regex = /Expected\s+(\d+)\s+child/i;
  if (key === 'infant') regex = /Expected\s+(\d+)\s+infant/i;

  const match = regex ? text.match(regex) : null;
  return match ? Number(match[1]) : 0;
}

async function clickAdd(modal, buttonText, times) {
  for (let i = 0; i < times; i++) {
    await modal.getByRole('button', { name: buttonText }).first().click();
  }
}

async function fillDynamicPassengers(modal, baseNationality, seed) {
  const expectedAdults = await readExpectedCount(modal, 'adult');
  const expectedChildren = await readExpectedCount(modal, 'child');
  const expectedInfants = await readExpectedCount(modal, 'infant');

  const additionalAdultAges = Array.isArray(seed?.additionalAdultAges) ? seed.additionalAdultAges : [];
  const childAges = Array.isArray(seed?.childAges) ? seed.childAges : [];
  const infantAges = Array.isArray(seed?.infantAges) ? seed.infantAges : [];

  const adultsToAdd = additionalAdultAges.length || expectedAdults;
  const childrenToAdd = childAges.length || expectedChildren;
  const infantsToAdd = infantAges.length || expectedInfants;

  await normalizePassengerRows(modal, 'Adult', /add adult/i, adultsToAdd);
  await normalizePassengerRows(modal, 'Child', /add child/i, childrenToAdd);
  await normalizePassengerRows(modal, 'Infant', /add infant/i, infantsToAdd);

  for (let i = 0; i < adultsToAdd; i++) {
    const idx = i + 2;
    await fillPassengerCard(
      modal,
      `Adult ${idx} Name`,
      `Adult ${String.fromCharCode(65 + idx)} Guest`,
      String(additionalAdultAges[i] || (30 + idx)),
      baseNationality,
    );
  }

  for (let i = 0; i < childrenToAdd; i++) {
    const idx = i + 1;
    await fillPassengerCard(
      modal,
      `Child ${idx} Name`,
      `Child ${String.fromCharCode(65 + idx)} Guest`,
      String(childAges[i] || (7 + i)),
      baseNationality,
      false,
    );
  }

  for (let i = 0; i < infantsToAdd; i++) {
    const idx = i + 1;
    await fillPassengerCard(
      modal,
      `Infant ${idx} Name`,
      `Infant${idx} Guest`,
      String(infantAges[i] || 2),
      baseNationality,
      false,
    );
  }
}

async function ensureAdultAges(modal, seed) {
  const primaryAgeNum = Number(seed?.primaryAdultAge);
  const primaryAdultAge = Number.isFinite(primaryAgeNum) && primaryAgeNum > 0 ? String(Math.trunc(primaryAgeNum)) : '34';
  const primaryAgeInput = modal.getByPlaceholder('Enter the Age').first();
  await primaryAgeInput.fill(primaryAdultAge);

  const adultAgeDefaults = Array.isArray(seed?.additionalAdultAges)
    ? seed.additionalAdultAges.map((a) => String(a))
    : [];

  const additionalAdultNameLabels = await modal
    .locator('label')
    .filter({ hasText: /^Adult\s+\d+\s+Name$/i })
    .all();

  for (let i = 0; i < additionalAdultNameLabels.length; i++) {
    const label = additionalAdultNameLabels[i];
    const card = label.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    const ageInput = card.getByPlaceholder('Age').first();
    const raw = Number(adultAgeDefaults[i]);
    const normalized = Number.isFinite(raw) && raw >= 12 ? String(Math.trunc(raw)) : String(32 + i);
    await ageInput.fill(normalized);
  }
}

async function checkPrebookAcknowledgement(modal) {
  const selectorCandidates = [
    'label:has-text("I have reviewed the inclusions") input[type="checkbox"]',
    'label:has-text("rate conditions") input[type="checkbox"]',
    'label:has-text("final booking confirmation") input[type="checkbox"]',
    'label:has-text("I have reviewed") input[type="checkbox"]',
  ];

  const roots = [modal, modal.page()];
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    for (const root of roots) {
      for (const selector of selectorCandidates) {
        const checkbox = root.locator(selector).first();
        if (await checkbox.isVisible().catch(() => false)) {
          const checked = await checkbox.isChecked().catch(() => false);
          if (!checked) {
            await checkbox.check({ force: true });
          }
          console.log(`[FORM] Prebook acknowledgement checked via selector: ${selector}`);
          return true;
        }
      }
    }

    await modal.page().waitForTimeout(250);
  }

  // Fallback: if exact label matching changes, tick the first visible unchecked checkbox in the dialog.
  const genericCheckbox = modal
    .page()
    .locator('div[role="dialog"] input[type="checkbox"]:visible')
    .first();
  if (await genericCheckbox.isVisible().catch(() => false)) {
    const checked = await genericCheckbox.isChecked().catch(() => false);
    if (!checked) {
      await genericCheckbox.check({ force: true });
    }
    console.log('[FORM] Prebook acknowledgement checked via generic dialog checkbox fallback.');
    return true;
  }

  return false;
}

async function run() {
  const url = parseArg('url', process.env.ITINERARY_URL || DEFAULT_URL);
  const headless = hasFlag('headless');
  const shouldSubmit = hasFlag('submit');
  const preferredProvider = parseArg('provider', process.env.PREFERRED_PROVIDER || 'TBO');
  const allowMixedProviders = hasFlag('allow-mixed-providers');
  const keepOpen = !headless && (hasFlag('keep-open') || !hasFlag('close'));
  let prebookRequestCount = 0;
  let confirmRequestCount = 0;
  let latestConfirmPayload = null;
  let latestConfirmResponse = null;
  let mixedProviderDialogMessage = null;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('dialog', async (dialog) => {
    const msg = String(dialog.message() || '');
    const type = dialog.type();
    console.log(`[BROWSER DIALOG] type=${type} message=${msg}`);

    const isMixedProviderPrompt = type === 'confirm' && /mixed providers detected/i.test(msg);
    if (isMixedProviderPrompt) {
      mixedProviderDialogMessage = msg;
      if (allowMixedProviders) {
        await dialog.accept();
        console.log('[BROWSER DIALOG] Mixed-provider prompt accepted due to --allow-mixed-providers flag.');
      } else {
        await dialog.dismiss();
        console.log('[BROWSER DIALOG] Mixed-provider prompt dismissed; confirmation blocked.');
      }
      return;
    }

    if (type === 'confirm') {
      await dialog.accept();
      return;
    }
    await dialog.dismiss();
  });

  page.on('request', (req) => {
    const urlText = String(req.url() || '');
    if (urlText.includes('/itineraries/confirm-quotation')) {
      confirmRequestCount += 1;
      console.log('\n[API REQUEST] confirm-quotation');
      console.log(`[API URL] ${urlText}`);
      const body = req.postData();
      if (body) {
        console.log('[API PAYLOAD]');
        console.log(body);
        try {
          latestConfirmPayload = JSON.parse(body);
        } catch {
          latestConfirmPayload = null;
        }
      }
    }
    if (urlText.includes('/itineraries/hotels/prebook')) {
      prebookRequestCount += 1;
      console.log(`\n[API REQUEST] prebook detected: ${urlText}`);
    }
  });

  page.on('response', async (res) => {
    const urlText = String(res.url() || '');
    if (urlText.includes('/itineraries/confirm-quotation')) {
      console.log(`[API RESPONSE] confirm-quotation -> ${res.status()}`);
      try {
        const body = await res.text();
        console.log('[API RESPONSE BODY]');
        console.log(body);
        try {
          latestConfirmResponse = JSON.parse(body);
        } catch {
          latestConfirmResponse = { raw: body };
        }
      } catch (err) {
        console.log('[API RESPONSE TEXT ERROR]', err.message);
        latestConfirmResponse = null;
      }
    }
  });

  try {
    console.log(`Opening: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await maybeLogin(page);
    if (!page.url().includes('/itinerary-details/')) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForLoadState('networkidle');

    const routeDayMap = await loadRouteDayMapFromApi(page, url);
    console.log('[HOTEL SELECT] Route day map:', JSON.stringify(routeDayMap));
    for (const day of [1, 2, 3, 4]) {
      await chooseProviderForDay(page, day, preferredProvider);
    }

    const passengerSeed = await loadPassengerSeedFromApi(page, url);

    await openConfirmationModal(page);

    const modal = page.locator('div:has(h3:has-text("Primary Guest Details - Adult 1"))').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 });

    // Primary guest required fields
    await modal.getByPlaceholder('Enter the Name').fill('Arun Kumar');
    await modal.getByPlaceholder('Enter the Age').fill(String(passengerSeed?.primaryAdultAge || '34'));
    await modal.getByPlaceholder('Enter the Contact No').fill('9876543210');
    const primaryNationalityInput = modal.getByPlaceholder('IN').first();
    const existingNationality = String((await primaryNationalityInput.inputValue().catch(() => '')) || '')
      .trim()
      .toUpperCase();
    const baseNationality = /^[A-Z]{2}$/.test(existingNationality)
      ? existingNationality
      : String(process.env.DEFAULT_NATIONALITY || 'IN').trim().toUpperCase();

    // Keep/create primary nationality in sync with itinerary-provided value when editable.
    const effectiveNationality = await setNationalityIfEditable(
      primaryNationalityInput,
      baseNationality,
      'Primary guest',
    );
    await modal.getByPlaceholder('Enter the Email ID').fill('arun.kumar@example.com');

    // Optional PAN: fill only when explicitly provided to avoid TBO rejecting demo/test PAN values.
    const explicitPan = String(process.env.DVI_PRIMARY_PAN || '').trim().toUpperCase();
    if (explicitPan) {
      await modal.getByPlaceholder('ABCDE1234F').fill(explicitPan);
    } else {
      await modal.getByPlaceholder('ABCDE1234F').fill('');
    }

    // Add/fill dynamic expected passenger counts from validation messages
    await fillDynamicPassengers(modal, effectiveNationality, passengerSeed);
    await ensureAdultAges(modal, passengerSeed);

    // Tick prebook acknowledgement/review checkbox required for final booking.
    const checkedPrebookAck = await checkPrebookAcknowledgement(modal);
    if (!checkedPrebookAck) {
      console.log('[FORM] Prebook acknowledgement checkbox not found in modal.');
    }

    // Check remaining validation messages
    const remainingErrors = await modal.locator('p.text-red-600').allTextContents();
    const meaningfulErrors = remainingErrors
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .filter((t) => !/^Expected\s+\d+\s+(adult|child|infant)s?,\s+but\s+found\s+\d+\.?$/i.test(t));

    console.log(`Remaining validation messages: ${meaningfulErrors.length}`);
    meaningfulErrors.forEach((e) => console.log(` - ${e}`));

    if (shouldSubmit) {
      const prebookBeforeSubmit = prebookRequestCount;
      let submitAttempt = 0;
      while (submitAttempt < 3 && confirmRequestCount <= 0) {
        submitAttempt += 1;
        console.log(`Clicking Confirm Booking... (attempt ${submitAttempt}/3)`);
        await modal.getByRole('button', { name: /confirm booking/i }).first().click();

        await page.waitForTimeout(1200);

        if (mixedProviderDialogMessage && !allowMixedProviders) {
          throw new Error(
            `Mixed-provider confirmation dialog appeared and was dismissed. Booking intentionally blocked. Message: ${mixedProviderDialogMessage}`,
          );
        }

        if (confirmRequestCount > 0) break;

        const checkedAfterClick = await checkPrebookAcknowledgement(modal);
        if (checkedAfterClick) {
          console.log('[FORM] Prebook acknowledgement checked after submit attempt. Retrying confirm.');
        }

        const proceedButton = modal.getByRole('button', { name: /proceed|continue|confirm/i }).first();
        if (await proceedButton.isVisible().catch(() => false)) {
          await proceedButton.click();
          await page.waitForTimeout(1000);
        }
      }

      await page
        .waitForResponse(
          (res) => String(res.url() || '').includes('/itineraries/confirm-quotation'),
          { timeout: 15000 },
        )
        .catch(() => null);
      await page.waitForTimeout(2500);
      const prebookAfterSubmit = prebookRequestCount;
      console.log(
        `[API TRACE] prebook requests before submit: ${prebookBeforeSubmit}, after submit: ${prebookAfterSubmit}, delta on submit: ${prebookAfterSubmit - prebookBeforeSubmit}`,
      );
      console.log(`[API TRACE] confirm-quotation requests seen: ${confirmRequestCount}`);

      if (confirmRequestCount <= 0) {
        throw new Error('Confirm API was not called. Booking not submitted.');
      }

      if (!latestConfirmPayload) {
        throw new Error('Confirm payload not captured from /confirm-quotation request.');
      }

      const hotelBookings = Array.isArray(latestConfirmPayload?.hotel_bookings)
        ? latestConfirmPayload.hotel_bookings
        : [];
      console.log(`[ASSERT] hotel_bookings count: ${hotelBookings.length}`);

      if (!latestConfirmResponse || typeof latestConfirmResponse !== 'object') {
        throw new Error('Confirm response body not captured; cannot validate provider booking success.');
      }

      const bookingResults =
        (Array.isArray(latestConfirmResponse?.bookingResults) && latestConfirmResponse.bookingResults) ||
        (Array.isArray(latestConfirmResponse?.data?.bookingResults) && latestConfirmResponse.data.bookingResults) ||
        (Array.isArray(latestConfirmResponse?.result?.bookingResults) && latestConfirmResponse.result.bookingResults) ||
        [];

      if (!Array.isArray(bookingResults) || bookingResults.length === 0) {
        throw new Error('confirm-quotation returned no bookingResults array; cannot verify provider booking success.');
      }

      const successCount = bookingResults.filter((r) => {
        const status = String(r?.status || '').toLowerCase();
        const successFlag = r?.success;
        return status === 'confirmed' || status === 'success' || successFlag === true;
      }).length;

      console.log(`[RESULT] Total bookings attempted: ${bookingResults.length}`);
      console.log(`[RESULT] Successful bookings: ${successCount}/${bookingResults.length}`);

      if (successCount < bookingResults.length) {
        const failures = bookingResults.filter((r) => {
          const status = String(r?.status || '').toLowerCase();
          const successFlag = r?.success;
          return !(status === 'confirmed' || status === 'success' || successFlag === true);
        });
        const failureSummary = failures
          .map((f) => `Route ${f.routeId} (${f.provider}): ${f.error || f.message || f.status || 'Unknown error'}`)
          .join(' | ');
        throw new Error(`Not all provider bookings succeeded (${successCount}/${bookingResults.length}). ${failureSummary}`);
      }

      console.log('Submit clicked. Booking verified as all-success.');
    } else {
      console.log('Filled successfully. Run with --submit to click Confirm Booking.');
    }

    if (keepOpen) {
      console.log('Form kept open. Close browser manually when done.');
      await new Promise(() => {});
    }
  } catch (err) {
    console.error('Script failed:', err.message);
    await page.screenshot({ path: 'playwright-fill-confirmation-details-error.png', fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
