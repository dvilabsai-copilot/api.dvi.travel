import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelRecommendationPackageService, mapHotelCategoryLabelToStar, resolveHotelRecommendationAlgorithm } from '../src/modules/itineraries/services/hotel-recommendation-package.service';
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

test('aggregates verified route-night rows into one continuous stay at actual nightly totals', () => {
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 11275, itinerary_route_date: '2026-09-01', next_visiting_location: 'Munnar' },
      { itinerary_route_ID: 11276, itinerary_route_date: '2026-09-02', next_visiting_location: 'Munnar' },
    ],
    hotelsByRoute: new Map([
      [11275, [option('Clouds Valley', 3960, 'CP', {
        canonicalHotelId: 95,
        roomType: 'Deluxe',
        itineraryRouteId: 11275,
        routeId: 11275,
        routeIds: [11275],
        checkInDate: '2026-09-01',
        checkOutDate: '2026-09-02',
        rateId: 'CP_PLAN',
        rateOptionId: 'clouds-cp-2026-09-01',
        pricePerNight: 3960,
      })]],
      [11276, [option('Clouds Valley', 4180, 'CP', {
        canonicalHotelId: 95,
        roomType: 'Deluxe',
        itineraryRouteId: 11276,
        routeId: 11276,
        routeIds: [11276],
        checkInDate: '2026-09-02',
        checkOutDate: '2026-09-03',
        rateId: 'CP_PLAN',
        rateOptionId: 'clouds-cp-2026-09-02',
        pricePerNight: 4180,
      })]],
    ]),
    preferredMealPlanCode: 'CP',
  });

  const selected = packages[0].hotels[0];
  assert.equal(packages[0].complete, true);
  assert.equal(selected.hotelName, 'Clouds Valley');
  assert.deepEqual(selected.routeIds, [11275, 11276]);
  assert.equal(selected.exactFullStayTotal, 8140);
  assert.equal(selected.totalStayPrice, 8140);
  assert.deepEqual(selected.nightlyRates?.map((rate) => [rate.date, rate.sellAmount]), [
    ['2026-09-01', 3960],
    ['2026-09-02', 4180],
  ]);
  assert.deepEqual(selected.nightlyRates?.map((rate) => (rate as any).rateOptionId), [
    'clouds-cp-2026-09-01',
    'clouds-cp-2026-09-02',
  ]);
  assert.deepEqual(selected.nightlyRates?.map((rate) => (rate as any).routeId), [11275, 11276]);
});

test('does not fabricate a continuous stay from a parent row copied across routes', () => {
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 11275, itinerary_route_date: '2026-09-01', next_visiting_location: 'Munnar' },
      { itinerary_route_ID: 11276, itinerary_route_date: '2026-09-02', next_visiting_location: 'Munnar' },
    ],
    hotelsByRoute: new Map([
      [11275, [option('Copied Coverage', 3960, 'CP', {
        itineraryRouteId: 11275,
        routeId: 11275,
        routeIds: [11275, 11276],
        checkInDate: '2026-09-01',
        checkOutDate: '2026-09-03',
        numberOfNights: 2,
      })]],
      [11276, []],
    ]),
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].complete, false);
  assert.equal(packages[0].hotels.length, 0);
  assert.equal(packages[0].stayResults[0].state, 'UNAVAILABLE');
});

test('normalizes a stale itinerary-wide total to the route-specific one-night stay', () => {
  const hotel = option('Hablis Hotel Chennai', 7179.38, 'UNKNOWN', {
    numberOfNights: 2,
    totalStayPrice: 14358.76,
    checkInDate: '2026-08-08',
    checkOutDate: '2026-08-09',
  });
  const packages = service().generate({
    routes: [{ itinerary_route_ID: 401, itinerary_route_date: '2026-08-08', next_visiting_location: 'Chennai' }],
    hotelsByRoute: new Map([[401, [hotel as any]]]),
  });

  assert.equal(packages[0].hotels[0].exactFullStayTotal, 7179.38);
  assert.equal(packages[0].totalPrice, 7179.38);
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

  assert.equal(packages.length, 4);
  assert.deepEqual(packages.map((pkg) => pkg.groupType), [1, 2, 3, 4]);
  assert.deepEqual(packages.map((pkg) => pkg.label), [
    'Recommended #1',
    'Recommended #2',
    'Recommended #3',
    'Recommended #4',
  ]);
  assert.equal(packages[0].complete, false);
  assert.equal(packages[0].totalPrice, null);
  assert.equal(packages[0].partialTotal, 100);
  assert.equal(packages[0].hotels.length, 1);
  assert.deepEqual(packages[0].stayResults.map((stay) => stay.state), ['SELECTED', 'UNAVAILABLE']);
  assert.deepEqual(packages.map((pkg) => pkg.groupType), [1, 2, 3, 4]);
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

  assert.equal(packages.length, 4);
  assert.deepEqual(packages.slice(0, 2).flatMap((pkg) => pkg.hotels.map((hotel) => hotel.hotelName)), ['Munnar A', 'Munnar B']);
  assert.deepEqual(packages.slice(2).flatMap((pkg) => pkg.hotels.map((hotel) => hotel.hotelName)), ['Munnar A', 'Munnar A']);
  assert.ok(packages.slice(0, 2).filter((pkg) => pkg.hotels.length > 0).every((pkg) => pkg.totalPrice === null && pkg.partialTotal > 0));
  assert.ok(packages.slice(0, 2).every((pkg) => pkg.stayResults[1].state === 'UNAVAILABLE'));
});

test('always exposes four tabs when no hotel stay has availability', () => {
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 1, itinerary_route_date: '2026-08-02', next_visiting_location: 'Kabini' },
    ],
    hotelsByRoute: new Map([[1, []]]),
    preferredMealPlanCode: 'CP',
  });

  assert.deepEqual(packages.map((pkg) => pkg.groupType), [1, 2, 3, 4]);
  assert.ok(packages.every((pkg) => pkg.complete === false && pkg.hotels.length === 0));
  assert.equal(packages[0].stayResults[0].state, 'UNAVAILABLE');
  assert.ok(packages.every((pkg) => pkg.stayResults.length === 0 || (pkg.stayResults.length === 1 && pkg.stayResults[0].state === 'UNAVAILABLE')));
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

test('uses parent stay linkage when consecutive nights have different cities', () => {
  const stays = service().buildLogicalStays([
    { itinerary_route_ID: 30, itinerary_route_date: '2026-08-01', next_visiting_location: 'City A' },
    { itinerary_route_ID: 31, itinerary_route_date: '2026-08-02', next_visiting_location: 'City B', parentStayRouteId: 30 },
    { itinerary_route_ID: 32, itinerary_route_date: '2026-08-03', next_visiting_location: 'City C', parentStayRouteId: 30 },
  ]);
  assert.equal(stays.length, 1);
  assert.deepEqual(stays[0].routeIds, [30, 31, 32]);
  assert.equal(stays[0].nights, 3);
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

test('recommendations use target prices but exhaust unused properties before reuse', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('A', 100), option('B', 110), option('C', 120), option('D', 130)]]]),
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages.length, 4);
  assert.equal(packages[0].totalPrice, 100);
  assert.equal(packages[1].targetPrice, null);
  assert.deepEqual(packages.map((pkg) => pkg.totalPrice), [100, 120, 110, 130]);
  assert.equal(packages[3].hotels[0].hotelName, 'D');
});

test('maps category master labels and codes to logical star buckets', () => {
  assert.equal(mapHotelCategoryLabelToStar('Budget'), 2);
  assert.equal(mapHotelCategoryLabelToStar('STD'), 2);
  assert.equal(mapHotelCategoryLabelToStar(1), 2);
  assert.equal(mapHotelCategoryLabelToStar('1*'), 2);
  assert.equal(mapHotelCategoryLabelToStar('unknown'), null);
  assert.equal(mapHotelCategoryLabelToStar('3*'), 3);
  assert.equal(mapHotelCategoryLabelToStar('hotel_category_5_star'), 5);
});

test('reuses a valid physical hotel when no distinct property remains', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [
      option('Same Hotel', 100, 'CP', { rateOptionId: 'same-hotel-cheap' }),
      option('Same Hotel', 110, 'CP', { rateOptionId: 'same-hotel-expensive' }),
      option('Different Hotel', 200),
    ]]]),
    preferredMealPlanCode: 'CP',
  });

  assert.deepEqual(packages.map((pkg) => pkg.totalPrice), [100, 200, 200, 200]);
  assert.equal(packages[0].hotels[0].hotelName, 'Same Hotel');
  assert.equal(packages[1].hotels[0].hotelName, 'Different Hotel');
  assert.equal(packages[2].hotels[0].hotelName, 'Different Hotel');
  assert.equal(packages[3].hotels[0].hotelName, 'Different Hotel');
});

test('distinct-property pass prefers another target-category property before meal fallback', () => {
  const packages = service().generate({
    routes: oneRoute('Munnar'),
    hotelsByRoute: new Map([[1, [
      option('Hotel A', 100, 'MAP', { category: '3-star', canonicalHotelId: 301 }),
      option('Hotel B', 110, 'CP', { category: '3-star', canonicalHotelId: 302 }),
      option('Hotel C', 120, 'MAP', { category: '2-star', canonicalHotelId: 303 }),
      option('Hotel D', 130, 'MAP', { category: '4-star', canonicalHotelId: 304 }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.deepEqual(packages.map((pkg) => pkg.hotels[0]?.hotelName), ['Hotel A', 'Hotel B', 'Hotel C', 'Hotel D']);
  assert.deepEqual(packages.map((pkg) => pkg.hotels[0]?.selectedCategory), [3, 3, 2, 4]);
});

test('distinct-property pass chooses lower category before reusing the target property', () => {
  const packages = service().generate({
    routes: oneRoute('Munnar'),
    hotelsByRoute: new Map([[1, [
      option('Hotel A', 100, 'MAP', { category: '3-star', canonicalHotelId: 401 }),
      option('Hotel B', 120, 'CP', { category: '2-star', canonicalHotelId: 402 }),
      option('Hotel C', 130, 'MAP', { category: '4-star', canonicalHotelId: 403 }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.deepEqual(packages.slice(0, 3).map((pkg) => pkg.hotels[0]?.hotelName), ['Hotel A', 'Hotel B', 'Hotel C']);
  assert.equal(packages[1].hotels[0]?.categoryFallbackApplied, true);
});

test('reuse is allowed only after every physical property is exhausted', () => {
  const packages = service().generate({
    routes: oneRoute('Munnar'),
    hotelsByRoute: new Map([[1, [option('Only Hotel', 100, 'MAP', { category: '3-star', canonicalHotelId: 501 })] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.deepEqual(packages.map((pkg) => pkg.hotels[0]?.hotelName), ['Only Hotel', 'Only Hotel', 'Only Hotel', 'Only Hotel']);
});

test('provider variants with one canonical hotel count as one physical property', () => {
  const packages = service().generate({
    routes: oneRoute('Munnar'),
    hotelsByRoute: new Map([[1, [
      option('Canonical Hotel', 100, 'MAP', { provider: 'axisrooms', canonicalHotelId: 601 }),
      option('Canonical Hotel', 105, 'MAP', { provider: 'offline', canonicalHotelId: 601 }),
      option('Other Hotel', 110, 'MAP', { provider: 'tbo', canonicalHotelId: 602 }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.equal(packages[0].hotels[0]?.canonicalHotelId, 601);
  assert.equal(packages[1].hotels[0]?.canonicalHotelId, 602);
  assert.equal(packages[2].hotels[0]?.canonicalHotelId, 601);
});

test('an unused candidate is chosen when the target multiplier cannot be met', () => {
  const packages = service().generate({
    routes: oneRoute('Munnar'),
    hotelsByRoute: new Map([[1, [
      option('Hotel A', 100, 'CP', { category: '3-star', canonicalHotelId: 701 }),
      option('Hotel B', 110, 'CP', { category: '3-star', canonicalHotelId: 702 }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].hotels[0]?.hotelName, 'Hotel A');
  assert.equal(packages[1].hotels[0]?.hotelName, 'Hotel B');
});

test('beam search finds the closest distinct real target package without DFS first-N truncation', () => {
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
  // The 300 combination reuses one of group 1's physical hotels. The next
  // valid distinct package is 400.
  assert.equal(packages[1].totalPrice, 400);
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

test('allocates one selected category in ascending price order with distinct properties', () => {
  const hotels = [100, 120, 140, 160].map((price) => option(`A-${price}`, price, 'CP', { category: '5-star' }));
  const packages = service().generate({ routes: oneRoute(), hotelsByRoute: new Map([[1, hotels as any]]), preferredCategories: [5] });
  assert.deepEqual(packages.map((pkg) => pkg.hotels[0]?.price), [100, 120, 140, 160]);
  assert.equal(packages[0].groupType, 1);
  assert.equal(packages[3].complete, true);
});

test('applies ascending price allocation to each single selected category', () => {
  for (const category of [3, 4, 5]) {
    const hotels = [100, 110, 120, 130].map((price) => option(`${category}-star-${price}`, price, 'CP', {
      category: `${category}-star`,
    }));
    const packages = service().generate({
      routes: oneRoute(),
      hotelsByRoute: new Map([[1, hotels as any]]),
      preferredCategories: [category],
      preferredMealPlanCode: 'CP',
    });
    assert.deepEqual(packages.map((pkg) => pkg.hotels[0]?.price), [100, 110, 120, 130]);
  }
});

test('allocates two categories as A/A/B/B using each category base', () => {
  const hotels = [100, 150, 200, 300].map((price, index) => option(`H-${index}`, price, 'CP', { category: index < 2 ? '3-star' : '4-star' }));
  const packages = service().generate({ routes: oneRoute(), hotelsByRoute: new Map([[1, hotels as any]]), preferredCategories: [3, 4] });
  assert.deepEqual(packages.map((pkg) => pkg.hotels[0]?.category), ['3-star', '3-star', '4-star', '4-star']);
  assert.deepEqual(packages.map((pkg) => pkg.hotels[0]?.price), [100, 150, 200, 300]);
});

test('allocates three categories as A/B/B/C and four categories one per group', () => {
  const three = [100, 200, 300, 400].map((price, index) => option(`T-${index}`, price, 'CP', { category: `${index === 0 ? 2 : index < 3 ? 3 : 4}-star` }));
  const threePackages = service().generate({ routes: oneRoute(), hotelsByRoute: new Map([[1, three as any]]), preferredCategories: [2, 3, 4] });
  assert.deepEqual(threePackages.map((pkg) => pkg.hotels[0]?.category), ['2-star', '3-star', '3-star', '4-star']);
  const four = [100, 200, 300, 400].map((price, index) => option(`F-${index}`, price, 'CP', { category: `${index + 2}-star` }));
  const fourPackages = service().generate({ routes: oneRoute(), hotelsByRoute: new Map([[1, four as any]]), preferredCategories: [2, 3, 4, 5] });
  assert.deepEqual(fourPackages.map((pkg) => pkg.hotels[0]?.category), ['2-star', '3-star', '4-star', '5-star']);
});

test('falls back from requested 3-star to lower 2-star before higher 4-star', () => {
  const packages = service().generate({
    routes: oneRoute('Kovalam'),
    hotelsByRoute: new Map([[1, [
      option('Jeevan Beach Resort', 2530, 'CP', { category: '2-star' }),
      option('Higher Category Resort', 2600, 'CP', { category: '4-star' }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[0].hotels[0].hotelName, 'Jeevan Beach Resort');
  assert.equal(packages[0].hotels[0].selectedCategory, 2);
  assert.equal(packages[0].hotels[0].requestedCategory, 3);
  assert.equal(packages[0].hotels[0].categoryFallbackApplied, true);
  assert.equal(packages[0].hotels[0].categoryFallbackReason, '2* selected — 3* not available');
});

test('live inventory wins automatic selection over cheaper offline inventory', () => {
  const packages = service().generate({
    routes: oneRoute('Kovalam'),
    hotelsByRoute: new Map([[1, [
      option('Live 4 Star', 4000, 'CP', { provider: 'tbo', category: '4-star' }),
      option('Offline 2 Star', 2500, 'CP', {
        provider: 'offline',
        category: '2-star',
        bookingMode: 'MANUAL_APPROVAL',
        requiresHotelApproval: true,
        isBookable: false,
        isLiveBookable: false,
      }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].hotels[0].hotelName, 'Live 4 Star');
  assert.equal(packages[0].hotels[0].provider, 'tbo');
  assert.equal(packages[0].hotels[0].selectedCategory, 4);
  assert.equal(packages[0].hotels[0].categoryFallbackApplied, true);
});

test('live inventory wins automatic selection over exact-category offline inventory', () => {
  const packages = service().generate({
    routes: oneRoute('Kovalam'),
    hotelsByRoute: new Map([[1, [
      option('Live 4 Star', 4000, 'CP', { provider: 'tbo', category: '4-star' }),
      option('Offline 3 Star', 5000, 'CP', {
        provider: 'offline',
        category: '3-star',
        bookingMode: 'MANUAL_APPROVAL',
        requiresHotelApproval: true,
        isBookable: false,
        isLiveBookable: false,
      }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].hotels[0].hotelName, 'Live 4 Star');
  assert.equal(packages[0].hotels[0].provider, 'tbo');
  assert.equal(packages[0].hotels[0].selectedCategory, 4);
  assert.equal(packages[0].hotels[0].categoryFallbackApplied, true);
});

test('selects a complete live Patio room across a continuous stay and rejects supplement-only Suite', () => {
  const patioRoom = (roomType: string, total: number, base: number) => option('THE PATIO', total, 'CP', {
    provider: 'axisrooms',
    canonicalHotelId: 234,
    providerHotelCode: '234',
    category: '1-star',
    roomId: roomType,
    roomType,
    basePricePerNight: base,
    baseTotalPrice: base,
    pricePerNight: total,
    totalStayPrice: total,
    extraBedRate: 1000,
    childWithoutBedRate: 600,
    rateFamily: 'CP',
    rateOptionId: `${roomType}-CP`,
    rateId: `${roomType}-CP`,
    isBookable: true,
    isLiveBookable: true,
    availabilityStatus: 'AVAILABLE',
  });
  const suite = patioRoom('Suite Room AC', 8000, 0);
  suite.rateOptions = [{
    roomId: 'suite', roomType: 'Suite Room AC', mealPlan: 'CP',
    totalStayPrice: 8000, pricePerNight: 8000,
    basePricePerNight: 0, baseTotalPrice: 0,
    extraBedRate: 1000, childWithoutBedRate: 600,
    rateOptionId: 'suite-cp', rateId: 'suite-cp',
  }];
  const packages = service().generate({
    routes: [
      { itinerary_route_ID: 11322, itinerary_route_date: '2026-09-05', next_visiting_location: 'Thekkady' },
      { itinerary_route_ID: 11323, itinerary_route_date: '2026-09-06', next_visiting_location: 'Thekkady' },
    ],
    hotelsByRoute: new Map([
      [11322, [
        patioRoom('Deluxe AC', 11440, 4400),
        suite,
        option('JUNGLE PARK RESORT', 7480, 'CP', {
          provider: 'offline', category: '3-star', canonicalHotelId: 439,
          bookingMode: 'MANUAL_APPROVAL', requiresHotelApproval: true,
          isBookable: false, isLiveBookable: false,
          extraBedRate: 1000, childWithoutBedRate: 600,
        }),
      ] as any],
      [11323, [
        patioRoom('Deluxe AC', 11440, 4400),
        suite,
        option('JUNGLE PARK RESORT', 5720, 'CP', {
          provider: 'offline', category: '3-star', canonicalHotelId: 439,
          bookingMode: 'MANUAL_APPROVAL', requiresHotelApproval: true,
          isBookable: false, isLiveBookable: false,
          extraBedRate: 1000, childWithoutBedRate: 600,
        }),
      ] as any],
    ]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
    occupancy: { extraBedCount: 1, childWithoutBedCount: 1 },
  });

  const stay = packages[0].stayResults[0];
  assert.equal(stay.hotel?.hotelName, 'THE PATIO');
  assert.equal(stay.hotel?.provider, 'axisrooms');
  assert.equal(stay.hotel?.roomType, 'Deluxe AC');
  assert.deepEqual(stay.hotel?.routeIds, [11322, 11323]);
  assert.equal(stay.hotel?.categoryFallbackApplied, true);
  // The application intentionally normalizes supplier 1-star/Budget labels
  // into its logical 2-star bucket.
  assert.equal(stay.hotel?.selectedCategory, 2);
  assert.equal(stay.hotel?.exactFullStayTotal, 22880);
  assert.equal(stay.rejectedCandidates?.some((item) => /Base SINGLE\/DOUBLE/.test(item.reason)), true);
});

test('required supplement rates are part of recommendation eligibility', () => {
  const packages = service().generate({
    routes: oneRoute('Munnar'),
    hotelsByRoute: new Map([[1, [
      option('Missing Supplements', 3000, 'CP', {
        provider: 'tbo',
        category: '3-star',
        canonicalHotelId: 901,
      }),
      option('Complete Axis Rate', 4200, 'CP', {
        provider: 'axisrooms',
        category: '3-star',
        canonicalHotelId: 902,
        extraBedRate: 1200,
        childWithoutBedRate: 700,
      }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
    occupancy: { extraBedCount: 1, childWithoutBedCount: 1 },
  });

  assert.equal(packages[0].stayResults[0].hotel?.hotelName, 'Complete Axis Rate');
  assert.equal(packages[0].stayResults[0].hotel?.provider, 'axisrooms');
});

test('AxisRooms wins a payable-price tie without excluding offline inventory', () => {
  const packages = service().generate({
    routes: oneRoute('Munnar'),
    hotelsByRoute: new Map([[1, [
      option('Offline Tie', 5000, 'CP', { provider: 'offline', category: '3-star', canonicalHotelId: 801 }),
      option('Axis Tie', 5000, 'CP', { provider: 'axisrooms', category: '3-star', canonicalHotelId: 802 }),
    ] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
  });

  assert.equal(packages[0].hotels[0].hotelName, 'Axis Tie');
  assert.equal(packages[0].hotels[0].provider, 'axisrooms');
});

test('fallback selects the only usable lower-category hotel even when its multiplier is not met', () => {
  const packages = service().generate({
    routes: oneRoute('Kovalam'),
    hotelsByRoute: new Map([[1, [option('Only Offline Hotel', 100, 'CP', {
      provider: 'offline',
      category: '2-star',
      bookingMode: 'MANUAL_APPROVAL',
      requiresHotelApproval: true,
      isBookable: false,
      isLiveBookable: false,
    })] as any]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'CP',
  });
  assert.equal(packages[3].stayResults[0].state, 'OFFLINE_FALLBACK');
  assert.equal(packages[3].hotels[0].hotelName, 'Only Offline Hotel');
  assert.equal(packages[3].hotels[0].selectedCategory, 2);
});

test('falls back to G3 only for missing G4 stays when another stay has genuine G4', () => {
  const routesForTwoStays = [
    { itinerary_route_ID: 1, itinerary_route_date: '2026-08-02', next_visiting_location: 'A' },
    { itinerary_route_ID: 2, itinerary_route_date: '2026-08-03', next_visiting_location: 'B' },
  ];
  const packages = service().generate({
    routes: routesForTwoStays,
    hotelsByRoute: new Map([
      [1, [option('A3', 100, 'CP', { category: '3-star' }), option('A3b', 120, 'CP', { category: '3-star' }), option('A4', 200, 'CP', { category: '4-star' }), option('A4b', 300, 'CP', { category: '4-star' })] as any],
      [2, [option('B4', 120, 'CP', { category: '4-star' })] as any],
    ]),
    preferredCategories: [3, 4],
  });
  assert.equal(packages[3].stayResults.find((stay) => stay.destination === 'A')?.state, 'SELECTED');
  assert.equal(packages[3].stayResults.find((stay) => stay.destination === 'B')?.state, 'SELECTED');
  assert.equal(packages[3].stayResults.find((stay) => stay.destination === 'B')?.hotel?.hotelName, 'B4');
});

test('requested MAP wins over a cheaper CP rate within the same category', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [
      option('MAP Hotel', 6500, 'Modified American Plan'),
      option('CP Hotel', 5000, 'Continental Plan'),
    ]]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.equal(packages[0].hotels[0].mealPlan, 'Modified American Plan');
  assert.equal(packages[0].hotels[0].totalStayPrice, 6500);
  assert.equal(packages[0].hotels[0].requestedCategory, 3);
  assert.equal(packages[0].hotels[0].selectedCategory, 3);
  assert.equal(packages[0].hotels[0].categoryFallbackApplied, false);
});

test('price multipliers are applied after choosing the MAP candidate population', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [
      option('MAP Base', 6500, 'MAP'),
      option('MAP Premium', 8000, 'MAP'),
      option('Cheap CP', 5000, 'CP'),
    ]]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.equal(packages[0].stayResults[0].hotel?.mealPlan, 'MAP');
  assert.equal(packages[1].stayResults[0].hotel?.mealPlan, 'MAP');
  assert.equal(packages[1].stayResults[0].totalPrice, 8000);
  assert.equal(packages[1].stayResults[0].hotel?.hotelName, 'MAP Premium');
});

test('category preference remains stronger than meal-plan preference', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [
      option('Three Star CP', 5000, 'CP', { category: '3-star' }),
      option('Two Star MAP', 4000, 'MAP', { category: '2-star' }),
    ]]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.equal(packages[0].stayResults[0].hotel?.hotelName, 'Three Star CP');
  assert.equal(packages[0].stayResults[0].hotel?.mealPlan, 'CP');
  assert.equal(packages[0].stayResults[0].hotel?.selectedCategory, 3);
  assert.equal(packages[0].stayResults[0].hotel?.categoryFallbackApplied, false);
});

test('a single valid MAP rate remains selectable for every group', () => {
  const packages = service().generate({
    routes: oneRoute(),
    hotelsByRoute: new Map([[1, [option('Only MAP Hotel', 6500, 'MAP')]]]),
    preferredCategories: [3],
    preferredMealPlanCode: 'MAP',
  });

  assert.ok(packages.slice(0, 4).every((pkg) => pkg.stayResults[0].state !== 'UNAVAILABLE'));
  assert.ok(packages.slice(0, 4).every((pkg) => pkg.stayResults[0].hotel?.mealPlan === 'MAP'));
});
