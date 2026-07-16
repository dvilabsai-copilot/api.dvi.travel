import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitAttemptStoreService } from '../src/modules/itineraries/services/itinerary-manual-fit-attempt-store.service';

test('persists, caches and deletes manual-fit attempts with the existing SQL contract', async () => {
  const executions: string[] = [];
  const prisma: any = {
    $executeRawUnsafe: async (query: string) => {
      executions.push(query.trim().split(/\s+/).slice(0, 5).join(' '));
    },
    $queryRawUnsafe: async () => [],
  };
  const service = new ItineraryManualFitAttemptStoreService(prisma);
  const entry = {
    attemptId: 'attempt-1',
    planId: 42,
    routeId: 7,
    selectedHotspotId: 99,
    expiresAt: '2026-07-16T12:00:00.000Z',
  };

  await service.save(entry);
  assert.deepEqual(await service.load('attempt-1'), entry);
  await service.delete('attempt-1');

  assert.equal(executions.length, 3);
  assert.match(executions[0], /CREATE TABLE IF NOT EXISTS/);
  assert.match(executions[1], /INSERT INTO dvi_manual_fit_preview_attempts/);
  assert.match(executions[2], /DELETE FROM dvi_manual_fit_preview_attempts/);
});

test('loads and validates a stored manual-fit attempt payload', async () => {
  const entry = {
    attemptId: 'attempt-2',
    planId: 42,
    routeId: 7,
    selectedHotspotId: 99,
    expiresAt: '2026-07-16T12:00:00.000Z',
  };
  const prisma: any = {
    $executeRawUnsafe: async () => undefined,
    $queryRawUnsafe: async () => [{ payload_json: JSON.stringify(entry) }],
  };
  const result = await new ItineraryManualFitAttemptStoreService(prisma).load('attempt-2');
  assert.deepEqual(result, entry);
});
