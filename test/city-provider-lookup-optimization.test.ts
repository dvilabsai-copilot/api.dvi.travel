import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';
import { HobseHotelProvider } from '../src/modules/hotels/providers/hobse-hotel.provider';
import {
  clearCityLookupCache,
  resolveCityRecordByName,
  resolveCityNameById,
} from '../src/modules/itineraries/utils/city-normalization.util';

function itineraryServiceWithCityRows(rows: Array<{ id: number; name: string }>) {
  const queries: any[] = [];
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  service.prisma = {
    dvi_cities: {
      findMany: async (args: any) => {
        queries.push(args);
        return rows;
      },
    },
  };
  service.logger = { log() {}, warn() {} };
  service.hobseCityCodeCache = new Map();
  service.hobseCityCodeCacheTtlMs = 30 * 60 * 1000;
  return { service, queries };
}

test('provider city candidates query only requested name prefixes', async () => {
  const { service, queries } = itineraryServiceWithCityRows([
    { id: 10, name: 'Kochi' },
    { id: 11, name: 'Kochi, Kerala' },
    { id: 12, name: 'Munnar' },
  ]);

  const result = await service.loadProviderCityCandidates(['Cochin']);

  assert.equal(queries.length, 1);
  assert.ok(Array.isArray(queries[0].where.OR));
  assert.ok(queries[0].where.OR.length > 0);
  assert.deepEqual(result.get('Cochin'), ['Cochin', 'kochi', 'Kochi', '10', 'Kochi, Kerala', '11']);
});

test('provider city candidates avoid any city query for empty destinations', async () => {
  const { service, queries } = itineraryServiceWithCityRows([]);

  const result = await service.loadProviderCityCandidates(['']);

  assert.equal(queries.length, 0);
  assert.equal(result.size, 0);
});

test('HOBSE city lookup uses the indexed HOBSE code before other identity fields', async () => {
  const queries: any[] = [];
  const provider = new HobseHotelProvider({
    dvi_cities: {
      findFirst: async (args: any) => {
        queries.push(args);
        return args.where.hobse_city_code ? { name: 'Kochi', hobse_city_code: '320' } : null;
      },
    },
  } as any);
  (provider as any).fileLog = () => {};
  (provider as any).postForm = async () => ({ hobse: { response: { data: [] } } });

  await provider.search({ cityCode: '320', checkInDate: '2026-10-01', checkOutDate: '2026-10-02' } as any);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].where, { hobse_city_code: '320' });
});

test('HOBSE hotel-name search filters the catalog before tariff lookups', async () => {
  const tariffHotelIds: string[] = [];
  const provider = new HobseHotelProvider({
    dvi_cities: {
      findFirst: async () => ({ name: 'Kochi', hobse_city_code: '320' }),
    },
  } as any);
  (provider as any).fileLog = () => {};
  (provider as any).postForm = async (method: string) => {
    assert.equal(method, 'GetHotelList');
    return {
      hobse: {
        response: {
          data: [
            { hotelId: '1', hotelName: 'Alpha Residency', cityName: 'Kochi' },
            { hotelId: '2', hotelName: 'Beta Palace', cityName: 'Kochi' },
          ],
        },
      },
    };
  };
  (provider as any).getHotelTariffAsSearchResult = async (args: { hotelId: string }) => {
    tariffHotelIds.push(args.hotelId);
    return null;
  };

  await provider.search({
    cityCode: '320',
    checkInDate: '2026-10-01',
    checkOutDate: '2026-10-02',
    roomCount: 1,
    guestCount: 2,
    hotelName: 'Alpha',
  } as any);

  assert.deepEqual(tariffHotelIds, ['1']);
});

test('HOBSE itinerary city mapping caches mapped and unmapped destinations', async () => {
  const queries: any[] = [];
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  service.prisma = {
    dvi_cities: {
      findMany: async (args: any) => {
        queries.push(args);
        return [{ name: 'Kochi', hobse_city_code: '320' }];
      },
    },
  };
  service.logger = { log() {}, warn() {} };
  service.hobseCityCodeCache = new Map();
  service.hobseCityCodeCacheTtlMs = 30 * 60 * 1000;

  const routes = [{ next_visiting_location: 'Kochi' }];
  assert.deepEqual(await service.batchMapDestinationsToHobseCityCodes(routes), { Kochi: '320' });
  assert.deepEqual(await service.batchMapDestinationsToHobseCityCodes(routes), { Kochi: '320' });

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].where.AND[0], { hobse_city_code: { not: null } });
});

test('shared city normalization uses lazy indexed lookups instead of warming all cities', async () => {
  clearCityLookupCache();
  const nameQueries: any[] = [];
  const prisma = {
    dvi_cities: {
      findMany: async (args: any) => {
        nameQueries.push(args);
        return [{
          id: 10,
          name: 'Kochi',
          state_id: 1,
          tbo_city_code: '1135152',
          hobse_city_code: '320',
        }];
      },
      findFirst: async () => null,
    },
  };

  const first = await resolveCityRecordByName(prisma, 'Cochin');
  const second = await resolveCityRecordByName(prisma, 'Cochin');

  assert.equal(first?.name, 'Kochi');
  assert.equal(second?.name, 'Kochi');
  assert.equal(nameQueries.length, 1);
  assert.ok(Array.isArray(nameQueries[0].where.AND[2].OR));

  clearCityLookupCache();
  const idQueries: any[] = [];
  const idPrisma = {
    dvi_cities: {
      findFirst: async (args: any) => {
        idQueries.push(args);
        return { id: 10, name: 'Kochi', state_id: 1, tbo_city_code: '1135152', hobse_city_code: '320' };
      },
      findMany: async () => [],
    },
  };

  assert.equal(await resolveCityNameById(idPrisma, 10), 'Kochi');
  assert.equal(idQueries.length, 1);
  assert.equal(idQueries[0].where.id, 10);
});
