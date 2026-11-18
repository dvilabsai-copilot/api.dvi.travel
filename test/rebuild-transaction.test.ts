import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteExistingRebuildRows, lockItineraryForRebuild, withRebuildTransactionRetry } from '../src/modules/itineraries/utils/rebuild-transaction.util';

test('empty plan range performs no delete, populated scope deletes only selected unique IDs', async () => {
  const calls: any[] = [];
  const where = { itinerary_plan_ID: 11713, itinerary_route_ID: 23111, deleted: 0 };
  let rows: any[] = [];
  const model = {
    findMany: async (args: any) => { assert.deepEqual(args.where, where); return rows; },
    deleteMany: async (args: any) => { calls.push(args); return { count: args.where.id.in.length }; },
  };
  assert.deepEqual(await deleteExistingRebuildRows(model, where, 'id'), { count: 0 });
  assert.equal(calls.length, 0);
  rows = Array.from({length: 501}, (_, i) => ({id: i + 50}));
  assert.deepEqual(await deleteExistingRebuildRows(model, where, 'id'), { count: 501 });
  assert.deepEqual(calls.flatMap(x => x.where.id.in), rows.map(x => x.id));
  assert.ok(calls.every(x => Object.keys(x.where).join() === 'id'));
});

test('plan lock binds the ID and uses a locking read on its primary key', async () => {
  await lockItineraryForRebuild({ $queryRaw: async (sql: any) => {
    assert.deepEqual(sql.values, [11713]);
    assert.match(sql.sql, /WHERE itinerary_plan_ID = \? FOR UPDATE/);
  }} as any, 11713);
});

test('only P2034 retries, at most three attempts, including failures at commit', async () => {
  for (const code of ['P2034', 'P2028', 'P2002', undefined]) {
    let attempts = 0; const delays: number[] = [];
    const error = Object.assign(new Error('policy or database failure'), {code});
    await assert.rejects(() => withRebuildTransactionRetry(async () => {attempts++; throw error;}, async ms => {delays.push(ms);}), e => e === error);
    assert.equal(attempts, code === 'P2034' ? 3 : 1);
    assert.equal(delays.length, code === 'P2034' ? 2 : 0);
    assert.ok(delays.every(ms => ms >= 50 && ms < 150));
  }
  let tries = 0;
  assert.equal(await withRebuildTransactionRetry(async () => {
    if (++tries < 3) throw {code:'P2034'};
    return 'committed';
  }, async () => {}), 'committed');
});
