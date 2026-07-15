import assert from 'node:assert/strict';
import { buildEntryTicketBreakdown } from '../src/modules/itineraries/utils/entry-ticket-breakdown.util';

const base = {
  dayNumber: 1,
  date: '2026-07-16',
  locationId: 12,
  locationName: 'Museum',
  routeHotspot: {
    hotspot_ID: 101,
    route_hotspot_ID: 9001,
    hotspot_amout: 250,
    hotspot_adult_entry_cost: 100,
    hotspot_child_entry_cost: 50,
    hotspot_infant_entry_cost: 0,
  },
  adults: 2,
  children: 1,
  infants: 0,
  nationality: 101,
  entryTicketRequired: true,
};

const persisted = buildEntryTicketBreakdown({
  ...base,
  persistedRows: [
    { traveller_type: 1, entry_ticket_cost: 100 },
    { traveller_type: 1, entry_ticket_cost: 100 },
    { traveller_type: 2, entry_ticket_cost: 50 },
  ],
});

assert.equal(persisted?.total, 250);
assert.deepEqual(persisted?.travellers, [
  { type: 'adult', label: 'Adult', quantity: 2, unitCost: 100, total: 200 },
  { type: 'child', label: 'Child', quantity: 1, unitCost: 50, total: 50 },
]);

const fallback = buildEntryTicketBreakdown({ ...base, persistedRows: [] });
assert.equal(fallback?.total, 250);
assert.equal(fallback?.travellers[0]?.unitCost, 100);
assert.equal(fallback?.travellers[1]?.unitCost, 50);
