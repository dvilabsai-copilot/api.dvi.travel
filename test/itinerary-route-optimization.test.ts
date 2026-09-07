import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryRouteOptimizationService } from '../src/modules/itineraries/services/itinerary-route-optimization.service';

test('preserves PHP-parity exhaustive ordering for a small route set', async () => {
  const distances: Record<string, number> = {
    'A>B': 1, 'B>C': 1, 'C>D': 1,
    'A>C': 10, 'C>B': 10, 'B>D': 10,
  };
  const service = new ItineraryRouteOptimizationService(
  {
    dvi_stored_locations: {
      findFirst: async (query: any) => ({
        distance:
          distances[
            `${query.where.source_location}>${query.where.destination_location}`
          ],
      }),
    },
  } as any,
  {
    normalizeLocationName: (
      value: string,
    ) =>
      value
        .trim()
        .toLowerCase(),

    hasBrokenChain: () => false,

    extractRouteOptimizationContext: () => ({
      start: 'A',

      end: 'D',

      movableStops: [
        {
          name: 'B',
          normalizedName: 'b',
        },
        {
          name: 'C',
          normalizedName: 'c',
        },
      ],

      stayDays: [],

      removedDuplicates: [],

      removedInvalidTerminalNodes: [],

      sourceLocations: [
        'A',
        'B',
        'C',
      ],

      nextVisitingLocations: [
        'B',
        'C',
        'D',
      ],

      rawFullPath: [
        'A',
        'B',
        'C',
        'D',
      ],

      cleanedFullPath: [
        'A',
        'B',
        'C',
        'D',
      ],

      rawMiddleLocations: [
        'B',
        'C',
      ],
    }),
  } as any,
);

const result = await service.optimizeRouteOrder([
  {
    location_name: 'A',
    next_visiting_location: 'B',
    itinerary_route_date: '2026-09-03',
  },
  {
    location_name: 'B',
    next_visiting_location: 'C',
    itinerary_route_date: '2026-09-04',
  },
  {
    location_name: 'C',
    next_visiting_location: 'D',
    itinerary_route_date: '2026-09-05',
  },
]);

  assert.deepEqual(result.map((route) => [route.location_name, route.next_visiting_location]), [['A', 'B'], ['B', 'C'], ['C', 'D']]);
});

test(
  'uses configured permutation workload instead of a hard-coded movable-day cutoff',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const shouldUseExhaustiveSearch =
      (
        service as any
      ).shouldUseExhaustiveSearch.bind(
        service,
      );

    assert.equal(
      shouldUseExhaustiveSearch(
        8,
        40320,
      ),
      true,
    );

    assert.equal(
      shouldUseExhaustiveSearch(
        9,
        40320,
      ),
      false,
    );

    assert.equal(
      shouldUseExhaustiveSearch(
        9,
        362880,
      ),
      true,
    );
  },
);

test(
  'long-route heuristic can generate more than the old 300-candidate limit',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const original =
      Array.from(
        { length: 14 },
        (_, index) =>
          `L${index + 1}`,
      );

    const distanceSeed =
      [...original].reverse();

    const orders =
      (
        service as any
      ).buildHeuristicMovableOrders(
        original,
        distanceSeed,
        2000,
      );

    assert.ok(
      orders.length > 300,
      `Expected more than 300 candidates, received ${orders.length}`,
    );
  },
);

test(
  'long-route heuristic preserves every movable destination',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const original = [
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
      'J',
      'K',
      'L',
    ];

    const orders =
      (
        service as any
      ).buildHeuristicMovableOrders(
        original,
        [...original].reverse(),
        1500,
      );

    const expected =
      [...original]
        .sort()
        .join('|');

    for (
      const order of orders
    ) {
      assert.equal(
        [...order]
          .sort()
          .join('|'),
        expected,
      );
    }
  },
);

test(
  'rejects invalid distance seed even when array length matches',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const original = [
      'A',
      'B',
      'C',
      'D',
      'E',
    ];

    const invalidSeed = [
      'A',
      'B',
      'C',
      'D',
      'D',
    ];

    const orders =
      (
        service as any
      ).buildHeuristicMovableOrders(
        original,
        invalidSeed,
        500,
      );

    const expected =
      [...original]
        .sort()
        .join('|');

    assert.ok(
      orders.length > 0,
    );

    assert.ok(
      orders.every(
        (order: string[]) =>
          [...order]
            .sort()
            .join('|') ===
          expected,
      ),
    );
  },
);

test(
  'candidate generation includes later itinerary positions',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const original =
      Array.from(
        { length: 14 },
        (_, index) =>
          `Day-${index + 1}`,
      );

    const orders =
      (
        service as any
      ).buildHeuristicMovableOrders(
        original,
        original,
        2000,
      );

    const originalLast =
      original[
        original.length - 1
      ];

    const laterPositionChanged =
      orders.some(
        (order: string[]) =>
          order[
            order.length - 1
          ] !== originalLast,
      );

    assert.equal(
      laterPositionChanged,
      true,
    );
  },
);

test(
  'accepts legitimate repeated movable destinations',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const validation =
      (
        service as any
      ).validateOptimizationInputs({
        start: 'A',

        end: 'D',

        movableStops: [
          {
            name: 'B',
            normalizedName: 'b',
          },
          {
            name: 'C',
            normalizedName: 'c',
          },
          {
            name: 'B',
            normalizedName: 'b',
          },
        ],
      });

    assert.deepEqual(
      validation,
      {
        isValid: true,
      },
    );
  },
);

test(
  'can move a unique middle city before between or after repeated destinations',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const movable = [
      'Pondicherry',
      'Chennai',
      'Pondicherry',
    ];

    const permutations =
      (
        service as any
      ).generatePermutations_PHP(
        movable,
      );

    const uniqueOrders =
      new Set(
        permutations.map(
          (order: string[]) =>
            order.join('>'),
        ),
      );

    assert.equal(
      uniqueOrders.has(
        [
          'Chennai',
          'Pondicherry',
          'Pondicherry',
        ].join('>'),
      ),
      true,
    );

    assert.equal(
      uniqueOrders.has(
        [
          'Pondicherry',
          'Chennai',
          'Pondicherry',
        ].join('>'),
      ),
      true,
    );

    assert.equal(
      uniqueOrders.has(
        [
          'Pondicherry',
          'Pondicherry',
          'Chennai',
        ].join('>'),
      ),
      true,
    );
  },
);

test(
  'heuristic supports relocation changes that a single swap cannot represent',
  () => {
    const service =
      new ItineraryRouteOptimizationService(
        {} as any,
        {} as any,
      );

    const original = [
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
    ];

    const orders =
      (
        service as any
      ).buildHeuristicMovableOrders(
        original,
        original,
        1000,
      );

    const expectedRelocation = [
      'B',
      'C',
      'D',
      'A',
      'E',
      'F',
    ].join('>');

    assert.ok(
      orders.some(
        (order: string[]) =>
          order.join('>') ===
          expectedRelocation,
      ),
    );
  },
);