// FILE: src/modules/itineraries/services/itinerary-low-priority-removal.service.ts

import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type LowPriorityRemovalCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryLowPriorityRemovalService {
  private readonly MANUAL_HOTSPOT_EFFECTIVE_PRIORITY = 4;
  private callbacks: LowPriorityRemovalCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: LowPriorityRemovalCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private getPreviewRowDurationMinutes(...args: any[]): any {
    return this.callbacks.getPreviewRowDurationMinutes?.(...args);
  }

  private buildMatrixRouteTimelineAfterLowPriorityRemoval(...args: any[]): any {
    return this.callbacks.buildMatrixRouteTimelineAfterLowPriorityRemoval?.(...args);
  }

  private parseSegmentEndMinutes(...args: any[]): any {
    return this.callbacks.parseSegmentEndMinutes?.(...args);
  }

  private minutesRangeToTimeString(...args: any[]): any {
    return this.callbacks.minutesRangeToTimeString?.(...args);
  }

  private validateResolvedLowPriorityTimeline(...args: any[]): any {
    return this.callbacks.validateResolvedLowPriorityTimeline?.(...args);
  }

  private formatMinutesHuman(...args: any[]): any {
    return this.callbacks.formatMinutesHuman?.(...args);
  }

  async resolveLowPriorityRemovalForMatrixOverflowInTx(
    tx: any,
    params: {
      planId: number;
      routeId: number;
      selectedHotspotId: number;
      selectedManualPriority: number;
      currentTimeline: any[];
      dayEndMinutes: number;
      overflowMinutes: number;
      preselectedRemovalHotspotIds?: number[];
    },
  ): Promise<{
    resolved: boolean;
    algorithm: 'MIN_REMOVALS_COMBINATION_SEARCH' | 'GREEDY_FALLBACK' | 'PRESELECTED_REMOVAL_PLAN' | 'NONE';
    originalOverflowMinutes: number;
    overflowMinutes: number;
    finalOverflowMinutes: number;
    finalTimeline: any[];
    finalArrivalTime: string | null;
    removedHotspots: Array<{ id: number; name: string; priority: number; durationMinutes: number; reason: string }>;
    candidateHotspots: Array<{ id: number; name: string; priority: number; estimatedMinutes: number }>;
    simulationAttempts: Array<{
      removedHotspotIds: number[];
      removedHotspotNames: string[];
      removedCount: number;
      finalArrivalTime: string | null;
      finalOverflowMinutes: number;
      valid: boolean;
      totalRemovedPriorityScore: number;
      totalRemovedVisitDurationMinutes: number;
      strategy: 'COMBINATION_SEARCH' | 'GREEDY_FALLBACK' | 'PRESELECTED';
    }>;
    rejectedAttempts: Array<{
      removedHotspotIds: number[];
      removedHotspotNames: string[];
      removedCount: number;
      finalArrivalTime: string | null;
      finalOverflowMinutes: number;
      valid: boolean;
      totalRemovedPriorityScore: number;
      totalRemovedVisitDurationMinutes: number;
      strategy: 'COMBINATION_SEARCH' | 'GREEDY_FALLBACK' | 'PRESELECTED';
    }>;
    message: string;
  }> {
    const planId = Number(params?.planId || 0);
    const routeId = Number(params?.routeId || 0);
    const selectedHotspotId = Number(params?.selectedHotspotId || 0);
    const selectedManualPriority = Number(params?.selectedManualPriority || 4);
    const dayEndMinutes = Number(params?.dayEndMinutes || 0);
    const currentTimeline = Array.isArray(params?.currentTimeline) ? params.currentTimeline : [];
    const overflowMinutes = Math.max(0, Number(params?.overflowMinutes || 0));
    const preselectedRemovalHotspotIds = Array.isArray(params?.preselectedRemovalHotspotIds)
      ? params.preselectedRemovalHotspotIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
      : [];

    if (!planId || !routeId || !selectedHotspotId || currentTimeline.length === 0) {
      return {
        resolved: false,
        algorithm: 'NONE',
        originalOverflowMinutes: overflowMinutes,
        overflowMinutes,
        finalOverflowMinutes: overflowMinutes,
        finalTimeline: currentTimeline,
        finalArrivalTime: null,
        removedHotspots: [],
        candidateHotspots: [],
        simulationAttempts: [],
        rejectedAttempts: [],
        message: 'Unable to evaluate low-priority removals for matrix overflow.',
      };
    }

    const routeAttractions = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_ID: true,
        hotspot_plan_own_way: true,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const routeHotspotIds = Array.from(new Set(
      (routeAttractions || [])
        .map((row: any) => Number(row?.hotspot_ID || 0))
        .filter((id: number) => id > 0),
    ));
    const protectedManualHotspotIds = new Set<number>(
      (routeAttractions || [])
        .filter((row: any) => Number(row?.hotspot_plan_own_way || 0) === 1)
        .map((row: any) => Number(row?.hotspot_ID || 0))
        .filter((id: number) => id > 0),
    );
    const routeOrderByHotspot = new Map<number, number>();
    for (let i = 0; i < (routeAttractions || []).length; i += 1) {
      const id = Number(routeAttractions[i]?.hotspot_ID || 0);
      if (id > 0 && !routeOrderByHotspot.has(id)) {
        routeOrderByHotspot.set(id, i + 1);
      }
    }

    const masters = routeHotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: {
            hotspot_ID: { in: routeHotspotIds },
            deleted: 0,
          },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_priority: true,
          },
        })
      : [];

    const priorityByHotspot = new Map<number, number>();
    const nameByHotspot = new Map<number, string>();
    for (const master of masters || []) {
      const hid = Number(master?.hotspot_ID || 0);
      if (!hid) continue;
      const priority = Number(master?.hotspot_priority || 0);
      priorityByHotspot.set(hid, Number.isFinite(priority) && priority > 0 ? priority : 4);
      nameByHotspot.set(hid, String(master?.hotspot_name || `Hotspot #${hid}`));
    }

    const durationByHotspot = new Map<number, number>();
    const timelinePriorityByHotspot = new Map<number, number>();
    const timelineNameByHotspot = new Map<number, string>();
    for (const row of currentTimeline || []) {
      const type = String(row?.type || '').toLowerCase();
      const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
      if (type !== 'attraction' || !hid) continue;

      if (!durationByHotspot.has(hid)) {
        const duration = Math.max(0, Number(this.getPreviewRowDurationMinutes(row) || 60));
        durationByHotspot.set(hid, duration);
      }

      const rowPriority = Number(row?.priority || 0);
      if (!timelinePriorityByHotspot.has(hid) && Number.isFinite(rowPriority) && rowPriority > 0) {
        timelinePriorityByHotspot.set(hid, rowPriority);
      }

      const rowName = String(row?.text || row?.name || '').trim();
      if (!timelineNameByHotspot.has(hid) && rowName) {
        timelineNameByHotspot.set(hid, rowName);
      }
    }

    const candidateSourceIds = Array.from(new Set([
      ...routeHotspotIds,
      ...Array.from(timelinePriorityByHotspot.keys()),
      ...Array.from(durationByHotspot.keys()),
    ]));

    const candidateHotspots = candidateSourceIds
      .filter((id: number) => id !== selectedHotspotId)
      .filter((id: number) => !protectedManualHotspotIds.has(id))
      .map((id: number) => ({
        id,
        name: timelineNameByHotspot.get(id) || nameByHotspot.get(id) || `Hotspot #${id}`,
        priority: Number(timelinePriorityByHotspot.get(id) || priorityByHotspot.get(id) || 0),
        estimatedMinutes: Number(durationByHotspot.get(id) || 60),
      }))
      .filter((row: any) => Number(row.priority || 0) > selectedManualPriority)
      .sort((a: any, b: any) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        const routeOrderA = Number(routeOrderByHotspot.get(Number(a?.id || 0)) || Number.MAX_SAFE_INTEGER);
        const routeOrderB = Number(routeOrderByHotspot.get(Number(b?.id || 0)) || Number.MAX_SAFE_INTEGER);
        if (routeOrderA !== routeOrderB) return routeOrderA - routeOrderB;
        return a.id - b.id;
      });

    console.log('[LowPriorityRemoval]', {
      selectedHotspotId,
      selectedManualPriority,
      candidateHotspots,
      overflowMinutes,
      dayEndMinutes,
      protectedManualHotspotIds: Array.from(protectedManualHotspotIds.values()),
    });

    if (candidateHotspots.length === 0) {
      return {
        resolved: false,
        algorithm: 'NONE',
        originalOverflowMinutes: overflowMinutes,
        overflowMinutes,
        finalOverflowMinutes: overflowMinutes,
        finalTimeline: currentTimeline,
        finalArrivalTime: null,
        removedHotspots: [],
        candidateHotspots,
        simulationAttempts: [],
        rejectedAttempts: [],
        message: 'No same-route lower-priority hotspots are available for overflow resolution.',
      };
    }

    const candidateById = new Map<number, any>();
    for (const row of candidateHotspots || []) {
      candidateById.set(Number(row?.id || 0), row);
    }

    const simulationAttempts: Array<{
      removedHotspotIds: number[];
      removedHotspotNames: string[];
      removedCount: number;
      finalArrivalTime: string | null;
      finalOverflowMinutes: number;
      valid: boolean;
      totalRemovedPriorityScore: number;
      totalRemovedVisitDurationMinutes: number;
      strategy: 'COMBINATION_SEARCH' | 'GREEDY_FALLBACK' | 'PRESELECTED';
    }> = [];
    const rejectedAttempts: Array<{
      removedHotspotIds: number[];
      removedHotspotNames: string[];
      removedCount: number;
      finalArrivalTime: string | null;
      finalOverflowMinutes: number;
      valid: boolean;
      totalRemovedPriorityScore: number;
      totalRemovedVisitDurationMinutes: number;
      strategy: 'COMBINATION_SEARCH' | 'GREEDY_FALLBACK' | 'PRESELECTED';
    }> = [];

    const makeRemovedRows = (ids: number[]) => ids
      .map((id: number) => candidateById.get(Number(id)))
      .filter(Boolean)
      .map((row: any) => ({
        id: Number(row.id),
        name: String(row.name || `Hotspot #${row.id}`),
        priority: Number(row.priority || 0),
        durationMinutes: Number(row.estimatedMinutes || 0),
        reason: `Removed because it is lower priority than the selected manual hotspot (P${selectedManualPriority}) and required to keep hotel check-in within day end.`,
      }));

    const compareRemovalPlans = (a: {
      removedRows: Array<{ id: number; priority: number; durationMinutes: number }>;
      finalArrivalMinutes: number;
      finalOverflowMinutes: number;
    }, b: {
      removedRows: Array<{ id: number; priority: number; durationMinutes: number }>;
      finalArrivalMinutes: number;
      finalOverflowMinutes: number;
    }) => {
      if ((a?.removedRows?.length || 0) !== (b?.removedRows?.length || 0)) {
        return (a?.removedRows?.length || 0) - (b?.removedRows?.length || 0);
      }

      const aPriorityScore = (a?.removedRows || []).reduce((sum: number, row: any) => sum + Number(row?.priority || 0), 0);
      const bPriorityScore = (b?.removedRows || []).reduce((sum: number, row: any) => sum + Number(row?.priority || 0), 0);
      if (aPriorityScore !== bPriorityScore) {
        return bPriorityScore - aPriorityScore;
      }

      if (a.finalArrivalMinutes !== b.finalArrivalMinutes) {
        return b.finalArrivalMinutes - a.finalArrivalMinutes;
      }

      const aDuration = (a?.removedRows || []).reduce((sum: number, row: any) => sum + Number(row?.durationMinutes || 0), 0);
      const bDuration = (b?.removedRows || []).reduce((sum: number, row: any) => sum + Number(row?.durationMinutes || 0), 0);
      if (aDuration !== bDuration) {
        return aDuration - bDuration;
      }

      const aIds = (a?.removedRows || []).map((row: any) => Number(row?.id || 0)).sort((x, y) => x - y);
      const bIds = (b?.removedRows || []).map((row: any) => Number(row?.id || 0)).sort((x, y) => x - y);
      for (let i = 0; i < Math.min(aIds.length, bIds.length); i += 1) {
        if (aIds[i] !== bIds[i]) return aIds[i] - bIds[i];
      }
      return 0;
    };

    const simulateRemovalSet = async (
      removalIdsInput: number[],
      strategy: 'COMBINATION_SEARCH' | 'GREEDY_FALLBACK' | 'PRESELECTED',
    ) => {
      const removalIds = Array.from(new Set(
        (removalIdsInput || [])
          .map((id: any) => Number(id || 0))
          .filter((id: number) => id > 0 && candidateById.has(id)),
      ));
      const removedRows = makeRemovedRows(removalIds);
      const finalTimeline = await this.buildMatrixRouteTimelineAfterLowPriorityRemoval(tx, currentTimeline, removalIds, {
        routeId: Number(params.routeId),
      });

      const maxEndMinutes = (finalTimeline || []).reduce((max: number, row: any) => {
        const end = this.parseSegmentEndMinutes(row);
        return end === null ? max : Math.max(max, end);
      }, 0);

      const finalOverflowMinutes = Math.max(0, maxEndMinutes - dayEndMinutes);
      const finalArrivalTime = maxEndMinutes > 0 ? this.minutesRangeToTimeString(maxEndMinutes, maxEndMinutes) : null;
      const totalRemovedPriorityScore = removedRows.reduce((sum: number, row: any) => sum + Number(row?.priority || 0), 0);
      const totalRemovedVisitDurationMinutes = removedRows.reduce((sum: number, row: any) => sum + Number(row?.durationMinutes || 0), 0);
      const valid = finalOverflowMinutes <= 0;

      const attempt = {
        removedHotspotIds: removedRows.map((row: any) => Number(row?.id || 0)).filter((id: number) => id > 0),
        removedHotspotNames: removedRows.map((row: any) => String(row?.name || '')).filter(Boolean),
        removedCount: removedRows.length,
        finalArrivalTime,
        finalOverflowMinutes,
        valid,
        totalRemovedPriorityScore,
        totalRemovedVisitDurationMinutes,
        strategy,
      };

      simulationAttempts.push(attempt);
      if (!valid) rejectedAttempts.push(attempt);

      return {
        attempt,
        removedRows,
        finalTimeline,
        finalOverflowMinutes,
        finalArrivalTime,
        finalArrivalMinutes: maxEndMinutes,
      };
    };

    let chosenPlan: {
      algorithm: 'MIN_REMOVALS_COMBINATION_SEARCH' | 'GREEDY_FALLBACK' | 'PRESELECTED_REMOVAL_PLAN';
      removedRows: Array<{ id: number; name: string; priority: number; durationMinutes: number; reason: string }>;
      finalTimeline: any[];
      finalArrivalTime: string | null;
      finalArrivalMinutes: number;
      finalOverflowMinutes: number;
    } | null = null;

    const normalizedPreselected = Array.from(new Set(preselectedRemovalHotspotIds)).filter((id: number) => candidateById.has(id));
    if (normalizedPreselected.length > 0) {
      const preselectedResult = await simulateRemovalSet(normalizedPreselected, 'PRESELECTED');
      if (preselectedResult.finalOverflowMinutes <= 0) {
        chosenPlan = {
          algorithm: 'PRESELECTED_REMOVAL_PLAN',
          removedRows: preselectedResult.removedRows,
          finalTimeline: preselectedResult.finalTimeline,
          finalArrivalTime: preselectedResult.finalArrivalTime,
          finalArrivalMinutes: preselectedResult.finalArrivalMinutes,
          finalOverflowMinutes: preselectedResult.finalOverflowMinutes,
        };
      } else {
        return {
          resolved: false,
          algorithm: 'PRESELECTED_REMOVAL_PLAN',
          originalOverflowMinutes: overflowMinutes,
          overflowMinutes,
          finalOverflowMinutes: preselectedResult.finalOverflowMinutes,
          finalTimeline: currentTimeline,
          finalArrivalTime: preselectedResult.finalArrivalTime,
          removedHotspots: [],
          candidateHotspots,
          simulationAttempts,
          rejectedAttempts,
          message: 'Preview removal plan is no longer valid for this route state. Please refresh preview before apply.',
        };
      }
    }

    if (!chosenPlan) {
      const candidateIds = candidateHotspots.map((row: any) => Number(row?.id || 0)).filter((id: number) => id > 0);
      const maxCombinationSize = candidateIds.length > 10 ? 3 : candidateIds.length;
      let fallbackGreedyUsed = false;

      const evaluateCombination = async (combination: number[]) => {
        const result = await simulateRemovalSet(combination, 'COMBINATION_SEARCH');
        if (result.finalOverflowMinutes <= 0) {
          const proposed = {
            algorithm: 'MIN_REMOVALS_COMBINATION_SEARCH' as const,
            removedRows: result.removedRows,
            finalTimeline: result.finalTimeline,
            finalArrivalTime: result.finalArrivalTime,
            finalArrivalMinutes: result.finalArrivalMinutes,
            finalOverflowMinutes: result.finalOverflowMinutes,
          };

          if (!chosenPlan || compareRemovalPlans(proposed, chosenPlan) < 0) {
            chosenPlan = proposed;
          }
        }
      };

      const buildCombinations = async (size: number, startIndex: number, path: number[]) => {
        if (path.length === size) {
          await evaluateCombination(path);
          return;
        }

        const remainingNeed = size - path.length;
        for (let i = startIndex; i <= candidateIds.length - remainingNeed; i += 1) {
          path.push(candidateIds[i]);
          await buildCombinations(size, i + 1, path);
          path.pop();
        }
      };

      for (let size = 1; size <= maxCombinationSize; size += 1) {
        await buildCombinations(size, 0, []);
        if (chosenPlan && chosenPlan.removedRows.length === size) {
          break;
        }
      }

      if (!chosenPlan && candidateIds.length > 10) {
        fallbackGreedyUsed = true;
        console.warn('Combination search capped; fallback greedy used.');

        const rollingRemovalIds: number[] = [];
        for (const candidateId of candidateIds) {
          rollingRemovalIds.push(candidateId);
          const greedyResult = await simulateRemovalSet(rollingRemovalIds, 'GREEDY_FALLBACK');
          if (greedyResult.finalOverflowMinutes <= 0) {
            chosenPlan = {
              algorithm: 'GREEDY_FALLBACK',
              removedRows: greedyResult.removedRows,
              finalTimeline: greedyResult.finalTimeline,
              finalArrivalTime: greedyResult.finalArrivalTime,
              finalArrivalMinutes: greedyResult.finalArrivalMinutes,
              finalOverflowMinutes: greedyResult.finalOverflowMinutes,
            };
            break;
          }
        }
      }

      if (!chosenPlan) {
        const bestFailedOverflow = simulationAttempts.reduce((min: number, row: any) => {
          const value = Number(row?.finalOverflowMinutes || overflowMinutes);
          return Math.min(min, Number.isFinite(value) ? value : overflowMinutes);
        }, overflowMinutes);

        return {
          resolved: false,
          algorithm: fallbackGreedyUsed ? 'GREEDY_FALLBACK' : 'MIN_REMOVALS_COMBINATION_SEARCH',
          originalOverflowMinutes: overflowMinutes,
          overflowMinutes,
          finalOverflowMinutes: bestFailedOverflow,
          finalTimeline: currentTimeline,
          finalArrivalTime: null,
          removedHotspots: [],
          candidateHotspots,
          simulationAttempts,
          rejectedAttempts,
          message: `Could not resolve ${overflowMinutes} minute overflow using same-route lower-priority removals.`,
        };
      }
    }

    const invariantError = this.validateResolvedLowPriorityTimeline(
      chosenPlan.finalTimeline,
      chosenPlan.removedRows,
      dayEndMinutes,
    );
    if (invariantError) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'LOW_PRIORITY_RESOLVED_TIMELINE_INVALID',
        message: invariantError,
      });
    }

    return {
      resolved: true,
      algorithm: chosenPlan.algorithm === 'PRESELECTED_REMOVAL_PLAN' ? 'MIN_REMOVALS_COMBINATION_SEARCH' : chosenPlan.algorithm,
      originalOverflowMinutes: overflowMinutes,
      overflowMinutes,
      finalOverflowMinutes: 0,
      finalTimeline: chosenPlan.finalTimeline,
      finalArrivalTime: chosenPlan.finalArrivalTime,
      removedHotspots: chosenPlan.removedRows,
      candidateHotspots,
      simulationAttempts,
      rejectedAttempts,
      message: 'Adding this manual hotspot exceeds the day end. The minimum lower-priority removal set was selected to keep hotel check-in within 8:00 PM.',
    };
  }

  public buildProgressiveRemovalReason(
    validationMode: 'DAY_END' | 'SELECTED_HOTSPOT_CLOSING',
    priority: number,
  ): string {
    const priorityLabel =
      Number(priority || 0) >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY
        ? 'Non-manual / Priority 4'
        : `Priority ${priority}`;

    if (validationMode === 'SELECTED_HOTSPOT_CLOSING') {
      return `${priorityLabel} hotspot removed after sequential check to keep the selected manual hotspot within operating hours.`;
    }

    return `${priorityLabel} hotspot removed after sequential check to keep the route within day end.`;
  }

  public buildSelectedClosingRemovalReason(params: {
    removedName: string;
    selectedHotspotLabel: string;
    attemptedVisitTime?: string | null;
    operatingHours?: string | null;
    overflowMinutes?: number | null;
  }): string {
    const removedName = String(params.removedName || 'This hotspot').trim();
    const selectedHotspotLabel = String(
      params.selectedHotspotLabel || 'the selected manual hotspot',
    ).trim();
    const attemptedVisitTime = String(params.attemptedVisitTime || '').trim() || null;
    const operatingHours = String(params.operatingHours || '').trim() || null;
    const overflowMinutes = Math.max(0, Number(params.overflowMinutes || 0));

    if (attemptedVisitTime && operatingHours) {
      const overflowText =
        overflowMinutes > 0
          ? ` It would miss the allowed operating window by ${this.formatMinutesHuman(overflowMinutes)}.`
          : '';
      return `${removedName} removed because keeping it would push selected manual hotspot ${selectedHotspotLabel} to attempted visit time ${attemptedVisitTime}, outside operating hours ${operatingHours}.${overflowText}`;
    }

    return `${removedName} removed because keeping it would prevent selected manual hotspot ${selectedHotspotLabel} from fitting within operating hours.`;
  }

  public buildProgressiveRemovalSuccessMessage(
    validationMode: 'DAY_END' | 'SELECTED_HOTSPOT_CLOSING',
    removedRows: Array<{ priority?: number; name?: string }>,
  ): string {
    const priorityText = removedRows
      .map((row) => (
        Number(row.priority || 0) >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY
          ? 'P4'
          : `P${Number(row.priority || 0)}`
      ))
      .filter(Boolean)
      .join(' -> ');

    if (validationMode === 'SELECTED_HOTSPOT_CLOSING') {
      return `Selected manual hotspot fits within operating hours after sequential removal check (${priorityText}).`;
    }

    return `Selected manual hotspot fits within route end after sequential removal check (${priorityText}).`;
  }

  public async getActiveRouteHotspotIdSetInTx(
    tx: any,
    planId: number,
    routeId: number,
  ): Promise<Set<number>> {
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_ID: true,
      },
    });

    return new Set(
      (rows || [])
        .map((row: any) => Number(row?.hotspot_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
  }

  public async getActiveRouteManualFitRemovalEvidenceInTx(
    tx: any,
    planId: number,
    routeId: number,
  ): Promise<{
    activeHotspotIds: Set<number>;
    activeRouteHotspotIds: Set<number>;
  }> {
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_ID: true,
        route_hotspot_ID: true,
      },
    });

    return {
      activeHotspotIds: new Set(
        (rows || [])
          .map((row: any) => Number(row?.hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ),
      activeRouteHotspotIds: new Set(
        (rows || [])
          .map((row: any) => Number(row?.route_hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ),
    };
  }

  public async getActiveRouteManualFitRemovalEvidence(
    planId: number,
    routeId: number,
  ): Promise<{
    activeHotspotIds: Set<number>;
    activeRouteHotspotIds: Set<number>;
  }> {
    const rows = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_ID: true,
        route_hotspot_ID: true,
      },
    });

    return {
      activeHotspotIds: new Set(
        (rows || [])
          .map((row: any) => Number(row?.hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ),
      activeRouteHotspotIds: new Set(
        (rows || [])
          .map((row: any) => Number(row?.route_hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ),
    };
  }

  public getManualFitRemovalHotspotId(row: any): number {
    return Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || row?.locationId || 0);
  }

  public getManualFitRemovalRouteHotspotId(row: any): number {
    return Number(row?.routeHotspotId || row?.route_hotspot_ID || row?.route_hotspot_id || 0);
  }

  public getManualFitRemovalRouteId(row: any): number | null {
    const routeId = Number(row?.itinerary_route_ID || row?.routeId || row?.route_id || 0);
    return routeId > 0 ? routeId : null;
  }

  public sanitizeUserFacingManualFitRemovals(
    rows: any[],
    params: {
      routeId: number;
      selectedHotspotId: number;
      activeRemovalEvidence?: {
        activeHotspotIds: Set<number>;
        activeRouteHotspotIds: Set<number>;
      };
    },
  ): any[] {
    const activeHotspotIds = params.activeRemovalEvidence?.activeHotspotIds || new Set<number>();
    const activeRouteHotspotIds = params.activeRemovalEvidence?.activeRouteHotspotIds || new Set<number>();
    const seenHotspotIds = new Set<number>();

    return (Array.isArray(rows) ? rows : []).filter((row: any) => {
      const hotspotId = this.getManualFitRemovalHotspotId(row);
      const routeHotspotId = this.getManualFitRemovalRouteHotspotId(row);
      const rowRouteId = this.getManualFitRemovalRouteId(row);
      const removalReasonCode = String(row?.removalReasonCode || '').toUpperCase();
      const reasonCode = String(row?.reasonCode || '').toUpperCase();
      const attemptedTimelineSource = String(row?.attemptedTimelineSource || '').toUpperCase();

      if (!hotspotId) return false;
      if (hotspotId === Number(params.selectedHotspotId || 0)) return false;
      if (removalReasonCode === 'UNPROVEN_REMOVAL' || reasonCode === 'UNPROVEN_REMOVAL') return false;
      if (attemptedTimelineSource === 'FAILED_BEFORE_REMOVAL') return false;
      if (removalReasonCode.includes('FAILED') || reasonCode.includes('FAILED')) return false;
      if (rowRouteId !== null && rowRouteId !== Number(params.routeId)) return false;
      if (!activeHotspotIds.has(hotspotId)) return false;
      if (routeHotspotId > 0 && !activeRouteHotspotIds.has(routeHotspotId)) return false;
      if (seenHotspotIds.has(hotspotId)) return false;

      seenHotspotIds.add(hotspotId);
      return true;
    });
  }

  public buildManualFitFinalizedPreviewTimeline(
    timeline: any[],
    removedRows: any[],
  ): any[] {
    return this.callbacks.buildManualFitFinalizedPreviewTimelineImpl?.(timeline, removedRows);
  }

  public buildManualFitAttemptTimelineSnapshot(
    timeline: any[],
    params: {
      removedHotspotIds?: number[];
      selectedHotspotId?: number;
    } = {},
  ): any[] {
    return this.callbacks.buildManualFitAttemptTimelineSnapshotImpl?.(timeline, params);
  }

  public buildManualFitAttemptDisplayTimelineSnapshot(
    displaySourceTimeline: any[],
    params: {
      removedHotspotIds?: number[];
      selectedHotspotId?: number;
      selectedConflict?: any | null;
      protectedHotspotIds?: number[];
    } = {},
  ): any[] {
    return this.callbacks.buildManualFitAttemptDisplayTimelineSnapshotImpl?.(displaySourceTimeline, params);
  }

  public buildManualFitAttemptComputedDisplayTimelineSnapshot(
    originalDisplayTimeline: any[],
    recalculatedTimeline: any[],
    params: {
      removedHotspotIds?: number[];
      selectedHotspotId?: number;
      selectedConflict?: any | null;
      protectedHotspotIds?: number[];
    } = {},
  ): any[] {
    return this.callbacks.buildManualFitAttemptComputedDisplayTimelineSnapshotImpl?.(
      originalDisplayTimeline,
      recalculatedTimeline,
      params,
    );
  }

  public validateManualFitAttemptDisplayTimeline(
    rows: any[],
    params: {
      removedHotspotIds: number[];
      selectedHotspotId: number;
    },
  ): string[] {
    return this.callbacks.validateManualFitAttemptDisplayTimelineImpl?.(rows, params);
  }

  public async filterPlannedRemovalsToSameRouteInTx(
    tx: any,
    planId: number,
    routeId: number,
    removals: any[],
  ): Promise<any[]> {
    const activeRouteEvidence = await this.getActiveRouteManualFitRemovalEvidenceInTx(tx, planId, routeId);

    return (Array.isArray(removals) ? removals : []).filter((row: any) => {
      const hotspotId = this.getManualFitRemovalHotspotId(row);
      const routeHotspotId = this.getManualFitRemovalRouteHotspotId(row);
      return (
        hotspotId > 0
        && activeRouteEvidence.activeHotspotIds.has(hotspotId)
        && (routeHotspotId <= 0 || activeRouteEvidence.activeRouteHotspotIds.has(routeHotspotId))
      );
    });
  }
}
