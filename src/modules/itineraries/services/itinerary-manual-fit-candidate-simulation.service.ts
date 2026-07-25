import { Injectable } from '@nestjs/common';

type Callbacks = {
  rebuildManualHotspotSet?: (...args: any[]) => Promise<any>;
  buildRouteHotspotInsertionCandidates?: (...args: any[]) => Promise<any>;
  getManualHotspotScheduleState?: (...args: any[]) => Promise<any>;
  getRouteTimelineForScoring?: (...args: any[]) => Promise<any[]>;
  manualFitTimelinePreservesSelectedAnchor?: (...args: any[]) => boolean;
  buildExactAnchorSequentialTimelineAfterRemoval?: (...args: any[]) => Promise<any[]>;
  enrichManualFitPreviewTimelineWithOperatingHours?: (...args: any[]) => Promise<any[]>;
  calculateWaitingMinutes?: (...args: any[]) => number;
  calculateTravelMetricsFromTimeline?: (...args: any[]) => any;
  detectTopPriorityImpact?: (...args: any[]) => any[];
  calculateRouteEndOverflowMinutes?: (...args: any[]) => number;
  scoreManualInsertionCandidate?: (...args: any[]) => number;
  getManualEffectivePriority?: (...args: any[]) => number;
  explainRejectedCandidate?: (...args: any[]) => string | null;
};

@Injectable()
export class ItineraryManualFitCandidateSimulationService {
  private callbacks: Callbacks = {};

  setCallbacks(callbacks: Callbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  async simulateManualInsertionAtPosition(
    tx: any,
    planId: number,
    routeId: number,
    route: any,
    manualHotspotIds: number[],
    position: any,
    baselineTopPriorityByHotspotId: Map<number, { id: number; name: string; priority: number }>,
    masterMap: Map<number, any>,
    options?: any,
  ): Promise<any> {
    const allowTopPriorityRemoval = options?.allowTopPriorityRemoval === true;
    await (this.callbacks.rebuildManualHotspotSet || (async () => undefined))(
      tx,
      Number(planId),
      Number(routeId),
      manualHotspotIds,
      { anchorType: 'after_travel', anchorIndex: Math.max(0, Number(position.anchorOrder) - 1) },
      {
        preferredManualPlacementByRoute: { [Number(routeId)]: { hotspotOrder: Number(position.anchorOrder) } },
        preferredHotspotOrder: options?.preferredHotspotOrder,
        previewOnly: true,
      },
    );

    const afterCandidates = await (this.callbacks.buildRouteHotspotInsertionCandidates || (async () => ({ masterMap, hotspotRows: [] })))(tx, Number(planId), Number(routeId), manualHotspotIds);
    const scheduleState = await (this.callbacks.getManualHotspotScheduleState || (async () => ({ scheduledHotspotIds: [], unscheduledManualHotspots: [] })))(
      tx,
      Number(planId),
      Number(routeId),
      manualHotspotIds,
      afterCandidates.masterMap,
    );

    let fullTimeline = await (this.callbacks.getRouteTimelineForScoring || (async () => []))(tx, Number(planId), Number(routeId));
    let exactAnchorPreserved = true;
    let exactAnchorFailureReason: string | null = null;
    if (options?.exactAnchorMode === true) {
      const selectedHotspotId = Number(manualHotspotIds?.[0] || 0);
      exactAnchorPreserved = this.callbacks.manualFitTimelinePreservesSelectedAnchor
        ? this.callbacks.manualFitTimelinePreservesSelectedAnchor({
            timeline: fullTimeline,
            selectedHotspotId,
            afterHotspotId: Number(options?.afterHotspotId || 0) || null,
            beforeHotspotId: Number(options?.beforeHotspotId || 0) || null,
            anchorIntent: options?.anchorIntent,
          }) === true
        : true;

      if (!exactAnchorPreserved && selectedHotspotId > 0 && this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval) {
        const rebuilt = await this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, fullTimeline, {
          removedHotspotIds: [],
          targetHotspotId: selectedHotspotId,
          routeId: Number(routeId),
          planId: Number(planId),
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
        });
        if (Array.isArray(rebuilt) && rebuilt.length > 0 && this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours) {
          const enriched = await this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours(Number(planId), Number(routeId), rebuilt);
          const rebuiltPreservesAnchor = this.callbacks.manualFitTimelinePreservesSelectedAnchor
            ? this.callbacks.manualFitTimelinePreservesSelectedAnchor({
                timeline: enriched,
                selectedHotspotId,
                afterHotspotId: Number(options?.afterHotspotId || 0) || null,
                beforeHotspotId: Number(options?.beforeHotspotId || 0) || null,
                anchorIntent: options?.anchorIntent,
              })
            : true;
          if (rebuiltPreservesAnchor) {
            fullTimeline = enriched;
            exactAnchorPreserved = true;
          }
        }
      }

      if (!exactAnchorPreserved) {
        exactAnchorFailureReason = options?.anchorIntent === 'AFTER_START'
          ? 'Exact-anchor rebuild failed: selected manual hotspot is not the first attraction after route start.'
          : 'Exact-anchor rebuild failed: selected manual hotspot is not immediately after the clicked anchor attraction.';
      }
    }

    const manualHotspotIdSet = new Set<number>(manualHotspotIds.map((id: number) => Number(id)));
    const waitingMinutes = this.callbacks.calculateWaitingMinutes
      ? this.callbacks.calculateWaitingMinutes(fullTimeline)
      : 0;
    const travelMetrics = this.callbacks.calculateTravelMetricsFromTimeline
      ? this.callbacks.calculateTravelMetricsFromTimeline(fullTimeline, manualHotspotIdSet, masterMap)
      : { extraTravelKm: 0, totalTravelKm: 0, toAndFroPenalty: 0 };
    const timelineAttractionIds = new Set<number>((fullTimeline || [])
      .filter((row: any) => Number(row?.item_type || 0) === 4 || String(row?.type || '').toLowerCase() === 'attraction')
      .map((row: any) => Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || row?.hotspot_id || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0));
    const topPriorityAffected = this.callbacks.detectTopPriorityImpact
      ? this.callbacks.detectTopPriorityImpact(baselineTopPriorityByHotspotId, afterCandidates).filter((row: any) => !timelineAttractionIds.has(Number(row.id)))
      : [];
    const openingHourConflictCount = Number((fullTimeline || []).filter((row: any) => row?.isConflict === true && Number(row?.item_type || 0) === 4).length || 0);
    const routeEndOverflowMinutes = this.callbacks.calculateRouteEndOverflowMinutes
      ? this.callbacks.calculateRouteEndOverflowMinutes(fullTimeline, route, options?.manualTimingPolicy?.endTime)
      : 0;
    const score = this.callbacks.scoreManualInsertionCandidate
      ? this.callbacks.scoreManualInsertionCandidate({
          waitingMinutes,
          extraTravelKm: travelMetrics.extraTravelKm,
          totalTravelKm: travelMetrics.totalTravelKm,
          toAndFroPenalty: travelMetrics.toAndFroPenalty,
          removedOptionalCount: Number(options?.removedOptionalHotspots?.length || 0),
          topPriorityAffectedCount: Number(topPriorityAffected.length || 0),
          routeEndOverflowMinutes,
          openingHourConflictCount,
        })
      : Number.MAX_SAFE_INTEGER;
    const scheduledManualHotspots = (scheduleState.scheduledHotspotIds || []).map((id: number) => {
      const master = afterCandidates.masterMap?.get(Number(id));
      const priority = this.callbacks.getManualEffectivePriority ? this.callbacks.getManualEffectivePriority() : 4;
      return { id: Number(id), name: String(master?.hotspot_name || `Hotspot #${id}`), priorityLabel: `Manual / P${priority}` };
    });
    const requiresConfirmation = topPriorityAffected.length > 0 && !allowTopPriorityRemoval;
    const success = exactAnchorPreserved === true
      && (scheduleState.unscheduledManualHotspots || []).length === 0
      && routeEndOverflowMinutes === 0
      && openingHourConflictCount === 0
      && (!requiresConfirmation || allowTopPriorityRemoval);
    const reason = exactAnchorFailureReason || (this.callbacks.explainRejectedCandidate
      ? this.callbacks.explainRejectedCandidate({
          unscheduledCount: (scheduleState.unscheduledManualHotspots || []).length,
          routeEndOverflowMinutes,
          openingHourConflictCount,
          topPriorityAffectedCount: topPriorityAffected.length,
          allowTopPriorityRemoval,
        })
      : null);

 console.log('[ManualInsertionOptimizer]', {
      candidateIndex: position.candidateIndex,
      positionLabel: position.positionLabel,
      waitingMinutes,
      extraTravelKm: travelMetrics.extraTravelKm,
      toAndFroPenalty: travelMetrics.toAndFroPenalty,
      removedOptionalCount: Number(options?.removedOptionalHotspots?.length || 0),
      topPriorityAffectedCount: topPriorityAffected.length,
      score,
      chosen: false,
    });

    return {
      success,
      candidateIndex: position.candidateIndex,
      rows: afterCandidates.hotspotRows,
      fullTimeline,
      score,
      waitingMinutes,
      totalTravelKm: travelMetrics.totalTravelKm,
      extraTravelKm: travelMetrics.extraTravelKm,
      toAndFroPenalty: travelMetrics.toAndFroPenalty,
      removedOptionalHotspots: [...(options?.removedOptionalHotspots || [])],
      removedTopPriorityHotspots: [...(options?.removedTopPriorityHotspots || [])],
      topPriorityAffected,
      scheduledManualHotspots,
      unscheduledManualHotspots: scheduleState.unscheduledManualHotspots || [],
      requiresConfirmation,
      reason,
      routeEndOverflowMinutes,
      openingHourConflictCount,
    };
  }
}
