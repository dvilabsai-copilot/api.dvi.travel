import assert from 'node:assert/strict';
import { SameCityCrossDayOptimizerService } from '../src/modules/itineraries/services/same-city-cross-day-optimizer.service';

function makeService(
  mockTx: any,
  capture?: { rebuildOptions?: any },
  onRebuild?: () => void,
): SameCityCrossDayOptimizerService {
  const prisma = {
    $transaction: async (fn: any) => fn(mockTx),
  } as any;

  const hotspotEngine = {
    rebuildRouteHotspots: async (_tx: any, _planId: number, _existingHotspots?: any[], options?: any) => ({
      rebuildSummary: { totalHotspotsScheduled: 0 },
      options,
    }),
  } as any;

  if (capture) {
    hotspotEngine.rebuildRouteHotspots = async (_tx: any, _planId: number, _existingHotspots?: any[], options?: any) => {
      capture.rebuildOptions = options;
      onRebuild?.();
      return { rebuildSummary: { totalHotspotsScheduled: 0 }, options };
    };
  }

  return new SameCityCrossDayOptimizerService(prisma, hotspotEngine);
}

async function main() {
  process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER = 'true';
  process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN = 'true';
  process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY = 'true';
  const capture = { rebuildOptions: null as any };
  const state = { rebuilt: false };

  const baseRouteHotspots = [
    {
      route_hotspot_ID: 11,
      itinerary_route_ID: 8605,
      hotspot_ID: 101,
      hotspot_name: 'Ramoji Film City',
      hotspot_priority: 1,
      hotspot_plan_own_way: 0,
      item_type: 4,
      hotspot_order: 1,
      hotspot_start_time: new Date('1970-01-01T10:00:00.000Z'),
      hotspot_end_time: new Date('1970-01-01T17:00:00.000Z'),
      hotspot_traveling_time: new Date('1970-01-01T09:00:00.000Z'),
    },
    {
      route_hotspot_ID: 12,
      itinerary_route_ID: 8605,
      hotspot_ID: 102,
      hotspot_name: 'Mecca Masjid',
      hotspot_priority: 0,
      hotspot_plan_own_way: 0,
      item_type: 4,
      hotspot_order: 2,
      hotspot_start_time: new Date('1970-01-01T17:56:00.000Z'),
      hotspot_end_time: new Date('1970-01-01T18:16:00.000Z'),
      hotspot_traveling_time: new Date('1970-01-01T17:01:00.000Z'),
    },
    {
      route_hotspot_ID: 21,
      itinerary_route_ID: 8606,
      hotspot_ID: 204,
      hotspot_name: 'Calvary Temple',
      hotspot_priority: 15,
      hotspot_plan_own_way: 0,
      item_type: 4,
      hotspot_order: 1,
      hotspot_start_time: new Date('1970-01-01T09:33:00.000Z'),
      hotspot_end_time: new Date('1970-01-01T10:33:00.000Z'),
      hotspot_traveling_time: new Date('1970-01-01T09:00:00.000Z'),
    },
    {
      route_hotspot_ID: 22,
      itinerary_route_ID: 8606,
      hotspot_ID: 201,
      hotspot_name: 'Charminar',
      hotspot_priority: 0,
      hotspot_plan_own_way: 0,
      item_type: 4,
      hotspot_order: 1,
      hotspot_start_time: new Date('1970-01-01T11:13:00.000Z'),
      hotspot_end_time: new Date('1970-01-01T12:13:00.000Z'),
      hotspot_traveling_time: new Date('1970-01-01T10:33:00.000Z'),
    },
    {
      route_hotspot_ID: 23,
      itinerary_route_ID: 8606,
      hotspot_ID: 202,
      hotspot_name: 'Qutub Shahi Tombs',
      hotspot_priority: 0,
      hotspot_plan_own_way: 0,
      item_type: 4,
      hotspot_order: 2,
      hotspot_start_time: new Date('1970-01-01T12:33:00.000Z'),
      hotspot_end_time: new Date('1970-01-01T13:33:00.000Z'),
      hotspot_traveling_time: new Date('1970-01-01T12:13:00.000Z'),
    },
    {
      route_hotspot_ID: 24,
      itinerary_route_ID: 8606,
      hotspot_ID: 203,
      hotspot_name: 'Birla Mandir',
      hotspot_priority: 0,
      hotspot_plan_own_way: 0,
      item_type: 4,
      hotspot_order: 3,
      hotspot_start_time: new Date('1970-01-01T16:16:00.000Z'),
      hotspot_end_time: new Date('1970-01-01T17:46:00.000Z'),
      hotspot_traveling_time: new Date('1970-01-01T15:27:00.000Z'),
    },
    {
      route_hotspot_ID: 31,
      itinerary_route_ID: 8607,
      hotspot_ID: 301,
      hotspot_name: 'Airport transfer',
      hotspot_priority: 0,
      hotspot_plan_own_way: 0,
      item_type: 7,
      hotspot_order: 1,
      hotspot_start_time: new Date('1970-01-01T08:00:00.000Z'),
      hotspot_end_time: new Date('1970-01-01T13:00:00.000Z'),
      hotspot_traveling_time: new Date('1970-01-01T08:00:00.000Z'),
    },
  ];

  const mockTx = {
    dvi_itinerary_plan_details: {
      findFirst: async () => ({
        itinerary_plan_ID: 9871,
        itinerary_quote_ID: 'DVI20260798',
      }),
    },
    dvi_itinerary_route_details: {
      findMany: async () => ([
        {
          itinerary_route_ID: 8605,
          itinerary_plan_ID: 9871,
          no_of_days: 1,
          itinerary_route_date: new Date('2026-07-12T00:00:00.000Z'),
          location_name: 'Hyderabad, Rajiv Gandhi International Airport',
          next_visiting_location: 'Hyderabad, Telangana, India',
          route_start_time: new Date('1970-01-01T05:00:00.000Z'),
          route_end_time: new Date('1970-01-01T20:00:00.000Z'),
          direct_to_next_visiting_place: 0,
          excluded_hotspot_ids: [],
        },
        {
          itinerary_route_ID: 8606,
          itinerary_plan_ID: 9871,
          no_of_days: 2,
          itinerary_route_date: new Date('2026-07-13T00:00:00.000Z'),
          location_name: 'Hyderabad, Telangana, India',
          next_visiting_location: 'Hyderabad, Telangana, India',
          route_start_time: new Date('1970-01-01T08:00:00.000Z'),
          route_end_time: new Date('1970-01-01T20:00:00.000Z'),
          direct_to_next_visiting_place: 0,
          excluded_hotspot_ids: [],
        },
        {
          itinerary_route_ID: 8607,
          itinerary_plan_ID: 9871,
          no_of_days: 3,
          itinerary_route_date: new Date('2026-07-14T00:00:00.000Z'),
          location_name: 'Hyderabad, Telangana, India',
          next_visiting_location: 'Hyderabad, Rajiv Gandhi International Airport',
          route_start_time: new Date('1970-01-01T08:00:00.000Z'),
          route_end_time: new Date('1970-01-01T13:00:00.000Z'),
          direct_to_next_visiting_place: 0,
          excluded_hotspot_ids: [],
        },
      ]),
      update: async () => ({}),
    },
    dvi_itinerary_route_hotspot_details: {
      findMany: async () => {
        if (!state.rebuilt) {
          return baseRouteHotspots;
        }

        return baseRouteHotspots.map((row) =>
          row.route_hotspot_ID === 12
            ? {
                ...row,
                itinerary_route_ID: 8606,
                hotspot_order: 1,
              }
            : row,
        );
      },
    },
    dvi_hotspot_place: {
      findMany: async () => ([
        {
          hotspot_ID: 101,
          hotspot_name: 'Ramoji Film City',
          hotspot_location: 'Hyderabad',
          hotspot_to_location: 'Hyderabad',
          hotspot_priority: 1,
          hotspot_duration: new Date('1970-01-01T07:00:00.000Z'),
          hotspot_latitude: 17.251,
          hotspot_longitude: 78.681,
        },
        {
          hotspot_ID: 102,
          hotspot_name: 'Mecca Masjid',
          hotspot_location: 'Hyderabad',
          hotspot_to_location: 'Hyderabad',
          hotspot_priority: 0,
          hotspot_duration: new Date('1970-01-01T00:20:00.000Z'),
          hotspot_latitude: 17.3616,
          hotspot_longitude: 78.4747,
        },
        {
          hotspot_ID: 201,
          hotspot_name: 'Charminar',
          hotspot_location: 'Hyderabad',
          hotspot_to_location: 'Hyderabad',
          hotspot_priority: 0,
          hotspot_duration: new Date('1970-01-01T01:00:00.000Z'),
          hotspot_latitude: 17.3616,
          hotspot_longitude: 78.4747,
        },
        {
          hotspot_ID: 204,
          hotspot_name: 'Calvary Temple',
          hotspot_location: 'Hyderabad',
          hotspot_to_location: 'Hyderabad',
          hotspot_priority: 15,
          hotspot_duration: new Date('1970-01-01T01:00:00.000Z'),
          hotspot_latitude: 17.365,
          hotspot_longitude: 78.480,
        },
        {
          hotspot_ID: 202,
          hotspot_name: 'Qutub Shahi Tombs',
          hotspot_location: 'Hyderabad',
          hotspot_to_location: 'Hyderabad',
          hotspot_priority: 0,
          hotspot_duration: new Date('1970-01-01T01:00:00.000Z'),
          hotspot_latitude: 17.4095,
          hotspot_longitude: 78.4083,
        },
        {
          hotspot_ID: 203,
          hotspot_name: 'Birla Mandir',
          hotspot_location: 'Hyderabad',
          hotspot_to_location: 'Hyderabad',
          hotspot_priority: 0,
          hotspot_duration: new Date('1970-01-01T01:30:00.000Z'),
          hotspot_latitude: 17.4066,
          hotspot_longitude: 78.4691,
        },
      ]),
    },
  };

  const svc = makeService(mockTx, capture, () => {
    state.rebuilt = true;
  });
  const result = await svc.analyzePlanId(9871, { quoteId: 'DVI20260798', dryRun: true, maxMoves: 5 });

  assert.equal(result.enabled, true);
  assert.equal(result.applied, false);
  assert.ok(result.routeSnapshots.some((route) => String(route.cityKey || '').includes('hyderabad')));
  assert.ok(result.proposedMoves.length >= 1);

  const topMove = result.proposedMoves[0];
  assert.equal(topMove.hotspotName, 'Mecca Masjid');
  assert.equal(topMove.anchorHotspotName, 'Charminar');
  assert.equal(topMove.fromRouteId, 8605);
  assert.equal(topMove.toRouteId, 8606);
  assert.equal(topMove.direction, 'FORWARD');
  assert.ok(Number.isFinite(topMove.score));
  assert.ok((topMove.distanceKm ?? 0) < 15);
  assert.ok(Array.isArray(topMove.clusterMemberNames));
  assert.equal(topMove.clusterMemberNames?.includes('Mecca Masjid'), true);
  assert.equal(topMove.clusterMemberNames?.includes('Charminar'), true);
  assert.equal(result.proposedMoves.some((move) => move.toRouteId === 8607), false);

  process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN = 'false';
  const applied = await svc.analyzePlanId(9871, { quoteId: 'DVI20260798', dryRun: false, maxMoves: 5 });
  assert.equal(applied.applied, true);
  const protectedHotspotIds = new Set<number>(Array.isArray(capture.rebuildOptions?.protectedHotspotIds) ? capture.rebuildOptions.protectedHotspotIds : []);
  assert.equal(protectedHotspotIds.has(101), true);
  assert.equal(protectedHotspotIds.has(204), true);
  assert.equal(protectedHotspotIds.has(102), true);
  const allocationPlan = capture.rebuildOptions?.sameCityAllocationPlan;
  assert.ok(allocationPlan);
  assert.deepEqual(allocationPlan?.preferredAdjacencyPairsByRoute?.[8606], [[201, 102]]);
  assert.deepEqual(allocationPlan?.desiredMovableOrderByRoute?.[8606], [201, 102, 202, 203]);
}

main()
  .then(() => {
    console.log('same-city-cross-day-optimizer tests passed');
  })
  .catch((error) => {
    console.error('same-city-cross-day-optimizer tests failed:', error);
    process.exit(1);
  });
