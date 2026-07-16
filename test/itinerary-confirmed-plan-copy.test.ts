import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryConfirmedPlanCopyService } from '../src/modules/itineraries/services/itinerary-confirmed-plan-copy.service';

function emptyTransaction() {
  const model = new Proxy({}, {
    get: (_target, property: string) => {
      if (property === 'findMany') return async () => [];
      if (property === 'findFirst') return async () => null;
      if (property === 'create') return async () => ({});
      if (property === 'update') return async () => ({});
      if (property === 'updateMany') return async () => ({ count: 0 });
      return async () => [];
    },
  });
  return new Proxy({}, {
    get: () => model,
  });
}

test('confirmed-plan copy preserves an empty transaction as a no-op', async () => {
  await assert.doesNotReject(() => new ItineraryConfirmedPlanCopyService().copyDraftToConfirmed(
    emptyTransaction(),
    99,
    100,
    1,
    { copyHotels: false },
  ));
});
