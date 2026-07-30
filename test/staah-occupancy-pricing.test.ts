import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateStaahAmountAcrossRoutes,
  calculateStaahOccupancyAmount,
} from '../src/modules/itineraries/helpers/staah-occupancy-pricing';

test('allocates the outbound multi-night amount using nightly rates', () => {
  assert.deepEqual(
    allocateStaahAmountAcrossRoutes(1760, [{ amountAfterTax: 880 }, { amountAfterTax: 880 }], 2),
    [880, 880],
  );
});

test('fallback allocation preserves the total when nightly rates are incomplete', () => {
  assert.deepEqual(
    allocateStaahAmountAcrossRoutes(100, [{ amountAfterTax: 100 }], 3),
    [33.33, 33.33, 33.34],
  );
});

test('returns no allocations when there are no route rows', () => {
  assert.deepEqual(allocateStaahAmountAcrossRoutes(100, [], 0), []);
});

test('applies nested STAAH extra-bed and extra-child rates for multi-room occupancy', () => {
  const breakdown = calculateStaahOccupancyAmount(
    {
      amountAfterTax: {
        obp: { person1: '800', person2: '900' },
        extrabed: '100',
        extrachild: '150',
      },
    },
    {
      roomCount: 2,
      adults: 3,
      children: 1,
      extraBedCount: 1,
      childWithBedCount: 1,
    },
  );

  assert.equal(breakdown.baseOccupancyAmount, 1700);
  assert.equal(breakdown.extraBedAmount, 100);
  assert.equal(breakdown.extraChildAmount, 150);
  assert.equal(breakdown.finalCalculatedAmount, 1950);
});

test('calculates STAAH price entries independently for DOUBLE plus SINGLE rooms', () => {
  const rates = { DOUBLE: 900, SINGLE: 800, EXTRACHILD: 150 };
  const doubleWithChild = calculateStaahOccupancyAmount(rates, {
    roomCount: 1,
    adults: 2,
    children: 1,
    childWithBedCount: 1,
  });
  const single = calculateStaahOccupancyAmount(rates, { roomCount: 1, adults: 1 });

  assert.equal(doubleWithChild.finalCalculatedAmount, 1050);
  assert.equal(doubleWithChild.extraChildCount, 1);
  assert.equal(doubleWithChild.extraChildRate, 150);
  assert.equal(single.finalCalculatedAmount, 800);
});
