import { HotspotDetailRow } from './types';
import { normalizeCityName } from '../../utils/city-normalization.util';
import { timeToSeconds } from './time.helper';

export type FixedTimelineAnchor = {
  kind: 'route_start' | 'hotspot' | 'route_end';
  startSeconds: number;
  endSeconds: number;
  hotspotId?: number;
};

export type RealGapInterval = { start: number; end: number; durationSeconds: number };
export type SameCityContinuationContext = { isSameCityChainContinuation: boolean; previousDayHotspotIds: Set<number> };

export class TimelineAnchorPolicyService {
  hasUsableCoords(coords?: { lat: number; lon: number } | null): coords is { lat: number; lon: number } {
    if (!coords) return false;
    const lat = Number(coords.lat);
    const lon = Number(coords.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
  }

  normalizePlaceLookupKey(value: string | null | undefined): string {
    return String(value || '')
      .split('|')[0]
      .split(',')[0]
      .replace(/\binternational\b/gi, ' ')
      .replace(/\bdomestic\b/gi, ' ')
      .replace(/\bair\s*port\b/gi, ' ')
      .replace(/\bairport\b/gi, ' ')
      .replace(/\brailway\b/gi, ' ')
      .replace(/\bstation\b/gi, ' ')
      .replace(/\bterminal\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  toAbsoluteSecondsForRoute(timeValue: string, routeStartSeconds: number): number {
    let seconds = timeToSeconds(timeValue);
    if (seconds < routeStartSeconds) seconds += 86400;
    return seconds;
  }

  toStoredTimeString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
    }
    return null;
  }

  buildFixedTimelineAnchors(
    hotspotRows: HotspotDetailRow[],
    routeId: number,
    routeStartSeconds: number,
    routeEndSeconds: number,
    currentTime: string,
  ): FixedTimelineAnchor[] {
    const currentAbs = this.toAbsoluteSecondsForRoute(currentTime, routeStartSeconds);
    const anchors: FixedTimelineAnchor[] = [{
      kind: 'route_start',
      startSeconds: Math.max(routeStartSeconds, currentAbs),
      endSeconds: Math.max(routeStartSeconds, currentAbs),
    }];
    const routeVisits = hotspotRows
      .filter((row) => Number((row as any).itinerary_route_ID || 0) === routeId && Number((row as any).item_type || 0) === 4)
      .map((row) => {
        const start = this.toStoredTimeString((row as any).hotspot_start_time) || '00:00:00';
        const end = this.toStoredTimeString((row as any).hotspot_end_time) || start;
        const absStart = this.toAbsoluteSecondsForRoute(start, routeStartSeconds);
        const absEndRaw = this.toAbsoluteSecondsForRoute(end, routeStartSeconds);
        return {
          kind: 'hotspot' as const,
          startSeconds: absStart,
          endSeconds: absEndRaw < absStart ? absEndRaw + 86400 : absEndRaw,
          hotspotId: Number((row as any).hotspot_ID || 0),
        };
      })
      .sort((a, b) => a.startSeconds - b.startSeconds);
    anchors.push(...routeVisits);
    anchors.push({ kind: 'route_end', startSeconds: routeEndSeconds, endSeconds: routeEndSeconds });
    return anchors;
  }

  buildRealGapIntervals(anchors: FixedTimelineAnchor[]): RealGapInterval[] {
    if (!anchors.length) return [];
    const sorted = [...anchors].sort((a, b) => a.startSeconds - b.startSeconds);
    const gaps: RealGapInterval[] = [];
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const current = sorted[i];
      const next = sorted[i + 1];
      const gapStart = Math.max(current.endSeconds, current.startSeconds);
      const gapEnd = Math.max(next.startSeconds, gapStart);
      const durationSeconds = Math.max(0, gapEnd - gapStart);
      if (durationSeconds > 0) gaps.push({ start: gapStart, end: gapEnd, durationSeconds });
    }
    return gaps;
  }

  buildSameCityContinuationContext(
    route: { itinerary_route_ID?: number; location_name?: string | null; next_visiting_location?: string | null },
    previousRoute: { itinerary_route_ID?: number; location_name?: string | null; next_visiting_location?: string | null } | undefined,
    hotspotRows: HotspotDetailRow[],
  ): SameCityContinuationContext {
    const previousDayHotspotIds = new Set<number>();
    if (!previousRoute) return { isSameCityChainContinuation: false, previousDayHotspotIds };
    const cityKey = (value: unknown) => normalizeCityName(String(value || '').split('|')[0]);
    const currentCityKey = cityKey(route.location_name || route.next_visiting_location);
    const prevDestKey = cityKey(previousRoute.next_visiting_location);
    const prevSourceKey = cityKey(previousRoute.location_name);
    const isSameCityChainContinuation = !!currentCityKey && (currentCityKey === prevDestKey || currentCityKey === prevSourceKey);
    if (isSameCityChainContinuation) {
      const prevRouteId = Number(previousRoute.itinerary_route_ID || 0);
      for (const row of hotspotRows) {
        if (Number((row as any).itinerary_route_ID || 0) !== prevRouteId) continue;
        if (Number((row as any).item_type || 0) !== 4) continue;
        const hotspotId = Number((row as any).hotspot_ID || 0);
        if (hotspotId > 0) previousDayHotspotIds.add(hotspotId);
      }
    }
    return { isSameCityChainContinuation, previousDayHotspotIds };
  }

  parsePlanDateTime(value: unknown): Date | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  extractPlanTimeOfDaySeconds(value: unknown): number | null {
    if (typeof value === 'string' && value.trim()) {
      const match = value.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
    }
    const parsed = this.parsePlanDateTime(value);
    return parsed ? parsed.getUTCHours() * 3600 + parsed.getUTCMinutes() * 60 + parsed.getUTCSeconds() : null;
  }

  getTravelLocationType(startLocation: string, endLocation: string): 1 | 2 {
    const starts = startLocation.split('|').map((value) => value.trim());
    const ends = endLocation.split('|').map((value) => value.trim());
    return starts.some((start) => ends.some((end) => start === end)) ? 1 : 2;
  }
}
