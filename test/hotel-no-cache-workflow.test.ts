import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const itinerarySources = [
  'src/modules/itineraries/services/hotel-availability-snapshot.service.ts',
  'src/modules/itineraries/services/hotel-stay-block-validation.service.ts',
  'src/modules/itineraries/services/itinerary-selection-workflow.service.ts',
  'src/modules/itineraries/itineraries.service.ts',
  'src/modules/itineraries/itineraries.controller.ts',
];

test('active itinerary hotel workflow has no search-cache table dependency', () => {
  for (const file of itinerarySources) {
    const source = readFileSync(resolve(file), 'utf8');
    assert.equal(
      source.includes('dvi_itinerary_hotel_search_cache'),
      false,
      `${file} must not read or write the legacy hotel search cache`,
    );
  }
});

test('supplier result cache adapters are disabled', () => {
  const source = readFileSync(
    resolve('src/modules/itineraries/itinerary-hotel-details-tbo.service.ts'),
    'utf8',
  );
  assert.match(source, /getCachedHotelDetails[\s\S]*?return null;/);
  assert.match(source, /getCachedRoomDetails[\s\S]*?return null;/);
  assert.match(source, /getCacheStats[\s\S]*?size:\s*0/);
});
