export function buildManualFitAttemptLogImpl(this: any, previewResult: any): any[] {
  const validation = previewResult?.validation || {};
  const resolution = previewResult?.resolution || {};
  const manualFit = previewResult?.manualInsertionFit || resolution?.manualInsertionFit || {};
  const chosenSlot = manualFit?.chosenSlot || manualFit?.bestSlot || null;

  const removedOptional = Array.isArray(resolution?.removedOptionalHotspots)
    ? resolution.removedOptionalHotspots
    : [];

  const removedTopPriority = Array.isArray(resolution?.removedTopPriorityHotspots)
    ? resolution.removedTopPriorityHotspots
    : [];

  const shiftedHotspots = Array.isArray(resolution?.shiftedHotspots)
    ? resolution.shiftedHotspots
    : [];

  const affectedPriority = Array.isArray(resolution?.topPriorityAffected)
    ? resolution.topPriorityAffected
    : [];

  const p3ToRemove = Array.isArray(resolution?.p3HotspotsToRemove)
    ? resolution.p3HotspotsToRemove
    : [];

  const canApply = validation?.readyToApply === true;

  const logs: any[] = [
    {
      id: 'timeline_loaded',
      label: 'Current timeline loaded',
      status: 'passed',
      message: 'Existing itinerary rows were loaded for this route.',
    },
    {
      id: 'anchor_resolved',
      label: 'Insertion position resolved',
      status: chosenSlot || validation ? 'passed' : 'warning',
      message: chosenSlot
        ? 'The selected Fit Here position was resolved against the route timeline.'
        : 'The selected position was evaluated, but no exact route-fit slot was selected.',
      details: chosenSlot
        ? {
            fromHotspotId: chosenSlot.fromHotspotId || null,
            toHotspotId: chosenSlot.toHotspotId || null,
            slotIndex: chosenSlot.slotIndex ?? null,
          }
        : undefined,
    },
    {
      id: 'travel_checked',
      label: 'Travel time checked',
      status: chosenSlot ? 'passed' : 'warning',
      message: chosenSlot
        ? 'Travel time before and after the selected hotspot was evaluated.'
        : 'Travel timing could not produce a clean feasible slot.',
    },
    {
      id: 'opening_hours_checked',
      label: 'Opening and closing hours checked',
      status: canApply ? 'passed' : 'warning',
      message: String(
        validation?.reason ||
          previewResult?.message ||
          'Opening, closing, visit duration, and arrival feasibility were evaluated.',
      ),
    },
    {
      id: 'priority_protection',
      label: 'Priority protection checked',
      status: affectedPriority.length > 0 ? 'failed' : (removedTopPriority.length > 0 ? 'warning' : 'passed'),
      message:
        affectedPriority.length > 0
          ? 'One or more protected high work-priority hotspots would be removed or become invalid.'
          : removedTopPriority.length > 0
            ? 'One or more high work-priority hotspots would be removed only with explicit confirmation.'
            : 'No high work-priority hotspot is removed or invalidated by this insertion.',
      details: {
        affectedPriorityCount: affectedPriority.length,
        removedTopPriorityCount: removedTopPriority.length,
      },
    },
    {
      id: 'shifted_hotspots',
      label: 'Shifted hotspots checked',
      status: shiftedHotspots.length > 0 ? 'warning' : 'passed',
      message:
        shiftedHotspots.length > 0
          ? `${shiftedHotspots.length} hotspot(s) may be shifted later but remain part of the proposed timeline.`
          : 'No existing hotspot needs to be shifted.',
      details: {
        shiftedCount: shiftedHotspots.length,
      },
    },
    {
      id: 'optional_removal',
      label: 'Optional hotspot removal checked',
      status: removedOptional.length > 0 || p3ToRemove.length > 0 ? 'warning' : 'passed',
      message:
        removedOptional.length > 0 || p3ToRemove.length > 0
          ? 'One or more optional or lower-priority hotspots may need removal to keep the route feasible.'
          : 'No optional hotspot removal is required.',
      details: {
        removedOptionalCount: removedOptional.length,
        p3ToRemoveCount: p3ToRemove.length,
      },
    },
    {
      id: 'route_end_validation',
      label: 'Route end and hotel timing checked',
      status: canApply ? 'passed' : 'warning',
      message: canApply
        ? 'The proposed route can be applied within the validated timing rules.'
        : 'The proposed route could not be safely confirmed with the current timing rules.',
    },
    {
      id: 'final_preview',
      label: 'Final preview prepared',
      status: canApply ? 'passed' : 'failed',
      message: canApply
        ? 'A confirmable Fit Here preview was prepared.'
        : 'A non-confirmable preview was prepared with rejection details.',
    },
  ];

  const selectedStrategyKey = String(resolution?.manualOptimizer?.selectedStrategyKey || '');
  const attemptRowsRaw = Array.isArray(resolution?.manualOptimizer?.attempts)
    ? resolution.manualOptimizer.attempts
    : [];
  const attemptRows = attemptRowsRaw.map((row: any) => {
    if (
      selectedStrategyKey === 'exact_anchor_sequential_rebuild' &&
      String(row?.strategyKey || '') === 'exact_anchor_sequential_rebuild'
    ) {
      return {
        ...row,
        source: 'REAL_CLUSTER_SIMULATION',
        readyToApply: canApply,
        requiresConfirmation: false,
        summary: canApply
          ? 'Exact-anchor sequential rebuild preserved the selected insertion order and produced the final preview timeline.'
          : String(validation?.reason || row?.summary || row?.reason || 'Exact-anchor sequential rebuild could not be confirmed.'),
        reason: canApply
          ? 'Exact-anchor sequential rebuild matched the authoritative final preview timeline.'
          : String(validation?.reason || row?.reason || 'Exact-anchor sequential rebuild could not be confirmed.'),
      };
    }

    return row;
  });

  const attemptLogs: any[] = attemptRows.slice(0, 6).map((row: any, index: number) => ({
    id: `optimizer_attempt_${index + 1}`,
    label: String(row?.strategyLabel || row?.strategyKey || `Optimizer attempt ${index + 1}`),
    status: row?.readyToApply === true
      ? 'passed'
      : row?.requiresConfirmation === true
        ? 'warning'
        : 'failed',
    message: String(row?.summary || row?.reason || 'Schedule attempt evaluated.'),
    details: {
      readyToApply: row?.readyToApply === true,
      requiresConfirmation: row?.requiresConfirmation === true,
    },
  }));

  return [...logs, ...attemptLogs];
}

export async function buildManualFitPreviewEnvelopeImpl(this: any, params: any) {
  const resolution = params.previewResult?.resolution || {};
  const validation = params.previewResult?.validation || resolution?.validation || {};
  const removedOptional = Array.isArray(resolution?.removedOptionalHotspots)
    ? resolution.removedOptionalHotspots
    : [];
  const removedTopPriority = Array.isArray(resolution?.removedTopPriorityHotspots)
    ? resolution.removedTopPriorityHotspots
    : [];
  const p3Hotspots = Array.isArray(resolution?.p3HotspotsToRemove)
    ? resolution.p3HotspotsToRemove
    : [];
  const topPriorityAffected = Array.isArray(resolution?.topPriorityAffected)
    ? resolution.topPriorityAffected
    : [];
  const removedHotspotsRaw = Array.isArray(resolution?.removedHotspots)
    ? resolution.removedHotspots
    : [];
  const selectedAnchor = params.selectedAnchor || null;
  const manualInsertionFit =
    selectedAnchor?.exactSelectedGap === true && params.previewResult?.manualInsertionFit
      ? this.normalizeExactAnchorManualInsertionFit({
          manualInsertionFit: params.previewResult.manualInsertionFit,
          anchorIntent: selectedAnchor?.anchorIntent,
          afterHotspotId: selectedAnchor?.afterHotspotId ?? null,
          beforeHotspotId: selectedAnchor?.beforeHotspotId ?? null,
          anchorLabel: params.anchorLabel || selectedAnchor?.anchorLabel || null,
        })
      : (params.previewResult?.manualInsertionFit || resolution?.manualInsertionFit || null);
  const dayEndPlan = manualInsertionFit?.lowPriorityRemovalPlanPreview || null;
  const openingHoursPlan = manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview || null;
  const resolvedLowPriorityRemovedHotspots = Array.isArray(manualInsertionFit?.removedLowPriorityHotspots)
    ? manualInsertionFit.removedLowPriorityHotspots
    : [];

  const plannedSequentialRemovals = [
    ...resolvedLowPriorityRemovedHotspots,
    ...(dayEndPlan?.resolved === true && Array.isArray(dayEndPlan?.plannedRemovals)
      ? dayEndPlan.plannedRemovals
      : []),
    ...(openingHoursPlan?.resolved === true && Array.isArray(openingHoursPlan?.plannedRemovals)
      ? openingHoursPlan.plannedRemovals
      : []),
  ];

  const unsafeMergedRemovalRows = [
    ...removedHotspotsRaw,
    ...removedOptional,
    ...p3Hotspots,
    ...removedTopPriority,
    ...resolvedLowPriorityRemovedHotspots,
    ...plannedSequentialRemovals,
  ];
  const removedHotspots = this.sanitizeUserFacingManualFitRemovals(unsafeMergedRemovalRows, {
    routeId: params.routeId,
    selectedHotspotId: params.selectedHotspotId,
    activeRemovalEvidence: params.activeRemovalEvidence,
  });
  const safeRemovedOptional = this.sanitizeUserFacingManualFitRemovals(removedOptional, {
    routeId: params.routeId,
    selectedHotspotId: params.selectedHotspotId,
    activeRemovalEvidence: params.activeRemovalEvidence,
  });
  const safeRemovedTopPriority = this.sanitizeUserFacingManualFitRemovals(removedTopPriority, {
    routeId: params.routeId,
    selectedHotspotId: params.selectedHotspotId,
    activeRemovalEvidence: params.activeRemovalEvidence,
  });
  const safeP3Hotspots = this.sanitizeUserFacingManualFitRemovals(p3Hotspots, {
    routeId: params.routeId,
    selectedHotspotId: params.selectedHotspotId,
    activeRemovalEvidence: params.activeRemovalEvidence,
  });
  const safeSequentialRemovals = this.sanitizeUserFacingManualFitRemovals(plannedSequentialRemovals, {
    routeId: params.routeId,
    selectedHotspotId: params.selectedHotspotId,
    activeRemovalEvidence: params.activeRemovalEvidence,
  });
  const affectedPriorityHotspots = this.sanitizeUserFacingManualFitRemovals([
    ...topPriorityAffected,
    ...removedTopPriority,
  ], {
    routeId: params.routeId,
    selectedHotspotId: params.selectedHotspotId,
    activeRemovalEvidence: params.activeRemovalEvidence,
  }).filter((row: any, index: number, list: any[]) => {
    const priority = Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 0);
    const id = this.getManualFitRemovalHotspotId(row);

    if (priority > 2 && safeRemovedTopPriority.length === 0) {
      return false;
    }

    if (!id) return true;

    return list.findIndex((candidate: any) => (
      Number(candidate?.id || candidate?.hotspotId || candidate?.hotspot_ID || 0) === id
    )) === index;
  });
  const timingRisk = resolution?.timingRisk || params.previewResult?.timingRisk || null;
  const removedPrioritySummary = this.buildRemovedPrioritySummary(removedHotspots);
  const changesRequiredDisplay = this.buildManualFitChangesRequiredDisplay({
    removedHotspots,
    affectedPriorityHotspots,
    removedPrioritySummary,
  });
  const highestSequentialRemovedPriority = safeSequentialRemovals.reduce((highest: number, row: any) => {
    const priority = Number(row?.priority || row?.hotspotPriority || row?.hotspot_priority || 0);
    if (!priority) return highest;
    return highest === 0 ? priority : Math.min(highest, priority);
  }, 0);
  const hasSequentialP1P2Removal =
    safeSequentialRemovals.some((row: any) => [1, 2].includes(Number(row?.priority || row?.hotspotPriority || row?.hotspot_priority || 0)));
  if (safeSequentialRemovals.length > 0) {
    removedPrioritySummary.removalOrder = safeSequentialRemovals
      .map((row: any) => Number(row?.priority || row?.hotspotPriority || row?.hotspot_priority || 0))
      .filter((priority: number) => priority > 0);

    removedPrioritySummary.requiresPriorityRemovalConfirmation = true;
    removedPrioritySummary.severity = hasSequentialP1P2Removal ? 'danger' : 'warning';
    removedPrioritySummary.message = hasSequentialP1P2Removal
      ? 'This Fit Here requires removing high work-priority hotspot(s). Review carefully before confirming.'
      : 'This Fit Here requires removing Priority 3 hotspot(s). Please confirm before applying.';

    if (highestSequentialRemovedPriority > 0) {
      removedPrioritySummary.highestRemovedPriority = highestSequentialRemovedPriority;
    }
  }

  let resultType:
    | 'FITS_DIRECTLY'
    | 'FITS_WITH_OPTIONAL_REMOVAL'
    | 'REQUIRES_P3_CONFIRMATION'
    | 'PRIORITY_CONFLICT'
    | 'CANNOT_FIT'
    | 'CONFLICT_ONLY'
    | 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME' = 'CANNOT_FIT';
  let canConfirm = false;

  const readyToApply =
    validation?.readyToApply === true ||
    resolution?.validation?.readyToApply === true ||
    params.previewResult?.readyToApply === true ||
    params.previewResult?.success === true ||
    params.previewResult?.inserted === true;

  const hasPriorityConflict =
    affectedPriorityHotspots.length > 0 ||
    safeRemovedTopPriority.length > 0;

  const hasOptionalRemoval =
    safeRemovedOptional.length > 0 ||
    safeP3Hotspots.length > 0 ||
    removedHotspots.some((row: any) => {
      const priority = Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 0);
      return priority >= 3 || priority === 0;
    });
  const hasRemovalChanges =
    removedHotspots.length > 0 ||
    safeSequentialRemovals.length > 0;

  const requiresTimingRiskConfirmation =
    resolution?.requiresTimingRiskConfirmation === true
    || params.previewResult?.requiresTimingRiskConfirmation === true
    || !!timingRisk;
  const requiresPriorityRemovalConfirmation =
    removedPrioritySummary.requiresPriorityRemovalConfirmation === true;
  const allowClosedHotspotForceConflict = true;
  const selectedOpeningConflict =
    validation?.selectedOpeningConflict ||
    resolution?.validation?.selectedOpeningConflict ||
    manualInsertionFit?.selectedOpeningConflict ||
    null;
  const hasSelectedOpeningConflict =
    !!selectedOpeningConflict ||
    (
      !readyToApply &&
      String(manualInsertionFit?.previewBlockReason || '').toUpperCase() === 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME'
    );

  if (hasSelectedOpeningConflict) {
    resultType = 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME';
    canConfirm = false;
  } else if (hasPriorityConflict) {
    resultType = 'PRIORITY_CONFLICT';
    canConfirm = false;
  } else if (readyToApply && (hasOptionalRemoval || hasRemovalChanges || requiresPriorityRemovalConfirmation || requiresTimingRiskConfirmation)) {
    resultType = 'FITS_WITH_OPTIONAL_REMOVAL';
    canConfirm = true;
  } else if (readyToApply) {
    resultType = 'FITS_DIRECTLY';
    canConfirm = true;
  } else if (resolution?.canForceConflict === true || validation?.requiresForceConfirmation === true) {
    resultType = 'CONFLICT_ONLY';
    canConfirm = false;
  } else {
    resultType = 'CANNOT_FIT';
    canConfirm = false;
  }
  const proposedTimelineBase = Array.isArray(params.previewResult?.routeTimeline)
    && params.previewResult.routeTimeline.length > 0
    ? params.previewResult.routeTimeline
    : (Array.isArray(params.previewResult?.fullTimeline)
      ? params.previewResult.fullTimeline
      : []);
  const exactOptimizerAttempts = Array.isArray(resolution?.manualOptimizer?.attempts)
    ? resolution.manualOptimizer.attempts
    : [];
  const proposedTimelinePreservesAnchor =
    selectedAnchor
      ? this.manualFitTimelinePreservesSelectedAnchor({
          timeline: proposedTimelineBase,
          selectedHotspotId: params.selectedHotspotId,
          afterHotspotId: selectedAnchor?.afterHotspotId ?? null,
          beforeHotspotId: selectedAnchor?.beforeHotspotId ?? null,
          anchorIntent: selectedAnchor?.anchorIntent,
        })
      : true;
  const exactAnchorAttempt = selectedAnchor
    ? (
        exactOptimizerAttempts.find((attempt: any) => (
          String(attempt?.strategyKey || '').trim().toLowerCase() === 'exact_anchor_sequential_rebuild'
          && Array.isArray(attempt?.previewTimeline)
          && this.manualFitTimelinePreservesSelectedAnchor({
            timeline: attempt.previewTimeline,
            selectedHotspotId: params.selectedHotspotId,
            afterHotspotId: selectedAnchor?.afterHotspotId ?? null,
            beforeHotspotId: selectedAnchor?.beforeHotspotId ?? null,
            anchorIntent: selectedAnchor?.anchorIntent,
          })
        ))
        || exactOptimizerAttempts.find((attempt: any) => (
          String(attempt?.strategyKey || '').trim().toLowerCase().startsWith('exact_anchor_')
          && Array.isArray(attempt?.previewTimeline)
          && this.manualFitTimelinePreservesSelectedAnchor({
            timeline: attempt.previewTimeline,
            selectedHotspotId: params.selectedHotspotId,
            afterHotspotId: selectedAnchor?.afterHotspotId ?? null,
            beforeHotspotId: selectedAnchor?.beforeHotspotId ?? null,
            anchorIntent: selectedAnchor?.anchorIntent,
          })
        ))
      )
    : null;
  const timelineBaseForEnvelope =
    !proposedTimelinePreservesAnchor
    && Array.isArray(exactAnchorAttempt?.previewTimeline)
    && exactAnchorAttempt.previewTimeline.length > 0
      ? exactAnchorAttempt.previewTimeline
      : proposedTimelineBase;
  const proposedTimelineRaw = await this.enrichManualFitPreviewTimelineWithOperatingHours(
    params.planId,
    params.routeId,
    timelineBaseForEnvelope,
  );
  let finalizedTimeline = this.buildManualFitFinalizedPreviewTimeline(
    proposedTimelineRaw,
    removedHotspots,
  );
  const selectedHotspotIdNum = Number(params.selectedHotspotId || 0);
  const finalizedAttractionRows = (Array.isArray(finalizedTimeline) ? finalizedTimeline : []).filter((row: any) => (
    String(row?.type || '').toLowerCase() === 'attraction'
    || Number(row?.item_type || 0) === 4
  ));
  const finalizedTravelRows = (Array.isArray(finalizedTimeline) ? finalizedTimeline : []).filter((row: any) => (
    String(row?.type || '').toLowerCase() === 'travel'
    || Number(row?.item_type || 0) === 3
    || Number(row?.item_type || 0) === 5
  ));
  const selectedExistsInFinalizedTimeline = finalizedAttractionRows.some((row: any) => (
    Number(row?.hotspotId || row?.hotspot_ID || row?.locationId || row?.hotspot_id || 0) === selectedHotspotIdNum
  ));
  const likelyMissingTravelLegs =
    selectedAnchor?.exactSelectedGap === true
    && selectedExistsInFinalizedTimeline
    && finalizedTravelRows.length === 0
    && finalizedAttractionRows.length <= 1;

  if (likelyMissingTravelLegs) {
    try {
      const baselineTimeline = await this.getRouteTimelineForScoring(
        this.prisma,
        Number(params.planId),
        Number(params.routeId),
      );
      const rebuiltExactTimeline = await this.buildExactAnchorSequentialTimelineAfterRemoval(
        this.prisma,
        baselineTimeline,
        {
          removedHotspotIds: removedHotspots
            .map((row: any) => this.getManualFitRemovalHotspotId(row))
            .filter((id: number) => Number.isFinite(id) && id > 0),
          targetHotspotId: selectedHotspotIdNum,
          routeId: Number(params.routeId),
          planId: Number(params.planId),
          anchorIntent: selectedAnchor?.anchorIntent,
          afterHotspotId: selectedAnchor?.afterHotspotId,
          beforeHotspotId: selectedAnchor?.beforeHotspotId,
        },
      );

      const enrichedRebuiltExactTimeline = await this.enrichManualFitPreviewTimelineWithOperatingHours(
        params.planId,
        params.routeId,
        rebuiltExactTimeline,
      );
      const rebuiltFinalizedTimeline = this.buildManualFitFinalizedPreviewTimeline(
        enrichedRebuiltExactTimeline,
        removedHotspots,
      );

      if (Array.isArray(rebuiltFinalizedTimeline) && rebuiltFinalizedTimeline.length > finalizedTimeline.length) {
        finalizedTimeline = rebuiltFinalizedTimeline;
      }
    } catch (error) {
      console.warn('[FitHere][preview_envelope_rebuild_failed]', {
        planId: Number(params.planId),
        routeId: Number(params.routeId),
        selectedHotspotId: selectedHotspotIdNum,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const finalizedSelectedHotspotIds = new Set<number>(
    (finalizedTimeline || [])
      .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction')
      .map((row: any) => Number(row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );
  const hasUnprovenProtectedRemoval = removedHotspots.some((row: any) => {
    const priority = Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 0);
    const reasonCode = String(row?.removalReasonCode || '').toUpperCase();
    return (priority === 1 || priority === 2) && reasonCode === 'UNPROVEN_REMOVAL';
  });

  if (hasUnprovenProtectedRemoval) {
    resultType = 'PRIORITY_CONFLICT';
    canConfirm = false;
  }

  const rejectedReasons = canConfirm
    ? []
    : [
        hasSelectedOpeningConflict
          ? String(
              selectedOpeningConflict?.reason ||
              `${selectedOpeningConflict?.hotspotName || 'Selected hotspot'} cannot be inserted here because attempted visit time is ${selectedOpeningConflict?.attemptedVisitTime || 'outside operating hours'}, but operating hours are ${selectedOpeningConflict?.operatingHours || 'not available'}.`,
            )
          : String(validation?.reason || params.previewResult?.message || 'Selected hotspot cannot fit at this anchor.'),
      ];

  if (hasUnprovenProtectedRemoval) {
    rejectedReasons.splice(
      0,
      rejectedReasons.length,
      'This preview removed a protected hotspot without proven operating-hours conflict, route-end overflow, or downstream route-feasibility evidence. Please treat this preview as invalid.',
    );
  }

  return {
    attemptId: params.attemptId,
    planId: params.planId,
    routeId: params.routeId,
    selectedHotspotId: params.selectedHotspotId,
    resultType,
    canConfirm,
    canForceConflict:
      resolution?.canForceConflict === true ||
      (hasSelectedOpeningConflict && allowClosedHotspotForceConflict),
    selectedOpeningConflict,
    requiresP3Confirmation: canConfirm ? false : safeP3Hotspots.length > 0,
    requiresP1P2Override: affectedPriorityHotspots.some((row: any) => Number(row?.priority || 0) > 0 && Number(row?.priority || 0) <= 2),
    requiresTimingRiskConfirmation,
    requiresPriorityRemovalConfirmation,
    timingRisk,
    removedPrioritySummary,
    changesRequiredDisplay,
    confirmButtonVariant: (requiresTimingRiskConfirmation || requiresPriorityRemovalConfirmation) ? 'danger' : 'default',
    acceptedReason: canConfirm ? String(params.previewResult?.message || validation?.reason || '').trim() || null : null,
    rejectedReasons,
    proposedTimeline: finalizedTimeline,
    finalizedTimeline,
    authoritativeTimelineSource: 'BACKEND_FINALIZED_PATCHED_TIMELINE',
    authoritativeRemovedHotspotIds: removedHotspots
      .map((row: any) => this.getManualFitRemovalHotspotId(row))
      .filter((id: number) => Number.isFinite(id) && id > 0),
    requiresRemovalAcknowledgementHotspotIds: changesRequiredDisplay.removedItems
      .map((row: any) => Number(row?.hotspotId || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0),
    removedHotspots,
    shiftedHotspots: Array.isArray(resolution?.shiftedHotspots) ? resolution.shiftedHotspots : [],
    affectedPriorityHotspots,
    suggestedAlternativePositions: Array.isArray(manualInsertionFit?.allSlotResults)
      ? manualInsertionFit.allSlotResults
          .filter((slot: any) => slot?.selectedAsBest === true || slot?.routePossible === true)
          .slice(0, 3)
          .map((slot: any) => ({
            label: String(slot?.displayLabel || slot?.label || '').trim(),
            fromHotspotId: Number(slot?.fromHotspotId || 0) || null,
            toHotspotId: Number(slot?.toHotspotId || 0) || null,
            slotIndex: Number.isInteger(Number(slot?.slotIndex)) ? Number(slot.slotIndex) : null,
          }))
      : [],
    anchorLabel: params.anchorLabel,
    manualInsertionFit,
    resolution: {
      ...(resolution || {}),
      manualInsertionFit,
      lowPriorityOpeningHoursRemovalPlanPreview:
        manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview ||
        resolution?.lowPriorityOpeningHoursRemovalPlanPreview ||
        null,
      removedOptionalHotspots: safeRemovedOptional,
      removedTopPriorityHotspots: safeRemovedTopPriority,
      p3HotspotsToRemove: safeP3Hotspots,
      topPriorityAffected: affectedPriorityHotspots,
      removedHotspots,
      changesRequiredDisplay,
      unscheduledManualHotspots: Array.isArray(resolution?.unscheduledManualHotspots)
        ? resolution.unscheduledManualHotspots.filter((row: any) => {
            const hotspotId = Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0);
            return !(hotspotId > 0 && finalizedSelectedHotspotIds.has(hotspotId));
          })
        : [],
    },
    selectedAnchor: params.selectedAnchor
      ? {
          anchorType: params.selectedAnchor.anchorType,
          anchorIntent: params.selectedAnchor.anchorIntent,
          anchorIndex: params.selectedAnchor.anchorIndex,
          anchorFrom: params.selectedAnchor.anchorFrom ?? null,
          anchorTo: params.selectedAnchor.anchorTo ?? null,
          anchorLabel: params.selectedAnchor.anchorLabel,
          afterRouteHotspotId: params.selectedAnchor.afterRouteHotspotId ?? null,
          afterHotspotId: params.selectedAnchor.afterHotspotId ?? null,
          beforeRouteHotspotId: params.selectedAnchor.beforeRouteHotspotId ?? null,
          beforeHotspotId: params.selectedAnchor.beforeHotspotId ?? null,
        }
      : null,
    sourceFingerprint: params.sourceFingerprint,
    expiresAt: params.expiresAt,
    attemptLog: this.buildManualFitAttemptLog(params.previewResult),
    proposedTimelineFingerprint: this.buildManualFitTimelineFingerprint(finalizedTimeline),
  };
}

export function removeManualFitDroppedRowsFromTimelineImpl(this: any, timeline: any[], removedRows: any[]): any[] {
  const removedIds = new Set<number>();
  const removedNames = new Set<string>();

  const normalizeName = (value: any): string =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

  for (const row of removedRows || []) {
    const id = Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0);
    if (id > 0) removedIds.add(id);

    const name = normalizeName(row?.name || row?.title || row?.hotspot_name || row?.text);
    if (name) removedNames.add(name);
  }

  if (removedIds.size === 0 && removedNames.size === 0) return timeline;

  return (timeline || []).filter((row: any) => {
    const rowHotspotId = Number(row?.hotspotId || row?.hotspot_ID || row?.id || row?.locationId || row?.hotspot_id || 0);
    if (rowHotspotId > 0 && removedIds.has(rowHotspotId)) return false;

    const rowName = normalizeName(row?.name || row?.title || row?.hotspot_name || row?.text);
    if (rowName && removedNames.has(rowName)) return false;

    const type = String(row?.type || '').toLowerCase();
    const text = normalizeName([
      row?.text,
      row?.name,
      row?.title,
      row?.from,
      row?.to,
      row?.fromName,
      row?.toName,
    ].filter(Boolean).join(' '));

    if (type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5) {
      for (const removedName of removedNames) {
        if (
          text.includes(`travel to ${removedName}`) ||
          text.includes(`to ${removedName}`) ||
          text.includes(`from ${removedName}`) ||
          text.includes(removedName)
        ) {
          return false;
        }
      }
    }

    return true;
  });
}

export function manualFitTimelinePreservesSelectedAnchorImpl(this: any, params: any): boolean {
  const timeline = Array.isArray(params.timeline) ? params.timeline : [];
  const selectedId = Number(params.selectedHotspotId || 0);
  const afterId = Number(params.afterHotspotId || 0);
  const beforeId = Number(params.beforeHotspotId || 0);

  if (!selectedId) return false;

  const getRowHotspotId = (row: any): number =>
    Number(row?.hotspotId || row?.hotspot_ID || row?.id || row?.locationId || row?.hotspot_id || 0);

  const attractionRows = timeline.filter((row: any) => {
    const type = String(row?.type || '').toLowerCase();
    const itemType = Number(row?.item_type || 0);
    return type === 'attraction' || itemType === 4;
  });

  const selectedIndex = attractionRows.findIndex((row: any) => {
    const rowId = getRowHotspotId(row);
    return (
      rowId === selectedId ||
      Number(row?.insertedHotspotId || 0) === selectedId ||
      (row?.isInserted === true && rowId === selectedId) ||
      (row?.isManual === true && rowId === selectedId)
    );
  });

  if (selectedIndex < 0) return false;

  if (params.anchorIntent === 'AFTER_START') {
    if (selectedIndex !== 0) return false;

    if (beforeId > 0) {
      const beforeIndex = attractionRows.findIndex((row: any) => getRowHotspotId(row) === beforeId);
      return beforeIndex < 0 || beforeIndex === selectedIndex + 1;
    }

    return true;
  }

  if (params.anchorIntent === 'AFTER_ATTRACTION') {
    const afterIndex = attractionRows.findIndex((row: any) => getRowHotspotId(row) === afterId);
    if (afterIndex < 0) return false;
    if (selectedIndex !== afterIndex + 1) return false;

    if (beforeId > 0) {
      const beforeIndex = attractionRows.findIndex((row: any) => getRowHotspotId(row) === beforeId);
      if (beforeIndex >= 0 && beforeIndex <= selectedIndex) {
        return false;
      }
    }

    return true;
  }

  return true;
}

export function buildManualFitFinalizedPreviewTimelineImpl(this: any, timeline: any[], removedRows: any[]): any[] {
  const removedHotspotIds = new Set(
    (Array.isArray(removedRows) ? removedRows : [])
      .map((row: any) => this.getManualFitRemovalHotspotId(row))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );
  const removedNames = new Set(
    (Array.isArray(removedRows) ? removedRows : [])
      .map((row: any) => String(row?.name || row?.hotspotName || row?.hotspot_name || '').trim().toLowerCase())
      .filter(Boolean),
  );

  const rowMentionsRemovedHotspot = (row: any): boolean => {
    const rowHotspotId = Number(
      row?.locationId ||
      row?.hotspotId ||
      row?.hotspot_ID ||
      row?.hotspot_id ||
      row?.id ||
      0,
    );
    if (rowHotspotId > 0 && removedHotspotIds.has(rowHotspotId)) {
      return true;
    }

    const rowParts = [
      row?.text,
      row?.name,
      row?.title,
      row?.from,
      row?.fromName,
      row?.to,
      row?.toName,
      row?.displayFromName,
      row?.displayToName,
    ]
      .map((value: any) => String(value || '').trim().toLowerCase())
      .filter(Boolean);

    for (const removedName of removedNames) {
      if (!removedName) continue;
      if (rowParts.some((value: string) => value.includes(removedName))) {
        return true;
      }
    }

    return false;
  };

  return (Array.isArray(timeline) ? timeline : []).filter((row: any) => {
    if (!row || typeof row !== 'object') return false;

    const rowType = String(row?.type || '').toLowerCase();
    if (rowType === 'waiting') return false;

    const isAttraction =
      rowType === 'attraction' ||
      Number(row?.item_type || 0) === 4;
    const isTravelLike =
      rowType === 'travel' ||
      Number(row?.item_type || 0) === 3 ||
      Number(row?.item_type || 0) === 5 ||
      Number(row?.item_type || 0) === 7;

    if (isAttraction && rowMentionsRemovedHotspot(row)) {
      return false;
    }

    if (isTravelLike && rowMentionsRemovedHotspot(row)) {
      return false;
    }

    return true;
  });
}

export function buildManualFitAttemptTimelineSnapshotImpl(this: any, timeline: any[], params: any = {}): any[] {
  const removedSet = new Set(
    (params.removedHotspotIds || [])
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );
  const selectedHotspotId = Number(params.selectedHotspotId || 0);

  const getHotspotId = (row: any): number =>
    Number(
      row?.locationId ||
      row?.hotspotId ||
      row?.hotspot_ID ||
      row?.hotspot_id ||
      row?.id ||
      0,
    );

  const getRouteHotspotId = (row: any): number =>
    Number(
      row?.routeHotspotId ||
      row?.route_hotspot_ID ||
      row?.route_hotspot_id ||
      0,
    );

  const getName = (row: any): string =>
    String(
      row?.name ||
      row?.title ||
      row?.hotspotName ||
      row?.hotspot_name ||
      row?.text ||
      row?.to ||
      row?.type ||
      'Row',
    );

  return (Array.isArray(timeline) ? timeline : []).map((row: any, index: number) => {
    const hotspotId = getHotspotId(row);
    const isAttraction =
      String(row?.type || '').toLowerCase() === 'attraction' ||
      Number(row?.item_type || 0) === 4;
    const isActionableAttraction = isAttraction && hotspotId > 0;
    const isRemoved = isActionableAttraction && removedSet.has(hotspotId);
    const isSelected = isActionableAttraction && selectedHotspotId > 0 && hotspotId === selectedHotspotId;
    const selectedOpeningConflict =
      row?.selectedOpeningConflict ||
      row?.openingConflict ||
      null;

    return {
      index,
      type: row?.type || null,
      itemType: Number(row?.item_type || 0) || null,
      hotspotId: hotspotId || null,
      routeHotspotId: getRouteHotspotId(row) || null,
      name: getName(row),
      title: row?.title || row?.name || row?.text || null,
      timeRange:
        row?.timeRange ||
        row?.visitTime ||
        row?.startTime ||
        row?.hotspot_start_time ||
        null,
      operatingHours: row?.operatingHours || row?.timings || row?.hotspot_timings || null,
      openingTime: row?.openingTime || null,
      closingTime: row?.closingTime || null,
      priority: Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 0) || null,
      isAttraction,
      isInserted:
        row?.isInserted === true ||
        row?.inserted === true ||
        row?.source === 'MANUAL_INSERTION',
      isManual:
        row?.isManual === true ||
        row?.mustInclude === true ||
        Number(row?.hotspot_plan_own_way || 0) === 1,
      isRemoved,
      isSelected,
      hasConflict: isSelected && !!selectedOpeningConflict,
      selectedOpeningConflict,
      status: isRemoved
        ? 'REMOVED'
        : isSelected && selectedOpeningConflict
          ? 'CONFLICT'
          : row?.status || null,
    };
  });
}

export function buildManualFitAttemptDisplayTimelineSnapshotImpl(this: any, displaySourceTimeline: any[], params: any = {}): any[] {
  const removedSet = new Set(
    (params.removedHotspotIds || [])
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );

  const protectedSet = new Set(
    (params.protectedHotspotIds || [])
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );

  const selectedHotspotId = Number(params.selectedHotspotId || 0);

  const getHotspotId = (row: any): number =>
    Number(
      row?.locationId ||
      row?.hotspotId ||
      row?.hotspot_ID ||
      row?.hotspot_id ||
      row?.id ||
      0,
    );

  const getRouteHotspotId = (row: any): number =>
    Number(
      row?.routeHotspotId ||
      row?.route_hotspot_ID ||
      row?.route_hotspot_id ||
      0,
    );

  const getName = (row: any): string =>
    String(
      row?.name ||
      row?.title ||
      row?.hotspotName ||
      row?.hotspot_name ||
      row?.text ||
      row?.to ||
      row?.type ||
      'Row',
    );

  return (Array.isArray(displaySourceTimeline) ? displaySourceTimeline : []).map((row: any, index: number) => {
    const hotspotId = getHotspotId(row);
    const isAttraction =
      String(row?.type || '').toLowerCase() === 'attraction' ||
      Number(row?.item_type || 0) === 4;
    const isActionableAttraction = isAttraction && hotspotId > 0;

    const isRemoved = isActionableAttraction && removedSet.has(hotspotId);
    const isSelected = isActionableAttraction && selectedHotspotId > 0 && hotspotId === selectedHotspotId;
    const isProtected = isActionableAttraction && protectedSet.has(hotspotId);

    const selectedOpeningConflict =
      isSelected
        ? (params.selectedConflict || row?.selectedOpeningConflict || row?.openingConflict || null)
        : null;

    return {
      index,
      originalIndex: index,
      type: row?.type || null,
      itemType: Number(row?.item_type || 0) || null,
      hotspotId: hotspotId || null,
      routeHotspotId: getRouteHotspotId(row) || null,
      name: getName(row),
      title: row?.title || row?.name || row?.text || null,
      timeRange:
        row?.timeRange ||
        row?.visitTime ||
        row?.startTime ||
        row?.hotspot_start_time ||
        null,
      operatingHours: row?.operatingHours || row?.timings || row?.hotspot_timings || null,
      openingTime: row?.openingTime || null,
      closingTime: row?.closingTime || null,
      priority: Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 0) || null,
      isAttraction,
      isInserted:
        row?.isInserted === true ||
        row?.inserted === true ||
        row?.source === 'MANUAL_INSERTION',
      isManual:
        row?.isManual === true ||
        row?.mustInclude === true ||
        Number(row?.hotspot_plan_own_way || 0) === 1,
      isRemoved,
      isSelected,
      isProtected,
      hasConflict: isSelected && !!selectedOpeningConflict,
      selectedOpeningConflict,
      status: isRemoved
        ? 'REMOVED'
        : isSelected && selectedOpeningConflict
          ? 'CONFLICT'
          : isProtected
            ? 'PROTECTED'
            : row?.status || null,
    };
  });
}

export function buildManualFitAttemptComputedDisplayTimelineSnapshotImpl(
  this: any,
  originalDisplayTimeline: any[],
  recalculatedTimeline: any[],
  params: any = {},
): any[] {
  const removedSet = new Set(
    (params.removedHotspotIds || [])
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );

  const protectedSet = new Set(
    (params.protectedHotspotIds || [])
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );

  const selectedHotspotId = Number(params.selectedHotspotId || 0);

  const getHotspotId = (row: any): number =>
    Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || row?.id || 0);

  const getName = (row: any): string =>
    String(row?.name || row?.title || row?.hotspotName || row?.hotspot_name || row?.text || row?.to || row?.type || 'Row');

  const isAttractionRow = (row: any): boolean =>
    String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;

  const isTravelRow = (row: any): boolean =>
    String(row?.type || '').toLowerCase() === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;

  const computedRows = (Array.isArray(recalculatedTimeline) ? recalculatedTimeline : [])
    .filter((row: any) => {
      const hotspotId = getHotspotId(row);

      if (hotspotId > 0 && removedSet.has(hotspotId) && isAttractionRow(row)) {
        return false;
      }

      if (isTravelRow(row)) {
        const fromHotspotId = Number(row?.fromHotspotId || row?.from_hotspot_ID || row?.fromHotspot_ID || 0);
        const toHotspotId = Number(row?.toHotspotId || row?.to_hotspot_ID || row?.toHotspot_ID || 0);

        if (fromHotspotId > 0 && removedSet.has(fromHotspotId)) return false;
        if (toHotspotId > 0 && removedSet.has(toHotspotId)) return false;
      }

      return true;
    })
    .map((row: any, index: number) => {
      const hotspotId = getHotspotId(row);
      const isSelected = selectedHotspotId > 0 && hotspotId === selectedHotspotId;
      const isProtected = hotspotId > 0 && protectedSet.has(hotspotId);
      const selectedOpeningConflict =
        isSelected
          ? (params.selectedConflict || row?.selectedOpeningConflict || row?.openingConflict || null)
          : null;

      return {
        index,
        originalIndex: index,
        type: row?.type || null,
        itemType: Number(row?.item_type || 0) || null,
        hotspotId: hotspotId || null,
        routeHotspotId: Number(row?.routeHotspotId || row?.route_hotspot_ID || row?.route_hotspot_id || 0) || null,
        fromHotspotId: Number(row?.fromHotspotId || row?.from_hotspot_ID || row?.fromHotspot_ID || 0) || null,
        toHotspotId: Number(row?.toHotspotId || row?.to_hotspot_ID || row?.toHotspot_ID || 0) || null,
        name: getName(row),
        text: row?.text || row?.name || null,
        title: row?.title || row?.name || row?.text || null,
        timeRange: row?.timeRange || row?.visitTime || row?.startTime || row?.hotspot_start_time || null,
        operatingHours: row?.operatingHours || row?.timings || row?.hotspot_timings || null,
        openingTime: row?.openingTime || null,
        closingTime: row?.closingTime || null,
        priority: Number(row?.priority || row?.hotspot_priority || row?.rawPriority || 0) || null,
        isAttraction: isAttractionRow(row),
        isInserted: row?.isInserted === true || row?.inserted === true || row?.source === 'MANUAL_INSERTION',
        isManual: row?.isManual === true || row?.mustInclude === true || Number(row?.hotspot_plan_own_way || 0) === 1,
        isRemoved: false,
        isSelected,
        isProtected,
        hasConflict: isSelected && !!selectedOpeningConflict,
        selectedOpeningConflict,
        status: isSelected && selectedOpeningConflict
          ? 'CONFLICT'
          : isProtected
            ? 'PROTECTED'
            : row?.status || null,
      };
    });
  return computedRows.map((row: any, index: number) => ({
    ...row,
    index,
    originalIndex: index,
  }));
}

export function validateManualFitAttemptDisplayTimelineImpl(this: any, rows: any[], params: any): string[] {
  const errors: string[] = [];
  const removedSet = new Set(
    (params.removedHotspotIds || []).map(Number).filter((id: number) => Number.isFinite(id) && id > 0),
  );

  const getHotspotId = (row: any): number =>
    Number(row?.hotspotId || row?.locationId || row?.hotspot_ID || row?.hotspot_id || row?.id || 0);

  const parseStartMinutes = (value: any): number | null => {
    const raw = String(value || '');
    const plusDayMatch = raw.match(/\+(\d+)d/);
    const dayOffset = plusDayMatch ? Number(plusDayMatch[1] || 0) : 0;
    const match = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const ap = String(match[3]).toUpperCase();
    if (ap === 'AM' && hour === 12) hour = 0;
    if (ap === 'PM' && hour !== 12) hour += 12;
    return hour * 60 + minute + dayOffset * 24 * 60;
  };

  let lastStart: number | null = null;

  for (const row of Array.isArray(rows) ? rows : []) {
    const hotspotId = getHotspotId(row);
    const type = String(row?.type || '').toLowerCase();
    const itemType = Number(row?.itemType || row?.item_type || 0);
    const isTravel = type === 'travel' || itemType === 3 || itemType === 5;
    const isRemoved = row?.isRemoved === true || String(row?.status || '').toUpperCase() === 'REMOVED';

    if (isTravel) {
      const fromHotspotId = Number(row?.fromHotspotId || row?.from_hotspot_ID || row?.fromHotspot_ID || 0);
      const toHotspotId = Number(row?.toHotspotId || row?.to_hotspot_ID || row?.toHotspot_ID || 0);
      if (fromHotspotId > 0 && removedSet.has(fromHotspotId)) {
        errors.push(`Display timeline contains travel from removed hotspot ${fromHotspotId}.`);
      }
      if (toHotspotId > 0 && removedSet.has(toHotspotId)) {
        errors.push(`Display timeline contains travel to removed hotspot ${toHotspotId}.`);
      }
    }

    if (hotspotId > 0 && removedSet.has(hotspotId) && !isRemoved) {
      errors.push(`Removed hotspot ${hotspotId} appears as active row.`);
    }

    if (!isRemoved) {
      const start = parseStartMinutes(row?.timeRange || row?.visitTime);
      if (start !== null) {
        if (lastStart !== null && start + 60 < lastStart) {
          errors.push(`Display timeline is non-monotonic around ${row?.name || row?.title || row?.text || hotspotId}.`);
        }
        lastStart = start;
      }
    }
  }

  return errors;
}

export function detectManualFitTimingRiskImpl(this: any, params: any): any | null {
  const timeline = Array.isArray(params.timeline) ? params.timeline : [];
  const selectedHotspotId = Number(params.selectedHotspotId || 0);
  if (!(selectedHotspotId > 0)) return null;

  const selectedRow = timeline.find((row: any) => {
    const isAttraction = String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
    if (!isAttraction) return false;
    const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
    return hotspotId === selectedHotspotId;
  });

  if (!selectedRow) return null;

  const timeRange = String(selectedRow?.timeRange || selectedRow?.visitTime || '').trim();
  if (!timeRange.includes('-')) return null;

  const startPart = timeRange.split('-')[0]?.trim() || '';
  const endPart = timeRange.split('-')[1]?.trim() || '';
  const startMin = this.parsePreviewTimeToMinutes(startPart);
  const endMin = this.parsePreviewTimeToMinutes(endPart);
  const closingMinute = this.parseManualHotspotLatestClosingMinute(selectedRow?.timings);

  if (startMin === null || endMin === null) return null;
  if (!(closingMinute > 0) || closingMinute >= 24 * 60) return null;
  if (startMin >= closingMinute || endMin <= closingMinute || endMin <= startMin) return null;

  const requestedDurationMinutes = Math.max(0, endMin - startMin);
  const usableDurationMinutes = Math.max(0, closingMinute - startMin);
  const overflowMinutes = Math.max(0, endMin - closingMinute);
  if (requestedDurationMinutes <= 0 || usableDurationMinutes <= 0 || overflowMinutes <= 0) return null;

  const severity: 'warning' | 'danger' =
    overflowMinutes >= 30 || usableDurationMinutes < Math.ceil(requestedDurationMinutes * 0.6)
      ? 'danger'
      : 'warning';

  const hotspotName = String(
    selectedRow?.name ||
    selectedRow?.hotspot_name ||
    selectedRow?.text ||
    `Hotspot #${selectedHotspotId}`,
  ).trim();
  const closingTime = this.formatTime(this.minutesToUtcTimeDate(closingMinute) as any);

  return {
    type: 'PARTIAL_STAY_AFTER_CLOSING',
    severity,
    hotspotId: selectedHotspotId,
    hotspotName,
    proposedVisitStart: startPart,
    proposedVisitEnd: endPart,
    closingTime,
    requestedDurationMinutes,
    usableDurationMinutes,
    overflowMinutes,
    message: `${hotspotName} closes at ${closingTime}. Your planned stay continues until ${endPart}, so you will have only about ${this.formatManualDurationMinutes(usableDurationMinutes)} of usable time instead of ${this.formatManualDurationMinutes(requestedDurationMinutes)}.`,
    canForceConfirm: true,
  };
}

export function buildRemovedPrioritySummaryImpl(this: any, removedRows: any[]) {
  const rows = Array.isArray(removedRows) ? removedRows : [];
  const removedP4 = rows.filter((row: any) => Number(row?.priority || 0) >= 4).length;
  const removedP3 = rows.filter((row: any) => Number(row?.priority || 0) === 3).length;
  const removedP2 = rows.filter((row: any) => Number(row?.priority || 0) === 2).length;
  const removedP1 = rows.filter((row: any) => Number(row?.priority || 0) === 1).length;
  const highestRemovedPriority = removedP1 > 0 ? 1 : removedP2 > 0 ? 2 : removedP3 > 0 ? 3 : removedP4 > 0 ? 4 : null;
  const requiresPriorityRemovalConfirmation = rows.length > 0;
  const severity: 'none' | 'warning' | 'danger' =
    highestRemovedPriority === null
      ? 'none'
      : highestRemovedPriority <= 2
        ? 'danger'
        : 'warning';
  const message =
    highestRemovedPriority === null
      ? 'No existing route hotspot removal is required.'
      : highestRemovedPriority === 4
        ? 'This manual insertion will remove non-manual / optional hotspots first before checking Priority 3 -> Priority 2 -> Priority 1.'
      : highestRemovedPriority === 3
        ? 'This manual insertion will remove existing hotspots. Removal order used: Non-manual / Priority 4 -> Priority 3 -> Priority 2 -> Priority 1.'
        : 'This manual insertion will remove existing priority hotspots. Removal order used: Non-manual / Priority 4 -> Priority 3 -> Priority 2 -> Priority 1.';

  return {
    removedP4,
    removedP3,
    removedP2,
    removedP1,
    highestRemovedPriority,
    removalOrder: [4, 3, 2, 1],
    requiresPriorityRemovalConfirmation,
    severity,
    message,
  };
}

export function buildManualFitChangesRequiredDisplayImpl(this: any, params: any) {
  const getHotspotId = (row: any): number =>
    Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || row?.locationId || 0);

  const getRouteHotspotId = (row: any): number | null => {
    const value = Number(row?.routeHotspotId || row?.route_hotspot_ID || row?.route_hotspot_id || 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const getName = (row: any): string =>
    String(row?.name || row?.hotspotName || row?.hotspot_name || row?.title || row?.text || `Hotspot #${getHotspotId(row)}`);

  const getPriority = (row: any): number | null => {
    const value = Number(row?.priority || row?.hotspotPriority || row?.hotspot_priority || row?.rawPriority || 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const seen = new Set<number>();

  const removedItems = (Array.isArray(params.removedHotspots) ? params.removedHotspots : [])
    .map((row: any) => {
      const hotspotId = getHotspotId(row);
      const workPriority = getPriority(row);

      return {
        hotspotId,
        routeHotspotId: getRouteHotspotId(row),
        name: getName(row),
        workPriority,
        workPriorityLabel: workPriority ? `Priority ${workPriority}` : 'Priority not set',
        reason: row?.reason || row?.message || null,
        removalReasonCode: row?.removalReasonCode || null,
        fitFailureExplanation: row?.fitFailureExplanation || null,
      };
    })
    .filter((row: any) => {
      if (!(row.hotspotId > 0)) return false;
      if (seen.has(row.hotspotId)) return false;
      seen.add(row.hotspotId);
      return true;
    })
    .sort((a: any, b: any) => {
      const ap = Number(a.workPriority || 99);
      const bp = Number(b.workPriority || 99);
      if (ap !== bp) return bp - ap;
      return String(a.name).localeCompare(String(b.name));
    });

  return {
    hasRemovals: removedItems.length > 0,
    title: 'Changes Required',
    removalOrderLabel: 'Removal order checked: Non-manual / Priority 4 -> Priority 3 -> Priority 2 -> Priority 1',
    removedItems,
    noRemovalText: 'No hotspot removed',
  };
}
