import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryLatestDataTableService } from '../src/modules/itineraries/services/itinerary-latest-data-table.service';

function createService(prisma: any) {
  return new ItineraryLatestDataTableService(
    prisma,
    (value) => value ? new Date(value) : null,
    (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()),
    (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999),
    (value) => value ? '09:00 AM' : null,
    (value) => value ? 'Fri, Jul 17, 2026' : '',
  );
}

test('projects only unconfirmed plans with DataTable pagination and user labels', async () => {
  const prisma = {
    dvi_itinerary_plan_details: {
      findMany: async () => [
        { itinerary_plan_ID: 1, arrival_location: 'A', departure_location: 'B', trip_start_date_and_time: new Date(), trip_end_date_and_time: new Date(), itinerary_quote_ID: 'Q1', no_of_days: 2, no_of_nights: 1, total_adult: 2, total_children: 1, total_infants: 0, itinerary_preference: 1, createdby: 10 },
        { itinerary_plan_ID: 2, arrival_location: 'C', departure_location: 'D', itinerary_quote_ID: 'Q2', createdby: 11 },
      ],
    },
    dvi_confirmed_itinerary_plan_details: { findMany: async () => [{ itinerary_plan_ID: 2, itinerary_quote_ID: 'BOOK-2' }] },
    dvi_users: { findMany: async () => [{ userID: 10, roleID: 1, staff_id: 0, agent_id: 0, username: 'admin' }] },
    dvi_staff_details: { findMany: async () => [] },
    dvi_agent: { findMany: async () => [] },
  };
  const service = createService(prisma);
  const result = await service.get({ draw: 3, start: 0, length: 10 }, { query: {}, user: {} });

  assert.equal(result.draw, 3);
  assert.equal(result.recordsTotal, 1);
  assert.equal(result.data[0].itinerary_quote_ID, 'Q1');
  assert.equal(result.data[0].username, 'admin');
  assert.equal(result.data[0].no_of_days_and_nights, '1&2');
});

test('returns an empty page when all matching plans are confirmed', async () => {
  const prisma = {
    dvi_itinerary_plan_details: { findMany: async () => [{ itinerary_plan_ID: 9, createdby: 0 }] },
    dvi_confirmed_itinerary_plan_details: { findMany: async () => [{ itinerary_plan_ID: 9, itinerary_quote_ID: 'BOOK-9' }] },
    dvi_users: { findMany: async () => [] },
    dvi_staff_details: { findMany: async () => [] },
    dvi_agent: { findMany: async () => [] },
  };
  const result = await createService(prisma).get({ draw: 1 }, { query: {}, user: {} });
  assert.equal(result.recordsTotal, 0);
  assert.deepEqual(result.data, []);
});
