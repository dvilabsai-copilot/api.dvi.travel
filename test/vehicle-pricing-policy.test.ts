import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLocalTimeLimitSignature,
  selectChargeableLocalSlab,
  sortLocalSlabs,
  toNum,
} from '../src/modules/itineraries/engines/vehicle-pricing-policy';

const slabs = [
  { time_limit_id: 2, hours_limit: 8, km_limit: 80, title: '8 Hours / 80 Kms' },
  { time_limit_id: 1, hours_limit: 4, km_limit: 40, title: '4 Hours / 40 Kms' },
  { time_limit_id: 3, hours_limit: 8, km_limit: 120, title: '8 Hours / 120 Kms' },
];

test('normalizes numeric values and title-derived time-limit signatures', () => {
    assert.equal(toNum('12.50'), 12.5);
    assert.equal(toNum('invalid'), 0);
    assert.deepEqual(normalizeLocalTimeLimitSignature(null, null, '8 Hours / 80 Kms'), {
      normalizedHours: 8,
      normalizedKm: 80,
    });
    assert.deepEqual(normalizeLocalTimeLimitSignature(4, 40, 'ignored'), {
      normalizedHours: 4,
      normalizedKm: 40,
    });
});

test('orders slabs deterministically by hours, kilometres and id', () => {
    assert.deepEqual(sortLocalSlabs(slabs).map((slab) => slab.time_limit_id), [1, 2, 3]);
});

test('keeps a covering selection and upgrades an insufficient selected slab', () => {
    const covered = selectChargeableLocalSlab(slabs, 4, 40, 1);
    assert.equal(covered?.chosen.time_limit_id, 1);
    assert.equal(covered?.selected?.time_limit_id, 1);
    assert.equal(covered?.slabUpgraded, false);
    assert.equal(covered?.noHigherSlabAvailable, false);

    const upgraded = selectChargeableLocalSlab(slabs, 8, 100, 2);
    assert.equal(upgraded?.chosen.time_limit_id, 3);
    assert.equal(upgraded?.selected?.time_limit_id, 2);
    assert.equal(upgraded?.slabUpgraded, true);
    assert.equal(upgraded?.noHigherSlabAvailable, false);
});

test('falls back to the largest slab when usage exceeds the available range', () => {
    const fallback = selectChargeableLocalSlab(slabs, 12, 200, 1);
    assert.equal(fallback?.chosen.time_limit_id, 3);
    assert.equal(fallback?.noHigherSlabAvailable, true);
    assert.equal(fallback?.slabUpgraded, true);
    assert.equal(selectChargeableLocalSlab([], 1, 1), null);
});
