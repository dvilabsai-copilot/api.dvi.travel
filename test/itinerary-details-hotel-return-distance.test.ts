import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsService } from '../src/modules/itineraries/itinerary-details.service';

const createService = () => new ItineraryDetailsService({} as any, {} as any, {} as any);

test('return-to-hotel distance uses the selected hotel coordinates instead of the stored city distance', async () => {
  const service = createService();
  let requestedEndpoints: number[] | null = null;
  (service as any).getOsrmRouteDistanceKm = async (...coordinates: number[]) => {
    requestedEndpoints = coordinates;
    return 43.7;
  };

  const distance = await (service as any).resolveTravelDistanceKm({
    row: { hotspot_travelling_distance: 78.83 },
    itemType: 3,
    location: {},
    route: {},
    preferToCoordinates: true,
    preferredToCoordinates: { latitude: 17.2543, longitude: 78.6808 },
    semanticFromHotspotId: 503,
    fromName: 'Sightseeing hotspot',
    toName: 'Selected hotel',
    hotspotMap: new Map([[503, { hotspot_latitude: 17.3616, hotspot_longitude: 78.4747 }]]),
  });

  assert.equal(distance, 43.7);
  assert.deepEqual(requestedEndpoints, [17.3616, 78.4747, 17.2543, 78.6808]);
});

test('return-to-hotel distance is omitted when selected hotel coordinates are missing', async () => {
  const service = createService();
  let routeLookupCalled = false;
  (service as any).getOsrmRouteDistanceKm = async () => {
    routeLookupCalled = true;
    return 43.7;
  };

  const distance = await (service as any).resolveTravelDistanceKm({
    row: { hotspot_travelling_distance: 78.83 },
    itemType: 3,
    location: {},
    route: {},
    preferToCoordinates: true,
    preferredToCoordinates: null,
    semanticFromHotspotId: 503,
    fromName: 'Sightseeing hotspot',
    toName: 'Selected hotel',
    hotspotMap: new Map([[503, { hotspot_latitude: 17.3616, hotspot_longitude: 78.4747 }]]),
  });

  assert.equal(distance, null);
  assert.equal(routeLookupCalled, false);
});

test('return-to-hotel distance is omitted when hotel coordinates are invalid', async () => {
  const service = createService();
  const distance = await (service as any).resolveTravelDistanceKm({
    row: { hotspot_travelling_distance: 78.83 },
    itemType: 3,
    location: {},
    route: {},
    preferToCoordinates: true,
    preferredToCoordinates: { latitude: 0, longitude: 0 },
    semanticFromHotspotId: 503,
    fromName: 'Sightseeing hotspot',
    toName: 'Selected hotel',
    hotspotMap: new Map([[503, { hotspot_latitude: 17.3616, hotspot_longitude: 78.4747 }]]),
  });

  assert.equal(distance, null);
});

test('return-to-hotel distance is omitted when the driving router has no route', async () => {
  const service = createService();
  (service as any).getOsrmRouteDistanceKm = async () => null;

  const distance = await (service as any).resolveTravelDistanceKm({
    row: { hotspot_travelling_distance: 78.83 },
    itemType: 3,
    location: {},
    route: {},
    preferToCoordinates: true,
    preferredToCoordinates: { latitude: 17.2543, longitude: 78.6808 },
    semanticFromHotspotId: 503,
    fromName: 'Sightseeing hotspot',
    toName: 'Selected hotel',
    hotspotMap: new Map([[503, { hotspot_latitude: 17.3616, hotspot_longitude: 78.4747 }]]),
  });

  assert.equal(distance, null);
});

test('ordinary travel legs retain their existing stored-distance behavior', async () => {
  const service = createService();
  const distance = await (service as any).resolveTravelDistanceKm({
    row: { hotspot_travelling_distance: 12.5 },
    itemType: 3,
    location: {},
    route: {},
    fromName: 'A',
    toName: 'B',
    hotspotMap: new Map(),
  });

  assert.equal(distance, 12.5);
});
