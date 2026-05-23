#!/usr/bin/env node
/*
  Playwright-assisted hotspot add verification for day 1/2/3.
  Applies via backend endpoint with correct payload, verifies in DB and UI via Playwright.

  Usage:
    node scripts/test-hotspot-add-playwright-assisted.js --quote DVI20260589
*/

function parseArgs(argv) {
  const out = { quote: 'DVI20260589' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--quote' && argv[i + 1]) {
      out.quote = String(argv[i + 1]).trim();
      i += 1;
    }
  }
  return out;
}

function normalize(v) {
  return String(v || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function ensureLoggedIn(page, itineraryUrl, email, password) {
  const signInButton = page.getByRole('button', { name: /sign in|login/i }).first();

  const isAtLogin = async () => {
    if (/\/signin|\/login/i.test(page.url())) return true;
    const hasEmail = await page.locator('input[type="email"], input[name="email"]').first().isVisible().catch(() => false);
    const hasPassword = await page.locator('input[type="password"], input[name="password"]').first().isVisible().catch(() => false);
    const hasSignIn = await signInButton.isVisible().catch(() => false);
    return (hasEmail && hasPassword) || hasSignIn;
  };

  const resolveInputs = async () => {
    const byType = page.locator('input[type="email"]').first();
    if (await byType.isVisible().catch(() => false)) {
      return { emailInput: byType, passwordInput: page.locator('input[type="password"]').first() };
    }

    const byLabelEmail = page.getByLabel(/email/i).first();
    const byLabelPassword = page.getByLabel(/password/i).first();
    if (
      await byLabelEmail.isVisible().catch(() => false) &&
      await byLabelPassword.isVisible().catch(() => false)
    ) {
      return { emailInput: byLabelEmail, passwordInput: byLabelPassword };
    }

    const visibleInputs = page.locator('input:visible');
    const count = await visibleInputs.count();
    if (count >= 2) {
      return { emailInput: visibleInputs.nth(0), passwordInput: visibleInputs.nth(1) };
    }

    throw new Error('Unable to resolve login inputs');
  };

  await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!(await isAtLogin())) return;

  const { emailInput, passwordInput } = await resolveInputs();
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await signInButton.click();
  await page.waitForTimeout(1500);

  if (await isAtLogin()) {
    throw new Error('Login failed. Check credentials.');
  }

  await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

async function loginToken(apiBase, email, password) {
  const resp = await fetch(`${apiBase.replace(/\/$/, '')}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const payload = await resp.json().catch(() => null);
  const token = payload?.data?.accessToken || payload?.accessToken || null;
  if (!token) throw new Error(`Auth token missing. status=${resp.status}`);
  return token;
}

async function run() {
  const args = parseArgs(process.argv);
  const baseUrl = String(process.env.DVI_BASE_URL || 'http://localhost:8080').trim();
  const apiBase = String(process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1').trim();
  const email = String(process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.DVI_PASSWORD || 'Keerthi@2404ias').trim();

  const { chromium } = require('playwright');
  const { PrismaClient } = require('@prisma/client');

  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const result = {
    ok: false,
    mode: 'playwright-assisted',
    quote: args.quote,
    latestPlanId: null,
    days: [],
    matrix: [],
  };

  try {
    const itineraryUrl = `${baseUrl.replace(/\/$/, '')}/itinerary-details/${encodeURIComponent(args.quote)}`;
    await ensureLoggedIn(page, itineraryUrl, email, password);
    const token = await loginToken(apiBase, email, password);

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

    for (const day of [1, 2, 3]) {
      const row = {
        day,
        routeId: routeIds[day - 1] || null,
        hotspotId: null,
        hotspotName: null,
        previewStatus: null,
        previewCode: null,
        previewOk: false,
        applyStatus: null,
        applyCode: null,
        applyOk: false,
        dbInsertedCount: 0,
        dbInserted: false,
        uiVisible: false,
        status: 'failed',
        error: null,
      };

      try {
        if (!row.routeId) throw new Error('Missing route id');

        const candidateRows = await prisma.$queryRawUnsafe(`
          SELECT h.hotspot_ID, p.hotspot_name, h.route_hotspot_ID
          FROM dvi_itinerary_route_hotspot_details h
          LEFT JOIN dvi_hotspot_place p ON p.hotspot_ID = h.hotspot_ID
          WHERE h.itinerary_plan_ID = ?
            AND h.itinerary_route_ID = ?
            AND h.item_type = 4
            AND h.deleted = 0
          ORDER BY h.hotspot_order DESC, h.route_hotspot_ID DESC
          LIMIT 10
        `, planId, Number(row.routeId));

        const selected = (Array.isArray(candidateRows) ? candidateRows : []).find((c) => Number(c?.hotspot_ID || 0) > 0);
        if (!selected) throw new Error('No route hotspot candidate found');

        row.hotspotId = Number(selected.hotspot_ID);
        row.hotspotName = String(selected.hotspot_name || '').trim();

        const existingRows = await prisma.$queryRawUnsafe(`
          SELECT route_hotspot_ID
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ?
            AND itinerary_route_ID = ?
            AND hotspot_ID = ?
            AND item_type = 4
            AND deleted = 0
        `, planId, Number(row.routeId), Number(row.hotspotId));

        const ids = (Array.isArray(existingRows) ? existingRows : [])
          .map((r) => Number(r?.route_hotspot_ID || 0))
          .filter((n) => Number.isFinite(n) && n > 0);

        if (ids.length > 0) {
          await prisma.$queryRawUnsafe(`
            DELETE FROM dvi_itinerary_route_activity_details
            WHERE itinerary_plan_ID = ?
              AND itinerary_route_ID = ?
              AND route_hotspot_ID IN (${ids.join(',')})
          `, planId, Number(row.routeId));

          await prisma.$queryRawUnsafe(`
            DELETE FROM dvi_itinerary_route_hotspot_details
            WHERE itinerary_plan_ID = ?
              AND itinerary_route_ID = ?
              AND hotspot_ID = ?
              AND item_type = 4
              AND deleted = 0
          `, planId, Number(row.routeId), Number(row.hotspotId));
        }

        const previewResp = await fetch(`${apiBase.replace(/\/$/, '')}/itineraries/${planId}/manual-hotspot/preview`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ routeId: row.routeId, hotspotId: row.hotspotId }),
        });
        const previewPayload = await previewResp.json().catch(() => null);
        row.previewStatus = previewResp.status;
        row.previewCode = previewPayload?.code || null;
        row.previewOk = previewResp.ok || previewPayload?.success === true || !!previewPayload?.code;

        const applyResp = await fetch(`${apiBase.replace(/\/$/, '')}/itineraries/${planId}/manual-hotspots/apply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            routeId: row.routeId,
            hotspotIds: [row.hotspotId],
            forceConflictInsertion: true,
          }),
        });
        const applyPayload = await applyResp.json().catch(() => null);
        row.applyStatus = applyResp.status;
        row.applyCode = applyPayload?.code || null;
        row.applyOk = applyResp.ok || applyPayload?.success === true;

        const dbRows = await prisma.$queryRawUnsafe(`
          SELECT COUNT(*) AS c
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ?
            AND itinerary_route_ID = ?
            AND hotspot_ID = ?
            AND item_type = 4
            AND deleted = 0
        `, planId, Number(row.routeId), Number(row.hotspotId));
        row.dbInsertedCount = Number(dbRows?.[0]?.c || 0);
        row.dbInserted = row.dbInsertedCount > 0;

        await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const dayRoot = page.locator(`#itinerary-day-${day}`).first();
        await dayRoot.waitFor({ state: 'visible', timeout: 30000 });
        const dayText = normalize(await dayRoot.innerText().catch(() => ''));
        row.uiVisible = dayText.includes(normalize(row.hotspotName));

        row.status = (row.previewOk && row.applyOk && row.dbInserted && row.uiVisible) ? 'passed' : 'failed';
      } catch (e) {
        row.error = e?.message || String(e);
      }

      result.days.push(row);
    }

    result.ok = result.days.every((d) => d.status === 'passed');
    result.matrix = result.days.map((d) => ({
      day: d.day,
      routeId: d.routeId,
      hotspotId: d.hotspotId,
      hotspotName: d.hotspotName,
      previewOk: d.previewOk,
      previewCode: d.previewCode,
      applyOk: d.applyOk,
      applyCode: d.applyCode,
      dbInserted: d.dbInserted,
      dbInsertedCount: d.dbInsertedCount,
      uiVisible: d.uiVisible,
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
  console.error('PLAYWRIGHT_ASSISTED_FAILED');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
