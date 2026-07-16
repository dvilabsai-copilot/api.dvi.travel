import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaahProviderRowsService } from '../src/modules/itineraries/services/staah-provider-rows.service';

test('loads STAAH rows, filters stale rooms and groups restrictions by rate key', async () => {
  const calls: string[] = [];
  const result = await new StaahProviderRowsService().load({
    propertyIds: ['P1'],
    checkInDate: new Date('2026-07-17T00:00:00.000Z'),
    checkOutDate: new Date('2026-07-18T00:00:00.000Z'),
    isAllowedRoom: (_property, room) => String(room) === 'ROOM-1',
    queries: {
      loadInventory: async () => [
        { staah_property_id: 'P1', room_id: 'ROOM-1' },
        { staah_property_id: 'P1', room_id: 'STALE' },
      ],
      loadRatePlans: async () => [
        { staah_property_id: 'P1', room_id: 'ROOM-1', rateplan_id: '12' },
        { staah_property_id: 'P1', room_id: 'STALE', rateplan_id: '15' },
      ],
      loadRates: async (input) => {
        calls.push(`rates:${input.roomIds.join(',')}:${input.ratePlanIds.join(',')}`);
        return [
          { staah_property_id: 'P1', room_id: 'ROOM-1', rateplan_id: '12' },
          { staah_property_id: 'P1', room_id: 'STALE', rateplan_id: '15' },
        ];
      },
      loadRestrictions: async () => [
        { staah_property_id: 'P1', room_id: 'ROOM-1', rateplan_id: '12', type: 'CLOSED' },
        { staah_property_id: 'P1', room_id: 'ROOM-1', rateplan_id: '12', type: 'CTA' },
      ],
    },
  });

  assert.deepEqual(result.roomIds, ['ROOM-1']);
  assert.deepEqual(result.ratePlanIds, ['12']);
  assert.equal(result.inventoryRows.length, 1);
  assert.equal(result.ratePlanRows.length, 1);
  assert.equal(result.rateRows.length, 1);
  assert.deepEqual(
    result.restrictionRowsByRateKey.get('P1|ROOM-1|12')?.map((row) => row.type),
    ['CLOSED', 'CTA'],
  );
  assert.deepEqual(calls, ['rates:ROOM-1:12']);
});

test('does not query rates or restrictions when no active room or rate-plan IDs remain', async () => {
  let downstreamCalls = 0;
  const result = await new StaahProviderRowsService().load({
    propertyIds: ['P1'],
    checkInDate: new Date('2026-07-17T00:00:00.000Z'),
    checkOutDate: new Date('2026-07-18T00:00:00.000Z'),
    isAllowedRoom: () => false,
    queries: {
      loadInventory: async () => [{ room_id: 'STALE' }],
      loadRatePlans: async () => [{ room_id: 'STALE', rateplan_id: '12' }],
      loadRates: async () => {
        downstreamCalls += 1;
        return [];
      },
      loadRestrictions: async () => {
        downstreamCalls += 1;
        return [];
      },
    },
  });

  assert.equal(result.roomIds.length, 0);
  assert.equal(result.ratePlanIds.length, 0);
  assert.equal(result.rateRows.length, 0);
  assert.equal(downstreamCalls, 0);
});
