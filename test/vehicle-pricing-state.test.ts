import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVehiclePricingState } from '../src/modules/itineraries/utils/vehicle-pricing-state.util';

test('vehicle pricing is not required when no vehicle type was persisted', () => {
  assert.equal(buildVehiclePricingState({
    requiresVehicles: false,
    requestedVehicleTypeIds: [],
    usableVehicleDetailCount: 0,
    selectedVehicleTypeIds: [],
  }).status, 'NOT_REQUIRED');
});

test('vehicle pricing is READY only when every requested type is selected and usable rows exist', () => {
  assert.deepEqual(buildVehiclePricingState({
    requiresVehicles: true,
    requestedVehicleTypeIds: [1, 2],
    usableVehicleDetailCount: 4,
    selectedVehicleTypeIds: [1, 2],
  }), {
    status: 'READY',
    requestedVehicleTypeCount: 2,
    usableVehicleDetailCount: 4,
    selectedVehicleTypeCount: 2,
    requiredSelectionCount: 2,
  });
});

test('a failed latest build remains FAILED when persisted selection is incomplete', () => {
  assert.equal(buildVehiclePricingState({
    requiresVehicles: true,
    requestedVehicleTypeIds: [1],
    usableVehicleDetailCount: 0,
    selectedVehicleTypeIds: [],
    latestBuildStatus: 'FAILED',
    latestFailureReason: 'vendor selection failed',
  }).status, 'FAILED');
});
