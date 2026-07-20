import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { CreateItineraryDto } from '../itineraries/dto/create-itinerary.dto';
import {
  CreateRouteVehicleRestrictionDto,
  EvaluateRouteVehicleRestrictionDto,
  RouteVehicleRestrictionLegDto,
  UpdateRouteVehicleRestrictionDto,
} from './dto/route-vehicle-restriction.dto';

type Leg = {
  sourceLocation: string;
  destinationLocation: string;
  routeDate: Date;
  startTime: string;
  endTime: string;
  viaRouteLocationId?: number | null;
  itineraryRouteId?: number;
};

type Conflict = {
  ruleCode: string;
  title: string;
  vehicleTypeIds: number[];
  sourceLocation: string;
  destinationLocation: string;
  timeWindow: string;
  plannedWindow: string;
  message: string;
  allowedVehicleTypes?: string[];
  enforcementMode: string;
  ghatEntry?: {
    name: string;
    latitude: number;
    longitude: number;
    distanceKm: number | null;
    durationMinutes: number | null;
    estimatedTime: string;
  };
};

type GhatBoundary = {
  name: string;
  latitude: number;
  longitude: number;
  detectionRadiusMetres: number;
  exit?: {
    name: string;
    latitude: number;
    longitude: number;
  };
};

const OOTY_GHAT_BOUNDARIES: Record<string, GhatBoundary> = {
  '15638': {
    name: 'Ooty Mountain Base / Kallar Forest Checkpost',
    latitude: 11.3371457,
    longitude: 76.8701544,
    detectionRadiusMetres: 700,
  },
  '15639': {
    name: 'Lower Coonoor / Coonoor Railway Station',
    latitude: 11.343714,
    longitude: 76.791337,
    detectionRadiusMetres: 700,
  },
};

@Injectable()
export class RouteVehicleRestrictionService {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private number(value: unknown): number {
    return Number(value || 0);
  }

  private timeToMinutes(value: unknown): number {
    if (value instanceof Date) {
      return (value.getUTCHours() * 60) + value.getUTCMinutes();
    }
    const raw = String(value || '00:00:00');
    const match = raw.match(/(?:T|\s|^)(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!match) return 0;
    return (Number(match[1] || 0) * 60) + Number(match[2] || 0);
  }

  private timeValue(value: string | null | undefined): Date | null {
    if (!value) return null;
    const [h, m, s] = value.split(':').map((part) => Number(part || 0));
    return new Date(Date.UTC(1970, 0, 1, h, m, s));
  }

  private displayTime(value: unknown): string {
    const minutes = this.timeToMinutes(value);
    const hour24 = Math.floor(minutes / 60) % 24;
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
  }

  private dateValue(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private dateKey(value: Date): string {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }

  private dayMask(value: Date): number {
    return 1 << value.getUTCDay();
  }

  private asBigInt(value: unknown): bigint {
    return BigInt(Math.trunc(Number(value || 0)));
  }

  private jsonSnapshot(value: unknown): any {
    return JSON.parse(JSON.stringify(value, (_key, item) => (
      typeof item === 'bigint' ? item.toString() : item
    )));
  }

  private normalizedPlace(value: unknown): string {
    return String(value || '')
      .toLowerCase()
      .replace(/tirupathi/g, 'tirupati')
      .replace(/[^a-z0-9]/g, '');
  }

  private isTirupatiRoundTrip(leg: Leg): boolean {
    const source = this.normalizedPlace(leg.sourceLocation);
    const destination = this.normalizedPlace(leg.destinationLocation);
    return source === destination && source.includes('tirupati');
  }

  private durationToMinutes(value: unknown): number {
    if (value instanceof Date) return this.timeToMinutes(value);
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 0;
    const hours = Number(raw.match(/(\d+(?:\.\d+)?)\s*hours?/)?.[1] || 0);
    const minutes = Number(raw.match(/(\d+)\s*mins?/)?.[1] || 0);
    if (hours || minutes) return Math.max(0, Math.round((hours * 60) + minutes));
    return this.timeToMinutes(raw);
  }

  private wallClockTimeFromMinutes(value: number): string {
    const minutes = ((Math.round(value) % (24 * 60)) + (24 * 60)) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
  }

  private async tirumalaRoute(db: any): Promise<{ sourceLocation: string; destinationLocation: string; travelMinutes: number } | null> {
    const rows = await db.dvi_stored_locations.findMany({
      where: {
        status: 1,
        deleted: 0,
        OR: [
          { source_location: { contains: 'Tirupati' }, destination_location: { contains: 'Tirumala' } },
          { source_location: { contains: 'Tirumala' }, destination_location: { contains: 'Tirupati' } },
        ],
      },
      select: { source_location: true, destination_location: true, duration: true },
    });
    const row = rows
      .filter((candidate: any) => {
        const source = this.normalizedPlace(candidate.source_location);
        const destination = this.normalizedPlace(candidate.destination_location);
        return source.includes('tirupati') && destination === 'tirumala';
      })
      .sort((left: any, right: any) => {
        const score = (candidate: any) => {
          const source = this.normalizedPlace(candidate.source_location);
          if (source === 'tirupatiandhrapradeshindia') return 0;
          if (source === 'tirupati') return 1;
          return 2;
        };
        return score(left) - score(right);
      })[0];
    if (!row) return null;
    return {
      sourceLocation: String(row.source_location || 'Tirupati'),
      destinationLocation: String(row.destination_location || 'Tirumala'),
      travelMinutes: this.durationToMinutes(row.duration),
    };
  }

  private async tirumalaHotspotMinutes(db: any): Promise<number> {
    const rows = await db.dvi_hotspot_place.findMany({
      where: {
        status: 1,
        deleted: 0,
        OR: [
          { hotspot_name: { contains: 'Tirumala' } },
          { hotspot_location: { contains: 'Tirumala' } },
          { hotspot_to_location: { contains: 'Tirumala' } },
        ],
      },
      select: { hotspot_name: true, hotspot_location: true, hotspot_to_location: true, hotspot_duration: true },
    });
    const row = rows.find((candidate: any) => {
      const text = `${candidate.hotspot_name || ''} ${candidate.hotspot_location || ''} ${candidate.hotspot_to_location || ''}`.toLowerCase();
      return text.includes('tirumala') && (text.includes('temple') || text.includes('venkateswara') || text.includes('balaji'));
    });
    return this.durationToMinutes(row?.hotspot_duration);
  }

  private async expandTirupatiRoundTrips(legs: Leg[], db: any): Promise<Leg[]> {
    const roundTrips = legs.filter((leg) => this.isTirupatiRoundTrip(leg));
    if (!roundTrips.length) return legs;

    const [tirumalaRoute, hotspotMinutes] = await Promise.all([
      this.tirumalaRoute(db),
      this.tirumalaHotspotMinutes(db),
    ]);
    const travelMinutes = tirumalaRoute?.travelMinutes || 0;
    const expanded: Leg[] = [];
    for (const leg of legs) {
      expanded.push(leg);
      if (!this.isTirupatiRoundTrip(leg)) continue;

      const ascentStart = this.timeToMinutes(leg.startTime);
      const ascentEnd = travelMinutes > 0 ? ascentStart + travelMinutes : this.timeToMinutes(leg.endTime);
      const descentStart = ascentEnd + hotspotMinutes;
      const descentEnd = travelMinutes > 0 ? descentStart + travelMinutes : this.timeToMinutes(leg.endTime);
      expanded.push(
        {
          ...leg,
          sourceLocation: tirumalaRoute?.sourceLocation || leg.sourceLocation,
          destinationLocation: tirumalaRoute?.destinationLocation || 'Tirumala',
          startTime: this.wallClockTimeFromMinutes(ascentStart),
          endTime: this.wallClockTimeFromMinutes(ascentEnd),
        },
        {
          ...leg,
          sourceLocation: tirumalaRoute?.destinationLocation || 'Tirumala',
          destinationLocation: tirumalaRoute?.sourceLocation || leg.destinationLocation,
          startTime: this.wallClockTimeFromMinutes(descentStart),
          endTime: this.wallClockTimeFromMinutes(descentEnd),
        },
      );
    }
    return expanded;
  }

  private extractWallTime(value: unknown, fallback: string): string {
    const match = String(value || '').match(/[T ](\d{2}:\d{2}(?::\d{2})?)/);
    return match?.[1]?.length === 5 ? `${match[1]}:00` : match?.[1] || fallback;
  }

  private projectedCreateLegs(dto: CreateItineraryDto): Leg[] {
    const plan: any = dto.plan || {};
    const tripStartTime = this.extractWallTime(plan.trip_start_date || plan.pick_up_date_and_time, '08:00:00');
    const tripEndTime = this.extractWallTime(plan.trip_end_date, '20:00:00');
    const rows = Array.isArray(dto.routes) ? dto.routes : [];
    return rows.map((route: any, index: number) => {
      const sourceLocation = String(route.location_name || '').trim();
      const destinationLocation = String(route.next_visiting_location || '').trim();
      const firstRoute = index === 0;
      const lastRoute = index === rows.length - 1;
      return {
        sourceLocation,
        destinationLocation,
        routeDate: new Date(route.itinerary_route_date),
        startTime: route.route_start_time || (firstRoute ? tripStartTime : '08:00:00'),
        endTime: route.route_end_time || (lastRoute ? tripEndTime : '20:00:00'),
        viaRouteLocationId: route.via_routes?.[0]?.itinerary_via_location_ID || null,
      };
    }).filter((leg) => leg.sourceLocation && leg.destinationLocation && Number.isFinite(leg.routeDate.getTime()));
  }

  private haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const earthRadiusKm = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private boundaryForRule(rule: any, route: any): GhatBoundary | null {
    let sourceReference: any = null;
    try {
      sourceReference = rule.source_reference ? JSON.parse(String(rule.source_reference)) : null;
    } catch {
      sourceReference = null;
    }
    const forward = sourceReference?.forwardDirection;
    const reverse = sourceReference?.reverseDirection;
    const routeText = `${String(route.source_location || '').trim()} to ${String(route.destination_location || '').trim()}`.toLowerCase();
    const forwardText = String(forward?.route || '').trim().toLowerCase();
    const reverseText = String(reverse?.route || '').trim().toLowerCase();
    const directionalPoint = routeText && reverseText && routeText === reverseText
      ? reverse?.entry
      : routeText && forwardText && routeText === forwardText
        ? forward?.entry
        : null;
    const directional = routeText && reverseText && routeText === reverseText ? reverse : routeText && forwardText && routeText === forwardText ? forward : null;
    const configured = directionalPoint || sourceReference?.routeBoundaries?.[String(route.location_ID)]?.ghatStart;
    const fallback = OOTY_GHAT_BOUNDARIES[String(route.location_ID)];
    const boundary = configured || fallback;
    if (!boundary) return null;
    const latitude = Number(boundary.latitude);
    const longitude = Number(boundary.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const exit = directional?.exit;
    const exitLatitude = Number(exit?.latitude);
    const exitLongitude = Number(exit?.longitude);
    return {
      name: String(boundary.name || 'Ghat-road boundary'),
      latitude,
      longitude,
      detectionRadiusMetres: Number(boundary.detectionRadiusMetres || sourceReference?.detectionRadiusMetres || 700),
      ...(Number.isFinite(exitLatitude) && Number.isFinite(exitLongitude) ? {
        exit: { name: String(exit.name || 'Ghat-road exit'), latitude: exitLatitude, longitude: exitLongitude },
      } : {}),
    };
  }

  private async routeDurationToBoundary(route: any, boundary: GhatBoundary, db: any): Promise<{ distanceKm: number | null; durationMinutes: number | null } | null> {
    const totalDistanceKm = Number(route.distance);
    const totalDurationMinutes = this.durationToMinutes(route.duration);
    const durationFromStoredRouteProfile = (distanceKm: number | null): number | null => {
      if (!Number.isFinite(distanceKm) || distanceKm == null || distanceKm <= 0) return null;
      if (!Number.isFinite(totalDistanceKm) || totalDistanceKm <= 0 || totalDurationMinutes <= 0) return null;
      return Math.max(1, Math.round(totalDurationMinutes * (distanceKm / totalDistanceKm)));
    };
    const viaRows = await db.dvi_stored_location_via_routes.findMany({
      where: { location_id: this.asBigInt(route.location_ID), status: 1, deleted: 0 },
      select: {
        via_route_location_lattitude: true,
        via_route_location_longitude: true,
        distance_from_source_to_via_route: true,
        duration_from_source_to_via_route: true,
      },
    });
    const matchingVia = viaRows.find((row: any) => {
      const latitude = Number(row.via_route_location_lattitude);
      const longitude = Number(row.via_route_location_longitude);
      return Number.isFinite(latitude)
        && Number.isFinite(longitude)
        && this.haversineKm(latitude, longitude, boundary.latitude, boundary.longitude) * 1000 <= boundary.detectionRadiusMetres;
    });
    if (matchingVia) {
      const distanceKm = Number(matchingVia.distance_from_source_to_via_route || 0) || null;
      return {
        distanceKm,
        durationMinutes: durationFromStoredRouteProfile(distanceKm)
          ?? (this.durationToMinutes(matchingVia.duration_from_source_to_via_route) || null),
      };
    }

    const fromLat = Number(route.source_location_lattitude);
    const fromLng = Number(route.source_location_longitude);
    if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) return null;
    const baseUrl = String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').trim();
    const url = `${baseUrl}/${fromLng},${fromLat};${boundary.longitude},${boundary.latitude}?overview=false&alternatives=false&steps=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const payload: any = await response.json();
      const routeResult = Array.isArray(payload?.routes) ? payload.routes[0] : null;
      if (!routeResult) return null;
      const distanceKm = Number(routeResult.distance) > 0 ? Number(routeResult.distance) / 1000 : null;
      return {
        distanceKm,
        durationMinutes: durationFromStoredRouteProfile(distanceKm)
          ?? (Number(routeResult.duration) > 0 ? Number(routeResult.duration) / 60 : null),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private timeFallsInWindow(value: number, start: number, end: number): boolean {
    const normalized = ((value % (24 * 60)) + (24 * 60)) % (24 * 60);
    const normalizedEnd = end < start ? end + (24 * 60) : end;
    const candidate = normalized < start ? normalized + (24 * 60) : normalized;
    return candidate >= start && candidate <= normalizedEnd;
  }

  private async activeRulesForLeg(leg: Leg, vehicleTypeIds: number[], db: any = this.db) {
    const routes = await db.dvi_stored_locations.findMany({
      where: {
        status: 1,
        deleted: 0,
        OR: [
          { source_location: leg.sourceLocation, destination_location: leg.destinationLocation },
          { source_location: leg.destinationLocation, destination_location: leg.sourceLocation },
        ],
      },
      select: {
        location_ID: true,
        source_location: true,
        destination_location: true,
        source_location_lattitude: true,
        source_location_longitude: true,
        destination_location_lattitude: true,
        destination_location_longitude: true,
        distance: true,
        duration: true,
      },
    });
    const routeIds = routes.map((route: any) => this.asBigInt(route.location_ID));
    if (!routeIds.length) return [];

    const rules = await db.dvi_route_vehicle_restrictions.findMany({
      where: {
        location_id: { in: routeIds },
        status: 1,
        deleted: 0,
        restriction_action: 'BLOCK',
        OR: [
          { applies_to_all_vehicle_types: 1 },
          {
            vehicle_types: {
              some: { vehicle_type_id: { in: vehicleTypeIds }, status: 1, deleted: 0 },
            },
          },
        ],
      },
      include: { vehicle_types: true },
      orderBy: [{ priority: 'asc' }, { route_vehicle_restriction_id: 'asc' }],
    });

    const start = this.timeToMinutes(leg.startTime);
    const endRaw = this.timeToMinutes(leg.endTime);
    const end = endRaw < start ? endRaw + (24 * 60) : endRaw;
    const legDateKey = this.dateKey(leg.routeDate);
    const legDayMask = this.dayMask(leg.routeDate);

    const activeRules: any[] = [];
    for (const rule of rules) {
      const exactRoute = routes.find((route: any) => (
        route.source_location === leg.sourceLocation && route.destination_location === leg.destinationLocation
      ));
      const ruleRoute = routes.find((route: any) => Number(route.location_ID) === Number(rule.location_id));
      const matchedRoute = rule.direction === 'BOTH'
        ? (exactRoute || ruleRoute)
        : rule.direction === 'FORWARD'
          ? (ruleRoute && ruleRoute.source_location === leg.sourceLocation && ruleRoute.destination_location === leg.destinationLocation ? ruleRoute : null)
          : (ruleRoute && ruleRoute.source_location === leg.destinationLocation && ruleRoute.destination_location === leg.sourceLocation ? ruleRoute : null);
      if (!matchedRoute) continue;
      if (rule.via_route_location_id && Number(rule.via_route_location_id) !== Number(leg.viaRouteLocationId || 0)) continue;
      if (rule.effective_from && legDateKey < this.dateKey(new Date(rule.effective_from))) continue;
      if (rule.effective_to && legDateKey > this.dateKey(new Date(rule.effective_to))) continue;
      if (rule.days_of_week_mask && (Number(rule.days_of_week_mask) & legDayMask) === 0) continue;
      if (rule.is_all_day) {
        activeRules.push({ ...rule, matchedRoute });
        continue;
      }

      const ruleStart = this.timeToMinutes(rule.start_local_time);
      const ruleEndRaw = this.timeToMinutes(rule.end_local_time);
      const ruleEnd = ruleEndRaw < ruleStart ? ruleEndRaw + (24 * 60) : ruleEndRaw;
      const boundary = this.boundaryForRule(rule, matchedRoute);
      const boundaryTiming = boundary ? await this.routeDurationToBoundary(matchedRoute, boundary, db) : null;
      const exitTiming = boundary?.exit ? await this.routeDurationToBoundary(matchedRoute, { ...boundary.exit, detectionRadiusMetres: boundary.detectionRadiusMetres }, db) : null;
      // The stored via-route distances are not guaranteed to be monotonic for
      // both configured geofences. Once the route-specific entry geofence is
      // reached, the restriction must be evaluated for this route direction.
      const crossesConfiguredGeofence = !boundary?.exit || boundaryTiming?.durationMinutes != null;
      if (!crossesConfiguredGeofence) continue;
      const ghatEntryMinutes = boundaryTiming?.durationMinutes != null ? start + boundaryTiming.durationMinutes : null;
      const restrictedByBoundaryEntry = ghatEntryMinutes != null
        ? this.timeFallsInWindow(ghatEntryMinutes, ruleStart, ruleEnd)
        : start < ruleEnd && end > ruleStart;
      if (!restrictedByBoundaryEntry) continue;
      activeRules.push({ ...rule, matchedRoute, boundary, boundaryTiming, ghatEntryMinutes });
    }
    return activeRules;
  }

  private async assertNoEnforcedConflicts(vehicleTypeIds: number[], legs: Leg[], reference: string, db: any = this.db) {
    const conflicts: Conflict[] = [];
    const seen = new Set<string>();
    const vehicleCatalog = await db.dvi_vehicle_type.findMany({
      where: { status: 1, deleted: 0 },
      select: { vehicle_type_id: true, vehicle_type_title: true },
      orderBy: { vehicle_type_title: 'asc' },
    });
    for (const leg of legs) {
      const rules = await this.activeRulesForLeg(leg, vehicleTypeIds, db);
      for (const rule of rules) {
        const conflictKey = `${String(rule.route_vehicle_restriction_id)}|${String(leg.itineraryRouteId || 0)}|${this.dateKey(leg.routeDate)}`;
        if (seen.has(conflictKey)) continue;
        seen.add(conflictKey);
        const matchingTypes = rule.applies_to_all_vehicle_types
          ? vehicleTypeIds
          : rule.vehicle_types
            .filter((item: any) => vehicleTypeIds.includes(Number(item.vehicle_type_id)))
            .map((item: any) => Number(item.vehicle_type_id));
        const timeWindow = rule.is_all_day
          ? 'all day'
          : `${this.displayTime(rule.start_local_time)} to ${this.displayTime(rule.end_local_time)}`;
        const plannedWindow = `${this.displayTime(leg.startTime)} to ${this.displayTime(leg.endTime)}`;
        const ghatEntry = rule.boundary && rule.boundaryTiming && rule.ghatEntryMinutes != null
          ? {
            name: rule.boundary.name,
            latitude: rule.boundary.latitude,
            longitude: rule.boundary.longitude,
            distanceKm: rule.boundaryTiming.distanceKm,
            durationMinutes: rule.boundaryTiming.durationMinutes,
            estimatedTime: this.displayTime(this.wallClockTimeFromMinutes(rule.ghatEntryMinutes)),
          }
          : undefined;
        const ghatEntryText = ghatEntry
          ? ` The route reaches the ghat entry at ${ghatEntry.estimatedTime} (${ghatEntry.durationMinutes != null ? `${Math.round(ghatEntry.durationMinutes)} minutes` : 'time unavailable'} after departure${ghatEntry.distanceKm != null ? `, approximately ${ghatEntry.distanceKm.toFixed(1)} km` : ''}) at ${ghatEntry.name}.`
          : '';
        const blockedVehicleTypeIds = rule.applies_to_all_vehicle_types
          ? vehicleCatalog.map((vehicle: any) => Number(vehicle.vehicle_type_id))
          : rule.vehicle_types
            .filter((item: any) => Number(item.status) === 1 && Number(item.deleted) === 0)
            .map((item: any) => Number(item.vehicle_type_id));
        const allowedVehicleTypes = rule.applies_to_all_vehicle_types
          ? []
          : vehicleCatalog
            .filter((vehicle: any) => !blockedVehicleTypeIds.includes(Number(vehicle.vehicle_type_id)))
            .map((vehicle: any) => String(vehicle.vehicle_type_title || '').trim())
            .filter(Boolean);
        const allowedVehicleText = allowedVehicleTypes.length
          ? ` Allowed vehicle types: ${allowedVehicleTypes.join(', ')}.`
          : '';
        const correctiveInstruction = rule.is_all_day && !rule.applies_to_all_vehicle_types
          ? `Choose an allowed vehicle type.${allowedVehicleText}`
          : rule.is_all_day
            ? 'This restriction applies to every vehicle all day. Choose another route.'
          : rule.applies_to_all_vehicle_types
            ? 'This restriction applies to every vehicle. Change the departure time or choose another route.'
            : `Choose an allowed vehicle type or change the departure time.${allowedVehicleText}`;
        conflicts.push({
          ruleCode: rule.rule_code,
          title: rule.title,
          vehicleTypeIds: matchingTypes,
          sourceLocation: leg.sourceLocation,
          destinationLocation: leg.destinationLocation,
          timeWindow,
          plannedWindow,
          allowedVehicleTypes,
          ghatEntry,
          message: rule.is_all_day && !rule.applies_to_all_vehicle_types
            ? `Travel from ${leg.sourceLocation} to ${leg.destinationLocation} is unavailable for the selected vehicle because ${rule.title}. This is a vehicle-type restriction. ${correctiveInstruction}`
            : `Travel from ${leg.sourceLocation} to ${leg.destinationLocation} is unavailable for the selected vehicle because ${rule.title}.${ghatEntryText} The planned route window is ${plannedWindow}. This restriction applies ${timeWindow === 'all day' ? 'all day' : `from ${timeWindow}`}. ${correctiveInstruction}`,
          enforcementMode: rule.enforcement_mode,
        });
        await db.dvi_itinerary_vehicle_restriction_audit.create({
          data: {
            itinerary_plan_id: null,
            itinerary_route_id: leg.itineraryRouteId || null,
            route_vehicle_restriction_id: rule.route_vehicle_restriction_id,
            location_id: rule.location_id,
            vehicle_type_id: matchingTypes[0] || vehicleTypeIds[0],
            source_location: leg.sourceLocation,
            destination_location: leg.destinationLocation,
            evaluated_departure_at: new Date(leg.routeDate),
            evaluated_arrival_at: null,
            timezone_name: rule.timezone_name || 'Asia/Kolkata',
            decision: rule.enforcement_mode === 'ENFORCE' ? 'BLOCKED' : 'SHADOW_CONFLICT',
            evaluation_reference: reference,
            rule_snapshot_json: this.jsonSnapshot(rule),
          },
        }).catch(() => undefined);
      }
    }
    const enforced = conflicts.filter((conflict) => conflict.enforcementMode === 'ENFORCE');
    if (enforced.length) {
      const hasAllDayVehicleRestriction = enforced.some((conflict) => {
        return /This is a vehicle-type restriction/i.test(conflict.message);
      });
      throw new UnprocessableEntityException({
        code: 'VEHICLE_ROUTE_RESTRICTION',
        message: enforced.map((conflict) => conflict.message).join('\n'),
        details: {
          conflicts: enforced,
          correctiveActions: hasAllDayVehicleRestriction
            ? ['Choose a permitted vehicle type.', 'Ask an administrator to review the restriction.']
            : ['Choose a permitted vehicle type.', 'Change the route or departure time.', 'Ask an administrator to review the restriction.'],
        },
      });
    }
    return { conflicts, blocked: false };
  }

  private toRuleData(dto: CreateRouteVehicleRestrictionDto | UpdateRouteVehicleRestrictionDto, userId: number) {
    const start = dto.isAllDay ? null : this.timeValue(dto.startLocalTime);
    const end = dto.isAllDay ? null : this.timeValue(dto.endLocalTime);
    if (!dto.isAllDay && (!start || !end)) throw new BadRequestException('startLocalTime and endLocalTime are required unless isAllDay is true');
    if (dto.effectiveFrom && dto.effectiveTo && new Date(dto.effectiveFrom) > new Date(dto.effectiveTo)) {
      throw new BadRequestException('effectiveFrom cannot be after effectiveTo');
    }
    if (!dto.appliesToAllVehicleTypes && !(dto.vehicleTypeIds || []).length) {
      throw new BadRequestException('Select vehicle types or enable all vehicle types.');
    }
    return {
      rule_code: dto.ruleCode.trim(), title: dto.title.trim(), description: dto.description || null,
      applies_to_all_vehicle_types: dto.appliesToAllVehicleTypes ? 1 : 0,
      location_id: this.asBigInt(dto.locationId), via_route_location_id: dto.viaRouteLocationId ? this.asBigInt(dto.viaRouteLocationId) : null,
      direction: dto.direction, restriction_action: 'BLOCK', is_all_day: dto.isAllDay ? 1 : 0,
      start_local_time: start, end_local_time: end, timezone_name: dto.timezoneName || 'Asia/Kolkata',
      days_of_week_mask: dto.daysOfWeekMask ?? null, effective_from: this.dateValue(dto.effectiveFrom), effective_to: this.dateValue(dto.effectiveTo),
      priority: dto.priority, enforcement_mode: dto.enforcementMode, source_reference: dto.sourceReference || null,
      last_verified_on: this.dateValue(dto.lastVerifiedOn), updatedby: userId,
    };
  }

  async list() {
    return this.db.dvi_route_vehicle_restrictions.findMany({
      where: { deleted: 0 }, include: { vehicle_types: true }, orderBy: [{ status: 'desc' }, { priority: 'asc' }, { title: 'asc' }],
    });
  }

  async get(id: number) {
    const rule = await this.db.dvi_route_vehicle_restrictions.findFirst({ where: { route_vehicle_restriction_id: this.asBigInt(id), deleted: 0 }, include: { vehicle_types: true } });
    if (!rule) throw new NotFoundException('Vehicle route restriction not found');
    return rule;
  }

  async routeOptions(search = '', page = 1, limit = 50) {
    const normalizedSearch = String(search || '').trim().slice(0, 120);
    const normalizedPage = Math.max(1, Math.trunc(Number(page) || 1));
    const normalizedLimit = Math.min(100, Math.max(10, Math.trunc(Number(limit) || 50)));
    const numericSearch = /^\d+$/.test(normalizedSearch) ? this.asBigInt(normalizedSearch) : null;
    const where: any = { status: 1, deleted: 0 };

    if (normalizedSearch) {
      where.OR = [
        { source_location: { contains: normalizedSearch } },
        { destination_location: { contains: normalizedSearch } },
        ...(numericSearch ? [{ location_ID: numericSearch }] : []),
      ];
    }

    const [total, items] = await Promise.all([
      this.db.dvi_stored_locations.count({ where }),
      this.db.dvi_stored_locations.findMany({
        where,
        select: { location_ID: true, source_location: true, destination_location: true, distance: true, duration: true },
        orderBy: { location_ID: 'asc' },
        skip: (normalizedPage - 1) * normalizedLimit,
        take: normalizedLimit,
      }),
    ]);

    return {
      items,
      page: normalizedPage,
      limit: normalizedLimit,
      total,
      hasNextPage: (normalizedPage * normalizedLimit) < total,
    };
  }

  async vehicleOptions() {
    return this.db.dvi_vehicle_type.findMany({ where: { status: 1, deleted: 0 }, select: { vehicle_type_id: true, vehicle_type_title: true, occupancy: true }, orderBy: { vehicle_type_title: 'asc' } });
  }

  async create(dto: CreateRouteVehicleRestrictionDto, userId: number) {
    const created = await this.db.$transaction(async (tx: any) => {
      const rule = await tx.dvi_route_vehicle_restrictions.create({ data: { ...this.toRuleData(dto, userId), createdby: userId, status: 1, deleted: 0 } });
      if (!dto.appliesToAllVehicleTypes && (dto.vehicleTypeIds || []).length) {
        await tx.dvi_route_vehicle_restriction_vehicle_types.createMany({ data: (dto.vehicleTypeIds || []).map((vehicleTypeId) => ({ route_vehicle_restriction_id: rule.route_vehicle_restriction_id, vehicle_type_id: vehicleTypeId, status: 1, deleted: 0 })) });
      }
      return rule;
    });
    return this.get(Number(created.route_vehicle_restriction_id));
  }

  async update(id: number, dto: UpdateRouteVehicleRestrictionDto, userId: number) {
    const ruleId = this.asBigInt(id);
    await this.get(id);
    await this.db.$transaction(async (tx: any) => {
      await tx.dvi_route_vehicle_restrictions.update({ where: { route_vehicle_restriction_id: ruleId }, data: this.toRuleData(dto, userId) });
      await tx.dvi_route_vehicle_restriction_vehicle_types.deleteMany({ where: { route_vehicle_restriction_id: ruleId } });
      if (!dto.appliesToAllVehicleTypes && (dto.vehicleTypeIds || []).length) {
        await tx.dvi_route_vehicle_restriction_vehicle_types.createMany({ data: (dto.vehicleTypeIds || []).map((vehicleTypeId) => ({ route_vehicle_restriction_id: ruleId, vehicle_type_id: vehicleTypeId, status: 1, deleted: 0 })) });
      }
    });
    return this.get(id);
  }

  async remove(id: number, userId: number) {
    await this.get(id);
    return this.db.dvi_route_vehicle_restrictions.update({ where: { route_vehicle_restriction_id: this.asBigInt(id) }, data: { deleted: 1, status: 0, updatedby: userId } });
  }

  async evaluate(dto: EvaluateRouteVehicleRestrictionDto) {
    const legs = await this.expandTirupatiRoundTrips(dto.legs.map((leg) => this.normalizeLeg(leg)), this.db);
    return this.assertNoEnforcedConflicts(dto.vehicleTypeIds, legs, 'manual-evaluation');
  }

  private normalizeLeg(leg: RouteVehicleRestrictionLegDto): Leg {
    const routeDate = new Date(leg.routeDate);
    if (!Number.isFinite(routeDate.getTime())) throw new BadRequestException('Invalid routeDate');
    return { ...leg, routeDate };
  }

  async assertCreateRequest(dto: CreateItineraryDto) {
    if (![2, 3].includes(Number(dto.plan.itinerary_preference))) return;
    const vehicleTypeIds = (dto.vehicles || []).filter((vehicle: any) => Number(vehicle.vehicle_count || 0) > 0).map((vehicle: any) => Number(vehicle.vehicle_type_id)).filter(Boolean);
    if (!vehicleTypeIds.length) return;
    const legs = await this.expandTirupatiRoundTrips(this.projectedCreateLegs(dto), this.db);
    await this.assertNoEnforcedConflicts(vehicleTypeIds, legs, 'create-itinerary');
  }

  async assertPersistedRouteTime(planId: number, routeId: number, startTime: string, endTime: string) {
    const plan = await this.db.dvi_itinerary_plan_details.findUnique({ where: { itinerary_plan_ID: planId }, select: { itinerary_preference: true } });
    if (!plan || ![2, 3].includes(Number(plan.itinerary_preference))) return;
    const vehicles = await this.db.dvi_itinerary_plan_vehicle_details.findMany({ where: { itinerary_plan_id: planId, status: 1, deleted: 0, vehicle_count: { gt: 0 } }, select: { vehicle_type_id: true } });
    const route = await this.db.dvi_itinerary_route_details.findFirst({ where: { itinerary_route_ID: routeId, itinerary_plan_ID: planId, deleted: 0 }, select: { itinerary_route_date: true, location_name: true, next_visiting_location: true } });
    if (!route || !route.itinerary_route_date) return;
    await this.assertNoEnforcedConflicts(vehicles.map((item: any) => Number(item.vehicle_type_id)), [{ sourceLocation: route.location_name || '', destinationLocation: route.next_visiting_location || '', routeDate: new Date(route.itinerary_route_date), startTime, endTime, itineraryRouteId: routeId }], `route-time:${planId}:${routeId}`);
  }

  async assertPersistedPlan(planId: number, reference = `plan-rebuild:${planId}`, db: any = this.db) {
    const plan = await db.dvi_itinerary_plan_details.findUnique({ where: { itinerary_plan_ID: planId }, select: { itinerary_preference: true } });
    if (!plan || ![2, 3].includes(Number(plan.itinerary_preference))) return;
    const [vehicles, routes] = await Promise.all([
      db.dvi_itinerary_plan_vehicle_details.findMany({ where: { itinerary_plan_id: planId, status: 1, deleted: 0, vehicle_count: { gt: 0 } }, select: { vehicle_type_id: true } }),
      db.dvi_itinerary_route_details.findMany({ where: { itinerary_plan_ID: planId, status: 1, deleted: 0 }, select: { itinerary_route_ID: true, itinerary_route_date: true, location_name: true, next_visiting_location: true, route_start_time: true, route_end_time: true } }),
    ]);
    const legs = routes.filter((route: any) => route.itinerary_route_date && route.location_name && route.next_visiting_location).map((route: any) => ({
      itineraryRouteId: route.itinerary_route_ID, sourceLocation: route.location_name, destinationLocation: route.next_visiting_location, routeDate: new Date(route.itinerary_route_date), startTime: String(route.route_start_time || '08:00:00').slice(-8), endTime: String(route.route_end_time || '20:00:00').slice(-8),
    }));
    const expandedLegs = await this.expandTirupatiRoundTrips(legs, db);
    await this.assertNoEnforcedConflicts(vehicles.map((item: any) => Number(item.vehicle_type_id)), expandedLegs, reference, db);
  }
}
