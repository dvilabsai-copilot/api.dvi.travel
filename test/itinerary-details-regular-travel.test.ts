import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsRegularTravelService } from '../src/modules/itineraries/services/itinerary-details-regular-travel.service';

test('projects a regular semantic travel row and returns updated loop state', async () => {
  const service = new ItineraryDetailsRegularTravelService();
  const row = { route_hotspot_ID: 8, hotspot_ID: 4, hotspot_order: 2, is_conflict: 0 };
  const segments: any[] = [];
  const result = await service.append({
    facade: {
      formatTime: () => '10:00 AM',
      orderedTimeRange: (start: string | null, end: string | null) => `${start} - ${end}`,
      durationToMinutes: () => 30,
      parseDisplayTimeMinutesStrict: () => 600,
      minutesToDisplayTime: () => '10:30 AM',
      formatDurationFromDisplayRange: () => '30 Min',
      formatDuration: () => '30 Min',
      resolveTravelDistanceKm: async () => 5,
      formatTravelDistance: () => '5.00 KM',
    },
    rh: row,
    master: { hotspot_name: 'Museum' },
    location: { source_location: 'City', destination_location: 'Museum' },
    route: { itinerary_route_ID: 3, next_visiting_location: 'Museum', route_start_time: new Date() },
    plan: { arrival_location: 'City', departure_location: 'Museum' },
    routeHotspots: [row],
    travelSegmentSemantics: new Map([[8, { from: 'City', to: 'Museum', fromHotspotId: null, toHotspotId: 4 }]]),
    previousStopName: 'City',
    pendingForcedManualConflictRows: [],
    insertedForcedManualConflictHotspotIds: new Set<number>(),
    startHotspot: null,
    startTimeText: '10:00 AM',
    endTimeText: '10:30 AM',
    travelDuration: '00:30:00',
    routeHotelMap: new Map(),
    routes: [],
    index: 0,
    hotspotMap: new Map([[4, { hotspot_name: 'Museum' }]]),
    hotspotGalleryMap: new Map(),
    pushHotspotAnchorPlaceholder: () => undefined,
    normalizeName: (value?: string | null) => String(value ?? '').trim().toLowerCase(),
    findNextSemanticDestinationName: () => null,
    inferHotspotIdFromLabel: () => null,
    getRouteHotelName: () => 'Hotel',
    proofQuoteEnabled: false,
    quoteId: 'Q1',
    segments,
    seenAttraction: false,
    emittedTravelBeforeFirstAttraction: false,
    totalDistanceKm: 0,
    viaLocationName: null,
    distanceNum: 0,
    travelDistance: '0.00 KM',
  });

  assert.equal(result.previousStopName, 'Museum');
  assert.equal(result.totalDistanceKm, 5);
  assert.equal(result.seenAttraction, false);
  assert.equal(result.emittedTravelBeforeFirstAttraction, true);
  assert.equal(segments[0].from, 'City');
  assert.equal(segments[0].to, 'Museum');
});
