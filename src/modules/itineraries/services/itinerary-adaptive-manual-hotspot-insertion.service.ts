// FILE: src/modules/itineraries/services/itinerary-adaptive-manual-hotspot-insertion.service.ts

import { Injectable } from '@nestjs/common';

type AdaptiveManualHotspotInsertionCallbacks = Record<string, (...args: any[]) => any>;
type ManualHotspotTimingPolicy = any;
type ManualOptimizerAttemptLog = any;

@Injectable()
export class ItineraryAdaptiveManualHotspotInsertionService {
  private readonly CONFIRMATION_REQUIRED_PRIORITY = 3;
  private callbacks: AdaptiveManualHotspotInsertionCallbacks = {};

  setCallbacks(callbacks: AdaptiveManualHotspotInsertionCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async runAdaptiveManualHotspotSetInsertion(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
    anchor?: {
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
      anchorIndex?: number;
      afterHotspotId?: number;
      beforeHotspotId?: number;
    },
    options?: {
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
      allowTopPriorityRemoval?: boolean;
      previewOnly?: boolean;
      exactAnchorMode?: boolean;
      trustedPreviewConfirmation?: boolean;
      afterHotspotId?: number;
      beforeHotspotId?: number;
      anchorLabel?: string | null;
      destinationInsertionMode?: boolean;
      destinationMinCandidateIndex?: number;
      sourceInsertionMode?: boolean;
      sourceMaxCandidateIndex?: number;
      manualTimingPolicy?: ManualHotspotTimingPolicy;
      preferredHotspotOrder?: number[];
    },
  ): Promise<{
    removedOptionalHotspots: Array<any>;
    removedTopPriorityHotspots: Array<any>;
    topPriorityAffected: Array<{ id: number; name: string; priority: number; reason: string }>;
    requiresConfirmation: boolean;
    requiresP3RemovalConfirmation?: boolean;
    p3HotspotsToRemove?: Array<any>;
    sameCityShuffleApplied?: boolean;
    sameCityShuffleOrder?: number[];
    scheduledHotspotIds: number[];
    unscheduledManualHotspots: Array<{ id: number; name: string; reason: string }>;
    shiftedHotspots: any[];
    deferredHotspots: any[];
    manualOptimizer?: ManualOptimizerAttemptLog;
    reason: string | null;
    slotInsights: Array<{
      slotOrder: number;
      candidateIndex: number;
      distanceDelta: number;
      proposedTimeRange: string | null;
      operatingHours: string | null;
      fitsTiming: boolean;
      fitsOverall: boolean;
      reason: string | null;
    }>;
    insertionMetrics: {
      labels: {
        distance: string;
        extraDetour: string;
        toAndFro: string;
      };
      values: {
        totalTravelKm: number;
        extraTravelKm: number;
        toAndFroPenalty: number;
        candidateIndex: number;
      };
    };
  }> {
 // See docs/manual-hotspot-reorder-and-removal-rules.md before changing exact-anchor Fit Here logic.
    const normalizedManualHotspotIds = this.callbacks.normalizeManualHotspotIds(manualHotspotIds);
    const allowP3Removal = options?.allowP3Removal === true;
    const allowProtectedPriorityRemoval =
      options?.allowP1P2Removal === true ||
      options?.allowTopPriorityRemoval === true;

    const allowTopPriorityRemoval = allowProtectedPriorityRemoval;
    const isPreviewOnly = options?.previewOnly === true;
    const isExactAnchorMode = options?.exactAnchorMode === true;
    const previewTimeBudgetMs = 15000;
    const startedAtMs = Date.now();
    const removedOptionalHotspots: Array<any> = [];
    const removedTopPriorityHotspots: Array<any> = [];
    const topPriorityAffected: Array<{ id: number; name: string; priority: number; reason: string }> = [];
    const simulatedRemovedHotspotIds = new Set<number>();
    const protectedAnchorHotspotIds = new Set<number>();

    const markCandidateRemovedForPreview = (candidate: any) => {
      const hotspotId = Number(candidate?.hotspotId || candidate?.id || candidate?.hotspot_ID || 0);
      if (hotspotId > 0) {
        simulatedRemovedHotspotIds.add(hotspotId);
      }
    };

    const filterSimulatedRemovedCandidates = (candidateState: any) => {
      const filterRows = (rows: any[] = []) =>
        rows.filter((row: any) => {
          const hotspotId = Number(row?.hotspotId || row?.id || row?.hotspot_ID || 0);
          return !(hotspotId > 0 && simulatedRemovedHotspotIds.has(hotspotId));
        });

      return {
        ...candidateState,
        hotspotRows: filterRows(candidateState?.hotspotRows || []),
        classified: {
          ...(candidateState?.classified || {}),
          p3ConfirmationCandidates: filterRows(candidateState?.classified?.p3ConfirmationCandidates || []),
          optionalFillers: filterRows(candidateState?.classified?.optionalFillers || []),
          strictTopPriority: filterRows(candidateState?.classified?.strictTopPriority || []),
          manualRequired: filterRows(candidateState?.classified?.manualRequired || []),
        },
      };
    };

    if (options?.exactAnchorMode === true) {
 // The first optimizer run already tries to preserve the clicked anchor literally.
 // After that fails, rescue is selected-hotspot-first: non-manual anchor/before rows
 // may be removed or repositioned by the normal manual/protected/priority policy.
      protectedAnchorHotspotIds.clear();
    }

    const baselineCandidates = await this.callbacks.buildRouteHotspotInsertionCandidates(
      tx,
      Number(planId),
      Number(routeId),
      normalizedManualHotspotIds,
    );
    const selectedManualHotspotNameForReason = String(
      (baselineCandidates?.hotspotMasters || [])
        .find((row: any) => normalizedManualHotspotIds.includes(Number(row?.hotspot_ID || 0)))?.hotspot_name
      || 'the selected manual hotspot',
    );

    const baselineTopPriorityByHotspotId = new Map<number, { id: number; name: string; priority: number }>();
    for (const row of [
      ...(baselineCandidates.classified.strictTopPriority || []),
    ]) {
      const hotspotId = Number(row?.hotspotId || 0);
      if (!Number.isFinite(hotspotId) || hotspotId <= 0) continue;
      if (baselineTopPriorityByHotspotId.has(hotspotId)) continue;
      baselineTopPriorityByHotspotId.set(hotspotId, {
        id: hotspotId,
        name: String(row?.name || `Hotspot #${hotspotId}`),
        priority: Number(row?.effectivePriority || row?.rawPriority || 0),
      });
    }

    let optimizerLog: ManualOptimizerAttemptLog = {
      decisionOrder: [],
      selectedStrategyKey: null,
      selectedStrategyLabel: null,
      summary: null,
      attempts: [],
    };

    const initialRun = await this.callbacks.runManualClusterOptimizer(
      tx,
      Number(planId),
      Number(routeId),
      normalizedManualHotspotIds,
      baselineCandidates,
      {
        allowP3Removal,
        allowP1P2Removal: allowProtectedPriorityRemoval,
        allowTopPriorityRemoval,
        previewOnly: isPreviewOnly,
        exactAnchorMode: isExactAnchorMode,
        anchorIntent: anchor?.anchorIntent,
        afterHotspotId: Number(anchor?.afterHotspotId || 0) || undefined,
        anchorType: anchor?.anchorType,
        anchorIndex: anchor?.anchorIndex,
        destinationInsertionMode: options?.destinationInsertionMode === true,
        destinationMinCandidateIndex: Number(options?.destinationMinCandidateIndex || 0) || undefined,
        sourceInsertionMode: options?.sourceInsertionMode === true,
        sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
        removedOptionalHotspots,
        removedTopPriorityHotspots,
        baselineTopPriorityByHotspotId,
        manualTimingPolicy: options?.manualTimingPolicy,
      },
    );
    let bestCandidate = initialRun.bestCandidate;
    optimizerLog = initialRun.optimizerLog;

    for (const row of bestCandidate.topPriorityAffected || []) {
      if (!topPriorityAffected.some((existing) => Number(existing.id) === Number(row.id))) {
        topPriorityAffected.push(row);
      }
    }

    if (bestCandidate.success && !bestCandidate.requiresConfirmation) {
      return {
        removedOptionalHotspots,
        removedTopPriorityHotspots,
        topPriorityAffected,
        requiresConfirmation: false,
        scheduledHotspotIds: (bestCandidate.scheduledManualHotspots || []).map((row: any) => Number(row.id)),
        unscheduledManualHotspots: bestCandidate.unscheduledManualHotspots || [],
        shiftedHotspots: [],
        deferredHotspots: removedTopPriorityHotspots,
        manualOptimizer: optimizerLog,
        reason: removedOptionalHotspots.length > 0
          ? 'Removed optional hotspots to fit manual hotspot batch.'
          : null,
        slotInsights: bestCandidate.slotInsights || [],
        insertionMetrics: this.callbacks.buildDistanceAndToFroLabels(bestCandidate),
      };
    }

    const currentCandidatesRaw = await this.callbacks.buildRouteHotspotInsertionCandidates(
      tx,
      Number(planId),
      Number(routeId),
      normalizedManualHotspotIds,
    );
    const currentCandidates = isPreviewOnly
      ? filterSimulatedRemovedCandidates(currentCandidatesRaw)
      : currentCandidatesRaw;

    const optionalCandidates = allowP3Removal
      ? [...(currentCandidates.classified.optionalFillers || [])]
      .filter((row: any) => {
        const hotspotId = Number(row?.hotspotId || row?.id || row?.hotspot_ID || 0);
        return (
          hotspotId > 0 &&
          !normalizedManualHotspotIds.includes(hotspotId) &&
          !protectedAnchorHotspotIds.has(hotspotId)
        );
      })
      .sort((a: any, b: any) => {
        const aPriority = this.callbacks.getEffectivePriorityForManualInsertion(a);
        const bPriority = this.callbacks.getEffectivePriorityForManualInsertion(b);
        const rankDiff = this.callbacks.mapOptionalRemovalPriority(aPriority) - this.callbacks.mapOptionalRemovalPriority(bPriority);
        if (rankDiff !== 0) return rankDiff;
        if (aPriority !== bPriority) return bPriority - aPriority;
        if (a.startTs !== b.startTs) return b.startTs - a.startTs;
        return b.routeHotspotId - a.routeHotspotId;
      })
      : [];

    for (const candidate of optionalCandidates) {
      if (isPreviewOnly && (Date.now() - startedAtMs) > previewTimeBudgetMs) {
        return {
          removedOptionalHotspots,
          removedTopPriorityHotspots,
          topPriorityAffected,
          requiresConfirmation: topPriorityAffected.length > 0,
          scheduledHotspotIds: (bestCandidate.scheduledManualHotspots || []).map((row: any) => Number(row.id)),
          unscheduledManualHotspots: bestCandidate.unscheduledManualHotspots || [],
          shiftedHotspots: [],
          deferredHotspots: [],
          reason: 'Preview timed out while exploring many hotspot replacement combinations. Please confirm force insert or refine selection.',
          slotInsights: bestCandidate.slotInsights || [],
          insertionMetrics: this.callbacks.buildDistanceAndToFroLabels(bestCandidate),
        };
      }

      if (isPreviewOnly) {
        markCandidateRemovedForPreview(candidate);
      } else {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            route_hotspot_ID: Number(candidate.routeHotspotId),
            itinerary_plan_ID: Number(planId),
            itinerary_route_ID: Number(routeId),
            deleted: 0,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });

        await this.callbacks.addRouteHotspotToExcludedList(tx, Number(routeId), Number(candidate.hotspotId));
      }
      const beforeRemovalCandidate: any = bestCandidate || {};
      const explainedCandidate = this.callbacks.enrichRemovedHotspotCandidateWithAttempt({
        candidate,
        attemptedTimeline: beforeRemovalCandidate?.fullTimeline || beforeRemovalCandidate?.rows || [],
        attemptedTimelineSource: isExactAnchorMode
          ? 'FAILED_BEFORE_REMOVAL'
          : 'UNKNOWN',
      });

      const refreshedCandidatesRaw = await this.callbacks.buildRouteHotspotInsertionCandidates(
        tx,
        Number(planId),
        Number(routeId),
        normalizedManualHotspotIds,
      );
      const refreshedCandidates = isPreviewOnly
        ? filterSimulatedRemovedCandidates(refreshedCandidatesRaw)
        : refreshedCandidatesRaw;
      const optionalRun = await this.callbacks.runManualClusterOptimizer(
        tx,
        Number(planId),
        Number(routeId),
        normalizedManualHotspotIds,
        refreshedCandidates,
        {
          allowP3Removal,
          allowP1P2Removal: allowProtectedPriorityRemoval,
          allowTopPriorityRemoval,
          previewOnly: isPreviewOnly,
          exactAnchorMode: isExactAnchorMode,
          anchorIntent: anchor?.anchorIntent,
          afterHotspotId: Number(anchor?.afterHotspotId || 0) || undefined,
          anchorType: anchor?.anchorType,
          anchorIndex: anchor?.anchorIndex,
          destinationInsertionMode: options?.destinationInsertionMode === true,
          destinationMinCandidateIndex: Number(options?.destinationMinCandidateIndex || 0) || undefined,
          sourceInsertionMode: options?.sourceInsertionMode === true,
          sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
          removedOptionalHotspots,
          removedTopPriorityHotspots,
          baselineTopPriorityByHotspotId,
          manualTimingPolicy: options?.manualTimingPolicy,
        },
      );
      bestCandidate = optionalRun.bestCandidate;
      optimizerLog = {
        ...optionalRun.optimizerLog,
        attempts: [...(optimizerLog.attempts || []), ...(optionalRun.optimizerLog.attempts || [])],
      };
      const beforeOverflowMinutes = Number(beforeRemovalCandidate?.routeEndOverflowMinutes || 0);
      const afterOverflowMinutes = Number(bestCandidate?.routeEndOverflowMinutes || 0);
      const beforeOpeningConflictCount = Number(beforeRemovalCandidate?.openingHourConflictCount || 0);
      const afterOpeningConflictCount = Number(bestCandidate?.openingHourConflictCount || 0);
      const removalImprovedFeasibility =
        bestCandidate?.success === true ||
        afterOverflowMinutes < beforeOverflowMinutes ||
        afterOpeningConflictCount < beforeOpeningConflictCount;

      let candidateReasonCode:
        | 'ROUTE_END_OVERFLOW'
        | 'OPENING_HOURS_CONFLICT'
        | 'LOWER_PRIORITY_REMOVAL_REQUIRED'
        | 'UNPROVEN_REMOVAL'
        | 'UNKNOWN' = 'UNKNOWN';

      if (beforeOverflowMinutes > 0 && afterOverflowMinutes < beforeOverflowMinutes) {
        candidateReasonCode = 'ROUTE_END_OVERFLOW';
      } else if (beforeOpeningConflictCount > 0 && afterOpeningConflictCount < beforeOpeningConflictCount) {
        candidateReasonCode = 'OPENING_HOURS_CONFLICT';
      } else if (removalImprovedFeasibility) {
        candidateReasonCode = 'LOWER_PRIORITY_REMOVAL_REQUIRED';
      } else {
        candidateReasonCode = 'UNPROVEN_REMOVAL';
      }

      removedOptionalHotspots.push({
        ...this.callbacks.buildRemovedHotspotExplanation({
          row: {
            ...explainedCandidate,
            routeEndOverflowBeforeRemoval: beforeOverflowMinutes,
            routeEndOverflowAfterRemoval: afterOverflowMinutes,
            openingHourConflictCountBeforeRemoval: beforeOpeningConflictCount,
            openingHourConflictCountAfterRemoval: afterOpeningConflictCount,
            removalImprovedFeasibility,
          },
          priority: Number(candidate.effectivePriority || candidate.rawPriority || 0),
          removalStage: 'OPTIONAL',
          reasonCode: candidateReasonCode,
          manualHotspotName: selectedManualHotspotNameForReason,
          anchorLabel: options?.anchorLabel || null,
          routeEndOverflowMinutes: beforeOverflowMinutes,
          openingHourConflictCount: beforeOpeningConflictCount,
        }),
        routeEndOverflowBeforeRemoval: beforeOverflowMinutes,
        routeEndOverflowAfterRemoval: afterOverflowMinutes,
        openingHourConflictCountBeforeRemoval: beforeOpeningConflictCount,
        openingHourConflictCountAfterRemoval: afterOpeningConflictCount,
        removalImprovedFeasibility,
      });

      for (const row of bestCandidate.topPriorityAffected || []) {
        if (!topPriorityAffected.some((existing) => Number(existing.id) === Number(row.id))) {
          topPriorityAffected.push(row);
        }
      }

      if (bestCandidate.success && !bestCandidate.requiresConfirmation) {
        return {
          removedOptionalHotspots,
          removedTopPriorityHotspots,
          topPriorityAffected,
          requiresConfirmation: false,
          scheduledHotspotIds: (bestCandidate.scheduledManualHotspots || []).map((row: any) => Number(row.id)),
          unscheduledManualHotspots: bestCandidate.unscheduledManualHotspots || [],
          shiftedHotspots: [],
          deferredHotspots: removedTopPriorityHotspots,
          manualOptimizer: optimizerLog,
          reason: 'Removed optional hotspots to fit manual hotspot batch.',
          slotInsights: bestCandidate.slotInsights || [],
          insertionMetrics: this.callbacks.buildDistanceAndToFroLabels(bestCandidate),
        };
      }
    }

    const p3HotspotsToRemove = allowP3Removal
      ? [...(currentCandidates.classified.p3ConfirmationCandidates || [])]
      .filter((row: any) => {
        const hotspotId = Number(row?.hotspotId || row?.id || row?.hotspot_ID || 0);
        return (
          hotspotId > 0 &&
          !normalizedManualHotspotIds.includes(hotspotId) &&
          !protectedAnchorHotspotIds.has(hotspotId)
        );
      })
      .map((row: any) => {
        const explainedRow = this.callbacks.enrichRemovedHotspotCandidateWithAttempt({
          candidate: row,
          attemptedTimeline: bestCandidate?.fullTimeline || bestCandidate?.rows || [],
          attemptedTimelineSource: isExactAnchorMode
            ? 'EXACT_ANCHOR_SEQUENTIAL_REBUILD'
            : 'UNKNOWN',
        });

        return this.callbacks.buildRemovedHotspotExplanation({
          row: explainedRow,
          priority: this.CONFIRMATION_REQUIRED_PRIORITY,
          removalStage: 'P3_FIRST',
          reasonCode: 'MANUAL_HOTSPOT_TIME_WINDOW',
          manualHotspotName: selectedManualHotspotNameForReason,
          anchorLabel: options?.anchorLabel || null,
          routeEndOverflowMinutes: Number(bestCandidate?.routeEndOverflowMinutes || 0),
          openingHourConflictCount: Number(bestCandidate?.openingHourConflictCount || 0),
        });
      })
      : [];

    const p3ConfirmedCandidates = allowP3Removal
      ? [...(currentCandidates.classified.p3ConfirmationCandidates || [])]
      .filter((row: any) => {
        const hotspotId = Number(row?.hotspotId || row?.id || row?.hotspot_ID || 0);
        return (
          hotspotId > 0 &&
          !normalizedManualHotspotIds.includes(hotspotId) &&
          !protectedAnchorHotspotIds.has(hotspotId)
        );
      })
      .sort((a: any, b: any) => {
        if (b.effectivePriority !== a.effectivePriority) {
          return b.effectivePriority - a.effectivePriority;
        }
        if (b.startTs !== a.startTs) {
          return b.startTs - a.startTs;
        }
        return b.routeHotspotId - a.routeHotspotId;
      })
      : [];

    for (const candidate of p3ConfirmedCandidates) {
      if (isPreviewOnly) {
        markCandidateRemovedForPreview(candidate);
      } else {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            route_hotspot_ID: Number(candidate.routeHotspotId),
            itinerary_plan_ID: Number(planId),
            itinerary_route_ID: Number(routeId),
            deleted: 0,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });

        await this.callbacks.addRouteHotspotToExcludedList(tx, Number(routeId), Number(candidate.hotspotId));
      }
      const beforeRemovalCandidate: any = bestCandidate || {};
      const explainedCandidate = this.callbacks.enrichRemovedHotspotCandidateWithAttempt({
        candidate,
        attemptedTimeline: beforeRemovalCandidate?.fullTimeline || beforeRemovalCandidate?.rows || [],
        attemptedTimelineSource: isExactAnchorMode
          ? 'FAILED_BEFORE_REMOVAL'
          : 'UNKNOWN',
      });

      const refreshedCandidatesRaw = await this.callbacks.buildRouteHotspotInsertionCandidates(
        tx,
        Number(planId),
        Number(routeId),
        normalizedManualHotspotIds,
      );
      const refreshedCandidates = isPreviewOnly
        ? filterSimulatedRemovedCandidates(refreshedCandidatesRaw)
        : refreshedCandidatesRaw;
      const p3Run = await this.callbacks.runManualClusterOptimizer(
        tx,
        Number(planId),
        Number(routeId),
        normalizedManualHotspotIds,
        refreshedCandidates,
        {
          allowP3Removal,
          allowP1P2Removal: allowProtectedPriorityRemoval,
          allowTopPriorityRemoval,
          previewOnly: isPreviewOnly,
          exactAnchorMode: isExactAnchorMode,
          anchorIntent: anchor?.anchorIntent,
          afterHotspotId: Number(anchor?.afterHotspotId || 0) || undefined,
          anchorType: anchor?.anchorType,
          anchorIndex: anchor?.anchorIndex,
          destinationInsertionMode: options?.destinationInsertionMode === true,
          destinationMinCandidateIndex: Number(options?.destinationMinCandidateIndex || 0) || undefined,
          sourceInsertionMode: options?.sourceInsertionMode === true,
          sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
          removedOptionalHotspots,
          removedTopPriorityHotspots,
          baselineTopPriorityByHotspotId,
          manualTimingPolicy: options?.manualTimingPolicy,
        },
      );
      bestCandidate = p3Run.bestCandidate;
      optimizerLog = {
        ...p3Run.optimizerLog,
        attempts: [...(optimizerLog.attempts || []), ...(p3Run.optimizerLog.attempts || [])],
      };
      const beforeOverflowMinutes = Number(beforeRemovalCandidate?.routeEndOverflowMinutes || 0);
      const afterOverflowMinutes = Number(bestCandidate?.routeEndOverflowMinutes || 0);
      const beforeOpeningConflictCount = Number(beforeRemovalCandidate?.openingHourConflictCount || 0);
      const afterOpeningConflictCount = Number(bestCandidate?.openingHourConflictCount || 0);
      const removalImprovedFeasibility =
        bestCandidate?.success === true ||
        afterOverflowMinutes < beforeOverflowMinutes ||
        afterOpeningConflictCount < beforeOpeningConflictCount;

      let candidateReasonCode:
        | 'ROUTE_END_OVERFLOW'
        | 'OPENING_HOURS_CONFLICT'
        | 'LOWER_PRIORITY_REMOVAL_REQUIRED'
        | 'UNPROVEN_REMOVAL'
        | 'UNKNOWN' = 'UNKNOWN';

      if (beforeOverflowMinutes > 0 && afterOverflowMinutes < beforeOverflowMinutes) {
        candidateReasonCode = 'ROUTE_END_OVERFLOW';
      } else if (beforeOpeningConflictCount > 0 && afterOpeningConflictCount < beforeOpeningConflictCount) {
        candidateReasonCode = 'OPENING_HOURS_CONFLICT';
      } else if (removalImprovedFeasibility) {
        candidateReasonCode = 'LOWER_PRIORITY_REMOVAL_REQUIRED';
      } else {
        candidateReasonCode = 'UNPROVEN_REMOVAL';
      }

      removedOptionalHotspots.push({
        ...this.callbacks.buildRemovedHotspotExplanation({
          row: {
            ...explainedCandidate,
            routeEndOverflowBeforeRemoval: beforeOverflowMinutes,
            routeEndOverflowAfterRemoval: afterOverflowMinutes,
            openingHourConflictCountBeforeRemoval: beforeOpeningConflictCount,
            openingHourConflictCountAfterRemoval: afterOpeningConflictCount,
            removalImprovedFeasibility,
          },
          priority: Number(candidate.effectivePriority || candidate.rawPriority || 0),
          removalStage: 'P3_FIRST',
          reasonCode: candidateReasonCode,
          manualHotspotName: selectedManualHotspotNameForReason,
          anchorLabel: options?.anchorLabel || null,
          routeEndOverflowMinutes: beforeOverflowMinutes,
          openingHourConflictCount: beforeOpeningConflictCount,
        }),
        routeEndOverflowBeforeRemoval: beforeOverflowMinutes,
        routeEndOverflowAfterRemoval: afterOverflowMinutes,
        openingHourConflictCountBeforeRemoval: beforeOpeningConflictCount,
        openingHourConflictCountAfterRemoval: afterOpeningConflictCount,
        removalImprovedFeasibility,
      });

      for (const row of bestCandidate.topPriorityAffected || []) {
        if (!topPriorityAffected.some((existing) => Number(existing.id) === Number(row.id))) {
          topPriorityAffected.push(row);
        }
      }

      if (bestCandidate.success) {
        return {
          removedOptionalHotspots,
          removedTopPriorityHotspots,
          topPriorityAffected,
          requiresConfirmation: false,
          requiresP3RemovalConfirmation: false,
          p3HotspotsToRemove,
          scheduledHotspotIds: (bestCandidate.scheduledManualHotspots || []).map((row: any) => Number(row.id)),
          unscheduledManualHotspots: bestCandidate.unscheduledManualHotspots || [],
          shiftedHotspots: [],
          deferredHotspots: removedTopPriorityHotspots,
          manualOptimizer: optimizerLog,
          reason: 'Removed P3 hotspots to fit manual hotspot batch.',
          slotInsights: bestCandidate.slotInsights || [],
          insertionMetrics: this.callbacks.buildDistanceAndToFroLabels(bestCandidate),
        };
      }
    }

    const shouldExploreProtectedPriorityRemovals =
      allowTopPriorityRemoval === true;

    if (shouldExploreProtectedPriorityRemovals) {
      const removablePriorityOrder = [2, 1];

      for (const priorityLevel of removablePriorityOrder) {
        let priorityCandidatesStateRaw = await this.callbacks.buildRouteHotspotInsertionCandidates(
          tx,
          Number(planId),
          Number(routeId),
          normalizedManualHotspotIds,
        );
        let priorityCandidatesState = isPreviewOnly
          ? filterSimulatedRemovedCandidates(priorityCandidatesStateRaw)
          : priorityCandidatesStateRaw;
        const priorityCandidates = [...(priorityCandidatesState.classified.strictTopPriority || [])]
          .filter((row: any) => Number(row?.effectivePriority || row?.rawPriority || 0) === priorityLevel)
          .filter((row: any) => {
            const hotspotId = Number(row?.hotspotId || row?.id || row?.hotspot_ID || 0);
            return (
              hotspotId > 0 &&
              !normalizedManualHotspotIds.includes(hotspotId) &&
              !protectedAnchorHotspotIds.has(hotspotId)
            );
          })
          .sort((a: any, b: any) => {
            if (b.startTs !== a.startTs) return b.startTs - a.startTs;
            return b.routeHotspotId - a.routeHotspotId;
          });

        for (const candidate of priorityCandidates) {
          if (isPreviewOnly) {
            markCandidateRemovedForPreview(candidate);
          } else {
            await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
              where: {
                route_hotspot_ID: Number(candidate.routeHotspotId),
                itinerary_plan_ID: Number(planId),
                itinerary_route_ID: Number(routeId),
                deleted: 0,
              },
              data: {
                deleted: 1,
                status: 0,
                updatedon: new Date(),
              },
            });

            await this.callbacks.addRouteHotspotToExcludedList(tx, Number(routeId), Number(candidate.hotspotId));
          }
          const beforeRemovalCandidate: any = bestCandidate || {};
          const explainedCandidate = this.callbacks.enrichRemovedHotspotCandidateWithAttempt({
            candidate,
            attemptedTimeline: beforeRemovalCandidate?.fullTimeline || beforeRemovalCandidate?.rows || [],
            attemptedTimelineSource: isExactAnchorMode
              ? 'FAILED_BEFORE_REMOVAL'
              : 'UNKNOWN',
          });

          priorityCandidatesStateRaw = await this.callbacks.buildRouteHotspotInsertionCandidates(
            tx,
            Number(planId),
            Number(routeId),
            normalizedManualHotspotIds,
          );
          priorityCandidatesState = isPreviewOnly
            ? filterSimulatedRemovedCandidates(priorityCandidatesStateRaw)
            : priorityCandidatesStateRaw;
          const priorityRun = await this.callbacks.runManualClusterOptimizer(
            tx,
            Number(planId),
            Number(routeId),
            normalizedManualHotspotIds,
            priorityCandidatesState,
            {
              allowP3Removal,
              allowP1P2Removal: allowProtectedPriorityRemoval,
              allowTopPriorityRemoval,
              previewOnly: isPreviewOnly,
              exactAnchorMode: isExactAnchorMode,
              anchorIntent: anchor?.anchorIntent,
              afterHotspotId: Number(anchor?.afterHotspotId || 0) || undefined,
              anchorType: anchor?.anchorType,
              anchorIndex: anchor?.anchorIndex,
              destinationInsertionMode: options?.destinationInsertionMode === true,
              destinationMinCandidateIndex: Number(options?.destinationMinCandidateIndex || 0) || undefined,
              sourceInsertionMode: options?.sourceInsertionMode === true,
              sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
              removedOptionalHotspots,
              removedTopPriorityHotspots,
              baselineTopPriorityByHotspotId,
              manualTimingPolicy: options?.manualTimingPolicy,
            },
          );
          bestCandidate = priorityRun.bestCandidate;
          optimizerLog = {
            ...priorityRun.optimizerLog,
            attempts: [...(optimizerLog.attempts || []), ...(priorityRun.optimizerLog.attempts || [])],
          };
          const beforeOverflowMinutes = Number(beforeRemovalCandidate?.routeEndOverflowMinutes || 0);
          const afterOverflowMinutes = Number(bestCandidate?.routeEndOverflowMinutes || 0);
          const beforeOpeningConflictCount = Number(beforeRemovalCandidate?.openingHourConflictCount || 0);
          const afterOpeningConflictCount = Number(bestCandidate?.openingHourConflictCount || 0);
          const removalImprovedFeasibility =
            bestCandidate?.success === true ||
            afterOverflowMinutes < beforeOverflowMinutes ||
            afterOpeningConflictCount < beforeOpeningConflictCount;

          let candidateReasonCode:
            | 'ROUTE_END_OVERFLOW'
            | 'OPENING_HOURS_CONFLICT'
            | 'LOWER_PRIORITY_REMOVAL_REQUIRED'
            | 'UNPROVEN_REMOVAL'
            | 'UNKNOWN' = 'UNKNOWN';

          if (beforeOverflowMinutes > 0 && afterOverflowMinutes < beforeOverflowMinutes) {
            candidateReasonCode = 'ROUTE_END_OVERFLOW';
          } else if (beforeOpeningConflictCount > 0 && afterOpeningConflictCount < beforeOpeningConflictCount) {
            candidateReasonCode = 'OPENING_HOURS_CONFLICT';
          } else if (removalImprovedFeasibility) {
            candidateReasonCode = 'LOWER_PRIORITY_REMOVAL_REQUIRED';
          } else {
            candidateReasonCode = 'UNPROVEN_REMOVAL';
          }

          removedTopPriorityHotspots.push({
            ...this.callbacks.buildRemovedHotspotExplanation({
              row: {
                ...explainedCandidate,
                routeEndOverflowBeforeRemoval: beforeOverflowMinutes,
                routeEndOverflowAfterRemoval: afterOverflowMinutes,
                openingHourConflictCountBeforeRemoval: beforeOpeningConflictCount,
                openingHourConflictCountAfterRemoval: afterOpeningConflictCount,
                removalImprovedFeasibility,
              },
              priority: Number(candidate.effectivePriority || candidate.rawPriority || priorityLevel),
              removalStage: priorityLevel === 2 ? 'P2_AFTER_P3' : 'P1_AFTER_P3_P2',
              reasonCode: candidateReasonCode,
              manualHotspotName: selectedManualHotspotNameForReason,
              anchorLabel: options?.anchorLabel || null,
              routeEndOverflowMinutes: beforeOverflowMinutes,
              openingHourConflictCount: beforeOpeningConflictCount,
            }),
            routeEndOverflowBeforeRemoval: beforeOverflowMinutes,
            routeEndOverflowAfterRemoval: afterOverflowMinutes,
            openingHourConflictCountBeforeRemoval: beforeOpeningConflictCount,
            openingHourConflictCountAfterRemoval: afterOpeningConflictCount,
            removalImprovedFeasibility,
          });

          for (const row of bestCandidate.topPriorityAffected || []) {
            if (!topPriorityAffected.some((existing) => Number(existing.id) === Number(row.id))) {
              topPriorityAffected.push(row);
            }
          }

          if (bestCandidate.success) {
            return {
              removedOptionalHotspots,
              removedTopPriorityHotspots,
              topPriorityAffected,
              requiresConfirmation: allowTopPriorityRemoval ? false : removedTopPriorityHotspots.length > 0,
              requiresP3RemovalConfirmation: false,
              p3HotspotsToRemove,
              scheduledHotspotIds: (bestCandidate.scheduledManualHotspots || []).map((row: any) => Number(row.id)),
              unscheduledManualHotspots: bestCandidate.unscheduledManualHotspots || [],
              shiftedHotspots: [],
              deferredHotspots: removedTopPriorityHotspots,
              manualOptimizer: optimizerLog,
              reason: `Removed priority hotspots in reverse order up to P${priorityLevel} to fit manual hotspot batch.`,
              slotInsights: bestCandidate.slotInsights || [],
              insertionMetrics: this.callbacks.buildDistanceAndToFroLabels(bestCandidate),
            };
          }
        }
      }
    }

    return {
      removedOptionalHotspots,
      removedTopPriorityHotspots,
      topPriorityAffected,
      requiresConfirmation: false,
      requiresP3RemovalConfirmation: false,
      p3HotspotsToRemove,
      scheduledHotspotIds: (bestCandidate.scheduledManualHotspots || []).map((row: any) => Number(row.id)),
      unscheduledManualHotspots: bestCandidate.unscheduledManualHotspots || [],
      shiftedHotspots: [],
      deferredHotspots: removedTopPriorityHotspots,
      manualOptimizer: optimizerLog,
      reason: bestCandidate.reason || 'Selected manual hotspots still do not fit after exhausting removable hotspots.',
      slotInsights: bestCandidate.slotInsights || [],
      insertionMetrics: this.callbacks.buildDistanceAndToFroLabels(bestCandidate),
    };
  }


}

