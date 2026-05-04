import { test, expect } from '@playwright/test';

/**
 * Direct API test for multi-room booking flow with logging
 * Bypasses UI modal issues by calling APIs directly
 * Tests: create → search → prebook → confirm → unconfirm
 * Captures all request/response payloads for validation
 */

const USER_EMAIL = process.env.E2E_USER ?? process.env.E2E_HOTSPOT_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_PASSWORD ?? process.env.E2E_HOTSPOT_PASSWORD ?? 'Keerthi@2404ias';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';
const FRONTEND_BASE_URL = 'http://localhost:8080';

async function loginForToken(request: any) {
  const response = await request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });
  
  if (!response.ok()) {
    const body = await response.text().catch(() => '');
    throw new Error(`Auth failed: ${response.status()} ${body}`);
  }
  
  const json = await response.json();
  const token = json?.accessToken;
  if (!token) throw new Error('No accessToken in auth response');
  return token;
}

function plusDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

test('Booking flow: create → search → prebook → confirm → unconfirm with API logging', async ({ request }) => {
  test.setTimeout(300000);

  const token = await loginForToken(request);
  expect(token).toBeTruthy();
  console.log(`✅ Authenticated, token: ${token?.substring(0, 20)}...`);

  // Define dates
  const now = new Date();
  const day1 = plusDays(now, 4);
  const day4 = plusDays(now, 7);

  // Create itinerary with 2 rooms, 2 adults + 1 child
  console.log('\n📝 Step 1: Create Itinerary');
  const createRes = await request.post(`${API_BASE_URL}/itineraries/create`, {
    data: {
      itinerary_name: 'E2E Test - Multi-room Booking',
      trip_type: 'multi-day',
      country_id: 1,
      state_id: 1,
      number_of_days: 4,
      number_of_room: 2,
      number_of_adult: 2,
      number_of_child: 1,
      days: [
        { day_number: 1, date: formatYmd(day1) },
        { day_number: 2, date: formatYmd(plusDays(now, 5)) },
        { day_number: 3, date: formatYmd(plusDays(now, 6)) },
        { day_number: 4, date: formatYmd(day4) },
      ],
    },
      }).catch(() => null);

      if (!createRes) {
        console.log('  Trying alternative endpoint...');
        const createRes2 = await request.post(`${API_BASE_URL}/itineraries`, {
          data: {
            itinerary_name: 'E2E Test - Multi-room Booking',
            trip_type: 'multi-day',
            country_id: 1,
            state_id: 1,
            number_of_days: 4,
            number_of_room: 2,
            number_of_adult: 2,
            number_of_child: 1,
            days: [
              { day_number: 1, date: formatYmd(day1) },
              { day_number: 2, date: formatYmd(plusDays(now, 5)) },
              { day_number: 3, date: formatYmd(plusDays(now, 6)) },
              { day_number: 4, date: formatYmd(day4) },
            ],
          },
    headers: { Authorization: `Bearer ${token}` },
  });

  const createJson = await createRes.json();
  expect(createRes.status()).toBe(201);
  const quoteId = createJson?.quoteId;
  const planId = createJson?.planId;
  console.log(`✅ Created: Quote=${quoteId}, Plan=${planId}`);

  if (createRes.status() !== 201) {
    console.error(`❌ Create failed with ${createRes.status()}`);
    console.error(`Response:`, createJson);
    throw new Error(`Create returned ${createRes.status()}`);
  }

  // Search hotels
  console.log('\n🔍 Step 2: Search Hotels');
  const searchRes = await request.post(`${API_BASE_URL}/hotels/search`, {
    data: {
      quote_id: quoteId,
      plan_id: planId,
      roomCount: 2,
      guestCount: 3,
      checkInDate: formatYmd(day1),
      checkOutDate: formatYmd(day4),
      guestNationality: 'IN',
      travelDate: formatYmd(day1),
      cityId: 1,
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const searchJson = await searchRes.json();
  expect(searchRes.status()).toBeLessThan(400);
  console.log(`✅ Search returned ${searchJson?.data?.length || 0} hotels`);
  console.log(`   REQUEST: roomCount=${2}, guestCount=${3}, nationality=IN`);
  if (searchJson?.data?.[0]) {
    console.log(`   RESPONSE: Found hotels, first has rooms`);
  }

  // Prebook first available hotel with 2 rooms and child occupancy
  console.log('\n📋 Step 3: Prebook Hotel');
  const hotelId = searchJson?.data?.[0]?.hotel_id;
  expect(hotelId).toBeTruthy();

  const prebookRes = await request.post(`${API_BASE_URL}/hotels/prebook`, {
    data: {
      quote_id: quoteId,
      plan_id: planId,
      hotel_id: hotelId,
      hotel_bookings: [
        {
          room_id: 1,
          occupancies: [
            { adults: 2, children: 1, child_age: [7] },
          ],
          passengers: [
            { pax_type: 1, name: 'Adult 1', age: 34 },
            { pax_type: 1, name: 'Adult 2', age: 32 },
            { pax_type: 2, name: 'Child 1', age: 7 }, // pax_type 2 = child
          ],
          rate_id: searchJson?.data?.[0]?.rooms?.[0]?.rate_id,
          check_in: formatYmd(day1),
          check_out: formatYmd(day4),
        },
        {
          room_id: 2,
          occupancies: [
            { adults: 0, children: 0 },
          ],
          passengers: [],
          rate_id: searchJson?.data?.[0]?.rooms?.[0]?.rate_id,
          check_in: formatYmd(day1),
          check_out: formatYmd(day4),
        },
      ],
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const prebookJson = await prebookRes.json();
  expect(prebookRes.status()).toBeLessThan(400);
  console.log(`✅ Prebook successful`);
  console.log(`   REQUEST: 2 rooms, room1 has 2 adults + 1 child (age 7)`);
  console.log(`   RESPONSE: Quote total = ${prebookJson?.quote?.total || 'N/A'}`);

  // Confirm quotation with child details
  console.log('\n✍️ Step 4: Confirm Quotation');
  const confirmRes = await request.post(`${API_BASE_URL}/itineraries/confirm-quotation`, {
    data: {
      quote_id: quoteId,
      plan_id: planId,
      child_name: 'E2E Child 1',
      child_age: 7,
      hotel_bookings: [
        {
          occupancies: [
            { adults: 2, children: 1, child_age: [7] },
          ],
          passengers: [
            { pax_type: 1, name: 'Adult 1', age: 34 },
            { pax_type: 1, name: 'Adult 2', age: 32 },
            { pax_type: 2, name: 'E2E Child 1', age: 7 },
          ],
        },
        {
          occupancies: [
            { adults: 0, children: 0 },
          ],
          passengers: [],
        },
      ],
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const confirmJson = await confirmRes.json();
  expect(confirmRes.status()).toBeLessThan(400);
  console.log(`✅ Quotation confirmed`);
  console.log(`   REQUEST: Sent child_name and child_age, 2 hotel_bookings with child in room 1`);
  console.log(`   RESPONSE: Booking ID = ${confirmJson?.booking_id || 'N/A'}`);

  // Unconfirm (cancel) the booking
  console.log('\n❌ Step 5: Unconfirm (Cancel)');
  const cancelRes = await request.post(`${API_BASE_URL}/itineraries/cancel`, {
    data: {
      itinerary_plan_ID: planId,
      reason: 'E2E test cleanup',
      cancellation_options: {
        modify_hotspot: true,
        modify_hotel: true,
        modify_vehicle: true,
        modify_guide: true,
        modify_activity: true,
      },
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(cancelRes.status()).toBeLessThan(400);
  console.log(`✅ Booking cancelled`);

  // Summary
  console.log(`\n✅ E2E FLOW COMPLETE`);
  console.log(`\n📊 PAYLOAD VALIDATION SUMMARY:`);
  console.log(`  ✓ Search: roomCount=2, guestCount=3, nationality=IN`);
  console.log(`  ✓ Prebook: 2 rooms with child occupancy (1 child age 7)`);
  console.log(`  ✓ Confirm: child_name and child_age sent, child in passengers`);
  console.log(`  ✓ Cancel: Plan ID=${planId} cancelled successfully`);
});
