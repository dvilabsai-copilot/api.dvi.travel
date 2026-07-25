// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts
//
// Implements required behavior:
// - priority=0 is LOWEST (treated as 9999)
// - direct_to_next_visiting_place = 1:
// DO NOT include SOURCE auto hotspots
// include VIA hotspots if via selected, else include BOUNDARY hotspots (city_boundaries match)
// then DESTINATION hotspots
// manual hotspots ALWAYS kept
// - direct_to_next_visiting_place = 0:
// manual hotspots ALWAYS kept
// include TOP-3 SOURCE hotspots
// include VIA hotspots (if any)
// include DESTINATION hotspots
//
// NOTE: Scheduler handles time windows, defers, gap-fill, conflicts.

import { Prisma } from "@prisma/client";
import { PrefetchContext, RouteRow, PlanHeader } from "./timeline.prefetch";
import { TimelineLogger } from "./timeline.logger";

type Tx = Prisma.TransactionClient;

export interface SelectedHotspot {
  hotspot_ID: number;

 /**
   * 1 = Source, 2 = Via/Boundary, 3 = Destination
 */
  city_order: 1 | 2 | 3;

 /**
   * Effective numeric priority (lower is better). priority=0 => 9999
 */
  hotspot_priority: number;

 /**
   * TRUE only when this selection is "manual" OR "boundary match".
   * (Used by cutoff-policy Rule-D enablement.)
 */
  isBoundaryMatch?: boolean;
}

export class HotspotSelector {
  private deps?: PrefetchContext;

  async selectForRoute(
    tx: Tx,
    plan: PlanHeader,
    route: RouteRow,
    deps: PrefetchContext,
    existingHotspots: any[] = [],
  ): Promise<SelectedHotspot[]> {
    this.deps = deps;

    const targetLocation = (route.location_name || "").split("|")[0].trim();
    const nextLocation = (route.next_visiting_location || "").split("|")[0].trim();
    const directToNext = Number(route.direct_to_next_visiting_place || 0);

    TimelineLogger.log(
      `[SELECTOR] Route ${route.itinerary_route_ID}: target=${targetLocation}, next=${nextLocation}, direct=${directToNext}`,
    );

 // ---------------------------------------------------------------------
 // 1) Identify Manual/Excluded
 // Identify manual hotspots (from existingHotspots)
 // Manual hotspots (hotspot_plan_own_way === 1) are always kept
 // Excluded hotspots are filtered via route.excluded_hotspot_ids (handled separately)
 // ---------------------------------------------------------------------
    const manualHotspotIds: Set<number> = new Set<number>(
      (existingHotspots || [])
        .filter(
          (h: any) =>
            Number(h.itinerary_route_ID) === Number(route.itinerary_route_ID) &&
            Number(h.hotspot_plan_own_way) === 1,
        )
        .map((h: any) => Number(h.hotspot_ID)),
    );

 // EXCLUSION LIST FIX: Read excluded_hotspot_ids from the route's JSON field
 // This is populated when users delete hotspots and prevents them from being re-selected
    const routeExcluded = (route as any).excluded_hotspot_ids || [];
    const excludedHotspotIds: Set<number> = new Set<number>(
      Array.isArray(routeExcluded) ? routeExcluded.map((id: any) => Number(id)) : [],
    );

 // kept for parity / future use
    const allowedHotspotIds: Set<number> | null = null;

 // ---------------------------------------------------------------------
 // 2) Helpers
 // ---------------------------------------------------------------------
    const normalize = (s: any) => this.deps!.normalizeCityName(String(s ?? ""));

    const containsLocation = (hotspotLocation: string, target: string) => {
      if (!target) return false;
      const t = normalize(target);
      const parts = String(hotspotLocation || "")
        .split("|")
        .map((p) => normalize(p));
      return parts.includes(t);
    };

    const getPriority = (h: any): number => {
      const raw = (h as any)?.hotspot_priority ?? (h as any)?.priority ?? 0;
      const n = Number(raw);
 if (!Number.isFinite(n) || n === 0) return 9999; // priority=0 lowest
      return n;
    };

    const boundaryMatchesRoute = (h: any, sourceCity: string, destCity: string): boolean => {
      const raw = String((h as any)?.city_boundaries ?? "");
      if (!raw) return false;

 // Supports values like:
 // "Chennai|Mahabalipuram" OR "Chennai,Mahabalipuram" OR "Chennai / Mahabalipuram"
 // Also supports your JSON-ish list strings (we just tokenize).
      const tokens = raw
 .split(/\||,|\//g)
        .map((t) => normalize(t))
        .filter(Boolean);

      const s = normalize(sourceCity);
      const d = normalize(destCity);
      if (!s || !d) return false;

 // Must contain BOTH endpoints
      return tokens.includes(s) && tokens.includes(d);
    };

    const bucketSort = (a: any, b: any) => {
      const aId = Number(a.hotspot_ID);
      const bId = Number(b.hotspot_ID);

      const ap = Number(a.__priority ?? 9999);
      const bp = Number(b.__priority ?? 9999);
      return ap - bp;
    };

 // ---------------------------------------------------------------------
 // 3) Build buckets
 // ---------------------------------------------------------------------
    const manualHotspots: any[] = [];
    const sourceHotspots: any[] = [];
    const destHotspots: any[] = [];
    const viaHotspots: any[] = [];
    const boundaryHotspots: any[] = [];

 // A) Manual hotspots (always kept)
    if (manualHotspotIds.size > 0) {
      for (const h of this.deps.allHotspots) {
        const hId = Number((h as any).hotspot_ID);
        if (!hId) continue;
        if (!manualHotspotIds.has(hId)) continue;

        manualHotspots.push({
          ...h,
          __bucket: "manual",
 // manual hotspot scheduling priority is always 4 never raw DB master priority
          __priority: 4,
          isBoundaryMatch: true,
        });
      }

 // if manual ID exists but not in hotspot table, keep stub
      for (const mid of Array.from(manualHotspotIds)) {
        if (manualHotspots.some((m) => Number(m.hotspot_ID) === Number(mid))) continue;
        manualHotspots.push({
          hotspot_ID: mid,
          __bucket: "manual",
          __priority: 9999,
          isBoundaryMatch: true,
        });
      }
    }

 // B) Auto buckets (source/dest + boundary)
    for (const h of this.deps.allHotspots) {
      const hId = Number((h as any).hotspot_ID);
      if (!hId) continue;
      const isManual = manualHotspotIds.has(hId);
      if (excludedHotspotIds.has(hId) && !isManual) continue;
      if (!isManual && allowedHotspotIds && !(allowedHotspotIds as Set<number>).has(hId)) continue;

      const matchesSource = containsLocation(String((h as any).hotspot_location || ""), targetLocation);
      const matchesDest = containsLocation(String((h as any).hotspot_location || ""), nextLocation);

      if (matchesSource) {
        sourceHotspots.push({
          ...h,
          __bucket: "source",
          __priority: getPriority(h),
 // IMPORTANT: source hotspot is NOT a boundary/manual trigger
          isBoundaryMatch: false,
        });
      }

      if (matchesDest) {
        destHotspots.push({
          ...h,
          __bucket: "dest",
          __priority: getPriority(h),
 // IMPORTANT: destination hotspot is NOT a boundary/manual trigger
          isBoundaryMatch: false,
        });
      }

 // Boundary/on-the-way (only used for direct=1 and no via)
      if (!matchesSource && !matchesDest) {
        if (boundaryMatchesRoute(h, targetLocation, nextLocation)) {
          boundaryHotspots.push({
            ...h,
            __bucket: "boundary",
            __priority: getPriority(h),
 // boundary match triggers Rule-D in cutoff-policy
            isBoundaryMatch: true,
          });
        }
      }
    }

 // C) Via routes bucket
    const viaRoutes = this.deps.viaRouteMap.get(Number(route.itinerary_route_ID)) || [];
    const sameSourceAndDestination =
      normalize(targetLocation) !== "" &&
      normalize(targetLocation) === normalize(nextLocation);
    const hasViaRoutes = viaRoutes.length > 0;
    const isSameCityViaOutstation = sameSourceAndDestination && hasViaRoutes;

    for (const vr of viaRoutes) {
      const viaName =
        (vr as any)?.itinerary_via_location_name ??
        (vr as any)?.via_route_name ??
        "";
      const vLoc = viaName ? String(viaName).split("|")[0].trim() : "";
      if (!vLoc) continue;

      for (const h of this.deps.allHotspots) {
        const hId = Number((h as any).hotspot_ID);
        if (!hId) continue;
        const isManual = manualHotspotIds.has(hId);
        if (excludedHotspotIds.has(hId) && !isManual) continue;
        if (!isManual && allowedHotspotIds && !(allowedHotspotIds as Set<number>).has(hId)) continue;

        if (containsLocation(String((h as any).hotspot_location || ""), vLoc)) {
          viaHotspots.push({
            ...h,
            __bucket: "via",
            __priority: getPriority(h),
 // via is NOT a boundary/manual trigger
            isBoundaryMatch: false,
          });
        }
      }
    }

 // ---------------------------------------------------------------------
 // 4) Sort buckets
 // ---------------------------------------------------------------------
    manualHotspots.sort(bucketSort);
    sourceHotspots.sort(bucketSort);
    destHotspots.sort(bucketSort);
    viaHotspots.sort(bucketSort);
    boundaryHotspots.sort(bucketSort);

    const sourceTop3 = sourceHotspots.slice(0, 3);

 // ---------------------------------------------------------------------
 // 5) Merge based on Direct rules
 // ---------------------------------------------------------------------
    let merged: any[] = [];

    if (isSameCityViaOutstation) {
 // Special case parity: source=destination with via means this is an outstation day.
 // Prefer via city hotspots and avoid auto-selecting the same-city source/destination set.
      const base = viaHotspots.length > 0 ? viaHotspots : boundaryHotspots;
      merged = [...base, ...manualHotspots].sort((a, b) => {
        const ap = Number(a.__priority ?? 9999);
        const bp = Number(b.__priority ?? 9999);
        return ap - bp;
      });
    } else if (directToNext === 1) {
 // Direct = YES: via/boundary + dest + manual, sorted by priority
      const hasVia = viaHotspots.length > 0;
      const base = [...(hasVia ? viaHotspots : boundaryHotspots), ...destHotspots];
 // Manual hotspots are mustInclude but sorted by effective P4 among others
      merged = [...base, ...manualHotspots].sort((a, b) => {
        const ap = Number(a.__priority ?? 9999);
        const bp = Number(b.__priority ?? 9999);
        return ap - bp;
      });
    } else {
 // Direct = NO: source + via + dest + manual, sorted by priority
      const base = [...sourceTop3, ...viaHotspots, ...destHotspots];
 // Manual hotspots are mustInclude but sorted by effective P4 among others
      merged = [...base, ...manualHotspots].sort((a, b) => {
        const ap = Number(a.__priority ?? 9999);
        const bp = Number(b.__priority ?? 9999);
        return ap - bp;
      });
    }

 // ---------------------------------------------------------------------
 // 6) Final unique list with city_order + hotspot_priority set
 // ---------------------------------------------------------------------
    const finalIds: Set<number> = new Set<number>();
    const result: SelectedHotspot[] = [];

    for (const h of merged) {
      const id = Number(h.hotspot_ID);
      if (!id) continue;
      if (finalIds.has(id)) continue;

      finalIds.add(id);

      const bucket = String(h.__bucket || "");
      let city_order: 1 | 2 | 3 = 1;
      if (bucket === "via" || bucket === "boundary") {
        city_order = 2;
      } else if (bucket === "dest") {
        city_order = 3;
      } else if (bucket === "manual") {
 // For manual, try to see if it matches source/dest/via to give it a better city_order
        const matchesSource = containsLocation(String(h.hotspot_location || ""), targetLocation);
        const matchesDest = containsLocation(String(h.hotspot_location || ""), nextLocation);
        if (matchesSource) {
          city_order = 1;
        } else if (matchesDest) {
          city_order = 3;
        } else {
 // Check via
          let foundVia = false;
          for (const vr of viaRoutes) {
            const viaName =
              (vr as any)?.itinerary_via_location_name ??
              (vr as any)?.via_route_name ??
              "";
            const vLoc = viaName ? String(viaName).split("|")[0].trim() : "";
            if (vLoc && containsLocation(String(h.hotspot_location || ""), vLoc)) {
              city_order = 2;
              foundVia = true;
              break;
            }
          }
          if (!foundVia) {
            city_order = 1;
          }
        }
      }

      result.push({
        hotspot_ID: id,
        city_order,
 // Manual hotspot always schedules as P4, not raw DB master priority
        hotspot_priority: h.__bucket === 'manual' ? 4 : getPriority(h),
        isBoundaryMatch: !!h.isBoundaryMatch,
      });
    }

 // Helpful debug log to validate counts fast
    try {
      const counts = {
        manual: manualHotspots.length,
        source: sourceHotspots.length,
        top3Source: sourceTop3.length,
        via: viaHotspots.length,
        boundary: boundaryHotspots.length,
        dest: destHotspots.length,
        merged: merged.length,
        final: result.length,
      };
      TimelineLogger.log(
        `[SELECTOR] Route ${route.itinerary_route_ID} direct=${directToNext} counts=${JSON.stringify(counts)}`,
      );
    } catch {
 // ignore
    }

    return result;
  }
}
