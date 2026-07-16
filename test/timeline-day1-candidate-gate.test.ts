import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineDay1CandidateGateService } from '../src/modules/itineraries/engines/helpers/timeline-day1-candidate-gate.service';

function evaluate(hotspot: any, overrides: Partial<any> = {}) {
  const logs: any[] = [];
  const input: any = {
    route: { itinerary_route_ID: 10 },
    hotspot,
    currentTime: '10:00:00',
    isRouteSourceTerminal: false,
    hasLaterOvernightInSourceCity: false,
    isHotspotAlreadyPlanned: () => false,
    resolveTimelineBucket: (value: any) => String(value.matched_bucket || 'source'),
    isRouteMovementBucket: (bucket: string) => bucket === 'via' || bucket === 'en_route',
    isSourceBucket: (bucket: string) => bucket === 'source',
    logHotspotCandidateEvaluation: (entry: any) => logs.push(entry),
    ...overrides,
  };
  return { skipped: new TimelineDay1CandidateGateService().shouldSkip(input), logs };
}

test('skips non-movement filler and over-priority Day-1 candidates', () => {
  assert.equal(evaluate({ hotspot_ID: 1, hotspot_priority: 0, matched_bucket: 'destination' }).skipped, true);
  assert.equal(evaluate({ hotspot_ID: 2, hotspot_priority: 4, matched_bucket: 'destination' }).skipped, true);
});

test('suppresses terminal source priority-one candidates when a later overnight exists', () => {
  const result = evaluate(
    { hotspot_ID: 3, hotspot_priority: 1, matched_bucket: 'source' },
    { isRouteSourceTerminal: true, hasLaterOvernightInSourceCity: true },
  );

  assert.equal(result.skipped, true);
  assert.match(result.logs[0].rejectedReasons[0], /later overnight/);
});

test('skips already-planned candidates and keeps movement candidates eligible', () => {
  const duplicate = evaluate({ hotspot_ID: 4, hotspot_priority: 1, matched_bucket: 'source' }, { isHotspotAlreadyPlanned: () => true });
  const movement = evaluate({ hotspot_ID: 5, hotspot_priority: 0, matched_bucket: 'via' });

  assert.equal(duplicate.skipped, true);
  assert.equal(movement.skipped, false);
});
