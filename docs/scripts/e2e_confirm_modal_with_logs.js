/*
 * E2E: create itinerary (2 rooms: 2 adults + 1 child),
 * run Playwright confirm modal flow, and capture search/prebook/booking payloads.
 *
 * Usage:
 *   node e2e_confirm_modal_with_logs.js
 *   BASE_URL=http://127.0.0.1:4006 FRONTEND_URL=http://localhost:8080 node e2e_confirm_modal_with_logs.js
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4006';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
const TOKEN =
  process.env.TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc2ODI2NTEsImV4cCI6MTc3ODI4NzQ1MX0.7pWoIL-8qRkUXDb24aLdCM0no5DVBrjTONv9LyMZjwU';
const LOGIN_EMAIL = process.env.E2E_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.E2E_PASSWORD || 'Admin@123';
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'e2e-logs', `confirm-modal-${Date.now()}`);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function plusDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatIso0530(date, hour, minute) {
  const ymd = formatYmd(date);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${ymd}T${hh}:${mm}:00+05:30`;
}

function formatUiDateTime(date, hour, minute) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  return `${dd}-${mm}-${yyyy} ${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function pick(obj, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (!isObject(cur) && !Array.isArray(cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
      if (cur === undefined) {
        ok = false;
        break;
      }
    }
    if (ok) return cur;
  }
  return undefined;
}

function normalizeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function requestJson(url, { method = 'GET', body, headers = {} } = {}) {
  const started = Date.now();
  const finalHeaders = {
    Accept: '*/*',
    Authorization: `Bearer ${TOKEN}`,
    ...headers,
  };
  if (body !== undefined && !finalHeaders['Content-Type']) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    ms: Date.now() - started,
    body: normalizeJson(text),
    rawText: text,
  };
}

function buildCreatePayload(now) {
  const day1 = plusDays(now, 4);
  const day2 = plusDays(now, 5);
  const day3 = plusDays(now, 6);
  const day4 = plusDays(now, 7);

  return {
    plan: {
      itinerary_plan_id: 292,
      agent_id: 8,
      staff_id: 0,
      location_id: 0,
      arrival_point: 'Chennai International Airport',
      departure_point: 'Chennai International Airport',
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: formatIso0530(day1, 8, 0),
      trip_end_date: formatIso0530(day4, 20, 0),
      pick_up_date_and_time: formatIso0530(day1, 8, 0),
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: 3,
      no_of_days: 4,
      budget: 20000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 229,
      food_type: 0,
      meal_plan_code: 'CP',
      meal_plan_breakfast: 1,
      meal_plan_lunch: 0,
      meal_plan_dinner: 0,
      adult_count: 2,
      child_count: 1,
      infant_count: 0,
      special_instructions: 'E2E confirm modal test',
    },
    routes: [
      {
        location_name: 'Chennai International Airport',
        next_visiting_location: 'Chennai',
        itinerary_route_date: formatIso0530(day1, 0, 0),
        no_of_days: 1,
        no_of_km: 16.61,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Chennai',
        next_visiting_location: 'Mahabalipuram',
        itinerary_route_date: formatIso0530(day2, 0, 0),
        no_of_days: 2,
        no_of_km: 52.07,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Mahabalipuram',
        next_visiting_location: 'Pondicherry',
        itinerary_route_date: formatIso0530(day3, 0, 0),
        no_of_days: 3,
        no_of_km: 86.57,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Pondicherry',
        next_visiting_location: 'Chennai International Airport',
        itinerary_route_date: formatIso0530(day4, 0, 0),
        no_of_days: 4,
        no_of_km: 40.17,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
    ],
    vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 2, traveller_age: '7', child_bed_type: 1 },
      { room_id: 2, traveller_type: 1 },
    ],
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  };
}

function getQuoteId(json) {
  const value = pick(json, [
    'data.quote_id',
    'data.quoteId',
    'data.quote_ID',
    'quote_id',
    'quoteId',
    'quote_ID',
    'data.itinerary_id',
    'itinerary_id',
    'data.itineraryCode',
    'itineraryCode',
  ]);
  return value ? String(value) : null;
}

function getPlanId(json) {
  const value = pick(json, ['data.planId', 'data.plan_id', 'planId', 'plan_id', 'data.itinerary_plan_ID']);
  return value != null ? Number(value) : null;
}

async function main() {
  ensureDir(OUT_DIR);
  const now = new Date();

  const execution = {
    baseUrl: BASE_URL,
    frontendUrl: FRONTEND_URL,
    startedAt: new Date().toISOString(),
    quoteId: null,
    itineraryPlanId: null,
    api: {},
    browser: {
      requestLogs: [],
      responseLogs: [],
      confirmStatus: null,
      errors: [],
    },
    unconfirm: null,
  };

  const createPayload = buildCreatePayload(now);
  execution.api.createRequest = createPayload;

  const createUrl = `${BASE_URL}/api/v1/itineraries/?type=itineary_basic_info`;
  const createRes = await requestJson(createUrl, { method: 'POST', body: createPayload });
  execution.api.createResponse = createRes;
  if (!createRes.ok) throw new Error(`Create failed: ${createRes.status}`);

  const quoteId = getQuoteId(createRes.body);
  if (!quoteId) throw new Error('Could not resolve quote id from create response');
  execution.quoteId = quoteId;

  const detailsUrl = `${BASE_URL}/api/v1/itineraries/details/${encodeURIComponent(quoteId)}`;
  const detailsRes = await requestJson(detailsUrl);
  execution.api.detailsResponse = detailsRes;

  const planIdFromDetails = getPlanId(detailsRes.body);
  if (!planIdFromDetails) throw new Error('Could not resolve itinerary_plan_ID from details response');
  execution.itineraryPlanId = planIdFromDetails;

  const day1 = plusDays(now, 4);
  const day2 = plusDays(now, 5);
  const searchPayload = {
    cityCode: 'Chennai',
    checkInDate: formatYmd(day1),
    checkOutDate: formatYmd(day2),
    roomCount: 2,
    guestCount: 3,
    guestNationality: 'IN',
    providers: ['tbo'],
  };
  execution.api.searchRequest = searchPayload;

  const searchUrl = `${BASE_URL}/api/v1/hotels/search`;
  const searchRes = await requestJson(searchUrl, { method: 'POST', body: searchPayload });
  execution.api.searchResponse = searchRes;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    page.on('request', (request) => {
      const url = request.url();
      if (
        url.includes('/api/v1/hotels/search') ||
        url.includes('/api/v1/itineraries/hotels/prebook') ||
        url.includes('/api/v1/itineraries/confirm-quotation')
      ) {
        let body = null;
        try {
          body = request.postDataJSON();
        } catch {
          body = request.postData() || null;
        }
        execution.browser.requestLogs.push({
          ts: new Date().toISOString(),
          method: request.method(),
          url,
          body,
        });
      }
    });

    page.on('response', async (response) => {
      const url = response.url();
      if (
        url.includes('/api/v1/hotels/search') ||
        url.includes('/api/v1/itineraries/hotels/prebook') ||
        url.includes('/api/v1/itineraries/confirm-quotation')
      ) {
        let body = null;
        try {
          body = normalizeJson(await response.text());
        } catch {
          body = null;
        }
        execution.browser.responseLogs.push({
          ts: new Date().toISOString(),
          status: response.status(),
          url,
          body,
        });
      }
    });

    await page.goto(`${FRONTEND_URL}/login`, { waitUntil: 'networkidle' });
    await page.getByLabel('Email').fill(LOGIN_EMAIL);
    await page.getByLabel('Password').fill(LOGIN_PASSWORD);
    await page.getByRole('button', { name: /^Sign in$/i }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });

    await page.goto(`${FRONTEND_URL}/itinerary-details/${quoteId}`, { waitUntil: 'networkidle' });

    const confirmOpenButton = page.getByRole('button', { name: /Confirm Quotation/i });
    await confirmOpenButton.waitFor({ state: 'visible', timeout: 45000 });
    await confirmOpenButton.click();

    await page.locator('input[placeholder="Enter the Name"]').first().fill('Modal Primary');
    await page.locator('input[placeholder="Enter the Age"]').first().fill('34');
    await page.locator('input[placeholder="Enter the Contact No"]').first().fill('9876543210');
    await page.locator('input[placeholder="IN"]').first().fill('IN');
    await page.locator('input[placeholder="Enter the Email ID"]').first().fill('modal.primary@example.com');

    const addAdultBtn = page.getByRole('button', { name: /Add Adult/i });
    await addAdultBtn.click();
    await page.locator('label:has-text("Adult 2 Name") + input').fill('Modal Adult2');
    await page.locator('label:has-text("Adult 2 Name")').locator('xpath=ancestor::div[contains(@class, "sm:col-span-5")]/following-sibling::div[1]//input').fill('31');
    await page.locator('label:has-text("Adult 2 Name")').locator('xpath=ancestor::div[contains(@class, "sm:col-span-5")]/following-sibling::div[2]//input').fill('IN');

    const addChildBtn = page.getByRole('button', { name: /Add Child/i });
    await addChildBtn.click();
    await page.locator('label:has-text("Child 1 Name") + input').fill('Modal Child1');
    await page.locator('label:has-text("Child 1 Name")').locator('xpath=ancestor::div[contains(@class, "sm:col-span-5")]/following-sibling::div[1]//input').fill('7');
    await page.locator('label:has-text("Child 1 Name")').locator('xpath=ancestor::div[contains(@class, "sm:col-span-5")]/following-sibling::div[2]//input').fill('IN');

    const arr = formatUiDateTime(day1, 9, 0);
    const dep = formatUiDateTime(plusDays(now, 7), 19, 0);
    await page.locator('input[placeholder="12-12-2025 9:00 AM"]').first().fill(arr);
    await page.locator('input[placeholder="19-12-2025 4:00 PM"]').first().fill(dep);

    const reviewText = page.locator('text=I have reviewed the inclusions, amenities, rate conditions, cancellation policy, room promotion, and additional charge details before final booking confirmation.');
    if (await reviewText.first().isVisible({ timeout: 4000 }).catch(() => false)) {
      await reviewText.first().click();
    }

    const confirmResponsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/v1/itineraries/confirm-quotation') && resp.request().method() === 'POST',
      { timeout: 120000 }
    );

    await page.getByRole('button', { name: /^Confirm Booking$/i }).click();
    const confirmResp = await confirmResponsePromise;
    execution.browser.confirmStatus = confirmResp.status();
  } catch (err) {
    execution.browser.errors.push({
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    });
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }

  const cancelPayload = {
    itinerary_plan_ID: execution.itineraryPlanId,
    reason: 'E2E retest cleanup: unconfirm after confirm flow',
    cancellation_options: {
      modify_hotspot: true,
      modify_hotel: true,
      modify_vehicle: true,
      modify_guide: true,
      modify_activity: true,
    },
  };

  const cancelUrl = `${BASE_URL}/api/v1/itineraries/cancel`;
  const cancelRes = await requestJson(cancelUrl, { method: 'POST', body: cancelPayload });
  execution.unconfirm = {
    request: cancelPayload,
    response: cancelRes,
  };

  execution.finishedAt = new Date().toISOString();

  const outFile = path.join(OUT_DIR, 'execution-log.json');
  fs.writeFileSync(outFile, JSON.stringify(execution, null, 2));

  const summary = {
    quoteId: execution.quoteId,
    itineraryPlanId: execution.itineraryPlanId,
    searchStatus: execution.api.searchResponse?.status || null,
    confirmApiStatusFromUi: execution.browser.confirmStatus,
    unconfirmStatus: execution.unconfirm?.response?.status || null,
    requestCaptureCounts: {
      requestLogs: execution.browser.requestLogs.length,
      responseLogs: execution.browser.responseLogs.length,
    },
    outFile,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('E2E COMPLETED');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  ensureDir(OUT_DIR);
  fs.writeFileSync(
    path.join(OUT_DIR, 'fatal-error.json'),
    JSON.stringify(
      {
        message: error?.message || String(error),
        stack: error?.stack || null,
        at: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.error('E2E FAILED:', error?.message || error);
  process.exit(1);
});
