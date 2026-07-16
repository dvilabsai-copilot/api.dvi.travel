import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineMatrixAutobuildService } from '../src/modules/itineraries/engines/helpers/timeline-matrix-autobuild.service';

function createInput() {
  const logs: any[] = [];
  const route = { itinerary_route_ID: 10, location_name: 'Chennai', next_visiting_location: 'Bengaluru' };
  const tx = {
    dvi_itinerary_route_hotspot_details: {
      findMany: async () => [{ hotspot_ID: 1 }, { hotspot_ID: 2 }],
    },
  };
  const input: any = {
    tx,
    route,
    plan: { quote_id: 99 },
    planId: 7,
    sourceCity: 'Chennai',
    destinationCity: 'Bengaluru',
    currentTime: '08:00:00',
    routeStartSeconds: 8 * 3600,
    routeEndSeconds: 18 * 3600,
    timingMap: new Map(),
    hotspotMap: new Map([
      [3, { hotspot_ID: 3, hotspot_name: 'Between', hotspot_location: 'Chennai', hotspot_to_location: 'Bengaluru', hotspot_duration: '01:00:00' }],
    ]),
    selectedHotspots: [],
    isHotspotAlreadyPlanned: () => false,
    getBetweenCandidatesForRouteSlots: async () => new Map([
      ['1_2', [{ between_hotspot_id: 3, route_fit_type: 'ON_ROUTE', from_hotspot_id: 1, to_hotspot_id: 2 }]],
    ]),
    logTimeline: (event: any, details: any) => logs.push({ event, details }),
    logBookingRule: (entry: any) => logs.push(entry),
    canonicalCityKey: (value: string) => String(value || '').toLowerCase(),
    hotspotLocationMatchesCity: (value: string, city: string) => String(value || '').toLowerCase() === String(city || '').toLowerCase(),
    checkHotspotOperatingHoursFromMap: () => ({ canVisitNow: true }),
  };
  return { input, logs };
}

test('skips matrix reads when the autobuild feature flag is disabled', async () => {
  const { input } = createInput();
  const original = process.env.HOTSPOT_MATRIX_AUTOBUILD;
  process.env.HOTSPOT_MATRIX_AUTOBUILD = 'false';
  let reads = 0;
  input.tx.dvi_itinerary_route_hotspot_details.findMany = async () => {
    reads += 1;
    return [];
  };

  try {
    const result = await new (await import('../src/modules/itineraries/engines/helpers/timeline-matrix-autobuild.service')).TimelineMatrixAutobuildService().apply(input);
    assert.deepEqual(result, []);
    assert.equal(reads, 0);
  } finally {
    if (original == null) delete process.env.HOTSPOT_MATRIX_AUTOBUILD;
    else process.env.HOTSPOT_MATRIX_AUTOBUILD = original;
  }
});

test('merges an eligible between-hotspot candidate with deterministic matrix metadata', async () => {
  const { input, logs } = createInput();
  const original = process.env.HOTSPOT_MATRIX_AUTOBUILD;
  process.env.HOTSPOT_MATRIX_AUTOBUILD = 'true';

  try {
    const service = new (await import('../src/modules/itineraries/engines/helpers/timeline-matrix-autobuild.service')).TimelineMatrixAutobuildService();
    const result = await service.apply(input);

    assert.equal(result.length, 1);
    assert.equal(result[0].hotspot_ID, 3);
    assert.equal(result[0].matched_bucket, 'matrix');
    assert.equal(result[0].matrix_score, 100);
    assert.equal(logs.some((entry) => entry.event === '[MATRIX] MATRIX_CANDIDATE_MERGED'), true);
  } finally {
    if (original == null) delete process.env.HOTSPOT_MATRIX_AUTOBUILD;
    else process.env.HOTSPOT_MATRIX_AUTOBUILD = original;
  }
});
