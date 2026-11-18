import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderPriorityApproach, TimelineRouteDirectionService, RoadRouter } from '../src/modules/itineraries/engines/helpers/timeline-route-direction.service';

type Stop = { id: number; x: number; destination?: boolean; close?: number; duration?: number };
const lineRoad: RoadRouter = async points => {
  const legs = points.slice(1).map((p, i) => ({ distanceKm: Math.abs(p.lon - points[i].lon), durationSeconds: Math.abs(p.lon - points[i].lon) * 60 }));
  return { distanceKm: legs.reduce((s, l) => s + l.distanceKm, 0), durationSeconds: legs.reduce((s, l) => s + l.durationSeconds, 0), legs };
};
const park: Stop = { id: 218, x: 60, destination: true, close: 18000, duration: 10800 };
const waterfall: Stop = { id: 228, x: 30, duration: 1200 };
const valara: Stop = { id: 357, x: 31, duration: 1200 };
function prepare(queue: Stop[], candidates = queue, startSeconds = 0, router: RoadRouter = lineRoad) {
  return orderPriorityApproach({ queue, candidates, startSeconds, id: s => s.id,
    coords: s => ({ lat: 10, lon: s.x }), eligible: () => true, target: s => !!s.destination,
    from: { lat: 10, lon: 0 }, roads: new TimelineRouteDirectionService(router),
    project: async (s, _from, start, travel) => {
      const end = start + travel + (s.duration || 0);
      return end <= (s.close ?? Infinity) ? end : null;
    },
  });
}
test('DVI20261115: waterfalls precede priority park when its full visit still fits', async () => {
  const result = await prepare([park, waterfall, valara]);
  assert.deepEqual(result.queue.map(s => s.id), [228, 357, 218]);
  assert.deepEqual([...result.approachIds].sort(), [218, 228, 357]);
});
test('late arrival preserves November priority destination and opening window', async () => {
  const result = await prepare([park, waterfall, valara], undefined, 3000);
  assert.equal(result.queue[0], park);
  assert.equal(result.approachIds.size, 0);
});
test('keeps a feasible subset when both preceding stops cannot fit', async () => {
  assert.deepEqual((await prepare([park, waterfall, valara], undefined, 1800)).queue.map(s => s.id), [228, 218, 357]);
});
test('destination stops encountered en route precede their farther priority target', async () => {
  const echo: Stop = { id: 483, x: 80, destination: true };
  const dam: Stop = { id: 223, x: 70, destination: true };
  assert.deepEqual((await prepare([echo, dam])).queue.map(s => s.id), [223, 483]);
});
test('does not move a far-behind candidate into a later approach', async () => {
  const result = await prepare([{ id: 1, x: 60, destination: true }, { id: 2, x: 80, destination: true }, { id: 3, x: -30 }]);
  assert.deepEqual(result.queue.map(s => s.id), [1, 2, 3]);
});
test('provider outage preserves candidate order and priority target', async () => {
  const queue = [park, waterfall, valara];
  assert.deepEqual((await prepare(queue, undefined, 0, async () => null)).queue, queue);
});
test('empty and single record inputs remain valid', async () => {
  assert.deepEqual((await prepare([])).queue, []);
  assert.deepEqual((await prepare([park])).queue, [park]);
});
test('different bucket records for the same hotspot survive missing road data', async () => {
  const source: Stop = { id: 218, x: 60 };
  assert.deepEqual((await prepare([source, park], undefined, 0, async () => null)).queue, [source, park]);
});
test('minor returns are allowed and heavy or slow returns are rejected', () => {
  assert.equal(TimelineRouteDirectionService.withinBudget({ extraKm: 2, extraSeconds: 240, baselineKm: 20 }), true);
  assert.equal(TimelineRouteDirectionService.withinBudget({ extraKm: 60, extraSeconds: 7200, baselineKm: 20 }), false);
  assert.equal(TimelineRouteDirectionService.withinBudget({ extraKm: 2, extraSeconds: 1200, baselineKm: 20 }), false);
});
test('small returns share a day budget and missing evidence cannot authorize a return', () => {
  const fit = { extraKm: 3, extraSeconds: 600, baselineKm: 20 };
  assert.equal(TimelineRouteDirectionService.withinBudget(fit, 3, 100), false);
  assert.equal(TimelineRouteDirectionService.withinBudget(fit, 0, 400), false);
  assert.equal(TimelineRouteDirectionService.withinBudget(null), false);
});
test('invalid coordinates never reach the provider', async () => {
  const roads = new TimelineRouteDirectionService(async () => { throw new Error('must not call provider'); });
  assert.equal(await roads.journey([{lat: 0, lon: 0}, {lat: 10, lon: 70}]), null);
  assert.equal(await roads.journey([{lat: NaN, lon: 70}, {lat: 10, lon: 70}]), null);
});
test('repeat planning is deterministic and does not mutate inputs', async () => {
  const queue = [park, waterfall, valara];
  const before = JSON.stringify(queue);
  assert.deepEqual((await prepare(queue)).queue, (await prepare(queue)).queue);
  assert.equal(JSON.stringify(queue), before);
});
