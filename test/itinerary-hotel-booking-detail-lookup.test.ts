import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelBookingDetailLookupService } from '../src/modules/itineraries/services/itinerary-hotel-booking-detail-lookup.service';

test('maps persisted hotel details and voucher cancellation flags', async () => {
  let requestedIds: number[] = [];
  const result = await new ItineraryHotelBookingDetailLookupService().load({
    loadDetails: async () => [
      { itinerary_plan_hotel_details_ID: 11, itinerary_route_id: 2, hotel_id: 10, group_type: 1 },
      { itinerary_plan_hotel_details_ID: 12, itinerary_route_id: 3, hotel_id: 20, group_type: 2 },
    ],
    loadVoucherStatuses: async (ids) => {
      requestedIds = ids;
      return [{ itinerary_plan_hotel_details_ID: 11, hotel_voucher_cancellation_status: 1 }];
    },
  });

  assert.deepEqual(requestedIds, [11, 12]);
  assert.equal(result.detailsMap.get('2-10-1'), 11);
  assert.equal(result.detailsMap.get('3-20-2'), 12);
  assert.equal(result.voucherStatusMap.get(11), true);
  assert.equal(result.voucherStatusMap.has(12), false);
});

test('skips voucher reads when no persisted hotel details exist', async () => {
  let voucherRead = false;
  const result = await new ItineraryHotelBookingDetailLookupService().load({
    loadDetails: async () => [],
    loadVoucherStatuses: async () => {
      voucherRead = true;
      return [];
    },
  });

  assert.equal(voucherRead, false);
  assert.equal(result.detailsMap.size, 0);
  assert.equal(result.voucherStatusMap.size, 0);
});
