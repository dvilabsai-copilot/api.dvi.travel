import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineManualPlacementOrderingService } from '../src/modules/itineraries/engines/helpers/timeline-manual-placement-ordering.service';

function createService() {
  const logs: any[] = [];
  return {
    service: new TimelineManualPlacementOrderingService((entry) => logs.push(entry)),
    logs,
  };
}

test('preserves route-scoped preview membership and filters sibling candidates', () => {
  const { service, logs } = createService();
  const result = service.apply({
    options: { scopeToRouteId: true },
    route: { itinerary_route_ID: 10 },
    plan: { quote_id: 1 },
    planId: 2,
    selectedHotspots: [{ hotspot_ID: 1 }, { hotspot_ID: 2 }],
    existingHotspots: [
      { itinerary_route_ID: 10, item_type: 4, hotspot_ID: 1, deleted: 0 },
      { itinerary_route_ID: 11, item_type: 4, hotspot_ID: 2, deleted: 0 },
    ],
  });

  assert.deepEqual(result.selectedHotspots.map((hotspot) => hotspot.hotspot_ID), [1]);
  assert.equal(logs[0].rule, 'SCOPED_PREVIEW_ROUTE_HOTSPOT_FILTER');
});

test('applies desired same-city order and merges persisted manual selections', () => {
  const { service, logs } = createService();
  const result = service.apply({
    options: {
      manualPlacementByRoute: { 10: { hotspotOrder: 1 } },
      sameCityAllocationPlan: {
        desiredMovableOrderByRoute: { 10: [2, 1] },
        preferredAdjacencyPairsByRoute: { 10: [[1, 2]] },
      },
    },
    route: { itinerary_route_ID: 10 },
    plan: { quote_id: 1 },
    planId: 2,
    selectedHotspots: [
      { hotspot_ID: 1, display_order: 20 },
      { hotspot_ID: 2, display_order: 10 },
    ],
    existingHotspots: [
      { itinerary_route_ID: 10, item_type: 4, hotspot_ID: 3, hotspot_plan_own_way: 1, hotspot_order: 4, deleted: 0 },
    ],
  });

  assert.deepEqual(result.selectedHotspots.map((hotspot) => hotspot.hotspot_ID), [3, 2, 1]);
  assert.equal(result.selectedHotspots[0].isManualSelection, true);
  assert.deepEqual([...result.desiredMovableOrderRank.entries()], [[2, 0], [1, 1]]);
  assert.deepEqual(result.routePreferredAdjacencyPairs, [[1, 2]]);
  assert.equal(logs.some((entry) => entry.rule === 'SAME_CITY_DESIRED_MOVABLE_ORDER_APPLIED'), true);
});

test('returns the original selection when no placement policy is present', () => {
  const { service } = createService();
  const selected = [{ hotspot_ID: 9 }];
  const result = service.apply({
    route: { itinerary_route_ID: 10 },
    plan: {},
    planId: 2,
    selectedHotspots: selected,
    existingHotspots: [],
  });

  assert.deepEqual(result.selectedHotspots, selected);
  assert.equal(result.routeDesiredMovableSet.size, 0);
  assert.equal(result.desiredMovableOrderRank.size, 0);
});
