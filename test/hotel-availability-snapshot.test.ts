import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelAvailabilitySnapshotService } from '../src/modules/itineraries/services/hotel-availability-snapshot.service';
import { hotelOptionKey } from '../src/modules/itineraries/utils/hotel-selection-identity.util';

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

test('persisted hotel read never invokes a live supplier', async () => {
  const prisma = makePrisma();
  let supplierCalls = 0;
  const service = new HotelAvailabilitySnapshotService(prisma, {
    getHotelDetailsByQuoteIdFromTbo: async () => {
      supplierCalls += 1;
      throw new Error('supplier must not be called by a read');
    },
  } as any);

  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(supplierCalls, 0);
  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels[0].hotelCode, 'H-1');
  assert.equal(response.hotelAvailability?.availabilityState, 'FRESH');
});

test('unscoped offline rows stay inside the existing recommendation groups', async () => {
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

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any);
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.deepEqual(response.hotelTabs.map((tab) => tab.groupType), [1, 2, 3, 4]);
  assert.equal(response.hotelTabs.some((tab) => tab.groupType === 0), false);
  assert.equal(response.hotelTabs.length, 4);
  assert.deepEqual(Array.from(new Set(response.hotels.map((row: any) => row.groupType))), [1, 2, 3, 4]);
});

test('offline materialization creates rows for valid recommendation groups only', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = (service as any).materializeOfflineRows(
    new Map([[10, [{ hotelId: 101, hotelName: 'Offline Hotel', provider: 'offline' }]]]),
    [{ itinerary_route_ID: 10, itinerary_route_date: new Date('2026-07-28T00:00:00.000Z'), next_visiting_location: 'Munnar' }],
    [1, 2, 3, 4, 5, 0],
  );

  assert.deepEqual(rows.map((row: any) => row.groupType), [1, 2, 3, 4]);
});

test('persisted hotel read remaps stale snapshot route IDs by stay date', async () => {
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

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any);
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels[0].itineraryRouteId, 20);
  assert.equal(response.hotels[0].day, 'Day 1 | 2026-07-28');
  assert.equal((response.hotelAvailability as any)?.emptySearchRoutes, 0);
});

test('option identity includes provider, property, room and rate dimensions', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any);
  const first = service.optionKey({ provider: 'tbo', hotelCode: 'H-1', roomId: 'room-1', rateId: 'rate-1', mealPlan: 'BB' });
  const second = service.optionKey({ provider: 'tbo', hotelCode: 'H-1', roomId: 'room-2', rateId: 'rate-1', mealPlan: 'BB' });
  assert.notEqual(first, second);
});

test('unavailable selection is metadata on the existing availability row, never a placeholder row', async () => {
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

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any);
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels[0].hotelName, 'Current Hotel');
  assert.equal((response.hotels[0] as any).selectionStatus, 'UNAVAILABLE');
  assert.equal((response.hotels[0] as any).selection?.hotelName, 'Old Hotel');
  assert.equal((response.hotels as any[]).some((row) => String(row.hotelName).includes('Previously selected')), false);
  assert.equal((response.hotelAvailability as any)?.searchRunId, 'hotel-run-stable');
  assert.equal((response as any).recommendationGeneration?.version, 'v2');
  assert.equal((response as any).recommendationGeneration?.algorithm, 'TARGET_PRICE_DIVERSITY_BEAM_SEARCH');
});

test('persisted read includes selected stays missing from a partial availability snapshot', async () => {
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

  assert.equal(response.hotels.length, 2);
  assert.deepEqual(response.hotels.map((row: any) => row.itineraryRouteId), [10, 11]);
  assert.equal((response.hotels[1] as any).selectionStatus, 'UNAVAILABLE');
  assert.equal((response.hotels[1] as any).availabilityStatus, 'REVIEW_REQUIRED');
  assert.equal((response.hotelAvailability as any)?.availabilityState, 'PARTIAL');
  assert.equal(response.hotelTabs[0].totalAmount, 250);
});

test('missing legacy selection gets an explicit unavailable label instead of Selected hotel', async () => {
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

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any, {} as any);
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });
  const row: any = response.hotels[0];

  assert.equal(row.hotelName, 'Previously selected hotel unavailable');
  assert.equal(row.category, null);
  assert.equal(row.selectionStatus, 'UNAVAILABLE');
  assert.equal(row.showSelectionWarning, true);
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

  const service = new HotelAvailabilitySnapshotService(prisma, {} as any);
  const response = await service.readPersisted('DVI2026072701', { page: 1, pageSize: 20 });

  assert.equal(response.hotels.length, 1);
  assert.equal(response.hotels.some((row: any) => row.hotelName === 'No Hotels Available'), false);
  assert.equal((response.hotelAvailability as any)?.emptySearchRoutes, 1);
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

test('same hotel with unchanged rate updates the fresh TBO search reference without a change', async () => {
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
  assert.equal(selections[0].selected_rate_option_id, 'rate-1-new-search');
  assert.equal(JSON.parse(selections[0].selected_price_snapshot).searchReference, 'search-reference-new');
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

test('same hotel with a changed rate updates the selection and reports old versus new', async () => {
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
  assert.equal(summary.changes.some((change: any) => change.changeType === 'RATE_CHANGED'), true);
  assert.equal(summary.changes.some((change: any) => change.previous?.hotelName === 'Stable Hotel' && change.current?.hotelName === 'Stable Hotel'), true);
  assert.equal(selections[0].selected_total_price, 125);
});

test('unavailable user selection is replaced by the nearest live rate and reports the replacement', async () => {
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

  assert.equal(summary.changes.some((change: any) => change.changeType === 'SELECTION_REPLACED'), true);
  assert.equal(selections[0].hotel_id, 202);
  assert.equal(selections[0].hotel_code, 'H-2');
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
});

test('reset clears editable selections before rebuilding the live snapshot', async () => {
  const calls: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_room_details: {
      updateMany: async (args: any) => calls.push(['rooms', args]),
    },
    dvi_itinerary_plan_hotel_room_amenities: {
      updateMany: async (args: any) => calls.push(['amenities', args]),
    },
    dvi_itinerary_plan_hotel_details: {
      updateMany: async (args: any) => calls.push(['selections', args]),
      findMany: async (args: any) => {
        calls.push(['verify', args]);
        return [];
      },
    },
  };
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);

  await (service as any).clearEditableHotelSelections(tx, 44);

  const selectionReset = calls.find(([name]) => name === 'selections')?.[1];
  const verification = calls.find(([name]) => name === 'verify')?.[1];
  assert.deepEqual(selectionReset.where, {
    itinerary_plan_id: 44,
    hotel_required: 1,
    status: 1,
    deleted: 0,
  });
  assert.deepEqual(verification.where, selectionReset.where);
  assert.equal(selectionReset.data.deleted, 1);
  assert.equal(selectionReset.data.status, 0);
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
  assert.equal(selections[0].hotel_id, 202);
  assert.equal(rooms.filter((row) => row.deleted === 0 && row.status === 1).length, 1);
});

test('live reconciliation never auto-selects offline inventory', async () => {
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

  assert.equal(createdSelections.length, 0);
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
