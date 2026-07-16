import { Injectable } from '@nestjs/common';

type ManualHotspotTimingPolicy = {
  mode: 'MANUAL_HOTSPOT';
  startTime: string;
  endTime: string;
  isFirstRoute: boolean;
  isLastRoute: boolean;
  autoBuildCutoffBypassed: boolean;
  hotelCheckInCutoff: string;
  lastDayDepartureBufferApplied: boolean;
  allowOffRouteWhenTimePermits?: boolean;
  note: string;
};

type ManualInsertionCandidateResult = {
  success: boolean;
  candidateIndex: number;
  fullTimeline: any[];
  reason?: string | null;
  slotInsights?: any[];
};

type Callbacks = {
  distanceBetweenHotspots?: (...args: any[]) => number;
  evaluateTimelineRowAgainstOperatingHours?: (...args: any[]) => any;
  calculateRouteEndOverflowMinutes?: (...args: any[]) => number;
};

@Injectable()
export class ItineraryManualFitValidationService {
  private callbacks: Callbacks = {};

  setCallbacks(callbacks: Callbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  resolveSelectedManualPriority(params: {
    selectedHotspotId: number;
    manualInsertionFit?: any;
    options?: any;
    selectedMaster?: any;
    focusMaster?: any;
  }): number {
    const explicit =
      Number(params?.options?.manualPriority || 0)
      || Number(params?.manualInsertionFit?.selectedManualPriority || 0)
      || Number(params?.manualInsertionFit?.manualPriority || 0);

    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return 4;
  }

  buildManualSlotInsights(
    candidates: ManualInsertionCandidateResult[],
    manualHotspotIds: number[],
    baselineAttractions: any[],
    masterMap: Map<number, any>,
  ): Array<{
    slotOrder: number;
    candidateIndex: number;
    distanceDelta: number;
    fromName: string;
    toName: string;
    directKm: number;
    viaKm: number;
    isBest: boolean;
    proposedTimeRange: string | null;
    operatingHours: string | null;
    fitsTiming: boolean;
    fitsOverall: boolean;
    reason: string | null;
  }> {
    const manualSet = new Set((manualHotspotIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0));

    const sorted = [...(baselineAttractions || [])]
      .filter((r: any) => {
        const itemType = Number(r?.item_type ?? r?.itemType ?? 0);
        if (itemType > 0) return itemType === 4;
        return Number(r?.hotspotId ?? r?.hotspot_ID ?? 0) > 0;
      })
      .sort((a: any, b: any) => Number(a?.hotspotOrder ?? a?.hotspot_order ?? 0) - Number(b?.hotspotOrder ?? b?.hotspot_order ?? 0));

    const manualHotspotId = manualHotspotIds && manualHotspotIds.length > 0 ? manualHotspotIds[0] : 0;
    const distanceBetweenHotspots = this.callbacks.distanceBetweenHotspots || (() => 0);

    const built = (candidates || []).map((candidate, index) => {
      const selectedRow = (candidate?.fullTimeline || []).find((row: any) => {
        const hotspotId = Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0);
        return Number(row?.item_type || 0) === 4 && manualSet.has(hotspotId);
      });

      const fitsTiming = selectedRow?.isConflict !== true;
      const ci = Number(candidate?.candidateIndex ?? index);
      const fromRow = ci > 0 ? sorted[ci - 1] : null;
      const toRow = ci < sorted.length ? sorted[ci] : null;
      const fromName = fromRow ? String(fromRow?.hotspot_name || fromRow?.name || `Stop ${ci}`) : 'Route Start';
      const toName = toRow ? String(toRow?.hotspot_name || toRow?.name || `Stop ${ci + 1}`) : 'Hotel / Destination';
      const fromId = Number(fromRow?.hotspot_ID || fromRow?.hotspotId || 0);
      const toId = Number(toRow?.hotspot_ID || toRow?.hotspotId || 0);

      const directKmRaw = fromId && toId ? distanceBetweenHotspots(masterMap, fromId, toId) : 0;
      const viaFromManualRaw = fromId && manualHotspotId
        ? distanceBetweenHotspots(masterMap, fromId, manualHotspotId)
        : 0;
      const viaManualToRaw = manualHotspotId && toId
        ? distanceBetweenHotspots(masterMap, manualHotspotId, toId)
        : 0;
      const directKm = Number(directKmRaw.toFixed(2));
      const localDetourKmRaw = (fromId && toId && manualHotspotId)
        ? Math.max(0, (viaFromManualRaw + viaManualToRaw) - directKmRaw)
        : 0;
      const extraKm = Number(localDetourKmRaw.toFixed(2));
      const viaKm = Number((directKmRaw + localDetourKmRaw).toFixed(2));

      let isGeographicallyFeasible = true;
      let geoReason: string | null = null;
      if (fromId && toId && manualHotspotId && fromRow && toRow) {
        const detourRatio = directKmRaw > 0 ? (localDetourKmRaw / directKmRaw) : 0;
        const detourTooHigh = localDetourKmRaw > 0.5;
        const ratioTooHigh = directKmRaw > 0 && detourRatio > 0.08;
        isGeographicallyFeasible = !(detourTooHigh || ratioTooHigh);
        if (!isGeographicallyFeasible) {
          geoReason = `${String(selectedRow?.hotspot_name || 'Hotspot')} is geographically off the direct route between ${fromName} and ${toName} (detour ~${extraKm.toFixed(1)} km).`;
        }
      }

      const isOverallFeasible = candidate?.success === true && isGeographicallyFeasible;
      return {
        slotOrder: index,
        candidateIndex: ci,
        distanceDelta: extraKm,
        fromName,
        toName,
        directKm,
        viaKm,
        isBest: false,
        proposedTimeRange: selectedRow?.timeRange || null,
        operatingHours: selectedRow?.timings || null,
        fitsTiming,
        fitsOverall: isOverallFeasible,
        reason: fitsTiming
          ? (isOverallFeasible ? null : (geoReason || String(candidate?.reason || 'This slot does not fit route constraints.')))
          : String(selectedRow?.conflictReason || candidate?.reason || 'Will not fit between these stops.'),
      };
    });

    const feasible = built.filter((slot) => slot.fitsOverall);
    const pool = feasible.length > 0 ? feasible : built;
    if (pool.length > 0) {
      const best = pool.reduce((a, b) => a.distanceDelta <= b.distanceDelta ? a : b);
      best.isBest = true;
    }
    return built;
  }

  buildManualHotspotValidation(params: {
    route: any;
    requestedHotspotIds: number[];
    fullTimeline: any[];
    manualTimingPolicy: ManualHotspotTimingPolicy;
    adaptive: {
      requiresConfirmation: boolean;
      unscheduledManualHotspots: Array<{ id: number; name: string; reason: string }>;
      reason: string | null;
    };
  }): {
    passesScheduleRules: boolean;
    readyToApply: boolean;
    requiresPriorityConfirmation: boolean;
    requiresTimingRiskConfirmation?: boolean;
    requiresForceConfirmation: boolean;
    stillUnschedulable: boolean;
    softManualRouteFitConflict: boolean;
    routeEndOverflowMinutes: number;
    manualTimingPolicy: ManualHotspotTimingPolicy;
    openingHourConflictCount: number;
    selectedManualConflictCount: number;
    scheduledSelectedManualCount: number;
    unscheduledManualCount: number;
    reason: string | null;
    selectedOpeningConflict?: any | null;
  } {
    const { route, requestedHotspotIds, fullTimeline, manualTimingPolicy, adaptive } = params;
    const requestedHotspotIdSet = new Set((requestedHotspotIds || [])
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0));
    const calculateOverflow = this.callbacks.calculateRouteEndOverflowMinutes || (() => 0);
    const evaluateOperatingHours = this.callbacks.evaluateTimelineRowAgainstOperatingHours || (() => ({ valid: true }));
    const routeEndOverflowMinutes = calculateOverflow(fullTimeline || [], route, manualTimingPolicy.endTime);
    const isAttractionRow = (row: any) => String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
    const getRowHotspotId = (row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0);
    const selectedAttractionRows = (fullTimeline || []).filter((row: any) => isAttractionRow(row) && requestedHotspotIdSet.has(getRowHotspotId(row)));
    const selectedAttractionRowIds = new Set<number>(selectedAttractionRows.map(getRowHotspotId).filter((id: number) => Number.isFinite(id) && id > 0));
    const selectedOpeningConflictRows: any[] = [];
    const openingHourConflictRows = selectedAttractionRows.filter((row: any) => {
      const evaluation = evaluateOperatingHours(row);
      if (evaluation.valid === false) {
        selectedOpeningConflictRows.push({
          hotspotId: getRowHotspotId(row),
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${getRowHotspotId(row)}`),
          attemptedVisitTime: evaluation.attemptedVisitTime,
          attemptedStartTime: evaluation.attemptedStartLabel,
          attemptedEndTime: evaluation.attemptedEndLabel,
          operatingHours: evaluation.operatingHours,
          openingTime: evaluation.openingLabel,
          closingTime: evaluation.closingLabel,
          reason: evaluation.reason,
          reasonCode: 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME',
        });
        return true;
      }
      return false;
    });
    const selectedManualConflictRows = openingHourConflictRows;
    const scheduledSelectedRows = selectedAttractionRows.filter((row: any) => {
      const evaluation = evaluateOperatingHours(row);
      return row?.isConflict !== true && Number(row?.is_conflict || 0) !== 1 && evaluation.valid !== false;
    });
    const selectedOpeningConflict = selectedOpeningConflictRows[0] || null;
    const rawStillUnschedulable = Array.isArray(adaptive?.unscheduledManualHotspots) && adaptive.unscheduledManualHotspots.length > 0;
    const requiresPriorityConfirmation = adaptive?.requiresConfirmation === true;
    const manualRelaxedRouteFit = manualTimingPolicy?.mode === 'MANUAL_HOTSPOT' && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
    const selectedHasPreviewRow = selectedAttractionRows.length > 0;
    const stillUnschedulable = rawStillUnschedulable && !selectedHasPreviewRow;
    const unscheduledManualHotspots = Array.isArray(adaptive?.unscheduledManualHotspots)
      ? adaptive.unscheduledManualHotspots.filter((row: any) => !selectedAttractionRowIds.has(getRowHotspotId(row)))
      : [];
    const unscheduledReasons = [String(adaptive?.reason || ''), ...((adaptive?.unscheduledManualHotspots || []).map((row: any) => String(row?.reason || '')))].join(' ').toUpperCase();
    const onlySoftManualRouteFitConflict = manualRelaxedRouteFit && rawStillUnschedulable && routeEndOverflowMinutes === 0 && selectedManualConflictRows.length === 0
      && (unscheduledReasons.includes('NO_FEASIBLE_ROUTE_SLOT') || unscheduledReasons.includes('OFF-ROUTE') || unscheduledReasons.includes('OFF_ROUTE') || unscheduledReasons.includes('BACKTRACK') || unscheduledReasons.includes('DETOUR'));
    const passesScheduleRules = routeEndOverflowMinutes === 0 && selectedManualConflictRows.length === 0 && (!stillUnschedulable || onlySoftManualRouteFitConflict);

    let reason: string | null = null;
    if (requiresPriorityConfirmation) reason = 'Priority 3 hotspots would need to be removed. Confirmation required.';
    else if (selectedOpeningConflict) reason = selectedOpeningConflict.reason || `${selectedOpeningConflict.hotspotName} cannot be inserted here because attempted visit time is ${selectedOpeningConflict.attemptedVisitTime}, but operating hours are ${selectedOpeningConflict.operatingHours}.`;
    else if (routeEndOverflowMinutes > 0) reason = 'Route end time overflow after rebuilt manual hotspot insertion.';
    else if (selectedManualConflictRows.length > 0) {
      const firstConflict = selectedManualConflictRows[0];
      const conflictReason = String(firstConflict?.conflictReason || firstConflict?.conflict_reason || '').trim();
      reason = conflictReason ? `Opening/timing conflict: ${conflictReason}` : 'Opening/timing conflict: selected manual hotspot does not fit the rebuilt time slot or operating window.';
    } else if (onlySoftManualRouteFitConflict) reason = 'Manual hotspot adds extra distance or off-route travel, but it is allowed because the rebuilt route is within the manual timing window.';
    else if (stillUnschedulable) reason = adaptive?.reason || adaptive?.unscheduledManualHotspots?.[0]?.reason || 'Manual hotspot could not be scheduled within valid route constraints.';

    const requiresForceConfirmation = routeEndOverflowMinutes === 0 && selectedManualConflictRows.length > 0 && !requiresPriorityConfirmation;
    return {
      passesScheduleRules,
      readyToApply: passesScheduleRules && !requiresPriorityConfirmation,
      requiresPriorityConfirmation,
      requiresForceConfirmation,
      stillUnschedulable: stillUnschedulable && !onlySoftManualRouteFitConflict,
      softManualRouteFitConflict: onlySoftManualRouteFitConflict,
      routeEndOverflowMinutes,
      manualTimingPolicy,
      openingHourConflictCount: openingHourConflictRows.length,
      selectedManualConflictCount: selectedManualConflictRows.length,
      scheduledSelectedManualCount: scheduledSelectedRows.length,
      unscheduledManualCount: unscheduledManualHotspots.length,
      reason,
      selectedOpeningConflict,
    };
  }
}
