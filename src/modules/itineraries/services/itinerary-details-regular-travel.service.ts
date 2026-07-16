type RegularTravelContext = Record<string, any>;

export class ItineraryDetailsRegularTravelService {
  async append(context: RegularTravelContext): Promise<RegularTravelContext> {
    let {
      facade,
      rh,
      viaLocationName,
      master,
      location,
      route,
      plan,
      routeHotspots,
      travelSegmentSemantics,
      previousStopName,
      pendingForcedManualConflictRows,
      insertedForcedManualConflictHotspotIds,
      startHotspot,
      startTimeText,
      endTimeText,
      travelDuration,
      routeHotelMap,
      routes,
      index,
      hotspotMap,
      hotspotGalleryMap,
      pushHotspotAnchorPlaceholder,
      normalizeName,
      findNextSemanticDestinationName,
      inferHotspotIdFromLabel,
      getRouteHotelName,
      proofQuoteEnabled,
      quoteId,
      segments,
      seenAttraction,
      emittedTravelBeforeFirstAttraction,
      totalDistanceKm,
    } = context;

    let distanceNum = Number(context.distanceNum ?? 0);
    let travelDistance = context.travelDistance;

            // Regular travel to hotspot - use precomputed semantic mapping
            const semanticMapping = travelSegmentSemantics.get(rh.route_hotspot_ID);
            let fromName = semanticMapping?.from ?? previousStopName;  // Fallback only if not in map
            let toName = semanticMapping?.to ?? 
              master?.hotspot_name ??
              viaLocationName ??
              (rh.hotspot_ID === 0 ? route.next_visiting_location : null) ??
              previousStopName;

            // In force-conflict mode, keep the manually inserted conflict hotspot in sequence:
            // Hotel -> [manual conflict hotspot] -> next scheduled attraction.
            if (pendingForcedManualConflictRows.length > 0) {
              for (const forcedRow of pendingForcedManualConflictRows) {
                const forcedHotspotId = Number((forcedRow as any)?.hotspot_ID ?? 0);
                if (!forcedHotspotId || insertedForcedManualConflictHotspotIds.has(forcedHotspotId)) {
                  continue;
                }

                const forcedMaster = hotspotMap.get(forcedHotspotId);
                const forcedName = String(forcedMaster?.hotspot_name ?? '').trim();
                if (!forcedName) {
                  insertedForcedManualConflictHotspotIds.add(forcedHotspotId);
                  continue;
                }

                const preManualStart =
                  facade.formatTime((startHotspot as any)?.hotspot_start_time ?? null) ||
                  facade.formatTime(route.route_start_time as any) ||
                  startTimeText;
                const preManualEnd = startTimeText || preManualStart;
                const preManualRange = facade.orderedTimeRange(preManualStart, preManualEnd);
                const forcedDurationMinutes = facade.durationToMinutes((forcedMaster as any)?.hotspot_duration ?? null);
                const conflictVisitStart = preManualEnd || preManualStart;
                const conflictVisitStartMinutes = facade.parseDisplayTimeMinutesStrict(conflictVisitStart);
                const conflictVisitEnd =
                  conflictVisitStartMinutes !== null && forcedDurationMinutes !== null
                    ? facade.minutesToDisplayTime(conflictVisitStartMinutes + forcedDurationMinutes)
                    : conflictVisitStart;
                const conflictVisitRange = facade.orderedTimeRange(conflictVisitStart, conflictVisitEnd);
                const conflictVisitTime = conflictVisitRange
                  ? `${conflictVisitRange} (Manual override)`
                  : 'Manual override';

                const previousDayHotelName =
                  index > 0
                    ? routeHotelMap.get(routes[index - 1].itinerary_route_ID)?.hotel_name ?? null
                    : null;
                const travelFrom = previousDayHotelName || previousStopName?.trim() || fromName;
                if (travelFrom && normalizeName(travelFrom) !== normalizeName(forcedName)) {
                  pushHotspotAnchorPlaceholder({
                    from: travelFrom,
                    to: forcedName,
                    timeRange: preManualRange,
                  });

                  segments.push({
                    type: 'travel' as const,
                    from: travelFrom,
                    to: forcedName,
                    timeRange: preManualRange,
                    distance: '--',
                    duration:
                      facade.formatDurationFromDisplayRange(preManualStart, preManualEnd) ||
                      facade.formatDuration('00:00:00'),
                    note: 'This may vary due to traffic conditions',
                    isConflict: true,
                    conflictReason: 'Forced manual insertion after user confirmation.',
                  });
                }

                segments.push({
                  type: 'attraction' as const,
                  name: forcedName,
                  description: forcedMaster?.hotspot_description ?? '',
                  visitTime: conflictVisitTime,
                  duration: facade.formatDuration((forcedMaster as any)?.hotspot_duration ?? null),
                  amount: null,
                  timings: '',
                  image: (hotspotGalleryMap.get(forcedHotspotId) ?? [])[0] ?? null,
                  galleryImages: hotspotGalleryMap.get(forcedHotspotId) ?? [],
                  videoUrl: forcedMaster?.hotspot_video_url ?? null,
                  planOwnWay: true,
                  activities: [],
                  hasAvailableActivities: false,
                  hotspotId: forcedHotspotId,
                  routeHotspotId: (forcedRow as any)?.route_hotspot_ID,
                  locationId: route.location_id ? Number(route.location_id) : null,
                  priority: Number((forcedMaster as any)?.hotspot_priority || 9999),
                  isConflict: true,
                  conflictReason: 'Forced manual insertion after user confirmation.',
                  isManual: true,
                  isDeleted: false,
                });

                insertedForcedManualConflictHotspotIds.add(forcedHotspotId);
                previousStopName = forcedName;
                fromName = forcedName;
                seenAttraction = true;
                emittedTravelBeforeFirstAttraction = true;
              }
            }

            if (toName === "Hotel") {
              const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
              if (hotelInfo?.hotel_name) {
                toName = hotelInfo.hotel_name;
              }
            }

            const initiallyDerivedToName = toName;
            let nextSemanticDestinationChosen: string | null = null;
            let usedNextSemanticDestination = false;

            if (proofQuoteEnabled) {
              console.log('[Item3RegularTravelBeforeLookahead][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                hotspotOrder: (rh as any).hotspot_order,
                hotspotId: Number(rh.hotspot_ID ?? 0),
                semanticMappingFound: !!semanticMapping,
                derivedFromName: fromName,
                derivedToNameInitial: initiallyDerivedToName,
                rowTimes: `${startTimeText} - ${endTimeText}`,
                rowDistance: travelDistance,
              });
            }

            if (
              normalizeName(fromName) === normalizeName(toName) &&
              Number(rh.hotspot_ID ?? 0) > 0
            ) {
              const currentIndex = routeHotspots.indexOf(rh);
              nextSemanticDestinationChosen =
                currentIndex >= 0
                  ? findNextSemanticDestinationName(routeHotspots, currentIndex)
                  : null;

              if (nextSemanticDestinationChosen) {
                toName = nextSemanticDestinationChosen;
                usedNextSemanticDestination = true;
              }
            }

            if (proofQuoteEnabled) {
              console.log('[Item3LookaheadResult][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                fromEqualToCondition: normalizeName(fromName) === normalizeName(initiallyDerivedToName),
                nextSemanticDestinationChosen,
                usedNextSemanticDestination,
                finalToName: toName,
              });
            }

            const currentRowIndex = routeHotspots.indexOf(rh);
            const hasUpcomingHotelSegment =
              currentRowIndex >= 0 &&
              routeHotspots
                .slice(currentRowIndex + 1)
                .some((nextRow) => {
                  const nextType = Number((nextRow as any).item_type ?? 0);
                  return nextType === 5 || nextType === 6;
                });

            const routeHotelName = getRouteHotelName();
            const destinationCityLabel =
              route.next_visiting_location ??
              location?.destination_location ??
              null;

            // When this is the terminal city-level travel right before hotel rows,
            // prefer the resolved hotel name so travel + checkin are consistent.
            if (
              hasUpcomingHotelSegment &&
              Number(rh.hotspot_ID ?? 0) === 0 &&
              destinationCityLabel &&
              normalizeName(toName) === normalizeName(destinationCityLabel) &&
              normalizeName(routeHotelName) !== '' &&
              normalizeName(routeHotelName) !== 'hotel' &&
              normalizeName(routeHotelName) !== normalizeName(destinationCityLabel)
            ) {
              toName = routeHotelName;
            }

            if (proofQuoteEnabled) {
              console.log('[TravelSegment][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                hotspotOrder: (rh as any).hotspot_order,
                itemType: 3,
                hotspotId: rh.hotspot_ID,
                semanticFrom: fromName,
                initiallyDerivedToName,
                nextSemanticDestinationChosen,
                finalFrom: fromName,
                finalTo: toName,
                fallbackUsed: !usedNextSemanticDestination,
              });
            }

            const resolvedDistanceKm = await facade.resolveTravelDistanceKm({
              row: rh,
              itemType: 3,
              location,
              route,
              semanticFromHotspotId:
                semanticMapping?.fromHotspotId
                ?? inferHotspotIdFromLabel(fromName)
                ?? null,
              semanticToHotspotId:
                semanticMapping?.toHotspotId
                ?? inferHotspotIdFromLabel(toName)
                ?? (Number(rh.hotspot_ID ?? 0) || null),
              fromName,
              toName,
              hotspotMap,
            });
            distanceNum = resolvedDistanceKm ?? 0;
            travelDistance = facade.formatTravelDistance(resolvedDistanceKm);

            if (Number.isFinite(distanceNum) && distanceNum > 0) {
              totalDistanceKm += distanceNum;
            }

            if (proofQuoteEnabled) {
              console.log('[Item3SegmentEmitted][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                type: 'travel',
                from: fromName,
                to: toName,
                timeRange: facade.orderedTimeRange(startTimeText, endTimeText),
                distance: travelDistance,
                duration: facade.formatDuration(travelDuration),
              });
            }

            const travelRange = facade.orderedTimeRange(startTimeText, endTimeText);

            pushHotspotAnchorPlaceholder({
              from: fromName,
              to: toName,
              timeRange: travelRange,
            });
            segments.push({
              type: "travel" as const,
              from: fromName,
              to: toName,
              timeRange: travelRange,
              distance: travelDistance,
              duration: facade.formatDuration(travelDuration),
              note: "This may vary due to traffic conditions",
              isConflict: (rh as any).is_conflict === 1,
              conflictReason: (rh as any).conflict_reason ?? null,
            });

            if (!seenAttraction) {
              emittedTravelBeforeFirstAttraction = true;
            }

            previousStopName = toName;
    return { previousStopName, segments, seenAttraction, emittedTravelBeforeFirstAttraction, totalDistanceKm, insertedForcedManualConflictHotspotIds };
  }
}
