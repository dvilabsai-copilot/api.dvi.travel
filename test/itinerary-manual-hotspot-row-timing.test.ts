import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualHotspotRowTimingService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-row-timing.service';

test('retires active manual rows whose persisted window has no duration', async () => {
  const service = new ItineraryManualHotspotRowTimingService();
  service.setCallbacks({
    computeRowDurationMinutes: (row: any) => row.hotspot_start_time === row.hotspot_end_time ? 0 : 30,
  });
  const calls: any[] = [];
  const prisma = {
    dvi_itinerary_route_hotspot_details: {
      findMany: async (query: any) => {
        calls.push(['findMany', query]);
        return [{ route_hotspot_ID: 12, hotspot_start_time: '10:00:00', hotspot_end_time: '10:00:00' }];
      },
      updateMany: async (query: any) => {
        calls.push(['updateMany', query]);
      },
    },
  };

  await service.cleanupStaleManualHotspotRows(prisma, 7, 8, [44]);

  assert.equal(calls[1][1].where.route_hotspot_ID.in[0], 12);
  assert.deepEqual(calls[1][1].data, { status: 0, deleted: 1, updatedon: calls[1][1].data.updatedon });
});

test('reactivates the newest manual row and retires duplicate rows', async () => {
  const service = new ItineraryManualHotspotRowTimingService();
  const calls: any[] = [];
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findMany: async () => [{ route_hotspot_ID: 20 }, { route_hotspot_ID: 19 }],
      update: async (query: any) => calls.push(['update', query]),
      updateMany: async (query: any) => calls.push(['updateMany', query]),
      create: async () => ({ route_hotspot_ID: 21 }),
    },
  };

  const rowId = await service.activateManualHotspotRowWithTimes(tx, {
    planId: 1,
    routeId: 2,
    hotspotId: 3,
    userId: 4,
    start: new Date('2026-07-16T10:00:00Z'),
    end: new Date('2026-07-16T11:30:00Z'),
    hotspotOrder: 5,
  });

  assert.equal(rowId, 20);
  assert.equal(calls[0][0], 'update');
  assert.deepEqual(calls[1][1].where, { route_hotspot_ID: { in: [19] } });
  assert.equal(
    calls[0][1].data.hotspot_traveling_time.getUTCHours() * 60
      + calls[0][1].data.hotspot_traveling_time.getUTCMinutes(),
    90,
  );
});
