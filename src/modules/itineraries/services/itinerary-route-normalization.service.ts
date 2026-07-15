import { Injectable } from '@nestjs/common';
import { normalizeCityName } from '../utils/city-normalization.util';

export type RouteOptimizationStop = {
  name: string;
  normalizedName: string;
};

export type RouteOptimizationContext = {
  start: string;
  end: string;
  sourceLocations: string[];
  nextVisitingLocations: string[];
  rawFullPath: string[];
  cleanedFullPath: string[];
  rawMiddleLocations: string[];
  movableStops: RouteOptimizationStop[];
  removedDuplicates: RouteOptimizationStop[];
  removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
};

@Injectable()
export class ItineraryRouteNormalizationService {
  normalizeLocationName(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const normalized = normalizeCityName(raw);
    if (normalized) return normalized;

    return raw
      .toLowerCase()
      .replace(/[.,()\-_\/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isTerminalAnchorLocation(locationName: string): boolean {
    return /(airport|air\s*port|railway|station|stn|junction|terminal|bus\s*stand|terminus)/i.test(
      String(locationName || '').toLowerCase(),
    );
  }

  extractRouteOptimizationContext(routes: any[]): RouteOptimizationContext {
    const sourceLocations = routes.map((r) => String(r?.location_name || '').trim());
    const nextVisitingLocations = routes.map((r) => String(r?.next_visiting_location || '').trim());
    const rawFullPath = sourceLocations.length > 0 ? [sourceLocations[0], ...nextVisitingLocations] : [];
    const cleanedFullPath = this.buildCleanOptimizationPath(rawFullPath);
    const start = cleanedFullPath[0] || '';
    const end = cleanedFullPath[cleanedFullPath.length - 1] || '';
    const rawMiddleLocations = cleanedFullPath.slice(1, -1);
    const rawStops = this.buildMovableStops(rawMiddleLocations, start, end);
    const dedupeResult = this.dedupeStops(rawStops);

    return {
      start,
      end,
      sourceLocations,
      nextVisitingLocations,
      rawFullPath,
      cleanedFullPath,
      rawMiddleLocations,
      movableStops: dedupeResult.stops,
      removedDuplicates: dedupeResult.removedDuplicates,
      removedInvalidTerminalNodes: rawStops.removedInvalidTerminalNodes,
    };
  }

  hasBrokenChain(routes: any[]): boolean {
    if (!routes || routes.length <= 1) return false;

    for (let i = 0; i < routes.length - 1; i++) {
      const currentNext = this.normalizeLocationName(String(routes[i]?.next_visiting_location || ''));
      const nextSource = this.normalizeLocationName(String(routes[i + 1]?.location_name || ''));
      if (!currentNext || !nextSource || currentNext !== nextSource) return true;
    }

    return false;
  }

  private buildMovableStops(
    rawMiddleLocations: string[],
    start: string,
    end: string,
  ): {
    stops: RouteOptimizationStop[];
    removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
  } {
    const stops: RouteOptimizationStop[] = [];
    const removedInvalidTerminalNodes: Array<{ name: string; reason: string }> = [];
    const startNormalized = this.normalizeLocationName(start);
    const endNormalized = this.normalizeLocationName(end);

    for (let idx = 0; idx < rawMiddleLocations.length; idx++) {
      const name = String(rawMiddleLocations[idx] || '').trim();
      const normalizedName = this.normalizeLocationName(name);

      if (!name || !normalizedName) {
        removedInvalidTerminalNodes.push({ name, reason: 'empty-name' });
        continue;
      }

      if (normalizedName === startNormalized || normalizedName === endNormalized) {
        const preserveFirstTerminalToCityHop =
          idx === 0 &&
          normalizedName === startNormalized &&
          this.isTerminalAnchorLocation(start) &&
          !this.isTerminalAnchorLocation(name) &&
          start.trim().toLowerCase() !== name.trim().toLowerCase();

        if (preserveFirstTerminalToCityHop) {
          stops.push({ name, normalizedName });
          continue;
        }

        removedInvalidTerminalNodes.push({ name, reason: 'matches-anchor' });
        continue;
      }

      stops.push({ name, normalizedName });
    }

    return { stops, removedInvalidTerminalNodes };
  }

  private buildCleanOptimizationPath(rawFullPath: string[]): string[] {
    const cleaned: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < rawFullPath.length; i++) {
      const name = String(rawFullPath[i] || '').trim();
      const normalizedName = this.normalizeLocationName(name);
      if (!name || !normalizedName) continue;

      let shouldPreserveTerminalToCityHop = false;
      if (cleaned.length > 0) {
        const prevName = cleaned[cleaned.length - 1];
        const prevNormalized = this.normalizeLocationName(prevName);
        if (normalizedName === prevNormalized) {
          const isFirstHop = cleaned.length === 1;
          shouldPreserveTerminalToCityHop =
            isFirstHop &&
            this.isTerminalAnchorLocation(prevName) &&
            !this.isTerminalAnchorLocation(name) &&
            prevNormalized === normalizedName &&
            prevName.trim().toLowerCase() !== name.trim().toLowerCase();

          if (!shouldPreserveTerminalToCityHop) continue;
        }
      }

      const isLastNode = i === rawFullPath.length - 1;
      if (seen.has(normalizedName) && !isLastNode && !shouldPreserveTerminalToCityHop) continue;

      cleaned.push(name);
      seen.add(normalizedName);
    }

    if (cleaned.length >= 2) return cleaned;

    const first = rawFullPath.find((p) => this.normalizeLocationName(p));
    const last = [...rawFullPath].reverse().find((p) => this.normalizeLocationName(p));
    const fallback: string[] = [];
    if (first) fallback.push(String(first).trim());
    if (last && this.normalizeLocationName(last) !== this.normalizeLocationName(first || '')) {
      fallback.push(String(last).trim());
    }
    return fallback;
  }

  private dedupeStops(stopsInput: {
    stops: RouteOptimizationStop[];
    removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
  }): {
    stops: RouteOptimizationStop[];
    removedDuplicates: RouteOptimizationStop[];
  } {
    const seen = new Set<string>();
    const stops: RouteOptimizationStop[] = [];
    const removedDuplicates: RouteOptimizationStop[] = [];

    for (const stop of stopsInput.stops) {
      if (seen.has(stop.normalizedName)) {
        removedDuplicates.push(stop);
        continue;
      }

      seen.add(stop.normalizedName);
      stops.push(stop);
    }

    return { stops, removedDuplicates };
  }
}
