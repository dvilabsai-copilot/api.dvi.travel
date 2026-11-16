import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationsService } from '../src/modules/locations/locations.service';

const outward = {
  location_ID: 1n,
  source_location: 'A',
  destination_location: 'B',
  source_location_lattitude: '12.00',
  source_location_longitude: '77.00',
  destination_location_lattitude: '12.75',
  destination_location_longitude: '77.00',
  distance: 100,
  duration: '4 hours 0 mins',
  status: 1,
  deleted: 0,
};
const returnRoute = {
  ...outward,
  location_ID: 2n,
  source_location: 'B',
  destination_location: 'A',
  source_location_lattitude: outward.destination_location_lattitude,
  destination_location_lattitude: outward.source_location_lattitude,
};
const payload = {
  via_route_location: 'X',
  via_route_location_lattitude: '12.25',
  via_route_location_longitude: '77.00',
  distance_from_source_location: '29',
  duration_from_source_location: '30 mins',
};

function setup(routes = [outward, returnRoute], failAtLocationId?: bigint) {
  const vias: any[] = [];
  const matches = (row: object, where: object) => Object.entries(where).every(
    ([key, value]) => row[key] === value,
  );
  const db = {
    dvi_stored_locations: {
      findFirst: async ({ where }) => routes.find((row) => matches(row, where)),
      findMany: async ({ where }) => routes.filter((row) => matches(row, where)).slice(0, 2),
      create: async ({ data }) => {
        const row = { ...data, location_ID: BigInt(routes.length + 1) };
        routes.push(row);
        return row;
      },
    },
    dvi_stored_location_via_routes: {
      findFirst: async ({ where }) => vias.find((row) => matches(row, where)),
      create: async ({ data }) => {
        if (data.location_id === failAtLocationId) throw new Error('via write failed');
        const row = { ...data, via_route_location_ID: BigInt(vias.length + 1) };
        vias.push(row);
        return row;
      },
    },
    $queryRawUnsafe: async (_sql, id) => vias.filter((row) => row.location_id === BigInt(id)),
    $transaction: async (operation, options) => {
      assert.equal(options.isolationLevel, 'Serializable');
      const routeCount = routes.length;
      const viaCount = vias.length;
      try {
        return await operation(db);
      } catch (error) {
        routes.splice(routeCount);
        vias.splice(viaCount);
        throw error;
      }
    },
  };
  return { service: new LocationsService(db as any), routes, vias };
}

test('one via stop is saved under each direction with its own distance and ID', async () => {
  const { service, vias } = setup();
  const saved = await service.addViaRoute(1, payload);
  await service.addViaRoute(1, payload);
  await service.addViaRoute(2, payload);

  assert.equal(saved.data.length, 1);
  assert.equal(vias.length, 2);
  assert.deepEqual(vias.map((row) => row.location_id), [1n, 2n]);
  assert.notEqual(vias[0].via_route_location_ID, vias[1].via_route_location_ID);
  assert.equal(vias[0].distance_from_source_to_via_route, '29');
  assert.equal(vias[0].duration_from_source_to_via_route, '30 mins');
  assert.equal(vias[1].distance_from_source_to_via_route, '55.597463');
  assert.equal(vias[1].duration_from_source_to_via_route, '2 hours 13 mins');
});

test('re-adding a saved stop repairs a missing counterpart and preserves existing data', async () => {
  const { service, vias } = setup();
  const saved = { ...payload, via_route_location_city: 'Saved city' };
  await service.addViaRoute(1, saved);
  const previous = vias.pop();
  await service.addViaRoute(1, { ...payload, via_route_location_city: 'Different city' });
  assert.equal(vias.length, 2);
  assert.deepEqual(vias[1].via_route_location_city, previous.via_route_location_city);
  assert.deepEqual(vias[0].via_route_location_city, saved.via_route_location_city);
});

test('a missing return route is created with swapped endpoints and the base route distance', async () => {
  const { service, routes, vias } = setup([outward]);
  await service.addViaRoute(1, payload);
  assert.equal(routes[1].source_location, 'B');
  assert.equal(routes[1].destination_location, 'A');
  assert.equal(routes[1].source_location_lattitude, outward.destination_location_lattitude);
  assert.equal(routes[1].distance, outward.distance);
  assert.deepEqual(vias.map((row) => row.location_id), [1n, 2n]);
});

test('a same-location route saves one stop, and an empty via name creates nothing', async () => {
  const { service, vias } = setup([{ ...outward, destination_location: 'A' }]);
  await assert.rejects(() => service.addViaRoute(1, { via_route_location: ' ' }), /is required/);
  await service.addViaRoute(1, { via_route_location: 'X' });
  assert.equal(vias.length, 1);
  assert.equal(vias[0].distance_from_source_to_via_route, '');
});

test('a failed return write or ambiguous return route leaves no forward stop', async () => {
  const failing = setup([outward], 2n);
  await assert.rejects(() => failing.service.addViaRoute(1, payload), /via write failed/);
  assert.equal(failing.routes.length, 1);
  assert.equal(failing.vias.length, 0);

  const ambiguous = setup([outward, returnRoute, { ...returnRoute, location_ID: 3n }]);
  await assert.rejects(() => ambiguous.service.addViaRoute(1, payload), /ambiguous/);
  assert.equal(ambiguous.vias.length, 0);
});
