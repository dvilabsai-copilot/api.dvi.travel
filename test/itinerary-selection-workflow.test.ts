import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerarySelectionWorkflowService } from '../src/modules/itineraries/services/itinerary-selection-workflow.service';

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

test('live multi-night selection must use the current route rate reference and nightly amount', async () => {
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

  await (service as any).validateLiveSelectionAgainstSnapshot(
    {
      planId: 10062,
      routeId: 10209,
      provider: 'axisrooms',
      hotelId: 95,
      canonicalHotelId: 95,
      hotelCode: '95',
      // This is the parent stay's 12-Aug reference, not route 10209's
      // 13-Aug reference. The request also carries the current route's
      // booking/search reference, which is the identity persisted by the UI.
      rateOptionId: 'axisrooms|95|2026-08-12|AX-95-20260812',
      bookingCode: 'AX-95-20260813',
      searchReference: 'AX-95-20260813',
      roomType: 'Valley View Double',
      hotelName: 'CLOUDS VALLEY',
      totalPrice: 3410,
    },
    { itinerary_plan_ID: 10062 },
    'DVI202607282',
  );

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
    ),
    /stale or unavailable/,
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
