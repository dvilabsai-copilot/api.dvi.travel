import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryConfirmedItineraryDetailsService } from '../src/modules/itineraries/services/itinerary-confirmed-itinerary-details.service';

test('confirmed itinerary details preserves missing-plan validation', async () => {
  const service = new ItineraryConfirmedItineraryDetailsService({
    dvi_confirmed_itinerary_plan_details: {
      findUnique: async () => null,
    },
  } as any);

  await assert.rejects(
    () => service.getConfirmedItineraryDetails(99),
    /Confirmed itinerary not found/,
  );
});
