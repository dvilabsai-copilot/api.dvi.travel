import assert from 'node:assert/strict';
import test from 'node:test';
import { getValidatedTboRoomNightBreakdownForDate } from '../src/modules/itineraries/utils/validated-tbo-room-night-breakdown.util';

test('validates and scopes manually selected TBO room-night breakdowns', () => {
  const rows = [
    { date: '2026-11-20', roomNumber: 1, allInAmount: 4447.98 },
    { date: '2026-11-20', roomNumber: 2, allInAmount: 4447.97 },
  ];

  assert.deepEqual(
    getValidatedTboRoomNightBreakdownForDate(rows, 8895.95, '2026-11-20'),
    rows,
  );

  assert.equal(
    getValidatedTboRoomNightBreakdownForDate(rows, 9000, '2026-11-20'),
    undefined,
  );

  assert.equal(getValidatedTboRoomNightBreakdownForDate(
    [{ ...rows[0], allInAmount: 'not-a-price' }],
    4447.98,
    '2026-11-20',
  ), undefined);
  assert.equal(
    getValidatedTboRoomNightBreakdownForDate(rows, 8895.95, '2026-11-21'),
    undefined,
  );
});
