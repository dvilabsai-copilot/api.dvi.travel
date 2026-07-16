// FILE: src/modules/itineraries/services/itinerary-exact-anchor-rebuild.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type ManualHotspotCityContext = 'SOURCE_CITY' | 'DESTINATION_CITY' | 'UNKNOWN';
type ExactAnchorRebuildCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryExactAnchorRebuildService {
  private readonly exactAnchorSequentialTimelineCache = new Map<string, any[]>();
  private readonly MANUAL_HOTSPOT_EFFECTIVE_PRIORITY = 4;
  private callbacks: ExactAnchorRebuildCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: ExactAnchorRebuildCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private buildExactAnchorSequentialTimelineCacheKey(...args: any[]): any {
    return this.callbacks.buildExactAnchorSequentialTimelineCacheKey?.(...args);
  }

  private cloneTimelineRowsForPreview(...args: any[]): any {
    return this.callbacks.cloneTimelineRowsForPreview?.(...args);
  }

  private getPreviewRowDurationMinutes(...args: any[]): any {
    return this.callbacks.getPreviewRowDurationMinutes?.(...args);
  }

  private minutesRangeToFitPreviewLabel(...args: any[]): any {
    return this.callbacks.minutesRangeToFitPreviewLabel?.(...args);
  }

  private parseSegmentStartMinutes(...args: any[]): any {
    return this.callbacks.parseSegmentStartMinutes?.(...args);
  }

  private getHotspotDurationMinutes(...args: any[]): any {
    return this.callbacks.getHotspotDurationMinutes?.(...args);
  }

  private enrichManualFitPreviewTimelineWithOperatingHours(...args: any[]): any {
    return this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours?.(...args);
  }

  private deriveLooseCityKey(...args: any[]): any {
    return this.callbacks.deriveLooseCityKey?.(...args);
  }

  private classifyManualHotspotCityContext(...args: any[]): any {
    return this.callbacks.classifyManualHotspotCityContext?.(...args);
  }

  private buildManualFitMainTimelineTravelReplicaMap(...args: any[]): any {
    return this.callbacks.buildManualFitMainTimelineTravelReplicaMap?.(...args);
  }

  private resolveSourceToHotspotLeg(...args: any[]): any {
    return this.callbacks.resolveSourceToHotspotLeg?.(...args);
  }

  private findManualFitMainTimelineTravelReplica(...args: any[]): any {
    return this.callbacks.findManualFitMainTimelineTravelReplica?.(...args);
  }

  private chooseReliableTravelDistanceKm(...args: any[]): any {
    return this.callbacks.chooseReliableTravelDistanceKm?.(...args);
  }

  private parseManualFitTravelReplicaDistanceKm(...args: any[]): any {
    return this.callbacks.parseManualFitTravelReplicaDistanceKm?.(...args);
  }

  private getManualFitTravelReplicaDurationMinutes(...args: any[]): any {
    return this.callbacks.getManualFitTravelReplicaDurationMinutes?.(...args);
  }

  private buildManualFitTravelReplicaDisplayFields(...args: any[]): any {
    return this.callbacks.buildManualFitTravelReplicaDisplayFields?.(...args);
  }

  private getCachedRouteMatrixLeg(...args: any[]): any {
    return this.callbacks.getCachedRouteMatrixLeg?.(...args);
  }

  private estimateDurationFromDistance(...args: any[]): any {
    return this.callbacks.estimateDurationFromDistance?.(...args);
  }

  private adjustManualFitVisitStartToOperatingWindow(...args: any[]): any {
    return this.callbacks.adjustManualFitVisitStartToOperatingWindow?.(...args);
  }

  private normalizeTravelLabelsToNextStop(...args: any[]): any {
    return this.callbacks.normalizeTravelLabelsToNextStop?.(...args);
  }

  private rememberExactAnchorSequentialTimeline(...args: any[]): any {
    const [cacheKey, timeline] = args;
    const normalizedKey = String(cacheKey || '').trim();
    if (normalizedKey && Array.isArray(timeline)) {
      this.exactAnchorSequentialTimelineCache.set(
        normalizedKey,
        this.cloneTimelineRowsForPreview(timeline),
      );
      while (this.exactAnchorSequentialTimelineCache.size > 200) {
        const oldestKey = this.exactAnchorSequentialTimelineCache.keys().next().value;
        if (!oldestKey) break;
        this.exactAnchorSequentialTimelineCache.delete(oldestKey);
      }
    }
    return this.callbacks.rememberExactAnchorSequentialTimeline?.(...args);
  }

  async buildExactAnchorSequentialTimelineAfterRemoval(
    tx: any,
    timeline: any[],
    params: {
      removedHotspotIds: number[];
      targetHotspotId: number;
      routeId: number;
      planId: number;
      anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
      afterHotspotId?: number;
      beforeHotspotId?: number;
      allowSelectedClosingAnchorBypass?: boolean;
    },
  ): Promise<any[]> {
    const ordered = Array.isArray(timeline) ? timeline : [];
    const cacheKey = this.buildExactAnchorSequentialTimelineCacheKey(ordered, params);
    const cachedTimeline = this.exactAnchorSequentialTimelineCache.get(cacheKey);
    if (Array.isArray(cachedTimeline) && cachedTimeline.length > 0) {
      return this.cloneTimelineRowsForPreview(cachedTimeline);
    }

    const removedSet = new Set(
      (params.removedHotspotIds || [])
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    const getHotspotId = (row: any): number =>
      Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || row?.id || 0);

    const isAttractionRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };

    const isTravelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };

    const isHotelLikeRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel'
        || type === 'checkin'
        || Number(row?.item_type || 0) === 6
        || text.includes('check-in at hotel')
        || text.includes('check-in at ');
    };

    const cloneForUi = (row: any): any => ({ ...(row || {}) });

    const getName = (row: any): string =>
      String(row?.text || row?.name || row?.title || row?.hotspot_name || row?.to || 'Stop').trim();
    const isSourceLikeInitialTravelReplica = (row: any): boolean => {
      if (!row) return false;

      const fromHotspotId = Number(row?.fromHotspotId || row?.from_hotspot_id || 0);
      if (fromHotspotId > 0) return false;

      const fromLabel = String(
        row?.fromName ||
        row?.from ||
        row?.displayFromName ||
        row?.sourceName ||
        '',
      ).trim().toLowerCase();

      return (
        fromLabel.length === 0 ||
        fromLabel.includes('hotel') ||
        fromLabel.includes('route start') ||
        fromLabel.includes('start your day') ||
        fromLabel.includes('source')
      );
    };

    const getDurationMinutes = (row: any, fallback: number): number => {
      const duration = Number(
        this.getPreviewRowDurationMinutes(row)
        || row?.durationMinutes
        || row?.duration_minutes
        || row?.visitDurationMinutes
        || row?.matrixDurationMin
        || fallback,
      );

      return Math.max(0, Number.isFinite(duration) ? Math.round(duration) : fallback);
    };

    const scheduleRow = (row: any, startMinutes: number, durationMinutes: number): any => ({
      ...cloneForUi(row),
      timeRange: this.minutesRangeToFitPreviewLabel(startMinutes, startMinutes + durationMinutes),
      hotspot_start_time: null,
      hotspot_end_time: null,
    });

    const firstStartMinutes =
      this.parseSegmentStartMinutes(ordered[0])
      ?? this.parseSegmentStartMinutes(ordered.find((row: any) => isAttractionRow(row)))
      ?? 8 * 60;

    const keptRows = ordered.filter((row: any) => {
      if (isAttractionRow(row)) {
        const hotspotId = getHotspotId(row);
        return hotspotId <= 0 || !removedSet.has(hotspotId);
      }

      if (isTravelRow(row)) {
        const toHotspotId = Number(row?.toHotspotId || 0);
        const fromHotspotId = Number(row?.fromHotspotId || 0);
        if (toHotspotId > 0 && removedSet.has(toHotspotId)) return false;
        if (fromHotspotId > 0 && removedSet.has(fromHotspotId)) return false;
      }

      return true;
    });

    const attractionSortKey = (row: any, index: number): number => {
      const hotspotOrder = Number(row?.hotspotOrder ?? row?.hotspot_order ?? 0);
      if (Number.isFinite(hotspotOrder) && hotspotOrder > 0) {
        return hotspotOrder * 1000 + index;
      }
      return index + 1;
    };

    let originalAttractions = ordered
      .map((row: any, index: number) => ({ row, index }))
      .filter((entry: any) => isAttractionRow(entry.row))
      .sort((a: any, b: any) => attractionSortKey(a.row, a.index) - attractionSortKey(b.row, b.index))
      .map((entry: any) => entry.row);

    const existingOriginalAttractionIds = new Set(
      originalAttractions
        .map((row: any) => getHotspotId(row))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    const persistedRouteAttractions = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(params.planId),
        itinerary_route_ID: Number(params.routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_plan_own_way: true,
      },
      orderBy: [{ hotspot_order: 'asc' }, { route_hotspot_ID: 'asc' }],
    });

    const persistedHotspotIds = Array.from(new Set(
      (persistedRouteAttractions || [])
        .map((row: any) => Number(row?.hotspot_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ));

    console.log('[FitHere][APJ_PIVOT_ARRAY_SOURCE]', {
      routeId: Number(params.routeId),
      selectedHotspotId: Number(params.targetHotspotId || 0),
      source: 'VISIBLE_TIMELINE_ONLY',
      fromTimelineIds: Array.from(existingOriginalAttractionIds),
      fromDbIds: persistedHotspotIds,
      addedFromDbIds: [],
      finalIds: originalAttractions.map((row: any) => getHotspotId(row)),
    });

    let selectedAttractionRow =
      originalAttractions.find((row: any) => getHotspotId(row) === Number(params.targetHotspotId || 0))
      || keptRows.find((row: any) => isAttractionRow(row) && getHotspotId(row) === Number(params.targetHotspotId || 0))
      || null;

    if (!selectedAttractionRow && Number(params.targetHotspotId || 0) > 0 && !removedSet.has(Number(params.targetHotspotId || 0))) {
      const selectedMaster = await (tx as any).dvi_hotspot_place.findFirst({
        where: { hotspot_ID: Number(params.targetHotspotId || 0), deleted: 0 },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_duration: true,
          hotspot_priority: true,
          hotspot_location: true,
          hotspot_to_location: true,
        },
      });

      if (selectedMaster) {
        const selectedDurationMinutes = this.getHotspotDurationMinutes(selectedMaster, {});
        selectedAttractionRow = {
          type: 'attraction',
          item_type: 4,
          locationId: Number(selectedMaster.hotspot_ID || params.targetHotspotId || 0),
          hotspot_ID: Number(selectedMaster.hotspot_ID || params.targetHotspotId || 0),
          hotspotId: Number(selectedMaster.hotspot_ID || params.targetHotspotId || 0),
          hotspot_id: Number(selectedMaster.hotspot_ID || params.targetHotspotId || 0),
          routeHotspotId: 0,
          route_hotspot_ID: 0,
          hotspotOrder: 0,
          hotspot_order: 0,
          text: String(selectedMaster.hotspot_name || `Hotspot #${Number(params.targetHotspotId || 0)}`).trim(),
          name: String(selectedMaster.hotspot_name || `Hotspot #${Number(params.targetHotspotId || 0)}`).trim(),
          hotspot_name: String(selectedMaster.hotspot_name || `Hotspot #${Number(params.targetHotspotId || 0)}`).trim(),
          hotspot_priority: Number(selectedMaster.hotspot_priority || this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY),
          priority: Number(selectedMaster.hotspot_priority || this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY),
          hotspot_location: selectedMaster.hotspot_location || '',
          hotspot_to_location: selectedMaster.hotspot_to_location || '',
          hotspot_plan_own_way: 1,
          isManual: true,
          durationMinutes: selectedDurationMinutes,
          duration: `${selectedDurationMinutes} min`,
        };

        originalAttractions = [selectedAttractionRow, ...originalAttractions];
        console.log('[FitHere][APJ_PIVOT_SYNTHESIZED_SELECTED]', {
          routeId: Number(params.routeId),
          selectedHotspotId: Number(params.targetHotspotId || 0),
          selectedHotspotName: selectedAttractionRow.name,
        });
      }
    }

    // The exact-anchor rebuild schedules rows before the final display-timeline
    // enrichment pass. Load the complete same-day operating-window summary now
    // so split shifts (for example 05:00-08:00, 16:00-19:00) are available to
    // adjustManualFitVisitStartToOperatingWindow. Without this, a manual
    // hotspot arriving between shifts is incorrectly marked as closed instead
    // of waiting for the next valid window.
    originalAttractions = await this.enrichManualFitPreviewTimelineWithOperatingHours(
      Number(params.planId),
      Number(params.routeId),
      originalAttractions,
    );
    // The enrichment returns cloned row objects; refresh the selected-row
    // reference so the scheduler receives the enriched split-window fields.
    selectedAttractionRow =
      originalAttractions.find((row: any) => getHotspotId(row) === Number(params.targetHotspotId || 0))
      || selectedAttractionRow;

    const survivingAttractions = originalAttractions.filter((row: any) => {
      const hotspotId = getHotspotId(row);
      return hotspotId > 0 && hotspotId !== Number(params.targetHotspotId || 0) && !removedSet.has(hotspotId);
    });

    const anchorIntent = String(params.anchorIntent || '').toUpperCase();
    const anchorAfterHotspotId = Number(params.afterHotspotId || 0);
    const anchorBeforeHotspotId = Number(params.beforeHotspotId || 0);

    const routeRowForDirection = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(params.routeId),
        deleted: 0,
      },
      select: {
        location_id: true,
        location_name: true,
        next_visiting_location: true,
      },
    });

    const routeLocationForDirection = Number(routeRowForDirection?.location_id || 0) > 0
      ? await (tx as any).dvi_stored_locations.findFirst({
          where: {
            location_ID: Number(routeRowForDirection?.location_id || 0),
            deleted: 0,
          },
          select: {
            source_location: true,
            destination_location: true,
          },
        })
      : null;

    const routeCityContext = {
      location_name: String(routeRowForDirection?.location_name || routeLocationForDirection?.source_location || '').trim(),
      next_visiting_location: String(routeRowForDirection?.next_visiting_location || routeLocationForDirection?.destination_location || '').trim(),
    };

    const sourceCityKey = this.deriveLooseCityKey(routeCityContext.location_name);
    const destinationCityKey = this.deriveLooseCityKey(routeCityContext.next_visiting_location);
    const sameCityRoute = !!sourceCityKey && !!destinationCityKey && sourceCityKey === destinationCityKey;
    const attractionIdsForDirection = Array.from(new Set(
      originalAttractions
        .map((row: any) => getHotspotId(row))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ));

    const directionMasters = attractionIdsForDirection.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: {
            hotspot_ID: { in: attractionIdsForDirection },
            deleted: 0,
          },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_location: true,
            hotspot_to_location: true,
          },
        })
      : [];

    const directionMasterById = new Map<number, any>(
      directionMasters.map((row: any) => [Number(row?.hotspot_ID || 0), row]),
    );

    const getAttractionCityContext = (row: any): ManualHotspotCityContext => {
      const hotspotId = getHotspotId(row);
      const master = directionMasterById.get(hotspotId) || {};
      return this.classifyManualHotspotCityContext(routeCityContext, {
        hotspot_location: master?.hotspot_location || row?.hotspot_location || row?.location || '',
        hotspot_to_location: master?.hotspot_to_location || row?.hotspot_to_location || '',
        hotspot_name: master?.hotspot_name || row?.hotspot_name || row?.name || row?.text || '',
      });
    };

    const selectedCityContext = selectedAttractionRow
      ? getAttractionCityContext(selectedAttractionRow)
      : 'UNKNOWN';

    const directionRank = (row: any): number => {
      if (sameCityRoute || !['SOURCE_CITY', 'DESTINATION_CITY'].includes(selectedCityContext)) return 0;

      const rowContext = getAttractionCityContext(row);
      if (rowContext === selectedCityContext) return 0;
      if (rowContext === 'UNKNOWN') return 1;
      return 2;
    };

    const orderDirectionalSurvivors = (rows: any[]): any[] =>
      [...rows].sort((a: any, b: any) => {
        const rankDiff = directionRank(a) - directionRank(b);
        if (rankDiff !== 0) return rankDiff;
        return attractionSortKey(a, originalAttractions.indexOf(a)) - attractionSortKey(b, originalAttractions.indexOf(b));
      });

    const oppositeCityContext =
      selectedCityContext === 'DESTINATION_CITY'
        ? 'SOURCE_CITY'
        : (
            selectedCityContext === 'SOURCE_CITY'
              ? 'DESTINATION_CITY'
              : 'UNKNOWN'
          );

    const pruneDirectionalBacktrackingAfterPivot = (rows: any[]): any[] => {
      return orderDirectionalSurvivors(rows);
    };

    const stabilizePrefixRowsBeforeDirectionalPivot = (rows: any[]): { keptPrefixRows: any[]; deferredRows: any[] } => {
      if (sameCityRoute || !['SOURCE_CITY', 'DESTINATION_CITY'].includes(selectedCityContext)) {
        return {
          keptPrefixRows: [...rows],
          deferredRows: [],
        };
      }

      const keptPrefixRows: any[] = [];
      const deferredRows: any[] = [];
      const rowContexts = rows.map((row: any) => getAttractionCityContext(row));

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const hotspotId = getHotspotId(row);
        const rowContext = rowContexts[index];
        const shouldBypassClickedAnchorForClosing =
          params.allowSelectedClosingAnchorBypass === true
          && hotspotId > 0
          && hotspotId === anchorAfterHotspotId
          && rowContext === selectedCityContext;
        const hasLaterOppositeSideRow = rowContexts.slice(index + 1).some((candidate: any) => candidate === oppositeCityContext);

        if (shouldBypassClickedAnchorForClosing || (rowContext === selectedCityContext && hasLaterOppositeSideRow)) {
          deferredRows.push(row);
          console.log('[FitHere][APJ_PIVOT_PREFIX_REORDER]', {
            routeId: Number(params.routeId),
            selectedHotspotId: Number(params.targetHotspotId || 0),
            hotspotId,
            name: getName(row),
            cityContext: rowContext,
            decision: shouldBypassClickedAnchorForClosing
              ? 'DEFER_CLICKED_ANCHOR_AFTER_SELECTED_PIVOT'
              : 'DEFER_BEFORE_SELECTED_PIVOT',
            reason: shouldBypassClickedAnchorForClosing
              ? `${getName(row)} was moved after the selected hotspot so the selected manual hotspot can fit before closing time.`
              : `${getName(row)} was moved after the selected pivot to avoid a cross-city bounce before the selected hotspot.`,
          });
          continue;
        }

        keptPrefixRows.push(row);
      }

      return {
        keptPrefixRows,
        deferredRows,
      };
    };

    const scheduledAttractions = (() => {
      if (!selectedAttractionRow) {
        console.warn('[FitHere][APJ_PIVOT_ARRAY_ABORT_NO_SELECTED]', {
          routeId: Number(params.routeId),
          selectedHotspotId: Number(params.targetHotspotId || 0),
          survivingIds: survivingAttractions.map((row: any) => getHotspotId(row)),
        });
        return [];
      }

      if (anchorIntent === 'AFTER_START') {
        return [selectedAttractionRow, ...pruneDirectionalBacktrackingAfterPivot(survivingAttractions)];
      }

      if (anchorAfterHotspotId > 0) {
        const afterIndex = survivingAttractions.findIndex((row: any) => getHotspotId(row) === anchorAfterHotspotId);
        if (afterIndex >= 0) {
          const prefixRows = survivingAttractions.slice(0, afterIndex + 1);
          const downstreamRows = survivingAttractions.slice(afterIndex + 1);
          const { keptPrefixRows, deferredRows } = stabilizePrefixRowsBeforeDirectionalPivot(prefixRows);
          return [
            ...keptPrefixRows,
            selectedAttractionRow,
            ...pruneDirectionalBacktrackingAfterPivot([...deferredRows, ...downstreamRows]),
          ];
        }

        if (anchorBeforeHotspotId > 0) {
          const beforeIndex = survivingAttractions.findIndex((row: any) => getHotspotId(row) === anchorBeforeHotspotId);
          if (beforeIndex >= 0) {
            const prefixRows = survivingAttractions.slice(0, beforeIndex);
            const downstreamRows = survivingAttractions.slice(beforeIndex);
            const { keptPrefixRows, deferredRows } = stabilizePrefixRowsBeforeDirectionalPivot(prefixRows);
            return [
              ...keptPrefixRows,
              selectedAttractionRow,
              ...pruneDirectionalBacktrackingAfterPivot([...deferredRows, ...downstreamRows]),
            ];
          }
        }
      }

      return [selectedAttractionRow, ...pruneDirectionalBacktrackingAfterPivot(survivingAttractions)];
    })();

    console.log('[FitHere][APJ_PIVOT_ARRAY_ORDER]', {
      routeId: Number(params.routeId),
      selectedHotspotId: Number(params.targetHotspotId || 0),
      anchorIntent,
      anchorAfterHotspotId,
      anchorBeforeHotspotId,
      scheduled: scheduledAttractions.map((row: any, index: number) => ({
        index,
        hotspotId: getHotspotId(row),
        name: getName(row),
        cityContext: getAttractionCityContext(row),
        decision: getHotspotId(row) === Number(params.targetHotspotId || 0) ? 'SELECTED_MANUAL_PIVOT' : 'TRY_SCHEDULE',
      })),
    });

    const rebuilt: any[] = [];
    let cursor = firstStartMinutes;
    let previousAttraction: any | null = null;
    const authoritativeTravelReplicaMap = this.buildManualFitMainTimelineTravelReplicaMap(ordered);

    const hotelRows = keptRows.filter((row: any) => isHotelLikeRow(row));
    const firstAttractionRow = scheduledAttractions[0] || null;
    const fallbackInitialTravel = keptRows.find((row: any) => {
      if (!isTravelRow(row) || isHotelLikeRow(row)) return false;
      if (!isSourceLikeInitialTravelReplica(row)) return false;
      const toHotspotId = Number(row?.toHotspotId || 0);
      const toName = String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();
      const targetName = String(firstAttractionRow?.text || firstAttractionRow?.name || '').trim().toLowerCase();
      const targetHotspotId = getHotspotId(firstAttractionRow);
      return (
        (targetHotspotId > 0 && toHotspotId === targetHotspotId)
        || (!!targetName && toName.includes(targetName))
      );
    }) || null;

    const leadingStaticRows = keptRows.filter((row: any) => {
      if (isHotelLikeRow(row)) return false;
      if (isTravelRow(row)) return false;
      if (isAttractionRow(row)) return false;
      return true;
    });

    for (const row of leadingStaticRows) {
      const duration = getDurationMinutes(row, 0);
      const scheduled = scheduleRow(row, cursor, duration);
      cursor += duration;
      rebuilt.push(scheduled);
    }

    for (const row of scheduledAttractions) {
      if (isHotelLikeRow(row)) {
        continue;
      }

      if (isTravelRow(row)) {
        continue;
      }

      const currentAttraction = row;

      if (!previousAttraction) {
        const toId = getHotspotId(currentAttraction);
        if (toId > 0 && currentAttraction === firstAttractionRow) {
          const sourceLeg = await this.resolveSourceToHotspotLeg(tx, Number(params.routeId), toId);
          const initialTravelReplicaCandidate =
            this.findManualFitMainTimelineTravelReplica(authoritativeTravelReplicaMap, {
              toHotspotId: toId,
              toName: getName(currentAttraction),
            })
            || (fallbackInitialTravel && !isHotelLikeRow(fallbackInitialTravel) ? fallbackInitialTravel : null);
          const initialTravelReplica = isSourceLikeInitialTravelReplica(initialTravelReplicaCandidate)
            ? initialTravelReplicaCandidate
            : null;
          const initialDistanceKm = this.chooseReliableTravelDistanceKm(
            initialTravelReplica
              ? this.parseManualFitTravelReplicaDistanceKm(
                  initialTravelReplica?.matrixDistanceKm ??
                  initialTravelReplica?.distanceKm ??
                  initialTravelReplica?.travelDistanceKm ??
                  initialTravelReplica?.hotspot_travelling_distance ??
                  initialTravelReplica?.distance,
                )
              : (sourceLeg.distanceKm != null ? Number(sourceLeg.distanceKm) : null),
            fallbackInitialTravel?.matrixDistanceKm != null
              ? Number(fallbackInitialTravel.matrixDistanceKm)
              : (fallbackInitialTravel?.distanceKm != null ? Number(fallbackInitialTravel.distanceKm) : null),
          );
          const initialTravelMinutes = Math.max(
            1,
            Math.round(
              Number(
                this.getManualFitTravelReplicaDurationMinutes(initialTravelReplica)
                || fallbackInitialTravel?.matrixDurationMin
                || this.getPreviewRowDurationMinutes(fallbackInitialTravel)
                || sourceLeg.durationMin
                || 10,
              ),
            ),
          );
          const initialTravelDisplay = this.buildManualFitTravelReplicaDisplayFields(
            initialTravelReplica,
            initialTravelMinutes,
            initialDistanceKm,
          );
          const toLabel = getName(currentAttraction);
          const fromLabel = String(
            sourceLeg.sourceName
            || initialTravelReplica?.fromName
            || initialTravelReplica?.from
            || fallbackInitialTravel?.fromName
            || fallbackInitialTravel?.from
            || 'Route Start',
          ).trim();

          console.log('[FitHere][MAIN_TIMELINE_TRAVEL_REPLICA]', {
            routeId: Number(params.routeId),
            fromHotspotId: null,
            toHotspotId: toId,
            fromName: fromLabel,
            toName: toLabel,
            source: initialTravelReplica ? 'MAIN_TIMELINE_REPLICA' : 'SOURCE_ENDPOINT_FALLBACK',
            durationMin: initialTravelMinutes,
            distanceKm: initialDistanceKm,
            originalTimeRange: initialTravelReplica?.timeRange || fallbackInitialTravel?.timeRange || null,
          });

          rebuilt.push({
            ...(initialTravelReplica || fallbackInitialTravel || {}),
            type: 'travel',
            item_type: Number(initialTravelReplica?.item_type || fallbackInitialTravel?.item_type || 3),
            text: `Travel to ${toLabel}`,
            name: `Travel to ${toLabel}`,
            fromName: fromLabel,
            toName: toLabel,
            from: fromLabel,
            to: toLabel,
            displayFromName: fromLabel,
            displayToName: toLabel,
            fromHotspotId: undefined,
            toHotspotId: toId,
            durationMinutes: initialTravelDisplay.durationMinutes,
            matrixDurationMin: initialTravelDisplay.matrixDurationMin,
            duration: initialTravelDisplay.duration,
            travelDuration: initialTravelDisplay.travelDuration,
            matrixDistanceKm: initialDistanceKm,
            distanceKm: initialDistanceKm,
            travelDistanceKm: initialDistanceKm,
            distance: initialTravelDisplay.distance,
            hotspot_travelling_distance: initialTravelDisplay.hotspot_travelling_distance,
            hotspot_traveling_distance: initialTravelDisplay.hotspot_traveling_distance,
            hotspot_travelling_time: initialTravelDisplay.hotspot_travelling_time,
            hotspot_traveling_time: initialTravelDisplay.hotspot_traveling_time,
            timeRange: this.minutesRangeToFitPreviewLabel(cursor, cursor + initialTravelMinutes),
            isMatrixReconnectedTravel: true,
            isEstimatedTravel:
              initialTravelReplica == null
              && fallbackInitialTravel?.matrixDurationMin == null
              && this.getPreviewRowDurationMinutes(fallbackInitialTravel) == null
              && sourceLeg.durationMin == null,
            id: undefined,
            locationId: undefined,
            hotspot_ID: undefined,
            hotspotId: undefined,
            hotspot_id: undefined,
          });

          cursor += initialTravelMinutes;
        }
      } else {
        const fromId = getHotspotId(previousAttraction);
        const toId = getHotspotId(currentAttraction);
        const fromLabel = getName(previousAttraction);
        const toLabel = getName(currentAttraction);
        const fromLabelKey = fromLabel.trim().toLowerCase();
        const toLabelKey = toLabel.trim().toLowerCase();

        const fallbackPairTravel = [...ordered, ...keptRows].find((row: any) => {
          if (!isTravelRow(row) || isHotelLikeRow(row)) return false;

          const rowFromId = Number(row?.fromHotspotId || row?.from_hotspot_id || 0);
          const rowToId = Number(row?.toHotspotId || row?.to_hotspot_id || 0);
          if (rowFromId > 0 && rowToId > 0) {
            return rowFromId === fromId && rowToId === toId;
          }

          const rowFromLabel = String(row?.fromName || row?.from || row?.displayFromName || '').trim().toLowerCase();
          const rowToLabel = String(row?.toName || row?.to || row?.displayToName || row?.text || row?.name || '').trim().toLowerCase();
          return !!fromLabelKey && !!toLabelKey && rowFromLabel.includes(fromLabelKey) && rowToLabel.includes(toLabelKey);
        }) || null;

        const mainTimelineTravelReplica =
          this.findManualFitMainTimelineTravelReplica(authoritativeTravelReplicaMap, {
            fromHotspotId: fromId,
            toHotspotId: toId,
            fromName: fromLabel,
            toName: toLabel,
          })
          || fallbackPairTravel;
        const leg = mainTimelineTravelReplica ? null : await this.getCachedRouteMatrixLeg(tx, fromId, toId);
        const fallbackTravelMinutes = Number(
          this.getManualFitTravelReplicaDurationMinutes(mainTimelineTravelReplica)
          || fallbackPairTravel?.matrixDurationMin
          || this.getPreviewRowDurationMinutes(fallbackPairTravel)
          || fallbackPairTravel?.durationMinutes
          || 0,
        );
        const travelMinutes = Math.max(
          1,
          Math.round(
            Number(
              fallbackTravelMinutes
              || leg?.durationMin
              || this.estimateDurationFromDistance(leg?.distanceKm)
              || 10,
            ),
          ),
        );
        const pairDistanceKm = this.chooseReliableTravelDistanceKm(
          mainTimelineTravelReplica
            ? this.parseManualFitTravelReplicaDistanceKm(
                mainTimelineTravelReplica?.matrixDistanceKm ??
                mainTimelineTravelReplica?.distanceKm ??
                mainTimelineTravelReplica?.travelDistanceKm ??
                mainTimelineTravelReplica?.hotspot_travelling_distance ??
                mainTimelineTravelReplica?.distance,
              )
            : (
                fallbackPairTravel?.matrixDistanceKm != null
                  ? Number(fallbackPairTravel.matrixDistanceKm)
                  : (fallbackPairTravel?.distanceKm != null ? Number(fallbackPairTravel.distanceKm) : null)
              ),
          leg?.distanceKm != null ? Number(leg.distanceKm) : null,
        );
        const pairTravelDisplay = this.buildManualFitTravelReplicaDisplayFields(
          mainTimelineTravelReplica,
          travelMinutes,
          pairDistanceKm,
        );

        console.log('[FitHere][MAIN_TIMELINE_TRAVEL_REPLICA]', {
          routeId: Number(params.routeId),
          fromHotspotId: fromId,
          toHotspotId: toId,
          fromName: fromLabel,
          toName: toLabel,
          source: mainTimelineTravelReplica ? 'MAIN_TIMELINE_REPLICA' : 'MATRIX_FALLBACK',
          durationMin: travelMinutes,
          distanceKm: pairDistanceKm,
          originalTimeRange: mainTimelineTravelReplica?.timeRange || fallbackPairTravel?.timeRange || null,
        });

        rebuilt.push({
          ...(mainTimelineTravelReplica || fallbackPairTravel || {}),
          type: 'travel',
          item_type: Number(mainTimelineTravelReplica?.item_type || fallbackPairTravel?.item_type || 3),
          text: `Travel to ${toLabel}`,
          name: `Travel to ${toLabel}`,
          fromName: fromLabel,
          toName: toLabel,
          from: fromLabel,
          to: toLabel,
          displayFromName: fromLabel,
          displayToName: toLabel,
          fromHotspotId: fromId,
          toHotspotId: toId,
          durationMinutes: pairTravelDisplay.durationMinutes,
          matrixDurationMin: pairTravelDisplay.matrixDurationMin,
          duration: pairTravelDisplay.duration,
          travelDuration: pairTravelDisplay.travelDuration,
          matrixDistanceKm: pairDistanceKm,
          distanceKm: pairDistanceKm,
          travelDistanceKm: pairDistanceKm,
          distance: pairTravelDisplay.distance,
          hotspot_travelling_distance: pairTravelDisplay.hotspot_travelling_distance,
          hotspot_traveling_distance: pairTravelDisplay.hotspot_traveling_distance,
          hotspot_travelling_time: pairTravelDisplay.hotspot_travelling_time,
          hotspot_traveling_time: pairTravelDisplay.hotspot_traveling_time,
          timeRange: this.minutesRangeToFitPreviewLabel(cursor, cursor + travelMinutes),
          isMatrixReconnectedTravel: true,
          isMainTimelineTravelReplica: !!mainTimelineTravelReplica,
        });

        cursor += travelMinutes;
      }

      const visitMinutes = getDurationMinutes(currentAttraction, 60);
      const operatingAdjustment = this.adjustManualFitVisitStartToOperatingWindow(
        currentAttraction,
        cursor,
        visitMinutes,
      );

      if (!operatingAdjustment.valid && getHotspotId(currentAttraction) !== Number(params.targetHotspotId || 0)) {
        console.warn('[FitHere][APJ_PIVOT_DECISION]', {
          routeId: Number(params.routeId),
          hotspotId: getHotspotId(currentAttraction),
          name: getName(currentAttraction),
          cityContext: getAttractionCityContext(currentAttraction),
          decision: 'REMOVE_OPERATING_HOURS_AFTER_PIVOT',
          reason: `${getName(currentAttraction)} removed because arrival/visit crossed operating hours.`,
          attemptedVisitTime: this.minutesRangeToFitPreviewLabel(cursor, cursor + visitMinutes),
          operatingHours: operatingAdjustment.operatingHours,
        });
        continue;
      }

      if (operatingAdjustment.waitingMinutes > 0) {
        rebuilt.push({
          type: 'waiting',
          item_type: 0,
          text: `Wait for ${getName(currentAttraction)} to open`,
          name: `Wait for ${getName(currentAttraction)} to open`,
          gapMinutes: operatingAdjustment.waitingMinutes,
          isSyntheticWaiting: true,
          timeRange: this.minutesRangeToFitPreviewLabel(cursor, operatingAdjustment.startMinutes),
        });
      }

      const adjustedStartMinutes = operatingAdjustment.valid
        ? operatingAdjustment.startMinutes
        : cursor;
      const scheduledAttraction = scheduleRow(currentAttraction, adjustedStartMinutes, visitMinutes);
      rebuilt.push(scheduledAttraction);
      cursor = adjustedStartMinutes + visitMinutes;
      previousAttraction = currentAttraction;
    }

    if (previousAttraction && hotelRows.length > 0) {
      const hotelRow = hotelRows[0];
      const fromLabel = getName(previousAttraction);
      const hotelName = getName(hotelRow).replace(/^Check-?in at\s*/i, '') || 'Hotel';
      const fallbackHotelTravel = ordered.find((row: any) => {
        const text = String(row?.text || row?.name || '').toLowerCase();
        return isTravelRow(row) && text.includes('travel to hotel');
      });

      const hotelTravelMinutes = Math.max(
        1,
        Math.round(
          Number(
            fallbackHotelTravel?.matrixDurationMin
            || this.getPreviewRowDurationMinutes(fallbackHotelTravel)
            || 10,
          ),
        ),
      );

      rebuilt.push({
        ...(fallbackHotelTravel || {}),
        type: 'travel',
        item_type: 5,
        text: `Travel to ${hotelName}`,
        name: `Travel to ${hotelName}`,
        fromName: fromLabel,
        toName: hotelName,
        from: fromLabel,
        to: hotelName,
        displayFromName: fromLabel,
        displayToName: hotelName,
        matrixDurationMin: hotelTravelMinutes,
        duration: `${hotelTravelMinutes} min`,
        timeRange: this.minutesRangeToFitPreviewLabel(cursor, cursor + hotelTravelMinutes),
        isMatrixReconnectedTravel: true,
        id: undefined,
        locationId: undefined,
        hotspot_ID: undefined,
        hotspotId: undefined,
        hotspot_id: undefined,
      });

      cursor += hotelTravelMinutes;

      for (const hotelRowItem of hotelRows) {
        rebuilt.push({
          ...cloneForUi(hotelRowItem),
          timeRange: this.minutesRangeToFitPreviewLabel(cursor, cursor),
          hotspot_start_time: null,
          hotspot_end_time: null,
          isZeroDurationHotel: true,
        });
      }
    }

    const enriched = await this.enrichManualFitPreviewTimelineWithOperatingHours(
      Number(params.planId),
      Number(params.routeId),
      rebuilt.map((row: any, index: number) => ({
        ...row,
        previewOrder: index,
        matrixPreviewOrder: index,
      })),
    );

    const normalized = this.normalizeTravelLabelsToNextStop(enriched);
    this.rememberExactAnchorSequentialTimeline(cacheKey, normalized);
    console.log('[FitHere][APJ_PIVOT_REBUILT_TIMELINE]', {
      routeId: Number(params.routeId),
      selectedHotspotId: Number(params.targetHotspotId || 0),
      attractionIds: normalized
        .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4)
        .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0)),
      rows: normalized.map((row: any, index: number) => ({
        index,
        type: row?.type,
        text: row?.text || row?.name,
        hotspotId: Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0) || null,
        timeRange: row?.timeRange || null,
      })),
    });

    return this.cloneTimelineRowsForPreview(normalized);
  }
}
