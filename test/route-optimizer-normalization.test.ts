import assert from 'node:assert/strict';
import { ItineraryRouteOptimizationService } from '../src/modules/itineraries/services/itinerary-route-optimization.service';
import { ItineraryRouteNormalizationService } from '../src/modules/itineraries/services/itinerary-route-normalization.service';

function makeService() {
  const matrix: Record<string, number> = {
    'chennai domestic airport|pondicherry': 150,
    'chennai domestic airport|chennai': 20,
    'chennai|pondicherry': 120,
    'pondicherry|chennai domestic airport': 140,
    'chennai|chennai domestic airport': 18,
    'pondicherry|chennai': 125,
    'chennai domestic airport|coimbatore': 510,
    'coimbatore|chennai domestic airport': 490,
    'chennai|coimbatore': 500,
    'coimbatore|pondicherry': 360,
    'pondicherry|coimbatore': 350,
  };
  return new ItineraryRouteOptimizationService({
    dvi_stored_locations: {
      findFirst: async ({ where }: any) => {
        const from = String(where.source_location).toLowerCase();
        const to = String(where.destination_location).toLowerCase();
        return { distance: from === to ? 0 : (matrix[`${from}|${to}`] ?? 100) };
      },
    },
  } as any, new ItineraryRouteNormalizationService());
}

function makeRoutesFromChain(chain: string[]): any[] {
  const baseDate = new Date('2026-04-01T00:00:00.000Z');
  const routes: any[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const date = new Date(baseDate);
    date.setUTCDate(baseDate.getUTCDate() + i);
    routes.push({
      itinerary_route_id: i + 1,
      location_name: chain[i],
      next_visiting_location: chain[i + 1],
      itinerary_route_date: date.toISOString(),
      no_of_days: i + 1,
      direct_to_next_visiting_place: 1,
      via_route: '',
    });
  }
  return routes;
}

function chainFromRoutes(routes: any[]): string[] {
  if (!routes.length) return [];
  return [routes[0].location_name, ...routes.map((r) => r.next_visiting_location)];
}

function assertPreservesRouteDays(original: any[], optimized: any[]) {
  const itineraryDates = (routes: any[]) => routes.map(route => String(route.itinerary_route_date).slice(0, 10));
  assert.deepEqual(
    itineraryDates(optimized),
    itineraryDates(original),
  );
  assert.deepEqual(
    chainFromRoutes(optimized).slice(1, -1).sort(),
    chainFromRoutes(original).slice(1, -1).sort(),
  );
  for (let index = 1; index < optimized.length; index++) {
    assert.equal(optimized[index - 1].next_visiting_location, optimized[index].location_name);
  }
}

async function runRouteOptimizerNormalizationTests() {
  process.env.DEBUG_ROUTE_OPTIMIZER = 'false';

  const svc = makeService();

  {
    const routes = makeRoutesFromChain([
      'Chennai Domestic airport',
      'Pondicherry',
      'Chennai',
      'Pondicherry',
      'Chennai Domestic airport',
    ]);

    const optimized = await svc.optimizeRouteOrder(routes);
    const chain = chainFromRoutes(optimized);

    assert.equal(chain[0], 'Chennai Domestic airport');
    assert.equal(chain[chain.length - 1], 'Chennai Domestic airport');
    assertPreservesRouteDays(routes, optimized);
  }

  {
    const routes = makeRoutesFromChain([
      'Chennai Domestic airport',
      'Pondicherry',
      'Chennai Domestic airport',
      'Chennai',
      'Chennai Domestic airport',
    ]);

    const optimized = await svc.optimizeRouteOrder(routes);
    const chain = chainFromRoutes(optimized);

    assert.equal(chain[0], 'Chennai Domestic airport');
    assert.equal(chain[chain.length - 1], 'Chennai Domestic airport');
    assertPreservesRouteDays(routes, optimized);
  }

  {
    const routes = makeRoutesFromChain([
      'Chennai Domestic airport',
      'Pondicherry',
      'Chennai Domestic airport',
    ]);

    const optimized = await svc.optimizeRouteOrder(routes);
    const chain = chainFromRoutes(optimized);

    assert.deepEqual(chain, ['Chennai Domestic airport', 'Pondicherry', 'Chennai Domestic airport']);
  }

  {
    const routes = makeRoutesFromChain([
      'Chennai Domestic airport',
      'Chennai',
      'Chennai Domestic airport',
      'Chennai Domestic airport',
    ]);

    const optimized = await svc.optimizeRouteOrder(routes);
    const chain = chainFromRoutes(optimized);

    assert.equal(chain[0], 'Chennai Domestic airport');
    assert.equal(chain[chain.length - 1], 'Chennai Domestic airport');
    assertPreservesRouteDays(routes, optimized);
    assert.equal(optimized.filter(route =>
      route.location_name === 'Chennai Domestic airport' &&
      route.next_visiting_location === 'Chennai Domestic airport'
    ).length, 1);
  }

  {
    const routes = makeRoutesFromChain([
      'Chennai Domestic airport',
      'Pondicherry',
      'Pondicherry',
      'Pondicherry',
      'Chennai Domestic airport',
    ]);

    const optimized = await svc.optimizeRouteOrder(routes);
    const chain = chainFromRoutes(optimized);

    assert.equal(chain[0], 'Chennai Domestic airport');
    assert.equal(chain[chain.length - 1], 'Chennai Domestic airport');
    assertPreservesRouteDays(routes, optimized);
  }

  {
    const routes = makeRoutesFromChain([
      'Chennai Domestic airport',
      'Bengaluru Airport',
      'Chennai Domestic airport',
    ]);

    const optimized = await svc.optimizeRouteOrder(routes);
    const chain = chainFromRoutes(optimized);

    assert.deepEqual(chain, ['Chennai Domestic airport', 'Bengaluru Airport', 'Chennai Domestic airport']);
  }

  {
    const brokenRoutes = makeRoutesFromChain([
      'Chennai Domestic airport', 'Pondicherry', 'Chennai', 'Chennai Domestic airport',
    ]);
    brokenRoutes[1].location_name = 'Coimbatore';

    const optimized = await svc.optimizeRouteOrder(brokenRoutes);
    assert.deepEqual(optimized, brokenRoutes);
  }
}

runRouteOptimizerNormalizationTests()
  .then(() => {
    console.log('route-optimizer-normalization tests passed');
  })
  .catch((error) => {
    console.error('route-optimizer-normalization tests failed:', error);
    process.exit(1);
  });
