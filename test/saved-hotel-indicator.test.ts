import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SavedHotelIndicatorService } from '../src/modules/itineraries/services/saved-hotel-indicator.service';

test('maps saved hotel rows to unique route indicators', async () => {
  const result = await new SavedHotelIndicatorService().load(10, {
    loadRows: async () => [{ itinerary_route_id: 2 }, { itinerary_route_id: 2 }, { itinerary_route_id: 3 }],
  });
  assert.deepEqual(Array.from(result.entries()), [[2, 'SAVED'], [3, 'SAVED']]);
});

test('returns an empty map when the indicator query fails', async () => {
  const warnings: string[] = [];
  const result = await new SavedHotelIndicatorService().load(10, {
    loadRows: async () => { throw new Error('database unavailable'); },
    warn: (message) => warnings.push(message),
  });
  assert.equal(result.size, 0);
  assert.match(warnings[0], /database unavailable/);
});
