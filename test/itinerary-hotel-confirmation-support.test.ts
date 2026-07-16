import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelConfirmationSupportService } from '../src/modules/itineraries/services/itinerary-hotel-confirmation-support.service';

function createService() {
  const service = new ItineraryHotelConfirmationSupportService(null as any, null as any);
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
