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
  assert.deepEqual((inventory[0] as any).rateOptions, [{ id: 'a' }]);
  assert.deepEqual(result.hotelDetails.hotels[0].rateOptions, [{ id: 'selected-rate' }]);
  assert.equal(result.hotelDetails.hotels[0].hotelCheckInDate, '2026-08-31');
  assert.equal(result.hotelDetails.hotels[0].hotelCheckOutDate, '2026-09-02');
  assert.equal(result.hotelDetails.hotels[0].actualGuestArrivalAt, '2026-09-01T06:00:00.000Z');
  assert.equal(result.hotelDetails.hotels[0].earlyCheckIn, true);
  assert.equal(result.hotelDetails.hotels[0].earlyCheckInExtraPaymentApplicable, true);
  assert.equal(result.hotelDetails.hotels[0].previousDayBillingSynthetic, false);
});

test('reset endpoint returns financial summary without hotel details', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  let resetQuoteId = '';
  (controller as any).hotelAvailabilitySnapshotService = {
    resetSelectionsOnly: async (quoteId: string) => {
      resetQuoteId = quoteId;
    },
  };
  (controller as any).detailsService = {
    getItineraryDetails: async () => ({
      overallCost: 29200,
      costBreakdown: { hotel: 11766 },
    }),
  };

  const response = await controller.resetItineraryHotelAvailability(
    'DVI-RESET',
    { user: { userId: 7, role: 1 } },
  );

  assert.equal(resetQuoteId, 'DVI-RESET');
  assert.deepEqual(response, {
    financialSummary: {
      overallCost: 29200,
      costBreakdown: { hotel: 11766 },
    },
  });
  assert.equal('hotelDetails' in response, false);
});

test('acknowledgement returns accepted selections and financial totals without another supplier search', async () => {
  const controller = Object.create(ItinerariesController.prototype) as ItinerariesController;
  let acceptedIds: number[] = [];
  (controller as any).hotelAvailabilitySnapshotService = {
    applyAcceptedSelectionChanges: async (_quoteId: string, selectionIds: number[]) => {
      acceptedIds = selectionIds;
      return { appliedCount: selectionIds.length, selectionIds };
    },
    readPersisted: async () => ({
      hotels: [{ hotelName: 'Accepted replacement' }],
      hotelTabs: [{ groupType: 1, totalAmount: 125 }],
      hotelSelectionState: [],
    }),
  };
  (controller as any).hotelDetailsService = {
    getHotelDetailsByQuoteId: async () => { throw new Error('fallback should not be needed'); },
  };
  (controller as any).detailsService = {
    getItineraryDetails: async () => ({ overallCost: 725, costBreakdown: { hotel: 125 } }),
  };

  const response = await controller.acknowledgeItineraryHotelAvailabilityChanges(
    'DVI-ACK',
    { selectionIds: [10, 11] },
    { user: { userId: 7, role: 1 } },
  );

  assert.deepEqual(acceptedIds, [10, 11]);
  assert.equal(response.appliedCount, 2);
  assert.equal(response.hotelDetails.hotels[0].hotelName, 'Accepted replacement');
  assert.equal(response.financialSummary.overallCost, 725);
});
