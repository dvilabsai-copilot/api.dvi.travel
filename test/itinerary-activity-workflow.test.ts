import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryActivityWorkflowService } from '../src/modules/itineraries/services/itinerary-activity-workflow.service';

test('activity deletion preserves the original not-found validation', async () => {
  const prisma = {
    $transaction: async (work: (tx: any) => Promise<any>) => work({
      dvi_itinerary_route_activity_details: {
        deleteMany: async () => ({ count: 0 }),
      },
    }),
  } as any;
  const service = new ItineraryActivityWorkflowService(prisma, null as any);

  await assert.rejects(
    () => service.deleteActivity(1, 2, 3),
    /Activity not found/,
  );
});

test('all-hotspots activity preview preserves activity lookup validation', async () => {
  const prisma = {
    dvi_activity: {
      findUnique: async () => null,
    },
  } as any;
  const service = new ItineraryActivityWorkflowService(prisma, null as any);

  await assert.rejects(
    () => service.previewActivityForAllHotspots({ planId: 1, routeId: 2, activityId: 3 }),
    /Activity not found/,
  );
});
