// FILE: src/modules/itineraries/services/itinerary-preview-timeline-application.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type ManualHotspotCityContext = 'SOURCE_CITY' | 'DESTINATION_CITY' | 'UNKNOWN';
type PreviewTimelineApplicationCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryPreviewTimelineApplicationService {
  private readonly MANUAL_HOTSPOT_EFFECTIVE_PRIORITY = 4;
  private callbacks: PreviewTimelineApplicationCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: PreviewTimelineApplicationCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private classifyManualHotspotCityContext(...args: any[]): any { return this.callbacks.classifyManualHotspotCityContext?.(...args); }
  private deriveLooseCityKey(...args: any[]): any { return this.callbacks.deriveLooseCityKey?.(...args); }
  private finalizeMatrixPreviewTimeline(...args: any[]): any { return this.callbacks.finalizeMatrixPreviewTimeline?.(...args); }
  private getHotspotDurationMinutes(...args: any[]): any { return this.callbacks.getHotspotDurationMinutes?.(...args); }
  private getHotspotDurationMinutesFromMasterFirst(...args: any[]): any { return this.callbacks.getHotspotDurationMinutesFromMasterFirst?.(...args); }
  private getPreviewRowDurationFromDurationFieldsOnly(...args: any[]): any { return this.callbacks.getPreviewRowDurationFromDurationFieldsOnly?.(...args); }
  private getPreviewRowDurationMinutes(...args: any[]): any { return this.callbacks.getPreviewRowDurationMinutes?.(...args); }
  private minutesRangeToTimeString(...args: any[]): any { return this.callbacks.minutesRangeToTimeString?.(...args); }
  private normalizeHotspotPriority(...args: any[]): any { return this.callbacks.normalizeHotspotPriority?.(...args); }
  private parseSegmentEndMinutes(...args: any[]): any { return this.callbacks.parseSegmentEndMinutes?.(...args); }
  private parseSegmentStartMinutes(...args: any[]): any { return this.callbacks.parseSegmentStartMinutes?.(...args); }
  public applyManualInsertionFitToPreviewTimeline(
    previewTimeline: any[],
    manualInsertionFit: any,
    selectedHotspotId: number,
  ): any[] {
    if (!Array.isArray(previewTimeline) || !manualInsertionFit) return previewTimeline;

 // If backend already produced explicit matrix split legs, treat that order as final.
 // Moving only the attraction row here can break A->C->B adjacency and create visual duplicates.
    if (previewTimeline.some((row: any) => row?.isMatrixSplitTravel === true)) {
      return previewTimeline;
    }

    const selectedIdNum = Number(selectedHotspotId || 0);
    if (selectedIdNum <= 0) return previewTimeline;

    const isInvalidSlot = (slot: any): boolean => {
      if (!slot) return true;
      return (
        Number(slot?.fromHotspotId || 0) === selectedIdNum
        || Number(slot?.toHotspotId || 0) === selectedIdNum
      );
    };

 // Prefer chosenSlot when valid; otherwise fallback to bestSlot; then first valid allSlotResults row.
    let effectiveSlot = !isInvalidSlot(manualInsertionFit?.chosenSlot)
      ? manualInsertionFit.chosenSlot
      : (!isInvalidSlot(manualInsertionFit?.bestSlot)
          ? manualInsertionFit.bestSlot
          : null);

    if (!effectiveSlot && Array.isArray(manualInsertionFit?.allSlotResults)) {
      effectiveSlot = manualInsertionFit.allSlotResults.find((row: any) => !isInvalidSlot(row)) || null;
    }

    if (!effectiveSlot) return previewTimeline;

 // Reject slots that include the selected hotspot as an endpoint
    if (
      Number(effectiveSlot.fromHotspotId) === selectedIdNum ||
      Number(effectiveSlot.toHotspotId) === selectedIdNum
    ) {
      return previewTimeline;
    }

 // Make a copy of the timeline
    let adjustedTimeline = [...previewTimeline];

 // Find the selected hotspot row and its current index
    let selectedRowIndex = -1;
    let selectedRow: any = null;
    for (let i = 0; i < adjustedTimeline.length; i++) {
      const row = adjustedTimeline[i];
      const rowHotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
      if (rowHotspotId === selectedIdNum) {
        selectedRowIndex = i;
        selectedRow = row;
        break;
      }
    }

    if (!selectedRow || selectedRowIndex === -1) return previewTimeline;

 // Find from and to hotspot rows
    let fromRowIndex = -1;
    let toRowIndex = -1;
    const fromIdNum = Number(effectiveSlot.fromHotspotId || 0);
    const toIdNum = Number(effectiveSlot.toHotspotId || 0);

    for (let i = 0; i < adjustedTimeline.length; i++) {
      const row = adjustedTimeline[i];
      const rowHotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
      if (fromRowIndex === -1 && rowHotspotId === fromIdNum) {
        fromRowIndex = i;
      }
      if (toRowIndex === -1 && rowHotspotId === toIdNum) {
        toRowIndex = i;
      }
    }

 // Validate slot boundaries exist
    if (fromRowIndex === -1 || toRowIndex === -1 || fromRowIndex >= toRowIndex) {
      return previewTimeline;
    }

 // Remove selected row from its old location
    adjustedTimeline.splice(selectedRowIndex, 1);

 // Recalculate indices after removal
    if (selectedRowIndex < fromRowIndex) {
      fromRowIndex -= 1;
    }
    if (selectedRowIndex < toRowIndex) {
      toRowIndex -= 1;
    }

 // Calculate time range: available gap between from and to hotspots
    const fromRow = adjustedTimeline[fromRowIndex];
    const toRow = adjustedTimeline[toRowIndex];
    const fromEndMinutes = this.parseSegmentEndMinutes(fromRow);
    const toStartMinutes = this.parseSegmentStartMinutes(toRow);

 // Get selected hotspot duration
    const selectedDurationMinutes = this.getPreviewRowDurationMinutes(selectedRow);

    let calculatedTimeRange: string | null = null;
    let isTimingConflict = false;
    let conflictReason: string | null = null;

    if (
      fromEndMinutes !== null &&
      toStartMinutes !== null &&
      selectedDurationMinutes !== null &&
      toStartMinutes >= fromEndMinutes
    ) {
      const availableGapMinutes = toStartMinutes - fromEndMinutes;

      if (availableGapMinutes >= selectedDurationMinutes) {
 // Fits perfectly in the gap
        const startMinutes = fromEndMinutes;
        const endMinutes = startMinutes + selectedDurationMinutes;
        calculatedTimeRange = this.minutesRangeToTimeString(startMinutes, endMinutes);
      } else {
 // Does not fit in the time gap
        isTimingConflict = true;
        conflictReason = 'Selected hotspot fits route-wise but does not fit current time gap.';
      }
    } else {
 // Missing timing anchors; never keep stale fallback time for matrix-positioned row.
      isTimingConflict = true;
      conflictReason = 'Selected hotspot fits route-wise but does not fit current time gap.';
    }

 // Create adjusted row with matrix positioning metadata
    const adjustedRow = {
      ...selectedRow,
      isUserSelectedPreview: true,
      isMatrixPositioned: true,
      matrixFit: {
        routeFitType: effectiveSlot.routeFitType,
        label: effectiveSlot.label,
        displayLabel: effectiveSlot.displayLabel || effectiveSlot.label,
        shortLabel: effectiveSlot.shortLabel || effectiveSlot.label,
        fromName: effectiveSlot.fromName,
        toName: effectiveSlot.toName,
        roadDetourKm: effectiveSlot.roadDetourKm,
        isZeroExtraDetour: effectiveSlot.isZeroExtraDetour === true,
        distanceComparisonNote: effectiveSlot.distanceComparisonNote || null,
        roadDetourRatio: effectiveSlot.roadDetourRatio,
        routeDecisionReason: effectiveSlot.decisionReason || effectiveSlot.routeDecisionReason,
      },
    };

    if (isTimingConflict) {
      adjustedRow.isConflict = true;
      adjustedRow.conflictReason = conflictReason;
      adjustedRow.timeRange = 'Needs reschedule';
    } else if (calculatedTimeRange) {
      adjustedRow.isConflict = false;
      adjustedRow.conflictReason = null;
      adjustedRow.timeRange = calculatedTimeRange;
    }

 // Reinsert adjusted row between from and to
 // Insert after fromRowIndex so it comes between from and to
    adjustedTimeline.splice(fromRowIndex + 1, 0, adjustedRow);

    return adjustedTimeline;
  }

  public destinationSidePreviewDroppedBaselineRows(params: {
    baselineTimeline: any[];
    previewTimeline: any[];
    selectedHotspotId: number;
    removedHotspotIds?: number[];
  }): boolean {
    const baselineRows = Array.isArray(params.baselineTimeline) ? params.baselineTimeline : [];
    const previewRows = Array.isArray(params.previewTimeline) ? params.previewTimeline : [];
    const selectedHotspotId = Number(params.selectedHotspotId || 0);
    const removedSet = new Set<number>(
      (Array.isArray(params.removedHotspotIds) ? params.removedHotspotIds : [])
        .map((id: any) => Number(id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    const attractionIdsOf = (rows: any[]): number[] => rows
      .filter((row: any) => (
        String(row?.type || '').toLowerCase() === 'attraction'
        || Number(row?.item_type || 0) === 4
      ))
      .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
      .filter((id: number) => (
        Number.isFinite(id)
        && id > 0
        && id !== selectedHotspotId
        && !removedSet.has(id)
      ));

    const baselineAttractionIds = attractionIdsOf(baselineRows);
    const previewAttractionIds = new Set<number>(attractionIdsOf(previewRows));

    return baselineAttractionIds.some((id: number) => !previewAttractionIds.has(id));
  }

  public async pruneManualFitBacktrackingAfterSelectedPivotInTx(
    tx: any,
    params: {
      routeId: number;
      timeline: any[];
      selectedHotspotId: number;
    },
  ): Promise<{ timeline: any[]; removedHotspots: any[] }> {
    const rows = Array.isArray(params.timeline) ? params.timeline : [];
    const selectedHotspotId = Number(params.selectedHotspotId || 0);
    if (rows.length === 0 || selectedHotspotId <= 0) return { timeline: rows, removedHotspots: [] };

    const getHotspotId = (row: any): number =>
      Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0);
    const isAttractionRow = (row: any): boolean =>
      String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
    const isTravelRow = (row: any): boolean =>
      String(row?.type || '').toLowerCase() === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    const getName = (row: any): string =>
      String(row?.text || row?.name || row?.title || row?.hotspot_name || `Hotspot #${getHotspotId(row)}`).trim();

    const routeRow = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: Number(params.routeId), deleted: 0 },
      select: { location_id: true, location_name: true, next_visiting_location: true },
    });

    const routeLocation = Number(routeRow?.location_id || 0) > 0
      ? await (tx as any).dvi_stored_locations.findFirst({
          where: { location_ID: Number(routeRow?.location_id || 0), deleted: 0 },
          select: { source_location: true, destination_location: true },
        })
      : null;

    const routeCityContext = {
      location_name: String(routeRow?.location_name || routeLocation?.source_location || '').trim(),
      next_visiting_location: String(routeRow?.next_visiting_location || routeLocation?.destination_location || '').trim(),
    };
    const sourceCityKey = this.deriveLooseCityKey(routeCityContext.location_name);
    const destinationCityKey = this.deriveLooseCityKey(routeCityContext.next_visiting_location);
    if (!sourceCityKey || !destinationCityKey || sourceCityKey === destinationCityKey) {
      return { timeline: rows, removedHotspots: [] };
    }

    const attractionIds = Array.from(new Set(
      rows
        .filter((row: any) => isAttractionRow(row))
        .map((row: any) => getHotspotId(row))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ));
    if (!attractionIds.includes(selectedHotspotId)) return { timeline: rows, removedHotspots: [] };

    const hotspotMasters = await (tx as any).dvi_hotspot_place.findMany({
      where: { hotspot_ID: { in: attractionIds }, deleted: 0 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_location: true,
        hotspot_to_location: true,
        hotspot_priority: true,
        hotspot_duration: true,
      },
    });
    const masterById = new Map<number, any>(hotspotMasters.map((row: any) => [Number(row?.hotspot_ID || 0), row]));

    const getCityContext = (row: any): ManualHotspotCityContext => {
      const hotspotId = getHotspotId(row);
      const master = masterById.get(hotspotId) || {};
      return this.classifyManualHotspotCityContext(routeCityContext, {
        hotspot_location: master?.hotspot_location || row?.hotspot_location || row?.location || '',
        hotspot_to_location: master?.hotspot_to_location || row?.hotspot_to_location || '',
        hotspot_name: master?.hotspot_name || row?.hotspot_name || row?.name || row?.text || '',
      });
    };

    const selectedRow = rows.find((row: any) => isAttractionRow(row) && getHotspotId(row) === selectedHotspotId);
    if (!selectedRow || getCityContext(selectedRow) !== 'DESTINATION_CITY') {
      return { timeline: rows, removedHotspots: [] };
    }

    const removedIds = new Set<number>();
    const removedHotspots: any[] = [];
    let selectedPivotReached = false;

    const attractionPrunedRows = rows.filter((row: any) => {
      if (!isAttractionRow(row)) return true;
      const hotspotId = getHotspotId(row);
      const cityContext = getCityContext(row);
      const name = getName(row);

      if (hotspotId === selectedHotspotId) {
        selectedPivotReached = true;
 console.log('[FitHere][APJ_PIVOT_DECISION]', {
          routeId: Number(params.routeId),
          hotspotId,
          name,
          cityContext,
          decision: 'KEEP_SELECTED_MANUAL_PIVOT',
          reason: `${name} is the selected manual hotspot and must win.`,
        });
        return true;
      }
      if (selectedPivotReached && cityContext === 'SOURCE_CITY') {
        const master = masterById.get(hotspotId) || {};
        const normalizedPriority = this.normalizeHotspotPriority(Number(master?.hotspot_priority ?? row?.hotspot_priority ?? row?.priority ?? 9999));
        const priority = normalizedPriority >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY || normalizedPriority === 9999 ? 4 : normalizedPriority;
        removedIds.add(hotspotId);
        removedHotspots.push({
          id: hotspotId,
          name,
          priority,
          estimatedMinutes: Number(this.getPreviewRowDurationMinutes(row) || this.getHotspotDurationMinutes(master, row) || 0),
          reason: `${name} removed because it is source-side after destination-side ${getName(selectedRow)} and causes backtracking.`,
          removalReasonCode: 'BACKTRACK_AFTER_DESTINATION_PIVOT',
          requiresAcknowledgement: true,
        });
 console.log('[FitHere][APJ_PIVOT_DECISION]', {
          routeId: Number(params.routeId),
          hotspotId,
          name,
          cityContext,
          decision: 'REMOVE_BACKTRACK_AFTER_DESTINATION_PIVOT',
          reason: `${name} removed because it is source-side after destination-side ${getName(selectedRow)} and causes backtracking.`,
        });
        return false;
      }
 console.log('[FitHere][APJ_PIVOT_DECISION]', {
        routeId: Number(params.routeId),
        hotspotId,
        name,
        cityContext,
        decision: selectedPivotReached ? 'TRY_AFTER_PIVOT' : 'TRY_BEFORE_PIVOT',
        reason: selectedPivotReached
          ? `${name} is allowed after selected destination-side pivot if operating hours pass.`
          : `${name} is before selected manual pivot and can be kept if APJ still fits.`,
      });
      return true;
    });

    if (removedIds.size === 0) return { timeline: rows, removedHotspots: [] };

    const removedNames = removedHotspots.map((row: any) => String(row.name || '').trim().toLowerCase()).filter(Boolean);
    const timeline = attractionPrunedRows
      .filter((row: any) => {
        if (!isTravelRow(row)) return true;
        const fromHotspotId = Number(row?.fromHotspotId || 0);
        const toHotspotId = Number(row?.toHotspotId || 0);
        if (fromHotspotId > 0 && removedIds.has(fromHotspotId)) return false;
        if (toHotspotId > 0 && removedIds.has(toHotspotId)) return false;
        const label = String(row?.text || row?.name || row?.fromName || row?.toName || '').trim().toLowerCase();
        return !removedNames.some((name: string) => name && label.includes(name));
      })
      .map((row: any, index: number) => ({
        ...row,
        previewOrder: index,
        matrixPreviewOrder: index,
      }));

    return { timeline, removedHotspots };
  }

  public rebuildDestinationSidePreviewFromBaseline(params: {
    baselineTimeline: any[];
    manualInsertionFit: any;
    selectedHotspotId: number;
    hotspotMasters: any[];
  }): any[] {
    const baselineRows = Array.isArray(params.baselineTimeline)
      ? params.baselineTimeline
          .map((row: any, index: number) => ({ row: { ...row }, index }))
          .sort((a: any, b: any) => {
            const aStart = this.parseSegmentStartMinutes(a.row);
            const bStart = this.parseSegmentStartMinutes(b.row);

            if (aStart === null && bStart === null) return Number(a.index) - Number(b.index);
            if (aStart === null) return 1;
            if (bStart === null) return -1;
            if (aStart !== bStart) return aStart - bStart;
            return Number(a.index) - Number(b.index);
          })
          .map((entry: any) => entry.row)
      : [];
    const manualInsertionFit = params.manualInsertionFit || null;
    const selectedHotspotId = Number(params.selectedHotspotId || 0);
    const hotspotMasters = Array.isArray(params.hotspotMasters) ? params.hotspotMasters : [];

    if (baselineRows.length === 0 || !manualInsertionFit || selectedHotspotId <= 0) return [];

    const bestSlot = manualInsertionFit?.chosenSlot || manualInsertionFit?.bestSlot || null;
    const fromHotspotId = Number(bestSlot?.fromHotspotId || 0);
    if (!bestSlot || fromHotspotId <= 0) return [];

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
      return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
    };

    const normalizedBaseline = baselineRows.filter((row: any) => {
      const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
      return hotspotId !== selectedHotspotId;
    });

    const fromRowIndex = normalizedBaseline.findIndex((row: any) => (
      isAttractionRow(row)
      && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0) === fromHotspotId
    ));
    if (fromRowIndex < 0) return [];

    const hotelIndex = normalizedBaseline.findIndex((row: any, index: number) => (
      index > fromRowIndex && isHotelLikeRow(row)
    ));
    if (hotelIndex < 0) return [];

    let hotelTravelIndex = -1;
    for (let i = hotelIndex - 1; i > fromRowIndex; i -= 1) {
      if (isTravelRow(normalizedBaseline[i])) {
        hotelTravelIndex = i;
        break;
      }
    }
    const hasExplicitHotelTravelRow = hotelTravelIndex >= 0;

    const fromRow = normalizedBaseline[fromRowIndex];
    const hotelTravelRow = hasExplicitHotelTravelRow
      ? normalizedBaseline[hotelTravelIndex]
      : {
          type: 'travel',
          item_type: 5,
          text: 'Travel to Hotel',
          name: 'Travel to Hotel',
          fromName: String(fromRow?.text || fromRow?.name || bestSlot?.fromName || 'Previous Stop').trim(),
          toName: String(bestSlot?.toName || 'Hotel').trim(),
        };
    const hotelRow = normalizedBaseline[hotelIndex];
    const fromEndMinutes = this.parseSegmentEndMinutes(fromRow);
    if (fromEndMinutes === null) return [];

    const selectedFromMaster = hotspotMasters.find(
      (row: any) => Number(row?.hotspot_ID || row?.id || 0) === selectedHotspotId,
    ) || null;
    const selectedLabel = String(
      selectedFromMaster?.hotspot_name
      || manualInsertionFit?.selectedHotspotName
      || `Hotspot #${selectedHotspotId}`,
    ).trim();
    const selectedDurationMinutes =
      this.getHotspotDurationMinutesFromMasterFirst(selectedFromMaster, selectedFromMaster)
      || this.getPreviewRowDurationFromDurationFieldsOnly(selectedFromMaster)
      || 60;
    const acDurationMin = Math.max(
      1,
      Math.round(
        Number(
          bestSlot?.acDurationMin
          || bestSlot?.routeLegSummary?.acDurationMin
          || 10,
        ),
      ),
    );
    const cbDurationMin = Math.max(
      1,
      Math.round(
        Number(
          bestSlot?.cbDurationMin
          || bestSlot?.routeLegSummary?.cbDurationMin
          || this.getPreviewRowDurationMinutes(hotelTravelRow)
          || 10,
        ),
      ),
    );

    let cursor = fromEndMinutes;
    const acStartMin = cursor;
    const acEndMin = cursor + acDurationMin;
    cursor = acEndMin;

    const selectedStartMin = cursor;
    const selectedEndMin = cursor + selectedDurationMinutes;
    cursor = selectedEndMin;

    const cbStartMin = cursor;
    const cbEndMin = cursor + cbDurationMin;
    cursor = cbEndMin;

    const hotelCheckinText = String(hotelRow?.text || hotelRow?.name || '').trim();
    const hotelCheckinMatch = hotelCheckinText.match(/check-?in\s+at\s+(.+)/i);
    const hotelNameFromCheckin = String(hotelCheckinMatch?.[1] || '').trim();
    const hotelLabel = hotelNameFromCheckin && hotelNameFromCheckin.toLowerCase() !== 'hotel'
      ? hotelNameFromCheckin
      : String(bestSlot?.toName || 'Hotel').trim();

    const prefix = normalizedBaseline
      .slice(0, hasExplicitHotelTravelRow ? hotelTravelIndex : fromRowIndex + 1)
      .map((row: any) => ({ ...row }));
    const suffix = normalizedBaseline.slice(hotelIndex + 1).map((row: any) => ({ ...row }));

    const aToCRow = {
      ...hotelTravelRow,
      type: 'travel',
      item_type: Number(hotelTravelRow?.item_type || 3),
      text: `Travel to ${selectedLabel}`,
      name: `Travel to ${selectedLabel}`,
      fromName: String(fromRow?.text || fromRow?.name || bestSlot?.fromName || 'Previous Stop').trim(),
      toName: selectedLabel,
      from: String(fromRow?.text || fromRow?.name || bestSlot?.fromName || 'Previous Stop').trim(),
      to: selectedLabel,
      displayFromName: String(fromRow?.text || fromRow?.name || bestSlot?.fromName || 'Previous Stop').trim(),
      displayToName: selectedLabel,
      isMatrixSplitTravel: true,
      isMatrixReconnectedTravel: true,
      matrixTravelLeg: 'A_TO_C',
      matrixDistanceKm: bestSlot?.acOsrmDistanceKm != null ? Number(bestSlot.acOsrmDistanceKm) : null,
      distanceKm: bestSlot?.acOsrmDistanceKm != null ? Number(bestSlot.acOsrmDistanceKm) : null,
      travelDistanceKm: bestSlot?.acOsrmDistanceKm != null ? Number(bestSlot.acOsrmDistanceKm) : null,
      matrixDurationMin: acDurationMin,
      duration: `${acDurationMin} Min`,
      timeRange: this.minutesRangeToTimeString(acStartMin, acEndMin),
      locationId: selectedHotspotId,
      hotspot_ID: selectedHotspotId,
      hotspotId: selectedHotspotId,
      hotspot_start_time: null,
      hotspot_end_time: null,
    };

    const selectedRow = {
      ...(selectedFromMaster || {}),
      type: 'attraction',
      item_type: 4,
      locationId: selectedHotspotId,
      hotspot_ID: selectedHotspotId,
      hotspotId: selectedHotspotId,
      text: selectedLabel,
      name: selectedLabel,
      isManual: true,
      isUserSelectedPreview: true,
      isMatrixPositioned: true,
      timeRange: this.minutesRangeToTimeString(selectedStartMin, selectedEndMin),
      isConflict: false,
      conflictReason: null,
      matrixFit: {
        routeFitType: bestSlot?.routeFitType,
        label: bestSlot?.label,
        displayLabel: bestSlot?.displayLabel || bestSlot?.label,
        shortLabel: bestSlot?.shortLabel || bestSlot?.label,
        fromName: bestSlot?.fromName,
        toName: bestSlot?.toName,
        roadDetourKm: bestSlot?.roadDetourKm,
        isZeroExtraDetour: bestSlot?.isZeroExtraDetour === true,
        distanceComparisonNote: bestSlot?.distanceComparisonNote || null,
        roadDetourRatio: bestSlot?.roadDetourRatio,
        routeDecisionReason: bestSlot?.routeDecisionReason || bestSlot?.decisionReason || null,
        finalDecisionReason: bestSlot?.finalDecisionReason || 'Selected: destination-side insertion after destination is reached.',
        routeLegSummary: {
          directDistanceKm: bestSlot?.abOsrmDistanceKm != null ? Number(bestSlot.abOsrmDistanceKm) : null,
          viaDistanceKm: bestSlot?.insertedRouteDistanceKm != null ? Number(bestSlot.insertedRouteDistanceKm) : null,
          extraDistanceKm: bestSlot?.roadDetourKm != null ? Number(bestSlot.roadDetourKm) : null,
          acDistanceKm: bestSlot?.acOsrmDistanceKm != null ? Number(bestSlot.acOsrmDistanceKm) : null,
          cbDistanceKm: bestSlot?.cbOsrmDistanceKm != null ? Number(bestSlot.cbOsrmDistanceKm) : null,
          acDurationMin,
          cbDurationMin,
        },
      },
      hotspot_start_time: null,
      hotspot_end_time: null,
    };

    const cToBRow = {
      ...hotelTravelRow,
      type: 'travel',
      item_type: 5,
      text: `Travel to ${hotelLabel}`,
      name: `Travel to ${hotelLabel}`,
      fromName: selectedLabel,
      toName: hotelLabel,
      from: selectedLabel,
      to: hotelLabel,
      displayFromName: selectedLabel,
      displayToName: hotelLabel,
      isMatrixSplitTravel: true,
      isMatrixReconnectedTravel: true,
      matrixTravelLeg: 'C_TO_B',
      matrixDistanceKm: bestSlot?.cbOsrmDistanceKm != null ? Number(bestSlot.cbOsrmDistanceKm) : null,
      distanceKm: bestSlot?.cbOsrmDistanceKm != null ? Number(bestSlot.cbOsrmDistanceKm) : null,
      travelDistanceKm: bestSlot?.cbOsrmDistanceKm != null ? Number(bestSlot.cbOsrmDistanceKm) : null,
      matrixDurationMin: cbDurationMin,
      duration: `${cbDurationMin} Min`,
      timeRange: this.minutesRangeToTimeString(cbStartMin, cbEndMin),
      locationId: 0,
      hotspot_ID: 0,
      hotspotId: 0,
      hotspot_start_time: null,
      hotspot_end_time: null,
    };

    const rebuilt = [
      ...prefix,
      aToCRow,
      selectedRow,
      cToBRow,
      {
        ...hotelRow,
        timeRange: this.minutesRangeToTimeString(cursor, cursor),
        hotspot_start_time: null,
        hotspot_end_time: null,
        isZeroDurationHotel: true,
      },
      ...suffix,
    ];

    return this.finalizeMatrixPreviewTimeline(rebuilt);
  }

}
