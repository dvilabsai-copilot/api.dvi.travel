import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelConfirmationSupportService } from '../src/modules/itineraries/services/itinerary-hotel-confirmation-support.service';

function createService(prisma: any = {
  dvi_itinerary_plan_details: { findUnique: async () => null },
  dvi_itinerary_plan_hotel_details: { findMany: async () => [] },
}) {
  const service = new ItineraryHotelConfirmationSupportService(prisma, null as any);
  service.setCallbacks({
    mergeConsecutiveSupplierHotelBookings: (rows: any[]) => rows,
    pruneHotelBookingsCoveredByMultiNight: (rows: any[]) => rows,
    getProviderBookableHotelBookings: (rows: any[]) => rows,
    getConfirmHotelGroupType: () => 1,
    uniquePositiveNumbers: (values: any[]) => Array.from(new Set(values.map(Number).filter((value) => value > 0))),
    bookingKey: (provider: string, routeId: number) => `${provider}::${routeId}`,
    assertConsistentMultiNightHotelSelection: () => undefined,
    getAgentWalletBalance: async () => ({ balance: 0 }),
  });
  return service;
}

test('hotel confirmation support preserves the empty draft synchronization result', async () => {
  const result = await createService().syncSelectedHotelDraftRowsForConfirmation(
    { itinerary_plan_ID: 99, hotel_bookings: [] } as any,
    1,
  );

  assert.deepEqual(result, {
    providerHotelBookings: [],
    selectedRouteIds: [],
    externalRouteIds: [],
    groupType: 1,
    skippedExternalStayCount: 0,
  });
});

test('hotel confirmation support preserves provider booking key normalization callback', () => {
  assert.equal(createService().getProviderBookableHotelBookings([]).length, 0);
});

test('confirmation reuses an active AxisRooms hold while preserving the existing VSR provider path', async () => {
  const emptyModel = { findMany: async () => [] };
  const prisma: any = {
    tbo_hotel_booking_confirmation: emptyModel,
    resavenue_hotel_booking_confirmation: emptyModel,
    hobse_hotel_booking_confirmation: emptyModel,
    axisrooms_hotel_booking_confirmation: emptyModel,
    staah_hotel_booking_confirmation: emptyModel,
    dvi_hotel_block_request: {
      findMany: async () => [
        {
          provider: 'AXISROOMS',
          status: 'BLOCKED',
          confirmation_channel: 'AXISROOMS_HOLD',
          confirmation_reference: 'DVI-HOLD-10-12-AX1',
          cutoff_at: new Date(Date.now() + 4 * 60 * 60 * 1000),
          hotel_code: 'AX1',
          selection_ids: '[1002]',
        },
      ],
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [
        { itinerary_plan_hotel_details_ID: 1002, itinerary_route_id: 12 },
      ],
    },
  };
  const service = new ItineraryHotelConfirmationSupportService(prisma, null as any);
  service.setCallbacks({ bookingKey: (provider, routeId) => `${provider}::${routeId}` });

  const result = await service.filterAlreadySuccessfulBookings(10, [
    { __provider: 'tbo', routeId: 11, hotelCode: 'VSR-1' },
    { __provider: 'axisrooms', routeId: 12, hotelCode: 'AX1' },
  ]);

  assert.deepEqual(result.pendingBookings.map((row) => row.__provider), ['tbo']);
  assert.deepEqual(result.alreadyConfirmedResults.map((row) => row.provider), ['axisrooms']);
});
