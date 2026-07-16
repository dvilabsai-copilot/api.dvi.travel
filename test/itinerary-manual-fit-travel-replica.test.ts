import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualFitTravelReplicaService } from '../src/modules/itineraries/services/itinerary-manual-fit-travel-replica.service';

test('manual-fit travel replica preserves duration and distance display fields', () => {
  const service = new ItineraryManualFitTravelReplicaService();
  service.setCallbacks({ formatPreviewTravelDuration: (minutes: number) => `${minutes} Min` });

  const result = service.buildManualFitTravelReplicaDisplayFields(
    { duration: '30 Min', distance: '12.50 KM' },
    30,
    12.5,
  );

  assert.equal(result.duration, '30 Min');
  assert.equal(result.travelDuration, '30 Min');
  assert.equal(result.durationMinutes, 30);
  assert.equal(result.distance, '12.50 KM');
  assert.equal(result.hotspot_travelling_distance, '12.50 KM');
});

test('normalizes travel-replica labels and parses distance/duration fallbacks', () => {
  const service = new ItineraryManualFitTravelReplicaService();
  service.setCallbacks({
    getPreviewRowDurationMinutes: () => 45,
    parseSegmentStartMinutes: () => 0,
    parseSegmentEndMinutes: () => 0,
  });

  assert.equal(service.normalizeManualFitTravelReplicaLabel(' Travelling to Munnar '), 'munnar');
  assert.equal(service.parseManualFitTravelReplicaDistanceKm('12.50 KM'), 12.5);
  assert.equal(service.getManualFitTravelReplicaDurationMinutes({}), 45);
});

test('indexes main-timeline travel replicas by ids and normalized labels', () => {
  const service = new ItineraryManualFitTravelReplicaService();
  const row = { type: 'travel', fromHotspotId: 10, toHotspotId: 20, fromName: 'Kochi', toName: 'Munnar' };
  const replicaMap = service.buildManualFitMainTimelineTravelReplicaMap([
    { type: 'attraction', locationId: 10, text: 'Kochi' },
    row,
    { type: 'attraction', locationId: 20, text: 'Munnar' },
  ]);

  assert.equal(service.findManualFitMainTimelineTravelReplica(replicaMap, { fromName: 'Kochi', toName: 'Munnar' }), row);
  assert.equal(service.findManualFitMainTimelineTravelReplica(replicaMap, { fromHotspotId: 10, toHotspotId: 20 }), row);
});

test('preserves saved-rule location classification and HMS duration conversion', () => {
  const service = new ItineraryManualFitTravelReplicaService();

  assert.equal(service.getSavedRuleTravelLocationType('Kochi|Munnar', 'Kochi'), 1);
  assert.equal(service.getSavedRuleTravelLocationType('Kochi', 'Munnar'), 2);
  assert.equal(service.hmsToMinutes('01:30:00'), 90);
});

test('projects hotspot endpoints with the saved-rule location fields', async () => {
  const service = new ItineraryManualFitTravelReplicaService();
  const endpoint = await service.resolveHotspotPreviewEndpoint({
    dvi_hotspot_place: {
      findFirst: async () => ({
        hotspot_ID: 9,
        hotspot_name: 'Tea Museum',
        hotspot_location: 'Munnar',
        hotspot_latitude: '10.1',
        hotspot_longitude: '76.2',
      }),
    },
  }, 9);

  assert.deepEqual(endpoint, {
    hotspotId: 9,
    hotspotName: 'Tea Museum',
    travelLocationName: 'Munnar',
    latitude: 10.1,
    longitude: 76.2,
  });
});
