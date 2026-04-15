import assert from 'node:assert/strict';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';

function makeService(): any {
  const svc = new ItinerariesService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  ) as any;

  svc['getDistance_PHP'] = async (from: string, to: string): Promise<number> => {
    const a = String(from || '').toLowerCase();
    const b = String(to || '').toLowerCase();
    if (a === b) return 0;

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

    return matrix[`${a}|${b}`] ?? 100;
  };

  return svc;
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

function assertNoConsecutiveDuplicateLocations(chain: string[]): void {
  for (let i = 0; i < chain.length - 1; i++) {
    assert.notEqual(
      chain[i].toLowerCase().trim(),
      chain[i + 1].toLowerCase().trim(),
      `Found consecutive duplicate locations at index ${i}: ${chain[i]}`,
    );
  }
}

async function runRouteOptimizerNormalizationTests() {
  process.env.DEBUG_ROUTE_OPTIMIZER = 'false';

  const svc: any = makeService();

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
    assert.equal(chain.filter((name) => name.toLowerCase() === 'pondicherry').length, 1);
    assertNoConsecutiveDuplicateLocations(chain);
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
    assert.equal(
      chain.slice(1, -1).some((name) => name.toLowerCase().includes('airport')),
      false,
      'Airport-like terminal location leaked into movable middle stops',
    );
    assertNoConsecutiveDuplicateLocations(chain);
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

    assert.deepEqual(chain, [
      'Chennai Domestic airport',
      'Chennai',
      'Chennai Domestic airport',
      'Chennai Domestic airport',
    ]);
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
    assert.equal(chain.filter((name) => name.toLowerCase() === 'pondicherry').length, 1);
    assertNoConsecutiveDuplicateLocations(chain);
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
    const brokenRoutes = [
      {
        itinerary_route_id: 1,
        location_name: 'Chennai Domestic airport',
        next_visiting_location: 'Pondicherry',
        itinerary_route_date: '2026-04-01T00:00:00.000Z',
        no_of_days: 1,
        direct_to_next_visiting_place: 1,
        via_route: '',
      },
      {
        itinerary_route_id: 2,
        location_name: 'Coimbatore',
        next_visiting_location: 'Chennai Domestic airport',
        itinerary_route_date: '2026-04-02T00:00:00.000Z',
        no_of_days: 2,
        direct_to_next_visiting_place: 1,
        via_route: '',
      },
    ];

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
