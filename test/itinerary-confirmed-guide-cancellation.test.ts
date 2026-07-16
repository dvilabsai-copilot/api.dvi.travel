import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryConfirmedGuideCancellationService } from '../src/modules/itineraries/services/itinerary-confirmed-guide-cancellation.service';

test('preserves confirmed guide slot cancellation validation', async () => {
  const service = new ItineraryConfirmedGuideCancellationService({} as any, {} as any, async () => undefined);

  await assert.rejects(
    () => service.cancelConfirmedGuideSlot(0, { routeGuideId: 1, guideSlotCostDetailsId: 2 }, 7),
    (error: any) => error?.message === 'confirmedPlanId is required',
  );
  await assert.rejects(
    () => service.cancelConfirmedGuideSlot(99, { routeGuideId: 0, guideSlotCostDetailsId: 2 }, 7),
    (error: any) => error?.message === 'routeGuideId is required',
  );
});

test('preserves missing confirmed-guide rejection after slot-cost hydration', async () => {
  const calls: string[] = [];
  const tx: any = {
    dvi_confirmed_itinerary_route_guide_slot_cost_details: {
      count: async () => 1,
    },
    dvi_confirmed_itinerary_route_guide_details: {
      findFirst: async () => null,
    },
  };
  const prisma: any = {
    dvi_confirmed_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_plan_ID: 42 }),
    },
    $transaction: async (callback: (client: any) => Promise<any>) => callback(tx),
  };
  const confirmedGuideAssignmentService: any = {
    ensureConfirmedGuideSlotCostRows: async () => calls.push('ensure-slot-cost-rows'),
  };

  await assert.rejects(
    () => new ItineraryConfirmedGuideCancellationService(prisma, confirmedGuideAssignmentService, async () => undefined)
      .cancelConfirmedGuideSlot(99, { routeGuideId: 55, guideSlotCostDetailsId: 401 }, 7),
    (error: any) => error?.message === 'Confirmed guide not found',
  );
  assert.deepEqual(calls, ['ensure-slot-cost-rows']);
});
