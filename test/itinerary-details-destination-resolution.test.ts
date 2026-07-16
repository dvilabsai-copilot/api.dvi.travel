import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsDestinationResolutionService } from '../src/modules/itineraries/services/itinerary-details-destination-resolution.service';

const context = {
  hotspotMap: new Map([[4, { hotspot_name: 'Museum' }]]),
  hotspotNameToIdMap: new Map([['museum', 4]]),
  route: { next_visiting_location: 'Hotel' },
  location: { destination_location: 'City' },
  plan: { departure_location: 'Airport' },
  normalizeLookupName: (value?: string | null) => String(value ?? '').trim().toLowerCase(),
  isForcedManualConflictAttractionRow: () => false,
  getRouteHotelName: () => 'Stay Hotel',
};

test('finds the next attraction while resolving Hotel to the route hotel', () => {
  const service = new ItineraryDetailsDestinationResolutionService();
  assert.equal(service.findNextSemanticDestinationName([
    { item_type: 3, hotspot_ID: 0 },
    { item_type: 4, hotspot_ID: 4 },
  ], 0, context), 'Museum');
  assert.equal(service.findNextSemanticDestinationName([{ item_type: 2 }], -1, context), 'Stay Hotel');
});

test('maps exact and normalized labels back to hotspot IDs', () => {
  const service = new ItineraryDetailsDestinationResolutionService();
  assert.equal(service.inferHotspotIdFromLabel('Museum', context), 4);
  assert.equal(service.inferHotspotIdFromLabel('unknown', context), null);
});
