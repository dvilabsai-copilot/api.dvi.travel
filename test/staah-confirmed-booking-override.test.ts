import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaahConfirmedBookingOverrideService } from '../src/modules/itineraries/services/staah-confirmed-booking-override.service';

test('overrides the matching route with confirmed STAAH reservation fields', () => {
  const rows: any[] = [{ itineraryRouteId: 7, hotelName: 'Search Hotel', date: '2026-07-20', hotelId: 1 }];
  new StaahConfirmedBookingOverrideService().apply(
    rows,
    new Map([[7, {
      api_response: {
        confirm: {
          request: {
            reservations: {
              reservation: [{
                propertyname: 'Booked Hotel',
                room: [{ room_name: 'Suite', price: [{ rate_name: 'Breakfast' }] }],
                totaltax: 12,
              }],
            },
          },
        },
      },
      staah_hotel_code: '99',
      booking_code: 'STAAH-99-R1-RT1-20260720',
      net_amount: 450,
      number_of_rooms: 1,
      total_guests: 2,
      check_in_date: '2026-07-20',
      check_out_date: '2026-07-22',
    }]]),
    'Q1',
    10,
    { parseSearchReference: () => ({ propertyId: '99', roomId: 'R1', rateId: 'RT1' }) },
  );

  assert.equal(rows[0].provider, 'staah');
  assert.equal(rows[0].hotelName, 'Booked Hotel');
  assert.equal(rows[0].totalHotelCost, 450);
  assert.equal(rows[0].totalHotelTaxAmount, 12);
  assert.equal(rows[0].roomId, 'R1');
  assert.equal(rows[0].isConfirmedBooking, true);
});

test('leaves unmatched rows unchanged', () => {
  const rows: any[] = [{ itineraryRouteId: 8, hotelName: 'Search Hotel' }];
  new StaahConfirmedBookingOverrideService().apply(rows, new Map(), 'Q1', 10, {
    parseSearchReference: () => null,
  });
  assert.deepEqual(rows, [{ itineraryRouteId: 8, hotelName: 'Search Hotel' }]);
});
