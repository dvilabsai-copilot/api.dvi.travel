import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocationGeoPolicyService } from '../src/modules/locations/services/location-geo-policy.service';

const policy = new LocationGeoPolicyService();

test('parses combined coordinates before scalar fallbacks', () => {
  assert.deepEqual(policy.resolveCoordinateInput('12.97, 77.59', null), { latitude: 12.97, longitude: 77.59 });
  assert.deepEqual(policy.resolveCoordinateInput('12.97', '77.59'), { latitude: 12.97, longitude: 77.59 });
  assert.deepEqual(policy.resolveCoordinateInput('invalid', '77.59'), { latitude: null, longitude: 77.59 });
});

test('normalizes names and removes case-insensitive duplicate strings', () => {
  assert.equal(policy.normalizeLocationName('  Bengaluru   Airport '), 'Bengaluru Airport');
  assert.deepEqual(policy.uniqueStringsCaseInsensitive(['Bengaluru', ' bengaluru ', '', null, 'Mysuru']), ['Bengaluru', 'Mysuru']);
});

test('preserves duration rounding and haversine distance semantics', () => {
  assert.equal(policy.estimateDurationText(25), '1 hours 0 mins');
  assert.equal(policy.calculateDistanceKm(0, 0, 0, 0), 0);
  assert.ok(policy.calculateDistanceKm(12.9716, 77.5946, 13.0827, 80.2707) > 285);
});
