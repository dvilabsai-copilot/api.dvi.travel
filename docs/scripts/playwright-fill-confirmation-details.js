const { chromium } = require('playwright');

const DEFAULT_URL = 'http://localhost:8080/itinerary-details/DVI20260534';

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseListArg(name, fallbackList) {
  const raw = parseArg(name, '');
  if (!raw) return fallbackList;
  return String(raw)
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function extractQuoteId(url) {
  const match = String(url || '').match(/\/itinerary-details\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function normalizeProviderBadgeText(value) {
  return String(value || '')
    .replace(/[^a-z]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalProviderName(value) {
  const normalized = normalizeProviderBadgeText(value).toLowerCase();
  if (normalized.includes('resavenue')) return 'ResAvenue';
  if (normalized.includes('axisrooms')) return 'AxisRooms';
  if (normalized.includes('hobse')) return 'HOBSE';
  if (normalized.includes('tbo')) return 'TBO';
  return '';
}

function normalizeProviderPreference(value, fallback = '') {
  const canonical = canonicalProviderName(value);
  if (canonical) return canonical;
  const raw = String(value || '').trim();
  return raw || fallback;
}

function parseProviderFallbackMode(raw) {
  const mode = String(raw || 'strict').trim().toLowerCase();
  if (mode === 'first-available' || mode === 'first_available') return 'first-available';
  if (mode === 'fallback-provider' || mode === 'fallback_provider') return 'fallback-provider';
  if (mode === 'skip-unavailable' || mode === 'skip_unavailable' || mode === 'skip-day' || mode === 'skip_day') {
    return 'skip-unavailable';
  }
  return 'strict';
}

async function resolveDayRow(page, dayNumber) {
  await page.locator('table tbody').first().waitFor({ state: 'visible', timeout: 30000 });
  const availableDays = [];

  for (let pass = 0; pass < 10; pass++) {
    const rows = page.locator('table tbody tr').filter({ hasText: /Day\s*\d+\s*\|/i });
    const rowCount = await rows.count();

    for (let i = 0; i < rowCount; i++) {
      const text = String((await rows.nth(i).textContent().catch(() => '')) || '');
      const match = text.match(/Day\s*(\d+)\s*\|/i);
      const currentDay = match ? Number(match[1]) : NaN;
      if (Number.isFinite(currentDay) && !availableDays.includes(currentDay)) {
        availableDays.push(currentDay);
      }
    }

    if (rowCount >= dayNumber) {
      return { row: rows.nth(dayNumber - 1), availableDays };
    }

    await page.evaluate(() => {
      const table = document.querySelector('table');
      let node = table;
      while (node) {
        const el = node;
        if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 10) {
          el.scrollTop += 900;
          return;
        }
        node = node.parentElement;
      }
      window.scrollBy(0, 900);
    }).catch(() => {});
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Day ${dayNumber} row not found in itinerary table. Available day rows: ${availableDays.length ? availableDays.join(', ') : 'none'}.`,
  );
}

async function getAvailableProvidersForDay(page, dayNumber) {
  const { row, availableDays } = await resolveDayRow(page, dayNumber);
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.waitFor({ state: 'visible', timeout: 10000 });
  await row.click();

  const expanded = row
    .locator('xpath=following-sibling::tr[1]')
    .first();

  // Row click toggles expand/collapse; ensure it's actually expanded.
  let expandedVisible = await expanded
    .waitFor({ state: 'visible', timeout: 1200 })
    .then(() => true)
    .catch(() => false);
  if (!expandedVisible) {
    await row.click();
    expandedVisible = await expanded
      .waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true)
      .catch(() => false);
  }

  if (!expandedVisible) {
    throw new Error(`Day ${dayNumber} details did not expand.`);
  }

  const expandedCardScope = expanded
    .locator('div.rounded-lg:visible')
    .filter({ has: page.locator('button:has-text("Choose"), button:has-text("Selected")') });

  await expandedCardScope.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

  const cardScope = expandedCardScope;
  const rawLabels = (await expandedCardScope.locator('span:visible').allTextContents())
    .map((text) => canonicalProviderName(text))
    .filter(Boolean);

  const availableProviders = [...new Set(rawLabels)];
  return { row, expanded, cardScope, availableProviders, availableDays };
}

async function chooseProviderForDay(page, dayNumber, providerName, options = {}) {
  const { expanded, cardScope, availableProviders, availableDays } = await getAvailableProvidersForDay(page, dayNumber);

  const fallbackMode = parseProviderFallbackMode(options.fallbackMode);
  const fallbackProvider = normalizeProviderPreference(options.fallbackProvider, 'TBO');
  const requestedProvider = normalizeProviderPreference(providerName, 'TBO');

  let selectedProvider = requestedProvider;
  let usedFallback = false;

  const findProviderCard = async (candidateProvider) => {
    if (!candidateProvider) return null;
    const providerRegex = new RegExp(candidateProvider, 'i');
    const cardFromGrid = cardScope.filter({ hasText: providerRegex }).first();
    const gridVisible = await cardFromGrid.isVisible({ timeout: 3000 }).catch(() => false);
    if (gridVisible) return cardFromGrid;

    if (expanded) {
      const badge = expanded.locator('span').filter({ hasText: providerRegex }).first();
      const badgeVisible = await badge.isVisible({ timeout: 3000 }).catch(() => false);
      if (badgeVisible) {
        const cardFromExpanded = badge.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
        const expandedVisible = await cardFromExpanded.isVisible({ timeout: 3000 }).catch(() => false);
        if (expandedVisible) return cardFromExpanded;
      }
    }

    return null;
  };

  let providerCard = await findProviderCard(requestedProvider);

  if (!providerCard) {
    const availabilityText = availableProviders.length > 0 ? availableProviders.join(', ') : 'none';
    const hobseHint = requestedProvider === 'HOBSE'
      ? ' HOBSE is not available in the UI for this day. This usually means HOBSE search is disabled or no HOBSE hotel was returned for that route.'
      : '';

    if (fallbackMode === 'fallback-provider') {
      const fallbackCard = await findProviderCard(fallbackProvider);
      if (fallbackCard) {
        providerCard = fallbackCard;
        selectedProvider = fallbackProvider;
        usedFallback = true;
        console.log(
          `[HOTEL SELECT] Day ${dayNumber}: requested ${requestedProvider} unavailable, using fallback provider ${fallbackProvider}.`,
        );
      }
    } else if (fallbackMode === 'first-available' && availableProviders.length > 0) {
      const firstAvailable = availableProviders[0];
      const firstCard = await findProviderCard(firstAvailable);
      if (firstCard) {
        providerCard = firstCard;
        selectedProvider = firstAvailable;
        usedFallback = true;
        console.log(
          `[HOTEL SELECT] Day ${dayNumber}: requested ${requestedProvider} unavailable, using first available provider ${firstAvailable}.`,
        );
      }
    }

    if (!providerCard) {
      if (fallbackMode === 'skip-unavailable') {
        console.log(
          `[HOTEL SELECT] Day ${dayNumber}: requested ${requestedProvider} unavailable and no fallback candidate found. Skipping this day due to skip-unavailable mode.`,
        );
        return {
          requestedProvider,
          selectedProvider: '',
          usedFallback: true,
          availableProviders,
          alreadySelected: false,
          skipped: true,
        };
      }
      throw new Error(
        `Provider ${requestedProvider} not found in Day ${dayNumber}. Available providers: ${availabilityText}. Available day rows: ${availableDays.length ? availableDays.join(', ') : 'none'}. Fallback mode: ${fallbackMode}.${hobseHint}`,
      );
    }
  }

  const card = providerCard;
  const selectedButton = card.getByRole('button', { name: /^Selected$/i }).first();
  if (await selectedButton.isVisible().catch(() => false)) {
    console.log(`[HOTEL SELECT] Day ${dayNumber}: ${selectedProvider} already selected.`);
    return {
      requestedProvider,
      selectedProvider,
      usedFallback,
      availableProviders,
      alreadySelected: true,
      skipped: false,
    };
  }

  const chooseButton = card.getByRole('button', { name: /^Choose$/i }).first();
  await chooseButton.waitFor({ state: 'visible', timeout: 10000 });
  await chooseButton.click();

  const confirmDialogBtn = page.getByRole('button', { name: /^Confirm$/i }).first();
  if (await confirmDialogBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await confirmDialogBtn.click();
  }

  await page.waitForTimeout(700);
  console.log(`[HOTEL SELECT] Day ${dayNumber}: selected ${selectedProvider}.`);
  return {
    requestedProvider,
    selectedProvider,
    usedFallback,
    availableProviders,
    alreadySelected: false,
    skipped: false,
  };
}

async function loadPassengerSeedFromApi(page, url) {
  const quoteId = extractQuoteId(url);
  if (!quoteId) return null;

  const apiBase = String(process.env.DVI_API_BASE || 'http://127.0.0.1:4006/api/v1').replace(/\/+$/, '');

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
  const dayProviders = parseListArg('day-providers', [
    'TBO',
    'TBO',
    'ResAvenue',
    'AxisRooms',
  ]);
  const providerFallbackMode = parseProviderFallbackMode(
    parseArg('provider-fallback-mode', process.env.PROVIDER_FALLBACK_MODE || 'strict'),
  );
  const fallbackProvider = normalizeProviderPreference(
    parseArg('fallback-provider', process.env.FALLBACK_PROVIDER || preferredProvider),
    'TBO',
  );
  const expectedRequestedProviders = [...new Set(dayProviders.map((provider) => normalizeProviderPreference(provider)).filter(Boolean))];
  const allowMixedProviders = hasFlag('allow-mixed-providers');
  const keepOpen = !headless && (hasFlag('keep-open') || !hasFlag('close'));
  let prebookRequestCount = 0;
  let confirmRequestCount = 0;
  let latestConfirmStatusCode = null;
  let latestConfirmResponse = null;
  let latestConfirmPayload = null;
  let mixedProviderDialogMessage = null;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('dialog', async (dialog) => {
    const type = dialog.type();
    const msg = String(dialog.message() || '');
    const isMixedProviderPrompt = type === 'confirm' && /mixed providers detected/i.test(msg);
    if (isMixedProviderPrompt) {
      mixedProviderDialogMessage = msg;
      if (allowMixedProviders) {
        await dialog.accept().catch(() => {});
        console.log('[BROWSER DIALOG] Mixed-provider prompt accepted due to --allow-mixed-providers flag.');
      } else {
        await dialog.dismiss().catch(() => {});
        console.log('[BROWSER DIALOG] Mixed-provider prompt dismissed; confirmation blocked.');
      }
      return;
    }
    await dialog.dismiss().catch(() => {});
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
      latestConfirmStatusCode = res.status();
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
      } catch {
        // Ignore response parse errors in logger.
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

    console.log('[HOTEL SELECT] Day providers:', JSON.stringify(dayProviders));
    console.log(`[HOTEL SELECT] provider fallback mode: ${providerFallbackMode}; fallback provider: ${fallbackProvider}`);
    const providerAvailability = [];
    for (const day of [1, 2, 3, 4]) {
      const { availableProviders } = await getAvailableProvidersForDay(page, day);
      providerAvailability.push({ day, availableProviders });
    }
    providerAvailability.forEach(({ day, availableProviders }) => {
      console.log(
        `[HOTEL SELECT] Day ${day} available providers: ${availableProviders.length ? availableProviders.join(', ') : 'none'}`,
      );
    });

    const selectedProviderDetails = [];
    for (const day of [1, 2, 3, 4]) {
      const providerForDay = dayProviders[day - 1] || preferredProvider;
      const selection = await chooseProviderForDay(page, day, providerForDay, {
        fallbackMode: providerFallbackMode,
        fallbackProvider,
      });
      selectedProviderDetails.push({ day, ...selection });
    }

    const expectedSelectedProviders = [...new Set(
      selectedProviderDetails
        .filter((selection) => !selection?.skipped)
        .map((selection) => normalizeProviderPreference(selection?.selectedProvider))
        .filter(Boolean),
    )];
    const fallbackDays = selectedProviderDetails
      .filter((selection) => selection?.usedFallback)
      .map((selection) => `Day ${selection.day}: ${selection.requestedProvider} -> ${selection.selectedProvider}`);
    if (fallbackDays.length > 0) {
      console.log('[HOTEL SELECT] fallback selections:', fallbackDays.join(' | '));
    }
    const skippedDays = selectedProviderDetails
      .filter((selection) => selection?.skipped)
      .map((selection) => `Day ${selection.day}`);
    if (skippedDays.length > 0) {
      console.log('[HOTEL SELECT] skipped days due to unavailable providers:', skippedDays.join(', '));
    }
    console.log('[HOTEL SELECT] expected providers after selection:', expectedSelectedProviders.join(', '));

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
      let confirmResponse = null;
      let submitAttempt = 0;
      while (submitAttempt < 3 && confirmRequestCount <= 0) {
        submitAttempt += 1;
        console.log(`Clicking Confirm Booking... (attempt ${submitAttempt}/3)`);
        await modal.getByRole('button', { name: /confirm booking/i }).first().click();
        await page.waitForTimeout(1200);

        if (mixedProviderDialogMessage && !allowMixedProviders) {
          throw new Error(
            `Mixed-provider confirmation dialog appeared and was dismissed. Message: ${mixedProviderDialogMessage}`,
          );
        }

        if (confirmRequestCount > 0) {
          confirmResponse = await page
            .waitForResponse(
              (res) => String(res.url() || '').includes('/itineraries/confirm-quotation'),
              { timeout: 60000 },
            )
            .catch(() => null);
        }
      }

      if (!confirmResponse) {
        confirmResponse = await page
          .waitForResponse(
            (res) => String(res.url() || '').includes('/itineraries/confirm-quotation'),
            { timeout: 60000 },
          )
          .catch(() => null);
      }

      if (confirmResponse) {
        try {
          const body = await confirmResponse.text();
          if (body) {
            try {
              latestConfirmResponse = JSON.parse(body);
            } catch {
              latestConfirmResponse = { raw: body };
            }
          }
        } catch {
          // Best effort: keep event-based capture fallback.
        }
      }

      await page.waitForTimeout(2000);
      const prebookAfterSubmit = prebookRequestCount;
      console.log(
        `[API TRACE] prebook requests before submit: ${prebookBeforeSubmit}, after submit: ${prebookAfterSubmit}, delta on submit: ${prebookAfterSubmit - prebookBeforeSubmit}`,
      );
      console.log(`[API TRACE] confirm-quotation requests seen: ${confirmRequestCount}`);

      if (confirmRequestCount <= 0) {
        throw new Error('Confirm API was not called. Booking not submitted.');
      }

      const hotelBookings = Array.isArray(latestConfirmPayload?.hotel_bookings)
        ? latestConfirmPayload.hotel_bookings
        : [];
      console.log(`[ASSERT] hotel_bookings count: ${hotelBookings.length}`);
      if (hotelBookings.length !== 4) {
        throw new Error(`Expected exactly 4 hotel bookings in payload, found ${hotelBookings.length}.`);
      }

      const payloadProviders = [...new Set(
        hotelBookings
          .map((b) => normalizeProviderPreference(b?.provider))
          .filter(Boolean),
      )];
      console.log('[ASSERT] providers in payload:', payloadProviders.join(', '));
      const expectedProvidersForAssertions = expectedSelectedProviders.length > 0
        ? expectedSelectedProviders
        : expectedRequestedProviders;
      const allowExtraProviders = providerFallbackMode === 'skip-unavailable';
      const missingPayloadProviders = expectedProvidersForAssertions.filter(
        (provider) => !payloadProviders.includes(provider),
      );
      if (missingPayloadProviders.length > 0 || (!allowExtraProviders && payloadProviders.length !== expectedProvidersForAssertions.length)) {
        throw new Error(
          `Payload providers did not match selected providers. Expected: ${expectedProvidersForAssertions.join(', ')}. Actual: ${payloadProviders.join(', ') || 'none'}. Missing: ${missingPayloadProviders.join(', ') || 'none'}.`,
        );
      }

      if (!latestConfirmResponse || typeof latestConfirmResponse !== 'object') {
        throw new Error('Confirm response body not captured; cannot verify booking success.');
      }

      const pendingBookings = Array.isArray(latestConfirmResponse?.pendingBookings)
        ? latestConfirmResponse.pendingBookings
        : Array.isArray(latestConfirmResponse?.data?.pendingBookings)
          ? latestConfirmResponse.data.pendingBookings
          : [];

      if ((latestConfirmStatusCode !== null && latestConfirmStatusCode >= 400) || pendingBookings.length > 0) {
        const pendingSummary = pendingBookings.length > 0
          ? pendingBookings
              .map((booking) => `${booking?.provider || 'unknown'}:${booking?.routeId || 'n/a'}:${booking?.hotelCode || 'n/a'}`)
              .join(' | ')
          : 'none';
        throw new Error(
          `Confirm API returned a partial/non-success response. HTTP status: ${latestConfirmStatusCode ?? 'unknown'}. Pending bookings: ${pendingSummary}.`,
        );
      }

      const bookingResults =
        (Array.isArray(latestConfirmResponse?.bookingResults) && latestConfirmResponse.bookingResults) ||
        (Array.isArray(latestConfirmResponse?.data?.bookingResults) && latestConfirmResponse.data.bookingResults) ||
        (Array.isArray(latestConfirmResponse?.result?.bookingResults) && latestConfirmResponse.result.bookingResults) ||
        [];

      if (!Array.isArray(bookingResults) || bookingResults.length !== 4) {
        throw new Error(`Expected 4 booking results, found ${bookingResults.length}.`);
      }

      const successResults = bookingResults.filter((r) => {
        const status = String(r?.status || '').toLowerCase();
        return status === 'confirmed' || status === 'success' || r?.success === true;
      });

      const resultProviders = [...new Set(
        bookingResults
          .map((r) => normalizeProviderPreference(r?.provider))
          .filter(Boolean),
      )];

      console.log(`[RESULT] successful bookings: ${successResults.length}/${bookingResults.length}`);
      console.log('[RESULT] providers in results:', resultProviders.join(', '));

      if (successResults.length !== 4) {
        const failures = bookingResults
          .filter((r) => {
            const status = String(r?.status || '').toLowerCase();
            return !(status === 'confirmed' || status === 'success' || r?.success === true);
          })
          .map((r) => `${r?.provider || 'unknown'}:${r?.error || r?.message || r?.status || 'failed'}`);
        throw new Error(`Not all 4 bookings succeeded. Failures: ${failures.join(' | ')}`);
      }

      const missingResultProviders = expectedProvidersForAssertions.filter(
        (provider) => !resultProviders.includes(provider),
      );
      if (resultProviders.length > 0 && (missingResultProviders.length > 0 || (!allowExtraProviders && resultProviders.length !== expectedProvidersForAssertions.length))) {
        throw new Error(
          `Booking result providers did not match selected providers. Expected: ${expectedProvidersForAssertions.join(', ')}. Actual: ${resultProviders.join(', ') || 'none'}. Missing: ${missingResultProviders.join(', ') || 'none'}.`,
        );
      }

      console.log(`Submit clicked. Booking verified: ${hotelBookings.length} hotels, providers matched requested mix, all succeeded.`);
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
