import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaahCandidateSelectionService } from '../src/modules/itineraries/services/staah-candidate-selection.service';

const checkInDate = new Date('2026-07-17T00:00:00.000Z');
const checkOutDate = new Date('2026-07-18T00:00:00.000Z');

function select(overrides: Record<string, unknown> = {}) {
  const rates = [
    { staah_property_id: 'P1', room_id: 'ROOM-1', rateplan_id: '15', price: 100 },
    { staah_property_id: 'P1', room_id: 'ROOM-1', rateplan_id: '12', price: 140 },
  ];
  const ratePlans = [
    { staah_property_id: 'P1', rateplan_id: '15', rateplan_name: 'Room Only', meal_plan_description: 'Room Only' },
    { staah_property_id: 'P1', rateplan_id: '12', rateplan_name: 'Breakfast', meal_plan_description: 'Breakfast' },
  ];
  const service = new StaahCandidateSelectionService();
  return service.select({
    routeId: 7,
    propertyId: 'P1',
    hotel: { hotel_id: 10 },
    rows: rates,
    ratePlanRows: ratePlans,
    restrictionRowsByRateKey: new Map(),
    includeRestrictedForDisplay: false,
    checkInDate,
    checkOutDate,
    lengthOfStay: 1,
    dateStamp: '20260717',
    callbacks: {
      isAllowedRoom: () => true,
      roomName: (roomId) => `Room ${roomId}`,
      calculatePrice: (rate) => Number(rate.price || 0),
      evaluateRestrictions: () => ({ blocked: false, reason: null, availableAgainFrom: null }),
      formatDate: (date) => date.toISOString().slice(0, 10),
    },
    ...overrides,
  });
}

test('selects the cheapest positive valid STAAH candidate and returns valid display rows', () => {
  const result = select();

  assert.equal(result.selected?.rate.rateplan_id, '15');
  assert.equal(result.selected?.price, 100);
  assert.equal(result.selectedReason, 'selected cheapest valid rate');
  assert.equal(result.validDisplayCandidates.length, 2);
  assert.equal(result.blockedCandidate, null);
});

test('surfaces a blocked preferred candidate when the selected valid plan is not preferred', () => {
  const restrictionRowsByRateKey = new Map([
    ['P1|ROOM-1|12', [{ restriction_type: 'CLOSED' }]],
  ]);
  const result = select({
    preferredMealPlanCode: 'CP',
    includeRestrictedForDisplay: true,
    restrictionRowsByRateKey,
    callbacks: {
      isAllowedRoom: () => true,
      roomName: (roomId: string) => `Room ${roomId}`,
      calculatePrice: (rate: any) => Number(rate.price || 0),
      evaluateRestrictions: (rateKey: string) =>
        rateKey === 'P1|ROOM-1|12'
          ? { blocked: true, reason: 'closed for arrival', availableAgainFrom: '2026-07-20' }
          : { blocked: false, reason: null, availableAgainFrom: null },
      formatDate: (date: Date) => date.toISOString().slice(0, 10),
    },
  });

  assert.equal(result.selected?.rate.rateplan_id, '15');
  assert.equal(result.blockedCandidate?.rate.rateplan_id, '12');
  assert.equal(result.blockedCandidate?.reason, 'closed for arrival');
  assert.equal(result.shouldSurfaceBlockedPreferred, true);
  assert.equal(result.shouldSurfaceBlockedVariant, false);
});

test('does not select non-positive rates and retains the last rejection reason', () => {
  const result = select({
    rows: [{ staah_property_id: 'P1', room_id: 'ROOM-1', rateplan_id: '15', price: 0 }],
  });

  assert.equal(result.selected, null);
  assert.equal(result.validDisplayCandidates.length, 0);
  assert.equal(result.selectedReason, 'no positive price for rateplan 15');
});
