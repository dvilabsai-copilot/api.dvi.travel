#!/usr/bin/env node
/*
  Headed diagnostics for Add Hotspot modal (days 1-3).

  Usage:
    node scripts/diagnose-hotspot-modal-playwright.js --quote DVI20260589
*/

const fs = require('fs');
const path = require('path');

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

async function ensureLogin(page, itineraryUrl, email, password) {
  const signIn = page.getByRole('button', { name: /sign in|login/i }).first();
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

    throw new Error('Unable to locate login inputs in diagnostics script.');
  };
  const atLogin = async () => {
    if (/\/login|\/signin/i.test(page.url())) return true;
    return await signIn.isVisible().catch(() => false);
  };

  await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!(await atLogin())) return;

  const { emailInput, passwordInput } = await resolveInputs();
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await signIn.click();
  await page.waitForTimeout(1600);

  if (await atLogin()) throw new Error('Login failed for diagnostics');
  await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

async function run() {
  const args = parseArgs(process.argv);
  const baseUrl = String(process.env.DVI_BASE_URL || 'http://localhost:8080').trim();
  const email = String(process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.DVI_PASSWORD || 'Keerthi@2404ias').trim();

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const report = {
    quote: args.quote,
    mode: 'headed-diagnostics',
    days: [],
  };

  try {
    const itineraryUrl = `${baseUrl.replace(/\/$/, '')}/itinerary-details/${encodeURIComponent(args.quote)}`;
    await ensureLogin(page, itineraryUrl, email, password);

    for (const day of [1, 2, 3]) {
      const row = {
        day,
        modalVisible: false,
        buttonTexts: [],
        previewButtons: [],
        topCards: [],
        screenshot: null,
        error: null,
      };

      try {
        await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const dayRoot = page.locator(`#itinerary-day-${day}`).first();
        await dayRoot.waitFor({ state: 'visible', timeout: 30000 });
        await dayRoot.getByRole('button', { name: /add hotspot/i }).first().click({ timeout: 10000 });

        const dialog = page.locator('[role="dialog"]').first();
        await dialog.waitFor({ state: 'visible', timeout: 15000 });
        row.modalVisible = true;

        row.buttonTexts = (await dialog.locator('button, [role="button"]').allInnerTexts().catch(() => []))
          .map((v) => String(v || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 80);

        const extracted = await dialog.evaluate((el) => {
          const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
          const btns = Array.from(el.querySelectorAll('button, [role="button"]'));

          const previewButtons = [];
          for (const b of btns) {
            const txt = norm(b.textContent || '').toLowerCase();
            const aria = norm(b.getAttribute('aria-label') || '').toLowerCase();
            const title = norm(b.getAttribute('title') || '').toLowerCase();
            const combined = `${txt} ${aria} ${title}`;
            if (combined.includes('preview') || combined.includes('view')) {
              previewButtons.push({ text: norm(b.textContent || ''), aria: norm(b.getAttribute('aria-label') || ''), title: norm(b.getAttribute('title') || '') });
            }
          }

          const cards = [];
          const cardNodes = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-hotspot-name],strong,b')).slice(0, 30);
          for (const n of cardNodes) {
            const t = norm(n.textContent || '');
            if (t) cards.push(t);
          }

          return { previewButtons, cards };
        });

        row.previewButtons = extracted.previewButtons || [];
        row.topCards = (extracted.cards || []).slice(0, 20);

        const outDir = path.join(process.cwd(), 'tmp');
        fs.mkdirSync(outDir, { recursive: true });
        const shotPath = path.join(outDir, `diag-hotspot-modal-day${day}-${Date.now()}.png`);
        await page.screenshot({ path: shotPath, fullPage: true });
        row.screenshot = shotPath;
      } catch (e) {
        row.error = e?.message || String(e);
      }

      report.days.push(row);
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('DIAG_FAILED');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
