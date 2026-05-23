#!/usr/bin/env node
/*
  Random hotspot add smoke test for day 1/2/3 via Playwright.

  Usage:
    node scripts/test-random-hotspot-add-playwright.js --quote DVI20260589

  Optional env:
    DVI_BASE_URL=http://localhost:8080
    DVI_EMAIL=admin@dvi.co.in
    DVI_PASSWORD=***
    HEADLESS=true
*/

function parseArgs(argv) {
  const out = { quote: 'DVI20260589' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const b = argv[i + 1];
    if (a === '--quote' && b) {
      out.quote = String(b).trim();
      i += 1;
    }
  }
  return out;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return decodeHtmlEntities(value).toLowerCase();
}

function timelineContainsHotspot(timeline, hotspotName, hotspotId) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const id = Number(hotspotId || 0);
  const target = normalizeName(hotspotName);

  for (const row of rows) {
    const rowId = Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0);
    const rowText = normalizeName(row?.text || row?.name || row?.displayLabel || row?.title || '');
    if (id > 0 && rowId === id) return true;
    if (target && rowText.includes(target)) return true;
  }

  return false;
}

function findHotspotIdInTimeline(timeline, hotspotName) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const target = normalizeName(hotspotName);

  for (const row of rows) {
    const rowId = Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0);
    const rowText = normalizeName(row?.text || row?.name || row?.displayLabel || row?.title || '');
    if (rowId > 0 && target && rowText.includes(target)) {
      return rowId;
    }
  }

  return null;
}

async function ensureLoggedInAndOpenItinerary({ page, itineraryUrl, email, password }) {
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

  const isAtLogin = async () => {
    if (/\/signin|\/login/i.test(page.url())) return true;
    const hasEmail = await page.locator('input[type="email"], input[name="email"]').first().isVisible().catch(() => false);
    const hasPassword = await page.locator('input[type="password"], input[name="password"]').first().isVisible().catch(() => false);
    const hasSignIn = await signInButton.isVisible().catch(() => false);
    return (hasEmail && hasPassword) || hasSignIn;
  };

  await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!(await isAtLogin())) return;

  if (!email || !password) {
    throw new Error('Login required. Set DVI_EMAIL and DVI_PASSWORD env vars.');
  }

  const { emailInput, passwordInput } = await resolveLoginInputs();
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await signInButton.click();
  await page.waitForTimeout(1500);

  if (await isAtLogin()) {
    throw new Error('Login failed. Check DVI_EMAIL/DVI_PASSWORD.');
  }

  await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getCandidateHotspots(dialog) {
  // Build candidates from cards that actually have Preview/View actions.
  const names = await dialog.evaluate((el) => {
    const out = [];
    const textSeen = new Set();
    const actionButtons = el.querySelectorAll('button, [role="button"]');

    const isActionButton = (btn) => {
      const txt = String(btn.textContent || '').toLowerCase();
      const aria = String(btn.getAttribute('aria-label') || '').toLowerCase();
      const title = String(btn.getAttribute('title') || '').toLowerCase();
      const joined = `${txt} ${aria} ${title}`;
      return joined.includes('preview') || joined.includes('view');
    };

    const findCard = (node) => {
      let cur = node;
      for (let i = 0; i < 8 && cur; i += 1) {
        if (
          cur.querySelector &&
          cur.querySelector('button, [role="button"]') &&
          /preview|view/i.test(String(cur.textContent || ''))
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    };

    const extractName = (card) => {
      const titleNode = card.querySelector('h1,h2,h3,h4,h5,h6,[data-hotspot-name],strong,b');
      if (titleNode) {
        return String(titleNode.textContent || '').replace(/\s+/g, ' ').trim();
      }

      const lines = String(card.textContent || '')
        .split('\n')
        .map((v) => String(v || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      return lines.find((line) => (
        line.length > 3
        && !/preview|view|add|confirm|reschedule|minutes?|hours?|distance|duration|travel/i.test(line)
      )) || null;
    };

    for (const btn of actionButtons) {
      if (!isActionButton(btn)) continue;
      const card = findCard(btn);
      if (!card) continue;
      const name = extractName(card);
      if (!name) continue;
      if (/^hotspot\s*list$/i.test(name)) continue;
      const key = name.toLowerCase();
      if (textSeen.has(key)) continue;
      textSeen.add(key);
      out.push(name);
    }

    return out;
  });

  return Array.isArray(names) ? names : [];
}

async function clickPreviewForHotspot(dialog, hotspotName) {
  const clicked = await dialog.evaluate((el, rawName) => {
    const norm = (v) => String(v || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const target = norm(rawName);
    const allButtons = Array.from(el.querySelectorAll('button, [role="button"]'));

    const isPreviewBtn = (btn) => {
      const txt = norm(btn.textContent || '');
      const aria = norm(btn.getAttribute('aria-label') || '');
      const title = norm(btn.getAttribute('title') || '');
      const combined = `${txt} ${aria} ${title}`;
      return combined.includes('preview') || combined.includes('view');
    };

    const findCard = (node) => {
      let cur = node;
      for (let i = 0; i < 8 && cur; i += 1) {
        if (cur.querySelector && cur.querySelector('button, [role="button"]')) return cur;
        cur = cur.parentElement;
      }
      return null;
    };

    for (const btn of allButtons) {
      if (!isPreviewBtn(btn)) continue;
      const card = findCard(btn);
      if (!card) continue;
      const cardText = norm(card.textContent || '');
      if (!target || !cardText.includes(target)) continue;
      btn.click();
      return true;
    }

    return false;
  }, hotspotName);

  if (!clicked) {
    throw new Error(`Preview button not found for hotspot: ${hotspotName}`);
  }

  await dialog.page().waitForTimeout(800);
}

async function clickConfirmAdd(dialog) {
  const rescheduleButton = dialog.getByRole('button', { name: /confirm reschedule/i }).first();
  if (await rescheduleButton.isVisible().catch(() => false)) {
    const disabled = await rescheduleButton.isDisabled().catch(() => true);
    if (!disabled) {
      await rescheduleButton.click({ timeout: 10000 });
      await dialog.page().waitForTimeout(1200);
    }
  }

  const patterns = [
    /confirm add hotspot/i,
    /add with reschedule/i,
    /confirm force add/i,
    /force add/i,
    /^add hotspot$/i,
  ];

  for (const p of patterns) {
    const btn = dialog.getByRole('button', { name: p }).first();
    if (await btn.isVisible().catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => true);
      if (disabled) {
        throw new Error(`Confirm button is disabled for pattern: ${String(p)}`);
      }
      const label = (await btn.innerText().catch(() => '')) || '';
      await btn.click({ timeout: 10000 });
      return label.trim() || String(p);
    }
  }

  throw new Error('Confirm add hotspot button not found.');
}

async function run() {
  const args = parseArgs(process.argv);
  const baseUrl = String(process.env.DVI_BASE_URL || 'http://localhost:8080').trim();
  const email = String(process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.DVI_PASSWORD || 'Keerthi@2404ias').trim();
  const headless = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';

  let chromium;
  let PrismaClient;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Missing dependency: playwright. Install with: npm i -D playwright');
    process.exit(1);
  }

  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch {
    console.error('Missing dependency: @prisma/client');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const result = {
    ok: false,
    quote: args.quote,
    baseUrl,
    latestPlanId: null,
    days: [],
    matrix: [],
  };

  try {
    const itineraryUrl = `${baseUrl.replace(/\/$/, '')}/itinerary-details/${encodeURIComponent(args.quote)}`;
    await ensureLoggedInAndOpenItinerary({ page, itineraryUrl, email, password });

    const latestPlanRows = await prisma.$queryRawUnsafe(`
      SELECT itinerary_plan_ID
      FROM dvi_itinerary_plan_details
      WHERE itinerary_quote_ID = ?
      ORDER BY itinerary_plan_ID DESC
      LIMIT 1
    `, args.quote);

    const latestPlanId = Number(latestPlanRows?.[0]?.itinerary_plan_ID || 0) || null;
    result.latestPlanId = latestPlanId;

    if (!latestPlanId) {
      throw new Error(`No itinerary plan found for quote ${args.quote}`);
    }

    const routeRows = await prisma.$queryRawUnsafe(`
      SELECT itinerary_route_ID, itinerary_route_date
      FROM dvi_itinerary_route_details
      WHERE itinerary_plan_ID = ?
        AND status = 1
        AND deleted = 0
      ORDER BY itinerary_route_date ASC, itinerary_route_ID ASC
    `, latestPlanId);

    const dayRouteIds = (Array.isArray(routeRows) ? routeRows : []).map((row) => Number(row?.itinerary_route_ID || 0));
    const usedHotspotNames = new Set();

    for (const day of [1, 2, 3]) {
      const dayResult = {
        day,
        routeId: dayRouteIds[day - 1] || null,
        selectedHotspot: null,
        selectedHotspotId: null,
        previewApiCode: null,
        previewApiStatus: null,
        previewApiOk: null,
        addedInApplyTimeline: false,
        applyApiStatus: null,
        applyApiOk: null,
        applyApiSuccessField: null,
        applyApiCode: null,
        applyApiUrl: null,
        confirmLabel: null,
        dbInsertedCount: 0,
        dbInserted: false,
        addedVisibleAfterReload: false,
        status: 'failed',
        error: null,
      };

      try {
        await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const dayRoot = page.locator(`#itinerary-day-${day}`).first();
        await dayRoot.waitFor({ state: 'visible', timeout: 30000 });

        const addHotspotBtn = dayRoot.getByRole('button', { name: /add hotspot/i }).first();
        await addHotspotBtn.click({ timeout: 10000 });

        const dialog = page.locator('[role="dialog"]').first();
        await dialog.waitFor({ state: 'visible', timeout: 15000 });

        const candidates = await getCandidateHotspots(dialog);
        if (!candidates.length) {
          throw new Error('No hotspot candidates found in modal');
        }

        const uniqueCandidates = candidates.filter((name) => !usedHotspotNames.has(normalizeName(name)));
        const candidatePool = uniqueCandidates.length > 0 ? uniqueCandidates : candidates;
        const shuffled = [...candidatePool].sort(() => Math.random() - 0.5);
        const maxAttempts = Math.min(5, shuffled.length);
        let attemptError = null;

        for (let i = 0; i < maxAttempts; i += 1) {
          const candidateHotspot = shuffled[i];
          dayResult.selectedHotspot = candidateHotspot;

          try {
            const previewRespPromise = page.waitForResponse((resp) => {
              const req = resp.request();
              return req.method() === 'POST' && /\/manual-hotspot\/preview$/i.test(resp.url());
            }, { timeout: 20000 }).catch(() => null);

            await clickPreviewForHotspot(dialog, candidateHotspot);

            const previewResp = await previewRespPromise;
            if (previewResp) {
              const previewPayload = await previewResp.json().catch(() => null);
              dayResult.previewApiStatus = previewResp.status();
              dayResult.previewApiCode = previewPayload?.code || null;
              dayResult.selectedHotspotId = findHotspotIdInTimeline(
                Array.isArray(previewPayload?.routeTimeline)
                  ? previewPayload.routeTimeline
                  : (Array.isArray(previewPayload?.fullTimeline) ? previewPayload.fullTimeline : []),
                candidateHotspot,
              );
              dayResult.previewApiOk = (
                previewResp.ok()
                || previewPayload?.success === true
                || String(previewPayload?.code || '').toUpperCase().includes('SUCCESS')
                || String(previewPayload?.code || '').toUpperCase().includes('PREVIEW')
              );
            } else {
              dayResult.previewApiOk = false;
            }

            const applyRespPromise = page.waitForResponse((resp) => {
              const req = resp.request();
              return req.method() === 'POST'
                && /\/manual-hotspots?\/(apply)?/i.test(resp.url())
                && !/\/manual-hotspot\/preview$/i.test(resp.url());
            }, { timeout: 25000 }).catch(() => null);

            dayResult.confirmLabel = await clickConfirmAdd(dialog);

            const applyResp = await applyRespPromise;
            if (applyResp) {
              const applyPayload = await applyResp.json().catch(() => null);
              dayResult.applyApiStatus = applyResp.status();
              dayResult.applyApiCode = applyPayload?.code || null;
              dayResult.applyApiUrl = applyResp.url();
              dayResult.applyApiSuccessField = applyPayload?.success === true;
              const applyTimeline = Array.isArray(applyPayload?.routeTimeline)
                ? applyPayload.routeTimeline
                : (Array.isArray(applyPayload?.fullTimeline) ? applyPayload.fullTimeline : []);
              dayResult.addedInApplyTimeline = timelineContainsHotspot(
                applyTimeline,
                candidateHotspot,
                dayResult.selectedHotspotId,
              );
              dayResult.applyApiOk = applyResp.ok() || applyPayload?.success === true;
            } else {
              dayResult.applyApiOk = false;
            }

            if (dayResult.applyApiOk) {
              attemptError = null;
              break;
            }

            attemptError = 'Apply API did not report success';
          } catch (innerErr) {
            attemptError = innerErr?.message || String(innerErr);
          }
        }

        if (!dayResult.applyApiOk) {
          throw new Error(attemptError || 'Could not add hotspot after multiple random attempts');
        }

        await page.waitForTimeout(2200);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        const refreshedDayRoot = page.locator(`#itinerary-day-${day}`).first();
        await refreshedDayRoot.waitFor({ state: 'visible', timeout: 30000 });
        const dayText = ((await refreshedDayRoot.innerText().catch(() => '')) || '').toLowerCase();
        dayResult.addedVisibleAfterReload = dayText.includes(normalizeName(dayResult.selectedHotspot || ''));

        if (dayResult.routeId && dayResult.selectedHotspotId) {
          const dbRows = await prisma.$queryRawUnsafe(`
            SELECT COUNT(*) AS c
            FROM dvi_itinerary_route_hotspot_details
            WHERE itinerary_plan_ID = ?
              AND itinerary_route_ID = ?
              AND hotspot_ID = ?
              AND item_type = 4
              AND deleted = 0
          `, latestPlanId, Number(dayResult.routeId), Number(dayResult.selectedHotspotId));
          dayResult.dbInsertedCount = Number(dbRows?.[0]?.c || 0);
          dayResult.dbInserted = dayResult.dbInsertedCount > 0;
        } else if (dayResult.routeId && dayResult.selectedHotspot) {
          const dbRowsByName = await prisma.$queryRawUnsafe(`
            SELECT COUNT(*) AS c
            FROM dvi_itinerary_route_hotspot_details h
            LEFT JOIN dvi_hotspot_place p ON p.hotspot_ID = h.hotspot_ID
            WHERE h.itinerary_plan_ID = ?
              AND h.itinerary_route_ID = ?
              AND h.item_type = 4
              AND h.deleted = 0
              AND LOWER(p.hotspot_name) = LOWER(?)
          `, latestPlanId, Number(dayResult.routeId), decodeHtmlEntities(dayResult.selectedHotspot));
          dayResult.dbInsertedCount = Number(dbRowsByName?.[0]?.c || 0);
          dayResult.dbInserted = dayResult.dbInsertedCount > 0;
        }

        usedHotspotNames.add(normalizeName(dayResult.selectedHotspot));

        dayResult.status = (
          dayResult.previewApiOk
          && dayResult.applyApiOk
          && (dayResult.addedInApplyTimeline || dayResult.dbInserted || dayResult.addedVisibleAfterReload)
        )
          ? 'passed'
          : 'failed';
      } catch (e) {
        dayResult.error = e?.message || String(e);
        dayResult.status = 'failed';
      }

      result.days.push(dayResult);
    }

    result.ok = result.days.every((d) => d.status === 'passed');
    result.matrix = result.days.map((d) => ({
      day: d.day,
      routeId: d.routeId,
      hotspot: d.selectedHotspot,
      hotspotId: d.selectedHotspotId,
      previewOk: d.previewApiOk,
      applyOk: d.applyApiOk,
      applyCode: d.applyApiCode,
      applyTimelineHasHotspot: d.addedInApplyTimeline,
      dbInserted: d.dbInserted,
      dbInsertedCount: d.dbInsertedCount,
      uiVisible: d.addedVisibleAfterReload,
      status: d.status,
    }));

    console.log(JSON.stringify(result, null, 2));

    if (!result.ok) {
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await browser.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('RANDOM_HOTSPOT_TEST_FAILED');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
