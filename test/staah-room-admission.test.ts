import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaahRoomAdmissionService } from '../src/modules/itineraries/services/staah-room-admission.service';

function createAdmission(warnings: string[]) {
  return new StaahRoomAdmissionService().create({
    routeId: 4,
    mappings: {
      allowedRoomCodesByPropertyId: new Map([['P1', new Set(['DELUXE-1'])]]),
      allowedLooseRoomCodesByPropertyId: new Map([['P1', new Set(['DELUXE1'])]]),
      allowedLooseExactCodesByPropertyId: new Map([
        ['P1', new Map([['DELUXE1', new Set(['DELUXE-1'])]])],
      ]),
    },
    normalizeExact: (value) => String(value || '').trim().toUpperCase(),
    normalizeLoose: (value) => String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    warn: (message) => warnings.push(message),
  });
}

test('accepts exact active room references', () => {
  const admission = createAdmission([]);
  assert.equal(admission('P1', 'deluxe-1'), true);
});

test('rejects normalized-only references and deduplicates stale-room warnings', () => {
  const warnings: string[] = [];
  const admission = createAdmission(warnings);

  assert.equal(admission('P1', 'DELUXE1'), false);
  assert.equal(admission('P1', 'DELUXE1'), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Only normalized match found/);
});

test('rejects unknown properties and reports missing mappings once', () => {
  const warnings: string[] = [];
  const admission = createAdmission(warnings);

  assert.equal(admission('UNKNOWN', 'ROOM-1'), false);
  assert.equal(admission('UNKNOWN', 'ROOM-1'), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No active dvi_hotel_rooms/);
});
