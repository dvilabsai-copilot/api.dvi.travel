import { normalizeCityName as normalizeCityNameShared } from '../../utils/city-normalization.util';
import { normalizeRouteCityKey } from '../../services/same-city-cross-day-optimizer.shared';
import { timeToSeconds } from './time.helper';

export type CarryForwardRouteContext = {
  routeId: number;
  routeDay: number;
  sourceCity: string;
  destinationCity: string;
};

export class TimelineRoutePolicyService {
  normalizeCityName(name: string): string {
    return normalizeCityNameShared(name);
  }

  canonicalCityKey(name: string): string {
    const raw = String(name ?? '').split('|')[0]?.trim() ?? '';
    if (!raw) return '';
    const beforeComma = raw.split(',')[0]?.trim() ?? '';
    return this.normalizeCityName(beforeComma) || this.normalizeCityName(raw);
  }

  isSameCity(a: string, b: string): boolean {
    const left = this.canonicalCityKey(a);
    const right = this.canonicalCityKey(b);
    return !!left && left === right;
  }

  getSameCityRouteKey(route: { location_name?: string | null; next_visiting_location?: string | null } | null | undefined): string {
    if (!route) return '';
    return this.canonicalCityKey(normalizeRouteCityKey(route.location_name, route.next_visiting_location));
  }

  buildReservedSameCityHotspotIdsByRoute(
    routes: Array<{ itinerary_route_ID?: number | null; location_name?: string | null; next_visiting_location?: string | null }>,
    existingHotspots: any[] | undefined,
  ): Map<number, Set<number>> {
    const routeCityKeyById = new Map<number, string>();
    for (const route of routes) {
      const routeId = Number(route?.itinerary_route_ID || 0);
      const cityKey = this.getSameCityRouteKey(route);
      if (routeId && cityKey) routeCityKeyById.set(routeId, cityKey);
    }
    if (routeCityKeyById.size === 0 || !Array.isArray(existingHotspots) || existingHotspots.length === 0) {
      return new Map<number, Set<number>>();
    }
    const cityReservedIds = new Map<string, Set<number>>();
    const routeReservedIds = new Map<number, Set<number>>();
    for (const row of existingHotspots) {
      if (Number(row?.deleted || 0) !== 0) continue;
      const routeId = Number(row?.itinerary_route_ID || 0);
      const hotspotId = Number(row?.hotspot_ID || 0);
      if (!routeId || !hotspotId || Number(row?.item_type || 0) !== 4) continue;
      const cityKey = routeCityKeyById.get(routeId);
      if (!cityKey) continue;
      if (!cityReservedIds.has(cityKey)) cityReservedIds.set(cityKey, new Set<number>());
      cityReservedIds.get(cityKey)!.add(hotspotId);
      if (!routeReservedIds.has(routeId)) routeReservedIds.set(routeId, new Set<number>());
      routeReservedIds.get(routeId)!.add(hotspotId);
    }
    const reservedByRoute = new Map<number, Set<number>>();
    for (const route of routes) {
      const routeId = Number(route?.itinerary_route_ID || 0);
      const cityKey = routeCityKeyById.get(routeId);
      const cityIds = cityKey ? cityReservedIds.get(cityKey) : undefined;
      if (!routeId || !cityIds?.size) continue;
      const ownIds = routeReservedIds.get(routeId) || new Set<number>();
      const reservedIds = new Set<number>([...cityIds].filter((hotspotId) => !ownIds.has(hotspotId)));
      if (reservedIds.size > 0) reservedByRoute.set(routeId, reservedIds);
    }
    return reservedByRoute;
  }

  hotspotLocationMatchesCity(
    hotspotLocation: string | null | undefined,
    targetCity: string | null | undefined,
  ): boolean {
    const targetKey = this.canonicalCityKey(String(targetCity || ''));
    if (!targetKey) return false;
    const parts = String(hotspotLocation || '')
      .split('|')
      .flatMap((part) => String(part || '').split(','))
      .map((part) => this.canonicalCityKey(part))
      .filter(Boolean);
    return parts.some((part) =>
      part === targetKey ||
      part.startsWith(`${targetKey} `) ||
      part.includes(` ${targetKey} `) ||
      part.endsWith(` ${targetKey}`),
    );
  }

  buildRouteLegs(
    sourceCity: string | null | undefined,
    viaLocationNames: string[],
    destinationCity: string | null | undefined,
  ): string[] {
    const rawLegs = [
      String(sourceCity || '').trim(),
      ...(Array.isArray(viaLocationNames) ? viaLocationNames : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
      String(destinationCity || '').trim(),
    ].filter(Boolean);
    const legs: string[] = [];
    for (const leg of rawLegs) {
      const previous = legs[legs.length - 1];
      if (previous && this.canonicalCityKey(previous) === this.canonicalCityKey(leg)) continue;
      legs.push(leg);
    }
    return legs;
  }

  routeSpecificHotspotMatchesRouteChain(
    hotspotLocation: string | null | undefined,
    hotspotToLocation: string | null | undefined,
    routeLegs: string[],
  ): { matches: boolean; fromIndex: number; toIndex: number } {
    const legs = Array.isArray(routeLegs) ? routeLegs.filter(Boolean) : [];
    if (legs.length < 2) return { matches: false, fromIndex: -1, toIndex: -1 };
    for (let toIndex = 1; toIndex < legs.length; toIndex += 1) {
      if (!this.hotspotLocationMatchesCity(hotspotToLocation, legs[toIndex])) continue;
      for (let fromIndex = toIndex - 1; fromIndex >= 0; fromIndex -= 1) {
        if (this.hotspotLocationMatchesCity(hotspotLocation, legs[fromIndex])) {
          return { matches: true, fromIndex, toIndex };
        }
      }
    }
    return { matches: false, fromIndex: -1, toIndex: -1 };
  }

  routeMovementOrder(
    fromIndex: number,
    toIndex: number,
    kind: 'en_route' | 'via_stop' | 'via_city' = 'en_route',
  ): number {
    const safeFrom = Number.isFinite(fromIndex) && fromIndex >= 0 ? fromIndex : 999;
    const safeTo = Number.isFinite(toIndex) && toIndex >= 0 ? toIndex : safeFrom + 1;
    if (kind === 'en_route') return safeFrom * 100 + 20;
    if (kind === 'via_stop') return Math.max(0, safeTo - 1) * 100 + 90;
    return Math.max(0, safeTo - 1) * 100 + 95;
  }

  hotspotNameMatchesLocation(hotspot: Record<string, any>, locationName: string | null | undefined): boolean {
    const targetKey = this.canonicalCityKey(String(locationName || ''));
    if (!targetKey) return false;
    const candidates = [hotspot?.hotspot_name, hotspot?.hotspot_landmark, hotspot?.hotspot_address, hotspot?.address]
      .map((value) => this.canonicalCityKey(String(value || '')))
      .filter(Boolean);
    return candidates.some((candidateKey) =>
      candidateKey === targetKey || candidateKey.includes(targetKey) || targetKey.includes(candidateKey),
    );
  }

  isCarryForwardHotspotCompatibleWithRoute(
    hotspot: Record<string, any>,
    routeContext: CarryForwardRouteContext,
  ): { compatible: boolean; reason: string; hotspotLocation: string; hotspotToLocation: string } {
    const hotspotLocation = String(hotspot.hotspot_location ?? hotspot.hotspotLocation ?? hotspot.location_name ?? '');
    const hotspotToLocation = String(hotspot.hotspot_to_location ?? hotspot.hotspotToLocation ?? hotspotLocation ?? '');
    const sourceKey = this.canonicalCityKey(routeContext.sourceCity);
    const destinationKey = this.canonicalCityKey(routeContext.destinationCity);
    const sameCityRoute = !!sourceKey && !!destinationKey && sourceKey === destinationKey;
    const compatible =
      this.hotspotLocationMatchesCity(hotspotLocation, routeContext.sourceCity) ||
      this.hotspotLocationMatchesCity(hotspotToLocation, routeContext.sourceCity) ||
      this.hotspotLocationMatchesCity(hotspotLocation, routeContext.destinationCity) ||
      this.hotspotLocationMatchesCity(hotspotToLocation, routeContext.destinationCity);
    return {
      compatible,
      reason: compatible
        ? (sameCityRoute ? 'same_city_compatible' : 'intercity_endpoint_compatible')
        : (sameCityRoute ? 'same_city_location_mismatch' : 'intercity_location_mismatch'),
      hotspotLocation,
      hotspotToLocation,
    };
  }

  estimateRouteHotspotCapacity(route: { route_start_time?: unknown; route_end_time?: unknown } | null | undefined): number {
    if (!route) return 0;
    const startRaw = typeof route.route_start_time === 'string' ? String(route.route_start_time) : '09:00:00';
    const endRaw = typeof route.route_end_time === 'string' ? String(route.route_end_time) : '18:00:00';
    let startSecs = timeToSeconds(startRaw);
    let endSecs = timeToSeconds(endRaw);
    if (endSecs < startSecs) endSecs += 86400;
    const effectiveSecs = Math.max(0, endSecs - startSecs - 60 * 60);
    return Math.max(1, Math.floor(effectiveSecs / (100 * 60)));
  }
}
