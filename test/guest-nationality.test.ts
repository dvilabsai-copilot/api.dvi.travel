import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuestNationalityService } from '../src/modules/itineraries/services/guest-nationality.service';

const callbacks = {
  findById: async () => ({ shortname: 'IN', name: 'India' }),
  findByLegacyName: async () => ({ shortname: 'US', name: 'United States' }),
  legacyNameForId: (id: number) => (id === 286 ? 'United States' : undefined),
};

test('prefers the active country-table ISO code', async () => {
  assert.equal(await new GuestNationalityService().resolve({ nationality: 7 }, callbacks), 'IN');
});

test('uses the legacy dropdown-name lookup when the ID is not a country master ID', async () => {
  assert.equal(
    await new GuestNationalityService().resolve(
      { nationality: 286 },
      { ...callbacks, findById: async () => null },
    ),
    'US',
  );
});

test('supports direct ISO values and defaults to IN when no source is available', async () => {
  const service = new GuestNationalityService();
  assert.equal(await service.resolve({ nationality: 'GB' }, callbacks), 'GB');
  assert.equal(await service.resolve({ nationality: '' }, { ...callbacks, findById: async () => null, findByLegacyName: async () => null }), 'IN');
});
