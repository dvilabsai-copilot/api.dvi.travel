import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryRouteTimingService } from '../src/modules/itineraries/services/itinerary-route-timing.service';

test('route timing preserves required plan and route validation', async () => {
  const service = new ItineraryRouteTimingService(null as any, null as any);

  await assert.rejects(
    () => service.updateRouteTimes(0, 0, '08:00:00', '18:00:00'),
    /planId and routeId are required/,
  );
});
