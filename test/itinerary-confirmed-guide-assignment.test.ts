import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryConfirmedGuideAssignmentService } from '../src/modules/itineraries/services/itinerary-confirmed-guide-assignment.service';

test('preserves missing confirmed-itinerary validation', async () => {
  const prisma: any = {
    dvi_confirmed_itinerary_plan_details: { findUnique: async () => null },
  };
  await assert.rejects(
    () => new ItineraryConfirmedGuideAssignmentService(prisma, {} as any).listConfirmedGuideAssignments(99),
    (error: any) => error?.message === 'Confirmed itinerary not found',
  );
});

test('projects confirmed guide rows, labels and slot costs in deterministic order', async () => {
  const prisma: any = {
    dvi_confirmed_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_plan_ID: 42 }),
    },
    dvi_confirmed_itinerary_route_guide_details: {
      findMany: async () => [{
        route_guide_ID: 55,
        itinerary_route_ID: 7,
        guide_id: 9,
        guide_type: 2,
        guide_cost: 250,
        guide_language: '2',
        guide_slot: '1,2',
        cancellation_status: 0,
      }],
    },
    dvi_confirmed_itinerary_route_guide_slot_cost_details: {
      findMany: async () => [{
        cnf_itinerary_guide_slot_cost_details_ID: 501,
        guide_slot_cost_details_id: 401,
        route_guide_id: 55,
        itinerary_route_id: 7,
        itinerary_route_date: new Date('2026-07-16T00:00:00Z'),
        guide_id: 9,
        guide_type: 2,
        guide_slot: 1,
        guide_slot_cost: 125,
        cancellation_status: 0,
        cancellation_defect_type: 0,
      }],
    },
    dvi_itinerary_route_details: {
      findMany: async () => [{ itinerary_route_ID: 7, itinerary_route_date: new Date('2026-07-16T00:00:00Z') }],
    },
    dvi_guide_details: {
      findMany: async () => [{ guide_id: 9, guide_name: 'Asha' }],
    },
    dvi_language: {
      findMany: async () => [{ language_id: 2, language: 'English' }],
    },
  };

  const result = await new ItineraryConfirmedGuideAssignmentService(prisma, {
    getGuideSlotLabel: (slotId: number) => `slot-${slotId}`,
  } as any).listConfirmedGuideAssignments(99);

  assert.deepEqual(result, [{
    routeGuideId: 55,
    itineraryRouteId: 7,
    itineraryRouteDate: '2026-07-16',
    guideId: 9,
    guideName: 'Asha',
    guideType: 2,
    guideCost: 250,
    guideLanguageIds: [2],
    guideLanguageLabels: ['English'],
    guideSlotIds: [1, 2],
    guideSlotLabels: ['slot-1', 'slot-2'],
    cancellationStatus: 0,
    slots: [{
      confirmedGuideSlotCostId: 501,
      guideSlotCostDetailsId: 401,
      routeGuideId: 55,
      itineraryRouteId: 7,
      itineraryRouteDate: '2026-07-16',
      guideId: 9,
      guideType: 2,
      guideSlot: 1,
      guideSlotLabel: 'slot-1',
      guideSlotCost: 125,
      cancellationStatus: 0,
      cancellationDefectType: 0,
    }],
  }]);
});
