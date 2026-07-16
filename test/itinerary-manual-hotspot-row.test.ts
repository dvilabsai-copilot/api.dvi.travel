import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualHotspotRowService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-row.service';

test('maintains route exclusion lists without duplicate writes', async () => {
  const service = new ItineraryManualHotspotRowService();
  const updates: any[] = [];
  const tx = {
    dvi_itinerary_route_details: {
      findUnique: async () => ({ excluded_hotspot_ids: [3, 7] }),
      update: async (args: any) => updates.push(args),
    },
  };
  await service.addRouteHotspotToExcludedList(tx, 2, 7);
  await service.addRouteHotspotToExcludedList(tx, 2, 9);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data.excluded_hotspot_ids, [3, 7, 9]);
});

test('reuses a valid manual row and retires stale active rows before creating a placeholder', async () => {
  const service = new ItineraryManualHotspotRowService();
  service.setCallbacks({ computeRowDurationMinutes: (row: any) => row.duration || 0 });
  const calls: string[] = [];
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findMany: async () => [
        { route_hotspot_ID: 2, status: 1, hotspot_plan_own_way: 1, duration: 0, is_conflict: 0 },
      ],
      update: async () => { calls.push('update'); },
      updateMany: async () => { calls.push('updateMany'); },
      create: async () => { calls.push('create'); },
    },
  };
  assert.deepEqual(await service.ensureManualHotspotRow(tx, 1, 2, 99, 5), { alreadyExisted: false });
  assert.deepEqual(calls, ['updateMany', 'create']);
});
