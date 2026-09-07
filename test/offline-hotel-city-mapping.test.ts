import assert from 'node:assert/strict';
import test from 'node:test';
import { OfflineHotelCatalogService } from '../src/modules/itineraries/services/offline-hotel-catalog.service';

const cityRecords = [
  { id: 1558, name: 'Bengaluru' },
  { id: 1930, name: 'Kochi' },
  { id: 266, name: 'Tirupati' },
  { id: 1582, name: 'Chikmagalur' },
  { id: 71173, name: 'Tiruchirappalli' },
  { id: 71090, name: 'Puducherry' },
  { id: 3659, name: 'Chennai' },
  { id: 2045, name: 'Thiruvananthapuram' },
  { id: 1848, name: 'Alappuzha' },
  { id: 70761, name: 'Alleppey' },
];

function service() {
  return new OfflineHotelCatalogService({
    dvi_cities: { findMany: async () => cityRecords },
  } as any, {} as any);
}

async function candidates(destination: string): Promise<string[]> {
  return (await (service() as any).resolveCityCandidatesForDestinations([destination])).get(destination) || [];
}

test('maps Bangalore route destinations to the Bengaluru city master record', async () => {
  const result = await candidates('Bangalore');
  assert.ok(result.includes('1558'));
  assert.ok(result.includes('Bengaluru'));
});

test('strips facility suffixes before applying city aliases', async () => {
  const result = await candidates('Bangalore, International Airport');
  assert.ok(result.includes('1558'));
  assert.ok(result.includes('Bengaluru'));
});

test('covers verified spelling and regional-name aliases', async () => {
  for (const [destination, expectedId] of [
    ['Chikmagaluru', '1582'],
    ['Cochin Airport', '1930'],
    ['Trichy', '71173'],
    ['Tirupathi', '266'],
    ['Pondicherry', '71090'],
    ['Trivandrum', '2045'],
  ] as const) {
    assert.ok((await candidates(destination)).includes(expectedId), destination);
  }
});

test('maps Chennai landmark route destinations to the canonical Chennai city', async () => {
  for (const destination of ['Chennai Koyembedu', 'ECR Beach, Chennai, Tamil Nadu']) {
    const result = await candidates(destination);
    assert.ok(result.includes('3659'), destination);
    assert.ok(result.includes('Chennai'), destination);
  }
});

test('normalizes Alleppey spellings to the Alappuzha city master', async () => {
  for (const destination of ['Alleppey', 'Allepe', 'Alappuzha']) {
    const result = await candidates(destination);
    assert.ok(result.includes('1848'), destination);
    assert.ok(result.includes('Alappuzha'), destination);
  }
});

test('does not turn an unknown landmark into a broad city search', async () => {
  const result = await candidates('Mahanandi');
  assert.deepEqual(result, ['Mahanandi']);
});
