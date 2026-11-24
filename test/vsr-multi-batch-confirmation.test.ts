import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';
import { ItineraryHotelPrebookService } from '../src/modules/itineraries/services/itinerary-hotel-prebook.service';
import { ItineraryHotelBookingFulfillmentService } from '../src/modules/itineraries/services/itinerary-hotel-booking-fulfillment.service';
import { ItineraryHotelConfirmationSupportService } from '../src/modules/itineraries/services/itinerary-hotel-confirmation-support.service';
import { TboHotelBookingService } from '../src/modules/itineraries/services/tbo-hotel-booking.service';
import { ItineraryConfirmedItineraryDetailsService } from '../src/modules/itineraries/services/itinerary-confirmed-itinerary-details.service';

const routeId = 17;
const checkInDate = '2099-12-10';
const checkOutDate = '2099-12-11';
const base = { success: true, itinerary_plan_ID: 1, confirmed_itinerary_plan_ID: 2 };
const identity = { hotelCode: '123', roomType: 'Standard', mealPlan: 'CP', currency: 'INR', isRefundable: true };
const batches = [6, 2].map((roomCount, batchIndex) => ({
  ...identity, batchIndex, startRoomIndex: batchIndex * 6, roomCount,
  bookingCode: 'saved!TB!' + batchIndex,
  supplierNetAmount: roomCount * 100, supplierTotalFare: roomCount * 100,
  occupancies: Array.from({ length: roomCount }, () => ({ adults: 1, children: 0, childrenAges: [] })),
}));
const stay = {
  ...identity, schemaVersion: 1, provider: 'tbo', anchorRouteId: routeId, routeIds: [routeId],
  roomCount: 8, checkInDate, checkOutDate, supplierNetAmount: 800, supplierTotalFare: 800,
  searchVerifiedAt: '2026-01-01T00:00:00Z', batches,
};
const draft = {
  itinerary_route_id: routeId, hotel_code: identity.hotelCode, total_no_of_rooms: 8,
  selected_price_snapshot: JSON.stringify({ tboMultiBatchStay: stay, roomType: identity.roomType, mealPlan: 'CP' }),
};
const makeDto = () => ({
  itinerary_plan_ID: 1, hotel_group_type: 3, agent: 4,
  vsrBatchFareApprovalToken: undefined as string | undefined,
  hotel_bookings: batches.map((batch) => ({
    ...identity, provider: 'tbo', routeId, routeIds: [routeId], hotelName: 'Fixture Hotel', checkInDate, checkOutDate,
    batchIndex: batch.batchIndex, startRoomIndex: batch.startRoomIndex, numberOfRooms: batch.roomCount,
    bookingCode: batch.bookingCode, occupancies: structuredClone(batch.occupancies), netAmount: 1,
    roomPassengerIndices: batch.occupancies.map((_, index) => [index]), guestNationality: 'IN',
    passengers: batch.occupancies.map(() => ({ firstName: 'Test', lastName: 'Guest', paxType: 1, age: 36, title: 'Mr' })),
  })),
});
const passthrough = <T,>(rows: T[]) => rows;
const emptyModel = { findMany: async () => [] };

function makeFixture(roomTypes?: string[]) {
  const selectedBatches = batches.map((batch, index) => ({ ...batch, roomType: roomTypes?.[index] || batch.roomType }));
  const selectedStay = { ...stay, batches: selectedBatches, roomType: [...new Set(selectedBatches.map(batch => batch.roomType))].join(' + ') };
  const calls: string[] = [];
  const stored: any[] = [];
  const attempts: any[] = [];
  let rejectedBatch = 1;
  let timedOutBatch = -1;
  let bookedFareIncrease = 0;
  let supplierPrecision = 0;
  let currentDraft = {
    ...draft, itinerary_plan_hotel_details_ID: 5, group_type: 3, hotel_margin_percentage: 10,
    selected_total_price: 880,
    selected_price_snapshot: JSON.stringify({ tboMultiBatchStay: selectedStay, roomType: selectedStay.roomType, mealPlan: 'CP' }),
  };
  const confirmedDrafts: any[] = [];
  const hotelModel = {
    findMany: async ({ where }: any) => where.selection_origin || where.itinerary_route_id?.notIn ? [] : [currentDraft],
    updateMany: async ({ where, data }: any) => {
      if (where.NOT) return { count: 0 };
      if (where.selected_price_snapshot !== currentDraft.selected_price_snapshot) return { count: 0 };
      currentDraft = { ...currentDraft, ...data };
      return { count: 1 };
    },
  };
  const prisma: any = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ nationality: 'IN' }), update: async () => undefined },
    dvi_confirmed_itinerary_plan_details: { update: async () => undefined },
    dvi_itinerary_plan_hotel_details: hotelModel,
    dvi_itinerary_plan_hotel_room_details: { updateMany: async () => undefined },
    dvi_itinerary_plan_hotel_room_amenities: { updateMany: async () => undefined },
    dvi_confirmed_itinerary_plan_hotel_details: {
      updateMany: async ({ data }: any) => { confirmedDrafts.push(data); },
    },
    dvi_confirmed_itinerary_plan_hotel_room_details: { updateMany: async () => undefined },
    $queryRaw: async () => [{ quotation_status: 0, itinerary_quote_ID: 'Fixture' }],
    $transaction: (work: (transaction: unknown) => unknown) => work(prisma),
    tbo_hotel_booking_confirmation: {
      findMany: async () => stored,
      create: async ({ data }: any) => {
        const row = { ...data, tbo_hotel_booking_confirmation_ID: stored.length + 1 };
        stored.push(row);
        return row;
      },
    },
    tbo_hotel_booking_attempt: {
      create: async ({ data }: any) => {
        if (attempts.some((row) => row.batch_index === data.batch_index)) throw { code: 'P2002' };
        const row = { ...data, id: attempts.length + 1 };
        attempts.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => attempts.find((row) =>
        typeof where.state === 'string'
          ? row.batch_index === where.batch_index && row.state === where.state && row.booking_code_hash === where.booking_code_hash
          : where.batch_index.in.includes(row.batch_index) && row.state !== where.state.not,
      ),
      update: async ({ where, data }: any) => Object.assign(attempts[where.id - 1], data),
      updateMany: async ({ where, data }: any) => {
        const row = attempts[where.id - 1];
        if (row.state !== where.state) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    resavenue_hotel_booking_confirmation: emptyModel,
    hobse_hotel_booking_confirmation: emptyModel,
    axisrooms_hotel_booking_confirmation: emptyModel,
    staah_hotel_booking_confirmation: emptyModel,
    dvi_hotel_block_request: emptyModel,
  };
  const supplier = Object.assign(Object.create(TboHotelBookingService.prototype), {
    prisma, USE_MOCK_TBO: false, PREBOOK_URL: 'prebook', BOOK_URL: 'book',
    logger: { log() {}, warn() {}, error() {} }, authenticate: async () => 'fixture',
    client: {
      post: async (endpoint: string, payload: any) => {
        const index = Number(String(payload.BookingCode).slice(-1));
        calls.push(endpoint + ' ' + index);
        if (endpoint === 'prebook') {
          assert.equal(payload.BookingCode, 'refreshed!TB!' + index);
          return { data: {
            Status: { Code: 200 }, BookingCode: 'verified!TB!' + index,
            NetAmount: batches[index].supplierNetAmount + (index === 1 ? bookedFareIncrease : 0) + supplierPrecision,
          } };
        }
        assert.equal(payload.BookingCode, 'verified!TB!' + index);
        assert.equal(payload.NetAmount, batches[index].supplierNetAmount + (index === 1 ? bookedFareIncrease : 0) + supplierPrecision);
        assert.equal(payload.IsVoucherBooking, true);
        assert.equal(payload.HotelRoomsDetails.length, batches[index].roomCount);
        if (index === timedOutBatch) throw new Error('timeout');
        if (index === rejectedBatch) {
          return { data: { BookResult: { Status: 2, ResponseStatus: 2, Error: { ErrorCode: 1, ErrorMessage: 'Booking rejected' } } } };
        }
        return { data: { BookResult: {
          Status: 1, ResponseStatus: 1, BookingId: 101 + index, BookingRefNo: 'reference-' + index, VoucherStatus: true,
        } } };
      },
    },
  });
  const prebook = new ItineraryHotelPrebookService(prisma, supplier, { normalizeSupplements: () => [] } as any);
  const mergeCallbacks = {
    mergeConsecutiveSupplierHotelBookings: passthrough, pruneHotelBookingsCoveredByMultiNight: passthrough,
    getProviderBookableHotelBookings: passthrough, getConfirmHotelGroupType: () => 3,
  };
  prebook.setCallbacks({
    ...mergeCallbacks, normalizeToArray: (value) => Array.isArray(value) ? value : value == null ? [] : [value],
    normalizeToUniqueStrings: (values) => [...new Set(values.map(String))], inferMealPlanFromInclusions: () => null,
  });
  const bookingKey = (provider: string, route: number) => provider + '::' + route;
  const support = new ItineraryHotelConfirmationSupportService(prisma, null as any);
  support.setCallbacks({
    ...mergeCallbacks, bookingKey, uniquePositiveNumbers: (items: number[]) => [...new Set(items.filter((id) => id > 0))],
    assertConsistentMultiNightHotelSelection: () => undefined,
  });
  const fulfillment = new ItineraryHotelBookingFulfillmentService(prisma, supplier, null as any, null as any, null as any, null as any);
  fulfillment.setCallbacks({
    ...mergeCallbacks, bookingKey, filterAlreadySuccessfulBookings: support.filterAlreadySuccessfulBookings.bind(support),
    isBookingResultSuccess: (result) => ['confirmed', 'already_confirmed'].includes(result.status),
    finalizeConfirmationFinancials: async () => { calls.push('financials'); },
    getConfirmedItineraryDetails: async () => ({ hotels: [] }),
  });
  const service = Object.assign(Object.create(ItinerariesService.prototype), {
    prisma, hotelPrebookService: prebook, hotelConfirmationSupportService: support,
    hotelBlockingService: { assertSplitVsrStayCanBook: async () => undefined },
    hotelDetailsTboService: {
      clearCacheForQuote: () => undefined,
      searchSelectedHotelForContinuousStay: async (params: any) => {
        calls.push('search');
        assert.deepEqual(params.vsrConfirmationRefresh.roomTypesByBatch, selectedBatches.map(batch => batch.roomType));
        return [{ isBookable: false, tboRoomBatches: selectedBatches.map((batch) => ({
          ...batch, bookingCode: 'refreshed!TB!' + batch.batchIndex,
        })) }];
      },
    },
    confirmationService: { ...mergeCallbacks, confirmQuotation: async () => base },
    syncAccountsAfterConfirmation: async () => undefined,
  });
  async function book(dto = makeDto(), actorId = 9) {
    await service.confirmQuotation(dto, actorId);
    const synced = await support.syncSelectedHotelDraftRowsForConfirmation(dto as any, 1);
    assert.deepEqual(synced.selectedRouteIds, [routeId]);
    assert.equal(synced.providerHotelBookings.length, 2);
    return fulfillment.processConfirmationWithTboBookings(base, dto as any, '127.0.0.1');
  }
  return {
    service, supplier, book, stored, attempts, calls, confirmedDrafts, draft: () => currentDraft,
    clearRejection: () => { rejectedBatch = -1; },
    increaseFare: (amount = 50) => { bookedFareIncrease = amount; },
    useSupplierPrecision: () => { supplierPrecision = 0.000345; },
    simulateTimeout: (batch: number) => { timedOutBatch = batch; },
  };
}

const previousBatchFlag = process.env.TBO_ENABLE_MULTI_BATCH_BOOKING;
test.before(() => { process.env.TBO_ENABLE_MULTI_BATCH_BOOKING = 'true'; });
test.after(() => {
  if (previousBatchFlag === undefined) delete process.env.TBO_ENABLE_MULTI_BATCH_BOOKING;
  else process.env.TBO_ENABLE_MULTI_BATCH_BOOKING = previousBatchFlag;
});

test('split VSR confirmation validates the whole saved stay and retries only the definitively rejected batch', async () => {
  const fixture = makeFixture();
  await assert.rejects(fixture.book(), /Partial booking success/);
  assert.deepEqual(fixture.calls, ['search', 'prebook 0', 'prebook 1', 'book 0', 'book 1']);
  assert.deepEqual(fixture.attempts.map((attempt) => attempt.state), ['CONFIRMED', 'REJECTED']);
  fixture.calls.length = 0;
  fixture.clearRejection();
  const result = await fixture.book();
  assert.equal(result.success, true);
  assert.deepEqual(fixture.calls, ['search', 'prebook 1', 'book 1', 'financials']);
  assert.deepEqual(fixture.stored.map((row) => [row.booking_code, row.number_of_rooms, row.net_amount]), [
    ['saved!TB!0', 6, 600], ['saved!TB!1', 2, 200],
  ]);
});

test('mixed VSR room types refresh and book with each batch’s own code', async () => {
  const roomTypes = ['Superior Twin', 'Deluxe Twin'];
  const fixture = makeFixture(roomTypes);
  const input = makeDto();
  input.hotel_bookings.forEach((booking, index) => { booking.roomType = roomTypes[index]; });
  const wrong = structuredClone(input);
  wrong.hotel_bookings[1].roomType = roomTypes[0];
  await assert.rejects(() => fixture.book(wrong), /submitted VSR batches do not match/);
  assert.deepEqual(fixture.calls, []);
  fixture.clearRejection();
  assert.equal((await fixture.book(input)).success, true);
  assert.deepEqual(fixture.calls, ['search', 'prebook 0', 'prebook 1', 'book 0', 'book 1', 'financials']);
  assert.deepEqual(fixture.stored.map(row => row.booking_code), ['saved!TB!0', 'saved!TB!1']);
});

test('split VSR confirmation rejects incomplete rooms and changed fares before supplier Book', async () => {
  const fixture = makeFixture();
  const incomplete = makeDto();
  incomplete.hotel_bookings.pop();
  await assert.rejects(fixture.book(incomplete), /needs 2 supplier batches/);
  assert.deepEqual(fixture.calls, []);
  fixture.increaseFare();
  await assert.rejects(fixture.book(), /VSR fares changed/);
  assert.deepEqual(fixture.calls, ['search', 'prebook 0', 'prebook 1']);
  assert.deepEqual(fixture.attempts, []);
});

test('split VSR confirmation requires scoped approval, persists the revised stay, and books with full supplier precision', async () => {
  const fixture = makeFixture();
  fixture.clearRejection();
  fixture.increaseFare();
  fixture.useSupplierPrecision();

  let approvalToken: string | undefined;
  await assert.rejects(fixture.book(), (error: any) => {
    const response = error.getResponse();
    assert.equal(response.code, 'VSR_RATE_CHANGED');
    assert.deepEqual(response.reviews, [{
      routeId, hotelName: 'Fixture Hotel', roomCount: 8, previousAmount: 880, newAmount: 935,
    }]);
    approvalToken = response.approvalToken;
    return typeof approvalToken === 'string';
  });
  assert.equal(fixture.draft().selected_total_price, 880);
  assert.deepEqual(fixture.attempts, []);

  await assert.rejects(fixture.book({ ...makeDto(), vsrBatchFareApprovalToken: approvalToken }, 10), /VSR fares changed/);
  fixture.increaseFare(60);
  await assert.rejects(fixture.book({ ...makeDto(), vsrBatchFareApprovalToken: approvalToken }), /VSR fares changed/);
  assert.equal(fixture.draft().selected_total_price, 880);
  assert.deepEqual(fixture.attempts, []);

  fixture.increaseFare();
  assert.equal((await fixture.book({ ...makeDto(), vsrBatchFareApprovalToken: approvalToken })).success, true);
  assert.equal(fixture.draft().selected_total_price, 935);
  assert.equal(JSON.parse(fixture.draft().selected_price_snapshot).tboMultiBatchStay.supplierNetAmount, 850);
  assert.equal(fixture.confirmedDrafts[0].selected_total_price, 935);
  assert.deepEqual(fixture.stored.map((row) => row.net_amount), [600, 250]);
});

test('an ambiguous split VSR Book timeout blocks a second attempt for that batch', async () => {
  const fixture = makeFixture();
  fixture.simulateTimeout(1);
  await assert.rejects(fixture.book(), /Partial booking success/);
  assert.deepEqual(fixture.attempts.map((attempt) => attempt.state), ['CONFIRMED', 'UNKNOWN']);
  fixture.calls.length = 0;
  await assert.rejects(fixture.book(), /Partial booking success/);
  assert.deepEqual(fixture.calls, ['search', 'prebook 1']);
});

test('an authentication failure before a split VSR Book can be retried', async () => {
  const fixture = makeFixture();
  fixture.supplier.authenticate = async () => { throw new Error('authentication unavailable'); };
  await assert.rejects(fixture.book(), /Partial booking success/);
  assert.deepEqual(fixture.calls, ['search', 'prebook 0', 'prebook 1']);
  assert.deepEqual(fixture.attempts, []);
  fixture.supplier.authenticate = async () => 'fixture';
  fixture.clearRejection();
  assert.equal((await fixture.book()).success, true);
});

test('confirmed itinerary shows all supplier references and the combined rooms and fare', async () => {
  const service = new ItineraryConfirmedItineraryDetailsService({
    dvi_confirmed_itinerary_plan_details: { findUnique: async () => base },
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 1, itinerary_quote_ID: 'Fixture' }) },
    dvi_itinerary_route_details: { findMany: async () => [{ itinerary_route_ID: routeId, itinerary_route_date: checkInDate }] },
    dvi_confirmed_itinerary_plan_hotel_details: emptyModel,
    dvi_confirmed_itinerary_plan_hotel_room_details: emptyModel,
    dvi_confirmed_itinerary_plan_hotel_voucher_details: emptyModel,
    tbo_hotel_booking_confirmation: {
      findMany: async () => batches.map((batch) => ({
        itinerary_route_ID: routeId, tbo_hotel_code: batch.hotelCode, booking_code: batch.bookingCode,
        tbo_booking_id: String(101 + batch.batchIndex), tbo_booking_reference_number: 'reference-' + batch.batchIndex,
        number_of_rooms: batch.roomCount, net_amount: batch.supplierNetAmount,
        api_response: { HotelName: 'Fixture Hotel', persistenceSnapshot: { batchIndex: batch.batchIndex } },
      })).reverse(),
    },
    resavenue_hotel_booking_confirmation: emptyModel, hobse_hotel_booking_confirmation: emptyModel,
    axisrooms_hotel_booking_confirmation: emptyModel, staah_hotel_booking_confirmation: emptyModel,
  } as any);
  service.setCallbacks({ listConfirmedGuideAssignments: async () => [] });
  const result = await service.getConfirmedItineraryDetails(2);
  assert.equal(result.hotels.length, 1);
  assert.equal(result.hotels[0].noOfRooms, 8);
  assert.equal(result.hotels[0].totalHotelCost, 800);
  assert.deepEqual(result.hotels[0].supplierBatches.map((batch) => batch.bookingRef), ['reference-0', 'reference-1']);
});
