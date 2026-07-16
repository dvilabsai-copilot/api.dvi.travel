import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualFitGeometryService } from '../src/modules/itineraries/services/itinerary-manual-fit-geometry.service';

test('manual-fit geometry preserves route coordinate parsing and projection ordering', () => {
  const service = new ItineraryManualFitGeometryService();
  const coordinates = service.parseRouteCoordinates('[[0,0],[1,0],[2,0]]');
  const projection = service.findNearestProgressOnRoute({ lat: 0, lng: 1.5 }, coordinates);

  assert.deepEqual(coordinates, [[0, 0], [1, 0], [2, 0]]);
  assert.equal(Number.isFinite(projection.distanceMeters), true);
  assert.equal(projection.progressRatio > 0.5, true);
  assert.equal(projection.progressRatio < 1, true);
});
