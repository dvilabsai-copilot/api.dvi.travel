import assert from 'node:assert/strict';
import { hotspotDurationToMinutes } from '../src/modules/itineraries/utils/hotspot-duration.util';

assert.equal(hotspotDurationToMinutes(new Date('1970-01-01T08:00:00.000Z')), 480);
assert.equal(hotspotDurationToMinutes('01:30:00'), 90);
assert.equal(hotspotDurationToMinutes('00:45:00'), 45);
assert.equal(hotspotDurationToMinutes(null), 0);
assert.equal(hotspotDurationToMinutes('not a duration'), 0);

console.log('hotspot duration utility tests passed');
