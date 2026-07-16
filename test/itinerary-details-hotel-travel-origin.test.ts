import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsHotelTravelOriginService } from '../src/modules/itineraries/services/itinerary-details-hotel-travel-origin.service';

test('uses the latest completed attraction as the travel-to-hotel origin', () => {
  const result = new ItineraryDetailsHotelTravelOriginService().resolve({
    hotelInfo: { hotel_name: 'Beach Hotel' },
    isVehicleOnly: false,
    location: { source_location: 'Chennai', destination_location: 'Mahabalipuram' },
    route: { location_name: 'Chennai', next_visiting_location: 'Mahabalipuram' },
    plan: { arrival_location: 'Airport' },
    previousDayHotelName: null,
    routeHotspots: [
      { item_type: 4, hotspot_ID: 1, hotspot_end_time: '10:00' },
      { item_type: 4, hotspot_ID: 2, hotspot_end_time: '12:30' },
      { item_type: 4, hotspot_ID: 3, hotspot_end_time: '15:00' },
    ],
    hotspotMap: new Map([
      [1, { hotspot_name: 'Fort' }],
      [2, { hotspot_name: 'Museum' }],
      [3, { hotspot_name: 'Temple' }],
    ]),
    startTimeText: '13:00',
    formatTime: String,
    timeToMinutes: (value) => {
      const [hours, minutes] = String(value ?? '0:0').split(':').map(Number);
      return hours * 60 + minutes;
    },
  });

  assert.deepEqual(result, { fromName: 'Museum', toName: 'Beach Hotel', shouldSuppress: false });
});

test('suppresses unresolved same-city fallback hotel travel', () => {
  const result = new ItineraryDetailsHotelTravelOriginService().resolve({
    hotelInfo: {},
    isVehicleOnly: false,
    location: { source_location: 'Goa', destination_location: 'Goa' },
    route: { location_name: 'Goa', next_visiting_location: 'Goa' },
    plan: { arrival_location: 'Goa' },
    previousDayHotelName: null,
    routeHotspots: [],
    hotspotMap: new Map(),
    startTimeText: null,
    formatTime: String,
    timeToMinutes: () => 0,
  });

  assert.equal(result.fromName, 'Goa');
  assert.equal(result.toName, 'Goa');
  assert.equal(result.shouldSuppress, true);
});
