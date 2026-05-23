#!/usr/bin/env node
/*
  Verify destination-side hotspot->hotel mapping behavior end-to-end:
  1) Open itinerary details page
  2) Preview a hotspot in Add Hotspot modal
  3) Capture decision lines
  4) Query DB for hotspot_hotel_between_map existence + rows

  Usage:
    node scripts/verify-hotspot-hotel-between-playwright.js \
      --quote DVI20260589 \
      --hotspot "Lakkam Waterfalls" \
      --day 1

  Optional env vars:
    DVI_BASE_URL=http://localhost:8080
    DVI_EMAIL=admin@example.com
    DVI_PASSWORD=secret
    HEADLESS=false
*/

const path = require('path');
const readline = require('readline');

function parseArgs(argv) {
  const out = {
    quote: 'DVI20260589',
    hotspot: 'Lakkam Waterfalls',
    day: 1,
    allowNoConfirm: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const b = argv[i + 1];
    if (a === '--quote' && b) {
      out.quote = String(b).trim();
      i += 1;
    } else if (a === '--hotspot' && b) {
      out.hotspot = String(b).trim();
      i += 1;
    } else if (a === '--day' && b) {
      out.day = Math.max(1, Number(b) || 1);
      i += 1;
    } else if (a === '--allow-no-confirm') {
      out.allowNoConfirm = true;
    }
  }

  return out;
}

function pickDecisionLines(lines) {
  return lines.filter((l) =>
    /off-route|backtracking|Attempted insertion slot|Insert after reaching|Will not be inserted|Could not schedule|MUNNAR QUEEN|Hotel|Proposed arrival|Planned stay|leave around|Then travel to/i.test(l)
  );
}

function parseTime12ToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hh = Number(match[1]);
  const mm = Number(match[2]);
  const ap = String(match[3]).toUpperCase();
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  hh = hh % 12;
  if (ap === 'PM') hh += 12;
  return hh * 60 + mm;
}

function extractHotspotPreviewTimeRange(lines, hotspotName) {
  const safeLines = Array.isArray(lines) ? lines.map((line) => String(line || '').trim()) : [];
  const target = String(hotspotName || '').trim().toLowerCase();
  const timeRangePattern = /\d{1,2}:\d{2}\s*(AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(AM|PM)/i;

  for (let i = 0; i < safeLines.length; i += 1) {
    if (!safeLines[i].toLowerCase().includes(target)) continue;

    for (let j = i + 1; j < Math.min(safeLines.length, i + 8); j += 1) {
      if (timeRangePattern.test(safeLines[j])) {
        return safeLines[j];
      }
    }
  }

  return null;
}

function parseTimeRangeMinutes(rangeValue) {
  const rangeText = String(rangeValue || '').trim();
  if (!rangeText.includes('-')) return null;

  const [startText, endText] = rangeText.split('-').map((part) => String(part || '').trim());
  const startMinutes = parseTime12ToMinutes(startText);
  const endMinutes = parseTime12ToMinutes(endText);
  if (startMinutes == null || endMinutes == null) return null;

  return endMinutes >= startMinutes
    ? (endMinutes - startMinutes)
    : ((24 * 60) - startMinutes + endMinutes);
}

function extractTimelineRowByHotspot(timeline, hotspotName, hotspotId) {
  const targetName = String(hotspotName || '').trim().toLowerCase();
  const targetId = Number(hotspotId || 0);
  const rows = Array.isArray(timeline) ? timeline : [];

  for (const row of rows) {
    const rowHotspotId = Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0);
    const rowText = String(row?.text || row?.name || row?.displayLabel || row?.toName || row?.fromName || '').trim().toLowerCase();
    if (targetId > 0 && rowHotspotId === targetId) return row;
    if (targetName && rowText.includes(targetName)) return row;
  }

  return null;
}

function collectConflictTimingConsistency(lines) {
  const safeLines = Array.isArray(lines) ? lines.map((line) => String(line || '').trim()) : [];
  const leaveLine = safeLines.find((line) => /leave around\s+\d{1,2}:\d{2}\s*(AM|PM)/i.test(line)) || null;
  const thenTravelLine = safeLines.find((line) => /then travel to\s+.+\(\d{1,2}:\d{2}\s*(AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(AM|PM)\)/i.test(line)) || null;

  const leaveMatch = leaveLine ? leaveLine.match(/leave around\s+(\d{1,2}:\d{2}\s*(AM|PM))/i) : null;
  const travelMatch = thenTravelLine ? thenTravelLine.match(/\((\d{1,2}:\d{2}\s*(AM|PM))\s*-/i) : null;

  const leaveAround = leaveMatch ? leaveMatch[1] : null;
  const travelStart = travelMatch ? travelMatch[1] : null;
  const leaveMin = leaveAround ? parseTime12ToMinutes(leaveAround) : null;
  const travelStartMin = travelStart ? parseTime12ToMinutes(travelStart) : null;

  const travelStartsBeforeLeave = (
    leaveMin != null
    && travelStartMin != null
    && travelStartMin < leaveMin
  );

  return {
    leaveLine,
    thenTravelLine,
    leaveAround,
    travelStart,
    travelStartsBeforeLeave,
  };
}

function collectHotelTravelDiagnostics(lines, hotelName) {
  const target = String(hotelName || '').trim().toLowerCase();
  const travelRows = [];
  const routeLegBlocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '').trim();
    const lower = line.toLowerCase();
    const isTravelToHotel = lower.includes('travel to') && (!target || lower.includes(target));
    if (isTravelToHotel) {
      const timeCandidate = String(lines[i - 1] || '').trim();
      const timeRange = /\d{1,2}:\d{2}\s*(AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(AM|PM)/i.test(timeCandidate)
        ? timeCandidate
        : null;
      travelRows.push({ timeRange, text: line });
    }

    if (lower.startsWith('route leg:')) {
      const distanceLine = String(lines[i + 1] || '').trim();
      const durationLine = String(lines[i + 2] || '').trim();
      routeLegBlocks.push({
        routeLeg: line,
        distance: /^distance:/i.test(distanceLine) ? distanceLine : null,
        duration: /^duration:/i.test(durationLine) ? durationLine : null,
      });
    }
  }

  return {
    travelRows,
    routeLegBlocks,
    travelRowCount: travelRows.length,
  };
}

function collectMatchingLines(lines, matcher) {
  return lines
    .map((line) => String(line || '').trim())
    .filter((line) => matcher.test(line));
}

function collectMatchContexts(lines, matcher, radius = 2) {
  const src = Array.isArray(lines) ? lines.map((line) => String(line || '').trim()) : [];
  const contexts = [];
  for (let i = 0; i < src.length; i += 1) {
    if (!matcher.test(src[i])) continue;
    const start = Math.max(0, i - radius);
    const end = Math.min(src.length - 1, i + radius);
    contexts.push({
      index: i,
      line: src[i],
      context: src.slice(start, end + 1),
    });
  }
  return contexts;
}

function normalizeTextForCompare(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHotspotRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      itinerary_route_ID: Number(r?.itinerary_route_ID || 0),
      hotspot_ID: Number(r?.hotspot_ID || 0),
      item_type: Number(r?.item_type || 0),
      hotspot_order: Number(r?.hotspot_order || 0),
      hotspot_plan_own_way: Number(r?.hotspot_plan_own_way || 0),
      hotspot_start_time: r?.hotspot_start_time ? new Date(r.hotspot_start_time).toISOString() : null,
      hotspot_end_time: r?.hotspot_end_time ? new Date(r.hotspot_end_time).toISOString() : null,
      hotspot_traveling_time: r?.hotspot_traveling_time == null ? null : String(r.hotspot_traveling_time),
      hotspot_travelling_distance: r?.hotspot_travelling_distance == null ? null : String(r.hotspot_travelling_distance),
      deleted: Number(r?.deleted || 0),
      status: Number(r?.status || 0),
    }))
    .sort((a, b) => {
      if (a.hotspot_order !== b.hotspot_order) return a.hotspot_order - b.hotspot_order;
      if (a.item_type !== b.item_type) return a.item_type - b.item_type;
      if (a.hotspot_ID !== b.hotspot_ID) return a.hotspot_ID - b.hotspot_ID;
      const aStart = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
      const bStart = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
      return aStart - bStart;
    });
}

async function maybeClickRebuildRoute(page, day) {
  const dayRoot = page.locator(`#itinerary-day-${day}`).first();
  if (!(await dayRoot.isVisible().catch(() => false))) {
    return { clicked: false, reason: 'day-not-found' };
  }

  const rebuildBtn = dayRoot.getByRole('button', { name: /rebuild route/i }).first();
  if (!(await rebuildBtn.isVisible().catch(() => false))) {
    return { clicked: false, reason: 'button-not-visible' };
  }

  await rebuildBtn.click({ timeout: 10000 });

  const toastLike = page.locator('text=/route rebuilt successfully|rebuild/i').first();
  await toastLike.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2200);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  return { clicked: true, reason: 'clicked' };
}

function askEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function jsonStringifySafe(value, space = 0) {
  return JSON.stringify(
    value,
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    space,
  );
}

async function waitForItineraryDay(page, day, timeoutMs = 30000) {
  const selector = `#itinerary-day-${day}`;
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function ensureLoggedInAndOpenItinerary({ page, itineraryUrl, email, password }) {
  const signInButton = page.getByRole('button', { name: /sign in|login/i }).first();
  const candidatePasswords = [
    password,
    'Keerthi@2404ias',
    'Admin@123',
  ].map((v) => String(v || '').trim()).filter(Boolean);

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
  if (!(await isAtLogin())) {
    return;
  }

  if (!email || candidatePasswords.length === 0) {
    throw new Error('Login required. Set DVI_EMAIL and DVI_PASSWORD env vars.');
  }

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!(await isAtLogin())) {
      break;
    }

    for (const pwd of candidatePasswords) {
      const { emailInput, passwordInput } = await resolveLoginInputs();
      await emailInput.fill(email);
      await passwordInput.fill(pwd);
      await signInButton.click();
      await page.waitForTimeout(1500);

      if (!(await isAtLogin())) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        break;
      }
    }

    if (!(await isAtLogin())) {
      break;
    }

    await page.waitForTimeout(500);
  }

  if (await isAtLogin()) {
    throw new Error('Login failed. Set DVI_EMAIL and DVI_PASSWORD env values for your current credentials.');
  }

  await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

async function clickHotspotPreviewInDialog({ dialog, hotspotName }) {
  const escaped = String(hotspotName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hotspotTextRegex = new RegExp(escaped, 'i');

  const hotspotAnchor = dialog.getByText(hotspotTextRegex).first();
  await hotspotAnchor.waitFor({ state: 'visible', timeout: 15000 });
  await hotspotAnchor.scrollIntoViewIfNeeded();

  const card = hotspotAnchor.locator('xpath=ancestor::*[self::div or self::article][.//button][1]');
  const attempts = [
    card.getByRole('button', { name: /preview|view/i }).first(),
    card.locator('button[aria-label*="preview" i], button[title*="preview" i], [role="button"][aria-label*="preview" i], [role="button"][title*="preview" i]').first(),
    card.locator('button:has(svg), [role="button"]:has(svg)').first(),
    dialog.getByRole('button', { name: /preview|view/i }).first(),
  ];

  for (const candidate of attempts) {
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    await candidate.click({ timeout: 10000 });
    return;
  }

  throw new Error(`Could not locate Preview action for hotspot "${hotspotName}" in Add Hotspot dialog.`);
}

async function run() {
  const args = parseArgs(process.argv);
  const baseUrl = String(process.env.DVI_BASE_URL || 'http://localhost:8080').trim();
  const headless = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
  const email = String(process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.DVI_PASSWORD || 'Keerthi@2404ias').trim();

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('Missing dependency: playwright. Install with: npm i -D playwright');
    process.exit(1);
  }

  let PrismaClient;
  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch (e) {
    console.error('Missing dependency: @prisma/client');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const result = {
    input: {
      quote: args.quote,
      hotspot: args.hotspot,
      day: args.day,
      baseUrl,
    },
    ui: {
      decisionLines: [],
      hotelTravelDiagnostics: { travelRows: [], routeLegBlocks: [], travelRowCount: 0 },
      conflictTimingConsistency: {
        leaveLine: null,
        thenTravelLine: null,
        leaveAround: null,
        travelStart: null,
        travelStartsBeforeLeave: false,
      },
      staleTimeRangeDetected: false,
      staleTimeRangeMatches: [],
      staleTimeRangeContexts: [],
      pothameduPreviewTimeRange: null,
      pothameduPreviewDurationMinutes: null,
      pothameduPreviewDurationValid: false,
      pothameduPreviewHasStaleRange: false,
      modalOpened: false,
      hotspotPreviewClicked: false,
      previewIsolationRecovered: false,
      previewApiCode: null,
      rebuildRoute: { clicked: false, reason: '' },
      beforeDayTextExcerpt: '',
      afterPreviewDayTextExcerpt: '',
      afterDayTextExcerpt: '',
      afterConfirmDayTextExcerpt: '',
      timelineUnchangedAfterPreviewOnly: false,
      timelineChangedAfterConfirm: false,
      containsHotspotAfterConfirm: false,
      containsTravelToHotspotAfterConfirm: false,
      containsTravelToEravikulamAfterConfirm: false,
      finalHotelCheckinTime: null,
      finalHotelCheckinBefore8Pm: null,
      pothameduConfirmTimeRange: null,
      pothameduConfirmDurationMinutes: null,
      pothameduConfirmDurationValid: false,
      pothameduPersistedDurationMinutes: null,
      confirmClicked: false,
      confirmButtonLabel: null,
      confirmButtonCandidates: [],
      confirmAvailable: false,
      confirmDisabled: false,
      applyBlockedReason: null,
      confirmApiCode: null,
      finalUrl: '',
      title: '',
    },
    db: {
      tableExists: false,
      latestPlan: null,
      dayRoute: null,
      beforeRouteRows: [],
      afterPreviewRouteRows: [],
      afterRouteRows: [],
      afterConfirmRouteRows: [],
      routeRowsChangedWithoutConfirm: false,
      routeRowsChangedAfterConfirm: false,
      hotspotIdByName: null,
      routeHotspotCountBefore: null,
      routeHotspotCountAfterPreview: null,
      routeHotspotCountAfterConfirm: null,
      hotspotCountChangedWithoutConfirm: false,
      hotspotCountChangedAfterConfirm: false,
      preexistingHotspotRowsRemoved: 0,
      attractionOrderAfterConfirm: [],
      selectedSlotOrderValidAfterConfirm: false,
      hotelCheckinTimeAfterConfirm: null,
      hotelCheckinBefore8PmAfterConfirm: null,
      rowsForPlan: [],
      rowsForLakkamName: [],
    },
  };

  try {
    const itineraryUrl = `${baseUrl.replace(/\/$/, '')}/itinerary-details/${encodeURIComponent(args.quote)}`;
    await ensureLoggedInAndOpenItinerary({ page, itineraryUrl, email, password });

    let ready = await waitForItineraryDay(page, args.day, 30000);
    if (!ready && !headless) {
      console.log('Itinerary day block not found. If login is pending, complete it in the opened browser, then press Enter here.');
      await askEnter('Press Enter after login and itinerary page is visible... ');
      await page.goto(itineraryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      ready = await waitForItineraryDay(page, args.day, 30000);
    }

    if (!ready) {
      result.ui.finalUrl = page.url();
      result.ui.title = await page.title();
      throw new Error(`Could not find #itinerary-day-${args.day}. finalUrl=${result.ui.finalUrl} title=${result.ui.title}`);
    }

    const dayRowsRes = await prisma.$queryRawUnsafe(`
      SELECT itinerary_route_ID, itinerary_route_date, location_name, next_visiting_location
      FROM dvi_itinerary_route_details
      WHERE itinerary_plan_ID = (
        SELECT itinerary_plan_ID
        FROM dvi_itinerary_plan_details
        WHERE itinerary_quote_ID = ?
        ORDER BY itinerary_plan_ID DESC
        LIMIT 1
      )
      AND status = 1
      AND deleted = 0
      ORDER BY itinerary_route_date ASC, itinerary_route_ID ASC
    `, args.quote);
    const dayRoute = Array.isArray(dayRowsRes) ? dayRowsRes[args.day - 1] : null;
    result.db.dayRoute = dayRoute || null;

    const hotspotLookupRows = await prisma.$queryRawUnsafe(`
      SELECT hotspot_ID
      FROM dvi_hotspot_place
      WHERE LOWER(hotspot_name) = LOWER(?)
      LIMIT 1
    `, args.hotspot);
    result.db.hotspotIdByName = Number(hotspotLookupRows?.[0]?.hotspot_ID || 0) || null;

    const dayRoot = page.locator(`#itinerary-day-${args.day}`).first();

    if (dayRoute?.itinerary_route_ID && result.db.hotspotIdByName) {
      const existingRows = await prisma.$queryRawUnsafe(`
        SELECT route_hotspot_ID
        FROM dvi_itinerary_route_hotspot_details
        WHERE itinerary_plan_ID = (
          SELECT itinerary_plan_ID
          FROM dvi_itinerary_plan_details
          WHERE itinerary_quote_ID = ?
          ORDER BY itinerary_plan_ID DESC
          LIMIT 1
        )
        AND itinerary_route_ID = ?
        AND hotspot_ID = ?
        AND item_type = 4
        AND deleted = 0
      `, args.quote, Number(dayRoute.itinerary_route_ID), Number(result.db.hotspotIdByName));

      const existingRouteHotspotIds = (Array.isArray(existingRows) ? existingRows : [])
        .map((row) => Number(row?.route_hotspot_ID || 0))
        .filter((id) => Number.isFinite(id) && id > 0);

      if (existingRouteHotspotIds.length > 0) {
        await prisma.$queryRawUnsafe(`
          DELETE FROM dvi_itinerary_route_activity_details
          WHERE itinerary_plan_ID = (
            SELECT itinerary_plan_ID
            FROM dvi_itinerary_plan_details
            WHERE itinerary_quote_ID = ?
            ORDER BY itinerary_plan_ID DESC
            LIMIT 1
          )
          AND itinerary_route_ID = ?
          AND route_hotspot_ID IN (${existingRouteHotspotIds.join(',')})
        `, args.quote, Number(dayRoute.itinerary_route_ID));

        await prisma.$queryRawUnsafe(`
          DELETE FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = (
            SELECT itinerary_plan_ID
            FROM dvi_itinerary_plan_details
            WHERE itinerary_quote_ID = ?
            ORDER BY itinerary_plan_ID DESC
            LIMIT 1
          )
          AND itinerary_route_ID = ?
          AND hotspot_ID = ?
          AND item_type = 4
          AND deleted = 0
        `, args.quote, Number(dayRoute.itinerary_route_ID), Number(result.db.hotspotIdByName));

        result.db.preexistingHotspotRowsRemoved = existingRouteHotspotIds.length;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      }
    }

    result.ui.beforeDayTextExcerpt = (await dayRoot.innerText().catch(() => '') || '').slice(0, 3000);

    result.ui.rebuildRoute = await maybeClickRebuildRoute(page, args.day);

    // Baseline is captured AFTER optional rebuild so preview-only mutation checks stay accurate.
    if (dayRoute?.itinerary_route_ID) {
      const beforeRows = await prisma.$queryRawUnsafe(`
        SELECT route_hotspot_ID, itinerary_route_ID, hotspot_ID, item_type, hotspot_order,
               hotspot_plan_own_way, hotspot_start_time, hotspot_end_time,
               hotspot_traveling_time, hotspot_travelling_distance, status, deleted
        FROM dvi_itinerary_route_hotspot_details
        WHERE itinerary_plan_ID = (
          SELECT itinerary_plan_ID
          FROM dvi_itinerary_plan_details
          WHERE itinerary_quote_ID = ?
          ORDER BY itinerary_plan_ID DESC
          LIMIT 1
        )
        AND itinerary_route_ID = ?
        AND deleted = 0
        ORDER BY route_hotspot_ID ASC
      `, args.quote, Number(dayRoute.itinerary_route_ID));
      result.db.beforeRouteRows = normalizeHotspotRows(beforeRows);

      if (result.db.hotspotIdByName) {
        const beforeCountRows = await prisma.$queryRawUnsafe(`
          SELECT COUNT(*) AS c
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = (
            SELECT itinerary_plan_ID
            FROM dvi_itinerary_plan_details
            WHERE itinerary_quote_ID = ?
            ORDER BY itinerary_plan_ID DESC
            LIMIT 1
          )
          AND itinerary_route_ID = ?
          AND hotspot_ID = ?
          AND item_type = 4
          AND deleted = 0
        `, args.quote, Number(dayRoute.itinerary_route_ID), Number(result.db.hotspotIdByName));
        result.db.routeHotspotCountBefore = Number(beforeCountRows?.[0]?.c || 0);
      }
    }

    await page.locator(`#itinerary-day-${args.day}`).getByRole('button', { name: 'Add Hotspot' }).click();
    result.ui.modalOpened = true;

    const dialog = page.locator('[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 15000 });

    const previewResponsePromise = page.waitForResponse((resp) => {
      const req = resp.request();
      return req.method() === 'POST' && /\/manual-hotspot\/preview$/i.test(resp.url());
    }, { timeout: 20000 }).catch(() => null);

    await clickHotspotPreviewInDialog({ dialog, hotspotName: args.hotspot });
    result.ui.hotspotPreviewClicked = true;

    const previewResponse = await previewResponsePromise;
    if (previewResponse) {
      const previewPayload = await previewResponse.json().catch(() => null);
      result.ui.previewIsolationRecovered = previewPayload?.previewIsolationRecovered === true;
      result.ui.previewApiCode = previewPayload?.code || null;
      const previewTimeline = Array.isArray(previewPayload?.routeTimeline)
        ? previewPayload.routeTimeline
        : (Array.isArray(previewPayload?.fullTimeline) ? previewPayload.fullTimeline : []);
      const previewSelectedRow = extractTimelineRowByHotspot(previewTimeline, args.hotspot, result.db.hotspotIdByName);
      const previewSelectedRange = previewSelectedRow?.timeRange || previewSelectedRow?.visitTime || null;
      if (previewSelectedRange) {
        result.ui.pothameduPreviewTimeRange = String(previewSelectedRange);
        result.ui.pothameduPreviewDurationMinutes = parseTimeRangeMinutes(previewSelectedRange);
        result.ui.pothameduPreviewDurationValid = result.ui.pothameduPreviewDurationMinutes === 60;
      }
    }

    await page.waitForTimeout(1800);
    const text = await dialog.innerText();
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const staleTimeRangeMatcher = /8:38\s*PM\s*-\s*8:48\s*PM/i;
    const pothameduPreviewTimeRange = result.ui.pothameduPreviewTimeRange || extractHotspotPreviewTimeRange(lines, args.hotspot);
    const pothameduPreviewDurationMinutes = result.ui.pothameduPreviewDurationMinutes ?? parseTimeRangeMinutes(pothameduPreviewTimeRange);
    result.ui.decisionLines = pickDecisionLines(lines);
    result.ui.hotelTravelDiagnostics = collectHotelTravelDiagnostics(lines, 'MUNNAR QUEEN');
    result.ui.conflictTimingConsistency = collectConflictTimingConsistency(lines);
    result.ui.staleTimeRangeMatches = collectMatchingLines(lines, staleTimeRangeMatcher);
    result.ui.staleTimeRangeContexts = collectMatchContexts(lines, staleTimeRangeMatcher);
    result.ui.staleTimeRangeDetected = result.ui.staleTimeRangeMatches.length > 0;
    result.ui.pothameduPreviewTimeRange = pothameduPreviewTimeRange;
    result.ui.pothameduPreviewDurationMinutes = pothameduPreviewDurationMinutes;
    result.ui.pothameduPreviewDurationValid = pothameduPreviewDurationMinutes === 60;
    result.ui.pothameduPreviewHasStaleRange = /12:01\s*PM\s*-\s*12:11\s*PM/i.test(text) && /1\s*Hours?/i.test(text);

    await page.waitForTimeout(800);
    result.ui.afterPreviewDayTextExcerpt = (await dayRoot.innerText().catch(() => '') || '').slice(0, 3000);
    result.ui.timelineUnchangedAfterPreviewOnly = (
      normalizeTextForCompare(result.ui.beforeDayTextExcerpt)
      === normalizeTextForCompare(result.ui.afterPreviewDayTextExcerpt)
    );

    if (dayRoute?.itinerary_route_ID) {
      const afterPreviewRows = await prisma.$queryRawUnsafe(`
        SELECT route_hotspot_ID, itinerary_route_ID, hotspot_ID, item_type, hotspot_order,
               hotspot_plan_own_way, hotspot_start_time, hotspot_end_time,
               hotspot_traveling_time, hotspot_travelling_distance, status, deleted
        FROM dvi_itinerary_route_hotspot_details
        WHERE itinerary_plan_ID = (
          SELECT itinerary_plan_ID
          FROM dvi_itinerary_plan_details
          WHERE itinerary_quote_ID = ?
          ORDER BY itinerary_plan_ID DESC
          LIMIT 1
        )
        AND itinerary_route_ID = ?
        AND deleted = 0
        ORDER BY route_hotspot_ID ASC
      `, args.quote, Number(dayRoute.itinerary_route_ID));
      result.db.afterPreviewRouteRows = normalizeHotspotRows(afterPreviewRows);
      result.db.routeRowsChangedWithoutConfirm = jsonStringifySafe(result.db.beforeRouteRows) !== jsonStringifySafe(result.db.afterPreviewRouteRows);

      if (result.db.hotspotIdByName) {
        const afterPreviewCountRows = await prisma.$queryRawUnsafe(`
          SELECT COUNT(*) AS c
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = (
            SELECT itinerary_plan_ID
            FROM dvi_itinerary_plan_details
            WHERE itinerary_quote_ID = ?
            ORDER BY itinerary_plan_ID DESC
            LIMIT 1
          )
          AND itinerary_route_ID = ?
          AND hotspot_ID = ?
          AND item_type = 4
          AND deleted = 0
        `, args.quote, Number(dayRoute.itinerary_route_ID), Number(result.db.hotspotIdByName));
        result.db.routeHotspotCountAfterPreview = Number(afterPreviewCountRows?.[0]?.c || 0);
        result.db.hotspotCountChangedWithoutConfirm = result.db.routeHotspotCountAfterPreview !== result.db.routeHotspotCountBefore;
      }
    }

    const applyResponsePromise = page.waitForResponse((resp) => {
      const req = resp.request();
      return req.method() === 'POST'
        && /\/manual-hotspots?\/(apply)?/i.test(resp.url())
        && !/\/manual-hotspot\/preview$/i.test(resp.url());
    }, { timeout: 20000 }).catch(() => null);

    await dialog.evaluate((el) => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch {
        // no-op
      }
    }).catch(() => {});
    await page.waitForTimeout(400);

    let buttonTexts = await dialog.locator('button').allInnerTexts().catch(() => []);
    result.ui.confirmButtonCandidates = (Array.isArray(buttonTexts) ? buttonTexts : [])
      .map((v) => String(v || '').trim())
      .filter(Boolean);

    // If priority replacement confirmation is required, complete it first.
    const rescheduleButton = dialog.getByRole('button', { name: /confirm reschedule/i }).first();
    if (await rescheduleButton.isVisible().catch(() => false)) {
      const rescheduleDisabled = await rescheduleButton.isDisabled().catch(() => true);
      if (!rescheduleDisabled) {
        await rescheduleButton.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1800);
        buttonTexts = await dialog.locator('button').allInnerTexts().catch(() => []);
        result.ui.confirmButtonCandidates = (Array.isArray(buttonTexts) ? buttonTexts : [])
          .map((v) => String(v || '').trim())
          .filter(Boolean);
      }
    }

    const confirmPatterns = [
      /confirm add hotspot/i,
      /add with reschedule/i,
      /confirm force add/i,
      /^add hotspot$/i,
    ];

    const findConfirmButton = async () => {
      for (const pattern of confirmPatterns) {
        const candidate = dialog.getByRole('button', { name: pattern }).first();
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
      return null;
    };

    let confirmButton = await findConfirmButton();

    if (!confirmButton) {
      const refreshButton = dialog.getByRole('button', { name: /refresh/i }).first();
      if (await refreshButton.isVisible().catch(() => false)) {
        const refreshDisabled = await refreshButton.isDisabled().catch(() => true);
        if (!refreshDisabled) {
          await refreshButton.click({ timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1800);
          buttonTexts = await dialog.locator('button').allInnerTexts().catch(() => []);
          result.ui.confirmButtonCandidates = (Array.isArray(buttonTexts) ? buttonTexts : [])
            .map((v) => String(v || '').trim())
            .filter(Boolean);
          confirmButton = await findConfirmButton();
        }
      }
    }

    if (!confirmButton) {
      result.ui.confirmAvailable = false;
      result.ui.confirmDisabled = true;
      result.ui.applyBlockedReason = 'CONFIRM_BUTTON_NOT_VISIBLE';
      if (!args.allowNoConfirm) {
        throw new Error(`Confirm button not visible in hotspot preview modal. buttons=${jsonStringifySafe(result.ui.confirmButtonCandidates)}`);
      }
    } else {
      result.ui.confirmAvailable = true;
      result.ui.confirmDisabled = await confirmButton.isDisabled().catch(() => true);
      result.ui.confirmButtonLabel = await confirmButton.innerText().catch(() => null);

      if (result.ui.confirmDisabled) {
        result.ui.applyBlockedReason = 'CONFIRM_BUTTON_DISABLED';
        if (!args.allowNoConfirm) {
          throw new Error(`Confirm button is disabled; cannot verify confirm-phase mutation. buttons=${jsonStringifySafe(result.ui.confirmButtonCandidates)}`);
        }
      } else {
        await confirmButton.click({ timeout: 10000 });
        result.ui.confirmClicked = true;

        const applyResponse = await applyResponsePromise;
        if (applyResponse) {
          const applyRequest = applyResponse.request();
          const applyPostData = applyRequest.postDataJSON ? applyRequest.postDataJSON() : null;
          const applyPayload = await applyResponse.json().catch(() => null);
          result.ui.confirmApiCode = applyPayload?.code || null;
          result.ui.confirmApiUrl = applyResponse.url();
          result.ui.confirmApiSuccess = applyPayload?.success === true;
          result.ui.confirmApiForceConflictInsertion = Boolean(applyPostData?.forceConflictInsertion);
          const applyTimeline = Array.isArray(applyPayload?.routeTimeline)
            ? applyPayload.routeTimeline
            : (Array.isArray(applyPayload?.fullTimeline) ? applyPayload.fullTimeline : []);
          const applySelectedRow = extractTimelineRowByHotspot(applyTimeline, args.hotspot, result.db.hotspotIdByName);
          result.ui.confirmApiSelectedRowTimeRange = applySelectedRow?.timeRange || applySelectedRow?.visitTime || null;
        }

        await page.waitForTimeout(2200);
        result.ui.afterConfirmDayTextExcerpt = (await dayRoot.innerText().catch(() => '') || '');
        result.ui.timelineChangedAfterConfirm = (
          normalizeTextForCompare(result.ui.afterConfirmDayTextExcerpt)
          !== normalizeTextForCompare(result.ui.afterPreviewDayTextExcerpt)
        );

        const confirmDayTextLower = String(result.ui.afterConfirmDayTextExcerpt || '').toLowerCase();
        const hotspotLower = String(args.hotspot || '').trim().toLowerCase();
        result.ui.containsHotspotAfterConfirm = hotspotLower.length > 0 && confirmDayTextLower.includes(hotspotLower);
        result.ui.containsTravelToHotspotAfterConfirm = hotspotLower.length > 0 && confirmDayTextLower.includes(`travel to ${hotspotLower}`);
        result.ui.containsTravelToEravikulamAfterConfirm = confirmDayTextLower.includes('travel to eravikulam national park');

        const checkinMatch = String(result.ui.afterConfirmDayTextExcerpt || '').match(/check-?in\s+at\s+[^\n]*?(\d{1,2}:\d{2}\s*(AM|PM))/i);
        const checkinTimeText = checkinMatch ? String(checkinMatch[1]) : null;
        result.ui.finalHotelCheckinTime = checkinTimeText;
        const checkinMin = checkinTimeText ? parseTime12ToMinutes(checkinTimeText) : null;
        result.ui.finalHotelCheckinBefore8Pm = checkinMin == null ? null : checkinMin <= (20 * 60);

        if (!result.ui.containsHotspotAfterConfirm) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await waitForItineraryDay(page, args.day, 30000);
          const refreshedText = (await dayRoot.innerText().catch(() => '') || '');
          result.ui.afterConfirmDayTextExcerpt = refreshedText;
          result.ui.timelineChangedAfterConfirm = (
            normalizeTextForCompare(refreshedText)
            !== normalizeTextForCompare(result.ui.afterPreviewDayTextExcerpt)
          );

          const refreshedLower = String(refreshedText || '').toLowerCase();
          result.ui.containsHotspotAfterConfirm = hotspotLower.length > 0 && refreshedLower.includes(hotspotLower);
          result.ui.containsTravelToHotspotAfterConfirm = hotspotLower.length > 0 && refreshedLower.includes(`travel to ${hotspotLower}`);
          result.ui.containsTravelToEravikulamAfterConfirm = refreshedLower.includes('travel to eravikulam national park');

          const refreshedCheckinMatch = String(refreshedText || '').match(/check-?in\s+at\s+[^\n]*?(\d{1,2}:\d{2}\s*(AM|PM))/i);
          const refreshedCheckinTime = refreshedCheckinMatch ? String(refreshedCheckinMatch[1]) : null;
          result.ui.finalHotelCheckinTime = refreshedCheckinTime;
          const refreshedCheckinMin = refreshedCheckinTime ? parseTime12ToMinutes(refreshedCheckinTime) : null;
          result.ui.finalHotelCheckinBefore8Pm = refreshedCheckinMin == null ? null : refreshedCheckinMin <= (20 * 60);
        }
      }
    }

    if (dayRoute?.itinerary_route_ID && result.ui.confirmClicked === true) {
      const afterConfirmRows = await prisma.$queryRawUnsafe(`
        SELECT route_hotspot_ID, itinerary_route_ID, hotspot_ID, item_type, hotspot_order,
               hotspot_plan_own_way, hotspot_start_time, hotspot_end_time,
               hotspot_traveling_time, hotspot_travelling_distance, status, deleted
        FROM dvi_itinerary_route_hotspot_details
        WHERE itinerary_plan_ID = (
          SELECT itinerary_plan_ID
          FROM dvi_itinerary_plan_details
          WHERE itinerary_quote_ID = ?
          ORDER BY itinerary_plan_ID DESC
          LIMIT 1
        )
        AND itinerary_route_ID = ?
        AND deleted = 0
        ORDER BY route_hotspot_ID ASC
      `, args.quote, Number(dayRoute.itinerary_route_ID));
      result.db.afterConfirmRouteRows = normalizeHotspotRows(afterConfirmRows);
      result.db.afterRouteRows = result.db.afterConfirmRouteRows;
      result.db.routeRowsChangedAfterConfirm = (
        jsonStringifySafe(result.db.afterConfirmRouteRows)
        !== jsonStringifySafe(result.db.afterPreviewRouteRows)
      );

      if (result.db.hotspotIdByName) {
        const afterConfirmCountRows = await prisma.$queryRawUnsafe(`
          SELECT COUNT(*) AS c
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = (
            SELECT itinerary_plan_ID
            FROM dvi_itinerary_plan_details
            WHERE itinerary_quote_ID = ?
            ORDER BY itinerary_plan_ID DESC
            LIMIT 1
          )
          AND itinerary_route_ID = ?
          AND hotspot_ID = ?
          AND item_type = 4
          AND deleted = 0
        `, args.quote, Number(dayRoute.itinerary_route_ID), Number(result.db.hotspotIdByName));
        result.db.routeHotspotCountAfterConfirm = Number(afterConfirmCountRows?.[0]?.c || 0);
        result.db.hotspotCountChangedAfterConfirm = result.db.routeHotspotCountAfterConfirm !== result.db.routeHotspotCountAfterPreview;
      }

      const attractionOrderRows = await prisma.$queryRawUnsafe(`
        SELECT h.hotspot_order, p.hotspot_name
        FROM dvi_itinerary_route_hotspot_details h
        LEFT JOIN dvi_hotspot_place p ON p.hotspot_ID = h.hotspot_ID
        WHERE h.itinerary_plan_ID = (
          SELECT itinerary_plan_ID
          FROM dvi_itinerary_plan_details
          WHERE itinerary_quote_ID = ?
          ORDER BY itinerary_plan_ID DESC
          LIMIT 1
        )
          AND h.itinerary_route_ID = ?
          AND h.item_type = 4
          AND h.deleted = 0
        ORDER BY h.hotspot_order ASC
      `, args.quote, Number(dayRoute.itinerary_route_ID));

      result.db.attractionOrderAfterConfirm = Array.isArray(attractionOrderRows)
        ? attractionOrderRows.map((row) => ({
            hotspot_order: Number(row?.hotspot_order || 0),
            hotspot_name: String(row?.hotspot_name || '').trim(),
          }))
        : [];

            const selectedHotspotDurationRows = await prisma.$queryRawUnsafe(`
        SELECT TIME_FORMAT(hotspot_start_time, '%h:%i %p') AS start_time,
               TIME_FORMAT(hotspot_end_time, '%h:%i %p') AS end_time,
               TIMESTAMPDIFF(MINUTE, hotspot_start_time, hotspot_end_time) AS duration_minutes
        FROM dvi_itinerary_route_hotspot_details
        WHERE itinerary_plan_ID = (
          SELECT itinerary_plan_ID
          FROM dvi_itinerary_plan_details
          WHERE itinerary_quote_ID = ?
          ORDER BY itinerary_plan_ID DESC
          LIMIT 1
        )
          AND itinerary_route_ID = ?
          AND item_type = 4
          AND deleted = 0
          AND LOWER((SELECT hotspot_name FROM dvi_hotspot_place WHERE hotspot_ID = dvi_itinerary_route_hotspot_details.hotspot_ID LIMIT 1)) LIKE ?
        ORDER BY hotspot_order ASC
        LIMIT 1
      `, args.quote, Number(dayRoute.itinerary_route_ID), `%${String(args.hotspot || '').trim().toLowerCase()}%`);

      result.ui.pothameduConfirmTimeRange = selectedHotspotDurationRows?.[0]?.start_time && selectedHotspotDurationRows?.[0]?.end_time
        ? `${String(selectedHotspotDurationRows[0].start_time)} - ${String(selectedHotspotDurationRows[0].end_time)}`
        : null;
      result.ui.pothameduConfirmDurationMinutes = Number(selectedHotspotDurationRows?.[0]?.duration_minutes || 0) || null;
      result.ui.pothameduConfirmDurationValid = result.ui.pothameduConfirmDurationMinutes === 60;
      result.ui.pothameduPersistedDurationMinutes = result.ui.pothameduConfirmDurationMinutes;

      const findIndexByName = (namePart) => result.db.attractionOrderAfterConfirm
        .findIndex((row) => String(row?.hotspot_name || '').toLowerCase().includes(String(namePart || '').toLowerCase()));

      const idxValara = findIndexByName('valara water falls');
      const idxPothamedu = findIndexByName('pothamedu view point');
      const idxEravikulam = findIndexByName('eravikulam national park');
      result.db.selectedSlotOrderValidAfterConfirm = (
        idxValara >= 0
        && idxPothamedu >= 0
        && idxEravikulam >= 0
        && idxValara < idxPothamedu
        && idxPothamedu < idxEravikulam
      );

      const checkinRows = await prisma.$queryRawUnsafe(`
        SELECT TIME_FORMAT(hotspot_start_time, '%h:%i %p') AS checkin_time
        FROM dvi_itinerary_route_hotspot_details
        WHERE itinerary_plan_ID = (
          SELECT itinerary_plan_ID
          FROM dvi_itinerary_plan_details
          WHERE itinerary_quote_ID = ?
          ORDER BY itinerary_plan_ID DESC
          LIMIT 1
        )
          AND itinerary_route_ID = ?
          AND item_type = 6
          AND deleted = 0
        ORDER BY hotspot_order DESC
        LIMIT 1
      `, args.quote, Number(dayRoute.itinerary_route_ID));

      result.db.hotelCheckinTimeAfterConfirm = checkinRows?.[0]?.checkin_time ? String(checkinRows[0].checkin_time) : null;
      const checkinDbMin = result.db.hotelCheckinTimeAfterConfirm
        ? parseTime12ToMinutes(result.db.hotelCheckinTimeAfterConfirm)
        : null;
      result.db.hotelCheckinBefore8PmAfterConfirm = checkinDbMin == null ? null : checkinDbMin <= (20 * 60);
    } else {
      result.db.afterConfirmRouteRows = result.db.afterPreviewRouteRows;
      result.db.afterRouteRows = result.db.afterPreviewRouteRows;
      result.db.routeRowsChangedAfterConfirm = false;
      result.db.routeHotspotCountAfterConfirm = result.db.routeHotspotCountAfterPreview;
      result.db.hotspotCountChangedAfterConfirm = false;
      result.db.attractionOrderAfterConfirm = [];
      result.db.selectedSlotOrderValidAfterConfirm = false;
      result.db.hotelCheckinTimeAfterConfirm = null;
      result.db.hotelCheckinBefore8PmAfterConfirm = null;
    }

    const closeDialogBtn = dialog.getByRole('button', { name: /close|cancel|x/i }).first();
    if (await closeDialogBtn.isVisible().catch(() => false)) {
      await closeDialogBtn.click({ timeout: 5000 }).catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }

    await page.waitForTimeout(1000);
    result.ui.afterDayTextExcerpt = (await dayRoot.innerText().catch(() => '') || '').slice(0, 3000);

    result.ui.finalUrl = page.url();
    result.ui.title = await page.title();

    const tableExistsRes = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*) AS c
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = 'hotspot_hotel_between_map'
    `);
    result.db.tableExists = Number(tableExistsRes?.[0]?.c || 0) > 0;

    const planRes = await prisma.$queryRawUnsafe(`
      SELECT itinerary_plan_ID, itinerary_quote_ID, status, deleted, createdon
      FROM dvi_itinerary_plan_details
      WHERE itinerary_quote_ID = ?
      ORDER BY itinerary_plan_ID DESC
      LIMIT 1
    `, args.quote);
    result.db.latestPlan = planRes?.[0] || null;

    if (result.db.tableExists && result.db.latestPlan?.itinerary_plan_ID) {
      const planId = Number(result.db.latestPlan.itinerary_plan_ID);
      result.db.rowsForPlan = await prisma.$queryRawUnsafe(`
        SELECT *
        FROM hotspot_hotel_between_map
        WHERE itinerary_plan_id = ?
        ORDER BY id DESC
        LIMIT 50
      `, planId);

      result.db.rowsForLakkamName = await prisma.$queryRawUnsafe(`
        SELECT m.*, p.hotspot_name AS between_hotspot_name
        FROM hotspot_hotel_between_map m
        LEFT JOIN dvi_hotspot_place p ON p.hotspot_ID = m.between_hotspot_id
        WHERE m.itinerary_plan_id = ?
          AND LOWER(p.hotspot_name) LIKE '%lakkam%'
        ORDER BY m.id DESC
        LIMIT 50
      `, planId);
    }

    const outPath = path.join(process.cwd(), 'tmp', `verify-hotspot-hotel-between-${Date.now()}.json`);
    require('fs').mkdirSync(path.dirname(outPath), { recursive: true });
    require('fs').writeFileSync(outPath, jsonStringifySafe(result, 2));

    const previewOnlyOk = !result.db.routeRowsChangedWithoutConfirm
      && !result.db.hotspotCountChangedWithoutConfirm
      && result.ui.timelineUnchangedAfterPreviewOnly
      && result.ui.staleTimeRangeDetected !== true
      && result.ui.conflictTimingConsistency?.travelStartsBeforeLeave !== true
      && result.ui.pothameduPreviewDurationValid === true
      && result.ui.pothameduPreviewHasStaleRange !== true;

    const confirmPhaseOk = result.ui.confirmClicked === true
      ? (result.db.routeRowsChangedAfterConfirm
          && result.db.hotspotCountChangedAfterConfirm
          && (result.ui.timelineChangedAfterConfirm || result.ui.containsHotspotAfterConfirm)
          && result.db.selectedSlotOrderValidAfterConfirm === true
          && result.db.hotelCheckinBefore8PmAfterConfirm !== false
          && result.ui.pothameduConfirmDurationValid === true
          && result.ui.pothameduPersistedDurationMinutes === 60)
      : false;

    const ok = args.allowNoConfirm
      ? previewOnlyOk
      : (previewOnlyOk && confirmPhaseOk);

    console.log(jsonStringifySafe({
      ok,
      outPath,
      summary: {
        rebuildRouteClicked: result.ui.rebuildRoute?.clicked === true,
        previewIsolationRecovered: result.ui.previewIsolationRecovered === true,
        previewApiCode: result.ui.previewApiCode || null,
        staleTimeRangeDetected: result.ui.staleTimeRangeDetected === true,
        staleTimeRangeMatches: result.ui.staleTimeRangeMatches,
        staleTimeRangeContexts: result.ui.staleTimeRangeContexts,
        pothameduPreviewTimeRange: result.ui.pothameduPreviewTimeRange,
        pothameduPreviewDurationMinutes: result.ui.pothameduPreviewDurationMinutes,
        pothameduPreviewDurationValid: result.ui.pothameduPreviewDurationValid,
        pothameduPreviewHasStaleRange: result.ui.pothameduPreviewHasStaleRange,
        conflictTimingConsistency: result.ui.conflictTimingConsistency,
        hotelTravelDiagnostics: result.ui.hotelTravelDiagnostics,
        decisionLines: result.ui.decisionLines,
        confirmClicked: result.ui.confirmClicked === true,
        confirmAvailable: result.ui.confirmAvailable === true,
        confirmDisabled: result.ui.confirmDisabled === true,
        confirmButtonLabel: result.ui.confirmButtonLabel || null,
        confirmButtonCandidates: result.ui.confirmButtonCandidates,
        applyBlockedReason: result.ui.applyBlockedReason || null,
        confirmApiCode: result.ui.confirmApiCode || null,
        timelineUnchangedAfterPreviewOnly: result.ui.timelineUnchangedAfterPreviewOnly === true,
        timelineChangedAfterConfirm: result.ui.timelineChangedAfterConfirm === true,
        containsHotspotAfterConfirm: result.ui.containsHotspotAfterConfirm === true,
        containsTravelToHotspotAfterConfirm: result.ui.containsTravelToHotspotAfterConfirm === true,
        containsTravelToEravikulamAfterConfirm: result.ui.containsTravelToEravikulamAfterConfirm === true,
        finalHotelCheckinTime: result.ui.finalHotelCheckinTime || null,
        finalHotelCheckinBefore8Pm: result.ui.finalHotelCheckinBefore8Pm,
        routeRowsChangedWithoutConfirm: result.db.routeRowsChangedWithoutConfirm,
        routeRowsChangedAfterConfirm: result.db.routeRowsChangedAfterConfirm,
        hotspotCountChangedWithoutConfirm: result.db.hotspotCountChangedWithoutConfirm,
        hotspotCountChangedAfterConfirm: result.db.hotspotCountChangedAfterConfirm,
        preexistingHotspotRowsRemoved: result.db.preexistingHotspotRowsRemoved,
        selectedSlotOrderValidAfterConfirm: result.db.selectedSlotOrderValidAfterConfirm,
        attractionOrderAfterConfirm: result.db.attractionOrderAfterConfirm,
        hotelCheckinTimeAfterConfirm: result.db.hotelCheckinTimeAfterConfirm,
        hotelCheckinBefore8PmAfterConfirm: result.db.hotelCheckinBefore8PmAfterConfirm,
        routeHotspotCountBefore: result.db.routeHotspotCountBefore,
        routeHotspotCountAfterPreview: result.db.routeHotspotCountAfterPreview,
        routeHotspotCountAfterConfirm: result.db.routeHotspotCountAfterConfirm,
        pothameduConfirmTimeRange: result.ui.pothameduConfirmTimeRange,
        pothameduConfirmDurationMinutes: result.ui.pothameduConfirmDurationMinutes,
        pothameduConfirmDurationValid: result.ui.pothameduConfirmDurationValid,
        pothameduPersistedDurationMinutes: result.ui.pothameduPersistedDurationMinutes,
        beforeRouteRows: Array.isArray(result.db.beforeRouteRows) ? result.db.beforeRouteRows.length : 0,
        afterPreviewRouteRows: Array.isArray(result.db.afterPreviewRouteRows) ? result.db.afterPreviewRouteRows.length : 0,
        afterRouteRows: Array.isArray(result.db.afterRouteRows) ? result.db.afterRouteRows.length : 0,
        tableExists: result.db.tableExists,
        latestPlanId: result.db.latestPlan?.itinerary_plan_ID || null,
        rowsForPlan: Array.isArray(result.db.rowsForPlan) ? result.db.rowsForPlan.length : 0,
        rowsForLakkamName: Array.isArray(result.db.rowsForLakkamName) ? result.db.rowsForLakkamName.length : 0,
      },
    }, 2));

    if (!ok) {
      throw new Error('Verifier failed: preview isolation checks failed or confirm-phase checks failed when required.');
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await browser.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('VERIFY_FAILED');
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
