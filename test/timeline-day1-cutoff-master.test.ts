import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineDay1CutoffMasterService } from '../src/modules/itineraries/engines/helpers/timeline-day1-cutoff-master.service';

function resolve(overrides: Partial<any> = {}) {
  const logs: any[] = [];
  const input: any = {
    route: { itinerary_route_ID: 10 },
    hotspot: { hotspot_ID: 1, hotspot_priority: 1, matched_bucket: 'source', hotspot_distance: 2 },
    hotspotMap: new Map([[1, { hotspot_ID: 1, hotspot_location: 'Chennai' }]]),
    bucket: 'source',
    currentTime: '10:00:00',
    shouldApplySourceHotspotCutoff: true,
    logHotspotCandidateEvaluation: (entry: any) => logs.push(entry),
    ...overrides,
  };
  return { result: new TimelineDay1CutoffMasterService().resolve(input), logs };
}

test('returns the prefetched hotspot master before the applicable cutoff', () => {
  const { result, logs } = resolve();
  assert.equal(result.hotspot_location, 'Chennai');
  assert.equal(logs.length, 0);
});

test('rejects source, via and destination candidates after their PHP cutoffs', () => {
  assert.equal(resolve({ bucket: 'source', currentTime: '12:00:00' }).result, null);
  assert.equal(resolve({ bucket: 'via', currentTime: '19:00:00' }).result, null);
  assert.equal(resolve({ bucket: 'destination', currentTime: '21:00:00' }).result, null);
});

test('rejects candidates whose prefetched hotspot master is missing', () => {
  const { result, logs } = resolve({ hotspotMap: new Map() });
  assert.equal(result, null);
  assert.deepEqual(logs[0].rejectedReasons, ['Rejected: hotspot master missing']);
});
