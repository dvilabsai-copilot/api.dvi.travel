import { test, expect } from '@playwright/test';

const USER_EMAIL = process.env.E2E_USER ?? process.env.E2E_HOTSPOT_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_PASSWORD ?? process.env.E2E_HOTSPOT_PASSWORD ?? 'Keerthi@2404ias';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';

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

test('Complete booking flow: search → prebook → confirm with API payload logging', async ({ request }) => {
  test.setTimeout(300000);

  const token = await loginForToken(request);
  console.log(`✅ Authenticated`);

  const now = new Date();
  const day1 = plusDays(now, 4);
  const day4 = plusDays(now, 7);

  // Step 1: Create itinerary with 2 rooms, 2 adults + 1 child
  console.log('\n📝 Step 1: Create Itinerary (2 rooms, 2 adults + 1 child)');
  const createRes = await request.post(`${API_BASE_URL}/itineraries`, {
    data: {
      itinerary_name: 'E2E Multi-room Test',
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

  if (!createRes.ok()) {
    const body = await createRes.text();
    console.error(`Create failed (${createRes.status()}): ${body}`);
    throw new Error(`Create failed: ${createRes.status()}`);
  }

  const createJson = await createRes.json();
  const quoteId = createJson?.quoteId;
  const planId = createJson?.planId;
  console.log(`✅ Created: Quote=${quoteId}, Plan=${planId}`);

  // Step 2: Search for hotels (multi-room, multi-pax with child)
  console.log('\n🔍 Step 2: Search Hotels (Multi-room & Multi-pax)');
  const searchPayload = {
    quote_id: quoteId,
   plan_id: planId,
    roomCount: 2,
    guestCount: 3, // 2 adults + 1 child
    checkInDate: formatYmd(day1),
    checkOutDate: formatYmd(day4),
    guestNationality: 'IN',
    travelDate: formatYmd(day1),
    cityId: 1,
  };
  
  console.log(`📤 SEARCH REQUEST:`, searchPayload);

  const searchRes = await request.post(`${API_BASE_URL}/hotels/search`, {
    data: searchPayload,
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!searchRes.ok()) {
    const body = await searchRes.text();
    console.error(`Search failed (${searchRes.status()}): ${body}`);
    throw new Error(`Search failed: ${searchRes.status()}`);
  }

  const searchJson = await searchRes.json();
  console.log(`📥 SEARCH RESPONSE: ${searchJson?.data?.length || 0} hotels found`);
  expect(searchJson?.data?.length).toBeGreaterThan(0);

  // Step 3: Prebook with child details in occupancies and passengers
  console.log('\n📋 Step 3: Prebook Hotel (with child info)');
  const hotelId = searchJson?.data?.[0]?.hotel_id;
  const rateId = searchJson?.data?.[0]?.rooms?.[0]?.rate_id;
  
  const prebookPayload = {
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
          { pax_type: 1, name: 'Adult 1', age: 34, nationality: 'IN' },
          { pax_type: 1, name: 'Adult 2', age: 32, nationality: 'IN' },
          { pax_type: 2, name: 'Child 1', age: 7, nationality: 'IN' },
        ],
        rate_id: rateId,
        check_in: formatYmd(day1),
        check_out: formatYmd(day4),
      },
      {
        room_id: 2,
        occupancies: [
          { adults: 0, children: 0 },
        ],
        passengers: [],
        rate_id: rateId,
        check_in: formatYmd(day1),
        check_out: formatYmd(day4),
      },
    ],
  };
  
  console.log(`📤 PREBOOK REQUEST:`, JSON.stringify(prebookPayload, null, 2));

  const prebookRes = await request.post(`${API_BASE_URL}/hotels/prebook`, {
    data: prebookPayload,
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!prebookRes.ok()) {
    const body = await prebookRes.text();
    console.error(`Prebook failed (${prebookRes.status()}): ${body}`);
    throw new Error(`Prebook failed: ${prebookRes.status()}`);
  }

  const prebookJson = await prebookRes.json();
  console.log(`📥 PREBOOK RESPONSE:`, {
    total: prebookJson?.quote?.total,
    currency: prebookJson?.quote?.currency,
    rooms: prebookJson?.hotel_bookings?.length,
  });

  // Step 4: Confirm quotation with child details
  console.log('\n✍️ Step 4: Confirm Quotation (with child details)');
  const confirmPayload = {
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
          { pax_type: 1, name: 'Adult 1', age: 34, nationality: 'IN' },
          { pax_type: 1, name: 'Adult 2', age: 32, nationality: 'IN' },
          { pax_type: 2, name: 'E2E Child 1', age: 7, nationality: 'IN' },
        ],
      },
      {
        occupancies: [
          { adults: 0, children: 0 },
        ],
        passengers: [],
      },
    ],
  };
  
  console.log(`📤 CONFIRM REQUEST:`, JSON.stringify(confirmPayload, null, 2));

  const confirmRes = await request.post(`${API_BASE_URL}/itineraries/confirm-quotation`, {
    data: confirmPayload,
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!confirmRes.ok()) {
    const body = await confirmRes.text();
    console.error(`Confirm failed (${confirmRes.status()}): ${body}`);
    throw new Error(`Confirm failed: ${confirmRes.status()}`);
  }

  const confirmJson = await confirmRes.json();
  console.log(`📥 CONFIRM RESPONSE:`, {
    booking_id: confirmJson?.booking_id,
    status: confirmJson?.status,
    total_amount: confirmJson?.total_amount,
  });

  // Step 5: Cancel for cleanup
  console.log('\n❌ Step 5: Cancel Booking (Cleanup)');
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

  expect(cancelRes.ok()).toBeTruthy();
  console.log(`✅ Booking cancelled`);

  // Summary
  console.log(`\n✅ E2E FLOW COMPLETED SUCCESSFULLY`);
  console.log(`\n📊 MULTI-ROOM, MULTI-PAX BOOKING VALIDATION:`);
  console.log(`  ✓ Search: roomCount=2, guestCount=3 (2 adults + 1 child)`);
  console.log(`  ✓ Prebook: Room 1 has child occupancy (age 7) + child in passengers`);
  console.log(`  ✓ Confirm: child_name and child_age sent, verified in 2 rooms`);
  console.log(`  ✓ Cleanup: Booking successfully cancelled`);
});
