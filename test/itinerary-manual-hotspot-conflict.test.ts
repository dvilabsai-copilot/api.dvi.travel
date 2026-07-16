import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualHotspotConflictService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-conflict.service';

test('marks an existing manual row as a confirmed conflict', async () => {
  const service = new ItineraryManualHotspotConflictService();
  let updateQuery: any;
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findFirst: async () => ({ route_hotspot_ID: 17 }),
      update: async (query: any) => { updateQuery = query; },
    },
  };
  const start = new Date('2026-07-16T10:00:00Z');
  const end = new Date('2026-07-16T11:30:00Z');

  assert.equal(await service.forceInsertManualHotspotConflictRow(tx, 1, 2, 3, 4, { start, end }), true);
  assert.equal(updateQuery.where.route_hotspot_ID, 17);
  assert.equal(updateQuery.data.is_conflict, 1);
  assert.equal(updateQuery.data.hotspot_traveling_time.getUTCHours() * 60 + updateQuery.data.hotspot_traveling_time.getUTCMinutes(), 90);
});

test('creates a fallback conflict row after reading route timing and current order', async () => {
  const service = new ItineraryManualHotspotConflictService();
  let createQuery: any;
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findFirst: async (query: any) => query.orderBy ? { hotspot_order: 8 } : null,
      create: async (query: any) => { createQuery = query; },
    },
    dvi_itinerary_route_details: {
      findUnique: async () => ({ route_start_time: new Date('2026-07-16T08:00:00Z'), route_end_time: new Date('2026-07-16T18:00:00Z') }),
    },
  };

  assert.equal(await service.forceInsertManualHotspotConflictRow(tx, 1, 2, 3, 4), true);
  assert.equal(createQuery.data.hotspot_order, 9);
  assert.equal(createQuery.data.is_conflict, 1);
  assert.equal(createQuery.data.createdby, 4);
});
