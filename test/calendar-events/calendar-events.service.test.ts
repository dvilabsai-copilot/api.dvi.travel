import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarEventsService } from '../../src/modules/calendar-events/calendar-events.service';

function eventRow(id = 1) {
  return {
    calendar_event_id: BigInt(id), event_key: 'india-diwali-2026', title: 'Diwali / Deepavali', short_title: 'Diwali', event_type: 'FESTIVAL',
    event_start_date: new Date('2026-11-08T00:00:00.000Z'), event_end_date: new Date('2026-11-08T00:00:00.000Z'),
    travel_window_start_date: new Date('2026-11-08T00:00:00.000Z'), travel_window_end_date: new Date('2026-11-08T00:00:00.000Z'),
    is_public_holiday: 1, travel_impact: 'UNSPECIFIED', description: null, travel_advisory: null, scopes: [{ calendar_event_scope_id: BigInt(4), scope_type: 'NATIONAL', scope_ref_id: 101 }],
  };
}

test('defaults to India national scope and de-duplicates event rows', async () => {
  let eventQuery: any;
  const prisma: any = {
    dvi_countries: { findFirst: async () => ({ id: 101 }) },
    dvi_stored_locations: { findMany: async () => [] },
    dvi_calendar_events: { findMany: async (args: any) => { eventQuery = args; return [eventRow(), eventRow()]; } },
  };
  const result = await new CalendarEventsService(prisma).getEvents({ from: '2026-11-01', to: '2026-11-30', location: [] } as any);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventStartDate, '2026-11-08');
  assert.deepEqual(eventQuery.where.scopes.some.OR, [{ scope_type: 'NATIONAL', scope_ref_id: 101 }]);
});

test('prefers stored-location city IDs and does not broaden unresolved locations', async () => {
  let eventQuery: any;
  const prisma: any = {
    dvi_stored_locations: { findMany: async (args: any) => args.where.OR[0].source_location?.in?.includes('Stored Airport') ? [{ source_location: 'Stored Airport', source_city_id: 7, destination_location: 'Other', destination_city_id: null }] : [] },
    dvi_cities: { findMany: async (args: any) => args.where.id ? [{ id: 7, name: 'Chennai', state_id: 8 }] : [] },
    dvi_states: { findMany: async () => [{ id: 8, name: 'Tamil Nadu', country_id: 101 }] },
    dvi_countries: { findFirst: async () => ({ id: 101 }), findMany: async () => [{ id: 101, name: 'India' }] },
    dvi_calendar_events: { findMany: async (args: any) => { eventQuery = args; return []; } },
  };
  const service = new CalendarEventsService(prisma);
  const storedResult = await service.getEvents({ from: '2026-10-01', to: '2026-10-31', location: ['Stored Airport'] } as any);
  assert.equal(storedResult.resolvedLocations[0].cityId, 7);
  assert.equal(storedResult.unresolvedLocations.length, 0);
  const result = await service.getEvents({ from: '2026-10-01', to: '2026-10-31', location: ['Unknown terminal'] } as any);
  assert.deepEqual(result.unresolvedLocations, ['Unknown terminal']);
  assert.deepEqual(eventQuery.where.scopes.some.OR, [{ scope_type: 'NATIONAL', scope_ref_id: 101 }]);
});
