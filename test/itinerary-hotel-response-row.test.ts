import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelResponseRowService } from '../src/modules/itineraries/services/itinerary-hotel-response-row.service';

const callbacks = {
  enrichHotelWithMasterMargin: (hotel: any) => ({ ...hotel, hotel_margin: 10 }),
  applyInvisibleHotelMargin: (amount: number, hotel: any) => Number((amount * (1 + Number(hotel.hotel_margin || 0) / 100)).toFixed(2)),
  getHotelMarginPercentage: (hotel: any) => Number(hotel.hotel_margin || 0),
  parseStaahSearchReference: () => ({ propertyId: '1', roomId: '2', rateId: '3' }),
  getGroupTypeFromPrice: () => 2,
};

test('projects a supplier hotel row with bookability, margin and distance fields', () => {
  const service = new ItineraryHotelResponseRowService();
  const row = service.buildSupplierRow({
    route: { itinerary_route_ID: 7, itinerary_route_date: '2026-07-20', next_visiting_location: 'Kochi', location_id: 9 },
    routeIndex: 0,
    groupType: 1,
    hotel: { hotelCode: '123', hotelName: 'Supplier Hotel', price: 100, provider: 'tbo', searchReference: '!TB!123', rating: '4', roomType: 'Deluxe' },
    detailsMap: new Map([['7-123-1', 88]]),
    voucherStatusMap: new Map([[88, true]]),
    routeDestinationCoordsByLocationId: new Map([[9, { lat: 10, lon: 76 }]]),
    hotelCoordsByProviderCode: new Map([['tbo|123', { lat: 10.01, lon: 76.01 }]]),
    callbacks,
  });

  assert.equal(row.hotelName, 'Supplier Hotel');
  assert.equal(row.isBookable, true);
  assert.equal(row.provider, 'tbo');
  assert.equal(row.totalHotelCost, 110);
  assert.equal(row.voucherCancelled, true);
  assert.match(String(row.hotelDistance), /KM$/);
});

test('projects restricted rows as non-bookable while preserving restriction metadata', () => {
  const service = new ItineraryHotelResponseRowService();
  const row = service.buildRestrictedRow({
    route: { itinerary_route_ID: 8, itinerary_route_date: '2026-07-20', next_visiting_location: 'Kochi', location_id: 9 },
    routeIndex: 1,
    hotel: { hotelCode: '456', hotelName: 'Restricted Hotel', price: 150, provider: 'staah', availabilityMessage: 'CTA active', availableAgainFrom: '2026-07-23' },
    allPrices: [100, 150, 200],
    routeDestinationCoordsByLocationId: new Map(),
    hotelCoordsByProviderCode: new Map(),
    callbacks,
  });

  assert.equal(row.groupType, 2);
  assert.equal(row.isBookable, false);
  assert.equal(row.provider, 'staah');
  assert.equal(row.availabilityStatus, 'NOT_BOOKABLE');
  assert.equal(row.availableAgainFrom, '2026-07-23');
});
