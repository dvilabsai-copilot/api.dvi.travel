import { Injectable } from '@nestjs/common';

type ManualInsertionCandidateResult = {
  success: boolean;
  candidateIndex: number;
  fullTimeline: any[];
  waitingMinutes: number;
  extraTravelKm: number;
  totalTravelKm: number;
  routeEndOverflowMinutes?: number;
  openingHourConflictCount?: number;
  topPriorityAffected?: any[];
  removedOptionalHotspots?: any[];
  removedTopPriorityHotspots?: any[];
  scheduledManualHotspots?: any[];
  requiresConfirmation: boolean;
  reason?: string | null;
};

type ManualCandidateOrder = {
  strategyKey: string;
  strategyLabel: string;
  description: string;
  hotspotOrder: number[];
  exactAnchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
  exactAfterHotspotId?: number;
  exactBeforeHotspotId?: number;
};

type ManualScheduleAttempt = {
  source: 'REAL_CLUSTER_SIMULATION' | 'CANDIDATE_WRAPPER';
  strategyKey: string;
  strategyLabel: string;
  description: string;
  hotspotOrder: number[];
  candidateIndex: number;
  previewTimeline?: any[];
  success: boolean;
  requiresConfirmation: boolean;
  readyToApply: boolean;
  routeEndOverflowMinutes: number;
  openingHourConflictCount: number;
  topPriorityAffectedCount: number;
  removedOptionalCount: number;
  removedTopPriorityCount: number;
  waitingMinutes: number;
  extraTravelKm: number;
  totalTravelKm: number;
  timingSafe: boolean;
  selected: boolean;
  summary: string | null;
  reason: string | null;
};

type Callbacks = {
  distanceBetweenHotspots?: (...args: any[]) => number;
  calculateInsertionExtraDistance?: (...args: any[]) => number;
  calculateToAndFroPenalty?: (...args: any[]) => number;
  isAttractionTimelineRow?: (...args: any[]) => boolean;
  getTimelineRowHotspotId?: (...args: any[]) => number;
  manualFitTimelinePreservesSelectedAnchor?: (...args: any[]) => boolean;
  parsePreviewTimeToMinutes?: (...args: any[]) => number | null;
  explainManualScheduleAttempt?: (...args: any[]) => string | null;
};

@Injectable()
export class ItineraryManualFitScheduleAttemptService {
  private callbacks: Callbacks = {};

  setCallbacks(callbacks: Callbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  calculateTravelMetricsFromTimeline(
    timeline: any[],
    manualHotspotIdSet: Set<number>,
    masterMap: Map<number, any>,
  ): { totalTravelKm: number; extraTravelKm: number; toAndFroPenalty: number } {
    const distanceBetweenHotspots = this.callbacks.distanceBetweenHotspots || (() => 0);
    const attractions = (timeline || [])
      .filter((row: any) => Number(row?.item_type || 0) === 4)
      .map((row: any) => ({
        hotspotId: Number(row?.hotspot_ID || row?.locationId || 0),
        isManual: Number(row?.hotspot_plan_own_way || 0) === 1 || row?.isManual === true || manualHotspotIdSet.has(Number(row?.hotspot_ID || 0)),
      }))
      .filter((row: any) => Number(row.hotspotId) > 0);

    let totalTravelKm = 0;
    for (let i = 1; i < attractions.length; i += 1) {
      totalTravelKm += distanceBetweenHotspots(masterMap, attractions[i - 1].hotspotId, attractions[i].hotspotId);
    }

    const extraTravelKm = this.callbacks.calculateInsertionExtraDistance
      ? this.callbacks.calculateInsertionExtraDistance(attractions, manualHotspotIdSet, masterMap)
      : 0;
    const toAndFroPenalty = this.callbacks.calculateToAndFroPenalty
      ? this.callbacks.calculateToAndFroPenalty(attractions, masterMap)
      : 0;
    return {
      totalTravelKm: Number(totalTravelKm.toFixed(2)),
      extraTravelKm,
      toAndFroPenalty,
    };
  }

  detectTopPriorityImpact(
    baselineTopPriorityByHotspotId: Map<number, { id: number; name: string; priority: number }>,
    afterCandidates: any,
  ): Array<{ id: number; name: string; priority: number; reason: string }> {
    const afterTopPriorityIds = new Set<number>([
      ...((afterCandidates?.classified?.strictTopPriority || [])
        .map((row: any) => Number(row?.hotspotId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0)),
      ...((afterCandidates?.classified?.p3ConfirmationCandidates || [])
        .map((row: any) => Number(row?.hotspotId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0)),
    ]);

    return Array.from(baselineTopPriorityByHotspotId.values())
      .filter((row) => !afterTopPriorityIds.has(Number(row.id)))
      .map((row) => ({
        ...row,
        reason: Number(row.priority || 0) <= 2
          ? `Protected P${row.priority || 0} hotspot would be removed or invalidated by this schedule attempt.`
          : `Priority ${row.priority || 0} hotspot would need confirmation before removal.`,
      }));
  }

  buildManualScheduleAttemptFromCandidate(params: {
    strategy: ManualCandidateOrder;
    candidate: ManualInsertionCandidateResult;
  }): ManualScheduleAttempt {
    const routeEndOverflowMinutes = Number(params.candidate?.routeEndOverflowMinutes || 0);
    const openingHourConflictCount = Number(params.candidate?.openingHourConflictCount || 0);
    const topPriorityAffectedCount = Number(params.candidate?.topPriorityAffected?.length || 0);
    const readyToApply = params.candidate.success === true && params.candidate.requiresConfirmation !== true;
    const attempt: ManualScheduleAttempt = {
      source: 'CANDIDATE_WRAPPER',
      strategyKey: params.strategy.strategyKey,
      strategyLabel: params.strategy.strategyLabel,
      description: params.strategy.description,
      hotspotOrder: params.strategy.hotspotOrder,
      candidateIndex: Number(params.candidate?.candidateIndex ?? -1),
      previewTimeline: Array.isArray(params.candidate?.fullTimeline) ? params.candidate.fullTimeline : [],
      success: params.candidate.success === true,
      requiresConfirmation: params.candidate.requiresConfirmation === true,
      readyToApply,
      routeEndOverflowMinutes,
      openingHourConflictCount,
      topPriorityAffectedCount,
      removedOptionalCount: Number(params.candidate?.removedOptionalHotspots?.length || 0),
      removedTopPriorityCount: Number(params.candidate?.removedTopPriorityHotspots?.length || 0),
      waitingMinutes: Number(params.candidate?.waitingMinutes || 0),
      extraTravelKm: Number(params.candidate?.extraTravelKm || 0),
      totalTravelKm: Number(params.candidate?.totalTravelKm || 0),
      timingSafe: routeEndOverflowMinutes === 0 && openingHourConflictCount === 0,
      selected: false,
      summary: null,
      reason: params.candidate?.reason || null,
    };
    attempt.summary = this.callbacks.explainManualScheduleAttempt
      ? this.callbacks.explainManualScheduleAttempt(attempt)
      : attempt.reason;
    return attempt;
  }

  buildExactAnchorSequentialScheduleAttempt(params: {
    strategy: ManualCandidateOrder;
    candidate: ManualInsertionCandidateResult;
  }): ManualScheduleAttempt {
    const timeline = Array.isArray(params.candidate?.fullTimeline) ? params.candidate.fullTimeline : [];
    const isAttraction = this.callbacks.isAttractionTimelineRow || ((row: any) => Number(row?.item_type || 0) === 4);
    const getHotspotId = this.callbacks.getTimelineRowHotspotId || ((row: any) => Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0));
    const attractionRows = timeline.filter((row: any) => isAttraction(row));
    const manualHotspotId = Number(params.candidate?.scheduledManualHotspots?.[0]?.id || (params.strategy.hotspotOrder || [])[0] || 0);
    const orderPreserved = manualHotspotId > 0 && (this.callbacks.manualFitTimelinePreservesSelectedAnchor
      ? this.callbacks.manualFitTimelinePreservesSelectedAnchor({
          timeline,
          selectedHotspotId: manualHotspotId,
          afterHotspotId: Number(params.strategy?.exactAfterHotspotId || 0) || null,
          beforeHotspotId: Number(params.strategy?.exactBeforeHotspotId || 0) || null,
          anchorIntent: params.strategy?.exactAnchorIntent || 'AFTER_ATTRACTION',
        })
      : true);
    const parseTime = this.callbacks.parsePreviewTimeToMinutes || (() => null);
    let overlapCount = 0;
    let previousEnd: number | null = null;
    for (const row of attractionRows) {
      const rawRange = String(row?.timeRange || row?.visitTime || '').trim();
      if (!rawRange.includes('-')) continue;
      const [startPart, endPart] = rawRange.split('-').map((value: string) => value.trim());
      const startMin = parseTime(startPart);
      const endMin = parseTime(endPart);
      if (startMin === null || endMin === null) continue;
      if (previousEnd !== null && startMin < previousEnd) overlapCount += 1;
      previousEnd = endMin;
    }

    const routeEndOverflowMinutes = Number(params.candidate?.routeEndOverflowMinutes || 0);
    const openingHourConflictCount = Number(params.candidate?.openingHourConflictCount || 0);
    const topPriorityAffectedCount = Number(params.candidate?.topPriorityAffected?.length || 0);
    const timingSafe = routeEndOverflowMinutes === 0 && openingHourConflictCount === 0 && overlapCount === 0;
    const readyToApply = params.candidate?.success === true && params.candidate?.requiresConfirmation !== true && timingSafe && orderPreserved;
    const reason = !orderPreserved
      ? 'Exact-anchor sequential rebuild did not keep the selected manual hotspot in the clicked Fit Here gap.'
      : overlapCount > 0
        ? 'Exact-anchor sequential rebuild produced overlapping kept hotspot times.'
        : params.candidate?.reason || null;
    const attempt: ManualScheduleAttempt = {
      source: 'REAL_CLUSTER_SIMULATION',
      strategyKey: params.strategy.strategyKey,
      strategyLabel: params.strategy.strategyLabel,
      description: params.strategy.description,
      hotspotOrder: params.strategy.hotspotOrder,
      candidateIndex: Number(params.candidate?.candidateIndex ?? -1),
      previewTimeline: Array.isArray(params.candidate?.fullTimeline) ? params.candidate.fullTimeline : [],
      success: params.candidate?.success === true && orderPreserved && overlapCount === 0,
      requiresConfirmation: params.candidate?.requiresConfirmation === true,
      readyToApply,
      routeEndOverflowMinutes,
      openingHourConflictCount,
      topPriorityAffectedCount,
      removedOptionalCount: Number(params.candidate?.removedOptionalHotspots?.length || 0),
      removedTopPriorityCount: Number(params.candidate?.removedTopPriorityHotspots?.length || 0),
      waitingMinutes: Number(params.candidate?.waitingMinutes || 0),
      extraTravelKm: Number(params.candidate?.extraTravelKm || 0),
      totalTravelKm: Number(params.candidate?.totalTravelKm || 0),
      timingSafe,
      selected: false,
      summary: null,
      reason,
    };
    attempt.summary = this.callbacks.explainManualScheduleAttempt
      ? this.callbacks.explainManualScheduleAttempt(attempt)
      : attempt.reason;
    return attempt;
  }

  async simulateManualClusterOrder(params: {
    strategy: ManualCandidateOrder;
    candidate: ManualInsertionCandidateResult;
  }): Promise<ManualScheduleAttempt> {
    if (params.strategy?.exactAnchorIntent) return this.buildExactAnchorSequentialScheduleAttempt(params);
    return this.buildManualScheduleAttemptFromCandidate(params);
  }

  compareManualScheduleAttempts(a: ManualScheduleAttempt, b: ManualScheduleAttempt): number {
    const category = (attempt: ManualScheduleAttempt): number => {
      if (attempt.readyToApply && attempt.removedOptionalCount === 0 && attempt.removedTopPriorityCount === 0) return 0;
      if (attempt.readyToApply) return 1;
      if (attempt.requiresConfirmation) return 2;
      if (attempt.timingSafe && attempt.topPriorityAffectedCount === 0
        && !String(attempt.reason || '').toLowerCase().includes('exact-anchor rebuild failed')
        && !String(attempt.reason || '').toLowerCase().includes('did not keep the selected manual hotspot')) return 3;
      return 4;
    };
    const totalRemovedCount = (attempt: ManualScheduleAttempt): number => Number(attempt.removedOptionalCount || 0) + Number(attempt.removedTopPriorityCount || 0);
    const ac = category(a);
    const bc = category(b);
    if (ac !== bc) return ac - bc;
    if (totalRemovedCount(a) !== totalRemovedCount(b)) return totalRemovedCount(a) - totalRemovedCount(b);
    if (a.removedTopPriorityCount !== b.removedTopPriorityCount) return a.removedTopPriorityCount - b.removedTopPriorityCount;
    if (a.topPriorityAffectedCount !== b.topPriorityAffectedCount) return a.topPriorityAffectedCount - b.topPriorityAffectedCount;
    if (a.openingHourConflictCount !== b.openingHourConflictCount) return a.openingHourConflictCount - b.openingHourConflictCount;
    if (a.routeEndOverflowMinutes !== b.routeEndOverflowMinutes) return a.routeEndOverflowMinutes - b.routeEndOverflowMinutes;
    if (a.waitingMinutes !== b.waitingMinutes) return a.waitingMinutes - b.waitingMinutes;
    if (a.extraTravelKm !== b.extraTravelKm) return a.extraTravelKm - b.extraTravelKm;
    if (a.totalTravelKm !== b.totalTravelKm) return a.totalTravelKm - b.totalTravelKm;
    return a.candidateIndex - b.candidateIndex;
  }
}
