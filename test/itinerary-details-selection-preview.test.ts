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

test('selection preview matches per-night supplier references for a multi-night stay', async () => {
  const service = new ItineraryDetailsService(
    {
      dvi_itinerary_plan_details: {
        findFirst: async () => ({ itinerary_quote_ID: 'DVI202607282' }),
      },
    } as any,
    {} as any,
    {
      getActiveRows: async () => [
        {
          itineraryRouteId: 10208,
          groupType: 1,
          provider: 'axisrooms',
          hotelCode: '95',
          hotelName: 'CLOUDS VALLEY',
          bookingCode: 'AX-95-20260812',
          searchReference: 'AX-95-20260812',
          roomType: 'Valley View Double',
          mealPlan: 'Breakfast only',
          totalHotelCost: 3410,
          totalHotelTaxAmount: 0,
          baseHotelCost: 3410,
        },
        {
          itineraryRouteId: 10209,
          groupType: 1,
          provider: 'axisrooms',
          hotelCode: '95',
          hotelName: 'CLOUDS VALLEY',
          bookingCode: 'AX-95-20260813',
          searchReference: 'AX-95-20260813',
          roomType: 'Valley View Double',
          mealPlan: '-',
          totalHotelCost: 3410,
          totalHotelTaxAmount: 0,
          baseHotelCost: 3410,
        },
      ],
      optionKey: (row: any) => `axisrooms|${row.hotelCode}|${row.bookingCode}`,
    } as any,
  );

  const override = await (service as any).buildSelectedHotelCostOverride({
    planId: 10062,
    quoteId: 'DVI202607282',
    selections: {
      10208: {
        routeId: 10208,
        routeIds: [10208, 10209],
        multiNightBooking: true,
        groupType: 1,
        provider: 'axisrooms',
        hotelId: 0,
        hotelCode: '95',
        bookingCode: 'AX-95-20260812',
        searchReference: 'AX-95-20260812',
        roomType: 'Valley View Double',
        hotelName: 'CLOUDS VALLEY',
      },
    },
    groupType: 1,
  });

  assert.equal(override.rows.length, 2);
  assert.deepEqual(override.breakdown.map((row: any) => row.routeId), [10208, 10209]);
});

test('selection preview prefers the selected route date when a rebuilt route has mixed snapshot rows', async () => {
  const service = new ItineraryDetailsService(
    {
      dvi_itinerary_plan_details: {
        findFirst: async () => ({ itinerary_quote_ID: 'DVI202607282' }),
      },
    } as any,
    {} as any,
    {
      getActiveRows: async () => [
        {
          itineraryRouteId: 10215,
          date: '2026-08-12',
          provider: 'tbo',
          hotelCode: '1568925',
          bookingCode: 'OLD-20260812',
          searchReference: 'OLD-20260812',
          roomType: 'Sugar Pine',
          mealPlan: 'EP',
          totalHotelCost: 10000,
          baseHotelCost: 10000,
        },
        {
          itineraryRouteId: 10215,
          date: '2026-08-13',
          provider: 'tbo',
          hotelCode: '1568925',
          bookingCode: 'CURRENT-20260813',
          searchReference: 'CURRENT-20260813',
          roomType: 'Sugar Pine',
          mealPlan: 'EP',
          totalHotelCost: 11000,
          baseHotelCost: 11000,
        },
      ],
      optionKey: (row: any) => `tbo|${row.hotelCode}|${row.bookingCode}`,
    } as any,
  );

  const override = await (service as any).buildSelectedHotelCostOverride({
    planId: 10062,
    quoteId: 'DVI202607282',
    selections: {
      10215: {
        routeId: 10215,
        provider: 'tbo',
        hotelCode: '1568925',
        bookingCode: 'CURRENT-20260813',
        searchReference: 'CURRENT-20260813',
        roomType: 'Sugar Pine',
        mealPlan: 'EP',
        checkInDate: '2026-08-13',
      },
    },
  });

  assert.equal(override.breakdown[0].routeId, 10215);
  assert.equal(override.breakdown[0].date, '2026-08-13');
  assert.equal(override.breakdown[0].totalAmount, 11000);
});
