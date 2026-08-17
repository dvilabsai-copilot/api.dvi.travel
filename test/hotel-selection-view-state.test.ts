import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHotelSelectionState,
  resolveHotelRequiredRoutes,
} from '../src/modules/itineraries/utils/hotel-selection-view-state.util';

const routes = [
  { routeId: 10145, routeDate: '2026-08-12' },
  { routeId: 10146, routeDate: '2026-08-13' },
];

const selectedRow = (routeId: number, overrides: Record<string, unknown> = {}) => ({
  groupType: 1,
  itineraryRouteId: routeId,
  date: routeId === 10145 ? '2026-08-12' : '2026-08-13',
  provider: 'axisrooms',
  canonicalHotelId: 232,
  providerHotelCode: '435',
  hotelCode: '435',
  hotelName: 'THE ARBOUR RESORT',
  roomType: 'Club Rooms Non AC',
  mealPlan: 'CP',
  rateOptionId: `axis:435:${routeId}`,
  selectionId: routeId,
  selectionOrigin: 'USER_SELECTED',
  isSelected: true,
  pricePerNight: 5040,
  totalPrice: 5040,
  selectedPriceSnapshot: {
    provider: 'axisrooms',
    canonicalHotelId: 232,
    providerHotelCode: '435',
    rateOptionId: `axis:435:${routeId}`,
    basePricePerNight: 4200,
    hotelMarginPercentage: 20,
    hotelMarginAmount: 840,
    pricePerNight: 5040,
    totalPrice: 5040,
  },
  ...overrides,
});

test('builds a complete two-night authoritative group without recalculating its tab total', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 10080 }],
    rows: routes.map((route) => selectedRow(route.routeId)),
    requiredRoutes: routes,
  });

  assert.equal(state[0].selectionStatus, 'SELECTED');
  assert.equal(state[0].totalAmount, 10080);
  assert.deepEqual(state[0].routes.map((route) => route.selectionStatus), ['SELECTED', 'SELECTED']);
  assert.deepEqual(state[0].routes.map((route) => route.selected?.providerHotelCode), ['435', '435']);
  assert.equal(state[0].routes[0].selected?.canonicalHotelId, 232);
  assert.equal(state[0].routes[0].selected?.selectedPriceSnapshot?.hotelMarginAmount, 840);
});

test('marks a partial legacy two-night group unresolved even when a numeric total exists', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 5040 }],
    rows: [selectedRow(10145)],
    requiredRoutes: routes,
  });

  assert.equal(state[0].selectionStatus, 'UNRESOLVED');
  assert.deepEqual(state[0].routes.map((route) => route.selectionStatus), ['SELECTED', 'UNRESOLVED']);
  assert.equal(state[0].routes[1].selected, null);
});

test('returns explicit unavailable route state without exposing a fake selected object', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 0 }],
    rows: routes.map((route) => selectedRow(route.routeId, {
      selectionStatus: 'UNAVAILABLE',
      isSelected: true,
    })),
    requiredRoutes: routes,
  });

  assert.equal(state[0].selectionStatus, 'UNAVAILABLE');
  assert.ok(state[0].routes.every((route) => route.selectionStatus === 'UNAVAILABLE'));
  assert.ok(state[0].routes.every((route) => route.selected === null));
});

test('returns TBO stable selection identity separately from the fresh supplier token', () => {
  const bookingCode = '1313362!TB!1!TB!fresh-session!TB!N!TB!AFF!';
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 3, label: 'Recommended #3', totalAmount: 20951.95 }],
    rows: [selectedRow(10145, {
      groupType: 3,
      provider: 'tbo',
      canonicalHotelId: null,
      providerHotelCode: '1313362',
      hotelCode: '1313362',
      rateOptionId: bookingCode,
      bookingCode,
      searchReference: bookingCode,
      selectionKey: 'tbo:1313362:1',
    })],
    requiredRoutes: [routes[0]],
  });

  assert.equal(state[0].routes[0].selected?.selectionKey, 'tbo:1313362:1');
  assert.equal(state[0].routes[0].selected?.supplierBookingCode, bookingCode);
});

test('does not manufacture a TBO supplier booking token from a stable rate identity', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 3, label: 'Recommended #3', totalAmount: 20951.95 }],
    rows: [selectedRow(10145, {
      groupType: 3,
      provider: 'tbo',
      providerHotelCode: '1313362',
      rateOptionId: 'tbo:1313362:1',
      bookingCode: undefined,
      searchReference: undefined,
      selectionKey: 'tbo:1313362:1',
    })],
    requiredRoutes: [routes[0]],
  });

  assert.equal(state[0].routes[0].selected?.rateOptionId, 'tbo:1313362:1');
  assert.equal(state[0].routes[0].selected?.supplierBookingCode, null);
});

test('resolves hotel-required routes semantically before applying the night cap', () => {
  const required = resolveHotelRequiredRoutes([
    { routeId: 1, isTransit: true },
    { routeId: 2, hotelRequired: true },
    { routeId: 3, isActivityOnly: true },
    { routeId: 4, hotel_required: 1 },
    { routeId: 5, isDeparture: true },
  ], 2);

  assert.deepEqual(required.map((route) => route.routeId), [2, 4]);
});

test('returns an explicit unresolved route when no persisted selection exists', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 0 }],
    rows: [],
    requiredRoutes: [routes[0]],
  });

  assert.equal(state[0].selectionStatus, 'UNRESOLVED');
  assert.equal(state[0].routes[0].selectionStatus, 'UNRESOLVED');
  assert.equal(state[0].routes[0].selected, null);
});

test('keeps untouched recommendation groups isolated when one group selection changes', () => {
  const before = buildHotelSelectionState({
    tabs: [
      { groupType: 1, label: 'Recommended #1', totalAmount: 9000 },
      { groupType: 2, label: 'Recommended #2', totalAmount: 12000 },
    ],
    rows: [
      selectedRow(10145, { groupType: 1, canonicalHotelId: 111, providerHotelCode: '111', totalPrice: 4500 }),
      selectedRow(10146, { groupType: 1, canonicalHotelId: 111, providerHotelCode: '111', totalPrice: 4500 }),
      selectedRow(10145, { groupType: 2, canonicalHotelId: 222, providerHotelCode: '222', totalPrice: 6000 }),
      selectedRow(10146, { groupType: 2, canonicalHotelId: 222, providerHotelCode: '222', totalPrice: 6000 }),
    ],
    requiredRoutes: routes,
  });
  const after = buildHotelSelectionState({
    tabs: [
      { groupType: 1, label: 'Recommended #1', totalAmount: 11400 },
      { groupType: 2, label: 'Recommended #2', totalAmount: 12000 },
    ],
    rows: [
      selectedRow(10145, { groupType: 1, canonicalHotelId: 333, providerHotelCode: '333', totalPrice: 5700 }),
      selectedRow(10146, { groupType: 1, canonicalHotelId: 333, providerHotelCode: '333', totalPrice: 5700 }),
      selectedRow(10145, { groupType: 2, canonicalHotelId: 222, providerHotelCode: '222', totalPrice: 6000 }),
      selectedRow(10146, { groupType: 2, canonicalHotelId: 222, providerHotelCode: '222', totalPrice: 6000 }),
    ],
    requiredRoutes: routes,
  });

  assert.notDeepEqual(after[0], before[0]);
  assert.deepEqual(after[1], before[1]);
});

test('returns offline SPRISE payable pricing and margin snapshot without recalculation', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 5700 }],
    rows: [selectedRow(10145, {
      provider: 'offline',
      canonicalHotelId: 987,
      providerHotelCode: '987',
      hotelName: 'SPRISE MUNNAR RESORT & SPA',
      pricePerNight: 5700,
      totalPrice: 5700,
      selectedPriceSnapshot: {
        provider: 'offline',
        canonicalHotelId: 987,
        providerHotelCode: '987',
        rateOptionId: 'offline:987:marvellous-mountain-view:cp',
        basePricePerNight: 4750,
        hotelMarginPercentage: 20,
        hotelMarginAmount: 950,
        pricePerNight: 5700,
        totalPrice: 5700,
      },
    })],
    requiredRoutes: [routes[0]],
  });

  assert.equal(state[0].totalAmount, 5700);
  assert.equal(state[0].routes[0].selected?.pricePerNight, 5700);
  assert.equal(state[0].routes[0].selected?.selectedPriceSnapshot?.basePricePerNight, 4750);
  assert.equal(state[0].routes[0].selected?.selectedPriceSnapshot?.hotelMarginAmount, 950);
});

test('returns distinct STAAH canonical and supplier property identifiers', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 4, label: 'Recommended #4', totalAmount: 7200 }],
    rows: [selectedRow(10145, {
      groupType: 4,
      provider: 'staah',
      canonicalHotelId: 44596,
      providerHotelCode: 'STAAHTESTHOTELPROD',
      hotelCode: 'STAAHTESTHOTELPROD',
      totalPrice: 7200,
    })],
    requiredRoutes: [routes[0]],
  });

  const selected = state[0].routes[0].selected;
  assert.equal(selected?.canonicalHotelId, 44596);
  assert.equal(selected?.providerHotelCode, 'STAAHTESTHOTELPROD');
});

test('serializes the complete hard-reload selected-row contract', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 10080 }],
    rows: routes.map((route) => selectedRow(route.routeId)),
    requiredRoutes: routes,
  });
  const restored = JSON.parse(JSON.stringify({ hotelSelectionState: state }));

  assert.equal(restored.hotelSelectionState[0].routes.length, 2);
  assert.deepEqual(
    Object.keys(restored.hotelSelectionState[0].routes[0].selected).sort(),
    [
      'canonicalHotelId', 'hotelCode', 'hotelName', 'mealPlan', 'pricePerNight',
      'provider', 'providerHotelCode', 'rateOptionId', 'selectedPriceSnapshot',
      'selectionKey', 'supplierBookingCode', 'totalPrice', 'roomType',
    ].sort(),
  );
});

test('decodes persisted hotel display names for React hydration', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 5700 }],
    requiredRoutes: [{ routeId: 10145, routeDate: '2026-08-12' }],
    rows: [{
      groupType: 1,
      routeId: 10145,
      selectionOrigin: 'USER_SELECTED',
      provider: 'offline',
      hotelName: 'SPRISE MUNNAR RESORT &amp; SPA',
      selectedPriceSnapshot: JSON.stringify({
        hotelName: 'SPRISE MUNNAR RESORT &amp; SPA',
        totalPrice: 5700,
      }),
    }],
  });

  assert.equal(state[0].routes[0].selected?.hotelName, 'SPRISE MUNNAR RESORT & SPA');
  assert.equal(
    state[0].routes[0].selected?.selectedPriceSnapshot?.hotelName,
    'SPRISE MUNNAR RESORT & SPA',
  );
});
