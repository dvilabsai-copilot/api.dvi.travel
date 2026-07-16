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
