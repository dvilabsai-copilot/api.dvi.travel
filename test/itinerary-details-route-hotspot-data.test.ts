import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsRouteHotspotDataService } from '../src/modules/itineraries/services/itinerary-details-route-hotspot-data.service';

test('loads route hotspots and preserves chronological tie-break ordering', async () => {
  const service = new ItineraryDetailsRouteHotspotDataService();
  const prisma = {
    $queryRawUnsafe: async () => [
      { hotspot_ID: 2, item_type: 4, hotspot_order: 2, hotspot_start_time: new Date('1970-01-01T10:00:00Z'), hotspot_end_time: new Date('1970-01-01T11:00:00Z') },
      { hotspot_ID: 1, item_type: 3, hotspot_order: 1, hotspot_start_time: new Date('1970-01-01T10:00:00Z'), hotspot_end_time: new Date('1970-01-01T10:30:00Z') },
    ],
    dvi_hotspot_place: { findMany: async () => [{ hotspot_ID: 1, hotspot_name: 'Museum (City)' }, { hotspot_ID: 2, hotspot_name: 'Fort' }] },
    dvi_hotspot_timing: { findMany: async () => [{ hotspot_ID: 2, weekday: 5 }] },
    dvi_hotspot_gallery_details: { findMany: async () => [{ hotspot_ID: 2, hotspot_gallery_name: 'fort.jpg' }] },
  };
  const result = await service.load({
    prisma,
    planId: 1,
    routeId: 2,
    formatTime: (value) => value instanceof Date ? `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')} AM` : null,
    timeToMinutes: (value) => value === '10:00 AM' ? 600 : value === '10:30 AM' ? 630 : 660,
  });

  assert.equal(result.routeHotspots[0].hotspot_ID, 1);
  assert.equal(result.hotspotNameToIdMap.get('museum'), 1);
  assert.deepEqual(result.hotspotTimingMap.get(2), [{ hotspot_ID: 2, weekday: 5 }]);
  assert.deepEqual(result.hotspotGalleryMap.get(2), ['/uploads/hotspot_gallery/fort.jpg']);
});

test('skips master, timing and gallery reads when a route has no hotspots', async () => {
  const service = new ItineraryDetailsRouteHotspotDataService();
  let masterReads = 0;
  const prisma = {
    $queryRawUnsafe: async () => [],
    dvi_hotspot_place: { findMany: async () => { masterReads += 1; return []; } },
    dvi_hotspot_timing: { findMany: async () => { masterReads += 1; return []; } },
    dvi_hotspot_gallery_details: { findMany: async () => { masterReads += 1; return []; } },
  };
  const result = await service.load({ prisma, planId: 1, routeId: 2, formatTime: () => null, timeToMinutes: () => 0 });
  assert.deepEqual(result.hotspotIds, []);
  assert.equal(masterReads, 0);
});
