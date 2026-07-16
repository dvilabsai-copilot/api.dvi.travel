import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelCityCodeService } from '../src/modules/itineraries/services/itinerary-hotel-city-code.service';

test('maps aliases and destination prefixes using one city-loader call', async () => {
  const service = new ItineraryHotelCityCodeService();
  let loadCount = 0;

  const result = await service.map(
    [
      { next_visiting_location: 'Cochin, Kerala' },
      { next_visiting_location: 'Bengaluru (City)' },
      { next_visiting_location: 'Unknown' },
    ],
    {
      loadCities: async () => {
        loadCount += 1;
        return [
          { name: 'Kochi', tbo_city_code: 'COK' },
          { name: 'Bengaluru', tbo_city_code: 'BLR' },
          { name: 'Jaipur, Rajasthan', tbo_city_code: 'JAI' },
        ];
      },
    },
  );

  assert.equal(loadCount, 1);
  assert.deepEqual(result, {
    'Cochin, Kerala': 'COK',
    'Bengaluru (City)': 'BLR',
  });
});

test('preserves first city code for duplicate names and skips empty destinations', async () => {
  const service = new ItineraryHotelCityCodeService();
  const warnings: string[] = [];

  const result = await service.map(
    [{ next_visiting_location: 'Jaipur, Rajasthan' }, { next_visiting_location: '' }, {}],
    {
      loadCities: async () => [
        { name: 'Jaipur', tbo_city_code: 'JAI-1' },
        { name: 'Jaipur', tbo_city_code: 'JAI-2' },
      ],
      warn: (message) => warnings.push(message),
    },
  );

  assert.deepEqual(result, { 'Jaipur, Rajasthan': 'JAI-1' });
  assert.deepEqual(warnings, []);
});

test('maps HOBSE codes by exact destination and comma-qualified prefix', async () => {
  const service = new ItineraryHotelCityCodeService();

  const result = await service.mapHobse(
    [
      { next_visiting_location: 'Kochi' },
      { next_visiting_location: 'Jaipur, Rajasthan' },
    ],
    {
      loadCities: async () => [
        { name: 'Kochi', hobse_city_code: 'H-COK' },
        { name: 'Jaipur', hobse_city_code: 'H-JAI' },
      ],
    },
  );

  assert.deepEqual(result, {
    Kochi: 'H-COK',
    'Jaipur, Rajasthan': 'H-JAI',
  });
});
