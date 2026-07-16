import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitValidationService } from '../src/modules/itineraries/services/itinerary-manual-fit-validation.service';

function createService(distance: (from: number, to: number) => number = () => 0): ItineraryManualFitValidationService {
  const service = new ItineraryManualFitValidationService();
  service.setCallbacks({
    distanceBetweenHotspots: (_map: Map<number, any>, from: number, to: number) => distance(from, to),
    evaluateTimelineRowAgainstOperatingHours: (row: any) => ({
      valid: row?.closed !== true,
      reason: row?.closed === true ? 'Closed at attempted visit time.' : null,
      attemptedVisitTime: row?.timeRange || null,
      operatingHours: row?.timings || null,
    }),
    calculateRouteEndOverflowMinutes: (_timeline: any[], _route: any, endTime: string) => endTime === '18:00' ? 0 : 15,
  });
  return service;
}

test('resolves explicit manual priority before the default policy', () => {
  const service = createService();

  assert.equal(service.resolveSelectedManualPriority({ selectedHotspotId: 10 }), 4);
  assert.equal(service.resolveSelectedManualPriority({ selectedHotspotId: 10, options: { manualPriority: 2 } }), 2);
});

test('selects the lowest-detour feasible slot and preserves slot reasons', () => {
  const service = createService((from, to) => Math.abs(from - to));
  const insights = service.buildManualSlotInsights([
    {
      success: true,
      candidateIndex: 0,
      fullTimeline: [{ item_type: 4, hotspot_ID: 99, timeRange: '09:00 AM - 10:00 AM' }],
    },
    {
      success: false,
      candidateIndex: 1,
      reason: 'Timing conflict',
      fullTimeline: [{ item_type: 4, hotspot_ID: 99, isConflict: true, conflictReason: 'Too late' }],
    },
  ], [99], [
    { item_type: 4, hotspot_ID: 10, hotspotOrder: 1, hotspot_name: 'A' },
    { item_type: 4, hotspot_ID: 20, hotspotOrder: 2, hotspot_name: 'B' },
  ], new Map());

  assert.equal(insights[0].isBest, true);
  assert.equal(insights[1].fitsTiming, false);
  assert.equal(insights[1].reason, 'Too late');
});

test('validates operating-hour conflicts and relaxed route-fit unscheduling', () => {
  const service = createService();
  const base = {
    route: {},
    requestedHotspotIds: [99],
    fullTimeline: [{ type: 'attraction', hotspot_ID: 99, closed: true, timeRange: '07:00 AM - 08:00 AM' }],
    manualTimingPolicy: { mode: 'MANUAL_HOTSPOT', startTime: '09:00', endTime: '18:00', allowOffRouteWhenTimePermits: false } as any,
  };
  const conflict = service.buildManualHotspotValidation({
    ...base,
    adaptive: { requiresConfirmation: false, unscheduledManualHotspots: [], reason: null },
  });

  assert.equal(conflict.passesScheduleRules, false);
  assert.equal(conflict.requiresForceConfirmation, true);
  assert.equal(conflict.openingHourConflictCount, 1);

  const relaxed = service.buildManualHotspotValidation({
    ...base,
    fullTimeline: [],
    manualTimingPolicy: { ...base.manualTimingPolicy, allowOffRouteWhenTimePermits: true } as any,
    adaptive: {
      requiresConfirmation: false,
      unscheduledManualHotspots: [{ id: 99, name: 'Manual', reason: 'NO_FEASIBLE_ROUTE_SLOT' }],
      reason: 'NO_FEASIBLE_ROUTE_SLOT',
    },
  });
  assert.equal(relaxed.softManualRouteFitConflict, true);
  assert.equal(relaxed.readyToApply, true);
});
