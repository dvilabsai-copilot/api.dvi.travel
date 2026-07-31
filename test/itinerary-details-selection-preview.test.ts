import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsService } from '../src/modules/itineraries/itinerary-details.service';

test('selection preview matches TBO rates when hotelId is zero and provider hotel code is supplied', async () => {
  const service = new ItineraryDetailsService(
    {
      dvi_itinerary_plan_details: {
        findFirst: async () => ({ itinerary_quote_ID: 'DVI202607282' }),
      },
    } as any,
    {} as any,
    {
      getActiveRows: async () => [{
        itineraryRouteId: 10208,
        groupType: 2,
        provider: 'tbo',
        hotelCode: '1130400',
        hotelId: 0,
        bookingCode: 'BOOKING-1130400',
        searchReference: 'SEARCH-1130400',
        roomType: 'Valley View Room',
        mealPlan: 'CP',
        totalHotelCost: 1000,
        totalHotelTaxAmount: 0,
        baseHotelCost: 1000,
        hotelMarginAmount: 0,
      }],
      optionKey: (row: any) => `tbo|${row.hotelCode}|${row.bookingCode}`,
    } as any,
  );

  const override = await (service as any).buildSelectedHotelCostOverride({
    planId: 10062,
    quoteId: 'DVI202607282',
    selections: {
      10208: {
        routeId: 10208,
        groupType: 2,
        provider: 'tbo',
        hotelId: 0,
        providerHotelCode: '1130400',
        bookingCode: 'BOOKING-1130400',
        searchReference: 'SEARCH-1130400',
        roomType: 'Valley View Room',
        mealPlan: 'CP',
      },
    },
    groupType: 2,
  });

  assert.equal(override.rows.length, 1);
  assert.equal(override.breakdown[0].hotelCode, '1130400');
  assert.equal(override.breakdown[0].totalAmount, 1000);
});
