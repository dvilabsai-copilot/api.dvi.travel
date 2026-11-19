import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Availability and selection-intent resolution use persisted search snapshots.
// The controller and booking validation should go through the workflow API.
const snapshotConsumers = [
  'src/modules/itineraries/services/hotel-stay-block-validation.service.ts',
  'src/modules/itineraries/services/itinerary-selection-workflow.service.ts',
  'src/modules/itineraries/itineraries.controller.ts',
];

test('hotel selection persistence and booking validation do not access the search snapshot table directly', () => {
  for (const file of snapshotConsumers) {
    const source = readFileSync(resolve(file), 'utf8');
    assert.equal(
      source.includes('dvi_itinerary_hotel_search_cache'),
      false,
      `${file} must access availability through the hotel workflow`,
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
