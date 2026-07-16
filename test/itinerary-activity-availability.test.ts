import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryActivityAvailabilityService } from '../src/modules/itineraries/services/itinerary-activity-availability.service';

test('returns an empty activity catalog without pricing reads', async () => {
  let pricingCalls = 0;
  const service = new ItineraryActivityAvailabilityService({
    dvi_activity: { findMany: async () => [] },
  } as any);
  service.setCalculateActivityPlanPricingCallback(async () => {
    pricingCalls += 1;
    return {};
  });

  assert.deepEqual(await service.getAvailableActivities(9), []);
  assert.equal(pricingCalls, 0);
});

test('projects activity slots and plan pricing without changing response fields', async () => {
  const service = new ItineraryActivityAvailabilityService({
    dvi_activity: {
      findMany: async () => [{
        activity_id: 12,
        activity_title: 'Boat ride',
        activity_description: 'Backwater tour',
        activity_duration: '01:00:00',
        max_allowed_person_count: 4,
      }],
    },
    dvi_activity_time_slot_details: {
      findMany: async () => [{
        activity_time_slot_ID: 3,
        time_slot_type: 'morning',
        special_date: null,
        start_time: '09:00:00',
        end_time: '10:00:00',
      }],
    },
  } as any);
  service.setCalculateActivityPlanPricingCallback(async () => ({
    pricingUnitType: 'PER_ADULT',
    priceUnitLabel: 'per adult',
    nationalityType: 1,
    adults: 2,
    children: 1,
    adultRate: 100,
    childRate: 50,
    unitRate: 0,
    totalAmount: 250,
    priceDate: '2026-07-16',
  }));

  assert.deepEqual(await service.getAvailableActivities(9, 42, 7), [{
    id: 12,
    title: 'Boat ride',
    description: 'Backwater tour',
    duration: '01:00:00',
    maxPersons: 4,
    pricingUnitType: 'PER_ADULT',
    priceUnitLabel: 'per adult',
    nationalityType: 1,
    adultCount: 2,
    childCount: 1,
    costAdult: 100,
    costChild: 50,
    unitCost: 0,
    totalAmount: 250,
    totalPrice: 250,
    priceDate: '2026-07-16',
    timeSlots: [{
      id: 3,
      type: 'morning',
      specialDate: null,
      startTime: '09:00:00',
      endTime: '10:00:00',
    }],
  }]);
});
