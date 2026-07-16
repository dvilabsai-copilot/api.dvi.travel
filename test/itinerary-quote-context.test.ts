import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryQuoteContextService } from '../src/modules/itineraries/services/itinerary-quote-context.service';

function createService(prisma: any = {}) {
  return new ItineraryQuoteContextService(prisma);
}

test('quote edit preserves missing-plan validation', async () => {
  await assert.rejects(
    () => createService({ dvi_itinerary_plan_details: { findUnique: async () => null } }).getPlanForEdit(99),
    /Plan 99 not found/,
  );
});

test('customer form preserves missing-plan validation', async () => {
  await assert.rejects(
    () => createService({ dvi_itinerary_plan_details: { findUnique: async () => null } }).getCustomerInfoForm(99),
    /Itinerary plan not found/,
  );
});

test('wallet resolution preserves the zero balance for an unknown agent', async () => {
  const service = createService({
    dvi_agent: { findUnique: async () => null },
  });

  assert.deepEqual(await service.getAgentWalletBalance(99), { balance: 0 });
});
