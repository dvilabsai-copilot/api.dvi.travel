import { Injectable } from '@nestjs/common';
import { normalizeCityName } from '../utils/city-normalization.util';

export type RouteOptimizationStop = {
  name: string;
  normalizedName: string;
};

export type RouteOptimizationStayDay = {
  name: string;
  normalizedName: string;
  count: number;
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
  stayDays: RouteOptimizationStayDay[];
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
    const sourceLocations = routes.map((r) =>
      String(r?.location_name || '').trim(),
    );

    const nextVisitingLocations = routes.map((r) =>
      String(r?.next_visiting_location || '').trim(),
    );

    const rawFullPath =
      sourceLocations.length > 0
        ? [sourceLocations[0], ...nextVisitingLocations]
        : [];

    const cleanedFullPath =
      this.buildCleanOptimizationPath(rawFullPath);

    // Arrival and departure are hard anchors.
    // Prefer the literal incoming locations so an airport/station is not
    // accidentally converted into only its normalized city name.
    const start =
      rawFullPath.find((value) =>
        Boolean(String(value || '').trim()),
      ) ||
      cleanedFullPath[0] ||
      '';

    const end =
      [...rawFullPath]
        .reverse()
        .find((value) =>
          Boolean(String(value || '').trim()),
        ) ||
      cleanedFullPath[cleanedFullPath.length - 1] ||
      '';

    const rawMiddleLocations =
      cleanedFullPath.slice(1, -1);

    const rawStops =
      this.buildMovableStops(
        rawMiddleLocations,
        start,
        end,
      );

    const dedupeResult =
      this.dedupeStops(rawStops);

    return {
      start,
      end,
      sourceLocations,
      nextVisitingLocations,
      rawFullPath,
      cleanedFullPath,
      rawMiddleLocations,
      movableStops: dedupeResult.stops,

      // Explicit A -> A rows are itinerary stay days.
      // They are removed from destination permutations but are reinserted
      // after the best destination order has been selected.
      stayDays: this.extractExplicitStayDays(routes),

      removedDuplicates: dedupeResult.removedDuplicates,
      removedInvalidTerminalNodes:
        rawStops.removedInvalidTerminalNodes,
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

      if (
        normalizedName === startNormalized ||
        normalizedName === endNormalized
      ) {
        const preserveFirstTerminalToCityHop =
          idx === 0 &&
          normalizedName === startNormalized &&
          this.isTerminalAnchorLocation(start) &&
          !this.isTerminalAnchorLocation(name) &&
          start.trim().toLowerCase() !== name.trim().toLowerCase();

        const preserveLastCityToTerminalHop =
          idx === rawMiddleLocations.length - 1 &&
          normalizedName === endNormalized &&
          !this.isTerminalAnchorLocation(name) &&
          this.isTerminalAnchorLocation(end) &&
          end.trim().toLowerCase() !== name.trim().toLowerCase();

        if (
          preserveFirstTerminalToCityHop ||
          preserveLastCityToTerminalHop
        ) {
          stops.push({
            name,
            normalizedName,
          });
          continue;
        }

        removedInvalidTerminalNodes.push({
          name,
          reason: 'matches-anchor',
        });
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

      const nextName = String(rawFullPath[i + 1] || '').trim();

      // Example:
      // Bengaluru -> Mysuru -> Bengaluru -> Bengaluru Airport
      //
      // The Bengaluru immediately before the airport must remain because
      // Bengaluru -> Bengaluru Airport is a real terminal transfer.
      const preserveFinalCityBeforeTerminal =
        i === rawFullPath.length - 2 &&
        Boolean(nextName) &&
        !this.isTerminalAnchorLocation(name) &&
        this.isTerminalAnchorLocation(nextName) &&
        normalizedName === this.normalizeLocationName(nextName) &&
        name.trim().toLowerCase() !== nextName.trim().toLowerCase();

      let preserveSameCityTransfer = preserveFinalCityBeforeTerminal;

      if (cleaned.length > 0) {
        const prevName = cleaned[cleaned.length - 1];
        const prevNormalized = this.normalizeLocationName(prevName);

        if (normalizedName === prevNormalized) {
          const isFirstHop = cleaned.length === 1;
          const isLastHop = i === rawFullPath.length - 1;

          const preserveFirstTerminalToCityHop =
            isFirstHop &&
            this.isTerminalAnchorLocation(prevName) &&
            !this.isTerminalAnchorLocation(name) &&
            prevName.trim().toLowerCase() !== name.trim().toLowerCase();

          const preserveLastCityToTerminalHop =
            isLastHop &&
            !this.isTerminalAnchorLocation(prevName) &&
            this.isTerminalAnchorLocation(name) &&
            prevName.trim().toLowerCase() !== name.trim().toLowerCase();

          preserveSameCityTransfer =
            preserveSameCityTransfer ||
            preserveFirstTerminalToCityHop ||
            preserveLastCityToTerminalHop;

          // Exact repeated locations are treated as stay-day rows and
          // reinserted after the destination sequence is optimized.
          if (!preserveSameCityTransfer) {
            continue;
          }
        }
      }

      const isLastNode = i === rawFullPath.length - 1;

      if (seen.has(normalizedName) && !isLastNode && !preserveSameCityTransfer) {
        continue;
      }

      cleaned.push(name);
      seen.add(normalizedName);
    }

    if (cleaned.length >= 2) return cleaned;

    const first = rawFullPath.find((value) => this.normalizeLocationName(value));
    const last = [...rawFullPath].reverse().find((value) => this.normalizeLocationName(value));
    const fallback: string[] = [];
    if (first) fallback.push(String(first).trim());
    if (last && String(last).trim().toLowerCase() !== String(first || '').trim().toLowerCase()) {
      fallback.push(String(last).trim());
    }
    return fallback;
  }
  private extractExplicitStayDays(
    routes: any[],
  ): RouteOptimizationStayDay[] {
    const byIdentity =
      new Map<string, RouteOptimizationStayDay>();

    for (const route of routes || []) {
      const source =
        String(route?.location_name || '').trim();

      const destination =
        String(
          route?.next_visiting_location || '',
        ).trim();

      if (!source || !destination) {
        continue;
      }

      // Only literal A -> A rows are treated as stay days.
      //
      // Airport -> City may normalize to the same city but must NOT
      // be classified as a stay day.
      const sourceIdentity =
        source
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();

      const destinationIdentity =
        destination
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();

      if (
        sourceIdentity !== destinationIdentity
      ) {
        continue;
      }

      const existing =
        byIdentity.get(sourceIdentity);

      if (existing) {
        existing.count += 1;
        continue;
      }

      byIdentity.set(sourceIdentity, {
        name: source,
        normalizedName:
          this.normalizeLocationName(source),
        count: 1,
      });
    }

    return Array.from(byIdentity.values());
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
