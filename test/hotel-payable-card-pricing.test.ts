import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateHotelRouteNightPayable,
  projectHotelPayablePricing,
  resolveStoredHotelPayablePricing,
} from '../src/modules/itineraries/utils/hotel-payable-pricing.util';
import {
  decorateHotelCardPricing,
  hotelCardPropertyKey,
} from '../src/modules/itineraries/utils/hotel-card-pricing.util';
import { resolveHotelOccupancyPricing } from '../src/modules/itineraries/utils/hotel-selection-pricing.util';
import { buildHotelSelectionState } from '../src/modules/itineraries/utils/hotel-selection-view-state.util';

test('continuous-stay route-night payable uses room and supplement components', () => {
  assert.equal(calculateHotelRouteNightPayable({
    marginBaseAmount: 6800 + 3500 + 800,
    marginPercentage: 6,
    taxAmount: 0,
  }), 11766);
});

test('multi-room day price is the complete occupancy-inclusive selected price', () => {
  const pricing = resolveHotelOccupancyPricing({
    rates: { SINGLE: 6800, DOUBLE: 6800, EXTRABED: 3500, CHILD_WITH_BED: 1000, CHILD_WITHOUT_BED: 800 },
    roomCount: 3,
    adultCount: 6,
    extraBedCount: 0,
    childWithBedCount: 3,
    childWithoutBedCount: 1,
    marginPercentage: 6,
  });

  assert.equal(pricing.baseTotalPrice, 20400);
  assert.equal(pricing.hotelMarginBaseAmount, 24200);
  assert.equal(pricing.hotelMarginAmount, 1452);
  assert.equal(pricing.totalPrice, 25652);
});

test('Axis base 4200 projects once to the same payable 5040 used by preview and persistence', () => {
  const projected = projectHotelPayablePricing({
    provider: 'axisrooms',
    canonicalHotelId: 232,
    hotelCode: '232',
    pricePerNight: 4200,
    totalPrice: 4200,
  }, 20);

  assert.equal(projected.basePricePerNight, 4200);
  assert.equal(projected.hotelMarginAmount, 840);
  assert.equal(projected.pricePerNight, 5040);
  assert.equal(projected.totalPrice, 5040);
  assert.equal(projected.amountIncludesHotelMargin, true);
  assert.equal(projectHotelPayablePricing(projected, 20).totalPrice, 5040);
});

test('nested supplier options retain the idempotency marker after projection', () => {
  const projected = projectHotelPayablePricing({
    provider: 'hobse',
    hotelCode: 'ABC',
    baseTotalPrice: 4020,
    totalPrice: 4020,
    rateOptions: [{
      rateOptionId: 'hobse-rate-1',
      baseTotalPrice: 4020,
      totalPrice: 4020,
    }],
  }, 10);

  const nested = projected.rateOptions[0];
  assert.equal(nested.totalPrice, 4422);
  assert.equal(nested.baseTotalPrice, 4020);
  assert.equal(nested.amountIncludesHotelMargin, true);
  assert.equal(projectHotelPayablePricing(projected, 10).rateOptions[0].totalPrice, 4422);
});

test('legacy persisted row exposes margin-inclusive payable total', () => {
  const pricing = resolveStoredHotelPayablePricing({
    storedTotal: 2750,
    baseTotal: 2750,
    marginAmount: 275,
    marginPercentage: 10,
  });

  assert.deepEqual(pricing, {
    baseTotal: 2750,
    marginAmount: 275,
    payableTotal: 3025,
    marginPercentage: 10,
  });
  assert.equal(resolveStoredHotelPayablePricing({
    storedTotal: 3025,
    baseTotal: 2750,
    marginAmount: 275,
    marginPercentage: 10,
  }).payableTotal, 3025);

  const correctedComponentPricing = resolveStoredHotelPayablePricing({
    storedTotal: 8774,
    baseTotal: 3200 + 1500,
    marginPercentage: 7,
    taxAmount: 0,
    preferCalculatedTotal: true,
  });
  assert.equal(correctedComponentPricing.marginAmount, 329);
  assert.equal(correctedComponentPricing.payableTotal, 5029);

  assert.equal(resolveStoredHotelPayablePricing({
    storedTotal: 8774,
    baseTotal: 4700,
    marginPercentage: 7,
    taxAmount: 245,
    preferCalculatedTotal: true,
  }).payableTotal, 5274);

  assert.equal(resolveStoredHotelPayablePricing({
    storedTotal: 8774,
    baseTotal: 4700,
    marginPercentage: 7,
  }).payableTotal, 8774);

  const staleComponentOption = projectHotelPayablePricing({
    provider: 'axisrooms',
    baseTotalPrice: 8200,
    totalRoomCost: 3200,
    extraBedCount: 1,
    extraBedRate: 1500,
    extraBedAmount: 1500,
    totalPrice: 8774,
  }, 7);
  assert.equal(staleComponentOption.baseTotalPrice, 3200);
  assert.equal(staleComponentOption.hotelMarginBaseAmount, 4700);
  assert.equal(staleComponentOption.totalPrice, 5029);

  const snapshotWithSupplement = projectHotelPayablePricing({
    provider: 'axisrooms',
    baseTotalPrice: 8200,
    totalRoomCost: 3200,
    extraBedCount: 1,
    extraBedAmount: 1500,
    totalPrice: 8774,
  }, 7);
  assert.equal(snapshotWithSupplement.extraBedAmount, 1500);
  assert.equal(snapshotWithSupplement.totalPrice, 5029);

  const underProjected = projectHotelPayablePricing({
    basePricePerNight: 2750,
    baseTotalPrice: 2750,
    pricePerNight: 2750,
    totalPrice: 2750,
    hotelMarginPercentage: 10,
    hotelMarginAmount: 275,
    amountIncludesHotelMargin: true,
  }, 10);
  assert.equal(underProjected.pricePerNight, 3025);
  assert.equal(underProjected.totalPrice, 3025);
});

test('legacy projected TBO/VSR row without base recovers base before calculating margin', () => {
  const projected = projectHotelPayablePricing({
    provider: 'tbo',
    amountIncludesHotelMargin: true,
    pricingIncludesHotelMargin: true,
    totalPrice: 2264.12,
    hotelMarginPercentage: 10,
    hotelMarginAmount: 205.83,
  }, 10);

  assert.equal(projected.baseTotalPrice, 2058.29);
  assert.equal(projected.hotelMarginBaseAmount, 2058.29);
  assert.equal(projected.hotelMarginTotalAmount, 205.83);
  assert.equal(projected.totalPrice, 2264.12);
});

test('ResAvenue margin projection remains idempotent at 9499 -> 10448.90', () => {
  const projected = projectHotelPayablePricing({
    provider: 'resavenue', hotelCode: '20', baseTotalPrice: 9499, totalPrice: 9499,
    rateOptions: [{ rateOptionId: 'RESAVENUE-20-rate', baseTotalPrice: 9499, totalPrice: 9499 }],
  }, 10);
  assert.equal(projected.rateOptions[0].baseTotalPrice, 9499);
  assert.equal(projected.rateOptions[0].totalPrice, 10448.9);
  assert.equal(projectHotelPayablePricing(projected, 10).rateOptions[0].totalPrice, 10448.9);
});

test('card identity is stable across supplier hotel-code representations', () => {
  const base = {
    itineraryRouteId: 10145,
    groupType: 1,
    provider: 'axisrooms',
    canonicalHotelId: 232,
    hotelName: 'THE ARBOUR RESORT',
  };
  assert.equal(
    hotelCardPropertyKey({ ...base, hotelCode: '232' }),
    hotelCardPropertyKey({ ...base, hotelCode: '435' }),
  );
});

test('card starting amount and difference use payable nested options', () => {
  const rows = decorateHotelCardPricing([{
    itineraryRouteId: 10145,
    groupType: 1,
    provider: 'axisrooms',
    canonicalHotelId: 232,
    hotelCode: '232',
    hotelName: 'THE ARBOUR RESORT',
    rateOptions: [
      { rateOptionId: 'CP', pricePerNight: 5040 },
      { rateOptionId: 'MAP', pricePerNight: 7920 },
      { rateOptionId: 'AP', pricePerNight: 10800 },
    ],
  }], new Map([['10145-1', 5040]]));

  assert.equal(rows[0].startingFromAmount, 5040);
  assert.deepEqual(rows[0].rateOptions.map((option: any) => option.priceDifference), [0, 2880, 5760]);
});

test('mixed-room selected view ignores stale flattened total and recalculates margin from room breakdown', () => {
  const [group] = buildHotelSelectionState({
    tabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 25652 }],
    requiredRoutes: [{ routeId: 11322, routeDate: '2026-09-05' }],
    rows: [{
      itineraryRouteId: 11322,
      routeDate: '2026-09-05',
      groupType: 1,
      isSelected: true,
      provider: 'offline',
      hotelCode: '439',
      hotelName: 'JUNGLE PARK RESORT',
      selectedPriceSnapshot: {
        provider: 'offline',
        hotelName: 'JUNGLE PARK RESORT',
        roomCount: 3,
        hotelMarginPercentage: 6,
        // This is the stale pre-edit aggregate that previously won.
        totalPrice: 25652,
        amountIncludesHotelMargin: true,
        nightlyRates: [{ date: '2026-09-05', sellAmount: 25652 }],
        roomTypeBreakdown: [
          { roomType: 'Garden Cottage', roomCount: 1, roomCost: 6800, childWithBedCost: 1000 },
          { roomType: 'Deluxe', roomCount: 2, roomCost: 8900, childWithBedCost: 2000, childWithoutBedCost: 800 },
        ],
      },
    }],
  });

  assert.equal(group.totalAmount, 20670);
  assert.equal(group.routes[0].selected?.totalPrice, 20670);
  assert.equal(group.routes[0].selected?.selectedTotalPrice, 20670);
  assert.equal(group.routes[0].selected?.hotelMarginBaseAmount, 19500);
  assert.equal(group.routes[0].selected?.hotelMarginAmount, 1170);
});

