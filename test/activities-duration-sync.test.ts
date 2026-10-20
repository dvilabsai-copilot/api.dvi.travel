import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivitiesService } from '../src/modules/activities/activities.service';

const time = (hours: number, minutes: number): Date => {
  const value = new Date(0);
  value.setUTCHours(hours, minutes, 0, 0);
  return value;
};

test('changing activity duration resynchronizes an editable itinerary timeline', async () => {
  const currentActivity = {
    route_activity_ID: 101,
    itinerary_plan_ID: 10,
    itinerary_route_ID: 20,
    route_hotspot_ID: 100,
    activity_ID: 7,
    activity_order: 1,
    activity_traveling_time: time(0, 30),
    activity_start_time: time(18, 1),
    activity_end_time: time(18, 31),
    deleted: 0,
    status: 1,
  };
  const downstreamActivity = {
    route_activity_ID: 201,
    itinerary_plan_ID: 10,
    itinerary_route_ID: 20,
    route_hotspot_ID: 200,
    activity_ID: 8,
    activity_order: 1,
    activity_traveling_time: time(1, 0),
    activity_start_time: time(18, 31),
    activity_end_time: time(19, 31),
    deleted: 0,
    status: 1,
  };
  const hotspots = new Map([
    [100, {
      route_hotspot_ID: 100,
      hotspot_order: 1,
      hotspot_start_time: time(18, 1),
      hotspot_end_time: time(18, 31),
    }],
    [200, {
      route_hotspot_ID: 200,
      hotspot_order: 2,
      hotspot_start_time: time(18, 31),
      hotspot_end_time: time(19, 31),
    }],
  ]);
  const activities = new Map([
    [101, currentActivity],
    [201, downstreamActivity],
  ]);

  const tx: any = {
    dvi_activity: {
      update: async ({ data }: any) => ({ activity_id: 7, ...data }),
    },
    dvi_itinerary_plan_details: {
      findMany: async () => [{ itinerary_plan_ID: 10 }],
    },
    dvi_itinerary_route_hotspot_details: {
      findFirst: async ({ where }: any) => hotspots.get(Number(where.route_hotspot_ID)) || null,
      findMany: async ({ where }: any) => Array.from(hotspots.values())
        .filter((row: any) => row.hotspot_order > Number(where.hotspot_order?.gt || 0)),
      update: async ({ where, data }: any) => {
        const row = hotspots.get(Number(where.route_hotspot_ID));
        Object.assign(row, data);
        return row;
      },
    },
    dvi_itinerary_route_activity_details: {
      findMany: async ({ where }: any) => {
        if (where.activity_ID) return [currentActivity];
        if (Number(where.route_hotspot_ID) === 100) return [currentActivity];
        if (Number(where.route_hotspot_ID) === 200) return [downstreamActivity];
        return [];
      },
      update: async ({ where, data }: any) => {
        const row = activities.get(Number(where.route_activity_ID));
        Object.assign(row, data);
        return row;
      },
    },
  };

  const prisma: any = {
    dvi_activity: {
      findFirst: async () => ({ activity_id: 7, activity_duration: time(0, 30) }),
    },
    $transaction: async (work: (client: any) => Promise<any>) => work(tx),
  };

  const service = new ActivitiesService(prisma);
  await service.updateActivity(7, { activity_duration: '02:00:00' });

  assert.equal(currentActivity.activity_end_time.getUTCHours(), 20);
  assert.equal(currentActivity.activity_end_time.getUTCMinutes(), 1);
  assert.equal(currentActivity.activity_traveling_time.getUTCHours(), 2);
  assert.equal(hotspots.get(100).hotspot_end_time.getUTCHours(), 20);
  assert.equal(hotspots.get(100).hotspot_end_time.getUTCMinutes(), 1);
  assert.equal(hotspots.get(200).hotspot_start_time.getUTCHours(), 20);
  assert.equal(hotspots.get(200).hotspot_start_time.getUTCMinutes(), 1);
  assert.equal(downstreamActivity.activity_start_time.getUTCHours(), 20);
  assert.equal(downstreamActivity.activity_start_time.getUTCMinutes(), 1);
});

test('duration synchronization does not touch confirmed itinerary plans', async () => {
  let activityUpdates = 0;
  const tx: any = {
    dvi_activity: { update: async () => ({ activity_id: 7 }) },
    dvi_itinerary_plan_details: { findMany: async () => [] },
    dvi_itinerary_route_hotspot_details: { findFirst: async () => null },
    dvi_itinerary_route_activity_details: {
      findMany: async ({ where }: any) => where.activity_ID ? [{
        itinerary_plan_ID: 10,
        itinerary_route_ID: 20,
        route_hotspot_ID: 100,
      }] : [],
      update: async () => { activityUpdates += 1; },
    },
  };
  const prisma: any = {
    dvi_activity: { findFirst: async () => ({ activity_id: 7, activity_duration: time(0, 30) }) },
    $transaction: async (work: (client: any) => Promise<any>) => work(tx),
  };

  const service = new ActivitiesService(prisma);
  await service.updateActivity(7, { activity_duration: '02:00:00' });

  assert.equal(activityUpdates, 0);
});
