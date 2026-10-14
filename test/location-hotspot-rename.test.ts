import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationsService } from '../src/modules/locations/locations.service';

function makePrisma() {
  const rows = new Map<bigint, any>([
    [1n, {
      location_ID: 1n,
      source_location: 'Old Town',
      destination_location: 'Destination',
      source_location_city: 'Old Town',
      destination_location_city: 'Destination',
    }],
  ]);
  const hotspots = new Map<number, any>([
    [10, {
      hotspot_ID: 10,
      deleted: 0,
      hotspot_location: 'Old Town|Other Place',
      hotspot_to_location: 'Destination|Old Town',
    }],
    [11, {
      hotspot_ID: 11,
      deleted: 0,
      hotspot_location: 'Old Town Center',
      hotspot_to_location: 'Other Place',
    }],
    [12, {
      hotspot_ID: 12,
      deleted: 1,
      hotspot_location: 'Old Town',
      hotspot_to_location: 'Old Town',
    }],
  ]);

  const storedLocations = {
    findFirst: async ({ where }: any) => rows.get(BigInt(where.location_ID)) ?? null,
    update: async ({ where, data }: any) => {
      const row = rows.get(BigInt(where.location_ID));
      if (!row) throw new Error('row not found');
      Object.assign(row, data);
      return row;
    },
  };

  const hotspotModel = {
    findMany: async () => Array.from(hotspots.values()).filter((hotspot) => hotspot.deleted === 0),
    update: async ({ where, data }: any) => {
      const hotspot = hotspots.get(Number(where.hotspot_ID));
      if (!hotspot) throw new Error('hotspot not found');
      Object.assign(hotspot, data);
      return hotspot;
    },
  };

  return {
    rows,
    hotspots,
    prisma: {
      dvi_stored_locations: storedLocations,
      $transaction: async (callback: (tx: any) => Promise<unknown>) =>
        callback({ dvi_stored_locations: storedLocations, dvi_hotspot_place: hotspotModel }),
    },
  };
}

test('quick source rename updates exact hotspot location tokens in both fields', async () => {
  const { prisma, rows, hotspots } = makePrisma();
  const service = new LocationsService(prisma as any);

  await service.modifyName(1, 'source', 'New Town');

  assert.equal(rows.get(1n)?.source_location, 'New Town');
  assert.equal(hotspots.get(10)?.hotspot_location, 'New Town|Other Place');
  assert.equal(hotspots.get(10)?.hotspot_to_location, 'Destination|New Town');
  assert.equal(hotspots.get(11)?.hotspot_location, 'Old Town Center');
  assert.equal(hotspots.get(12)?.hotspot_location, 'Old Town');
});

test('quick destination rename updates destination location tokens', async () => {
  const { prisma, rows, hotspots } = makePrisma();
  const service = new LocationsService(prisma as any);

  await service.modifyName(1, 'destination', 'New Destination');

  assert.equal(rows.get(1n)?.destination_location, 'New Destination');
  assert.equal(hotspots.get(10)?.hotspot_to_location, 'New Destination|Old Town');
  assert.equal(hotspots.get(10)?.hotspot_location, 'Old Town|Other Place');
});
