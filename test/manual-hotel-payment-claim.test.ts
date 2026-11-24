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

function splitFixture() {
  const { now, tx, updated } = fixture({ claimCount: 4 });
  const hotel = (hotelCode: string, ids: number[], firstRequestId: number) => {
    const batches = ['Deluxe Twin', 'Deluxe Double'].map((roomType, batchIndex) => ({
      hotelCode, roomType, batchIndex, roomCount: batchIndex === 0 ? 6 : 2, mealPlan: 'CP',
      bookingCode: `${hotelCode}!TB!${batchIndex}`,
    }));
    return {
      selected: ids.map(id => ({ itinerary_plan_hotel_details_ID: id,
        selected_price_snapshot: JSON.stringify({ tboMultiBatchStay: { batches } }) })),
      holds: batches.map(batch => ({
        id: firstRequestId + batch.batchIndex,
        status: 'BLOCKED', cutoff_at: new Date('2026-11-05T13:00:00.000Z'), paid_confirmed_at: null,
        selection_ids: JSON.stringify(ids), hotel_code: hotelCode, room_type: batch.roomType,
        room_count: batch.roomCount, meal_plan: batch.mealPlan,
        request_payload: JSON.stringify({ supplierHold: {
          batch: { key: hotelCode, index: batch.batchIndex, count: 2 }, bookingCode: batch.bookingCode,
          bookingId: firstRequestId + batch.batchIndex + 100,
        } }),
      })),
    };
  };
  const fortune = hotel('fortune', [101, 102], 1);
  const treebo = hotel('treebo', [103], 3);
  const holds = [...fortune.holds, ...treebo.holds];
  tx.dvi_itinerary_plan_hotel_details.findMany = async () => [...fortune.selected, ...treebo.selected];
  tx.dvi_hotel_block_request.findMany = async () => holds;
  return { now, tx, updated, holds };
}

test('payment counts each complete split stay once and claims all four supplier reservations', async () => {
  const { now, tx, updated } = splitFixture();
  assert.deepEqual(await claimManualHotelHoldsForPayment(tx, 800, 2, now), { claimedCount: 4 });
  assert.deepEqual(updated[0].where.id.in, [1, 2, 3, 4]);
});

test('payment rejects a missing split batch, even when every selected date is covered', async () => {
  const { now, tx, updated, holds } = splitFixture();
  holds.pop();
  await assert.rejects(claimManualHotelHoldsForPayment(tx, 800, 2, now), /hold expired or the selected hotels changed/i);
  assert.equal(updated.length, 0);
});

test('payment rejects duplicate supplier reservations and changed split bedroom assignments', async () => {
  for (const change of ['duplicate', 'roomType']) {
    const { now, tx, updated, holds } = splitFixture();
    if (change === 'duplicate') {
      const payload = JSON.parse(holds[1].request_payload);
      payload.supplierHold.bookingId = JSON.parse(holds[0].request_payload).supplierHold.bookingId;
      holds[1].request_payload = JSON.stringify(payload);
    } else {
      holds[1].room_type = 'Different Room';
    }
    await assert.rejects(claimManualHotelHoldsForPayment(tx, 800, 2, now), /hold expired or the selected hotels changed/i);
    assert.equal(updated.length, 0);
  }
});
