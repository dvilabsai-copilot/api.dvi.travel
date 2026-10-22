import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';
import { OfflineHotelCatalogService } from '../src/modules/itineraries/services/offline-hotel-catalog.service';

const pricing = {
  resolveEffectiveHotelMarginPercentage: async () => 0,
  marginBreakdown: (value: number) => ({ baseAmount: value, marginPercentage: 0, marginAmount: 0, sellAmount: value }),
  money: (value: number) => Number(value.toFixed(2)),
} as any;

const inventory = (hotelId: number, roomId: number, dates: string[], free = 3) =>
  new Map([[`${hotelId}|${roomId}`, dates.map((date) => ({
    hotel_id: hotelId,
    room_id: roomId,
    start_date: new Date(`${date}T00:00:00.000Z`),
    end_date: new Date(`${date}T00:00:00.000Z`),
    free,
    received_at: new Date('2026-01-01T00:00:00.000Z'),
  }))]]);

const catalog = (dates: string[], ratePlan = 'MAP_PLAN', includeRate = true, includeInventory = true) => ({
  roomsByHotel: new Map([[700, [{ room_ID: 701, room_type_id: 70, room_title: 'Deluxe Room' }]]]),
  activeRoomTypeIds: new Set([70]),
  ratePlansByRoom: new Map([[701, [{ room_id: 701, rateplan_id: ratePlan, rateplan_name: ratePlan, meal_plan_description: ratePlan }]]]),
  occupancyRatesByRoomPlan: new Map(includeRate ? [[`700|701|${ratePlan}`, dates.map((date) => ({
    start_date: new Date(`${date}T00:00:00.000Z`),
    end_date: new Date(`${date}T00:00:00.000Z`),
    occupancy_rates: { DOUBLE: 4200 },
  }))]] : []),
  inventoryByHotelRoom: includeInventory ? inventory(700, 701, dates) : new Map(),
  mealPricebookByHotelDate: new Map(),
});

test('offline catalog requires a matching meal-plan rate and price for every night', async () => {
  const service = new OfflineHotelCatalogService({} as any, pricing);

  const valid = await (service as any).buildRoomOffersFromCatalogRows(
    { hotel_id: 700 },
    ['2026-12-27', '2026-12-28'],
    1,
    2,
    0,
    catalog(['2026-12-27', '2026-12-28']),
    0,
    'MAP',
  );
  assert.equal(valid.length, 1);
  assert.equal(valid[0].mealPlan, 'MAP');
  assert.deepEqual(valid[0].nightlySell, [4200, 4200]);

  const partialCatalog = catalog(['2026-12-27', '2026-12-28']);
  partialCatalog.occupancyRatesByRoomPlan.get('700|701|MAP_PLAN')!.pop();
  const partial = await (service as any).buildRoomOffersFromCatalogRows(
    { hotel_id: 700 },
    ['2026-12-27', '2026-12-28'],
    1,
    2,
    0,
    partialCatalog,
    0,
    'MAP',
  );
  assert.equal(partial.length, 1);
  assert.equal(partial[0].completeStayBookable, false);
  assert.deepEqual(partial[0].availableDates, ['2026-12-27']);
  assert.deepEqual(partial[0].unavailableDates, ['2026-12-28']);
  assert.deepEqual(partial[0].nightlySell, [4200, 0]);

  const missingInventory = await (service as any).buildRoomOffersFromCatalogRows(
    { hotel_id: 700 },
    ['2026-12-27', '2026-12-28'],
    1,
    2,
    0,
    catalog(['2026-12-27', '2026-12-28'], 'MAP_PLAN', true, false),
    0,
    'MAP',
  );
  assert.equal(missingInventory.length, 1);
  assert.deepEqual(missingInventory[0].nightlySell, [4200, 4200]);

  const missingMapRate = await (service as any).buildRoomOffersFromCatalogRows(
    { hotel_id: 700 },
    ['2026-12-27'],
    1,
    2,
    0,
    catalog(['2026-12-27'], 'CP_PLAN', true, true),
    0,
    'MAP',
  );
  assert.deepEqual(missingMapRate, []);
});

test('legacy offline pricebook retains a partial stay with the missing night', () => {
  const service = new OfflineHotelCatalogService({} as any, pricing);
  const offers = (service as any).buildRoomOffersFromLegacyPricebook(
    { hotel_id: 200 },
    ['2026-11-26', '2026-11-27'],
    1,
    2,
    0,
    {
      roomsByHotel: new Map([[200, [{ room_ID: 518, room_type_id: 274, room_title: 'Executive Room' }]]]),
      activeRoomTypeIds: new Set([274]),
      legacyPricebookByRoom: new Map([['200|518|274', [{
        hotel_id: 200,
        room_id: 518,
        room_type_id: 274,
        price_type: 0,
        year: '2026',
        month: 'November',
        day_26: '3700',
        day_27: '0',
      }]]]),
      ratePlansByRoom: new Map(),
      occupancyRatesByRoomPlan: new Map(),
      mealPricebookByHotelDate: new Map(),
    },
    5,
    'CP',
  );

  assert.equal(offers.length, 1);
  assert.equal(offers[0].completeStayBookable, false);
  assert.deepEqual(offers[0].availableDates, ['2026-11-26']);
  assert.deepEqual(offers[0].unavailableDates, ['2026-11-27']);
  assert.deepEqual(offers[0].nightlySell, [3700, 0]);
});

const offlineCandidates = [{
  routeId: 17019,
  itineraryRouteId: 17019,
  date: '2026-12-27',
  provider: 'offline',
  hotelCode: 'LOCAL-700',
  providerHotelCode: 'LOCAL-700',
  canonicalHotelId: 700,
  hotelId: 700,
  hotelName: 'Local Chennai Hotel',
  roomType: 'Deluxe Room',
  roomTypeId: 70,
  roomId: 701,
  mealPlan: 'MAP',
  rateOptionId: 'offline:700:701:70:2026-12-27:2026-12-28',
  selectionKey: 'offline:700:701:70:2026-12-27:2026-12-28',
  pricePerNight: 4200,
  totalPrice: 4200,
  isSelectable: true,
  isBookable: true,
}];

test('offline intent preview uses nationality and meal plan in the catalog contract', async () => {
  const service = Object.create(ItinerariesService.prototype) as any;
  const calls: any[][] = [];
  service.prisma = {
    dvi_itinerary_route_details: {
      findMany: async () => [{
        itinerary_route_ID: 17019,
        itinerary_route_date: new Date('2026-12-27T00:00:00.000Z'),
      }],
    },
  };
  service.offlineHotelCatalogService = {
    clearCache: () => undefined,
    fetchOfflineHotelsForRoutes: async (...args: any[]) => {
      calls.push(args);
      return new Map([[17019, offlineCandidates]]);
    },
  };

  const result = await (service as any).resolveOfflineIntentCandidates(
    {
      guest_nationality: 'in',
      meal_plan_code: 'MAP',
      preferred_room_count: 1,
      total_adult: 2,
      total_children: 0,
      total_extra_bed: 0,
      total_child_with_bed: 0,
      total_child_without_bed: 0,
    },
    {
      routeIds: [17019],
      stayDates: ['2026-12-27'],
      nights: 1,
    },
    {
      planId: 10966,
      canonicalHotelId: 700,
      hotelCode: 'LOCAL-700',
      mealPlanCode: 'MAP',
    },
    1,
  );

  assert.equal(result.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'IN');
  assert.equal(calls[0][7], 'MAP');
});

function createIntentService(options: { routeExists?: boolean; provider: 'offline' | 'tbo' }) {
  const service = Object.create(ItinerariesService.prototype) as any;
  let supplierCalls = 0;
  service.prisma = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'DVI20261227' }) },
    dvi_itinerary_route_details: {
      findFirst: async () => options.routeExists === false ? null : ({ itinerary_route_date: new Date('2026-12-27T00:00:00.000Z') }),
    },
  };
  service.selectionWorkflowService = {
    withHotelSelectionLock: async (_planId: number, _groupType: number, callback: () => Promise<any>) => callback(),
  };
  service.hotelStayBlockValidationService = {
    buildContinuousStayCandidate: async () => ({
      routeIds: [17019],
      stayDates: ['2026-12-27'],
      nights: 1,
      checkInDate: '2026-12-27',
      checkOutDate: '2026-12-28',
      stayKey: `${options.provider}:LOCAL-700:2026-12-27_to_2026-12-28`,
    }),
  };
  service.offlineHotelCatalogService = {
    clearCache: () => undefined,
    fetchOfflineHotelsForRoutes: async () => new Map([[17019, offlineCandidates]]),
  };
  service.hotelDetailsTboService = {
    searchSelectedHotelForContinuousStay: async () => { supplierCalls += 1; return []; },
    getSelectedHotelRates: async () => { supplierCalls += 1; return { hotels: [] }; },
  };
  service.hotelAvailabilitySnapshotService = { getActiveRows: async () => [] };
  service.resolveOfflineIntentCandidates = async () => offlineCandidates;
  return { service, supplierCalls: () => supplierCalls };
}

test('offline selection never calls TBO and returns the local identity', async () => {
  const { service, supplierCalls } = createIntentService({ provider: 'offline' });
  const result = await service.previewHotelIntent({
    planId: 10966,
    routeId: 17019,
    groupType: 1,
    selectionIntent: 'RATE_OPTION',
    provider: 'offline',
    canonicalHotelId: 700,
    hotelCode: 'LOCAL-700',
    providerHotelCode: 'LOCAL-700',
    roomId: 701,
    roomTypeId: 70,
    mealPlanCode: 'MAP',
    rateOptionId: offlineCandidates[0].rateOptionId,
    selectionKey: offlineCandidates[0].selectionKey,
    routeDate: '2026-12-27',
  });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selections[0].provider, 'offline');
  assert.equal(result.selections[0].hotelCode, 'LOCAL-700');
  assert.equal(supplierCalls(), 0);
});

test('TBO selection does not use offline fallback', async () => {
  const { service } = createIntentService({ provider: 'tbo' });
  service.resolveOfflineIntentCandidates = async () => {
    throw new Error('offline fallback must not be called');
  };
  const tbo = { ...offlineCandidates[0], provider: 'tbo', hotelCode: '1129886', providerHotelCode: '1129886', canonicalHotelId: undefined, hotelId: undefined, rateOptionId: '1129886!TB!1!TB!session!TB!N!TB!AFF!' };
  service.hotelDetailsTboService.searchSelectedHotelForContinuousStay = async () => [tbo];
  service.hotelDetailsTboService.getSelectedHotelRates = async () => ({ hotels: [tbo] });
  const result = await service.previewHotelIntent({
    planId: 10966,
    routeId: 17019,
    groupType: 1,
    selectionIntent: 'RATE_OPTION',
    provider: 'tbo',
    hotelCode: '1129886',
    providerHotelCode: '1129886',
    rateOptionId: tbo.rateOptionId,
    routeDate: '2026-12-27',
  });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selections[0].provider, 'tbo');
});

test('mismatched route and plan is rejected with 409 before availability lookup', async () => {
  const { service } = createIntentService({ provider: 'offline', routeExists: false });
  let catalogCalled = false;
  service.resolveOfflineIntentCandidates = async () => { catalogCalled = true; return offlineCandidates; };
  await assert.rejects(
    () => service.previewHotelIntent({
      planId: 10757,
      routeId: 17019,
      groupType: 1,
      selectionIntent: 'HOTEL',
      provider: 'offline',
      canonicalHotelId: 700,
      hotelCode: 'LOCAL-700',
      routeDate: '2026-12-27',
    }),
    (error: any) => {
      assert.equal(error.getStatus?.() || error.status, 409);
      assert.equal(error.response?.code, 'HOTEL_ROUTE_PLAN_MISMATCH');
      return true;
    },
  );
  assert.equal(catalogCalled, false);
});
