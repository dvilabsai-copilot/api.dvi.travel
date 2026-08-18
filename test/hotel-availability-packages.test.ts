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
