import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';

function serviceWithSetting(value: number | null) {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype) as any;
  service.prisma = {
    dvi_global_settings: {
      findFirst: async () => value === null ? null : { hobse_search_enabled: value },
    },
  };
  return service;
}

test('HOBSE itinerary search reads the enabled flag from global settings', async () => {
  const service = serviceWithSetting(1);
  const previous = process.env.HOBSE_SEARCH_ENABLED;
  process.env.HOBSE_SEARCH_ENABLED = '0';

  try {
    await assert.doesNotReject(async () => {
      assert.equal(await service.isHobseSearchEnabled(), true);
    });
  } finally {
    if (previous === undefined) delete process.env.HOBSE_SEARCH_ENABLED;
    else process.env.HOBSE_SEARCH_ENABLED = previous;
  }
});

test('HOBSE itinerary search can be disabled by global settings', async () => {
  const service = serviceWithSetting(0);
  assert.equal(await service.isHobseSearchEnabled(), false);
});

test('missing global setting preserves the current enabled default', async () => {
  const service = serviceWithSetting(null);
  assert.equal(await service.isHobseSearchEnabled(), true);
});
