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
