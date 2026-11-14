import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVehicleOriginCoordinates } from '../src/modules/itineraries/utils/vehicle-origin-coordinates.util';
import { VendorsService } from '../src/modules/vendors/vendors.service';
import { calculateDistanceAndDuration, getLegDistanceAndDuration } from '../src/modules/itineraries/engines/vehicle-calculation.helpers';

const fallback = { latitude: 13.1, longitude: 80.1 };
const vendor = { vendor_origin_latitude: 13.2, vendor_origin_longitude: 80.2 };

test('vehicle coordinates take precedence over vendor coordinates', () => {
  assert.deepEqual(resolveVehicleOriginCoordinates({ vehicle_origin_latitude: 13.3, vehicle_origin_longitude: 80.3 }, vendor, fallback), { latitude: 13.3, longitude: 80.3 });
});
test('missing or invalid vehicle pairs use vendor coordinates without mixing axes', () => {
  for (const vehicle of [{}, { vehicle_origin_latitude: 13.3 }, { vehicle_origin_latitude: 91, vehicle_origin_longitude: 80.3 }]) {
    assert.deepEqual(resolveVehicleOriginCoordinates(vehicle, vendor, fallback), { latitude: 13.2, longitude: 80.2 });
  }
});
test('missing or invalid vendor pairs preserve existing location fallback', () => {
  for (const candidate of [null, {}, { vendor_origin_latitude: 13.2 }, { vendor_origin_latitude: 0, vendor_origin_longitude: 0 }]) {
    assert.deepEqual(resolveVehicleOriginCoordinates({}, candidate, fallback), fallback);
  }
});
test('coordinate with one zero axis remains valid', () => {
  assert.deepEqual(resolveVehicleOriginCoordinates({}, { vendor_origin_latitude: 0, vendor_origin_longitude: 80.2 }, fallback), { latitude: 0, longitude: 80.2 });
});
test('explicit origin coordinates bypass a stale named distance; legacy lookup still uses it', async () => {
  let lookups = 0;
  const prisma = { dvi_stored_locations: { findFirst: async () => { lookups++; return { distance: 100, duration: '01:00:00' }; } } };
  const actual = await getLegDistanceAndDuration(prisma, 'Airport', 'City', 12.9826161, 80.1639177, 13.00697343, 80.19643533, 1, 40, 60, undefined, true);
  assert.equal(actual.distance, calculateDistanceAndDuration(12.9826161, 80.1639177, 13.00697343, 80.19643533, 40, 1.5).distance);
  assert.equal(lookups, 0);
  const legacy = await getLegDistanceAndDuration(prisma, 'Airport', 'City', 12.9826161, 80.1639177, 13.00697343, 80.19643533, 1);
  assert.equal(legacy.distance, '100.00');
  assert.equal(lookups, 1);
});
test('vendor basic payload validates pairs, permits clearing, and omits absent coordinates', () => {
  const service = Object.create(VendorsService.prototype) as any;
  assert.equal(Object.hasOwn(service.mapVendorBasicPayload({}), 'vendor_origin_latitude'), false);
  const parsed = service.mapVendorBasicPayload({ vendor_origin_latitude: '13.2', vendor_origin_longitude: '80.2' });
  assert.equal(parsed.vendor_origin_latitude, 13.2);
  assert.equal(parsed.vendor_origin_longitude, 80.2);
  assert.equal(service.mapVendorBasicPayload({ vendor_origin_latitude: null, vendor_origin_longitude: null }).vendor_origin_latitude, null);
  assert.throws(() => service.mapVendorBasicPayload({ vendor_origin_latitude: 13.2 }), /both vendor origin/);
  assert.throws(() => service.mapVendorBasicPayload({ vendor_origin_latitude: 91, vendor_origin_longitude: 80.2 }), /between/);
});
