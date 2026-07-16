import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaahCandidateResultService } from '../src/modules/itineraries/services/staah-candidate-result.service';

const input = (isBookable: boolean) => ({
  candidate: { rate: { room_id: 'R1', rateplan_id: '12' }, rp: { meal_plan_description: 'Breakfast', currency: 'INR' }, price: 500, reason: 'CTA active', availableAgainFrom: '2026-07-23' },
  isBookable,
  routeId: 7,
  propertyId: 'P1',
  hotel: { hotel_id: 10, hotel_name: 'STAAH Hotel', hotel_city: 'Kochi', hotel_category: 4, hotel_cancel_policy: 'Cancel' },
  destination: 'Kochi',
  dateStamp: '20260720',
  hotelIdByPropertyId: new Map([['P1', 10]]),
  roomTitleByHotelAndCode: new Map([['10|R1', 'Deluxe']]),
  pushedKeys: new Set<string>(),
  callbacks: {
    isAllowedRoom: () => true,
    normalizeExactRoom: (value: unknown) => String(value).toUpperCase(),
    normalizeLooseRoom: (value: unknown) => String(value).replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    buildAvailabilityMessage: (reason: string | null, from: string | null) => `${reason}:${from}`,
  },
});

test('projects a bookable STAAH candidate with room metadata and search reference', () => {
  const result = new StaahCandidateResultService().build(input(true));
  assert.equal(result?.isBookable, true);
  assert.equal(result?.roomType, 'Deluxe');
  assert.equal(result?.mealPlan, 'Breakfast');
  assert.equal(result?.searchReference, 'STAAH-P1-R1-12-20260720');
  assert.equal(result?.availabilityMessage, '');
});

test('projects restricted candidates once and preserves the availability message', () => {
  const service = new StaahCandidateResultService();
  const context = input(false);
  const first = service.build(context);
  const second = service.build(context);
  assert.equal(first?.availabilityStatus, 'NOT_BOOKABLE');
  assert.equal(first?.availabilityMessage, 'CTA active:2026-07-23');
  assert.equal(second, null);
});
