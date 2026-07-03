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
  selectedHotspotId?: number,
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

  const hotspotIds = routeHotspots
    .map((row: any) => Number(row?.hotspot_ID || 0))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  const hotspotMasters = hotspotIds.length > 0
    ? await this.prisma.dvi_hotspot_place.findMany({
        where: {
          hotspot_ID: { in: hotspotIds },
          deleted: 0,
        },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
        },
      })
    : [];
  const hotspotNameById = new Map<number, string>(
    hotspotMasters.map((row: any) => [Number(row?.hotspot_ID || 0), String(row?.hotspot_name || '').trim()]),
  );

  const rows = routeHotspots.map((row: any, index: number) => ({
    index,
    routeHotspotId: Number(row?.route_hotspot_ID || 0),
    hotspotId: Number(row?.hotspot_ID || 0),
    hotspotOrder: Number(row?.hotspot_order || index + 1),
    hotspotName: hotspotNameById.get(Number(row?.hotspot_ID || 0)) || null,
  }));

  const findByRouteHotspotId = (value: any) => rows.find((row) => row.routeHotspotId === Number(value || 0));
  const findByHotspotId = (value: any) => rows.find((row) => row.hotspotId === Number(value || 0));
  const normalizeLabel = (value: any): string =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const findByLabel = (value: any) => {
    const label = normalizeLabel(value);
    if (!label) return null;
    return rows.find((row) => normalizeLabel(row.hotspotName).includes(label)) || null;
  };

  const afterRow =
    findByRouteHotspotId(anchor?.afterRouteHotspotId) ||
    findByRouteHotspotId(anchor?.afterRowId) ||
    findByHotspotId(anchor?.afterHotspotId) ||
    findByLabel(anchor?.anchorFrom) ||
    findByLabel(anchor?.anchorLabel);

  const beforeRow =
    findByRouteHotspotId(anchor?.beforeRouteHotspotId) ||
    findByRouteHotspotId(anchor?.beforeRowId) ||
    findByHotspotId(anchor?.beforeHotspotId) ||
    findByLabel(anchor?.anchorTo);

  let anchorIndex = Number.isFinite(Number(anchor?.anchorIndex))
    ? Number(anchor.anchorIndex)
    : 0;

  let resolvedBeforeRow = beforeRow;

  if (anchorIntent === 'AFTER_START') {
    anchorIndex = 0;
    // Treat "after start" as the concrete gap before the first attraction.
    // This keeps the exact anchor pinned to the route's first hotspot instead
    // of letting downstream slot matching drift toward hotel/destination gaps.
    resolvedBeforeRow = rows[0] || null;
  }

  if (anchorIntent === 'AFTER_ATTRACTION') {
    let resolvedAfterRow = afterRow;
    if (!resolvedAfterRow && Number.isFinite(Number(selectedHotspotId || 0)) && Number(selectedHotspotId || 0) > 0) {
      const selectedRow = findByHotspotId(selectedHotspotId);
      if (selectedRow && selectedRow.index > 0) {
        resolvedAfterRow = rows[selectedRow.index - 1] || rows[0] || null;
      }
    }
    if (!resolvedAfterRow) {
      resolvedAfterRow = rows[Math.max(0, Math.min(anchorIndex, Math.max(0, rows.length - 1)))] || rows[0] || null;
    }
    if (!resolvedAfterRow) {
      throw new BadRequestException('Invalid Fit Here anchor: attraction anchor was not found on this route.');
    }

    anchorIndex = Number(resolvedAfterRow.index);
    if (!afterRow) {
      console.warn('[FitHere][anchor_fallback_to_live_route_gap]', {
        routeId: Number(routeId),
        selectedHotspotId: Number(selectedHotspotId || 0),
        anchorIntent,
        requestedAfterHotspotId: Number(anchor?.afterHotspotId || 0),
        requestedAfterRouteHotspotId: Number(anchor?.afterRouteHotspotId || 0),
        resolvedAfterHotspotId: Number(resolvedAfterRow?.hotspotId || 0),
      });
    }
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
    beforeRouteHotspotId: resolvedBeforeRow?.routeHotspotId ?? null,
    beforeHotspotId: resolvedBeforeRow?.hotspotId ?? null,
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

  const resolvedAnchor = await this.resolveManualFitHereAnchor(Number(data.routeId), data.anchor || {}, Number(data.selectedHotspotId || 0));
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
  const finalizedTimelineForAnchorValidation =
    Array.isArray((response as any).finalizedTimeline) && (response as any).finalizedTimeline.length > 0
      ? (response as any).finalizedTimeline
      : (Array.isArray((response as any).proposedTimeline) ? (response as any).proposedTimeline : []);
  const timelineAttractionHotspotIds = finalizedTimelineForAnchorValidation
    .filter((row: any) => {
      const rowType = String(row?.type || '').toLowerCase();
      return rowType === 'attraction' || Number(row?.item_type || 0) === 4;
    })
    .map((row: any) => Number(
      row?.hotspotId ??
      row?.hotspot_ID ??
      row?.locationId ??
      row?.hotspot_id ??
      row?.id ??
      0,
    ))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const selectedHotspotIdForPreview = Number(data.selectedHotspotId || 0);
  const selectedAttractionIndex = timelineAttractionHotspotIds.indexOf(selectedHotspotIdForPreview);

  let selectedHotspotPreservedInPreview =
    selectedHotspotIdForPreview > 0 && selectedAttractionIndex >= 0;

  if (resolvedAnchor.exactSelectedGap === true && selectedHotspotPreservedInPreview === true) {
    const beforeHotspotId = Number(resolvedAnchor.beforeHotspotId || 0);
    const beforeIndex = beforeHotspotId > 0
      ? timelineAttractionHotspotIds.indexOf(beforeHotspotId)
      : -1;

    if (beforeIndex >= 0 && selectedAttractionIndex > beforeIndex) {
      selectedHotspotPreservedInPreview = false;
    }

    if (resolvedAnchor.anchorIntent === 'AFTER_START') {
      const blockersBeforeSelected = timelineAttractionHotspotIds
        .slice(0, selectedAttractionIndex)
        .filter((id: number) => id !== selectedHotspotIdForPreview);

      if (blockersBeforeSelected.length > 0) {
        selectedHotspotPreservedInPreview = false;
      }
    }
  }
  const selectedAnchorPreserved =
    resolvedAnchor.exactSelectedGap === true
      ? this.manualFitTimelinePreservesSelectedAnchor({
          timeline: finalizedTimelineForAnchorValidation,
          selectedHotspotId: Number(data.selectedHotspotId),
          afterHotspotId: resolvedAnchor.afterHotspotId ?? null,
          beforeHotspotId: resolvedAnchor.beforeHotspotId ?? null,
          anchorIntent: resolvedAnchor.anchorIntent,
        })
      : true;

  (response as any).selectedAnchorPreserved = selectedAnchorPreserved === true;
  (response as any).selectedHotspotPreserved = selectedHotspotPreservedInPreview;

  const normalizeCannotFitExactAnchorResponse = (rejectedMessage: string, exactAnchorMismatch: any | null) => {
    const failedRescueDisplay = {
      hasRemovals: false,
      title: 'Rescue attempts checked',
      removalOrderLabel: 'Rescue order checked: Non-manual / Priority 4 -> Priority 3 -> Priority 2 -> Priority 1',
      removedItems: [],
      noRemovalText: 'No anchor-preserving rescue removal unlocked this position.',
      exactAnchorFailure: true,
    };

    (response as any).canConfirm = false;
    (response as any).resultType = 'CANNOT_FIT';
    (response as any).acceptedReason = null;
    (response as any).rejectedReasons = [String(rejectedMessage || 'No valid anchor-preserving solution found for this selected position.').trim()];
    (response as any).confirmButtonVariant = 'default';
    (response as any).requiresTimingRiskConfirmation = false;
    (response as any).requiresPriorityRemovalConfirmation = false;
    (response as any).changesRequiredDisplay = failedRescueDisplay;
    (response as any).removedHotspots = [];
    (response as any).affectedPriorityHotspots = [];
    (response as any).requiresRemovalAcknowledgementHotspotIds = [];
    (response as any).proposedTimeline = [];
    (response as any).finalizedTimeline = [];
    (response as any).authoritativeTimelineSource = 'EXACT_ANCHOR_NO_VALID_RESULT';
    (response as any).proposedTimelineFingerprint = this.buildManualFitTimelineFingerprint([]);
    (response as any).exactAnchorMismatch = exactAnchorMismatch;
    (response as any).selectedAnchorPreserved = false;

    if ((response as any).resolution && typeof (response as any).resolution === 'object') {
      (response as any).resolution.requiresTimingRiskConfirmation = false;
      (response as any).resolution.requiresPriorityRemovalConfirmation = false;
      (response as any).resolution.changesRequiredDisplay = failedRescueDisplay;
      (response as any).resolution.removedHotspots = [];
      (response as any).resolution.topPriorityAffected = [];
      (response as any).resolution.exactAnchorMismatch = exactAnchorMismatch;
    }
  };

  if (
    resolvedAnchor.exactSelectedGap === true &&
    (response as any).canConfirm === true &&
    selectedHotspotPreservedInPreview !== true
  ) {
    normalizeCannotFitExactAnchorResponse(
      'The selected manual hotspot was only placed after the clicked before-row or downstream blockers. This is not a valid selected-hotspot-preserving rescue.',
      {
        message: 'The selected manual hotspot was only placed after the clicked before-row or downstream blockers.',
        anchorIntent: resolvedAnchor.anchorIntent,
        anchorFrom: resolvedAnchor.anchorFrom ?? null,
        anchorTo: resolvedAnchor.anchorTo ?? null,
        afterHotspotId: resolvedAnchor.afterHotspotId ?? null,
        beforeHotspotId: resolvedAnchor.beforeHotspotId ?? null,
      },
    );
    (response as any).selectedHotspotPreserved = false;
  }

  if (resolvedAnchor.exactSelectedGap === true && selectedAnchorPreserved !== true) {
    const anchorMismatchMessage = String(
      resolvedAnchor.anchorIntent === 'AFTER_START'
        ? 'The selected hotspot was rescued, but it could not stay before the first attraction.'
        : `The selected hotspot was rescued, but it could not stay immediately after ${resolvedAnchor.anchorFrom || 'the selected attraction'}.`,
    ).trim();
    (response as any).selectedAnchorPreserved = false;
    (response as any).exactAnchorMismatch = {
      message: anchorMismatchMessage,
      anchorIntent: resolvedAnchor.anchorIntent,
      anchorFrom: resolvedAnchor.anchorFrom ?? null,
      anchorTo: resolvedAnchor.anchorTo ?? null,
      afterHotspotId: resolvedAnchor.afterHotspotId ?? null,
      beforeHotspotId: resolvedAnchor.beforeHotspotId ?? null,
    };

    if ((response as any).resolution && typeof (response as any).resolution === 'object') {
      (response as any).resolution.exactAnchorMismatch = (response as any).exactAnchorMismatch;
    }

    if (
      (response as any).canConfirm !== true &&
      selectedHotspotPreservedInPreview !== true &&
      selectedAnchorPreserved !== true
    ) {
      normalizeCannotFitExactAnchorResponse(anchorMismatchMessage, (response as any).exactAnchorMismatch);
      (response as any).selectedHotspotPreserved = false;
    }
  } else if (
    resolvedAnchor.exactSelectedGap === true &&
    (response as any).canConfirm !== true &&
    selectedHotspotPreservedInPreview !== true &&
    selectedAnchorPreserved !== true
  ) {
    normalizeCannotFitExactAnchorResponse(
      String(
        Array.isArray((response as any).rejectedReasons) && (response as any).rejectedReasons.length > 0
          ? (response as any).rejectedReasons[0]
          : 'No valid selected-hotspot-preserving solution was found after all allowed rescue attempts.',
      ).trim(),
      null,
    );
    (response as any).selectedHotspotPreserved = false;
  }

  if (
    resolvedAnchor.exactSelectedGap === true &&
    (response as any).canConfirm !== true &&
    selectedHotspotPreservedInPreview === true
  ) {
    (response as any).resultType = Array.isArray((response as any).removedHotspots) && (response as any).removedHotspots.length > 0
      ? 'FITS_WITH_OPTIONAL_REMOVAL'
      : 'FITS_DIRECTLY';
    (response as any).acceptedReason =
      String((response as any).exactAnchorMismatch?.message || (response as any).acceptedReason || '').trim() || null;
    (response as any).rejectedReasons = [];
    (response as any).authoritativeTimelineSource = 'BACKEND_FINALIZED_PATCHED_TIMELINE';
  }

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
    selectedAnchorPreserved: selectedAnchorPreserved === true,
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

  if (
    resolvedAnchor.exactSelectedGap === true &&
    (response as any).canConfirm !== true &&
    (response as any).selectedHotspotPreserved !== true
  ) {
    const failedRescueDisplay = {
      hasRemovals: false,
      title: 'Rescue attempts checked',
      removalOrderLabel: 'Rescue order checked: Non-manual / Priority 4 -> Priority 3 -> Priority 2 -> Priority 1',
      removedItems: [],
      noRemovalText: 'No selected-hotspot-preserving rescue removal unlocked this position.',
      exactAnchorFailure: true,
    };

    (response as any).changesRequiredDisplay = failedRescueDisplay;
    (response as any).removedHotspots = [];
    (response as any).affectedPriorityHotspots = [];
    (response as any).requiresRemovalAcknowledgementHotspotIds = [];
    (response as any).proposedTimeline = [];
    (response as any).finalizedTimeline = [];
    (response as any).authoritativeTimelineSource = 'EXACT_ANCHOR_NO_VALID_RESULT';
    (response as any).proposedTimelineFingerprint = this.buildManualFitTimelineFingerprint([]);
    (response as any).selectedAnchorPreserved = false;
    (response as any).selectedHotspotPreserved = false;

    if ((response as any).resolution && typeof (response as any).resolution === 'object') {
      (response as any).resolution.changesRequiredDisplay = failedRescueDisplay;
      (response as any).resolution.removedHotspots = [];
      (response as any).resolution.topPriorityAffected = [];
    }
  }

  if (
    resolvedAnchor.exactSelectedGap === true &&
    selectedHotspotPreservedInPreview === true &&
    (response as any).canConfirm !== true
  ) {
    (response as any).canConfirm = true;
    (response as any).resultType = Array.isArray((response as any).removedHotspots) && (response as any).removedHotspots.length > 0
      ? 'FITS_WITH_OPTIONAL_REMOVAL'
      : 'FITS_DIRECTLY';
    (response as any).acceptedReason =
      String((response as any).exactAnchorMismatch?.message || (response as any).acceptedReason || '').trim() || null;
    (response as any).rejectedReasons = [];

    if ((response as any).changesRequiredDisplay && typeof (response as any).changesRequiredDisplay === 'object') {
      (response as any).changesRequiredDisplay.exactAnchorFailure = false;
      if (!String((response as any).changesRequiredDisplay.noRemovalText || '').trim()) {
        (response as any).changesRequiredDisplay.noRemovalText = 'The selected hotspot was rescued, but the clicked anchor moved.';
      }
    }

    if ((response as any).resolution && typeof (response as any).resolution === 'object') {
      (response as any).resolution.canForceConflict = false;
      (response as any).resolution.requiresTimingRiskConfirmation = false;
      (response as any).resolution.requiresPriorityRemovalConfirmation = false;
    }
  }

  const isExactAnchorNoValidResult =
    String((response as any).authoritativeTimelineSource || '').toUpperCase() === 'EXACT_ANCHOR_NO_VALID_RESULT';
  const normalizedSelectedAnchorPreserved =
    isExactAnchorNoValidResult
      ? false
      : this.manualFitTimelinePreservesSelectedAnchor({
          timeline: Array.isArray((response as any).finalizedTimeline) && (response as any).finalizedTimeline.length > 0
            ? (response as any).finalizedTimeline
            : (response as any).proposedTimeline,
          selectedHotspotId: Number(data.selectedHotspotId),
          afterHotspotId: resolvedAnchor.afterHotspotId ?? null,
          beforeHotspotId: resolvedAnchor.beforeHotspotId ?? null,
          anchorIntent: resolvedAnchor.anchorIntent,
        });

  (response as any).selectedAnchorPreserved = normalizedSelectedAnchorPreserved;
  cacheEntry.canConfirm = (response as any).canConfirm === true;
  cacheEntry.requiresTimingRiskConfirmation = (response as any).requiresTimingRiskConfirmation === true;
  cacheEntry.requiresPriorityRemovalConfirmation = (response as any).requiresPriorityRemovalConfirmation === true;
  cacheEntry.selectedAnchorPreserved = (response as any).selectedAnchorPreserved === true;
  cacheEntry.selectedHotspotPreserved = (response as any).selectedHotspotPreserved === true;
  cacheEntry.selectedOpeningConflict = (response as any).selectedOpeningConflict || null;
  cacheEntry.resultType = String((response as any).resultType || '').trim() || null;
  cacheEntry.acceptedReason = (response as any).acceptedReason || null;
  cacheEntry.rejectedReasons = Array.isArray((response as any).rejectedReasons)
    ? [...(response as any).rejectedReasons]
    : [];
  cacheEntry.authoritativeTimelineSource = String((response as any).authoritativeTimelineSource || cacheEntry.authoritativeTimelineSource || '').trim() || null;
  cacheEntry.proposedTimelineSnapshot = Array.isArray((response as any).proposedTimeline)
    ? (response as any).proposedTimeline
    : cacheEntry.proposedTimelineSnapshot;
  cacheEntry.proposedTimelineFingerprint = String((response as any).proposedTimelineFingerprint || cacheEntry.proposedTimelineFingerprint || '').trim();
  cacheEntry.removedHotspotsSnapshot = Array.isArray((response as any).removedHotspots)
    ? (response as any).removedHotspots
    : cacheEntry.removedHotspotsSnapshot;

  await this.saveManualFitAttemptEntry(cacheEntry);

  return response;
}

const getManualAutoFitRemovedRows = (attempt: any): any[] => {
  const rows = [
    ...(Array.isArray(attempt?.removedHotspots) ? attempt.removedHotspots : []),
    ...(Array.isArray(attempt?.resolution?.removedHotspots) ? attempt.resolution.removedHotspots : []),
    ...(Array.isArray(attempt?.changesRequiredDisplay?.removedItems) ? attempt.changesRequiredDisplay.removedItems : []),
  ];

  const seen = new Set<number>();

  return rows.filter((row: any) => {
    const id = Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || row?.locationId || 0);
    if (!(id > 0)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const getManualAutoFitHighestRemovedPriority = (attempt: any): number | null => {
  const rows = getManualAutoFitRemovedRows(attempt);

  const priorities = rows
    .map((row: any) => Number(row?.priority || row?.hotspotPriority || row?.hotspot_priority || row?.rawPriority || row?.workPriority || 0))
    .filter((priority: number) => [1, 2, 3].includes(priority));

  if (priorities.length === 0) {
    return null;
  }

  return Math.min(...priorities);
};

const scoreManualAutoFitAttempt = (attempt: any): { score: number; reason: string } => {
  const resultType = String(attempt?.resultType || '').toUpperCase();
  const removedRows = getManualAutoFitRemovedRows(attempt);
  const removedCount = removedRows.length;
  const highestRemovedPriority = getManualAutoFitHighestRemovedPriority(attempt);

  let score = 0;
  let reason = 'Cannot fit at this position.';

  if (resultType === 'FITS_DIRECTLY' && attempt?.canConfirm === true) {
    score = 1000;
    reason = 'Clean fit. No hotspot removal required.';
  } else if (resultType === 'FITS_WITH_OPTIONAL_REMOVAL' && attempt?.canConfirm === true) {
    score = 800;
    reason = 'Fits with confirmed changes.';
  } else if (resultType === 'REQUIRES_P3_CONFIRMATION' && attempt?.canConfirm === true) {
    score = 650;
    reason = 'Fits with Priority 3 removal acknowledgement.';
  } else if (resultType === 'PRIORITY_CONFLICT') {
    score = 250;
    reason = 'Protected hotspot impact detected.';
  } else if (resultType === 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME') {
    score = 150;
    reason = 'Selected hotspot is closed at attempted time.';
  } else if (attempt?.canConfirm === true) {
    score = 500;
    reason = 'Can confirm with warnings.';
  }

  score -= removedCount * 120;

  if (highestRemovedPriority === 1) score -= 400;
  if (highestRemovedPriority === 2) score -= 250;
  if (highestRemovedPriority === 3) score -= 100;

  if (attempt?.requiresTimingRiskConfirmation === true) score -= 150;
  if (attempt?.requiresPriorityRemovalConfirmation === true) score -= 100;
  if (attempt?.selectedOpeningConflict) score -= 150;

  return {
    score: Math.max(0, score),
    reason,
  };
};

export async function previewManualHotspotAutoFitHereImpl(
  this: any,
  planId: number,
  data: any,
) {
  if (!(Number(planId) > 0) || !(Number(data?.routeId) > 0) || !(Number(data?.selectedHotspotId) > 0)) {
    throw new BadRequestException('planId, routeId, and selectedHotspotId are required');
  }

  const anchors = Array.isArray(data?.anchors) ? data.anchors : [];

  if (anchors.length === 0) {
    throw new BadRequestException('At least one Fit Here anchor is required for Auto-Preview.');
  }

  const normalizedAnchors = anchors
    .filter((anchor: any) => {
      const intent = String(anchor?.anchorIntent || '').trim().toUpperCase();
      return intent === 'AFTER_START' || intent === 'AFTER_ATTRACTION';
    })
    .map((anchor: any, index: number) => ({
      ...anchor,
      anchorType: 'BETWEEN_ROWS',
      anchorIntent: String(anchor.anchorIntent).trim().toUpperCase(),
      anchorIndex: Number.isFinite(Number(anchor?.anchorIndex)) ? Number(anchor.anchorIndex) : index,
    }));

  if (normalizedAnchors.length === 0) {
    throw new BadRequestException('Auto-Preview only supports Before first attraction and After attraction anchors.');
  }

  const results: any[] = [];
  const anchorPerformance: Array<{
    anchorKey: string;
    anchorLabel: string;
    elapsedMs: number;
    status: 'COMPLETED' | 'FAILED';
    canConfirm: boolean;
    removedCount: number;
  }> = [];
  const startedAtMs = Date.now();

  console.log('[AutoFitHere][start]', {
    planId: Number(planId),
    routeId: Number(data.routeId),
    selectedHotspotId: Number(data.selectedHotspotId),
    totalPositions: normalizedAnchors.length,
  });

  for (let index = 0; index < normalizedAnchors.length; index += 1) {
    const anchor = normalizedAnchors[index];
    const anchorStartedAtMs = Date.now();
    const anchorKey = [
      anchor.anchorIntent,
      Number(anchor.anchorIndex ?? index),
      String(anchor.anchorFrom || ''),
      String(anchor.anchorTo || ''),
      Number(anchor.afterHotspotId || 0),
      Number(anchor.beforeHotspotId || 0),
    ].join(':');
    const anchorLabel = String(
      anchor?.anchorLabel ||
      (anchor?.anchorIntent === 'AFTER_START'
        ? 'Before first attraction'
        : `After ${String(anchor?.anchorFrom || 'selected attraction')}`),
    ).trim();

    console.log('[AutoFitHere][anchor_start]', {
      index: index + 1,
      totalPositions: normalizedAnchors.length,
      anchorKey,
      anchorLabel,
      anchorIntent: anchor.anchorIntent,
      afterHotspotId: Number(anchor.afterHotspotId || 0) || null,
      beforeHotspotId: Number(anchor.beforeHotspotId || 0) || null,
    });

    try {
      const attempt = await previewManualHotspotFitHereImpl.call(this, planId, {
        routeId: Number(data.routeId),
        selectedHotspotId: Number(data.selectedHotspotId),
        anchor,
        allowP3Removal: data.allowP3Removal === true,
        allowP1P2Removal: data.allowP1P2Removal === true,
      });

      const ranking = scoreManualAutoFitAttempt(attempt);
      const elapsedMs = Date.now() - anchorStartedAtMs;
      const removedCount = getManualAutoFitRemovedRows(attempt).length;

      results.push({
        anchorKey,
        anchor,
        attempt,
        status: 'COMPLETED',
        score: ranking.score,
        rankReason: ranking.reason,
        removedCount,
      });

      anchorPerformance.push({
        anchorKey,
        anchorLabel,
        elapsedMs,
        status: 'COMPLETED',
        canConfirm: attempt?.canConfirm === true,
        removedCount,
      });

      console.log('[AutoFitHere][anchor_done]', {
        index: index + 1,
        totalPositions: normalizedAnchors.length,
        anchorKey,
        anchorLabel,
        elapsedMs,
        resultType: String(attempt?.resultType || '').toUpperCase() || null,
        canConfirm: attempt?.canConfirm === true,
        removedCount,
        score: ranking.score,
      });
    } catch (error: any) {
      const elapsedMs = Date.now() - anchorStartedAtMs;
      results.push({
        anchorKey,
        anchor,
        attempt: null,
        status: 'FAILED',
        score: 0,
        rankReason: 'This position could not be previewed.',
        removedCount: 0,
        error: error?.message || 'Could not preview this Fit Here position.',
      });

      anchorPerformance.push({
        anchorKey,
        anchorLabel,
        elapsedMs,
        status: 'FAILED',
        canConfirm: false,
        removedCount: 0,
      });

      console.log('[AutoFitHere][anchor_failed]', {
        index: index + 1,
        totalPositions: normalizedAnchors.length,
        anchorKey,
        anchorLabel,
        elapsedMs,
        error: error?.message || 'Could not preview this Fit Here position.',
      });
    }
  }

  const sortedResults = [...results].sort((a, b) => {
    if (Number(b.score || 0) !== Number(a.score || 0)) {
      return Number(b.score || 0) - Number(a.score || 0);
    }

    return Number(a.anchor?.anchorIndex ?? 9999) - Number(b.anchor?.anchorIndex ?? 9999);
  });

  const best =
    sortedResults.find((row) => row?.attempt?.canConfirm === true) ||
    sortedResults[0] ||
    null;

  const totalElapsedMs = Date.now() - startedAtMs;
  const completedAnchorRuns = anchorPerformance.filter((row) => row.status === 'COMPLETED');
  const avgAnchorMs = anchorPerformance.length > 0
    ? Math.round(anchorPerformance.reduce((sum, row) => sum + Number(row.elapsedMs || 0), 0) / anchorPerformance.length)
    : 0;
  const slowestAnchor = [...anchorPerformance].sort((a, b) => Number(b.elapsedMs || 0) - Number(a.elapsedMs || 0))[0] || null;

  console.log('[AutoFitHere][summary]', {
    planId: Number(planId),
    routeId: Number(data.routeId),
    selectedHotspotId: Number(data.selectedHotspotId),
    totalPositions: normalizedAnchors.length,
    completedPositions: completedAnchorRuns.length,
    failedPositions: anchorPerformance.filter((row) => row.status === 'FAILED').length,
    totalElapsedMs,
    avgAnchorMs,
    slowestAnchorLabel: slowestAnchor?.anchorLabel || null,
    slowestAnchorMs: slowestAnchor?.elapsedMs || null,
  });

  return {
    planId: Number(planId),
    routeId: Number(data.routeId),
    selectedHotspotId: Number(data.selectedHotspotId),
    totalPositions: normalizedAnchors.length,
    completedPositions: results.filter((row) => row.status === 'COMPLETED').length,
    failedPositions: results.filter((row) => row.status === 'FAILED').length,
    selectedBestAttemptId: best?.attempt?.attemptId || null,
    bestAnchorKey: best?.anchorKey || null,
    performanceSummary: {
      totalElapsedMs,
      avgAnchorMs,
      slowestAnchorLabel: slowestAnchor?.anchorLabel || null,
      slowestAnchorMs: slowestAnchor?.elapsedMs || null,
    },
    results: sortedResults,
  };
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
  let applyAlreadyExists = false;
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
        alreadyExists: applyResult?.alreadyExists === true,
        routeTimelineCount: Array.isArray(applyResult?.routeTimeline) ? applyResult.routeTimeline.length : null,
        fullTimelineCount: Array.isArray(applyResult?.fullTimeline) ? applyResult.fullTimeline.length : null,
      });

      applyAlreadyExists = String(applyResult?.code || '') === 'MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE';

      if (applyResult?.success !== true || (applyResult?.inserted !== true && !applyAlreadyExists)) {
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
        !applyAlreadyExists &&
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

  const effectiveApplyResult = applyAlreadyExists
    ? {
        ...applyResult,
        success: true,
        inserted: true,
        alreadyExists: true,
        idempotent: true,
      }
    : applyResult;

  if (!effectiveApplyResult || effectiveApplyResult?.success !== true || effectiveApplyResult?.inserted !== true) {
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

  let confirmedTimeline = Array.isArray(effectiveApplyResult?.routeTimeline)
    ? effectiveApplyResult.routeTimeline
    : (Array.isArray(effectiveApplyResult?.fullTimeline) ? effectiveApplyResult.fullTimeline : []);
  if (confirmedTimeline.length === 0) {
    confirmedTimeline = await this.getRouteTimelineForScoring(this.prisma, Number(planId), Number(entry.routeId));
  }
  const confirmedTimelineDisplay = confirmedTimeline.map((row: any, index: number, rows: any[]) => {
    const rowType = String(row?.type || '').toLowerCase();
    const itemType = Number(row?.item_type || 0);
    const isTravelRow = rowType === 'travel' || itemType === 3 || itemType === 5;
    if (!isTravelRow) return row;

    const previousRelevantRow = [...rows.slice(0, index)].reverse().find((candidate: any) => {
      const candidateType = String(candidate?.type || '').toLowerCase();
      const candidateItemType = Number(candidate?.item_type || 0);
      return candidateType !== 'travel' && candidateItemType !== 3 && candidateItemType !== 5;
    }) || null;
    const nextRelevantRow = rows.slice(index + 1).find((candidate: any) => {
      const candidateType = String(candidate?.type || '').toLowerCase();
      const candidateItemType = Number(candidate?.item_type || 0);
      return candidateType !== 'travel' && candidateItemType !== 3 && candidateItemType !== 5;
    }) || null;

    const fromName = String(
      previousRelevantRow?.text ||
      previousRelevantRow?.name ||
      row?.fromName ||
      row?.displayFromName ||
      row?.from ||
      'Previous Stop',
    ).trim();
    const toName = String(
      nextRelevantRow?.text ||
      nextRelevantRow?.name ||
      row?.toName ||
      row?.displayToName ||
      row?.to ||
      'Next Stop',
    ).trim();
    const fromHotspotId = Number(
      previousRelevantRow?.hotspotId ||
      previousRelevantRow?.hotspot_ID ||
      previousRelevantRow?.locationId ||
      0,
    );
    const toHotspotId = Number(
      nextRelevantRow?.hotspotId ||
      nextRelevantRow?.hotspot_ID ||
      nextRelevantRow?.locationId ||
      0,
    );
    const durationMinutes = Math.max(1, Math.round(Number(
      row?.matrixDurationMin ||
      row?.durationMinutes ||
      this.getPreviewRowDurationMinutes(row) ||
      10,
    )));
    const distanceKmRaw =
      row?.matrixDistanceKm != null
        ? Number(row.matrixDistanceKm)
        : (row?.distanceKm != null
          ? Number(row.distanceKm)
          : (row?.travelDistanceKm != null
            ? Number(row.travelDistanceKm)
            : (row?.hotspot_travelling_distance != null
              ? Number(row.hotspot_travelling_distance)
              : null)));
    const distanceKm = Number.isFinite(distanceKmRaw as number) ? Number(distanceKmRaw) : null;
    const travelDisplay = this.buildManualFitTravelReplicaDisplayFields(row, durationMinutes, distanceKm);

    return {
      ...row,
      fromName,
      toName,
      from: fromName,
      to: toName,
      displayFromName: fromName,
      displayToName: toName,
      fromHotspotId: fromHotspotId > 0 ? fromHotspotId : null,
      toHotspotId: toHotspotId > 0 ? toHotspotId : null,
      matrixDurationMin: travelDisplay.matrixDurationMin,
      durationMinutes: travelDisplay.durationMinutes,
      duration: travelDisplay.duration,
      travelDuration: travelDisplay.travelDuration,
      matrixDistanceKm: distanceKm,
      distanceKm,
      travelDistanceKm: distanceKm,
      distance: travelDisplay.distance,
      hotspot_travelling_distance: travelDisplay.hotspot_travelling_distance,
      hotspot_traveling_distance: travelDisplay.hotspot_traveling_distance,
      hotspot_travelling_time: travelDisplay.hotspot_travelling_time,
      hotspot_traveling_time: travelDisplay.hotspot_traveling_time,
      source: 'MAIN_TIMELINE_REPLICA',
      isMainTimelineTravelReplica: true,
    };
  });
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
    ...effectiveApplyResult,
    routeTimeline: Array.isArray(effectiveApplyResult?.routeTimeline) && effectiveApplyResult.routeTimeline.length > 0
      ? effectiveApplyResult.routeTimeline
      : confirmedTimelineDisplay,
    fullTimeline: Array.isArray(effectiveApplyResult?.fullTimeline) && effectiveApplyResult.fullTimeline.length > 0
      ? effectiveApplyResult.fullTimeline
      : confirmedTimelineDisplay,
    finalizedTimeline: Array.isArray(effectiveApplyResult?.finalizedTimeline) && effectiveApplyResult.finalizedTimeline.length > 0
      ? effectiveApplyResult.finalizedTimeline
      : confirmedTimelineDisplay,
    proposedTimeline: Array.isArray(effectiveApplyResult?.proposedTimeline) && effectiveApplyResult.proposedTimeline.length > 0
      ? effectiveApplyResult.proposedTimeline
      : confirmedTimelineDisplay,
    routeHotspotId: persistedRouteHotspotId,
    resolution: {
      ...(effectiveApplyResult?.resolution || {}),
      scheduledManualHotspots: Array.isArray(effectiveApplyResult?.resolution?.scheduledManualHotspots)
        ? effectiveApplyResult.resolution.scheduledManualHotspots.map((row: any) => {
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
