import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryListingService } from '../src/modules/itineraries/services/itinerary-listing.service';
import { ItineraryDetailsService } from '../src/modules/itineraries/itinerary-details.service';

function createService() {
  return new ItineraryListingService({
    dvi_agent: { findMany: async () => [] },
    dvi_itinerary_plan_details: { findMany: async () => [] },
  } as any);
}

test('listing preserves empty agent filter results', async () => {
  assert.deepEqual(await createService().getAgentsForFilter({ user: {} }), []);
});

test('listing preserves empty location filter results', async () => {
  assert.deepEqual(await createService().getLocationsForLatestFilter(), []);
});

test('latest location filters use database distinct queries', async () => {
  const calls: any[] = [];
  const service = new ItineraryListingService({
    dvi_itinerary_plan_details: {
      findMany: async (args: any) => {
        calls.push(args);
        return args.select.arrival_location
          ? [{ arrival_location: 'A' }]
          : [{ departure_location: 'B' }];
      },
    },
  } as any);

  assert.deepEqual(
    await service.getLocationsForLatestFilter({ user: {} }),
    [
      { value: 'A', label: 'A' },
      { value: 'B', label: 'B' },
    ],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].distinct, ['arrival_location']);
  assert.deepEqual(calls[1].distinct, ['departure_location']);
});

test('latest listing applies pagination in the database', async () => {
  const planFindManyCalls: any[] = [];
  const confirmed = {
    findMany: async () => [{ itinerary_plan_ID: 11 }],
  };
  const plans = {
    count: async ({ where }: any) => {
      assert.deepEqual(where.NOT, { itinerary_plan_ID: { in: [11] } });
      return 3;
    },
    findMany: async (args: any) => {
      planFindManyCalls.push(args);
      return [
        {
          itinerary_plan_ID: 7,
          arrival_location: 'A',
          departure_location: 'B',
          trip_start_date_and_time: null,
          trip_end_date_and_time: null,
          itinerary_quote_ID: 'DVI7',
          no_of_routes: 1,
          no_of_days: 1,
          no_of_nights: 0,
          total_adult: 2,
          total_children: 0,
          total_infants: 0,
          itinerary_preference: 0,
          preferred_room_count: 1,
          total_extra_bed: 0,
          status: 1,
          deleted: 0,
          createdon: null,
          createdby: 0,
          staff_id: 0,
          agent_id: 0,
        },
      ];
    },
  };

  const service = new ItineraryDetailsService({
    dvi_confirmed_itinerary_plan_details: confirmed,
    dvi_itinerary_plan_details: plans,
    dvi_users: { findMany: async () => [] },
    dvi_staff_details: { findMany: async () => [] },
    dvi_agent: { findMany: async () => [] },
  } as any);

  const response = await service.getLatestItinerariesDataTable(
    { draw: 1, start: 20, length: 10 } as any,
    { query: {}, user: {} },
  );

  assert.equal(response.recordsTotal, 3);
  assert.equal(response.recordsFiltered, 3);
  assert.equal(response.data.length, 1);
  assert.equal(planFindManyCalls.length, 1);
  assert.equal(planFindManyCalls[0].skip, 20);
  assert.equal(planFindManyCalls[0].take, 10);
});
