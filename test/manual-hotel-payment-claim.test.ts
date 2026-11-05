import assert from 'node:assert/strict';
import test from 'node:test';
import { claimManualHotelHoldsForPayment } from '../src/modules/itineraries/services/itinerary-confirmation.service';

const fixture = (options: { cutoff?: Date; selectedIds?: number[]; holdIds?: number[]; claimCount?: number } = {}) => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const updated: any[] = [];
  const tx = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => (options.selectedIds || [101]).map((id) => ({ itinerary_plan_hotel_details_ID: id })),
    },
    dvi_hotel_block_request: {
      findMany: async () => (options.holdIds || [101]).map((id, index) => ({
        id: index + 1,
        status: 'BLOCKED',
        cutoff_at: options.cutoff || new Date('2026-11-05T13:00:00.000Z'),
        paid_confirmed_at: null,
        selection_ids: JSON.stringify([id]),
      })),
      updateMany: async (args: any) => { updated.push(args); return { count: options.claimCount ?? 1 }; },
    },
  };
  return { now, tx, updated };
};

test('payment claims selected active holds with a conditional unpaid/future-cutoff update', async () => {
  const { now, tx, updated } = fixture();
  const result = await claimManualHotelHoldsForPayment(tx, 800, 2, now);
  assert.deepEqual(result, { claimedCount: 1 });
  assert.deepEqual(updated[0].where, {
    id: { in: [1] }, status: { in: ['BLOCKED', 'CONFIRMED'] }, paid_confirmed_at: null,
    cutoff_at: { gt: now },
  });
  assert.deepEqual(updated[0].data, { paid_confirmed_at: now });
});

test('payment claim rejects an expired hold before changing its paid state', async () => {
  const { now, tx, updated } = fixture({ cutoff: new Date('2026-11-05T11:59:59.000Z') });
  await assert.rejects(claimManualHotelHoldsForPayment(tx, 800, 2, now), (error: any) => {
    assert.equal(error?.response?.code, 'HOTEL_HOLD_EXPIRED_OR_CHANGED');
    return true;
  });
  assert.equal(updated.length, 0);
});

test('payment claim rejects a concurrent expiry winner and rolls back its transaction', async () => {
  const { now, tx } = fixture({ claimCount: 0 });
  await assert.rejects(claimManualHotelHoldsForPayment(tx, 800, 2, now), (error: any) => {
    assert.equal(error?.response?.code, 'HOTEL_HOLD_EXPIRED_OR_CHANGED');
    assert.match(error?.response?.message, /expired while payment was starting/i);
    return true;
  });
});

test('payment claim rejects a selection changed since holds were created', async () => {
  const { now, tx, updated } = fixture({ selectedIds: [102], holdIds: [101] });
  await assert.rejects(claimManualHotelHoldsForPayment(tx, 800, 2, now), (error: any) => {
    assert.equal(error?.response?.code, 'HOTEL_HOLD_EXPIRED_OR_CHANGED');
    return true;
  });
  assert.equal(updated.length, 0);
});
