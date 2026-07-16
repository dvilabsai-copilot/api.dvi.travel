import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryVoucherReadService } from '../src/modules/itineraries/services/itinerary-voucher-read.service';

function createService() {
  return new ItineraryVoucherReadService({
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => null },
  } as any);
}

test('voucher read preserves missing confirmed-plan validation', async () => {
  await assert.rejects(
    () => createService().getVoucherDetails(99),
    /Confirmed itinerary plan not found/,
  );
});

test('transport voucher read preserves missing confirmed-plan validation', async () => {
  await assert.rejects(
    () => createService().getTransportVoucherDetails(99),
    /Confirmed itinerary plan not found/,
  );
});
