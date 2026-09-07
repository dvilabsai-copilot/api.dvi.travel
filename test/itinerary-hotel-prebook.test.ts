import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelPrebookService } from '../src/modules/itineraries/services/itinerary-hotel-prebook.service';

function createService(bookable: any[] = []) {
  const service = new ItineraryHotelPrebookService(null as any, null as any, null as any, null as any);
  service.setCallbacks({
    normalizeToArray: (value: any) => (Array.isArray(value) ? value : value == null ? [] : [value]),
    normalizeToUniqueStrings: (values: any[]) => Array.from(new Set(values.map(String).filter(Boolean))),
    inferMealPlanFromInclusions: () => null,
    getProviderBookableHotelBookings: () => bookable,
  });
  return service;
}

function createTboService() {
  const preBookHotel = async () => ({ Status: 200, NetAmount: 1234.56 });
  const tbo = { preBookHotel } as any;
  const supplementNormalizer = { normalizeSupplements: () => [] } as any;
  const service = new ItineraryHotelPrebookService(null as any, tbo, supplementNormalizer);
  service.setCallbacks({
    normalizeToArray: (value: any) => (Array.isArray(value) ? value : value == null ? [] : [value]),
    normalizeToUniqueStrings: (values: any[]) => Array.from(new Set(values.map(String).filter(Boolean))),
    inferMealPlanFromInclusions: () => null,
    getProviderBookableHotelBookings: () => [],
  });
  return { service, preBookHotel };
}

test('hotel prebook preserves the empty-selection response', async () => {
  const result = await createService().prebookHotels({ itinerary_plan_ID: 99, hotel_bookings: [] } as any);

  assert.equal(result.success, true);
  assert.equal(result.message, 'No supplier-bookable hotels selected for prebook');
  assert.equal(result.totalAmount, 0);
});

test('hotel prebook preserves skipped external-stay counting', async () => {
  const result = await createService([]).prebookHotels({
    itinerary_plan_ID: 99,
    hotel_bookings: [{ provider: 'external', routeId: 1 }],
  } as any);

  assert.equal(result.skippedExternalStayCount, 1);
  assert.deepEqual(result.hotels, []);
});

test('hotel prebook sends a valid TBO selection even when client amount is zero', async () => {
  const { service, preBookHotel } = createTboService();
  let calls = 0;
  const original = preBookHotel;
  (service as any).tboHotelBooking.preBookHotel = async (...args: any[]) => {
    calls += 1;
    return original(...args);
  };

  const result = await service.prebookHotels({
    itinerary_plan_ID: 10234,
    hotel_bookings: [{
      routeId: 11372,
      provider: 'tbo',
      hotelCode: '1114182',
      hotelName: 'Mountain Club Resort',
      bookingCode: '1114182!TB!2!TB!test!TB!N!TB!AFF!',
      roomType: 'Standard Cottage, 1 Bedroom, Fireplace, Garden Area,2 Twin Beds',
      checkInDate: '2026-09-03',
      checkOutDate: '2026-09-04',
      numberOfRooms: 2,
      guestNationality: 'IN',
      netAmount: 0,
      passengers: [],
    }],
  } as any);

  assert.equal(calls, 1);
  assert.equal(result.hotels.length, 1);
  assert.equal(result.finalPrice, 1234.56);
});
