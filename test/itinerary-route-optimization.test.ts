import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryRouteOptimizationService } from '../src/modules/itineraries/services/itinerary-route-optimization.service';

test('preserves PHP-parity exhaustive ordering for a small route set', async () => {
  const distances: Record<string, number> = {
    'A>B': 1, 'B>C': 1, 'C>D': 1,
    'A>C': 10, 'C>B': 10, 'B>D': 10,
  };
  const service = new ItineraryRouteOptimizationService(
    { dvi_stored_locations: { findFirst: async (query: any) => ({ distance: distances[`${query.where.source_location}>${query.where.destination_location}`] }) } },
    {
      normalizeLocationName: (value: string) => value.trim().toLowerCase(),
      hasBrokenChain: () => false,
      extractRouteOptimizationContext: () => ({
        start: 'A',
        end: 'D',
        movableStops: [{ name: 'B', normalizedName: 'b' }, { name: 'C', normalizedName: 'c' }],
        removedDuplicates: [],
        removedInvalidTerminalNodes: [],
        sourceLocations: ['A', 'B', 'C'],
        nextVisitingLocations: ['B', 'C', 'D'],
        rawFullPath: ['A', 'B', 'C', 'D'],
        cleanedFullPath: ['A', 'B', 'C', 'D'],
        rawMiddleLocations: ['B', 'C'],
      }),
    } as any,
  );

  const result = await service.optimizeRouteOrder([
    { location_name: 'A', next_visiting_location: 'B', itinerary_route_date: '2026-07-16' },
    { location_name: 'B', next_visiting_location: 'C', itinerary_route_date: '2026-07-17' },
    { location_name: 'C', next_visiting_location: 'D', itinerary_route_date: '2026-07-18' },
  ]);

  assert.deepEqual(result.map((route) => [route.location_name, route.next_visiting_location]), [['A', 'B'], ['B', 'C'], ['C', 'D']]);
});

test('returns the original order when the route chain is broken', async () => {
  const routes = [{ location_name: 'A', next_visiting_location: 'C' }, { location_name: 'B', next_visiting_location: 'D' }];
  const service = new ItineraryRouteOptimizationService({}, {
    hasBrokenChain: () => true,
    extractRouteOptimizationContext: () => ({ start: 'A', end: 'D', movableStops: [] }),
    normalizeLocationName: (value: string) => value.toLowerCase(),
  } as any);
  assert.equal(await service.optimizeRouteOrder(routes), routes);
});
