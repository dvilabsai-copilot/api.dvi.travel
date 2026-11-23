import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryCancellationService } from '../src/modules/itineraries/services/itinerary-cancellation.service';

function createService() {
  return new ItineraryCancellationService(null as any, null as any, null as any, null as any);
}

test('cancellation preserves required plan validation', async () => {
  await assert.rejects(
    () => createService().cancelItinerary({ itinerary_plan_ID: 0, reason: 'test' } as any),
    /Itinerary Plan ID is required/,
  );
});

test('cancellation preserves required reason validation', async () => {
  await assert.rejects(
    () => createService().cancelItinerary({ itinerary_plan_ID: 99 } as any),
    /Cancellation reason is required/,
  );
});

function setupCancellation(vsrOutcomes: string[]) {
  const calls: string[] = [];
  const record = (name: string) => async () => { calls.push(name); };
  let completed = false;
  const tx = {
    $queryRaw: record('lock itinerary'),
    dvi_cancelled_itineraries: {
      findFirst: async () => completed ? { cancelled_itinerary_ID: 5 } : null,
      create: async () => { calls.push('create cancellation'); return { cancelled_itinerary_ID: 5 }; },
      update: async () => { calls.push('complete cancellation'); completed = true; },
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{ itinerary_plan_hotel_details_ID: 7, hotel_provider: 'VSR', hotel_id: 10 }],
      updateMany: record('mark planned hotel cancelled'),
    },
    dvi_confirmed_itinerary_plan_hotel_details: { updateMany: record('mark confirmed hotel cancelled') },
    dvi_confirmed_itinerary_plan_hotel_voucher_details: { updateMany: record('mark hotel voucher cancelled') },
    dvi_cancelled_itinerary_plan_hotel_details: { create: record('copy hotel cancellation') },
    dvi_cash_wallet: { create: record('refund wallet') },
    dvi_confirmed_itinerary_plan_details: { update: record('mark itinerary cancelled') },
  };
  const prisma = {
    dvi_confirmed_itinerary_plan_details: {
      findFirst: async () => ({ itinerary_plan_ID: 42, confirmed_itinerary_plan_ID: 4, itinerary_total_net_payable_amount: 100 }),
    },
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const vsr = {
    cancelItineraryHotels: async (id: number, reason: string) => {
      assert.equal(id, 42);
      assert.equal(reason, 'Itinerary cancelled by user');
      calls.push('verify VSR cancellation');
      return vsrOutcomes.map(status => ({ status }));
    },
  };
  const service = new ItineraryCancellationService(
    prisma as never, vsr as never,
    { cancelItineraryHotels: record('cancel ResAvenue') } as never,
    { cancelItineraryHotels: record('cancel HOBSE') } as never,
  );
  Object.assign(service, { logCancellationAction: async () => {}, sendCancellationNotifications: record('notify') });
  return { service, calls };
}

const hotelCancellation = {
  itinerary_plan_ID: 42,
  reason: 'Test cancellation',
  cancellation_options: { modify_hotel: true },
};

test('a rejected VSR stay blocks all itinerary cancellation writes and allows a retry', async () => {
  const outcomes = ['cancelled', 'failed'];
  const { service, calls } = setupCancellation(outcomes);
  await assert.rejects(service.cancelItinerary(hotelCancellation), /VSR did not confirm/);
  assert.deepEqual(calls, ['lock itinerary', 'verify VSR cancellation']);

  outcomes.splice(0, outcomes.length, 'cancelled');
  await service.cancelItinerary(hotelCancellation);
  assert.deepEqual(calls.slice(2), [
    'lock itinerary', 'verify VSR cancellation', 'create cancellation', 'cancel ResAvenue', 'cancel HOBSE',
    'mark planned hotel cancelled', 'mark confirmed hotel cancelled', 'mark hotel voucher cancelled',
    'copy hotel cancellation', 'refund wallet', 'mark itinerary cancelled', 'complete cancellation', 'notify',
  ]);
  await assert.rejects(service.cancelItinerary(hotelCancellation), /Itinerary already cancelled/);
  assert.equal(calls.at(-1), 'lock itinerary');
});

test('an itinerary with no active VSR booking can cancel normally', async () => {
  const { service, calls } = setupCancellation([]);
  assert.equal((await service.cancelItinerary(hotelCancellation)).data.cancellation_details.hotels_cancelled, 1);
  assert.ok(calls.includes('complete cancellation'));
});
