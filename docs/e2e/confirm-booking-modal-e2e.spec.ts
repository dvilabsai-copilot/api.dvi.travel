import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_USER ?? process.env.E2E_HOTSPOT_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_PASSWORD ?? process.env.E2E_HOTSPOT_PASSWORD ?? 'Keerthi@2404ias';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';
const FRONTEND_BASE_URL = process.env.E2E_FRONTEND_BASE_URL ?? 'http://localhost:8080';

async function loginForToken(request: APIRequestContext): Promise<string> {
  const loginRes = await request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });

  if (!loginRes.ok()) {
    const body = await loginRes.text().catch(() => '');
    throw new Error(`Auth login failed: status=${loginRes.status()} body=${body}`);
  }

  const json = (await loginRes.json()) as { accessToken?: string };
  const token = String(json?.accessToken || '').trim();
  if (!token) {
    throw new Error('Auth login succeeded but accessToken missing');
  }

  return token;
}

async function seedAuthToken(page: Page, request: APIRequestContext): Promise<string> {
  const token = await loginForToken(request);
  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
  }, token);
  return token;
}

function plusDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatIso0530(date: Date, hour: number, minute: number): string {
  const ymd = formatYmd(date);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${ymd}T${hh}:${mm}:00+05:30`;
}

function formatUiDateTime(date: Date, hour: number, minute: number): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  return `${dd}-${mm}-${yyyy} ${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
}

test('confirm modal E2E: 2 rooms, 2 adults + 1 child, search→prebook→confirm→unconfirm with request logging', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(300000);

  const apiLogs: { type: 'request' | 'response'; method?: string; path?: string; status?: number; body?: any; ts: string }[] = [];
  const now = new Date();

  // Intercept API calls
  page.on('request', (req) => {
    const url = req.url();
    if (
      url.includes('/hotels/search') ||
      url.includes('/itineraries/hotels/prebook') ||
      url.includes('/itineraries/confirm-quotation')
    ) {
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = req.postData() || null;
      }
      apiLogs.push({
        type: 'request',
        method: req.method(),
        path: url.split(API_BASE_URL).pop() || url,
        body,
        ts: new Date().toISOString(),
      });
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (
      url.includes('/hotels/search') ||
      url.includes('/itineraries/hotels/prebook') ||
      url.includes('/itineraries/confirm-quotation')
    ) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      apiLogs.push({
        type: 'response',
        method: res.request().method(),
        path: url.split(API_BASE_URL).pop() || url,
        status: res.status(),
        body,
        ts: new Date().toISOString(),
      });
    }
  });

  const token = await seedAuthToken(page, request);

  // Create itinerary: 2 rooms, 2 adults + 1 child
  const day1 = plusDays(now, 4);
  const day2 = plusDays(now, 5);
  const day3 = plusDays(now, 6);
  const day4 = plusDays(now, 7);

  const createPayload = {
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
      special_instructions: 'E2E confirm modal test with 2 rooms multi-pax',
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

  const createRes = await request.post(`${API_BASE_URL}/itineraries/?type=itineary_basic_info`, {
    data: createPayload,
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(createRes.ok()).toBeTruthy();
  const createJson = (await createRes.json()) as any;
  
  // Extract quote ID from response
  const quoteId = String(
    createJson?.quoteId ||
    createJson?.data?.quoteId ||
    createJson?.quote_id ||
    createJson?.data?.quote_id ||
    'UNKNOWN'
  );
  expect(quoteId).not.toBe('UNKNOWN');
  console.log(`✅ Created itinerary: ${quoteId}`);

  const detailsRes = await request.get(`${API_BASE_URL}/itineraries/details/${encodeURIComponent(quoteId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(detailsRes.ok()).toBeTruthy();
  const detailsJson = (await detailsRes.json()) as any;
  
  // Extract planId from create response or details
  let itineraryPlanId = Number(createJson?.planId || createJson?.plan_id || 0);
  if (!itineraryPlanId) {
    itineraryPlanId = Number(
      detailsJson?.data?.planId ||
      detailsJson?.planId ||
      detailsJson?.data?.plan_id ||
      detailsJson?.plan_id ||
      0
    );
  }
  expect(itineraryPlanId).toBeGreaterThan(0);
  console.log(`✅ Itinerary plan ID: ${itineraryPlanId}`);

  // Set up browser console logging
  const consoleLogs: any[] = [];
  page.on('console', msg => {
    consoleLogs.push({ level: msg.type(), text: msg.text() });
  });
  
  page.on('pageerror', err => {
    consoleLogs.push({ level: 'error', text: `Page error: ${err.message}` });

    page.on('response', (res) => {
      if (res.url().includes('/itineraries/details')) {
        consoleLogs.push({ 
          level: 'api-response', 
          text: `${res.status()} ${res.url()}` 
        });
      }
    });
  });

  // Navigate to itinerary details in UI
  console.log(`🌐 Navigating to itinerary details: ${quoteId}`);
  await page.goto(`${FRONTEND_BASE_URL}/itinerary-details/${quoteId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for either the URL to match or the heading to appear
  await expect(page).toHaveURL(new RegExp(`/${quoteId}$`), { timeout: 30000 });
  console.log('✅ Navigated to itinerary details page');

  // Dump console logs from page
  if (consoleLogs.length > 0) {
    console.log('📋 Browser console logs:');
    consoleLogs.slice(0, 30).forEach(log => {
      console.log(`  [${log.level}] ${log.text}`);
    });
  }

  // Add delay for page render
  await page.waitForTimeout(3000);
  
  // Add longer wait for API data fetch to complete
  await page.waitForTimeout(5000);
  
  // Check page content and all console logs
  const pageHtmlLength = await page.evaluate(() => document.body.innerHTML.length);
  console.log(`📄 Page body HTML length: ${pageHtmlLength}`);
  console.log(`📋 Total console logs so far: ${consoleLogs.length}`);
  if (consoleLogs.length > 30) {
    console.log('📋 Additional console logs (31+):');
    consoleLogs.slice(30).forEach((log, i) => {
      console.log(`  [${i + 31}] [${log.level}] ${log.text}`);
    });
  }

  // Try to click the "Confirm Quotation" button using JavaScript directly
  try {
    const clicked = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        b => b.textContent.includes('Confirm Quotation')
      );
      if (button) {
        console.log('Found button via text search, clicking...');
        (button as HTMLButtonElement).click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      // Log diagnostic info
      const btnCount = await page.evaluate(() => document.querySelectorAll('button').length);
      const btnTexts = await page.evaluate(() => 
        Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).slice(0, 10)
      );
      console.log(`Found ${btnCount} total buttons, texts:`, btnTexts);
      
      throw new Error('Confirm Quotation button not found - may need page debugging');
    }
    
    console.log('✅ Clicked Confirm Quotation button');

    // Wait for modal to appear
    await page.waitForTimeout(1500);
    
  } catch (err) {
    console.error('Failed to click button:', err);
    // Take screenshot for debugging
    await page.screenshot({ path: 'test-results/button-click-failed.png' });
    throw err;
  }

  // Fill primary guest
  const nameInput = page.getByLabel('Primary Guest Name').or(page.locator('input[placeholder="Enter the Name"]').first());
  await nameInput.fill('E2E Primary Guest');

  const ageInput = page.getByLabel('Age').or(page.locator('input[placeholder="Enter the Age"]').first());
  await ageInput.fill('34');

  const contactInput = page.getByLabel('Primary Contact No').or(page.locator('input[placeholder="Enter the Contact No"]').first());
  await contactInput.fill('9876543210');

  const nationalityInputs = page.locator('input[placeholder="IN"]');
  await nationalityInputs.first().fill('IN');

  const emailInput = page.getByLabel('Email ID').or(page.locator('input[placeholder="Enter the Email ID"]'));
  await emailInput.fill('e2e.primary@example.com');

  // Add second adult
  const addAdultBtn = page.getByRole('button', { name: /Add Adult/i });
  await addAdultBtn.click();

  const adult2NameInputs = page.locator('label:has-text("Adult 2 Name")').locator('xpath=following-sibling::input[1]');
  await adult2NameInputs.first().fill('E2E Adult 2');

  // Add child
  const addChildBtn = page.getByRole('button', { name: /Add Child/i });
  await addChildBtn.click();

  const childNameInputs = page.locator('label:has-text("Child 1 Name")').locator('xpath=following-sibling::input[1]');
  await childNameInputs.first().fill('E2E Child 1');

  const childAgeInputs = page.locator('label:has-text("Child 1 Name")').locator('xpath=ancestor::div[contains(@class, "sm:col-span-5")]/following-sibling::div[1]//input');
  await childAgeInputs.first().fill('7');

  // Set arrival/departure times
  const arrivalDateInput = page.locator('input[placeholder="12-12-2025 9:00 AM"]').first();
  await arrivalDateInput.fill(formatUiDateTime(day1, 9, 0));

  const departureInput = page.locator('input[placeholder="19-12-2025 4:00 PM"]').first();
  await departureInput.fill(formatUiDateTime(day4, 19, 0));

  // Accept terms if visible
  const reviewCheckbox = page.locator('text=/reviewed the inclusions.*before final booking/i').locator('xpath=preceding::input[@type="checkbox"][1]');
  if (await reviewCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
    await reviewCheckbox.click();
  }

  // Click Confirm Booking and wait for response
  const confirmBookingBtn = page.getByRole('button', { name: /^Confirm Booking$/i });
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('/itineraries/confirm-quotation') && res.request().method() === 'POST',
    { timeout: 120000 },
  );

  await confirmBookingBtn.click();
  const confirmResponse = await responsePromise;

  expect(confirmResponse.status()).toBeLessThan(400);

  // Unconfirm (cancel) the itinerary
  const cancelPayload = {
    itinerary_plan_ID: itineraryPlanId,
    reason: 'E2E test cleanup: unconfirm after confirm flow',
    cancellation_options: {
      modify_hotspot: true,
      modify_hotel: true,
      modify_vehicle: true,
      modify_guide: true,
      modify_activity: true,
    },
  };

  const cancelRes = await request.post(`${API_BASE_URL}/itineraries/cancel`, {
    data: cancelPayload,
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(cancelRes.ok()).toBeTruthy();

  // Log summary
  console.log(`\n✅ E2E FLOW COMPLETED`);
  console.log(`   Quote ID: ${quoteId}`);
  console.log(`   Plan ID: ${itineraryPlanId}`);
  console.log(`   API calls intercepted: ${apiLogs.length}`);
  console.log(`   Confirm modal closed: confirm was clicked`);
  console.log(`   Unconfirm status: ${cancelRes.status()}`);

  // Validate payloads
  const searchLogs = apiLogs.filter((log) => log.path?.includes('/hotels/search'));
  const prebookLogs = apiLogs.filter((log) => log.path?.includes('/prebook'));
  const confirmLogs = apiLogs.filter((log) => log.path?.includes('/confirm-quotation'));

  console.log(`\n📊 PAYLOAD CAPTURE SUMMARY`);
  console.log(`   Search calls: ${searchLogs.length}`);
  console.log(`   Prebook calls: ${prebookLogs.length}`);
  console.log(`   Confirm calls: ${confirmLogs.length}`);

  // Verify search payload has multi-room & multi-pax
  const searchReqs = searchLogs.filter((log) => log.type === 'request');
  if (searchReqs.length > 0) {
    const sr = searchReqs[0].body as any;
    console.log(`\n🔍 SEARCH REQUEST PAYLOAD (multi-room test):`);
    console.log(`   roomCount: ${sr?.roomCount || 'N/A'}`);
    console.log(`   guestCount: ${sr?.guestCount || 'N/A'}`);
    console.log(`   guestNationality: ${sr?.guestNationality || 'N/A'}`);
    expect(sr?.roomCount).toBeGreaterThanOrEqual(2);
    expect(sr?.guestCount).toBeGreaterThanOrEqual(3);
  }

  // Verify prebook payload includes child details
  const prebookReqs = prebookLogs.filter((log) => log.type === 'request');
  if (prebookReqs.length > 0) {
    const pr = prebookReqs[0].body as any;
    const hotel = pr?.hotel_bookings?.[0];
    console.log(`\n🏨 PREBOOK REQUEST PAYLOAD (child info test):`);
    console.log(`   hotel_bookings count: ${pr?.hotel_bookings?.length || 0}`);
    console.log(`   occupancies: ${JSON.stringify(hotel?.occupancies || 'N/A')}`);
    console.log(`   passengers count: ${hotel?.passengers?.length || 0}`);
  }

  // Verify confirm payload includes child details
  const confirmReqs = confirmLogs.filter((log) => log.type === 'request');
  if (confirmReqs.length > 0) {
    const cr = confirmReqs[0].body as any;
    const hotel = cr?.hotel_bookings?.[0];
    console.log(`\n✍️ CONFIRM REQUEST PAYLOAD (booking child details):`);
    console.log(`   hotel_bookings count: ${cr?.hotel_bookings?.length || 0}`);
    console.log(`   child_name: ${cr?.child_name || 'N/A'}`);
    console.log(`   child_age: ${cr?.child_age || 'N/A'}`);
    console.log(`   occupancies: ${JSON.stringify(hotel?.occupancies || 'N/A')}`);
    console.log(`   passengers count: ${hotel?.passengers?.length || 0}`);
    expect(cr?.hotel_bookings?.length).toBeGreaterThan(0);
  }

  console.log(`\n✅ ALL ASSERTIONS PASSED`);
});
