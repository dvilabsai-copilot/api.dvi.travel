import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineCandidateFeasibilityService } from '../src/modules/itineraries/engines/helpers/timeline-candidate-feasibility.service';

const distanceHelper = {
  fromSourceAndDestination: async () => ({ travelTime: '00:30:00', bufferTime: '00:10:00' }),
} as any;
const service = new TimelineCandidateFeasibilityService(distanceHelper);

function openTimingMap() {
  return new Map([[41, new Map([[2, [{ hotspot_start_time: '09:00:00', hotspot_end_time: '18:00:00' }]]])]]);
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    tx: {} as any,
    route: { next_visiting_location: 'Coorg' },
    isLastRoute: false,
    routeStartSeconds: 8 * 3600,
    routeEndSeconds: 18 * 3600,
    currentTime: '09:00:00',
    currentLocationName: 'Mysuru',
    currentCoords: { lat: 1, lon: 1 },
    destinationCoords: { lat: 2, lon: 2 },
    dayOfWeek: 2,
    hotspotId: 41,
    hotspotLocationName: 'Mysuru',
    hotspotDuration: '01:00:00',
    hotspotCoords: { lat: 1, lon: 1 },
    timingMap: openTimingMap(),
    plan: { departure_location: 'Coorg' },
    destinationCity: 'Coorg',
    lastRouteArrivalDeadlineSeconds: 20 * 3600,
    allowWaitUntilOpen: true,
    rejectIfOutsideOperatingWindow: true,
    ...overrides,
  };
}

test('admits a candidate inside the operating and route windows', async () => {
  const result = await service.evaluateCandidateInsertion(candidate() as any);
  assert.equal(result.feasible, true);
  assert.equal(result.startSeconds, 9.5 * 3600);
  assert.equal(result.endSeconds, 10.5 * 3600);
  assert.equal(result.travelTimeToHotspot, '00:30:00');
});

test('returns the original operating-window rejection reasons', async () => {
  const result = await service.evaluateCandidateInsertion(candidate({
    timingMap: new Map(),
  }) as any);
  assert.deepEqual(result, { feasible: false, reason: 'closed_for_day_at_visit_time' });
});

test('protects the next fixed anchor and reports missing anchor metadata', async () => {
  const result = await service.evaluateAnchorGapInsertion(
    {} as any,
    [{ itinerary_route_ID: 4, item_type: 4, hotspot_ID: 55, hotspot_start_time: '11:00:00', hotspot_end_time: '12:00:00' } as any],
    new Map(),
    4,
    8 * 3600,
    18 * 3600,
    '09:00:00',
    'Mysuru',
    { lat: 1, lon: 1 },
    10 * 3600,
  );
  assert.deepEqual(result, {
    feasible: false,
    reason: 'next_anchor_hotspot_metadata_missing',
    nextAnchorHotspotId: 55,
    nextAnchorStartSeconds: 11 * 3600,
  });
});
