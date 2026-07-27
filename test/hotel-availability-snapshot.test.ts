import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelAvailabilitySnapshotService } from '../src/modules/itineraries/services/hotel-availability-snapshot.service';
import { hotelOptionKey } from '../src/modules/itineraries/utils/hotel-selection-identity.util';

function makePrisma() {
  const persistedRow = {
    id: 1,
    synced_at: new Date('2026-07-27T10:00:00.000Z'),
    full_payload: JSON.stringify({
      groupType: 1,
      itineraryRouteId: 10,
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
