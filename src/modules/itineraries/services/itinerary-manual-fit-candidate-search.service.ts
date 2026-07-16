import { Injectable } from '@nestjs/common';

type Callbacks = {
  findRouteDetails?: (...args: any[]) => Promise<any>;
  buildRouteHotspotInsertionCandidates?: (...args: any[]) => Promise<any>;
  buildManualInsertionPositions?: (...args: any[]) => any[];
  buildPreferredManualInsertionIndex?: (...args: any[]) => number | null;
  simulateManualInsertionAtPosition?: (...args: any[]) => Promise<any>;
  buildManualSlotInsights?: (...args: any[]) => any[];
  chooseBestManualInsertionCandidate?: (...args: any[]) => any;
  rebuildManualHotspotSet?: (...args: any[]) => Promise<any>;
  buildManualClusterCandidateOrders?: (...args: any[]) => any[];
  simulateManualClusterOrder?: (...args: any[]) => Promise<any>;
  compareManualScheduleAttempts?: (...args: any[]) => number;
};

@Injectable()
export class ItineraryManualFitCandidateSearchService {
  private callbacks: Callbacks = {};

  setCallbacks(callbacks: Callbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  async findBestManualInsertionCandidate(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
    options?: any,
  ): Promise<any> {
    const route = this.callbacks.findRouteDetails
      ? await this.callbacks.findRouteDetails(tx, Number(planId), Number(routeId))
      : null;
    const baseline = await (this.callbacks.buildRouteHotspotInsertionCandidates || (async () => ({ hotspotRows: [], masterMap: new Map() })))(tx, Number(planId), Number(routeId), manualHotspotIds);
    const preferredOrder = Array.isArray(options?.preferredHotspotOrder)
      ? options.preferredHotspotOrder.map(Number).filter((id: number) => id > 0)
      : [];
    const hotspotRowsForPositioning = preferredOrder.length > 1
      ? (() => {
          const orderIndex = new Map<number, number>(preferredOrder.map((hotspotId: number, index: number) => [hotspotId, index]));
          const preferredRows = baseline.hotspotRows
            .filter((row: any) => orderIndex.has(Number(row.hotspotId || 0)))
            .sort((a: any, b: any) => Number(orderIndex.get(Number(a.hotspotId || 0))) - Number(orderIndex.get(Number(b.hotspotId || 0))));
          const preferredIds = new Set(preferredRows.map((row: any) => Number(row.hotspotId || 0)));
          return [...preferredRows, ...baseline.hotspotRows.filter((row: any) => !preferredIds.has(Number(row.hotspotId || 0)))];
        })()
      : baseline.hotspotRows;
    const allPositions = this.callbacks.buildManualInsertionPositions
      ? this.callbacks.buildManualInsertionPositions(hotspotRowsForPositioning)
      : [];
    const preferredCandidateIndex = this.callbacks.buildPreferredManualInsertionIndex
      ? this.callbacks.buildPreferredManualInsertionIndex(hotspotRowsForPositioning, options?.preferredHotspotOrder, manualHotspotIds)
      : null;
    const positions = (() => {
      const orderedBase = preferredCandidateIndex === null
        ? allPositions
        : [...allPositions].sort((a: any, b: any) => {
            const aDiff = Math.abs(Number(a.candidateIndex) - Number(preferredCandidateIndex));
            const bDiff = Math.abs(Number(b.candidateIndex) - Number(preferredCandidateIndex));
            return aDiff !== bDiff ? aDiff - bDiff : Number(a.candidateIndex) - Number(b.candidateIndex);
          });
      if (options?.exactAnchorMode === true && preferredCandidateIndex !== null) {
        const exactPositions = orderedBase.filter((pos: any) => Number(pos.candidateIndex) === Number(preferredCandidateIndex));
        if (exactPositions.length > 0) return exactPositions;
      }
      if (options?.destinationInsertionMode === true) {
        const minIndex = Math.max(0, Number(options?.destinationMinCandidateIndex || 0));
        return [...orderedBase.filter((pos: any) => Number(pos.candidateIndex) >= minIndex), ...orderedBase.filter((pos: any) => Number(pos.candidateIndex) < minIndex)];
      }
      if (options?.sourceInsertionMode === true) {
        const maxIndex = Math.max(0, Number(options?.sourceMaxCandidateIndex || 0));
        return [...orderedBase.filter((pos: any) => Number(pos.candidateIndex) <= maxIndex), ...orderedBase.filter((pos: any) => Number(pos.candidateIndex) > maxIndex)];
      }
      return orderedBase;
    })();
    const baselineTopPriorityByHotspotId = options?.baselineTopPriorityByHotspotId || new Map();
    const masterMap = options?.masterMap || baseline.masterMap;
    const candidates: any[] = [];
    for (const position of positions) {
      candidates.push(await (this.callbacks.simulateManualInsertionAtPosition || (async () => ({ success: false, candidateIndex: position.candidateIndex, fullTimeline: [], score: Number.MAX_SAFE_INTEGER })))(
        tx,
        Number(planId),
        Number(routeId),
        route,
        manualHotspotIds,
        position,
        baselineTopPriorityByHotspotId,
        masterMap,
        {
          allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
          removedOptionalHotspots: options?.removedOptionalHotspots || [],
          removedTopPriorityHotspots: options?.removedTopPriorityHotspots || [],
          manualTimingPolicy: options?.manualTimingPolicy,
          preferredHotspotOrder: options?.preferredHotspotOrder,
          exactAnchorMode: options?.exactAnchorMode === true,
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          sourceInsertionMode: options?.sourceInsertionMode === true,
          sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
        },
      ));
    }
    const baselineAttractionsSorted = [...(baseline.hotspotRows || [])]
      .sort((a: any, b: any) => Number(a?.hotspotOrder ?? a?.hotspot_order ?? 0) - Number(b?.hotspotOrder ?? b?.hotspot_order ?? 0));
    const slotInsights = this.callbacks.buildManualSlotInsights
      ? this.callbacks.buildManualSlotInsights(candidates, manualHotspotIds, baselineAttractionsSorted, masterMap)
      : [];
    const best = this.callbacks.chooseBestManualInsertionCandidate
      ? this.callbacks.chooseBestManualInsertionCandidate(candidates)
      : null;
    if (!best) {
      return {
        success: false,
        candidateIndex: -1,
        rows: [],
        fullTimeline: [],
        score: Number.MAX_SAFE_INTEGER,
        waitingMinutes: 0,
        totalTravelKm: 0,
        extraTravelKm: 0,
        toAndFroPenalty: 0,
        removedOptionalHotspots: [...(options?.removedOptionalHotspots || [])],
        removedTopPriorityHotspots: [...(options?.removedTopPriorityHotspots || [])],
        topPriorityAffected: [],
        scheduledManualHotspots: [],
        unscheduledManualHotspots: [],
        requiresConfirmation: false,
        reason: 'No insertion candidate evaluated.',
        slotInsights,
      };
    }
    best.slotInsights = slotInsights;
    const selectedPosition = positions.find((pos: any) => pos.candidateIndex === best.candidateIndex) || positions[0];
    if (selectedPosition && this.callbacks.rebuildManualHotspotSet) {
      await this.callbacks.rebuildManualHotspotSet(tx, Number(planId), Number(routeId), manualHotspotIds, {
        anchorType: 'after_travel',
        anchorIndex: Math.max(0, Number(selectedPosition.anchorOrder) - 1),
      }, {
        preferredManualPlacementByRoute: { [Number(routeId)]: { hotspotOrder: Number(selectedPosition.anchorOrder) } },
        preferredHotspotOrder: options?.preferredHotspotOrder,
        previewOnly: options?.previewOnly === true,
      });
    }
    console.log('[ManualInsertionOptimizer]', {
      candidateIndex: best.candidateIndex,
      positionLabel: selectedPosition?.positionLabel || 'unknown',
      waitingMinutes: best.waitingMinutes,
      extraTravelKm: best.extraTravelKm,
      toAndFroPenalty: best.toAndFroPenalty,
      removedOptionalCount: Number(best.removedOptionalHotspots?.length || 0),
      topPriorityAffectedCount: Number(best.topPriorityAffected?.length || 0),
      score: best.score,
      chosen: true,
    });
    return best;
  }

  async runManualClusterOptimizer(tx: any, planId: number, routeId: number, manualHotspotIds: number[], baselineCandidates: any, options?: any): Promise<any> {
    const strategies = this.callbacks.buildManualClusterCandidateOrders
      ? this.callbacks.buildManualClusterCandidateOrders({
          hotspots: baselineCandidates?.hotspotRows || [],
          manualHotspotIds,
          anchorIndex: options?.anchorIndex,
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          allowP3Removal: options?.allowP3Removal === true,
          allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
          exactAnchorMode: options?.exactAnchorMode === true,
          masterMap: baselineCandidates?.masterMap || new Map(),
        })
      : [];
    const attempts: any[] = [];
    for (const strategy of strategies) {
      const candidate = await this.findBestManualInsertionCandidate(tx, Number(planId), Number(routeId), manualHotspotIds, {
        ...options,
        preferredHotspotOrder: strategy.hotspotOrder,
      });
      candidate.strategyKey = strategy.strategyKey;
      candidate.strategyLabel = strategy.strategyLabel;
      const attempt = this.callbacks.simulateManualClusterOrder
        ? await this.callbacks.simulateManualClusterOrder({ strategy, candidate })
        : { strategyKey: strategy.strategyKey, strategyLabel: strategy.strategyLabel, summary: null, selected: false };
      attempts.push({ strategy, candidate, attempt });
    }
    const selected = [...attempts].sort((a: any, b: any) => this.callbacks.compareManualScheduleAttempts
      ? this.callbacks.compareManualScheduleAttempts(a.attempt, b.attempt)
      : 0)[0];
    if (selected) {
      selected.attempt.selected = true;
      selected.candidate.strategySummary = selected.attempt.summary;
    }
    const fallback = selected?.candidate || await this.findBestManualInsertionCandidate(tx, Number(planId), Number(routeId), manualHotspotIds, {
      ...options,
      preferredHotspotOrder: selected?.strategy?.hotspotOrder || [],
    });
    return {
      bestCandidate: fallback,
      optimizerLog: {
        decisionOrder: ['opening-hours feasibility', 'selected manual hotspot scheduled without conflict', 'P1/P2 preserved', 'P3 preserved unless confirmed', 'route end time', 'wait time', 'detour as tie-breaker'],
        selectedStrategyKey: selected?.attempt.strategyKey || null,
        selectedStrategyLabel: selected?.attempt.strategyLabel || null,
        summary: selected?.attempt.summary || null,
        attempts: attempts.map((row: any) => row.attempt),
      },
    };
  }
}
