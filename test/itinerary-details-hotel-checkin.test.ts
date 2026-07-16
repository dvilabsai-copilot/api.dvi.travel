import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsHotelCheckInService } from '../src/modules/itineraries/services/itinerary-details-hotel-checkin.service';

test('prefers the arrival time carried from travel-to-hotel and projects the resolved address', () => {
  const result = new ItineraryDetailsHotelCheckInService().build({
    hotelInfo: { hotel_name: 'Harbor Hotel', hotel_address: 'Main Road' },
    isVehicleOnly: false,
    location: { destination_location: 'Chennai' },
    route: { next_visiting_location: 'Chennai', route_end_time: '18:00' },
    hotelArrivalTime: '17:45',
    endTimeText: '17:30',
    startTimeText: '17:00',
    formatTime: String,
  });

  assert.deepEqual(result, {
    hotelName: 'Harbor Hotel',
    segment: { type: 'checkin', hotelName: 'Harbor Hotel', hotelAddress: 'Main Road', time: '17:45' },
  });
});

test('uses vehicle-only labels and route-end fallback when row times are absent', () => {
  const result = new ItineraryDetailsHotelCheckInService().build({
    hotelInfo: { hotel_name: 'Supplier Hotel', hotel_address: null },
    isVehicleOnly: true,
    location: { destination_location: 'Chennai' },
    route: { next_visiting_location: 'Chennai', route_end_time: '18:00' },
    hotelArrivalTime: null,
    endTimeText: null,
    startTimeText: null,
    formatTime: (value) => `formatted:${value}`,
  });

  assert.equal(result.hotelName, 'Hotel');
  assert.deepEqual(result.segment, {
    type: 'checkin',
    hotelName: 'Hotel',
    hotelAddress: '',
    time: 'formatted:18:00',
  });
});
