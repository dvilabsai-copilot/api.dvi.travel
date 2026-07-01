import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";

export async function resolveManualFitHereAnchorImpl(
  this: any,
  routeId: number,
  anchor: any,
): Promise<any> {
  const anchorIntentRaw = String(anchor?.anchorIntent || '').trim().toUpperCase();

  if (!['AFTER_START', 'AFTER_ATTRACTION'].includes(anchorIntentRaw)) {
    throw new BadRequestException('Invalid Fit Here anchor intent for this flow.');
  }

  const anchorIntent = anchorIntentRaw as 'AFTER_START' | 'AFTER_ATTRACTION';

  const routeHotspots = await this.prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_route_ID: Number(routeId),
      item_type: 4,
      deleted: 0,
    } as any,
    orderBy: [{ hotspot_order: 'asc' }, { route_hotspot_ID: 'asc' }],
    select: {
      route_hotspot_ID: true,
      hotspot_ID: true,
      hotspot_order: true,
    },
  });

  const rows = routeHotspots.map((row: any, index: number) => ({
    index,
    routeHotspotId: Number(row?.route_hotspot_ID || 0),
    hotspotId: Number(row?.hotspot_ID || 0),
    hotspotOrder: Number(row?.hotspot_order || index + 1),
  }));

  const findByRouteHotspotId = (value: any) => rows.find((row) => row.routeHotspotId === Number(value || 0));
  const findByHotspotId = (value: any) => rows.find((row) => row.hotspotId === Number(value || 0));

  const afterRow =
    findByRouteHotspotId(anchor?.afterRouteHotspotId) ||
    findByRouteHotspotId(anchor?.afterRowId) ||
    findByHotspotId(anchor?.afterHotspotId);

  const beforeRow =
    findByRouteHotspotId(anchor?.beforeRouteHotspotId) ||
    findByRouteHotspotId(anchor?.beforeRowId) ||
    findByHotspotId(anchor?.beforeHotspotId);

  let anchorIndex = Number.isFinite(Number(anchor?.anchorIndex))
    ? Number(anchor.anchorIndex)
    : 0;

  if (anchorIntent === 'AFTER_START') {
    anchorIndex = 0;
  }

  if (anchorIntent === 'AFTER_ATTRACTION') {
    if (!afterRow) {
      throw new BadRequestException('Invalid Fit Here anchor: attraction anchor was not found on this route.');
    }

    anchorIndex = Number(afterRow.index);
  }

  anchorIndex = Math.max(0, Math.min(anchorIndex, rows.length));

  const fallbackLabel =
    anchorIntent === 'AFTER_START'
      ? 'Before first attraction'
      : `After ${String(anchor?.anchorFrom || 'selected attraction')}`;

  return {
    anchorType: 'BETWEEN_ROWS',
    anchorIntent,
    anchorIndex,
    anchorLabel: String(anchor?.anchorLabel || fallbackLabel).trim(),
    anchorFrom: String(anchor?.anchorFrom || '').trim() || null,
    anchorTo: String(anchor?.anchorTo || '').trim() || null,
    anchorTimeRange: String(anchor?.anchorTimeRange || '').trim() || null,
    afterRowType: String(anchor?.afterRowType || '').trim() || null,
    beforeRowType: String(anchor?.beforeRowType || '').trim() || null,
    afterRouteHotspotId: afterRow?.routeHotspotId ?? null,
    afterHotspotId: afterRow?.hotspotId ?? null,
    beforeRouteHotspotId: beforeRow?.routeHotspotId ?? null,
    beforeHotspotId: beforeRow?.hotspotId ?? null,
    exactSelectedGap: true,
  };
}

export function extractManualFitPreferredSlotImpl(this: any, previewResult: any): any | null {
  const slot = previewResult?.manualInsertionFit?.chosenSlot || previewResult?.manualInsertionFit?.bestSlot || null;
  if (!slot) return null;

  const fromHotspotId = Number(slot?.fromHotspotId || 0);
  const toHotspotId = Number(slot?.toHotspotId || 0);
  const slotIndex = Number(slot?.slotIndex);

  return {
    fromHotspotId: fromHotspotId > 0 ? fromHotspotId : undefined,
    toHotspotId: toHotspotId > 0 ? toHotspotId : undefined,
    slotIndex: Number.isInteger(slotIndex) && slotIndex >= 0 ? slotIndex : undefined,
    source: ['REQUESTED_SLOT', 'EXACT_ANCHOR'].includes(String(slot?.source || '').toUpperCase())
      ? 'EXACT_ANCHOR'
      : 'BEST_FIT',
  };
}

export async function previewManualHotspotFitHereImpl(
  this: any,
  planId: number,
  data: any,
) {
  if (!(Number(planId) > 0) || !(Number(data?.routeId) > 0) || !(Number(data?.selectedHotspotId) > 0)) {
    throw new BadRequestException('planId, routeId, and selectedHotspotId are required');
  }

  await this.purgeExpiredManualFitAttempts();

  const resolvedAnchor = await this.resolveManualFitHereAnchor(Number(data.routeId), data.anchor || {});
  const exactAnchorPreferredSlot =
    resolvedAnchor.exactSelectedGap === true
      ? {
          fromHotspotId: resolvedAnchor.afterHotspotId || undefined,
          toHotspotId: resolvedAnchor.beforeHotspotId || undefined,
          slotIndex: resolvedAnchor.anchorIndex,
          source: 'EXACT_ANCHOR' as const,
        }
      : undefined;
  const previewResult = await this.previewManualHotspotsBatch(
    Number(planId),
    Number(data.routeId),
    [Number(data.selectedHotspotId)],
    {
      anchorType: resolvedAnchor.anchorType,
      anchorIntent: resolvedAnchor.anchorIntent,
      anchorIndex: resolvedAnchor.anchorIndex,
      afterHotspotId: resolvedAnchor.afterHotspotId || undefined,
      beforeHotspotId: resolvedAnchor.beforeHotspotId || undefined,
      afterRouteHotspotId: resolvedAnchor.afterRouteHotspotId || undefined,
      beforeRouteHotspotId: resolvedAnchor.beforeRouteHotspotId || undefined,
      allowTopPriorityRemoval: data.allowP1P2Removal === true,
      allowP3Removal: data.allowP3Removal === true,
      allowP1P2Removal: data.allowP1P2Removal === true,
      focusHotspotId: Number(data.selectedHotspotId),
      previewOnly: true,
      exactAnchorMode: true,
      matrixPreferredSlot: exactAnchorPreferredSlot,
    },
  );

  const attemptId = randomUUID();
  const sourceFingerprint = await this.buildManualFitSourceFingerprint(Number(planId), Number(data.routeId));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const activeRemovalEvidence = await this.getActiveRouteManualFitRemovalEvidence(
    Number(planId),
    Number(data.routeId),
  );
  const response = await this.buildManualFitPreviewEnvelope({
    attemptId,
    planId: Number(planId),
    routeId: Number(data.routeId),
    selectedHotspotId: Number(data.selectedHotspotId),
    anchorLabel: resolvedAnchor.anchorLabel,
    selectedAnchor: resolvedAnchor,
    sourceFingerprint,
    expiresAt,
    previewResult,
    activeRemovalEvidence,
  });
  (response as any).removalPolicy = {
    allowP3Removal: data.allowP3Removal === true,
    allowP1P2Removal: data.allowP1P2Removal === true,
  };
  const matrixPreferredSlot = this.extractManualFitPreferredSlot(previewResult);
  console.log('[FitHere][preview_anchor_cache]', {
    attemptId,
    anchorIntent: resolvedAnchor.anchorIntent,
    anchorFrom: resolvedAnchor.anchorFrom,
    anchorTo: resolvedAnchor.anchorTo,
    afterHotspotId: resolvedAnchor.afterHotspotId,
    beforeHotspotId: resolvedAnchor.beforeHotspotId,
    exactAnchorPreferredSlot,
    extractedBestSlot: matrixPreferredSlot,
    cachedSlot: exactAnchorPreferredSlot || matrixPreferredSlot,
  });

  const cacheEntry: any = {
    attemptId,
    planId: Number(planId),
    routeId: Number(data.routeId),
    selectedHotspotId: Number(data.selectedHotspotId),
    anchorType: resolvedAnchor.anchorType,
    anchorIntent: resolvedAnchor.anchorIntent,
    anchorIndex: resolvedAnchor.anchorIndex,
    anchorLabel: resolvedAnchor.anchorLabel,
    anchorFrom: resolvedAnchor.anchorFrom ?? null,
    anchorTo: resolvedAnchor.anchorTo ?? null,
    anchorTimeRange: resolvedAnchor.anchorTimeRange ?? null,
    afterRowType: resolvedAnchor.afterRowType ?? null,
    beforeRowType: resolvedAnchor.beforeRowType ?? null,
    afterRouteHotspotId: resolvedAnchor.afterRouteHotspotId ?? null,
    afterHotspotId: resolvedAnchor.afterHotspotId ?? null,
    beforeRouteHotspotId: resolvedAnchor.beforeRouteHotspotId ?? null,
    beforeHotspotId: resolvedAnchor.beforeHotspotId ?? null,
    exactSelectedGap: resolvedAnchor.exactSelectedGap === true,
    allowP3Removal: data.allowP3Removal === true,
    allowP1P2Removal: data.allowP1P2Removal === true,
    canConfirm: response.canConfirm === true,
    requiresTimingRiskConfirmation: (response as any).requiresTimingRiskConfirmation === true,
    requiresPriorityRemovalConfirmation: (response as any).requiresPriorityRemovalConfirmation === true,
    timingRisk: (response as any).timingRisk || null,
    matrixPreferredSlot: exactAnchorPreferredSlot || matrixPreferredSlot,
    manualInsertionFitSnapshot: previewResult?.manualInsertionFit || null,
    proposedTimelineSnapshot: Array.isArray((response as any).proposedTimeline)
      ? (response as any).proposedTimeline
      : [],
    removedHotspotsSnapshot: Array.isArray((response as any).removedHotspots)
      ? (response as any).removedHotspots
      : [],
    selectedAnchorSnapshot: {
      anchorType: resolvedAnchor.anchorType,
      anchorIntent: resolvedAnchor.anchorIntent,
      anchorIndex: resolvedAnchor.anchorIndex,
      anchorFrom: resolvedAnchor.anchorFrom ?? null,
      anchorTo: resolvedAnchor.anchorTo ?? null,
      anchorLabel: resolvedAnchor.anchorLabel,
      afterHotspotId: resolvedAnchor.afterHotspotId ?? null,
      beforeHotspotId: resolvedAnchor.beforeHotspotId ?? null,
    },
    sourceFingerprint,
    proposedTimelineFingerprint: String((response as any).proposedTimelineFingerprint || ''),
    expiresAt,
  };

  if ((response as any).canConfirm === true) {
    const preflight = await this.preflightManualFitAttemptConfirmation(cacheEntry, 1);
    if (!preflight.canConfirm) {
      const preflightMessage = String(preflight.message || 'This Fit Here preview cannot be confirmed safely.').trim();
      (response as any).canConfirm = false;
      (response as any).resultType = 'CANNOT_FIT';
      (response as any).acceptedReason = null;
      (response as any).rejectedReasons = [preflightMessage];
      (response as any).confirmButtonVariant = 'default';
      (response as any).requiresTimingRiskConfirmation = false;
      (response as any).requiresPriorityRemovalConfirmation = false;
      (response as any).preflightFailure = {
        message: preflightMessage,
        body: preflight.body || null,
      };

      if ((response as any).resolution && typeof (response as any).resolution === 'object') {
        (response as any).resolution.requiresTimingRiskConfirmation = false;
        (response as any).resolution.requiresPriorityRemovalConfirmation = false;
        (response as any).resolution.preflightFailure = {
          message: preflightMessage,
          body: preflight.body || null,
        };
      }

      cacheEntry.canConfirm = false;
      cacheEntry.requiresTimingRiskConfirmation = false;
      cacheEntry.requiresPriorityRemovalConfirmation = false;
    }
  }

  await this.saveManualFitAttemptEntry(cacheEntry);

  return response;
}

export async function applyManualFitAttemptWithinTransactionImpl(
  this: any,
  tx: any,
  params: any,
) {
  const entry = params.entry;
  const snapshotRouteFitType = String(
    entry?.manualInsertionFitSnapshot?.chosenSlot?.routeFitType
    || entry?.manualInsertionFitSnapshot?.bestSlot?.routeFitType
    || '',
  ).toUpperCase();
  const snapshotSlotContext = String(
    entry?.manualInsertionFitSnapshot?.chosenSlot?.slotContext
    || entry?.manualInsertionFitSnapshot?.bestSlot?.slotContext
    || '',
  ).toUpperCase();
  const isDestinationSideExactFit =
    snapshotRouteFitType === 'DESTINATION_SIDE_INSERTION'
    || snapshotSlotContext === 'LAST_SOURCE_HOTSPOT_TO_DESTINATION_HOTEL';
  const shouldUseCachedExactFit =
    !params.canForceClosedHotspotConflict
    && entry.exactSelectedGap === true
    && !!entry.manualInsertionFitSnapshot
    && !!entry.matrixPreferredSlot;
  const cachedExactFit = shouldUseCachedExactFit
    ? (() => {
        const preferredSlot = entry.matrixPreferredSlot || {};
        const inferredRouteFitType =
          Number(preferredSlot?.fromHotspotId || 0) > 0 && Number(preferredSlot?.toHotspotId || 0) > 0
            ? 'ON_ROUTE'
            : Number(preferredSlot?.fromHotspotId || 0) > 0
              ? 'SINGLE_HOTSPOT_AFTER'
              : Number(preferredSlot?.toHotspotId || 0) > 0
                ? 'SINGLE_HOTSPOT_BEFORE'
                : String(
                    entry?.manualInsertionFitSnapshot?.chosenSlot?.routeFitType
                    || entry?.manualInsertionFitSnapshot?.bestSlot?.routeFitType
                    || '',
                  ).toUpperCase();

        return {
          ...(entry.manualInsertionFitSnapshot || {}),
          chosenSlot: {
            ...(entry.manualInsertionFitSnapshot?.chosenSlot || entry.manualInsertionFitSnapshot?.bestSlot || {}),
            ...(entry.matrixPreferredSlot || {}),
            routeFitType: inferredRouteFitType,
            source: 'EXACT_ANCHOR',
            chosenSlotSource: 'EXACT_ANCHOR',
            selectedAsBest: false,
          },
          bestSlot: {
            ...(entry.manualInsertionFitSnapshot?.bestSlot || entry.manualInsertionFitSnapshot?.chosenSlot || {}),
            ...(entry.matrixPreferredSlot || {}),
            routeFitType: inferredRouteFitType,
            source: 'EXACT_ANCHOR',
            chosenSlotSource: 'EXACT_ANCHOR',
            selectedAsBest: false,
          },
          chosenSlotSource: 'EXACT_ANCHOR',
        };
      })()
    : null;

  return shouldUseCachedExactFit
    ? await this.applyMatrixSafeManualHotspotInsertionInTx(tx, {
        planId: Number(params.planId),
        routeId: Number(entry.routeId),
        selectedHotspotIds: [Number(entry.selectedHotspotId)],
        userId: Number(params.userId || 1),
        manualInsertionFit: cachedExactFit,
        matrixPreferredSlot: entry.matrixPreferredSlot || undefined,
        trustedPreviewConfirmation: params.trustedPreviewConfirmation === true,
        trustedPreviewTimeline: params.trustedPreviewConfirmation === true
          ? entry.proposedTimelineSnapshot || null
          : null,
        skipPostApplyAssertions: true,
      })
    : await this.runManualHotspotBatchWithinTransaction(
        tx,
        Number(params.planId),
        Number(entry.routeId),
        [Number(entry.selectedHotspotId)],
        Number(params.userId || 1),
        {
          anchorType: entry.anchorType,
          anchorIntent: entry.anchorIntent,
          anchorIndex: entry.anchorIndex,
          afterHotspotId: entry.afterHotspotId,
          beforeHotspotId: entry.beforeHotspotId,
          afterRouteHotspotId: entry.afterRouteHotspotId,
          beforeRouteHotspotId: entry.beforeRouteHotspotId,
          allowP3Removal: entry.allowP3Removal === true,
          allowP1P2Removal: entry.allowP1P2Removal === true,
          allowTopPriorityRemoval: entry.allowP1P2Removal === true,
          matrixPreferredSlot: entry.matrixPreferredSlot || undefined,
          exactAnchorMode: entry.exactSelectedGap === true,
          trustedPreviewConfirmation: params.trustedPreviewConfirmation === true,
          previewOnly: false,
          forceConflictInsertion: params.canForceClosedHotspotConflict,
          forceConflictPreferredTimesByHotspotId: params.forceConflictPreferredTimesByHotspotId,
        },
      );
}

export async function preflightManualFitAttemptConfirmationImpl(
  this: any,
  entry: any,
  userId: number,
): Promise<any> {
  const rollbackError = new Error('__MANUAL_FIT_CONFIRM_PREFLIGHT_ROLLBACK__');
  const manualHotspotTxTimeoutMs = 180000;

  try {
    await this.prisma.$transaction(async (tx: any) => {
      const applyResult = await this.applyManualFitAttemptWithinTransaction(tx, {
        planId: Number(entry.planId),
        entry,
        userId: Number(userId || 1),
        canForceClosedHotspotConflict: false,
        forceConflictPreferredTimesByHotspotId: {},
        trustedPreviewConfirmation: true,
      });

      if (applyResult?.success !== true || applyResult?.inserted !== true) {
        throw new ConflictException(applyResult || 'Could not confirm Fit Here insertion.');
      }

      throw rollbackError;
    }, { timeout: manualHotspotTxTimeoutMs });
  } catch (error: any) {
    if (error === rollbackError) {
      return { canConfirm: true, body: null, message: null };
    }

    const details = this.extractManualFitErrorDetails(error);
    return {
      canConfirm: false,
      message: details.message,
      body: details.body,
    };
  }

  return {
    canConfirm: false,
    message: 'This Fit Here preview cannot be confirmed safely.',
    body: null,
  };
}

export async function confirmManualHotspotFitHereImpl(
  this: any,
  planId: number,
  payload: any,
  userId: number,
) {
  await this.purgeExpiredManualFitAttempts();

  const attemptId = String(payload?.attemptId || '').trim();
  const entry = await this.loadManualFitAttemptEntry(attemptId);
  if (!entry || Number(entry.planId) !== Number(planId)) {
    throw new NotFoundException('Fit Here preview attempt was not found.');
  }

  if (new Date(entry.expiresAt).getTime() <= Date.now()) {
    await this.deleteManualFitAttemptEntry(entry.attemptId);
    throw new ConflictException('Fit Here preview attempt expired. Please preview again.');
  }

  const allowClosedHotspotConflict = payload?.allowClosedHotspotConflict === true;
  const canForceClosedHotspotConflict =
    entry.canConfirm !== true &&
    allowClosedHotspotConflict === true &&
    entry.manualInsertionFitSnapshot?.selectedOpeningConflict;
  const forceConflictPreferredTimesByHotspotId: Record<number, { start: Date; end: Date }> = {};

  if (canForceClosedHotspotConflict) {
    const selectedOpeningConflict = entry.manualInsertionFitSnapshot?.selectedOpeningConflict || null;
    const attemptedVisitTime = selectedOpeningConflict?.attemptedVisitTime;
    const parsedAttemptedTimes = this.parsePreviewTimeRangeToUtcDates(attemptedVisitTime);

    if (parsedAttemptedTimes.start && parsedAttemptedTimes.end) {
      forceConflictPreferredTimesByHotspotId[Number(entry.selectedHotspotId)] = {
        start: parsedAttemptedTimes.start,
        end: parsedAttemptedTimes.end,
      };
    } else {
      console.warn('[FitHere][force_conflict_missing_attempted_time]', {
        attemptId: entry.attemptId,
        selectedHotspotId: entry.selectedHotspotId,
        attemptedVisitTime,
        selectedOpeningConflict,
      });
    }
  }

  if (entry.canConfirm !== true && !canForceClosedHotspotConflict) {
    throw new ConflictException('This Fit Here attempt cannot be confirmed as a clean fit.');
  }

  const freshActiveRemovalEvidence = await this.getActiveRouteManualFitRemovalEvidence(
    Number(planId),
    Number(entry.routeId),
  );
  const cachedRemovedHotspots = Array.isArray(entry.removedHotspotsSnapshot)
    ? entry.removedHotspotsSnapshot
    : [];
  const sanitizedCachedRemovedHotspots = this.sanitizeUserFacingManualFitRemovals(cachedRemovedHotspots, {
    routeId: Number(entry.routeId),
    selectedHotspotId: Number(entry.selectedHotspotId),
    activeRemovalEvidence: freshActiveRemovalEvidence,
  });

  if (sanitizedCachedRemovedHotspots.length !== cachedRemovedHotspots.length) {
    throw new ConflictException({
      success: false,
      inserted: false,
      code: 'FIT_HERE_INVALID_REMOVAL_SCOPE',
      message: 'This Fit Here preview contains stale or invalid removal rows. Please recalculate the preview before confirming.',
    });
  }

  const acknowledgedRemovedHotspotIds = Array.isArray(payload?.acknowledgedRemovedHotspotIds)
    ? payload.acknowledgedRemovedHotspotIds.map((id: any) => Number(id)).filter((id: number) => id > 0)
    : [];
  const plannedRemovalRows = sanitizedCachedRemovedHotspots;
  const plannedRemovalIds = plannedRemovalRows
    .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  const plannedRemovalPriorities = plannedRemovalRows
    .map((row: any) => Number(row?.priority || row?.hotspotPriority || row?.hotspot_priority || 0))
    .filter((priority: number) => Number.isFinite(priority) && priority > 0);
  const requiresAnyPriorityRemovalAcknowledgement = plannedRemovalIds.length > 0;
  const hasP1P2PlannedRemoval = plannedRemovalPriorities.some((priority) => priority === 1 || priority === 2);
  const acknowledgedSet = new Set(
    (payload?.acknowledgedRemovedHotspotIds || [])
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0),
  );

  if (requiresAnyPriorityRemovalAcknowledgement) {
    const missingAcknowledgement = plannedRemovalIds.some((id) => !acknowledgedSet.has(id));

    if (payload?.allowPriorityRemoval !== true || missingAcknowledgement) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MANUAL_INSERT_REMOVAL_ACKNOWLEDGEMENT_REQUIRED',
        message: hasP1P2PlannedRemoval
          ? 'This Fit Here requires removing Priority 1 / Priority 2 hotspot(s). Please acknowledge each listed removal.'
          : 'This Fit Here requires removing Priority 3 hotspot(s). Please acknowledge each listed removal.',
        plannedRemovalIds,
        acknowledgedRemovedHotspotIds: Array.from(acknowledgedSet),
      });
    }
  }
  const requiredRemovedHotspotIds = sanitizedCachedRemovedHotspots
    .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0))
    .filter((id: number) => id > 0);

  if (entry.requiresTimingRiskConfirmation === true && payload?.allowTimingRisk !== true) {
    throw new ConflictException('This Fit Here attempt requires explicit timing-risk confirmation.');
  }

  if (entry.requiresPriorityRemovalConfirmation === true && payload?.allowPriorityRemoval !== true) {
    throw new ConflictException('This Fit Here attempt requires explicit hotspot-removal confirmation.');
  }

  if (entry.requiresPriorityRemovalConfirmation === true) {
    const missingAcknowledgements = requiredRemovedHotspotIds.filter((id) => !acknowledgedRemovedHotspotIds.includes(id));
    if (missingAcknowledgements.length > 0) {
      throw new ConflictException('Please acknowledge all removed hotspots before confirming this Fit Here change.');
    }
  }

  const currentFingerprint = await this.buildManualFitSourceFingerprint(Number(planId), Number(entry.routeId));
  const sourceFingerprintChanged = currentFingerprint !== entry.sourceFingerprint;
  if (sourceFingerprintChanged) {
    console.warn('[FitHere][confirm_source_fingerprint_changed]', {
      attemptId: entry.attemptId,
      planId: Number(planId),
      routeId: Number(entry.routeId),
    });
  }

  const normalizedHotspotIds = this.normalizeManualHotspotIds([entry.selectedHotspotId]);
  await this.cleanupStaleManualHotspotRows(Number(planId), Number(entry.routeId), normalizedHotspotIds);

  const manualHotspotTxTimeoutMs = 180000;
  const applyRollbackError = new Error('__CONFIRM_FIT_HERE_ROLLBACK__');
  let applyResult: any;
  let rollbackReason = 'CONFIRM_FAILED';
  const confirmStartedAt = Date.now();
  console.log('[FitHere][confirm_start]', {
    attemptId: entry.attemptId,
    planId,
    routeId: entry.routeId,
    selectedHotspotId: entry.selectedHotspotId,
    sourceFingerprintChanged,
    anchorIntent: entry.anchorIntent,
    anchorFrom: entry.anchorFrom,
    anchorTo: entry.anchorTo,
    afterHotspotId: entry.afterHotspotId,
    beforeHotspotId: entry.beforeHotspotId,
  });

  try {
    await this.prisma.$transaction(async (tx: any) => {
      applyResult = await this.applyManualFitAttemptWithinTransaction(tx, {
        planId: Number(planId),
        entry,
        userId: Number(userId || 1),
        canForceClosedHotspotConflict,
        forceConflictPreferredTimesByHotspotId,
        trustedPreviewConfirmation: entry.canConfirm === true,
      });
      console.log('[FitHere][confirm_apply_result]', {
        attemptId: entry.attemptId,
        durationMs: Date.now() - confirmStartedAt,
        success: applyResult?.success,
        inserted: applyResult?.inserted,
        routeTimelineCount: Array.isArray(applyResult?.routeTimeline) ? applyResult.routeTimeline.length : null,
        fullTimelineCount: Array.isArray(applyResult?.fullTimeline) ? applyResult.fullTimeline.length : null,
      });

      if (applyResult?.success !== true || applyResult?.inserted !== true) {
        rollbackReason = 'APPLY_RESULT_REJECTED';
        throw applyRollbackError;
      }

      const persistedTimeline = Array.isArray(applyResult?.routeTimeline)
        ? applyResult.routeTimeline
        : (Array.isArray(applyResult?.fullTimeline) ? applyResult.fullTimeline : []);
      const persistedFingerprint = this.buildManualFitTimelineFingerprint(persistedTimeline);
      const skipStrictFingerprintForClosedConflict =
        canForceClosedHotspotConflict === true &&
        applyResult?.forceConflictInsertionApplied === true;

      if (
        !skipStrictFingerprintForClosedConflict &&
        persistedFingerprint !== entry.proposedTimelineFingerprint
      ) {
        console.warn('[FitHere][confirm_fingerprint_mismatch]', {
          attemptId: entry.attemptId,
          expected: entry.proposedTimelineFingerprint,
          actual: persistedFingerprint,
          previewTimelineCount: entry.proposedTimelineSnapshot?.length || 0,
          persistedTimelineCount: persistedTimeline.length,
        });
        rollbackReason = 'TIMELINE_MISMATCH';
        throw applyRollbackError;
      }
    }, { timeout: manualHotspotTxTimeoutMs });
  } catch (error: any) {
    if (error !== applyRollbackError) {
      await this.cleanupStaleManualHotspotRows(Number(planId), Number(entry.routeId), normalizedHotspotIds);
      throw error;
    }
  }

  if (!applyResult || applyResult?.success !== true || applyResult?.inserted !== true) {
    throw new ConflictException({
      success: false,
      inserted: false,
      code: rollbackReason === 'TIMELINE_MISMATCH'
        ? 'FIT_HERE_CONFIRM_TIMELINE_MISMATCH'
        : 'FIT_HERE_CONFIRM_APPLY_REJECTED',
      message: rollbackReason === 'TIMELINE_MISMATCH'
        ? 'Fit Here confirm was rejected because the persisted result differed from the preview.'
        : 'Could not confirm Fit Here insertion.',
      applyCode: String(applyResult?.code || ''),
      applyMessage: String(applyResult?.message || ''),
      applyDebug: applyResult?.resolution?.debug || null,
      applyValidation: applyResult?.validation || null,
      rollbackReason,
    });
  }

  const confirmedTimeline = Array.isArray(applyResult?.routeTimeline)
    ? applyResult.routeTimeline
    : (Array.isArray(applyResult?.fullTimeline) ? applyResult.fullTimeline : []);
  const confirmedAttractions = confirmedTimeline
    .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction');
  const confirmedSelectedRow = confirmedAttractions.find((row: any) => (
    Number(row?.hotspotId || row?.hotspot_ID || row?.locationId || 0) === Number(entry.selectedHotspotId)
  ));
  const confirmedSelectedTimes = this.parsePreviewTimeRangeToUtcDates(confirmedSelectedRow?.timeRange);
  const confirmedSelectedOrder = confirmedAttractions.findIndex((row: any) => (
    Number(row?.hotspotId || row?.hotspot_ID || row?.locationId || 0) === Number(entry.selectedHotspotId)
  ));

  if (confirmedSelectedTimes.start && confirmedSelectedTimes.end) {
    await this.prisma.$transaction(async (tx: any) => {
      await this.activateManualHotspotRowWithTimes(tx, {
        planId: Number(planId),
        routeId: Number(entry.routeId),
        hotspotId: Number(entry.selectedHotspotId),
        userId: Number(userId || 1),
        start: confirmedSelectedTimes.start,
        end: confirmedSelectedTimes.end,
        hotspotOrder: confirmedSelectedOrder >= 0 ? confirmedSelectedOrder + 1 : undefined,
      });
    });
  }

  const persistedManualRow = await this.assertConfirmedManualHotspotPersisted({
    planId: Number(planId),
    routeId: Number(entry.routeId),
    hotspotId: Number(entry.selectedHotspotId),
  });
  const persistedRouteHotspotId = Number(persistedManualRow.route_hotspot_ID || 0);

  await this.deleteManualFitAttemptEntry(entry.attemptId);
  return {
    success: true,
    attemptId: entry.attemptId,
    planId: Number(planId),
    routeId: Number(entry.routeId),
    selectedHotspotId: Number(entry.selectedHotspotId),
    anchorLabel: entry.anchorLabel,
    ...applyResult,
    routeHotspotId: persistedRouteHotspotId,
    resolution: {
      ...(applyResult?.resolution || {}),
      scheduledManualHotspots: Array.isArray(applyResult?.resolution?.scheduledManualHotspots)
        ? applyResult.resolution.scheduledManualHotspots.map((row: any) => {
            const hotspotId = Number(row?.hotspotId || row?.id || 0);
            if (hotspotId !== Number(entry.selectedHotspotId)) return row;

            return {
              ...row,
              hotspotId,
              routeHotspotId: persistedRouteHotspotId,
              isManual: true,
              planOwnWay: true,
            };
          })
        : [{
            hotspotId: Number(entry.selectedHotspotId),
            routeHotspotId: persistedRouteHotspotId,
            isManual: true,
            planOwnWay: true,
          }],
    },
  };
}

export async function assertConfirmedManualHotspotPersistedImpl(this: any, params: any) {
  const row = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findFirst({
    where: {
      itinerary_plan_ID: Number(params.planId),
      itinerary_route_ID: Number(params.routeId),
      hotspot_ID: Number(params.hotspotId),
      item_type: 4,
      deleted: 0,
      status: 1,
      hotspot_plan_own_way: 1,
    },
    orderBy: { route_hotspot_ID: 'desc' },
    select: {
      route_hotspot_ID: true,
      hotspot_ID: true,
      itinerary_route_ID: true,
      hotspot_plan_own_way: true,
      hotspot_order: true,
    },
  });

  if (!row?.route_hotspot_ID) {
    throw new InternalServerErrorException(
      'Fit Here confirm returned success but the manual hotspot was not persisted. Please retry.',
    );
  }

  return row;
}
