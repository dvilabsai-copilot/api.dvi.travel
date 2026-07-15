import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerarySmartActivityService } from '../src/modules/itineraries/services/itinerary-smart-activity.service';

test('smart activity insert preserves required gap validation', async () => {
  const service = new ItinerarySmartActivityService(null as any);

  await assert.rejects(
    () => service.smartInsertActivity(1, { routeId: 2, activityId: 3 }),
    /gapIndex is required for smart insert/,
  );
});
