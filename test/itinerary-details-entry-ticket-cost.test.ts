import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsEntryTicketCostService } from '../src/modules/itineraries/services/itinerary-details-entry-ticket-cost.service';

test('groups positive route-hotspot entry costs and normalizes numeric fields', async () => {
  const service = new ItineraryDetailsEntryTicketCostService();
  const map = await service.load({
    dvi_itinerary_route_hotspot_entry_cost_details: {
      findMany: async () => [
        { route_hotspot_id: '7', traveller_type: '1', entry_ticket_cost: '125.5' },
        { route_hotspot_id: 7, traveller_type: 2, entry_ticket_cost: 80 },
        { route_hotspot_id: 0, traveller_type: 1, entry_ticket_cost: 1 },
      ],
    },
  }, 42);

  assert.deepEqual(map.get(7), [
    { traveller_type: 1, entry_ticket_cost: 125.5 },
    { traveller_type: 2, entry_ticket_cost: 80 },
  ]);
  assert.equal(map.has(0), false);
});
