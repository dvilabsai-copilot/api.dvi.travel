import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelBlockingService } from '../src/modules/itineraries/services/hotel-blocking.service';
import { TboHotelBookingService } from '../src/modules/itineraries/services/tbo-hotel-booking.service';

function fortunePlaza() {
  const checkInDate = '2099-12-10';
  const checkOutDate = '2099-12-12';
  const common = { hotelCode: 'fixture-fortune', mealPlan: 'CP', currency: 'INR', isRefundable: true };
  const batches = ['Superior King', 'Deluxe Twin'].map((roomType, batchIndex) => {
    const roomCount = batchIndex === 0 ? 6 : 2;
    return {
      ...common, roomType, batchIndex, roomCount, startRoomIndex: batchIndex * 6,
      bookingCode: `search!TB!${batchIndex}`, supplierNetAmount: roomCount * 100, supplierTotalFare: roomCount * 100,
      occupancies: Array.from({ length: roomCount }, () => ({ adults: 2, children: 0, childrenAges: [] })),
    };
  });
  const stay = {
    ...common, schemaVersion: 1, provider: 'tbo', roomType: 'Superior King + Deluxe Twin',
    checkInDate, checkOutDate, routeIds: [17, 18], anchorRouteId: 17, roomCount: 8,
    supplierNetAmount: 800, supplierTotalFare: 800, searchVerifiedAt: new Date().toISOString(), batches,
  };
  const rows = stay.routeIds.map((route, index) => ({
    itinerary_plan_hotel_details_ID: 50 + index, itinerary_route_id: route,
    selected_price_snapshot: JSON.stringify({ tboMultiBatchStay: stay }),
  }));
  const requests: any[] = [];
  const calls: string[] = [];
  const state = { refundable: true, failure: '' };
  const prisma = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ quotation_status: 0, preferred_room_count: 8 }) },
    dvi_itinerary_plan_hotel_details: { findMany: async () => rows },
    dvi_hotel_block_request: {
      findMany: async ({ where }: any) => requests.filter(row => !where.status?.notIn?.includes(row.status)),
      create: async ({ data }: any) => {
        assert.equal(data.status, 'REQUESTED');
        assert.equal(requests.some(row => row.reservation_key === data.reservation_key), false);
        const row = { ...data, id: requests.length + 1 };
        requests.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(requests[where.id - 1], data),
    },
  };
  const supplier = Object.assign(Object.create(TboHotelBookingService.prototype), {
    USE_MOCK_TBO: false, PREBOOK_URL: 'prebook', BOOK_URL: 'hold',
    logger: { log() {}, warn() {}, error() {} }, authenticate: async () => 'fixture',
    client: {
      async post(endpoint: string, payload: any) {
        const index = Number(payload.BookingCode.slice(-1));
        const batch = batches[index];
        calls.push(`${endpoint}:${index}`);
        if (endpoint === 'prebook') {
          assert.equal(payload.BookingCode, state.failure === 'stale' ? `refreshed!TB!${index}` : batch.bookingCode);
          return { data: { Status: { Code: 200 }, HotelResult: [{ Rooms: [{
            BookingCode: `verified!TB!${index}`, NetAmount: batch.supplierNetAmount,
            IsRefundable: index === 0 || state.refundable, LastCancellationDeadline: '09-12-2099 20:00:00',
          }] }] } };
        }
        assert.equal(payload.BookingCode, `verified!TB!${index}`);
        assert.equal(payload.NetAmount, batch.supplierNetAmount);
        assert.equal(payload.IsVoucherBooking, false);
        assert.equal(payload.HotelRoomsDetails.length, batch.roomCount);
        assert.ok(payload.HotelRoomsDetails.every((room: any) => room.HotelPassenger.length === 2));
        if (index === 1 && state.failure === 'unknown') throw new Error('connection reset');
        if (index === 1 && state.failure === 'declined') {
          return { data: { BookResult: { Status: 2, ResponseStatus: 2, Error: { ErrorCode: 1, ErrorMessage: 'Rate declined' } } } };
        }
        return { data: { BookResult: { Status: 1, ResponseStatus: 1, BookingId: 250 + index, BookingRefNo: `hold-ref-${index}` } } };
      },
    },
  });
  const service = Object.assign(Object.create(HotelBlockingService.prototype), { prisma, tboHotelBooking: supplier });
  service.hotelDetailsTbo = { searchSelectedHotelForContinuousStay: async () => {
    calls.push('refresh');
    return [{ tboRoomBatches: batches.map(batch => ({ ...batch, bookingCode: `refreshed!TB!${batch.batchIndex}` })) }];
  } };
  const input = {
    planId: 7, groupType: 2, rows, stay, hotelName: 'Fortune Plaza', requestedAt: new Date(),
    policy: { tboHoldLcdBufferDays: 1 },
    bookings: batches.map(batch => ({
      hotelDetailsIds: [50, 51],
      selection: {
        ...batch, numberOfRooms: batch.roomCount, checkInDate, checkOutDate, guestNationality: 'IN',
        roomPassengerIndices: batch.occupancies.map((_, index) => [index * 2, index * 2 + 1]),
        passengers: Array.from({ length: batch.roomCount * 2 }, () => ({
          paxType: 1, age: 35, title: 'Mr', firstName: 'Fixture', lastName: 'Passenger',
        })),
      },
    })),
  };
  service.getDefaultHotelHoldCutoff = () => new Date('2099-12-08T12:00:00Z');
  return { state, input, service, requests, calls, hold: () => service.holdSplitVsrStay(input) };
}

test('Fortune Plaza 6+2 uses independent refundable PreBook codes and defers vouchers', async () => {
  const { service, requests, calls, hold } = fortunePlaza();
  const result = await hold();
  assert.deepEqual(calls, ['prebook:0', 'prebook:1', 'hold:0', 'hold:1']);
  assert.equal(result.outcome.status, 'HELD');
  assert.deepEqual(requests.map(row => [row.room_count, row.room_type, row.voucher_status]), [
    [6, 'Superior King', 'UNVOUCHERED'], [2, 'Deluxe Twin', 'UNVOUCHERED'],
  ]);
  assert.deepEqual(requests.map(row => JSON.parse(row.request_payload).supplierHold.bookingId), [250, 251]);
  assert.equal((await service.assertPlanReady(7, 2)).ready, true);
  assert.equal((await hold()).outcome.status, 'ALREADY_HELD');
  assert.equal(calls.length, 4);
});

test('a nonrefundable fresh PreBook in either batch prevents all supplier holds', async () => {
  const { state, hold, requests, calls } = fortunePlaza();
  state.refundable = false;
  await assert.rejects(hold, /Each VSR batch must have a refundable rate/);
  assert.deepEqual(calls, ['prebook:0', 'prebook:1']);
  assert.equal(requests.length, 0);
});

test('expired Search codes are refreshed once and the verified PreBook code stays batch-specific', async () => {
  const { state, input, hold, requests, calls } = fortunePlaza();
  state.failure = 'stale';
  input.stay.searchVerifiedAt = '2020-01-01T00:00:00Z';
  input.rows.forEach(row => { row.selected_price_snapshot = JSON.stringify({ tboMultiBatchStay: input.stay }); });
  await hold();
  assert.deepEqual(calls, ['refresh', 'prebook:0', 'prebook:1', 'hold:0', 'hold:1']);
  assert.deepEqual(requests.map(row => JSON.parse(row.request_payload).supplierHold.searchCode), [
    'refreshed!TB!0', 'refreshed!TB!1',
  ]);
});

test('a partial hold blocks payment and a definite decline can retry just the missing batch', async () => {
  const { state, service, hold, requests, calls } = fortunePlaza();
  state.failure = 'declined';
  await assert.rejects(hold, /Rate declined/);
  assert.deepEqual(requests.map(row => row.status), ['BLOCKED', 'SUPERSEDED']);
  await assert.rejects(() => service.assertPlanReady(7, 2));
  state.failure = '';
  await hold();
  assert.deepEqual(calls, ['prebook:0', 'prebook:1', 'hold:0', 'hold:1', 'prebook:1', 'hold:1']);
  assert.equal((await service.assertPlanReady(7, 2)).ready, true);
});

test('an unknown supplier result prevents duplicate holds and blocks payment', async () => {
  const { state, service, hold, requests, calls } = fortunePlaza();
  state.failure = 'unknown';
  await assert.rejects(hold, /connection reset/);
  assert.deepEqual(requests.map(row => row.status), ['BLOCKED', 'REQUESTED']);
  await assert.rejects(hold, /awaiting supplier confirmation/);
  await assert.rejects(() => service.assertPlanReady(7, 2));
  assert.equal(calls.length, 4);
});
