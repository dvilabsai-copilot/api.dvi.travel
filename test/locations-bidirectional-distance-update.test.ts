import assert from 'node:assert/strict';
import test from 'node:test';
import { DistanceHelper } from '../src/modules/itineraries/engines/helpers/distance.helper';
import { LocationsService } from '../src/modules/locations/locations.service';

function makeRow(
  id: number,
  source: string,
  destination: string,
  distance: number,
) {
  return {
    location_ID: BigInt(id),
    source_location: source,
    source_location_lattitude: '12.971600',
    source_location_longitude: '77.594600',
    source_location_city: source,
    source_city_id: null,
    source_location_state: 'Karnataka',
    destination_location: destination,
    destination_location_lattitude: '12.337500',
    destination_location_longitude: '75.806900',
    destination_location_city: destination,
    destination_city_id: null,
    destination_location_state: 'Karnataka',
    distance,
    duration: '4 hours 0 mins',
    location_description: null,
    created_from: 0,
    createdby: 0n,
    createdon: new Date('2026-01-01T00:00:00.000Z'),
    updatedon: null,
    status: 1,
    deleted: 0,
  };
}

function makePrisma(rows: Map<bigint, any>) {
  const storedLocations = {
    findFirst: async ({ where }: any) => {
      if (where?.location_ID !== undefined) {
        return rows.get(BigInt(where.location_ID)) ?? null;
      }

      return Array.from(rows.values()).find((row) =>
        (!where?.deleted || row.deleted === where.deleted) &&
        (!where?.source_location || row.source_location === where.source_location) &&
        (!where?.destination_location || row.destination_location === where.destination_location),
      ) ?? null;
    },
    update: async ({ where, data }: any) => {
      const row = rows.get(BigInt(where.location_ID));
      if (!row) throw new Error('row not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of rows.values()) {
        if (
          row.deleted === where.deleted &&
          row.source_location === where.source_location &&
          row.destination_location === where.destination_location
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
    create: async ({ data }: any) => {
      const nextId = Math.max(...Array.from(rows.keys()).map(Number), 0) + 1;
      const row = { ...data, location_ID: BigInt(nextId) };
      rows.set(row.location_ID, row);
      return row;
    },
  };

  return {
    dvi_stored_locations: storedLocations,
    dvi_global_settings: {
      findFirst: async () => null,
    },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
      dvi_stored_locations: storedLocations,
      dvi_global_settings: {
        findFirst: async () => null,
      },
    }),
  };
}

test('editing one route updates the reverse route and invalidates distance cache', async () => {
  const rows = new Map<bigint, any>([
    [1n, makeRow(1, 'Bangalore', 'Coorg', 280)],
    [2n, makeRow(2, 'Coorg', 'Bangalore', 280)],
  ]);
  const prisma = makePrisma(rows);
  const distanceHelper = new DistanceHelper();

  const before = await distanceHelper.fromSourceAndDestination(
    prisma as any,
    'Coorg',
    'Bangalore',
    2,
  );
  assert.equal(before.distanceKm, 280);

  const service = new LocationsService(prisma as any);
  await service.update(1, { distance_km: 300 });

  assert.equal(rows.get(1n)?.distance, 300);
  assert.equal(rows.get(2n)?.distance, 300);
  assert.equal(rows.get(1n)?.duration, '12 hours 0 mins');
  assert.equal(rows.get(2n)?.duration, '12 hours 0 mins');

  const after = await distanceHelper.fromSourceAndDestination(
    prisma as any,
    'Coorg',
    'Bangalore',
    2,
  );
  assert.equal(after.distanceKm, 300);
});

test('editing a route creates the reverse route when it is missing', async () => {
  const rows = new Map<bigint, any>([
    [1n, makeRow(1, 'Bangalore', 'Coorg', 280)],
  ]);
  const prisma = makePrisma(rows);
  const service = new LocationsService(prisma as any);

  await service.update(1, { distance_km: 300 });

  const reverse = Array.from(rows.values()).find(
    (row) => row.source_location === 'Coorg' && row.destination_location === 'Bangalore',
  );
  assert.ok(reverse);
  assert.equal(reverse.distance, 300);
  assert.equal(reverse.duration, '12 hours 0 mins');
});
