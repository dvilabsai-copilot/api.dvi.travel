import { Prisma } from '@prisma/client';
import { DistanceHelper } from './distance.helper';

type Tx = Prisma.TransactionClient;

export interface TimelineRouteHotspotSelectionCallbacks {
  logTimeline: (...args: any[]) => void;
  logBookingRule: (...args: any[]) => void;
  logHotspotCandidateEvaluation: (...args: any[]) => void;
  canonicalCityKey: (...args: any[]) => any;
  hotspotLocationMatchesCity: (...args: any[]) => boolean;
  hotspotNameMatchesLocation: (...args: any[]) => boolean;
  routeSpecificHotspotMatchesRouteChain: (...args: any[]) => any;
  routeMovementOrder: (...args: any[]) => any;
  buildRouteLegs: (...args: any[]) => any;
  resolvePlaceCoords: (...args: any[]) => Promise<any>;
  getTravelLocationType: (...args: any[]) => any;
}

export class TimelineRouteHotspotSelectionService {
  private callbacks!: TimelineRouteHotspotSelectionCallbacks;

  constructor(private readonly distanceHelper: DistanceHelper = new DistanceHelper()) {}

  setCallbacks(callbacks: TimelineRouteHotspotSelectionCallbacks): void {
    this.callbacks = callbacks;
  }

  async fetch(
    tx: Tx,
    planId: number,
    routeId: number,
    allHotspots: any[],
    maxSourceHotspots?: number,
    skipDestinationHotspots?: boolean,
    forceDirectDestination?: boolean,
  ): Promise<any[]> {
    const fetchStart = Date.now();
    try {
 // 1) Load route context (dates + locations)
      let opStart = Date.now();
      const route = (await (tx as any).dvi_itinerary_route_details?.findFirst({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          deleted: 0,
          status: 1,
        },
      })) as any | null;
      this.callbacks.logTimeline('[TIMELINE] fetchSelectedHotspotsForRoute - fetch route:', Date.now() - opStart, 'ms');

      if (!route) {
        return [];
      }

 // Route fields are the source of truth for hotspot candidate matching.
 // Do not classify hotspots using dvi_stored_locations source/destination,
 // because location_id can point to stale/reused rows and contaminate routes.
 // stored_locations should only support coordinates later.
      opStart = Date.now();

      let targetLocation = String((route as any).location_name || '')
        .split('|')[0]
        .trim();

      let nextLocation = String((route as any).next_visiting_location || '')
        .split('|')[0]
        .trim();

      let storedLoc: any = null;

      if (route.location_id) {
        storedLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: {
            location_ID: BigInt(route.location_id),
            deleted: 0,
            status: 1,
          },
        });

        if (storedLoc) {
          const routeSourceKey = this.callbacks.canonicalCityKey(String(targetLocation || ''));
          const routeDestinationKey = this.callbacks.canonicalCityKey(String(nextLocation || ''));
          const storedSourceKey = this.callbacks.canonicalCityKey(String(storedLoc.source_location || ''));
          const storedDestinationKey = this.callbacks.canonicalCityKey(String(storedLoc.destination_location || ''));

          if (
            routeSourceKey &&
            routeDestinationKey &&
            storedSourceKey &&
            storedDestinationKey &&
            (routeSourceKey !== storedSourceKey || routeDestinationKey !== storedDestinationKey)
          ) {
 console.warn('[ROUTE_LOCATION_ID_MISMATCH]', {
              planId,
              routeId,
              locationId: Number((route as any).location_id || 0),
              routeSource: targetLocation,
              routeDestination: nextLocation,
              storedSource: storedLoc.source_location,
              storedDestination: storedLoc.destination_location,
              reason:
                'Using route.location_name and route.next_visiting_location as source of truth for hotspot selection.',
            });
          }

          if (!targetLocation) {
            targetLocation = String(storedLoc.source_location || '')
              .split('|')[0]
              .trim();
          }

          if (!nextLocation) {
            nextLocation = String(storedLoc.destination_location || '')
              .split('|')[0]
              .trim();
          }
        }
      }

      if (!targetLocation || !nextLocation) {
 console.warn('[HOTSPOT_SELECTION_ROUTE_CONTEXT_MISSING]', {
          planId,
          routeId,
          locationId: Number((route as any).location_id || 0),
          routeSource: (route as any).location_name,
          routeDestination: (route as any).next_visiting_location,
        });
        return [];
      }
      this.callbacks.logTimeline(
        '[TIMELINE] fetchSelectedHotspotsForRoute - route-field location lookup:',
        Date.now() - opStart,
        'ms',
        {
          routeId,
          targetLocation,
          nextLocation,
          routeLocationName: (route as any).location_name,
          routeNextVisitingLocation: (route as any).next_visiting_location,
          locationId: (route as any).location_id,
        },
      );

 // PHP uses day-of-week filtering via dvi_hotspot_timing (date('N')-1 => Monday=0)
      const routeDate = route.itinerary_route_date
        ? new Date(route.itinerary_route_date)
        : null;
      const phpDow = routeDate
 ? ((routeDate.getDay() + 6) % 7) // JS: Sunday=0; PHP: Monday=0, Sunday=6
        : undefined;

 // 2) Preload hotspot timings for this day (if available)
 // PHP uses LEFT JOIN without filtering hotspot_closed - includes all hotspots with timing records
      opStart = Date.now();
      let allowedHotspotIds: Set<number> | null = null;
      if (phpDow !== undefined) {
        const timingRows = await (tx as any).dvi_hotspot_timing?.findMany({
          where: {
            hotspot_timing_day: phpDow,
            deleted: 0,
            status: 1,
          },
        });
 // Keep timing rows for downstream checks, but avoid hard candidate prefilter.
 // Missing weekday timing should remain eligible and be handled later.
        if ((timingRows || []).length > 0) {
          allowedHotspotIds = null;
        }
      }

      const routeExcluded = (route as any).excluded_hotspot_ids || [];
      const excludedHotspotIds: Set<number> = new Set<number>(
        Array.isArray(routeExcluded)
          ? routeExcluded.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
          : [],
      );

      if (excludedHotspotIds.size > 0) {
 console.log(`[Timeline] Route ${routeId} has excluded_hotspot_ids:`, Array.from(excludedHotspotIds));
      }

      this.callbacks.logTimeline('[TIMELINE] fetchSelectedHotspotsForRoute - fetch timings:', Date.now() - opStart, 'ms');



 // 3) Use pre-fetched hotspots array (passed as parameter for performance)
 // Note: allHotspots is now passed from buildTimelineForPlan to avoid redundant queries

 // 3b) Fetch operating hours for all hotspots to enable time-aware sorting
 // PHP behavior: sortHotspots() re-orders to prioritize time-critical hotspots
 // Include all timing records (even closed) - checkHotspotOperatingHours will filter later
      const hotspotTimings = phpDow !== undefined
        ? await (tx as any).dvi_hotspot_timing?.findMany({
            where: {
              hotspot_timing_day: phpDow,
              deleted: 0,
              status: 1,
            },
          }) || []
        : [];

 // Map hotspot_ID -> earliest closing time for quick lookup
      const closingTimeMap = new Map<number, string>();
      for (const timing of hotspotTimings) {
        const hotspotId = Number(timing.hotspot_ID ?? 0);
        const endTime = timing.hotspot_end_time || '23:59:59';

 // Keep earliest closing time if multiple slots exist
        if (!closingTimeMap.has(hotspotId) || endTime < closingTimeMap.get(hotspotId)!) {
          closingTimeMap.set(hotspotId, endTime);
        }
      }

      const targetLower = targetLocation.toLowerCase();
      const nextLower = nextLocation.toLowerCase();
      const directToNextVisitingPlace = forceDirectDestination
        ? 1
        : (route as any).direct_to_next_visiting_place || 0;
      const debugBucketIds = new Set<number>([245, 243, 241, 228, 357]);

      const viaRoutes =
        (await (tx as any).dvi_itinerary_via_route_details?.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            deleted: 0,
            status: 1,
          },
        })) || [];

      const viaLocationNames = viaRoutes
        .map((viaRoute: any) =>
          String(
            viaRoute?.itinerary_via_location_name ??
              viaRoute?.via_route_name ??
              '',
          ).trim(),
        )
        .filter(Boolean);

      const routeLegs = this.callbacks.buildRouteLegs(
        targetLocation,
        viaLocationNames,
        nextLocation,
      );

      const isIntercityRouteForBucket =
        this.callbacks.canonicalCityKey(String(targetLocation || '')) !== '' &&
        this.callbacks.canonicalCityKey(String(nextLocation || '')) !== '' &&
        this.callbacks.canonicalCityKey(String(targetLocation || '')) !==
          this.callbacks.canonicalCityKey(String(nextLocation || ''));

      const hasExplicitViaRoutes = viaLocationNames.length > 0;
      const earliestViaLegIndex = hasExplicitViaRoutes ? 1 : -1;

      const isDirectDestinationRouteForBucket =
        Number(directToNextVisitingPlace || 0) === 1 &&
        isIntercityRouteForBucket &&
        !hasExplicitViaRoutes;

      const shouldSuppressSourceHotspotsForViaTransfer =
        hasExplicitViaRoutes && isIntercityRouteForBucket;

      const shouldSuppressSourceHotspotsForMovementTransfer =
        isIntercityRouteForBucket &&
        (hasExplicitViaRoutes || isDirectDestinationRouteForBucket);

      const routeLegCoordsCache = new Map<number, { lat: number; lon: number } | null>();
      const getRouteLegCoords = async (legIndex: number): Promise<{ lat: number; lon: number } | undefined> => {
        if (!Number.isFinite(legIndex) || legIndex < 0) return undefined;
        if (routeLegCoordsCache.has(legIndex)) {
          return routeLegCoordsCache.get(legIndex) || undefined;
        }

        const legName = String(routeLegs[legIndex] || '').trim();
        if (!legName) {
          routeLegCoordsCache.set(legIndex, null);
          return undefined;
        }

        const coords =
          legIndex === 0 && startLat && startLon
            ? { lat: startLat, lon: startLon }
            : await this.callbacks.resolvePlaceCoords(tx, legName, legIndex === routeLegs.length - 1 ? 'destination' : 'source');

        routeLegCoordsCache.set(legIndex, coords || null);
        return coords || undefined;
      };

 // Get starting location coordinates from stored_locations (already fetched above)
 // PHP line 1108-1109: Uses source coordinates for starting point
      let startLat = 0;
      let startLon = 0;

      if (storedLoc) {
 // Use source coordinates (PHP uses source for starting point)
        startLat = Number(storedLoc.source_location_lattitude ?? 0);
        startLon = Number(storedLoc.source_location_longitude ?? 0);
      }

 // Fallback: If location_id is missing/0 and no coordinates, try by location_name
      if (!startLat && !startLon && targetLocation) {
 // Try exact match first
        let foundLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: {
            source_location: targetLocation,
            deleted: 0,
            status: 1,
          },
        });

 // Fuzzy match if exact didn't work
        if (!foundLoc && route.location_name) {
          foundLoc = await (tx as any).dvi_stored_locations?.findFirst({
            where: {
              source_location: { contains: route.location_name },
              deleted: 0,
              status: 1,
            },
          });
        }

        if (foundLoc) {
          startLat = Number(foundLoc.source_location_lattitude ?? 0);
          startLon = Number(foundLoc.source_location_longitude ?? 0);
        }
      }

 // PHP LINE 1003-1011: Filter includes source location when direct_to_next_visiting_place != 1
 // Categorize hotspots like PHP does (lines 1197-1210)
      let sourceLocationHotspots: any[] = [];
      let destinationHotspots: any[] = [];
      const viaRouteHotspots: any[] = [];
      const enRouteHotspots: any[] = [];

 // Helper function to match location with normalization
 // PHP parity: containsLocation() uses strict lowercase+trim exact matching
 // between target location and pipe-delimited hotspot_location tokens.
      const containsLocation = (hotspotLocation: string | null, targetLocation: string | null): boolean => {
        return this.callbacks.hotspotLocationMatchesCity(hotspotLocation, targetLocation);
      };

      for (const h of allHotspots) {
        const debugHotspotId = Number(h.hotspot_ID ?? 0);
 // Check if timing allows this hotspot on this day
        if (allowedHotspotIds && !allowedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
          this.callbacks.logHotspotCandidateEvaluation({
            routeId,
            hotspotId: Number(h.hotspot_ID ?? 0),
            name: String(h.hotspot_name || h.hotspot_location || `hotspot_${Number(h.hotspot_ID ?? 0)}`),
            matchedBucket: 'prefilter',
            priority: Number(h.hotspot_priority ?? 0),
            isMustVisit: Number(h.hotspot_priority ?? 0) > 0,
            distanceFromRoute: null,
            openingTime: null,
            closingTime: null,
            visitTime: '',
            isOpenAtVisitTime: false,
            selected: false,
            rejectedReasons: ['Rejected: day-of-week mismatch'],
          });
          continue;
        }

 // PERF FIX 2: city-match BEFORE the expensive distance call.
 // With 774 hotspots in DB, ~750 are in different cities and can be skipped immediately.
        const hotspotFromLocation = String(h.hotspot_location || '').trim();
        const hotspotToLocation = String(h.hotspot_to_location || h.hotspot_location || '').trim();

        const hotspotPrimaryLocation = hotspotFromLocation
          .split('|')[0]
          .trim();

        const isRouteSpecificHotspot =
          hotspotFromLocation.toLowerCase() !== hotspotToLocation.toLowerCase();

        const matchesSource = containsLocation(hotspotFromLocation, targetLocation);
        const matchesDestination = containsLocation(hotspotFromLocation, nextLocation);

        const routeChainMatch = isRouteSpecificHotspot
          ? this.callbacks.routeSpecificHotspotMatchesRouteChain(
              hotspotFromLocation,
              hotspotToLocation,
              routeLegs,
            )
          : { matches: false, fromIndex: -1, toIndex: -1 };

        if (isRouteSpecificHotspot) {
          if (!routeChainMatch.matches) {
 console.log('[HOTSPOT ROUTE SKIP]', {
              routeId,
              hotspot_ID: h.hotspot_ID,
              hotspot_name: h.hotspot_name,
              hotspot_location: hotspotFromLocation,
              hotspot_to_location: hotspotToLocation,
              route_chain: routeLegs,
              reason: 'route-specific hotspot does not match current route chain',
            });
            continue;
          }
        } else {
          if (!matchesSource && !matchesDestination) {
            continue;
          }
        }

 // PHP parity: use travel-distance engine for ordering, not haversine approximation.
        const hsLat = Number(h.hotspot_latitude ?? 0);
        const hsLon = Number(h.hotspot_longitude ?? 0);
        let distance = Number.POSITIVE_INFINITY;
        const effectiveRouteMovementFromIndex =
          isRouteSpecificHotspot && routeChainMatch.matches
            ? (hasExplicitViaRoutes
                ? Math.max(routeChainMatch.fromIndex, earliestViaLegIndex)
                : routeChainMatch.fromIndex)
            : routeChainMatch.fromIndex;
        const distanceSourceLocation =
          isRouteSpecificHotspot && routeChainMatch.matches
            ? String(routeLegs[effectiveRouteMovementFromIndex] || targetLocation)
            : targetLocation;
        const distanceSourceCoords =
          isRouteSpecificHotspot && routeChainMatch.matches
            ? await getRouteLegCoords(effectiveRouteMovementFromIndex)
            : (startLat && startLon ? { lat: startLat, lon: startLon } : undefined);

        if (distanceSourceCoords?.lat && distanceSourceCoords?.lon && hsLat && hsLon && hotspotPrimaryLocation) {
          const distanceResult = await this.distanceHelper.fromSourceAndDestination(
            tx,
            distanceSourceLocation,
            hotspotPrimaryLocation,
            this.callbacks.getTravelLocationType(distanceSourceLocation, hotspotPrimaryLocation),
            distanceSourceCoords,
            { lat: hsLat, lon: hsLon },
          );

          const numericDistance = Number(
            String(distanceResult.distanceKm ?? '')
              .replace(/[^0-9.]/g, ''),
          );
          if (Number.isFinite(numericDistance) && numericDistance > 0) {
            distance = numericDistance;
          }
        }

        if (!Number.isFinite(distance)) {
          distance = 999999;
        }

        const hotspotWithDistance = { ...h, hotspot_distance: distance };

        if (excludedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
          const hotspotId = Number(h.hotspot_ID ?? 0);
 console.log(`[Timeline] Hotspot ${hotspotId} (${h.hotspot_name}) REJECTED for route ${routeId} - it's in excluded list`);
          this.callbacks.logHotspotCandidateEvaluation({
            routeId,
            hotspotId: hotspotId,
            name: String(h.hotspot_name || h.hotspot_location || `hotspot_${hotspotId}`),
            matchedBucket: 'prefilter',
            priority: Number(h.hotspot_priority ?? 0),
            isMustVisit: Number(h.hotspot_priority ?? 0) > 0,
            distanceFromRoute: Number.isFinite(distance) ? distance : null,
            openingTime: null,
            closingTime: null,
            visitTime: '',
            isOpenAtVisitTime: false,
            selected: false,
            rejectedReasons: ['Rejected: excluded'],
          });
          continue;
        }


 // PHP PARITY: Lines showing categorization:
 // if ($source_match) :
 // $source_location_hotspots[] = $hotspot_details;
 // endif;
 // if ($destination_match) :
 // $destination_hotspots[] = $hotspot_details;
 // endif;

 // CRITICAL: Hotspot can be in BOTH buckets (e.g., hotspot_location = "Chennai|Pondicherry")
 // Deduplication happens AFTER bucket selection based on direct flag
        if (isRouteSpecificHotspot) {
          enRouteHotspots.push({
            ...hotspotWithDistance,
            __bucket: 'en_route',
            matched_bucket: 'en_route',
            __route_chain_from_index: effectiveRouteMovementFromIndex,
            __route_chain_to_index: routeChainMatch.toIndex,
            __route_movement_order: this.callbacks.routeMovementOrder(
              effectiveRouteMovementFromIndex,
              routeChainMatch.toIndex,
              'en_route',
            ),
            __bucket_reason: 'route_specific_hotspot_matches_route_chain',
          });
          if (debugBucketIds.has(debugHotspotId)) {
 console.log('[FETCH_SELECTED_BUCKETS_DEBUG]', {
              routeId,
              sourceCity: targetLocation,
              destinationCity: nextLocation,
              routeChain: routeLegs,
              candidate: {
                hotspot_ID: debugHotspotId,
                hotspot_name: String(h.hotspot_name || ''),
                __bucket: 'en_route',
                hotspot_location: String(h.hotspot_location || ''),
                hotspot_to_location: String(h.hotspot_to_location || h.hotspot_location || ''),
                hotspot_priority: Number(h.hotspot_priority ?? 0),
                routeChainMatch,
              },
            });
          }
          continue;
        } else {
          if (matchesSource && !shouldSuppressSourceHotspotsForMovementTransfer) {
            sourceLocationHotspots.push({ ...hotspotWithDistance, __bucket: 'source' });
            if (debugBucketIds.has(debugHotspotId)) {
 console.log('[FETCH_SELECTED_BUCKETS_DEBUG]', {
                routeId,
                sourceCity: targetLocation,
                destinationCity: nextLocation,
                locationId: Number((route as any)?.location_id || 0),
                candidate: {
                  hotspot_ID: debugHotspotId,
                  hotspot_name: String(h.hotspot_name || ''),
                  __bucket: 'source',
                  matched_bucket: null,
                  hotspot_location: String(h.hotspot_location || ''),
                  hotspot_to_location: String(h.hotspot_to_location || h.hotspot_location || ''),
                  hotspot_priority: Number(h.hotspot_priority ?? 0),
                },
              });
            }
          }

          if (matchesDestination) {
            destinationHotspots.push({ ...hotspotWithDistance, __bucket: 'destination' });
            if (debugBucketIds.has(debugHotspotId)) {
 console.log('[FETCH_SELECTED_BUCKETS_DEBUG]', {
                routeId,
                sourceCity: targetLocation,
                destinationCity: nextLocation,
                locationId: Number((route as any)?.location_id || 0),
                candidate: {
                  hotspot_ID: debugHotspotId,
                  hotspot_name: String(h.hotspot_name || ''),
                  __bucket: 'destination',
                  matched_bucket: null,
                  hotspot_location: String(h.hotspot_location || ''),
                  hotspot_to_location: String(h.hotspot_to_location || h.hotspot_location || ''),
                  hotspot_priority: Number(h.hotspot_priority ?? 0),
                },
              });
            }
          }
        }
      }

      for (const viaRoute of viaRoutes) {
        const viaLocationName = String(
          (viaRoute as any)?.itinerary_via_location_name ??
            (viaRoute as any)?.via_route_name ??
            '',
        ).trim();
        if (!viaLocationName) continue;

        const viaLegIndex = routeLegs.findIndex((leg) =>
          this.callbacks.hotspotLocationMatchesCity(leg, viaLocationName) ||
          this.callbacks.hotspotLocationMatchesCity(viaLocationName, leg),
        );

        for (const h of allHotspots) {
          if (allowedHotspotIds && !allowedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
            this.callbacks.logHotspotCandidateEvaluation({
              routeId,
              hotspotId: Number(h.hotspot_ID ?? 0),
              name: String(h.hotspot_name || h.hotspot_location || `hotspot_${Number(h.hotspot_ID ?? 0)}`),
              matchedBucket: 'via',
              priority: Number(h.hotspot_priority ?? 0),
              isMustVisit: Number(h.hotspot_priority ?? 0) > 0,
              distanceFromRoute: null,
              openingTime: null,
              closingTime: null,
              visitTime: '',
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: ['Rejected: day-of-week mismatch'],
            });
            continue;
          }

          if (excludedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
            continue;
          }

          const hotspotFromLocation = String(h.hotspot_location || '').trim();
          const hotspotToLocation = String(h.hotspot_to_location || h.hotspot_location || '').trim();
          const hotspotPrimaryLocation = hotspotFromLocation
            .split('|')[0]
            .trim();
          const isRouteSpecificHotspot =
            hotspotFromLocation.toLowerCase() !== hotspotToLocation.toLowerCase();

          const isExplicitViaStop =
            this.callbacks.hotspotNameMatchesLocation(h, viaLocationName) ||
            containsLocation(hotspotFromLocation, viaLocationName);

          if (isRouteSpecificHotspot && !this.callbacks.hotspotNameMatchesLocation(h, viaLocationName)) {
            continue;
          }

          if (!isExplicitViaStop) {
            continue;
          }

          const hsLat = Number(h.hotspot_latitude ?? 0);
          const hsLon = Number(h.hotspot_longitude ?? 0);
          let distance = Number.POSITIVE_INFINITY;

          if (startLat && startLon && hsLat && hsLon && hotspotPrimaryLocation) {
            const distanceResult = await this.distanceHelper.fromSourceAndDestination(
              tx,
              targetLocation,
              hotspotPrimaryLocation,
              this.callbacks.getTravelLocationType(targetLocation, hotspotPrimaryLocation),
              { lat: startLat, lon: startLon },
              { lat: hsLat, lon: hsLon },
            );

            const numericDistance = Number(
              String(distanceResult.distanceKm ?? '')
                .replace(/[^0-9.]/g, ''),
            );
            if (Number.isFinite(numericDistance) && numericDistance > 0) {
              distance = numericDistance;
            }
          }

          if (!Number.isFinite(distance)) {
            distance = 999999;
          }

          viaRouteHotspots.push({
            ...h,
            hotspot_distance: distance,
            __bucket: 'via',
            matched_bucket: 'via',
            __explicit_via_stop: true,
            __route_chain_from_index: Math.max(0, viaLegIndex - 1),
            __route_chain_to_index: viaLegIndex >= 0 ? viaLegIndex : 1,
            __route_movement_order: this.callbacks.routeMovementOrder(
              Math.max(0, viaLegIndex - 1),
              viaLegIndex >= 0 ? viaLegIndex : 1,
              'via_stop',
            ),
            __bucket_reason: 'explicit_via_route_stop',
          });
        }
      }

 // PHP parity: keep bucket ordering simple (priority then distance), no greedy re-scoring.
      const sortHotspots = (hotspots: any[]) => {
        hotspots.sort((a: any, b: any) => {
          const ap = Number(a.hotspot_priority ?? 0);
          const bp = Number(b.hotspot_priority ?? 0);
          const ar = ap > 0 ? ap : 9999;
          const br = bp > 0 ? bp : 9999;
          if (ar !== br) return ar - br;

          if (ar === 9999 && br === 9999) {
            const bucket = String(a.__bucket || b.__bucket || '');
            if (bucket === 'source') {
              return Number(a.hotspot_ID ?? 0) - Number(b.hotspot_ID ?? 0);
            }
          }

          const ad = Number(a.hotspot_distance ?? Number.POSITIVE_INFINITY);
          const bd = Number(b.hotspot_distance ?? Number.POSITIVE_INFINITY);
          if (ad !== bd) return ad - bd;

          return Number(a.hotspot_ID ?? 0) - Number(b.hotspot_ID ?? 0);
        });
      };

 // PHP BEHAVIOR: Sort individual location buckets, NOT the final combined list
      sortHotspots(sourceLocationHotspots);
      sortHotspots(enRouteHotspots);
      sortHotspots(destinationHotspots);
      sortHotspots(viaRouteHotspots);

 // Apply max source hotspots limit if specified (for Day 1 arrival city)
      if (maxSourceHotspots && maxSourceHotspots > 0 && sourceLocationHotspots.length > maxSourceHotspots) {
 // Limit to top priority hotspots only
        sourceLocationHotspots = sourceLocationHotspots.slice(0, maxSourceHotspots);
      }

 // PHP does NOT filter priority=0, it just sorts them to the END
 // Time constraints and route_end_time will naturally prevent low-priority hotspots
 // from being added if there's not enough time

 // PHP PARITY: Process hotspots based on direct_to_next_visiting_place
 // Concatenate buckets in the order PHP processes them
      let matchingHotspots: any[] = [];

      const sameSourceAndDestination =
        String(targetLocation || '').trim().toLowerCase() ===
        String(nextLocation || '').trim().toLowerCase();
      const hasViaHotspots = viaRouteHotspots.length > 0;

      if (Number(directToNextVisitingPlace || 0) === 1) {
        const explicitDestinationHotspots = allHotspots
          .filter((h: any) => {
            const hotspotId = Number(h.hotspot_ID || 0);
            if (!hotspotId) return false;

            const hotspotFromLocation = String(h.hotspot_location || '');
            const hotspotToLocation = String(h.hotspot_to_location || hotspotFromLocation || '');
            const fromKey = this.callbacks.canonicalCityKey(hotspotFromLocation);
            const toKey = this.callbacks.canonicalCityKey(hotspotToLocation);
            const isRouteSpecific = fromKey !== '' && toKey !== '' && fromKey !== toKey;

            const isDestinationCityHotspot = this.callbacks.hotspotLocationMatchesCity(hotspotFromLocation, nextLocation);
            if (!isDestinationCityHotspot) return false;
            if (isRouteSpecific) return false;
            return true;
          })
          .map((h: any) => ({
            ...h,
            hotspot_distance: Number(h.hotspot_distance ?? 0),
            __bucket: 'destination',
            matched_bucket: 'destination',
          }));

        if (destinationHotspots.length === 0 && explicitDestinationHotspots.length > 0) {
          destinationHotspots = explicitDestinationHotspots;
          sortHotspots(destinationHotspots);
        }

        this.callbacks.logBookingRule({
          rule: 'DIRECT_ROUTE_DESTINATION_POOL_DEBUG',
          planId,
          routeId,
          sourceCity: targetLocation,
          destinationCity: nextLocation,
          directToNext: directToNextVisitingPlace,
          destinationHotspotCount: destinationHotspots.length,
          destinationHotspotSample: destinationHotspots.slice(0, 10).map((h: any) => ({
            hotspotId: Number(h.hotspot_ID || 0),
            name: String(h.hotspot_name || ''),
            bucket: String(h.__bucket || h.matched_bucket || ''),
            location: String(h.hotspot_location || ''),
            toLocation: String(h.hotspot_to_location || ''),
            priority: Number(h.hotspot_priority ?? 0),
          })),
        });
      }

      const compareRouteMovementCandidates = (a: any, b: any) => {
        const ao = Number(a.__route_movement_order ?? 999999);
        const bo = Number(b.__route_movement_order ?? 999999);
        if (ao !== bo) return ao - bo;

        const ap = Number(a.hotspot_priority ?? 0);
        const bp = Number(b.hotspot_priority ?? 0);
        const ar = ap > 0 ? ap : 9999;
        const br = bp > 0 ? bp : 9999;
        if (ar !== br) return ar - br;

        const ad = Number(a.hotspot_distance ?? Number.POSITIVE_INFINITY);
        const bd = Number(b.hotspot_distance ?? Number.POSITIVE_INFINITY);
        if (ad !== bd) return ad - bd;

        return Number(a.hotspot_ID ?? 0) - Number(b.hotspot_ID ?? 0);
      };

      const routeMovementHotspots = [
        ...enRouteHotspots,
        ...viaRouteHotspots,
      ].sort(compareRouteMovementCandidates);

      const sourceCandidatesForRoute = shouldSuppressSourceHotspotsForMovementTransfer
        ? []
        : sourceLocationHotspots;

      if (sameSourceAndDestination && hasViaHotspots) {
        matchingHotspots = routeMovementHotspots;
      } else if (directToNextVisitingPlace === 1 && !hasExplicitViaRoutes) {
        matchingHotspots = skipDestinationHotspots
          ? routeMovementHotspots
          : [...routeMovementHotspots, ...destinationHotspots];
      } else if (hasExplicitViaRoutes && isIntercityRouteForBucket) {
        matchingHotspots = skipDestinationHotspots
          ? routeMovementHotspots
          : [...routeMovementHotspots, ...destinationHotspots];
      } else {
        matchingHotspots = skipDestinationHotspots
          ? [...sourceCandidatesForRoute, ...enRouteHotspots, ...viaRouteHotspots]
          : [...sourceCandidatesForRoute, ...enRouteHotspots, ...viaRouteHotspots, ...destinationHotspots];
      }

 // PHP parity: keep bucket-level candidates distinct.
 // The same hotspot can be tested in source and later in destination loops.
 // De-dup only exact (hotspot_ID + bucket) duplicates.
      const seen = new Set<string>();
      const uniqueHotspots: any[] = [];
      for (const h of matchingHotspots) {
        const id = Number(h.hotspot_ID ?? 0) || 0;
        const bucket = String(h.__bucket || 'unknown');
        const key = `${id}:${bucket}`;
        if (!id || seen.has(key)) continue;
        seen.add(key);
        uniqueHotspots.push(h);
      }

      const isIntercityRouteForFinalCorridorOverride =
        isIntercityRouteForBucket;

      const finalCandidates = uniqueHotspots.map((h: any) => {
        const hotspotId = Number(h.hotspot_ID || 0);
        const master = allHotspots.find((x: any) => Number(x.hotspot_ID || 0) === hotspotId) || h;
        const masterLocation = String(master.hotspot_location || '');
        const masterToLocation = String(master.hotspot_to_location || master.hotspot_location || '');
        const routeChainMatch = this.callbacks.routeSpecificHotspotMatchesRouteChain(
          masterLocation,
          masterToLocation,
          routeLegs,
        );
        const forceEnRoute = isIntercityRouteForFinalCorridorOverride && routeChainMatch.matches;
        const finalBucket = forceEnRoute ? 'en_route' : String(h.__bucket || 'unknown').toLowerCase();
        return {
          ...h,
          __bucket: finalBucket,
          __master_location: masterLocation,
          __master_to_location: masterToLocation,
          __route_chain_from_index:
            Number(h.__route_chain_from_index ?? (routeChainMatch.matches ? routeChainMatch.fromIndex : -1)),
          __route_chain_to_index:
            Number(h.__route_chain_to_index ?? (routeChainMatch.matches ? routeChainMatch.toIndex : -1)),
          __route_movement_order:
            Number(
              h.__route_movement_order ??
                (routeChainMatch.matches
                  ? this.callbacks.routeMovementOrder(routeChainMatch.fromIndex, routeChainMatch.toIndex, 'en_route')
                  : 999999),
            ),
          __bucket_reason: forceEnRoute ? 'scheduler_route_chain_override' : String(h.__bucket_reason || 'original'),
        };
      });

      const seenCandidateIds = new Set<number>();
      const dedupedFinalCandidates = finalCandidates.filter((candidate: any) => {
        const id = Number(candidate?.hotspot_ID || 0);
        if (!id) return true;
        if (seenCandidateIds.has(id)) return false;
        seenCandidateIds.add(id);
        return true;
      });

      this.callbacks.logBookingRule({
        rule: 'FINAL_BUCKET_CLASSIFICATION_PROOF',
        quoteId: null,
        planId,
        routeId,
        sourceCity: String(targetLocation || ''),
        destinationCity: String(nextLocation || ''),
        candidates: dedupedFinalCandidates.map((h: any) => ({
          hotspotId: Number(h.hotspot_ID || 0),
          name: String(h.hotspot_name || ''),
          masterLocation: String(h.__master_location || ''),
          masterToLocation: String(h.__master_to_location || ''),
          finalBucket: String(h.__bucket || ''),
          reason: String(h.__bucket_reason || ''),
        })),
      });

      if (
        process.env.DEBUG_HOTSPOT_WRITER === '1' ||
        process.env.NODE_ENV !== 'production'
      ) {
 console.log('[HOTSPOT_RCA] hotspot candidates', {
          planId,
          routeId,
          sourceName: String(targetLocation || ''),
          destName: String(nextLocation || ''),
          normalizedSource: this.callbacks.canonicalCityKey(String(targetLocation || '')),
          normalizedDest: this.callbacks.canonicalCityKey(String(nextLocation || '')),
          locationId: Number((route as any)?.location_id || 0),
          candidateCount: dedupedFinalCandidates.length,
          insertedCount: dedupedFinalCandidates.length,
        });
      }

      return dedupedFinalCandidates.map((h: any, index: number) => ({
        hotspot_ID: Number(h.hotspot_ID ?? 0) || 0,
        display_order: Number(h.hotspot_priority ?? index + 1) || index + 1,
        hotspot_priority: Number(h.hotspot_priority ?? 0) || 0,
        matched_bucket: String(h.__bucket || 'unknown'),
        hotspot_distance: Number(h.hotspot_distance ?? 0) || 0,
        hotspot_name: String(h.hotspot_name || ''),
        hotspot_location: String(h.__master_location || h.hotspot_location || ''),
        hotspot_to_location: String(
          h.__master_to_location ||
            h.hotspot_to_location ||
            h.hotspot_location ||
            '',
        ),
        hotspot_type: String(h.hotspot_type || ''),
        hotspotType: String(h.hotspot_type || ''),
        __route_chain_from_index: Number(h.__route_chain_from_index ?? -1),
        __route_chain_to_index: Number(h.__route_chain_to_index ?? -1),
        __route_movement_order: Number(h.__route_movement_order ?? 999999),
        __explicit_via_stop: Boolean(h.__explicit_via_stop),
        __bucket_reason: String(h.__bucket_reason || ''),
      } as any));
    } catch (err) {
 console.error("[fetchSelectedHotspots] Error:", err);
      return [];
    }
  }

 /**
   * Get the "location name" (city) of a hotspot.
   *
   * In PHP, this is whatever you used in getSTOREDLOCATION_ID_FROM_SOURCE_AND_DESTINATION
   * when travelling to a hotspot.
   *
   * TODO: Adjust the field you return:
   *   - hotspot_location
   *   - hotspot_city
   *   - city
   *   - etc. depending on your dvi_hotspot_place schema.
 */
}
