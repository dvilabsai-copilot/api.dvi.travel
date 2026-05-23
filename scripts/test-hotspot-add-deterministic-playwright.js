#!/usr/bin/env node
/*
  Deterministic Playwright hotspot add test for day 1/2/3.
  Chooses actually-clickable Preview actions from the modal.

  Usage:
    node scripts/test-hotspot-add-deterministic-playwright.js --quote DVI20260589

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

function normalize(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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

async function collectHotspotCandidates(dialog) {
  return dialog.evaluate((el) => {
    const norm = (v) => String(v || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();

    const findCard = (node) => {
      let cur = node;
      for (let i = 0; i < 8 && cur; i += 1) {
        if (cur.querySelector && cur.querySelector('button, [role="button"]')) return cur;
        cur = cur.parentElement;
      }
      return null;
    };

    const headingNodes = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-hotspot-name],strong,b'));
    const seen = new Set();
    const out = [];

    for (const node of headingNodes) {
      const name = norm(node.textContent || '');
      if (!name || /^hotspot\s*list$/i.test(name)) continue;
      const card = findCard(node);
      if (!card) continue;

      const cardText = norm(card.textContent || '').toLowerCase();
      const closed = /\bclosed\b/i.test(cardText);
      const added = /\badded\b/i.test(cardText);

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, closed, added });
    }

    return out;
  });
}

async function clickHotspotCardByName(dialog, hotspotName) {
  const ok = await dialog.evaluate((el, rawName) => {
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

    const findCard = (node) => {
      let cur = node;
      for (let i = 0; i < 10 && cur; i += 1) {
        if (cur.querySelector && cur.querySelector('button, [role="button"]')) return cur;
        cur = cur.parentElement;
      }
      return null;
    };

    const nodes = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-hotspot-name],strong,b'));
    for (const node of nodes) {
      const nodeName = norm(node.textContent || '');
      if (!nodeName || !(nodeName.includes(target) || target.includes(nodeName))) continue;
      const card = findCard(node);
      if (!card) continue;

      // Select hotspot by clicking both title and container to ensure selection state updates.
      if (node instanceof HTMLElement) {
        node.click();
      } else {
        card.click();
      }
      if (card instanceof HTMLElement) {
        card.click();
      }

      // Optionally click media icon if present to trigger preview-like evaluation.
      const mediaBtns = Array.from(card.querySelectorAll('button[title*="Images" i], button[title*="Video" i], [role="button"][title*="Images" i], [role="button"][title*="Video" i]'));
      for (const mediaBtn of mediaBtns.slice(0, 1)) {
        mediaBtn.click();
      }
      return true;
    }

    return false;
  }, hotspotName);

  if (!ok) throw new Error(`Hotspot card not found for hotspot: ${hotspotName}`);
}

async function clickConfirm(dialog, page) {
  const rescheduleButton = dialog.getByRole('button', { name: /confirm reschedule/i }).first();
  if (await rescheduleButton.isVisible().catch(() => false)) {
    if (!(await rescheduleButton.isDisabled().catch(() => true))) {
      await rescheduleButton.click({ timeout: 10000 });
      await page.waitForTimeout(1200);
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
      if (await btn.isDisabled().catch(() => true)) continue;
      const label = (await btn.innerText().catch(() => '')) || '';
      await btn.click({ timeout: 10000 });
      return label;
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
    ({ PrismaClient } = require('@prisma/client'));
  } catch (e) {
    console.error(e?.message || String(e));
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const result = {
    ok: false,
    mode: 'deterministic-ui',
    quote: args.quote,
    latestPlanId: null,
    days: [],
    matrix: [],
  };

  try {
    const itineraryUrl = `${baseUrl.replace(/\/$/, '')}/itinerary-details/${encodeURIComponent(args.quote)}`;
    await ensureLoggedInAndOpenItinerary({ page, itineraryUrl, email, password });

    const planRows = await prisma.$queryRawUnsafe(`
      SELECT itinerary_plan_ID
      FROM dvi_itinerary_plan_details
      WHERE itinerary_quote_ID = ?
      ORDER BY itinerary_plan_ID DESC
      LIMIT 1
    `, args.quote);

    const planId = Number(planRows?.[0]?.itinerary_plan_ID || 0) || null;
    result.latestPlanId = planId;
    if (!planId) throw new Error('No plan found');

    const routeRows = await prisma.$queryRawUnsafe(`
      SELECT itinerary_route_ID
      FROM dvi_itinerary_route_details
      WHERE itinerary_plan_ID = ? AND status = 1 AND deleted = 0
      ORDER BY itinerary_route_date ASC, itinerary_route_ID ASC
    `, planId);

    const routeIds = (Array.isArray(routeRows) ? routeRows : []).map((r) => Number(r?.itinerary_route_ID || 0));
    const used = new Set();

    for (const day of [1, 2, 3]) {
      const dayResult = {
        day,
        routeId: routeIds[day - 1] || null,
        selectedHotspot: null,
        selectedHotspotId: null,
        previewApiStatus: null,
        previewApiCode: null,
        previewApiOk: false,
        confirmLabel: null,
        applyApiStatus: null,
        applyApiCode: null,
        applyApiOk: false,
        dbInsertedCount: 0,
        dbInserted: false,
        uiVisibleAfterReload: false,
        status: 'failed',
        error: null,
      };

      try {
        // Fetch candidates once from a fresh modal.
        await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const dayRootInit = page.locator(`#itinerary-day-${day}`).first();
        await dayRootInit.waitFor({ state: 'visible', timeout: 30000 });
        await dayRootInit.getByRole('button', { name: /add hotspot/i }).first().click({ timeout: 10000 });
        const initDialog = page.locator('[role="dialog"]').first();
        await initDialog.waitFor({ state: 'visible', timeout: 15000 });

        const candidatesRaw = await collectHotspotCandidates(initDialog);
        await page.keyboard.press('Escape').catch(() => {});

        const candidates = (Array.isArray(candidatesRaw) ? candidatesRaw : [])
          .filter((c) => String(c?.name || '').trim().length > 0)
          .filter((c) => !/^hotspot\s*list$/i.test(String(c?.name || '')))
          .filter((c) => !used.has(normalize(c?.name || '')))
          .slice(0, 6);

        if (candidates.length === 0) throw new Error('No usable hotspot candidates found for day');

        let success = false;
        let lastError = null;

        for (const candidate of candidates) {
          const candidateName = String(candidate?.name || '').trim();
          dayResult.selectedHotspot = candidateName;

          try {
            const hotspotIdRows = await prisma.$queryRawUnsafe(`
              SELECT hotspot_ID
              FROM dvi_hotspot_place
              WHERE LOWER(hotspot_name) = LOWER(?)
              LIMIT 1
            `, candidateName);
            const candidateHotspotId = Number(hotspotIdRows?.[0]?.hotspot_ID || 0) || null;
            dayResult.selectedHotspotId = candidateHotspotId;

            let beforeCount = 0;
            if (dayResult.routeId && candidateHotspotId) {
              const existingRows = await prisma.$queryRawUnsafe(`
                SELECT route_hotspot_ID
                FROM dvi_itinerary_route_hotspot_details
                WHERE itinerary_plan_ID = ?
                  AND itinerary_route_ID = ?
                  AND hotspot_ID = ?
                  AND item_type = 4
                  AND deleted = 0
              `, planId, Number(dayResult.routeId), Number(candidateHotspotId));

              const existingIds = (Array.isArray(existingRows) ? existingRows : [])
                .map((r) => Number(r?.route_hotspot_ID || 0))
                .filter((id) => Number.isFinite(id) && id > 0);

              beforeCount = existingIds.length;

              // To validate "add more" deterministically, clear an already-added row first.
              if (existingIds.length > 0) {
                await prisma.$queryRawUnsafe(`
                  DELETE FROM dvi_itinerary_route_activity_details
                  WHERE itinerary_plan_ID = ?
                    AND itinerary_route_ID = ?
                    AND route_hotspot_ID IN (${existingIds.join(',')})
                `, planId, Number(dayResult.routeId));

                await prisma.$queryRawUnsafe(`
                  DELETE FROM dvi_itinerary_route_hotspot_details
                  WHERE itinerary_plan_ID = ?
                    AND itinerary_route_ID = ?
                    AND hotspot_ID = ?
                    AND item_type = 4
                    AND deleted = 0
                `, planId, Number(dayResult.routeId), Number(candidateHotspotId));

                beforeCount = 0;
              }
            }

            await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const dayRoot = page.locator(`#itinerary-day-${day}`).first();
            await dayRoot.waitFor({ state: 'visible', timeout: 30000 });
            await dayRoot.getByRole('button', { name: /add hotspot/i }).first().click({ timeout: 10000 });
            const dialog = page.locator('[role="dialog"]').first();
            await dialog.waitFor({ state: 'visible', timeout: 15000 });

            const previewRespPromise = page.waitForResponse((resp) => {
              const req = resp.request();
              return req.method() === 'POST' && /\/manual-hotspot\/preview$/i.test(resp.url());
            }, { timeout: 12000 }).catch(() => null);

            await clickHotspotCardByName(dialog, candidateName);
            await page.waitForTimeout(1000);

            const previewResp = await previewRespPromise;
            if (previewResp) {
              const previewPayload = await previewResp.json().catch(() => null);
              dayResult.previewApiStatus = previewResp.status();
              dayResult.previewApiCode = previewPayload?.code || null;
              dayResult.previewApiOk = previewResp.ok() || previewPayload?.success === true || !!previewPayload?.code;
            } else {
              dayResult.previewApiStatus = null;
              dayResult.previewApiCode = null;
              dayResult.previewApiOk = false;
            }

            const applyRespPromise = page.waitForResponse((resp) => {
              const req = resp.request();
              return req.method() === 'POST'
                && /\/manual-hotspots?\/(apply)?/i.test(resp.url())
                && !/\/manual-hotspot\/preview$/i.test(resp.url());
            }, { timeout: 15000 }).catch(() => null);

            dayResult.confirmLabel = await clickConfirm(dialog, page);

            const applyResp = await applyRespPromise;
            if (!applyResp) {
              throw new Error(`Apply API response not captured for ${candidateName}`);
            }

            const applyReq = applyResp.request();
            const applyPost = applyReq.postDataJSON ? applyReq.postDataJSON() : null;
            const applyPayload = await applyResp.json().catch(() => null);
            dayResult.applyApiStatus = applyResp.status();
            dayResult.applyApiCode = applyPayload?.code || null;
            dayResult.applyApiOk = applyResp.ok() || applyPayload?.success === true;
            if (!dayResult.selectedHotspotId && Number(applyPost?.hotspotId || 0) > 0) {
              dayResult.selectedHotspotId = Number(applyPost.hotspotId);
            }

            await page.waitForTimeout(1800);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            const refreshed = page.locator(`#itinerary-day-${day}`).first();
            await refreshed.waitFor({ state: 'visible', timeout: 30000 });

            const dayText = normalize(await refreshed.innerText().catch(() => ''));
            dayResult.uiVisibleAfterReload = dayText.includes(normalize(candidateName));

            let afterCount = beforeCount;
            if (dayResult.routeId && dayResult.selectedHotspotId) {
              const afterRows = await prisma.$queryRawUnsafe(`
                SELECT COUNT(*) AS c
                FROM dvi_itinerary_route_hotspot_details
                WHERE itinerary_plan_ID = ?
                  AND itinerary_route_ID = ?
                  AND hotspot_ID = ?
                  AND item_type = 4
                  AND deleted = 0
              `, planId, Number(dayResult.routeId), Number(dayResult.selectedHotspotId));

              afterCount = Number(afterRows?.[0]?.c || 0);
              dayResult.dbInsertedCount = afterCount;
              dayResult.dbInserted = afterCount > beforeCount;
            }

            if (dayResult.applyApiOk && (dayResult.dbInserted || dayResult.uiVisibleAfterReload)) {
              success = true;
              used.add(normalize(candidateName));
              break;
            }

            lastError = `candidate ${candidateName} did not persist (before=${beforeCount}, after=${afterCount})`;
          } catch (innerErr) {
            lastError = innerErr?.message || String(innerErr);
          }
        }

        if (!success) {
          throw new Error(lastError || 'No hotspot candidate produced successful add');
        }

        dayResult.status = 'passed';
      } catch (e) {
        dayResult.error = e?.message || String(e);
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
      previewCode: d.previewApiCode,
      applyOk: d.applyApiOk,
      applyCode: d.applyApiCode,
      dbInserted: d.dbInserted,
      dbCount: d.dbInsertedCount,
      uiVisible: d.uiVisibleAfterReload,
      status: d.status,
    }));

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
    await browser.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('DETERMINISTIC_TEST_FAILED');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
