import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerariesController } from '../src/modules/itineraries/itineraries.controller';

test('compact reset response preserves complete per-day hotel inventory for the editor', () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  const result = (controller as any).buildCompactHotelAvailabilityResponse(
    {
      response: {
        hotels: [{
          itineraryRouteId: 11046,
          date: '2026-09-01',
          hotelName: 'MAMALLA HERITAGE',
          hotelCheckInDate: '2026-08-31',
          hotelCheckOutDate: '2026-09-02',
          actualGuestArrivalAt: '2026-09-01T06:00:00.000Z',
          earlyCheckIn: true,
          earlyCheckInExtraPaymentApplicable: true,
          previousDayBillingSynthetic: false,
          rateOptions: [{ id: 'selected-rate' }],
        }],
        hotelTabs: [],
        hotelSelectionState: [],
        hotelAvailability: {
          hasSupplierHotels: true,
          sharedHotelInventory: [
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'MAMALLA HERITAGE', rateOptions: [{ id: 'a' }] },
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'Grand Continent Hotels', rateOptions: [{ id: 'b' }] },
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'MGM Beach Resorts', rateOptions: [{ id: 'c' }] },
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'Radisson Blu Resort Temple Bay', rateOptions: [{ id: 'd' }] },
          ],
        },
      },
      changeSummary: null,
    },
    { overallCost: '0', costBreakdown: {} },
  );

  const inventory = result.hotelDetails.hotelAvailability.sharedHotelInventory;
  assert.equal(inventory.length, 4);
  assert.deepEqual(
    inventory.map((hotel: any) => hotel.hotelName),
    [
      'MAMALLA HERITAGE',
      'Grand Continent Hotels',
      'MGM Beach Resorts',
      'Radisson Blu Resort Temple Bay',
    ],
  );
  assert.deepEqual((inventory[0] as any).rateOptions, [{ id: 'a' }]);
  assert.deepEqual(result.hotelDetails.hotels[0].rateOptions, [{ id: 'selected-rate' }]);
  assert.equal(result.hotelDetails.hotels[0].hotelCheckInDate, '2026-08-31');
  assert.equal(result.hotelDetails.hotels[0].hotelCheckOutDate, '2026-09-02');
  assert.equal(result.hotelDetails.hotels[0].actualGuestArrivalAt, '2026-09-01T06:00:00.000Z');
  assert.equal(result.hotelDetails.hotels[0].earlyCheckIn, true);
  assert.equal(result.hotelDetails.hotels[0].earlyCheckInExtraPaymentApplicable, true);
  assert.equal(result.hotelDetails.hotels[0].previousDayBillingSynthetic, false);
});

test('initial compact response promotes an authoritative hotel over a blank route placeholder', () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  const result = (controller as any).buildCompactHotelAvailabilityResponse(
    {
      response: {
        hotels: [{ routeId: 11531, itineraryRouteId: 11531, groupType: 1, date: '2026-09-07', hotelName: '-', roomType: 'Deluxe' }],
        hotelTabs: [],
        hotelSelectionState: [],
        hotelAvailability: {
          availabilityState: 'FRESH',
          authoritativeRecommendationRows: [{
            routeId: 11531,
            authoritativeRouteIds: [11531],
            groupType: 1,
            date: '2026-09-07',
            hotelName: 'Munnar Live Hotel',
            provider: 'axisrooms',
            rateOptions: [{ rateOptionId: 'live-rate', roomType: 'Deluxe', mealPlan: 'CP', totalPrice: 5000 }],
          }],
          sharedHotelInventory: [{ hotelName: 'unused alternative', routeId: 11531 }],
        },
      },
      changeSummary: null,
    },
    null,
    false,
  );

  assert.equal(result.hotelDetails.hotels[0].hotelName, 'Munnar Live Hotel');
  assert.equal(result.hotelDetails.hotels[0].provider, 'axisrooms');
  assert.equal(result.hotelDetails.hotels[0].rateOptions[0].rateOptionId, 'live-rate');
  assert.equal(result.hotelDetails.hotelAvailability.sharedHotelInventory, undefined);
});

test('initial compact response exposes per-route load-more metadata without inventory rows', () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  const result = (controller as any).buildCompactHotelAvailabilityResponse(
    {
      response: {
        hotels: [{ routeId: 11531, itineraryRouteId: 11531, groupType: 1, date: '2026-09-07', hotelName: 'Selected Hotel' }],
        hotelTabs: [],
        hotelSelectionState: [],
        hotelIndex: [{
          provider: 'tbo',
          hotelCode: 'H-1',
          hotelName: 'Hotel 1',
          groupType: 1,
          routeId: 11531,
        }],
        routePagination: {
          '1-11531': { page: 0, pageSize: 20, total: 21, hasMore: true, groupType: 1 },
        },
        hotelAvailability: {
          sharedHotelInventory: Array.from({ length: 21 }, (_, index) => ({
            routeId: 11531,
            itineraryRouteId: 11531,
            groupType: 1,
            hotelName: `Hotel ${index + 1}`,
            rateOptions: [{ rateOptionId: `rate-${index + 1}` }],
          })),
        },
      },
      changeSummary: null,
    },
    null,
    false,
  );

  assert.equal(result.hotelDetails.hotelAvailability.sharedHotelInventory, undefined);
  assert.deepEqual(result.hotelDetails.routePagination['1-11531'], {
    page: 0,
    pageSize: 20,
    total: 21,
    hasMore: true,
    groupType: 1,
  });
});

test('persisted refresh alias returns selected rows without shared inventory by default', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  (controller as any).hotelAvailabilitySnapshotService = {
    readPersisted: async () => ({
      hotels: [{ hotelName: 'Selected hotel', routeId: 11531 }],
      hotelTabs: [{ groupType: 1, totalAmount: 500 }],
      hotelSelectionState: [{ groupType: 1, routes: [] }],
      hotelIndex: [{ hotelName: 'Cached alternative', routeId: 11531, groupType: 1 }],
      routePagination: {
        '1-11531': { page: 0, pageSize: 20, total: 100, hasMore: true, groupType: 1 },
      },
      hotelAvailability: {
        sharedHotelInventory: Array.from({ length: 100 }, (_, index) => ({
          hotelName: `Cached hotel ${index + 1}`,
          routeId: 11531,
        })),
      },
    }),
  };

  const response = await controller.getPersistedItineraryHotelDetails('DVI-REFRESH');

  assert.deepEqual(response.hotels, [{ hotelName: 'Selected hotel', routeId: 11531 }]);
  assert.equal(response.hotelAvailability.sharedHotelInventory, undefined);
assert.deepEqual((response as any).hotelIndex, [
  { hotelName: 'Cached alternative', routeId: 11531, groupType: 1 }
]);
  assert.deepEqual(response.routePagination['1-11531'], {
    page: 0,
    pageSize: 20,
    total: 100,
    hasMore: true,
    groupType: 1,
  });
});

test('persisted refresh handles unnamed hotels without authoritative rows', async () => {
  const controller = Object.create(
    ItinerariesController.prototype
  ) as ItinerariesController;

  (controller as any).hotelAvailabilitySnapshotService = {
    readPersisted: async () => ({
      hotels: [
        {
          routeId: 101,
          groupType: 1,
          date: '2026-10-17',
          hotelName: 'Selected Hotel',
        },
        {
          routeId: 102,
          groupType: 1,
          date: '2026-10-18',
          hotelName: '',
        },
      ],
      hotelTabs: [
        { groupType: 1, label: 'Recommended #1', totalAmount: 500 },
      ],
      hotelSelectionState: [],
    }),
  };

  const response =
    await controller.getPersistedItineraryHotelDetails('SPB2026102');

 assert.equal(response.hotels.length, 2);
assert.equal(response.hotels[0].hotelName, 'Selected Hotel');
assert.equal(response.hotels[1].hotelName, '');
assert.equal(response.hotelTabs[0].totalAmount, 500);
});

test('reset endpoint returns only a reset acknowledgement', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  (controller as any).itineraryAccessService = { assertQuoteRevisionEditable: async () => undefined };
  let resetQuoteId = '';
  (controller as any).hotelAvailabilitySnapshotService = {
    resetSelectionsOnly: async (quoteId: string) => {
      resetQuoteId = quoteId;
    },
  };
  (controller as any).detailsService = {
    getItineraryDetails: async () => { throw new Error('reset must not read itinerary details'); },
  };

const response = await controller.resetItineraryHotelAvailability(
  'DVI-RESET',
);

  assert.equal(resetQuoteId, 'DVI-RESET');
  assert.deepEqual(response, { resetApplied: true });
  assert.equal('hotelDetails' in response, false);
  assert.equal('financialSummary' in response, false);
});

test('acknowledgement returns accepted selections and financial totals without another supplier search', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  (controller as any).itineraryAccessService = {
    assertQuoteRevisionEditable: async (quoteId: string) => assert.equal(quoteId, 'DVI-ACK'),
    assertVehicleAgentHotelMutation: () => undefined,
    getQuoteAccessDecision: async () => ({ exists: true, allowed: true }),
  };
  let acceptedIds: number[] = [];
  (controller as any).hotelAvailabilitySnapshotService = {
    applyAcceptedSelectionChanges: async (quoteId: string, selectionIds: number[], userId: number, previewId: string) => {
      assert.equal(quoteId, 'DVI-ACK');
      assert.equal(userId, 7);
      assert.equal(previewId, 'approved-preview');
      acceptedIds = selectionIds;
      return { appliedCount: selectionIds.length, selectionIds };
    },
    readPersisted: async () => ({
      hotels: [{ hotelName: 'Accepted replacement' }],
      hotelTabs: [{ groupType: 1, totalAmount: 125 }],
      hotelSelectionState: [],
    }),
  };
  (controller as any).hotelDetailsService = {
    getHotelDetailsByQuoteId: async () => { throw new Error('fallback should not be needed'); },
  };
  (controller as any).detailsService = {
    getItineraryDetails: async () => ({ overallCost: 725, costBreakdown: { hotel: 125 } }),
  };

  const response = await controller.acknowledgeItineraryHotelAvailabilityChanges(
    'DVI-ACK',
    { selectionIds: [10, 11], previewId: 'approved-preview' },
    { user: { userId: 7, role: 1 } },
  );

  assert.deepEqual(acceptedIds, [10, 11]);
  assert.equal(response.appliedCount, 2);
  assert.equal(response.hotelDetails.hotels[0].hotelName, 'Accepted replacement');
  assert.equal(response.financialSummary.overallCost, 725);
});

test('ordinary availability check exposes its approval preview with the legacy reconciliation flag disabled', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  (controller as any).itineraryAccessService = { assertQuoteRevisionEditable: async () => undefined };
  let requestedReconciliation: boolean | undefined;
  (controller as any).hotelAvailabilitySnapshotService = {
    searchAndPersist: async (...args: any[]) => {
      requestedReconciliation = args[4];
      return {
        response: { hotels: [], hotelTabs: [], hotelSelectionState: [] },
        changeSummary: { hasChanges: true, totalChanges: 1, changes: [] },
        previewId: 'plain-check-preview',
      };
    },
  };
  (controller as any).logger = { log: () => undefined };
  (controller as any).detailsService = { getItineraryDetails: async () => ({ overallCost: 100 }) };
  const result = await controller.checkItineraryHotelAvailability('DVI-CHECK', {}, { user: { userId: 7 } });
  assert.equal(requestedReconciliation, false);
  assert.equal(result.reconciliationEnabled, true);
  assert.equal(result.previewId, 'plain-check-preview');
  assert.equal(result.changeSummary.hasChanges, true);
});

test('reconciliation check forwards the preview flag without applying changes', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  (controller as any).itineraryAccessService = { assertQuoteRevisionEditable: async () => undefined };
  const previousFlag = process.env.HOTEL_RECONCILE;
  process.env.HOTEL_RECONCILE = 'true';
  let received: unknown[] = [];
  (controller as any).hotelAvailabilitySnapshotService = {
    searchAndPersist: async (...args: unknown[]) => {
      received = args;
      return {
        response: { hotels: [], hotelTabs: [], hotelSelectionState: [] },
        changeSummary: { hasChanges: true, totalChanges: 1, changes: [] },
        previewId: 'hotel-preview-test',
      };
    },
  };
  (controller as any).logger = { log: () => undefined, error: () => undefined };
  (controller as any).detailsService = {
    getItineraryDetails: async () => ({ overallCost: 100, costBreakdown: { hotel: 100 } }),
  };

  const response = await controller.checkItineraryHotelAvailability(
    'DVI-CHECK',
    { reconciliation: true },
    { user: { userId: 7, role: 1 } },
  );

  assert.deepEqual(received.slice(0, 5), ['DVI-CHECK', 'CHECK_AVAILABILITY', 7, false, true]);
  assert.equal(response.previewId, 'hotel-preview-test');
  assert.equal(response.changeSummary.hasChanges, true);
  assert.equal(response.hotelDetails.hotelAvailability.sharedHotelInventory, undefined);
  if (previousFlag === undefined) delete process.env.HOTEL_RECONCILE;
  else process.env.HOTEL_RECONCILE = previousFlag;
});

test('offline catalogue requires quote access before reading its stay rates', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  const req = { user: { userId: 17 } };
  const lookups: Array<[string, number]> = [];
  (controller as any).itineraryAccessService = {
    getQuoteAccessDecision: async (quote: string, user: unknown) => {
      assert.equal(user, req.user);
      return { exists: quote !== 'missing', allowed: quote === 'allowed' };
    },
  };
  (controller as any).hotelAvailabilitySnapshotService = {
    readOfflineCatalogue: async (quote: string, routeId: number) => {
      lookups.push([quote, routeId]);
      return { hotels: [] };
    },
  };

  await assert.rejects(controller.readOfflineItineraryHotelCatalogue('missing', 10, req), /Itinerary not found/);
  await assert.rejects(controller.readOfflineItineraryHotelCatalogue('private', 10, req), /not allowed to access/);
  await assert.rejects(controller.readOfflineItineraryHotelCatalogue('allowed', 0, req), /Hotel stay route was not found/);
  assert.deepEqual(await controller.readOfflineItineraryHotelCatalogue('allowed', 10, req), { hotels: [] });
  assert.deepEqual(lookups, [['allowed', 10]]);
});
