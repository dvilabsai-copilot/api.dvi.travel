import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';
import { makeTboMultiBatchStay, priceTboMultiBatchStay } from '../src/modules/hotels/utils/tbo-multi-batch-stay.util';
import { projectHotelPayablePricing } from '../src/modules/itineraries/utils/hotel-payable-pricing.util';

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

test('EP batches save the selected DVI meal plan and preserve supplier amounts and codes through repricing', async () => {
  const writes: any[] = [];
  const hotelCode = '1738421';
  const roomType = 'Deluxe Double Room';
  const routes = [26765, 26766];
  const batch = (mealPlan: string, roomCount: number, batchIndex: number) => ({
    hotelCode, roomType, mealPlan, currency: 'INR', isRefundable: false,
    batchIndex, startRoomIndex: batchIndex * 6, roomCount, bookingCode: hotelCode + '!TB!' + mealPlan + batchIndex,
    supplierNetAmount: roomCount * 1000, supplierTotalFare: roomCount * 1250,
    occupancies: Array.from({ length: roomCount }, (_, index) => ({ adults: 2, children: Number(index === 0), childrenAges: index === 0 ? [7] : [] })),
  });
  const offer = (mealPlan: string) => ({
    hotelCode, hotelName: 'Hotel Citywalk Residency', roomType, mealPlan, currency: 'INR', rating: 3,
    totalFare: 10000, tboRoomBatches: [6, 2].map((count, index) => batch(mealPlan, count, index)),
  });
  let supplierRows = [offer('EP')];
  const service = Object.assign(Object.create(ItinerariesService.prototype), {
    prisma: {
      dvi_global_settings: { findFirst: async () => ({ hotel_margin: 5 }) },
      dvi_itinerary_plan_hotel_details: { findMany: async () => writes.map(selection => ({
        itinerary_route_id: selection.routeId,
        selected_price_snapshot: JSON.stringify({ tboMultiBatchStay: selection.tboMultiBatchStay }),
      })) },
    },
    hotelDetailsTboService: {
      searchSelectedHotelForContinuousStay: async () => supplierRows,
      getTboMapFallbackConfig: async () => ({ enabled: true, breakfastRate: 400, dinnerRate3Star: 900 }),
    },
    selectionWorkflowService: { bulkSaveHotels: async (_id: number, selections: any[]) => writes.push(...selections) },
    hotelBlockingService: { cancelHoldsAfterHotelChange: async () => {} },
    itineraryDetails: { getItineraryDetailsForSelectedHotelRates: async () => null },
  });
  const run = (mealPlanCode: string, expectedAmount?: number) => service.selectTboMultiBatchStayIntent({
    planId: 12254, quoteId: 'DVI20261156', anchorRouteId: routes[0], groupType: 1,
    hotelCode, intent: 'MEAL_PLAN', plan: { preferred_room_count: 8, meal_plan_code: 'CP' },
    data: { roomType, mealPlanCode, previewOnly: expectedAmount === undefined,
      expectedBatchFare: { amount: expectedAmount, currency: 'INR' } },
    stay: { routeIds: routes, nights: 2, checkInDate: '2026-11-25', checkOutDate: '2026-11-27', stayDates: ['2026-11-25', '2026-11-26'] },
  });
  const cp = await run('CP');
  assert.equal(cp.totals.totalPrice, 24900);
  assert.equal(cp.selections[0].tboMapFallbackBreakfastPerNight, 7200);
  assert.equal(cp.selections[0].mealPlan, 'CP');
  assert.equal(cp.selections[0].supplierMealPlan, 'EP');
  const map = await run('MAP');
  assert.deepEqual(map.selections.map(row => row.pricePerNight), [28650, 28650]);
  assert.equal(map.totals.totalPrice, 57300);
  await assert.rejects(() => run('MAP', 10500), (error: ConflictException) =>
    (error.getResponse() as any).mealSupplement === 46800);
  assert.deepEqual(writes, []);
  await run('MAP', 57300);
  const saved = writes[0].tboMultiBatchStay;
  assert.equal(saved.mealPlan, 'EP');
  assert.equal(writes[0].mealPlanCode, 'MAP');
  assert.deepEqual(saved.batches.map(row => row.bookingCode), [hotelCode + '!TB!EP0', hotelCode + '!TB!EP1']);
  assert.equal(projectHotelPayablePricing(writes[0], 5).totalPrice, 28650);
  const updated = makeTboMultiBatchStay({ ...saved, batches: saved.batches.map(row => ({
    ...row, supplierTotalFare: row.supplierTotalFare + 50,
  })) });
  assert.equal(priceTboMultiBatchStay(updated, 5).totalPrice, 57405);
  assert.equal(updated.dviMealSupplement?.breakfastPerNight, 7200);
  supplierRows = [offer('EP'), offer('CP')];
  const native = await run('CP');
  assert.equal(native.totals.totalPrice, 10500);
  assert.equal(native.selections[0].supplierMealPlan, 'CP');
  assert.equal(native.selections[0].tboMultiBatchStay.dviMealSupplement, undefined);
});
