import { Injectable } from '@nestjs/common';

type TimelinePolicyCallbacks = {
  parseSegmentEndMinutes?: (segment: any) => number | null;
};

@Injectable()
export class ItineraryManualFitTimelinePolicyService {
  private parseSegmentEndMinutesCallback: (segment: any) => number | null = () => null;

  setCallbacks(callbacks: TimelinePolicyCallbacks): void {
    this.parseSegmentEndMinutesCallback = callbacks.parseSegmentEndMinutes || (() => null);
  }

  private parseSegmentEndMinutes(segment: any): number | null {
    return this.parseSegmentEndMinutesCallback(segment);
  }


  public validateResolvedLowPriorityTimeline(
    timeline: any[],
    plannedRemovals: Array<any>,
    dayEndMinutes: number,
  ): string | null {
    const rows = Array.isArray(timeline) ? timeline : [];
    const removals = Array.isArray(plannedRemovals) ? plannedRemovals : [];
    if (rows.length === 0) return 'Resolved timeline is empty.';

    const removedIds = new Set<number>(
      removals
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const removedNames = new Set<string>(
      removals
        .map((row: any) => String(row?.name || row?.hotspotName || '').trim().toLowerCase())
        .filter(Boolean),
    );

    const isAttractionRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isTravelRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };
    const isHotelRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || type === 'checkin' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel') || text.includes('check-in at ');
    };

 // Debug: Log what we're checking
    const timelineHotspotIds = rows
      .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
      .filter((id: number) => id > 0);
    const planDuplicates = timelineHotspotIds.filter((id: number) => removedIds.has(id));

    if (planDuplicates.length > 0) {
 console.error('[validateResolvedLowPriorityTimeline] FAIL: Removed hotspot IDs still in timeline:', {
        removedIds: Array.from(removedIds),
        duplicateIds: planDuplicates,
        timelineHotspotIds,
        timelineLength: rows.length,
      });
 console.error('[validateResolvedLowPriorityTimeline] Matching rows:');
      for (const row of rows) {
        const rowId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
        if (rowId > 0 && removedIds.has(rowId)) {
 console.error(` - Row type=${row?.type} id=${rowId} text="${row?.text}" toName="${row?.toName}"`);
        }
      }
    }

    for (const row of rows) {
      const rowId = Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || 0);
      const rowText = String(row?.text || row?.name || row?.toName || row?.to || '').trim().toLowerCase();
      if (rowId > 0 && removedIds.has(rowId)) return `Resolved timeline still contains removed hotspot id ${rowId}.`;
      for (const removedName of removedNames) {
        if (removedName && rowText.includes(removedName)) {
          return `Resolved timeline still contains removed hotspot name ${removedName}.`;
        }
      }
      if (isTravelRow(row)) {
        const toName = String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();
        for (const removedName of removedNames) {
          if (removedName && toName.includes(removedName)) {
            return `Travel row still points to removed hotspot ${removedName}.`;
          }
        }
      }
    }

    const attractionIndices = rows
      .map((row: any, index: number) => ({ row, index }))
      .filter((entry: any) => isAttractionRow(entry.row));

    for (let i = 1; i < attractionIndices.length; i += 1) {
      const attractionIndex = attractionIndices[i].index;
      const prevRow = rows[attractionIndex - 1];
      if (!prevRow || !isTravelRow(prevRow)) {
        return `Attraction at index ${attractionIndex} is not preceded by a travel row.`;
      }
    }

    const sourceRows = Array.isArray(rows) ? rows : [];
    const sourceHasHotelRow = sourceRows.some((row: any) => isHotelRow(row));
    const hotelIndex = rows.findIndex((row: any) => isHotelRow(row));

    if (sourceHasHotelRow && hotelIndex < 0) {
      return 'Resolved timeline has no hotel/check-in row.';
    }

    if (hotelIndex >= 0) {
      const hasRowsAfterHotel = rows.slice(hotelIndex + 1).some((row: any) => {
        const type = String(row?.type || '').toLowerCase();
        return type !== '';
      });
      if (hasRowsAfterHotel) return 'Hotel/check-in row is not last in resolved timeline.';
    }

    const finalEnd = rows.reduce((max: number, row: any) => {
      const end = this.parseSegmentEndMinutes(row);
      return end == null ? max : Math.max(max, end);
    }, 0);
    if (finalEnd > dayEndMinutes) {
      return `Resolved timeline still exceeds day end by ${finalEnd - dayEndMinutes} minutes.`;
    }

    const orderSequential = rows.every((row: any, index: number) => Number(row?.matrixPreviewOrder ?? row?.previewOrder) === index);
    if (!orderSequential) return 'matrixPreviewOrder/previewOrder is not sequential.';

    return null;
  }

  public minutesToTimeRange(startMinutes: number, endMinutes: number): string {
    const toDisplay = (minutes: number): string => {
      const total = Math.max(0, Math.floor(Number(minutes || 0)));
      const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
      const mm = String(total % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    };

    return `${toDisplay(startMinutes)} - ${toDisplay(endMinutes)}`;
  }

  public sanitizeResolvedLowPriorityTimeline(
    timeline: any[],
    plannedRemovals: Array<any>,
  ): any[] {
    const source = Array.isArray(timeline) ? timeline : [];
    const removals = Array.isArray(plannedRemovals) ? plannedRemovals : [];

    const removedIds = new Set<number>(
      removals
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const removedNames = new Set<string>(
      removals
        .map((row: any) => String(row?.name || row?.hotspotName || '').trim().toLowerCase())
        .filter(Boolean),
    );

    return source
      .filter((row: any) => {
        const rowId = Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || 0);
        const rowText = String(row?.text || row?.name || row?.toName || row?.to || '').trim().toLowerCase();

        if (rowId > 0 && removedIds.has(rowId)) return false;

        for (const removedName of removedNames) {
          if (removedName && rowText.includes(removedName)) return false;
        }

        return true;
      })
      .map((row: any, idx: number) => ({
        ...row,
        previewOrder: idx,
        matrixPreviewOrder: idx,
      }));
  }

  public pruneRemovedHotspotsFromManualPreviewTimeline(
    timeline: any[],
    removedHotspots: any[],
  ): any[] {
    if (!Array.isArray(timeline) || timeline.length === 0) return [];

    const removedRows = Array.isArray(removedHotspots) ? removedHotspots : [];
    const removedIds = new Set(
      removedRows
        .map((row: any) => Number(row?.id ?? row?.hotspotId ?? row?.hotspot_ID ?? 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    if (removedIds.size === 0 && removedRows.length === 0) return timeline;

    return timeline.filter((row: any) => {
      const rowHotspotId = Number(
        row?.hotspotId
        ?? row?.hotspot_ID
        ?? row?.locationId
        ?? 0,
      );

      if (removedIds.has(rowHotspotId)) {
        return false;
      }

      const toHotspotId = Number(
        row?.toHotspotId
        ?? row?.to_location_id
        ?? 0,
      );

      if (removedIds.has(toHotspotId)) {
        return false;
      }

      const toName = String(row?.toName || row?.to || row?.displayToName || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();

      return !removedRows.some((removed: any) => {
        const removedName = String(removed?.name || '').toLowerCase().trim();
        if (!removedName) return false;

        return (
          toName.includes(removedName)
          || text.includes(`travel to ${removedName}`)
          || text === removedName
        );
      });
    });
  }

  public isRetryableManualPreviewTransactionError(error: any): boolean {
    const code = String(error?.code || '').trim().toUpperCase();
    const message = String(error?.message || '').toLowerCase();

    return (
      code === 'P2034'
      || message.includes('write conflict')
      || message.includes('deadlock')
    );
  }

  public normalizeExactAnchorManualInsertionFit(params: {
    manualInsertionFit: any;
    anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
    afterHotspotId?: number | null;
    beforeHotspotId?: number | null;
    anchorLabel?: string | null;
  }): any {
    const fit = params.manualInsertionFit || {};
    const requestedSlot = fit.requestedSlot || {};

    const exactSlot = {
      ...requestedSlot,
      fromHotspotId: Number(params.afterHotspotId || 0) || null,
      toHotspotId: Number(params.beforeHotspotId || 0) || null,
      source: 'EXACT_ANCHOR',
      chosenSlotSource: 'EXACT_ANCHOR',
      selectedAsBest: true,
      attempted: true,
      exactAnchor: true,
      anchorIntent: params.anchorIntent || null,
      label: params.anchorLabel || requestedSlot.label || 'Selected Fit Here position',
      displayLabel: params.anchorLabel || requestedSlot.displayLabel || 'Selected Fit Here position',
      shortLabel: params.anchorLabel || requestedSlot.shortLabel || 'Selected Fit Here position',
    };

    return {
      ...fit,
      requestedSlot: exactSlot,
      chosenSlot: exactSlot,
      bestSlot: exactSlot,
      chosenSlotSource: 'EXACT_ANCHOR',
    };
  }

  public timelineContainsPlannedRemovalRows(
    timeline: any[],
    plannedRemovals: Array<any>,
  ): boolean {
    const source = Array.isArray(timeline) ? timeline : [];
    const removals = Array.isArray(plannedRemovals) ? plannedRemovals : [];
    if (source.length === 0 || removals.length === 0) return false;

    const removedIds = new Set<number>(
      removals
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const removedNames = new Set<string>(
      removals
        .map((row: any) => String(row?.name || row?.hotspotName || '').trim().toLowerCase())
        .filter(Boolean),
    );

    return source.some((row: any) => {
      const rowId = Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || 0);
      const rowText = String(row?.text || row?.name || row?.toName || row?.to || '').trim().toLowerCase();
      if (rowId > 0 && removedIds.has(rowId)) return true;
      for (const removedName of removedNames) {
        if (removedName && rowText.includes(removedName)) return true;
      }
      return false;
    });
  }
}
