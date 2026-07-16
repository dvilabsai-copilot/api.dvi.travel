import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineNonHotelCutoffService } from '../src/modules/itineraries/engines/helpers/timeline-non-hotel-cutoff.service';

function createService() {
  const service = new TimelineNonHotelCutoffService({
    fromSourceAndDestination: async () => ({ travelTime: '02:00:00', bufferTime: '00:30:00' }),
  } as any);
  service.setCallbacks({ canonicalCityKey: (value) => String(value || '').trim().toLowerCase() });
  return service;
}

test('subtracts outstation travel and buffer from the configured route end', async () => {
  const result = await createService().calculate({
    tx: {} as any,
    route: { direct_to_next_visiting_place: 0, location_name: 'Chennai', next_visiting_location: 'Bengaluru' },
    isLastRoute: false,
    routeEndSeconds: 18 * 3600,
    routeEndTime: '18:00:00',
    sourceCity: 'Chennai',
    destinationCity: 'Bengaluru',
  });
  assert.equal(result.latestNonHotelEndSeconds, 55800);
  assert.equal(result.latestNonHotelEndTime, '15:30:00');
});

test('preserves direct intercity and final-route no-subtraction behavior', async () => {
  const service = createService();
  const direct = await service.calculate({
    tx: {} as any,
    route: { direct_to_next_visiting_place: 1 },
    isLastRoute: false,
    routeEndSeconds: 18 * 3600,
    routeEndTime: '18:00:00',
    sourceCity: 'Chennai',
    destinationCity: 'Bengaluru',
  });
  const last = await service.calculate({
    tx: {} as any,
    route: { direct_to_next_visiting_place: 0 },
    isLastRoute: true,
    routeEndSeconds: 18 * 3600,
    routeEndTime: '18:00:00',
    sourceCity: 'Chennai',
    destinationCity: 'Bengaluru',
  });
  assert.deepEqual(direct, { latestNonHotelEndSeconds: 64800, latestNonHotelEndTime: '18:00:00' });
  assert.deepEqual(last, { latestNonHotelEndSeconds: 64800, latestNonHotelEndTime: '18:00:00' });
});
