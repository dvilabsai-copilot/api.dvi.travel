import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsHotelTravelTimeService } from '../src/modules/itineraries/services/itinerary-details-hotel-travel-time.service';

const toMinutes = (value: string | null | undefined) => {
  const [hours, minutes] = String(value ?? '0:0').split(':').map(Number);
  return hours * 60 + minutes;
};

test('reverses persisted item-type-5 times and stores the actual arrival time', () => {
  const result = new ItineraryDetailsHotelTravelTimeService().build({
    startTimeText: '18:00',
    endTimeText: '16:30',
    travelDuration: '01:30:00',
    quoteId: 1,
    routeId: 2,
    routeHotspotId: 3,
    fromName: 'Museum',
    toName: 'Hotel',
    proofQuoteEnabled: false,
    timeToMinutes: toMinutes,
    getTravelTimeRangeWithDuration: () => null,
  });

  assert.deepEqual(result, { timeRange: '16:30 - 18:00', hotelArrivalTime: '18:00' });
});

test('derives a duration-backed range when stored start and end times are equal', () => {
  const result = new ItineraryDetailsHotelTravelTimeService().build({
    startTimeText: '10:00',
    endTimeText: '10:00',
    travelDuration: '01:15:00',
    quoteId: 1,
    routeId: 2,
    routeHotspotId: 3,
    fromName: 'Museum',
    toName: 'Hotel',
    proofQuoteEnabled: false,
    timeToMinutes: toMinutes,
    getTravelTimeRangeWithDuration: () => '10:00 - 11:15',
  });

  assert.deepEqual(result, { timeRange: '10:00 - 11:15', hotelArrivalTime: '11:15' });
});
