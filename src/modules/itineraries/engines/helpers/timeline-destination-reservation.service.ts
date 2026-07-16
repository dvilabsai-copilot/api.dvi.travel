export interface TimelineDestinationReservationInput {
  tx: any;
  planId: number;
  routeIndex: number;
  route: any;
  plan: any;
  nextRoute: any;
  sourceCity: string;
  destinationCity: string;
  currentRouteViaLocationNames: string[];
  isEligibleForDestinationReservation: boolean;
  isIntercityMovementFirstTransfer: boolean;
  allHotspots: any[];
  addedHotspotIds: Set<number>;
  selectedHotspots: any[];
  hotspotMap: Map<number, any>;
  minimumReservationCount: number;
  estimateRouteHotspotCapacity: (...args: any[]) => number;
  isHotspotAlreadyPlanned: (...args: any[]) => boolean;
  fetchSelectedHotspots: (...args: any[]) => Promise<any[]>;
  fetchDay1TopPrioritySourceHotspots: (...args: any[]) => Promise<any[]>;
  hotspotLocationMatchesCity: (...args: any[]) => boolean;
  logBookingRule: (...args: any[]) => void;
}

export class TimelineDestinationReservationService {
  async apply(input: TimelineDestinationReservationInput): Promise<any[]> {
    let selectedHotspots = input.selectedHotspots;
    const {
      tx,
      planId,
      routeIndex,
      route,
      plan,
      nextRoute,
      sourceCity,
      destinationCity,
      currentRouteViaLocationNames,
      isEligibleForDestinationReservation,
      isIntercityMovementFirstTransfer,
      allHotspots,
      addedHotspotIds,
      hotspotMap,
    } = input;

          let shouldReserveDestinationHotspotsForNextLoopbackDay = false;
          let nextLoopbackAvailableCount = 0;
          let nextLoopbackMinimumRequired = input.minimumReservationCount;
          if (isEligibleForDestinationReservation && nextRoute) {
            const nextRouteCandidates = await input.fetchSelectedHotspots(
              tx,
              planId,
              Number((nextRoute as any).itinerary_route_ID || 0),
              allHotspots,
            );
            const uniqueNextRouteIds = new Set<number>();
            for (const candidate of nextRouteCandidates as any[]) {
              const hotspotId = Number((candidate as any).hotspot_ID || 0);
              if (!hotspotId || uniqueNextRouteIds.has(hotspotId)) continue;
              uniqueNextRouteIds.add(hotspotId);
              if (input.isHotspotAlreadyPlanned(hotspotId)) continue;
              nextLoopbackAvailableCount++;
            }
    
            const nextRouteCapacity = input.estimateRouteHotspotCapacity(nextRoute as any);
            nextLoopbackMinimumRequired = Math.max(
              1,
              Math.min(input.minimumReservationCount, nextRouteCapacity),
            );
    
            shouldReserveDestinationHotspotsForNextLoopbackDay =
              nextLoopbackAvailableCount >= nextLoopbackMinimumRequired;
    
            input.logBookingRule({
              rule: 'DESTINATION_RESERVATION_FEASIBILITY_CHECK',
              quoteId:
                (plan as any).quote_id ??
                (plan as any).quoteId ??
                (plan as any).quote_ID ??
                null,
              planId,
              routeId: route.itinerary_route_ID,
              sourceCity,
              destinationCity,
              nextRouteId: Number((nextRoute as any).itinerary_route_ID || 0),
              availableCount: nextLoopbackAvailableCount,
              minimumRequired: nextLoopbackMinimumRequired,
              staticMinimumCap: input.minimumReservationCount,
              willReserve: shouldReserveDestinationHotspotsForNextLoopbackDay,
              reason:
                'Reserve destination hotspots for next loopback day only when destination has enough candidates for estimated route capacity.',
            });
          }
    
          if (shouldReserveDestinationHotspotsForNextLoopbackDay) {
            const beforeReservationCandidates = [...selectedHotspots];
            const beforeCount = selectedHotspots.length;
    
            const destinationBucketCountBeforeReservation = beforeReservationCandidates.filter((h: any) => {
              const bucket = String((h as any).matched_bucket || '').toLowerCase();
              return bucket === 'destination' || bucket === 'dest';
            }).length;
    
            // Reserve destination-city candidates for the next same-city/local day,
            // but do not blindly destroy the current route's candidate pool.
            selectedHotspots = selectedHotspots.filter((h: any) => {
              if ((h as any).isManualSelection) return true;
    
              const hotspotId = Number((h as any).hotspot_ID || 0);
              if (!hotspotId) return false;
              if (input.isHotspotAlreadyPlanned(hotspotId)) return false;
    
              const bucket = String((h as any).matched_bucket || '').toLowerCase();
              return bucket !== 'destination' && bucket !== 'dest';
            });
    
            let sourceFallbackRows: any[] = [];
            if (!isIntercityMovementFirstTransfer) {
              const sourceFallback = await input.fetchDay1TopPrioritySourceHotspots(
                tx,
                planId,
                route.itinerary_route_ID,
                sourceCity,
                destinationCity,
                addedHotspotIds,
                Math.max(6, Math.min(20, input.estimateRouteHotspotCapacity(route as any) * 2)),
                true,
              );
    
              if (sourceFallback.length > 0) {
                sourceFallbackRows = sourceFallback
                  .map((h: any) => {
                    const hotspotId = Number((h as any).hotspot_ID || 0);
                    const master = hotspotMap.get(hotspotId) as any;
                    return {
                      ...h,
                      hotspot_ID: hotspotId,
                      hotspot_name: String((h as any).hotspot_name || master?.hotspot_name || ''),
                      hotspot_location: String((h as any).hotspot_location || master?.hotspot_location || ''),
                      hotspot_to_location: String(
                        (h as any).hotspot_to_location ||
                          master?.hotspot_to_location ||
                          master?.hotspot_location ||
                          '',
                      ),
                      matched_bucket: 'source_fallback',
                    };
                  })
                  .filter((h: any) => {
                    const hotspotId = Number((h as any).hotspot_ID || 0);
                    if (!hotspotId) return false;
                    if (input.isHotspotAlreadyPlanned(hotspotId)) return false;
    
                    const hotspotLocation = String((h as any).hotspot_location || '');
                    const hotspotToLocation = String((h as any).hotspot_to_location || hotspotLocation || '');
    
                    const sourceMatch =
                      input.hotspotLocationMatchesCity(hotspotLocation, sourceCity) ||
                      input.hotspotLocationMatchesCity(hotspotToLocation, sourceCity);
    
                    if (!sourceMatch) {
                      input.logBookingRule({
                        rule: 'SOURCE_FALLBACK_REJECTED_SOURCE_MISMATCH',
                        quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                        planId,
                        routeId: Number(route.itinerary_route_ID || 0),
                        routeDay: Number((route as any).no_of_days || routeIndex || 0),
                        sourceCity,
                        destinationCity,
                        hotspotId,
                        hotspotName: String((h as any).hotspot_name || ''),
                        hotspotLocation,
                        hotspotToLocation,
                        reason: 'source_fallback_must_match_current_source_city',
                      });
                      return false;
                    }
    
                    return true;
                  });
    
                if (sourceFallbackRows.length > 0) {
                  selectedHotspots = [
                    ...sourceFallbackRows,
                    ...selectedHotspots,
                  ].filter((hs: any, idx: number, arr: any[]) => {
                    const id = Number((hs as any).hotspot_ID || 0);
                    if (!id) return false;
                    return arr.findIndex((x: any) => Number((x as any).hotspot_ID || 0) === id) === idx;
                  });
                }
              }
            } else {
              input.logBookingRule({
                rule: 'SOURCE_FALLBACK_SKIPPED_FOR_MOVEMENT_FIRST_TRANSFER',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: Number(route.itinerary_route_ID || 0),
                routeDay: Number((route as any).no_of_days || routeIndex || 0),
                sourceCity,
                destinationCity,
                viaLocationNames: currentRouteViaLocationNames,
                reason: 'Explicit via or direct destination route exists; source-city sightseeing must not be reintroduced before route movement.',
              });
            }
    
            // Safety net:
            // Destination reservation must not make the current route empty when source-city
            // candidates exist. This is the regression-case-07 Day 6 pattern:
            // Alleppey -> Kumarakom has exhausted Kumarakom destination inventory, but
            // still has unused Alleppey source inventory.
            if (
              !isIntercityMovementFirstTransfer &&
              selectedHotspots.length === 0 &&
              beforeReservationCandidates.length > 0
            ) {
              const rescuedSourceLikeCandidates = beforeReservationCandidates
                .filter((h: any) => {
                  if ((h as any).isManualSelection) return true;
    
                  const hotspotId = Number((h as any).hotspot_ID || 0);
                  if (!hotspotId) return false;
                  if (input.isHotspotAlreadyPlanned(hotspotId)) return false;
                  const bucket = String((h as any).matched_bucket || h?.__bucket || '').toLowerCase();
                  if (
                    bucket !== 'source' &&
                    bucket !== 'source_fallback' &&
                    bucket !== 'via' &&
                    bucket !== 'en_route' &&
                    bucket !== 'source_to_destination' &&
                    bucket !== 'matrix'
                  ) {
                    return false;
                  }
    
                  const master = hotspotMap.get(hotspotId) as any;
                  const hotspotLocation = String((h as any).hotspot_location || master?.hotspot_location || '');
                  const hotspotToLocation = String(
                    (h as any).hotspot_to_location ||
                      master?.hotspot_to_location ||
                      master?.hotspot_location ||
                      '',
                  );
    
                  // For source-like rescue, current source match is enough.
                  return (
                    input.hotspotLocationMatchesCity(hotspotLocation, sourceCity) ||
                    input.hotspotLocationMatchesCity(hotspotToLocation, sourceCity)
                  );
                })
                .slice(0, Math.max(1, input.estimateRouteHotspotCapacity(route as any)));
    
              if (rescuedSourceLikeCandidates.length > 0) {
                selectedHotspots = rescuedSourceLikeCandidates.map((h: any) => {
                  const hotspotId = Number((h as any).hotspot_ID || 0);
                  const master = hotspotMap.get(hotspotId) as any;
    
                  return {
                    ...h,
                    hotspot_ID: hotspotId,
                    hotspot_name: String((h as any).hotspot_name || master?.hotspot_name || ''),
                    hotspot_location: String((h as any).hotspot_location || master?.hotspot_location || ''),
                    hotspot_to_location: String(
                      (h as any).hotspot_to_location ||
                        master?.hotspot_to_location ||
                        master?.hotspot_location ||
                        '',
                    ),
                    matched_bucket: String((h as any).matched_bucket || (h as any).__bucket || 'source_fallback'),
                  };
                });
    
                input.logBookingRule({
                  rule: 'DESTINATION_RESERVATION_SOURCE_RESCUE_TO_AVOID_EMPTY_ROUTE',
                  quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                  planId,
                  routeId: Number(route.itinerary_route_ID || 0),
                  routeDay: Number((route as any).no_of_days || routeIndex || 0),
                  sourceCity,
                  destinationCity,
                  restoredCount: selectedHotspots.length,
                  restoredHotspotIds: selectedHotspots.map((h: any) => Number((h as any).hotspot_ID || 0)),
                  reason: 'Destination reservation would leave current intercity route empty while source-city candidates exist.',
                });
              }
            }
    
            input.logBookingRule({
              rule: 'DESTINATION_HOTSPOTS_RESERVED_FOR_NEXT_LOOPBACK_DAY',
              quoteId:
                (plan as any).quote_id ??
                (plan as any).quoteId ??
                (plan as any).quote_ID ??
                null,
              planId,
              routeId: route.itinerary_route_ID,
              sourceCity,
              destinationCity,
              nextRouteId: Number((nextRoute as any)?.itinerary_route_ID || 0),
              nextRouteSource: String((nextRoute as any)?.location_name || ''),
              nextRouteDestination: String((nextRoute as any)?.next_visiting_location || ''),
              nextLoopbackAvailableCount,
              destinationBucketCountBeforeReservation,
              sourceFallbackCount: sourceFallbackRows.length,
              filteredCount: Math.max(0, beforeCount - selectedHotspots.length),
              remainingCount: selectedHotspots.length,
              usedSourceFallback: selectedHotspots.some(
                (h: any) => String((h as any).matched_bucket || '') === 'source_fallback',
              ),
              reason:
                'Intercity route before destination loopback day: reserve destination-city hotspots for next day, but preserve current source-city candidates.',
            });
          }
    
    return selectedHotspots;
  }
}
