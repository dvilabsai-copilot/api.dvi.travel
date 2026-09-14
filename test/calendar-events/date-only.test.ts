import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDateOnly, MAX_CALENDAR_RANGE_DAYS, parseDateOnly, rangesOverlapInclusive, validateDateRange } from '../../src/modules/calendar-events/utils/date-only.util';

test('accepts strict valid dates and preserves Nov 8', () => {
  assert.equal(formatDateOnly(parseDateOnly('2026-11-08')), '2026-11-08');
});

test('rejects malformed and impossible dates', () => {
  assert.throws(() => parseDateOnly('08-11-2026'));
  assert.throws(() => parseDateOnly('2026-02-30'));
});

test('validates order and maximum inclusive range', () => {
  assert.throws(() => validateDateRange('2026-11-09', '2026-11-08'));
  assert.throws(() => validateDateRange('2026-01-01', '2027-01-02'));
  const range = validateDateRange('2026-01-01', '2027-01-01');
  assert.equal(Math.round((range.to.getTime() - range.from.getTime()) / 86400000) + 1, MAX_CALENDAR_RANGE_DAYS);
});

test('uses inclusive travel-window overlap', () => {
  assert.equal(rangesOverlapInclusive('2026-10-02', '2026-10-02', '2026-10-02', '2026-10-03'), true);
  assert.equal(rangesOverlapInclusive('2026-10-03', '2026-10-03', '2026-10-02', '2026-10-03'), true);
  assert.equal(rangesOverlapInclusive('2026-10-04', '2026-10-05', '2026-10-02', '2026-10-03'), false);
});

test('keeps observance and travel window as separate concepts', () => {
  assert.notEqual('2026-11-08', '2026-11-07');
  assert.equal(rangesOverlapInclusive('2026-11-07', '2026-11-09', '2026-11-09', '2026-11-09'), true);
});
