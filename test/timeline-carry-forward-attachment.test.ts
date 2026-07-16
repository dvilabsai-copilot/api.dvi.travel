import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineCarryForwardAttachmentService } from '../src/modules/itineraries/engines/helpers/timeline-carry-forward-attachment.service';

function input(overrides: Partial<any> = {}) {
  const logs: any[] = [];
  const service = new TimelineCarryForwardAttachmentService();
  return {
    service,
    logs,
    value: {
      route: { itinerary_route_ID: 10, no_of_days: 3 },
      plan: { quote_id: 99 },
      planId: 7,
      routeIndex: 2,
      sourceCity: 'Chennai',
      destinationCity: 'Bengaluru',
      selectedHotspots: [{ hotspot_ID: 1, matched_bucket: 'source_fallback' }],
      carryForwardHotspots: [{ hotspot_ID: 5 }],
      addedHotspotIds: new Set<number>(),
      forceNoSightseeingOnThisRoute: false,
      sameCityChainContinuation: true,
      mergeCarryForwardIntoCandidates: () => [{ hotspot_ID: 5 }, { hotspot_ID: 1 }],
      logBookingRule: (entry: any) => logs.push(entry),
      ...overrides,
    },
  };
}

test('attaches carry-forward hotspots only on a same-city continuation', () => {
  const { service, value, logs } = input();
  const result = service.apply(value);

  assert.deepEqual(result.selectedHotspots.map((hotspot) => hotspot.hotspot_ID), [5, 1]);
  assert.equal(result.hasOnlySourceFallbackCandidates, true);
  assert.equal(logs[0].rule, 'STRICT_CARRY_FORWARD_ATTACHED');
});

test('does not attach carry-forward hotspots when sightseeing is suppressed or the chain ended', () => {
  let mergeCalls = 0;
  const { service, value } = input({
    forceNoSightseeingOnThisRoute: true,
    mergeCarryForwardIntoCandidates: () => {
      mergeCalls += 1;
      return [];
    },
  });

  const result = service.apply(value);

  assert.deepEqual(result.selectedHotspots, value.selectedHotspots);
  assert.equal(mergeCalls, 0);
});

test('reports when the selected bucket contains only source fallbacks', () => {
  const { service, value } = input({
    carryForwardHotspots: [],
    selectedHotspots: [
      { hotspot_ID: 1, matched_bucket: 'source_fallback' },
      { hotspot_ID: 2, matched_bucket: 'source_fallback' },
    ],
  });

  assert.equal(service.apply(value).hasOnlySourceFallbackCandidates, true);
});
