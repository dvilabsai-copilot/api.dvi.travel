import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineCandidatePreparationService } from '../src/modules/itineraries/engines/helpers/timeline-candidate-preparation.service';

test('runs candidate preparation stages in order and returns scheduling metadata', async () => {
  const calls: string[] = [];
  const service = new TimelineCandidatePreparationService(
    { apply: (value: any) => { calls.push(`manual:${value.selectedHotspots.length}`); return { selectedHotspots: [2], routeDesiredMovableSet: new Set([1]), desiredMovableOrderRank: new Map([[1, 0]]), routePreferredAdjacencyPairs: [[1, 2]] }; } },
    { apply: async (value: any) => { calls.push(`reserve:${value.selectedHotspots.length}`); return [2, 3]; } },
    { apply: (value: any) => { calls.push(`carry:${value.selectedHotspots.length}`); return { selectedHotspots: [3], hasOnlySourceFallbackCandidates: true }; } },
    { apply: async (value: any) => { calls.push(`matrix:${value.selectedHotspots.length}`); return [3, 4]; } },
    { reorder: (value: any[]) => { calls.push(`reorder:${value.length}`); return value.reverse(); } },
  );

  const result = await service.prepare({
    selectedHotspots: [1],
    existingHotspots: [],
    minimumReservationCount: 4,
    logTimeline: () => calls.push('log'),
    estimateRouteHotspotCapacity: () => 0,
    isHotspotAlreadyPlanned: () => false,
    fetchSelectedHotspots: async () => [],
    fetchDay1TopPrioritySourceHotspots: async () => [],
    hotspotLocationMatchesCity: () => true,
    logBookingRule: () => undefined,
    mergeCarryForwardIntoCandidates: () => undefined,
    getBetweenCandidatesForRouteSlots: async () => [],
    canonicalCityKey: (value: string) => value,
    checkHotspotOperatingHoursFromMap: () => ({ valid: true }),
  });

  assert.deepEqual(calls, ['manual:1', 'reserve:1', 'carry:2', 'log', 'matrix:1', 'reorder:2']);
  assert.deepEqual(result.selectedHotspots, [4, 3]);
  assert.equal(result.hasOnlySourceFallbackCandidates, true);
  assert.deepEqual(Array.from(result.routeDesiredMovableSet), [1]);
  assert.deepEqual(result.routePreferredAdjacencyPairs, [[1, 2]]);
});

test('preserves the preparation result when all optional stages return empty candidates', async () => {
  const service = new TimelineCandidatePreparationService(
    { apply: (value: any) => ({ selectedHotspots: value.selectedHotspots, routeDesiredMovableSet: new Set(), desiredMovableOrderRank: new Map(), routePreferredAdjacencyPairs: [] }) },
    { apply: async (value: any) => value.selectedHotspots },
    { apply: (value: any) => ({ selectedHotspots: value.selectedHotspots, hasOnlySourceFallbackCandidates: false }) },
    { apply: async (value: any) => value.selectedHotspots },
    { reorder: (value: any[]) => value },
  );

  const result = await service.prepare({ selectedHotspots: [], logTimeline: () => undefined });
  assert.deepEqual(result.selectedHotspots, []);
  assert.equal(result.hasOnlySourceFallbackCandidates, false);
});
