// FILE: src/modules/itineraries/services/itinerary-progressive-priority-removal.service.ts

import { Injectable } from '@nestjs/common';
import { TimeConverter } from '../engines/helpers/time-converter';

type ProgressivePriorityRemovalCallbacks = Record<string, (...args: any[]) => any>;
type ManualHotspotCityContext = any;

@Injectable()
export class ItineraryProgressivePriorityRemovalService {
  private readonly MANUAL_HOTSPOT_EFFECTIVE_PRIORITY = 4;
  private readonly CONFIRMATION_REQUIRED_PRIORITY = 3;
  private callbacks: ProgressivePriorityRemovalCallbacks = {};

  setCallbacks(callbacks: ProgressivePriorityRemovalCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async resolveProgressivePriorityRemovalForManualFitInTx(
    tx: any,
    params: {
      planId: number;
      routeId: number;
      selectedHotspotId: number;
      selectedManualPriority: number;
      currentTimeline: any[];
      dayEndMinutes: number;
      overflowMinutes: number;
      validationMode?: 'DAY_END' | 'SELECTED_HOTSPOT_CLOSING';
      targetHotspotId?: number;
      targetHotspotLatestEndMinutes?: number;
      allowP3Removal?: boolean;
      allowP2Removal?: boolean;
      allowP1Removal?: boolean;
      preselectedRemovalHotspotIds?: number[];
      exactAnchorMode?: boolean;
      anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
      afterHotspotId?: number;
      beforeHotspotId?: number;
    },
  ): Promise<{
    resolved: boolean;
    algorithm: 'PROGRESSIVE_PRIORITY_REMOVAL';
    validationMode: 'DAY_END' | 'SELECTED_HOTSPOT_CLOSING';
    removedHotspots: Array<{
      id: number;
      name: string;
      priority: number;
      estimatedMinutes?: number;
      reason: string;
      removalReasonCode: string;
      requiresAcknowledgement: boolean;
    }>;
    candidateHotspots: Array<any>;
    finalTimeline: any[];
    finalOverflowMinutes: number;
    finalArrivalTime: string | null;
    simulationAttempts: Array<any>;
    rejectedAttempts: Array<any>;
    candidateAudit: Array<any>;
    message: string;
  }> {
    const validationMode = params.validationMode || 'DAY_END';
    const currentTimeline = Array.isArray(params.currentTimeline) ? params.currentTimeline : [];
    const selectedHotspotId = Number(params.selectedHotspotId || 0);
    const activeRouteRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(params.planId),
        itinerary_route_ID: Number(params.routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_ID: true,
        hotspot_plan_own_way: true,
        route_hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
    });

    const getRowHotspotId = (row: any): number =>
      Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || row?.id || 0);

    const isAttractionLikeRow = (row: any): boolean => {
      if (this.callbacks.isAttractionTimelineRow(row)) return true;

      const hotspotId = getRowHotspotId(row);
      if (!hotspotId) return false;

      const label = String(row?.name || row?.text || '').trim();
      if (!label) return false;
      if (/^travel to\b/i.test(label)) return false;
      if (/^(hotel|check-?in|check out|refreshment|start)$/i.test(label)) return false;

      return true;
    };

    const activeRouteHotspotIds = new Set(
      [
        ...(activeRouteRows || [])
          .map((row: any) => Number(row?.hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
        ...currentTimeline
          .filter((row: any) => isAttractionLikeRow(row))
          .map((row: any) => getRowHotspotId(row))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ],
    );

    const manualRouteHotspotIds = new Set(
      [
        ...(activeRouteRows || [])
          .filter((row: any) => Number(row?.hotspot_plan_own_way || 0) === 1)
          .map((row: any) => Number(row?.hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
        ...currentTimeline
          .filter((row: any) => {
            const hotspotId = getRowHotspotId(row);
            if (!hotspotId) return false;
            return (
              row?.isManual === true ||
              row?.mustInclude === true ||
              row?.planOwnWay === true ||
              Number(row?.hotspot_plan_own_way || 0) === 1
            );
          })
          .map((row: any) => getRowHotspotId(row))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ],
    );

    const targetHotspotId = Number(params.targetHotspotId || selectedHotspotId);
    const selectedHotspotMaster = targetHotspotId > 0
      ? await (tx as any).dvi_hotspot_place.findFirst({
          where: {
            hotspot_ID: targetHotspotId,
            deleted: 0,
          },
          select: {
            hotspot_name: true,
          },
        })
      : null;
    const selectedHotspotMasterName = String(selectedHotspotMaster?.hotspot_name || '').trim() || null;
    const protectedHotspotIds = new Set(
      [selectedHotspotId, targetHotspotId]
        .map((id) => Number(id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    let sourceTimeline = currentTimeline;
    const sourceTimelineAttractionCount = sourceTimeline.filter((row: any) => isAttractionLikeRow(row)).length;
    if (params.exactAnchorMode === true && sourceTimelineAttractionCount === 0) {
      const fallbackRouteTimeline = await this.callbacks.getRouteTimelineForScoring(
        tx,
        Number(params.planId),
        Number(params.routeId),
      );

      if (Array.isArray(fallbackRouteTimeline) && fallbackRouteTimeline.length > 0) {
        sourceTimeline = fallbackRouteTimeline;
      }
    }

    const targetTimelineIndex = sourceTimeline.findIndex((row: any) => {
      return isAttractionLikeRow(row) && getRowHotspotId(row) === targetHotspotId;
    });

    const activeRouteOrderByHotspotId = new Map<number, number>(
      (activeRouteRows || [])
        .map((row: any, rowIndex: number) => [
          Number(row?.hotspot_ID || 0),
          Number(row?.hotspot_order || rowIndex + 1),
        ])
        .filter(([hotspotId]: any) => Number.isFinite(Number(hotspotId)) && Number(hotspotId) > 0) as any,
    );
    const anchorBlockerMaxRouteOrder =
      validationMode === 'SELECTED_HOTSPOT_CLOSING' &&
      params.exactAnchorMode === true &&
      Number(params.afterHotspotId || 0) > 0
        ? Number(activeRouteOrderByHotspotId.get(Number(params.afterHotspotId || 0)) || 0)
        : 0;

    const routeRowForRemovalDirection = params.exactAnchorMode === true
      ? await (tx as any).dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_route_ID: Number(params.routeId),
            deleted: 0,
          },
          select: {
            location_id: true,
            location_name: true,
            next_visiting_location: true,
          },
        })
      : null;

    const routeLocationForRemovalDirection = Number(routeRowForRemovalDirection?.location_id || 0) > 0
      ? await (tx as any).dvi_stored_locations.findFirst({
          where: {
            location_ID: Number(routeRowForRemovalDirection?.location_id || 0),
            deleted: 0,
          },
          select: {
            source_location: true,
            destination_location: true,
          },
        })
      : null;

    const removalRouteCityContext = {
      location_name: String(routeRowForRemovalDirection?.location_name || routeLocationForRemovalDirection?.source_location || '').trim(),
      next_visiting_location: String(routeRowForRemovalDirection?.next_visiting_location || routeLocationForRemovalDirection?.destination_location || '').trim(),
    };

    const removalSourceCityKey = this.callbacks.deriveLooseCityKey(removalRouteCityContext.location_name);
    const removalDestinationCityKey = this.callbacks.deriveLooseCityKey(removalRouteCityContext.next_visiting_location);
    const removalSameCityRoute = !!removalSourceCityKey && !!removalDestinationCityKey && removalSourceCityKey === removalDestinationCityKey;
    const removalDirectionHotspotIds = Array.from(activeRouteHotspotIds.values()).filter((id: number) => id > 0);
    const removalDirectionMasters = params.exactAnchorMode === true && removalDirectionHotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: {
            hotspot_ID: { in: removalDirectionHotspotIds },
            deleted: 0,
          },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_location: true,
            hotspot_to_location: true,
            hotspot_priority: true,
            hotspot_duration: true,
          },
        })
      : [];

    const removalDirectionMasterById = new Map<number, any>(
      removalDirectionMasters.map((row: any) => [Number(row?.hotspot_ID || 0), row]),
    );

    const getRemovalCityContext = (hotspotId: number, row: any = null): ManualHotspotCityContext => {
      const master = removalDirectionMasterById.get(Number(hotspotId || 0)) || {};
      return this.callbacks.classifyManualHotspotCityContext(removalRouteCityContext, {
        hotspot_location: master?.hotspot_location || row?.hotspot_location || row?.location || '',
        hotspot_to_location: master?.hotspot_to_location || row?.hotspot_to_location || '',
        hotspot_name: master?.hotspot_name || row?.hotspot_name || row?.name || row?.text || '',
      });
    };

    const selectedRemovalCityContext = params.exactAnchorMode === true
      ? getRemovalCityContext(targetHotspotId)
      : 'UNKNOWN';

    const removalDirectionRank = (row: any): number => {
      if (params.exactAnchorMode !== true) return 0;
      if (removalSameCityRoute || !['SOURCE_CITY', 'DESTINATION_CITY'].includes(selectedRemovalCityContext)) return 0;

      const hotspotId = Number(row?.id || getRowHotspotId(row?.row || row) || 0);
      const rowContext = getRemovalCityContext(hotspotId, row?.row || row);

      if (selectedRemovalCityContext === 'DESTINATION_CITY' && rowContext === 'SOURCE_CITY') return 0;
      if (selectedRemovalCityContext === 'SOURCE_CITY' && rowContext === 'DESTINATION_CITY') return 0;
      if (rowContext === 'UNKNOWN') return 1;
      return 2;
    };

    const getCandidateRemovalPriority = (row: any): number => {
      const hotspotId = getRowHotspotId(row);
      const master = removalDirectionMasterById.get(hotspotId) || null;
      const normalized = this.callbacks.normalizeHotspotPriority(
        Number(
          row?.priority ||
          row?.hotspot_priority ||
          row?.rawPriority ||
          master?.hotspot_priority ||
          9999,
        ),
      );

      if (normalized >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY || normalized === 9999) return 4;
      if (normalized === this.CONFIRMATION_REQUIRED_PRIORITY) return 3;
      if ([1, 2].includes(normalized)) return normalized;
      return 0;
    };

    let candidateRows = sourceTimeline
      .map((row: any, rowIndex: number) => ({ row, rowIndex }))
      .filter(({ row, rowIndex }: any) => {
        if (!isAttractionLikeRow(row)) return false;

        const hotspotId = getRowHotspotId(row);
        if (!hotspotId) return false;
        if (protectedHotspotIds.has(hotspotId)) return false;
        if (manualRouteHotspotIds.has(hotspotId)) return false;
        if (!activeRouteHotspotIds.has(hotspotId)) return false;

        if (
          validationMode === 'SELECTED_HOTSPOT_CLOSING' &&
          targetTimelineIndex >= 0 &&
          rowIndex >= targetTimelineIndex
        ) {
          return false;
        }

        const isManual =
          row?.isManual === true ||
          row?.mustInclude === true ||
          row?.planOwnWay === true ||
          Number(row?.hotspot_plan_own_way || 0) === 1;

        if (isManual) return false;

        const priority = getCandidateRemovalPriority(row);

        if (priority === 4) return true;
        if (priority === 3 && params.allowP3Removal !== true) return false;
        if (priority === 2 && params.allowP2Removal !== true) return false;
        if (priority === 1 && params.allowP1Removal !== true) return false;

        return [1, 2, 3, 4].includes(priority);
      })
      .map(({ row, rowIndex }: any) => {
        const hotspotId = getRowHotspotId(row);
        const master = removalDirectionMasterById.get(hotspotId) || null;
        const priority = getCandidateRemovalPriority(row);
        return {
          row,
          timelineIndex: rowIndex,
          routeOrder: Number(row?.hotspot_order || row?.order || rowIndex),
          id: hotspotId,
          name: String(row?.name || row?.text || row?.hotspot_name || master?.hotspot_name || `Hotspot #${hotspotId}`),
          priority,
          estimatedMinutes: Number(
            row?.durationMinutes ||
            row?.duration_minutes ||
            row?.visitDurationMinutes ||
            row?.hotspot_duration_minutes ||
            this.callbacks.getHotspotDurationMinutes(master, row) ||
            this.callbacks.getPreviewRowDurationMinutes(row) ||
            0,
          ),
          endMinutes: this.callbacks.parseSegmentEndMinutes(row) ?? 0,
        };
      })
      .sort((a: any, b: any) => {
        if (validationMode === 'SELECTED_HOTSPOT_CLOSING' && params.exactAnchorMode === true) {
          const directionDiff = removalDirectionRank(a) - removalDirectionRank(b);
          if (directionDiff !== 0) return directionDiff;

          if (a.timelineIndex !== b.timelineIndex) {
            return b.timelineIndex - a.timelineIndex;
          }

          if (a.priority !== b.priority) return b.priority - a.priority;
          return a.id - b.id;
        }

        if (a.priority !== b.priority) return b.priority - a.priority;
        const directionDiff = removalDirectionRank(a) - removalDirectionRank(b);
        if (directionDiff !== 0) return directionDiff;
        if (a.timelineIndex !== b.timelineIndex) {
          return a.timelineIndex - b.timelineIndex;
        }
        return a.id - b.id;
      });

    const shouldUseActiveRouteFallbackCandidates =
      params.exactAnchorMode === true
      && candidateRows.length === 0
      && sourceTimelineAttractionCount === 0;

    if (shouldUseActiveRouteFallbackCandidates) {
      const existingTimelineCandidateRows = [...candidateRows];
      const activeIds = Array.from(activeRouteHotspotIds.values()).filter((id: number) => id > 0);
      const hotspotMasters = activeIds.length > 0
        ? await (tx as any).dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: { in: activeIds },
            },
            select: {
              hotspot_ID: true,
              hotspot_name: true,
              hotspot_priority: true,
              hotspot_duration: true,
            },
          })
        : [];

      const masterById = new Map<number, any>(
        hotspotMasters.map((row: any) => [Number(row?.hotspot_ID || 0), row]),
      );

      candidateRows = (activeRouteRows || [])
        .map((row: any, rowIndex: number) => {
          const hotspotId = Number(row?.hotspot_ID || 0);
          const master = masterById.get(hotspotId) || null;
          const normalizedPriority = this.callbacks.normalizeHotspotPriority(
            Number(master?.hotspot_priority ?? 9999),
          );
          const priority =
            normalizedPriority >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY || normalizedPriority === 9999
              ? 4
              : normalizedPriority;

          return {
            row,
            timelineIndex: rowIndex,
            routeOrder: Number(row?.hotspot_order || rowIndex + 1),
            id: hotspotId,
            name: String(master?.hotspot_name || `Hotspot #${hotspotId}`),
            priority,
            estimatedMinutes: Number(
              this.callbacks.getHotspotDurationMinutes(master, row) || 0,
            ),
            endMinutes: row?.hotspot_end_time
              ? Math.floor(
                  this.callbacks.hmsToSeconds(TimeConverter.toTimeString(row.hotspot_end_time)) / 60,
                )
              : 0,
            fallbackSource: 'ACTIVE_ROUTE_ROWS',
          };
        })
        .filter((row: any) => {
          const hotspotId = Number(row?.id || 0);
          if (!hotspotId) return false;
          if (protectedHotspotIds.has(hotspotId)) return false;
          if (manualRouteHotspotIds.has(hotspotId)) return false;
          if (
            validationMode === 'SELECTED_HOTSPOT_CLOSING' &&
            params.exactAnchorMode === true &&
            anchorBlockerMaxRouteOrder > 0 &&
            Number(row?.routeOrder || 0) > anchorBlockerMaxRouteOrder
          ) {
            return false;
          }
          if (row.priority === 3 && params.allowP3Removal !== true) return false;
          if (row.priority === 2 && params.allowP2Removal !== true) return false;
          if (row.priority === 1 && params.allowP1Removal !== true) return false;
          return [1, 2, 3, 4].includes(Number(row.priority || 0));
        })
        .sort((a: any, b: any) => {
          if (validationMode === 'SELECTED_HOTSPOT_CLOSING' && params.exactAnchorMode === true) {
            const directionDiff = removalDirectionRank(a) - removalDirectionRank(b);
            if (directionDiff !== 0) return directionDiff;
            if (a.routeOrder !== b.routeOrder) return b.routeOrder - a.routeOrder;
            if (a.priority !== b.priority) return b.priority - a.priority;
            return a.id - b.id;
          }

          if (a.priority !== b.priority) return b.priority - a.priority;
          const directionDiff = removalDirectionRank(a) - removalDirectionRank(b);
          if (directionDiff !== 0) return directionDiff;
          if (a.routeOrder !== b.routeOrder) return a.routeOrder - b.routeOrder;
          return a.id - b.id;
        });

      if (candidateRows.length === 0 && existingTimelineCandidateRows.length > 0) {
        candidateRows = existingTimelineCandidateRows;
      }
    }
    const candidateAudit = sourceTimeline
      .map((row: any, rowIndex: number) => {
        const hotspotId = getRowHotspotId(row);
        const label = String(row?.name || row?.text || row?.hotspot_name || '').trim();
        const priority = getCandidateRemovalPriority(row);
        const isManual =
          row?.isManual === true ||
          row?.mustInclude === true ||
          row?.planOwnWay === true ||
          Number(row?.hotspot_plan_own_way || 0) === 1;
        const beforeTarget = !(
          validationMode === 'SELECTED_HOTSPOT_CLOSING'
          && targetTimelineIndex >= 0
          && rowIndex >= targetTimelineIndex
        );
        const allowedByPriority =
          (priority === 4 || priority === 3 ? params.allowP3Removal === true : true) &&
          (priority === 2 ? params.allowP2Removal === true : true) &&
          (priority === 1 ? params.allowP1Removal === true : true);

        return {
          rowIndex,
          hotspotId,
          name: label || `Hotspot #${hotspotId || 0}`,
          attractionLike: isAttractionLikeRow(row),
          protected: protectedHotspotIds.has(hotspotId),
          manualRoute: manualRouteHotspotIds.has(hotspotId),
          sameRouteActive: activeRouteHotspotIds.has(hotspotId),
          beforeTarget,
          isManual,
          priority,
          allowedByPriority,
          included:
            isAttractionLikeRow(row) &&
            hotspotId > 0 &&
            !protectedHotspotIds.has(hotspotId) &&
            !manualRouteHotspotIds.has(hotspotId) &&
            activeRouteHotspotIds.has(hotspotId) &&
            beforeTarget &&
            !isManual &&
            allowedByPriority &&
            [1, 2, 3, 4].includes(priority),
        };
      })
      .filter((row: any) => row.hotspotId > 0);

    if (validationMode === 'SELECTED_HOTSPOT_CLOSING') {
      console.log('[FitHere][APJ_SELECTED_CLOSING_RESCUE_CANDIDATES]', {
        routeId: Number(params.routeId),
        selectedHotspotId,
        targetHotspotId,
        targetTimelineIndex,
        exactAnchorMode: params.exactAnchorMode === true,
        candidates: candidateRows.map((row: any) => ({
          id: row.id,
          name: row.name,
          priority: row.priority,
          timelineIndex: row.timelineIndex,
          directionRank: removalDirectionRank(row),
        })),
      });
    }

    const simulationAttempts: any[] = [];
    const rejectedAttempts: any[] = [];
    const protectedHotspotMetadata = sourceTimeline
      .map((row: any) => {
        const hotspotId = getRowHotspotId(row);
        if (!(hotspotId > 0)) return null;

        const isSelectedProtected = protectedHotspotIds.has(hotspotId);
        const isManualProtected = manualRouteHotspotIds.has(hotspotId);
        if (!isSelectedProtected && !isManualProtected) return null;

        const reasons: string[] = [];
        if (hotspotId === targetHotspotId || hotspotId === selectedHotspotId) {
          reasons.push('Selected hotspot is protected from removal.');
        }
        if (isManualProtected) {
          reasons.push('Manually added / own-way hotspot is protected from removal.');
        }

        return {
          hotspotId,
          name: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
          reason: reasons.join(' '),
          isManualProtected,
        };
      })
      .filter(Boolean)
      .filter((row: any, index: number, list: any[]) => (
        list.findIndex((candidate: any) => Number(candidate?.hotspotId || 0) === Number(row?.hotspotId || 0)) === index
      ));
    const protectedHotspotIdsForDisplay = Array.from(
      new Set([
        Number(params.selectedHotspotId || 0),
        targetHotspotId,
        ...protectedHotspotMetadata.map((row: any) => Number(row?.hotspotId || 0)),
        ...candidateAudit
          .filter((row: any) => row?.manualRoute === true || row?.protected === true || row?.isManual === true)
          .map((row: any) => Number(row?.hotspotId || row?.id || row?.hotspotId || 0)),
      ].filter((id: number) => Number.isFinite(id) && id > 0)),
    );
    const buildProtectedHotspotsForSummary = (removedIds: number[]) => protectedHotspotIdsForDisplay
      .filter((id: number) => !removedIds.includes(id))
      .map((id: number) => {
        const matchingRow = sourceTimeline.find((row: any) => getRowHotspotId(row) === id);

        return {
          hotspotId: id,
          name:
            matchingRow?.name ||
            matchingRow?.title ||
            matchingRow?.hotspot_name ||
            `Hotspot #${id}`,
          reason: id === targetHotspotId
            ? 'Selected hotspot is protected from removal.'
            : 'Manually added / own-way hotspot is protected from removal.',
        };
      });

    const getAttemptSelectedWindow = (timeline: any[]) => {
      const targetRow = (Array.isArray(timeline) ? timeline : []).find((row: any) => {
        return isAttractionLikeRow(row) && getRowHotspotId(row) === targetHotspotId;
      });

      return {
        attemptedVisitTime: targetRow?.timeRange || targetRow?.visitTime || null,
        operatingHours: targetRow?.operatingHours || targetRow?.timings || null,
        selectedOpeningConflict: targetRow?.selectedOpeningConflict || null,
      };
    };

    const evaluateTimeline = async (timeline: any[]) => {
      let evaluatedTimeline = Array.isArray(timeline) ? timeline : [];
      if (validationMode === 'SELECTED_HOTSPOT_CLOSING') {
        evaluatedTimeline = await this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours(
          Number(params.planId),
          Number(params.routeId),
          evaluatedTimeline,
        );
      }

      const maxEndMinutes = evaluatedTimeline.reduce((max: number, row: any) => {
        const end = this.callbacks.parseSegmentEndMinutes(row);
        return end === null ? max : Math.max(max, end);
      }, 0);

      const dayEndOverflowMinutes = Math.max(0, maxEndMinutes - Number(params.dayEndMinutes || 0));
      const selectedTargetRow = evaluatedTimeline.find((row: any) => {
        if (!isAttractionLikeRow(row)) return false;
        return getRowHotspotId(row) === targetHotspotId;
      });

      const selectedTargetEndMinutes =
        selectedTargetRow ? this.callbacks.parseSegmentEndMinutes(selectedTargetRow) : null;

      let selectedClosingOverflowMinutes = 0;
      let selectedOpeningConflict: any | null = null;

      if (validationMode === 'SELECTED_HOTSPOT_CLOSING') {
        const selectedClosingCheck = this.callbacks.getSelectedManualClosingOverflow({
          timeline: evaluatedTimeline,
          selectedHotspotIds: [targetHotspotId],
        });

        const selectedOperatingValidation = this.callbacks.markSelectedManualOperatingHourConflicts(
          evaluatedTimeline,
          [targetHotspotId],
        );

        evaluatedTimeline = selectedOperatingValidation.timeline;
        selectedOpeningConflict = selectedOperatingValidation.selectedOpeningConflict || null;

        const selectedStillInvalid =
          selectedClosingCheck.hasClosingOverflow === true ||
          !!selectedOpeningConflict;

        selectedClosingOverflowMinutes = Number(selectedClosingCheck.overflowMinutes || 0);

        const finalOverflowMinutes = selectedStillInvalid
          ? Number(selectedClosingCheck.overflowMinutes || 1)
          : 0;

        const valid = !selectedStillInvalid && dayEndOverflowMinutes <= 0 && !!selectedTargetRow;
        const selectedWindow = getAttemptSelectedWindow(evaluatedTimeline);

        return {
          valid,
          finalOverflowMinutes,
          dayEndOverflowMinutes,
          selectedClosingOverflowMinutes,
          maxEndMinutes,
          selectedTargetEndMinutes,
          selectedTargetRow,
          finalArrivalTime:
            selectedTargetEndMinutes
              ? this.callbacks.minutesRangeToFitPreviewLabel(selectedTargetEndMinutes, selectedTargetEndMinutes)
              : (maxEndMinutes > 0 ? this.callbacks.minutesRangeToFitPreviewLabel(maxEndMinutes, maxEndMinutes) : null),
          evaluatedTimeline,
          selectedAttemptedVisitTime: selectedWindow.attemptedVisitTime,
          selectedOperatingHours: selectedWindow.operatingHours,
          selectedOpeningConflict: selectedWindow.selectedOpeningConflict || selectedOpeningConflict,
        };
      }

      const finalOverflowMinutes = dayEndOverflowMinutes;
      const valid = finalOverflowMinutes <= 0 && dayEndOverflowMinutes <= 0;

      return {
        valid,
        finalOverflowMinutes,
        dayEndOverflowMinutes,
        selectedClosingOverflowMinutes,
        maxEndMinutes,
        selectedTargetEndMinutes,
        selectedTargetRow,
        finalArrivalTime:
          maxEndMinutes > 0 ? this.callbacks.minutesRangeToTimeString(maxEndMinutes, maxEndMinutes) : null,
        evaluatedTimeline,
        selectedAttemptedVisitTime: null,
        selectedOperatingHours: null,
        selectedOpeningConflict: null,
      };
    };

    const rebuildAfterRemoval = async (removedIds: number[]) => {
      if (removedIds.length === 0) return sourceTimeline;

      if (validationMode === 'SELECTED_HOTSPOT_CLOSING' || params.exactAnchorMode === true) {
        return this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, sourceTimeline, {
          removedHotspotIds: removedIds,
          targetHotspotId,
          routeId: Number(params.routeId),
          planId: Number(params.planId),
          anchorIntent: params.anchorIntent,
          afterHotspotId: params.afterHotspotId,
          beforeHotspotId: params.beforeHotspotId,
          allowSelectedClosingAnchorBypass: validationMode === 'SELECTED_HOTSPOT_CLOSING',
        });
      }

      return this.callbacks.buildMatrixRouteTimelineAfterLowPriorityRemoval(
        tx,
        sourceTimeline,
        removedIds,
        {
          routeId: Number(params.routeId),
        },
      );
    };

    let selectedClosingRemovalReasonContext: {
      selectedAttemptedVisitTime: string | null;
      selectedOperatingHours: string | null;
      selectedClosingOverflowMinutes: number;
    } | null = null;

    if (validationMode === 'SELECTED_HOTSPOT_CLOSING') {
      let reasonTimeline = sourceTimeline;
      const sourceContainsTarget = sourceTimeline.some((row: any) => (
        isAttractionLikeRow(row) && getRowHotspotId(row) === targetHotspotId
      ));

      if (!sourceContainsTarget) {
        const baselineExactTimeline = await this.callbacks.buildExactAnchorSequentialTimelineAfterRemoval(tx, sourceTimeline, {
          removedHotspotIds: [],
          targetHotspotId,
          routeId: Number(params.routeId),
          planId: Number(params.planId),
          anchorIntent: params.anchorIntent,
          afterHotspotId: params.afterHotspotId,
          beforeHotspotId: params.beforeHotspotId,
          allowSelectedClosingAnchorBypass: false,
        });

        if (Array.isArray(baselineExactTimeline) && baselineExactTimeline.length > 0) {
          reasonTimeline = baselineExactTimeline;
        }
      }

      const baselineReasonEvaluation = await evaluateTimeline(reasonTimeline);
      if (baselineReasonEvaluation?.selectedAttemptedVisitTime || baselineReasonEvaluation?.selectedOperatingHours) {
        selectedClosingRemovalReasonContext = {
          selectedAttemptedVisitTime: baselineReasonEvaluation.selectedAttemptedVisitTime || null,
          selectedOperatingHours: baselineReasonEvaluation.selectedOperatingHours || null,
          selectedClosingOverflowMinutes: Number(
            baselineReasonEvaluation.selectedClosingOverflowMinutes || 0,
          ),
        };
      }
    }

    const candidateById = new Map<number, any>(
      candidateRows
        .map((row: any) => [Number(row?.id || 0), row] as const)
        .filter(([id]) => Number.isFinite(id) && id > 0),
    );

    const buildSelectedClosingExactRescuePlans = async () => {
      if (!(validationMode === 'SELECTED_HOTSPOT_CLOSING' && params.exactAnchorMode === true)) {
        return [] as any[];
      }

      const selectedHotspotName = String(
        sourceTimeline.find((row: any) => (
          isAttractionLikeRow(row) && getRowHotspotId(row) === targetHotspotId
        ))?.name ||
        sourceTimeline.find((row: any) => (
          isAttractionLikeRow(row) && getRowHotspotId(row) === targetHotspotId
        ))?.text ||
        selectedHotspotMasterName ||
        `Hotspot #${targetHotspotId}`,
      ).trim();

      const selectedStub = {
        hotspotId: targetHotspotId,
        name: selectedHotspotName || `Hotspot #${targetHotspotId}`,
        routeOrder: 0,
      };
      const toSelectedClosingRescuePriority = (priorityInput: any): number | null => {
        const rawPriority = Number(priorityInput || 0);
        const normalizedPriority = this.callbacks.normalizeHotspotPriority(rawPriority);

        if (normalizedPriority === 9999 || normalizedPriority >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY) {
          return 4;
        }

        return [1, 2, 3, 4].includes(Number(normalizedPriority || 0))
          ? Number(normalizedPriority || 0)
          : null;
      };

      const anchorIntentUpper = String(params.anchorIntent || '').trim().toUpperCase();
      const clickedAnchorHotspotId = Number(params.afterHotspotId || 0);
      const beforeAnchorHotspotId = Number(params.beforeHotspotId || 0);
      const sourceTimelineExactArray = sourceTimeline
        .filter((row: any) => isAttractionLikeRow(row))
        .map((row: any, rowIndex: number) => {
          const hotspotId = getRowHotspotId(row);
          if (!(hotspotId > 0)) return null;
          if (manualRouteHotspotIds.has(hotspotId) && hotspotId !== targetHotspotId) return null;

          return {
            id: hotspotId,
            hotspotId,
            name: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`).trim(),
            routeOrder: Number(
              row?.hotspot_order ||
              row?.hotspotOrder ||
              activeRouteOrderByHotspotId.get(hotspotId) ||
              rowIndex + 1,
            ),
            priority: toSelectedClosingRescuePriority(candidateById.get(hotspotId)?.priority || 0),
            rawPriority: Number(candidateById.get(hotspotId)?.priority || 0) || null,
            estimatedMinutes: Number(candidateById.get(hotspotId)?.estimatedMinutes || 0),
            candidate: candidateById.get(hotspotId) || null,
            row,
            cityContext: getRemovalCityContext(hotspotId, row),
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => Number(a?.routeOrder || 0) - Number(b?.routeOrder || 0));

      if (sourceTimelineExactArray.length === 0) {
        return [] as any[];
      }

      const exactArray = (() => {
        const sourceRouteArray = sourceTimelineExactArray;
        if (sourceRouteArray.length === 0) return [] as any[];

        if (anchorIntentUpper === 'AFTER_START') {
          return [selectedStub, ...sourceRouteArray];
        }

        if (clickedAnchorHotspotId > 0) {
          const afterIndex = sourceRouteArray.findIndex((row: any) => Number(row?.hotspotId || 0) === clickedAnchorHotspotId);
          if (afterIndex >= 0) {
            return [
              ...sourceRouteArray.slice(0, afterIndex + 1),
              selectedStub,
              ...sourceRouteArray.slice(afterIndex + 1),
            ];
          }
        }

        if (beforeAnchorHotspotId > 0) {
          const beforeIndex = sourceRouteArray.findIndex((row: any) => Number(row?.hotspotId || 0) === beforeAnchorHotspotId);
          if (beforeIndex >= 0) {
            return [
              ...sourceRouteArray.slice(0, beforeIndex),
              selectedStub,
              ...sourceRouteArray.slice(beforeIndex),
            ];
          }
        }

        return [selectedStub, ...sourceRouteArray];
      })();

      const selectedIndex = exactArray.findIndex((row: any) => Number(row?.hotspotId || 0) === targetHotspotId);
      if (selectedIndex < 0) {
        return [] as any[];
      }

      const beforeSelectedRows = exactArray
        .slice(0, selectedIndex)
        .filter((row: any) => Number(row?.hotspotId || 0) > 0);
      const afterSelectedRows = exactArray
        .slice(selectedIndex + 1)
        .filter((row: any) => Number(row?.hotspotId || 0) > 0);
      const rescueRowById = new Map<number, any>(
        sourceTimelineExactArray
          .map((row: any) => [Number(row?.hotspotId || 0), row] as const),
      );
      const isRescuePriorityAllowed = (priority: number): boolean => {
        if (priority === 3) return params.allowP3Removal === true;
        if (priority === 2) return params.allowP2Removal === true;
        if (priority === 1) return params.allowP1Removal === true;
        return [1, 2, 3, 4].includes(Number(priority || 0));
      };
      const removableBeforeSelectedRows = beforeSelectedRows.filter((row: any) => {
        const rescueRow = rescueRowById.get(Number(row?.hotspotId || 0));
        return !!rescueRow && isRescuePriorityAllowed(Number(rescueRow?.priority || 0));
      });
      const orderedBeforeSelectedDesc = [...removableBeforeSelectedRows]
        .sort((a: any, b: any) => Number(b?.routeOrder || 0) - Number(a?.routeOrder || 0));
      const anchorRow = clickedAnchorHotspotId > 0
        ? removableBeforeSelectedRows.find((row: any) => Number(row?.hotspotId || 0) === clickedAnchorHotspotId) || null
        : null;
      const nonAnchorBeforeSelectedDesc = orderedBeforeSelectedDesc.filter((row: any) => Number(row?.hotspotId || 0) !== clickedAnchorHotspotId);
      const sourceSideBeforeSelectedDesc = nonAnchorBeforeSelectedDesc.filter((row: any) => row?.cityContext === 'SOURCE_CITY');
      const otherBeforeSelectedDesc = nonAnchorBeforeSelectedDesc.filter((row: any) => row?.cityContext !== 'SOURCE_CITY');
      const preferredNonAnchorBlockers = [...sourceSideBeforeSelectedDesc, ...otherBeforeSelectedDesc];
      const deferClickedAnchorRemoval =
        Boolean(anchorRow)
        && String(anchorRow?.cityContext || '') === String(selectedRemovalCityContext || '')
        && ['SOURCE_CITY', 'DESTINATION_CITY'].includes(String(selectedRemovalCityContext || ''));
      const preserveClickedAnchorFirst = Boolean(anchorRow && afterSelectedRows.length > 0 && !deferClickedAnchorRemoval);
      const explicitRescuePlans: any[] = [];
      const seenPlanKeys = new Set<string>();

      const pushPlan = (label: string, removedIdsInput: Array<number | null | undefined>) => {
        const removedIds = Array.from(new Set(
          removedIdsInput
            .map((id: any) => Number(id || 0))
            .filter((id: number) => {
              if (!Number.isFinite(id) || id <= 0) return false;
              const rescueRow = rescueRowById.get(id);
              return !!rescueRow && isRescuePriorityAllowed(Number(rescueRow?.priority || 0));
            }),
        ));
        if (removedIds.length === 0) return;

        const planKey = removedIds.join(',');
        if (seenPlanKeys.has(planKey)) return;
        seenPlanKeys.add(planKey);

        const planRows = removedIds
          .map((hotspotId: number) => rescueRowById.get(hotspotId))
          .filter(Boolean);
        const planArray = exactArray.filter((row: any) => (
          Number(row?.hotspotId || 0) === targetHotspotId ||
          !removedIds.includes(Number(row?.hotspotId || 0))
        ));

        explicitRescuePlans.push({
          label,
          removedIds,
          rows: planRows,
          exactArrayHotspotIds: exactArray.map((row: any) => Number(row?.hotspotId || 0)),
          exactArrayHotspotNames: exactArray.map((row: any) => String(row?.name || '').trim()),
          arrayHotspotIds: planArray.map((row: any) => Number(row?.hotspotId || 0)),
          arrayHotspotNames: planArray.map((row: any) => String(row?.name || '').trim()),
        });
      };

      if (preserveClickedAnchorFirst) {
        const firstPreferredNonAnchor = preferredNonAnchorBlockers[0] || null;
        const remainingEarlierBlockers = orderedBeforeSelectedDesc.filter((row: any) => (
          Number(row?.hotspotId || 0) !== Number(firstPreferredNonAnchor?.hotspotId || 0) &&
          Number(row?.hotspotId || 0) !== Number(anchorRow?.hotspotId || 0)
        ));

        pushPlan('REMOVE_PRE_ANCHOR_BLOCKER_FIRST', [firstPreferredNonAnchor?.hotspotId]);
        pushPlan('REMOVE_CLICKED_ANCHOR', [anchorRow?.hotspotId]);
        pushPlan('REMOVE_PRE_ANCHOR_AND_CLICKED_ANCHOR', [
          firstPreferredNonAnchor?.hotspotId,
          anchorRow?.hotspotId,
        ]);

        if ((params.allowP1Removal === true || params.allowP2Removal === true) && remainingEarlierBlockers.length > 0) {
          pushPlan('REMOVE_EARLIER_BLOCKERS_AND_CLICKED_ANCHOR', [
            firstPreferredNonAnchor?.hotspotId,
            anchorRow?.hotspotId,
            ...remainingEarlierBlockers.map((row: any) => Number(row?.hotspotId || 0)),
          ]);
        }
      } else {
        const anchorExcludedRows = orderedBeforeSelectedDesc.filter((row: any) => (
          Number(row?.hotspotId || 0) !== Number(anchorRow?.hotspotId || 0)
        ));
        const primarySingles = deferClickedAnchorRemoval
          ? [
              ...anchorExcludedRows,
              anchorRow,
            ].filter(Boolean)
          : [
              anchorRow,
              ...anchorExcludedRows,
            ].filter(Boolean);

        primarySingles.slice(0, 3).forEach((row: any, index: number) => {
          pushPlan(`REMOVE_NEAREST_BLOCKER_${index + 1}`, [row?.hotspotId]);
        });

        const pairCandidates = primarySingles.slice(0, 3);
        for (let left = 0; left < pairCandidates.length; left += 1) {
          for (let right = left + 1; right < pairCandidates.length; right += 1) {
            pushPlan(`REMOVE_BLOCKER_PAIR_${left + 1}_${right + 1}`, [
              pairCandidates[left]?.hotspotId,
              pairCandidates[right]?.hotspotId,
            ]);
          }
        }

        if (pairCandidates.length > 2) {
          pushPlan('REMOVE_PRIMARY_BLOCKER_CLUSTER', pairCandidates.map((row: any) => row?.hotspotId));
        }

        if ((params.allowP1Removal === true || params.allowP2Removal === true) && orderedBeforeSelectedDesc.length > pairCandidates.length) {
          pushPlan('REMOVE_FULL_BLOCKER_CHAIN', orderedBeforeSelectedDesc.map((row: any) => row?.hotspotId));
        }
      }

      console.log('[FitHere][APJ_SELECTED_CLOSING_EXPLICIT_RESCUE_ARRAYS]', {
        routeId: Number(params.routeId),
        selectedHotspotId: targetHotspotId,
        clickedAnchorHotspotId: clickedAnchorHotspotId || null,
        exactArray: {
          hotspotIds: exactArray.map((row: any) => Number(row?.hotspotId || 0)),
          hotspotNames: exactArray.map((row: any) => String(row?.name || '').trim()),
        },
        rescueArrays: explicitRescuePlans.map((plan: any) => ({
          rescueLabel: plan.label,
          removedHotspotIds: plan.removedIds,
          removedHotspotNames: (plan.rows || []).map((row: any) => row?.name),
          hotspotIds: plan.arrayHotspotIds,
          hotspotNames: plan.arrayHotspotNames,
        })),
      });

      return explicitRescuePlans;
    };

    const selectedHotspotLabel = String(
      sourceTimeline.find((row: any) => (
        isAttractionLikeRow(row) && getRowHotspotId(row) === targetHotspotId
      ))?.name ||
      sourceTimeline.find((row: any) => (
        isAttractionLikeRow(row) && getRowHotspotId(row) === targetHotspotId
      ))?.text ||
      selectedHotspotMasterName ||
      `Hotspot #${targetHotspotId}`,
    ).trim();

    const toRemovedRows = (
      rows: any[],
      context?: {
        selectedAttemptedVisitTime?: string | null;
        selectedOperatingHours?: string | null;
        selectedClosingOverflowMinutes?: number | null;
      },
    ) => rows.map((row: any) => {
      const selectedClosingReasonContext =
        validationMode === 'SELECTED_HOTSPOT_CLOSING'
          ? (selectedClosingRemovalReasonContext || context || null)
          : null;
      const reason =
        validationMode === 'SELECTED_HOTSPOT_CLOSING'
          ? this.callbacks.buildSelectedClosingRemovalReason({
              removedName: String(row?.name || `Hotspot #${row?.id || ''}`),
              selectedHotspotLabel,
              attemptedVisitTime: selectedClosingReasonContext?.selectedAttemptedVisitTime || null,
              operatingHours: selectedClosingReasonContext?.selectedOperatingHours || null,
              overflowMinutes: selectedClosingReasonContext?.selectedClosingOverflowMinutes || 0,
            })
          : this.callbacks.buildProgressiveRemovalReason(validationMode, row.priority);

      return {
        id: row.id,
        name: row.name,
        priority: row.priority,
        estimatedMinutes: row.estimatedMinutes,
        reason,
        fitFailureExplanation: reason,
        removalReasonCode:
          validationMode === 'SELECTED_HOTSPOT_CLOSING'
            ? 'SELECTED_HOTSPOT_CLOSING_RESCUE'
            : 'DAY_END_RESCUE',
        requiresAcknowledgement: true,
      };
    });

    const preselectedRemovalIds = Array.isArray(params.preselectedRemovalHotspotIds)
      ? params.preselectedRemovalHotspotIds.map(Number).filter((id) => id > 0)
      : [];

    let selectedRemovedIds: number[] = [];
    let selectedRemovedRows: any[] = [];
    let workingTimeline = sourceTimeline;

    if (preselectedRemovalIds.length > 0) {
      selectedRemovedIds = [...preselectedRemovalIds];
      selectedRemovedRows = candidateRows.filter((candidate: any) => selectedRemovedIds.includes(candidate.id));
      workingTimeline = await rebuildAfterRemoval(selectedRemovedIds);

      const evaluation = await evaluateTimeline(workingTimeline);
      workingTimeline = evaluation.evaluatedTimeline;
      const attemptNumber = simulationAttempts.length + 1;
      const selectedWindow = getAttemptSelectedWindow(workingTimeline);
      const attemptComputedTimeline = this.callbacks.buildManualFitAttemptTimelineSnapshot(workingTimeline, {
        removedHotspotIds: selectedRemovedIds,
        selectedHotspotId: targetHotspotId,
      });
      const attemptDisplayTimeline = this.callbacks.buildManualFitAttemptComputedDisplayTimelineSnapshot(
        sourceTimeline,
        workingTimeline,
        {
          removedHotspotIds: selectedRemovedIds,
          selectedHotspotId: targetHotspotId,
          selectedConflict:
            selectedWindow?.selectedOpeningConflict ||
            evaluation?.selectedOpeningConflict ||
            null,
          protectedHotspotIds: protectedHotspotIdsForDisplay,
        },
      );
      const displayTimelineErrors = this.callbacks.validateManualFitAttemptDisplayTimeline(attemptDisplayTimeline, {
        removedHotspotIds: selectedRemovedIds,
        selectedHotspotId: targetHotspotId,
      });

      simulationAttempts.push({
        attemptNumber,
        cumulative: true,
        validationMode,
        removedHotspotIds: [...selectedRemovedIds],
        removedHotspotNames: selectedRemovedRows.map((row: any) => row.name),
        removedCount: selectedRemovedIds.length,
        priorities: selectedRemovedRows.map((row: any) => row.priority),
        selectedAttemptedVisitTime: evaluation.selectedAttemptedVisitTime,
        selectedOperatingHours: evaluation.selectedOperatingHours,
        selectedOpeningConflict: evaluation.selectedOpeningConflict,
        finalArrivalTime: evaluation.finalArrivalTime,
        finalOverflowMinutes: evaluation.finalOverflowMinutes,
        dayEndOverflowMinutes: evaluation.dayEndOverflowMinutes,
        selectedClosingOverflowMinutes: evaluation.selectedClosingOverflowMinutes,
        valid: evaluation.valid,
        resolved: evaluation.valid,
        strategy: 'PRESELECTED_PROGRESSIVE_REMOVAL',
        displayTimelineErrors,
        displayTimelineWarning: displayTimelineErrors.length > 0,
        previewTimelineDisplay: attemptDisplayTimeline,
        displayTimeline: attemptDisplayTimeline,
        previewTimeline: attemptDisplayTimeline,
        computedTimelineDebug: attemptComputedTimeline,
        removalSummary: {
          removedHotspotIds: [...selectedRemovedIds],
          removedHotspotNames: selectedRemovedRows.map((row: any) => row.name),
          protectedHotspots: buildProtectedHotspotsForSummary(selectedRemovedIds),
          result: evaluation.valid ? 'FITS_AFTER_REMOVAL' : 'STILL_DOES_NOT_FIT',
        },
      });

      if (evaluation.valid) {
        return {
          resolved: true,
          algorithm: 'PROGRESSIVE_PRIORITY_REMOVAL',
          validationMode,
          removedHotspots: toRemovedRows(selectedRemovedRows, evaluation),
          candidateHotspots: candidateRows,
          finalTimeline: evaluation.evaluatedTimeline,
          finalOverflowMinutes: 0,
          finalArrivalTime: evaluation.finalArrivalTime,
          simulationAttempts,
          rejectedAttempts,
          candidateAudit,
          message: this.callbacks.buildProgressiveRemovalSuccessMessage(validationMode, selectedRemovedRows),
        };
      }
    }

    if (validationMode === 'SELECTED_HOTSPOT_CLOSING' && params.exactAnchorMode === true && candidateRows.length > 0) {
      let rescuePlans: any[] = await buildSelectedClosingExactRescuePlans();

      if (rescuePlans.length === 0) {
        const boundedClosingCandidates = candidateRows.slice(0, 6);

        for (let mask = 1; mask < (1 << boundedClosingCandidates.length); mask += 1) {
          const rows = boundedClosingCandidates.filter((_: any, index: number) => (mask & (1 << index)) > 0);
          const removedIds = rows.map((row: any) => Number(row.id || 0)).filter((id: number) => id > 0);
          if (removedIds.length === 0) continue;

          rescuePlans.push({
            label: `BITMASK_RESCUE_${mask}`,
            rows,
            removedIds,
            maxTimelineIndex: Math.max(...rows.map((row: any) => Number(row.timelineIndex || 0))),
            directionScore: rows.reduce((sum: number, row: any) => sum + removalDirectionRank(row), 0),
            priorityScore: rows.reduce((sum: number, row: any) => sum + Number(row.priority || 0), 0),
          });
        }

        rescuePlans.sort((a: any, b: any) => {
          if (a.rows.length !== b.rows.length) return a.rows.length - b.rows.length;
          if (a.directionScore !== b.directionScore) return a.directionScore - b.directionScore;
          if (a.maxTimelineIndex !== b.maxTimelineIndex) return b.maxTimelineIndex - a.maxTimelineIndex;
          if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
          return a.removedIds.join(',').localeCompare(b.removedIds.join(','));
        });
      }

      for (const plan of rescuePlans) {
        const planRows: any[] = (
          Array.isArray(plan.rows) && plan.rows.length > 0
            ? plan.rows
            : (Array.isArray(plan.removedIds)
                ? plan.removedIds.map((id: any) => candidateById.get(Number(id || 0))).filter(Boolean)
                : [])
        );
        const planRemovedIds: number[] = Array.from(new Set<number>(
          (Array.isArray(plan.removedIds) ? plan.removedIds : [])
            .map((id: any) => Number(id || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0),
        ));
        let planTimeline = await rebuildAfterRemoval(planRemovedIds);
        const evaluation = await evaluateTimeline(planTimeline);
        planTimeline = evaluation.evaluatedTimeline;

        const attemptNumber = simulationAttempts.length + 1;
        const selectedWindow = getAttemptSelectedWindow(planTimeline);
        const attemptComputedTimeline = this.callbacks.buildManualFitAttemptTimelineSnapshot(planTimeline, {
          removedHotspotIds: planRemovedIds,
          selectedHotspotId: targetHotspotId,
        });
        const attemptDisplayTimeline = this.callbacks.buildManualFitAttemptComputedDisplayTimelineSnapshot(
          sourceTimeline,
          planTimeline,
          {
            removedHotspotIds: planRemovedIds,
            selectedHotspotId: targetHotspotId,
            selectedConflict:
              selectedWindow?.selectedOpeningConflict ||
              evaluation?.selectedOpeningConflict ||
              null,
            protectedHotspotIds: protectedHotspotIdsForDisplay,
          },
        );
        const displayTimelineErrors = this.callbacks.validateManualFitAttemptDisplayTimeline(attemptDisplayTimeline, {
          removedHotspotIds: planRemovedIds,
          selectedHotspotId: targetHotspotId,
        });

        const selectedClosingPlanResolved = Boolean(
          validationMode === 'SELECTED_HOTSPOT_CLOSING'
          && params.exactAnchorMode === true
          && !!evaluation.selectedTargetRow
          && !evaluation.selectedOpeningConflict
          && Number(evaluation.selectedClosingOverflowMinutes || 0) <= 0
        );

        console.log('[FitHere][SELECTED_CLOSING_RESCUE_PLAN_EVAL]', {
          routeId: Number(params.routeId),
          selectedHotspotId: targetHotspotId,
          rescueLabel: String(plan?.label || '').trim() || null,
          removedHotspotIds: planRemovedIds,
          removedHotspotNames: planRows.map((row: any) => row.name),
          selectedAttemptedVisitTime: evaluation.selectedAttemptedVisitTime,
          selectedOperatingHours: evaluation.selectedOperatingHours,
          apjFits: evaluation.valid || selectedClosingPlanResolved,
          evaluationValid: evaluation.valid,
          selectedClosingPlanResolved,
          selectedOpeningConflict: evaluation.selectedOpeningConflict,
          dayEndOverflowMinutes: evaluation.dayEndOverflowMinutes,
          selectedClosingOverflowMinutes: evaluation.selectedClosingOverflowMinutes,
        });

        const attempt = {
          attemptNumber,
          cumulative: false,
          validationMode,
          removedHotspotIds: planRemovedIds,
          removedHotspotNames: planRows.map((row: any) => row.name),
          removedCount: planRemovedIds.length,
          priorities: planRows.map((row: any) => row.priority),
          rescueLabel: String(plan?.label || '').trim() || null,
          selectedAttemptedVisitTime: evaluation.selectedAttemptedVisitTime,
          selectedOperatingHours: evaluation.selectedOperatingHours,
          selectedOpeningConflict: evaluation.selectedOpeningConflict,
          finalArrivalTime: evaluation.finalArrivalTime,
          finalOverflowMinutes: evaluation.finalOverflowMinutes,
          dayEndOverflowMinutes: evaluation.dayEndOverflowMinutes,
          selectedClosingOverflowMinutes: evaluation.selectedClosingOverflowMinutes,
          valid: evaluation.valid || selectedClosingPlanResolved,
          resolved: evaluation.valid || selectedClosingPlanResolved,
          strategy: 'SELECTED_CLOSING_RESCUE_PLAN',
          displayTimelineErrors,
          displayTimelineWarning: displayTimelineErrors.length > 0,
          previewTimelineDisplay: attemptDisplayTimeline,
          displayTimeline: attemptDisplayTimeline,
          previewTimeline: attemptDisplayTimeline,
          computedTimelineDebug: attemptComputedTimeline,
          removalSummary: {
            removedHotspotIds: planRemovedIds,
            removedHotspotNames: planRows.map((row: any) => row.name),
            protectedHotspots: buildProtectedHotspotsForSummary(planRemovedIds),
            result: (evaluation.valid || selectedClosingPlanResolved) ? 'FITS_AFTER_REMOVAL' : 'STILL_DOES_NOT_FIT',
          },
        };

        simulationAttempts.push(attempt);

        if (evaluation.valid || selectedClosingPlanResolved) {
          return {
            resolved: true,
            algorithm: 'PROGRESSIVE_PRIORITY_REMOVAL',
            validationMode,
            removedHotspots: toRemovedRows(planRows, evaluation),
            candidateHotspots: candidateRows,
            finalTimeline: planTimeline,
            finalOverflowMinutes: 0,
            finalArrivalTime: evaluation.finalArrivalTime,
            simulationAttempts,
            rejectedAttempts,
            candidateAudit,
            message: this.callbacks.buildProgressiveRemovalSuccessMessage(validationMode, planRows),
          };
        }

        rejectedAttempts.push(attempt);
      }
    }

    const candidateByPriority = {
      4: candidateRows.filter((row: any) => row.priority === 4),
      3: candidateRows.filter((row: any) => row.priority === 3),
      2: candidateRows.filter((row: any) => row.priority === 2),
      1: candidateRows.filter((row: any) => row.priority === 1),
    } as Record<number, any[]>;

    for (const priority of [4, 3, 2, 1]) {
      const rowsForPriority = candidateByPriority[priority] || [];

      for (const candidate of rowsForPriority) {
        if (selectedRemovedIds.includes(candidate.id)) continue;

        const nextRemovedIds = [...selectedRemovedIds, candidate.id];
        const nextRemovedRows = [
          ...selectedRemovedRows,
          candidate,
        ];

        let nextTimeline = await rebuildAfterRemoval(nextRemovedIds);
        const evaluation = await evaluateTimeline(nextTimeline);
        nextTimeline = evaluation.evaluatedTimeline;
        const attemptNumber = simulationAttempts.length + 1;
        const selectedWindow = getAttemptSelectedWindow(nextTimeline);
        const attemptComputedTimeline = this.callbacks.buildManualFitAttemptTimelineSnapshot(nextTimeline, {
          removedHotspotIds: nextRemovedIds,
          selectedHotspotId: targetHotspotId,
        });
        const attemptDisplayTimeline = this.callbacks.buildManualFitAttemptComputedDisplayTimelineSnapshot(
        sourceTimeline,
        nextTimeline,
          {
            removedHotspotIds: nextRemovedIds,
            selectedHotspotId: targetHotspotId,
            selectedConflict:
              selectedWindow?.selectedOpeningConflict ||
              evaluation?.selectedOpeningConflict ||
              null,
            protectedHotspotIds: protectedHotspotIdsForDisplay,
          },
        );
        const displayTimelineErrors = this.callbacks.validateManualFitAttemptDisplayTimeline(attemptDisplayTimeline, {
          removedHotspotIds: nextRemovedIds,
          selectedHotspotId: targetHotspotId,
        });

        const attempt = {
          attemptNumber,
          cumulative: true,
          validationMode,
          removedHotspotIds: nextRemovedIds,
          removedHotspotNames: nextRemovedRows.map((row: any) => row.name),
          removedCount: nextRemovedIds.length,
          priorities: nextRemovedRows.map((row: any) => row.priority),
          justTriedHotspotId: candidate.id,
          justTriedName: candidate.name,
          justTriedPriority: priority,
          selectedAttemptedVisitTime: evaluation.selectedAttemptedVisitTime,
          selectedOperatingHours: evaluation.selectedOperatingHours,
          selectedOpeningConflict: evaluation.selectedOpeningConflict,
          finalArrivalTime: evaluation.finalArrivalTime,
          finalOverflowMinutes: evaluation.finalOverflowMinutes,
          dayEndOverflowMinutes: evaluation.dayEndOverflowMinutes,
          selectedClosingOverflowMinutes: evaluation.selectedClosingOverflowMinutes,
          valid: evaluation.valid,
          resolved: evaluation.valid,
          strategy: 'CUMULATIVE_PRIORITY_REMOVAL',
          displayTimelineErrors,
          displayTimelineWarning: displayTimelineErrors.length > 0,
          previewTimelineDisplay: attemptDisplayTimeline,
          displayTimeline: attemptDisplayTimeline,
          previewTimeline: attemptDisplayTimeline,
          computedTimelineDebug: attemptComputedTimeline,
          removalSummary: {
            removedHotspotIds: [...nextRemovedIds],
            removedHotspotNames: nextRemovedRows.map((row: any) => row.name),
            protectedHotspots: buildProtectedHotspotsForSummary(nextRemovedIds),
            result: evaluation.valid ? 'FITS_AFTER_REMOVAL' : 'STILL_DOES_NOT_FIT',
          },
        };

        simulationAttempts.push(attempt);

        if (evaluation.valid) {
          return {
            resolved: true,
            algorithm: 'PROGRESSIVE_PRIORITY_REMOVAL',
            validationMode,
            removedHotspots: toRemovedRows(nextRemovedRows, evaluation),
            candidateHotspots: candidateRows,
            finalTimeline: nextTimeline,
            finalOverflowMinutes: 0,
            finalArrivalTime: evaluation.finalArrivalTime,
            simulationAttempts,
            rejectedAttempts,
            candidateAudit,
            message: this.callbacks.buildProgressiveRemovalSuccessMessage(validationMode, nextRemovedRows),
          };
        }

        rejectedAttempts.push(attempt);
        selectedRemovedIds = nextRemovedIds;
        selectedRemovedRows = nextRemovedRows;
        workingTimeline = nextTimeline;
      }
    }

    const finalEvaluation = await evaluateTimeline(workingTimeline);

    return {
      resolved: false,
      algorithm: 'PROGRESSIVE_PRIORITY_REMOVAL',
      validationMode,
      removedHotspots: [],
      candidateHotspots: candidateRows,
      finalTimeline: finalEvaluation.evaluatedTimeline,
      finalOverflowMinutes: finalEvaluation.finalOverflowMinutes,
      finalArrivalTime: finalEvaluation.finalArrivalTime,
      simulationAttempts,
      rejectedAttempts,
      candidateAudit,
      message:
        validationMode === 'SELECTED_HOTSPOT_CLOSING'
          ? 'Could not fit the selected manual hotspot within operating hours after trying cumulative same-route generated removals.'
          : 'Could not fit the selected manual hotspot within route end after checking same-route Non-manual / Priority 4, then Priority 3, then Priority 2, then Priority 1 removals one by one.',
    };
  }

}
