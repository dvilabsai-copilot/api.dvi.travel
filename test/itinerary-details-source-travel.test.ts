import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsSourceTravelService } from '../src/modules/itineraries/services/itinerary-details-source-travel.service';

test('appends a resolved source travel segment and returns loop state', async () => {
  const service = new ItineraryDetailsSourceTravelService();
  const segments: any[] = [];
  const result = await service.append({
    row: { route_hotspot_ID: 1 },
    location: { destination_location: 'Museum' },
    route: { itinerary_route_ID: 3, next_visiting_location: 'Museum' },
    hotspotMap: new Map(),
    routeHotelMap: new Map(),
    previousStopName: 'City',
    startTimeText: '10:00 AM',
    endTimeText: '10:30 AM',
    travelDuration: '00:30:00',
    segments,
    seenAttraction: false,
    resolveTravelDistanceKm: async () => 12.5,
    formatTravelDistance: (value) => `${value?.toFixed(2)} KM`,
    getTravelTimeRangeWithDuration: (start, end) => `${start} - ${end}`,
    formatDuration: () => '30 Min',
    pushHotspotAnchorPlaceholder: () => undefined,
  });

  assert.equal(result.previousStopName, 'Museum');
  assert.equal(result.totalDistanceKm, 12.5);
  assert.equal(result.emittedTravelBeforeFirstAttraction, true);
  assert.equal(segments[0].to, 'Museum');
});

test('treats same-place source travel as a no-op while updating the stop', async () => {
  const service = new ItineraryDetailsSourceTravelService();
  const result = await service.append({
    row: {}, location: {}, route: { itinerary_route_ID: 1, next_visiting_location: 'City' },
    hotspotMap: new Map(), routeHotelMap: new Map(), previousStopName: 'City',
    startTimeText: null, endTimeText: null, travelDuration: null, segments: [], seenAttraction: true,
    resolveTravelDistanceKm: async () => { throw new Error('must not resolve distance'); },
    formatTravelDistance: () => '', getTravelTimeRangeWithDuration: () => null, formatDuration: () => null,
    pushHotspotAnchorPlaceholder: () => { throw new Error('must not add anchor'); },
  });
  assert.equal(result.handled, true);
  assert.equal(result.totalDistanceKm, 0);
});
