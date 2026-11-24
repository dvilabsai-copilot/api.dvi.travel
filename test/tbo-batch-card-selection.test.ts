import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';

test('a changed 6+2 card fare needs approval before either the existing hotel or holds change', async () => {
  const writes: any[] = [];
  const processedHolds: any[] = [];
  const hotelCode = '1141249';
  const routeId = 26765;
  const service = Object.create(ItinerariesService.prototype) as any;
  Object.assign(service, {
    prisma: {
      dvi_global_settings: { findFirst: async () => ({ hotel_margin: 5 }) },
      dvi_itinerary_plan_hotel_details: { findMany: async () => writes.map((selection) => ({
        itinerary_route_id: selection.routeId,
        selected_price_snapshot: JSON.stringify({ tboMultiBatchStay: selection.tboMultiBatchStay }),
      })) },
    },
    hotelDetailsTboService: {
      searchSelectedHotelForContinuousStay: async () => [{
        hotelCode, hotelName: 'Metro Plaza Hotel', roomType: 'Executive Room', mealPlan: 'CP', currency: 'INR',
        tboRoomBatches: [6, 2].map((roomCount, batchIndex) => ({
          hotelCode, roomType: 'Executive Room', mealPlan: 'CP', currency: 'INR', isRefundable: false,
          batchIndex, startRoomIndex: batchIndex * 6, roomCount, bookingCode: hotelCode + '!TB!fixture' + batchIndex,
          supplierNetAmount: 2000 * roomCount, supplierTotalFare: 2500 * roomCount,
          occupancies: Array.from({ length: roomCount }, () => ({ adults: 2, children: 0, childrenAges: [] })),
        })),
      }],
    },
    selectionWorkflowService: { bulkSaveHotels: async (_planId: number, selections: any[]) => writes.push(...selections) },
    hotelBlockingService: { cancelHoldsAfterHotelChange: async (details: unknown) => processedHolds.push(details) },
    itineraryDetails: { getItineraryDetailsForSelectedHotelRates: async () => null },
  });
  const params = {
    planId: 12254, quoteId: 'DVI20261156', anchorRouteId: routeId, groupType: 1, hotelCode, intent: 'ROOM_TYPE',
    data: { roomType: 'Executive Room', mealPlanCode: 'CP' },
    plan: { preferred_room_count: 8 },
    stay: { routeIds: [routeId], nights: 1, checkInDate: '2026-11-25', checkOutDate: '2026-11-26', stayDates: ['2026-11-25'] },
  };
  const select = (amount: number | null) => service.selectTboMultiBatchStayIntent({
    ...params, data: { ...params.data, expectedBatchFare: { amount, currency: 'INR' } },
  });
  for (const previousAmount of [19957.39, null]) {
    await assert.rejects(() => select(previousAmount), (error: ConflictException) => {
      const response = error.getResponse() as Record<string, unknown>;
      assert.equal(response.code, 'TBO_BATCH_CARD_FARE_CHANGED');
      assert.equal(response.previousAmount, previousAmount);
      assert.equal(response.amount, 21000);
      return true;
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(processedHolds, []);
  }

  const result = await select(21000);
  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.affectedRouteIds, [routeId]);
  assert.equal(writes.length, 1);
  assert.equal(processedHolds.length, 1);
  assert.equal(writes[0].totalPrice, 21000);
  assert.deepEqual(writes[0].tboMultiBatchStay.batches.map((batch: any) => batch.roomCount), [6, 2]);
  assert.equal(writes[0].bookingCode, undefined);
});
