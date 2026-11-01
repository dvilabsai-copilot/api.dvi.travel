import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIntercityPhaseCandidateQueue,
  shouldAdvanceToPostSourceCandidate,
} from '../src/modules/itineraries/engines/helpers/timeline-intercity-phase.service';

test('keeps strict destination candidates queued after source candidates', () => {
  const candidates = [
    { hotspot_ID: 10, matched_bucket: 'source', hotspot_priority: 4 },
    { hotspot_ID: 120, matched_bucket: 'destination', hotspot_priority: 1 },
    { hotspot_ID: 349, matched_bucket: 'en_route', hotspot_priority: 10 },
    { hotspot_ID: 122, matched_bucket: 'destination', hotspot_priority: 2 },
  ];

  const result = buildIntercityPhaseCandidateQueue(
    candidates,
    (candidate) => candidate.matched_bucket === 'source',
  );

  assert.deepEqual(result.map((candidate) => candidate.hotspot_ID), [10, 120, 349, 122]);
});

test('can preempt the source phase for one priority destination candidate', () => {
  const destination = { id: 120, bucket: 'destination' };
  const source = { id: 114, bucket: 'source' };
  const queued = buildIntercityPhaseCandidateQueue(
    [source, destination],
    (candidate) => candidate.bucket === 'source',
    destination,
  );

  assert.deepEqual(queued, [destination, source]);
});

test('advances when no unplanned source candidate remains after the current candidate', () => {
  const candidates = [
    { hotspot_ID: 10, matched_bucket: 'source' },
    { hotspot_ID: 120, matched_bucket: 'destination' },
  ];

  assert.equal(
    shouldAdvanceToPostSourceCandidate(
      candidates,
      1,
      (candidate) => candidate.matched_bucket === 'source',
      () => false,
    ),
    true,
  );
});
