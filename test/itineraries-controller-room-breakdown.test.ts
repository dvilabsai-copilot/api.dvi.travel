import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerariesController } from '../src/modules/itineraries/itineraries.controller';

test('compact itinerary hotel responses preserve VSR room-night breakdown for rate selection', () => {
  const controller = Object.create(ItinerariesController.prototype) as any;
  const breakdown = [{
    date: '2026-11-20',
    roomNumber: 1,
    adults: 2,
    children: 0,
    childrenAges: [],
    baseAmount: 100,
    fareAdjustment: 5,
    allInAmount: 105,
    nightTotal: 210,
  }];
  const response = controller.buildCompactHotelAvailabilityResponse({
    response: {
      hotels: [],
      hotelAvailability: {
        sharedHotelInventory: [{
          provider: 'tbo',
          providerDisplayName: 'VSR',
          itineraryRouteId: 11,
          groupType: 1,
          hotelCode: 'H-1',
          hotelName: 'Example VSR Hotel',
          rateOptions: [{
            provider: 'tbo',
            rateOptionId: 'rate-1',
            totalPrice: 210,
            tboRoomNightBreakdown: breakdown,
            supplierRawResponse: { internal: true },
          }],
        }],
        authoritativeRecommendationRows: [],
      },
      hotelTabs: [],
      hotelSelectionState: [],
    },
  }, {});

  const rateOption = response.hotelDetails.hotelAvailability.sharedHotelInventory[0].rateOptions[0];
  assert.deepEqual(rateOption.tboRoomNightBreakdown, breakdown);
  assert.equal(Object.prototype.hasOwnProperty.call(rateOption, 'supplierRawResponse'), false);
});

test('compact itinerary hotel responses do not expose VSR breakdowns on other providers', () => {
  const controller = Object.create(ItinerariesController.prototype) as any;
  const response = controller.buildCompactHotelAvailabilityResponse({
    response: {
      hotels: [],
      hotelAvailability: {
        sharedHotelInventory: [{
          provider: 'axisrooms',
          itineraryRouteId: 11,
          groupType: 1,
          hotelCode: 'AX-1',
          hotelName: 'Example Axis Hotel',
          rateOptions: [{
            provider: 'axisrooms',
            rateOptionId: 'axis-rate-1',
            tboRoomNightBreakdown: [{ date: '2026-11-20', roomNumber: 1, allInAmount: 100 }],
          }],
        }],
        authoritativeRecommendationRows: [],
      },
      hotelTabs: [],
      hotelSelectionState: [],
    },
  }, {});

  const rateOption = response.hotelDetails.hotelAvailability.sharedHotelInventory[0].rateOptions[0];
  assert.equal(Object.prototype.hasOwnProperty.call(rateOption, 'tboRoomNightBreakdown'), false);
});
