import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextSoftDeleteValue,
  normalizeLocalTimeLimitSignature,
  normalizeOutstationKmSignature,
} from '../src/modules/vendors/vendor-pricebook-policy';

test('normalizes outstation kilometre values from explicit input or title', () => {
  assert.deepEqual(normalizeOutstationKmSignature(null, '250 Kms'), {
    normalizedLimit: 250,
    normalizedTitle: '250 Kms',
  });
  assert.deepEqual(normalizeOutstationKmSignature(300, '250 Kms'), {
    normalizedLimit: 300,
    normalizedTitle: '250 Kms',
  });
});

test('normalizes local time-limit signatures and preserves title labels', () => {
  assert.deepEqual(normalizeLocalTimeLimitSignature(null, null, '8 Hours / 80 Kms'), {
    normalizedHours: 8,
    normalizedKm: 80,
    normalizedTitle: '8 Hours / 80 Kms',
  });
  assert.deepEqual(normalizeLocalTimeLimitSignature(4, 40, '4 Hours / 40 Kms'), {
    normalizedHours: 4,
    normalizedKm: 40,
    normalizedTitle: '4 Hours / 40 Kms',
  });
});

test('allocates the next positive soft-delete marker', () => {
  assert.equal(nextSoftDeleteValue([]), 2);
  assert.equal(nextSoftDeleteValue([0, 1, 4, null]), 5);
});
