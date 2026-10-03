import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';

test('Fit Here confirmation rebuilds parking charges and vehicle pricing', async () => {
  const calls: Array<{ name: string; args: number[] }> = [];
  const service = {
    manualHotspotPreviewService: {
      confirmManualHotspotFitHere: async () => ({
        success: true,
        inserted: true,
        routeId: 13033,
      }),
    },
    hotspotEngine: {
      rebuildParkingCharges: async (...args: number[]) => {
        calls.push({ name: 'parking', args });
      },
    },
    forceRebuildVehiclePricingAfterHotspotChange: async (...args: number[]) => {
      calls.push({ name: 'vehicle-pricing', args });
    },
  };

  const result = await (ItinerariesService.prototype.confirmManualHotspotFitHere as any).call(
    service,
    10496,
    { attemptId: 'fit-attempt' },
    7,
  );

  assert.equal(result.parkingChargesRebuilt, true);
  assert.equal(result.vehiclePricingRebuilt, true);
  assert.deepEqual(calls, [
    { name: 'parking', args: [10496, 7] },
    { name: 'vehicle-pricing', args: [10496, 13033] },
  ]);
});

test('Fit Here confirmation does not rebuild pricing when confirmation is unsuccessful', async () => {
  const calls: string[] = [];
  const service = {
    manualHotspotPreviewService: {
      confirmManualHotspotFitHere: async () => ({
        success: false,
        inserted: false,
      }),
    },
    hotspotEngine: {
      rebuildParkingCharges: async () => calls.push('parking'),
    },
    forceRebuildVehiclePricingAfterHotspotChange: async () => calls.push('vehicle-pricing'),
  };

  const result = await (ItinerariesService.prototype.confirmManualHotspotFitHere as any).call(
    service,
    10496,
    { attemptId: 'fit-attempt' },
    7,
  );

  assert.equal(result.parkingChargesRebuilt, undefined);
  assert.equal(result.vehiclePricingRebuilt, undefined);
  assert.deepEqual(calls, []);
});
