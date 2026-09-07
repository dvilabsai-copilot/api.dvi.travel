import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface TimelineRouteHotspotPlanningCallbacks {
  fetchSelectedHotspots: (...args: any[]) => Promise<any[]>;
  fetchDay1TopPrioritySourceHotspots: (...args: any[]) => Promise<any[]>;
  canonicalCityKey: (value: string) => string;
  buildSameCityContinuationContext: (...args: any[]) => any;
  logBookingRule: (...args: any[]) => void;
}

export class TimelineRouteHotspotPlanningService {
  private callbacks!: TimelineRouteHotspotPlanningCallbacks;

  setCallbacks(callbacks: TimelineRouteHotspotPlanningCallbacks): void {
    this.callbacks = callbacks;
  }

  async select(input: {
    tx: Tx;
    planId: number;
    route: any;
    plan: any;
    routes: any[];
    scopedRoutes: any[];
    routeIndex: number;
    previousRouteByRouteId: Map<number, any>;
    sourceCity: string;
    destinationCity: string;
    arrivalPoint: string;
    departurePoint: string;
    currentLocationName: string;
    filteredHotspots: any[];
    hotspotRows: any[];
    carryForwardHotspots: any[];
    isFirstRoute: boolean;
    isLastRoute: boolean;
    shouldDeferDay1Sightseeing: boolean;
    forceNoSightseeingOnThisRoute: boolean;
    forceDirectDestinationSightseeing: boolean;
    verboseTimelineProofLogs: boolean;
  }): Promise<any> {
    const { tx, planId, route, plan, routes, scopedRoutes, routeIndex, previousRouteByRouteId,
      sourceCity, destinationCity, arrivalPoint, departurePoint, currentLocationName,
      filteredHotspots, hotspotRows, isFirstRoute, isLastRoute, shouldDeferDay1Sightseeing,
      forceNoSightseeingOnThisRoute, forceDirectDestinationSightseeing,
      verboseTimelineProofLogs } = input;
    let carryForwardHotspots = input.carryForwardHotspots;
      let selectedHotspots: any[] = [];

      if (forceNoSightseeingOnThisRoute) {
        selectedHotspots = [];
      }

      const day1SourceCompare = this.callbacks.canonicalCityKey(String(sourceCity || ''));
      const day1DestinationCompare = this.callbacks.canonicalCityKey(String(destinationCity || ''));
      const nextRoute = routeIndex < routes.length ? routes[routeIndex] : null;
      const currentRouteViaRows =
        (await (tx as any).dvi_itinerary_via_route_details?.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: route.itinerary_route_ID,
            deleted: 0,
            status: 1,
          },
        })) || [];

      const currentRouteViaLocationNames = currentRouteViaRows
        .map((viaRoute: any) =>
          String(
            viaRoute?.itinerary_via_location_name ??
              viaRoute?.via_route_name ??
              '',
          ).trim(),
        )
        .filter(Boolean);

      const hasExplicitViaRouteOnCurrentRoute = currentRouteViaLocationNames.length > 0;

      const isIntercityTransferWithExplicitVia =
        hasExplicitViaRouteOnCurrentRoute &&
        day1SourceCompare !== '' &&
        day1DestinationCompare !== '' &&
        day1SourceCompare !== day1DestinationCompare;

      const directToNextForCurrentRoute =
        Number((route as any).direct_to_next_visiting_place || 0);

      const isIntercityDirectDestinationTransfer =
        directToNextForCurrentRoute === 1 &&
        !hasExplicitViaRouteOnCurrentRoute &&
        day1SourceCompare !== '' &&
        day1DestinationCompare !== '' &&
        day1SourceCompare !== day1DestinationCompare;

      const isIntercityMovementFirstTransfer =
        isIntercityTransferWithExplicitVia || isIntercityDirectDestinationTransfer;

      const previousRouteForCurrent = previousRouteByRouteId.get(Number((route as any).itinerary_route_ID || 0));
      const sameCityContinuationContextForRoute = this.callbacks.buildSameCityContinuationContext(
        route,
        previousRouteForCurrent,
        hotspotRows,
      );
      const nextRouteSourceCompare = this.callbacks.canonicalCityKey(String((nextRoute as any)?.location_name || ''));
      const nextRouteDestinationCompare = this.callbacks.canonicalCityKey(
        String((nextRoute as any)?.next_visiting_location || ''),
      );
      const currentRouteCityForCarry = this.callbacks.canonicalCityKey(String((route as any).next_visiting_location || (route as any).location_name || ''));
      const nextRouteSameCityContinuation =
        !!nextRoute &&
        !!currentRouteCityForCarry &&
        (currentRouteCityForCarry === nextRouteSourceCompare || currentRouteCityForCarry === nextRouteDestinationCompare);

      if (carryForwardHotspots.length > 0 && !sameCityContinuationContextForRoute.isSameCityChainContinuation) {
        this.callbacks.logBookingRule({
          rule: 'STRICT_CARRY_FORWARD_EXPIRED',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          pendingHotspotIds: carryForwardHotspots.map((h) => Number((h as any).hotspot_ID || 0)).filter((id) => id > 0),
          reason: 'Same-city continuation chain ended before carry-forward consumption.',
        });
        carryForwardHotspots = [];
      }
      const isDay1DifferentCities =
        isFirstRoute &&
        day1SourceCompare &&
        day1DestinationCompare &&
        day1SourceCompare !== day1DestinationCompare &&
        (route as any).direct_to_next_visiting_place !== 1;
      const directToNextForDestinationReservation = Number(
        (route as any).direct_to_next_visiting_place || 0,
      );
      const isEligibleForDestinationReservation =
        directToNextForDestinationReservation !== 1 &&
        !isFirstRoute &&
        !isLastRoute &&
        day1SourceCompare !== '' &&
        day1DestinationCompare !== '' &&
        day1SourceCompare !== day1DestinationCompare &&
        !!nextRoute &&
        nextRouteSourceCompare !== '' &&
        nextRouteDestinationCompare !== '' &&
        nextRouteSourceCompare === day1DestinationCompare &&
        nextRouteDestinationCompare === day1DestinationCompare;
      this.callbacks.logBookingRule({
        rule: 'DESTINATION_RESERVATION_DIRECT_ON_GUARD',
        planId,
        routeId: route.itinerary_route_ID,
        directToNext: directToNextForDestinationReservation,
        isEligibleForDestinationReservation,
        sourceCity,
        destinationCity,
        nextRouteId: Number((nextRoute as any)?.itinerary_route_ID || 0),
        nextRouteSource: String((nextRoute as any)?.location_name || ''),
        nextRouteDestination: String((nextRoute as any)?.next_visiting_location || ''),
        reason:
          directToNextForDestinationReservation === 1
            ? 'Direct route must use destination hotspots today, not reserve them for next same-city day.'
            : 'Non-direct route keeps existing destination reservation behavior.',
      });
      const isRouteSourceTerminal = /airport|railway station/i.test(
        String(sourceCity || route.location_name || ''),
      );
      const remainingRoutes = scopedRoutes.slice(routeIndex);
      const hasLaterOvernightInSourceCity =
        day1SourceCompare !== '' &&
        remainingRoutes.some((candidateRoute: any) => {
          const candidateSourceCompare = this.callbacks.canonicalCityKey(
            String(candidateRoute?.location_name || ''),
          );
          const candidateDestinationCompare = this.callbacks.canonicalCityKey(
            String(candidateRoute?.next_visiting_location || ''),
          );

          return (
            candidateDestinationCompare === day1SourceCompare ||
            (
              candidateSourceCompare === day1SourceCompare &&
              candidateDestinationCompare === day1SourceCompare
            )
          );
        });
      const tracePhpIncludeFlow = verboseTimelineProofLogs;
      const isLoopbackRoute =
        day1SourceCompare !== '' &&
        day1SourceCompare === day1DestinationCompare;
      const shouldApplySourceHotspotCutoff = !isLoopbackRoute;
      this.callbacks.logBookingRule({
        rule: 'DAY1_SOURCE_CITY_RETURN_STAY_CHECK',
        planId,
        routeId: route.itinerary_route_ID,
        sourceCity,
        sourceCityKey: day1SourceCompare,
        isRouteSourceTerminal,
        hasLaterOvernightInSourceCity,
        remainingRouteIds: remainingRoutes.map((candidateRoute: any) => (
          Number(candidateRoute?.itinerary_route_ID || 0)
        )).filter((candidateRouteId: number) => candidateRouteId > 0),
      });

      if (isDay1DifferentCities) {
        this.callbacks.logBookingRule({
          rule: 'EN_ROUTE_SIGHTSEEING_BRANCH',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          sourceCity,
          destinationCity,
          directToNext: Number((route as any).direct_to_next_visiting_place || 0),
          enabled: true,
        });
      }

      if (!forceNoSightseeingOnThisRoute) {
        if (forceDirectDestinationSightseeing && isFirstRoute) {
          // Early check-in follows the Direct Destination hotspot pool while
          // leaving the persisted route flag unchanged.
          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
            undefined,
            false,
            true,
          );
        } else if (isDay1DifferentCities) {
        const directToNext = Number((route as any).direct_to_next_visiting_place || 0);

        if (directToNext === 1) {
          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
          );
        } else {
 // PHP parity: for Day-1 different-cities non-direct routes, do not suppress
 // destination hotspots. Example: "Chennai International Airport -> Chennai"
 // should still allow Chennai destination hotspots on Day 1.
          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
            undefined,
            false,
          );

 // Fallback to strict source-priority fetch if route matching returns nothing.
          if (!selectedHotspots.length) {
            selectedHotspots = await this.callbacks.fetchDay1TopPrioritySourceHotspots(
              tx,
              planId,
              route.itinerary_route_ID,
              sourceCity,
              destinationCity,
            );
          }

 // PHP parity tuning for Day-1 non-direct airport/city routes:
 // keep tie-order deterministic for zero-priority carry spots.
          selectedHotspots.sort((a, b) => {
            const ap = Number((a as any).hotspot_priority ?? 0);
            const bp = Number((b as any).hotspot_priority ?? 0);
            const ar = ap > 0 ? ap : 9999;
            const br = bp > 0 ? bp : 9999;
            if (ar !== br) return ar - br;

            if (ar === 9999 && br === 9999) {
              return Number(a.hotspot_ID || 0) - Number(b.hotspot_ID || 0);
            }

            const ad = Number((a as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
            const bd = Number((b as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
            if (ad !== bd) return ad - bd;
            return Number(a.hotspot_ID || 0) - Number(b.hotspot_ID || 0);
          });
        }
      } else if (isFirstRoute && shouldDeferDay1Sightseeing) {
 // Check if current route is STAYING in arrival city (not just passing through)
 // Only skip if both location_name AND next_visiting_location are in arrival city
        const currentCity = this.callbacks.canonicalCityKey(currentLocationName);
        const nextCity = this.callbacks.canonicalCityKey(route.next_visiting_location || '');
        const arrivalCity = this.callbacks.canonicalCityKey(arrivalPoint);

 // CRITICAL FIX: Only skip if STAYING in arrival city, not just starting from there
 // Example: "Madurai Airport Alleppey" should NOT skip (traveling away)
 // Example: "Madurai Airport Madurai" SHOULD skip (staying in same city)
        const isStayingInArrivalCity = (currentCity === arrivalCity) && (nextCity === arrivalCity);

        if (isStayingInArrivalCity) {
 // Same-city Day 1 should not depend on source label (city vs airport/station).
 // Keep sightseeing enabled consistently for both cases.
          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
            undefined,
            false,
          );
        } else {
 // Traveling away from arrival city on Day 1 - apply same direct/non-direct logic
          const directToNext = (route as any).direct_to_next_visiting_place || 0;

          if (directToNext === 1) {
 // Direct travel: Skip arrival city hotspots

            selectedHotspots = await this.callbacks.fetchSelectedHotspots(
              tx,
              planId,
              route.itinerary_route_ID,
              filteredHotspots,
 undefined, // No source limit for direct travel
            );
          } else {
 // Non-direct travel: Visit all available arrival city hotspots

            selectedHotspots = await this.callbacks.fetchSelectedHotspots(
              tx,
              planId,
              route.itinerary_route_ID,
              filteredHotspots,
 undefined, // No limit - schedule all top priority hotspots
 true, // Skip destination hotspots - they'll be added on Day 2
            );
          }
        }
      } else if (isFirstRoute && !shouldDeferDay1Sightseeing) {
 // Day 1 traveling to different city - check direct flag
        const directToNext = (route as any).direct_to_next_visiting_place || 0;

        if (directToNext === 1) {
 // Direct travel: Skip arrival city hotspots, go straight to destination
 // Fetch destination city hotspots only (fetchSelectedHotspotsForRoute handles direct flag internally)

          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
 undefined, // No source limit for direct travel (will skip source anyway)
          );
        } else {
 // Non-direct travel: Visit all available arrival city hotspots

 // Fetch all available hotspots, skip destination (will be on Day 2)
          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
 undefined, // No limit - schedule all top priority hotspots
 true, // Skip destination hotspots - they'll be added on Day 2
          );
        }
      } else if (isLastRoute && shouldDeferDay1Sightseeing) {
 // Last day in departure city - fetch hotspots for departure city sightseeing
        const currentCity = this.callbacks.canonicalCityKey(currentLocationName);
        const departureCity = this.callbacks.canonicalCityKey(departurePoint);

        if (currentCity === departureCity) {
 // Do local sightseeing on last day

 // Fetch hotspots for this city (will get popular spots)
          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
          );
        } else {
 // Normal last route
          selectedHotspots = await this.callbacks.fetchSelectedHotspots(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
          );
        }
      } else {
 // Normal route - fetch hotspots
        selectedHotspots = await this.callbacks.fetchSelectedHotspots(
          tx,
          planId,
          route.itinerary_route_ID,
          filteredHotspots,
        );
      }

      }
    return {
      selectedHotspots,
      carryForwardHotspots,
      day1SourceCompare,
      day1DestinationCompare,
      nextRoute,
      currentRouteViaRows,
      currentRouteViaLocationNames,
      hasExplicitViaRouteOnCurrentRoute,
      isIntercityTransferWithExplicitVia,
      directToNextForCurrentRoute,
      isIntercityDirectDestinationTransfer,
      isIntercityMovementFirstTransfer,
      sameCityContinuationContextForRoute,
      nextRouteSameCityContinuation,
      isDay1DifferentCities,
      directToNextForDestinationReservation,
      isEligibleForDestinationReservation,
      isRouteSourceTerminal,
      remainingRoutes,
      hasLaterOvernightInSourceCity,
      tracePhpIncludeFlow,
      isLoopbackRoute,
      shouldApplySourceHotspotCutoff,
    };
  }
}
