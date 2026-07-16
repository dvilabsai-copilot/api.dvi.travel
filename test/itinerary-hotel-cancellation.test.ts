import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelCancellationService } from '../src/modules/itineraries/services/itinerary-hotel-cancellation.service';

test('projects cancellation charges with the legacy percentage and breakdown fields', async () => {
  const service = new ItineraryHotelCancellationService({
    dvi_confirmed_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 7 }) },
    dvi_confirmed_itinerary_plan_hotel_details: { findFirst: async () => ({
      total_hotel_cost: 1000,
      total_room_cost: 700,
      total_hotel_meal_plan_cost: 100,
      total_amenities_cost: 50,
      total_hotel_tax_amount: 150,
    }) },
  });

  const result = await service.getEntireDayCancellationCharges(9, 4, '2026-07-16', 10);
  assert.deepEqual(result, {
    total_cost: 1000,
    cancellation_percentage: 10,
    cancellation_charge: 100,
    refund_amount: 900,
    breakdown: { room_cost: 700, meal_plan_cost: 100, amenities_cost: 50, tax_amount: 150 },
  });
});

test('cancellation soft-deletes hotel rows and updates refund accounting in one transaction', async () => {
  const calls: string[] = [];
  const service = new ItineraryHotelCancellationService({
    dvi_confirmed_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 7 }) },
    $transaction: async (callback: any) => callback({
      dvi_hotel_cancellations: { create: async () => { calls.push('audit'); } },
      dvi_confirmed_itinerary_plan_hotel_details: {
        findFirst: async () => ({ confirmed_itinerary_plan_hotel_details_ID: 12 }),
        update: async () => { calls.push('hotel'); },
      },
      dvi_confirmed_itinerary_plan_hotel_room_details: { updateMany: async () => { calls.push('rooms'); } },
      dvi_confirmed_itinerary_plan_details: { update: async () => { calls.push('plan'); } },
      dvi_accounts_itinerary_details: { updateMany: async () => { calls.push('accounts'); } },
    }),
  });

  const result = await service.cancelHotel(9, 4, '2026-07-16', 100, 900);
  assert.equal(result.refund_amount, 900);
  assert.deepEqual(calls, ['audit', 'hotel', 'rooms', 'plan', 'accounts']);
});
