import assert from 'node:assert/strict';
import test from 'node:test';
import { HotspotsService } from '../src/modules/hotspots/hotspots.service';

const time = (hours: number, minutes: number): Date => {
  const value = new Date(0);
  value.setUTCHours(hours, minutes, 0, 0);
  return value;
};

const buildTx = (planRows: any[]) => {
  const rows = new Map<number, any>([
    [101, {
      route_hotspot_ID: 101,
      itinerary_plan_ID: 10,
      itinerary_route_ID: 20,
      hotspot_ID: 593,
      item_type: 4,
      hotspot_order: 1,
      hotspot_start_time: time(18, 1),
      hotspot_end_time: time(18, 31),
      hotspot_traveling_time: time(0, 30),
      deleted: 0,
      status: 1,
    }],
    [102, {
      route_hotspot_ID: 102,
      itinerary_plan_ID: 10,
      itinerary_route_ID: 20,
      hotspot_ID: 999,
      item_type: 4,
      hotspot_order: 2,
      hotspot_start_time: time(18, 31),
      hotspot_end_time: time(19, 31),
      hotspot_traveling_time: time(1, 0),
      deleted: 0,
      status: 1,
    }],
  ]);

  return {
    dvi_itinerary_route_hotspot_details: {
      findMany: async ({ where }: any) => {
        if (where.hotspot_ID === 593) {
          return [{ itinerary_plan_ID: 10, itinerary_route_ID: 20 }];
        }
        return Array.from(rows.values())
          .filter((row) => row.itinerary_plan_ID === where.itinerary_plan_ID
            && row.itinerary_route_ID === where.itinerary_route_ID);
      },
      update: async ({ where, data }: any) => {
        const row = rows.get(Number(where.route_hotspot_ID));
        Object.assign(row, data);
        return row;
      },
    },
    dvi_itinerary_plan_details: {
      findMany: async () => planRows,
    },
    rows,
  };
};

test('changing hotspot duration resynchronizes an editable itinerary timeline', async () => {
  const tx: any = buildTx([{ itinerary_plan_ID: 10 }]);
  const service = new HotspotsService({} as any);

  await (service as any).synchronizeEditableItineraryHotspotDuration(tx, 593, 120);

  const target = tx.rows.get(101);
  const downstream = tx.rows.get(102);
  assert.equal(target.hotspot_end_time.getUTCHours(), 20);
  assert.equal(target.hotspot_end_time.getUTCMinutes(), 1);
  assert.equal(target.hotspot_traveling_time.getUTCHours(), 2);
  assert.equal(downstream.hotspot_start_time.getUTCHours(), 20);
  assert.equal(downstream.hotspot_start_time.getUTCMinutes(), 1);
  assert.equal(downstream.hotspot_end_time.getUTCHours(), 21);
  assert.equal(downstream.hotspot_end_time.getUTCMinutes(), 1);
});

test('changing hotspot duration does not touch confirmed itinerary timelines', async () => {
  const tx: any = buildTx([]);
  const service = new HotspotsService({} as any);

  await (service as any).synchronizeEditableItineraryHotspotDuration(tx, 593, 120);

  const target = tx.rows.get(101);
  assert.equal(target.hotspot_end_time.getUTCHours(), 18);
  assert.equal(target.hotspot_end_time.getUTCMinutes(), 31);
});
