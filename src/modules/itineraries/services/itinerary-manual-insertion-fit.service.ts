// FILE: src/modules/itineraries/services/itinerary-manual-insertion-fit.service.ts

import { Injectable } from '@nestjs/common';

type ManualInsertionFitCallbacks = Record<string, (...args: any[]) => any>;
type ManualHotspotTimingPolicy = any;
type ManualHotspotCityContext = any;

@Injectable()
export class ItineraryManualInsertionFitService {
  private callbacks: ManualInsertionFitCallbacks = {};

  setCallbacks(callbacks: ManualInsertionFitCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async buildManualInsertionFit(
    tx: any,
    planId: number,
    routeId: number,
    candidateHotspotId: number,
    candidateHotspotName: string,
    requestedAnchorIndex: number | undefined,
    requestedAnchorType: string | undefined,
    baselineTimeline: any[] = [],
    debugEnabled = false,
    manualTimingPolicy?: ManualHotspotTimingPolicy,
    exactAnchorMode = false,
    matrixPreferredSlot?: {
      fromHotspotId?: number;
      toHotspotId?: number;
      slotIndex?: number;
      source?: 'BEST_FIT' | 'EXACT_ANCHOR';
    },
  ): Promise<any> {
    const routeRow = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        location_id: true,
        location_name: true,
        next_visiting_location: true,
        direct_to_next_visiting_place: true,
      },
    });

    const routeLocationMaster = Number(routeRow?.location_id || 0) > 0
      ? await (tx as any).dvi_stored_locations.findFirst({
          where: {
            location_ID: Number(routeRow?.location_id || 0),
            deleted: 0,
          },
          select: {
            source_location: true,
            destination_location: true,
          },
        })
      : null;

    const routeCityContext = {
      location_name: String(routeRow?.location_name || routeLocationMaster?.source_location || '').trim(),
      next_visiting_location: String(routeRow?.next_visiting_location || routeLocationMaster?.destination_location || '').trim(),
    };

    let hotspotCityContext: ManualHotspotCityContext = 'UNKNOWN';
    let destinationInsertionMode = false;
    let destinationAnchorHotspotId: number | null = null;
    let destinationAnchorName: string | null = null;
    let destinationAnchorOrder: number | null = null;
    let destinationSlotReason = 'DESTINATION_SLOT_NOT_FOUND';
    let destinationMinCandidateIndex: number | null = null;

 // 1. Fetch route's current active attraction hotspots ordered by hotspot_order
    const rawRouteAttractions: any[] = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      orderBy: { hotspot_order: 'asc' },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
      },
    });

 // Baseline-only slot source: never allow candidate C as a slot endpoint.
    const routeAttractions = rawRouteAttractions.filter(
      (r: any) => Number(r.hotspot_ID) !== Number(candidateHotspotId),
    );

    const candidateMaster = await (tx as any).dvi_hotspot_place.findFirst({
      where: { hotspot_ID: Number(candidateHotspotId), deleted: 0 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_duration: true,
        hotspot_location: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });
    const candidateDurationMinutes = candidateMaster?.hotspot_duration
      ? Math.max(1, Number(this.callbacks.timeToMinutes(candidateMaster.hotspot_duration as any)) || 0)
      : 60;

    hotspotCityContext = this.callbacks.classifyManualHotspotCityContext(routeCityContext, candidateMaster || {
      hotspot_name: candidateHotspotName,
    });
    const emptyRouteSourceCityEligible =
      routeAttractions.length === 0
      && hotspotCityContext === 'SOURCE_CITY'
      && Number(routeRow?.direct_to_next_visiting_place || 0) !== 1;
    if (routeAttractions.length === 0) {
      const cityRows = await (tx as any).$queryRawUnsafe(`
        SELECT
          from_hotspot_id AS fromHotspotId,
          from_hotspot_name AS fromName,
          to_hotspot_id AS toHotspotId,
          to_hotspot_name AS toName,
          from_endpoint_type AS fromEndpointType,
          from_location_id AS fromLocationId,
          from_location_name AS fromLocationName,
          to_endpoint_type AS toEndpointType,
          to_location_id AS toLocationId,
          to_location_name AS toLocationName,
          slot_context AS slotContext,
          between_hotspot_id AS betweenHotspotId,
          between_hotspot_name AS betweenHotspotName,
          route_fit_type AS routeFitType,
          ab_osrm_distance_km AS abOsrmDistanceKm,
          ac_osrm_distance_km AS acOsrmDistanceKm,
          cb_osrm_distance_km AS cbOsrmDistanceKm,
          inserted_route_distance_km AS insertedRouteDistanceKm,
          road_detour_km AS roadDetourKm,
          road_detour_ratio AS roadDetourRatio,
          candidate_distance_from_ab_route_meters AS candidateDistanceFromAbRouteMeters,
          destination_distance_from_ac_route_meters AS destinationDistanceFromAcRouteMeters,
          route_decision_reason AS routeDecisionReason
        FROM hotspot_route_between_map
        WHERE between_hotspot_id = ?
          AND slot_context = 'CITY_TO_CITY'
        ORDER BY
          CASE route_fit_type
            WHEN 'ON_ROUTE' THEN 1
            WHEN 'MINOR_DETOUR' THEN 2
            WHEN 'BACKTRACK' THEN 3
            WHEN 'OFF_ROUTE' THEN 4
            ELSE 9
          END,
          road_detour_km ASC
        LIMIT 5
      `, candidateHotspotId) as any[];

      const manualRelaxedRouteFit =
        manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
        && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;

      const allCitySlots = cityRows.map((row: any, index: number) => {
        const routeFitType = String(row?.routeFitType || '').toUpperCase();
        const routePossible = this.callbacks.isFeasibleFitType(routeFitType)
          || (
            manualRelaxedRouteFit
            && this.callbacks.isUsableMatrixRouteFitType(routeFitType)
          );

        return {
          slotIndex: index,
          fromHotspotId: Number(row?.fromHotspotId || 0),
          fromName: String(row?.fromLocationName || row?.fromName || 'City Start'),
          toHotspotId: Number(row?.toHotspotId || 0),
          toName: String(row?.toLocationName || row?.toName || 'City End'),
          fromEndpointType: row?.fromEndpointType || 'CITY',
          fromLocationId: Number(row?.fromLocationId || 0) || null,
          toEndpointType: row?.toEndpointType || 'CITY',
          toLocationId: Number(row?.toLocationId || 0) || null,
          routeFitType,
          slotContext: 'CITY_TO_CITY',
          cityEndpointInsertionMode: true,
          emptyRouteCityEndpointMode: true,
          label: `Insert between ${String(row?.fromLocationName || row?.fromName || 'City')} and ${String(row?.toLocationName || row?.toName || 'City')}`,
          displayLabel: `Insert between ${String(row?.fromLocationName || row?.fromName || 'City')} and ${String(row?.toLocationName || row?.toName || 'City')}`,
          shortLabel: 'City endpoint slot',
          roadDetourKm: row?.roadDetourKm == null ? null : Number(row.roadDetourKm),
          roadDetourRatio: row?.roadDetourRatio == null ? null : Number(row.roadDetourRatio),
          insertedRouteDistanceKm: row?.insertedRouteDistanceKm == null ? null : Number(row.insertedRouteDistanceKm),
          abOsrmDistanceKm: row?.abOsrmDistanceKm == null ? null : Number(row.abOsrmDistanceKm),
          acOsrmDistanceKm: row?.acOsrmDistanceKm == null ? null : Number(row.acOsrmDistanceKm),
          cbOsrmDistanceKm: row?.cbOsrmDistanceKm == null ? null : Number(row.cbOsrmDistanceKm),
          candidateDistanceFromAbRouteMeters: row?.candidateDistanceFromAbRouteMeters == null ? null : Number(row.candidateDistanceFromAbRouteMeters),
          destinationDistanceFromAcRouteMeters: row?.destinationDistanceFromAcRouteMeters == null ? null : Number(row.destinationDistanceFromAcRouteMeters),
          routePossible,
          timingPossible: routePossible,
          prioritySafe: true,
          selectedAsBest: false,
          attempted: true,
          source: 'CITY_ENDPOINT_MATRIX',
          routeDecisionReason: row?.routeDecisionReason || 'City endpoint matrix slot.',
          finalDecisionReason: routePossible
            ? 'Selected: first hotspot can be inserted using city endpoint matrix.'
            : 'Not selected: city endpoint route-fit is not feasible.',
        };
      });

      const bestCitySlot =
        allCitySlots.find((slot: any) => slot.routeFitType === 'ON_ROUTE')
        || allCitySlots.find((slot: any) => slot.routeFitType === 'MINOR_DETOUR')
        || (manualRelaxedRouteFit
          ? allCitySlots.find((slot: any) => slot.routeFitType === 'BACKTRACK' || slot.routeFitType === 'OFF_ROUTE')
          : null)
        || null;

      if (bestCitySlot) {
        bestCitySlot.selectedAsBest = true;
      }

      return {
        selectedHotspotId: candidateHotspotId,
        selectedHotspotName: candidateHotspotName,
        requestedSlot: bestCitySlot,
        bestSlot: bestCitySlot,
        chosenSlot: bestCitySlot,
        allSlotResults: allCitySlots,
        chosenSlotSource: bestCitySlot
          ? 'BEST_FIT'
          : (emptyRouteSourceCityEligible ? 'EMPTY_ROUTE_SCHEDULER' : 'NO_MATRIX_DATA'),
        routeFitAvailable: !!bestCitySlot,
        hasAnyMatrixData: allCitySlots.length > 0,
        hasFeasibleMatrixSlot: !!bestCitySlot,
        requiresMatrixBuild: allCitySlots.length === 0,
        canAutoMove: !!bestCitySlot,
        canApply: !!bestCitySlot || emptyRouteSourceCityEligible,
        selectedIncluded: !!bestCitySlot || emptyRouteSourceCityEligible,
        warning: allCitySlots.length === 0
          ? 'Route has no active attraction hotspots; build city endpoint matrix before preview/apply.'
          : (emptyRouteSourceCityEligible && !bestCitySlot)
            ? 'City endpoint matrix marks this same-city arrival route as off-route/backtracking, so fallback timing evaluation is allowed.'
          : null,
        previewBlockReason: allCitySlots.length === 0 ? 'MATRIX_MISSING' : null,
        emptyRouteInsertionMode: true,
        emptyRouteCityEndpointMode: true,
        cityEndpointInsertionMode: true,
      };
    }

    if (routeAttractions.length === 1) {
      const onlyRouteHotspotId = Number(routeAttractions[0]?.hotspot_ID || 0);
      const onlyRouteHotspotOrder = Number(routeAttractions[0]?.hotspot_order || 1);

      const citySlotRows: any[] = await (tx as any).$queryRawUnsafe(`
        SELECT
          from_hotspot_id,
          from_hotspot_name,
          to_hotspot_id,
          to_hotspot_name,
          between_hotspot_id,
          route_fit_type,
          route_decision_reason,
          road_detour_km,
          road_detour_ratio,
          ab_osrm_distance_km,
          ac_osrm_distance_km,
          cb_osrm_distance_km,
          inserted_route_distance_km,
          candidate_distance_from_ab_route_meters,
          destination_distance_from_ac_route_meters,
          from_endpoint_type,
          from_location_id,
          from_location_name,
          to_endpoint_type,
          to_location_id,
          to_location_name,
          slot_context
        FROM hotspot_route_between_map
        WHERE between_hotspot_id = ?
          AND slot_context IN ('CITY_TO_HOTSPOT', 'HOTSPOT_TO_CITY')
          AND (from_hotspot_id = ? OR to_hotspot_id = ?)
      `, Number(candidateHotspotId), onlyRouteHotspotId, onlyRouteHotspotId);

      if (!Array.isArray(citySlotRows) || citySlotRows.length === 0) {
        return {
          selectedHotspotId: candidateHotspotId,
          selectedHotspotName: candidateHotspotName,
          requestedSlot: null,
          bestSlot: null,
          chosenSlot: null,
          allSlotResults: [],
          chosenSlotSource: 'NO_MATRIX_DATA',
          routeFitAvailable: false,
          requiresMatrixBuild: true,
          canAutoMove: false,
          canApply: false,
          code: 'MANUAL_HOTSPOT_MATRIX_DATA_MISSING',
          previewBlockReason: 'MATRIX_MISSING',
          warning: 'Route-fit matrix data is missing for the single-hotspot city endpoint slots.',
          cityEndpointInsertionMode: true,
          singleHotspotAnchorHotspotId: onlyRouteHotspotId,
        };
      }

      const selectionRank = (type: string): number => {
        if (type === 'ON_ROUTE') return 1;
        if (type === 'MINOR_DETOUR') return 2;
        if (type === 'BACKTRACK') return 3;
        if (type === 'OFF_ROUTE') return 4;
        return 5;
      };

      const allSlotResults = citySlotRows.map((row: any, index: number) => {
        const slotContext = String(row?.slot_context || '').toUpperCase();
        const fromName = String(row?.from_location_name || row?.from_hotspot_name || '').trim();
        const toName = String(row?.to_location_name || row?.to_hotspot_name || '').trim();
        const routeFitType = String(row?.route_fit_type || 'UNKNOWN').toUpperCase();
        const manualRelaxedRouteFit =
          manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
          && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
        const routePossible = this.callbacks.isFeasibleFitType(routeFitType)
          || (
            manualRelaxedRouteFit
            && this.callbacks.isUsableMatrixRouteFitType(routeFitType)
          );
        const displayLabel = slotContext === 'CITY_TO_HOTSPOT'
          ? `Will be inserted between ${fromName} and ${toName}`
          : `Will be inserted between ${fromName} and ${toName}`;

        return {
          slotIndex: index,
          fromHotspotId: Number(row?.from_hotspot_id || 0),
          fromName,
          toHotspotId: Number(row?.to_hotspot_id || 0),
          toName,
          fromEndpointType: String(row?.from_endpoint_type || 'HOTSPOT').toUpperCase(),
          fromLocationId: Number(row?.from_location_id || 0) || null,
          toEndpointType: String(row?.to_endpoint_type || 'HOTSPOT').toUpperCase(),
          toLocationId: Number(row?.to_location_id || 0) || null,
          slotContext,
          routeFitType,
          label: displayLabel,
          displayLabel,
          shortLabel: slotContext === 'CITY_TO_HOTSPOT' ? 'City to hotspot' : 'Hotspot to city',
          roadDetourKm: row?.road_detour_km != null ? Number(row.road_detour_km) : null,
          roadDetourRatio: row?.road_detour_ratio != null ? Number(row.road_detour_ratio) : null,
          insertedRouteDistanceKm: row?.inserted_route_distance_km != null ? Number(row.inserted_route_distance_km) : null,
          abOsrmDistanceKm: row?.ab_osrm_distance_km != null ? Number(row.ab_osrm_distance_km) : null,
          acOsrmDistanceKm: row?.ac_osrm_distance_km != null ? Number(row.ac_osrm_distance_km) : null,
          cbOsrmDistanceKm: row?.cb_osrm_distance_km != null ? Number(row.cb_osrm_distance_km) : null,
          candidateDistanceFromAbRouteMeters: row?.candidate_distance_from_ab_route_meters != null ? Number(row.candidate_distance_from_ab_route_meters) : null,
          destinationDistanceFromAcRouteMeters: row?.destination_distance_from_ac_route_meters != null ? Number(row.destination_distance_from_ac_route_meters) : null,
          routePossible,
          timingPossible: true,
          prioritySafe: true,
          selectedAsBest: false,
          attempted: true,
          routeDecisionReason: row?.route_decision_reason ? String(row.route_decision_reason) : null,
          timingDecisionReason: 'Timing will be validated by the main timeline rebuild.',
          priorityDecisionReason: null,
          finalDecisionReason: routePossible
            ? `Selected: ${displayLabel}.`
            : `Not selected: ${displayLabel}.`,
          existingAnchorHotspotId: onlyRouteHotspotId,
          existingAnchorOrder: onlyRouteHotspotOrder,
        };
      }).sort((a: any, b: any) => selectionRank(String(a?.routeFitType || '')) - selectionRank(String(b?.routeFitType || '')));

      const bestSlot = allSlotResults[0] || null;
      const manualRelaxedRouteFit =
        manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
        && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
      const chosenSlot = bestSlot && (
        this.callbacks.isFeasibleFitType(String(bestSlot?.routeFitType || '').toUpperCase())
        || (
          manualRelaxedRouteFit
          && this.callbacks.isUsableMatrixRouteFitType(String(bestSlot?.routeFitType || '').toUpperCase())
        )
      )
        ? { ...bestSlot, selectedAsBest: true }
        : bestSlot ? { ...bestSlot, selectedAsBest: true } : null;
      const hasFeasibleMatrixSlot = allSlotResults.some((slot: any) => (
        this.callbacks.isFeasibleFitType(String(slot?.routeFitType || '').toUpperCase())
        || (
          manualRelaxedRouteFit
          && this.callbacks.isUsableMatrixRouteFitType(String(slot?.routeFitType || '').toUpperCase())
        )
      ));

      return {
        selectedHotspotId: candidateHotspotId,
        selectedHotspotName: candidateHotspotName,
        requestedSlot: chosenSlot,
        bestSlot: chosenSlot,
        chosenSlot,
        allSlotResults,
        chosenSlotSource: 'BEST_FIT',
        routeFitAvailable: true,
        hasAnyMatrixData: true,
        hasFeasibleMatrixSlot,
        requiresMatrixBuild: false,
        canAutoMove: hasFeasibleMatrixSlot,
        canApply: hasFeasibleMatrixSlot,
        selectedIncluded: hasFeasibleMatrixSlot,
        warning: hasFeasibleMatrixSlot
          ? (
              manualRelaxedRouteFit
              && chosenSlot
              && !this.callbacks.isFeasibleFitType(String(chosenSlot?.routeFitType || '').toUpperCase())
                ? `Manual add allows this route-fit as long as the rebuilt timeline finishes within ${manualTimingPolicy?.endTime || 'the manual day end'}.`
                : null
            )
          : 'Matrix data exists, but no feasible city endpoint insertion slot is available.',
        previewBlockReason: hasFeasibleMatrixSlot ? null : 'NO_FEASIBLE_ROUTE_SLOT',
        code: hasFeasibleMatrixSlot ? 'SINGLE_HOTSPOT_CITY_MATRIX_READY' : 'MANUAL_HOTSPOT_NO_FEASIBLE_ROUTE_SLOT',
        cityEndpointInsertionMode: true,
        singleHotspotAnchorHotspotId: onlyRouteHotspotId,
        singleHotspotAnchorHotspotName: String(chosenSlot?.toName || chosenSlot?.fromName || ''),
        manualTimingPolicy,
      };
    }

 // 2. Fetch all hotspot names in one query
    const hotspotIds = routeAttractions.map((r: any) => Number(r.hotspot_ID));
    const hotspotMasters: any[] = await (tx as any).dvi_hotspot_place.findMany({
      where: { hotspot_ID: { in: hotspotIds }, deleted: 0 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_duration: true,
        hotspot_location: true,
        hotspot_to_location: true,
      },
    });
    const nameById = new Map<number, string>(
      hotspotMasters.map((m: any) => [Number(m.hotspot_ID), String(m.hotspot_name || '')]),
    );
    const masterById = new Map<number, any>(
      hotspotMasters.map((m: any) => [Number(m.hotspot_ID), m]),
    );

    destinationInsertionMode = hotspotCityContext === 'DESTINATION_CITY';
    if (destinationInsertionMode) {
      await this.callbacks.ensureHotspotHotelBetweenMapTable(tx);
    }
    let destinationHotelEndpoint = destinationInsertionMode
      ? await this.callbacks.resolveSelectedHotelEndpoint(tx, Number(planId), Number(routeId))
      : null;
    if (destinationInsertionMode && !destinationHotelEndpoint) {
      const baselineRowsLocal = Array.isArray(baselineTimeline) ? baselineTimeline : [];
      const baselineHotelRow = baselineRowsLocal.find((row: any) => {
        const type = String(row?.type || '').toLowerCase();
        const text = String(row?.text || row?.name || '').toLowerCase();
        return type === 'hotel' || type === 'checkin' || Number(row?.item_type || 0) === 6 || text.includes('check-in at');
      }) || null;
      const baselineHotelText = String(baselineHotelRow?.text || baselineHotelRow?.name || '').trim();
      const extracted = baselineHotelText.match(/check-?in\s+(?:to|at)\s+(.+)/i);
      const hotelNameHint = String(extracted?.[1] || baselineHotelText || '').trim();
      const normalizedHint = this.callbacks.normalizeLocationText(hotelNameHint);
      const genericHints = new Set([
        'hotel',
        'check in at hotel',
        'check in to hotel',
        'checkin at hotel',
        'checkin to hotel',
        'hotel route start',
      ]);
      if (hotelNameHint && hotelNameHint.length >= 4 && !genericHints.has(normalizedHint)) {
        destinationHotelEndpoint = await this.callbacks.resolveHotelEndpointByLooseName(tx, hotelNameHint);
      }
    }
    if (destinationInsertionMode && !destinationHotelEndpoint) {
      destinationHotelEndpoint = await this.callbacks.resolveRouteDestinationCityEndpoint(tx, Number(routeId));
    }
    const destinationHotelLabel = String(destinationHotelEndpoint?.hotelName || 'Hotel');
    const destinationHotelEndpointResolved =
      !!destinationHotelEndpoint
      && Number.isFinite(Number(destinationHotelEndpoint.latitude))
      && Number.isFinite(Number(destinationHotelEndpoint.longitude));

    const attractionCityContexts = routeAttractions.map((row: any, index: number) => {
      const rowId = Number(row?.hotspot_ID || 0);
      const rowMaster = masterById.get(rowId);
      const rowContext = this.callbacks.classifyManualRouteAttractionCityContext(routeCityContext, {
        hotspot_location: rowMaster?.hotspot_location,
        hotspot_to_location: rowMaster?.hotspot_to_location,
        hotspot_name: rowMaster?.hotspot_name || nameById.get(rowId),
      });
      return {
        index,
        hotspotId: rowId,
        hotspotOrder: Number(row?.hotspot_order || 0),
        name: nameById.get(rowId) || `Hotspot #${rowId}`,
        cityContext: rowContext,
      };
    });

    const firstDestinationAttraction = attractionCityContexts.find((row: any) => row.cityContext === 'DESTINATION_CITY') || null;
    const destinationRows = attractionCityContexts.filter((row: any) => row.cityContext === 'DESTINATION_CITY');
    const lastDestinationAttraction = destinationRows.length > 0 ? destinationRows[destinationRows.length - 1] : null;
    const destinationMinPairIndex = destinationInsertionMode
      ? Math.max(0, Number(firstDestinationAttraction?.index ?? routeAttractions.length))
      : 0;
    const destinationBoundaryPairIndex = destinationInsertionMode
      ? Math.max(0, destinationMinPairIndex - 1)
      : 0;
    destinationMinCandidateIndex = destinationInsertionMode
      ? Math.max(0, Number(firstDestinationAttraction?.index ?? routeAttractions.length))
      : null;

    if (destinationInsertionMode) {
      destinationAnchorHotspotId = Number(lastDestinationAttraction?.hotspotId || firstDestinationAttraction?.hotspotId || 0) || null;
      destinationAnchorName = String(lastDestinationAttraction?.name || firstDestinationAttraction?.name || '') || null;
      destinationAnchorOrder = Number(lastDestinationAttraction?.hotspotOrder || firstDestinationAttraction?.hotspotOrder || 0) || null;
 console.log('[ManualDestinationInsert] city_context', {
        routeId: Number(routeId),
        selectedHotspotId: Number(candidateHotspotId),
        hotspotCityContext,
        source: String(routeCityContext?.location_name || ''),
        destination: String(routeCityContext?.next_visiting_location || ''),
      });
 console.log('[ManualDestinationInsert] destination_hotspot_candidates', {
        routeId: Number(routeId),
        selectedHotspotId: Number(candidateHotspotId),
        destinationHotspotIds: destinationRows.map((row: any) => Number(row?.hotspotId || 0)).filter((id: number) => id > 0),
        destinationHotspotNames: destinationRows.map((row: any) => String(row?.name || '')).filter(Boolean),
      });
 console.log('[ManualDestinationInsert] selected_anchor', {
        routeId: Number(routeId),
        selectedHotspotId: Number(candidateHotspotId),
        destinationAnchorHotspotId,
        destinationAnchorName,
        destinationAnchorOrder,
      });
    }

    if (!candidateMaster) {
      return {
        selectedHotspotId: candidateHotspotId,
        selectedHotspotName: candidateHotspotName,
        requestedSlot: null,
        bestSlot: null,
        chosenSlot: null,
        allSlotResults: [],
        chosenSlotSource: 'NO_MATRIX_DATA',
        routeFitAvailable: false,
        requiresMatrixBuild: true,
        canAutoMove: false,
        canApply: false,
        code: 'MANUAL_HOTSPOT_MATRIX_DATA_MISSING',
        previewBlockReason: 'MATRIX_MISSING',
        warning: 'Selected hotspot does not exist in hotspot master data.',
      };
    }

 // 3. Build hotspot-to-hotspot slot pairs
    const slotPairs: Array<{ slotIndex: number; fromId: number; toId: number; fromName: string; toName: string }> = [];
    let nextSlotIndex = 0;
    for (let i = 0; i < routeAttractions.length - 1; i++) {
      if (destinationInsertionMode && i < destinationBoundaryPairIndex) {
        continue;
      }
      const fromId = Number(routeAttractions[i].hotspot_ID);
      const toId = Number(routeAttractions[i + 1].hotspot_ID);
      if (fromId === Number(candidateHotspotId) || toId === Number(candidateHotspotId)) {
        continue;
      }
      slotPairs.push({
        slotIndex: nextSlotIndex,
        fromId,
        toId,
        fromName: nameById.get(fromId) || `Hotspot #${fromId}`,
        toName: nameById.get(toId) || `Hotspot #${toId}`,
      });
      nextSlotIndex += 1;
    }

    if (slotPairs.length === 0) {
      const lastRouteAttraction = attractionCityContexts.length > 0
        ? attractionCityContexts[attractionCityContexts.length - 1]
        : null;
      if (destinationInsertionMode && destinationHotelEndpointResolved) {
        const baselineRowsLocal = Array.isArray(baselineTimeline) ? baselineTimeline : [];
        const baselineRowsByIdLocal = new Map<number, any>();
        for (const row of baselineRowsLocal) {
          const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.selectedHotspotId || 0);
          if (hotspotId > 0 && !baselineRowsByIdLocal.has(hotspotId)) {
            baselineRowsByIdLocal.set(hotspotId, row);
          }
        }

        const baselineHotelRow = baselineRowsLocal.find((row: any) => {
          const type = String(row?.type || '').toLowerCase();
          const text = String(row?.text || row?.name || '').toLowerCase();
          return type === 'hotel' || type === 'checkin' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
        }) || null;
        const anchorId = Number(destinationAnchorHotspotId || lastRouteAttraction?.hotspotId || 0);
        const anchorName = String(
          destinationAnchorName
          || lastRouteAttraction?.name
          || nameById.get(anchorId)
          || `Hotspot #${anchorId}`,
        );
        const destinationSlotReasonLocal = Number(destinationAnchorHotspotId || 0) > 0
          ? 'A_LAST_DESTINATION_TO_HOTEL'
          : 'C_FINAL_TRAVEL_TO_HOTEL_SPLIT';
        if (anchorId <= 0) {
          return {
            selectedHotspotId: candidateHotspotId,
            selectedHotspotName: candidateHotspotName,
            requestedSlot: null,
            bestSlot: null,
            chosenSlot: null,
            allSlotResults: [],
            chosenSlotSource: 'NO_MATRIX_DATA',
            routeFitAvailable: false,
            hasAnyMatrixData: false,
            hasFeasibleMatrixSlot: false,
            requiresMatrixBuild: false,
            canAutoMove: false,
            canApply: false,
            code: 'DESTINATION_SLOT_NOT_FOUND',
            previewBlockReason: 'DESTINATION_SLOT_NOT_FOUND',
            warning: 'No valid destination-side insertion slot was found after destination is reached.',
            reason: 'DESTINATION_SLOT_NOT_FOUND',
            hotspotCityContext,
            destinationInsertionMode: true,
            destinationAnchorHotspotId,
            destinationAnchorName,
            destinationAnchorOrder,
            destinationSlotReason: 'DESTINATION_SLOT_NOT_FOUND',
            destinationMinCandidateIndex,
            destinationHotelId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
            destinationHotelName: destinationHotelLabel,
            destinationHotelEndpointResolved,
          };
        }
        const selectedName = String(candidateHotspotName || candidateMaster?.hotspot_name || `Hotspot #${candidateHotspotId}`);
        const hotelLabel = destinationHotelLabel;

        const anchorToCandidateLeg = await this.callbacks.getCachedRouteMatrixLeg(tx, anchorId, Number(candidateHotspotId));
        const reverseAnchorToCandidateLeg = (
          (anchorToCandidateLeg?.distanceKm == null || anchorToCandidateLeg?.durationMin == null)
            ? await this.callbacks.getCachedRouteMatrixLeg(tx, Number(candidateHotspotId), anchorId)
            : { distanceKm: null, durationMin: null }
        );

        const combinedMasterById = new Map<number, any>(masterById);
        combinedMasterById.set(Number(candidateHotspotId), candidateMaster);

        const acDistanceKm =
          anchorToCandidateLeg?.distanceKm
          ?? reverseAnchorToCandidateLeg?.distanceKm
          ?? this.callbacks.distanceBetweenHotspots(combinedMasterById, anchorId, Number(candidateHotspotId))
          ?? null;
        const acDurationMin =
          anchorToCandidateLeg?.durationMin
          ?? reverseAnchorToCandidateLeg?.durationMin
          ?? this.callbacks.estimateDurationFromDistance(acDistanceKm)
          ?? 10;

        const anchorToHotelLeg = await this.callbacks.resolveHotspotToHotelLeg(
          tx,
          Number(anchorId),
          destinationHotelEndpoint,
        );
        const candidateToHotelLeg = await this.callbacks.resolveHotspotToHotelLeg(
          tx,
          Number(candidateHotspotId),
          destinationHotelEndpoint,
        );
        const abDistanceKm = anchorToHotelLeg.distanceKm;
        const cbDistanceKm = candidateToHotelLeg.distanceKm;
        const cbDurationMin = candidateToHotelLeg.durationMin ?? this.callbacks.estimateDurationFromDistance(cbDistanceKm);
        const insertedRouteDistanceKm =
          acDistanceKm != null && cbDistanceKm != null
            ? Number(acDistanceKm) + Number(cbDistanceKm)
            : null;
        const roadDetourKm =
          insertedRouteDistanceKm != null && abDistanceKm != null
            ? Number(insertedRouteDistanceKm) - Number(abDistanceKm)
            : null;

        const fromBaselineRow = baselineRowsByIdLocal.get(anchorId);
        const hotelStartMinutes = this.callbacks.parseSegmentStartMinutes(baselineHotelRow);
        const anchorEndMinutes = this.callbacks.parseSegmentEndMinutes(fromBaselineRow);
        const finalTravelToHotelRow = [...baselineRowsLocal].reverse().find((row: any) => {
          const type = String(row?.type || '').toLowerCase();
          const text = String(row?.text || row?.name || '').toLowerCase();
          return (
            type === 'travel'
            && (
              text.includes('travel to hotel')
              || Number(row?.item_type || 0) === 5
            )
          );
        }) || null;
        const finalTravelStartMinutes = this.callbacks.parseSegmentStartMinutes(finalTravelToHotelRow);
        const finalTravelEndMinutes = this.callbacks.parseSegmentEndMinutes(finalTravelToHotelRow);
        const totalRequiredMinutes = Number(candidateDurationMinutes || 0) + Number(acDurationMin || 0) + Number(cbDurationMin || 0);
        const availableGapMinutes = (
          hotelStartMinutes != null && anchorEndMinutes != null
            ? (hotelStartMinutes - anchorEndMinutes)
            : finalTravelStartMinutes != null && finalTravelEndMinutes != null
              ? (finalTravelEndMinutes - finalTravelStartMinutes)
              : null
        );
        const timingPossible = availableGapMinutes == null ? true : availableGapMinutes >= totalRequiredMinutes;

        const chosenSlot = {
          slotIndex: 0,
          fromHotspotId: anchorId,
          fromName: anchorName,
          toHotspotId: Number(destinationHotelEndpoint?.hotelId || 0),
          toName: hotelLabel,
          destinationHotelId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
          destinationHotelEndpointResolved: true,
          source: destinationSlotReasonLocal === 'C_FINAL_TRAVEL_TO_HOTEL_SPLIT'
            ? 'FINAL_TRAVEL_TO_HOTEL_SPLIT'
            : 'DESTINATION_CITY_AFTER_REACHED',
          routeFitType: 'DESTINATION_SIDE_INSERTION',
          slotContext: 'LAST_SOURCE_HOTSPOT_TO_DESTINATION_HOTEL',
          label: `Before reaching ${String(routeCityContext?.next_visiting_location || 'destination')} hotel`,
          displayLabel: `After Madurai sightseeing, before ${String(routeCityContext?.next_visiting_location || 'destination')} hotel`,
          shortLabel: 'Before destination hotel',
          routePossible: true,
          timingPossible,
          prioritySafe: true,
          selectedAsBest: true,
          attempted: true,
          acOsrmDistanceKm: acDistanceKm,
          acDurationMin,
          routeDecisionReason: 'Destination hotspot insertion is evaluated by splitting the final travel-to-hotel leg. Normal hotspot-to-hotspot matrix is not required.',
          timingDecisionReason: timingPossible
            ? 'Timing fits before hotel/check-in within the manual 11 PM hotel reach policy.'
            : 'Timing requires reschedule because the available final hotel-leg window is not enough.',
          priorityDecisionReason: null,
          finalDecisionReason: destinationSlotReasonLocal === 'C_FINAL_TRAVEL_TO_HOTEL_SPLIT'
            ? 'Selected: final travel-to-hotel leg is split for destination-side hotspot insertion.'
            : 'Selected: destination-side insertion after destination is reached.',
          decisionReason: 'Destination hotspot insertion is evaluated by splitting the final travel-to-hotel leg. Normal hotspot-to-hotspot matrix is not required.',
          abOsrmDistanceKm: abDistanceKm,
          cbOsrmDistanceKm: cbDistanceKm,
          cbDurationMin,
          insertedRouteDistanceKm,
          roadDetourKm,
          attemptedSlotLabel: `${anchorName} -> ${selectedName} -> ${hotelLabel}`,
        };

        if (Number(destinationHotelEndpoint?.hotelId || 0) > 0) {
          await this.callbacks.upsertHotspotHotelBetweenMapRow(tx, {
            planId: Number(planId),
            routeId: Number(routeId),
            fromHotspotId: Number(anchorId),
            hotelId: Number(destinationHotelEndpoint!.hotelId),
            betweenHotspotId: Number(candidateHotspotId),
            routeFitType: 'DESTINATION_SIDE_INSERTION',
            routeDecisionReason: String(chosenSlot.routeDecisionReason || ''),
            abDistanceKm,
            acDistanceKm,
            cbDistanceKm,
            insertedDistanceKm: insertedRouteDistanceKm,
            roadDetourKm,
            osrmUsed: anchorToHotelLeg.osrmUsed || candidateToHotelLeg.osrmUsed,
          });
        }

 console.log('[ManualDestinationInsert] hotel_side_insertion', {
          routeId: Number(routeId),
          selectedHotspotId: Number(candidateHotspotId),
          anchorId,
          anchorName,
          selectedName,
          acDistanceKm,
          acDurationMin,
          cbDistanceKm,
          cbDurationMin,
          roadDetourKm,
          availableGapMinutes,
          requiredMinutes: totalRequiredMinutes,
          timingPossible,
        });
 console.log('[ManualDestinationInsert] skipped_matrix_for_hotel_endpoint', {
          routeId: Number(routeId),
          selectedHotspotId: Number(candidateHotspotId),
          reason: 'Only destination anchor and hotel endpoint are available; hotspot-to-hotspot matrix slot pairs do not apply.',
        });

        return {
          selectedHotspotId: candidateHotspotId,
          selectedHotspotName: candidateHotspotName,
          requestedSlot: chosenSlot,
          bestSlot: chosenSlot,
          chosenSlot,
          allSlotResults: [chosenSlot],
          chosenSlotSource: 'BEST_FIT',
          routeFitAvailable: true,
          hasAnyMatrixData: true,
          hasFeasibleMatrixSlot: true,
          requiresMatrixBuild: false,
          canAutoMove: true,
          canApply: true,
          code: 'MANUAL_HOTSPOT_DESTINATION_INSERT_PREVIEW_READY',
          previewBlockReason: null,
          warning: null,
          hotspotCityContext,
          destinationInsertionMode: true,
          destinationAnchorHotspotId,
          destinationAnchorName,
          destinationAnchorOrder,
          destinationSlotReason: destinationSlotReasonLocal,
          destinationMinCandidateIndex,
          destinationHotelId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
          destinationHotelName: destinationHotelLabel,
          destinationHotelEndpointResolved: true,
        };
      }

      if (destinationInsertionMode) {
        return {
          selectedHotspotId: candidateHotspotId,
          selectedHotspotName: candidateHotspotName,
          requestedSlot: {
            fromHotspotId: Number(destinationAnchorHotspotId || 0) || null,
            fromName: String(destinationAnchorName || routeCityContext?.next_visiting_location || 'Destination'),
            toHotspotId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
            toName: destinationHotelLabel,
            destinationHotelId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
            routeFitType: 'DESTINATION_SIDE_INSERTION',
            label: 'Destination insertion',
            displayLabel: 'Destination insertion',
            shortLabel: 'Destination insertion',
            roadDetourKm: null,
            roadDetourRatio: null,
            insertedRouteDistanceKm: null,
            abOsrmDistanceKm: null,
            acOsrmDistanceKm: null,
            cbOsrmDistanceKm: null,
            candidateDistanceFromAbRouteMeters: null,
            decisionReason: 'No existing destination hotspot anchor is available to create a destination-side insertion slot.',
          },
          bestSlot: null,
          chosenSlot: null,
          allSlotResults: [],
          chosenSlotSource: 'NO_MATRIX_DATA',
          routeFitAvailable: false,
          hasAnyMatrixData: false,
          hasFeasibleMatrixSlot: false,
          requiresMatrixBuild: false,
          canAutoMove: false,
          canApply: false,
          code: 'DESTINATION_SLOT_NOT_FOUND',
          previewBlockReason: 'DESTINATION_SLOT_NOT_FOUND',
          reason: 'DESTINATION_SLOT_NOT_FOUND',
          warning: 'No valid destination-side insertion slot was found after destination is reached.',
          hotspotCityContext,
          destinationInsertionMode: true,
          destinationAnchorHotspotId,
          destinationAnchorName,
          destinationAnchorOrder,
          destinationSlotReason: 'DESTINATION_SLOT_NOT_FOUND',
          destinationMinCandidateIndex,
          destinationHotelId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
          destinationHotelName: destinationHotelLabel,
          destinationHotelEndpointResolved,
        };
      }

      return {
        selectedHotspotId: candidateHotspotId,
        selectedHotspotName: candidateHotspotName,
        requestedSlot: {
          fromHotspotId: null,
          fromName: 'Hotel / Route Start',
          toHotspotId: null,
          toName: null,
          routeFitType: 'MATRIX_UNAVAILABLE',
          label: this.callbacks.routeFitLabel('MATRIX_UNAVAILABLE'),
          roadDetourKm: null,
          roadDetourRatio: null,
          insertedRouteDistanceKm: null,
          abOsrmDistanceKm: null,
          acOsrmDistanceKm: null,
          cbOsrmDistanceKm: null,
          candidateDistanceFromAbRouteMeters: null,
          decisionReason: 'Hotel/source segments are not evaluated in the route-fit matrix.',
        },
        bestSlot: null,
        chosenSlot: null,
        allSlotResults: [],
        chosenSlotSource: 'NO_MATRIX_DATA',
        routeFitAvailable: false,
        requiresMatrixBuild: true,
        canAutoMove: false,
        canApply: false,
        warning: 'No baseline hotspot-to-hotspot slots available for matrix evaluation.',
      };
    }

 // 4. Query hotspot_route_between_map per original A->B slot for candidate C.
 // Check both directions: A->B->C and B->A->C (geographically interchangeable)
    const matrixRows: any[] = [];
    for (const slot of slotPairs) {
      try {
        const rows = await (tx as any).$queryRawUnsafe(`
          SELECT
            from_hotspot_id,
            to_hotspot_id,
            between_hotspot_id,
            route_fit_type,
            route_decision_reason,
            road_detour_km,
            road_detour_ratio,
            ab_osrm_distance_km,
            ac_osrm_distance_km,
            cb_osrm_distance_km,
            inserted_route_distance_km,
            candidate_distance_from_ab_route_meters,
            destination_distance_from_ac_route_meters
          FROM hotspot_route_between_map
          WHERE (
            (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
            OR
            (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
          )
          LIMIT 1
        `, Number(slot.fromId), Number(slot.toId), Number(candidateHotspotId),
           Number(slot.toId), Number(slot.fromId), Number(candidateHotspotId));
        if (Array.isArray(rows) && rows.length > 0) {
          matrixRows.push(rows[0]);
        } else {
          const rejectionRow = await this.callbacks.getRouteBetweenRejectionRow(
            tx,
            Number(slot.fromId),
            Number(slot.toId),
            Number(candidateHotspotId),
          );

          if (rejectionRow) {
            const rejectionCode = String(rejectionRow?.rejection_code || '').toUpperCase();
            const rejectionReason = rejectionRow?.rejection_reason
              ? String(rejectionRow.rejection_reason)
              : String(rejectionRow?.error_message || 'Rejected in hotspot_route_between_rejections.');

            matrixRows.push({
              from_hotspot_id: Number(rejectionRow?.from_hotspot_id || slot.fromId),
              to_hotspot_id: Number(rejectionRow?.to_hotspot_id || slot.toId),
              between_hotspot_id: Number(rejectionRow?.between_hotspot_id || candidateHotspotId),
              route_fit_type: rejectionCode === 'OFF_ROUTE_SKIPPED' ? 'OFF_ROUTE' : 'UNKNOWN',
              route_decision_reason: rejectionReason,
              road_detour_km: rejectionRow?.road_detour_km ?? null,
              road_detour_ratio: rejectionRow?.road_detour_ratio ?? null,
              ab_osrm_distance_km: null,
              ac_osrm_distance_km: null,
              cb_osrm_distance_km: null,
              inserted_route_distance_km: null,
              candidate_distance_from_ab_route_meters: rejectionRow?.candidate_distance_from_ab_route_meters ?? null,
              destination_distance_from_ac_route_meters: null,
            });
          }
        }
      } catch (err) {
 console.error('[buildManualInsertionFit] matrix query error:', err);
      }
    }

 // Index matrix rows by from+to, and also reverse key for directional tolerance.
    const matrixBySlot = new Map<string, any>();
    for (const row of matrixRows) {
      const fromId = Number(row?.from_hotspot_id || 0);
      const toId = Number(row?.to_hotspot_id || 0);
      if (!fromId || !toId) continue;
      matrixBySlot.set(`${fromId}_${toId}`, row);
      matrixBySlot.set(`${toId}_${fromId}`, row);
    }

    if (
      destinationInsertionMode
      && destinationMinPairIndex > 0
      && candidateMaster
      && destinationMinPairIndex < routeAttractions.length
    ) {
      const boundaryFromId = Number(routeAttractions[destinationMinPairIndex - 1]?.hotspot_ID || 0);
      const boundaryToId = Number(routeAttractions[destinationMinPairIndex]?.hotspot_ID || 0);
      const boundaryKey = `${boundaryFromId}_${boundaryToId}`;

      if (boundaryFromId > 0 && boundaryToId > 0 && !matrixBySlot.has(boundaryKey)) {
        const boundaryMx = await this.callbacks.ensureRouteBetweenMapRow(
          tx,
          boundaryFromId,
          boundaryToId,
          Number(candidateHotspotId),
        );

        if (boundaryMx) {
          matrixRows.push(boundaryMx);
          matrixBySlot.set(`${boundaryFromId}_${boundaryToId}`, boundaryMx);
          matrixBySlot.set(`${boundaryToId}_${boundaryFromId}`, boundaryMx);
 console.log('[ManualDestinationInsert] boundary_matrix_fallback_added', {
            routeId: Number(routeId),
            selectedHotspotId: Number(candidateHotspotId),
            fromHotspotId: boundaryFromId,
            toHotspotId: boundaryToId,
            routeFitType: String(boundaryMx?.route_fit_type || ''),
          });
        } else {
 console.warn('[ManualDestinationInsert] boundary_matrix_fallback_missing', {
            routeId: Number(routeId),
            selectedHotspotId: Number(candidateHotspotId),
            fromHotspotId: boundaryFromId,
            toHotspotId: boundaryToId,
          });
        }
      }
    }

    const baselineRows = Array.isArray(baselineTimeline) ? baselineTimeline : [];
    const baselineRowsById = new Map<number, any>();
    for (const row of baselineRows) {
      const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.selectedHotspotId || 0);
      if (hotspotId > 0 && !baselineRowsById.has(hotspotId)) {
        baselineRowsById.set(hotspotId, row);
      }
    }

    const evaluateTimingFit = (fromHotspotId: number, toHotspotId: number) => {
      const fromRow = baselineRowsById.get(Number(fromHotspotId));
      const toRow = baselineRowsById.get(Number(toHotspotId));
      const fromEndMinutes = this.callbacks.parseSegmentEndMinutes(fromRow);
      const toStartMinutes = this.callbacks.parseSegmentStartMinutes(toRow);

      if (fromEndMinutes === null || toStartMinutes === null) {
        return {
          timingPossible: false,
          timingDecisionReason: 'Timing requires reschedule because available gap is not enough.',
        };
      }

      const availableGapMinutes = toStartMinutes - fromEndMinutes;
      if (availableGapMinutes >= candidateDurationMinutes) {
        return {
          timingPossible: true,
          timingDecisionReason: `Timing fits within the available ${availableGapMinutes} min gap.`,
        };
      }

      return {
        timingPossible: false,
        timingDecisionReason: 'Timing requires reschedule because available gap is not enough.',
      };
    };

    const selectionRank = (type: string): number => {
      if (type === 'ON_ROUTE') return 1;
      if (type === 'MINOR_DETOUR') return 2;
      if (type === 'BACKTRACK') return 3;
      if (type === 'OFF_ROUTE') return 4;
      if (type === 'UNKNOWN') return 5;
      if (type === 'MATRIX_UNAVAILABLE') return 6;
      return 5;
    };

 // 5. Build allSlotResults
    let allSlotResults: any[] = slotPairs.map((slot) => {
      const key = `${slot.fromId}_${slot.toId}`;
      const mx = matrixBySlot.get(key);
      const routeFitType = String(mx?.route_fit_type || 'UNKNOWN');
      const routePossible = this.callbacks.isFeasibleFitType(routeFitType);
      const timingEval = evaluateTimingFit(slot.fromId, slot.toId);
      const routeDecisionReason = mx?.route_decision_reason ? String(mx.route_decision_reason) : null;
      const timingDecisionReason = timingEval.timingDecisionReason;
      const finalDecisionReason = !mx
        ? 'Not selected: route-fit data missing.'
        : !routePossible
          ? (routeFitType === 'BACKTRACK'
              ? 'Not selected: candidate causes backtracking.'
              : routeFitType === 'OFF_ROUTE'
                ? 'Not selected: candidate adds too much road detour.'
                : routeFitType === 'MATRIX_UNAVAILABLE'
                  ? 'Not selected: hotel/source segment has no hotspot matrix.'
                  : 'Not selected: route-fit data missing.')
          : (!timingEval.timingPossible
              ? 'Not selected: timing gap is insufficient and requires reschedule.'
              : 'Not selected: candidate is feasible but not the best route-fit slot.');

      if (!mx) {
        return {
          slotIndex: slot.slotIndex,
          fromHotspotId: slot.fromId,
          fromName: slot.fromName,
          toHotspotId: slot.toId,
          toName: slot.toName,
          routeFitType: 'UNKNOWN',
          label: this.callbacks.routeFitLabel('UNKNOWN'),
          displayLabel: this.callbacks.routeFitLabel('UNKNOWN'),
          shortLabel: this.callbacks.routeFitLabel('UNKNOWN'),
          roadDetourKm: null,
          isZeroExtraDetour: false,
          distanceComparisonNote: null,
          roadDetourRatio: null,
          insertedRouteDistanceKm: null,
          abOsrmDistanceKm: null,
          acOsrmDistanceKm: null,
          cbOsrmDistanceKm: null,
          candidateDistanceFromAbRouteMeters: null,
          destinationDistanceFromAcRouteMeters: null,
          routePossible: false,
          timingPossible: timingEval.timingPossible,
          prioritySafe: true,
          selectedAsBest: false,
          attempted: true,
          routeDecisionReason: 'Route-fit data not available. Run matrix builder for this route slot and candidate.',
          timingDecisionReason,
          priorityDecisionReason: null,
          finalDecisionReason: 'Not selected: route-fit data missing.',
        };
      }

      const roadDetourKm = mx.road_detour_km != null ? Number(mx.road_detour_km) : null;
      const insertedRouteDistanceKm = mx.inserted_route_distance_km != null ? Number(mx.inserted_route_distance_km) : null;
      const abOsrmDistanceKm = mx.ab_osrm_distance_km != null ? Number(mx.ab_osrm_distance_km) : null;
      const displayMeta = this.callbacks.buildRouteFitDisplayMeta({
        routeFitType,
        roadDetourKm,
        insertedRouteDistanceKm,
        abOsrmDistanceKm,
        finalDecisionReason,
      });

      return {
        slotIndex: slot.slotIndex,
        fromHotspotId: slot.fromId,
        fromName: slot.fromName,
        toHotspotId: slot.toId,
        toName: slot.toName,
        routeFitType,
        label: this.callbacks.routeFitLabel(routeFitType),
        displayLabel: displayMeta.displayLabel,
        shortLabel: displayMeta.shortLabel,
        roadDetourKm,
        isZeroExtraDetour: displayMeta.isZeroExtraDetour,
        distanceComparisonNote: displayMeta.distanceComparisonNote,
        roadDetourRatio: mx.road_detour_ratio != null ? Number(mx.road_detour_ratio) : null,
        insertedRouteDistanceKm,
        abOsrmDistanceKm,
        acOsrmDistanceKm: mx.ac_osrm_distance_km != null ? Number(mx.ac_osrm_distance_km) : null,
        cbOsrmDistanceKm: mx.cb_osrm_distance_km != null ? Number(mx.cb_osrm_distance_km) : null,
        candidateDistanceFromAbRouteMeters: mx.candidate_distance_from_ab_route_meters != null ? Number(mx.candidate_distance_from_ab_route_meters) : null,
        destinationDistanceFromAcRouteMeters: mx.destination_distance_from_ac_route_meters != null ? Number(mx.destination_distance_from_ac_route_meters) : null,
        routePossible,
        timingPossible: timingEval.timingPossible,
        prioritySafe: true,
        selectedAsBest: false,
        attempted: true,
        routeDecisionReason,
        timingDecisionReason,
        priorityDecisionReason: null,
        finalDecisionReason: displayMeta.finalDecisionReason,
      };
    });

    if (
      destinationInsertionMode
      && allSlotResults.every((slot) => String(slot?.routeFitType || '').toUpperCase() === 'UNKNOWN')
      && destinationMinPairIndex > 0
      && destinationMinPairIndex < routeAttractions.length
    ) {
      const boundaryFromId = Number(routeAttractions[destinationMinPairIndex - 1]?.hotspot_ID || 0);
      const boundaryToId = Number(routeAttractions[destinationMinPairIndex]?.hotspot_ID || 0);

      if (boundaryFromId > 0 && boundaryToId > 0) {
        const boundaryFromName = nameById.get(boundaryFromId) || `Hotspot #${boundaryFromId}`;
        const boundaryToName = nameById.get(boundaryToId) || `Hotspot #${boundaryToId}`;
        const directLeg = await this.callbacks.getCachedRouteMatrixLeg(tx, boundaryFromId, boundaryToId);
        const acLeg = await this.callbacks.getCachedRouteMatrixLeg(tx, boundaryFromId, Number(candidateHotspotId));
        const cbLeg = await this.callbacks.getCachedRouteMatrixLeg(tx, Number(candidateHotspotId), boundaryToId);

        const directKm =
          directLeg?.distanceKm
          ?? this.callbacks.distanceBetweenHotspots(masterById, boundaryFromId, boundaryToId)
          ?? null;
        const acDistanceKm =
          acLeg?.distanceKm
          ?? this.callbacks.distanceBetweenHotspots(
            new Map<number, any>([...masterById, [Number(candidateHotspotId), candidateMaster]]),
            boundaryFromId,
            Number(candidateHotspotId),
          )
          ?? null;
        const cbDistanceKm =
          cbLeg?.distanceKm
          ?? this.callbacks.distanceBetweenHotspots(
            new Map<number, any>([...masterById, [Number(candidateHotspotId), candidateMaster]]),
            Number(candidateHotspotId),
            boundaryToId,
          )
          ?? null;
        const insertedRouteDistanceKm =
          directKm != null && acDistanceKm != null && cbDistanceKm != null
            ? Number(acDistanceKm) + Number(cbDistanceKm)
            : null;
        const roadDetourKm =
          insertedRouteDistanceKm != null && directKm != null
            ? Number(insertedRouteDistanceKm) - Number(directKm)
            : null;

        let routeFitType = 'UNKNOWN';
        if (roadDetourKm != null) {
          routeFitType =
            roadDetourKm <= 2
              ? 'ON_ROUTE'
              : roadDetourKm <= 10
                ? 'MINOR_DETOUR'
                : 'OFF_ROUTE';
        }

        const timingEval = evaluateTimingFit(boundaryFromId, boundaryToId);
        const destinationBoundarySlot = {
          slotIndex: allSlotResults.length,
          fromHotspotId: boundaryFromId,
          fromName: boundaryFromName,
          toHotspotId: boundaryToId,
          toName: boundaryToName,
          routeFitType,
          label: this.callbacks.routeFitLabel(routeFitType),
          displayLabel: this.callbacks.routeFitLabel(routeFitType),
          shortLabel: this.callbacks.routeFitLabel(routeFitType),
          roadDetourKm,
          isZeroExtraDetour: roadDetourKm != null ? Number(roadDetourKm) <= 0.5 : false,
          distanceComparisonNote: null,
          roadDetourRatio:
            insertedRouteDistanceKm != null && directKm != null && Number(directKm) > 0
              ? (Number(insertedRouteDistanceKm) - Number(directKm)) / Number(directKm)
              : null,
          insertedRouteDistanceKm,
          abOsrmDistanceKm: directKm,
          acOsrmDistanceKm: acDistanceKm,
          cbOsrmDistanceKm: cbDistanceKm,
          candidateDistanceFromAbRouteMeters: null,
          destinationDistanceFromAcRouteMeters: null,
          routePossible: this.callbacks.isFeasibleFitType(routeFitType),
          timingPossible: timingEval.timingPossible,
          prioritySafe: true,
          selectedAsBest: false,
          attempted: true,
          source: 'DESTINATION_ENTRY_BOUNDARY',
          routeDecisionReason: 'Destination-city manual hotspot is evaluated on the transition into the destination before the first destination-side attraction.',
          timingDecisionReason: timingEval.timingDecisionReason,
          priorityDecisionReason: null,
          finalDecisionReason:
            routeFitType === 'UNKNOWN'
              ? 'Not selected: destination-entry boundary slot could not be evaluated.'
              : 'Selected: destination-entry boundary slot before the first destination-side attraction.',
        };

        allSlotResults.push(destinationBoundarySlot);
 console.log('[ManualDestinationInsert] synthetic_destination_entry_slot_added', {
          routeId: Number(routeId),
          selectedHotspotId: Number(candidateHotspotId),
          fromHotspotId: boundaryFromId,
          toHotspotId: boundaryToId,
          routeFitType,
          roadDetourKm,
        });
      }
    }

    const hasFeasibleNormalMatrixSlot = allSlotResults.some((slot) =>
      this.callbacks.isFeasibleFitType(String(slot?.routeFitType || '').toUpperCase()),
    );

    let osrmRouteCheckFailed = false;

    if (!hasFeasibleNormalMatrixSlot && candidateMaster && !destinationInsertionMode) {
      const routeRow = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: Number(routeId),
          deleted: 0,
        },
        select: {
          location_name: true,
          next_visiting_location: true,
        },
      });

      const sourceLocation = this.callbacks.normalizeLocationText(routeRow?.location_name || '');
      const destinationLocation = this.callbacks.normalizeLocationText(routeRow?.next_visiting_location || '');
      const sourceCityKey = this.callbacks.deriveLooseCityKey(String(routeRow?.location_name || ''));
      const destinationCityKey = this.callbacks.deriveLooseCityKey(String(routeRow?.next_visiting_location || ''));
      const sameCity = !!sourceCityKey && !!destinationCityKey && sourceCityKey === destinationCityKey;

 console.log('[SourceCityExitAnchor] loose_city_keys', {
        routeId: Number(routeId),
        sourceLocation,
        destinationLocation,
        sourceCityKey,
        destinationCityKey,
      });

      if (sameCity) {
 console.log('[SourceCityExitAnchor] skipped_same_city', {
          routeId: Number(routeId),
          candidateHotspotId: Number(candidateHotspotId),
          sourceLocation,
          destinationLocation,
          sourceCityKey,
          destinationCityKey,
        });
      } else {
 console.log('[SourceCityExitAnchor] attempt', {
          routeId: Number(routeId),
          candidateHotspotId: Number(candidateHotspotId),
          sourceLocation,
          destinationLocation,
          sourceCityKey,
          destinationCityKey,
        });

        const candidateLocation = this.callbacks.normalizeLocationText(candidateMaster?.hotspot_location || '');
        const candidateIsSourceSide = (
          (!!sourceLocation && candidateLocation.includes(sourceLocation))
          || (!!sourceCityKey && candidateLocation.includes(sourceCityKey))
        );

        const sourceSideHotspotId = Number(routeAttractions[0]?.hotspot_ID || 0);
        const destinationSideHotspotId = Number(routeAttractions[routeAttractions.length - 1]?.hotspot_ID || 0);

        if (candidateIsSourceSide && sourceSideHotspotId > 0 && destinationSideHotspotId > 0 && sourceSideHotspotId !== destinationSideHotspotId) {
          const sourceAnchor = await this.callbacks.findLastSourceCityHotspotOnOsrmRoute(tx, {
            routeId: Number(routeId),
            sourceCityKey: sourceCityKey || sourceLocation,
            destinationCityKey: destinationCityKey || destinationLocation,
            candidateHotspotId: Number(candidateHotspotId),
            debug: debugEnabled,
          });

          if (sourceAnchor?.osrmFailed) {
            osrmRouteCheckFailed = true;
          }

          const anchorHotspotId = Number(sourceAnchor?.sourceAnchorHotspotId || 0);
          const nextConsecutiveRouteHotspotId = Number(sourceAnchor?.nextRouteHotspotId || 0);

          if (anchorHotspotId > 0 && nextConsecutiveRouteHotspotId > 0) {
            const ensuredBetweenHotspotId = await this.callbacks.ensureHotspotPlace(tx, {
              hotspotId: Number(candidateMaster?.hotspot_ID || candidateHotspotId),
              hotspotName: String(candidateMaster?.hotspot_name || candidateHotspotName || `Hotspot #${candidateHotspotId}`),
              hotspotLocation: String(candidateMaster?.hotspot_location || routeRow?.location_name || ''),
              lat: Number(candidateMaster?.hotspot_latitude),
              lng: Number(candidateMaster?.hotspot_longitude),
            });

            const fallbackMx = ensuredBetweenHotspotId
              ? await this.callbacks.ensureRouteBetweenMapRow(
                  tx,
                  Number(anchorHotspotId),
                  Number(nextConsecutiveRouteHotspotId),
                  Number(ensuredBetweenHotspotId),
                )
              : null;

            if (fallbackMx) {
              matrixRows.push(fallbackMx);
              matrixBySlot.set(`${Number(anchorHotspotId)}_${Number(nextConsecutiveRouteHotspotId)}`, fallbackMx);
              matrixBySlot.set(`${Number(nextConsecutiveRouteHotspotId)}_${Number(anchorHotspotId)}`, fallbackMx);

              const fallbackType = String(fallbackMx?.route_fit_type || '').toUpperCase();
              if (this.callbacks.isFeasibleFitType(fallbackType)) {
                const timingEval = evaluateTimingFit(Number(anchorHotspotId), Number(nextConsecutiveRouteHotspotId));
                const roadDetourKm = fallbackMx.road_detour_km != null ? Number(fallbackMx.road_detour_km) : null;
                const insertedRouteDistanceKm = fallbackMx.inserted_route_distance_km != null
                  ? Number(fallbackMx.inserted_route_distance_km)
                  : null;
                const abOsrmDistanceKm = fallbackMx.ab_osrm_distance_km != null
                  ? Number(fallbackMx.ab_osrm_distance_km)
                  : null;
                const displayMeta = this.callbacks.buildRouteFitDisplayMeta({
                  routeFitType: fallbackType,
                  roadDetourKm,
                  insertedRouteDistanceKm,
                  abOsrmDistanceKm,
                  finalDecisionReason: 'Selected: source-city OSRM anchor fallback slot.',
                });

                allSlotResults.push({
                  slotIndex: allSlotResults.length,
                  fromHotspotId: Number(anchorHotspotId),
                  fromName: nameById.get(Number(anchorHotspotId)) || String(sourceAnchor?.sourceAnchorName || `Hotspot #${anchorHotspotId}`),
                  toHotspotId: Number(nextConsecutiveRouteHotspotId),
                  toName: nameById.get(Number(nextConsecutiveRouteHotspotId)) || `Hotspot #${nextConsecutiveRouteHotspotId}`,
                  routeFitType: fallbackType,
                  label: this.callbacks.routeFitLabel(fallbackType),
                  displayLabel: displayMeta.displayLabel,
                  shortLabel: displayMeta.shortLabel,
                  roadDetourKm,
                  isZeroExtraDetour: displayMeta.isZeroExtraDetour,
                  distanceComparisonNote: displayMeta.distanceComparisonNote,
                  roadDetourRatio: fallbackMx.road_detour_ratio != null ? Number(fallbackMx.road_detour_ratio) : null,
                  insertedRouteDistanceKm,
                  abOsrmDistanceKm,
                  acOsrmDistanceKm: fallbackMx.ac_osrm_distance_km != null ? Number(fallbackMx.ac_osrm_distance_km) : null,
                  cbOsrmDistanceKm: fallbackMx.cb_osrm_distance_km != null ? Number(fallbackMx.cb_osrm_distance_km) : null,
                  candidateDistanceFromAbRouteMeters:
                    fallbackMx.candidate_distance_from_ab_route_meters != null
                      ? Number(fallbackMx.candidate_distance_from_ab_route_meters)
                      : Number(sourceAnchor?.candidateDistanceFromRouteMeters || 0),
                  destinationDistanceFromAcRouteMeters:
                    fallbackMx.destination_distance_from_ac_route_meters != null
                      ? Number(fallbackMx.destination_distance_from_ac_route_meters)
                      : null,
                  routePossible: true,
                  timingPossible: timingEval.timingPossible,
                  prioritySafe: true,
                  selectedAsBest: false,
                  attempted: true,
                  source: 'OSRM_SOURCE_CITY_ROUTE_ANCHOR',
                  sourceCityExitAnchorHotspotId: Number(anchorHotspotId),
                  sourceCityExitAnchorName: String(sourceAnchor?.sourceAnchorName || `Hotspot #${anchorHotspotId}`),
                  sourceCityExitAnchorProgressRatio: Number(sourceAnchor?.sourceAnchorProgressRatio || 0),
                  sourceCityExitAnchorDistanceFromRouteMeters: Number(sourceAnchor?.sourceAnchorDistanceFromRouteMeters || 0),
                  sourceCityExitAnchorSelectionWhy: debugEnabled ? String(sourceAnchor?.anchorSelectionWhy || '') : undefined,
                  sourceCityExitAnchorSelectionDebug: debugEnabled ? (sourceAnchor?.anchorSelectionDebug || null) : undefined,
                  routeDecisionReason: `${String(fallbackMx.route_decision_reason || 'Route-fit validated using OSRM source route anchor')}. Applied into existing consecutive route slot.`,
                  timingDecisionReason: timingEval.timingDecisionReason,
                  priorityDecisionReason: null,
                  finalDecisionReason: displayMeta.finalDecisionReason,
                });
              }
            } else {
 console.log('[ManualMatrixEnsure] missing_row', {
                fromHotspotId: Number(anchorHotspotId),
                toHotspotId: Number(nextConsecutiveRouteHotspotId),
                candidateHotspotId: Number(candidateHotspotId),
              });
            }
          } else {
 console.log('[ManualMatrixEnsure] missing_row', {
              fromHotspotId: Number(sourceSideHotspotId),
              toHotspotId: Number(destinationSideHotspotId),
              candidateHotspotId: Number(candidateHotspotId),
            });
          }
        }
      }
    }

    if (destinationInsertionMode) {
      const baselineHotelRow = baselineRows.find((row: any) => {
        const type = String(row?.type || '').toLowerCase();
        const text = String(row?.text || row?.name || '').toLowerCase();
        return type === 'hotel' || type === 'checkin' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
      }) || null;
      const destinationReachedAt = firstDestinationAttraction || lastDestinationAttraction || null;
      const lastRouteAttraction = attractionCityContexts.length > 0
        ? attractionCityContexts[attractionCityContexts.length - 1]
        : null;

 console.log('[ManualDestinationInsert] destination_reached_at', {
        routeId: Number(routeId),
        selectedHotspotId: Number(candidateHotspotId),
        destinationReachedAtHotspotId: Number(destinationReachedAt?.hotspotId || 0) || null,
        destinationReachedAtHotspotName: destinationReachedAt?.name || null,
        destinationReachedAtOrder: Number(destinationReachedAt?.hotspotOrder || 0) || null,
      });

      const getSafeAnchorContext = (ctx: any): any | null => {
        if (!ctx) return null;

        const hotspotId = Number(ctx?.hotspotId || 0);
        const attractionRow = hotspotId > 0 ? baselineRowsById.get(hotspotId) : null;
        if (!attractionRow) return ctx;

        const attractionStart = this.callbacks.parseSegmentStartMinutes(attractionRow);
        const attractionEnd = this.callbacks.parseSegmentEndMinutes(attractionRow);

        const travelToAnchor = [...baselineRows].reverse().find((row: any) => {
          const type = String(row?.type || '').toLowerCase();
          const toId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
          const toText = String(row?.toName || row?.to || row?.text || row?.name || '').toLowerCase();
          const anchorName = String(ctx?.name || attractionRow?.text || attractionRow?.name || '').toLowerCase();

          return (
            (type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5)
            && (
              toId === hotspotId
              || (!!anchorName && toText.includes(anchorName))
            )
          );
        }) || null;

        const travelEnd = this.callbacks.parseSegmentEndMinutes(travelToAnchor);
        if (
          attractionStart !== null
          && travelEnd !== null
          && travelEnd > attractionStart
        ) {
 console.warn('[ManualDestinationInsert] skipping_invalid_destination_anchor', {
            routeId: Number(routeId),
            selectedHotspotId: Number(candidateHotspotId),
            anchorHotspotId: hotspotId,
            anchorName: ctx?.name || attractionRow?.text || attractionRow?.name || null,
            travelEnd,
            attractionStart,
            attractionEnd,
          });
          return null;
        }

        return ctx;
      };

      const anchorForHotelSlot =
        getSafeAnchorContext(lastDestinationAttraction)
        || getSafeAnchorContext(destinationReachedAt)
        || getSafeAnchorContext(lastRouteAttraction);
      const hotelStartMinutes = this.callbacks.parseSegmentStartMinutes(baselineHotelRow);
      const fromBaselineRow = anchorForHotelSlot
        ? baselineRowsById.get(Number(anchorForHotelSlot.hotspotId))
        : null;
      const anchorEndMinutes = this.callbacks.parseSegmentEndMinutes(fromBaselineRow);
      const finalTravelToHotelRow = [...baselineRows].reverse().find((row: any) => {
        const type = String(row?.type || '').toLowerCase();
        const text = String(row?.text || row?.name || '').toLowerCase();
        return (
          type === 'travel'
          && (
            text.includes('travel to hotel')
            || Number(row?.item_type || 0) === 5
          )
        );
      }) || null;
      const finalTravelStartMinutes = this.callbacks.parseSegmentStartMinutes(finalTravelToHotelRow);
      const finalTravelEndMinutes = this.callbacks.parseSegmentEndMinutes(finalTravelToHotelRow);
      const availableWindowMinutes = (
        hotelStartMinutes !== null && anchorEndMinutes !== null
          ? hotelStartMinutes - anchorEndMinutes
          : finalTravelStartMinutes !== null && finalTravelEndMinutes !== null
            ? finalTravelEndMinutes - finalTravelStartMinutes
            : null
      );
      const timingPossible = (
        availableWindowMinutes === null
        || availableWindowMinutes >= candidateDurationMinutes
      );

      let destinationSlotPriorityRank = 999;
      if (lastDestinationAttraction && baselineHotelRow) {
        destinationSlotReason = 'A_LAST_DESTINATION_TO_HOTEL';
        destinationSlotPriorityRank = 1;
      } else if (firstDestinationAttraction && destinationRows.length >= 2) {
        destinationSlotReason = 'B_BETWEEN_DESTINATION_ATTRACTIONS';
        destinationSlotPriorityRank = 2;
      } else if (anchorForHotelSlot && baselineHotelRow) {
        destinationSlotReason = 'C_FINAL_TRAVEL_TO_HOTEL_SPLIT';
        destinationSlotPriorityRank = 3;
      } else {
        destinationSlotReason = 'DESTINATION_SLOT_NOT_FOUND';
      }

      if (destinationSlotReason !== 'DESTINATION_SLOT_NOT_FOUND' && anchorForHotelSlot && destinationHotelEndpointResolved) {
        const selectedName = String(candidateHotspotName || candidateMaster?.hotspot_name || `Hotspot #${candidateHotspotId}`);
        const anchorToCandidateLeg = await this.callbacks.getCachedRouteMatrixLeg(
          tx,
          Number(anchorForHotelSlot.hotspotId),
          Number(candidateHotspotId),
        );
        const reverseAnchorToCandidateLeg = (
          (anchorToCandidateLeg?.distanceKm == null || anchorToCandidateLeg?.durationMin == null)
            ? await this.callbacks.getCachedRouteMatrixLeg(tx, Number(candidateHotspotId), Number(anchorForHotelSlot.hotspotId))
            : { distanceKm: null, durationMin: null }
        );
        const acDistanceKm =
          anchorToCandidateLeg?.distanceKm
          ?? reverseAnchorToCandidateLeg?.distanceKm
          ?? this.callbacks.distanceBetweenHotspots(
            new Map<number, any>([...masterById, [Number(candidateHotspotId), candidateMaster]]),
            Number(anchorForHotelSlot.hotspotId),
            Number(candidateHotspotId),
          )
          ?? null;
        const acDurationMin =
          anchorToCandidateLeg?.durationMin
          ?? reverseAnchorToCandidateLeg?.durationMin
          ?? this.callbacks.estimateDurationFromDistance(acDistanceKm)
          ?? 10;
        const anchorToHotelLeg = await this.callbacks.resolveHotspotToHotelLeg(
          tx,
          Number(anchorForHotelSlot.hotspotId),
          destinationHotelEndpoint,
        );
        const candidateToHotelLeg = await this.callbacks.resolveHotspotToHotelLeg(
          tx,
          Number(candidateHotspotId),
          destinationHotelEndpoint,
        );
        const abDistanceKm = anchorToHotelLeg.distanceKm;
        const cbDistanceKm = candidateToHotelLeg.distanceKm;
        const cbDurationMin = candidateToHotelLeg.durationMin ?? this.callbacks.estimateDurationFromDistance(cbDistanceKm);
        const insertedRouteDistanceKm =
          acDistanceKm != null && cbDistanceKm != null
            ? Number(acDistanceKm) + Number(cbDistanceKm)
            : null;
        const roadDetourKm =
          insertedRouteDistanceKm != null && abDistanceKm != null
            ? Number(insertedRouteDistanceKm) - Number(abDistanceKm)
            : null;

        const hotelSideSlot = {
          slotIndex: allSlotResults.length,
          fromHotspotId: Number(anchorForHotelSlot.hotspotId),
          fromName: String(anchorForHotelSlot.name || `Hotspot #${anchorForHotelSlot.hotspotId}`),
          toHotspotId: Number(destinationHotelEndpoint?.hotelId || 0),
          toName: destinationHotelLabel,
          destinationHotelId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
          destinationHotelEndpointResolved: true,
          routeFitType: 'DESTINATION_SIDE_INSERTION',
          label: `Before reaching ${String(routeCityContext?.next_visiting_location || 'destination')} hotel`,
          displayLabel: `After Madurai sightseeing, before ${String(routeCityContext?.next_visiting_location || 'destination')} hotel`,
          shortLabel: 'Before destination hotel',
          roadDetourKm,
          isZeroExtraDetour: roadDetourKm != null ? Number(roadDetourKm) <= 0.5 : false,
          distanceComparisonNote: null,
          roadDetourRatio: null,
          insertedRouteDistanceKm,
          abOsrmDistanceKm: abDistanceKm,
          acOsrmDistanceKm: acDistanceKm,
          acDurationMin,
          cbOsrmDistanceKm: cbDistanceKm,
          cbDurationMin,
          candidateDistanceFromAbRouteMeters: null,
          destinationDistanceFromAcRouteMeters: null,
          routePossible: true,
          timingPossible,
          prioritySafe: true,
          selectedAsBest: false,
          attempted: true,
          source: destinationSlotReason === 'C_FINAL_TRAVEL_TO_HOTEL_SPLIT'
            ? 'FINAL_TRAVEL_TO_HOTEL_SPLIT'
            : 'DESTINATION_CITY_AFTER_REACHED',
          slotContext: 'LAST_SOURCE_HOTSPOT_TO_DESTINATION_HOTEL',
          destinationSlotPriorityRank,
          routeDecisionReason: 'Destination hotspot insertion is evaluated by splitting the final travel-to-hotel leg. Normal hotspot-to-hotspot matrix is not required.',
          timingDecisionReason: timingPossible
            ? 'Timing fits before hotel/check-in within the manual 11 PM hotel reach policy.'
            : 'Timing requires reschedule because the available final hotel-leg window is not enough.',
          priorityDecisionReason: null,
          finalDecisionReason: destinationSlotReason === 'C_FINAL_TRAVEL_TO_HOTEL_SPLIT'
            ? 'Selected: final travel-to-hotel leg is split for destination-side hotspot insertion.'
            : 'Selected: destination-side insertion after destination is reached.',
          attemptedSlotLabel: `${String(anchorForHotelSlot.name || `Hotspot #${anchorForHotelSlot.hotspotId}`)} -> ${selectedName} -> ${destinationHotelLabel}`,
        };

        if (Number(destinationHotelEndpoint?.hotelId || 0) > 0) {
          await this.callbacks.upsertHotspotHotelBetweenMapRow(tx, {
            planId: Number(planId),
            routeId: Number(routeId),
            fromHotspotId: Number(anchorForHotelSlot.hotspotId),
            hotelId: Number(destinationHotelEndpoint!.hotelId),
            betweenHotspotId: Number(candidateHotspotId),
            routeFitType: 'DESTINATION_SIDE_INSERTION',
            routeDecisionReason: String(hotelSideSlot.routeDecisionReason || ''),
            abDistanceKm,
            acDistanceKm,
            cbDistanceKm,
            insertedDistanceKm: insertedRouteDistanceKm,
            roadDetourKm,
            osrmUsed: anchorToHotelLeg.osrmUsed || candidateToHotelLeg.osrmUsed,
          });
        }

        allSlotResults.push(hotelSideSlot);
 console.log('[ManualDestinationInsert] selected_destination_slot', {
          routeId: Number(routeId),
          selectedHotspotId: Number(candidateHotspotId),
          slotReason: destinationSlotReason,
          fromHotspotId: hotelSideSlot.fromHotspotId,
          fromName: hotelSideSlot.fromName,
          toName: hotelSideSlot.toName,
        });
 console.log('[ManualDestinationInsert] hotel_side_slot_used', {
          routeId: Number(routeId),
          selectedHotspotId: Number(candidateHotspotId),
          used: true,
          slotReason: destinationSlotReason,
        });
      }
    }

 // 6. Rank and find bestSlot
 // Important: if normal ON_ROUTE/MINOR slots exist, prefer those over destination-side hotel insertion.
    const isDestinationSideSlot = (slot: any): boolean =>
      String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION';

    const sortByRouteFit = (a: any, b: any): number => {
      const aDestination = isDestinationSideSlot(a);
      const bDestination = isDestinationSideSlot(b);

      if (destinationInsertionMode && aDestination && bDestination) {
        const destinationRankA = Number(a?.destinationSlotPriorityRank || 999);
        const destinationRankB = Number(b?.destinationSlotPriorityRank || 999);
        if (destinationRankA !== destinationRankB) return destinationRankA - destinationRankB;
      }

      const rankDiff = selectionRank(a.routeFitType) - selectionRank(b.routeFitType);
      if (rankDiff !== 0) return rankDiff;
      const detourA = a.roadDetourKm ?? 99999;
      const detourB = b.roadDetourKm ?? 99999;
      if (detourA !== detourB) return detourA - detourB;
      const ratioA = a.roadDetourRatio ?? 99999;
      const ratioB = b.roadDetourRatio ?? 99999;
      if (ratioA !== ratioB) return ratioA - ratioB;
      const distA = a.candidateDistanceFromAbRouteMeters ?? 99999;
      const distB = b.candidateDistanceFromAbRouteMeters ?? 99999;
      return distA - distB;
    };

    const normalUsableSlots = allSlotResults.filter((slot) => {
      const fitType = String(slot?.routeFitType || '').toUpperCase();
      return this.callbacks.isUsableMatrixRouteFitType(fitType);
    });

    const destinationUsableSlots = allSlotResults.filter((slot) => isDestinationSideSlot(slot));

    const normalFeasibleSlots = normalUsableSlots.filter((slot) =>
      this.callbacks.isFeasibleFitType(String(slot?.routeFitType || '').toUpperCase()),
    );

    const sortedByUsable = normalFeasibleSlots.length > 0
      ? [...normalFeasibleSlots].sort(sortByRouteFit)
      : [...normalUsableSlots, ...destinationUsableSlots]
          .sort((a, b) => {
            const aFeasible = this.callbacks.isFeasibleFitType(String(a?.routeFitType || '').toUpperCase()) || isDestinationSideSlot(a);
            const bFeasible = this.callbacks.isFeasibleFitType(String(b?.routeFitType || '').toUpperCase()) || isDestinationSideSlot(b);
            if (aFeasible !== bFeasible) return aFeasible ? -1 : 1;
            return sortByRouteFit(a, b);
          });

    const hasResolvedDestinationEndpoint = (slot: any): boolean =>
      Number(slot?.destinationHotelId || 0) > 0 || slot?.destinationHotelEndpointResolved === true;

    const bestSlotData = sortedByUsable.length > 0 ? sortedByUsable[0] : null;

    const bestSlot = bestSlotData
      ? {
          slotIndex: bestSlotData.slotIndex,
          fromHotspotId: bestSlotData.fromHotspotId,
          fromName: bestSlotData.fromName,
          toHotspotId: bestSlotData.toHotspotId,
          toName: bestSlotData.toName,
          destinationHotelId: bestSlotData.destinationHotelId,
          destinationHotelEndpointResolved: bestSlotData.destinationHotelEndpointResolved === true,
          routeFitType: bestSlotData.routeFitType,
          label: bestSlotData.label,
          displayLabel: bestSlotData.displayLabel || bestSlotData.label,
          shortLabel: bestSlotData.shortLabel || bestSlotData.label,
          roadDetourKm: bestSlotData.roadDetourKm,
          isZeroExtraDetour: bestSlotData.isZeroExtraDetour === true,
          distanceComparisonNote: bestSlotData.distanceComparisonNote || null,
          roadDetourRatio: bestSlotData.roadDetourRatio,
          insertedRouteDistanceKm: bestSlotData.insertedRouteDistanceKm,
          abOsrmDistanceKm: bestSlotData.abOsrmDistanceKm,
          acOsrmDistanceKm: bestSlotData.acOsrmDistanceKm,
          cbOsrmDistanceKm: bestSlotData.cbOsrmDistanceKm,
          candidateDistanceFromAbRouteMeters: bestSlotData.candidateDistanceFromAbRouteMeters,
          destinationDistanceFromAcRouteMeters: bestSlotData.destinationDistanceFromAcRouteMeters,
          sourceCityExitAnchorHotspotId: bestSlotData.sourceCityExitAnchorHotspotId,
          sourceCityExitAnchorName: bestSlotData.sourceCityExitAnchorName,
          sourceCityExitAnchorProgressRatio: bestSlotData.sourceCityExitAnchorProgressRatio,
          sourceCityExitAnchorDistanceFromRouteMeters: bestSlotData.sourceCityExitAnchorDistanceFromRouteMeters,
          attemptedSlotLabel: bestSlotData.attemptedSlotLabel,
          sourceCityExitAnchorSelectionWhy: debugEnabled ? bestSlotData.sourceCityExitAnchorSelectionWhy : undefined,
          sourceCityExitAnchorSelectionDebug: debugEnabled ? bestSlotData.sourceCityExitAnchorSelectionDebug : undefined,
          source: bestSlotData.source,
          decisionReason: bestSlotData.routeDecisionReason,
          routePossible: bestSlotData.routePossible,
          timingPossible: bestSlotData.timingPossible,
          prioritySafe: bestSlotData.prioritySafe,
          selectedAsBest: true,
          attempted: true,
          routeDecisionReason: bestSlotData.routeDecisionReason,
          timingDecisionReason: bestSlotData.timingDecisionReason,
          priorityDecisionReason: bestSlotData.priorityDecisionReason,
          finalDecisionReason:
            String(bestSlotData.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
            && !hasResolvedDestinationEndpoint(bestSlotData)
              ? 'Not selected: destination hotel endpoint is missing. Select a route hotel with valid coordinates.'
              : this.callbacks.buildRouteFitDisplayMeta({
                  routeFitType: String(bestSlotData.routeFitType || ''),
                  roadDetourKm: bestSlotData.roadDetourKm,
                  insertedRouteDistanceKm: bestSlotData.insertedRouteDistanceKm,
                  abOsrmDistanceKm: bestSlotData.abOsrmDistanceKm,
                  finalDecisionReason: 'Selected: best lower-detour feasible slot.',
                }).finalDecisionReason,
        }
      : null;

 // 7. Build requestedSlot
 // anchorIndex from caller maps to: 0 = before first hotspot (hotel/source), n = after hotspot[n-1]
 // A hotspot-to-hotspot slot exists at anchor index 1..N-1 (i.e. slotIndex = anchorIndex - 1)
    let requestedSlot: any = null;
    const anchorIdx = Number.isInteger(Number(requestedAnchorIndex)) ? Number(requestedAnchorIndex) : -1;
    const isHotspotSlot = anchorIdx >= 1 && anchorIdx <= slotPairs.length;
 const requestedSlotIndex = anchorIdx - 1; // maps to slotPairs index
    const preferredFromHotspotId = Number(matrixPreferredSlot?.fromHotspotId || 0);
    const preferredToHotspotId = Number(matrixPreferredSlot?.toHotspotId || 0);

    const mapRequestedSlotResult = (rs: any) => ({
      fromHotspotId: rs.fromHotspotId,
      fromName: rs.fromName,
      toHotspotId: rs.toHotspotId,
      toName: rs.toName,
      destinationHotelId: rs.destinationHotelId,
      destinationHotelEndpointResolved: rs.destinationHotelEndpointResolved === true,
      routeFitType: rs.routeFitType,
      label: rs.label,
      displayLabel: rs.displayLabel || rs.label,
      shortLabel: rs.shortLabel || rs.label,
      roadDetourKm: rs.roadDetourKm,
      isZeroExtraDetour: rs.isZeroExtraDetour === true,
      distanceComparisonNote: rs.distanceComparisonNote || null,
      roadDetourRatio: rs.roadDetourRatio,
      insertedRouteDistanceKm: rs.insertedRouteDistanceKm,
      abOsrmDistanceKm: rs.abOsrmDistanceKm,
      acOsrmDistanceKm: rs.acOsrmDistanceKm,
      cbOsrmDistanceKm: rs.cbOsrmDistanceKm,
      candidateDistanceFromAbRouteMeters: rs.candidateDistanceFromAbRouteMeters,
      sourceCityExitAnchorHotspotId: rs.sourceCityExitAnchorHotspotId,
      sourceCityExitAnchorName: rs.sourceCityExitAnchorName,
      sourceCityExitAnchorProgressRatio: rs.sourceCityExitAnchorProgressRatio,
      sourceCityExitAnchorDistanceFromRouteMeters: rs.sourceCityExitAnchorDistanceFromRouteMeters,
      sourceCityExitAnchorSelectionWhy: debugEnabled ? rs.sourceCityExitAnchorSelectionWhy : undefined,
      sourceCityExitAnchorSelectionDebug: debugEnabled ? rs.sourceCityExitAnchorSelectionDebug : undefined,
      source: rs.source,
      routePossible: rs.routePossible,
      timingPossible: rs.timingPossible,
      prioritySafe: rs.prioritySafe,
      selectedAsBest: false,
      attempted: true,
      decisionReason: rs.routeDecisionReason,
      routeDecisionReason: rs.routeDecisionReason,
      timingDecisionReason: rs.timingDecisionReason,
      priorityDecisionReason: rs.priorityDecisionReason,
      finalDecisionReason: rs.finalDecisionReason,
    });

    if (
      exactAnchorMode
      && (preferredFromHotspotId > 0 || preferredToHotspotId > 0)
      && Array.isArray(allSlotResults)
    ) {
      const exactGapMatch = allSlotResults.find((slot: any) => (
        Number(slot?.fromHotspotId || 0) === preferredFromHotspotId
        && Number(slot?.toHotspotId || 0) === preferredToHotspotId
      ));

      if (exactGapMatch) {
        requestedSlot = mapRequestedSlotResult(exactGapMatch);
      } else if (!(preferredFromHotspotId > 0) && preferredToHotspotId > 0) {
        const toHotspotMatch = allSlotResults.find((slot: any) => (
          Number(slot?.toHotspotId || 0) === preferredToHotspotId
          && Number(slot?.fromHotspotId || 0) <= 0
        ));

        if (toHotspotMatch) {
          requestedSlot = mapRequestedSlotResult(toHotspotMatch);
        }
      } else if (preferredFromHotspotId > 0 && !(preferredToHotspotId > 0)) {
        const fromHotspotMatch = allSlotResults.find((slot: any) => (
          Number(slot?.fromHotspotId || 0) === preferredFromHotspotId
        ));

        if (fromHotspotMatch) {
          requestedSlot = mapRequestedSlotResult(fromHotspotMatch);
        }
      }
    }

    if (!requestedSlot && !exactAnchorMode && isHotspotSlot && requestedSlotIndex >= 0 && requestedSlotIndex < allSlotResults.length) {
      const rs = allSlotResults[requestedSlotIndex];
      requestedSlot = mapRequestedSlotResult(rs);
    } else if (anchorIdx === 0 || !isHotspotSlot) {
 // Hotel/source segment or first segment before any hotspot
      const toName = routeAttractions.length > 0
        ? (nameById.get(Number(routeAttractions[0].hotspot_ID)) || `Hotspot #${routeAttractions[0].hotspot_ID}`)
        : 'First Hotspot';
      requestedSlot = {
        fromHotspotId: null,
        fromName: 'Hotel / Route Start',
        toHotspotId: routeAttractions.length > 0 ? Number(routeAttractions[0].hotspot_ID) : null,
        toName,
        routeFitType: 'MATRIX_UNAVAILABLE',
        label: this.callbacks.routeFitLabel('MATRIX_UNAVAILABLE'),
        displayLabel: this.callbacks.routeFitLabel('MATRIX_UNAVAILABLE'),
        shortLabel: this.callbacks.routeFitLabel('MATRIX_UNAVAILABLE'),
        roadDetourKm: null,
        isZeroExtraDetour: false,
        distanceComparisonNote: null,
        roadDetourRatio: null,
        insertedRouteDistanceKm: null,
        abOsrmDistanceKm: null,
        acOsrmDistanceKm: null,
        cbOsrmDistanceKm: null,
        candidateDistanceFromAbRouteMeters: null,
        routePossible: false,
        timingPossible: false,
        prioritySafe: true,
        selectedAsBest: false,
        attempted: true,
        decisionReason: 'Hotel/source segments are not evaluated in the route-fit matrix.',
        routeDecisionReason: 'Requested slot cannot be evaluated because one side is hotel/source, not a hotspot matrix endpoint.',
        timingDecisionReason: 'Timing requires reschedule because available gap is not enough.',
        priorityDecisionReason: null,
        finalDecisionReason: 'Requested slot cannot be evaluated because one side is hotel/source, not a hotspot matrix endpoint.',
      };
    }

 // 8. Choose the actual insertion slot
    let chosenSlot: any;
    let chosenSlotSource: 'BEST_FIT' | 'REQUESTED_SLOT' | 'FALLBACK_TIMING' | 'NO_MATRIX_DATA';
    let warning: string | null = null;
    const manualRelaxedRouteFit =
      manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
      && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;

 // Explicit state detection: distinguish between no matrix data and no feasible slot
    const usableTypes = ['ON_ROUTE', 'MINOR_DETOUR', 'BACKTRACK', 'OFF_ROUTE'];
    const feasibleTypes = manualRelaxedRouteFit
      ? ['ON_ROUTE', 'MINOR_DETOUR', 'BACKTRACK', 'OFF_ROUTE']
      : ['ON_ROUTE', 'MINOR_DETOUR'];

    const hasAnyMatrixData = allSlotResults.some((slot) =>
      usableTypes.includes(String(slot?.routeFitType || '').toUpperCase())
      || String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
    );

    const hasFeasibleMatrixSlot = allSlotResults.some((slot) =>
      feasibleTypes.includes(String(slot?.routeFitType || '').toUpperCase())
      || (
        String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
        && hasResolvedDestinationEndpoint(slot)
      )
    );

    const hasOnlyOffRouteOrBacktrack =
      hasAnyMatrixData && !hasFeasibleMatrixSlot;

 // Case 1: MATRIX_MISSING no real route-fit rows exist
    if (!hasAnyMatrixData) {
      if (destinationInsertionMode) {
        return {
          selectedHotspotId: candidateHotspotId,
          selectedHotspotName: candidateHotspotName,
          requestedSlot,
          bestSlot: null,
          chosenSlot: null,
          chosenSlotSource: 'NO_MATRIX_DATA',
          routeFitAvailable: false,
          hasAnyMatrixData: false,
          hasFeasibleMatrixSlot: false,
          requiresMatrixBuild: false,
          canAutoMove: false,
          canApply: false,
          code: 'DESTINATION_SLOT_NOT_FOUND',
          previewBlockReason: 'DESTINATION_SLOT_NOT_FOUND',
          warning: 'No valid destination-side insertion slot was found after destination is reached.',
          reason: 'DESTINATION_SLOT_NOT_FOUND',
          allSlotResults: [],
          hotspotCityContext,
          destinationInsertionMode: true,
          destinationAnchorHotspotId,
          destinationAnchorName,
          destinationAnchorOrder,
          destinationSlotReason,
          destinationMinCandidateIndex,
        };
      }

      const normalizedSlots = allSlotResults.map((slot) => ({
        ...slot,
        selectedAsBest: false,
        routePossible: false,
        finalDecisionReason: 'Not selected: route-fit data missing.',
      }));

      return {
        selectedHotspotId: candidateHotspotId,
        selectedHotspotName: candidateHotspotName,
        requestedSlot,
        bestSlot: null,
        chosenSlot: null,
        chosenSlotSource: 'NO_MATRIX_DATA',
        routeFitAvailable: false,
        hasAnyMatrixData: false,
        hasFeasibleMatrixSlot: false,
        requiresMatrixBuild: true,
        canAutoMove: false,
        canApply: false,
        code: 'MANUAL_HOTSPOT_MATRIX_DATA_MISSING',
        previewBlockReason: 'MATRIX_MISSING',
        warning: osrmRouteCheckFailed
          ? 'OSRM route validation failed while trying to generate source-city matrix slot.'
          : 'Route-fit matrix data is missing for this candidate and current route. Build matrix before preview/apply.',
        reason: osrmRouteCheckFailed ? 'OSRM_ROUTE_CHECK_FAILED' : 'MATRIX_MISSING',
        allSlotResults: normalizedSlots,
        hotspotCityContext,
        destinationInsertionMode,
        destinationAnchorHotspotId,
        destinationAnchorName,
        destinationAnchorOrder,
        destinationSlotReason,
        destinationMinCandidateIndex,
      };
    }

 // Case 2: MATRIX_BUILT_BUT_NO_FEASIBLE_SLOT matrix exists but all slots are OFF_ROUTE or BACKTRACK
    if (hasOnlyOffRouteOrBacktrack && !manualRelaxedRouteFit) {
      const normalizedAllSlotResults = allSlotResults.map((slot) => ({
        ...slot,
        selectedAsBest: false,
        routePossible: false,
        finalDecisionReason: 'Not selected: route-fit data exists but this hotspot is off-route/backtracking.',
      }));

      return {
        selectedHotspotId: candidateHotspotId,
        selectedHotspotName: candidateHotspotName,
        requestedSlot,
        bestSlot: null,
        chosenSlot: null,
        chosenSlotSource: 'NO_MATRIX_DATA',
        routeFitAvailable: true,
        hasAnyMatrixData: true,
        hasFeasibleMatrixSlot: false,
        requiresMatrixBuild: false,
        canAutoMove: false,
        canApply: false,
        code: 'MANUAL_HOTSPOT_NO_FEASIBLE_ROUTE_SLOT',
        previewBlockReason: 'NO_FEASIBLE_ROUTE_SLOT',
        warning: 'Matrix data exists, but this hotspot is off-route/backtracking for all current route slots.',
        allSlotResults: normalizedAllSlotResults,
        hotspotCityContext,
        destinationInsertionMode,
        destinationAnchorHotspotId,
        destinationAnchorName,
        destinationAnchorOrder,
        destinationSlotReason,
        destinationMinCandidateIndex,
      };
    }

    if (exactAnchorMode && requestedSlot && requestedSlot.routeFitType !== 'MATRIX_UNAVAILABLE') {
      chosenSlotSource = 'REQUESTED_SLOT';
      chosenSlot = {
        ...requestedSlot,
        source: 'REQUESTED_SLOT',
        selectedAsBest: false,
        attempted: true,
      };
      warning = null;
    } else if (exactAnchorMode) {
      chosenSlotSource = 'NO_MATRIX_DATA';
      chosenSlot = null;
      warning = 'The selected Fit Here position cannot be confirmed for this exact route gap.';
    } else if (
      bestSlot
      && (
        this.callbacks.isFeasibleFitType(String(bestSlot.routeFitType || '').toUpperCase())
        || (
          manualRelaxedRouteFit
          && this.callbacks.isUsableMatrixRouteFitType(String(bestSlot.routeFitType || '').toUpperCase())
        )
      )
    ) {
 // Best slot is feasible use it
      chosenSlotSource = 'BEST_FIT';
      chosenSlot = {
        slotIndex: bestSlot.slotIndex,
        fromHotspotId: bestSlot.fromHotspotId,
        fromName: bestSlot.fromName,
        toHotspotId: bestSlot.toHotspotId,
        toName: bestSlot.toName,
        destinationHotelId: bestSlot.destinationHotelId,
        destinationHotelEndpointResolved: bestSlot.destinationHotelEndpointResolved === true,
        routeFitType: bestSlot.routeFitType,
        label: bestSlot.label,
        displayLabel: bestSlot.displayLabel || bestSlot.label,
        shortLabel: bestSlot.shortLabel || bestSlot.label,
        source: 'BEST_FIT',
        isZeroExtraDetour: bestSlot.isZeroExtraDetour === true,
        distanceComparisonNote: bestSlot.distanceComparisonNote || null,
        routePossible: bestSlot.routePossible || manualRelaxedRouteFit,
        timingPossible: bestSlot.timingPossible,
        prioritySafe: bestSlot.prioritySafe,
        selectedAsBest: true,
        attempted: true,
        routeDecisionReason: bestSlot.routeDecisionReason,
        timingDecisionReason: bestSlot.timingDecisionReason,
        priorityDecisionReason: bestSlot.priorityDecisionReason,
        finalDecisionReason: bestSlot.finalDecisionReason,
        sourceCityExitAnchorHotspotId: bestSlot.sourceCityExitAnchorHotspotId,
        sourceCityExitAnchorName: bestSlot.sourceCityExitAnchorName,
        sourceCityExitAnchorProgressRatio: bestSlot.sourceCityExitAnchorProgressRatio,
        sourceCityExitAnchorDistanceFromRouteMeters: bestSlot.sourceCityExitAnchorDistanceFromRouteMeters,
        attemptedSlotLabel: bestSlot.attemptedSlotLabel,
      };
 // Warn if user requested a different slot
      if (requestedSlot && isHotspotSlot && requestedSlotIndex !== bestSlot.slotIndex) {
        warning = `Requested slot (${requestedSlot.fromName} → ${requestedSlot.toName}) is not the optimal insertion point. Best slot is ${bestSlot.fromName} → ${bestSlot.toName} (${bestSlot.label}).`;
      }
    } else if (bestSlot) {
 // Matrix exists but best slot is not feasible for apply (e.g. BACKTRACK/OFF_ROUTE)
      chosenSlotSource = 'BEST_FIT';
      chosenSlot = {
        ...bestSlot,
        selectedAsBest: true,
        attempted: true,
      };
      warning = manualRelaxedRouteFit
        ? `Manual add allows this route-fit as long as the rebuilt timeline finishes within ${manualTimingPolicy?.endTime || 'the manual day end'}. Best available slot is ${bestSlot.fromName} → ${bestSlot.toName} (${bestSlot.label}).`
        : `No ON_ROUTE/MINOR_DETOUR insertion slot found. Best available route-fit slot is ${bestSlot.fromName} → ${bestSlot.toName} (${bestSlot.label}).`;
    } else if (requestedSlot && isHotspotSlot && requestedSlot.routeFitType !== 'MATRIX_UNAVAILABLE') {
      chosenSlotSource = 'REQUESTED_SLOT';
      chosenSlot = {
        ...requestedSlot,
        source: 'REQUESTED_SLOT',
        selectedAsBest: false,
        attempted: true,
      };
      warning = 'Requested slot has matrix data but no feasible ON_ROUTE/MINOR_DETOUR fit is currently available.';
    } else {
      chosenSlotSource = 'NO_MATRIX_DATA';
      chosenSlot = null;
      warning = 'No usable route-fit slot available for this candidate.';
    }

    const routeFitAvailable = hasAnyMatrixData;
    const chosenRouteFitType = String(chosenSlot?.routeFitType || '').toUpperCase();
    const manualRouteFitAllowed =
      manualRelaxedRouteFit
      && this.callbacks.isUsableMatrixRouteFitType(chosenRouteFitType);
    const canAutoMove =
      chosenSlotSource === 'BEST_FIT'
      && (
        this.callbacks.isFeasibleFitType(chosenRouteFitType)
        || manualRouteFitAllowed
      );
    const destinationSideSlotChosen = (
      destinationInsertionMode
      && chosenRouteFitType === 'DESTINATION_SIDE_INSERTION'
      && Number(chosenSlot?.fromHotspotId || 0) > 0
    );
    const destinationSideReady = (
      destinationSideSlotChosen
      && hasResolvedDestinationEndpoint(chosenSlot)
    );
    const canApply = destinationSideReady || (
      canAutoMove
      && Number(chosenSlot?.fromHotspotId || 0) > 0
      && Number(chosenSlot?.toHotspotId || 0) > 0
    );
    const destinationHotelMissingForChosen = (
      destinationInsertionMode
      && destinationSideSlotChosen
      && !hasResolvedDestinationEndpoint(chosenSlot)
    );
    const destinationHotelMissingWarning = (
      destinationInsertionMode
      && destinationSideSlotChosen
      && !hasResolvedDestinationEndpoint(chosenSlot)
    )
      ? 'Destination-side slot found, but selected route hotel is missing or has no valid coordinates. Select a hotel for this route to enable insertion.'
      : null;

    const normalizedAllSlotResults = allSlotResults.map((slot) => ({
      ...slot,
      selectedAsBest:
        !!bestSlotData
        && (
          this.callbacks.isUsableMatrixRouteFitType(String(slot?.routeFitType || '').toUpperCase())
          || String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
        )
        && !(
          String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
          && !hasResolvedDestinationEndpoint(slot)
        )
        && Number(slot?.slotIndex) === Number(bestSlotData?.slotIndex),
      routePossible:
        String(slot?.routeFitType || '').toUpperCase() === 'UNKNOWN'
          ? false
          : (
          String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
          && !hasResolvedDestinationEndpoint(slot)
        )
          ? false
        : (
          manualRelaxedRouteFit
          && this.callbacks.isUsableMatrixRouteFitType(String(slot?.routeFitType || '').toUpperCase())
        )
          ? true
        : slot?.routePossible,
      finalDecisionReason:
        String(slot?.routeFitType || '').toUpperCase() === 'UNKNOWN'
          ? 'Not selected: route-fit data missing.'
          : (
            String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
            && !hasResolvedDestinationEndpoint(slot)
          )
            ? 'Not selected: destination hotel endpoint is missing. Select a route hotel with valid coordinates.'
          : slot?.finalDecisionReason,
    }));

    if (destinationHotelMissingForChosen && chosenSlot) {
      chosenSlot.routePossible = false;
      chosenSlot.selectedAsBest = false;
      chosenSlot.finalDecisionReason = 'Not selected: destination hotel endpoint is missing. Select a route hotel with valid coordinates.';
    }

    return {
      selectedHotspotId: candidateHotspotId,
      selectedHotspotName: candidateHotspotName,
      requestedSlot,
      bestSlot,
      chosenSlot,
      allSlotResults: normalizedAllSlotResults,
      chosenSlotSource,
      routeFitAvailable,
      hasAnyMatrixData,
      hasFeasibleMatrixSlot,
      requiresMatrixBuild: false,
      canAutoMove,
      canApply,
      code: destinationSideSlotChosen
        ? 'MANUAL_HOTSPOT_DESTINATION_INSERT_PREVIEW_READY'
        : 'MANUAL_HOTSPOT_PREVIEW_READY',
      previewBlockReason: null,
      warning: destinationHotelMissingWarning || warning,
      hotspotCityContext,
      destinationInsertionMode,
      destinationAnchorHotspotId,
      destinationAnchorName,
      destinationAnchorOrder,
      destinationSlotReason,
      destinationMinCandidateIndex,
      destinationHotelId: Number(destinationHotelEndpoint?.hotelId || 0) || null,
      destinationHotelName: destinationHotelLabel,
      destinationHotelEndpointResolved,
      manualTimingPolicy,
    };
  }


}

