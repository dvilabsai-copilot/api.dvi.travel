import { PrismaClient } from '@prisma/client';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDateOnly } from '../src/modules/calendar-events/utils/date-only.util';

type InputScope = { type: 'NATIONAL' | 'STATE' | 'CITY'; countryName?: string; stateName?: string; cityName?: string };
type InputEvent = {
  eventKey: string; title: string; shortTitle?: string; eventType: string;
  eventStartDate: string; eventEndDate: string; travelWindowStartDate: string; travelWindowEndDate: string;
  isPublicHoliday?: boolean; travelImpact?: string; description?: string; travelAdvisory?: string;
  sourceName?: string; sourceReference?: string; sortPriority?: number; scopes: InputScope[];
};

const prisma = new PrismaClient();
const dataDirectory = resolve(__dirname, '../data/calendar-events');

async function resolveScope(scope: InputScope) {
  if (scope.type === 'NATIONAL') {
    const country = await prisma.dvi_countries.findFirst({ where: { name: scope.countryName, status: 1, deleted: 0 }, select: { id: true } });
    if (!country) throw new Error(`Country not found: ${scope.countryName}`);
    return { scope_type: scope.type, scope_ref_id: country.id };
  }
  const country = await prisma.dvi_countries.findFirst({ where: { name: scope.countryName, status: 1, deleted: 0 }, select: { id: true } });
  if (!country) throw new Error(`Country not found: ${scope.countryName}`);
  if (scope.type === 'STATE') {
    const state = await prisma.dvi_states.findFirst({ where: { name: scope.stateName, country_id: country.id, deleted: 0 }, select: { id: true } });
    if (!state) throw new Error(`State not found: ${scope.stateName}`);
    return { scope_type: scope.type, scope_ref_id: state.id };
  }
  const state = await prisma.dvi_states.findFirst({ where: { name: scope.stateName, country_id: country.id, deleted: 0 }, select: { id: true } });
  if (!state) throw new Error(`State not found: ${scope.stateName}`);
  const city = await prisma.dvi_cities.findFirst({ where: { name: scope.cityName, state_id: state.id, status: 1, deleted: 0 }, select: { id: true } });
  if (!city) throw new Error(`City not found: ${scope.cityName}`);
  return { scope_type: scope.type, scope_ref_id: city.id };
}

async function main() {
  const sourceFiles = (await readdir(dataDirectory))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort();
  const events = (await Promise.all(
    sourceFiles.map(async (fileName) => JSON.parse(await readFile(resolve(dataDirectory, fileName), 'utf8')) as InputEvent[]),
  )).flat();
  for (const item of events) {
    const eventStart = parseDateOnly(item.eventStartDate, 'eventStartDate');
    const eventEnd = parseDateOnly(item.eventEndDate, 'eventEndDate');
    const windowStart = parseDateOnly(item.travelWindowStartDate, 'travelWindowStartDate');
    const windowEnd = parseDateOnly(item.travelWindowEndDate, 'travelWindowEndDate');
    if (eventStart > eventEnd || windowStart > windowEnd) throw new Error(`Invalid date range for ${item.eventKey}`);
    const scopes = await Promise.all(item.scopes.map(resolveScope));
    await prisma.$transaction(async (tx) => {
      const event = await tx.dvi_calendar_events.upsert({
        where: { event_key: item.eventKey },
        create: {
          event_key: item.eventKey, title: item.title, short_title: item.shortTitle, event_type: item.eventType,
          event_start_date: eventStart, event_end_date: eventEnd, travel_window_start_date: windowStart, travel_window_end_date: windowEnd,
          is_public_holiday: item.isPublicHoliday ? 1 : 0, travel_impact: item.travelImpact || 'UNSPECIFIED', description: item.description,
          travel_advisory: item.travelAdvisory, source_name: item.sourceName, source_reference: item.sourceReference, sort_priority: item.sortPriority ?? 100,
        },
        update: {
          title: item.title, short_title: item.shortTitle, event_type: item.eventType, event_start_date: eventStart, event_end_date: eventEnd,
          travel_window_start_date: windowStart, travel_window_end_date: windowEnd, is_public_holiday: item.isPublicHoliday ? 1 : 0,
          travel_impact: item.travelImpact || 'UNSPECIFIED', description: item.description, travel_advisory: item.travelAdvisory,
          source_name: item.sourceName, source_reference: item.sourceReference, sort_priority: item.sortPriority ?? 100, status: 1, deleted: 0,
        },
      });
      await tx.dvi_calendar_event_scopes.deleteMany({ where: { calendar_event_id: event.calendar_event_id } });
      if (scopes.length) await tx.dvi_calendar_event_scopes.createMany({ data: scopes.map((scope) => ({ ...scope, calendar_event_id: event.calendar_event_id })) });
    });
  }
  console.log(`Imported ${events.length} calendar events`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
