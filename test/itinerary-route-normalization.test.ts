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

test(
  'keeps only arrival and departure fixed while every middle occurrence remains movable',
  () => {
    const context =
      service.extractRouteOptimizationContext(
        routes([
          'Chennai Domestic airport',
          'Pondicherry',
          'Chennai',
          'Pondicherry',
          'Chennai Domestic airport',
        ]),
      );

    assert.equal(
      context.start,
      'Chennai Domestic airport',
    );

    assert.equal(
      context.end,
      'Chennai Domestic airport',
    );

    assert.deepEqual(
      context.cleanedFullPath,
      [
        'Chennai Domestic airport',
        'Pondicherry',
        'Chennai',
        'Pondicherry',
        'Chennai Domestic airport',
      ],
    );

    assert.deepEqual(
      context.movableStops.map(
        (stop) => stop.name,
      ),
      [
        'Pondicherry',
        'Chennai',
        'Pondicherry',
      ],
    );

    assert.equal(
      context.removedDuplicates.length,
      0,
    );

    assert.equal(
      context.removedInvalidTerminalNodes.length,
      0,
    );
  },
);
test(
  'keeps consecutive literal repeats as stay days',
  () => {
    const context =
      service.extractRouteOptimizationContext(
        routes([
          'A',
          'B',
          'B',
          'C',
          'D',
        ]),
      );

    assert.deepEqual(
      context.cleanedFullPath,
      [
        'A',
        'B',
        'C',
        'D',
      ],
    );

    assert.deepEqual(
      context.movableStops.map(
        (stop) => stop.name,
      ),
      [
        'B',
        'C',
      ],
    );

    assert.equal(
      context.stayDays.length,
      1,
    );

    assert.equal(
      context.stayDays[0].name,
      'B',
    );

    assert.equal(
      context.stayDays[0].count,
      1,
    );
  },
);

test(
  'preserves every non-consecutive revisit in a 16-day itinerary',
  () => {
    const context =
      service.extractRouteOptimizationContext(
        routes([
          'Chennai International Airport',
          'Thanjavur',
          'Mahabalipuram',
          'Trichy',
          'Madurai',
          'Kanchipuram, Tamil Nadu, India',
          'Kanchipuram, Railway Station',
          'Mahabalipuram',
          'Trichy',
          'Coimbatore',
          'Madurai',
          'Coimbatore',
          'Kanchipuram, Tamil Nadu, India',
          'Kanchipuram, Railway Station',
          'Yelagiri, Tamil Nadu, India',
          'Pondicherry',
          'Pondicherry Airport',
        ]),
      );

    assert.equal(
      context.cleanedFullPath.length,
      17,
    );

    assert.equal(
      context.movableStops.length,
      15,
    );

    const names =
      context.movableStops.map(
        (stop) => stop.name,
      );

    assert.equal(
      names.filter(
        (name) =>
          name ===
          'Mahabalipuram',
      ).length,
      2,
    );

    assert.equal(
      names.filter(
        (name) =>
          name === 'Trichy',
      ).length,
      2,
    );

    assert.equal(
      names.filter(
        (name) =>
          name === 'Madurai',
      ).length,
      2,
    );

    assert.equal(
      names.filter(
        (name) =>
          name ===
          'Coimbatore',
      ).length,
      2,
    );

    assert.equal(
      context.stayDays.length,
      0,
    );
  },
);

test(
  'allows a middle occurrence even when it matches an arrival or departure anchor',
  () => {
    const context =
      service.extractRouteOptimizationContext(
        routes([
          'Chennai Domestic airport',
          'Pondicherry',
          'Chennai Domestic airport',
          'Mahabalipuram',
          'Chennai Domestic airport',
        ]),
      );

    assert.equal(
      context.start,
      'Chennai Domestic airport',
    );

    assert.equal(
      context.end,
      'Chennai Domestic airport',
    );

    assert.deepEqual(
      context.movableStops.map(
        (stop) => stop.name,
      ),
      [
        'Pondicherry',
        'Chennai Domestic airport',
        'Mahabalipuram',
      ],
    );

    assert.equal(
      context.removedInvalidTerminalNodes.length,
      0,
    );
  },
);

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
