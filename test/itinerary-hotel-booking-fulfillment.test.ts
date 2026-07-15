import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelBookingFulfillmentService } from '../src/modules/itineraries/services/itinerary-hotel-booking-fulfillment.service';

function createService() {
  const service = new ItineraryHotelBookingFulfillmentService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
  service.setCallbacks({
    bookingKey: (provider: string, routeId: number) => `${provider}::${routeId}`,
    isBookingResultSuccess: () => true,
    filterAlreadySuccessfulBookings: async (_planId: number, bookings: any[]) => ({
      pendingBookings: bookings,
      alreadyConfirmedResults: [],
    }),
    finalizeConfirmationFinancials: async () => undefined,
    getConfirmedItineraryDetails: async () => ({ rows: [] }),
    mergeConsecutiveSupplierHotelBookings: (rows: any[]) => rows,
    pruneHotelBookingsCoveredByMultiNight: (rows: any[]) => rows,
    getProviderBookableHotelBookings: () => [],
  });
  return service;
}

test('hotel booking fulfillment preserves the external-stay-only response', async () => {
  const baseResult = { confirmed_itinerary_plan_ID: 7, message: 'confirmed' };
  const result = await createService().processConfirmationWithTboBookings(
    baseResult,
    { itinerary_plan_ID: 99, hotel_bookings: [{ provider: 'external' }] } as any,
  );

  assert.equal(result.success, true);
  assert.equal(result.confirmedHotelDetails.rows.length, 0);
  assert.equal(result.message, 'confirmed');
});
