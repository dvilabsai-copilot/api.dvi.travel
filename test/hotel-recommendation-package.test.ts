import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelRecommendationPackageService, resolveHotelRecommendationAlgorithm } from '../src/modules/itineraries/services/hotel-recommendation-package.service';
import { HotelMealPlanPolicyService } from '../src/modules/itineraries/services/hotel-meal-plan-policy.service';
import {
  getCanonicalMealPlanFlags,
  inferCanonicalHotelRatePlanCodeFromMealFlags,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../src/modules/hotels/hotel-rate-plans';

const option = (hotelName: string, price: number, mealPlan = 'CP', extra: Record<string, unknown> = {}) => ({
  provider: 'tbo',
  canonicalHotelId: Number(extra.canonicalHotelId || 0) || null,
  providerHotelCode: hotelName.toUpperCase(),
  hotelCode: hotelName.toUpperCase(),
  hotelName,
  cityCode: 'TEST',
  address: '',
  rating: 3,
  category: '3-star',
  facilities: [],
  images: [],
  price,
  totalStayPrice: price,
  currency: 'INR',
  roomTypes: [],
  mealPlan,
  rateOptionId: `${hotelName}-${price}-${mealPlan}`,
  rateId: `${hotelName}-rate-${price}`,
  roomId: `${hotelName}-room`,
  searchReference: `${hotelName}-${price}`,
  expiresAt: new Date(Date.now() + 60_000),
  isSelectable: true,
  isLiveBookable: true,
  ...extra,
});

const routes = [
  { itinerary_route_ID: 101, itinerary_route_date: '2026-08-02', next_visiting_location: 'Munnar' },
  { itinerary_route_ID: 102, itinerary_route_date: '2026-08-03', next_visiting_location: 'Munnar' },
  { itinerary_route_ID: 103, itinerary_route_date: '2026-08-04', next_visiting_location: 'Alleppey' },
];

const service = () => new HotelRecommendationPackageService(new HotelMealPlanPolicyService());
const oneRoute = (location = 'Munnar') => [{ itinerary_route_ID: 1, itinerary_route_date: '2026-08-02', next_visiting_location: location }];

test('feature flag defaults to v1 and accepts only explicit v2', () => {
  assert.equal(resolveHotelRecommendationAlgorithm(''), 'v1');
  assert.equal(resolveHotelRecommendationAlgorithm('v1'), 'v1');
  assert.equal(resolveHotelRecommendationAlgorithm('v2'), 'v2');
  assert.equal(resolveHotelRecommendationAlgorithm('unexpected'), 'v1');
});

test('selects the exact CP rate option and its CP price, not the hotel-level EP price', () => {
  const hotel = option('Hotel A', 1800, 'EP', {
    rateOptions: [
      { rateOptionId: 'A-EP', rateId: 'EP-RATE', roomId: 'ROOM-1', roomType: 'Standard', mealPlan: 'EP', totalStayPrice: 1800, pricePerNight: 1800 },
      { rateOptionId: 'A-CP', rateId: 'CP-RATE', roomId: 'ROOM-1', roomType: 'Standard', mealPlan: 'CP', totalStayPrice: 2100, pricePerNight: 2100 },
    ],
    totalStayPrice: 1800,
  });
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [hotel as any]]]),
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].hotels[0].rateOptionId, 'A-CP');
  assert.equal(packages[0].totalPrice, 2100);
  assert.equal(packages[0].hotels[0].exactFullStayTotal, 2100);
  assert.deepEqual(packages[0].hotels[0].rateOptions?.map((rate) => rate.rateOptionId), ['A-CP']);
});

test('never inherits the parent EP total when an expanded CP option only has a per-night price', () => {
  const hotel = option('Hotel B', 1800, 'EP', {
    rateOptions: [
      { rateOptionId: 'B-EP', rateId: 'EP-RATE', roomId: 'ROOM-1', roomType: 'Standard', mealPlan: 'EP', totalStayPrice: 1800, pricePerNight: 1800 },
      { rateOptionId: 'B-CP', rateId: 'CP-RATE', roomId: 'ROOM-1', roomType: 'Standard', mealPlan: 'CP', pricePerNight: 2100 },
    ],
    totalStayPrice: 1800,
  });
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [hotel as any]]]),
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].hotels[0].rateOptionId, 'B-CP');
  assert.equal(packages[0].totalPrice, 2100);
  assert.equal(packages[0].hotels[0].exactFullStayTotal, 2100);
});

test('merges parent and child route availability for a logical multi-night stay', () => {
  const packages = service().generate({
    routes,
    hotelsByRoute: new Map([
      [101, []],
      [102, [option('Munnar Full Stay', 300, 'CP', { numberOfNights: 2 })]],
      [103, [option('Alleppey Stay', 200)]],
    ]),
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].complete, true);
  assert.equal(packages[0].hotels[0].stayKey, '101|2026-08-02|2026-08-04');
  assert.deepEqual(packages[0].hotels[0].routeIds, [101, 102]);
  assert.equal(packages[0].hotels[0].exactFullStayTotal, 300);
});

test('rejects a child-route one-night rate when the logical stay needs multiple nights', () => {
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 301, itinerary_route_date: '2026-08-02', next_visiting_location: 'Munnar' },
      { itinerary_route_ID: 302, itinerary_route_date: '2026-08-03', next_visiting_location: 'Munnar' },
    ],
    hotelsByRoute: new Map([
      [301, []],
      [302, [option('One Night Only', 100, 'CP', { numberOfNights: 1 })]],
    ]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[0].complete, false);
  assert.match(packages[0].stayResults[0].reason || '', /full logical stay/i);
});

test('preserves valid stays when another logical stay is unavailable', () => {
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 1, itinerary_route_date: '2026-08-02', next_visiting_location: 'Munnar' },
      { itinerary_route_ID: 2, itinerary_route_date: '2026-08-03', next_visiting_location: 'Kochi' },
    ],
    hotelsByRoute: new Map([[1, [option('Munnar Hotel', 100)]], [2, []]]),
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages.length, 1);
  assert.equal(packages[0].complete, false);
  assert.equal(packages[0].totalPrice, null);
  assert.equal(packages[0].partialTotal, 100);
  assert.equal(packages[0].hotels.length, 1);
  assert.deepEqual(packages[0].stayResults.map((stay) => stay.state), ['SELECTED', 'UNAVAILABLE']);
});

test('returns partial alternatives for available stays while preserving the unavailable stay row', () => {
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 1, itinerary_route_date: '2026-08-02', next_visiting_location: 'Munnar' },
      { itinerary_route_ID: 2, itinerary_route_date: '2026-08-03', next_visiting_location: 'Kochi' },
    ],
    hotelsByRoute: new Map([
      [1, [option('Munnar A', 100), option('Munnar B', 110)]],
      [2, []],
    ]),
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages.length, 2);
  assert.deepEqual(packages.map((pkg) => pkg.hotels[0].hotelName), ['Munnar A', 'Munnar B']);
  assert.ok(packages.every((pkg) => pkg.totalPrice === null && pkg.partialTotal > 0));
  assert.ok(packages.every((pkg) => pkg.stayResults[1].state === 'UNAVAILABLE'));
});

test('constructs stable logical stays and handles aliases, repeated destinations, departure, and transit routes', () => {
  const stays = service().buildLogicalStays([
    { itinerary_route_ID: 1, itinerary_route_date: '2026-08-01', next_visiting_location: 'Alleppey' },
    { itinerary_route_ID: 2, itinerary_route_date: '2026-08-02', next_visiting_location: 'Alappuzha' },
    { itinerary_route_ID: 3, itinerary_route_date: '2026-08-03', next_visiting_location: 'Kochi' },
    { itinerary_route_ID: 4, itinerary_route_date: '2026-08-04', next_visiting_location: 'Alleppey' },
    { itinerary_route_ID: 5, itinerary_route_date: '2026-08-05', next_visiting_location: 'Departure', isDeparture: true },
    { itinerary_route_ID: 6, itinerary_route_date: '2026-08-06', next_visiting_location: 'Transit', isTransit: true },
  ]);

  assert.equal(stays.length, 3);
  assert.deepEqual(stays[0].routeIds, [1, 2]);
  assert.equal(stays[0].stayKey, '1|2026-08-01|2026-08-03');
  assert.equal(stays[1].stayKey, '3|2026-08-03|2026-08-04');
  assert.equal(stays[2].stayKey, '4|2026-08-04|2026-08-05');
});

test('uses stable stay group IDs when destination text differs', () => {
  const stays = service().buildLogicalStays([
    { itinerary_route_ID: 20, itinerary_route_date: '2026-08-01', next_visiting_location: 'Area A', stayGroupId: 'stay-1' },
    { itinerary_route_ID: 21, itinerary_route_date: '2026-08-02', next_visiting_location: 'Area B', stayGroupId: 'stay-1' },
  ]);
  assert.equal(stays.length, 1);
  assert.deepEqual(stays[0].routeIds, [20, 21]);
});

test('offline inventory may be selectable for approval without live bookability', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('Offline Hotel', 90, 'CP', {
      provider: 'offline',
      bookingMode: 'MANUAL_APPROVAL',
      isBookable: false,
      isLiveBookable: false,
      requiresHotelApproval: true,
    })]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[0].complete, true);
  assert.equal(packages[0].stayResults[0].state, 'OFFLINE_FALLBACK');
  assert.equal(packages[0].hotels[0].availabilityState, 'OFFLINE_APPROVAL_REQUIRED');
  assert.equal(packages[0].hotels[0].isSelectable, true);
});

test('rejects a live candidate with no explicit availability or bookability signal', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('Unverifiable Live Hotel', 100, 'CP', {
      availabilityStatus: undefined,
      isLiveBookable: undefined,
      isBookable: undefined,
    })]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[0].complete, false);
  assert.match(packages[0].stayResults[0].reason || '', /explicit availability or bookability/i);
});

test('normalizes star categories without reading unrelated numbers', () => {
  const accepted = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('Three Star', 100, 'CP', { category: '3 Star' }), option('Noise 123', 90, 'CP', { category: 'Room 123 near highway', rating: 0 })]]]),
    preferredMealPlanCode: 'CP',
    preferredCategories: [3],
  });
  assert.equal(accepted[0].hotels[0].hotelName, 'Three Star');
});

test('does not treat zero or missing distance as valid when distance is required', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('Unknown Distance', 100, 'CP', { distanceKm: 0 })]]]),
    preferredMealPlanCode: 'CP',
    requireKnownDistance: true,
  });
  assert.equal(packages[0].complete, false);
  assert.match(packages[0].stayResults[0].reason || '', /Distance is unavailable/);
});

test('unknown meal text is not silently treated as EP', () => {
  assert.equal(inferCanonicalHotelRatePlanCodeFromMealText('Parking and Wi-Fi included'), null);
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('Unknown', 50, 'Parking and Wi-Fi included')]]]),
    preferredMealPlanCode: 'EP',
  });
  assert.equal(packages[0].complete, false);
});

test('meal-plan flags preserve the canonical CP/MAP/AP contract', () => {
  assert.deepEqual(getCanonicalMealPlanFlags('CP'), {
    all: false,
    breakfast: true,
    lunch: false,
    dinner: false,
  });
  assert.deepEqual(getCanonicalMealPlanFlags('MAP'), {
    all: false,
    breakfast: true,
    lunch: false,
    dinner: true,
  });
  assert.deepEqual(getCanonicalMealPlanFlags('AP'), {
    all: true,
    breakfast: true,
    lunch: true,
    dinner: true,
  });
  assert.equal(inferCanonicalHotelRatePlanCodeFromMealFlags(1, 1, 0), 'MAP');
  assert.equal(inferCanonicalHotelRatePlanCodeFromMealFlags(1, 0, 1), 'MAP');
  assert.equal(inferCanonicalHotelRatePlanCodeFromMealFlags(1, 1, 1), 'AP');
});

test('houseboat policy requires AP', () => {
  const packages = service().generate({
    routes: [{ itinerary_route_ID: 201, itinerary_route_date: '2026-08-02', next_visiting_location: 'Alleppey' }],
    hotelsByRoute: new Map([[201, [option('Houseboat CP', 50, 'CP', { accommodationType: 'HOUSEBOAT' }), option('Houseboat AP', 90, 'AP', { accommodationType: 'HOUSEBOAT' })]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[0].hotels[0].hotelName, 'Houseboat AP');
});

test('recommendations stop at the number of real combinations and expose diversity metadata', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('A', 100), option('B', 110), option('C', 120), option('D', 130)]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages.length, 4);
  assert.equal(packages[0].totalPrice, 100);
  assert.equal(packages[1].targetPrice, 110);
  assert.ok(Array.isArray(packages[3].repeatedAcrossGroupsHotelIds));
  assert.ok(Array.isArray(packages[3].sameOptionAcrossGroups));
  assert.ok(Array.isArray(packages[3].duplicateWithinPackageHotelIds));
});

test('beam search finds the closest real target package without DFS first-N truncation', () => {
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 1, itinerary_route_date: '2026-08-02', next_visiting_location: 'Munnar' },
      { itinerary_route_ID: 2, itinerary_route_date: '2026-08-03', next_visiting_location: 'Kochi' },
    ],
    hotelsByRoute: new Map([
      [1, [option('M1', 100), option('M2', 200), option('M3', 300)]],
      [2, [option('K1', 100), option('K2', 200), option('K3', 300)]],
    ]),
    preferredMealPlanCode: 'CP',
    beamWidth: 200,
    packageLimit: 1000,
  });
  assert.equal(packages[0].totalPrice, 200);
  assert.equal(packages[1].totalPrice, 300);
});

test('shuffled source input produces deterministic recommendations', () => {
  const input = {
    routes: oneRoute(),
    preferredMealPlanCode: 'CP',
  };
  const first = service().generate({ ...input, hotelsByRoute: new Map([[1, [option('B', 200), option('A', 100)]]]) });
  const second = service().generate({ ...input, hotelsByRoute: new Map([[1, [option('A', 100), option('B', 200)]]]) });
  assert.equal(first[0].hotels[0].rateOptionId, second[0].hotels[0].rateOptionId);
  assert.equal(first[0].totalPrice, second[0].totalPrice);
});
