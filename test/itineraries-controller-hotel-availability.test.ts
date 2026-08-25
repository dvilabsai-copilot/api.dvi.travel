import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerariesController } from '../src/modules/itineraries/itineraries.controller';

test('compact reset response preserves complete per-day hotel inventory for the editor', () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  const result = (controller as any).buildCompactHotelAvailabilityResponse(
    {
      response: {
        hotels: [{
          itineraryRouteId: 11046,
          date: '2026-09-01',
          hotelName: 'MAMALLA HERITAGE',
          hotelCheckInDate: '2026-08-31',
          hotelCheckOutDate: '2026-09-02',
          actualGuestArrivalAt: '2026-09-01T06:00:00.000Z',
          earlyCheckIn: true,
          earlyCheckInExtraPaymentApplicable: true,
          previousDayBillingSynthetic: false,
          rateOptions: [{ id: 'selected-rate' }],
        }],
        hotelTabs: [],
        hotelSelectionState: [],
        hotelAvailability: {
          hasSupplierHotels: true,
          sharedHotelInventory: [
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'MAMALLA HERITAGE', rateOptions: [{ id: 'a' }] },
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'Grand Continent Hotels', rateOptions: [{ id: 'b' }] },
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'MGM Beach Resorts', rateOptions: [{ id: 'c' }] },
            { itineraryRouteId: 11046, date: '2026-09-01', hotelName: 'Radisson Blu Resort Temple Bay', rateOptions: [{ id: 'd' }] },
          ],
        },
      },
      changeSummary: null,
    },
    { overallCost: '0', costBreakdown: {} },
  );

  const inventory = result.hotelDetails.hotelAvailability.sharedHotelInventory;
  assert.equal(inventory.length, 4);
  assert.deepEqual(
    inventory.map((hotel: any) => hotel.hotelName),
    [
      'MAMALLA HERITAGE',
      'Grand Continent Hotels',
      'MGM Beach Resorts',
      'Radisson Blu Resort Temple Bay',
    ],
  );
  assert.equal((inventory[0] as any).rateOptions, undefined);
  assert.equal(result.hotelDetails.hotels[0].rateOptions, undefined);
  assert.equal(result.hotelDetails.hotels[0].hotelCheckInDate, '2026-08-31');
  assert.equal(result.hotelDetails.hotels[0].hotelCheckOutDate, '2026-09-02');
  assert.equal(result.hotelDetails.hotels[0].actualGuestArrivalAt, '2026-09-01T06:00:00.000Z');
  assert.equal(result.hotelDetails.hotels[0].earlyCheckIn, true);
  assert.equal(result.hotelDetails.hotels[0].earlyCheckInExtraPaymentApplicable, true);
  assert.equal(result.hotelDetails.hotels[0].previousDayBillingSynthetic, false);
});
