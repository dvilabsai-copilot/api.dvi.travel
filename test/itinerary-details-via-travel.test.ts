import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsViaTravelService } from '../src/modules/itineraries/services/itinerary-details-via-travel.service';

test('emits a via-route travel segment and returns accumulated state', async () => {
  const service = new ItineraryDetailsViaTravelService();
  const segments: any[] = [];
  const result = await service.append({
    row: { via_location_name: 'Lake View' }, location: {}, route: { itinerary_route_ID: 2 },
    hotspotMap: new Map(), previousStopName: 'City', startTimeText: '11:00 AM', endTimeText: '11:30 AM',
    travelDuration: '00:30:00', segments, seenAttraction: false,
    resolveTravelDistanceKm: async () => 8,
    formatTravelDistance: (value) => `${value} KM`,
    getTravelTimeRangeWithDuration: (start, end) => `${start} - ${end}`,
    formatDuration: () => '30 Min', pushHotspotAnchorPlaceholder: () => undefined,
  });
  assert.equal(result.previousStopName, 'Lake View');
  assert.equal(result.totalDistanceKm, 8);
  assert.equal(segments[0].to, 'Lake View');
});
