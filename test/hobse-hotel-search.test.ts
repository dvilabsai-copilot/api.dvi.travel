import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelSearchService } from '../src/modules/hotels/services/hotel-search.service';

const epHotel = {
  provider: 'HOBSE',
  hotelCode: 'justa-rameshwaram',
  hotelName: 'juSTa Sarang Rameshwaram',
  cityCode: 'Rameswaram',
  address: 'Rameswaram',
  rating: 4,
  category: '4-Star',
  facilities: [],
  images: [],
  price: 4620,
  currency: 'INR',
  roomTypes: [],
  roomType: 'Deluxe Room',
  mealPlan: 'European Plan',
  searchReference: 'hobse-search-reference',
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
};

function createService(showHobseEpHotels = 1) {
  const calls: any[] = [];
  const prisma = {
    dvi_global_settings: {
      findFirst: async () => ({
        show_ep_hotels: 0,
        show_hobse_ep_hotels: showHobseEpHotels,
        tbo_map_fallback_enabled: 1,
        tbo_map_dinner_rate_3_star: 900,
        tbo_map_dinner_rate_4_star: 1500,
        tbo_map_dinner_rate_5_star: 2500,
      }),
    },
  } as any;
  const provider = (name: string) => ({
    getName: () => name,
    search: async (criteria: any) => {
      calls.push({ name, criteria });
      return name === 'HOBSE' ? [{ ...epHotel }] : [];
    },
  });
  const offline = { searchOfflineHotels: async () => [] } as any;
  const service = new HotelSearchService(
    prisma,
    provider('TBO') as any,
    provider('ResAvenue') as any,
    provider('HOBSE') as any,
    offline,
  );
  return { service, calls };
}

const baseSearch = {
  cityCode: 'Rameswaram',
  checkInDate: '2099-01-01',
  checkOutDate: '2099-01-02',
  roomCount: 1,
  guestCount: 3,
  adultCount: 2,
  childCount: 1,
  guestNationality: 'IN',
};

test('explicit HOBSE hotel-name search bypasses EP hiding when enabled', async () => {
  const { service, calls } = createService(1);
  const results = await service.searchHotels({
    ...baseSearch,
    hotelName: 'juSTa',
    providers: ['hobse'],
  } as any);

  assert.equal(results.length, 1);
  assert.equal(results[0].hotelName, 'juSTa Sarang Rameshwaram');
  assert.equal(results[0].mealPlan, 'European Plan');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].criteria.hotelName, 'juSTa');
});

test('normal HOBSE inventory still hides EP when the global setting is disabled', async () => {
  const { service } = createService(1);
  const results = await service.searchHotels({
    ...baseSearch,
    providers: ['hobse'],
  } as any);

  assert.deepEqual(results, []);
});

test('explicit HOBSE hotel-name search respects the dedicated setting when disabled', async () => {
  const { service } = createService(0);
  const results = await service.searchHotels({
    ...baseSearch,
    hotelName: 'juSTa',
    providers: ['hobse'],
  } as any);

  assert.deepEqual(results, []);
});

test('explicit TBO hotel-name search does not bypass EP hiding', async () => {
  const { service } = createService();
  const results = await service.searchHotels({
    ...baseSearch,
    hotelName: 'juSTa',
    providers: ['tbo'],
  } as any);

  assert.deepEqual(results, []);
});
