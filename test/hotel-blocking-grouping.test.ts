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

test('uses the four-band hold policy at the calendar-day boundaries', () => {
  const requestedAt = '2026-01-01T10:00:00.000Z';
  assert.equal(hotelHoldDurationHours('2026-01-16', requestedAt), 48);
  assert.equal(hotelHoldDurationHours('2026-01-17', requestedAt), 12);
  assert.equal(hotelHoldDurationHours('2026-01-31', requestedAt), 12);
  assert.equal(hotelHoldDurationHours('2026-02-01', requestedAt), 48);
  assert.equal(hotelHoldCutoffAt('2026-01-16', requestedAt).toISOString(), '2026-01-03T10:00:00.000Z');
});

test('matches the configured hold decision at every requested lead-day boundary', () => {
  const requestedAt = '2026-01-01T10:00:00.000Z';
  const cases = [
    { leadDays: 0, checkIn: '2026-01-01', allowed: false, durationHours: null, band: null },
    { leadDays: 1, checkIn: '2026-01-02', allowed: false, durationHours: null, band: null },
    { leadDays: 2, checkIn: '2026-01-03', allowed: false, durationHours: null, band: null },
    { leadDays: 3, checkIn: '2026-01-04', allowed: true, durationHours: 48, band: '1-15' },
    { leadDays: 15, checkIn: '2026-01-16', allowed: true, durationHours: 48, band: '1-15' },
    { leadDays: 16, checkIn: '2026-01-17', allowed: true, durationHours: 12, band: '16-30' },
    { leadDays: 30, checkIn: '2026-01-31', allowed: true, durationHours: 12, band: '16-30' },
    { leadDays: 31, checkIn: '2026-02-01', allowed: true, durationHours: 48, band: '31-60' },
    { leadDays: 60, checkIn: '2026-03-02', allowed: true, durationHours: 48, band: '31-60' },
    { leadDays: 61, checkIn: '2026-03-03', allowed: true, durationHours: 240, band: '61+' },
    { leadDays: 75, checkIn: '2026-03-17', allowed: true, durationHours: 240, band: '61+' },
    { leadDays: 90, checkIn: '2026-04-01', allowed: true, durationHours: 240, band: '61+' },
  ] as const;

  for (const item of cases) {
    const decision = hotelHoldDecision(item.checkIn, requestedAt);
    assert.equal(decision.leadDays, item.leadDays, `lead day ${item.leadDays}`);
    assert.equal(decision.allowed, item.allowed, `eligibility at lead day ${item.leadDays}`);
    assert.equal(decision.durationHours, item.durationHours, `duration at lead day ${item.leadDays}`);
    assert.equal(decision.band, item.band, `band at lead day ${item.leadDays}`);
  }
});

test('fails closed when the check-in date is invalid', () => {
  const decision = hotelHoldDecision('not-a-date', '2026-01-01T10:00:00.000Z');
  assert.equal(decision.allowed, false);
  assert.equal(decision.durationHours, null);
  assert.equal(decision.reason, 'invalid check-in or request date');
});

test('caps TBO hold extensions at the stored fresh-rate LCD', () => {
  const service = new (HotelBlockingService as any)({}, {}, {});
  const request = {
    confirmation_channel: 'TBO_BOOK_HOLD',
    requested_at: new Date('2026-11-05T12:00:00.000Z'),
    check_in: '2026-11-20',
    cutoff_at: new Date('2026-11-07T00:00:00.000Z'),
    request_payload: JSON.stringify({ supplierHold: { lcdDeadlineAt: '2026-11-06T14:30:00.000Z' } }),
  };
  assert.equal(service.maxHotelHoldCutoff(request).toISOString(), '2026-11-06T14:30:00.000Z');

  request.request_payload = JSON.stringify({ supplierHold: {} });
  assert.equal(service.maxHotelHoldCutoff(request).toISOString(), '2026-11-07T12:00:00.000Z');
});

test('the rolling 48-hour cutoff allows a two-calendar-day lead only when more than 48 hours remain', () => {
  const policy = {
    noBlockBeforeHours: 48,
    minimumLeadDays: 1,
    shortLeadDays: 15,
    mediumLeadDays: 30,
    longLeadDays: 60,
    shortDurationHours: 48,
    mediumDurationHours: 12,
    longDurationHours: 48,
    extendedDurationHours: 240,
    tboHoldLcdBufferDays: 1,
  };
  const withinCutoff = hotelHoldDecision('2026-01-03T09:00:00.000Z', '2026-01-01T10:00:00.000Z', policy);
  const beyondCutoff = hotelHoldDecision('2026-01-03T11:00:00.000Z', '2026-01-01T10:00:00.000Z', policy);
  assert.equal(withinCutoff.allowed, false);
  assert.equal(beyondCutoff.allowed, true);
  assert.equal(beyondCutoff.durationHours, 48);
  assert.equal(hotelHoldDecision('2026-01-16T10:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).durationHours, 48);
  assert.equal(hotelHoldDecision('2026-01-31T10:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).durationHours, 12);
  assert.equal(hotelHoldDecision('2026-02-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', policy).durationHours, 48);
});

test('uses the hotel-local calendar day across a timezone offset and preserves the exact cutoff time', () => {
  const requestedAt = '2026-01-01T18:00:00.000Z';
  const checkIn = '2026-01-04T00:30:00+05:30';
  const decision = hotelHoldDecision(checkIn, requestedAt);

  assert.equal(decision.allowed, true);
  assert.equal(decision.leadDays, 3);
  assert.equal(decision.durationHours, 48);
  assert.equal(hotelHoldCutoffAt(checkIn, requestedAt).toISOString(), '2026-01-03T18:00:00.000Z');
});

test('keeps calendar-day lead times correct across month-end and year-end', () => {
  const monthEnd = hotelHoldDecision('2026-02-02', '2026-01-30T12:00:00.000Z');
  const yearEnd = hotelHoldDecision('2027-01-01', '2026-12-29T12:00:00.000Z');

  assert.equal(monthEnd.leadDays, 3);
  assert.equal(monthEnd.allowed, true);
  assert.equal(monthEnd.durationHours, 48);
  assert.equal(yearEnd.leadDays, 3);
  assert.equal(yearEnd.allowed, true);
  assert.equal(yearEnd.durationHours, 48);
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

test('provider hold notice email has no hotelier response link', () => {
  const html = renderHotelBlockEmailHtml({
    quotationReference: '12029',
    hotelName: 'AXIS HOTEL',
    provider: 'AXISROOMS',
    checkIn: '27 Nov 2026',
    checkOut: '28 Nov 2026',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    roomCount: 1,
    responseUrl: '',
    demoMode: false,
    intendedRecipient: 'hotel@example.test',
    emailKind: 'HOLD_NOTICE',
    cutoffAt: '27 Nov 2026, 4:00 PM',
  });

  assert.match(html, /Hotel Hold Created/);
  assert.match(html, /Hold expires/);
  assert.doesNotMatch(html, /Review &amp; Respond to Hotel Request/);
  assert.doesNotMatch(html, /href="https?:\/\//);
});

test('AxisRooms/offline hold extension email remains informational without creating a response link', () => {
  const html = renderHotelBlockEmailHtml({
    quotationReference: '12029',
    hotelName: 'OFFLINE HOTEL',
    provider: 'OFFLINE',
    checkIn: '27 Nov 2026',
    checkOut: '28 Nov 2026',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    roomCount: 1,
    responseUrl: 'https://example.test/should-not-be-used',
    demoMode: false,
    intendedRecipient: 'hotel@example.test',
    emailKind: 'HOLD_EXTENSION_NOTICE',
    previousCutoffAt: '27 Nov 2026, 4:00 PM',
    cutoffAt: '27 Nov 2026, 8:00 PM',
  });

  assert.match(html, /Hotel Hold Extended/);
  assert.match(html, /New hold until/);
  assert.doesNotMatch(html, /href="https?:\/\//);
});

test('AxisRooms hold uses the provider confirmation once, emails without an action link, and does not debit wallet', async () => {
  process.env.PUBLIC_ITINERARY_BASE_URL = 'https://example.test';
  const selectedRow = {
    itinerary_plan_hotel_details_ID: 101,
    itinerary_route_id: 9001,
    itinerary_route_date: '2027-01-10',
    hotel_check_in_date: '2027-01-10',
    hotel_check_out_date: '2027-01-11',
    hotel_id: 10,
    hotel_code: 'AX-10',
    hotel_provider: 'axisrooms',
    total_no_of_rooms: 1,
    total_room_cost: 5000,
    selected_rate_option_id: 'AX-RATE-1',
    selected_price_snapshot: JSON.stringify({ hotelName: 'Axis Hotel', roomType: 'Deluxe', mealPlan: 'CP', rateId: 'AX-RATE-1', roomId: 'AX-ROOM-1' }),
  };
  let persisted: any = null;
  let nextId = 500;
  const sent: any[] = [];
  const agentNotices: any[] = [];
  const providerCalls: any[] = [];
  const prisma: any = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'AXQ-1', total_adult: 2, total_children: 1, nationality: 101, agent_id: 50, staff_id: 0, createdby: 1 }),
    },
    dvi_agent: { findFirst: async () => ({ agent_name: 'Selected Agent', agent_lastname: 'One', agent_email_id: 'agent@example.test', travel_expert_id: 92 }) },
    dvi_staff_details: { findFirst: async () => ({ staff_name: 'Assigned Expert', staff_email: 'expert@example.test' }) },
    dvi_users: { findFirst: async () => null },
    dvi_itinerary_plan_hotel_details: { findMany: async () => [selectedRow] },
    dvi_hotel: { findMany: async () => [{ hotel_id: 10, hotel_name: 'Axis Hotel', hotel_email: 'hotel@example.test', hotel_mobile: null }] },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [{ itinerary_plan_hotel_details_id: 101, room_type_name: 'Deluxe', room_type_id: 4, room_qty: 1 }],
    },
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: {
      findMany: async ({ where }: any) => {
        if (!persisted) return [];
        if (where?.confirmation_channel) return [persisted];
        return [persisted];
      },
      findUnique: async () => null,
    },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        create: async ({ data }: any) => { persisted = { id: nextId++, ...data }; return persisted; },
      },
      dvi_hotel_block_event: { create: async () => undefined },
      dvi_hotel_block_token: { create: async () => undefined },
      dvi_hotel_block_message: { create: async () => undefined },
    }),
  };
  const emailService: any = {
    dispatch: async (input: any) => { sent.push(input); return { status: 'QUEUED' as const }; },
    dispatchAgentHoldCreated: async (input: any) => { agentNotices.push(input); return { status: 'QUEUED' as const }; },
    deliveryRecipient: (recipient: string) => recipient,
    logFailure: (error: unknown) => String(error),
  };
  const axisRooms = {
    pushForHotelSelection: async (input: any) => {
      providerCalls.push(input);
      return {
        success: true,
        payload: { confirmationNo: input.confirmationNo, bookingStatus: input.bookingStatus, paymentStatus: 0 },
        response: { status: 'success' },
      };
    },
  };
  const service = new (HotelBlockingService as any)(prisma, emailService, {}, axisRooms);
  const input = {
    itineraryPlanId: 12029,
    groupType: 1,
    guest: { name: 'Lead Guest', email: 'guest@example.test', phone: '9999999999' },
  };

  const first = await service.holdGroup(input);
  const second = await service.holdGroup(input);

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].bookingStatus, 'confirmed');
  assert.equal(providerCalls[0].persistConfirmation, false);
  assert.equal(providerCalls[0].hotel.occupancies[0].adults, 2);
  assert.equal(providerCalls[0].hotel.occupancies[0].children, 1);
  assert.equal(first.requests[0].status, 'BLOCKED');
  assert.equal(first.requests[0].responseUrl, undefined);
  assert.equal(first.walletDebited, 0);
  assert.equal(first.supplierBookingCalls, 1);
  assert.equal(second.requests[0].created, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.emailKind, 'HOLD_NOTICE');
  assert.equal(sent[0].request.responseUrl, undefined);
  assert.equal(agentNotices.length, 1);
  assert.deepEqual(agentNotices[0].recipients, [
    { role: 'Agent', name: 'Selected Agent One', email: 'agent@example.test' },
    { role: 'Travel Expert', name: 'Assigned Expert', email: 'expert@example.test' },
  ]);
});

test('offline hold is recorded locally without calling a supplier and has no hotelier action link', async () => {
  process.env.PUBLIC_ITINERARY_BASE_URL = 'https://example.test';
  const sent: any[] = [];
  let persisted: any = null;
  const prisma: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{
        itinerary_plan_hotel_details_ID: 301,
        itinerary_route_id: 9301,
        itinerary_route_date: '2027-01-10',
        hotel_check_in_date: '2027-01-10',
        hotel_check_out_date: '2027-01-11',
        hotel_id: 30,
        hotel_code: '30',
        hotel_provider: 'offline',
        hotel_booking_mode: 'MANUAL_APPROVAL',
        total_no_of_rooms: 1,
        selected_price_snapshot: JSON.stringify({ hotelName: 'Offline Hotel', roomType: 'Standard', mealPlan: 'CP' }),
      }],
    },
    dvi_hotel: { findMany: async () => [{ hotel_id: 30, hotel_name: 'Offline Hotel', hotel_email: 'hotel@example.test', hotel_mobile: null }] },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [] },
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: { findMany: async () => [], findUnique: async () => null },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        create: async ({ data }: any) => { persisted = { id: 701, ...data }; return persisted; },
      },
      dvi_hotel_block_event: { create: async () => undefined },
      dvi_hotel_block_token: { create: async () => { throw new Error('offline hold must not create a response token'); } },
      dvi_hotel_block_message: { create: async () => undefined },
    }),
  };
  const emailService: any = {
    dispatch: async (input: any) => { sent.push(input); return { status: 'QUEUED' as const }; },
    deliveryRecipient: (recipient: string) => recipient,
    logFailure: (error: unknown) => String(error),
  };
  const axisRooms = { pushForHotelSelection: async () => { throw new Error('offline hold must not call AxisRooms'); } };
  const service = new (HotelBlockingService as any)(prisma, emailService, {}, axisRooms);

  const result = await service.holdGroup({
    itineraryPlanId: 12030,
    groupType: 1,
    actor: { id: 9, name: 'Travel Expert', type: 'STAFF', roleId: 8 },
    guest: { name: 'Lead Guest', email: 'guest@example.test', phone: '9999999999' },
    hotelierContact: { name: 'Hotel Desk', phone: '8888888888' },
  });

  assert.equal(result.requests[0].status, 'BLOCKED');
  assert.equal(result.requests[0].responseUrl, undefined);
  assert.equal(result.supplierBookingCalls, 0);
  assert.equal(result.walletDebited, 0);
  assert.equal(persisted.confirmation_channel, 'OFFLINE_HOLD');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.emailKind, 'HOLD_NOTICE');
  assert.equal(sent[0].request.responseUrl, undefined);
});

test('a cancelled offline hold can be held again without reusing its unique reservation key', async () => {
  const cancelledRequest: any = {
    id: 701,
    itinerary_plan_id: 12030,
    group_type: 1,
    reservation_key: '12030|1|OFFLINE|30|2027-01-10|2027-01-11|selection:301',
    selection_ids: '[301]',
    provider: 'OFFLINE',
    hotel_id: 30,
    hotel_code: '30',
    hotel_name: 'Offline Hotel',
    check_in: new Date('2027-01-10T00:00:00.000Z'),
    check_out: new Date('2027-01-11T00:00:00.000Z'),
    room_type: 'Standard',
    meal_plan: 'CP',
    room_count: 1,
    status: 'CANCELLED',
    contact_email: 'hotel@example.test',
    contact_phone: null,
    contact_source: 'HOTEL_MASTER',
    confirmation_channel: 'OFFLINE_HOLD',
    requested_at: new Date('2026-11-05T10:00:00.000Z'),
    cutoff_at: null,
    version: 1,
  };
  const requests: any[] = [cancelledRequest];
  const sent: any[] = [];
  const events: any[] = [];
  const prisma: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{
        itinerary_plan_hotel_details_ID: 301,
        itinerary_route_id: 9301,
        itinerary_route_date: '2027-01-10',
        hotel_check_in_date: '2027-01-10',
        hotel_check_out_date: '2027-01-11',
        hotel_id: 30,
        hotel_code: '30',
        hotel_provider: 'offline',
        hotel_booking_mode: 'MANUAL_APPROVAL',
        total_no_of_rooms: 1,
        selected_price_snapshot: JSON.stringify({ hotelName: 'Offline Hotel', roomType: 'Standard', mealPlan: 'CP' }),
      }],
    },
    dvi_hotel: { findMany: async () => [{ hotel_id: 30, hotel_name: 'Offline Hotel', hotel_email: 'hotel@example.test', hotel_mobile: null }] },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [] },
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: {
      findMany: async ({ where }: any) => where?.confirmation_channel ? [] : requests,
      findUnique: async () => null,
    },
    dvi_hotel_block_message: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        create: async ({ data }: any) => {
          const request = { id: 702, ...data };
          requests.push(request);
          return request;
        },
      },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
      dvi_hotel_block_message: { create: async () => undefined },
    }),
  };
  const emailService: any = {
    dispatch: async (input: any) => { sent.push(input); return { status: 'SENT' as const }; },
    deliveryRecipient: (recipient: string) => recipient,
    logFailure: (error: unknown) => String(error),
  };
  const service = new (HotelBlockingService as any)(prisma, emailService, {}, {});
  const input = {
    itineraryPlanId: 12030,
    groupType: 1,
    actor: { id: 9, name: 'Travel Expert', type: 'STAFF', roleId: 8 },
    guest: { name: 'Lead Guest', email: 'guest@example.test', phone: '9999999999' },
    hotelierContact: { name: 'Hotel Desk', phone: '8888888888' },
    hotelDetailsIds: [301],
  };

  const first = await service.holdGroup(input);
  const retry = await service.holdGroup(input);

  assert.equal(first.requests[0].created, true);
  assert.equal(first.requests[0].status, 'BLOCKED');
  assert.equal(retry.requests[0].created, false);
  assert.equal(retry.requests[0].status, 'BLOCKED');
  assert.equal(cancelledRequest.status, 'CANCELLED');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].reservation_key, `${cancelledRequest.reservation_key}|retry:${cancelledRequest.id}`);
  assert.equal(events[0].event_type, 'REQUEST_CREATED');
  assert.equal(sent.length, 1);
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
      hotel_provider: 'RESAVENUE',
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
      hotel_provider: 'RESAVENUE',
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
      hotel_provider: 'RESAVENUE',
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

test('a failed supplier hold does not prevent an independent offline stay from being held', async () => {
  const selectedRows = [
    {
      itinerary_plan_hotel_details_ID: 801,
      itinerary_route_id: 9801,
      itinerary_route_date: '2027-02-10',
      hotel_check_in_date: '2027-02-10',
      hotel_check_out_date: '2027-02-11',
      hotel_id: 81,
      hotel_code: 'AXIS-REJECTED',
      hotel_provider: 'AXISROOMS',
      total_no_of_rooms: 1,
      selected_price_snapshot: JSON.stringify({ hotelName: 'Axis Hotel', roomType: 'Deluxe', mealPlan: 'CP' }),
    },
    {
      itinerary_plan_hotel_details_ID: 802,
      itinerary_route_id: 9802,
      itinerary_route_date: '2027-02-11',
      hotel_check_in_date: '2027-02-11',
      hotel_check_out_date: '2027-02-12',
      hotel_id: 82,
      hotel_code: 'OFFLINE-ACCEPTED',
      hotel_provider: 'OFFLINE',
      hotel_booking_mode: 'MANUAL_APPROVAL',
      total_no_of_rooms: 1,
      selected_price_snapshot: JSON.stringify({ hotelName: 'Offline Hotel', roomType: 'Standard', mealPlan: 'CP' }),
    },
  ];
  const persisted: any[] = [];
  const sent: any[] = [];
  let nextRequestId = 900;
  const hotels = [
    { hotel_id: 81, hotel_name: 'Axis Hotel', hotel_email: 'axis@example.test', hotel_mobile: null },
    { hotel_id: 82, hotel_name: 'Offline Hotel', hotel_email: 'offline@example.test', hotel_mobile: null },
  ];
  const prisma: any = {
    dvi_itinerary_plan_hotel_details: { findMany: async () => selectedRows },
    dvi_hotel: { findMany: async () => hotels },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [] },
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: { findMany: async () => [], findUnique: async () => null },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        create: async ({ data }: any) => {
          const request = { id: nextRequestId++, ...data };
          persisted.push(request);
          return request;
        },
      },
      dvi_hotel_block_event: { create: async () => undefined },
      dvi_hotel_block_token: { create: async () => undefined },
      dvi_hotel_block_message: { create: async () => undefined },
    }),
  };
  const emailService: any = {
    dispatch: async (input: any) => { sent.push(input); return { status: 'QUEUED' as const }; },
    deliveryRecipient: (recipient: string) => recipient,
    logFailure: (error: unknown) => String(error),
  };
  const axisRooms = {
    pushForHotelSelection: async () => ({ success: false, error: 'supplier rejected the request' }),
  };
  const service = new (HotelBlockingService as any)(prisma, emailService, {}, axisRooms);

  const result = await service.holdGroup({
    itineraryPlanId: 12043,
    groupType: 1,
    actor: { id: 9, name: 'Travel Expert', type: 'STAFF', roleId: 8 },
    guest: { name: 'Lead Guest', email: 'guest@example.test', phone: '9999999999' },
    hotelierContact: { name: 'Offline Desk', phone: '8888888888' },
  });

  assert.equal(result.success, true);
  assert.equal(result.partialSuccess, true);
  assert.equal(result.allSucceeded, false);
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0].status, 'FAILED');
  assert.match(result.outcomes[0].message, /supplier rejected/i);
  assert.equal(result.outcomes[1].status, 'HELD');
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].confirmationChannel, 'OFFLINE_HOLD');
  assert.equal(persisted.length, 1);
  assert.equal(sent.length, 1);
});

test('VSR hold is exposed as HOLD, refreshes supplier status, and reuses the same active rate', async () => {
  const selectedRow = {
    itinerary_plan_hotel_details_ID: 601,
    itinerary_route_date: '2026-12-15',
    hotel_check_in_date: '2026-12-15',
    hotel_check_out_date: '2026-12-16',
    hotel_id: 61,
    hotel_code: 'VSR-TEA-CASTLE',
    hotel_provider: 'VSR',
    total_no_of_rooms: 1,
    selected_price_snapshot: JSON.stringify({
      hotelName: 'Tea Castle',
      roomType: 'Executive Room',
      mealPlan: 'CP',
      isRefundable: true,
    }),
  };
  let persisted: any = null;
  let prebookCalls = 0;
  let holdCalls = 0;
  let holdSelection: any = null;
  let statusCalls = 0;
  let statusReference: string | undefined;
  let statusBookingId: string | number | undefined;
  const sent: any[] = [];
  const prisma: any = {
    dvi_itinerary_plan_hotel_details: { findMany: async () => [selectedRow] },
    dvi_hotel: { findMany: async () => [{ hotel_id: 61, hotel_name: 'Tea Castle', hotel_email: 'hotel@example.test' }] },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [] },
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: {
      findMany: async () => (persisted ? [persisted] : []),
      findUnique: async () => null,
    },
    dvi_hotel_block_message: { findMany: async () => [] },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        create: async ({ data }: any) => {
          persisted = { id: 700, ...data };
          return persisted;
        },
        update: async ({ data }: any) => {
          persisted = { ...persisted, ...data };
          return persisted;
        },
      },
      dvi_hotel_block_event: { create: async () => undefined },
      dvi_hotel_block_token: { create: async () => undefined },
      dvi_hotel_block_message: { create: async () => undefined },
    }),
  };
  const emailService = {
    dispatch: async (input: any) => { sent.push(input); return { status: 'QUEUED' as const }; },
    deliveryRecipient: (recipient: string) => recipient,
    logFailure: (error: unknown) => String(error),
  };
  const tboBooking = {
    preBookHotelForHold: async () => {
      prebookCalls += 1;
      return {
        Status: { Code: 300, Description: 'Insufficient Balance' },
        NetAmount: 3255.35,
        HotelResult: [{ Rooms: [{ IsRefundable: true, LastCancellationDeadline: '31-12-2099 23:59:59' }] }],
      };
    },
    holdHotel: async (_preBookResponse: any, selection: any) => {
      holdCalls += 1;
      holdSelection = selection;
      return { BookResult: { BookingRefNo: 'TBO-HOLD-700', BookingId: 700 } };
    },
    getHoldStatus: async (reference: string, bookingId: string | number) => {
      statusCalls += 1;
      statusReference = reference;
      statusBookingId = bookingId;
      return { status: 'Confirmed', bookingDeadline: '2026-12-15T18:00:00.000Z' };
    },
  };
  const service = new (HotelBlockingService as any)(prisma, emailService, tboBooking);
  const input = {
    itineraryPlanId: 12042,
    groupType: 1,
    guest: { name: 'Guest', email: 'guest@example.test', phone: '9999999999' },
    tboHoldBookings: [{
      hotelDetailsIds: [601],
      selection: {
        hotelCode: 'VSR-TEA-CASTLE', hotelName: 'Tea Castle', bookingCode: 'RATE-1',
        roomType: 'Executive Room', numberOfRooms: 1, netAmount: 3255.35,
      },
    }],
  };

  const first = await service.holdGroup(input);
  const second = await service.holdGroup(input);
  const refreshed = await service.listForItinerary(12042, 1);

  assert.equal(first.requests[0].status, 'HOLD');
  assert.equal(second.requests[0].status, 'HOLD');
  assert.equal(prebookCalls, 1);
  assert.equal(holdCalls, 1);
  assert.equal(holdSelection?.isVoucherBooking, false);
  assert.equal(sent.length, 0);
  assert.equal(refreshed[0].status, 'HOLD');
  assert.equal(statusCalls, 1);
  assert.equal(statusReference, 'TBO-HOLD-700');
  assert.equal(statusBookingId, 700);
});

test('an expired supplier status is exposed as HOLD expired', async () => {
  const service = new (HotelBlockingService as any)({}, {}, {
    getHoldStatus: async () => ({
      status: 'Cancelled',
      bookingDeadline: '2026-12-15T18:00:00.000Z',
    }),
  });
  const refreshed = await service.refreshSupplierHold({
    provider: 'VSR',
    confirmation_channel: 'TBO_BOOK_HOLD',
    confirmation_reference: 'TBO-HOLD-EXPIRED',
    cutoff_at: new Date('2026-12-15T18:00:00.000Z'),
  });

  assert.equal(refreshed.statusOverride, 'HOLD_EXPIRED');
});

test('VSR supplier status cannot extend the persisted policy hold cutoff', async () => {
  const policyCutoff = new Date('2026-12-10T14:00:00.000Z');
  const service = new (HotelBlockingService as any)({}, {}, {
    getHoldStatus: async () => ({
      status: 'Confirmed',
      bookingDeadline: '2026-12-15T18:00:00.000Z',
    }),
  });
  const refreshed = await service.refreshSupplierHold({
    provider: 'VSR',
    confirmation_channel: 'TBO_BOOK_HOLD',
    confirmation_reference: 'TBO-HOLD-POLICY-CUTOFF',
    cutoff_at: policyCutoff,
  });

  assert.equal(refreshed.statusOverride, 'HOLD');
  assert.equal(refreshed.cutoffAt.getTime(), policyCutoff.getTime());
});

test('an earlier VSR supplier LCD shortens the persisted policy hold cutoff', async () => {
  const supplierCutoff = new Date('2026-12-10T14:00:00.000Z');
  const service = new (HotelBlockingService as any)({}, {}, {
    getHoldStatus: async () => ({
      status: 'Confirmed',
      bookingDeadline: supplierCutoff.toISOString(),
    }),
  });
  const refreshed = await service.refreshSupplierHold({
    provider: 'VSR',
    confirmation_channel: 'TBO_BOOK_HOLD',
    confirmation_reference: 'TBO-HOLD-SUPPLIER-CUTOFF',
    cutoff_at: new Date('2026-12-15T18:00:00.000Z'),
  });

  assert.equal(refreshed.statusOverride, 'HOLD');
  assert.equal(refreshed.cutoffAt.getTime(), supplierCutoff.getTime());
});

test('changing a VSR hotel retires the local request without emailing the hotelier', async () => {
  const request: any = {
    id: 78,
    itinerary_plan_id: 12042,
    group_type: 1,
    status: 'BLOCKED',
    selection_ids: JSON.stringify([601]),
    hotel_id: 61,
    hotel_code: 'VSR-TEA-CASTLE',
    hotel_name: 'Tea Castle',
    provider: 'VSR',
    confirmation_channel: 'TBO_BOOK_HOLD',
    confirmation_reference: 'TBO-HOLD-700',
    check_in: '2026-12-15',
    check_out: '2026-12-16',
    requested_at: new Date('2026-11-01T10:00:00.000Z'),
    cutoff_at: new Date('2026-11-01T14:00:00.000Z'),
    request_payload: JSON.stringify({ supplierHold: { bookingCode: 'RATE-1' } }),
    version: 1,
  };
  const events: any[] = [];
  const sent: any[] = [];
  const prisma: any = {
    dvi_hotel_block_request: {
      findMany: async () => (request.status === 'BLOCKED' ? [request] : []),
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async ({ where }: any) => where.itinerary_plan_hotel_details_ID?.in
        ? [{
            itinerary_plan_hotel_details_ID: 601,
            itinerary_route_id: 9001,
            hotel_id: 61,
            hotel_code: 'VSR-TEA-CASTLE',
            hotel_provider: 'VSR',
            selected_price_snapshot: JSON.stringify({ hotelName: 'Tea Castle' }),
          }]
        : [{
            itinerary_plan_hotel_details_ID: 602,
            itinerary_route_id: 9001,
            hotel_id: 62,
            hotel_code: 'VSR-SNOW-LINE',
            hotel_provider: 'VSR',
            selected_price_snapshot: JSON.stringify({ hotelName: 'Snow Line Resort' }),
          }],
    },
    dvi_hotel_block_message: { update: async ({ data }: any) => data },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        update: async ({ data }: any) => { Object.assign(request, data); return request; },
      },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
      dvi_hotel_block_message: { create: async () => undefined },
    }),
  };
  const emailService: any = {
    deliveryRecipient: (recipient: string) => recipient,
    dispatch: async (input: any) => { sent.push(input); return { status: 'SENT' }; },
    logFailure: (error: unknown) => String(error),
  };
  const service = new (HotelBlockingService as any)(prisma, emailService, {});

  const result = await service.cancelHoldsAfterHotelChange({
    itineraryPlanId: 12042,
    groupType: 1,
    routeIds: [9001],
    actor: { id: 1, type: 'STAFF' },
  });

  assert.equal(result.cancelled, 1);
  assert.equal(result.emailsQueued, 0);
  assert.equal(sent.length, 0);
  assert.equal(request.status, 'CANCELLED');
  assert.match(events[0].notes, /TBO auto-cancels/);
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

test('staff hold extension advances the reminder version and only updates the active unpaid hold', async () => {
  const now = new Date();
  const requestedAt = new Date(now.getTime() - 60 * 60 * 1000);
  const existingCutoff = new Date(now.getTime() + 60 * 60 * 1000);
  const nextCutoff = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const request: any = {
    id: 78,
    status: 'BLOCKED',
    version: 4,
    requested_at: requestedAt,
    cutoff_at: existingCutoff,
    check_in: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    check_out: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
    request_payload: JSON.stringify({ quotationPlanId: 12030, stayDetails: [] }),
    contact_email: null,
  };
  const events: any[] = [];
  const whereAndData: any[] = [];
  const prisma: any = {
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: { findUnique: async () => request },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        updateMany: async ({ where, data }: any) => {
          whereAndData.push({ where, data });
          if (request.status !== 'BLOCKED' || request.paid_confirmed_at || request.cutoff_at !== where.cutoff_at) return { count: 0 };
          request.cutoff_at = data.cutoff_at;
          request.version += data.version.increment;
          return { count: 1 };
        },
        findUnique: async () => request,
      },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  const service = new (HotelBlockingService as any)(prisma, {});

  const result = await service.updateCutoff(78, nextCutoff.toISOString(), { id: 9, type: 'STAFF' });

  assert.equal(result.request.version, 5);
  assert.equal(new Date(result.request.cutoffAt).getTime(), nextCutoff.getTime());
  assert.deepEqual(whereAndData[0].where.status, { in: ['BLOCKED', 'CONFIRMED'] });
  assert.equal(whereAndData[0].where.paid_confirmed_at, null);
  assert.equal(whereAndData[0].data.version.increment, 1);
  assert.equal(events[0].event_type, 'HOLD_EXTENDED');
});

test('does not extend a hold if payment or expiry wins the concurrent update', async () => {
  const now = new Date();
  const request: any = {
    id: 79,
    status: 'BLOCKED',
    version: 1,
    requested_at: new Date(now.getTime() - 60 * 60 * 1000),
    cutoff_at: new Date(now.getTime() + 60 * 60 * 1000),
    check_in: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    check_out: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
  };
  const events: any[] = [];
  const prisma: any = {
    dvi_global_settings: { findFirst: async () => ({}) },
    dvi_hotel_block_request: { findUnique: async () => request },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: { updateMany: async () => ({ count: 0 }) },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  const service = new (HotelBlockingService as any)(prisma, {});

  await assert.rejects(
    () => service.updateCutoff(79, new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(), { id: 9, type: 'STAFF' }),
    /changed or expired/,
  );
  assert.equal(events.length, 0);
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
