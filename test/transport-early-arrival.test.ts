import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { TransportEarlyArrivalValidationService } from '../src/modules/itineraries/validation/transport-early-arrival-validation.service';
import { TransportEarlyArrivalOption } from '../src/modules/itineraries/transport-early-arrival';
import { TransportEarlyArrivalTimelineService } from '../src/modules/itineraries/engines/helpers/transport-early-arrival-timeline.service';

const basePlan = {
  itinerary_preference: 2,
  trip_start_date: '2026-07-18T06:00:00+05:30',
};

test('rejects an early Transport Only arrival without a preference', () => {
  const service = new TransportEarlyArrivalValidationService();
  assert.throws(
    () => service.validate(basePlan as any),
    (error: unknown) =>
      error instanceof BadRequestException &&
      (error as any).response.code === 'TRANSPORT_EARLY_ARRIVAL_PREFERENCE_REQUIRED',
  );
});

test('does not require a preference at the cutoff or for hotel-inclusive plans', () => {
  const service = new TransportEarlyArrivalValidationService();
  service.validate({ ...basePlan, trip_start_date: '2026-07-18T08:00:00+05:30' } as any);
  service.validate({ ...basePlan, itinerary_preference: 3 } as any);
});

test('allows hotel rest without a hotel name', () => {
  const service = new TransportEarlyArrivalValidationService();
  service.validate({
    ...basePlan,
    transport_early_arrival_option: TransportEarlyArrivalOption.HOTEL_REST,
  } as any);
});

test('creates one explicit refreshment break through earliest sightseeing time', async () => {
  const service = new TransportEarlyArrivalTimelineService();
  const result = await service.apply({
    tx: {} as any,
    planId: 1,
    routeId: 2,
    plan: {
      ...basePlan,
      itinerary_preference: 2,
      transport_early_arrival_option: TransportEarlyArrivalOption.REFRESHMENT_BEFORE_SIGHTSEEING,
    },
    isFirstRoute: true,
    isLastRoute: false,
    routeEndSeconds: 18 * 3600,
    currentTime: '08:00:00',
    currentLocationName: 'Airport',
    order: 1,
    createdByUserId: 1,
  });

  assert.equal(result.handled, true);
  assert.equal(result.skipGenericRefreshment, true);
  assert.equal(result.currentTime, '09:00:00');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].item_type, 3);
});

test('creates a provisional hotel-rest segment without hotel booking rows', async () => {
  const service = new TransportEarlyArrivalTimelineService();
  const result = await service.apply({
    tx: {} as any,
    planId: 1,
    routeId: 2,
    plan: {
      ...basePlan,
      transport_early_arrival_option: TransportEarlyArrivalOption.HOTEL_REST,
      transport_early_arrival_hotel_name: 'Guest-arranged hotel',
      transport_early_arrival_rest_minutes: 180,
    },
    isFirstRoute: true,
    isLastRoute: false,
    routeEndSeconds: 18 * 3600,
    currentTime: '08:00:00',
    currentLocationName: 'Airport',
    order: 1,
    createdByUserId: 1,
  });

  assert.equal(result.currentLocationName, 'Guest-arranged hotel');
  assert.match(result.rows[0].via_location_name, /Guest-arranged hotel/);
  assert.equal(result.rows[0].hotspot_travelling_distance, null);
});
