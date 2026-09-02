import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelAvailabilitySnapshotService } from '../src/modules/itineraries/services/hotel-availability-snapshot.service';
import { autoSelectionIdentityMatches, hotelOptionKey, hotelSelectionKeyFromRow, selectionOriginFromRow } from '../src/modules/itineraries/utils/hotel-selection-identity.util';
import { projectHotelPayablePricing } from '../src/modules/itineraries/utils/hotel-payable-pricing.util';

function makePrisma() {
  const persistedRow = {
    id: 1,
    synced_at: new Date(),
    full_payload: JSON.stringify({
      groupType: 1,
      itineraryRouteId: 10,
      date: '2026-07-28',
      day: 'Day 1 | 2026-07-28',
      hotelCode: 'H-1',
      hotelId: 101,
      hotelName: 'Persisted Hotel',
      provider: 'tbo',
      totalHotelCost: 100,
      totalHotelTaxAmount: 5,
      isBookable: true,
      rateId: 'rate-1',
      roomId: 'room-1',
    }),
    sort_rank: 0,
  };
  const cache = {
    findFirst: async () => ({ synced_at: persistedRow.synced_at }),
    findMany: async () => [persistedRow],
  };
  return {
    dvi_itinerary_plan_details: {
      findFirst: async () => ({ itinerary_plan_ID: 44, itinerary_quote_ID: 'DVI2026072701', hotel_rates_visibility: 1 }),
    },
    dvi_itinerary_hotel_search_cache: cache,
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
    },
  } as any;
}

function persistedReaderFromFixture(prisma: any) {
  return {
    getHotelDetailsByQuoteId: async (quoteId: string) => {
      const cacheRows = prisma?.dvi_itinerary_hotel_search_cache?.findMany
        ? await prisma.dvi_itinerary_hotel_search_cache.findMany()
        : [];
      const hotels = (cacheRows || []).map((row: any) => {
        try {
          return typeof row.full_payload === 'string' ? JSON.parse(row.full_payload) : row.full_payload;
        } catch {
          return null;
        }
      }).filter(Boolean);
      const groupTypes = Array.from(new Set(hotels.map((row: any) => Number(row.groupType || 0)).filter((value: number) => value > 0)));
      return {
        quoteId,
        planId: 44,
        hotelRatesVisible: true,
        showHotelMargins: false,
        hotelTabs: groupTypes.map((groupType: any) => ({
          groupType,
          label: `Recommended #${groupType}`,
          totalAmount: hotels
            .filter((row: any) => Number(row.groupType || 0) === Number(groupType))
            .reduce((sum: number, row: any) => sum + Number(row.totalHotelCost || row.totalStayPrice || 0), 0),
        })),
        hotels,
        totalRoomCount: hotels.length,
      };
    },
  } as any;
}

test('AxisRooms DOUBLE price is resolved from the matching occupancy row', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tx = {
    dvi_hotel_occupancy_rate: {
      findMany: async () => [{
        occupancy_rates: JSON.stringify({ DOUBLE: 3500, SINGLE: 3500, TRIPLE: 4500 }),
      }],
    },
  } as any;

  const base = await (service as any).resolveAxisRoomsBasePrice(
    tx,
    {
      provider: 'axisrooms',
      canonicalHotelId: 231,
      roomId: 604,
      rateOptionId: 'axisrooms:231:604:CP_PLAN:2026-09-01',
      date: '2026-09-01',
    },
    { total_adult: 2, total_child_with_bed: 0, total_extra_bed: 0 },
    1,
  );

  assert.equal(base, 3500);
});

test('AxisRooms base price is pure room cost and uses the plan room count', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tx = {
    dvi_hotel_occupancy_rate: {
      findMany: async () => [{
        occupancy_rates: JSON.stringify({ DOUBLE: 6800, EXTRABED: 3500 }),
      }],
    },
  } as any;

  const base = await (service as any).resolveAxisRoomsBasePrice(
    tx,
    { provider: 'axisrooms', canonicalHotelId: 231, roomId: 604,
      rateOptionId: 'axisrooms:231:604:CP_PLAN:2026-09-01', date: '2026-09-01' },
    { total_adult: 5, preferred_room_count: 2, total_extra_bed: 1 },
    2,
  );

  assert.equal(base, 13600);
});

test('nested STAAH authoritative rate inherits only omitted parent identity fields', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = (service as any).expandRateOptions([{
    provider: 'staah', canonicalHotelId: 232, providerHotelCode: 'STAAHTESTHOTELPROD',
    roomId: 'DELUXEROOM', rateId: 'CP_PLAN', mealPlan: 'CP',
    rateOptionId: 'CP_PLAN', autoSelectionCandidate: true,
    autoSelectionIdentity: {
      provider: 'staah', canonicalHotelId: 232, providerHotelCode: 'STAAHTESTHOTELPROD',
      rateOptionId: 'CP_PLAN', roomId: 'DELUXEROOM', rateId: 'CP_PLAN', mealPlan: 'CP',
    },
    rateOptions: [{ roomId: 'DELUXEROOM', rateId: 'CP_PLAN', searchReference: '2026-09-03-token' }],
  }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].rateOptionId, 'CP_PLAN');
  assert.equal(rows[0].searchReference, '2026-09-03-token');
  assert.equal(rows[0].autoSelectionCandidate, true);
});

test('persisted hotel read never invokes a live supplier', async () => {
  const prisma = makePrisma();
  let supplierCalls = 0;
  const service = new HotelAvailabilitySnapshotService(prisma, {
    getHotelDetailsByQuoteIdFromTbo: async () => {
      supplierCalls += 1;
      throw new Error('supplier must not be called by a read');
    },
  } as any, {} as any, persistedReaderFromFixture(prisma));

  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(supplierCalls, 0);
  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels[0].hotelCode, 'H-1');
  assert.equal(response.hotelAvailability?.availabilityState, 'NOT_CHECKED');
});

test('client hotel payload strips recommendation internals and shared inventory deduplicates groups', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = [1, 2, 3, 4].map((groupType) => ({
    groupType,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'tbo',
    hotelCode: 'H-1',
    hotelName: 'Shared Hotel',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    totalHotelCost: 100,
    rateOptions: [{ rateOptionId: 'rate-1', roomType: 'Deluxe', mealPlan: 'CP', totalPrice: 100 }],
    recommendationTabs: [{ groupType: 1, label: 'Recommended #1' }],
    authoritativeRecommendation: true,
    autoSelectionCandidate: groupType === 1,
    autoSelectionIdentity: { rateOptionId: 'rate-1' },
  }));

  const shared = (service as any).buildSharedHotelInventory(rows, 0);
  const clientRow = (service as any).toClientHotelRow(rows[0]);

  assert.equal(shared.length, 1);
  assert.equal(shared[0].groupType, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(shared[0], 'recommendationTabs'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(shared[0], 'autoSelectionCandidate'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clientRow, 'recommendationTabs'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clientRow, 'authoritativeRecommendation'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clientRow, 'autoSelectionIdentity'), false);
});

test('reset keeps authoritative group rows separate from shared inventory rows', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = (service as any).extractAuthoritativeRecommendationRows({
    hotels: [
      { groupType: 0, hotelCode: 'shared' },
      { groupType: 1, hotelCode: 'g1', authoritativeRecommendation: true },
      { groupType: 2, hotelCode: 'g2', autoSelectionCandidate: true },
      { groupType: 3, hotelCode: 'g3', authoritativeRecommendation: false },
      { groupType: 4, hotelCode: 'g4', authoritativeRecommendation: true },
    ],
  });

  assert.deepEqual(rows.map((row: any) => row.hotelCode), ['g1', 'g2', 'g4']);
});

test('client hotel payload keeps every rate option but removes unused supplier fields', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const clientRow = (service as any).toClientHotelRow({
    hotelName: 'Shared Hotel',
    rateOptions: [{
      rateOptionId: 'rate-1',
      roomType: 'Deluxe Room',
      mealPlan: 'CP',
      totalPrice: 100,
      bookingCode: 'BOOK-1',
      supplierRawResponse: { thousands: 'of unused fields' },
      roomAvailabilityBreakdown: Array.from({ length: 20 }, () => ({ rooms: 2 })),
    }],
  });

  assert.equal(clientRow.rateOptions.length, 1);
  assert.equal(clientRow.rateOptions[0].rateOptionId, 'rate-1');
  assert.equal(clientRow.rateOptions[0].roomType, 'Deluxe Room');
  assert.equal(clientRow.rateOptions[0].mealPlan, 'CP');
  assert.equal(clientRow.rateOptions[0].totalPrice, 100);
  assert.equal(clientRow.rateOptions[0].bookingCode, 'BOOK-1');
  assert.equal(Object.prototype.hasOwnProperty.call(clientRow.rateOptions[0], 'supplierRawResponse'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clientRow.rateOptions[0], 'roomAvailabilityBreakdown'), false);
});

test('canonicalizes raw and normalized HOBSE copies into one rate and one room identity', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const reference = JSON.stringify({ provider: 'HOBSE', roomCode: 'supplier-room-1', ratePlanCode: 'ep-1' });
  const options = (service as any).canonicalizeRateOptions(
    { provider: 'HOBSE', hotelCode: 'fe1d1c893b009365', roomType: 'Superior Room', mealPlan: 'European Plan' },
    [
      { provider: 'HOBSE', searchReference: reference, roomType: 'Superior Room', mealPlan: 'European Plan', baseTotalPrice: 4020, totalPrice: 4422 },
      { provider: 'hobse', rateOptionId: reference, bookingCode: reference, searchReference: reference, roomTypeId: 'wrong-normalized-id', roomType: 'Superior Room', mealPlan: 'European Plan', baseTotalPrice: 4422, totalPrice: 4864.2 },
    ],
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].baseTotalPrice, 4020);
  assert.equal(options[0].totalPrice, 4422);
  assert.equal(options[0].roomTypeId, 'supplier-room-1');
  assert.equal(options[0].roomCode, 'supplier-room-1');
});

test('client recommendation tabs never carry nested hotel inventories', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tab = (service as any).toClientHotelTab({
    groupType: 1,
    label: 'Recommended #1',
    totalAmount: 1234,
    hotels: Array.from({ length: 100 }, () => ({ hotelName: 'duplicated payload' })),
    fullPackage: { hotels: [{ hotelName: 'duplicated payload' }] },
    stayResults: [{
      stayKey: '10|2026-07-28',
      parentRouteId: 10,
      routeIds: [10],
      destination: 'Ooty',
      checkInDate: '2026-07-28',
      checkOutDate: '2026-07-29',
      nights: 1,
      state: 'SELECTED',
      totalPrice: 1234,
    }],
  });

  assert.equal(tab.groupType, 1);
  assert.equal(tab.totalAmount, 1234);
  assert.equal(Object.prototype.hasOwnProperty.call(tab, 'hotels'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(tab, 'fullPackage'), false);
  assert.equal(tab.stayResults.length, 1);
});

test('complete persisted reads expose one hotel summary row per recommendation group and stay', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = [1, 2, 3, 4].map((groupType) => ({
    groupType,
    itineraryRouteId: 10,
    date: '2026-07-28',
    hotelName: `Hotel ${groupType}`,
    isBookable: true,
    isSelectable: true,
    isSelected: groupType === 3,
  }));

  const summary = (service as any).buildClientStaySummaryRows(rows);

  assert.equal(summary.length, 4);
  assert.deepEqual(
    summary.map((row: any) => row.groupType),
    [1, 2, 3, 4],
  );
  assert.equal(summary.find((row: any) => row.groupType === 3)?.hotelName, 'Hotel 3');
});

test('complete persisted reads prefer a live supplier over offline fallback per stay', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const summary = (service as any).buildClientStaySummaryRows([
    {
      itineraryRouteId: 10,
      date: '2026-07-28',
      provider: 'offline',
      hotelName: 'Offline Hotel',
      isBookable: true,
      isSelectable: true,
    },
    {
      itineraryRouteId: 10,
      date: '2026-07-28',
      provider: 'staah',
      hotelName: 'Live Hotel',
      isBookable: true,
      isSelectable: true,
    },
  ]);

  assert.equal(summary.length, 1);
  assert.equal(summary[0].hotelName, 'Live Hotel');
});

test('canonical selected rate id never falls back to another nested option', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const selected = (service as any).selectedRateOption(
    {
      selected_rate_option_id: 'fresh-suite-map',
      selected_price_snapshot: JSON.stringify({ rateOptionId: 'fresh-suite-map' }),
    },
    {
      rateOptions: [
        { rateOptionId: 'old-deluxe-cp', roomType: 'Deluxe Room', mealPlan: 'CP', totalPrice: 1450 },
        { rateOptionId: 'fresh-suite-map', roomType: 'Suite Room', mealPlan: 'MAP', totalPrice: 1630 },
      ],
    },
  );

  assert.equal(selected.rateOptionId, 'fresh-suite-map');
  assert.equal(selected.roomType, 'Suite Room');
  assert.equal(selected.mealPlan, 'MAP');

  const stale = (service as any).selectedRateOption(
    {
      selected_rate_option_id: 'missing-rate',
      selected_price_snapshot: JSON.stringify({ rateOptionId: 'missing-rate' }),
    },
    { rateOptions: [{ rateOptionId: 'old-deluxe-cp', roomType: 'Deluxe Room', mealPlan: 'CP', totalPrice: 1450 }] },
  );
  assert.equal(stale, null);
});

test('authoritative unavailable groups do not invent a cheapest automatic selection', async () => {
  const created: any[] = [];
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => { created.push(data); return data; },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async () => ({}),
      updateMany: async () => ({}),
    },
  };

  await (service as any).ensureAutoSelections(tx, 44, [{
    groupType: 3,
    itineraryRouteId: 10,
    date: '2026-07-28',
    hotelCode: 'H-1',
    hotelName: 'Lower category hotel',
    provider: 'tbo',
    rateOptionId: 'rate-1',
    totalStayPrice: 100,
    isBookable: true,
    isSelectable: true,
    authoritativeRecommendation: true,
    autoSelectionStatus: 'UNAVAILABLE',
  }], 'run-authoritative-empty', 1);

  assert.equal(created.length, 0);
});

test('authoritative identity rejects a different nested room or meal rate', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const identity = {
    provider: 'staah',
    canonicalHotelId: 101,
    providerHotelCode: 'H1',
    rateOptionId: 'suite-map',
    roomId: 'suite',
    rateId: 'map-rate',
    mealPlan: 'MAP',
  };

  assert.equal((service as any).autoSelectionIdentityMatches({
    provider: 'staah', hotelId: 101, hotelCode: 'H1', rateOptionId: 'suite-map',
    roomId: 'suite', rateId: 'map-rate', mealPlan: 'MAP',
  }, identity), true);
  assert.equal((service as any).autoSelectionIdentityMatches({
    provider: 'staah', hotelId: 101, hotelCode: 'H1', rateOptionId: 'deluxe-cp',
    roomId: 'deluxe', rateId: 'cp-rate', mealPlan: 'CP',
  }, identity), false);
});

test('strict authoritative identity rejects a different rate when room fields are absent', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const identity = {
    provider: 'staah', canonicalHotelId: 101, providerHotelCode: 'H1',
    rateOptionId: 'suite-map', mealPlan: 'MAP', roomId: '', roomType: '', rateId: '',
  };
  assert.equal((service as any).autoSelectionIdentityMatches({
    provider: 'staah', hotelId: 101, hotelCode: 'H1', rateOptionId: 'suite-map', mealPlan: 'MAP',
  }, identity), true);
  assert.equal((service as any).autoSelectionIdentityMatches({
    provider: 'staah', hotelId: 101, hotelCode: 'H1', rateOptionId: 'deluxe-cp', mealPlan: 'MAP',
  }, identity), false);
});

test('continuous logical stay persists one parent selection and one full-stay total', async () => {
  const created: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => { created.push(data); return data; },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
      updateMany: async () => ({}),
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 102,
    routeId: 102,
    routeIds: [101, 102],
    groupType: 1,
    authoritativeRecommendation: true,
    autoSelectionStatus: 'AVAILABLE',
    autoSelectionCandidate: true,
    autoSelectionIdentity: {
      provider: 'tbo', canonicalHotelId: 501, providerHotelCode: 'H-501',
      rateOptionId: 'suite-map', searchReference: '', bookingCode: '',
      roomId: 'suite', roomTypeId: '', roomType: 'Suite', rateId: 'map-rate', mealPlan: 'MAP',
    },
    authoritativeStayKey: '101|2026-08-02|2026-08-04',
    authoritativeParentRouteId: 101,
    authoritativeRouteIds: [101, 102],
    authoritativeCheckInDate: '2026-08-02',
    authoritativeCheckOutDate: '2026-08-04',
    provider: 'tbo', hotelId: 501, hotelCode: 'H-501', hotelName: 'Hotel A',
    rateOptionId: 'suite-map', roomId: 'suite', roomType: 'Suite', rateId: 'map-rate', mealPlan: 'MAP',
    pricePerNight: 2500, totalStayPrice: 5000,
    nightlyRates: [
      { date: '2026-08-02', baseAmount: 2400, sellAmount: 2500 },
      { date: '2026-08-03', baseAmount: 2400, sellAmount: 2500 },
    ],
    checkInDate: '2026-08-02', checkOutDate: '2026-08-04',
    isBookable: true, isSelectable: true,
  }], 'logical-stay-run', 7);

  assert.equal(created.length, 1);
  assert.equal(created[0].itinerary_route_id, 101);
  assert.equal(created[0].selected_total_price, 5000);
  const snapshot = JSON.parse(created[0].selected_price_snapshot);
  assert.equal(snapshot.authoritativeStayKey, '101|2026-08-02|2026-08-04');
  assert.deepEqual(snapshot.authoritativeRouteIds, [101, 102]);
  assert.deepEqual(snapshot.nightlyRates, [
    { date: '2026-08-02', baseAmount: 2400, sellAmount: 2500 },
    { date: '2026-08-03', baseAmount: 2400, sellAmount: 2500 },
  ]);
  assert.equal(snapshot.rateOptionId, 'suite-map');
});

test('route-derived continuous stay keeps the online property across nights', async () => {
  const created: any[] = [];
  const tx: any = {
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 6 }) },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => { created.push(data); return data; },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
      updateMany: async () => ({}),
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const routes = [
    { itinerary_route_ID: 101, itinerary_route_date: '2026-08-02', next_visiting_location: 'Thekkady' },
    { itinerary_route_ID: 102, itinerary_route_date: '2026-08-03', next_visiting_location: 'Thekkady' },
  ];
  const rows = [101, 102].flatMap((routeId) => ([
    {
      itineraryRouteId: routeId,
      groupType: 1,
      provider: 'axisrooms',
      hotelId: 501,
      hotelCode: 'PATIO',
      hotelName: 'The Patio',
      rateOptionId: `patio-${routeId}`,
      mealPlan: 'CP',
      pricePerNight: 500,
      totalHotelCost: 500,
      isBookable: true,
      isSelectable: true,
    },
    {
      itineraryRouteId: routeId,
      groupType: 1,
      provider: 'offline',
      hotelId: 601,
      hotelCode: 'CHEAPER',
      hotelName: 'Cheaper Offline Hotel',
      rateOptionId: `offline-${routeId}`,
      mealPlan: 'CP',
      pricePerNight: 100,
      totalHotelCost: 100,
      isBookable: true,
      isSelectable: true,
    },
  ]));

  await (service as any).ensureAutoSelections(tx, 44, rows, 'route-derived-stay-run', 7, true, undefined, 'CP', undefined, routes);

  assert.equal(created.length, 2);
  assert.deepEqual(created.map((row) => row.hotel_provider), ['axisrooms', 'axisrooms']);
  assert.deepEqual(created.map((row) => row.hotel_id), [501, 501]);
});

test('genuine G4 recommendation clears stale G3 fallback metadata', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const fallbackSelection: any = {
    hotel_id: 101,
    hotel_code: 'A',
    hotel_provider: 'staah',
    selected_total_price: 100,
    total_hotel_cost: 100,
    selected_price_snapshot: JSON.stringify({
      selectionOrigin: 'AUTO_SELECTED',
      autoSelectionFallbackFromGroup: 3,
      hotelName: 'Hotel A',
    }),
  };
  const fallbackOption = {
    provider: 'staah', hotelId: 101, hotelCode: 'A', hotelName: 'Hotel A',
    rateOptionId: 'a-cp', roomId: 'a-room', rateId: 'a-rate', mealPlan: 'CP',
    totalPrice: 100, autoSelectionFallbackFromGroup: 3,
  };
  const first = (service as any).buildSelectionUpdate(fallbackSelection, fallbackOption, 'AUTO_SELECTED', 'run-1');
  Object.assign(fallbackSelection, first);
  assert.equal(JSON.parse(fallbackSelection.selected_price_snapshot).autoSelectionFallbackFromGroup, 3);

  const genuineG4 = {
    provider: 'staah', hotelId: 202, hotelCode: 'B', hotelName: 'Hotel B',
    rateOptionId: 'b-map', roomId: 'b-room', rateId: 'b-rate', mealPlan: 'MAP',
    totalPrice: 200,
  };
  const second = (service as any).buildSelectionUpdate(fallbackSelection, genuineG4, 'AUTO_SELECTED', 'run-2');
  const refreshedSnapshot = JSON.parse(second.selected_price_snapshot);
  assert.equal(refreshedSnapshot.hotelName, 'Hotel B');
  assert.equal(Object.prototype.hasOwnProperty.call(refreshedSnapshot, 'autoSelectionFallbackFromGroup'), false);
});

test('persisted read does not synthesize recommendation groups from unscoped inventory', async () => {
  const syncedAt = new Date('2026-07-29T10:00:00.000Z');
  const prisma = makePrisma();
  prisma.dvi_itinerary_plan_details.findFirst = async () => ({
    itinerary_plan_ID: 44,
    itinerary_quote_ID: 'DVI2026072701',
    hotel_rates_visibility: 1,
    no_of_nights: 1,
  });
  prisma.dvi_itinerary_route_details = {
    findMany: async () => [{
      itinerary_route_ID: 10,
      itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'),
      next_visiting_location: 'Munnar',
    }],
  };
  prisma.dvi_itinerary_hotel_search_cache.findFirst = async () => ({
    synced_at: syncedAt,
    full_payload: JSON.stringify({ searchRunId: 'offline-run' }),
  });
  prisma.dvi_itinerary_hotel_search_cache.findMany = async () => [{
    id: 1,
    group_type: 0,
    synced_at: syncedAt,
    sort_rank: 0,
    full_payload: JSON.stringify({
      itineraryRouteId: 10,
      date: '2026-07-28',
      hotelCode: 'OFF-1',
      hotelId: 101,
      hotelName: 'Offline Munnar Hotel',
      provider: 'offline',
      totalHotelCost: 100,
      isBookable: true,
    }),
  }];
  prisma.dvi_itinerary_plan_hotel_details.findMany = async () => [1, 2, 3, 4].map((groupType) => ({
    itinerary_plan_hotel_details_ID: groupType,
    itinerary_plan_id: 44,
    itinerary_route_id: 10,
    itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'),
    group_type: groupType,
    hotel_required: 1,
    hotel_id: 101,
  }));

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any, persistedReaderFromFixture(prisma));
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.deepEqual(response.hotelTabs, []);
  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels[0].groupType, undefined);
});

test('offline materialization creates rows for valid recommendation groups only', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = (service as any).materializeOfflineRows(
    new Map([[10, [{ hotelId: 101, hotelName: 'Offline Hotel', provider: 'offline' }]]]),
    [{ itinerary_route_ID: 10, itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'), next_visiting_location: 'Munnar' }],
    [1, 2, 3, 4, 5, 0],
  );

  assert.deepEqual(rows.map((row: any) => row.groupType), [1, 2, 3, 4]);
  assert.deepEqual(
    (service as any).dedupeRows(rows).map((row: any) => row.groupType),
    [1, 2, 3, 4],
  );
});

test('authoritative recommendation metadata wins when generic and authoritative rows dedupe', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = (service as any).dedupeRows([
    {
      itineraryRouteId: 10,
      groupType: 1,
      canonicalHotelId: 101,
      hotelCode: 'JEEVAN',
      hotelName: 'JEEVAN BEACH RESORT',
      provider: 'offline',
      rateOptionId: 'CP_PLAN',
      optionKey: 'offline|JEEVAN|CP_PLAN',
      price: 2530,
    },
    {
      itineraryRouteId: 10,
      groupType: 1,
      canonicalHotelId: 101,
      hotelCode: 'JEEVAN',
      hotelName: 'JEEVAN BEACH RESORT',
      provider: 'offline',
      rateOptionId: 'CP_PLAN',
      optionKey: 'offline|JEEVAN|CP_PLAN',
      price: 2530,
      authoritativeRecommendation: true,
      autoSelectionCandidate: true,
      requestedCategory: 3,
      selectedCategory: 2,
      categoryFallbackApplied: true,
      categoryFallbackReason: '2* selected — 3* not available',
      selectedPriceSnapshot: JSON.stringify({ rateOptionId: 'CP_PLAN' }),
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestedCategory, 3);
  assert.equal(rows[0].selectedCategory, 2);
  assert.equal(rows[0].categoryFallbackApplied, true);
  assert.equal(rows[0].categoryFallbackReason, '2* selected — 3* not available');
});

test('decorated nested MAP selection replaces parent CP identity and money atomically', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const date = '2026-08-25';
  const row: any = {
    itineraryRouteId: 10,
    groupType: 1,
    itineraryRouteDate: date,
    provider: 'axisrooms',
    canonicalHotelId: 101,
    hotelCode: 'HAVELI',
    hotelName: 'HAVELI BACKWATER RESORT',
    roomId: 'ROOM-1',
    rateId: 'CP-RATE',
    rateOptionId: 'CP_PLAN',
    optionKey: 'axisrooms|HAVELI|CP_PLAN',
    mealPlan: 'CP',
    price: 3424,
    pricePerNight: 3424,
    totalPrice: 3424,
    rateOptions: [
      { provider: 'axisrooms', hotelCode: 'HAVELI', canonicalHotelId: 101, roomId: 'ROOM-1', rateId: 'CP-RATE', rateOptionId: 'CP_PLAN', bookingCode: 'CP-BOOK', mealPlan: 'CP', pricePerNight: 3424, totalPrice: 3424 },
      { provider: 'axisrooms', hotelCode: 'HAVELI', canonicalHotelId: 101, roomId: 'ROOM-1', rateId: 'MAP-RATE', rateOptionId: 'MAP_PLAN', bookingCode: 'MAP-BOOK', searchReference: 'MAP-REF', mealPlan: 'MAP', pricePerNight: 4708, totalPrice: 4708 },
    ],
  };
  const selection: any = {
    itinerary_plan_hotel_details_ID: 99,
    itinerary_plan_id: 44,
    itinerary_route_id: 10,
    group_type: 1,
    itinerary_route_date: date,
    hotel_provider: 'axisrooms',
    hotel_id: 101,
    hotel_code: 'HAVELI',
    selected_rate_option_id: 'MAP_PLAN',
    selected_price_per_night: 4708,
    selected_total_price: 4708,
    selected_price_snapshot: JSON.stringify({ rateOptionId: 'MAP_PLAN', mealPlan: 'MAP', optionKey: 'axisrooms|HAVELI|MAP_PLAN' }),
  };
  const decorated = (service as any).decorateSelection(
    row,
    new Map([[hotelSelectionKeyFromRow(44, row), selection]]),
    44,
  );

  assert.equal(decorated.rateOptionId, 'MAP_PLAN');
  assert.equal(decorated.selectedRateOptionId, 'MAP_PLAN');
  assert.equal(decorated.mealPlan, 'MAP');
  assert.equal(decorated.price, 4708);
  assert.equal(decorated.pricePerNight, 4708);
  assert.equal(decorated.totalPrice, 4708);
  assert.equal(decorated.totalAmount, 4708);
  assert.match(String(decorated.optionKey), /map_plan/i);
  assert.doesNotMatch(String(decorated.optionKey), /cp_plan/i);
  const snapshot = JSON.parse(decorated.selectedPriceSnapshot);
  assert.equal(snapshot.rateOptionId, 'MAP_PLAN');
  assert.match(String(snapshot.optionKey), /map_plan/i);
});

test('persisted early-arrival selection exposes Day 0 metadata without changing selection identity', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const row: any = {
    itineraryRouteId: 11045,
    itineraryRouteDate: '2026-08-31',
    provider: 'offline',
    hotelId: 277,
    hotelCode: '277',
    hotelName: 'MAMALLA HERITAGE',
    roomType: 'Standard Double',
    mealPlan: 'CP',
    rateOptionId: 'offline:277:733:445:2026-08-31:2026-09-03',
    pricePerNight: 15213,
    totalPrice: 15213,
  };
  const selection: any = {
    itinerary_plan_hotel_details_ID: 19977,
    itinerary_plan_id: 10176,
    itinerary_route_id: 11045,
    itinerary_route_date: '2026-08-31',
    group_type: 1,
    hotel_id: 277,
    hotel_code: '277',
    hotel_provider: 'offline',
    selected_rate_option_id: row.rateOptionId,
    selected_price_per_night: 15213,
    selected_total_price: 15213,
    early_checkin: 1,
    early_checkin_extra_payment_applicable: 1,
    early_checkin_payment_status: 'EXTRA_PAYMENT_APPLICABLE',
    hotel_check_in_date: '2026-08-30',
    hotel_check_out_date: '2026-09-01',
    actual_guest_arrival_at: new Date('2026-08-31T01:00:00.000Z'),
    early_checkin_note: 'Room to be blocked from 2026-08-30.',
  };

  const key = hotelSelectionKeyFromRow(10176, row);
  const decorated = (service as any).decorateSelection(row, new Map([[key, selection]]), 10176);

  assert.equal(decorated.isSelected, true);
  assert.equal(decorated.hotelName, 'MAMALLA HERITAGE');
  assert.equal(decorated.roomType, 'Standard Double');
  assert.equal(decorated.mealPlan, 'CP');
  assert.equal(decorated.earlyCheckIn, true);
  assert.equal(decorated.earlyCheckInExtraPaymentApplicable, true);
  assert.equal(decorated.hotelCheckInDate, '2026-08-30');
  assert.equal(decorated.hotelCheckOutDate, '2026-09-01');
  assert.equal(decorated.actualGuestArrivalAt.toISOString(), '2026-08-31T01:00:00.000Z');
  assert.equal(decorated.previousDayBillingSynthetic, false);
  assert.equal(decorated.totalPrice, 15213);
  assert.equal(decorated.selection.earlyCheckIn, undefined);
});

test('fresh recommendation groups are preserved when reset has no persisted selections', async () => {
  const prisma: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
    },
  };
  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any);

  const groups = await (service as any).getRecommendationGroupTypes(44, [], [
    { groupType: 1 },
    { groupType: 2 },
    { groupType: 3 },
    { groupType: 4 },
  ]);

  assert.deepEqual(groups, [1, 2, 3, 4]);
});

test('tab totals use one full-stay recommendation per logical stay', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const routes = [
    {
      itinerary_route_ID: 10,
      itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'),
      next_visiting_location: 'Munnar',
    },
    {
      itinerary_route_ID: 11,
      itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'),
      next_visiting_location: 'Munnar',
    },
  ];
  const rows = [
    // The same two-night rate is materialized once for each night. It must
    // contribute ₹10,000 once, not ₹20,000.
    { groupType: 1, itineraryRouteId: 10, provider: 'tbo', hotelCode: 'H-1', totalHotelCost: 5000, totalStayPrice: 10000 },
    { groupType: 1, itineraryRouteId: 11, provider: 'tbo', hotelCode: 'H-1', totalHotelCost: 5000, totalStayPrice: 10000 },
    { groupType: 1, itineraryRouteId: 10, provider: 'tbo', hotelCode: 'H-2', totalHotelCost: 6000, totalStayPrice: 12000 },
    { groupType: 1, itineraryRouteId: 11, provider: 'tbo', hotelCode: 'H-2', totalHotelCost: 6000, totalStayPrice: 12000 },
  ];

  const tabs = (service as any).buildTabs(rows, routes, 2);

  assert.deepEqual(tabs, [{ groupType: 1, label: 'Recommended #1', totalAmount: 10000 }]);
});

test('persisted recommendation totals are preferred over availability-row sums', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tabs = (service as any).buildTabs(
    [
      { groupType: 1, itineraryRouteId: 10, provider: 'tbo', totalHotelCost: 500000 },
      { groupType: 1, itineraryRouteId: 11, provider: 'tbo', totalHotelCost: 500000 },
    ],
    [],
    2,
    [{ groupType: 1, label: 'Budget Hotels', totalAmount: 3520, complete: true }],
  );

  assert.equal(tabs[0].totalAmount, 3520);
});

test('route-specific selected totals do not inherit the itinerary night count', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tabs = (service as any).buildTabs(
    [{
      groupType: 1,
      itineraryRouteId: 10,
      provider: 'tbo',
      hotelCode: 'HABLIS',
      checkInDate: '2026-08-08',
      checkOutDate: '2026-08-09',
      pricePerNight: 7179.38,
      totalStayPrice: 14358.76,
    }],
    [{ itinerary_route_ID: 10, itinerary_route_date: '2026-08-08', next_visiting_location: 'Chennai' }],
    2,
  );

  assert.equal(tabs[0].totalAmount, 7179.38);
});

test('incomplete persisted packages use partial totals instead of returning null tab rates', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tabs = (service as any).buildTabs(
    [],
    [],
    2,
    [{ groupType: 1, label: 'Recommended #1', totalAmount: null, partialTotal: 3900, complete: false }],
  );

  assert.equal(tabs[0].totalAmount, 3900);
});

test('incomplete persisted packages cannot retain totals from unavailable stays', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const tabs = (service as any).buildTabs(
    [],
    [],
    2,
    [{
      groupType: 1,
      label: 'Recommended #1',
      totalAmount: 19793.4,
      partialTotal: 19793.4,
      complete: false,
      stayResults: [
        { stayKey: '10|2026-08-17', state: 'UNAVAILABLE' },
        { stayKey: '11|2026-08-18', state: 'UNAVAILABLE' },
      ],
    }],
  );

  assert.equal(tabs[0].totalAmount, 0);
  assert.equal(tabs[0].partialTotal, 0);
});

test('an explicitly empty recommendation tab is not rebuilt from shared group inventory', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const route = {
    itinerary_route_ID: 10,
    itinerary_route_date: new Date('2026-08-17T00:00:00.000Z'),
    next_visiting_location: 'Ooty',
  };
  const populatedTab = (groupType: number) => ({
    groupType,
    label: `Recommended #${groupType}`,
    totalAmount: groupType * 1000,
    partialTotal: groupType * 1000,
    complete: true,
    stayResults: [{ parentRouteId: 10, state: 'AVAILABLE', totalPrice: groupType * 1000 }],
  });
  const tabs = (service as any).buildTabs(
    [{
      groupType: 4,
      itineraryRouteId: 10,
      provider: 'offline',
      hotelCode: '211',
      totalStayPrice: 6741,
      selectionOrigin: 'USER_SELECTED',
      isSelected: true,
    }],
    [route],
    1,
    [
      populatedTab(1),
      populatedTab(2),
      populatedTab(3),
      {
        groupType: 4,
        label: 'Recommended #4',
        hotels: [],
        stayResults: [],
        totalAmount: null,
        partialTotal: 0,
        complete: false,
        distinctFromPrevious: false,
      },
    ],
  );

  assert.equal(tabs[3].totalAmount, 0);
  assert.deepEqual(tabs[3].stayResults, []);
});

test('recommendation tabs retain category group identity instead of payable-total ranking', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const persistedTabs = [
    {
      groupType: 1,
      label: 'Recommended #1',
      totalAmount: 100,
      partialTotal: 100,
      complete: true,
      stayResults: [{ parentRouteId: 10, state: 'AVAILABLE', totalPrice: 100 }],
    },
    {
      groupType: 2,
      label: 'Recommended #2',
      totalAmount: 300,
      partialTotal: 300,
      complete: true,
      stayResults: [{ parentRouteId: 10, state: 'AVAILABLE', totalPrice: 300 }],
    },
    {
      groupType: 3,
      label: 'Recommended #3',
      totalAmount: 200,
      partialTotal: 200,
      complete: true,
      stayResults: [{ parentRouteId: 10, state: 'AVAILABLE', totalPrice: 200 }],
    },
    {
      groupType: 4,
      label: 'Recommended #4',
      hotels: [],
      stayResults: [],
      totalAmount: null,
      partialTotal: 0,
      complete: false,
      distinctFromPrevious: false,
    },
  ];

  const tabs = (service as any).buildTabs([], [], 1, persistedTabs);

  assert.deepEqual(
    tabs.map((tab: any) => ({
      groupType: tab.groupType,
      label: tab.label,
      totalAmount: tab.totalAmount,
    })),
    [
      { groupType: 1, label: 'Recommended #1', totalAmount: 100 },
      { groupType: 2, label: 'Recommended #2', totalAmount: 300 },
      { groupType: 3, label: 'Recommended #3', totalAmount: 200 },
      { groupType: 4, label: 'Recommended #4', totalAmount: 0 },
    ],
  );
});

test('persisted hotel read does not rewrite authoritative route identity', async () => {
  const prisma = makePrisma();
  prisma.dvi_itinerary_plan_details.findFirst = async () => ({
    itinerary_plan_ID: 44,
    itinerary_quote_ID: 'DVI2026072701',
    hotel_rates_visibility: 1,
    no_of_nights: 1,
  });
  prisma.dvi_itinerary_route_details = {
    findMany: async () => [
      {
        itinerary_route_ID: 20,
        itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'),
        next_visiting_location: 'Munnar',
      },
      {
        itinerary_route_ID: 21,
        itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'),
        next_visiting_location: 'Thekkady',
      },
    ],
  };
  prisma.dvi_itinerary_hotel_search_cache.findMany = async () => [{
    id: 1,
    synced_at: new Date(),
    sort_rank: 0,
    full_payload: JSON.stringify({
      groupType: 1,
      itineraryRouteId: 10,
      date: '2026-07-28',
      hotelCode: 'H-1',
      hotelId: 101,
      hotelName: 'Rebuilt Route Hotel',
      provider: 'tbo',
      totalHotelCost: 100,
    }),
  }];

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any, persistedReaderFromFixture(prisma));
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels[0].itineraryRouteId, 10);
  assert.equal(response.hotels[0].date, '2026-07-28');
  assert.equal((response.hotelAvailability as any)?.emptySearchRoutes, 1);
});

test('persisted read sanitizes only the supplied persisted-selection response', async () => {
  const syncedAt = new Date('2026-07-29T10:00:00.000Z');
  const prisma = makePrisma();
  prisma.dvi_itinerary_plan_details.findFirst = async () => ({
    itinerary_plan_ID: 44,
    itinerary_quote_ID: 'DVI2026072701',
    hotel_rates_visibility: 1,
    no_of_nights: 1,
  });
  prisma.dvi_itinerary_route_details = {
    findMany: async () => [{
      itinerary_route_ID: 11,
      itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'),
      next_visiting_location: 'Chennai',
    }],
  };
  prisma.dvi_itinerary_hotel_search_cache.findFirst = async () => ({
    synced_at: syncedAt,
    full_payload: JSON.stringify({ searchRunId: 'current-run' }),
  });
  prisma.dvi_itinerary_hotel_search_cache.findMany = async () => [
    {
      id: 1,
      route_id: 11,
      check_in_date: new Date('2026-07-28T00:00:00.000Z'),
      check_out_date: new Date('2026-07-30T00:00:00.000Z'),
      synced_at: syncedAt,
      sort_rank: 0,
      full_payload: JSON.stringify({
        groupType: 1,
        itineraryRouteId: 11,
        date: '2026-07-28',
        hotelName: 'Stale TBO Hotel',
        hotelCode: 'STALE',
        provider: 'tbo',
        totalStayPrice: 4531.68,
      }),
    },
    {
      id: 2,
      route_id: 11,
      check_in_date: new Date('2026-07-29T00:00:00.000Z'),
      check_out_date: new Date('2026-07-30T00:00:00.000Z'),
      synced_at: syncedAt,
      sort_rank: 1,
      full_payload: JSON.stringify({
        groupType: 1,
        itineraryRouteId: 11,
        date: '2026-07-29',
        hotelName: 'Current Lemon Tree',
        hotelCode: 'CURRENT',
        provider: 'offline',
        totalStayPrice: 7350,
        pricePerNight: 7350,
        roomType: 'Superior Double',
        mealPlan: 'CP',
      }),
    },
  ];
  prisma.dvi_itinerary_plan_hotel_details.findMany = async () => [{
    itinerary_plan_hotel_details_ID: 99,
    itinerary_plan_id: 44,
    itinerary_route_id: 11,
    itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'),
    group_type: 1,
    hotel_required: 1,
    hotel_id: 1498639,
    hotel_provider: 'tbo',
    selected_total_price: 4531.68,
  }];

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any, persistedReaderFromFixture(prisma));
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(response.hotels.length, 2);
  assert.equal((response.hotels as any[]).some((row) => row.hotelName === 'Current Lemon Tree'), true);
  assert.equal((response.hotels as any[]).some((row) => row.hotelName === 'Stale TBO Hotel'), true);
  assert.equal((response.hotels[0] as any).selectionStatus, undefined);
});

test('option identity includes provider, property, room and rate dimensions', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const first = service.optionKey({ provider: 'tbo', hotelCode: 'H-1', roomId: 'room-1', rateId: 'rate-1', mealPlan: 'BB' });
  const second = service.optionKey({ provider: 'tbo', hotelCode: 'H-1', roomId: 'room-2', rateId: 'rate-1', mealPlan: 'BB' });
  assert.notEqual(first, second);
});

test('persisted-first read does not infer unavailable before fresh validation', async () => {
  const syncedAt = new Date('2026-07-27T10:00:00.000Z');
  const prisma = makePrisma();
  prisma.dvi_itinerary_hotel_search_cache.findFirst = async () => ({
    synced_at: syncedAt,
    recommendation_algorithm_version: 'v2',
    recommendation_search_run_id: 'hotel-run-stable',
    recommendation_generated_at: syncedAt,
    full_payload: JSON.stringify({ searchRunId: 'hotel-run-stable' }),
  });
  prisma.dvi_itinerary_hotel_search_cache.findMany = async () => [{
    id: 1,
    synced_at: syncedAt,
    sort_rank: 0,
    full_payload: JSON.stringify({
      groupType: 1,
      itineraryRouteId: 10,
      date: '2026-07-28',
      day: 'Day 2',
      destination: 'Munnar',
      hotelCode: 'H-2',
      hotelId: 102,
      hotelName: 'Current Hotel',
      provider: 'tbo',
      rateOptionId: 'rate-new',
      totalHotelCost: 120,
    }),
  }];
  prisma.dvi_itinerary_plan_hotel_details.findMany = async () => [{
    itinerary_plan_hotel_details_ID: 99,
    itinerary_plan_id: 44,
    itinerary_route_id: 10,
    itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'),
    itinerary_route_location: 'Munnar',
    group_type: 1,
    hotel_required: 1,
    hotel_id: 101,
    hotel_code: 'H-1',
    hotel_provider: 'tbo',
    selected_rate_option_id: 'rate-old',
    selected_total_price: 100,
    selected_price_snapshot: JSON.stringify({
      selectionOrigin: 'USER_SELECTED',
      hotelName: 'Old Hotel',
      optionKey: 'tbo|h-1|room-1|rate-old||||2026-07-28|',
    }),
  }];

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any, persistedReaderFromFixture(prisma));
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels[0].hotelName, 'Current Hotel');
  assert.equal((response.hotels[0] as any).selectionStatus, undefined);
  assert.equal((response.hotels[0] as any).selection, undefined);
  assert.equal((response.hotels as any[]).some((row) => String(row.hotelName).includes('Previously selected')), false);
  assert.equal((response.hotelAvailability as any)?.searchRunId, undefined);
  assert.equal((response as any).recommendationGeneration, undefined);
});

test('explicit persisted fallback is authoritative and is not merged with old inventory', async () => {
  const syncedAt = new Date('2026-07-27T10:00:00.000Z');
  const prisma = makePrisma();
  prisma.dvi_itinerary_hotel_search_cache.findFirst = async () => ({
    synced_at: syncedAt,
    full_payload: JSON.stringify({ searchRunId: 'hotel-run-partial' }),
  });
  prisma.dvi_itinerary_hotel_search_cache.findMany = async () => [{
    id: 1,
    synced_at: syncedAt,
    sort_rank: 0,
    full_payload: JSON.stringify({
      groupType: 1,
      itineraryRouteId: 10,
      date: '2026-07-28',
      day: 'Day 1 | 2026-07-28',
      destination: 'Munnar',
      hotelCode: 'H-1',
      hotelId: 101,
      hotelName: 'Current Hotel',
      provider: 'tbo',
      totalHotelCost: 100,
    }),
  }];
  prisma.dvi_itinerary_plan_hotel_details.findMany = async () => [{
    itinerary_plan_hotel_details_ID: 99,
    itinerary_plan_id: 44,
    itinerary_route_id: 11,
    itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'),
    itinerary_route_location: 'Thekkady',
    group_type: 1,
    hotel_required: 1,
    hotel_id: 102,
    hotel_code: 'H-2',
    hotel_provider: 'tbo',
    selected_rate_option_id: 'rate-old',
    selected_total_price: 150,
    selected_price_snapshot: JSON.stringify({
      selectionOrigin: 'USER_SELECTED',
      hotelName: 'Selected Hotel',
      optionKey: 'tbo|h-2||||rate-old||2026-07-29|',
    }),
  }];

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any);
  const response = await service.readPersisted(
    'DVI2026072701',
    { page: 1, pageSize: 20 },
    async () => ({
      quoteId: 'DVI2026072701',
      planId: 44,
      hotelRatesVisible: true,
      showHotelMargins: false,
      hotelTabs: [],
      hotels: [{
        groupType: 1,
        itineraryRouteId: 11,
        day: 'Day 2 | 2026-07-29',
        date: '2026-07-29',
        destination: 'Thekkady',
        hotelId: 102,
        hotelName: 'Selected Hotel',
        provider: 'tbo',
        totalHotelCost: 150,
      }],
      totalRoomCount: 1,
    } as any),
  );

  assert.equal(response.hotels.length, 1);
  assert.deepEqual(response.hotels.map((row: any) => row.itineraryRouteId), [11]);
  assert.equal((response.hotels[0] as any).selectionStatus, undefined);
  assert.equal((response.hotelAvailability as any)?.availabilityState, 'NOT_CHECKED');
});

test('ambiguous legacy selection does not fabricate a placeholder hotel identity', async () => {
  const syncedAt = new Date('2026-07-27T10:00:00.000Z');
  const prisma = makePrisma();
  prisma.dvi_itinerary_plan_details.findFirst = async () => ({
    itinerary_plan_ID: 44,
    itinerary_quote_ID: 'DVI2026072701',
    hotel_rates_visibility: 1,
    no_of_nights: 1,
  });
  prisma.dvi_itinerary_route_details = {
    findMany: async () => [{
      itinerary_route_ID: 11,
      itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'),
      next_visiting_location: 'Trichy',
    }],
  };
  prisma.dvi_itinerary_hotel_search_cache.findFirst = async () => ({
    synced_at: syncedAt,
    full_payload: JSON.stringify({ searchRunId: 'hotel-run-missing-selection' }),
  });
  prisma.dvi_itinerary_hotel_search_cache.findMany = async () => [];
  prisma.dvi_itinerary_plan_hotel_details.findMany = async () => [{
    itinerary_plan_hotel_details_ID: 99,
    itinerary_plan_id: 44,
    itinerary_route_id: 11,
    itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'),
    group_type: 1,
    hotel_required: 1,
    hotel_id: 690,
    total_hotel_cost: 4935,
  }];
  prisma.dvi_hotel = { findMany: async () => [] };

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any, persistedReaderFromFixture(prisma));
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });
  assert.equal(response.hotels.length, 0);
  assert.equal((response.hotelAvailability as any).placeholderRowCount, 0);
});

test('persisted read omits missing-night placeholders and reports empty routes as metadata', async () => {
  const prisma = makePrisma();
  prisma.dvi_itinerary_plan_details.findFirst = async () => ({
    itinerary_plan_ID: 44,
    itinerary_quote_ID: 'DVI2026072701',
    hotel_rates_visibility: 1,
    no_of_nights: 2,
  });
  prisma.dvi_itinerary_route_details = {
    findMany: async () => [
      { itinerary_route_ID: 10, itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'), next_visiting_location: 'Munnar' },
      { itinerary_route_ID: 11, itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'), next_visiting_location: 'Thekkady' },
      { itinerary_route_ID: 12, itinerary_route_date: new Date('2026-07-30T00:00:00.000Z'), next_visiting_location: 'Kochi' },
    ],
  };

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any, persistedReaderFromFixture(prisma));
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels.some((row: any) => row.hotelName === 'No Hotels Available'), false);
  assert.equal((response.hotelAvailability as any)?.emptySearchRoutes, 2);
  assert.equal((response.hotelAvailability as any)?.placeholderRowCount, 0);
});

function makeReconciliationTx() {
  const selections: any[] = [{
    itinerary_plan_hotel_details_ID: 1,
    itinerary_plan_id: 44,
    itinerary_route_id: 10,
    itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'),
    itinerary_route_location: 'Munnar',
    group_type: 1,
    hotel_required: 1,
    hotel_id: 101,
    hotel_code: 'H-1',
    hotel_provider: 'tbo',
    selected_rate_option_id: 'rate-1',
    selected_total_price: 100,
    total_hotel_cost: 100,
    total_no_of_rooms: 1,
    status: 1,
    deleted: 0,
    selected_price_snapshot: JSON.stringify({
      optionKey: 'tbo|h-1|room-1|rate-1||||2026-07-28|',
      selectionOrigin: 'USER_SELECTED',
      hotelName: 'Stable Hotel',
      roomType: 'Deluxe',
      mealPlan: 'CP',
    }),
  }];
  const rooms: any[] = [{
    itinerary_plan_hotel_room_details_ID: 1,
    itinerary_plan_hotel_details_id: 1,
    deleted: 0,
    status: 1,
  }];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => selections.filter((row) => row.deleted === 0 && row.status === 1),
      update: async ({ where, data }: any) => {
        const row = selections.find((entry) => entry.itinerary_plan_hotel_details_ID === where.itinerary_plan_hotel_details_ID);
        Object.assign(row, data);
        return row;
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async ({ where }: any) => rooms.filter((row) => row.itinerary_plan_hotel_details_id === where.itinerary_plan_hotel_details_id && row.deleted === 0 && row.status === 1),
      update: async ({ where, data }: any) => {
        const row = rooms.find((entry) => entry.itinerary_plan_hotel_room_details_ID === where.itinerary_plan_hotel_room_details_ID);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        rooms.filter((row) => row.itinerary_plan_hotel_details_id === where.itinerary_plan_hotel_details_id && row.deleted === 0 && row.status === 1).forEach((row) => Object.assign(row, data));
      },
      create: async ({ data }: any) => {
        const row = { ...data, itinerary_plan_hotel_room_details_ID: rooms.length + 1 };
        rooms.push(row);
        return row;
      },
    },
  };
  return { tx, selections, rooms };
}

test('reconciliation is idempotent and updates the existing selected room in place', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections, rooms } = makeReconciliationTx();
  const option = {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'tbo',
    hotelCode: 'H-1',
    hotelId: 101,
    roomId: 'room-1',
    rateId: 'rate-1',
    rateOptionId: 'rate-1',
    hotelName: 'Stable Hotel',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    pricePerNight: 100,
    totalStayPrice: 100,
  };
  option.optionKey = hotelOptionKey(option);

  await (service as any).reconcileSelections(tx, 44, [option], 'run-1', 1);
  await (service as any).reconcileSelections(tx, 44, [option], 'run-2', 1);

  assert.equal(selections.filter((row) => row.deleted === 0 && row.status === 1).length, 1);
  assert.equal(rooms.filter((row) => row.deleted === 0 && row.status === 1).length, 1);
  assert.equal(selections[0].itinerary_plan_hotel_details_ID, 1);
  assert.equal(rooms[0].itinerary_plan_hotel_details_id, 1);
});

test('same hotel with unchanged rate does not rewrite the durable selection', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections } = makeReconciliationTx();
  const refreshed: any = {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'tbo',
    hotelCode: 'H-1',
    hotelId: 101,
    hotelName: 'Stable Hotel',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    pricePerNight: 100,
    totalStayPrice: 100,
    rateOptionId: 'rate-1-new-search',
    searchReference: 'search-reference-new',
    bookingCode: 'search-reference-new',
    roomId: 'room-1',
    rateId: 'rate-1',
  };
  refreshed.optionKey = hotelOptionKey(refreshed);

  const summary = await (service as any).reconcileSelections(tx, 44, [refreshed], 'run-refreshed', 1);

  assert.equal(summary.hasChanges, false);
  assert.equal(selections[0].selected_rate_option_id, 'rate-1');
  assert.equal(JSON.parse(selections[0].selected_price_snapshot).searchReference, undefined);
});

test('persisted selection matches a nested supplier rate without marking the hotel unavailable', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const selection = {
    hotel_id: 101,
    hotel_code: 'H-1',
    hotel_provider: 'tbo',
    selected_total_price: 6373.71,
    selected_price_snapshot: JSON.stringify({
      hotelCode: 'H-1',
      provider: 'tbo',
      roomType: 'Compact',
      mealPlan: 'Room Only',
      totalPrice: 2124.57,
    }),
  };
  const row = {
    hotelId: 101,
    hotelCode: 'H-1',
    provider: 'tbo',
    hotelName: 'Stable Hotel',
    totalHotelCost: 1712.55,
    rateOptions: [{
      hotelId: 101,
      hotelCode: 'H-1',
      provider: 'tbo',
      roomType: 'Compact',
      mealPlan: 'Room Only',
      pricePerNight: 2124.57,
      totalStayPrice: 2124.57,
    }],
  };

  assert.equal((service as any).rowMatchesSelection(selection, row), true);
});

test('price reconciliation stages the complete nested option until acknowledgement', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const { tx, selections } = makeReconciliationTx();
  selections[0].selected_rate_option_id = 'rate-1';
  selections[0].selected_total_price = 2304;
  selections[0].selected_price_per_night = 1152;
  selections[0].selected_price_snapshot = JSON.stringify({
    provider: 'staah',
    hotelCode: 'H-1',
    roomType: 'Suite Room',
    mealPlan: 'MAP',
    rateOptionId: 'rate-1',
    totalPrice: 2304,
    pricePerNight: 1152,
  });

  const refreshed: any = {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'tbo',
    hotelCode: 'H-1',
    hotelId: 101,
    hotelName: 'Stable Hotel',
    // The parent intentionally describes another option. Reconciliation must
    // use the nested rate matching selected_rate_option_id instead.
    roomType: 'Suite Room',
    mealPlan: 'MAP',
    rateOptionId: 'rate-2',
    pricePerNight: 999,
    totalPrice: 999,
    rateOptions: [
      {
        provider: 'tbo',
        hotelCode: 'H-1',
        hotelId: 101,
        hotelName: 'Stable Hotel',
        roomType: 'Deluxe Room',
        mealPlan: 'CP',
        roomId: 'deluxe-room',
        rateId: 'cp-rate',
        rateOptionId: 'rate-1',
        pricePerNight: 1600,
        totalStayPrice: 3200,
        totalPrice: 3200,
      },
      {
        provider: 'tbo',
        hotelCode: 'H-1',
        hotelId: 101,
        hotelName: 'Stable Hotel',
        roomType: 'Suite Room',
        mealPlan: 'MAP',
        roomId: 'suite-room',
        rateId: 'map-rate',
        rateOptionId: 'rate-2',
        pricePerNight: 1800,
        totalStayPrice: 3600,
        totalPrice: 3600,
      },
    ],
  };

  const summary = await (service as any).reconcileSelections(tx, 44, [refreshed], 'run-nested-rate', 1);
  const snapshot = JSON.parse(selections[0].selected_price_snapshot);

  assert.equal(summary.hasChanges, true);
  assert.equal(selections[0].selected_rate_option_id, 'rate-1');
  assert.equal(selections[0].selected_price_per_night, 1152);
  assert.equal(selections[0].selected_total_price, 2304);
  assert.equal(snapshot.pendingAvailabilityChange.requiresAcceptance, true);
  assert.equal(snapshot.pendingAvailabilityChange.option.rateOptionId, 'rate-1');
  assert.equal(snapshot.pendingAvailabilityChange.option.roomType, 'Deluxe Room');

  const applied = await (service as any).applyPendingSelectionChanges(tx, 44, [1], 1);
  assert.deepEqual(applied, [1]);
  assert.equal(selections[0].selected_price_per_night, 1600);
  assert.equal(selections[0].selected_total_price, 3200);
  const acceptedSnapshot = JSON.parse(selections[0].selected_price_snapshot);
  assert.equal(acceptedSnapshot.roomType, 'Deluxe Room');
  assert.equal(acceptedSnapshot.mealPlan, 'CP');
  assert.equal(Object.prototype.hasOwnProperty.call(acceptedSnapshot, 'pendingAvailabilityChange'), false);
});

test('unavailable exact USER_SELECTED rate is preserved and reports the fresh same-hotel proposal', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections } = makeReconciliationTx();
  const refreshed: any = {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'tbo',
    hotelCode: 'H-1',
    hotelId: 101,
    hotelName: 'Stable Hotel',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    pricePerNight: 125,
    totalStayPrice: 125,
    rateOptionId: 'rate-2',
    searchReference: 'search-reference-2',
    roomId: 'room-1',
    rateId: 'rate-2',
  };
  refreshed.optionKey = hotelOptionKey(refreshed);

  const summary = await (service as any).reconcileSelections(tx, 44, [refreshed], 'run-rate-change', 1);

  assert.equal(summary.hasChanges, true);
  assert.equal(summary.totalChanges, 1);
  assert.equal(summary.changes.some((change: any) => change.changeType === 'SELECTION_UNAVAILABLE'), true);
  assert.equal(summary.changes.some((change: any) => change.previous?.hotelName === 'Stable Hotel' && change.current?.hotelName === 'Stable Hotel'), true);
  assert.equal(selections[0].selected_total_price, 100);
  assert.equal(selectionOriginFromRow(selections[0]), 'USER_SELECTED');
});

test('authoritative identity treats CP and Continental Plan as the same meal plan', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const identity = {
    provider: 'axisrooms', canonicalHotelId: 232, providerHotelCode: 'AX_DVI_HOTEL_232',
    rateOptionId: 'axisrooms:232:605:CP_PLAN:2026-09-06',
    mealPlan: 'CONTINENTAL PLAN',
  };

  assert.equal((service as any).autoSelectionIdentityMatches({
    provider: 'axisrooms', hotelId: 232, hotelCode: 'AX_DVI_HOTEL_232',
    rateOptionId: 'axisrooms:232:605:CP_PLAN:2026-09-06', mealPlan: 'CP',
  }, identity), true);
  assert.equal(autoSelectionIdentityMatches({
    provider: 'axisrooms', hotelId: 232, hotelCode: 'AX_DVI_HOTEL_232',
    rateOptionId: 'axisrooms:232:605:CP_PLAN:2026-09-06', mealPlan: 'CP',
  }, identity), true);
});

test('unavailable USER_SELECTED hotel is not replaced automatically', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections } = makeReconciliationTx();
  const nearest: any = {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'tbo',
    hotelCode: 'H-2',
    hotelId: 202,
    hotelName: 'Nearest Hotel',
    roomType: 'Deluxe',
    mealPlan: 'CP',
    pricePerNight: 110,
    totalStayPrice: 110,
    rateOptionId: 'rate-near',
    searchReference: 'search-near',
    isBookable: true,
    isSelectable: true,
  };
  nearest.optionKey = hotelOptionKey(nearest);
  const farther: any = { ...nearest, hotelCode: 'H-3', hotelId: 303, hotelName: 'Farther Hotel', totalStayPrice: 160, pricePerNight: 160 };
  farther.optionKey = hotelOptionKey(farther);

  const summary = await (service as any).reconcileSelections(tx, 44, [nearest, farther], 'run-unavailable', 1);

  assert.equal(summary.changes.some((change: any) => change.changeType === 'SELECTION_UNAVAILABLE'), true);
  assert.equal(selections[0].hotel_id, 101);
  assert.equal(selections[0].hotel_code, 'H-1');
  assert.equal(selectionOriginFromRow(selections[0]), 'USER_SELECTED');

  const repeated = await (service as any).reconcileSelections(tx, 44, [nearest, farther], 'run-unavailable-2', 1);
  assert.equal(repeated.hasChanges, false);
  assert.equal(repeated.totalChanges, 0);
});

test('provider failure preserves the selection as unknown instead of treating it as sold out', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections } = makeReconciliationTx();
  selections[0].selected_price_snapshot = JSON.stringify({
    selectionOrigin: 'AUTO_SELECTED',
    hotelName: 'Saved TBO Hotel',
    totalPrice: 100,
  });

  const summary = await (service as any).reconcileSelections(
    tx,
    44,
    [{
      groupType: 1,
      itineraryRouteId: 10,
      date: '2026-07-28',
      provider: 'axisrooms',
      hotelId: 202,
      hotelCode: 'AX-202',
      hotelName: 'Other Available Hotel',
      totalStayPrice: 90,
      isBookable: true,
      isSelectable: true,
    }],
    'run-provider-failed',
    1,
    false,
    undefined,
    undefined,
    undefined,
    new Set(['tbo']),
  );

  assert.equal(summary.hasChanges, false);
  assert.equal(selections[0].hotel_provider, 'tbo');
  assert.equal(selections[0].hotel_id, 101);
  const snapshot = JSON.parse(selections[0].selected_price_snapshot);
  assert.equal(snapshot.availabilityStatus, 'UNKNOWN');
  assert.match(snapshot.availabilityMessage, /could not be verified/i);
});

test('initial availability creates one canonical auto-selection per missing stay/group', async () => {
  const createdSelections: any[] = [];
  const createdRooms: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        const row = {
          ...data,
          itinerary_plan_hotel_details_ID: 501,
          itinerary_plan_id: 44,
          hotel_required: 1,
        };
        createdSelections.push(row);
        return row;
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdRooms.push(data);
        return data;
      },
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'tbo',
    hotelId: 987,
    hotelCode: 'PROVIDER-HOTEL-987',
    hotelName: 'Auto Hotel',
    roomId: 'room-1',
    rateId: 'rate-1',
    rateOptionId: 'rate-1',
    totalHotelCost: 1200,
    totalHotelTaxAmount: 120,
    isBookable: true,
    isSelectable: true,
  }], 'hotel-run-1', 7);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_id, 987);
  assert.equal(createdSelections[0].hotel_code, 'PROVIDER-HOTEL-987');
  assert.equal(createdSelections[0].selected_price_snapshot.includes('AUTO_SELECTED'), true);
  assert.equal(createdRooms.length, 1);
  assert.equal(createdRooms[0].hotel_id, 987);
  assert.equal(createdRooms[0].room_id, 0);
});

test('empty persisted placeholder does not reserve an authoritative recommendation key', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ preferred_room_count: 2, total_adult: 5 }),
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{ itinerary_plan_hotel_details_ID: 21918, itinerary_route_id: 11326,
        itinerary_route_date: '2026-09-03', group_type: 2, hotel_id: 0, hotel_code: null,
        hotel_provider: null, selected_price_snapshot: null }],
      create: async ({ data }: any) => { createdSelections.push(data); return { ...data, itinerary_plan_hotel_details_ID: 21919 }; },
    },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [], create: async ({ data }: any) => data },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const option: any = {
    itineraryRouteId: 11326, groupType: 2, date: '2026-09-03', provider: 'staah',
    hotelId: 232, hotelCode: 'STAAH-232', hotelName: 'STAAH TEST HOTEL PROD',
    roomType: 'Garden Cottage', mealPlan: 'CP', rateOptionId: 'rate-2026-09-03',
    totalHotelCost: 20034, pricePerNight: 20034, isBookable: true, isSelectable: true,
    authoritativeRecommendation: true, autoSelectionCandidate: true,
    authoritativeParentRouteId: 11326, authoritativeRouteIds: [11326, 11327],
    authoritativeCheckInDate: '2026-09-03', authoritativeCheckOutDate: '2026-09-05',
  };
  option.autoSelectionIdentity = { provider: 'staah', canonicalHotelId: 232,
    providerHotelCode: 'STAAH-232', rateOptionId: 'rate-2026-09-03', mealPlan: 'CP' };

  await (service as any).ensureAutoSelections(tx, 44, [option], 'placeholder-run', 7);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_id, 232);
  assert.equal(createdSelections[0].group_type, 2);
});

test('initial availability persists the authoritative offline category selection even when live inventory exists', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 511 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
      updateMany: async () => ({}),
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const authoritativeOffline = {
    itineraryRouteId: 10,
    groupType: 2,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 232,
    hotelCode: 'OFFLINE-232',
    hotelName: 'Exact Category Hotel',
    rateOptionId: 'offline-232-cp',
    mealPlan: 'CP',
    totalHotelCost: 1200,
    isBookable: true,
    isSelectable: true,
    authoritativeRecommendation: true,
    autoSelectionCandidate: true,
  };
  authoritativeOffline.autoSelectionIdentity = {
    provider: 'offline', canonicalHotelId: 232, providerHotelCode: 'OFFLINE-232',
    rateOptionId: 'offline-232-cp', mealPlan: 'CONTINENTAL PLAN',
  };

  await (service as any).ensureAutoSelections(tx, 44, [authoritativeOffline, {
    itineraryRouteId: 10,
    groupType: 2,
    date: '2026-07-28',
    provider: 'axisrooms',
    hotelId: 563,
    hotelCode: 'AX-563',
    hotelName: 'Higher Category Live Hotel',
    rateOptionId: 'axis-563-cp',
    mealPlan: 'CP',
    totalHotelCost: 1800,
    isBookable: true,
    isSelectable: true,
  }], 'authoritative-offline-run', 7, false, undefined, 'CP');

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_provider, 'offline');
  assert.equal(createdSelections[0].hotel_id, 232);
});

test('MAP fallback auto-selects live CP without relabelling it as MAP', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 502 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 2,
    date: '2026-07-28',
    provider: 'tbo',
    hotelId: 988,
    hotelCode: 'PROVIDER-HOTEL-988',
    hotelName: 'Group Two Hotel',
    mealPlan: 'CP',
    roomId: 'room-2',
    rateId: 'rate-2',
    rateOptionId: 'rate-2',
    totalHotelCost: 1300,
    isBookable: true,
    isSelectable: true,
  }], 'hotel-run-meal-fallback', 7, false, undefined, 'MAP');

  assert.equal(createdSelections.length, 1);
  const snapshot = JSON.parse(createdSelections[0].selected_price_snapshot);
  assert.equal(snapshot.mealPlan, 'CP');
  assert.equal(snapshot.selectionOrigin, 'AUTO_SELECTED');
});

test('MAP fallback auto-selects EP when CP is unavailable without relabelling it as MAP', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 505 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 2,
    date: '2026-07-28',
    provider: 'tbo',
    hotelId: 989,
    hotelCode: 'PROVIDER-HOTEL-989',
    hotelName: 'Group Two EP Hotel',
    mealPlan: 'EP',
    roomId: 'room-ep',
    rateId: 'rate-ep',
    rateOptionId: 'rate-ep',
    totalHotelCost: 1200,
    isBookable: true,
    isSelectable: true,
  }], 'hotel-run-meal-ep-fallback', 7, false, undefined, 'MAP');

  assert.equal(createdSelections.length, 1);
  const snapshot = JSON.parse(createdSelections[0].selected_price_snapshot);
  assert.equal(snapshot.mealPlan, 'EP');
  assert.equal(snapshot.selectionOrigin, 'AUTO_SELECTED');
});

test('an explicitly auto-selected offline snapshot remains automatic', () => {
  assert.equal(selectionOriginFromRow({
    hotel_provider: 'offline',
    selected_price_snapshot: JSON.stringify({ selectionOrigin: 'AUTO_SELECTED' }),
  }), 'AUTO_SELECTED');
  assert.equal(selectionOriginFromRow({
    hotel_provider: 'offline',
    selected_price_snapshot: JSON.stringify({ selectionOrigin: 'USER_SELECTED' }),
  }), 'USER_SELECTED');
  assert.equal(selectionOriginFromRow({
    hotel_provider: 'offline',
    hotel_booking_mode: 'OFFLINE_MANUAL',
    price_source: 'OFFLINE_DB',
  }), 'AUTO_SELECTED');
  assert.equal(selectionOriginFromRow({
    hotel_provider: 'offline',
    hotel_booking_mode: 'MANUAL_APPROVAL',
    price_source: 'DATABASE',
  }), 'USER_SELECTED');
});

test('auto-selection falls back to CP without relabelling it when MAP has no priced option', async () => {
  const createdSelections: any[] = [];
  const createdRooms: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 503 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdRooms.push(data);
        return data;
      },
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 2,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 322,
    hotelCode: '322',
    hotelName: 'Offline CP Hotel',
    mealPlan: 'CP',
    roomId: 834,
    roomType: 'Vinayaga Superior',
    rateOptionId: 'offline-322-834-cp',
    totalHotelCost: 1300,
    isBookable: true,
    isSelectable: true,
  }], 'hotel-run-map-offline-fallback', 7, false, undefined, 'MAP', {
    breakfast: 1,
    lunch: 0,
    dinner: 1,
  });

  assert.equal(createdSelections.length, 1);
  assert.equal(createdRooms.length, 1);
  const snapshot = JSON.parse(createdSelections[0].selected_price_snapshot);
  assert.equal(snapshot.mealPlan, 'CP');
  assert.equal(snapshot.selectionOrigin, 'AUTO_SELECTED');
  assert.equal(createdSelections[0].selected_rate_option_id, 'offline-322-834-cp');
});

test('meal-plan notice keeps CP inventory selectable and explains the MAP fallback', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const cpOption = {
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 322,
    hotelName: 'CP Hotel',
    roomType: 'Superior',
    mealPlan: 'CP',
    totalHotelCost: 1300,
    isBookable: true,
    isSelectable: true,
  };

  const [decorated] = (service as any).decorateMealPlanAutoSelectionBlockers(
    [cpOption],
    'MAP',
    new Map(),
    44,
  );

  assert.equal(decorated.autoSelectionBlocked, true);
  assert.equal(decorated.autoSelectionBlockCode, 'REQUESTED_MEAL_PLAN_PRICE_UNAVAILABLE');
  assert.equal(decorated.autoSelectionBlockMessage, 'MAP requested — price unavailable.');
  assert.deepEqual(decorated.availableMealPlanCodes, ['CP']);
  assert.equal(decorated.isSelectable, true);
  assert.equal(decorated.mealPlan, 'CP');
});

test('meal-plan blocker is absent when an exact MAP option is priced', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const rows = (service as any).decorateMealPlanAutoSelectionBlockers([{
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'staah',
    hotelId: 500,
    hotelName: 'MAP Hotel',
    roomType: 'Deluxe',
    mealPlan: 'MAP',
    totalHotelCost: 1800,
    isBookable: true,
    isSelectable: true,
  }], 'MAP', new Map(), 44);

  assert.equal(rows[0].autoSelectionBlocked, undefined);
});

test('authoritative recommendation scope falls back to complete CP inventory when MAP is unavailable', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const authoritativeEp = {
    provider: 'tbo',
    hotelId: 24188,
    hotelCode: 'TBO-24188',
    roomId: 'ep-room',
    rateOptionId: 'ep-rate',
    roomType: 'Standard Room',
    mealPlan: 'EP',
    totalHotelCost: 2200,
  };
  const completeCp = {
    provider: 'tbo',
    hotelId: 24188,
    hotelCode: 'TBO-24188',
    roomId: 'cp-room',
    rateOptionId: 'cp-rate',
    roomType: 'Standard Room',
    mealPlan: 'CP',
    totalHotelCost: 2400,
  };

  const pool = (service as any).getEffectiveAutoSelectionPool(
    [authoritativeEp, completeCp],
    'MAP',
    undefined,
    [authoritativeEp],
  );

  assert.deepEqual(pool, [completeCp]);
});

test('empty authoritative MAP scope uses complete CP inventory when available', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const completeCp = {
    provider: 'tbo',
    hotelId: 24188,
    hotelCode: 'TBO-24188',
    roomId: 'cp-room',
    rateOptionId: 'cp-rate',
    roomType: 'Standard Room',
    mealPlan: 'CP',
    totalHotelCost: 2400,
  };

  const pool = (service as any).getEffectiveAutoSelectionPool(
    [completeCp],
    'MAP',
    undefined,
    [],
    true,
  );

  assert.deepEqual(pool, [completeCp]);
});

test('refresh replaces an incompatible AUTO_SELECTED rate with the permitted CP fallback', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections, rooms } = makeReconciliationTx();
  selections[0].selected_price_snapshot = JSON.stringify({
    selectionOrigin: 'AUTO_SELECTED',
    hotelName: 'Old EP Hotel',
    roomType: 'Deluxe - OTA EP Plan',
    mealPlan: 'EP',
  });
  selections[0].selected_rate_option_id = 'rate-ep';

  const cpOnly: any = {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'resavenue',
    hotelCode: 'H-CP',
    hotelId: 202,
    roomId: 'room-cp',
    rateId: 'rate-cp',
    rateOptionId: 'rate-cp',
    hotelName: 'CP Only Hotel',
    roomType: 'Deluxe - OTA CP Plan',
    mealPlan: 'CP',
    pricePerNight: 140,
    totalStayPrice: 140,
    isBookable: true,
    isSelectable: true,
  };
  cpOnly.optionKey = hotelOptionKey(cpOnly);

  const summary = await (service as any).reconcileSelections(
    tx,
    44,
    [cpOnly],
    'run-map-mismatch',
    1,
    false,
    undefined,
    'MAP',
  );

  const activeSelection = selections.find((row) => row.deleted === 0 && row.status === 1);
  assert.ok(activeSelection);
  assert.equal(activeSelection.selected_rate_option_id, 'rate-ep');
  assert.equal(JSON.parse(activeSelection.selected_price_snapshot).pendingAvailabilityChange.option.rateOptionId, 'rate-cp');
  await (service as any).applyPendingSelectionChanges(tx, 44, [1], 1);
  assert.equal(activeSelection.selected_rate_option_id, 'rate-cp');
  assert.equal(JSON.parse(activeSelection.selected_price_snapshot).mealPlan, 'CP');
  assert.equal(rooms.filter((row) => row.deleted === 0 && row.status === 1).length, 1);
  assert.equal(summary.changes.some((change: any) => change.changeType === 'AUTO_SELECTION_CHANGED'), true);
});

test('auto-selection uses a requested nested rate option instead of the parent display meal plan', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 504 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 2,
    date: '2026-07-28',
    provider: 'tbo',
    hotelId: 988,
    hotelCode: 'PROVIDER-HOTEL-988',
    hotelName: 'Group Two Hotel',
    mealPlan: 'CP',
    roomType: 'Standard Room',
    totalHotelCost: 1300,
    isBookable: true,
    isSelectable: true,
    rateOptions: [
      {
        roomId: 'room-cp',
        rateId: 'rate-cp',
        rateOptionId: 'rate-cp',
        mealPlan: 'CP',
        totalHotelCost: 1300,
      },
      {
        roomId: 'room-map',
        rateId: 'rate-map',
        rateOptionId: 'rate-map',
        mealPlan: 'MAP',
        totalHotelCost: 1600,
      },
    ],
  }], 'hotel-run-nested-map', 7, false, undefined, 'MAP');

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].selected_rate_option_id, 'rate-map');
  assert.equal(JSON.parse(createdSelections[0].selected_price_snapshot).mealPlan, 'MAP');
});

test('auto-selection accepts explicit offline approval candidates when no meal plan is constrained', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 503 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 3,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 989,
    hotelCode: 'OFFLINE-HOTEL-989',
    hotelName: 'Approval Hotel',
    mealPlan: 'CP',
    roomType: 'Queen Bed',
    totalHotelCost: 12000,
    isBookable: false,
    isSelectable: true,
    availabilityStatus: 'OFFLINE_APPROVAL_REQUIRED',
    bookingMode: 'MANUAL_APPROVAL',
    requiresHotelApproval: true,
  }], 'hotel-run-approval-fallback', 7, false, undefined, undefined);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].group_type, 3);
  assert.equal(createdSelections[0].hotel_id, 989);
  assert.equal(createdSelections[0].selected_price_snapshot.includes('AUTO_SELECTED'), true);
});

test('reset retries the live availability rebuild when the first snapshot has no hotels', async () => {
  let offlineCacheCleared = 0;
  const service = new HotelAvailabilitySnapshotService(
    {} as any,
    {} as any,
    { clearCache: () => { offlineCacheCleared += 1; } } as any,
  );
  const calls: any[] = [];
  (service as any).searchAndPersist = async (
    quoteId: string,
    requestType: string,
    createdBy: number,
    resetSelections: boolean,
  ) => {
    calls.push({ quoteId, requestType, createdBy, resetSelections });
    return calls.length === 1
      ? { searchRunId: 'empty-run', response: { hotels: [] }, changeSummary: { hasChanges: false, totalChanges: 0, changes: [] } }
      : { searchRunId: 'live-run', response: { hotels: [{ hotelName: 'Live Hotel' }] }, changeSummary: { hasChanges: false, totalChanges: 0, changes: [] } };
  };

  const result = await service.resetAndPersist('DVI20260893', 7);

  assert.equal(result.searchRunId, 'live-run');
  assert.equal(offlineCacheCleared, 0);
  assert.deepEqual(calls, [
    { quoteId: 'DVI20260893', requestType: 'CREATE', createdBy: 7, resetSelections: true },
    { quoteId: 'DVI20260893', requestType: 'CHECK_AVAILABILITY', createdBy: 7, resetSelections: true },
  ]);
});

test('live reset rows exclude synthetic departure-route availability rows', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const searchableRouteIds = (service as any).getSearchableRouteIds([
    { itinerary_route_ID: 10208 },
    { itinerary_route_ID: 10209 },
    { itinerary_route_ID: 10210 },
  ], 2);
  const rows = (service as any).filterSearchableLiveRows([
    { itineraryRouteId: 10208, hotelName: 'Live Hotel' },
    { itineraryRouteId: 10210, hotelName: 'No hotel available', provider: 'external' },
  ], searchableRouteIds);

  assert.deepEqual(rows.map((row: any) => row.itineraryRouteId), [10208]);
});

test('missing auto selection is replaced in place and reports AUTO_SELECTION_CHANGED', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections, rooms } = makeReconciliationTx();
  selections[0].selected_price_snapshot = JSON.stringify({ selectionOrigin: 'AUTO_SELECTED', hotelName: 'Old Auto Hotel' });
  selections[0].selected_rate_option_id = 'rate-old';
  const replacement: any = {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'axisrooms',
    hotelCode: 'H-2',
    hotelId: 202,
    roomId: 'room-2',
    rateId: 'rate-2',
    rateOptionId: 'rate-2',
    hotelName: 'New Auto Hotel',
    roomType: 'Suite',
    mealPlan: 'MAP',
    pricePerNight: 140,
    totalStayPrice: 140,
    isBookable: true,
    isSelectable: true,
  };
  replacement.optionKey = hotelOptionKey(replacement);

  const summary = await (service as any).reconcileSelections(tx, 44, [replacement], 'run-auto', 1);

  assert.equal(summary.hasChanges, true);
  assert.equal(summary.changes.some((change: any) => change.changeType === 'AUTO_SELECTION_CHANGED'), true);
  assert.equal(selections.filter((row) => row.deleted === 0 && row.status === 1).length, 1);
  assert.equal(selections[0].hotel_id, 101);
  assert.equal(JSON.parse(selections[0].selected_price_snapshot).pendingAvailabilityChange.option.hotelId, 202);
  await (service as any).applyPendingSelectionChanges(tx, 44, [1], 1);
  assert.equal(selections[0].hotel_id, 202);
  assert.equal(rooms.filter((row) => row.deleted === 0 && row.status === 1).length, 1);
});

test('AUTO_SELECTED replacement prefers comparable room and closest payable total over lowest price', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const { tx, selections } = makeReconciliationTx();
  selections[0].selected_total_price = 9000;
  selections[0].total_hotel_cost = 9000;
  selections[0].selected_price_snapshot = JSON.stringify({ selectionOrigin: 'AUTO_SELECTED', roomType: 'Suite', mealPlan: 'CP', totalPrice: 9000 });
  selections[0].selected_rate_option_id = 'old-suite';
  const deluxe: any = {
    groupType: 1, itineraryRouteId: 10, date: '2026-07-28', provider: 'staah',
    hotelCode: 'H-2', hotelId: 202, roomId: 'deluxe', rateId: 'deluxe-rate',
    rateOptionId: 'deluxe-rate', hotelName: 'New Hotel', roomType: 'Deluxe',
    mealPlan: 'CP', pricePerNight: 5000, totalStayPrice: 5000,
    isBookable: true, isSelectable: true,
  };
  deluxe.optionKey = hotelOptionKey(deluxe);
  const suite: any = { ...deluxe, roomType: 'Suite', roomId: 'suite', rateId: 'suite-rate', rateOptionId: 'suite-rate', pricePerNight: 9500, totalStayPrice: 9500 };
  suite.optionKey = hotelOptionKey(suite);

  await (service as any).reconcileSelections(tx, 44, [deluxe, suite], 'run-auto-price', 1);

  assert.equal(selections[0].hotel_id, 101);
  assert.equal(JSON.parse(selections[0].selected_price_snapshot).pendingAvailabilityChange.option.rateOptionId, 'suite-rate');
  await (service as any).applyPendingSelectionChanges(tx, 44, [1], 1);
  assert.equal(selections[0].hotel_id, 202);
  assert.equal(selections[0].selected_rate_option_id, 'suite-rate');
  assert.equal(JSON.parse(selections[0].selected_price_snapshot).roomType, 'Suite');
  assert.equal(Number(selections[0].selected_total_price), 9500);
});

test('AUTO_SELECTED chooses the cheapest eligible live provider before deterministic tie-breaks', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => { createdSelections.push(data); return { ...data, itinerary_plan_hotel_details_ID: 777 }; },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const rows = ['axisrooms', 'tbo', 'staah'].map((provider, index) => ({
    itineraryRouteId: 10, groupType: 1, date: '2026-07-28', provider,
    hotelId: 300 + index, hotelCode: `${provider}-hotel`, hotelName: provider,
    roomId: provider, rateId: `${provider}-rate`, rateOptionId: `${provider}-rate`,
    totalStayPrice: provider === 'staah' ? 2800 : provider === 'tbo' ? 3000 : 4000,
    isBookable: true, isSelectable: true,
  }));
  rows.forEach((row: any) => { row.optionKey = hotelOptionKey(row); });

  await (service as any).ensureAutoSelections(tx, 44, rows, 'run-provider-price', 7);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_provider, 'staah');
  assert.equal(Number(createdSelections[0].selected_total_price), 2800);
});

test('selected totals include a positive supplement cost when the normalized amount is zero', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 6 }) },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => { createdSelections.push(data); return { ...data, itinerary_plan_hotel_details_ID: 778 }; },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const row: any = {
    itineraryRouteId: 10, groupType: 1, date: '2026-07-28', provider: 'offline',
    hotelId: 301, hotelCode: 'axis-hotel', hotelName: 'Axis Hotel', roomId: 'room-1',
    rateId: 'axis-rate', rateOptionId: 'axis-rate', totalStayPrice: 10000,
    baseTotalPrice: 10000, totalRoomCost: 10000,
    extraBedCount: 1, extraBedRate: 2000, extraBedAmount: 0, totalExtraBedCost: 2000,
    childWithoutBedCount: 1, childWithoutBedRate: 1500, childWithoutBedAmount: 0,
    totalChildWithoutBedCost: 1500,
    isBookable: false, isLiveBookable: false, requiresHotelApproval: true,
    bookingMode: 'MANUAL_APPROVAL', isSelectable: true,
  };
  row.optionKey = hotelOptionKey(row);

  await (service as any).ensureAutoSelections(tx, 44, [row], 'run-supplement-normalization', 6);

  assert.equal(createdSelections.length, 1);
  assert.equal(Number(createdSelections[0].total_room_cost), 10000);
  assert.equal(Number(createdSelections[0].total_extra_bed_cost), 2000);
  assert.equal(Number(createdSelections[0].total_childwithout_bed_cost), 1500);
  assert.equal(Number(createdSelections[0].hotel_margin_rate), 810);
  assert.equal(Number(createdSelections[0].total_hotel_cost), 14310);
});

test('refresh replaces a persisted AUTO_SELECTED offline row when live exists for the same day', async () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const { tx, selections } = makeReconciliationTx();
  selections[0].hotel_id = 987;
  selections[0].hotel_code = 'OFFLINE-987';
  selections[0].hotel_provider = 'offline';
  selections[0].selected_rate_option_id = 'offline-rate';
  selections[0].selected_price_snapshot = JSON.stringify({
    optionKey: 'offline|offline-987|room-1|offline-rate||||2026-07-28|',
    selectionOrigin: 'AUTO_SELECTED',
    hotelName: 'Offline Hotel',
    roomType: 'Deluxe',
    mealPlan: 'CP',
  });

  await (service as any).reconcileSelections(tx, 44, [{
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 987,
    hotelCode: 'OFFLINE-987',
    hotelName: 'Offline Hotel',
    roomId: 'room-1',
    rateId: 'offline-rate',
    rateOptionId: 'offline-rate',
    totalStayPrice: 1200,
    isBookable: true,
    isSelectable: true,
  }, {
    groupType: 1,
    itineraryRouteId: 10,
    date: '2026-07-28',
    provider: 'staah',
    hotelId: 988,
    hotelCode: 'LIVE-988',
    hotelName: 'Live Hotel',
    roomId: 'room-2',
    rateId: 'live-rate',
    rateOptionId: 'live-rate',
    totalStayPrice: 1800,
    isBookable: true,
    isSelectable: true,
  }], 'live-refresh', 7, false);

  assert.equal(selections[0].hotel_provider, 'offline');
  assert.equal(JSON.parse(selections[0].selected_price_snapshot).pendingAvailabilityChange.option.provider, 'staah');
  await (service as any).applyPendingSelectionChanges(tx, 44, [1], 7);
  assert.equal(selections[0].hotel_provider, 'staah');
  assert.equal(selections[0].hotel_id, 988);
});

test('live reconciliation falls back to offline inventory only when live is absent', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 900 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 987,
    hotelCode: 'OFFLINE-987',
    hotelName: 'Offline Hotel',
    totalHotelCost: 1200,
    isBookable: true,
    isSelectable: true,
  }], 'live-run', 7);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_provider, 'offline');
});

test('TBO/VSR complete fare stays ahead of offline when supplements are requested', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({
        preferred_room_count: 1,
        total_adult: 2,
        total_extra_bed: 1,
        total_child_with_bed: 1,
        total_child_without_bed: 1,
      }),
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 901 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'tbo',
    hotelId: 988,
    hotelCode: 'TBO-988',
    hotelName: 'Live VSR Hotel',
    roomType: 'Deluxe Room',
    mealPlan: 'CP',
    totalHotelCost: 1800,
    isBookable: true,
    isSelectable: true,
  }, {
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 987,
    hotelCode: 'OFFLINE-987',
    hotelName: 'Cheaper Offline Hotel',
    roomType: 'Deluxe Room',
    mealPlan: 'CP',
    totalHotelCost: 1200,
    extraBedRate: 200,
    childWithBedRate: 150,
    childWithoutBedRate: 100,
    isBookable: true,
    isSelectable: true,
  }], 'tbo-complete-fare', 7);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_provider, 'tbo');
  assert.equal(createdSelections[0].hotel_id, 988);
});

test('stay-level live inventory does not fabricate a missing recommendation group', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 903 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
      updateMany: async () => ({}),
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 987,
    hotelCode: 'OFFLINE-987',
    hotelName: 'Offline Hotel',
    totalHotelCost: 1200,
    isBookable: true,
    isSelectable: true,
  }, {
    itineraryRouteId: 10,
    groupType: 2,
    date: '2026-07-28',
    provider: 'staah',
    hotelId: 988,
    hotelCode: 'LIVE-988',
    hotelName: 'Live Hotel',
    mealPlan: 'CP',
    totalHotelCost: 1800,
    isBookable: true,
    isSelectable: true,
    authoritativeRecommendation: true,
    autoSelectionCandidate: true,
    autoSelectionIdentity: {
      provider: 'staah',
      canonicalHotelId: 988,
      providerHotelCode: 'LIVE-988',
      mealPlan: 'CP',
    },
  }], 'stay-live-run', 7);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_provider, 'staah');
  assert.equal(createdSelections[0].group_type, 2);
});

test('automatic replacement prefers live providers even when offline is cheaper', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 902 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 987,
    hotelCode: 'OFFLINE-987',
    hotelName: 'Offline Hotel',
    totalHotelCost: 1200,
    isBookable: true,
    isSelectable: true,
  }, {
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'staah',
    hotelId: 988,
    hotelCode: 'LIVE-988',
    hotelName: 'Live Hotel',
    totalHotelCost: 1800,
    isBookable: true,
    isSelectable: true,
  }], 'live-run-with-offline', 7);

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_provider, 'staah');
});

test('a live rate remains the automatic choice when offline has the requested meal plan', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 903 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);

  await (service as any).ensureAutoSelections(tx, 44, [{
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 987,
    hotelCode: 'OFFLINE-CP-987',
    hotelName: 'Offline CP Hotel',
    mealPlan: 'CP',
    totalHotelCost: 1200,
    isBookable: true,
    isSelectable: true,
  }, {
    itineraryRouteId: 10,
    groupType: 1,
    date: '2026-07-28',
    provider: 'resavenue',
    hotelId: 988,
    hotelCode: 'LIVE-EP-988',
    hotelName: 'Live EP Hotel',
    mealPlan: 'EP',
    totalHotelCost: 900,
    isBookable: true,
    isSelectable: true,
  }], 'live-ep-offline-cp', 7, false, undefined, 'CP');

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].hotel_provider, 'resavenue');
  assert.equal(createdSelections[0].hotel_id, 988);
  assert.equal(JSON.parse(createdSelections[0].selected_price_snapshot).mealPlan, 'EP');
});

test('explicit offline fetch can auto-select only its requested stay group', async () => {
  const createdSelections: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        createdSelections.push(data);
        return { ...data, itinerary_plan_hotel_details_ID: 901 };
      },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const offline = (routeId: number) => ({
    itineraryRouteId: routeId,
    groupType: 1,
    date: '2026-07-28',
    provider: 'offline',
    hotelId: 987,
    hotelCode: 'OFFLINE-987',
    hotelName: 'Offline Hotel',
    totalHotelCost: 1200,
    isBookable: true,
    isSelectable: true,
  });

  await (service as any).ensureAutoSelections(
    tx,
    44,
    [offline(10), offline(11)],
    'offline-run',
    7,
    true,
    new Set([11]),
  );

  assert.equal(createdSelections.length, 1);
  assert.equal(createdSelections[0].itinerary_route_id, 11);
  assert.equal(createdSelections[0].hotel_provider, 'offline');
});

test('empty availability is reported as one continuous destination stay block', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const routes = [
    { itinerary_route_ID: 10, itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'), next_visiting_location: 'Munnar', day_number: 1 },
    { itinerary_route_ID: 11, itinerary_route_date: new Date('2026-07-29T00:00:00.000Z'), next_visiting_location: 'Kabini', day_number: 2 },
    { itinerary_route_ID: 12, itinerary_route_date: new Date('2026-07-30T00:00:00.000Z'), next_visiting_location: 'Kabini', day_number: 3 },
    { itinerary_route_ID: 13, itinerary_route_date: new Date('2026-07-31T00:00:00.000Z'), next_visiting_location: 'Bengaluru', day_number: 4 },
  ];
  const blocks = (service as any).buildEmptyStayBlocks(routes, [{
    itineraryRouteId: 10,
    provider: 'tbo',
    isBookable: true,
    isPlaceholder: false,
  }], 3);

  assert.deepEqual(blocks, [{
    routeIds: [11, 12],
    dayNumbers: [2, 3],
    dates: ['2026-07-29', '2026-07-30'],
    destination: 'Kabini',
  }]);
});

test('validated complete logical child route is excluded from empty diagnostics', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const routes = [
    { itinerary_route_ID: 101, itinerary_route_date: new Date('2026-09-04T00:00:00.000Z'), next_visiting_location: 'Pondicherry' },
    { itinerary_route_ID: 102, itinerary_route_date: new Date('2026-09-05T00:00:00.000Z'), next_visiting_location: 'Pondicherry' },
  ];
  const rows = [{
    itineraryRouteId: 101,
    provider: 'staah',
    hotelName: 'Hotel X',
    totalPrice: 8808.99,
    completeStayBookable: true,
    completeStayRouteIds: [101, 102],
  }];
  const covered = (service as any).buildEffectiveCoveredRouteIds(routes, rows, [], 2);
  const blocks = (service as any).buildEmptyStayBlocks(routes, rows, 2, covered);
  assert.deepEqual([...covered].sort(), [101, 102]);
  assert.deepEqual(blocks, []);
});

test('missing physical logical-stay route remains in empty diagnostics', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const routes = [
    { itinerary_route_ID: 101, itinerary_route_date: new Date('2026-09-04T00:00:00.000Z'), next_visiting_location: 'Thekkady' },
    { itinerary_route_ID: 102, itinerary_route_date: new Date('2026-09-05T00:00:00.000Z'), next_visiting_location: 'Thekkady' },
  ];
  const rows = [{ itineraryRouteId: 101, provider: 'staah', hotelName: 'Hotel X', totalPrice: 5000 }];
  const covered = (service as any).buildEffectiveCoveredRouteIds(routes, rows, [], 2);
  const blocks = (service as any).buildEmptyStayBlocks(routes, rows, 2, covered);
  assert.deepEqual([...covered], [101]);
  assert.deepEqual(blocks.map((block: any) => block.routeIds), [[102]]);
});

test('partial continuous hotel coverage is unavailable on every linked route pane', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const routes = [
    { itinerary_route_ID: 101, itinerary_route_date: new Date('2026-09-05T00:00:00.000Z'), next_visiting_location: 'Thekkady', day_number: 3 },
    { itinerary_route_ID: 102, itinerary_route_date: new Date('2026-09-06T00:00:00.000Z'), next_visiting_location: 'Thekkady', day_number: 4 },
  ];
  const rows = [{
    itineraryRouteId: 101,
    routeId: 101,
    date: '2026-09-05',
    provider: 'axisrooms',
    canonicalHotelId: 234,
    hotelName: 'The Patio',
    roomType: 'Deluxe Room NON AC',
    mealPlan: 'CP',
    totalPrice: 5100,
    isBookable: true,
    isSelectable: true,
    rateOptions: [{ roomType: 'Deluxe Room NON AC', mealPlan: 'CP', totalPrice: 5100 }],
  }];

  const result = (service as any).applyCompleteStayAvailability(rows, routes, 2);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((row: any) => Number(row.itineraryRouteId)).sort(), [101, 102]);
  assert.ok(result.every((row: any) => row.availabilityStatus === 'NO_AVAILABILITY'));
  assert.ok(result.every((row: any) => row.availabilityState === 'UNAVAILABLE'));
  assert.ok(result.every((row: any) => row.selectionStatus === 'UNAVAILABLE'));
  assert.ok(result.every((row: any) => row.hotelStayCompleteStayBookable === false));
  assert.ok(result.every((row: any) => row.hotelStayIsSelectable === false));
});

test('TBO selection normalization exposes canonical room pricing', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const projected = projectHotelPayablePricing({
    provider: 'tbo',
    totalStayPrice: 1562.37,
    roomCount: 1,
    isSelected: true,
  }, 10);
  assert.equal(projected.roomRate, 1562.37);
  assert.equal(projected.totalRoomCost, 1562.37);
  assert.equal(projected.hotelMarginBaseAmount, 1562.37);
  assert.equal(projected.hotelMarginAmount, 156.24);
  assert.equal(projected.totalPrice, 1718.61);
});
test('property reconciliation keeps the current availability price', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const row = {
    provider: 'offline',
    hotelId: 687,
    hotelCode: '687',
    hotelName: 'Lemon Tree Shimona',
    roomType: 'Superior Double',
    mealPlan: 'CP',
    totalHotelCost: 7350,
    totalPrice: 7350,
    pricePerNight: 7350,
    isSelectable: true,
  };
  const staleSelection = {
    itinerary_plan_hotel_details_ID: 12201,
    hotel_id: 687,
    hotel_code: '687',
    hotel_provider: 'tbo',
    room_type: 'Superior Double',
    meal_plan: 'CP',
    selected_total_price: 4531.68,
    selected_price_per_night: 4531.68,
    selected_price_snapshot: JSON.stringify({
      provider: 'tbo',
      optionKey: 'tbo|687|old-rate',
      totalPrice: 4531.68,
      pricePerNight: 4531.68,
    }),
  };

  const decorated = (service as any).decoratePropertySelection(row, staleSelection, 10039);

  assert.equal(decorated.totalPrice, 7350);
  assert.equal(decorated.totalHotelCost, 7350);
  assert.equal(decorated.selectedTotalPrice, 7350);
  assert.equal(decorated.pricePerNight, 7350);
  assert.equal(decorated.selectedPricePerNight, 7350);
  assert.equal(decorated.provider, 'offline');
});

test('property reconciliation keeps the persisted payable total for the same provider', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const row = {
    provider: 'offline',
    hotelId: 618,
    hotelCode: '618',
    hotelName: 'GOKULAM PARK - ASHOK NAGAR',
    roomType: 'Deluxe Rooms',
    mealPlan: 'CP',
    totalHotelCost: 3990,
    totalPrice: 3990,
    pricePerNight: 3990,
    hotelMarginPercentage: 0,
    isSelectable: true,
  };
  const persistedSelection = {
    itinerary_plan_hotel_details_ID: 12225,
    hotel_id: 618,
    hotel_code: '618',
    hotel_provider: 'offline',
    room_type: 'Deluxe Rooms',
    meal_plan: 'CP',
    selected_total_price: 4389,
    selected_price_per_night: 3990,
    hotel_margin_percentage: 7,
    selected_price_snapshot: JSON.stringify({
      provider: 'offline',
      optionKey: 'offline|618|current-rate',
      totalPrice: 4389,
      pricePerNight: 3990,
    }),
  };

  const decorated = (service as any).decoratePropertySelection(row, persistedSelection, 10039);

  assert.equal(decorated.totalPrice, 4389);
  assert.equal(decorated.totalHotelCost, 4389);
  assert.equal(decorated.selectedTotalPrice, 4389);
  assert.equal(decorated.pricePerNight, 3990);
  assert.equal(decorated.selectedPricePerNight, 3990);
  assert.equal(decorated.hotelMarginPercentage, 7);
  assert.equal(decorated.provider, 'offline');
});

test('persisted selected rows expose per-room category assignments', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const roomSelections = [
    { room_number: 1, room_type_title: 'Suite Room', room_qty: 1 },
    { room_number: 2, room_type_title: 'Club Room', room_qty: 1 },
    { room_number: 3, room_type_title: 'Club Room', room_qty: 1 },
    { room_number: 4, room_type_title: 'Club Room', room_qty: 1 },
    { room_number: 5, room_type_title: 'Club Room', room_qty: 1 },
  ];
  const row = {
    provider: 'offline',
    hotelId: 315,
    hotelCode: '315',
    hotelName: 'GREEN PALACE',
    itineraryRouteId: 11048,
    itineraryRouteDate: '2026-09-03',
    groupType: 1,
    roomType: 'Club Room',
    mealPlan: 'CP',
    totalHotelCost: 20900,
    totalPrice: 20900,
    pricePerNight: 20900,
    isSelectable: true,
    rateOptions: [{ roomType: 'Club Room', totalPrice: 20900, pricePerNight: 20900 }],
  };
  const selection = {
    __roomCategorySelection: true,
    itinerary_plan_hotel_details_ID: 19920,
    hotel_id: 315,
    hotel_code: '315',
    hotel_provider: 'offline',
    itinerary_route_id: 11048,
    itinerary_route_date: '2026-09-03',
    group_type: 1,
    room_type: 'Club Room',
    selected_total_price: 20900,
    selected_price_per_night: 20900,
    total_no_of_rooms: 5,
    roomSelections,
    selected_price_snapshot: JSON.stringify({
      provider: 'offline',
      roomType: 'Club Room',
      totalPrice: 20900,
      pricePerNight: 20900,
    }),
  };

  const decorated = (service as any).decorateSelection(
    row,
    new Map([[hotelSelectionKeyFromRow(10039, row), selection]]),
    10039,
  );

  assert.deepEqual(decorated.roomSelections, roomSelections);
  assert.deepEqual(decorated.selection.roomSelections, roomSelections);
});

test('room-category reconciliation uses the current nested rate instead of a stale selected total', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const row = {
    provider: 'tbo',
    itineraryRouteId: 10107,
    itineraryRouteDate: '2026-08-08',
    date: '2026-08-08',
    groupType: 1,
    hotelId: 687,
    hotelCode: '687',
    hotelName: 'Park Hyatt Chennai',
    roomType: 'Room, 1 King Bed, Park View',
    totalHotelCost: 11700.15,
    totalPrice: 11700.15,
    pricePerNight: 11700.15,
    rateOptions: [{
      provider: 'tbo',
      hotelId: 687,
      roomType: 'Room, 1 King Bed, Park View',
      roomId: 'park-view',
      mealPlan: 'UNKNOWN',
      totalPrice: 11700.15,
      pricePerNight: 11700.15,
    }],
    // Simulate the stale selected-price fields that can survive on the
    // canonical parent row after a reset.
    selectedTotalPrice: 9983.46,
    selectedPricePerNight: 9983.46,
    isSelectable: true,
  };
  const staleRoomSelection = {
    __roomCategorySelection: true,
    itinerary_plan_hotel_details_ID: 12201,
    hotel_id: 687,
    hotel_provider: 'tbo',
    selected_total_price: 9983.46,
    selected_price_per_night: 9983.46,
    selected_price_snapshot: JSON.stringify({
      hotelId: 687,
      roomType: 'Room, 1 King Bed, Park View',
      roomTypeKeys: ['room1kingbedparkview'],
      totalPrice: 9983.46,
      pricePerNight: 9983.46,
    }),
  };

  const decorated = (service as any).decorateSelection(
    row,
    new Map([['10039|10107|1|2026-08-08|NORMAL', staleRoomSelection]]),
    10039,
  );

  assert.equal(decorated.totalPrice, 11700.15);
  assert.equal(decorated.totalHotelCost, 11700.15);
  assert.equal(decorated.selectedTotalPrice, 11700.15);
  assert.equal(decorated.pricePerNight, 11700.15);
});

test('supplier rows are normalized to the current route date before persistence', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const [normalized] = (service as any).normalizeRowsToCurrentRouteDates([
    {
      itineraryRouteId: 10107,
      routeIds: [10107],
      date: '2026-08-03',
      checkInDate: '2026-08-03',
      checkOutDate: '2026-08-05',
      provider: 'tbo',
      hotelCode: 'old-rate',
      totalPrice: 4531.68,
    },
  ], [
    {
      itinerary_route_ID: 10107,
      itinerary_route_date: new Date('2026-08-08T00:00:00.000Z'),
    },
  ]);

  assert.equal(normalized.date, '2026-08-08');
  assert.equal(normalized.checkInDate, '2026-08-08');
  assert.equal(normalized.checkOutDate, '2026-08-09');
  assert.equal(normalized.itinerary_route_date, '2026-08-08');
  assert.equal(normalized.totalPrice, 4531.68);
});
