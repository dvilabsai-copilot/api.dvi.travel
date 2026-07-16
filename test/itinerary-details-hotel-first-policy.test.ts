import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsHotelFirstPolicyService } from '../src/modules/itineraries/services/itinerary-details-hotel-first-policy.service';

test('keeps the start segment before check-in when hotel-first departure is detected', () => {
  const service = new ItineraryDetailsHotelFirstPolicyService();
  const start = { type: 'start', timeRange: '07:00 AM - 07:30 AM' };
  const checkin = { type: 'checkin', time: '08:00 AM - 08:30 AM' };
  const travel = { type: 'travel', from: 'Night Hotel', to: 'Museum', timeRange: '09:00 AM - 09:30 AM' };
  const segments = service.apply({
    segments: [start, checkin, travel],
    routeHotelName: 'Night Hotel',
    normalizeName: (value) => String(value ?? '').trim().toLowerCase(),
    timeToMinutes: (value) => {
      const [clock, period] = String(value).split(' ');
      const [hours, minutes] = clock.split(':').map(Number);
      return ((hours % 12) + (period === 'PM' ? 12 : 0)) * 60 + minutes;
    },
  });
  assert.deepEqual(segments, [start, checkin, travel]);
});
