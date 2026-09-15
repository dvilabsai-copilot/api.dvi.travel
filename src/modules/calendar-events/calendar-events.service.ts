import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { resolveCityRecordByName } from '../itineraries/utils/city-normalization.util';
import { CalendarEventsQueryDto } from './dto/calendar-events-query.dto';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { UpdateCalendarEventDto } from './dto/update-calendar-event.dto';
import { formatDateOnly, validateDateRange } from './utils/date-only.util';
import { parseDateOnly } from './utils/date-only.util';

type ResolvedLocation = {
  input: string;
  cityId: number;
  cityName: string;
  stateId: number;
  stateName: string;
  countryId: number;
  countryName: string;
};

type ScopeFilter = { scope_type: string; scope_ref_id: number };

function locationKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Map(values.map((value) => [locationKey(value), value.trim()])).values());
}

function eventKeySlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'holiday';
}

@Injectable()
export class CalendarEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAdmin() {
    const rows = await this.prisma.dvi_calendar_events.findMany({
      where: { deleted: 0 },
      include: { scopes: { where: { deleted: 0 }, orderBy: [{ scope_type: 'asc' }, { scope_ref_id: 'asc' }] } },
      orderBy: [{ event_start_date: 'desc' }, { sort_priority: 'desc' }, { title: 'asc' }, { calendar_event_id: 'desc' }],
    });
    return rows.map((row) => this.toAdminRow(row));
  }

  async create(dto: CreateCalendarEventDto, userId: number) {
    const requestedEventKey = dto.eventKey?.trim();
    const eventKey = requestedEventKey || await this.generateEventKey(dto.title, dto.eventStartDate);
    const data = this.toCreateData(dto, userId, eventKey);
    const existing = await this.prisma.dvi_calendar_events.findUnique({ where: { event_key: data.event_key } });
    if (existing) throw new BadRequestException('A holiday with this event key already exists.');

    const india = await this.prisma.dvi_countries.findFirst({
      where: { name: 'India', status: 1, deleted: 0 },
      select: { id: true },
    });
    if (!india) throw new BadRequestException('India country master data is required for a new holiday.');

    try {
      const row = await this.prisma.dvi_calendar_events.create({
        data: {
          ...data,
          createdby: userId,
          scopes: { create: [{ scope_type: 'NATIONAL', scope_ref_id: india.id }] },
        },
        include: { scopes: { where: { deleted: 0 } } },
      });
      return this.toAdminRow(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException('A holiday with these details already exists.');
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateCalendarEventDto) {
    const existing = await this.prisma.dvi_calendar_events.findUnique({ where: { calendar_event_id: id } });
    if (!existing || existing.deleted === 1) throw new NotFoundException('Holiday or festival not found.');

    const data = this.toUpdateData(dto, existing);
    const nextEventKey = typeof data.event_key === 'string' ? data.event_key : undefined;
    if (nextEventKey && nextEventKey !== existing.event_key) {
      const duplicate = await this.prisma.dvi_calendar_events.findUnique({ where: { event_key: nextEventKey } });
      if (duplicate && duplicate.calendar_event_id !== BigInt(id) && duplicate.deleted === 0) {
        throw new BadRequestException('A holiday with this event key already exists.');
      }
    }

    const row = await this.prisma.dvi_calendar_events.update({
      where: { calendar_event_id: id },
      data,
      include: { scopes: { where: { deleted: 0 } } },
    });
    return this.toAdminRow(row);
  }

  async updateStatus(id: number, status: number) {
    if (![0, 1].includes(Number(status))) throw new BadRequestException('Status must be 0 or 1.');
    const existing = await this.prisma.dvi_calendar_events.findUnique({ where: { calendar_event_id: id } });
    if (!existing || existing.deleted === 1) throw new NotFoundException('Holiday or festival not found.');
    const row = await this.prisma.dvi_calendar_events.update({
      where: { calendar_event_id: id },
      data: { status: Number(status) },
      include: { scopes: { where: { deleted: 0 } } },
    });
    return this.toAdminRow(row);
  }

  async remove(id: number) {
    const existing = await this.prisma.dvi_calendar_events.findUnique({ where: { calendar_event_id: id } });
    if (!existing || existing.deleted === 1) throw new NotFoundException('Holiday or festival not found.');
    await this.prisma.dvi_calendar_events.update({ where: { calendar_event_id: id }, data: { deleted: 1, status: 0 } });
  }

  private async generateEventKey(title: string, eventStartDate: string): Promise<string> {
    const year = eventStartDate.slice(0, 4);
    const base = `india-${eventKeySlug(title)}-${year}`.slice(0, 150);
    let candidate = base;
    let suffix = 2;
    while (await this.prisma.dvi_calendar_events.findUnique({ where: { event_key: candidate } })) {
      const suffixText = `-${suffix}`;
      candidate = `${base.slice(0, 150 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    return candidate;
  }

  private toCreateData(dto: CreateCalendarEventDto, userId: number, eventKey: string): Prisma.dvi_calendar_eventsCreateInput {
    const eventStart = parseDateOnly(dto.eventStartDate, 'eventStartDate');
    const eventEnd = parseDateOnly(dto.eventEndDate, 'eventEndDate');
    const windowStart = parseDateOnly(dto.travelWindowStartDate, 'travelWindowStartDate');
    const windowEnd = parseDateOnly(dto.travelWindowEndDate, 'travelWindowEndDate');
    this.validateEventRanges(eventStart, eventEnd, windowStart, windowEnd);
    return {
      event_key: eventKey, title: dto.title.trim(), short_title: dto.shortTitle?.trim() || null,
      event_type: dto.eventType.trim(), event_start_date: eventStart, event_end_date: eventEnd,
      travel_window_start_date: windowStart, travel_window_end_date: windowEnd,
      is_public_holiday: dto.isPublicHoliday ? 1 : 0, travel_impact: dto.travelImpact || 'UNSPECIFIED',
      description: dto.description?.trim() || null, travel_advisory: dto.travelAdvisory?.trim() || null,
      source_name: dto.sourceName?.trim() || null, source_reference: dto.sourceReference?.trim() || null,
      sort_priority: dto.sortPriority ?? 100, createdby: userId, status: dto.status ?? 1, deleted: 0,
    };
  }

  private toUpdateData(dto: UpdateCalendarEventDto, existing: any): Prisma.dvi_calendar_eventsUpdateInput {
    const eventStart = dto.eventStartDate ? parseDateOnly(dto.eventStartDate, 'eventStartDate') : existing.event_start_date;
    const eventEnd = dto.eventEndDate ? parseDateOnly(dto.eventEndDate, 'eventEndDate') : existing.event_end_date;
    const windowStart = dto.travelWindowStartDate ? parseDateOnly(dto.travelWindowStartDate, 'travelWindowStartDate') : existing.travel_window_start_date;
    const windowEnd = dto.travelWindowEndDate ? parseDateOnly(dto.travelWindowEndDate, 'travelWindowEndDate') : existing.travel_window_end_date;
    this.validateEventRanges(eventStart, eventEnd, windowStart, windowEnd);
    return {
      ...(dto.eventKey !== undefined ? { event_key: dto.eventKey.trim() } : {}),
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.shortTitle !== undefined ? { short_title: dto.shortTitle.trim() || null } : {}),
      ...(dto.eventType !== undefined ? { event_type: dto.eventType.trim() } : {}),
      ...(dto.eventStartDate !== undefined ? { event_start_date: eventStart } : {}),
      ...(dto.eventEndDate !== undefined ? { event_end_date: eventEnd } : {}),
      ...(dto.travelWindowStartDate !== undefined ? { travel_window_start_date: windowStart } : {}),
      ...(dto.travelWindowEndDate !== undefined ? { travel_window_end_date: windowEnd } : {}),
      ...(dto.isPublicHoliday !== undefined ? { is_public_holiday: dto.isPublicHoliday ? 1 : 0 } : {}),
      ...(dto.travelImpact !== undefined ? { travel_impact: dto.travelImpact } : {}),
      ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
      ...(dto.travelAdvisory !== undefined ? { travel_advisory: dto.travelAdvisory.trim() || null } : {}),
      ...(dto.sourceName !== undefined ? { source_name: dto.sourceName.trim() || null } : {}),
      ...(dto.sourceReference !== undefined ? { source_reference: dto.sourceReference.trim() || null } : {}),
      ...(dto.sortPriority !== undefined ? { sort_priority: dto.sortPriority } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
  }

  private validateEventRanges(eventStart: Date, eventEnd: Date, windowStart: Date, windowEnd: Date) {
    if (eventStart > eventEnd) throw new BadRequestException('eventStartDate must be on or before eventEndDate.');
    if (windowStart > windowEnd) throw new BadRequestException('travelWindowStartDate must be on or before travelWindowEndDate.');
  }

  private toAdminRow(row: any) {
    return {
      id: String(row.calendar_event_id), eventKey: row.event_key, title: row.title, shortTitle: row.short_title,
      eventType: row.event_type, eventStartDate: formatDateOnly(row.event_start_date, 'event_start_date'),
      eventEndDate: formatDateOnly(row.event_end_date, 'event_end_date'),
      travelWindowStartDate: formatDateOnly(row.travel_window_start_date, 'travel_window_start_date'),
      travelWindowEndDate: formatDateOnly(row.travel_window_end_date, 'travel_window_end_date'),
      isPublicHoliday: row.is_public_holiday === 1, travelImpact: row.travel_impact, sortPriority: row.sort_priority,
      description: row.description, travelAdvisory: row.travel_advisory, sourceName: row.source_name,
      sourceReference: row.source_reference, status: row.status === 1,
      scopes: (row.scopes || []).map((scope: any) => ({ id: String(scope.calendar_event_scope_id), scopeType: scope.scope_type, scopeRefId: scope.scope_ref_id })),
    };
  }

  async getEvents(query: CalendarEventsQueryDto) {
    const { from, to } = validateDateRange(query.from, query.to);
    const locations = uniqueStrings(query.location || []);
    const resolution = await this.resolveLocations(locations);

    let scopes: ScopeFilter[] = resolution.resolvedLocations.flatMap((location) => [
      { scope_type: 'NATIONAL', scope_ref_id: location.countryId },
      { scope_type: 'STATE', scope_ref_id: location.stateId },
      { scope_type: 'CITY', scope_ref_id: location.cityId },
    ]);

    if (resolution.resolvedLocations.length === 0) {
      const india = await this.prisma.dvi_countries.findFirst({
        where: { name: 'India', status: 1, deleted: 0 },
        select: { id: true },
      });
      scopes = india ? [{ scope_type: 'NATIONAL', scope_ref_id: india.id }] : [];
    }

    const uniqueScopes = Array.from(
      new Map(scopes.map((scope) => [`${scope.scope_type}:${scope.scope_ref_id}`, scope])).values(),
    );
    const matchingScopeWhere = {
      status: 1,
      deleted: 0,
      OR: uniqueScopes,
    };

    const rows = uniqueScopes.length
      ? await this.prisma.dvi_calendar_events.findMany({
          where: {
            status: 1,
            deleted: 0,
            travel_window_start_date: { lte: to },
            travel_window_end_date: { gte: from },
            scopes: { some: matchingScopeWhere },
          },
          include: {
            scopes: {
              where: matchingScopeWhere,
              orderBy: [{ scope_type: 'asc' }, { scope_ref_id: 'asc' }],
            },
          },
          orderBy: [
            { travel_window_start_date: 'asc' },
            { sort_priority: 'desc' },
            { title: 'asc' },
            { calendar_event_id: 'asc' },
          ],
        })
      : [];

    const seen = new Set<string>();
    const events = rows
      .filter((row) => {
        const key = String(row.calendar_event_id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((row) => ({
        id: String(row.calendar_event_id),
        eventKey: row.event_key,
        title: row.title,
        shortTitle: row.short_title,
        eventType: row.event_type,
        eventStartDate: formatDateOnly(row.event_start_date, 'event_start_date'),
        eventEndDate: formatDateOnly(row.event_end_date, 'event_end_date'),
        travelWindowStartDate: formatDateOnly(row.travel_window_start_date, 'travel_window_start_date'),
        travelWindowEndDate: formatDateOnly(row.travel_window_end_date, 'travel_window_end_date'),
        isPublicHoliday: row.is_public_holiday === 1,
        travelImpact: row.travel_impact,
        sortPriority: row.sort_priority,
        description: row.description,
        travelAdvisory: row.travel_advisory,
        scopes: row.scopes.map((scope) => ({
          id: String(scope.calendar_event_scope_id),
          scopeType: scope.scope_type,
          scopeRefId: scope.scope_ref_id,
        })),
      }));

    return {
      from: query.from,
      to: query.to,
      resolvedLocations: resolution.resolvedLocations,
      unresolvedLocations: resolution.unresolvedLocations,
      events,
    };
  }

  private async resolveLocations(locations: string[]) {
    if (!locations.length) return { resolvedLocations: [] as ResolvedLocation[], unresolvedLocations: [] as string[] };

    const storedRows = await this.prisma.dvi_stored_locations.findMany({
      where: {
        status: 1,
        deleted: 0,
        OR: [
          { source_location: { in: locations } },
          { destination_location: { in: locations } },
        ],
      },
      select: {
        source_location: true,
        source_city_id: true,
        destination_location: true,
        destination_city_id: true,
      },
    });

    const storedCityByLocation = new Map<string, number>();
    for (const row of storedRows) {
      if (row.source_city_id) storedCityByLocation.set(locationKey(row.source_location), Number(row.source_city_id));
      if (row.destination_city_id) storedCityByLocation.set(locationKey(row.destination_location), Number(row.destination_city_id));
    }

    const cityIdByInput = new Map<string, number>();
    for (const input of locations) {
      const storedCityId = storedCityByLocation.get(locationKey(input));
      if (storedCityId) {
        cityIdByInput.set(input, storedCityId);
        continue;
      }
      const fallback = await resolveCityRecordByName(this.prisma, input);
      if (fallback?.id) cityIdByInput.set(input, fallback.id);
    }

    const cityIds = Array.from(new Set(Array.from(cityIdByInput.values())));
    const cities = cityIds.length
      ? await this.prisma.dvi_cities.findMany({
          where: { id: { in: cityIds }, status: 1, deleted: 0 },
          select: { id: true, name: true, state_id: true },
        })
      : [];
    const stateIds = Array.from(new Set(cities.map((city) => Number(city.state_id)).filter(Boolean)));
    const states = stateIds.length
      ? await this.prisma.dvi_states.findMany({
          where: { id: { in: stateIds }, deleted: 0 },
          select: { id: true, name: true, country_id: true },
        })
      : [];
    const countryIds = Array.from(new Set(states.map((state) => Number(state.country_id)).filter(Boolean)));
    const countries = countryIds.length
      ? await this.prisma.dvi_countries.findMany({
          where: { id: { in: countryIds }, status: 1, deleted: 0 },
          select: { id: true, name: true },
        })
      : [];

    const cityById = new Map(cities.map((city) => [city.id, city]));
    const stateById = new Map(states.map((state) => [state.id, state]));
    const countryById = new Map(countries.map((country) => [country.id, country]));
    const resolvedLocations: ResolvedLocation[] = [];
    const unresolvedLocations: string[] = [];

    for (const input of locations) {
      const city = cityById.get(cityIdByInput.get(input) || 0);
      const state = city ? stateById.get(city.state_id) : undefined;
      const country = state ? countryById.get(state.country_id) : undefined;
      if (!city || !state || !country) {
        unresolvedLocations.push(input);
        continue;
      }
      resolvedLocations.push({
        input,
        cityId: city.id,
        cityName: city.name,
        stateId: state.id,
        stateName: state.name,
        countryId: country.id,
        countryName: country.name,
      });
    }
    return { resolvedLocations, unresolvedLocations };
  }
}
