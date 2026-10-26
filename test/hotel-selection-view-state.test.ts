import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHotelSelectionState,
  resolveHotelRequiredRoutes,
  synchronizeHotelTabTotals,
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

test('DVI20260891 aligns hotelTabs with hotelSelectionState and deduplicates Day 1/2', () => {
  const dviRoutes = [
    { routeId: 1, routeDate: '2026-08-31' },
    { routeId: 2, routeDate: '2026-09-01' },
    { routeId: 3, routeDate: '2026-09-02' },
    { routeId: 4, routeDate: '2026-09-03' },
  ];
  const rows = [
    selectedRow(1, { canonicalHotelId: 10, hotelName: 'MAMALLA HERITAGE', selectionKey: 'offline:10:cp', totalPrice: 60637.5, selectedPriceSnapshot: { provider: 'offline', canonicalHotelId: 10, rateOptionId: 'offline:10:cp', totalPrice: 60637.5, pricePerNight: 60637.5 } }),
    selectedRow(2, { canonicalHotelId: 10, hotelName: 'MAMALLA HERITAGE', selectionKey: 'offline:10:cp', totalPrice: 60637.5, selectedPriceSnapshot: { provider: 'offline', canonicalHotelId: 10, rateOptionId: 'offline:10:cp', totalPrice: 60637.5, pricePerNight: 60637.5 } }),
    selectedRow(3, { canonicalHotelId: 20, hotelName: 'MGM Beach Resorts', selectionKey: 'tbo:mgm:deluxe:cp', totalPrice: 871765.73, selectedPriceSnapshot: { provider: 'tbo', canonicalHotelId: 20, providerHotelCode: 'mgm', rateOptionId: 'tbo:mgm:deluxe:cp', totalPrice: 871765.73, pricePerNight: 871765.73 } }),
    selectedRow(4, { canonicalHotelId: 30, hotelName: 'GREEN PALACE', selectionKey: 'offline:30:cp', totalPrice: 20900, selectedPriceSnapshot: { provider: 'offline', canonicalHotelId: 30, rateOptionId: 'offline:30:cp', totalPrice: 20900, pricePerNight: 20900 } }),
  ];
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 81537.5 }],
    rows,
    requiredRoutes: dviRoutes,
  });
  const tabs = synchronizeHotelTabTotals(
    [{ groupType: 1, label: 'Recommended #1', totalAmount: 81537.5 }],
    state,
  );

  assert.equal(state[0].routes[2].selected?.hotelName, 'MGM Beach Resorts');
  assert.equal(state[0].totalAmount, 953303.23);
  assert.equal(tabs[0].totalAmount, 953303.23);
});

test('route-night offline MAP is included for each physical night', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 4, label: 'Recommended #4', totalAmount: 9607.5 }],
    rows: [1, 2, 3].map((routeId) => selectedRow(routeId, {
      groupType: 4,
      provider: 'offline',
      selectionKey: 'offline:lake-forest:deluxe:map',
      totalPrice: 9607.5,
      selectedPriceSnapshot: {
        provider: 'offline',
        pricingScope: 'ROUTE_NIGHT',
        selectionKey: 'offline:lake-forest:deluxe:map',
        baseTotalPrice: 9150,
        hotelMarginPercentage: 5,
        mealPlanBreakdown: { totalMealPlanCost: 3900.6 },
        nightlyRates: [{
          date: routeId === 1 ? '2026-08-12' : routeId === 2 ? '2026-08-13' : '2026-08-14',
          mealPlanBreakdown: { totalMealPlanCost: 3900.6 },
        }],
      },
    })),
    requiredRoutes: [
      { routeId: 1, routeDate: '2026-08-12' },
      { routeId: 2, routeDate: '2026-08-13' },
      { routeId: 3, routeDate: '2026-08-14' },
    ],
  });

  assert.deepEqual(
    state[0].routes.map((route) => route.selected?.selectedTotalPrice),
    [13508.1, 13508.1, 13508.1],
  );
  assert.equal(state[0].totalAmount, 40524.3);
});

test('TBO MAP fallback dinner is included in each projected route night', () => {
  const tboSnapshot = {
    provider: 'tbo',
    providerHotelCode: '1089728',
    hotelCode: '1089728',
    hotelName: 'Ambady Estate',
    roomType: 'Luxury Cottage',
    mealPlan: 'MAP',
    roomCount: 2,
    totalRoomCost: 28200.62,
    baseTotalPrice: 28200.62,
    hotelMarginPercentage: 5,
    tboMapFallbackApplied: true,
    tboMapFallbackDinnerRate: 900,
    tboMapFallbackDinnerPerNight: 5400,
    tboMapFallbackDinnerTotal: 16200,
    nightlyRates: [
      { date: '2026-08-12', baseAmount: 28200.62 },
      { date: '2026-08-13', baseAmount: 28200.62 },
      { date: '2026-08-14', baseAmount: 28200.62 },
    ],
  };
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 2, label: 'Recommended #2', totalAmount: 88831.95 }],
    rows: [{
      groupType: 2,
      itineraryRouteId: 10145,
      date: '2026-08-12',
      provider: 'tbo',
      providerHotelCode: '1089728',
      hotelCode: '1089728',
      hotelName: 'Ambady Estate',
      roomType: 'Luxury Cottage',
      mealPlan: 'MAP',
      selectionId: 1,
      selectionOrigin: 'AUTO_SELECTED',
      isSelected: true,
      completeStayBookable: true,
      completeStayRouteIds: [10145, 10146, 10147],
      selectedPriceSnapshot: tboSnapshot,
    }],
    requiredRoutes: [
      { routeId: 10145, routeDate: '2026-08-12' },
      { routeId: 10146, routeDate: '2026-08-13' },
      { routeId: 10147, routeDate: '2026-08-14' },
    ],
  });

  assert.deepEqual(
    state[0].routes.map((route) => route.selected?.pricePerNight),
    [35010.65, 35010.65, 35010.65],
  );
  assert.equal(state[0].routes[0].selected?.selectedPriceSnapshot?.hotelMealPlanCost, 5400);
  assert.equal(state[0].routes[0].selected?.selectedPriceSnapshot?.hotelMarginBaseAmount, 33600.62);
  assert.equal(state[0].routes[0].selected?.selectedPriceSnapshot?.hotelMarginAmount, 1410.03);
  assert.equal(state[0].totalAmount, 105031.95);
});

test('DVI20260891 projects a complete MGM stay through Day 3 without double counting it', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 41112.5 }],
    rows: [
      selectedRow(11045, {
        groupType: 1,
        provider: 'offline',
        canonicalHotelId: 277,
        hotelName: 'MAMALLA HERITAGE',
        completeStayBookable: true,
        completeStayRouteIds: [11045, 11046, 11047],
        selectionKey: 'offline:277:cp:2026-08-31:2026-09-03',
        totalPrice: 20212.5,
        selectedPriceSnapshot: {
          provider: 'offline',
          canonicalHotelId: 277,
          hotelName: 'MAMALLA HERITAGE',
          rateOptionId: 'offline:277:733:445:2026-08-31:2026-09-03',
          totalPrice: 20212.5,
          pricePerNight: 20212.5,
        },
      }),
      selectedRow(11048, {
        groupType: 1,
        provider: 'offline',
        canonicalHotelId: 315,
        hotelName: 'GREEN PALACE',
        selectionKey: 'offline:315:cp',
        totalPrice: 20900,
        selectedPriceSnapshot: {
          provider: 'offline', canonicalHotelId: 315, hotelName: 'GREEN PALACE',
          rateOptionId: 'offline:315:cp', totalPrice: 20900, pricePerNight: 20900,
        },
      }),
    ],
    requiredRoutes: [
      { routeId: 11045, routeDate: '2026-08-31' },
      { routeId: 11046, routeDate: '2026-09-01' },
      { routeId: 11047, routeDate: '2026-09-02' },
      { routeId: 11048, routeDate: '2026-09-03' },
    ],
  });

  assert.deepEqual(state[0].routes.map((route) => route.selectionStatus), [
    'SELECTED', 'SELECTED', 'SELECTED', 'SELECTED',
  ]);
  assert.deepEqual(state[0].routes.slice(0, 3).map((route) => route.selected?.hotelName), [
    'MAMALLA HERITAGE', 'MAMALLA HERITAGE', 'MAMALLA HERITAGE',
  ]);
  assert.equal(state[0].totalAmount, 41112.5);
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

test('keeps nightly route payable separate from the full logical-stay total', () => {
  const nightly = (date: string) => ({
    date,
    baseAmount: 8008.17,
    sellAmount: 8808.99,
    pricePerNight: 8808.99,
  });
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 17617.98 }],
    rows: [{
      ...selectedRow(10145, {
        provider: 'tbo',
        canonicalHotelId: 999,
        hotelName: 'Hotel Surguru',
        selectionOrigin: 'AUTO_SELECTED',
        completeStayBookable: true,
        completeStayRouteIds: [10145, 10146],
        selectedPriceSnapshot: {
          provider: 'tbo',
          roomCount: 1,
          baseTotalPrice: 8008.17,
          hotelMarginPercentage: 10,
          pricePerNight: 8808.99,
          totalPrice: 8808.99,
          nightlyRates: [nightly('2026-08-12'), nightly('2026-08-13')],
        },
      }),
    }],
    requiredRoutes: routes,
  });

  assert.deepEqual(state[0].routes.map((route) => route.selected?.pricePerNight), [8808.99, 8808.99]);
  assert.equal(state[0].routes[0].selected?.selectedTotalPrice, 17617.98);
  assert.equal(state[0].totalAmount, 17617.98);
});

test('rebuilds a continuous TBO package total from payable nightly room totals', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 11807.04 }],
    rows: [{
      groupType: 1,
      itineraryRouteId: 24774,
      date: '2026-10-22',
      provider: 'tbo',
      providerHotelCode: '1092990',
      hotelCode: '1092990',
      hotelName: 'Taj Mahal Hotel Abids',
      roomType: 'Executive Room',
      mealPlan: 'CP',
      isSelected: true,
      selectionOrigin: 'AUTO_SELECTED',
      authoritativeRouteIds: [24774, 24775],
      selectedPriceSnapshot: {
        provider: 'tbo',
        roomCount: 2,
        totalRoomCost: 5244.8,
        baseTotalPrice: 5244.8,
        hotelMarginPercentage: 5,
        nightlyRates: [
          { date: '2026-10-22', baseAmount: 5244.8 },
          { date: '2026-10-23', baseAmount: 5244.8 },
        ],
      },
    }, {
      groupType: 1,
      itineraryRouteId: 24776,
      date: '2026-10-24',
      provider: 'offline',
      hotelId: 523,
      hotelCode: 'DVIHTL418426',
      hotelName: 'Raghavendra Grand',
      roomType: 'Deluxe double',
      mealPlan: 'CP',
      isSelected: true,
      selectionOrigin: 'AUTO_SELECTED',
      totalPrice: 6300,
      selectedPriceSnapshot: { provider: 'offline', totalRoomCost: 6000, hotelMarginPercentage: 5 },
    }],
    requiredRoutes: [
      { routeId: 24774, routeDate: '2026-10-22' },
      { routeId: 24775, routeDate: '2026-10-23' },
      { routeId: 24776, routeDate: '2026-10-24' },
    ],
  });

  assert.equal(state[0].totalAmount, 17314.08);
  assert.equal(state[0].routes[0].selected?.pricePerNight, 5507.04);
  assert.equal(state[0].routes[1].selected?.pricePerNight, 5507.04);
  assert.equal(state[0].routes[0].selected?.selectedTotalPrice, 11014.08);
});

test('does not treat an empty persisted placeholder as a selected hotel', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 2, label: 'Recommended #2', totalAmount: 100 }],
    rows: [{
      groupType: 2, itineraryRouteId: 10145, date: '2026-08-12', selectionId: 21918,
      isSelected: false, hotelId: 0, hotelName: '', provider: null,
    }],
    requiredRoutes: [{ routeId: 10145, routeDate: '2026-08-12' }],
  });

  assert.equal(state[0].routes[0].selectionStatus, 'UNRESOLVED');
  assert.equal(state[0].routes[0].selected, null);
});

test('marks a selected row unavailable when only its persisted snapshot has the status', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 3710 }],
    rows: [{
      groupType: 1, itineraryRouteId: 10145, date: '2026-08-12',
      provider: 'axisrooms', hotelId: 232, hotelCode: 'AX_DVI_HOTEL_232',
      hotelName: 'THE ARBOUR RESORT', roomType: 'Club room A/C', mealPlan: 'CP',
      selectionOrigin: 'USER_SELECTED', selectionId: 28929,
      selectionStatus: 'AVAILABLE',
      selectedPriceSnapshot: {
        hotelName: 'THE ARBOUR RESORT',
        availabilityStatus: 'UNAVAILABLE',
      },
    }],
    requiredRoutes: [{ routeId: 10145, routeDate: '2026-08-12' }],
  });

  assert.equal(state[0].routes[0].selectionStatus, 'UNAVAILABLE');
  assert.equal(state[0].routes[0].selected?.hotelName, 'THE ARBOUR RESORT');
});

test('canonical room pricing wins over stale nightly baseAmount', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 40068 }],
    rows: [{
      groupType: 1, itineraryRouteId: 11326, date: '2026-09-03', provider: 'axisrooms',
      hotelId: 232, hotelCode: 'AURUM', hotelName: 'AURUM RESORT', roomType: 'Garden Cottage',
      mealPlan: 'CP', isSelected: true, selectionOrigin: 'AUTO_SELECTED',
      selectedPriceSnapshot: {
        provider: 'axisrooms', roomRate: 6800, roomCount: 2, totalRoomCost: 13600,
        baseTotalPrice: 12100, extraBedAmount: 3500, childWithBedAmount: 1000,
        childWithoutBedAmount: 800, hotelMarginPercentage: 6,
        nightlyRates: [{ date: '2026-09-03', baseAmount: 12100, sellAmount: 12100 }],
      },
    }],
    requiredRoutes: [{ routeId: 11326, routeDate: '2026-09-03' }],
  });

  assert.equal(state[0].routes[0].selected?.totalPrice, 20034);
  assert.equal(state[0].routes[0].selected?.selectedPriceSnapshot?.totalRoomCost, 13600);
});

test('legacy continuous offline snapshot projects per-night room and supplement pricing', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 11440 }],
    rows: [{
      groupType: 1,
      itineraryRouteId: 11322,
      date: '2026-09-05',
      provider: 'offline',
      hotelId: 439,
      hotelCode: '439',
      hotelName: 'JUNGLE PARK RESORT',
      roomType: 'Jungle View Deluxe',
      mealPlan: 'CP',
      isSelected: true,
      selectionOrigin: 'AUTO_SELECTED',
      completeStayBookable: true,
      completeStayRouteIds: [11322, 11323],
      selectedPriceSnapshot: {
        provider: 'offline',
        roomRate: 3600,
        roomCount: 1,
        totalRoomCost: 2000,
        baseTotalPrice: 2000,
        extraBedCount: 1,
        extraBedRate: 1000,
        extraBedAmount: 2000,
        childWithBedCount: 0,
        childWithBedRate: 1000,
        childWithBedAmount: 0,
        childWithoutBedCount: 1,
        childWithoutBedRate: 600,
        childWithoutBedAmount: 1200,
        hotelMarginPercentage: 10,
        pricePerNight: 7480,
        totalPrice: 5720,
        nightlyRates: [
          { date: '2026-09-05', baseAmount: 3600, marginPercentage: 10, marginAmount: 360, sellAmount: 3960 },
          { date: '2026-09-06', baseAmount: 3600, marginPercentage: 10, marginAmount: 360, sellAmount: 3960 },
        ],
      },
    }],
    requiredRoutes: [
      { routeId: 11322, routeDate: '2026-09-05' },
      { routeId: 11323, routeDate: '2026-09-06' },
    ],
  });

  for (const route of state[0].routes) {
    assert.equal(route.selected?.pricePerNight, 5720);
    assert.equal(route.selected?.totalPrice, 5720);
    assert.equal(route.selected?.selectedPriceSnapshot?.roomRate, 3600);
    assert.equal(route.selected?.selectedPriceSnapshot?.totalRoomCost, 3600);
    assert.equal(route.selected?.selectedPriceSnapshot?.extraBedAmount, 1000);
    assert.equal(route.selected?.selectedPriceSnapshot?.childWithoutBedAmount, 600);
    assert.equal(route.selected?.selectedPriceSnapshot?.hotelMarginBaseAmount, 5200);
    assert.equal(route.selected?.selectedPriceSnapshot?.hotelMarginAmount, 520);
  }
});

test('legacy continuous offline MAP projects the meal total per physical night', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 4, label: 'Recommended #4', totalAmount: 31201.8 }],
    rows: [{
      groupType: 4,
      itineraryRouteId: 25603,
      date: '2026-10-25',
      provider: 'offline',
      canonicalHotelId: 148,
      providerHotelCode: '148',
      hotelCode: '148',
      hotelName: 'SHOLA CROWN RESORT',
      roomType: 'King Bed',
      mealPlan: 'MAP',
      mealPlanBreakdown: { totalMealPlanCost: 14401.8 },
      hotelMealPlanCost: 14401.8,
      totalHotelMealPlanCost: 14401.8,
      isSelected: true,
      selectionOrigin: 'AUTO_SELECTED',
      completeStayBookable: true,
      completeStayRouteIds: [25603, 25604, 25605],
      selectionKey: 'offline:148:208:7:2026-10-25:2026-10-28',
      selectedPriceSnapshot: {
        provider: 'offline',
        roomCount: 2,
        totalRoomCost: 13500,
        baseTotalPrice: 13500,
        extraBedCount: 1,
        extraBedRate: 1500,
        extraBedAmount: 1500,
        childWithoutBedCount: 1,
        childWithoutBedRate: 1000,
        childWithoutBedAmount: 1000,
        hotelMealPlanCost: 14401.8,
        totalHotelMealPlanCost: 14401.8,
        hotelMarginPercentage: 5,
        totalPrice: 16800,
        nightlyRates: [
          { date: '2026-10-25', baseAmount: 13500, marginAmount: 675, sellAmount: 14175 },
          { date: '2026-10-26', baseAmount: 13500, marginAmount: 675, sellAmount: 14175 },
          { date: '2026-10-27', baseAmount: 13500, marginAmount: 675, sellAmount: 14175 },
        ],
      },
    }],
    requiredRoutes: [
      { routeId: 25603, routeDate: '2026-10-25' },
      { routeId: 25604, routeDate: '2026-10-26' },
      { routeId: 25605, routeDate: '2026-10-27' },
    ],
  });

  assert.deepEqual(
    state[0].routes.map((route) => route.selected?.selectedTotalPrice),
    [21600.6, 21600.6, 21600.6],
  );
  assert.equal(state[0].totalAmount, 64801.8);
  assert.equal(state[0].routes[0].selected?.hotelMarginBaseAmount, 20800.6);
  assert.equal(state[0].routes[0].selected?.hotelMarginAmount, 800);
});

test('uses nightly offline MAP charges for rows and recommendation totals', () => {
  const nightlyMealPlanBreakdown = ['2026-12-31', '2027-01-01', '2027-01-02'].map((date) => ({
    date,
    totalMealPlanCost: 6000,
    totalDinnerCost: 6000,
  }));
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 2, label: 'Recommended #2', totalAmount: 136080 }],
    rows: [{
      groupType: 2,
      itineraryRouteId: 25689,
      date: '2026-12-31',
      provider: 'offline',
      hotelCode: '405',
      hotelName: 'KISHKINDA HERITAGE RESORT',
      roomType: 'COTTAGE',
      mealPlan: 'MAP',
      isSelected: true,
      selectionOrigin: 'AUTO_SELECTED',
      completeStayBookable: true,
      completeStayRouteIds: [25689, 25690, 25691],
      selectionKey: 'offline:405:cottage:map:2026-12-31:2027-01-03',
      selectedPriceSnapshot: {
        provider: 'offline',
        roomCount: 5,
        totalRoomCost: 27000,
        baseTotalPrice: 27000,
        hotelMealPlanCost: 18000,
        totalHotelMealPlanCost: 18000,
        mealPlanBreakdown: { totalMealPlanCost: 18000, totalDinnerCost: 18000 },
        nightlyMealPlanBreakdown,
        hotelMarginPercentage: 8,
        nightlyRates: [
          { date: '2026-12-31', baseAmount: 27000 },
          { date: '2027-01-01', baseAmount: 24500 },
          { date: '2027-01-02', baseAmount: 24500 },
        ],
      },
    }],
    requiredRoutes: [
      { routeId: 25689, routeDate: '2026-12-31' },
      { routeId: 25690, routeDate: '2027-01-01' },
      { routeId: 25691, routeDate: '2027-01-02' },
    ],
  });

  assert.deepEqual(
    state[0].routes.map((route) => route.selected?.selectedTotalPrice),
    [35160, 32460, 32460],
  );
  assert.equal(state[0].totalAmount, 100080);
});

test('projects one persisted continuous-stay selection to every authoritative route', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 8140 }],
    rows: [{
      groupType: 1,
      itineraryRouteId: 11285,
      date: '2026-09-01',
      provider: 'axisrooms',
      hotelCode: '435',
      hotelName: 'CLOUDS VALLEY',
      roomType: 'Valley View Double',
      mealPlan: 'CP',
      isSelected: true,
      selectionOrigin: 'AUTO_SELECTED',
      selectedPriceSnapshot: JSON.stringify({
        provider: 'axisrooms',
        hotelCode: '435',
        hotelName: 'CLOUDS VALLEY',
        roomType: 'Valley View Double',
        mealPlan: 'CP',
        authoritativeStayKey: '11285|2026-09-01|2026-09-03',
        authoritativeParentRouteId: 11285,
        authoritativeRouteIds: [11285, 11286],
        authoritativeCheckInDate: '2026-09-01',
        authoritativeCheckOutDate: '2026-09-03',
        totalRooms: 1,
        hotelMarginPercentage: 0,
        nightlyRates: [
          { date: '2026-09-01', baseAmount: 3960, sellAmount: 3960 },
          { date: '2026-09-02', baseAmount: 4180, sellAmount: 4180 },
        ],
        baseTotalPrice: 3960,
        pricePerNight: 3960,
        totalPrice: 8140,
      }),
    }],
    requiredRoutes: [
      { routeId: 11285, routeDate: '2026-09-01' },
      { routeId: 11286, routeDate: '2026-09-02' },
    ],
  });

  assert.deepEqual(state[0].routes.map((route) => route.selectionStatus), ['SELECTED', 'SELECTED']);
  assert.deepEqual(state[0].routes.map((route) => route.selected?.hotelName), ['CLOUDS VALLEY', 'CLOUDS VALLEY']);
  assert.equal(state[0].routes[1].selected?.selectedPriceSnapshot?.baseTotalPrice, 4180);
  assert.equal(state[0].routes[1].selected?.totalPrice, 4180);
});

test('returns explicit unavailable route state while exposing the persisted manual identity', () => {
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
  assert.ok(state[0].routes.every((route) => route.selected?.hotelName === 'THE ARBOUR RESORT'));
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
      'canonicalHotelId', 'hotelCode', 'hotelMarginAmount', 'hotelMarginBaseAmount', 'hotelMarginPercentage', 'hotelName', 'mealPlan', 'pricePerNight',
      'provider', 'providerHotelCode', 'rateOptionId', 'selectedPriceSnapshot',
      'selectionKey', 'supplierBookingCode', 'totalPrice', 'roomType',
      'roomRate', 'totalRoomCost', 'selectedPricePerNight', 'selectedTotalPrice',
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

test('projects legacy selected snapshots to payable pricing for hard reload', () => {
  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 3025 }],
    requiredRoutes: [{ routeId: 10145, routeDate: '2026-08-12' }],
    rows: [{
      groupType: 1,
      routeId: 10145,
      selectionOrigin: 'AUTO_SELECTED',
      isSelected: true,
      provider: 'offline',
      hotelName: 'The Whispering Meadows',
      totalPrice: 2750,
      selectedPriceSnapshot: JSON.stringify({
        provider: 'offline',
        hotelName: 'The Whispering Meadows',
        basePricePerNight: 2750,
        baseTotalPrice: 2750,
        hotelMarginPercentage: 10,
        pricePerNight: 2750,
        totalPrice: 2750,
      }),
    }],
  });

  const selected = state[0].routes[0].selected;
  assert.equal(selected?.pricePerNight, 3025);
  assert.equal(selected?.totalPrice, 3025);
  assert.equal(selected?.selectedPriceSnapshot?.pricePerNight, 3025);
  assert.equal(selected?.selectedPriceSnapshot?.totalPrice, 3025);
});
