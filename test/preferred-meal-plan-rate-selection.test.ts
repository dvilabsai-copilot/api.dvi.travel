import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';

test('selects the cheapest matching meal-plan rate option', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const hotel = {
    provider: 'tbo',
    hotelCode: '1089829',
    hotelName: 'Test Hotel',
    mealPlan: 'EP',
    price: 1000,
    rateOptions: [
      {
        rateOptionId: 'cp-expensive',
        mealPlan: 'CP',
        price: 1800,
        pricePerNight: 1800,
        totalStayPrice: 3600,
      },
      {
        rateOptionId: 'ep-cheap',
        mealPlan: 'EP',
        price: 900,
        pricePerNight: 900,
        totalStayPrice: 1800,
      },
      {
        rateOptionId: 'cp-cheap',
        mealPlan: 'CP',
        price: 1200,
        pricePerNight: 1200,
        totalStayPrice: 2400,
      },
    ],
  };

  const selected = service.alignHotelToPreferredMealPlan(hotel, 'CP');

  assert.equal(selected.rateOptionId, 'cp-cheap');
  assert.equal(selected.mealPlan, 'CP');
  assert.equal(selected.price, 1200);
  assert.equal(selected.rateOptions[0].rateOptionId, 'cp-cheap');
});

test('preserves the current hotel when no matching meal-plan rate exists', () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  const hotel = {
    provider: 'resavenue',
    hotelCode: '22',
    mealPlan: 'EP',
    rateOptions: [{ rateOptionId: 'ep-only', mealPlan: 'EP', pricePerNight: 1000 }],
  };

  assert.strictEqual(service.alignHotelToPreferredMealPlan(hotel, 'CP'), hotel);
});
