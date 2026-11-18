import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryRouteTimingService } from '../src/modules/itineraries/services/itinerary-route-timing.service';

function harness(departureType = 1, singleDay = false, failRebuild = false) {
  const route = { itinerary_route_ID: 30, itinerary_plan_ID: 1, no_of_days: singleDay ? 1 : 3,
    itinerary_route_date: new Date('2026-11-24T00:00:00Z'), location_name: 'Rameswaram',
    next_visiting_location: 'Madurai, Mattuthavani', route_start_time: '07:06:00', route_end_time: '21:00:00' };
  const first = singleDay ? route : { ...route, itinerary_route_ID: 10, no_of_days: 1,
    itinerary_route_date: new Date('2026-11-22T00:00:00Z'), route_start_time: '09:00:00' };
  const plan = { itinerary_preference: 2, departure_type: departureType,
    trip_end_date_and_time: new Date('2026-11-24T12:00:00Z'),
    transport_early_arrival_option: 'AIRPORT_LOUNGE', transport_early_arrival_rest_minutes: 60 };
  const writes: any[] = [];
  const events: string[] = [];
  const tx: any = {
    dvi_itinerary_route_details: {
      findFirst: async (args: any) => args.where?.itinerary_route_ID ? route
        : args.orderBy?.[0]?.no_of_days === 'asc' ? first : route,
      update: async (args: any) => { writes.push({ kind: 'route', data: args.data }); return route; },
    },
    dvi_itinerary_plan_details: {
      findFirst: async () => plan,
      updateMany: async (args: any) => { writes.push({ kind: 'plan', data: args.data }); return { count: 1 }; },
    },
    dvi_itinerary_plan_hotel_details: { findMany: async () => [], updateMany: async () => {
      throw Error('departure-only edit touched arrival hotel data');
    } },
  };
  const engine: any = {
    rebuildRouteHotspots: async () => {
      events.push('rebuild'); if (failRebuild) throw Error('rebuild failed');
      return { rebuildSummary: {}, warnings: [] };
    },
    rebuildParkingCharges: async () => { events.push('parking'); },
  };
  const prisma: any = { $transaction: async (run: any) => {
    try { return await run(tx); } catch (error) { writes.length = 0; throw error; }
  } };
  const service = new ItineraryRouteTimingService(prisma, engine,
    { assertPersistedPlan: async () => undefined } as any);
  service.setCallbacks({ forceRebuildVehiclePricingAfterHotspotChange: async () => { events.push('pricing'); } });
  const update = (changeType: 'FINAL_DAY_DEPARTURE' | 'ROUTE_END', time = '21:00:00', routeId = 30) =>
    service.updateRouteTimes(1, routeId, '07:06:00', time, undefined, undefined,
      undefined, undefined, undefined, undefined, changeType);
  return { update, writes, events, service };
}

test('actual departure and buffered cutoff save together before rebuild, parking and pricing', async () => {
  for (const [type, cutoff] of [[1, '19:00:00'], [2, '20:00:00'], [3, '21:00:00']]) {
    const h = harness(type);
    const result = await h.update('FINAL_DAY_DEPARTURE');
    assert.equal(result.routeTimes.departureTime, '21:00:00');
    assert.equal(result.routeTimes.endTime, cutoff);
    assert.equal(h.writes.find(x => x.kind === 'plan').data.trip_end_date_and_time.toISOString(), '2026-11-24T21:00:00.000Z');
    assert.equal(h.writes.find(x => x.kind === 'route').data.route_end_time.toISOString().slice(11, 19), cutoff);
    assert.deepEqual(h.events, ['rebuild', 'parking', 'pricing']);
    assert.equal('transport_early_arrival_option' in h.writes.find(x => x.kind === 'plan').data, false);
  }
});

test('ordinary day-end edit preserves the actual departure', async () => {
  const h = harness();
  const result = await h.update('ROUTE_END', '20:00:00');
  assert.equal(result.routeTimes.endTime, '20:00:00');
  assert.equal('trip_end_date_and_time' in h.writes.find(x => x.kind === 'plan').data, false);
});

test('single-day departure edit leaves arrival and early-arrival preferences untouched', async () => {
  const h = harness(1, true);
  const result = await h.update('FINAL_DAY_DEPARTURE');
  const data = h.writes.find(x => x.kind === 'plan').data;
  assert.equal('trip_start_date_and_time' in data, false);
  assert.equal('transport_early_arrival_option' in data, false);
  assert.equal(result.itineraryBoundaries.day1RouteUpdated, false);
});

test('non-final departure, malformed time and unsupported negative cutoff fail before saving', async () => {
  for (const [time, id, error] of [['21:00:00', 10, /last route/],
    ['bad', 30, /HH:MM:SS/], ['01:00:00', 30, /too early/]] as const) {
    const h = harness();
    await assert.rejects(() => h.update('FINAL_DAY_DEPARTURE', time, id), error);
    assert.equal(h.writes.length, 0);
  }
});

test('rebuild failure rolls back departure writes and skips external pricing work', async () => {
  const h = harness(1, false, true);
  await assert.rejects(() => h.update('FINAL_DAY_DEPARTURE'), /rebuild failed/);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.events, ['rebuild']);
});
