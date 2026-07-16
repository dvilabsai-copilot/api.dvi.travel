import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ItineraryGuideAssignmentWriteService,
  SaveGuideAssignmentPayload,
} from '../src/modules/itineraries/services/itinerary-guide-assignment-write.service';

test('preserves draft guide assignment validation before database access', async () => {
  const service = new ItineraryGuideAssignmentWriteService({} as any, {} as any);

  await assert.rejects(
    () => service.saveGuideAssignment(0, { guideLanguage: 2 }, 7),
    (error: any) => error?.message === 'itinerary_plan_ID_required',
  );
  await assert.rejects(
    () => service.saveGuideAssignment(42, { guideLanguage: 0, routeId: 3 }, 7),
    (error: any) => error?.message === 'guide_language_required',
  );
});

test('persists a route guide and rebuilds its slot-cost rows', async () => {
  const calls: string[] = [];
  const guideAssignmentService: any = {
    resolveEligibleGuideCost: async (params: any) => ({
      guideId: 9,
      totalGuideCost: params.slotIds?.length === 1 ? 125 : 250,
      datewiseCost: { '2026-07-16': 125 },
    }),
    getPlanRouteDates: async () => [],
  };
  const tx: any = {
    dvi_itinerary_route_guide_details: {
      create: async ({ data }: any) => {
        calls.push(`guide.create:${data.guide_slot}`);
        return { route_guide_ID: 55, guide_cost: data.guide_cost };
      },
    },
    dvi_itinerary_route_guide_slot_cost_details: {
      deleteMany: async () => calls.push('slots.deleteMany'),
      createMany: async ({ data }: any) => calls.push(`slots.createMany:${data.length}`),
    },
  };
  const prisma: any = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_plan_ID: 42, total_adult: 2, total_children: 1, total_infants: 0 }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_ID: 7, itinerary_route_date: new Date('2026-07-16T00:00:00Z') }),
    },
    $transaction: async (callback: (client: any) => Promise<any>) => callback(tx),
  };
  const payload: SaveGuideAssignmentPayload = {
    routeId: 7,
    guideLanguage: 2,
    guideSlots: [1, 1, 2],
  };

  const result = await new ItineraryGuideAssignmentWriteService(prisma, guideAssignmentService)
    .saveGuideAssignment(42, payload, 7);

  assert.deepEqual(result, { success: true, routeGuideId: 55, guideCost: 250 });
  assert.deepEqual(calls, ['guide.create:1,2', 'slots.deleteMany', 'slots.createMany:2']);
});

test('deletes draft slot costs before the route guide row', async () => {
  const calls: string[] = [];
  const tx: any = {
    dvi_itinerary_route_guide_slot_cost_details: {
      deleteMany: async ({ where }: any) => calls.push(`slots:${where.route_guide_id}:${where.itinerary_plan_id}`),
    },
    dvi_itinerary_route_guide_details: {
      deleteMany: async ({ where }: any) => calls.push(`guide:${where.route_guide_ID}:${where.itinerary_route_ID}`),
    },
  };
  const prisma: any = {
    $transaction: async (callback: (client: any) => Promise<any>) => callback(tx),
  };

  const result = await new ItineraryGuideAssignmentWriteService(prisma, {} as any)
    .deleteGuideAssignment(42, 55, 7);

  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, ['slots:55:42', 'guide:55:7']);
});
