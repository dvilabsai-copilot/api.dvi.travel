import assert from 'node:assert/strict';
import test from 'node:test';
import { groupContinuousHotelRows, HotelBlockingService } from '../src/modules/itineraries/services/hotel-blocking.service';
import { renderHotelBlockEmailHtml } from '../src/modules/itineraries/templates/hotel-block-email.template';

type Row = { hotel: string; checkIn: string; checkOut: string; roomType: string };

const groupRows = (rows: Row[]) => groupContinuousHotelRows(
  rows,
  (row) => row.hotel,
  (row) => row.checkIn,
  (row) => row.checkOut,
);

test('groups consecutive dates for the same hotel even when room categories differ', () => {
  const groups = groupRows([
    { hotel: 'AURUM', checkIn: '2026-10-28', checkOut: '2026-10-28', roomType: 'Garden Cottage' },
    { hotel: 'AURUM', checkIn: '2026-10-27', checkOut: '2026-10-27', roomType: 'Deluxe' },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((row) => row.roomType), ['Deluxe', 'Garden Cottage']);
});

test('does not merge a date gap or a different hotel', () => {
  const groups = groupRows([
    { hotel: 'AURUM', checkIn: '2026-10-27', checkOut: '2026-10-27', roomType: 'Deluxe' },
    { hotel: 'THE PATIO', checkIn: '2026-10-28', checkOut: '2026-10-28', roomType: 'Deluxe' },
    { hotel: 'AURUM', checkIn: '2026-10-29', checkOut: '2026-10-29', roomType: 'Deluxe' },
  ]);

  assert.equal(groups.length, 3);
});

test('renders nightly details in the combined email', () => {
  const html = renderHotelBlockEmailHtml({
    quotationReference: '12029',
    hotelName: 'AURUM RESORT',
    provider: 'AXISROOMS',
    checkIn: '27 Oct 2026',
    checkOut: '29 Oct 2026',
    roomType: 'Multiple room categories',
    mealPlan: 'MAP',
    roomCount: 1,
    responseUrl: 'https://example.test/respond',
    demoMode: false,
    intendedRecipient: 'hotel@example.test',
    stayDetails: [
      { checkIn: '27 Oct 2026', checkOut: '27 Oct 2026', roomType: 'Deluxe', mealPlan: 'MAP', roomCount: 1 },
      { checkIn: '28 Oct 2026', checkOut: '28 Oct 2026', roomType: 'Garden Cottage', mealPlan: 'MAP', roomCount: 1 },
    ],
  });

  assert.match(html, /Nightly stay details/);
  assert.match(html, /Garden Cottage/);
  assert.match(html, /27 Oct 2026/);
});

test('holdGroup dispatches one email for a continuous hotel and one for another hotel', async () => {
  process.env.PUBLIC_ITINERARY_BASE_URL = 'https://example.test';
  const selectedRows = [
    {
      itinerary_plan_hotel_details_ID: 101,
      itinerary_route_date: '2026-10-27',
      hotel_check_in_date: '2026-10-27',
      hotel_check_out_date: '2026-10-27',
      hotel_id: 10,
      hotel_code: 'AURUM-AXIS',
      hotel_provider: 'AXISROOMS',
      total_no_of_rooms: 1,
      selected_price_snapshot: JSON.stringify({ hotelName: 'AURUM RESORT', roomType: 'Deluxe', mealPlan: 'MAP' }),
    },
    {
      itinerary_plan_hotel_details_ID: 102,
      itinerary_route_date: '2026-10-28',
      hotel_check_in_date: '2026-10-28',
      hotel_check_out_date: '2026-10-28',
      hotel_id: 10,
      hotel_code: 'AURUM-AXIS',
      hotel_provider: 'AXISROOMS',
      total_no_of_rooms: 1,
      selected_price_snapshot: JSON.stringify({ hotelName: 'AURUM RESORT', roomType: 'Garden Cottage', mealPlan: 'MAP' }),
    },
    {
      itinerary_plan_hotel_details_ID: 103,
      itinerary_route_date: '2026-10-29',
      hotel_check_in_date: '2026-10-29',
      hotel_check_out_date: '2026-10-29',
      hotel_id: 20,
      hotel_code: 'PATIO-AXIS',
      hotel_provider: 'AXISROOMS',
      total_no_of_rooms: 1,
      selected_price_snapshot: JSON.stringify({ hotelName: 'THE PATIO', roomType: 'Deluxe Room', mealPlan: 'MAP' }),
    },
  ];
  const sent: Array<Record<string, any>> = [];
  let nextRequestId = 1;
  const prisma = {
    dvi_itinerary_plan_hotel_details: { findMany: async () => selectedRows },
    dvi_hotel: {
      findMany: async ({ where }: any) => where.hotel_id
        ? [
            { hotel_id: 10, hotel_name: 'AURUM RESORT', hotel_email: 'aurum@example.test', hotel_mobile: null },
            { hotel_id: 20, hotel_name: 'THE PATIO', hotel_email: 'patio@example.test', hotel_mobile: null },
          ]
        : [],
    },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [] },
    dvi_global_settings: { findFirst: async () => ({ hotel_blocked_cutoff_time: 1 }) },
    dvi_hotel_block_request: {
      findMany: async () => [],
      findUnique: async () => null,
    },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        create: async ({ data }: any) => ({ id: nextRequestId++, ...data }),
      },
      dvi_hotel_block_event: { create: async () => undefined },
      dvi_hotel_block_token: { create: async () => undefined },
      dvi_hotel_block_message: { create: async () => undefined },
    }),
  };
  const emailService = {
    dispatch: async (input: any) => {
      sent.push(input);
      return { status: 'QUEUED' as const };
    },
    deliveryRecipient: (recipient: string) => recipient,
    logFailure: (error: unknown) => String(error),
  };
  const service = new (HotelBlockingService as any)(prisma, emailService);

  const result = await service.holdGroup({
    itineraryPlanId: 12029,
    groupType: 1,
    guest: { name: 'Guest', email: 'guest@example.test', phone: '9999999999' },
  });

  assert.equal(result.requests.length, 2);
  assert.equal(sent.length, 2);
  const aurumEmail = sent.find((input) => input.request.hotelName === 'AURUM RESORT');
  assert.equal(aurumEmail?.request.stayDetails.length, 2);
  assert.deepEqual(aurumEmail?.request.stayDetails.map((detail: any) => detail.roomType), ['Deluxe', 'Garden Cottage']);
});
