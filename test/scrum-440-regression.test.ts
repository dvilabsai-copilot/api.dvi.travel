import assert from 'node:assert/strict';
import test from 'node:test';
import { findTerminalTravelAndOvernightRows } from '../src/modules/itineraries/engines/helpers/terminal-route-pair.helper';
import { shouldSuppressSyntheticLocalPickup } from '../src/modules/itineraries/engines/helpers/local-pickup-policy.helper';

const row = (item_type: number, start: string, end: string) => ({
  item_type,
  hotspot_start_time: new Date(start),
  hotspot_end_time: new Date(end),
});

test('terminal validation keeps an early hotel-first pair and selects the final pair', () => {
  const rows = [
    row(5, '2026-01-01T08:00:00.000Z', '2026-01-01T08:30:00.000Z'),
    row(6, '2026-01-01T08:30:00.000Z', '2026-01-01T08:30:00.000Z'),
    row(4, '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z'),
    row(4, '2026-01-01T12:00:00.000Z', '2026-01-01T13:00:00.000Z'),
    row(5, '2026-01-01T13:00:00.000Z', '2026-01-01T14:00:00.000Z'),
    row(6, '2026-01-01T14:00:00.000Z', '2026-01-01T14:00:00.000Z'),
  ];

  const pair = findTerminalTravelAndOvernightRows(
    rows,
    new Date('2026-01-01T13:00:00.000Z').getTime(),
  );

  assert.equal(pair?.finalTravel, rows[4]);
  assert.equal(pair?.overnight, rows[5]);
});

test('terminal validation rejects a missing final check-in marker', () => {
  const rows = [
    row(4, '2026-01-01T12:00:00.000Z', '2026-01-01T13:00:00.000Z'),
    row(5, '2026-01-01T13:00:00.000Z', '2026-01-01T14:00:00.000Z'),
    row(6, '2026-01-01T14:05:00.000Z', '2026-01-01T14:05:00.000Z'),
  ];

  assert.equal(
    findTerminalTravelAndOvernightRows(
      rows,
      new Date('2026-01-01T13:00:00.000Z').getTime(),
    ),
    null,
  );
});

test('pickup suppression keeps the PR rule but preserves selected hotels without coordinates', () => {
  const shared = {
    travelType: 1,
    routeCount: 2,
    isSameVehicleOriginCity: true,
    localPointSource: 'city_fallback',
  };

  assert.equal(
    shouldSuppressSyntheticLocalPickup({ ...shared, hasSelectedHotel: false }),
    true,
  );
  assert.equal(
    shouldSuppressSyntheticLocalPickup({ ...shared, hasSelectedHotel: true }),
    false,
  );
});
