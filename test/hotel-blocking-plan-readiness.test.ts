import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelBlockingService } from '../src/modules/itineraries/services/hotel-blocking.service';

function serviceWithPlan(itineraryPreference: number, selectedRows: any[] = [], requests: any[] = []) {
  const calls = { selectedRows: 0, requests: 0 };
  const service = new HotelBlockingService(
    {
      dvi_itinerary_plan_details: {
        findUnique: async () => ({ itinerary_preference: itineraryPreference }),
      },
      dvi_itinerary_plan_hotel_details: {
        findMany: async () => {
          calls.selectedRows += 1;
          return selectedRows;
        },
      },
      dvi_hotel_block_request: {
        findMany: async () => {
          calls.requests += 1;
          return requests;
        },
      },
    } as any,
    {} as any,
  );
  return { service, calls };
}

test('vehicle-only plans bypass hotel readiness checks', async () => {
  const { service, calls } = serviceWithPlan(2, [{ itinerary_plan_hotel_details_ID: 101 }], []);

  const result = await service.assertPlanReady(12032, 1);

  assert.deepEqual(result, { ready: true, requestCount: 0 });
  assert.equal(calls.selectedRows, 0);
  assert.equal(calls.requests, 0);
});

test('hotel-inclusive plans still require every selected hotel to be confirmed', async () => {
  const { service, calls } = serviceWithPlan(
    1,
    [{ itinerary_plan_hotel_details_ID: 101 }],
    [{ id: 7, hotel_name: 'Test Hotel', status: 'REQUESTED', selection_ids: '[101]' }],
  );

  await assert.rejects(
    service.assertPlanReady(12032, 1),
    (error: any) => {
      assert.equal(error?.response?.code, 'HOTEL_CONFIRMATION_PENDING');
      assert.equal(error?.response?.message, 'Confirm & Pay is available only after every selected hotel confirms the stay.');
      return true;
    },
  );
  assert.equal(calls.selectedRows, 1);
  assert.equal(calls.requests, 1);
});
