import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectOfflineRouteNightlyRate,
  selectOfflineRoomRate,
} from '../src/modules/itineraries/services/offline-hotel-catalog.service';
import { buildHotelSelectionState } from '../src/modules/itineraries/utils/hotel-selection-view-state.util';

test('ROOM_RATE is authoritative and DOUBLE is only the fallback', () => {
  assert.equal(selectOfflineRoomRate({ ROOM_RATE: 3675, DOUBLE: 1500, SINGLE: 1200 }), 3675);
  assert.equal(selectOfflineRoomRate({ DOUBLE: 1800, SINGLE: 1200 }), 1800);
});

test('DVI20260891 route rows use each date rate while retaining room-count semantics', () => {
  const offer = {
    nightlyBase: [9000, 7500],
    nightlyMargin: [900, 750],
    nightlySell: [9900, 8250],
    roomCount: 5,
  };

  assert.deepEqual(
    selectOfflineRouteNightlyRate(offer, ['2026-08-31', '2026-09-01'], '2026-08-31'),
    { index: 0, baseAmount: 9000, marginAmount: 900, sellAmount: 9900, basePricePerNight: 1800 },
  );
  assert.deepEqual(
    selectOfflineRouteNightlyRate(offer, ['2026-08-31', '2026-09-01'], '2026-09-01'),
    { index: 1, baseAmount: 7500, marginAmount: 750, sellAmount: 8250, basePricePerNight: 1500 },
  );
});

test('continuous offline selection projects the matching night for 2-Sep', () => {
  const nightlyRates = [
    { date: '2026-08-31', baseAmount: 9000, marginPercentage: 10, marginAmount: 900, sellAmount: 9900 },
    { date: '2026-09-01', baseAmount: 7500, marginPercentage: 10, marginAmount: 750, sellAmount: 8250 },
    { date: '2026-09-02', baseAmount: 18375, marginPercentage: 10, marginAmount: 1837.5, sellAmount: 20212.5 },
  ];
  const rows = [
    {
      groupType: 1,
      itineraryRouteId: 11046,
      date: '2026-09-01',
      provider: 'offline',
      hotelCode: '277',
      hotelName: 'MAMALLA HERITAGE',
      roomType: 'Standard / Deluxe',
      mealPlan: 'CP',
      isSelected: true,
      selectionOrigin: 'AUTO_SELECTED',
      completeStayBookable: true,
      completeStayRouteIds: [11045, 11046, 11047],
      nightlyRates,
      selectedPriceSnapshot: {
        provider: 'offline',
        hotelCode: '277',
        hotelName: 'MAMALLA HERITAGE',
        roomType: 'Standard / Deluxe',
        mealPlan: 'CP',
        baseTotalPrice: 7500,
        basePricePerNight: 1500,
        totalRooms: 5,
        extraBedAmount: 950,
        childWithBedAmount: 1900,
        childWithoutBedAmount: 1980,
        hotelMarginPercentage: 10,
      },
    },
  ];

  const state = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 0 }],
    rows,
    requiredRoutes: [
      { routeId: 11045, routeDate: '2026-08-31' },
      { routeId: 11046, routeDate: '2026-09-01' },
      { routeId: 11047, routeDate: '2026-09-02' },
    ],
  });

  const route = state[0].routes.find((item) => item.routeId === 11047);
  assert.equal(route?.selected?.selectedPriceSnapshot?.baseTotalPrice, 18375);
  assert.equal(route?.selected?.totalPrice, 25525.5);
});
