import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryGuideAssignmentService } from '../src/modules/itineraries/services/itinerary-guide-assignment.service';

test('preserves guide slot, pax-bucket and GST policies', () => {
  const service = new ItineraryGuideAssignmentService({} as any);
  assert.equal(service.getGuideSlotLabel(2), '1 PM to 6 PM');
  assert.equal(service.getGuideSlotLabel(99), 'Slot 99');
  assert.equal(service.getGuidePaxBucket(5), 1);
  assert.equal(service.getGuidePaxBucket(6), 2);
  assert.equal(service.guideHasLanguage('2,4', 4), true);
  assert.equal(service.guideHasAllSlots('1,3', [1, 3]), true);
  assert.equal(service.applyGuideGst(100, 10, 2), 110);
});

test('maps guide assignment option languages and slots', async () => {
  const service = new ItineraryGuideAssignmentService({
    dvi_language: {
      findMany: async () => [
        { language_id: 2, language: 'English' },
        { language_id: 4, language: 'Hindi' },
      ],
    },
  } as any);
  const result = await service.getGuideAssignmentOptions(42);
  assert.deepEqual(result.languages, [
    { id: 2, label: 'English' },
    { id: 4, label: 'Hindi' },
  ]);
  assert.equal(result.slots.length, 4);
  assert.equal(result.assignment, null);
});

test('reports guide availability from route dates, guide slots and pricebook rows', async () => {
  const service = new ItineraryGuideAssignmentService({
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_plan_ID: 42, total_adult: 2, total_children: 0, total_infants: 0 }),
    },
    dvi_itinerary_route_details: {
      findMany: async () => [{ itinerary_route_ID: 7, itinerary_route_date: new Date('2026-07-16T00:00:00Z') }],
    },
    dvi_guide_details: {
      findMany: async () => [{ guide_id: 9, guide_available_slot: '1,2' }],
    },
    dvi_guide_pricebook: {
      findMany: async () => [{ guide_id: 9, slot_type: 1, year: '2026', month: 'July', day_16: 125 }],
    },
  } as any);
  const result = await service.getGuideAvailability(42);
  assert.equal(result.wholeItineraryAvailable, true);
  assert.deepEqual(result.days, [{ routeId: 7, routeDate: '2026-07-16', available: true }]);
});
