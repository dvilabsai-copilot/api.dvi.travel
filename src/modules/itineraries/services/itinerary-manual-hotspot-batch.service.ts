// FILE: src/modules/itineraries/services/itinerary-manual-hotspot-batch.service.ts

import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { HotspotEngineService } from '../engines/hotspot-engine.service';
import { TimeConverter } from '../engines/helpers/time-converter';

type ManualHotspotBatchCallbacks = Record<string, (...args: any[]) => any>;
type ManualHotspotTimingPolicy = any;
type ManualFitHereAnchorIntent = 'AFTER_START' | 'AFTER_ATTRACTION';

@Injectable()
export class ItineraryManualHotspotBatchService {
  private readonly MANUAL_HOTSPOT_EFFECTIVE_PRIORITY = 4;
  private readonly CONFIRMATION_REQUIRED_PRIORITY = 3;
  private callbacks: ManualHotspotBatchCallbacks = {};

  constructor(private readonly hotspotEngine: HotspotEngineService) {}

  setCallbacks(callbacks: ManualHotspotBatchCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async runManualHotspotBatchWithinTransaction(
    tx: any,
    planId: number,
    routeId: number,
    hotspotIds: number[],
    userId: number,
    options?: {
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      anchorIntent?: ManualFitHereAnchorIntent;
      anchorIndex?: number;
      afterHotspotId?: number;
      beforeHotspotId?: number;
      afterRouteHotspotId?: number;
      beforeRouteHotspotId?: number;
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
      allowTopPriorityRemoval?: boolean;
      focusHotspotId?: number;
      previewOnly?: boolean;
      debug?: boolean;
      forceConflictInsertion?: boolean;
      forceConflictPreferredTimesByHotspotId?: Record<number, { start: Date; end: Date }>;
      exactAnchorMode?: boolean;
      trustedPreviewConfirmation?: boolean;
      trustedPreviewTimeline?: any[] | null;
      trustedPreviewTimelineFingerprint?: string | null;
      enforceTrustedPreviewConfirmation?: boolean;
      manualTimingPolicy?: ManualHotspotTimingPolicy;
      sourceInsertionMode?: boolean;
      sourceMaxCandidateIndex?: number;
      matrixPreferredSlot?: {
        fromHotspotId?: number;
        toHotspotId?: number;
        slotIndex?: number;
        source?: 'BEST_FIT' | 'EXACT_ANCHOR';
      };
    },
  ) {
    const requestedHotspotIds = this.callbacks.normalizeManualHotspotIds(hotspotIds);
    if (requestedHotspotIds.length === 0) {
      throw new BadRequestException('At least one hotspot is required');
    }

    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(routeId),
        itinerary_plan_ID: Number(planId),
        deleted: 0,
      },
    });

    if (!route) {
      throw new NotFoundException('Route not found for this itinerary plan');
    }

    if (options?.previewOnly !== true && requestedHotspotIds.length === 1) {
      const existingInRoute = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
        where: {
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          hotspot_ID: Number(requestedHotspotIds[0]),
          item_type: 4,
          deleted: 0,
          status: 1,
        },
        select: {
          route_hotspot_ID: true,
        },
      });

      if (existingInRoute) {
        return {
          success: true,
          inserted: false,
          alreadyExists: true,
          code: 'MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE',
          message: 'This hotspot is already active in this route.',
          planId: Number(planId),
          routeId: Number(routeId),
          hotspotId: Number(requestedHotspotIds[0]),
          hotspotIds: requestedHotspotIds,
        };
      }
    }

    const hotspotMasters = await (tx as any).dvi_hotspot_place.findMany({
      where: {
        hotspot_ID: { in: requestedHotspotIds },
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_priority: true,
        hotspot_duration: true,
        hotspot_location: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    if (hotspotMasters.length !== requestedHotspotIds.length) {
      throw new BadRequestException('One or more hotspots are missing or inactive');
    }

    const routeManualHotspotIds = await this.callbacks.getRouteManualHotspotIds(tx, Number(planId), Number(routeId), requestedHotspotIds);

    const manualTimingPolicy = await this.callbacks.getManualHotspotTimingPolicyInTx(
      tx,
      Number(planId),
      route,
    );

    const callerHasAnchor =
      (options?.anchorType === 'after_travel' || options?.anchorType === 'BETWEEN_ROWS') &&
      Number.isInteger(Number(options?.anchorIndex));

    let resolvedAnchorType: 'after_travel' | 'BETWEEN_ROWS' | undefined = callerHasAnchor
      ? options?.anchorType
      : undefined;
    let resolvedAnchorIndex: number | undefined = callerHasAnchor
      ? Number(options?.anchorIndex)
      : undefined;

    console.log('[ManualHotspotApply] requested anchor', {
      planId: Number(planId),
      routeId: Number(routeId),
      requestedHotspotIds,
      anchorType: options?.anchorType || null,
      anchorIndex: Number.isInteger(Number(options?.anchorIndex)) ? Number(options?.anchorIndex) : null,
      previewOnly: options?.previewOnly === true,
      matrixPreferredSlot: options?.matrixPreferredSlot || null,
    });

    if (!callerHasAnchor && requestedHotspotIds.length > 0) {
      const inferred = await this.callbacks.inferDetourOptimizedAnchorIndex(
        tx,
        Number(planId),
        Number(routeId),
        Number(requestedHotspotIds[0]),
      );
      if (Number.isInteger(Number(inferred))) {
        resolvedAnchorType = 'after_travel';
        resolvedAnchorIndex = Number(inferred);
      }
    }

    // Fast path: when the caller already confirmed force-conflict insertion,
    // skip the slow adaptive search entirely and persist each hotspot as a conflict row.
    if (options?.forceConflictInsertion === true && options?.previewOnly !== true) {
      for (const hotspotId of requestedHotspotIds) {
        await this.callbacks.forceInsertManualHotspotConflictRow(
          tx,
          Number(planId),
          Number(routeId),
          Number(hotspotId),
          Number(userId || 1),
          options?.forceConflictPreferredTimesByHotspotId?.[Number(hotspotId)],
        );
      }
      const refreshedTimeline = await this.callbacks.buildRouteTimelineSnapshotAfterManualConflictInsert(
        tx,
        Number(planId),
        Number(routeId),
      );
      const refreshedSelectedRows = Array.isArray(refreshedTimeline)
        ? refreshedTimeline.filter((row: any) => (
            String(row?.type || '').toLowerCase() === 'attraction' &&
            requestedHotspotIds.includes(Number(row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
          ))
        : [];

      if (refreshedSelectedRows.length === 0) {
        console.warn('[FitHere][force_conflict_refreshed_timeline_missing_selected_hotspot]', {
          planId: Number(planId),
          routeId: Number(routeId),
          requestedHotspotIds,
          refreshedTimelineCount: Array.isArray(refreshedTimeline) ? refreshedTimeline.length : 0,
        });
      }
      return {
        success: true,
        inserted: true,
        forceConflictInsertionApplied: true,
        planId: Number(planId),
        routeId: Number(routeId),
        hotspotIds: requestedHotspotIds,
        manualTimingPolicy,
        fullTimeline: refreshedTimeline,
        routeTimeline: refreshedTimeline,
        message: 'Manual hotspots inserted as conflicts after user confirmation.',
        distanceAndToFro: this.callbacks.buildDistanceAndToFroLabels({
          totalTravelKm: 0,
          extraTravelKm: 0,
          toAndFroPenalty: 0,
          candidateIndex: 0,
        }),
        resolution: {
          requiresConfirmation: false,
          forceConflictInsertionApplied: true,
          removedOptionalHotspots: [],
          removedTopPriorityHotspots: [],
          topPriorityAffected: [],
          scheduledManualHotspots: [],
          unscheduledManualHotspots: requestedHotspotIds.map((id) => ({
            id,
            name: hotspotMasters.find((m: any) => m.hotspot_ID === id)?.hotspot_name ?? '',
            reason: 'Force-inserted as conflict by user confirmation.',
          })),
          shiftedHotspots: [],
          deferredHotspots: [],
          removedHotspots: [],
          removedCount: 0,
          stillUnschedulable: true,
          timingAdjusted: false,
          reason: 'Force conflict insertion applied.',
          validation: {
            passesScheduleRules: false,
            readyToApply: false,
            requiresPriorityConfirmation: false,
            stillUnschedulable: true,
            routeEndOverflowMinutes: 0,
            manualTimingPolicy,
            openingHourConflictCount: requestedHotspotIds.length,
            selectedManualConflictCount: requestedHotspotIds.length,
            scheduledSelectedManualCount: 0,
            unscheduledManualCount: requestedHotspotIds.length,
            reason: 'Force conflict insertion applied.',
          },
          slotInsights: [],
          insertionMetrics: this.callbacks.buildDistanceAndToFroLabels({
            totalTravelKm: 0,
            extraTravelKm: 0,
            toAndFroPenalty: 0,
            candidateIndex: 0,
          }),
        },
      };
    }

    // â”€â”€ Build manualInsertionFit before any apply mutation â”€â”€
    const baselineTimelineForMatrix = await this.callbacks.getRouteTimelineForScoring(tx, Number(planId), Number(routeId));
    const preFocusHotspotId = this.callbacks.resolveManualHotspotFocusId(requestedHotspotIds, routeManualHotspotIds, options?.focusHotspotId);
    const preFocusCandidate = hotspotMasters.find((m: any) => Number(m.hotspot_ID) === Number(preFocusHotspotId));
    const manualInsertionFit = await this.callbacks.buildManualInsertionFit(
      tx,
      Number(planId),
      Number(routeId),
      Number(preFocusHotspotId),
      String(preFocusCandidate?.hotspot_name || `Hotspot #${preFocusHotspotId}`),
      options?.anchorIndex,
      options?.anchorType,
      baselineTimelineForMatrix,
      options?.debug === true,
      manualTimingPolicy,
      options?.exactAnchorMode === true,
      options?.matrixPreferredSlot,
    );

    if (manualInsertionFit && !manualInsertionFit.manualTimingPolicy) {
      manualInsertionFit.manualTimingPolicy = manualTimingPolicy;
    }

    const hasValidMatrixSlot = this.callbacks.hasValidManualMatrixSlot(manualInsertionFit);
    const emptyRouteSchedulerEligible = this.callbacks.isEmptyRouteSchedulerEligible(manualInsertionFit);
    const destinationSlotNotFound = (
      manualInsertionFit?.destinationInsertionMode === true
      && String(manualInsertionFit?.previewBlockReason || '').toUpperCase() === 'DESTINATION_SLOT_NOT_FOUND'
    );
    const destinationHotelSideReady = (
      manualInsertionFit?.destinationInsertionMode === true
      && String(manualInsertionFit?.code || '').toUpperCase() === 'MANUAL_HOTSPOT_DESTINATION_INSERT_PREVIEW_READY'
    );
    const manualRelaxedRouteFitForMatrixRequirement =
      manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
      && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
    const manualRelaxedMatrixUsable =
      manualRelaxedRouteFitForMatrixRequirement
      && manualInsertionFit?.hasAnyMatrixData === true
      && hasValidMatrixSlot;
    const destinationSideInsertion =
      manualInsertionFit?.destinationInsertionMode === true
      || String(manualInsertionFit?.hotspotCityContext || '').toUpperCase() === 'DESTINATION_CITY';
    const exactAnchorGapRequested =
      options?.exactAnchorMode === true
      && (
        Number(options?.afterHotspotId || 0) > 0
        || Number(options?.beforeHotspotId || 0) > 0
      );
    const requiresMatrixBuild = (
      (
        manualInsertionFit?.requiresMatrixBuild === true
        && !destinationSideInsertion
        && !manualRelaxedMatrixUsable
        && !exactAnchorGapRequested
      )
      || (
        !hasValidMatrixSlot
        && !destinationHotelSideReady
        && !emptyRouteSchedulerEligible
        && !destinationSideInsertion
        && !exactAnchorGapRequested
      )
    ) && !destinationSlotNotFound;
    const missingMatrixBuildSuggestion = this.callbacks.buildMissingMatrixBuildSuggestion(
      Number(planId),
      Number(routeId),
      Number(preFocusHotspotId),
    );

    if (destinationSlotNotFound && options?.previewOnly === true) {
      console.warn('[ManualDestinationInsert] destination_slot_not_found_continuing_preview_rescue', {
        planId: Number(planId),
        routeId: Number(routeId),
        selectedHotspotId: Number(preFocusHotspotId),
        exactAnchorMode: options?.exactAnchorMode === true,
      });
      manualInsertionFit.previewBlockReason = null;
      manualInsertionFit.requiresMatrixBuild = false;
      manualInsertionFit.canBuildMatrix = false;
      manualInsertionFit.code = 'MANUAL_HOTSPOT_DESTINATION_INSERT_PREVIEW_READY';
    }

    if (requiresMatrixBuild) {
      if (options?.previewOnly === true) {
        if (
          manualInsertionFit?.destinationInsertionMode === true
          || String(manualInsertionFit?.hotspotCityContext || '').toUpperCase() === 'DESTINATION_CITY'
        ) {
          return {
            success: true,
            inserted: false,
            selectedIncluded: true,
            code: 'MANUAL_HOTSPOT_DESTINATION_INSERT_PREVIEW_READY',
            message: 'Destination-side manual hotspot can be previewed without normal route-fit matrix.',
            planId: Number(planId),
            routeId: Number(routeId),
            hotspotId: Number(preFocusHotspotId),
            hotspotIds: requestedHotspotIds,
            manualTimingPolicy,
            canBuildMatrix: false,
            fullTimeline: baselineTimelineForMatrix,
            routeTimeline: baselineTimelineForMatrix,
            manualInsertionFit: {
              ...manualInsertionFit,
              requiresMatrixBuild: false,
              canBuildMatrix: false,
              destinationInsertionMode: true,
              manualTimingPolicy,
              previewBlockReason: null,
              code: 'MANUAL_HOTSPOT_DESTINATION_INSERT_PREVIEW_READY',
            },
            validation: {
              passesScheduleRules: true,
              readyToApply: true,
              requiresPriorityConfirmation: false,
              stillUnschedulable: false,
              routeEndOverflowMinutes: 0,
              manualTimingPolicy,
              openingHourConflictCount: 0,
              selectedManualConflictCount: 0,
              scheduledSelectedManualCount: requestedHotspotIds.length,
              unscheduledManualCount: 0,
              requiresMatrixBuild: false,
              reason: 'DESTINATION_SIDE_MATRIX_NOT_REQUIRED',
            },
          };
        }

        const osrmRouteCheckFailed = String(manualInsertionFit?.reason || manualInsertionFit?.previewBlockReason || '') === 'OSRM_ROUTE_CHECK_FAILED';
        const manualFitCode = String(manualInsertionFit?.code || '').toUpperCase();
        const manualFitBlockReason = String(manualInsertionFit?.previewBlockReason || '').toUpperCase();
        const matrixExistsButNoFeasibleSlot =
          manualInsertionFit?.requiresMatrixBuild !== true
          && manualInsertionFit?.hasAnyMatrixData === true
          && manualInsertionFit?.hasFeasibleMatrixSlot === false;
        const noFeasibleRouteSlot = manualFitBlockReason === 'NO_FEASIBLE_ROUTE_SLOT'
          || manualFitCode === 'MANUAL_HOTSPOT_NO_FEASIBLE_ROUTE_SLOT'
          || matrixExistsButNoFeasibleSlot;
        const blockedValidation = {
          passesScheduleRules: false,
          readyToApply: false,
          requiresPriorityConfirmation: false,
          stillUnschedulable: true,
          routeEndOverflowMinutes: 0,
          manualTimingPolicy,
          openingHourConflictCount: 0,
          selectedManualConflictCount: 0,
          scheduledSelectedManualCount: 0,
          unscheduledManualCount: requestedHotspotIds.length,
          requiresMatrixBuild: !noFeasibleRouteSlot,
          reason: osrmRouteCheckFailed
            ? 'OSRM_ROUTE_CHECK_FAILED'
            : noFeasibleRouteSlot
              ? 'NO_FEASIBLE_ROUTE_SLOT'
              : 'MATRIX_DATA_MISSING',
        };

        return {
          success: false,
          inserted: false,
          selectedIncluded: false,
          code: noFeasibleRouteSlot ? 'MANUAL_HOTSPOT_NO_FEASIBLE_ROUTE_SLOT' : 'MATRIX_DATA_MISSING',
          message: osrmRouteCheckFailed
            ? 'OSRM route validation failed while checking source-city route anchor.'
            : noFeasibleRouteSlot
              ? (
                  manualTimingPolicy?.allowOffRouteWhenTimePermits === true
                    ? 'This hotspot adds extra distance or off-route travel. Manual add can continue if the rebuilt route fits within the allowed timing window.'
                    : 'Matrix data exists, but this hotspot is off-route or backtracking for all current route segments.'
                )
              : 'Route-fit matrix data is missing for this hotspot and current route. Build matrix before preview/apply.',
          planId: Number(planId),
          routeId: Number(routeId),
          hotspotId: Number(requestedHotspotIds[0] || 0),
          hotspotIds: requestedHotspotIds,
          manualTimingPolicy,
          canBuildMatrix: !noFeasibleRouteSlot && !osrmRouteCheckFailed,
          matrixBuildCandidateId: Number(preFocusHotspotId || requestedHotspotIds[0] || 0),
          fullTimeline: baselineTimelineForMatrix,
          routeTimeline: baselineTimelineForMatrix,
          manualInsertionFit: {
            ...manualInsertionFit,
            manualTimingPolicy,
            canBuildMatrix: !noFeasibleRouteSlot && !osrmRouteCheckFailed,
            matrixBuildCandidateId: Number(preFocusHotspotId || requestedHotspotIds[0] || 0),
          },
          missingMatrixBuildSuggestion,
          validation: blockedValidation,
          resolution: {
            manualTimingPolicy,
            manualInsertionFit: {
              ...manualInsertionFit,
              manualTimingPolicy,
              canBuildMatrix: !noFeasibleRouteSlot && !osrmRouteCheckFailed,
              matrixBuildCandidateId: Number(preFocusHotspotId || requestedHotspotIds[0] || 0),
            },
            requiresConfirmation: false,
            removedOptionalHotspots: [],
            removedTopPriorityHotspots: [],
            topPriorityAffected: [],
            scheduledManualHotspots: [],
            unscheduledManualHotspots: requestedHotspotIds.map((id) => ({
              id: Number(id),
              name: String(hotspotMasters.find((m: any) => Number(m?.hotspot_ID || 0) === Number(id))?.hotspot_name || `Hotspot #${id}`),
              reason: noFeasibleRouteSlot
                ? (
                    manualTimingPolicy?.allowOffRouteWhenTimePermits === true
                      ? 'This hotspot adds extra distance or off-route travel. Manual add can continue if the rebuilt route fits within the allowed timing window.'
                      : 'Matrix data exists, but this hotspot is off-route or backtracking for all current route segments.'
                  )
                : 'Matrix data missing. Build route matrix for this candidate before preview/apply.',
            })),
            shiftedHotspots: [],
            deferredHotspots: [],
            removedHotspots: [],
            removedCount: 0,
            stillUnschedulable: true,
            timingAdjusted: false,
            reason: osrmRouteCheckFailed
              ? 'OSRM_ROUTE_CHECK_FAILED'
              : noFeasibleRouteSlot
                ? 'NO_FEASIBLE_ROUTE_SLOT'
                : 'MATRIX_DATA_MISSING',
            validation: blockedValidation,
            slotInsights: [],
            insertionMetrics: this.callbacks.buildDistanceAndToFroLabels({
              totalTravelKm: 0,
              extraTravelKm: 0,
              toAndFroPenalty: 0,
              candidateIndex: 0,
            }),
            missingMatrixBuildSuggestion,
          },
        };
      }

      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MANUAL_HOTSPOT_MATRIX_DATA_MISSING',
        message: 'Route-fit matrix data is missing for this hotspot and current route. Build matrix before applying.',
        routeId: Number(routeId),
        hotspotIds: requestedHotspotIds,
        missingMatrixBuildSuggestion,
      });
    }

    const bestRouteFitType = String(manualInsertionFit?.bestSlot?.routeFitType || '').toUpperCase();
    const bestFromHotspotId = Number(manualInsertionFit?.bestSlot?.fromHotspotId || 0);
    const bestToHotspotId = Number(manualInsertionFit?.bestSlot?.toHotspotId || 0);
    const bestSlotContext = String(manualInsertionFit?.bestSlot?.slotContext || '').toUpperCase();
    const manualRelaxedRouteFit =
      manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
      && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
    const isNormalMatrixSlot =
      bestRouteFitType === 'ON_ROUTE'
      || bestRouteFitType === 'MINOR_DETOUR'
      || (
        manualRelaxedRouteFit
        && (bestRouteFitType === 'BACKTRACK' || bestRouteFitType === 'OFF_ROUTE')
      );
    const isSingleHotspotBeforeSlot =
      bestRouteFitType === 'SINGLE_HOTSPOT_BEFORE';
    const isSingleHotspotAfterSlot =
      bestRouteFitType === 'SINGLE_HOTSPOT_AFTER';
    const isDestinationSideSlot =
      bestRouteFitType === 'DESTINATION_SIDE_INSERTION';
    const isCityEndpointBeforeSlot =
      bestSlotContext === 'CITY_TO_HOTSPOT';
    const isCityEndpointAfterSlot =
      bestSlotContext === 'HOTSPOT_TO_CITY';
    const isCityToCitySlot =
      bestSlotContext === 'CITY_TO_CITY';
    const hasMatrixSafeSlot =
      options?.previewOnly !== true
      && options?.forceConflictInsertion !== true
      && requestedHotspotIds.length === 1
      && !!manualInsertionFit?.bestSlot
      && (
        (
          isNormalMatrixSlot
          && bestFromHotspotId > 0
          && bestToHotspotId > 0
        )
        || (
          isSingleHotspotBeforeSlot
          && bestToHotspotId > 0
        )
        || (
          isSingleHotspotAfterSlot
          && bestFromHotspotId > 0
        )
        || (
          isDestinationSideSlot
          && bestFromHotspotId > 0
        )
        || (
          isNormalMatrixSlot
          && isCityEndpointBeforeSlot
          && bestToHotspotId > 0
        )
        || (
          isNormalMatrixSlot
          && isCityEndpointAfterSlot
          && bestFromHotspotId > 0
        )
        || (
          isCityToCitySlot
          && Number(preFocusHotspotId || 0) > 0
        )
      );

    if (hasMatrixSafeSlot && options?.previewOnly !== true && options?.exactAnchorMode !== true) {
      return this.callbacks.applyMatrixSafeManualHotspotInsertionInTx(tx, {
        planId: Number(planId),
        routeId: Number(routeId),
        selectedHotspotIds: requestedHotspotIds,
        userId: Number(userId || 1),
        manualInsertionFit,
        manualTimingPolicy,
        matrixPreferredSlot: options?.matrixPreferredSlot,
        trustedPreviewConfirmation: options?.trustedPreviewConfirmation === true,
        trustedPreviewTimeline: options?.trustedPreviewTimeline || null,
        trustedPreviewTimelineFingerprint: String(options?.trustedPreviewTimelineFingerprint || '').trim() || null,
        enforceTrustedPreviewConfirmation: options?.enforceTrustedPreviewConfirmation === true,
        allowP1P2Removal: options?.allowP1P2Removal === true,
        allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
      });
    }

    const preparedByHotspotId = new Map<number, { alreadyExisted: boolean }>();
    for (const hotspotId of requestedHotspotIds) {
      await this.callbacks.removeRouteHotspotFromExcludedList(tx, Number(routeId), hotspotId, route);
      const prepared = await this.callbacks.ensureManualHotspotRow(tx, Number(planId), Number(routeId), hotspotId, Number(userId || 1));
      preparedByHotspotId.set(hotspotId, prepared);
    }

    // If frontend sends BEST_FIT slot hints, keep them only when they match backend-computed best slot.
    const payloadMatrixPreferredSlot = options?.matrixPreferredSlot || null;
    if (payloadMatrixPreferredSlot?.source === 'BEST_FIT' && manualInsertionFit?.bestSlot) {
      const payloadFrom = Number(payloadMatrixPreferredSlot?.fromHotspotId || 0);
      const payloadTo = Number(payloadMatrixPreferredSlot?.toHotspotId || 0);
      const bestFrom = Number(manualInsertionFit?.bestSlot?.fromHotspotId || 0);
      const bestTo = Number(manualInsertionFit?.bestSlot?.toHotspotId || 0);
      if (payloadFrom !== bestFrom || payloadTo !== bestTo) {
        console.warn('[ManualHotspotApply] matrixPreferredSlot mismatch with computed best slot', {
          payloadFrom,
          payloadTo,
          bestFrom,
          bestTo,
        });
      }
    }

    const matrixGapResolution = await this.callbacks.resolveMatrixBestInsertionGap({
      routeId: Number(routeId),
      selectedHotspotId: Number(preFocusHotspotId),
      manualInsertionFit,
    });

    console.log('[ManualHotspotApply] matrix best slot', {
      selectedHotspotId: Number(preFocusHotspotId),
      chosenSlotSource: manualInsertionFit?.chosenSlotSource || null,
      bestSlot: manualInsertionFit?.bestSlot || null,
      matrixGapResolution,
    });

    if (matrixGapResolution.shouldUseMatrixSlot) {
      resolvedAnchorType = 'after_travel';
      resolvedAnchorIndex = Number(matrixGapResolution.gapIndex);
    }

    console.log('[ManualHotspotApply] resolved gap index', {
      resolvedAnchorType: resolvedAnchorType || null,
      resolvedAnchorIndex: Number.isInteger(Number(resolvedAnchorIndex)) ? Number(resolvedAnchorIndex) : null,
      reason: matrixGapResolution.reason,
      shouldUseMatrixSlot: matrixGapResolution.shouldUseMatrixSlot,
    });

    const adaptive = await this.callbacks.runAdaptiveManualHotspotSetInsertion(
      tx,
      Number(planId),
      Number(routeId),
      routeManualHotspotIds,
      {
        anchorType: resolvedAnchorType,
        anchorIntent: options?.anchorIntent,
        anchorIndex: resolvedAnchorIndex,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
      },
      {
        allowP3Removal: options?.allowP3Removal === true,
        allowP1P2Removal: options?.allowP1P2Removal === true,
        allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
        previewOnly: options?.previewOnly === true,
        exactAnchorMode: options?.exactAnchorMode === true,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
        anchorLabel: this.callbacks.buildManualFitAnchorLabel({
          anchorType: resolvedAnchorType,
          anchorIndex: resolvedAnchorIndex,
          afterHotspotId: options?.afterHotspotId ?? null,
          beforeHotspotId: options?.beforeHotspotId ?? null,
        }),
        destinationInsertionMode: manualInsertionFit?.destinationInsertionMode === true,
        destinationMinCandidateIndex: Number(manualInsertionFit?.destinationMinCandidateIndex || 0) || undefined,
        sourceInsertionMode: manualInsertionFit?.hotspotCityContext === 'SOURCE_CITY' || options?.sourceInsertionMode === true,
        sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
        manualTimingPolicy,
      },
    );

    const focusHotspotId = this.callbacks.resolveManualHotspotFocusId(requestedHotspotIds, routeManualHotspotIds, options?.focusHotspotId);
    const selectedAttempt = (adaptive.manualOptimizer?.attempts || []).find((attempt: any) => (
      attempt?.selected === true &&
      String(attempt?.strategyKey || '') === String(adaptive.manualOptimizer?.selectedStrategyKey || '')
    )) || (adaptive.manualOptimizer?.attempts || []).find((attempt: any) => attempt?.selected === true) || null;
    const authoritativeRemovedHotspots = this.callbacks.getAuthoritativeManualFitRemovedHotspots({
      selectedAttempt,
      fallbackRemovedHotspots: [
        ...(adaptive.removedOptionalHotspots || []),
        ...(adaptive.removedTopPriorityHotspots || []),
      ],
    });
    const allRemovedHotspots = [
      ...authoritativeRemovedHotspots,
    ];

    const enginePreview = await this.hotspotEngine.previewManualHotspotAdd(
      tx,
      Number(planId),
      Number(routeId),
      focusHotspotId,
      {
        droppedItems: allRemovedHotspots.map((row: any) => ({
          itineraryRouteId: Number(routeId),
          hotspotId: Number(row.id),
          routeHotspotId: 0,
          name: row.name,
          hotspotOrder: 0,
          priority: row.priority,
          reason: row.reason || 'Removed to fit manual hotspot batch',
        })),
        shiftedItems: adaptive.shiftedHotspots || [],
        resolution: {
          removedHotspots: allRemovedHotspots,
          removedCount: allRemovedHotspots.length,
          stillUnschedulable: adaptive.unscheduledManualHotspots.length > 0,
        },
        requestedAnchor:
          resolvedAnchorType === 'after_travel' && Number.isInteger(Number(resolvedAnchorIndex))
            ? {
                anchorType: 'after_travel' as const,
                anchorIndex: Number(resolvedAnchorIndex),
              }
            : undefined,
      },
    );

    console.log('[ManualTimelineBuild] api_test_start', {
      planId: Number(planId),
      routeId: Number(routeId),
      selectedHotspotId: Number(focusHotspotId || 0),
      anchorType: resolvedAnchorType || null,
      anchorIndex: Number.isInteger(Number(resolvedAnchorIndex)) ? Number(resolvedAnchorIndex) : null,
    });

    const previewTimeline = Array.isArray(enginePreview?.fullTimeline) ? enginePreview.fullTimeline : [];
    const validation = this.callbacks.buildManualHotspotValidation({
      route,
      requestedHotspotIds,
      fullTimeline: previewTimeline,
      manualTimingPolicy,
      adaptive,
    });

    // â”€â”€ Apply matrix-fit positioning to preview timeline â”€â”€
    // Keep the full baseline route and merge the matrix-selected hotspot into the best slot.
    // With timing recalculation and forward time-shifting.
    const routeEndMinutesPreview = manualTimingPolicy?.endTime
      ? Math.floor(this.callbacks.hmsToSeconds(TimeConverter.toTimeString(manualTimingPolicy.endTime)) / 60)
      : 23 * 60;
    const requestedExactSlot =
      options?.exactAnchorMode === true
        ? {
            fromHotspotId: Number(options?.afterHotspotId || options?.matrixPreferredSlot?.fromHotspotId || 0) || undefined,
            toHotspotId: Number(options?.beforeHotspotId || options?.matrixPreferredSlot?.toHotspotId || 0) || undefined,
            slotIndex: Number.isFinite(Number(options?.anchorIndex ?? options?.matrixPreferredSlot?.slotIndex))
              ? Number(options?.anchorIndex ?? options?.matrixPreferredSlot?.slotIndex)
              : undefined,
            source: 'EXACT_ANCHOR' as const,
          }
        : null;
    const exactAnchorCandidateSlots = [
      manualInsertionFit?.requestedSlot,
      manualInsertionFit?.chosenSlot,
      manualInsertionFit?.bestSlot,
      ...(Array.isArray(manualInsertionFit?.allSlotResults) ? manualInsertionFit.allSlotResults : []),
    ].filter(Boolean);
    const exactAnchorMatchedSlot = requestedExactSlot
      ? (
          exactAnchorCandidateSlots.find((slot: any) => (
            Number(slot?.fromHotspotId || 0) === Number(requestedExactSlot?.fromHotspotId || 0)
            && Number(slot?.toHotspotId || 0) === Number(requestedExactSlot?.toHotspotId || 0)
          ))
          || (
            Number(requestedExactSlot?.fromHotspotId || 0) <= 0
            && Number(requestedExactSlot?.toHotspotId || 0) > 0
              ? exactAnchorCandidateSlots.find((slot: any) => (
                  Number(slot?.toHotspotId || 0) === Number(requestedExactSlot?.toHotspotId || 0)
                  && Number(slot?.fromHotspotId || 0) <= 0
                ))
              : null
          )
          || (
            Number(requestedExactSlot?.toHotspotId || 0) <= 0
              ? exactAnchorCandidateSlots.find((slot: any) => (
                  Number(slot?.fromHotspotId || 0) === Number(requestedExactSlot?.fromHotspotId || 0)
                  && (
                    Number(slot?.toHotspotId || 0) === 0
                    || String(slot?.routeFitType || '').toUpperCase() === 'DESTINATION_SIDE_INSERTION'
                    || String(slot?.slotContext || '').toUpperCase() === 'LAST_SOURCE_HOTSPOT_TO_DESTINATION_HOTEL'
                    || String(slot?.source || '').toUpperCase() === 'FINAL_TRAVEL_TO_HOTEL_SPLIT'
                    || String(slot?.source || '').toUpperCase() === 'DESTINATION_CITY_AFTER_REACHED'
                  )
                ))
              : null
          )
          || exactAnchorCandidateSlots.find((slot: any) => (
            Number(slot?.fromHotspotId || 0) === Number(requestedExactSlot?.fromHotspotId || 0)
          ))
        )
      : null;
    const computedExactRequestedSlot =
      exactAnchorMatchedSlot || manualInsertionFit?.requestedSlot || manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || null;
    const exactAnchorSlotMatchesComputedSlot = Boolean(
      requestedExactSlot
      && computedExactRequestedSlot
      && Number(computedExactRequestedSlot?.fromHotspotId || 0) === Number(requestedExactSlot?.fromHotspotId || 0)
      && (
        Number(requestedExactSlot?.toHotspotId || 0) > 0
          ? Number(computedExactRequestedSlot?.toHotspotId || 0) === Number(requestedExactSlot?.toHotspotId || 0)
          : true
      )
    );
    const exactAnchorPreviewSlot =
      requestedExactSlot
      && options?.exactAnchorMode === true
      && (exactAnchorMatchedSlot || manualInsertionFit?.requestedSlot)
        ? {
            ...(exactAnchorMatchedSlot || manualInsertionFit?.requestedSlot || {}),
            ...requestedExactSlot,
          }
        : null;
    const timelineInsertionFit =
      exactAnchorPreviewSlot
        ? {
            ...(manualInsertionFit || {}),
            chosenSlot: {
              ...(manualInsertionFit?.requestedSlot || manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || {}),
              ...exactAnchorPreviewSlot,
              selectedAsBest: false,
              source: 'EXACT_ANCHOR',
              chosenSlotSource: 'EXACT_ANCHOR',
            },
            bestSlot: {
              ...(manualInsertionFit?.requestedSlot || manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || {}),
              ...exactAnchorPreviewSlot,
              selectedAsBest: false,
              source: 'EXACT_ANCHOR',
              chosenSlotSource: 'EXACT_ANCHOR',
            },
            chosenSlotSource: 'EXACT_ANCHOR',
          }
        : requestedExactSlot && exactAnchorSlotMatchesComputedSlot
        ? {
            ...(manualInsertionFit || {}),
            chosenSlot: {
              ...(manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || {}),
              ...requestedExactSlot,
              selectedAsBest: false,
              source: 'EXACT_ANCHOR',
              chosenSlotSource: 'EXACT_ANCHOR',
            },
            bestSlot: {
              ...(manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || {}),
              ...requestedExactSlot,
              selectedAsBest: false,
              source: 'EXACT_ANCHOR',
              chosenSlotSource: 'EXACT_ANCHOR',
            },
            chosenSlotSource: 'EXACT_ANCHOR',
          }
        : manualInsertionFit;
    let adjustedPreviewTimeline = await this.callbacks.buildMatrixRescheduledPreviewTimeline({
      routeId: Number(route?.itinerary_route_ID || routeId || 0),
      baselineTimeline: baselineTimelineForMatrix,
      enginePreviewTimeline: previewTimeline,
      manualInsertionFit: timelineInsertionFit,
      selectedHotspotId: focusHotspotId,
      hotspotMasters,
      tx,
      routeEndMinutes: routeEndMinutesPreview,
    });

    const removedPreviewHotspots = [
      ...(adaptive.removedOptionalHotspots || []),
      ...(adaptive.removedTopPriorityHotspots || []),
      ...(adaptive.p3HotspotsToRemove || []),
    ];

    adjustedPreviewTimeline = this.callbacks.removeManualFitDroppedRowsFromTimeline(
      adjustedPreviewTimeline,
      removedPreviewHotspots,
    );

    // Final deterministic overlay: ensure selected row is between matrix slot boundaries and stale times are not shown.
    adjustedPreviewTimeline = this.callbacks.applyManualInsertionFitToPreviewTimeline(
      adjustedPreviewTimeline,
      timelineInsertionFit,
      Number(focusHotspotId),
    );

    if (
      options?.exactAnchorMode === true
      && manualInsertionFit?.destinationInsertionMode === true
      && Number(options?.afterHotspotId || 0) > 0
      && Number(options?.beforeHotspotId || 0) <= 0
    ) {
      let destinationExactAnchorRebuilt = await this.callbacks.buildMatrixRescheduledPreviewTimeline({
        routeId: Number(route?.itinerary_route_ID || routeId || 0),
        baselineTimeline: baselineTimelineForMatrix,
        enginePreviewTimeline: previewTimeline,
        manualInsertionFit: timelineInsertionFit,
        selectedHotspotId: focusHotspotId,
        hotspotMasters,
        tx,
        routeEndMinutes: routeEndMinutesPreview,
      });

      destinationExactAnchorRebuilt = this.callbacks.removeManualFitDroppedRowsFromTimeline(
        destinationExactAnchorRebuilt,
        removedPreviewHotspots,
      );

      const rebuiltPreservesAnchor = this.callbacks.manualFitTimelinePreservesSelectedAnchor({
        timeline: destinationExactAnchorRebuilt,
        selectedHotspotId: focusHotspotId,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
        anchorIntent: options?.anchorIntent,
      });

      if (
        rebuiltPreservesAnchor
        && destinationExactAnchorRebuilt.length > adjustedPreviewTimeline.length
      ) {
        adjustedPreviewTimeline = destinationExactAnchorRebuilt;
      }
    }

    const destinationPreviewSlot = timelineInsertionFit?.chosenSlot || timelineInsertionFit?.bestSlot || manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || null;
    const destinationPreviewSlotContext = String(destinationPreviewSlot?.slotContext || '').toUpperCase();
    const destinationPreviewSlotSource = String(destinationPreviewSlot?.source || '').toUpperCase();
    const destinationPreviewRouteFitType = String(destinationPreviewSlot?.routeFitType || '').toUpperCase();
    const isDestinationSidePreviewSlot =
      timelineInsertionFit?.destinationInsertionMode === true
      || manualInsertionFit?.destinationInsertionMode === true
      || destinationPreviewRouteFitType === 'DESTINATION_SIDE_INSERTION'
      || destinationPreviewSlotContext === 'LAST_SOURCE_HOTSPOT_TO_DESTINATION_HOTEL'
      || destinationPreviewSlotSource === 'FINAL_TRAVEL_TO_HOTEL_SPLIT'
      || destinationPreviewSlotSource === 'DESTINATION_CITY_AFTER_REACHED'
      || (
        Number(destinationPreviewSlot?.fromHotspotId || 0) > 0
        && Number(destinationPreviewSlot?.toHotspotId || 0) <= 0
      );
    const removedPreviewHotspotIds = removedPreviewHotspots
      .map((row: any) => Number(this.callbacks.getManualFitRemovalHotspotId(row) || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    const destinationPivotRebuildRemovedHotspotIds = isDestinationSidePreviewSlot
      ? []
      : removedPreviewHotspotIds;
    const destinationPreviewDroppedBaselineRows =
      isDestinationSidePreviewSlot
      && this.callbacks.destinationSidePreviewDroppedBaselineRows({
        baselineTimeline: baselineTimelineForMatrix,
        previewTimeline: adjustedPreviewTimeline,
        selectedHotspotId: Number(focusHotspotId),
        removedHotspotIds: removedPreviewHotspotIds,
      });

    if (destinationPreviewDroppedBaselineRows) {
      let destinationBaselineRebuilt = await this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, baselineTimelineForMatrix, {
        removedHotspotIds: destinationPivotRebuildRemovedHotspotIds,
        targetHotspotId: Number(focusHotspotId),
        routeId: Number(routeId),
        planId: Number(planId),
        anchorIntent: options?.anchorIntent,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
      });

      if (this.callbacks.isManualPreviewTimelineWrapped(destinationBaselineRebuilt)) {
        console.warn('[FitHere][destination_side_rebuild_rejected_wrapped_timeline]', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          rebuiltLength: Array.isArray(destinationBaselineRebuilt) ? destinationBaselineRebuilt.length : 0,
        });
        destinationBaselineRebuilt = [];
      }

      if (destinationBaselineRebuilt.length === 0) {
        destinationBaselineRebuilt = this.callbacks.rebuildDestinationSidePreviewFromBaseline({
          baselineTimeline: baselineTimelineForMatrix,
          manualInsertionFit: timelineInsertionFit,
          selectedHotspotId: Number(focusHotspotId),
          hotspotMasters,
        });
      }

      const destinationRebuildPreservesRequestedAnchor =
        options?.exactAnchorMode !== true ||
        this.callbacks.manualFitTimelinePreservesSelectedAnchor({
          timeline: destinationBaselineRebuilt,
          selectedHotspotId: focusHotspotId,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          anchorIntent: options?.anchorIntent,
        }) === true;

      const destinationRebuildAttractionIds = destinationBaselineRebuilt
        .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
        .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);
      const destinationRebuildSelectedIndex = destinationRebuildAttractionIds.indexOf(Number(focusHotspotId));
      const destinationRebuildBeforeIndex = Number(options?.beforeHotspotId || 0) > 0
        ? destinationRebuildAttractionIds.indexOf(Number(options?.beforeHotspotId || 0))
        : -1;
      const destinationRebuildKeepsSelectedBeforeBeforeRow =
        options?.exactAnchorMode === true &&
        destinationRebuildSelectedIndex >= 0 &&
        (destinationRebuildBeforeIndex < 0 || destinationRebuildSelectedIndex < destinationRebuildBeforeIndex);

      if (
        destinationBaselineRebuilt.length > adjustedPreviewTimeline.length &&
        (destinationRebuildPreservesRequestedAnchor || destinationRebuildKeepsSelectedBeforeBeforeRow)
      ) {
        console.warn('[FitHere][destination_side_preview_baseline_rebuild]', {
          routeId,
          selectedHotspotId: Number(focusHotspotId),
          beforeLength: adjustedPreviewTimeline.length,
          afterLength: destinationBaselineRebuilt.length,
        });
        adjustedPreviewTimeline = destinationBaselineRebuilt;
      } else {
        console.warn('[FitHere][destination_side_preview_baseline_rebuild_skipped]', {
          routeId,
          selectedHotspotId: Number(focusHotspotId),
          currentLength: adjustedPreviewTimeline.length,
          rebuiltLength: destinationBaselineRebuilt.length,
          isDestinationSidePreviewSlot,
          reason: destinationRebuildPreservesRequestedAnchor || destinationRebuildKeepsSelectedBeforeBeforeRow
            ? 'Rebuild was not better than current preview.'
            : 'Rebuild would place selected hotspot after clicked before-row/downstream blockers.',
        });
      }
    }

    if (
      options?.exactAnchorMode === true &&
      options?.trustedPreviewConfirmation !== true &&
      this.callbacks.manualFitTimelinePreservesSelectedAnchor({
        timeline: adjustedPreviewTimeline,
        selectedHotspotId: focusHotspotId,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
        anchorIntent: options?.anchorIntent,
        allowBoundaryRescuePlacement: true,
      }) !== true
    ) {
      console.warn('[FitHere][exact_anchor_drift]', {
        routeId,
        selectedHotspotId: focusHotspotId,
        anchorIntent: options?.anchorIntent,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
      });

      const focusMaster = (hotspotMasters || []).find(
        (row: any) => Number(row?.hotspot_ID || 0) === Number(focusHotspotId),
      );
      const selectedManualPriority = this.callbacks.resolveSelectedManualPriority({
        selectedHotspotId: Number(focusHotspotId),
        manualInsertionFit,
        options,
        focusMaster,
      });
      const dayEndMinutes = Math.floor(
        this.callbacks.hmsToSeconds(
          TimeConverter.toTimeString(
            manualTimingPolicy.endTime || route?.route_end_time || '23:00:00',
          ),
        ) / 60,
      );
      const exactAnchorOverflowMinutes = Math.max(
        1,
        Number(
          this.callbacks.calculateRouteEndOverflowMinutes(
            adjustedPreviewTimeline,
            route,
            manualTimingPolicy.endTime,
          )
          || manualInsertionFit?.dayOverflowMinutes
          || validation?.routeEndOverflowMinutes
          || 0,
        ),
      );
      const exactAnchorRescueSourceTimeline =
        Array.isArray(baselineTimelineForMatrix) && baselineTimelineForMatrix.length > 0
          ? baselineTimelineForMatrix
          : adjustedPreviewTimeline;
      const exactAnchorRemovalPlan = await this.callbacks.resolveProgressivePriorityRemovalForManualFitInTx(tx, {
        planId: Number(planId),
        routeId: Number(routeId),
        selectedHotspotId: Number(focusHotspotId),
        selectedManualPriority,
        currentTimeline: exactAnchorRescueSourceTimeline,
        dayEndMinutes,
        overflowMinutes: exactAnchorOverflowMinutes,
        validationMode: 'SELECTED_HOTSPOT_CLOSING',
        exactAnchorMode: options?.exactAnchorMode === true,
        anchorIntent: options?.anchorIntent,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
        allowP3Removal: true,
        allowP2Removal: options?.allowP1P2Removal === true || options?.allowTopPriorityRemoval === true,
        allowP1Removal: options?.allowP1P2Removal === true || options?.allowTopPriorityRemoval === true,
      });
      const sameRouteExactAnchorRemovals = await this.callbacks.filterPlannedRemovalsToSameRouteInTx(
        tx,
        Number(planId),
        Number(routeId),
        exactAnchorRemovalPlan.removedHotspots || [],
      );
      const resolvedExactAnchorRemovals =
        sameRouteExactAnchorRemovals.length > 0
          ? sameRouteExactAnchorRemovals
          : ((exactAnchorRemovalPlan.removedHotspots || []).filter((row: any) => this.callbacks.getManualFitRemovalHotspotId(row) > 0));
      const sameRouteExactAnchorCandidates = await this.callbacks.filterPlannedRemovalsToSameRouteInTx(
        tx,
        Number(planId),
        Number(routeId),
        exactAnchorRemovalPlan.candidateHotspots || [],
      );
      const exhaustiveExactAnchorCandidateRemovals = (() => {
        const fallbackCandidates = (exactAnchorRemovalPlan.candidateHotspots || []).filter((row: any) => (
          this.callbacks.getManualFitRemovalHotspotId(row) > 0
        ));
        const merged = sameRouteExactAnchorCandidates.length > 0
          ? sameRouteExactAnchorCandidates
          : fallbackCandidates;
        const byHotspotId = new Map<number, any>();

        for (const row of merged) {
          const hotspotId = this.callbacks.getManualFitRemovalHotspotId(row);
          if (!(hotspotId > 0) || byHotspotId.has(hotspotId)) continue;
          byHotspotId.set(hotspotId, row);
        }

        return Array.from(byHotspotId.values());
      })();

      manualInsertionFit.lowPriorityRemovalPlanPreview = {
        resolved: exactAnchorRemovalPlan.resolved,
        algorithm: exactAnchorRemovalPlan.algorithm,
        originalOverflowMinutes: exactAnchorOverflowMinutes,
        overflowMinutes: exactAnchorOverflowMinutes,
        finalOverflowMinutes: Number(exactAnchorRemovalPlan.finalOverflowMinutes || exactAnchorOverflowMinutes),
        plannedRemovals: exactAnchorRemovalPlan.resolved ? resolvedExactAnchorRemovals : [],
        candidates: exactAnchorRemovalPlan.candidateHotspots,
        candidateAudit: exactAnchorRemovalPlan.candidateAudit,
        simulationAttempts: exactAnchorRemovalPlan.simulationAttempts,
        rejectedAttempts: exactAnchorRemovalPlan.rejectedAttempts,
        message: exactAnchorRemovalPlan.message,
      };

      if (
        exactAnchorRemovalPlan.resolved === true &&
        this.callbacks.manualFitTimelinePreservesSelectedAnchor({
          timeline: exactAnchorRemovalPlan.finalTimeline,
          selectedHotspotId: focusHotspotId,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          anchorIntent: options?.anchorIntent,
          allowBoundaryRescuePlacement: true,
        })
      ) {
        adjustedPreviewTimeline = exactAnchorRemovalPlan.finalTimeline;
        manualInsertionFit.removedLowPriorityHotspots = resolvedExactAnchorRemovals;
        manualInsertionFit.rescheduleApplied = true;
        manualInsertionFit.dayOverflowMinutes = 0;
        console.warn('[FitHere][exact_anchor_boundary_rescue_applied]', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          removedHotspotIds: resolvedExactAnchorRemovals
            .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
            .filter((id: number) => id > 0),
          afterHotspotId: Number(options?.afterHotspotId || 0) || null,
          beforeHotspotId: Number(options?.beforeHotspotId || 0) || null,
        });
      } else {
      const exhaustiveExactAnchorRemovalIds = exhaustiveExactAnchorCandidateRemovals
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);
      const exhaustiveExactAnchorTimeline = exhaustiveExactAnchorRemovalIds.length > 0
        ? await this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, exactAnchorRescueSourceTimeline, {
            removedHotspotIds: exhaustiveExactAnchorRemovalIds,
            targetHotspotId: Number(focusHotspotId),
            routeId: Number(routeId),
            planId: Number(planId),
            anchorIntent: options?.anchorIntent,
            afterHotspotId: options?.afterHotspotId,
            beforeHotspotId: options?.beforeHotspotId,
            allowSelectedClosingAnchorBypass: true,
          })
        : [];
      const selectedHotspotRescuedByExhaustiveRemoval = exhaustiveExactAnchorTimeline.some((row: any) => (
        Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0) === Number(focusHotspotId)
        && (String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
      ));
      const exhaustiveRemovalStillPreservesClickedAnchor =
        selectedHotspotRescuedByExhaustiveRemoval &&
        this.callbacks.manualFitTimelinePreservesSelectedAnchor({
          timeline: exhaustiveExactAnchorTimeline,
          selectedHotspotId: focusHotspotId,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          anchorIntent: options?.anchorIntent,
          allowBoundaryRescuePlacement: true,
        });

      if (selectedHotspotRescuedByExhaustiveRemoval) {
        const exhaustiveExactAnchorRemovalRows = exhaustiveExactAnchorCandidateRemovals.map((row: any) => {
          const hotspotId = this.callbacks.getManualFitRemovalHotspotId(row);
          const priority = Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 4) || 4;
          const removedName = String(row?.name || row?.hotspot_name || row?.text || `Hotspot #${hotspotId}`).trim();
          const reason = exhaustiveRemovalStillPreservesClickedAnchor
            ? `Removed because this optional/lower-priority hotspot conflicts with the selected manual hotspot insertion at the chosen position.`
            : `Removed because keeping it would stop the selected manual hotspot from being rescued near the clicked Fit Here position.`;

          return {
            ...row,
            id: hotspotId,
            hotspotId,
            name: removedName,
            priority,
            reason,
            fitFailureExplanation: reason,
            removalReasonCode: 'EXACT_ANCHOR_RESCUE_REMOVAL',
            requiresAcknowledgement: true,
          };
        });

        adjustedPreviewTimeline = exhaustiveExactAnchorTimeline;
        manualInsertionFit.removedLowPriorityHotspots = exhaustiveExactAnchorRemovalRows;
        manualInsertionFit.rescheduleApplied = true;
        manualInsertionFit.dayOverflowMinutes = 0;
        manualInsertionFit.selectedHotspotPreserved = true;
        manualInsertionFit.exactAnchorDrift = exhaustiveRemovalStillPreservesClickedAnchor !== true;
        manualInsertionFit.lowPriorityRemovalPlanPreview = {
          ...manualInsertionFit.lowPriorityRemovalPlanPreview,
          resolved: true,
          plannedRemovals: exhaustiveExactAnchorRemovalRows,
          finalOverflowMinutes: 0,
          message: exhaustiveRemovalStillPreservesClickedAnchor
            ? 'Selected manual hotspot was rescued by exhausting same-route non-manual hotspot removals.'
            : 'Selected manual hotspot was rescued only after exhausting same-route non-manual hotspot removals, so the clicked anchor moved.',
        };
        console.warn('[FitHere][exact_anchor_exhaustive_same_route_rescue_applied]', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          removedHotspotIds: exhaustiveExactAnchorRemovalIds,
          anchorPreserved: exhaustiveRemovalStillPreservesClickedAnchor === true,
        });
      } else {
      const exactAnchorExhaustedMessage =
        Array.isArray(exactAnchorRemovalPlan.candidateHotspots) && exactAnchorRemovalPlan.candidateHotspots.length > 0
          ? 'Could not preserve the selected Fit Here position after trying same-route non-manual hotspot removals.'
          : (
              exactAnchorRemovalPlan.message
              || 'Selected Fit Here anchor could not be preserved. Please try another position.'
            );
      manualInsertionFit.lowPriorityRemovalPlanPreview = {
        ...manualInsertionFit.lowPriorityRemovalPlanPreview,
        resolved: false,
        plannedRemovals: [],
        finalOverflowMinutes: Number(exactAnchorRemovalPlan.finalOverflowMinutes || exactAnchorOverflowMinutes),
        message: exactAnchorExhaustedMessage,
      };
      const attemptedRemovals = [
        ...(Array.isArray(adaptive?.removedOptionalHotspots) ? adaptive.removedOptionalHotspots : []),
        ...(Array.isArray(adaptive?.removedTopPriorityHotspots) ? adaptive.removedTopPriorityHotspots : []),
        ...(Array.isArray(adaptive?.p3HotspotsToRemove) ? adaptive.p3HotspotsToRemove : []),
        ...resolvedExactAnchorRemovals,
      ];
      const selectedHotspotStillPresent = adjustedPreviewTimeline.some((row: any) => (
        Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0) === Number(focusHotspotId)
        && (String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
      ));

      if (!selectedHotspotStillPresent) {
        console.warn('[ManualTimelineBuild] exact_anchor_drift_selected_hotspot_missing', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          exactAnchorExhaustedMessage,
        });
      }

      adjustedPreviewTimeline = exactAnchorRemovalPlan.finalTimeline.length > 0
        ? exactAnchorRemovalPlan.finalTimeline
        : adjustedPreviewTimeline;

      manualInsertionFit.rescheduleApplied = true;
      manualInsertionFit.dayOverflowMinutes = 0;
      manualInsertionFit.selectedHotspotPreserved = selectedHotspotStillPresent;
      manualInsertionFit.exactAnchorDrift = true;
      }
      }
    }

    if (manualInsertionFit?.destinationInsertionMode === true) {
      console.log('[ManualDestinationInsert] timeline_built',
        (Array.isArray(adjustedPreviewTimeline) ? adjustedPreviewTimeline : []).map((row: any, index: number) => ({
          index,
          type: String(row?.type || row?.item_type || ''),
          text: String(row?.text || row?.name || ''),
          hotspotId: Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) || null,
          timeRange: String(row?.timeRange || ''),
        })),
      );
    }

    // â”€â”€ Fix confirmation logic: don't mark requiresConfirmation for feasible matrix slots â”€â”€
    // If the matrix bestSlot is feasible (ON_ROUTE/MINOR_DETOUR) and no hotspots are actually removed,
    // there is no reason to ask for confirmation. The anchor boundary hotspots are not "removed".
    const matrixFeasible =
      timelineInsertionFit?.bestSlot?.routeFitType === 'ON_ROUTE' ||
      timelineInsertionFit?.bestSlot?.routeFitType === 'MINOR_DETOUR';

    const adjustedTimelineAttractionIds = new Set<number>(
      (Array.isArray(adjustedPreviewTimeline) ? adjustedPreviewTimeline : [])
        .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    const removedTopPriorityCandidates = Array.isArray(adaptive.removedTopPriorityHotspots)
      ? adaptive.removedTopPriorityHotspots
      : [];

    // Treat as truly removed only when the hotspot no longer exists in adjusted preview timeline.
    const actuallyRemovedTopPriorityRows = removedTopPriorityCandidates.filter((row: any) => {
      const id = Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0);
      return id > 0 && !adjustedTimelineAttractionIds.has(id);
    });
    const actuallyRemovedTopPriority = actuallyRemovedTopPriorityRows.length > 0;

    let finalRequiresConfirmation = adaptive.requiresConfirmation;
    let finalTopPriorityAffected = adaptive.topPriorityAffected || [];
    let finalRemovedTopPriority = actuallyRemovedTopPriorityRows;

    if (matrixFeasible && !actuallyRemovedTopPriority) {
      // Matrix found a good fit and no hotspots are actually removed, so no confirmation needed
      finalRequiresConfirmation = false;
      finalTopPriorityAffected = [];
      finalRemovedTopPriority = [];
    }

    if (Array.isArray(manualInsertionFit?.allSlotResults)) {
      const prioritySafe = finalRemovedTopPriority.length === 0;
      const bestSlotIndex = Number.isFinite(Number(manualInsertionFit?.bestSlot?.slotIndex))
        ? Number(manualInsertionFit.bestSlot.slotIndex)
        : null;
      manualInsertionFit.allSlotResults = manualInsertionFit.allSlotResults.map((row: any) => {
        const computedFinalDecisionReason = (bestSlotIndex !== null && Number(row?.slotIndex) === bestSlotIndex)
          ? (prioritySafe
              ? 'Selected: best lower-detour feasible slot.'
              : 'Selected: best lower-detour feasible slot, but priority hotspots would need to be replaced.')
          : (prioritySafe
              ? row?.finalDecisionReason
              : 'Not selected: would require replacing priority hotspots.');

        const displayMeta = this.callbacks.buildRouteFitDisplayMeta({
          routeFitType: String(row?.routeFitType || ''),
          roadDetourKm: row?.roadDetourKm,
          insertedRouteDistanceKm: row?.insertedRouteDistanceKm,
          abOsrmDistanceKm: row?.abOsrmDistanceKm,
          finalDecisionReason: computedFinalDecisionReason,
        });

        return {
          ...row,
          selectedAsBest: bestSlotIndex !== null ? Number(row?.slotIndex) === bestSlotIndex : row?.selectedAsBest === true,
          prioritySafe,
          priorityDecisionReason: prioritySafe
            ? null
            : 'Not selected: would require replacing priority hotspots.',
          displayLabel: displayMeta.displayLabel,
          shortLabel: displayMeta.shortLabel,
          isZeroExtraDetour: displayMeta.isZeroExtraDetour,
          distanceComparisonNote: displayMeta.distanceComparisonNote,
          finalDecisionReason: displayMeta.finalDecisionReason,
        };
      });
      if (manualInsertionFit.bestSlot) {
        const bestMeta = this.callbacks.buildRouteFitDisplayMeta({
          routeFitType: String(manualInsertionFit.bestSlot?.routeFitType || ''),
          roadDetourKm: manualInsertionFit.bestSlot?.roadDetourKm,
          insertedRouteDistanceKm: manualInsertionFit.bestSlot?.insertedRouteDistanceKm,
          abOsrmDistanceKm: manualInsertionFit.bestSlot?.abOsrmDistanceKm,
          finalDecisionReason: prioritySafe
            ? 'Selected: best lower-detour feasible slot.'
            : 'Selected: best lower-detour feasible slot, but priority hotspots would need to be replaced.',
        });
        manualInsertionFit.bestSlot = {
          ...manualInsertionFit.bestSlot,
          displayLabel: bestMeta.displayLabel,
          shortLabel: bestMeta.shortLabel,
          isZeroExtraDetour: bestMeta.isZeroExtraDetour,
          distanceComparisonNote: bestMeta.distanceComparisonNote,
          prioritySafe,
          priorityDecisionReason: prioritySafe ? null : 'Not selected: would require replacing priority hotspots.',
          finalDecisionReason: bestMeta.finalDecisionReason,
        };
      }
      if (manualInsertionFit.requestedSlot) {
        manualInsertionFit.requestedSlot = {
          ...manualInsertionFit.requestedSlot,
          prioritySafe,
          priorityDecisionReason: prioritySafe ? null : 'Not selected: would require replacing priority hotspots.',
        };
      }
      if (manualInsertionFit.chosenSlot) {
        manualInsertionFit.chosenSlot = {
          ...manualInsertionFit.chosenSlot,
          prioritySafe,
          priorityDecisionReason: prioritySafe ? null : 'Not selected: would require replacing priority hotspots.',
        };
      }
    }

    // Priority confirmation should only remain when there are actual removed top-priority rows.
    if (!Array.isArray(finalRemovedTopPriority) || finalRemovedTopPriority.length === 0) {
      finalRequiresConfirmation = false;
      finalTopPriorityAffected = [];
      finalRemovedTopPriority = [];
    }

    let finalValidationBase = this.callbacks.buildManualHotspotValidation({
      route,
      requestedHotspotIds,
      fullTimeline: adjustedPreviewTimeline,
      manualTimingPolicy,
      adaptive,
    });

    let finalValidation = {
      ...finalValidationBase,
      requiresPriorityConfirmation: finalRequiresConfirmation,
      readyToApply: finalValidationBase.passesScheduleRules && !finalRequiresConfirmation,
    };

    const matrixRescheduleSafeToApply =
      matrixFeasible
      && manualInsertionFit?.rescheduleApplied === true
      && Number(manualInsertionFit?.dayOverflowMinutes || 0) <= 0
      && Number(validation?.routeEndOverflowMinutes || 0) <= 0
      && finalRemovedTopPriority.length === 0
      && finalTopPriorityAffected.length === 0;

    if (matrixRescheduleSafeToApply) {
      finalRequiresConfirmation = false;
      finalValidation = {
        ...finalValidation,
        passesScheduleRules: true,
        readyToApply: true,
        requiresPriorityConfirmation: false,
        stillUnschedulable: false,
        reason: 'Manual hotspot is route-feasible and timetable was rescheduled.',
      };
    }

    const previewOverflowMinutes = Math.max(
      0,
      Number(finalValidation?.routeEndOverflowMinutes || manualInsertionFit?.dayOverflowMinutes || 0),
    );

    const chosenRouteFitType = String(manualInsertionFit?.chosenSlot?.routeFitType || '').toUpperCase();
    const shouldRunLowPriorityOverflowResolver =
      matrixFeasible === true
      && manualInsertionFit?.requiresMatrixBuild !== true
      && !!manualInsertionFit?.chosenSlot
      && (chosenRouteFitType === 'ON_ROUTE' || chosenRouteFitType === 'MINOR_DETOUR')
      && previewOverflowMinutes > 0;

    if (shouldRunLowPriorityOverflowResolver) {
      const focusMaster = (hotspotMasters || []).find((row: any) => Number(row?.hotspot_ID || 0) === Number(focusHotspotId));
      const selectedManualPriority = this.callbacks.resolveSelectedManualPriority({
        selectedHotspotId: Number(focusHotspotId),
        manualInsertionFit,
        options,
        focusMaster,
      });
      manualInsertionFit.selectedManualPriority = selectedManualPriority;
      manualInsertionFit.selectedPriorityLabel = `Manual / P${selectedManualPriority}`;
      const dayEndMinutes = Math.floor(
        this.callbacks.hmsToSeconds(TimeConverter.toTimeString(manualTimingPolicy.endTime || route?.route_end_time || '23:00:00')) / 60,
      );

      const lowPriorityRemovalPlanPreview = await this.callbacks.resolveProgressivePriorityRemovalForManualFitInTx(tx, {
        planId: Number(planId),
        routeId: Number(routeId),
        selectedHotspotId: Number(focusHotspotId),
        selectedManualPriority,
        currentTimeline: adjustedPreviewTimeline,
        dayEndMinutes,
        overflowMinutes: previewOverflowMinutes,
        validationMode: 'DAY_END',
        exactAnchorMode: options?.exactAnchorMode === true,
        anchorIntent: options?.anchorIntent,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
        allowP3Removal: true,
        allowP2Removal: options?.allowP1P2Removal === true || options?.allowTopPriorityRemoval === true,
        allowP1Removal: options?.allowP1P2Removal === true || options?.allowTopPriorityRemoval === true,
      });

      const sameRouteDayEndResolvedRemovals = await this.callbacks.filterPlannedRemovalsToSameRouteInTx(
        tx,
        Number(planId),
        Number(routeId),
        lowPriorityRemovalPlanPreview.removedHotspots || [],
      );
      const resolvedDayEndRemovals =
        sameRouteDayEndResolvedRemovals.length > 0
          ? sameRouteDayEndResolvedRemovals
          : ((lowPriorityRemovalPlanPreview.removedHotspots || []).filter((row: any) => this.callbacks.getManualFitRemovalHotspotId(row) > 0));
      if (sameRouteDayEndResolvedRemovals.length !== (lowPriorityRemovalPlanPreview.removedHotspots || []).length) {
        console.warn('[FitHere][cross_route_removal_candidate_blocked]', {
          planId: Number(planId),
          routeId: Number(routeId),
          originalRemovalIds: (lowPriorityRemovalPlanPreview.removedHotspots || []).map((row: any) => row?.id),
          sameRouteRemovalIds: sameRouteDayEndResolvedRemovals.map((row: any) => row?.id),
        });
      }

      manualInsertionFit.lowPriorityRemovalPlanPreview = {
        resolved: lowPriorityRemovalPlanPreview.resolved,
        algorithm: lowPriorityRemovalPlanPreview.algorithm,
        originalOverflowMinutes: previewOverflowMinutes,
        overflowMinutes: previewOverflowMinutes,
        finalOverflowMinutes: lowPriorityRemovalPlanPreview.finalOverflowMinutes,
        plannedRemovals: lowPriorityRemovalPlanPreview.resolved
          ? resolvedDayEndRemovals
          : [],
        candidates: lowPriorityRemovalPlanPreview.candidateHotspots,
        candidateAudit: lowPriorityRemovalPlanPreview.candidateAudit,
        simulationAttempts: lowPriorityRemovalPlanPreview.simulationAttempts,
        rejectedAttempts: lowPriorityRemovalPlanPreview.rejectedAttempts,
        message: lowPriorityRemovalPlanPreview.message,
      };

      if (lowPriorityRemovalPlanPreview.resolved) {
        const finalResolvedTimeline = this.callbacks.sanitizeResolvedLowPriorityTimeline(
          Array.isArray(lowPriorityRemovalPlanPreview.finalTimeline) ? lowPriorityRemovalPlanPreview.finalTimeline : adjustedPreviewTimeline,
          resolvedDayEndRemovals,
        );

        const invariantMessage = this.callbacks.validateResolvedLowPriorityTimeline(
          finalResolvedTimeline,
          resolvedDayEndRemovals,
          dayEndMinutes,
        );
        if (invariantMessage) {
          if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
            throw new ConflictException({
              success: false,
              inserted: false,
              code: 'LOW_PRIORITY_RESOLVED_TIMELINE_INVALID',
              message: invariantMessage,
            });
          }
          console.error(invariantMessage);
        }

        manualInsertionFit.exceedsDayEnd = false;
        manualInsertionFit.dayOverflowMinutes = 0;
        manualInsertionFit.overflowResolved = true;
        manualInsertionFit.removedLowPriorityHotspots = resolvedDayEndRemovals;
        manualInsertionFit.finalArrivalTime = lowPriorityRemovalPlanPreview.finalArrivalTime || manualInsertionFit.finalArrivalTime;
        manualInsertionFit.rescheduleApplied = true;
        manualInsertionFit.fullTimelineIsResolvedRemovalPlan = true;
        manualInsertionFit.timelineSource = 'LOW_PRIORITY_REMOVAL_FINAL_TIMELINE';
        manualInsertionFit.canApply = true;
        manualInsertionFit.lowPriorityRemovalPlanPreview = {
          ...manualInsertionFit.lowPriorityRemovalPlanPreview,
          resolved: true,
          originalOverflowMinutes: previewOverflowMinutes,
          finalOverflowMinutes: 0,
          plannedRemovals: resolvedDayEndRemovals,
          finalTimelineHotspotIds: finalResolvedTimeline
            .map((row: any) => Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0),
        };
        finalRequiresConfirmation = false;
        finalValidation = {
          ...finalValidation,
          passesScheduleRules: true,
          readyToApply: true,
          requiresPriorityConfirmation: false,
          stillUnschedulable: false,
          routeEndOverflowMinutes: 0,
          reason: 'Route overflow resolved by removing lower-priority hotspots from the same route.',
        };
        adjustedPreviewTimeline = finalResolvedTimeline;
      } else {
        manualInsertionFit.lowPriorityRemovalPlanPreview = {
          ...manualInsertionFit.lowPriorityRemovalPlanPreview,
          resolved: false,
          originalOverflowMinutes: previewOverflowMinutes,
          finalOverflowMinutes: Number(lowPriorityRemovalPlanPreview.finalOverflowMinutes || previewOverflowMinutes),
          plannedRemovals: [],
        };
        finalValidation = {
          ...finalValidation,
          passesScheduleRules: false,
          readyToApply: false,
          routeEndOverflowMinutes: Number(lowPriorityRemovalPlanPreview.finalOverflowMinutes || previewOverflowMinutes),
          reason: lowPriorityRemovalPlanPreview.message || 'Could not resolve route overflow with same-route lower-priority hotspots.',
        };
      }
    }

    adjustedPreviewTimeline = this.callbacks.removeManualFitDroppedRowsFromTimeline(
      adjustedPreviewTimeline,
      removedPreviewHotspots,
    );

    adjustedPreviewTimeline = await this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours(
      Number(planId),
      Number(routeId),
      adjustedPreviewTimeline,
    );

    if (isDestinationSidePreviewSlot) {
      let destinationBaselineRebuilt = await this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, baselineTimelineForMatrix, {
        removedHotspotIds: destinationPivotRebuildRemovedHotspotIds,
        targetHotspotId: Number(focusHotspotId),
        routeId: Number(routeId),
        planId: Number(planId),
        anchorIntent: options?.anchorIntent,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
      });

      if (this.callbacks.isManualPreviewTimelineWrapped(destinationBaselineRebuilt)) {
        console.warn('[FitHere][destination_side_rebuild_rejected_wrapped_timeline]', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          rebuiltLength: Array.isArray(destinationBaselineRebuilt) ? destinationBaselineRebuilt.length : 0,
        });
        destinationBaselineRebuilt = [];
      }

      if (destinationBaselineRebuilt.length === 0) {
        destinationBaselineRebuilt = this.callbacks.rebuildDestinationSidePreviewFromBaseline({
          baselineTimeline: baselineTimelineForMatrix,
          manualInsertionFit: timelineInsertionFit,
          selectedHotspotId: Number(focusHotspotId),
          hotspotMasters,
        });
      }

      if (destinationBaselineRebuilt.length > 0) {
        destinationBaselineRebuilt = await this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours(
          Number(planId),
          Number(routeId),
          destinationBaselineRebuilt,
        );

        const repairedSelectedOperatingValidation = this.callbacks.markSelectedManualOperatingHourConflicts(
          destinationBaselineRebuilt,
          requestedHotspotIds,
        );

        const repairedTimeline = Array.isArray(repairedSelectedOperatingValidation.timeline)
          ? repairedSelectedOperatingValidation.timeline
          : [];
        const timelineKeepsSelected = (timeline: any[]): boolean =>
          (Array.isArray(timeline) ? timeline : []).some((row: any) => {
            const isAttraction = String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
            const rowHotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0);
            return isAttraction && rowHotspotId === Number(focusHotspotId);
          });

        const currentKeepsSelected = timelineKeepsSelected(adjustedPreviewTimeline);
        const repairedKeepsSelected = timelineKeepsSelected(repairedTimeline);
        const rebuiltKeepsSelected = timelineKeepsSelected(destinationBaselineRebuilt);

        console.warn('[FitHere][destination_side_preview_pre_closing_repair]', {
          routeId,
          selectedHotspotId: Number(focusHotspotId),
          beforeLength: adjustedPreviewTimeline.length,
          afterLength: repairedTimeline.length,
          currentKeepsSelected,
          repairedKeepsSelected,
          rebuiltKeepsSelected,
        });

        if (repairedKeepsSelected) {
          adjustedPreviewTimeline = repairedTimeline;
        } else if (rebuiltKeepsSelected) {
          console.warn('[FitHere][destination_side_preview_repair_guard_kept_rebuild]', {
            routeId,
            selectedHotspotId: Number(focusHotspotId),
            droppedRepairLength: repairedTimeline.length,
            keptRebuildLength: destinationBaselineRebuilt.length,
          });
          adjustedPreviewTimeline = destinationBaselineRebuilt;
        } else if (currentKeepsSelected) {
          console.warn('[FitHere][destination_side_preview_repair_guard_kept_current]', {
            routeId,
            selectedHotspotId: Number(focusHotspotId),
            droppedRepairLength: repairedTimeline.length,
            keptCurrentLength: adjustedPreviewTimeline.length,
          });
        } else {
          adjustedPreviewTimeline = repairedTimeline;
        }
      }
    }

    const pivotBacktrackingPrune = await this.callbacks.pruneManualFitBacktrackingAfterSelectedPivotInTx(tx, {
      routeId: Number(routeId),
      timeline: adjustedPreviewTimeline,
      selectedHotspotId: Number(focusHotspotId),
    });

    if (pivotBacktrackingPrune.removedHotspots.length > 0) {
      adjustedPreviewTimeline = pivotBacktrackingPrune.timeline;
      const existingRemovedIds = new Set(
        authoritativeRemovedHotspots
          .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      );
      const newBacktrackingRemovals = pivotBacktrackingPrune.removedHotspots.filter((row: any) => {
        const id = Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0);
        return id > 0 && !existingRemovedIds.has(id);
      });

      if (newBacktrackingRemovals.length > 0) {
        authoritativeRemovedHotspots.push(...newBacktrackingRemovals);
        manualInsertionFit.pivotBacktrackingRemovedHotspots = [
          ...(manualInsertionFit.pivotBacktrackingRemovedHotspots || []),
          ...newBacktrackingRemovals,
        ];

        const pivotRemovedHotspotIds = newBacktrackingRemovals
          .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0);

        const pivotRebuiltTimeline = await this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, baselineTimelineForMatrix, {
          removedHotspotIds: pivotRemovedHotspotIds,
          targetHotspotId: Number(focusHotspotId),
          routeId: Number(routeId),
          planId: Number(planId),
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
        });

        if (pivotRebuiltTimeline.length > 0) {
          adjustedPreviewTimeline = pivotRebuiltTimeline;
        }
      }
    }

    const selectedClosingOverflow = this.callbacks.getSelectedManualClosingOverflow({
      timeline: adjustedPreviewTimeline,
      selectedHotspotIds: requestedHotspotIds,
    });

    const selectedClosingFallbackValidation = this.callbacks.markSelectedManualOperatingHourConflicts(
      adjustedPreviewTimeline,
      requestedHotspotIds,
    );
    adjustedPreviewTimeline = selectedClosingFallbackValidation.timeline;

    const fallbackSelectedOpeningConflict =
      selectedClosingFallbackValidation.selectedOpeningConflict || null;
    const fallbackAttemptedEndMinutes = this.callbacks.parsePreviewTimeToMinutes(
      fallbackSelectedOpeningConflict?.attemptedEndTime
      || this.callbacks.parseTimeRangeParts(fallbackSelectedOpeningConflict?.attemptedVisitTime).end,
    );
    const fallbackClosingMinutes = this.callbacks.parsePreviewTimeToMinutes(
      fallbackSelectedOpeningConflict?.closingTime
      || this.callbacks.extractClosingTimeFromOperatingHours(fallbackSelectedOpeningConflict?.operatingHours),
    );
    const fallbackOverflowMinutes =
      fallbackAttemptedEndMinutes !== null && fallbackClosingMinutes !== null
        ? Math.max(0, fallbackAttemptedEndMinutes - fallbackClosingMinutes)
        : 0;
    const selectedClosingOverflowMinutesForResolver =
      selectedClosingOverflow.hasClosingOverflow === true
        ? Number(selectedClosingOverflow.overflowMinutes || 0)
        : fallbackOverflowMinutes;
    const selectedLatestAllowedEndMinutesForResolver =
      selectedClosingOverflow.hasClosingOverflow === true
        ? Number(selectedClosingOverflow.latestAllowedEndMinutes || 0)
        : Number(fallbackClosingMinutes || 0);
    const selectedClosingConflictForResolver =
      selectedClosingOverflow.hasClosingOverflow === true
        ? selectedClosingOverflow.conflict
        : fallbackSelectedOpeningConflict;
    const selectedClosingResolverSlot =
      manualInsertionFit?.chosenSlot ||
      manualInsertionFit?.bestSlot ||
      manualInsertionFit?.requestedSlot ||
      timelineInsertionFit?.chosenSlot ||
      timelineInsertionFit?.bestSlot ||
      timelineInsertionFit?.requestedSlot ||
      null;
    const directClickedAnchorRescueHotspotId =
      options?.exactAnchorMode === true &&
      String(options?.anchorIntent || '').toUpperCase() === 'AFTER_ATTRACTION'
        ? Number(options?.afterHotspotId || 0)
        : 0;
    const selectedClosingHotspotMasterById = new Map<number, any>(
      (hotspotMasters || [])
        .map((row: any) => [Number(row?.hotspot_ID || 0), row] as const)
        .filter((entry: readonly [number, any]) => entry[0] > 0),
    );
    const tryDirectClickedAnchorClosingRescue = async (): Promise<boolean> => {
      if (!(directClickedAnchorRescueHotspotId > 0)) return false;

      const attractionRows = adjustedPreviewTimeline.filter((row: any) => {
        const rowType = String(row?.type || '').toLowerCase();
        return rowType === 'attraction' || Number(row?.item_type || 0) === 4;
      });
      const selectedAttractionIndex = attractionRows.findIndex((row: any) => (
        Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0) === Number(focusHotspotId)
      ));
      console.log('[FitHere][DIRECT_CLOSING_RESCUE_PRECHECK]', {
        routeId: Number(routeId),
        selectedHotspotId: Number(focusHotspotId),
        selectedAttractionIndex,
        attractionRows: attractionRows.map((row: any) => ({
          hotspotId: Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0),
          text: String(row?.text || row?.name || ''),
          timeRange: String(row?.timeRange || ''),
          priority: Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 0),
        })),
      });
      if (selectedAttractionIndex <= 0) return false;

      const toRescuePriority = (row: any, candidate: any): number | null => {
        const normalized = this.callbacks.normalizeHotspotPriority(
          Number(
            candidate?.priority ||
            candidate?.hotspot_priority ||
            row?.priority ||
            row?.hotspot_priority ||
            row?.rawPriority ||
            9999,
          ),
        );
        const mapped =
          normalized >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY || normalized === 9999
            ? 4
            : normalized === this.CONFIRMATION_REQUIRED_PRIORITY
              ? 3
              : ([1, 2].includes(normalized) ? normalized : null);

        if (mapped === 4) return 4;
        if (mapped === 3) return options?.allowP3Removal === true ? 3 : null;
        if (mapped === 2 || mapped === 1) {
          return options?.allowP1P2Removal === true || options?.allowTopPriorityRemoval === true
            ? mapped
            : null;
        }
        return null;
      };

      const beforeSelectedRows = attractionRows
        .slice(0, selectedAttractionIndex)
        .filter((row: any) => {
          const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0);
          return hotspotId > 0 && hotspotId !== Number(focusHotspotId);
        })
        .map((row: any) => {
          const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0);
          const candidate = selectedClosingHotspotMasterById.get(hotspotId) || null;

          return {
            row,
            candidate,
            hotspotId,
            priority: toRescuePriority(row, candidate),
          };
        })
        .filter((entry: any) => entry.priority !== null);

      const orderedBeforeSelected = [...beforeSelectedRows].reverse();
      console.log('[FitHere][DIRECT_CLOSING_RESCUE_INPUT]', {
        routeId: Number(routeId),
        selectedHotspotId: Number(focusHotspotId),
        directClickedAnchorRescueHotspotId,
        selectedAttractionIndex,
        beforeSelectedRows: beforeSelectedRows.map((entry: any) => ({
          hotspotId: entry.hotspotId,
          name: String(
            entry?.candidate?.name ||
            entry?.candidate?.hotspot_name ||
            entry?.row?.name ||
            entry?.row?.text ||
            '',
          ).trim(),
          priority: entry.priority,
          rawPriority: Number(
            entry?.candidate?.priority ||
            entry?.candidate?.hotspot_priority ||
            entry?.row?.priority ||
            entry?.row?.hotspot_priority ||
            entry?.row?.rawPriority ||
            0,
          ),
        })),
      });
      if (orderedBeforeSelected.length === 0) return false;

      const rescuePlans: number[][] = [];
      for (let index = 0; index < orderedBeforeSelected.length; index += 1) {
        rescuePlans.push([orderedBeforeSelected[index].hotspotId]);
      }
      for (let size = 2; size <= orderedBeforeSelected.length; size += 1) {
        rescuePlans.push(orderedBeforeSelected.slice(0, size).map((entry: any) => Number(entry.hotspotId)));
      }
      console.log('[FitHere][DIRECT_CLOSING_RESCUE_PLANS]', {
        routeId: Number(routeId),
        selectedHotspotId: Number(focusHotspotId),
        rescuePlans,
      });

      const selectedHotspotLabel = String(
        (hotspotMasters || []).find((row: any) => Number(row?.hotspot_ID || 0) === Number(focusHotspotId))?.hotspot_name
        || manualInsertionFit?.selectedHotspotName
        || 'the selected manual hotspot',
      ).trim();
      for (const removedHotspotIds of rescuePlans) {
        console.log('[FitHere][DIRECT_CLOSING_RESCUE_TRY]', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          removedHotspotIds,
        });
        const directRescueTimeline = await this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, adjustedPreviewTimeline, {
          removedHotspotIds,
          targetHotspotId: Number(focusHotspotId),
          routeId: Number(routeId),
          planId: Number(planId),
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          allowSelectedClosingAnchorBypass: true,
        });

        if (!Array.isArray(directRescueTimeline) || directRescueTimeline.length === 0) {
          console.log('[FitHere][DIRECT_CLOSING_RESCUE_EMPTY_TIMELINE]', {
            routeId: Number(routeId),
            selectedHotspotId: Number(focusHotspotId),
            removedHotspotIds,
          });
          continue;
        }

        const enrichedTimeline = await this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours(
          Number(planId),
          Number(routeId),
          directRescueTimeline,
        );
        const selectedAfterDirectRescue = this.callbacks.getSelectedManualClosingOverflow({
          timeline: enrichedTimeline,
          selectedHotspotIds: requestedHotspotIds,
        });
        const selectedOperatingAfterDirectRescue = this.callbacks.markSelectedManualOperatingHourConflicts(
          enrichedTimeline,
          requestedHotspotIds,
        );
        const directRescueOverflowMinutes = Math.max(
          0,
          Number(
            this.callbacks.calculateRouteEndOverflowMinutes(
              selectedOperatingAfterDirectRescue.timeline,
              route,
              manualTimingPolicy.endTime,
            ) || 0,
          ),
        );

        if (
          selectedAfterDirectRescue.hasClosingOverflow === true ||
          selectedOperatingAfterDirectRescue.selectedOpeningConflict ||
          directRescueOverflowMinutes > 0
        ) {
          console.log('[FitHere][DIRECT_CLOSING_RESCUE_REJECTED]', {
            routeId: Number(routeId),
            selectedHotspotId: Number(focusHotspotId),
            removedHotspotIds,
            selectedClosingOverflow: selectedAfterDirectRescue,
            selectedOpeningConflict: selectedOperatingAfterDirectRescue.selectedOpeningConflict || null,
            directRescueOverflowMinutes,
            attractionOrder: selectedOperatingAfterDirectRescue.timeline
              .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
              .map((row: any) => ({
                hotspotId: Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0),
                text: String(row?.text || row?.name || ''),
                timeRange: String(row?.timeRange || ''),
              })),
          });
          continue;
        }

        const directRescueRemovals = removedHotspotIds.map((removedId: number) => {
          const matchedEntry = beforeSelectedRows.find((entry: any) => Number(entry.hotspotId) === Number(removedId));
          const matchedRow = matchedEntry?.row || {};
          const matchedCandidate = matchedEntry?.candidate || {};
          const removedName = String(
            matchedCandidate?.name ||
            matchedCandidate?.hotspot_name ||
            matchedRow?.name ||
            matchedRow?.text ||
            matchedRow?.hotspot_name ||
            `Hotspot #${removedId}`,
          ).trim();

          const reason = this.callbacks.buildSelectedClosingRemovalReason({
            removedName,
            selectedHotspotLabel,
            attemptedVisitTime:
              selectedClosingConflictForResolver?.attemptedVisitTime ||
              selectedClosingConflictForResolver?.visitTime ||
              null,
            operatingHours:
              selectedClosingConflictForResolver?.operatingHours ||
              selectedClosingConflictForResolver?.timings ||
              null,
            overflowMinutes: selectedClosingOverflowMinutesForResolver,
          });

          return {
            id: Number(removedId),
            name: removedName,
            priority: Number(matchedEntry?.priority || 4),
            rawPriority: this.callbacks.normalizeHotspotPriority(
              Number(
                matchedCandidate?.priority ||
                matchedCandidate?.hotspot_priority ||
                matchedRow?.priority ||
                matchedRow?.hotspot_priority ||
                matchedRow?.rawPriority ||
                9999,
              ),
            ),
            estimatedMinutes: Number(
              matchedCandidate?.estimatedMinutes ||
              matchedRow?.durationMinutes ||
              matchedRow?.duration_minutes ||
              matchedRow?.visitDurationMinutes ||
              this.callbacks.getPreviewRowDurationMinutes(matchedRow) ||
              0,
            ),
            reason,
            fitFailureExplanation: reason,
            removalReasonCode: 'SELECTED_HOTSPOT_CLOSING_RESCUE',
            requiresAcknowledgement: true,
          };
        });

        adjustedPreviewTimeline = selectedOperatingAfterDirectRescue.timeline;
        authoritativeRemovedHotspots.push(...directRescueRemovals);
        allRemovedHotspots.push(...directRescueRemovals);
        manualInsertionFit.removedLowPriorityHotspots = [
          ...(manualInsertionFit.removedLowPriorityHotspots || []),
          ...directRescueRemovals,
        ];
        manualInsertionFit.lowPriorityOpeningHoursRemovalPlanPreview = {
          resolved: true,
          algorithm: 'DIRECT_CLICKED_ANCHOR_CLOSING_RESCUE',
          originalOverflowMinutes: selectedClosingOverflowMinutesForResolver,
          overflowMinutes: selectedClosingOverflowMinutesForResolver,
          finalOverflowMinutes: 0,
          plannedRemovals: directRescueRemovals,
          candidates: [],
          candidateAudit: [],
          simulationAttempts: [
            {
              strategy: 'DIRECT_CLICKED_ANCHOR_CLOSING_RESCUE',
              removedHotspotIds,
              removedHotspotNames: directRescueRemovals.map((row: any) => row.name),
              selectedAttemptedVisitTime: null,
              selectedOperatingHours: null,
              selectedOpeningConflict: null,
              selectedClosingOverflowMinutes: 0,
              resolved: true,
            },
          ],
          rejectedAttempts: [],
          message: `${directRescueRemovals.map((row: any) => row.name).join(', ')} removed so the selected manual hotspot can fit before closing time.`,
          selectedClosingConflict: selectedClosingConflictForResolver,
        };
        manualInsertionFit.openingHoursRejected = false;
        manualInsertionFit.selectedOpeningConflict = null;
        manualInsertionFit.previewBlockReason = null;
        manualInsertionFit.canApply = true;
        manualInsertionFit.overflowResolved = true;
        manualInsertionFit.rescheduleApplied = true;
        manualInsertionFit.fullTimelineIsResolvedRemovalPlan = true;
        manualInsertionFit.timelineSource = 'DIRECT_CLICKED_ANCHOR_CLOSING_RESCUE';

        finalValidation = {
          ...finalValidation,
          passesScheduleRules: true,
          readyToApply: true,
          requiresPriorityConfirmation: false,
          stillUnschedulable: false,
          routeEndOverflowMinutes: 0,
          openingHourConflictCount: 0,
          selectedManualConflictCount: 0,
          selectedOpeningConflict: null,
          reason: `${directRescueRemovals.map((row: any) => row.name).join(', ')} removed so the selected manual hotspot can fit before closing time.`,
        };

        console.log('[FitHere][DIRECT_CLICKED_ANCHOR_CLOSING_RESCUE_PROMOTED]', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          removedHotspotIds,
          finalTimelineHotspotIds: adjustedPreviewTimeline
            .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
            .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0)),
        });

        return true;
      }

      return false;
    };

    const shouldTryDirectClickedAnchorClosingRescue =
      directClickedAnchorRescueHotspotId > 0 &&
      (
        selectedClosingOverflow.hasClosingOverflow === true ||
        (!!fallbackSelectedOpeningConflict && fallbackOverflowMinutes > 0)
      ) &&
      selectedLatestAllowedEndMinutesForResolver > 0;
    console.log('[FitHere][DIRECT_CLOSING_RESCUE_GATE]', {
      routeId: Number(routeId),
      selectedHotspotId: Number(focusHotspotId),
      exactAnchorMode: options?.exactAnchorMode === true,
      anchorIntent: String(options?.anchorIntent || ''),
      directClickedAnchorRescueHotspotId,
      selectedClosingOverflow,
      fallbackSelectedOpeningConflict: fallbackSelectedOpeningConflict || null,
      fallbackOverflowMinutes,
      selectedLatestAllowedEndMinutesForResolver,
      shouldTryDirectClickedAnchorClosingRescue,
    });

    const shouldRunSelectedClosingResolver =
      manualInsertionFit?.requiresMatrixBuild !== true &&
      !!selectedClosingResolverSlot &&
      (
        options?.exactAnchorMode === true ||
        selectedClosingResolverSlot?.routePossible !== false
      ) &&
      (
        selectedClosingOverflow.hasClosingOverflow === true ||
        (!!fallbackSelectedOpeningConflict && fallbackOverflowMinutes > 0)
      ) &&
      selectedLatestAllowedEndMinutesForResolver > 0;

    const directClickedAnchorClosingRescueApplied =
      shouldTryDirectClickedAnchorClosingRescue
        ? await tryDirectClickedAnchorClosingRescue()
        : false;

    if (shouldRunSelectedClosingResolver && !directClickedAnchorClosingRescueApplied) {
      const focusMaster = (hotspotMasters || []).find(
        (row: any) => Number(row?.hotspot_ID || 0) === Number(focusHotspotId),
      );

      const selectedManualPriority = this.callbacks.resolveSelectedManualPriority({
        selectedHotspotId: Number(focusHotspotId),
        manualInsertionFit,
        options,
        focusMaster,
      });

      const dayEndMinutes = Math.floor(
        this.callbacks.hmsToSeconds(
          TimeConverter.toTimeString(
            manualTimingPolicy.endTime || route?.route_end_time || '23:00:00',
          ),
        ) / 60,
      );

      const openingHoursRemovalPlan = await this.callbacks.resolveProgressivePriorityRemovalForManualFitInTx(tx, {
        planId: Number(planId),
        routeId: Number(routeId),
        selectedHotspotId: Number(focusHotspotId),
        selectedManualPriority,
        currentTimeline: adjustedPreviewTimeline,
        dayEndMinutes,
        overflowMinutes: selectedClosingOverflowMinutesForResolver,
        validationMode: 'SELECTED_HOTSPOT_CLOSING',
        targetHotspotId: Number(focusHotspotId),
        targetHotspotLatestEndMinutes: selectedLatestAllowedEndMinutesForResolver,
        exactAnchorMode: options?.exactAnchorMode === true,
        anchorIntent: options?.anchorIntent,
        afterHotspotId: options?.afterHotspotId,
        beforeHotspotId: options?.beforeHotspotId,
        allowP3Removal: options?.allowP3Removal === true || options?.allowTopPriorityRemoval === true,
        allowP2Removal: options?.allowP1P2Removal === true || options?.allowTopPriorityRemoval === true,
        allowP1Removal: options?.allowP1P2Removal === true || options?.allowTopPriorityRemoval === true,
      });

      const sameRouteResolvedRemovals = await this.callbacks.filterPlannedRemovalsToSameRouteInTx(
        tx,
        Number(planId),
        Number(routeId),
        openingHoursRemovalPlan.removedHotspots || [],
      );
      const resolvedOpeningHourRemovals =
        sameRouteResolvedRemovals.length > 0
          ? sameRouteResolvedRemovals
          : ((openingHoursRemovalPlan.removedHotspots || []).filter((row: any) => this.callbacks.getManualFitRemovalHotspotId(row) > 0));
      if (sameRouteResolvedRemovals.length !== (openingHoursRemovalPlan.removedHotspots || []).length) {
        console.warn('[FitHere][cross_route_removal_candidate_blocked]', {
          planId: Number(planId),
          routeId: Number(routeId),
          originalRemovalIds: (openingHoursRemovalPlan.removedHotspots || []).map((row: any) => row?.id),
          sameRouteRemovalIds: sameRouteResolvedRemovals.map((row: any) => row?.id),
        });
      }

      manualInsertionFit.lowPriorityOpeningHoursRemovalPlanPreview = {
        resolved: openingHoursRemovalPlan.resolved,
        algorithm: openingHoursRemovalPlan.algorithm,
        originalOverflowMinutes: selectedClosingOverflowMinutesForResolver,
        overflowMinutes: selectedClosingOverflowMinutesForResolver,
        finalOverflowMinutes: openingHoursRemovalPlan.finalOverflowMinutes,
        plannedRemovals: openingHoursRemovalPlan.resolved
          ? resolvedOpeningHourRemovals
          : [],
        candidates: openingHoursRemovalPlan.candidateHotspots,
        candidateAudit: openingHoursRemovalPlan.candidateAudit,
        simulationAttempts: openingHoursRemovalPlan.simulationAttempts,
        rejectedAttempts: openingHoursRemovalPlan.rejectedAttempts,
        message: openingHoursRemovalPlan.message,
        selectedClosingConflict: selectedClosingConflictForResolver,
      };

      if (openingHoursRemovalPlan.resolved) {
        let finalResolvedTimeline = this.callbacks.sanitizeResolvedLowPriorityTimeline(
          Array.isArray(openingHoursRemovalPlan.finalTimeline)
            ? openingHoursRemovalPlan.finalTimeline
            : adjustedPreviewTimeline,
          resolvedOpeningHourRemovals,
        );

        finalResolvedTimeline = await this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours(
          Number(planId),
          Number(routeId),
          finalResolvedTimeline,
        );

        const selectedAfterRescue = this.callbacks.getSelectedManualClosingOverflow({
          timeline: finalResolvedTimeline,
          selectedHotspotIds: requestedHotspotIds,
        });

        const selectedClosingResolverAccepted = Boolean(
          openingHoursRemovalPlan?.resolved === true
          && (openingHoursRemovalPlan?.simulationAttempts || []).some((attempt: any) =>
            attempt?.strategy === 'SELECTED_CLOSING_RESCUE_PLAN'
            && attempt?.resolved === true
            && !attempt?.selectedOpeningConflict
            && Number(attempt?.selectedClosingOverflowMinutes || 0) <= 0,
          )
        );

        if (selectedClosingResolverAccepted && selectedAfterRescue.hasClosingOverflow === true) {
          console.warn('[FitHere][SELECTED_CLOSING_RESCUE_ACCEPTED_WITH_STALE_OVERFLOW]', {
            routeId: Number(routeId),
            selectedHotspotId: Number(focusHotspotId),
            selectedAfterRescue,
          });

          finalResolvedTimeline = finalResolvedTimeline.map((row: any) => {
            const isSelectedAttraction =
              (String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
              && requestedHotspotIds.includes(Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0));

            if (!isSelectedAttraction) return row;

            return {
              ...row,
              isConflict: false,
              conflictReason: null,
              selectedOpeningConflict: null,
              openingHoursRejected: false,
            };
          });
        }

        if (selectedAfterRescue.hasClosingOverflow !== true || selectedClosingResolverAccepted) {
          adjustedPreviewTimeline = finalResolvedTimeline;

          manualInsertionFit.openingHoursRejected = false;
          manualInsertionFit.selectedOpeningConflict = null;
          manualInsertionFit.previewBlockReason = null;
          manualInsertionFit.canApply = true;
          manualInsertionFit.overflowResolved = true;
          manualInsertionFit.rescheduleApplied = true;
          manualInsertionFit.fullTimelineIsResolvedRemovalPlan = true;
          manualInsertionFit.timelineSource = 'LOW_PRIORITY_OPENING_HOURS_REMOVAL_FINAL_TIMELINE';

          const existingResolvedRemovalIds = new Set<number>(
            [
              ...authoritativeRemovedHotspots,
              ...allRemovedHotspots,
              ...(manualInsertionFit.removedLowPriorityHotspots || []),
            ]
              .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
              .filter((id: number) => Number.isFinite(id) && id > 0),
          );
          const newResolvedOpeningHourRemovals = resolvedOpeningHourRemovals.filter((row: any) => {
            const id = Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0);
            return id > 0 && !existingResolvedRemovalIds.has(id);
          });

          if (newResolvedOpeningHourRemovals.length > 0) {
            authoritativeRemovedHotspots.push(...newResolvedOpeningHourRemovals);
            allRemovedHotspots.push(...newResolvedOpeningHourRemovals);
          }

          manualInsertionFit.removedLowPriorityHotspots = [
            ...(manualInsertionFit.removedLowPriorityHotspots || []),
            ...newResolvedOpeningHourRemovals,
          ];

          console.log('[FitHere][SELECTED_CLOSING_RESCUE_PROMOTED]', {
            routeId: Number(routeId),
            selectedHotspotId: Number(focusHotspotId),
            removedHotspotIds: resolvedOpeningHourRemovals.map((row: any) => Number(row?.id || 0)),
            finalTimelineHotspotIds: finalResolvedTimeline
              .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
              .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0)),
          });

          manualInsertionFit.lowPriorityOpeningHoursRemovalPlanPreview = {
            ...manualInsertionFit.lowPriorityOpeningHoursRemovalPlanPreview,
            resolved: true,
            finalOverflowMinutes: 0,
            plannedRemovals: resolvedOpeningHourRemovals,
          };

          finalValidation = {
            ...finalValidation,
            passesScheduleRules: true,
            readyToApply: true,
            requiresPriorityConfirmation: false,
            stillUnschedulable: false,
            routeEndOverflowMinutes: 0,
            openingHourConflictCount: 0,
            selectedManualConflictCount: 0,
            selectedOpeningConflict: null,
            reason: 'Selected manual hotspot closing conflict resolved by removing earlier blockers and rebuilding the APJ pivot timeline.',
          };
        }
      }
    }

    let selectedOperatingValidation = this.callbacks.markSelectedManualOperatingHourConflicts(
      adjustedPreviewTimeline,
      requestedHotspotIds,
    );

    adjustedPreviewTimeline = selectedOperatingValidation.timeline;

    const resolvedSelectedClosingAttempt = (manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview?.simulationAttempts || [])
      .find((attempt: any) =>
        attempt?.strategy === 'SELECTED_CLOSING_RESCUE_PLAN'
        && attempt?.resolved === true
        && !attempt?.selectedOpeningConflict
        && Number(attempt?.selectedClosingOverflowMinutes || 0) <= 0,
      );

    if (selectedOperatingValidation.selectedOpeningConflict && resolvedSelectedClosingAttempt) {
      const rescuedTimelineCandidate =
        (Array.isArray(resolvedSelectedClosingAttempt?.previewTimelineDisplay) && resolvedSelectedClosingAttempt.previewTimelineDisplay.length > 0
          ? resolvedSelectedClosingAttempt.previewTimelineDisplay
          : null)
        || (Array.isArray(resolvedSelectedClosingAttempt?.displayTimeline) && resolvedSelectedClosingAttempt.displayTimeline.length > 0
          ? resolvedSelectedClosingAttempt.displayTimeline
          : null)
        || (Array.isArray(resolvedSelectedClosingAttempt?.previewTimeline) && resolvedSelectedClosingAttempt.previewTimeline.length > 0
          ? resolvedSelectedClosingAttempt.previewTimeline
          : null)
        || (Array.isArray(resolvedSelectedClosingAttempt?.computedTimelineDebug) && resolvedSelectedClosingAttempt.computedTimelineDebug.length > 0
          ? resolvedSelectedClosingAttempt.computedTimelineDebug
          : []);

      if (rescuedTimelineCandidate.length > 0) {
        adjustedPreviewTimeline = rescuedTimelineCandidate.map((row: any) => {
          const isSelectedAttraction =
            (String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
            && requestedHotspotIds.includes(Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0));

          return isSelectedAttraction
            ? { ...row, isConflict: false, conflictReason: null, selectedOpeningConflict: null, openingHoursRejected: false }
            : row;
        });

        const plannedRemovals = Array.isArray(manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview?.plannedRemovals)
          ? manualInsertionFit.lowPriorityOpeningHoursRemovalPlanPreview.plannedRemovals
          : [];
        const existingRemovalIds = new Set(
          [...authoritativeRemovedHotspots, ...allRemovedHotspots]
            .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0),
        );
        const newPlannedRemovals = plannedRemovals.filter((row: any) => {
          const id = Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0);
          return id > 0 && !existingRemovalIds.has(id);
        });

        if (newPlannedRemovals.length > 0) {
          authoritativeRemovedHotspots.push(...newPlannedRemovals);
          allRemovedHotspots.push(...newPlannedRemovals);
        }

        selectedOperatingValidation = {
          ...selectedOperatingValidation,
          timeline: adjustedPreviewTimeline,
          selectedOpeningConflict: null,
        };
        manualInsertionFit.selectedOpeningConflict = null;
        manualInsertionFit.canApply = true;
        manualInsertionFit.openingHoursRejected = false;
        manualInsertionFit.previewBlockReason = null;
        manualInsertionFit.rescheduleApplied = true;
        manualInsertionFit.overflowResolved = true;
        manualInsertionFit.fullTimelineIsResolvedRemovalPlan = true;
        manualInsertionFit.timelineSource = 'SELECTED_CLOSING_RESCUE_LATE_PROMOTION';

        console.warn('[FitHere][SELECTED_CLOSING_RESCUE_LATE_PROMOTION]', {
          routeId: Number(routeId),
          selectedHotspotId: Number(focusHotspotId),
          removedHotspotIds: plannedRemovals.map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0)),
          finalTimelineHotspotIds: adjustedPreviewTimeline
            .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
            .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0)),
          rescuedTimelineLength: adjustedPreviewTimeline.length,
        });
      }
    }

    if (manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview?.resolved === true) {
      selectedOperatingValidation = {
        ...selectedOperatingValidation,
        selectedOpeningConflict: null,
        timeline: adjustedPreviewTimeline,
      };
      manualInsertionFit.selectedOpeningConflict = null;
      manualInsertionFit.canApply = true;
      manualInsertionFit.openingHoursRejected = false;
      manualInsertionFit.previewBlockReason = null;
    } else if (selectedOperatingValidation.selectedOpeningConflict) {
      manualInsertionFit.selectedOpeningConflict = selectedOperatingValidation.selectedOpeningConflict;
      manualInsertionFit.canApply = false;
      manualInsertionFit.openingHoursRejected = true;
      manualInsertionFit.previewBlockReason = 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME';
    } else {
      manualInsertionFit.selectedOpeningConflict = null;
      manualInsertionFit.openingHoursRejected = false;
      manualInsertionFit.previewBlockReason = null;
      manualInsertionFit.canApply = true;
    }

    finalValidationBase = this.callbacks.buildManualHotspotValidation({
      route,
      requestedHotspotIds,
      fullTimeline: adjustedPreviewTimeline,
      manualTimingPolicy,
      adaptive,
    });
    const selectedClosingRescueResolved = Boolean(
      manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview?.resolved === true
      && manualInsertionFit?.openingHoursRejected !== true
      && !manualInsertionFit?.selectedOpeningConflict
    );

    finalValidation = {
      ...finalValidation,
      ...finalValidationBase,
      requiresPriorityConfirmation: selectedClosingRescueResolved ? false : finalRequiresConfirmation,
      readyToApply: selectedClosingRescueResolved
        ? true
        : finalValidationBase.passesScheduleRules && !finalRequiresConfirmation,
      ...(selectedClosingRescueResolved
        ? {
            passesScheduleRules: true,
            stillUnschedulable: false,
            routeEndOverflowMinutes: 0,
            openingHourConflictCount: 0,
            selectedManualConflictCount: 0,
            selectedOpeningConflict: null,
            reason: 'Selected manual hotspot closing conflict resolved by removing earlier blockers and rebuilding the APJ pivot timeline.',
          }
        : {}),
    };
    const unresolvedDayEndOverflowMinutes = Math.max(
      0,
      Number(
        manualInsertionFit?.lowPriorityRemovalPlanPreview?.resolved === true
          ? 0
          : (
              manualInsertionFit?.lowPriorityRemovalPlanPreview?.finalOverflowMinutes
              || finalValidation?.routeEndOverflowMinutes
              || finalValidationBase?.routeEndOverflowMinutes
              || manualInsertionFit?.dayOverflowMinutes
              || 0
            ),
      ),
    );
    const hasUnresolvedDayEndRemovalPlan =
      !!manualInsertionFit?.lowPriorityRemovalPlanPreview
      && manualInsertionFit.lowPriorityRemovalPlanPreview.resolved !== true
      && unresolvedDayEndOverflowMinutes > 0;

    if (hasUnresolvedDayEndRemovalPlan) {
      manualInsertionFit.canApply = false;
      manualInsertionFit.exceedsDayEnd = true;
      manualInsertionFit.dayOverflowMinutes = unresolvedDayEndOverflowMinutes;
      finalValidation = {
        ...finalValidation,
        passesScheduleRules: false,
        readyToApply: false,
        routeEndOverflowMinutes: unresolvedDayEndOverflowMinutes,
        reason:
          manualInsertionFit?.lowPriorityRemovalPlanPreview?.message
          || finalValidation?.reason
          || 'Could not resolve route overflow with same-route lower-priority hotspots.',
      };
    }

    const timingRisk = this.callbacks.detectManualFitTimingRisk({
      timeline: adjustedPreviewTimeline,
      selectedHotspotId: Number(focusHotspotId),
    });
    const hasHardSelectedOpeningConflict =
      !!manualInsertionFit?.selectedOpeningConflict ||
      !!finalValidation?.selectedOpeningConflict ||
      String(manualInsertionFit?.previewBlockReason || '').toUpperCase() === 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME';
    const allowsPartialStayRiskConfirmation =
      !!timingRisk
      && !hasHardSelectedOpeningConflict
      && Number(finalValidation?.routeEndOverflowMinutes || 0) <= 0
      && finalValidation.stillUnschedulable !== true;

    if (allowsPartialStayRiskConfirmation) {
      manualInsertionFit.canApply = true;
      finalValidation = {
        ...finalValidation,
        passesScheduleRules: true,
        readyToApply: true,
        requiresPriorityConfirmation: false,
        requiresTimingRiskConfirmation: true,
        requiresForceConfirmation: false,
        stillUnschedulable: false,
        reason: timingRisk?.message || finalValidation.reason,
      };
    }

    const strictTimingValidation = this.callbacks.validateStrictMatrixTimeline(adjustedPreviewTimeline);
    if (!strictTimingValidation.passes) {
      finalRequiresConfirmation = false;
      finalTopPriorityAffected = [];
      finalRemovedTopPriority = [];
      manualInsertionFit.canApply = false;
      manualInsertionFit.strictTimingValidation = strictTimingValidation;
      finalValidation = {
        ...finalValidation,
        passesScheduleRules: false,
        readyToApply: false,
        requiresPriorityConfirmation: false,
        stillUnschedulable: true,
        reason: strictTimingValidation.reason,
      };
    }

    const selectedManualRowsInPreview = (Array.isArray(adjustedPreviewTimeline) ? adjustedPreviewTimeline : [])
      .filter((row: any) => {
        if (String(row?.type || '').toLowerCase() !== 'attraction' && Number(row?.item_type || 0) !== 4) {
          return false;
        }
        const id = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0);
        return requestedHotspotIds.includes(id);
      });
    const selectedManualPresentInPreview = selectedManualRowsInPreview.length > 0;
    const selectedManualConflictInPreview = selectedManualRowsInPreview.some((row: any) => row?.isConflict === true);
    const selectedManualPivotPreviewValid = Boolean(
      manualInsertionFit?.destinationInsertionMode === true
      && selectedManualPresentInPreview
      && !selectedManualConflictInPreview
      && !manualInsertionFit?.selectedOpeningConflict
      && manualInsertionFit?.openingHoursRejected !== true,
    );
    const chosenRouteFitTypeUpper = String(timelineInsertionFit?.chosenSlot?.routeFitType || '').toUpperCase();
    const chosenSlotFeasible = chosenRouteFitTypeUpper === 'ON_ROUTE' || chosenRouteFitTypeUpper === 'MINOR_DETOUR';
    const resolvedWithTimelineRecalc = Boolean(
      allRemovedHotspots.length > 0
      || manualInsertionFit?.lowPriorityRemovalPlanPreview?.resolved === true
      || manualInsertionFit?.rescheduleApplied === true,
    );

    console.log('[FitHere][APJ_PIVOT_VALIDATION]', {
      routeId: Number(routeId),
      selectedHotspotIds: requestedHotspotIds,
      selectedManualPresentInPreview,
      selectedManualConflictInPreview,
      selectedManualPivotPreviewValid,
      staleRouteEndOverflowMinutes: Number(finalValidation?.routeEndOverflowMinutes || 0),
      staleUnscheduledManualCount: Number(finalValidation?.unscheduledManualCount || 0),
    });

    if (
      (chosenSlotFeasible || selectedManualPivotPreviewValid)
      && selectedManualPresentInPreview
      && !selectedManualConflictInPreview
      && !manualInsertionFit?.selectedOpeningConflict
      && manualInsertionFit?.openingHoursRejected !== true
      && (Number(finalValidation?.routeEndOverflowMinutes || 0) <= 0 || selectedManualPivotPreviewValid)
      && finalRequiresConfirmation !== true
    ) {
      manualInsertionFit.canApply = true;
      finalValidation = {
        ...finalValidation,
        passesScheduleRules: true,
        readyToApply: true,
        requiresPriorityConfirmation: false,
        stillUnschedulable: false,
        routeEndOverflowMinutes: selectedManualPivotPreviewValid ? 0 : Number(finalValidation?.routeEndOverflowMinutes || 0),
        scheduledSelectedManualCount: Math.max(Number(finalValidation?.scheduledSelectedManualCount || 0), selectedManualRowsInPreview.length),
        unscheduledManualCount: 0,
        reason: resolvedWithTimelineRecalc || selectedManualPivotPreviewValid
          ? 'Manual hotspot can be inserted and timeline will be recalculated.'
          : 'Manual hotspot can be inserted in the selected route-fit slot.',
      };
    }

    if (
      finalValidation?.readyToApply === true
      && !finalValidation?.selectedOpeningConflict
    ) {
      manualInsertionFit.selectedOpeningConflict = null;
      manualInsertionFit.openingHoursRejected = false;
      if (String(manualInsertionFit?.previewBlockReason || '').toUpperCase() === 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME') {
        manualInsertionFit.previewBlockReason = null;
      }
    }

    const canForceConflictInsertion =
      options?.previewOnly !== true
      && options?.forceConflictInsertion === true
      && finalValidation.readyToApply !== true
      && finalRequiresConfirmation !== true;

    if (canForceConflictInsertion) {
      for (const hotspotId of requestedHotspotIds) {
        const previewRow = (Array.isArray(adjustedPreviewTimeline) ? adjustedPreviewTimeline : []).find((row: any) => {
          const isAttraction = String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
          if (!isAttraction) return false;
          const rowHotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
          return rowHotspotId === Number(hotspotId);
        });
        const previewRange = this.callbacks.parsePreviewTimeRangeToUtcDates(previewRow?.timeRange);
        const previewDurationMinutes = (previewRange.start && previewRange.end)
          ? Math.round((previewRange.end.getTime() - previewRange.start.getTime()) / 60000)
          : 0;

        await this.callbacks.forceInsertManualHotspotConflictRow(
          tx,
          Number(planId),
          Number(routeId),
          Number(hotspotId),
          Number(userId || 1),
          (previewRange.start && previewRange.end && previewDurationMinutes > 0)
            ? { start: previewRange.start, end: previewRange.end }
            : undefined,
        );
      }
    }

    const success = finalValidation.readyToApply || canForceConflictInsertion;
    const inserted = success;
    const removedPrioritySummary = this.callbacks.buildRemovedPrioritySummary([
      ...authoritativeRemovedHotspots,
      ...(adaptive.p3HotspotsToRemove || []),
    ]);
    const authoritativeRemovedHotspotIds = Array.from(new Set(
      authoritativeRemovedHotspots
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ));
    const requiresRemovalAcknowledgementHotspotIds = authoritativeRemovedHotspotIds;
    const changesRequiredDisplay = this.callbacks.buildManualFitChangesRequiredDisplay({
      removedHotspots: authoritativeRemovedHotspots,
      affectedPriorityHotspots: finalTopPriorityAffected,
      removedPrioritySummary,
    }) as any;
    changesRequiredDisplay.exactAnchorFailure =
      String(adaptive.reason || finalValidation?.reason || '').toLowerCase().includes('exact-anchor rebuild failed') ||
      String(adaptive.reason || finalValidation?.reason || '').toLowerCase().includes('did not keep the selected manual hotspot');
    const selectedStrategyKey = String(adaptive.manualOptimizer?.selectedStrategyKey || '').trim();
    const selectedStrategyLabel = String(adaptive.manualOptimizer?.selectedStrategyLabel || '').trim()
      || (finalValidation.readyToApply
        ? 'Selected Timing-Safe Schedule'
        : (canForceConflictInsertion ? 'Conflict Mode Only' : 'P3 Removal Required'));
    const finalConflictModeOnly =
      finalValidation.readyToApply !== true
      && finalRequiresConfirmation !== true
      && canForceConflictInsertion !== true;

    if (!options?.previewOnly && !success) {
      const rollbackHotspotIds = requestedHotspotIds.filter(
        (hotspotId) => preparedByHotspotId.get(hotspotId)?.alreadyExisted !== true,
      );

      if (rollbackHotspotIds.length > 0) {
        await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
          where: {
            itinerary_plan_ID: Number(planId),
            itinerary_route_ID: Number(routeId),
            hotspot_ID: { in: rollbackHotspotIds },
            item_type: 4,
            hotspot_plan_own_way: 1,
            deleted: 0,
          },
        });
      }
    }

    if (
      options?.previewOnly === true
      && options?.exactAnchorMode === true
      && manualInsertionFit?.destinationInsertionMode === true
    ) {
      console.log('[FitPreview][final_response_timeline]', {
        routeId: Number(routeId),
        selectedHotspotIds: requestedHotspotIds,
        timelineLength: Array.isArray(adjustedPreviewTimeline) ? adjustedPreviewTimeline.length : 0,
        rows: (Array.isArray(adjustedPreviewTimeline) ? adjustedPreviewTimeline : []).map((row: any, index: number) => ({
          index,
          type: String(row?.type || row?.item_type || ''),
          text: String(row?.text || row?.name || ''),
          hotspotId: Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) || null,
          timeRange: String(row?.timeRange || ''),
        })),
      });
    }

    adjustedPreviewTimeline = await this.callbacks.ensurePreviewTimelineHasComputedHotelTravel(
      tx,
      Number(planId),
      Number(routeId),
      adjustedPreviewTimeline,
    );

    const responseManualInsertionFit =
      options?.exactAnchorMode === true
        ? this.callbacks.normalizeExactAnchorManualInsertionFit({
            manualInsertionFit: {
              ...(manualInsertionFit || {}),
              ...(timelineInsertionFit || {}),
            },
            anchorIntent: options?.anchorIntent,
            afterHotspotId: options?.afterHotspotId ?? null,
            beforeHotspotId: options?.beforeHotspotId ?? null,
            anchorLabel: String(
              manualInsertionFit?.anchorLabel ||
              manualInsertionFit?.requestedSlot?.label ||
              timelineInsertionFit?.anchorLabel ||
              timelineInsertionFit?.requestedSlot?.label ||
              'Selected Fit Here position',
            ).trim(),
          })
        : {
            ...(manualInsertionFit || {}),
            ...(timelineInsertionFit || {}),
            manualTimingPolicy,
          };

    const response = {
      ...enginePreview,
      success,
      inserted,
      planId: Number(planId),
      routeId: Number(routeId),
      hotspotId: focusHotspotId,
      hotspotIds: requestedHotspotIds,
      fullTimeline: adjustedPreviewTimeline,
      routeTimeline: adjustedPreviewTimeline,
      manualTimingPolicy,
      selectedStrategyKey,
      selectedStrategyLabel,
      canForceConflict: canForceConflictInsertion,
      finalConflictModeOnly,
      timingRisk,
      requiresTimingRiskConfirmation: finalValidation?.requiresTimingRiskConfirmation === true,
      confirmButtonVariant: (
        timingRisk
        || removedPrioritySummary.requiresPriorityRemovalConfirmation === true
        || removedPrioritySummary.highestRemovedPriority === 1
        || removedPrioritySummary.highestRemovedPriority === 2
      ) ? 'danger' : 'default',
      removedPrioritySummary,
      manualOptimizer: adaptive.manualOptimizer || null,
      distanceAndToFro: adaptive.insertionMetrics,
      manualInsertionFit: responseManualInsertionFit,
      selectedIncluded: finalValidation.stillUnschedulable !== true,
      code: finalRequiresConfirmation
        ? 'MANUAL_HOTSPOT_CONFIRM_PRIORITY_REPLACEMENT'
        : (!finalValidation.passesScheduleRules
            ? (Number(finalValidation.routeEndOverflowMinutes || manualInsertionFit?.dayOverflowMinutes || 0) > 0
            ? (manualInsertionFit?.lowPriorityRemovalPlanPreview?.resolved === true
              ? 'MANUAL_HOTSPOT_READY_WITH_LOW_PRIORITY_REMOVAL_PLAN'
              : ((Array.isArray(manualInsertionFit?.lowPriorityRemovalPlanPreview?.candidates)
                  && manualInsertionFit.lowPriorityRemovalPlanPreview.candidates.length === 0)
                ? 'MANUAL_INSERT_NO_LOW_PRIORITY_REMOVAL_AVAILABLE'
                : 'MANUAL_INSERT_EXCEEDS_DAY_END'))
                : 'MANUAL_HOTSPOT_CANNOT_FIT')
            : (matrixGapResolution.shouldUseMatrixSlot
                ? 'MANUAL_HOTSPOT_INSERTED_WITH_MATRIX_SLOT'
                : undefined)),
      message: finalRequiresConfirmation
        ? 'Priority 3 hotspot removal confirmation required.'
        : (canForceConflictInsertion
            ? 'Manual hotspots inserted as conflicts after user confirmation.'
            : !finalValidation.passesScheduleRules
            ? (selectedStrategyKey === 'opening_urgency' && Number(finalValidation?.selectedManualConflictCount || 0) > 0
                ? 'Opening-hours rescue was attempted, but the selected manual hotspot would end after its closing window.'
                : (removedPreviewHotspots.length > 0
                ? 'A Priority 3 hotspot was removed, but the selected manual hotspot still conflicts with opening/timing rules.'
                : (Number(finalValidation.routeEndOverflowMinutes || manualInsertionFit?.dayOverflowMinutes || 0) > 0
                  ? (manualInsertionFit?.lowPriorityRemovalPlanPreview?.resolved === true
                    ? (manualInsertionFit?.lowPriorityRemovalPlanPreview?.message || 'Manual hotspot can be applied by removing lower-priority hotspots from this route.')
                    : (finalValidation.reason || `Manual hotspot is route-feasible but exceeds day end by ${Number(finalValidation.routeEndOverflowMinutes || manualInsertionFit?.dayOverflowMinutes || 0)} minutes.`))
                  : (finalValidation.reason || 'One or more selected hotspots cannot be scheduled within valid route constraints.'))))
            : (matrixGapResolution.shouldUseMatrixSlot
                ? 'Manual hotspot inserted using matrix best slot.'
                : 'Manual hotspots applied successfully')),
      validation: finalValidation,
      resolution: {
        manualTimingPolicy,
        manualInsertionFit: responseManualInsertionFit,
        requiresConfirmation: finalRequiresConfirmation,
        requiresP3RemovalConfirmation: adaptive.requiresP3RemovalConfirmation === true,
        requiresTimingRiskConfirmation: finalValidation?.requiresTimingRiskConfirmation === true,
        requiresPriorityRemovalConfirmation: removedPrioritySummary.requiresPriorityRemovalConfirmation === true,
        forceConflictInsertionApplied: canForceConflictInsertion,
        canForceConflict: canForceConflictInsertion,
        finalConflictModeOnly,
        timingRisk,
        removedPrioritySummary,
        removedHotspots: authoritativeRemovedHotspots,
        authoritativeRemovedHotspotIds,
        requiresRemovalAcknowledgementHotspotIds,
        changesRequiredDisplay,
        removedOptionalHotspots: adaptive.removedOptionalHotspots,
        removedTopPriorityHotspots: finalRemovedTopPriority,
        p3HotspotsToRemove: adaptive.p3HotspotsToRemove || [],
        topPriorityAffected: finalTopPriorityAffected,
        sameCityShuffleApplied: adaptive.sameCityShuffleApplied === true,
        sameCityShuffleOrder: adaptive.sameCityShuffleOrder || [],
        selectedStrategyKey,
        selectedStrategyLabel,
        manualOptimizer: adaptive.manualOptimizer || null,
        scheduledManualHotspots: this.callbacks.decorateScheduledManualHotspots(
          requestedHotspotIds,
          hotspotMasters,
          adjustedPreviewTimeline,
        ),
        unscheduledManualHotspots: adaptive.unscheduledManualHotspots.filter((row: any) =>
          requestedHotspotIds.includes(Number(row?.id || 0)),
        ),
        shiftedHotspots: adaptive.shiftedHotspots || [],
        deferredHotspots: adaptive.deferredHotspots || [],
        removedCount: authoritativeRemovedHotspots.length,
        stillUnschedulable: adaptive.unscheduledManualHotspots.length > 0,
        timingAdjusted: authoritativeRemovedHotspots.length > 0,
        reason: adaptive.reason,
        validation: finalValidation,
        slotInsights:
          Array.isArray(manualInsertionFit?.allSlotResults) && manualInsertionFit.allSlotResults.length > 0
            ? []
            : (adaptive.slotInsights || []),
        insertionMetrics: adaptive.insertionMetrics,
      },
    };

    (response as any).removedHotspots = authoritativeRemovedHotspots;
    (response as any).authoritativeRemovedHotspotIds = authoritativeRemovedHotspotIds;
    (response as any).requiresRemovalAcknowledgementHotspotIds = requiresRemovalAcknowledgementHotspotIds;
    (response as any).changesRequiredDisplay = changesRequiredDisplay;

    if (success && options?.previewOnly !== true) {
      const insertedRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          hotspot_ID: { in: requestedHotspotIds },
          item_type: 4,
          deleted: 0,
          hotspot_plan_own_way: 1,
        },
        orderBy: [
          { hotspot_order: 'asc' },
          { route_hotspot_ID: 'desc' },
        ],
        select: {
          route_hotspot_ID: true,
          hotspot_order: true,
          hotspot_ID: true,
        },
      });

      const insertedRowByHotspotId = new Map<number, any>();
      for (const row of insertedRows || []) {
        const hotspotId = Number(row?.hotspot_ID || 0);
        if (hotspotId > 0 && !insertedRowByHotspotId.has(hotspotId)) {
          insertedRowByHotspotId.set(hotspotId, row);
        }
      }

      const focusInsertedRow = insertedRowByHotspotId.get(Number(focusHotspotId)) || null;
      const focusRouteHotspotId = Number(focusInsertedRow?.route_hotspot_ID || 0) || null;

      response.routeHotspotId = focusRouteHotspotId;

      response.resolution = {
        ...(response.resolution || {}),
        scheduledManualHotspots: Array.isArray(response?.resolution?.scheduledManualHotspots)
          ? response.resolution.scheduledManualHotspots.map((row: any) => {
              const hotspotId = Number(row?.hotspotId || row?.id || 0);
              const insertedRow = insertedRowByHotspotId.get(hotspotId) || null;

              return {
                ...row,
                hotspotId,
                routeHotspotId: Number(insertedRow?.route_hotspot_ID || 0) || row?.routeHotspotId || null,
                isManual: true,
                planOwnWay: true,
              };
            })
          : [],
      };

      console.log('[ManualHotspotApply] inserted row ids', {
        planId: Number(planId),
        routeId: Number(routeId),
        routeHotspotId: focusRouteHotspotId,
        insertedRows: (insertedRows || []).map((row: any) => ({
          routeHotspotId: Number(row?.route_hotspot_ID || 0) || null,
          hotspotOrder: Number(row?.hotspot_order || 0) || null,
          hotspotId: Number(row?.hotspot_ID || 0) || null,
        })),
      });
    }

    console.log('[ManualHotspotApply] validation result', {
      planId: Number(planId),
      routeId: Number(routeId),
      success,
      inserted,
      code: response.code || null,
      message: response.message || null,
      validation: response.validation,
    });

    return response;
  }


}
