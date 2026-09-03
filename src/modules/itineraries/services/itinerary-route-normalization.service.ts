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
  );

return {
  start,
  end,
  sourceLocations,
  nextVisitingLocations,
  rawFullPath,
  cleanedFullPath,
  rawMiddleLocations,

  // Non-consecutive repeated destinations are genuine itinerary
  // occurrences and must remain available to the optimizer.
  movableStops: rawStops.stops,

  // Literal A -> A rows continue to be handled separately
  // as explicit stay days.
  stayDays:
    this.extractExplicitStayDays(routes),

  // Kept for context/interface compatibility.
  // Genuine revisits are no longer treated as duplicates.
  removedDuplicates: [],

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
): {
  stops: RouteOptimizationStop[];
  removedInvalidTerminalNodes: Array<{
    name: string;
    reason: string;
  }>;
} {
  const stops:
    RouteOptimizationStop[] = [];

  const removedInvalidTerminalNodes:
    Array<{
      name: string;
      reason: string;
    }> = [];

  /*
   * The first arrival occurrence and final departure occurrence
   * have already been removed from this collection by:
   *
   * cleanedFullPath.slice(1, -1)
   *
   * Therefore every valid occurrence remaining here is a genuine
   * middle itinerary occurrence and must be movable.
   *
   * Do NOT remove a middle location merely because it normalizes
   * to the same city as the arrival/departure anchor.
   *
   * Example:
   *
   * Chennai Domestic Airport
   * -> Pondicherry
   * -> Chennai
   * -> Pondicherry
   * -> Chennai Domestic Airport
   *
   * Movable occurrences must be:
   *
   * Pondicherry
   * Chennai
   * Pondicherry
   */
  for (
    const rawLocation of
      rawMiddleLocations
  ) {
    const name =
      String(
        rawLocation || '',
      ).trim();

    const normalizedName =
      this.normalizeLocationName(
        name,
      );

    if (
      !name ||
      !normalizedName
    ) {
      removedInvalidTerminalNodes.push({
        name,
        reason: 'empty-name',
      });

      continue;
    }

    stops.push({
      name,
      normalizedName,
    });
  }

  return {
    stops,
    removedInvalidTerminalNodes,
  };
}
private buildCleanOptimizationPath(
  rawFullPath: string[],
): string[] {
  const cleaned: string[] = [];

  for (
    let i = 0;
    i < rawFullPath.length;
    i++
  ) {
    const name =
      String(
        rawFullPath[i] || '',
      ).trim();

    const normalizedName =
      this.normalizeLocationName(
        name,
      );

    if (
      !name ||
      !normalizedName
    ) {
      continue;
    }

    if (
      cleaned.length > 0
    ) {
      const prevName =
        cleaned[
          cleaned.length - 1
        ];

      const prevNormalized =
        this.normalizeLocationName(
          prevName,
        );

      /*
       * Consecutive locations which normalize to the same city
       * need two different treatments:
       *
       * A -> A
       * = explicit stay day
       * = remove from movable sequence and reinsert later.
       *
       * City -> City Airport / Railway Station
       * Airport / Station -> City
       * = real transfer
       * = preserve.
       */
      if (
        normalizedName ===
        prevNormalized
      ) {
        const previousLiteral =
          prevName
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();

        const currentLiteral =
          name
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();

        const literalsDiffer =
          previousLiteral !==
          currentLiteral;

        const preserveSameCityTransfer =
          literalsDiffer &&
          (
            this.isTerminalAnchorLocation(
              prevName,
            ) ||
            this.isTerminalAnchorLocation(
              name,
            )
          );

        if (
          !preserveSameCityTransfer
        ) {
          continue;
        }
      }
    }

    /*
     * IMPORTANT:
     *
     * Do NOT globally de-duplicate normalized locations.
     *
     * A -> B -> C -> B -> D
     * contains two genuine B occurrences.
     *
     * Both must survive normalization so the optimizer can
     * evaluate the complete itinerary without changing its
     * number of days.
     */
    cleaned.push(name);
  }

  if (
    cleaned.length >= 2
  ) {
    return cleaned;
  }

  const first =
    rawFullPath.find(
      (value) =>
        this.normalizeLocationName(
          value,
        ),
    );

  const last =
    [...rawFullPath]
      .reverse()
      .find(
        (value) =>
          this.normalizeLocationName(
            value,
          ),
      );

  const fallback: string[] = [];

  if (first) {
    fallback.push(
      String(first).trim(),
    );
  }

  if (
    last &&
    String(last)
      .trim()
      .toLowerCase() !==
      String(first || '')
        .trim()
        .toLowerCase()
  ) {
    fallback.push(
      String(last).trim(),
    );
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
}
