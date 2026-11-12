import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateTboRouteNightPricing } from '../src/modules/hotels/utils/tbo-room-night-pricing';

test('allocates the stay margin across actual VSR nightly totals and reconciles the aggregate', () => {
  const pricing = allocateTboRouteNightPricing([
    {
      routeId: 20101,
      routeDate: '2026-09-03',
      marginPercentage: 5,
      breakdown: [
        { date: '2026-09-03', allInAmount: 15379.64, nightTotal: 28895.73 },
        { date: '2026-09-03', allInAmount: 13516.09, nightTotal: 28895.73 },
        { date: '2026-09-04', allInAmount: 15824.94, nightTotal: 29774.38 },
        { date: '2026-09-04', allInAmount: 13949.44, nightTotal: 29774.38 },
      ],
    },
    {
      routeId: 20102,
      routeDate: '2026-09-04',
      marginPercentage: 5,
      breakdown: [
        { date: '2026-09-03', allInAmount: 15379.64, nightTotal: 28895.73 },
        { date: '2026-09-03', allInAmount: 13516.09, nightTotal: 28895.73 },
        { date: '2026-09-04', allInAmount: 15824.94, nightTotal: 29774.38 },
        { date: '2026-09-04', allInAmount: 13949.44, nightTotal: 29774.38 },
      ],
    },
  ]);

  assert.ok(pricing);
  assert.deepEqual(pricing.get(20101), {
    routeId: 20101,
    routeDate: '2026-09-03',
    baseTotalPrice: 28895.73,
    hotelMarginAmount: 1444.79,
    totalPrice: 30340.52,
  });
  assert.deepEqual(pricing.get(20102), {
    routeId: 20102,
    routeDate: '2026-09-04',
    baseTotalPrice: 29774.38,
    hotelMarginAmount: 1488.72,
    totalPrice: 31263.1,
  });
  assert.equal(
    Math.round([...pricing.values()].reduce((sum, night) => sum + night.totalPrice, 0) * 100) / 100,
    61603.62,
  );
});

test('returns no route pricing if any selected VSR night lacks a valid matching breakdown', () => {
  assert.equal(allocateTboRouteNightPricing([
    {
      routeId: 20101,
      routeDate: '2026-09-03',
      marginPercentage: 5,
      breakdown: [{ date: '2026-09-03', allInAmount: 100, nightTotal: 100 }],
    },
    {
      routeId: 20102,
      routeDate: '2026-09-04',
      marginPercentage: 5,
      breakdown: [],
    },
  ]), undefined);
});
