import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';

test('route-scoped repair preserves populated Munnar input and repairs only empty Thekkady input', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const munnar = [{ hotelCode: 'MUNNAR-G1', provider: 'tbo', price: 1000 }];
  const thekkady = [{ hotelCode: 'THEKKADY-G1', provider: 'axisrooms', price: 1200 }];
  const repaired = service.buildRecommendationHotelsByRoute(
    new Map([[11275, munnar], [11277, thekkady]]),
    new Map([[11275, munnar], [11277, []]]),
  );

  assert.strictEqual(repaired.get(11275), munnar);
  assert.strictEqual(repaired.get(11277), thekkady);
  assert.deepEqual(repaired.get(11275), [{ hotelCode: 'MUNNAR-G1', provider: 'tbo', price: 1000 }]);
});

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

test('shared hotel inventory collapses duplicate visible supplier offers', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const inventory = service.buildSharedHotelInventory([
    { groupType: 1, itineraryRouteId: 11081, date: '2026-09-01', provider: 'tbo', hotelCode: '5004143', hotelName: 'Itsy Hotels Deluxe Inn', roomType: 'Economy Double Room,1 Queen Bed', mealPlan: 'CP', pricePerNight: 2916.7, rateOptionId: 'booking-a' },
    { groupType: 2, itineraryRouteId: 11081, date: '2026-09-01', provider: 'tbo', hotelCode: '5004143', hotelName: 'Itsy Hotels Deluxe Inn', roomType: 'Economy Double Room,1 Queen Bed', mealPlan: 'CP', pricePerNight: 2916.7, rateOptionId: 'booking-b' },
    { groupType: 3, itineraryRouteId: 11081, date: '2026-09-01', provider: 'tbo', hotelCode: '5004143', hotelName: 'Itsy Hotels Deluxe Inn', roomType: 'Economy Double Room,1 Queen Bed', mealPlan: 'CP', pricePerNight: 3000, rateOptionId: 'booking-c' },
  ]);

  assert.equal(inventory.length, 2);
  assert.deepEqual(inventory.map((row: any) => row.pricePerNight), [2916.7, 3000]);
});

test('group-neutral shared inventory strips recommendation-only metadata', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const inventory = service.buildSharedHotelInventory([{
    itineraryRouteId: 10,
    provider: 'staah', hotelCode: 'H1', hotelName: 'Hotel A', price: 100,
    isBookable: true, isSelectable: true,
    authoritativeRecommendation: true,
    autoSelectionStatus: 'AVAILABLE',
    autoSelectionCandidate: true,
    autoSelectionIdentity: { rateOptionId: 'suite-map' },
    autoSelectionFallbackFromGroup: 3,
    authoritativeStayKey: '10|2026-08-02|2026-08-04',
    authoritativeParentRouteId: 10,
    authoritativeRouteIds: [10, 11],
    authoritativeCheckInDate: '2026-08-02',
    authoritativeCheckOutDate: '2026-08-04',
    recommendationTabs: [{ groupType: 1, label: 'Recommended #1' }],
  }]);

  assert.equal(inventory.length, 1);
  for (const field of [
    'authoritativeRecommendation', 'autoSelectionStatus', 'autoSelectionCandidate',
    'autoSelectionIdentity', 'autoSelectionFallbackFromGroup',
    'authoritativeStayKey', 'authoritativeParentRouteId', 'authoritativeRouteIds',
    'authoritativeCheckInDate', 'authoritativeCheckOutDate', 'recommendationTabs',
  ]) assert.equal(Object.prototype.hasOwnProperty.call(inventory[0], field), false, field);
});

test('every recommendation pane receives the same complete route inventory', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const route = { itinerary_route_ID: 10, itinerary_route_date: '2026-08-19', next_visiting_location: 'Ooty' };
  const source = [
    { provider: 'tbo', hotelCode: 'H1', hotelName: 'Meadows Residency', category: '4*', price: 1000 },
    { provider: 'tbo', hotelCode: 'H2', hotelName: 'Ooty-Fern Hill', category: '4*', price: 1200 },
    { provider: 'tbo', hotelCode: 'H3', hotelName: 'Gem Park-Ooty', category: '4*', price: 1400 },
    { provider: 'tbo', hotelCode: 'H4', hotelName: 'Fortune Resort Sullivan Court', category: '4*', price: 1600 },
  ];
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[10, source]]),
    [route],
    [
      { groupType: 1, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: source[0] }] },
      { groupType: 2, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: source[1] }] },
      { groupType: 3, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: source[2] }] },
      { groupType: 4, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: source[3] }] },
    ],
  );

  const paneSets = packages.map((pkg: any) => pkg.hotels.map((hotel: any) => hotel.hotelCode));
  assert.deepEqual(paneSets, [
    ['H1', 'H2', 'H3', 'H4'],
    ['H1', 'H2', 'H3', 'H4'],
    ['H1', 'H2', 'H3', 'H4'],
    ['H1', 'H2', 'H3', 'H4'],
  ]);
  assert.deepEqual(packages.map((pkg: any) => pkg.hotels.filter((hotel: any) => hotel.autoSelectionCandidate).map((hotel: any) => hotel.hotelCode)), [
    ['H1'], ['H2'], ['H3'], ['H4'],
  ]);
});

test('group 3 reuses group 2 selected hotel when its route inventory is empty', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const selectedGroup2 = {
    provider: 'tbo', hotelCode: 'ALLEPPEY-G2', hotelName: 'Lake Canopy',
    roomType: 'The Creek', mealPlan: 'CP', price: 17250,
    extraBedRate: 1000, childWithoutBedRate: 500, rateOptionId: 'g2-rate',
  };
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[10, []]]),
    [{ itinerary_route_ID: 10, itinerary_route_date: '2026-08-19', next_visiting_location: 'Alleppey' }],
    [
      { groupType: 1, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
      { groupType: 2, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: selectedGroup2 }] },
      { groupType: 3, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
      { groupType: 4, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
    ],
  );

  const group3Hotel = packages[2].hotels[0];
  assert.equal(group3Hotel.hotelCode, 'ALLEPPEY-G2');
  assert.equal(group3Hotel.price, 17250);
  assert.equal(group3Hotel.extraBedRate, 1000);
  assert.equal(group3Hotel.childWithoutBedRate, 500);
  assert.equal(group3Hotel.autoSelectionStatus, 'AVAILABLE');
  assert.equal(group3Hotel.autoSelectionCandidate, true);
  assert.equal(group3Hotel.autoSelectionFallbackFromGroup, 2);
});

test('missing group 2 selection reuses group 1 without hiding route inventory', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const group1Hotel = {
    provider: 'tbo', hotelCode: 'COCHIN-G1', hotelName: 'Cochin Hotel',
    roomType: 'Deluxe Room', mealPlan: 'MAP', price: 5000,
    rateOptionId: 'cochin-g1-rate',
  };
  const alternateHotel = {
    provider: 'tbo', hotelCode: 'COCHIN-OTHER', hotelName: 'Other Cochin Hotel',
    roomType: 'Deluxe Room', mealPlan: 'MAP', price: 6500,
    rateOptionId: 'cochin-other-rate',
  };
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[10, [group1Hotel, alternateHotel]]]),
    [{ itinerary_route_ID: 10, itinerary_route_date: '2026-08-19', next_visiting_location: 'Cochin' }],
    [
      { groupType: 1, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: group1Hotel }] },
      { groupType: 2, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
      { groupType: 3, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: alternateHotel }] },
      { groupType: 4, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
    ],
  );

  assert.deepEqual(packages[1].hotels.map((hotel: any) => hotel.hotelCode), [
    'COCHIN-G1', 'COCHIN-OTHER',
  ]);
  const automatic = packages[1].hotels.find((hotel: any) => hotel.autoSelectionCandidate);
  assert.equal(automatic.hotelCode, 'COCHIN-G1');
  assert.equal(automatic.autoSelectionFallbackFromGroup, 1);
  assert.match(automatic.recommendationFallbackReason, /group 1/i);
});

test('unavailable current group selection falls back to the previous usable group', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const group2Hotel = {
    provider: 'axisrooms', hotelCode: 'COCHIN-G2', hotelName: 'Cochin Group 2 Hotel',
    roomType: 'Deluxe Room', mealPlan: 'MAP', price: 5200,
    rateOptionId: 'cochin-g2-rate', isSelectable: true, isBookable: true,
  };
  const unavailableGroup3Hotel = {
    provider: 'axisrooms', hotelCode: 'COCHIN-G3', hotelName: 'Stale Group 3 Hotel',
    roomType: 'Deluxe Room', mealPlan: 'MAP', price: 0,
    rateOptionId: 'cochin-g3-rate', availabilityStatus: 'UNAVAILABLE', isSelectable: false,
  };
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[10, [group2Hotel, unavailableGroup3Hotel]]]),
    [{ itinerary_route_ID: 10, itinerary_route_date: '2026-08-19', next_visiting_location: 'Cochin' }],
    [
      { groupType: 1, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
      { groupType: 2, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: group2Hotel }] },
      { groupType: 3, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: unavailableGroup3Hotel }] },
      { groupType: 4, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
    ],
  );

  const automatic = packages[2].hotels.find((hotel: any) => hotel.autoSelectionCandidate);
  assert.equal(automatic.hotelCode, 'COCHIN-G2');
  assert.equal(automatic.autoSelectionFallbackFromGroup, 2);
  assert.match(automatic.recommendationFallbackReason, /group 2/i);
});

test('zero-priced current group selection falls back to the previous payable group', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const group2Hotel = {
    provider: 'tbo', hotelCode: 'COCHIN-PAYABLE', hotelName: 'Payable Cochin Hotel',
    roomType: 'Deluxe Room', mealPlan: 'MAP', price: 5200,
  };
  const zeroPricedGroup3Hotel = {
    provider: 'axisrooms', hotelCode: 'COCHIN-ZERO', hotelName: 'Zero Rate Hotel',
    roomType: 'Deluxe Room', mealPlan: 'MAP', price: 0,
    availabilityStatus: 'AVAILABLE', isSelectable: true,
  };
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[10, [group2Hotel, zeroPricedGroup3Hotel]]]),
    [{ itinerary_route_ID: 10, itinerary_route_date: '2026-08-19', next_visiting_location: 'Cochin' }],
    [
      { groupType: 1, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
      { groupType: 2, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: group2Hotel }] },
      { groupType: 3, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: zeroPricedGroup3Hotel }] },
      { groupType: 4, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
    ],
  );

  const automatic = packages[2].hotels.find((hotel: any) => hotel.autoSelectionCandidate);
  assert.equal(automatic.hotelCode, 'COCHIN-PAYABLE');
  assert.equal(automatic.autoSelectionFallbackFromGroup, 2);
});

test('stale zero-priced inventory cannot block a usable previous-group fallback', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const group2Hotel = {
    provider: 'axisrooms', hotelCode: 'COCHIN-G2', hotelName: 'Cochin Group 2 Hotel',
    roomType: 'Royal', mealPlan: 'MAP', price: 5200, rateOptionId: 'cochin-g2-rate',
  };
  const staleGroup3Inventory = {
    provider: 'axisrooms', hotelCode: 'COCHIN-G3', hotelName: 'Dutch Manor',
    roomType: 'Premium Room', mealPlan: 'MAP', price: 0,
    availabilityStatus: 'UNAVAILABLE', isSelectable: true,
  };
  const payableGroup3Recommendation = {
    ...staleGroup3Inventory, price: 9100, availabilityStatus: 'AVAILABLE',
  };
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[10, [group2Hotel, staleGroup3Inventory]]]),
    [{ itinerary_route_ID: 10, itinerary_route_date: '2026-08-19', next_visiting_location: 'Cochin' }],
    [
      { groupType: 1, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
      { groupType: 2, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: group2Hotel }] },
      { groupType: 3, stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: payableGroup3Recommendation }] },
      { groupType: 4, stayResults: [{ parentRouteId: 10, state: 'UNAVAILABLE' }] },
    ],
  );

  const automatic = packages[2].hotels.find((hotel: any) => hotel.autoSelectionCandidate);
  assert.equal(automatic.hotelCode, 'COCHIN-G2');
  assert.equal(automatic.autoSelectionFallbackFromGroup, 2);
});

test('category filtering never removes a hotel from the shared inventory', async () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  service.prisma = {
    dvi_hotel: { findMany: async () => [] },
    dvi_hotel_amenities: { findMany: async () => [] },
  };
  service.logger = { debug: () => undefined, log: () => undefined, warn: () => undefined };

  const route = {
    itinerary_route_ID: 10,
    itinerary_route_date: '2026-08-19',
    next_visiting_location: 'Ooty',
  };
  const source = Array.from({ length: 11 }, (_, index) => ({
    provider: 'tbo',
    hotelCode: `H${index + 1}`,
    hotelName: `Hotel ${index + 1}`,
    category: index === 10 ? '3*' : '4*',
    price: 1000 + index * 100,
  }));
  const completeHotelsByRoute = new Map([[10, source]]);

  // Category 4 is allowed to narrow recommendation candidates only.
  const recommendationCandidates = await service.applyPlanPreferenceFilters(
    completeHotelsByRoute,
    [4],
    null,
    [],
  );
  assert.equal(recommendationCandidates.get(10)?.length, 10);

  const packages = service.generateSharedAvailabilityPackages(
    completeHotelsByRoute,
    [route],
    [1, 2, 3, 4].map((groupType) => ({
      groupType,
      stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: source[groupType - 1] }],
    })),
  );

  assert.deepEqual(
    packages.map((pkg: any) => pkg.hotels.map((hotel: any) => hotel.hotelCode)),
    [1, 2, 3, 4].map(() => source.map((hotel) => hotel.hotelCode)),
  );
});

test('recommendation metadata identifies the exact selected rate, not every nested rate', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const selected = {
    provider: 'staah',
    hotelId: 101,
    hotelCode: 'H1',
    rateOptionId: 'suite-map',
    roomId: 'suite',
    rateId: 'map-rate',
    mealPlan: 'MAP',
  };
  const source = [{
    provider: 'staah',
    hotelId: 101,
    hotelCode: 'H1',
    hotelName: 'Meadows Residency',
    rateOptionId: 'deluxe-cp',
    roomId: 'deluxe',
    rateId: 'cp-rate',
    mealPlan: 'CP',
    rateOptions: [
      { rateOptionId: 'deluxe-cp', roomId: 'deluxe', rateId: 'cp-rate', mealPlan: 'CP' },
      selected,
    ],
  }];
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[10, source]]),
    [{ itinerary_route_ID: 10 }],
    [{ groupType: 1, stayResults: [{ parentRouteId: 10, hotel: selected }] }],
  );

  assert.equal(packages[0].hotels[0].autoSelectionCandidate, true);
  assert.equal(packages[0].hotels[0].autoSelectionIdentity.provider, 'staah');
  assert.equal(packages[0].hotels[0].autoSelectionIdentity.canonicalHotelId, 101);
  assert.equal(packages[0].hotels[0].autoSelectionIdentity.rateOptionId, 'suite-map');
  assert.equal(packages[0].hotels[0].autoSelectionIdentity.roomId, 'suite');
  assert.equal(packages[0].hotels[0].autoSelectionIdentity.rateId, 'map-rate');
  assert.equal(packages[0].hotels[0].autoSelectionIdentity.mealPlan, 'MAP');
});

test('active category prefilter normalizes Budget and STD to two-star', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  assert.deepEqual(service.getHotelCategoryCandidates({ category: 'Budget' }), [2]);
  assert.deepEqual(service.getHotelCategoryCandidates({ category: 'STD' }), [2]);
});

test('continuous child route resolves the parent logical stay and carries authority metadata', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const parent = {
    provider: 'tbo', hotelId: 501, hotelCode: 'H-501', hotelName: 'Hotel A',
    rateOptionId: 'suite-map', roomId: 'suite', roomType: 'Suite', rateId: 'map-rate', mealPlan: 'MAP',
    price: 5000, totalStayPrice: 5000, isBookable: true, isSelectable: true,
  };
  const packages = service.generateSharedAvailabilityPackages(
    new Map([[101, []], [102, [{ ...parent, rateOptions: [{ ...parent }] }]]]),
    [
      { itinerary_route_ID: 101 },
      { itinerary_route_ID: 102 },
    ],
    [{
      groupType: 1,
      stayResults: [{
        parentRouteId: 101,
        routeIds: [101, 102],
        stayKey: '101|2026-08-02|2026-08-04',
        checkInDate: '2026-08-02',
        checkOutDate: '2026-08-04',
        state: 'SELECTED',
        hotel: { ...parent, routeId: 101, routeIds: [101, 102] },
      }],
    }],
  );
  const childRow = packages[0].hotels.find((hotel: any) => hotel.routeId === 102);
  assert.ok(childRow);
  assert.equal(childRow.autoSelectionCandidate, true);
  assert.equal(childRow.authoritativeParentRouteId, 101);
  assert.deepEqual(childRow.authoritativeRouteIds, [101, 102]);
  assert.equal(childRow.authoritativeStayKey, '101|2026-08-02|2026-08-04');
});

test('continuous stay authority resolves first, middle, and last route members', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const selected = {
    provider: 'tbo', hotelId: 501, hotelCode: 'H-501', hotelName: 'Hotel A',
    rateOptionId: 'a-map', roomId: 'suite', roomType: 'Suite', rateId: 'map-rate', mealPlan: 'MAP',
  };
  const packages = service.generateSharedAvailabilityPackages(
    new Map([
      [101, [{ ...selected }]],
      [102, [{ ...selected }]],
      [103, [{ ...selected }]],
    ]),
    [{ itinerary_route_ID: 101 }, { itinerary_route_ID: 102 }, { itinerary_route_ID: 103 }],
    [{ groupType: 1, stayResults: [{
      parentRouteId: 101, routeIds: [101, 102, 103], stayKey: '101|2026-08-02|2026-08-05',
      state: 'SELECTED', hotel: selected,
    }] }],
  );
  assert.deepEqual(packages[0].hotels.map((row: any) => row.authoritativeParentRouteId), [101, 101, 101]);
  assert.deepEqual(packages[0].hotels.map((row: any) => row.authoritativeRouteIds), [[101, 102, 103], [101, 102, 103], [101, 102, 103]]);
  assert.equal(packages[0].hotels.filter((row: any) => row.autoSelectionCandidate).length, 3);
});

test('response DTO preserves authoritative nested-rate metadata', async () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const persistedSnapshot = {
    provider: 'staah', hotelId: 101, hotelCode: 'H1', hotelName: 'Meadows Residency',
    rateOptionId: 'suite-map', roomId: 'suite', rateId: 'map-rate', roomType: 'Suite', mealPlan: 'MAP',
    totalPrice: 1200, pricePerNight: 1200, selectionOrigin: 'AUTO_SELECTED',
    authoritativeStayKey: '10|2026-08-19|2026-08-20', authoritativeParentRouteId: 10, authoritativeRouteIds: [10],
  };
  const fallbackModel = new Proxy({}, { get: () => async () => [] });
  service.prisma = new Proxy({
    dvi_itinerary_plan_details: { findFirst: async () => ({ hotel_rates_visibility: 1 }) },
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 0 }) },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{
        itinerary_plan_hotel_details_ID: 901, itinerary_route_id: 10, hotel_id: 101, group_type: 1,
        hotel_required: 1, hotel_code: 'H1', hotel_provider: 'staah', selected_rate_option_id: 'suite-map',
        selected_price_per_night: 1200, selected_total_price: 1200, selected_price_snapshot: JSON.stringify(persistedSnapshot),
      }],
    },
  }, { get: (target: any, property: string) => target[property] || fallbackModel });
  service.logger = { log: () => undefined, debug: () => undefined, warn: () => undefined };
  const parent = {
    itineraryRouteId: 10, routeId: 10,
    provider: 'staah', hotelId: 101, hotelCode: 'H1', hotelName: 'Meadows Residency',
    category: '4*', rateOptionId: 'deluxe-cp', roomId: 'deluxe', rateId: 'cp-rate', mealPlan: 'CP',
    price: 1000, rateOptions: [
      { rateOptionId: 'deluxe-cp', roomId: 'deluxe', rateId: 'cp-rate', mealPlan: 'CP', price: 1000 },
      { rateOptionId: 'suite-map', roomId: 'suite', rateId: 'map-rate', mealPlan: 'MAP', price: 1200 },
    ],
  };
  const selected = { ...parent, rateOptionId: 'suite-map', roomId: 'suite', rateId: 'map-rate', mealPlan: 'MAP', price: 1200 };
  const recommendationPackages: any[] = [{
    groupType: 1,
    label: 'Recommended #1',
    complete: true,
    hotels: [parent],
    stayResults: [{ parentRouteId: 10, state: 'SELECTED', hotel: selected, totalPrice: 1200 }],
    totalPrice: 1200,
  }];
  const availabilityPackages: any[] = [{
    groupType: 1,
    label: 'Recommended #1',
    hotels: [{ ...parent, authoritativeRecommendation: true, autoSelectionStatus: 'AVAILABLE', autoSelectionCandidate: true,
      autoSelectionIdentity: {
        provider: 'staah', canonicalHotelId: 101, providerHotelCode: 'H1', rateOptionId: 'suite-map',
        searchReference: '', bookingCode: '', roomId: 'suite', rateId: 'map-rate', mealPlan: 'MAP',
      } }],
  }];
  const response = await service.buildHotelDetailsResponse(
    'quote-1', 44, recommendationPackages, new Map([[10, [parent]]]), new Map(),
    [{ itinerary_route_ID: 10, itinerary_route_date: '2026-08-19', next_visiting_location: 'Ooty' }],
    1, availabilityPackages, false,
  );
  const liveRow = response.hotels?.find((row: any) => row.groupType === 1 && row.autoSelectionCandidate === true);
  assert.ok(liveRow);
  assert.equal(liveRow.authoritativeRecommendation, true);
  assert.equal(liveRow.autoSelectionCandidate, true);
  assert.equal(liveRow.autoSelectionIdentity.rateOptionId, 'suite-map');
  assert.equal(liveRow.autoSelectionIdentity.roomId, 'suite');
  assert.equal(liveRow.authoritativeStayKey, '10|2026-08-19|2026-08-20');
});
