import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelRecommendationPackageService } from '../src/modules/itineraries/services/hotel-recommendation-package.service';
import { HotelMealPlanPolicyService } from '../src/modules/itineraries/services/hotel-meal-plan-policy.service';
import { inferCanonicalHotelRatePlanCodeFromMealText } from '../src/modules/hotels/hotel-rate-plans';

const routes = [
  { itinerary_route_ID: 101, itinerary_route_date: '2026-08-02', next_visiting_location: 'Munnar' },
  { itinerary_route_ID: 102, itinerary_route_date: '2026-08-03', next_visiting_location: 'Munnar' },
  { itinerary_route_ID: 103, itinerary_route_date: '2026-08-04', next_visiting_location: 'Alleppey' },
];

const option = (hotelName: string, price: number, mealPlan = 'CP', extra: Record<string, unknown> = {}) => ({
  provider: 'tbo', hotelCode: hotelName.toUpperCase(), hotelName, cityCode: 'TEST', address: '', rating: 3,
  category: '3-star', facilities: [], images: [], price, totalStayPrice: price, currency: 'INR', roomTypes: [],
  mealPlan, rateOptionId: `${hotelName}-${price}`, searchReference: `${hotelName}-${price}`, expiresAt: new Date(Date.now() + 60_000),
  isBookable: true, isSelectable: true, ...extra,
});

const service = () => new HotelRecommendationPackageService(new HotelMealPlanPolicyService());

test('builds logical stays and does not double-count the two-night stay', () => {
  const packages = service().generate({
    routes,
    noOfNights: 3,
    hotelsByRoute: new Map([
      [101, [option('Munnar A', 100), option('Munnar B', 150)]],
      [102, [option('Munnar A', 100), option('Munnar B', 150)]],
      [103, [option('Alleppey A', 200), option('Alleppey B', 260)]],
    ]),
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].complete, true);
  assert.equal(packages[0].hotels.length, 2);
  assert.equal(packages[0].totalPrice, 300);
  assert.deepEqual(packages[0].hotels[0].routeIds, [101, 102]);
});

test('uses exact requested CP even when EP is cheaper', () => {
  const packages = service().generate({
    routes: [routes[0]], noOfNights: 1,
    hotelsByRoute: new Map([[101, [option('EP Cheap', 50, 'EP'), option('CP Valid', 100, 'CP')]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[0].hotels[0].hotelName, 'CP Valid');
});

test('unknown meal text is not silently treated as EP', () => {
  assert.equal(inferCanonicalHotelRatePlanCodeFromMealText('Parking and Wi-Fi included'), null);
  const packages = service().generate({
    routes: [routes[0]], noOfNights: 1,
    hotelsByRoute: new Map([[101, [option('Unknown', 50, 'Parking and Wi-Fi included')]]]),
    preferredMealPlanCode: 'EP',
  });
  assert.equal(packages[0].complete, false);
});

test('excludes hotels beyond the configured radius from v2 automatic recommendations', () => {
  const packages = service().generate({
    routes: [routes[0]], noOfNights: 1,
    hotelsByRoute: new Map([[101, [option('Far', 50, 'CP', { distanceKm: 15.01 }), option('Near', 70, 'CP', { distanceKm: 15 })]]]),
    preferredMealPlanCode: 'CP', maxDistanceKm: 15,
  });
  assert.equal(packages[0].hotels[0].hotelName, 'Near');
});

test('requires AP for a structured Alleppey houseboat', () => {
  const packages = service().generate({
    routes: [{ itinerary_route_ID: 201, itinerary_route_date: '2026-08-02', next_visiting_location: 'Alleppey' }], noOfNights: 1,
    hotelsByRoute: new Map([[201, [option('Houseboat', 50, 'CP', { accommodationType: 'HOUSEBOAT' }), option('Houseboat AP', 90, 'AP', { accommodationType: 'HOUSEBOAT' })]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[0].hotels[0].hotelName, 'Houseboat AP');
});

test('does not pretend one real option creates four distinct packages', () => {
  const packages = service().generate({
    routes: [routes[0]], noOfNights: 1,
    hotelsByRoute: new Map([[101, [option('Only Hotel', 50)]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages.length, 1);
});
