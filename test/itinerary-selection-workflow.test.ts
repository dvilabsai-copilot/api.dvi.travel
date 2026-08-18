import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerarySelectionWorkflowService } from '../src/modules/itineraries/services/itinerary-selection-workflow.service';
import {
  normalizeSupplierRateIdentity,
  supplierRateIdentityMatches,
} from '../src/modules/itineraries/utils/hotel-selection-identity.util';

function createService(prisma: any = {}) {
  return new ItinerarySelectionWorkflowService(
    prisma,
    null as any,
    null as any,
    null as any,
  );
}

test('hotel availability preserves the empty result when the route is absent', async () => {
  const service = createService({
    dvi_itinerary_route_details: { findFirst: async () => null },
  });

  assert.deepEqual(await service.getAvailableHotels(99), []);
});

test('AxisRooms supplier references normalize canonical meal plans before persistence', () => {
  const cp = normalizeSupplierRateIdentity({
    provider: 'axisrooms',
    mealPlan: '-',
    rateOptionId: 'axisrooms:232:605:CP_PLAN:2026-08-12',
    bookingCode: 'AX-232:605:CP_PLAN:2026-08-12',
  });
  assert.equal(cp.mealPlan, 'CP');
  assert.equal(cp.mealPlanCode, 'CP');
  const mappedProperty = normalizeSupplierRateIdentity({
    ...cp,
    canonicalHotelId: 232,
    hotelId: 232,
    hotelCode: '435',
    providerHotelCode: '435',
  });
  assert.equal(mappedProperty.canonicalHotelId, 232);
  assert.equal(mappedProperty.hotelId, 232);
  assert.equal(mappedProperty.hotelCode, '435');
  assert.equal(mappedProperty.providerHotelCode, '435');
  assert.equal(normalizeSupplierRateIdentity({
    provider: 'axisrooms',
    bookingCode: 'AX-232:605:MAP_PLAN:2026-08-12',
  }).mealPlan, 'MAP');
});

test('TBO identity preserves a real booking code while accepting a fresh session for the same commercial room', () => {
  const current = '1114182!TB!1!TB!current-search!TB!N!TB!AFF!';
  const normalized = normalizeSupplierRateIdentity({
    provider: 'tbo', hotelCode: '1114182',
    optionKey: 'tbo|1114182|cp|2026-08-12',
    bookingCode: 'tbo|1114182|cp|2026-08-12',
    searchReference: current,
  });
  assert.equal(normalized.rateOptionId, current);
  assert.equal(normalized.bookingCode, current);
  assert.equal(normalized.searchReference, current);
  assert.equal(supplierRateIdentityMatches(normalized, { ...normalized }), true);
  const stale = '1114182!TB!1!TB!stale-search!TB!N!TB!AFF!';
  assert.equal(supplierRateIdentityMatches(normalized, {
    ...normalized, rateOptionId: stale, bookingCode: stale, searchReference: stale,
  }), true);
  const differentCommercialRoom = '1114182!TB!2!TB!stale-room!TB!N!TB!AFF!';
  assert.equal(supplierRateIdentityMatches(normalized, {
    ...normalized, rateOptionId: differentCommercialRoom, bookingCode: differentCommercialRoom, searchReference: differentCommercialRoom,
  }), false);
});

test('manual hotel persistence rejects a missing target group instead of defaulting to Group 1', async () => {
  const service = createService();

  await assert.rejects(
    () => service.selectHotel({
      planId: 100,
      routeId: 10,
      hotelId: 22,
      roomTypeId: 3,
      provider: 'offline',
      rateOptionId: 'offline:hotel-b',
    }),
    /valid target groupType between 1 and 4/,
  );
});

test('live multi-night selection rejects a stale primary rate reference even when another alias is current', async () => {
  const syncedAt = new Date('2026-07-31T15:25:00.000Z');
  const currentRoutePayload = {
    itineraryRouteId: 10209,
    provider: 'axisrooms',
    hotelCode: '95',
    hotelId: 95,
    hotelName: 'CLOUDS VALLEY',
    roomType: 'Valley View Double',
    mealPlan: '-',
    bookingCode: 'AX-95-20260813',
    searchReference: 'AX-95-20260813',
    optionKey: 'axisrooms|95|2026-08-13|AX-95-20260813',
    totalHotelCost: 3410,
  };
  const prisma: any = {
    dvi_itinerary_hotel_search_cache: {
      findFirst: async () => ({ synced_at: syncedAt }),
      findMany: async () => [{ full_payload: JSON.stringify(currentRoutePayload) }],
    },
  };
  const service = createService(prisma);

  await assert.rejects(
    () => (service as any).validateLiveSelectionAgainstSnapshot(
      {
        planId: 10062,
        routeId: 10209,
        provider: 'axisrooms',
        hotelId: 95,
        canonicalHotelId: 95,
        hotelCode: '95',
        rateOptionId: 'axisrooms|95|2026-08-12|AX-95-20260812',
        bookingCode: 'AX-95-20260812',
        searchReference: 'AX-95-20260812',
        roomType: 'Valley View Double',
        hotelName: 'CLOUDS VALLEY',
        totalPrice: 3410,
      },
      { itinerary_plan_ID: 10062 },
      'DVI202607282',
      { itinerary_route_date: new Date('2026-08-13T00:00:00.000Z') },
    ),
    (error: any) => error?.response?.code === 'HOTEL_RATE_ROUTE_DATE_MISMATCH',
  );
});

test('AxisRooms accepts a current ARI database rate when the snapshot has no matching row', async () => {
  const prisma: any = {
    dvi_itinerary_hotel_search_cache: {
      findFirst: async () => ({ synced_at: new Date('2026-07-31T15:25:00.000Z') }),
      findMany: async () => [],
    },
    dvi_hotel_room_availability: {
      findFirst: async () => ({ free: 2 }),
    },
    dvi_hotel_room_rate_plan: {
      findFirst: async () => ({ rateplan_id: 'CP_PLAN' }),
    },
    dvi_hotel_occupancy_rate: {
      findMany: async () => [{ occupancy_rates: { DOUBLE: 6950 } }],
    },
  };
  const service = createService(prisma);

  await (service as any).validateLiveSelectionAgainstSnapshot(
    {
      planId: 10062,
      routeId: 10218,
      groupType: 1,
      provider: 'axisrooms',
      hotelId: 561,
      canonicalHotelId: 561,
      hotelCode: '561',
      roomId: 1706,
      rateOptionId: 'axisrooms:561:1706:CP_PLAN:2026-08-13',
      bookingCode: 'AX-561-20260813',
      searchReference: 'AX-561-20260813',
      roomType: 'Executive Room',
      hotelName: 'Fort Munnar',
      totalPrice: 6950,
      roomCount: 2,
    },
    { itinerary_plan_ID: 10062 },
    'DVI202607282',
    { itinerary_route_date: new Date('2026-08-13T00:00:00.000Z') },
  );
});

test('live selection tolerates a rebuilt route id when the latest snapshot has the same stay date', async () => {
  const currentSnapshotPayload = {
    itineraryRouteId: 10208,
    provider: 'axisrooms',
    hotelCode: '95',
    hotelId: 95,
    hotelName: 'CLOUDS VALLEY',
    roomType: 'Valley View Double',
    mealPlan: 'Breakfast only',
    bookingCode: 'AX-95-20260812',
    searchReference: 'AX-95-20260812',
    rateOptionId: 'axisrooms:95:231:CP_PLAN:2026-08-12',
    totalHotelCost: 3410,
    date: '2026-08-12',
    groupType: 1,
  };
  const prisma: any = {
    dvi_itinerary_hotel_search_cache: {
      findFirst: async () => ({ synced_at: new Date('2026-07-31T17:35:22.000Z') }),
      findMany: async (args: any) => args.where.route_id
        ? []
        : [{ full_payload: JSON.stringify(currentSnapshotPayload) }],
    },
  };
  const service = createService(prisma);

  await (service as any).validateLiveSelectionAgainstSnapshot(
    {
      planId: 10062,
      routeId: 10214,
      groupType: 1,
      provider: 'axisrooms',
      hotelId: 95,
      canonicalHotelId: 95,
      hotelCode: '95',
      rateOptionId: 'axisrooms:95:231:CP_PLAN:2026-08-12',
      bookingCode: 'AX-95-20260812',
      searchReference: 'AX-95-20260812',
      roomType: 'Valley View Double',
      hotelName: 'CLOUDS VALLEY',
      totalPrice: 3410,
    },
    { itinerary_plan_ID: 10062 },
    'DVI202607282',
    { itinerary_route_date: new Date('2026-08-12T00:00:00.000Z') },
  );
});

test('live selection validates the selected nested rate option before its parent hotel row', async () => {
  const tboBookingCode = 'TBO-123!TB!1!TB!selected-search!TB!N!TB!AFF!';
  const selectedRate = {
    provider: 'tbo',
    hotelCode: 'TBO-123',
    hotelId: 'TBO-123',
    hotelName: 'Seven Springs Resort',
    roomType: 'Honey Moon Cottage with Jacuzzi',
    mealPlan: 'CP',
    rateOptionId: tboBookingCode,
    optionKey: 'tbo|TBO-123|CP|2026-08-11',
    bookingCode: tboBookingCode,
    searchReference: tboBookingCode,
    totalPrice: 30149,
  };
  const parentHotelRow = {
    ...selectedRate,
    // This is the parent row amount, not the selected room/rate amount.
    totalPrice: 9999,
    rateOptions: [selectedRate],
  };
  const prisma: any = {
    dvi_itinerary_hotel_search_cache: {
      findFirst: async () => ({ synced_at: new Date('2026-08-04T08:00:00.000Z') }),
      findMany: async () => [{ full_payload: JSON.stringify(parentHotelRow) }],
    },
  };
  const service = createService(prisma);

  await (service as any).validateLiveSelectionAgainstSnapshot(
    {
      planId: 10060,
      routeId: 10203,
      provider: 'tbo',
      hotelId: 'TBO-123',
      canonicalHotelId: 'TBO-123',
      hotelCode: 'TBO-123',
      hotelName: 'Seven Springs Resort',
      roomType: 'Honey Moon Cottage with Jacuzzi',
      mealPlanCode: 'CP',
      rateOptionId: tboBookingCode,
      optionKey: 'tbo|TBO-123|CP|2026-08-11',
      bookingCode: tboBookingCode,
      searchReference: tboBookingCode,
      totalPrice: 30149,
    },
    { itinerary_plan_ID: 10060 },
    'DVI202607280',
    { itinerary_route_date: new Date('2026-08-11T00:00:00.000Z') },
  );

  await assert.rejects(
    () => (service as any).validateLiveSelectionAgainstSnapshot(
      {
        planId: 10060,
        routeId: 10203,
        provider: 'tbo',
        hotelId: 'TBO-123',
        canonicalHotelId: 'TBO-123',
        hotelCode: 'TBO-123',
        hotelName: 'Seven Springs Resort',
        roomType: 'Honey Moon Cottage with Jacuzzi',
        mealPlanCode: 'CP',
        rateOptionId: tboBookingCode,
        optionKey: 'tbo|TBO-123|CP|2026-08-11',
        bookingCode: tboBookingCode,
        searchReference: tboBookingCode,
        totalPrice: 30150,
      },
      { itinerary_plan_ID: 10060 },
      'DVI202607280',
      { itinerary_route_date: new Date('2026-08-11T00:00:00.000Z') },
    ),
    /selected hotel price changed/,
  );
});

test('live selection ignores same-hotel rates belonging to another recommendation group', async () => {
  const bookingCode = '1130403!TB!1!TB!same-commercial-room!TB!N!TB!AFF!';
  const groupThreeRow = {
    provider: 'tbo', hotelCode: '1130403', hotelName: 'Ela Ecoland Nature Retreat',
    groupType: 3, itineraryRouteId: 10719, bookingCode, searchReference: bookingCode,
    rateOptionId: bookingCode, totalPrice: 9999,
  };
  const groupFourRow = {
    provider: 'tbo', hotelCode: '1130403', hotelName: 'Ela Ecoland Nature Retreat',
    groupType: 4, itineraryRouteId: 10719, bookingCode, searchReference: bookingCode,
    rateOptionId: bookingCode, totalPrice: 2056.89,
  };
  const service = createService({
    dvi_itinerary_hotel_search_cache: {
      findFirst: async () => ({ synced_at: new Date('2026-08-18T00:00:00.000Z') }),
      findMany: async () => [
        { full_payload: JSON.stringify(groupThreeRow) },
        { full_payload: JSON.stringify(groupFourRow) },
      ],
    },
  });

  await (service as any).validateLiveSelectionAgainstSnapshot(
    {
      planId: 10124, routeId: 10719, groupType: 4, provider: 'tbo',
      hotelCode: '1130403', hotelName: 'Ela Ecoland Nature Retreat',
      bookingCode, searchReference: bookingCode, rateOptionId: bookingCode,
      totalPrice: 2056.89,
    },
    { itinerary_plan_ID: 10124 },
    'DVI20260847',
    { itinerary_route_date: new Date('2026-08-22T00:00:00.000Z') },
  );
});

test('current TBO supplier booking identity passes while stale and different hotels fail', async () => {
  const syncedAt = new Date('2026-08-11T14:02:55.000Z');
  const currentBookingCode = '1114182!TB!1!TB!current-search!TB!N!TB!AFF!';
  const snapshot = {
    provider: 'tbo', hotelCode: '1114182', hotelName: 'Mountain Club Resort',
    roomType: 'Family Double Room,2 Queen Beds', mealPlan: 'CP',
    optionKey: 'tbo|1114182|||||cp|2026-08-12|2026-08-13',
    searchReference: currentBookingCode,
    rateOptions: [{
      provider: 'tbo', hotelCode: '1114182', hotelName: 'Mountain Club Resort',
      roomType: 'Family Double Room,2 Queen Beds', mealPlan: 'CP',
      searchReference: currentBookingCode, pricePerNight: 14541.83, totalPrice: 14541.83,
    }],
  };
  const service = createService({
    dvi_itinerary_hotel_search_cache: {
      findFirst: async () => ({ synced_at: syncedAt }),
      findMany: async () => [{ full_payload: JSON.stringify(snapshot) }],
    },
  });
  const currentSelection = {
    planId: 10040, routeId: 10145, provider: 'tbo', hotelCode: '1114182',
    hotelName: 'Mountain Club Resort', roomType: 'Family Double Room,2 Queen Beds',
    rateOptionId: currentBookingCode, optionKey: snapshot.optionKey,
    bookingCode: currentBookingCode, searchReference: currentBookingCode,
    totalPrice: 14541.83,
  };
  const route = { itinerary_route_date: new Date('2026-08-12T00:00:00.000Z') };
  await (service as any).validateLiveSelectionAgainstSnapshot(
    currentSelection, { itinerary_plan_ID: 10040 }, 'DVI2026082', route,
  );
  const stale = '1114182!TB!2!TB!old-search!TB!N!TB!AFF!';
  await assert.rejects(
    () => (service as any).validateLiveSelectionAgainstSnapshot(
      { ...currentSelection, rateOptionId: stale, bookingCode: stale, searchReference: stale },
      { itinerary_plan_ID: 10040 }, 'DVI2026082', route,
    ),
    /stale or unavailable/,
  );
  await assert.rejects(
    () => (service as any).validateLiveSelectionAgainstSnapshot(
      { ...currentSelection, hotelCode: '9999999' },
      { itinerary_plan_ID: 10040 }, 'DVI2026082', route,
    ),
    /stale or unavailable/,
  );
});

test('bulk hotel persistence forwards provider hotel code into atomic validation', async () => {
  let forwarded: any;
  const service = createService({
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'DVI2026082' }) },
    $transaction: async (callback: any) => callback({}),
  });
  (service as any).selectHotel = async (data: any) => { forwarded = data; };
  (service as any).hotelDetailsTboService = { clearCacheForQuote: () => undefined };
  await service.bulkSaveHotels(10040, [{
    routeId: 10145, groupType: 1, provider: 'tbo', hotelCode: '1114182',
    rateOptionId: '1114182!TB!1!TB!current-search!TB!N!TB!AFF!',
  }], 1, true, true);
  assert.equal(forwarded.hotelCode, '1114182');
});

test('bulk hotel persistence rolls back every route when one route fails', async () => {
  const committed: number[] = [];
  const staged: number[] = [];
  const prisma: any = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'Q-1' }) },
    $transaction: async (callback: any) => {
      const tx = { $queryRawUnsafe: async (sql: string) => sql.includes('GET_LOCK') ? [{ acquired: 1 }] : [{ released: 1 }] };
      try {
        await callback(tx);
        committed.push(...staged);
      } catch (error) {
        staged.length = 0;
        throw error;
      }
    },
  };
  const service = createService(prisma);
  (service as any).selectHotel = async (data: any) => {
    staged.push(Number(data.routeId));
    if (Number(data.routeId) === 103) throw new Error('simulated route 103 persistence failure');
    return { success: true };
  };

  await assert.rejects(
    () => service.bulkSaveHotels(77, [
      { routeId: 101, hotelId: 1, groupType: 1 },
      { routeId: 102, hotelId: 1, groupType: 1 },
      { routeId: 103, hotelId: 1, groupType: 1 },
    ], 1, false, true),
    /simulated route 103 persistence failure/,
  );
  assert.deepEqual(committed, []);
  assert.deepEqual(staged, []);
});

test('hotel selection lock fails closed when DATABASE_URL is unavailable', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const service = createService({} as any);
    await assert.rejects(
      () => (service as any).withHotelSelectionLock(77, 1, async () => 'unlocked'),
      (error: any) => error?.response?.code === 'HOTEL_SELECTION_LOCK_UNAVAILABLE',
    );
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test('vehicle slab selection preserves required-field validation', async () => {
  await assert.rejects(
    () => createService().selectVehicleSlab({ planId: 0, vehicleTypeId: 0 }),
    /planId, vehicleTypeId, vendorEligibleId and timeLimitId are required/,
  );
});

test('vehicle slab auto-selection preserves plan validation', async () => {
  await assert.rejects(
    () => createService().autoSelectVehicleSlabs({ planId: 0 }),
    /planId is required/,
  );
});

test('vehicle vendor radio selection is persisted as the manual selection', async () => {
  const selectedEligible = {
    itinerary_plan_vendor_eligible_ID: 42,
    itinerary_plan_id: 9001,
    vehicle_type_id: 7,
    vendor_id: 11,
    vendor_branch_id: 12,
    vendor_vehicle_type_id: 7,
    vehicle_id: 13,
    vehicle_grand_total: 1000,
    status: 1,
    deleted: 0,
  };

  const eligibleUpdates: any[] = [];
  let persistedSelection: any;

  const prisma: any = {
    dvi_itinerary_plan_vendor_eligible_list: {
      findFirst: async () => selectedEligible,
      findMany: async () => [selectedEligible],
    },
    dvi_itinerary_plan_vehicle_details: {
      findMany: async () => [{ vehicle_count: 1 }],
    },
    dvi_vendor_details: {
      findMany: async () => [{ vendor_id: 11 }],
    },
    dvi_vendor_branches: {
      findMany: async () => [{ vendor_branch_id: 12, vendor_id: 11 }],
    },
    dvi_vehicle: {
      findMany: async () => [
        {
          vehicle_id: 13,
          vendor_id: 11,
          vendor_branch_id: 12,
          vehicle_type_id: 7,
        },
      ],
    },
    dvi_vendor_vehicle_types: {
      findMany: async () => [{ vendor_vehicle_type_ID: 7, vendor_id: 11 }],
    },
    $transaction: async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        dvi_itinerary_plan_vendor_eligible_list: {
          updateMany: async (args: any) => {
            eligibleUpdates.push(args);
            return { count: 1 };
          },
        },
        dvi_itinerary_plan_vehicle_vendor_selection: {
          upsert: async (args: any) => {
            persistedSelection = args;
            return args.create;
          },
        },
      }),
  };

  const service = createService(prisma);
  (service as any).getVehicleRateAvailabilityForEligible = async () => ({
    available: true,
  });

  const result = await service.selectVehicleVendor({
    planId: 9001,
    vehicleTypeId: 7,
    vendorEligibleId: 42,
  });

  assert.equal(result.success, true);
  assert.equal(result.selectedVendorEligibleId, 42);
  assert.deepEqual(result.assignedVendorEligibleIds, [42]);
  assert.equal(persistedSelection.create.selected_vendor_eligible_id, 42);
  assert.equal(persistedSelection.create.selection_source, 'manual');
  assert.equal(eligibleUpdates.length, 2);
  assert.equal(eligibleUpdates[0].data.itineary_plan_assigned_status, 0);
  assert.equal(eligibleUpdates[1].data.itineary_plan_assigned_status, 1);
});
