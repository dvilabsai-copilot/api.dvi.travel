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

test('shared hotel inventory unions every package without leaking group selections', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const inventory = service.buildSharedHotelInventory([
    { groupType: 1, itineraryRouteId: 10, date: '2026-08-19', provider: 'tbo', hotelCode: 'H1', hotelName: 'Meadows Residency', pricePerNight: 1000, isBookable: true, isSelectable: true, isSelected: true, selectionStatus: 'SELECTED' },
    { groupType: 2, itineraryRouteId: 10, date: '2026-08-19', provider: 'tbo', hotelCode: 'H2', hotelName: 'Ooty-Fern Hill', pricePerNight: 1200, isBookable: true, isSelectable: true },
    { groupType: 3, itineraryRouteId: 10, date: '2026-08-19', provider: 'tbo', hotelCode: 'H3', hotelName: 'Gem Park-Ooty', pricePerNight: 1400, isBookable: true, isSelectable: true },
    { groupType: 4, itineraryRouteId: 10, date: '2026-08-19', provider: 'tbo', hotelCode: 'H4', hotelName: 'Fortune Resort Sullivan Court', pricePerNight: 1600, isBookable: true, isSelectable: true },
    { groupType: 2, itineraryRouteId: 10, date: '2026-08-19', provider: 'tbo', hotelCode: 'H2', hotelName: 'Ooty-Fern Hill', pricePerNight: 1200, isBookable: true, isSelectable: true },
    { groupType: 4, itineraryRouteId: 10, date: '2026-08-19', provider: 'external', hotelCode: '', hotelName: 'No hotel available', isBookable: false, isSelectable: false },
  ]);

  assert.deepEqual(inventory.map((hotel: any) => hotel.hotelName), [
    'Meadows Residency',
    'Ooty-Fern Hill',
    'Gem Park-Ooty',
    'Fortune Resort Sullivan Court',
  ]);
  assert.ok(inventory.every((hotel: any) => hotel.groupType === 0));
  assert.ok(inventory.every((hotel: any) => hotel.isSelected === false));
  assert.ok(inventory.every((hotel: any) => hotel.selectionStatus === 'AVAILABLE'));
});
