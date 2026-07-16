import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineDestinationReservationService } from '../src/modules/itineraries/engines/helpers/timeline-destination-reservation.service';

function createService() {
  const logs: any[] = [];
  const service = new TimelineDestinationReservationService();
  return {
    service,
    logs,
    base: {
      tx: {},
      planId: 7,
      routeIndex: 2,
      route: { itinerary_route_ID: 10, no_of_days: 3 },
      plan: { quote_id: 99 },
      nextRoute: { itinerary_route_ID: 11, location_name: 'Bengaluru', next_visiting_location: 'Chennai' },
      sourceCity: 'Chennai',
      destinationCity: 'Bengaluru',
      currentRouteViaLocationNames: [],
      isEligibleForDestinationReservation: true,
      isIntercityMovementFirstTransfer: false,
      allHotspots: [],
      addedHotspotIds: new Set<number>(),
      selectedHotspots: [
        { hotspot_ID: 1, matched_bucket: 'source', hotspot_location: 'Chennai' },
        { hotspot_ID: 2, matched_bucket: 'destination', hotspot_location: 'Bengaluru' },
      ],
      hotspotMap: new Map<number, any>(),
      minimumReservationCount: 4,
      estimateRouteHotspotCapacity: () => 2,
      isHotspotAlreadyPlanned: () => false,
      fetchSelectedHotspots: async () => [{ hotspot_ID: 3 }, { hotspot_ID: 4 }],
      fetchDay1TopPrioritySourceHotspots: async () => [],
      hotspotLocationMatchesCity: (value: string, city: string) => String(value).toLowerCase().includes(String(city).toLowerCase()),
      logBookingRule: (entry: any) => logs.push(entry),
    },
  };
}

test('reserves destination candidates when the next loopback has capacity', async () => {
  const { service, base, logs } = createService();
  const result = await service.apply(base);

  assert.deepEqual(result.map((hotspot) => hotspot.hotspot_ID), [1]);
  assert.equal(logs.some((entry) => entry.rule === 'DESTINATION_RESERVATION_FEASIBILITY_CHECK'), true);
  assert.equal(logs.some((entry) => entry.rule === 'DESTINATION_HOTSPOTS_RESERVED_FOR_NEXT_LOOPBACK_DAY'), true);
});

test('uses a source fallback when reservation would otherwise remove the current route pool', async () => {
  const { service, base, logs } = createService();
  base.selectedHotspots = [{ hotspot_ID: 2, matched_bucket: 'destination', hotspot_location: 'Bengaluru' }];
  base.fetchDay1TopPrioritySourceHotspots = async () => [{ hotspot_ID: 5, hotspot_location: 'Chennai' }];

  const result = await service.apply(base);

  assert.deepEqual(result.map((hotspot) => hotspot.hotspot_ID), [5]);
  assert.equal(result[0].matched_bucket, 'source_fallback');
  assert.equal(logs.some((entry) => entry.rule === 'DESTINATION_RESERVATION_SOURCE_RESCUE_TO_AVOID_EMPTY_ROUTE'), false);
});

test('preserves the selection when the destination reservation guard is not eligible', async () => {
  const { service, base } = createService();
  base.isEligibleForDestinationReservation = false;

  const result = await service.apply(base);

  assert.deepEqual(result, base.selectedHotspots);
});
