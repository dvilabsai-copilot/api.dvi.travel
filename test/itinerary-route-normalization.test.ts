import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryRouteNormalizationService } from '../src/modules/itineraries/services/itinerary-route-normalization.service';

const service = new ItineraryRouteNormalizationService();

function routes(chain: string[]) {
  return chain.slice(0, -1).map((location_name, index) => ({
    location_name,
    next_visiting_location: chain[index + 1],
  }));
}

test('normalizes duplicate movable stops while preserving anchors', () => {
  const context = service.extractRouteOptimizationContext(routes([
    'Chennai Domestic airport',
    'Pondicherry',
    'Chennai',
    'Pondicherry',
    'Chennai Domestic airport',
  ]));

  assert.equal(context.cleanedFullPath[0], 'Chennai Domestic airport');
  assert.equal(context.cleanedFullPath.at(-1), 'Chennai Domestic airport');
  assert.deepEqual(context.movableStops.map((stop) => stop.name), ['Pondicherry']);
  const middle = context.cleanedFullPath.slice(1, -1);
  assert.equal(new Set(middle.map((name) => service.normalizeLocationName(name))).size, middle.length);
});

test('recognizes a broken route chain without changing it', () => {
  assert.equal(service.hasBrokenChain([
    { location_name: 'Chennai Domestic airport', next_visiting_location: 'Pondicherry' },
    { location_name: 'Coimbatore', next_visiting_location: 'Chennai Domestic airport' },
  ]), true);
});

test('does not treat terminal anchors as movable stops', () => {
  const context = service.extractRouteOptimizationContext(routes([
    'Chennai Domestic airport',
    'Pondicherry',
    'Chennai Domestic airport',
    'Chennai Domestic airport',
  ]));

  assert.deepEqual(context.movableStops.map((stop) => stop.name), ['Pondicherry']);
  assert.equal(context.movableStops.some((stop) => service.isTerminalAnchorLocation(stop.name)), false);
});
