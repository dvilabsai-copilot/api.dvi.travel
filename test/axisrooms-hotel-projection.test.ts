import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AxisroomsHotelProjectionService } from '../src/modules/itineraries/services/axisrooms-hotel-projection.service';

test('selects the preferred AxisRooms rate plan and projects local hotel metadata', () => {
  const service = new AxisroomsHotelProjectionService();
  const result = service.build({
    hotel: { hotel_id: 10, hotel_name: 'Axis Hotel', hotel_city: 'Kochi', hotel_category: 4, hotel_cancel_policy: 'Free cancellation' },
    availableRoomIds: new Set([20]),
    occupancyRows: [
      { hotel_id: 10, room_id: 20, rateplan_id: '12', occupancy_rates: { DOUBLE: 900 } },
      { hotel_id: 10, room_id: 20, rateplan_id: '15', occupancy_rates: { DOUBLE: 700 } },
    ],
    amenities: ['Pool', 'Pool'],
    ratePlanMetaByHotelRoom: new Map([['10|20', { rateConditions: ['Pay now'], inclusions: ['Breakfast'] }]]),
    mealPlanByRatePlan: new Map([['12', 'CP'], ['15', 'EP']]),
    roomTitleMap: new Map([[20, 'Deluxe']]),
    preferredMealPlanCode: 'CP',
    dateStamp: '20260720',
    destination: 'Kochi',
    callbacks: { extractRate: (value: any) => Number(value.DOUBLE) },
  });

  assert.equal(result?.hotelCode, '10');
  assert.equal(result?.price, 900);
  assert.equal(result?.mealPlan, 'CP');
  assert.deepEqual(result?.amenities, ['Pool']);
  assert.equal(result?.roomType, 'Deluxe');
  assert.equal(result?.searchReference, 'AX-10-20260720');
});

test('returns no projection when no valid occupancy rate is available', () => {
  const result = new AxisroomsHotelProjectionService().build({
    hotel: { hotel_id: 10 },
    availableRoomIds: new Set([20]),
    occupancyRows: [{ hotel_id: 10, room_id: 20, rateplan_id: '1', occupancy_rates: {} }],
    amenities: [],
    ratePlanMetaByHotelRoom: new Map(),
    mealPlanByRatePlan: new Map(),
    roomTitleMap: new Map(),
    dateStamp: '20260720',
    destination: 'Kochi',
    callbacks: { extractRate: () => 0 },
  });
  assert.equal(result, null);
});
