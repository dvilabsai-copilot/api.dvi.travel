import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineRoutePolicyService } from '../src/modules/itineraries/engines/helpers/timeline-route-policy.service';
import { TimelineRouteHotspotSelectionService } from '../src/modules/itineraries/engines/helpers/timeline-route-hotspot-selection.service';
import { orderPriorityApproach, orderAdmittedCorridorStops, TimelineRouteDirectionService, RoadRouter } from '../src/modules/itineraries/engines/helpers/timeline-route-direction.service';

const policy = new TimelineRoutePolicyService();
const aliases = 'Cochin|Cochin International Airport|Ernakulam Railway Station Kerala';
const noMatch = { matches: false, fromIndex: -1, toIndex: -1 };

test('explicit Cochin city alias fixes Valara without changing global city normalization', () => {
  assert.equal(policy.hotspotLocationMatchesCity('Cochin International Airport|Ernakulam Railway Station Kerala', 'Cochin'), false);
  assert.equal(policy.hotspotLocationMatchesCity(aliases, 'Cochin'), true);
  assert.equal(policy.hotspotLocationMatchesCity(aliases, 'Cochin International Airport'), true);
});

test('reverse corridor ownership requires an explicit opt-in and uses actual travel indices', () => {
  assert.deepEqual(policy.routeSpecificHotspotMatchesRouteChain(aliases, 'Munnar', ['Munnar', 'Cochin']), noMatch);
  for (const destination of ['Cochin', 'Cochin International Airport']) {
    assert.deepEqual(policy.routeSpecificHotspotMatchesRouteChain(aliases, 'Munnar', ['Munnar', destination], true),
      { matches: true, fromIndex: 0, toIndex: 1 });
  }
});

test('opt-in does not admit unrelated, empty, same-city or reverse via chains', () => {
  for (const legs of [[], ['Munnar'], ['Munnar', 'Thekkady'], ['Munnar', 'Thekkady', 'Cochin']]) {
    assert.deepEqual(policy.routeSpecificHotspotMatchesRouteChain(aliases, 'Munnar', legs, true), noMatch);
  }
  assert.deepEqual(policy.routeSpecificHotspotMatchesRouteChain(aliases, 'Munnar', policy.buildRouteLegs('Munnar', [], 'Munnar'), true), noMatch);
  assert.deepEqual(policy.routeSpecificHotspotMatchesRouteChain(aliases, 'Munnar', ['Cochin', 'Adimali', 'Munnar'], true),
    { matches: true, fromIndex: 0, toIndex: 2 });
});

const masters = [
  { hotspot_ID: 228, hotspot_name: 'Cheeyappara Waterfalls', hotspot_priority: 15 },
  { hotspot_ID: 357, hotspot_name: 'Valara Water Falls', hotspot_priority: 16 },
].map(h => ({ ...h, hotspot_location: aliases, hotspot_to_location: 'Munnar', hotspot_allow_reverse_auto_route: 1,
  hotspot_latitude: '10', hotspot_longitude: String(h.hotspot_ID === 228 ? 30 : 31) }));

async function select(source: string, destination: string, input = masters, excluded: number[] = [], via: string[] = []) {
  const service = new TimelineRouteHotspotSelectionService({ fromSourceAndDestination: async () => ({ distanceKm: '10' }) } as any);
  service.setCallbacks({ logTimeline: () => undefined, logBookingRule: () => undefined,
    logHotspotCandidateEvaluation: () => undefined,
    canonicalCityKey: value => policy.canonicalCityKey(value),
    hotspotLocationMatchesCity: (location, city) => policy.hotspotLocationMatchesCity(location, city),
    hotspotNameMatchesLocation: (hotspot, location) => policy.hotspotNameMatchesLocation(hotspot, location),
    routeSpecificHotspotMatchesRouteChain: (...args) => (policy.routeSpecificHotspotMatchesRouteChain as any)(...args),
    routeMovementOrder: (...args) => (policy.routeMovementOrder as any)(...args),
    buildRouteLegs: (...args) => (policy.buildRouteLegs as any)(...args),
    resolvePlaceCoords: async () => ({ lat: 10, lon: 76 }), getTravelLocationType: () => 2,
  });
  const tx = {
    dvi_itinerary_route_details: { findFirst: async () => ({ itinerary_route_ID: 10,
      location_name: source, next_visiting_location: destination, excluded_hotspot_ids: excluded,
      itinerary_route_date: new Date('2026-12-21T00:00:00Z'), direct_to_next_visiting_place: 0 }) },
    dvi_itinerary_plan_details: { findFirst: async () => ({ itinerary_preference: 3 }) },
    dvi_itinerary_via_route_details: { findMany: async () => via.map(name => ({ itinerary_via_location_name: name })) },
    dvi_stored_locations: { findFirst: async () => null },
    dvi_hotspot_timing: { findMany: async () => [] },
  };
  return service.fetch(tx as any, 1, 10, input);
}

test('real candidate selector admits both waterfalls from Cochin city and in automatic reverse', async () => {
  for (const [from, to] of [['Cochin', 'Munnar'], ['Cochin International Airport', 'Munnar'], ['Munnar', 'Cochin'], ['Munnar', 'Cochin International Airport']]) {
    const rows = await select(from, to);
    assert.deepEqual(rows.map(x => x.hotspot_ID).sort(), [228, 357]);
    assert.ok(rows.every(x => x.matched_bucket === 'en_route' && x.__route_chain_from_index === 0 && x.__route_chain_to_index === 1));
  }
});

test('selector retains one-way defaults, exclusions and explicit via ownership', async () => {
  assert.deepEqual(await select('Munnar', 'Cochin', masters.map(x => ({ ...x, hotspot_allow_reverse_auto_route: 0 }))), []);
  assert.deepEqual((await select('Munnar', 'Cochin', masters, [357])).map(x => x.hotspot_ID), [228]);
  assert.deepEqual(await select('Munnar', 'Cochin', masters, [], ['Thekkady']), []);
});

test('reverse road approach orders Valara then Cheeyappara rather than master priority order', async () => {
  const corridor = await select('Munnar', 'Cochin');
  const destination = { hotspot_ID: 244, hotspot_longitude: '0', destination: true };
  const candidates = [...corridor.map(x => ({ ...x, hotspot_longitude: x.hotspot_ID === 357 ? '31' : '30', destination: false })), destination];
  const road: RoadRouter = async points => {
    const legs = points.slice(1).map((p, i) => ({ distanceKm: Math.abs(p.lon - points[i].lon), durationSeconds: Math.abs(p.lon - points[i].lon) * 60 }));
    return { legs, distanceKm: legs.reduce((n, l) => n + l.distanceKm, 0), durationSeconds: legs.reduce((n, l) => n + l.durationSeconds, 0) };
  };
  const result = await orderPriorityApproach({ queue: [destination, ...candidates.slice(0, 2)], candidates,
    id: h => h.hotspot_ID, coords: h => ({ lat: 10, lon: Number(h.hotspot_longitude) }),
    eligible: h => !h.destination, target: h => h.destination, from: { lat: 10, lon: 60 }, startSeconds: 0,
    roads: new TimelineRouteDirectionService(road), project: async (_h, _from, seconds, travel) => seconds + travel + 1200 });
  assert.deepEqual(result.queue.map(x => x.hotspot_ID), [357, 228, 244]);
});

test('already admitted direct-return corridor visits order by road approach without moving priorities', async () => {
  const park = { id: 218, x: 70, corridor: '' };
  const cheeyappara = { id: 228, x: 30, corridor: 'cochin-munnar' };
  const valara = { id: 357, x: 31, corridor: 'cochin-munnar' };
  const destination = { id: 244, x: 0, corridor: '' };
  const queue = [park, cheeyappara, valara, destination];
  const road: RoadRouter = async points => ({
    distanceKm: Math.abs(points[1].lon - points[0].lon), durationSeconds: 60,
    legs: [{ distanceKm: Math.abs(points[1].lon - points[0].lon), durationSeconds: 60 }],
  });
  const result = await orderAdmittedCorridorStops({ queue, from: { lat: 10, lon: 60 },
    coords: h => ({ lat: 10, lon: h.x }), group: h => h.corridor || null,
    roads: new TimelineRouteDirectionService(road) });
  assert.deepEqual(result.map(h => h.id), [218, 357, 228, 244]);
  assert.deepEqual(queue.map(h => h.id), [218, 228, 357, 244]);
});

test('corridor ordering preserves separate groups, singleton visits and unavailable road results', async () => {
  const queue = [{ id: 1, x: 30, corridor: 'a' }, { id: 2, x: 31, corridor: 'a' },
    { id: 3, x: 0, corridor: '' }, { id: 4, x: 10, corridor: 'b' }];
  const result = await orderAdmittedCorridorStops({ queue, from: { lat: 10, lon: 60 },
    coords: h => ({ lat: 10, lon: h.x }), group: h => h.corridor || null,
    roads: new TimelineRouteDirectionService(async () => null) });
  assert.deepEqual(result, queue);
  assert.deepEqual(await orderAdmittedCorridorStops({ queue: [], from: { lat: 10, lon: 60 },
    coords: () => ({ lat: 0, lon: 0 }), group: () => null,
    roads: new TimelineRouteDirectionService(async () => { throw new Error('no road work for empty queue'); }) }), []);
});
