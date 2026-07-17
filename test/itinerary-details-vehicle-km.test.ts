import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryDetailsVehicleKmService } from '../src/modules/itineraries/services/itinerary-details-vehicle-km.service';

test('aggregates route vehicle kilometres using the maximum persisted values', async () => {
  const prisma = {
    $queryRawUnsafe: async () => [
      { itinerary_route_id: 1, total_running_km: '10.5', total_siteseeing_km: '2', total_travelled_km: '12.5' },
      { itinerary_route_id: 1, total_running_km: '8', total_siteseeing_km: '4', total_travelled_km: '13' },
      { itinerary_route_id: 0, total_running_km: '99', total_siteseeing_km: '99', total_travelled_km: '99' },
    ],
  };
  const result = await new ItineraryDetailsVehicleKmService().load(prisma, 42);
  assert.deepEqual(result.get(1), { runningKm: 10.5, sightseeingKm: 4, totalKm: 13 });
  assert.equal(result.has(0), false);
});

test('returns an empty map when the persisted vehicle read is empty', async () => {
  const result = await new ItineraryDetailsVehicleKmService().load({ $queryRawUnsafe: async () => [] }, 1);
  assert.equal(result.size, 0);
});

test('preserves numeric fallback for malformed kilometre values', async () => {
  const result = await new ItineraryDetailsVehicleKmService().load({
    $queryRawUnsafe: async () => [{ itinerary_route_id: 2, total_running_km: 'bad', total_siteseeing_km: null, total_travelled_km: undefined }],
  }, 1);
  assert.deepEqual(result.get(2), { runningKm: 0, sightseeingKm: 0, totalKm: 0 });
});
