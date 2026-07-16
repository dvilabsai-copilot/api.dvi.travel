import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelPricePackageService } from '../src/modules/itineraries/services/itinerary-hotel-price-package.service';

const route = (id: number) => ({ itinerary_route_ID: id });
const hotel = (code: string, price: number) =>
  ({ hotelCode: code, hotelName: `Hotel ${code}`, price, roomType: 'Room', mealPlan: 'Breakfast' }) as any;

test('assigns one available hotel to every price tier', () => {
  const service = new ItineraryHotelPricePackageService();
  const packages = service.generate(new Map([[1, [hotel('one', 100)]]]), [route(1)]);

  assert.equal(packages.length, 4);
  assert.deepEqual(packages.map((pkg) => pkg.groupType), [1, 2, 3, 4]);
  assert.deepEqual(packages.map((pkg) => pkg.hotels[0].hotelCode), ['one', 'one', 'one', 'one']);
  assert.deepEqual(packages.map((pkg) => pkg.hotels[0].routeId), [1, 1, 1, 1]);
});

test('sorts multiple hotels into price tiers and creates unavailable placeholders', () => {
  const service = new ItineraryHotelPricePackageService();
  const packages = service.generate(
    new Map([
      [1, [hotel('expensive', 300), hotel('cheap', 100), hotel('mid', 200)]],
      [2, []],
      [3, null],
    ]),
    [route(1), route(2), route(3)],
  );

  assert.equal(packages.length, 4);
  assert.deepEqual(
    packages.map((pkg) => pkg.hotels.filter((item) => item.routeId === 1).map((item) => item.hotelCode)),
    [['cheap'], ['mid'], ['expensive'], ['expensive']],
  );
  assert.equal(packages[0].hotels.find((item) => item.routeId === 2)?.hotelName, 'No Hotels Available');
  assert.equal(packages[0].hotels.some((item) => item.routeId === 3), false);
});
