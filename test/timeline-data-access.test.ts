import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineDataAccessService } from '../src/modules/itineraries/engines/helpers/timeline-data-access.service';

const service = new TimelineDataAccessService();

test('normalizes inter-city zero-distance travel rows without changing local rows', () => {
  const row = { item_type: 3, hotspot_travelling_distance: 0 } as any;
  assert.equal(service.normalizeTravelRowDistance(row, 'Chennai', 'Bengaluru').hotspot_travelling_distance, null);
  assert.equal(service.normalizeTravelRowDistance(row, 'Chennai', 'Chennai').hotspot_travelling_distance, 0);
});

test('batches between-map rows under exact and reverse slot keys', async () => {
  const tx = {
    $queryRawUnsafe: async () => [
      { from_hotspot_id: 10, to_hotspot_id: 20, between_hotspot_id: 30, route_fit_type: 'ON_ROUTE' },
    ],
  };
  const result = await service.getBetweenCandidatesForRouteSlots(tx as any, [{ fromId: 10, toId: 20 }]);
  assert.equal(result.get('10_20')?.[0].between_hotspot_id, 30);
  assert.equal(result.get('20_10')?.[0].between_hotspot_id, 30);
});

test('derives arrival billing state from marker rows and legacy hotel dates', async () => {
  const markerTx = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{ group_type: 1 }],
      findFirst: async () => null,
    },
  };
  assert.deepEqual(
    await service.getArrivalPolicyDecisionStateForRoute(markerTx as any, 1, 2, new Date('2026-07-16T00:00:00Z')),
    { previousDayBillingDecisionProvided: true, previousDayBillingConfirmed: true },
  );

  const legacyTx = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [],
      findFirst: async () => ({ itinerary_route_date: new Date('2026-07-15T00:00:00Z') }),
    },
  };
  assert.deepEqual(
    await service.getArrivalPolicyDecisionStateForRoute(legacyTx as any, 1, 2, new Date('2026-07-16T00:00:00Z')),
    { previousDayBillingDecisionProvided: true, previousDayBillingConfirmed: true },
  );
});

test('loads timeline inputs with active predicates and groups timings for O(1) lookup', async () => {
  const calls: Array<{ model: string; args: any }> = [];
  const tx = {
    dvi_itinerary_plan_details: {
      findFirst: async (args: any) => {
        calls.push({ model: 'plan', args });
        return { itinerary_plan_ID: 7 };
      },
    },
    dvi_itinerary_route_details: {
      findMany: async (args: any) => {
        calls.push({ model: 'routes', args });
        return [{ itinerary_route_ID: 11 }];
      },
    },
    dvi_hotspot_place: {
      findMany: async (args: any) => {
        calls.push({ model: 'hotspots', args });
        return [{ hotspot_ID: 101 }];
      },
    },
    dvi_hotspot_timing: {
      findMany: async (args: any) => {
        calls.push({ model: 'timings', args });
        return [
          { hotspot_ID: 101, hotspot_timing_day: 2, open: '09:00' },
          { hotspot_ID: 101, hotspot_timing_day: 2, open: '10:00' },
        ];
      },
    },
  };

  const plan = await service.loadPlan(tx as any, 7);
  const routes = await service.loadRoutes(tx as any, 7);
  const allHotspots = await service.loadAllActiveHotspots(tx as any);
  const allTimings = await service.loadAllActiveTimings(tx as any);
  const timingMap = service.buildTimingMap(allTimings);

  assert.equal(plan.itinerary_plan_ID, 7);
  assert.equal(routes[0].itinerary_route_ID, 11);
  assert.equal(allHotspots[0].hotspot_ID, 101);
  assert.equal(timingMap.get(101)?.get(2)?.length, 2);
  assert.deepEqual(calls.map((call) => call.model), ['plan', 'routes', 'hotspots', 'timings']);
  assert.deepEqual(calls[0].args.where, { itinerary_plan_ID: 7, deleted: 0 });
  assert.deepEqual(calls[2].args.where, { deleted: 0, status: 1 });
});
