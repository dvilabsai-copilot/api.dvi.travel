import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupContinuousHotelRows,
  hotelHoldCutoffAt,
  hotelHoldDecision,
  hotelHoldDurationHours,
  HotelBlockingService,
  resolveHotelContact,
} from '../src/modules/itineraries/services/hotel-blocking.service';
import { renderHotelBlockEmailHtml } from '../src/modules/itineraries/templates/hotel-block-email.template';

type Row = { hotel: string; checkIn: string; checkOut: string; roomType: string };

const groupRows = (rows: Row[]) => groupContinuousHotelRows(
  rows,
  (row) => row.hotel,
  (row) => row.checkIn,
  (row) => row.checkOut,
);

test('uses the lead-time hotel hold policy at the 15 and 30 day boundaries', () => {
  const requestedAt = '2026-01-01T10:00:00.000Z';
  assert.equal(hotelHoldDurationHours('2026-01-16', requestedAt), 4);
  assert.equal(hotelHoldDurationHours('2026-01-17', requestedAt), 12);
  assert.equal(hotelHoldDurationHours('2026-01-31', requestedAt), 12);
  assert.equal(hotelHoldDurationHours('2026-02-01', requestedAt), 48);
  assert.equal(hotelHoldCutoffAt('2026-01-16', requestedAt).toISOString(), '2026-01-01T14:00:00.000Z');
});

test('blocks holds inside the minimum lead band and the 48-hour no-block window', () => {
  const policy = {
    noBlockBeforeHours: 48,
    minimumLeadDays: 3,
    shortLeadDays: 15,
    mediumLeadDays: 30,
    shortDurationHours: 4,
    mediumDurationHours: 12,
    longDurationHours: 48,
  };
  assert.equal(hotelHoldDecision('2026-01-03T23:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).allowed, false);
  assert.equal(hotelHoldDecision('2026-01-03T09:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).allowed, false);
  assert.equal(hotelHoldDecision('2026-01-16T10:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).durationHours, 4);
  assert.equal(hotelHoldDecision('2026-01-31T10:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).durationHours, 12);
  assert.equal(hotelHoldDecision('2026-02-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).durationHours, 48);
});

test('uses the TBO master hotel email only when the primary hotel email is empty', () => {
  const tboMaster = { hotel_name: 'TBO HOTEL', hotel_email: 'tbo@example.test', hotel_mobile: '+911111111111' };
  assert.equal(resolveHotelContact({ hotel_name: 'TBO HOTEL', hotel_email: null }, tboMaster).hotel_email, 'tbo@example.test');
  assert.equal(resolveHotelContact({ hotel_name: 'TBO HOTEL', hotel_email: 'primary@example.test' }, tboMaster).hotel_email, 'primary@example.test');
  assert.equal(resolveHotelContact(undefined, tboMaster).hotel_mobile, '+911111111111');
});

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
      itinerary_route_date: '2026-11-27',
      hotel_check_in_date: '2026-11-27',
      hotel_check_out_date: '2026-11-27',
      hotel_id: 10,
      hotel_code: 'AURUM-AXIS',
      hotel_provider: 'AXISROOMS',
      total_no_of_rooms: 1,
      selected_price_snapshot: JSON.stringify({ hotelName: 'AURUM RESORT', roomType: 'Deluxe', mealPlan: 'MAP' }),
    },
    {
      itinerary_plan_hotel_details_ID: 102,
      itinerary_route_date: '2026-11-28',
      hotel_check_in_date: '2026-11-28',
      hotel_check_out_date: '2026-11-28',
      hotel_id: 10,
      hotel_code: 'AURUM-AXIS',
      hotel_provider: 'AXISROOMS',
      total_no_of_rooms: 1,
      selected_price_snapshot: JSON.stringify({ hotelName: 'AURUM RESORT', roomType: 'Garden Cottage', mealPlan: 'MAP' }),
    },
    {
      itinerary_plan_hotel_details_ID: 103,
      itinerary_route_date: '2026-11-29',
      hotel_check_in_date: '2026-11-29',
      hotel_check_out_date: '2026-11-29',
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

test('allows a hotelier to shorten the hold but keeps staff extensions one-way', async () => {
  const now = new Date();
  const requestedAt = new Date(now.getTime() - 60 * 60 * 1000);
  const existingCutoff = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const earlierCutoff = new Date(now.getTime() + 60 * 60 * 1000);
  const request = {
    id: 77,
    status: 'CONFIRMATION_AWAITED',
    requested_at: requestedAt,
    cutoff_at: existingCutoff,
    check_in: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    check_out: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
    request_payload: JSON.stringify({ quotationPlanId: 12029, stayDetails: [] }),
  };
  const prisma = {
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: {
      findUnique: async () => request,
    },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        update: async ({ data }: any) => ({ ...request, ...data }),
      },
      dvi_hotel_block_event: { create: async () => undefined },
    }),
  };
  const service = new (HotelBlockingService as any)(prisma, {});

  const hotelierResult = await service.transition(77, 'BLOCKED', {
    actor: { type: 'HOTEL_LINK' },
    eventType: 'HOTEL_RESPONSE_RECORDED',
    cutoffAt: earlierCutoff,
  });
  assert.equal(new Date(hotelierResult.request.cutoffAt).getTime(), earlierCutoff.getTime());

  await assert.rejects(
    () => service.transition(77, 'BLOCKED', {
      actor: { type: 'STAFF' },
      eventType: 'HOTEL_RESPONSE_RECORDED',
      cutoffAt: earlierCutoff,
    }),
    /current hold cutoff/,
  );
});

test('cancels the previous hold and emails the hotelier when a selected hotel changes', async () => {
  const request: any = {
    id: 77,
    itinerary_plan_id: 12029,
    group_type: 1,
    status: 'BLOCKED',
    selection_ids: JSON.stringify([501]),
    hotel_id: 10,
    hotel_code: 'AURUM-AXIS',
    hotel_name: 'AURUM RESORT',
    provider: 'AXISROOMS',
    check_in: '2026-10-29',
    check_out: '2026-10-30',
    room_type: 'Deluxe',
    meal_plan: 'MAP',
    room_count: 1,
    contact_email: 'aurum@example.test',
    contact_phone: null,
    requested_at: new Date('2026-10-26T10:00:00.000Z'),
    cutoff_at: new Date('2026-10-26T14:00:00.000Z'),
    request_payload: JSON.stringify({ stayDetails: [] }),
    version: 1,
  };
  const currentRow = {
    itinerary_plan_hotel_details_ID: 502,
    itinerary_route_id: 9001,
    hotel_id: 20,
    hotel_code: 'PATIO-AXIS',
    hotel_provider: 'AXISROOMS',
    selected_price_snapshot: JSON.stringify({ hotelName: 'THE PATIO' }),
    hotel_required: 1,
    status: 1,
    deleted: 0,
  };
  const sent: any[] = [];
  const events: any[] = [];
  const messages: any[] = [];
  const prisma: any = {
    dvi_hotel_block_request: {
      findMany: async () => request.status === 'BLOCKED' ? [request] : [],
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async ({ where }: any) => where.itinerary_plan_hotel_details_ID?.in ? [{
        itinerary_plan_hotel_details_ID: 501,
        itinerary_route_id: 9001,
        hotel_id: 10,
        hotel_code: 'AURUM-AXIS',
        hotel_provider: 'AXISROOMS',
        selected_price_snapshot: JSON.stringify({ hotelName: 'AURUM RESORT' }),
      }] : [currentRow],
    },
    dvi_hotel_block_message: {
      update: async ({ data }: any) => ({ ...data }),
    },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        update: async ({ data }: any) => {
          Object.assign(request, data);
          return request;
        },
      },
      dvi_hotel_block_event: {
        create: async ({ data }: any) => {
          events.push(data);
        },
      },
      dvi_hotel_block_message: {
        create: async ({ data }: any) => {
          const message = { id: 901, ...data };
          messages.push(message);
          return message;
        },
      },
    }),
  };
  const emailService: any = {
    deliveryRecipient: (recipient: string) => recipient,
    dispatch: async (input: any) => {
      sent.push(input);
      return { status: 'SENT' as const, providerMessageId: 'provider-1' };
    },
    logFailure: (error: unknown) => String(error),
  };
  const service = new (HotelBlockingService as any)(prisma, emailService);

  const result = await service.cancelHoldsAfterHotelChange({
    itineraryPlanId: 12029,
    groupType: 1,
    routeIds: [9001],
    actor: { id: 1, type: 'STAFF' },
  });

  assert.equal(result.cancelled, 1);
  assert.equal(result.emailsQueued, 1);
  assert.equal(request.status, 'CANCELLED');
  assert.equal(request.cutoff_at, null);
  assert.equal(events[0].event_type, 'HOTEL_CHANGE_HOLD_CANCELLED');
  assert.equal(messages.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.emailKind, 'CANCELLATION');
  assert.match(sent[0].request.hotelName, /AURUM RESORT/);

  const repeated = await service.cancelHoldsAfterHotelChange({
    itineraryPlanId: 12029,
    groupType: 1,
    routeIds: [9001],
  });
  assert.equal(repeated.cancelled, 0);
  assert.equal(sent.length, 1);
});
