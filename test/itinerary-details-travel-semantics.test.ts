import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsTravelSemanticsService } from '../src/modules/itineraries/services/itinerary-details-travel-semantics.service';

test('reconstructs travel origins from the preceding semantic attraction', () => {
  const service = new ItineraryDetailsTravelSemanticsService();
  const result = service.build({
    routeHotspots: [
      { item_type: 4, hotspot_ID: 11, route_hotspot_ID: 11 },
      { item_type: 3, hotspot_ID: 12, route_hotspot_ID: 12, hotspot_start_time: new Date('1970-01-01T10:00:00Z') },
      { item_type: 4, hotspot_ID: 12, route_hotspot_ID: 13 },
    ],
    hotspotMap: new Map([
      [11, { hotspot_name: 'Museum' }],
      [12, { hotspot_name: 'Temple' }],
    ]),
    location: { source_location: 'Hotel' },
    route: { location_name: 'City', itinerary_route_ID: 1 },
    plan: { arrival_location: 'Airport' },
    index: 0,
    routes: [],
    routeHotelMap: new Map(),
    formatTime: () => '10:00 AM',
    timeToMinutes: (value) => value === '10:00 AM' ? 600 : 0,
    isForcedManualConflictAttractionRow: () => false,
    getRouteHotelName: () => 'Stay Hotel',
  });

  assert.deepEqual(result.get(12), {
    from: 'Museum',
    to: 'Temple',
    fromHotspotId: 11,
    toHotspotId: 12,
  });
});

test('uses hotel origin for first attraction after a prior check-in', () => {
  const service = new ItineraryDetailsTravelSemanticsService();
  const result = service.build({
    routeHotspots: [
      { item_type: 6, hotspot_ID: 0, hotspot_start_time: new Date('1970-01-01T09:00:00Z'), hotspot_end_time: new Date('1970-01-01T09:30:00Z') },
      { item_type: 3, hotspot_ID: 21, route_hotspot_ID: 21, hotspot_start_time: new Date('1970-01-01T10:00:00Z') },
      { item_type: 4, hotspot_ID: 21, route_hotspot_ID: 22 },
    ],
    hotspotMap: new Map([[21, { hotspot_name: 'Fort' }]]),
    location: { source_location: 'City' },
    route: { location_name: 'City', itinerary_route_ID: 2 },
    plan: { arrival_location: 'City' },
    index: 1,
    routes: [{ itinerary_route_ID: 1 }, { itinerary_route_ID: 2 }],
    routeHotelMap: new Map([[1, { hotel_name: 'Night Hotel' }]]),
    formatTime: (value) => value ? (value instanceof Date && value.getUTCHours() === 9 ? '09:30 AM' : '10:00 AM') : null,
    timeToMinutes: (value) => value === '09:30 AM' ? 570 : 600,
    isForcedManualConflictAttractionRow: () => false,
    getRouteHotelName: () => 'Night Hotel',
  });

  assert.equal(result.get(21)?.from, 'Night Hotel');
});
