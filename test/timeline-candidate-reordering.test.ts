import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineCandidateReorderingService } from '../src/modules/itineraries/engines/helpers/timeline-candidate-reordering.service';

test('keeps manual and prioritized candidates ahead of matrix-ranked candidates', () => {
  const logs: any[] = [];
  const selected = [
    { hotspot_ID: 1, hotspot_priority: 0, matrix_score: 50, hotspot_distance: 3 },
    { hotspot_ID: 2, hotspot_priority: 2, matrix_score: 0 },
    { hotspot_ID: 3, isManualSelection: true, matrix_score: 0 },
    { hotspot_ID: 4, hotspot_priority: 0, matrix_score: 80, hotspot_distance: 5 },
  ];

  const result = new TimelineCandidateReorderingService().reorder(selected, (...args) => logs.push(args));

  assert.deepEqual(result.map((hotspot) => hotspot.hotspot_ID), [2, 3, 4, 1]);
  assert.equal(logs[0][0], '[TIMELINE] Candidates reordered (priority preserved, matrix_score applied)');
});

test('uses distance as the deterministic tie-breaker for equal matrix scores', () => {
  const result = new TimelineCandidateReorderingService().reorder([
    { hotspot_ID: 1, matrix_score: 10, hotspot_distance: 9 },
    { hotspot_ID: 2, matrix_score: 10, hotspot_distance: 2 },
  ], () => undefined);

  assert.deepEqual(result.map((hotspot) => hotspot.hotspot_ID), [2, 1]);
});

test('retains the original logging failure contract', () => {
  const selected = [{ hotspot_ID: 1, matrix_score: 1 }];
  assert.throws(() => new TimelineCandidateReorderingService().reorder(selected, () => {
    throw new Error('log unavailable');
  }), /log unavailable/);
});
