import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateStaahAmountAcrossRoutes } from '../src/modules/itineraries/helpers/staah-occupancy-pricing';

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
