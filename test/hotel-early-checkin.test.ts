import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerarySelectionWorkflowService } from '../src/modules/itineraries/services/itinerary-selection-workflow.service';
import { ItineraryRouteTimingService } from '../src/modules/itineraries/services/itinerary-route-timing.service';
import { ItineraryConfirmedPlanCopyService } from '../src/modules/itineraries/services/itinerary-confirmed-plan-copy.service';

const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);

function createSelectionService(overrides: Record<string, any> = {}) {
  const prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({
        itinerary_quote_ID: 'Q-1',
        itinerary_preference: 1,
        trip_start_date_and_time: new Date('2026-06-15T05:30:00.000Z'),
      }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({
        itinerary_route_date: new Date('2026-06-15T00:00:00.000Z'),
        next_visiting_location: 'Munnar',
      }),
    },
    dvi_itinerary_plan_hotel_details: {
      findFirst: async () => null,
      findMany: async () => [],
      update: async ({ data }: any) => ({
        itinerary_plan_hotel_details_ID: 12,
        hotel_id: data.hotel_id,
      }),
      findUnique: async () => ({ hotel_id: 22, group_type: 1 }),
      create: async ({ data }: any) => ({
        itinerary_plan_hotel_details_ID: 12,
        hotel_id: data.hotel_id,
      }),
    },
    dvi_itinerary_plan_hotel_room_details: {
      findFirst: async () => null,
      create: async () => ({}),
    },
    ...overrides,
  };

  return {
    service: new ItinerarySelectionWorkflowService(
      prisma as any,
      null as any,
      null as any,
      { clearCacheForQuote: () => undefined } as any,
    ),
    prisma,
  };
}

test('selecting a hotel ignores the previous-day marker and stores structured metadata', async () => {
  const createCalls: any[] = [];
  let markerLookup = true;
  const { service, prisma } = createSelectionService();
  prisma.dvi_itinerary_plan_hotel_details.findFirst = async () => {
    if (markerLookup) {
      markerLookup = false;
      return {
        itinerary_route_date: new Date('2026-06-14T00:00:00.000Z'),
        hotel_required: 2,
        hotel_id: 0,
      };
    }
    return null;
  };
  prisma.dvi_itinerary_plan_hotel_details.create = async ({ data }: any) => {
    createCalls.push(data);
    return { itinerary_plan_hotel_details_ID: 12, hotel_id: data.hotel_id };
  };

  await service.selectHotel({ planId: 1, routeId: 10, hotelId: 22, roomTypeId: 3, groupType: 1 });

  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].hotel_required, 1);
  assert.equal(dateOnly(createCalls[0].hotel_check_in_date), '2026-06-14');
  assert.equal(createCalls[0].actual_guest_arrival_at.toISOString(), '2026-06-15T05:30:00.000Z');
  assert.equal(dateOnly(createCalls[0].hotel_check_out_date), '2026-06-16');
  assert.equal(createCalls[0].early_checkin, 1);
  assert.equal(createCalls[0].early_checkin_extra_payment_applicable, 1);
  assert.equal(createCalls[0].early_checkin_payment_status, 'EXTRA_PAYMENT_APPLICABLE');
});

test('early-check-in date arithmetic crosses month and year boundaries', () => {
  const monthBoundary = new Date('2026-07-01T00:00:00.000Z');
  monthBoundary.setUTCDate(monthBoundary.getUTCDate() - 1);
  assert.equal(dateOnly(monthBoundary), '2026-06-30');

  const yearBoundary = new Date('2027-01-01T00:00:00.000Z');
  yearBoundary.setUTCDate(yearBoundary.getUTCDate() - 1);
  assert.equal(dateOnly(yearBoundary), '2026-12-31');
});

function createTimingHarness(firstRouteDate: string, existingMarkers: any[]) {
  const markerCreates: any[] = [];
  const hotelUpdates: any[] = [];
  const deletes: any[] = [];
  const tx: any = {
    dvi_itinerary_route_details: {
      findFirst: async (args: any) => {
        if (args.select?.itinerary_route_ID) {
          return {
            itinerary_route_ID: 10,
            itinerary_route_date: new Date(`${firstRouteDate}T00:00:00.000Z`),
            no_of_days: 1,
            next_visiting_location: 'Munnar',
            location_name: 'Airport',
            route_start_time: '05:30:00',
            route_end_time: '18:00:00',
          };
        }
        return {
          itinerary_route_ID: 10,
          itinerary_route_date: new Date(`${firstRouteDate}T00:00:00.000Z`),
          no_of_days: 1,
          next_visiting_location: 'Munnar',
          location_name: 'Airport',
          route_start_time: '05:30:00',
          route_end_time: '18:00:00',
        };
      },
      update: async () => ({}),
    },
    dvi_itinerary_plan_details: {
      findFirst: async () => ({ itinerary_preference: 1 }),
      updateMany: async () => ({}),
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => existingMarkers,
      createMany: async ({ data }: any) => {
        markerCreates.push(...data);
        return {};
      },
      deleteMany: async (args: any) => {
        deletes.push(args);
        return {};
      },
      updateMany: async (args: any) => {
        hotelUpdates.push(args);
        return {};
      },
    },
  };
  const hotspotEngine: any = {
    rebuildRouteHotspots: async () => ({ rebuildSummary: {}, warnings: [] }),
    rebuildParkingCharges: async () => undefined,
  };
  const prisma: any = {
    $transaction: async (callback: (value: any) => Promise<any>) => callback(tx),
  };
  const service = new ItineraryRouteTimingService(prisma, hotspotEngine);
  service.setCallbacks({ forceRebuildVehiclePricingAfterHotspotChange: async () => undefined });

  return { service, markerCreates, hotelUpdates, deletes };
}

test('route timing persists previous-night metadata and supports month/year boundaries', async () => {
  for (const [arrivalDate, expectedCheckIn] of [
    ['2026-07-01', '2026-06-30'],
    ['2027-01-01', '2026-12-31'],
  ]) {
    const harness = createTimingHarness(arrivalDate, []);
    await harness.service.updateRouteTimes(1, 10, '05:30:00', '18:00:00', true, true);
    assert.equal(harness.markerCreates.length, 4);
    assert.equal(dateOnly(harness.markerCreates[0].itinerary_route_date), expectedCheckIn);
    assert.equal(harness.hotelUpdates[0].data.early_checkin, 1);
    assert.equal(dateOnly(harness.hotelUpdates[0].data.hotel_check_out_date),
      arrivalDate === '2026-07-01' ? '2026-07-02' : '2027-01-02');
  }
});

test('changing Day 1 to a late time clears structured metadata and markers', async () => {
  const harness = createTimingHarness('2026-06-15', [
    { group_type: 1, itinerary_route_date: new Date('2026-06-14T00:00:00.000Z') },
  ]);

  await harness.service.updateRouteTimes(1, 10, '10:00:00', '18:00:00', true, true);

  assert.equal(harness.deletes.length, 1);
  assert.equal(harness.hotelUpdates[0].data.early_checkin, 0);
  assert.equal(harness.hotelUpdates[0].data.hotel_check_in_date, null);
  assert.equal(harness.hotelUpdates[0].data.actual_guest_arrival_at, null);
  assert.equal(harness.hotelUpdates[0].data.hotel_check_out_date, null);
});

test('confirmed-plan copy excludes markers and carries structured metadata', async () => {
  const hotelWhereCalls: any[] = [];
  const confirmedRows: any[] = [];
  const genericModel = {
    findMany: async () => [],
    create: async () => ({}),
  };
  const hotelModel = {
    findMany: async ({ where }: any) => {
      hotelWhereCalls.push(where);
      return [{
        itinerary_plan_hotel_details_ID: 12,
        group_type: 1,
        itinerary_plan_id: 1,
        itinerary_route_id: 10,
        itinerary_route_date: new Date('2026-06-15T00:00:00.000Z'),
        hotel_required: 1,
        hotel_id: 22,
        hotel_check_in_date: new Date('2026-06-14T00:00:00.000Z'),
        actual_guest_arrival_at: new Date('2026-06-15T05:30:00.000Z'),
        hotel_check_out_date: new Date('2026-06-16T00:00:00.000Z'),
        early_checkin: 1,
        early_checkin_extra_payment_applicable: 1,
        early_checkin_payment_status: 'EXTRA_PAYMENT_APPLICABLE',
        early_checkin_note: 'Block from previous night.',
      }];
    },
  };
  const confirmedHotelModel = {
    create: async ({ data }: any) => {
      confirmedRows.push(data);
      return { confirmed_itinerary_plan_hotel_details_ID: 44 };
    },
  };
  const tx: any = new Proxy({}, {
    get: (_target, property: string) => {
      if (property === 'dvi_itinerary_plan_hotel_details') return hotelModel;
      if (property === 'dvi_confirmed_itinerary_plan_hotel_details') return confirmedHotelModel;
      return genericModel;
    },
  });

  await new ItineraryConfirmedPlanCopyService().copyDraftToConfirmed(tx, 1, 2, 1);

  assert.deepEqual(hotelWhereCalls[0].hotel_required, { not: 2 });
  assert.equal(confirmedRows.length, 1);
  assert.equal(dateOnly(confirmedRows[0].hotel_check_in_date), '2026-06-14');
  assert.equal(confirmedRows[0].early_checkin, 1);
  assert.equal(confirmedRows[0].early_checkin_extra_payment_applicable, 1);
  assert.equal(confirmedRows[0].early_checkin_payment_status, 'EXTRA_PAYMENT_APPLICABLE');
});
