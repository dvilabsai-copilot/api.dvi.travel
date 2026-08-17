import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';

test('availability panes keep every eligible hotel in the matching recommendation group', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const route = {
    itinerary_route_ID: 10,
    itinerary_route_date: '2026-08-19',
    next_visiting_location: 'Ooty',
  };
  const hotelsByRoute = new Map([[10, [
    { provider: 'tbo', hotelCode: 'LOW', hotelName: 'Low', category: '4*', price: 1000 },
    { provider: 'tbo', hotelCode: 'MID', hotelName: 'Mid', category: '4*', price: 1200 },
    { provider: 'tbo', hotelCode: 'HIGH', hotelName: 'High', category: '4*', price: 1600 },
  ]]]);

  const packages = service.generateCategoryAvailabilityPackages(hotelsByRoute, [route], [4]);

  assert.deepEqual(packages.map((pkg: any) => pkg.hotels.map((hotel: any) => hotel.hotelCode)), [
    ['LOW', 'MID', 'HIGH'],
    ['MID', 'LOW', 'HIGH'],
    ['HIGH', 'LOW', 'MID'],
    [],
  ]);
});
