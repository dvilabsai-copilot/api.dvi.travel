import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryConfirmationService } from '../src/modules/itineraries/services/itinerary-confirmation.service';

function createService(prisma: any = {}) {
  return new ItineraryConfirmationService(prisma, null as any, null as any);
}

test('quotation confirmation preserves missing-plan validation', async () => {
  await assert.rejects(
    () => createService({ dvi_itinerary_plan_details: { findUnique: async () => null } }).confirmQuotation({ itinerary_plan_ID: 99 } as any),
    /Itinerary plan not found/,
  );
});

test('confirmation preserves provider-bookable hotel filtering', () => {
  const service = createService();
  const bookings = [
    { provider: 'staah', hotelCode: 'H-1', netAmount: 100 },
    { provider: 'external', hotelCode: 'H-2', netAmount: 100 },
    { provider: 'tbo', hotelCode: 'H-3', bookingCode: '!TB!fresh', netAmount: 100 },
  ];

  assert.deepEqual(service.getProviderBookableHotelBookings(bookings), [bookings[0], bookings[2]]);
});

test('confirmation preserves booking-key normalization', () => {
  assert.equal(createService().bookingKey(' STAah ', 7), 'staah::7');
});
