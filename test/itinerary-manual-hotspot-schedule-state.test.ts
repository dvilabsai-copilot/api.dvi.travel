import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualHotspotScheduleStateService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-schedule-state.service';

function createTx(timings: any[] = []) {
  return {
    dvi_itinerary_route_hotspot_details: {
      findMany: async () => [{ route_hotspot_ID: 1, hotspot_start_time: new Date('2026-07-16T09:00:00Z'), hotspot_end_time: new Date('2026-07-16T10:00:00Z'), is_conflict: 0 }],
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_date: new Date('2026-07-16T00:00:00Z') }),
    },
    dvi_hotspot_timing: { findMany: async () => timings },
  };
}

test('accepts a scheduled row inside its active operating window', async () => {
  const service = new ItineraryManualHotspotScheduleStateService();
  service.setCallbacks({
    computeRowDurationMinutes: () => 60,
    manualRowHasNoOverlap: async () => true,
  });
  const result = await service.isManualHotspotScheduled(createTx([
    { hotspot_open_all_time: 0, hotspot_start_time: new Date('2026-07-16T08:00:00Z'), hotspot_end_time: new Date('2026-07-16T18:00:00Z') },
  ]), 1, 2, 99);
  assert.equal(result, true);
});

test('preserves overnight operating-window and conflict rejection behavior', async () => {
  const service = new ItineraryManualHotspotScheduleStateService();
  service.setCallbacks({
    computeRowDurationMinutes: () => 60,
    manualRowHasNoOverlap: async () => false,
  });
  const result = await service.isManualHotspotScheduled(createTx([
    { hotspot_open_all_time: 0, hotspot_start_time: new Date('2026-07-16T18:00:00Z'), hotspot_end_time: new Date('2026-07-16T02:00:00Z') },
  ]), 1, 2, 99);
  assert.equal(result, false);
});
