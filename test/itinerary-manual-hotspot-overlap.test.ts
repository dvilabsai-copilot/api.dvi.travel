import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualHotspotOverlapService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-overlap.service';

const row = (id: number, start: string, end: string, isConflict = 0) => ({
  route_hotspot_ID: id,
  hotspot_start_time: start,
  hotspot_end_time: end,
  is_conflict: isConflict,
});

test('rejects a manual row that overlaps an active row on the same route', async () => {
  const service = new ItineraryManualHotspotOverlapService();
  const calls: any[] = [];
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findMany: async (query: any) => {
        calls.push(query);
        return [row(2, '10:30:00', '11:30:00')];
      },
    },
  };

  assert.equal(await service.manualRowHasNoOverlap(tx, 1, 2, row(1, '10:00:00', '11:00:00')), false);
  assert.equal(calls[0].where.itinerary_plan_ID, 1);
  assert.equal(calls[0].where.route_hotspot_ID.not, 1);
});

test('ignores conflict rows and accepts a non-overlapping valid row', async () => {
  const service = new ItineraryManualHotspotOverlapService();
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findMany: async () => [row(2, '10:30:00', '11:30:00', 1), row(3, '12:00:00', '13:00:00')],
    },
  };

  assert.equal(await service.manualRowHasNoOverlap(tx, 1, 2, row(1, '11:30:00', '12:00:00')), true);
  assert.equal(await service.hasAnyNonOverlappingManualRow(tx, 1, 2, [row(1, '10:00:00', '11:00:00'), row(4, '13:00:00', '14:00:00')]), true);
});
