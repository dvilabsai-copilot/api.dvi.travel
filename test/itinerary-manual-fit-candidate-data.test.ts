import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitCandidateDataService } from '../src/modules/itineraries/services/itinerary-manual-fit-candidate-data.service';

test('projects route hotspot masters and active timing windows with stable fields', async () => {
  const service = new ItineraryManualFitCandidateDataService();
  service.setCallbacks({
    normalizeManualHotspotIds: (ids: any[]) => [...new Set(ids.map(Number).filter((id) => id > 0))],
    normalizeHotspotPriority: (value: number) => value || 9999,
    getHotspotDurationMinutes: () => 45,
    classifyHotspotsForManualInsertion: (rows: any[]) => ({ manual: rows.filter((row) => row.isManual) }),
  });
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findMany: async () => [{ route_hotspot_ID: 1, hotspot_ID: 10, hotspot_plan_own_way: 1, hotspot_order: 1 }],
    },
    dvi_hotspot_place: {
      findMany: async () => [{ hotspot_ID: 10, hotspot_name: 'Museum', hotspot_priority: 2, hotspot_location: 'Kochi' }],
    },
    dvi_hotspot_timing: {
      findMany: async () => [{ hotspot_ID: 10, hotspot_closed: 0, hotspot_open_all_time: 0, hotspot_start_time: new Date('2020-01-01T09:00:00Z'), hotspot_end_time: new Date('2020-01-01T17:00:00Z') }],
    },
  };

  const result = await service.buildRouteHotspotInsertionCandidates(tx, 1, 2, [10]);
  assert.equal(result.hotspotRows[0].name, 'Museum');
  assert.equal(result.hotspotRows[0].timings, '09:00 AM - 05:00 PM');
  assert.equal(result.hotspotRows[0].durationMinutes, 45);
  assert.deepEqual(result.classified.manual.map((row: any) => row.hotspotId), [10]);
});
