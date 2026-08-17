import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getNormalizedMealPlanLabelFromMealText,
  inferCanonicalHotelRatePlanCode,
} from '../src/modules/hotels/hotel-rate-plans';
import { ResAvenueHotelProvider } from '../src/modules/hotels/providers/resavenue-hotel.provider';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';

test('canonicalizes ResAvenue descriptive OTA rate-plan names', () => {
  assert.equal(inferCanonicalHotelRatePlanCode('Double Deluxe Room - OTA EP Plan'), 'EP');
  assert.equal(inferCanonicalHotelRatePlanCode('Double Deluxe Room - OTA CP Plan'), 'CP');
  assert.equal(inferCanonicalHotelRatePlanCode('Family Room - OTA MAP_PLAN'), 'MAP');
  assert.equal(inferCanonicalHotelRatePlanCode('Family Room - OTA APPLAN'), 'AP');
  assert.equal(getNormalizedMealPlanLabelFromMealText('Double Deluxe Room - OTA EP Plan'), 'EP');
  assert.equal(inferCanonicalHotelRatePlanCode('AP Residency Suite'), null);
});

test('ResAvenue search preserves the cheapest rate plan and every room-level plan', async () => {
  const provider = new ResAvenueHotelProvider({} as any);
  const internal = provider as any;

  internal.getPropertyDetails = async () => ({
    RoomTypes: [{
      room_id: 66,
      room_name: 'Vinayaga Premium',
      max_occupancy: 3,
      room_status: 'active',
      RatePlans: [
        { rate_id: 137, rate_name: 'Double Deluxe Room - OTA EP Plan', rate_status: 'active' },
        { rate_id: 16101, rate_name: 'Double Deluxe Room - OTA CP Plan', rate_status: 'active' },
      ],
    }],
  });
  internal.getInventory = async () => [{
    InvCode: 66,
    Inventory: [{
      Date: '2026-08-17',
      InvCount: 5,
      StopSell: false,
      CloseOnArrival: false,
      CloseOnDeparture: false,
    }],
  }];
  internal.getRates = async () => [
    {
      RateCode: 137,
      Rate: [{ Date: '2026-08-17', Single: 1800, Double: 2000, ExtraPax: 0, ExtraChild: 0, MinStay: 1, MaxStay: 10, StopSell: false }],
    },
    {
      RateCode: 16101,
      Rate: [{ Date: '2026-08-17', Single: 2200, Double: 2400, ExtraPax: 0, ExtraChild: 0, MinStay: 1, MaxStay: 10, StopSell: false }],
    },
  ];

  const result = await internal.searchHotel(
    {
      resavenue_hotel_code: '22',
      hotel_name: 'Vinayaga Inn by Poppys Ooty',
      hotel_city: 'Ooty',
      hotel_address: '',
      hotel_category: 2,
    },
    {
      cityCode: 'Ooty',
      checkInDate: '2026-08-17',
      checkOutDate: '2026-08-18',
      roomCount: 1,
      guestCount: 2,
    },
  );

  assert.ok(result);
  assert.equal(result.mealPlan, 'EP');
  assert.deepEqual(result.roomTypes.map((room: any) => room.mealPlan), ['EP', 'CP']);
  assert.equal(result.roomTypes[0].price, 2000);
  assert.equal(result.roomTypes[1].price, 2400);
});

test('itinerary meal preference promotes the matching ResAvenue room and rejects a MAP mismatch', async () => {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  service.logger = { log() {}, warn() {}, debug() {} };
  const hotel = {
    provider: 'resavenue',
    hotelCode: '22',
    hotelName: 'Vinayaga Inn by Poppys Ooty',
    rating: 2,
    price: 2000,
    mealPlan: 'EP',
    roomType: 'Vinayaga Premium - Double Deluxe Room - OTA EP Plan',
    roomTypes: [
      {
        roomCode: '66-137',
        roomName: 'Vinayaga Premium - Double Deluxe Room - OTA EP Plan',
        mealPlan: 'EP',
        price: 2000,
      },
      {
        roomCode: '66-16101',
        roomName: 'Vinayaga Premium - Double Deluxe Room - OTA CP Plan',
        mealPlan: 'CP',
        price: 2400,
      },
    ],
  };

  const cpFiltered = await service.applyPlanPreferenceFilters(
    new Map([[10293, [hotel]]]),
    [],
    'CP',
    [],
  );
  assert.equal(cpFiltered.get(10293).length, 1);
  assert.equal(cpFiltered.get(10293)[0].mealPlan, 'CP');
  assert.equal(cpFiltered.get(10293)[0].price, 2400);

  const mapFiltered = await service.applyPlanPreferenceFilters(
    new Map([[10293, [hotel]]]),
    [],
    'MAP',
    [],
  );
  assert.deepEqual(mapFiltered.get(10293), []);
});
