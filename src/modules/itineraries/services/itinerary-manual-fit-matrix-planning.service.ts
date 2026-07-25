// FILE: src/modules/itineraries/services/itinerary-manual-fit-matrix-planning.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { haversineKm } from '../utils/distance-utils';

type ManualFitMatrixPlanningCallbacks = {
  sortTimelineSegmentsForPreview?: (rows: any[]) => any[];
  getPreviewRowDurationMinutes?: (row: any) => number | null;
  minutesRangeToTimeString?: (startMinutes: number, endMinutes: number) => string;
  parseSegmentStartMinutes?: (segment: any) => number | null;
  resolveSourceToHotspotLeg?: (...args: any[]) => Promise<any>;
  chooseReliableTravelDistanceKm?: (...args: any[]) => number | null;
  getCachedRouteMatrixLeg?: (...args: any[]) => Promise<any>;
  estimateDurationFromDistance?: (...args: any[]) => number | null;
  normalizeTravelLabelsToNextStop?: (timeline: any[]) => any[];
};

@Injectable()
export class ItineraryManualFitMatrixPlanningService {
  private callbacks: ManualFitMatrixPlanningCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: ManualFitMatrixPlanningCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private sortTimelineSegmentsForPreview(rows: any[]): any[] {
    if (this.callbacks.sortTimelineSegmentsForPreview) {
      return this.callbacks.sortTimelineSegmentsForPreview(rows);
    }
    return [...(rows || [])];
  }

  private getPreviewRowDurationMinutes(row: any): number | null {
    return this.callbacks.getPreviewRowDurationMinutes?.(row) ?? null;
  }

  private minutesRangeToTimeString(startMinutes: number, endMinutes: number): string {
    if (this.callbacks.minutesRangeToTimeString) {
      return this.callbacks.minutesRangeToTimeString(startMinutes, endMinutes);
    }
    const format = (minutes: number): string => {
      const rounded = Math.round(minutes);
      const hours = Math.floor(rounded / 60) % 24;
      const remainder = rounded % 60;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = hours % 12 === 0 ? 12 : hours % 12;
      return `${String(displayHours).padStart(1, '0')}:${String(remainder).padStart(2, '0')} ${ampm}`;
    };
    return `${format(startMinutes)} - ${format(endMinutes)}`;
  }

  private parseSegmentStartMinutes(segment: any): number | null {
    if (this.callbacks.parseSegmentStartMinutes) {
      return this.callbacks.parseSegmentStartMinutes(segment);
    }
    const raw = String(segment?.timeRange || '').split('-')[0]?.trim() || '';
    const match = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!match) return null;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = String(match[3] || '').toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  private async resolveSourceToHotspotLeg(...args: any[]): Promise<any> {
    if (this.callbacks.resolveSourceToHotspotLeg) {
      return this.callbacks.resolveSourceToHotspotLeg(...args);
    }
    return { distanceKm: null, durationMin: null, osrmUsed: false, sourceName: null };
  }

  private chooseReliableTravelDistanceKm(...args: any[]): number | null {
    if (this.callbacks.chooseReliableTravelDistanceKm) {
      return this.callbacks.chooseReliableTravelDistanceKm(...args);
    }
    const preferred = Number(args[0]);
    const fallback = Number(args[1]);
    if (Number.isFinite(preferred) && preferred > 0) return preferred;
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
    return null;
  }

  private async getCachedRouteMatrixLeg(...args: any[]): Promise<any> {
    if (this.callbacks.getCachedRouteMatrixLeg) {
      return this.callbacks.getCachedRouteMatrixLeg(...args);
    }
    return { distanceKm: null, durationMin: null };
  }

  private estimateDurationFromDistance(distanceKm: number | null): number | null {
    if (this.callbacks.estimateDurationFromDistance) {
      return this.callbacks.estimateDurationFromDistance(distanceKm);
    }
    if (distanceKm == null || !Number.isFinite(Number(distanceKm)) || Number(distanceKm) <= 0) return null;
    return Math.max(5, Math.round((Number(distanceKm) / 25) * 60));
  }

  private normalizeTravelLabelsToNextStop(timeline: any[]): any[] {
    return this.callbacks.normalizeTravelLabelsToNextStop?.(timeline) ?? timeline;
  }

  async inferDetourOptimizedAnchorIndex(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotId: number,
  ): Promise<number | undefined> {
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
        hotspot_order: true,
      },
      orderBy: [
        { hotspot_order: 'asc' },
      ],
    });

    const visits = (rows || [])
      .map((r: any) => ({
        hotspotId: Number(r?.hotspot_ID || 0),
        order: Number(r?.hotspot_order || 0),
      }))
      .filter((r: any) => r.hotspotId > 0 && r.order > 0)
      .sort((a: any, b: any) => a.order - b.order);

    if (visits.length < 2) return undefined;

    const hotspotIds = Array.from(
      new Set([
        Number(manualHotspotId),
        ...visits.map((v: any) => Number(v.hotspotId)),
      ]),
    ).filter((id) => Number.isFinite(id) && id > 0);

    const masters = hotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_latitude: true,
            hotspot_longitude: true,
          },
        })
      : [];

    const coordsById = new Map<number, { lat: number; lng: number }>();
    for (const row of masters || []) {
      const id = Number((row as any)?.hotspot_ID || 0);
      const lat = Number((row as any)?.hotspot_latitude);
      const lng = Number((row as any)?.hotspot_longitude);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      coordsById.set(id, { lat, lng });
    }

    const c = coordsById.get(Number(manualHotspotId));
    if (!c) return undefined;

    let best: { extraKm: number; anchorIndex: number } | null = null;

    for (let i = 0; i < visits.length - 1; i += 1) {
      const a = visits[i];
      const b = visits[i + 1];
      const ca = coordsById.get(Number(a.hotspotId));
      const cb = coordsById.get(Number(b.hotspotId));
      if (!ca || !cb) continue;

      const direct = haversineKm(ca.lat, ca.lng, cb.lat, cb.lng);
      const aToC = haversineKm(ca.lat, ca.lng, c.lat, c.lng);
      const cToB = haversineKm(c.lat, c.lng, cb.lat, cb.lng);
      const extraKm = Number((aToC + cToB - direct).toFixed(3));

      const candidate = {
        extraKm,
 // anchorIndex uses "after_travel" semantics where preferred order = anchorIndex + 1
 // so for A(order=n) -> C -> B(order=n+1), anchorIndex should be n.
        anchorIndex: Number(a.order),
      };

      if (!best || candidate.extraKm < best.extraKm) {
        best = candidate;
      }
    }

    return best ? best.anchorIndex : undefined;
  }

  async resolveMatrixBestInsertionGap(params: {
    routeId: number;
    selectedHotspotId: number;
    manualInsertionFit: any;
  }): Promise<{
    shouldUseMatrixSlot: boolean;
    fromHotspotId: number;
    toHotspotId: number;
    gapIndex: number;
    reason: string;
  }> {
    const routeId = Number(params?.routeId || 0);
    const selectedHotspotId = Number(params?.selectedHotspotId || 0);
    const bestSlot = params?.manualInsertionFit?.bestSlot || params?.manualInsertionFit?.chosenSlot || null;
    const routeFitType = String(bestSlot?.routeFitType || '').toUpperCase();

    if (!routeId || !selectedHotspotId || !bestSlot) {
      return {
        shouldUseMatrixSlot: false,
        fromHotspotId: 0,
        toHotspotId: 0,
        gapIndex: -1,
        reason: 'MISSING_MATRIX_FIT_OR_INPUT',
      };
    }

    if (routeFitType !== 'ON_ROUTE' && routeFitType !== 'MINOR_DETOUR') {
      return {
        shouldUseMatrixSlot: false,
        fromHotspotId: Number(bestSlot?.fromHotspotId || 0),
        toHotspotId: Number(bestSlot?.toHotspotId || 0),
        gapIndex: -1,
        reason: 'MATRIX_SLOT_NOT_ROUTE_FEASIBLE',
      };
    }

    const fromHotspotId = Number(bestSlot?.fromHotspotId || 0);
    const toHotspotId = Number(bestSlot?.toHotspotId || 0);
    if (!fromHotspotId || !toHotspotId) {
      if (
        params?.manualInsertionFit?.destinationInsertionMode === true
        && String(bestSlot?.source || '') === 'DESTINATION_HOTEL_SIDE'
        && Number(params?.manualInsertionFit?.destinationAnchorOrder || 0) > 0
      ) {
        return {
          shouldUseMatrixSlot: true,
          fromHotspotId,
          toHotspotId,
          gapIndex: Number(params?.manualInsertionFit?.destinationAnchorOrder),
          reason: 'DESTINATION_HOTEL_SIDE_SLOT_RESOLVED',
        };
      }

      return {
        shouldUseMatrixSlot: false,
        fromHotspotId,
        toHotspotId,
        gapIndex: -1,
        reason: 'MATRIX_SLOT_BOUNDARIES_MISSING',
      };
    }

    if (
      fromHotspotId === selectedHotspotId
      || toHotspotId === selectedHotspotId
      || fromHotspotId === toHotspotId
    ) {
      return {
        shouldUseMatrixSlot: false,
        fromHotspotId,
        toHotspotId,
        gapIndex: -1,
        reason: 'MATRIX_SLOT_ENDPOINTS_INVALID_FOR_SELECTED_HOTSPOT',
      };
    }

    const rows = await this.prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_ID: true,
        hotspot_order: true,
      },
      orderBy: {
        hotspot_order: 'asc',
      },
    });

    const attractions = (rows || [])
      .map((r: any) => ({
        hotspotId: Number(r?.hotspot_ID || 0),
        order: Number(r?.hotspot_order || 0),
      }))
      .filter((r: any) => r.hotspotId > 0 && r.order > 0 && r.hotspotId !== selectedHotspotId)
      .sort((a: any, b: any) => a.order - b.order);

    if (attractions.length < 2) {
      return {
        shouldUseMatrixSlot: false,
        fromHotspotId,
        toHotspotId,
        gapIndex: -1,
        reason: 'ROUTE_HAS_INSUFFICIENT_ACTIVE_ATTRACTIONS',
      };
    }

    for (let i = 0; i < attractions.length - 1; i += 1) {
      const left = attractions[i];
      const right = attractions[i + 1];
      if (left.hotspotId === fromHotspotId && right.hotspotId === toHotspotId) {
        return {
          shouldUseMatrixSlot: true,
          fromHotspotId,
          toHotspotId,
          gapIndex: Number(left.order),
          reason: 'MATRIX_BEST_SLOT_RESOLVED',
        };
      }
    }

    return {
      shouldUseMatrixSlot: false,
      fromHotspotId,
      toHotspotId,
      gapIndex: -1,
      reason: 'MATRIX_BOUNDARY_PAIR_NOT_FOUND_IN_ACTIVE_ROUTE_SEQUENCE',
    };
  }

  async buildMatrixRouteTimelineAfterLowPriorityRemoval(
    tx: any,
    timeline: any[],
    removedHotspotIds: number[],
    options?: {
      routeId?: number;
    },
  ): Promise<any[]> {
    const ordered = this.sortTimelineSegmentsForPreview(Array.isArray(timeline) ? timeline : []);
    const removedSet = new Set<number>(removedHotspotIds.map((id: any) => Number(id)).filter((id: number) => id > 0));

 // Detailed logging to track hotspot 220
 console.log('[buildMatrixRouteTimelineAfterLowPriorityRemoval] START', {
      inputRemovedHotspotIds: removedHotspotIds,
      removedSetContents: Array.from(removedSet),
      orderedTimelineLength: ordered.length,
      contains220: Array.from(removedSet).includes(220),
    });

    if (ordered.length === 0 || removedSet.size === 0) {
 console.log('[buildMatrixRouteTimelineAfterLowPriorityRemoval] Early return - empty timeline or no removals');
      return ordered;
    }

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
      return type === 'hotel' || type === 'checkin' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel') || text.includes('check-in at ');
    };
    const isTravelToHotelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return (type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5)
        && text.includes('travel to hotel');
    };
    const scheduleRowAtCursor = (row: any, cursorMinutes: number, forcedDuration?: number | null) => {
      const type = String(row?.type || '').toLowerCase();
      const fallbackDuration = type === 'hotel' ? 0 : (type === 'travel' ? 10 : 60);
      const duration = Math.max(
        0,
        Number(
          forcedDuration
          ?? this.getPreviewRowDurationMinutes(row)
          ?? row?.matrixDurationMin
          ?? fallbackDuration,
        ),
      );
      const startMin = cursorMinutes;
      const endMin = startMin + duration;
      return {
        cursor: endMin,
        row: {
          ...row,
          timeRange: this.minutesRangeToTimeString(startMin, endMin),
          hotspot_start_time: null,
          hotspot_end_time: null,
        },
      };
    };

 // Helper: Check if a row matches a removed hotspot ID
    const containsRemovedHotspotId = (row: any): boolean => {
      const rowId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
      if (rowId > 0 && removedSet.has(rowId)) return true;
      const toHotspotId = Number(row?.toHotspotId || 0);
      if (toHotspotId > 0 && removedSet.has(toHotspotId)) return true;
      const fromHotspotId = Number(row?.fromHotspotId || 0);
      if (fromHotspotId > 0 && removedSet.has(fromHotspotId)) return true;
      return false;
    };

    const removedNameSet = new Set<string>();
    for (const row of ordered) {
      if (!isAttractionRow(row)) continue;
      const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
      if (!removedSet.has(hid)) continue;
      const name = String(row?.text || row?.name || '').trim().toLowerCase();
      if (name) removedNameSet.add(name);
    }

    const attractionRows = ordered.filter((row: any) => isAttractionRow(row));
    const keptAttractions = attractionRows.filter((row: any) => {
      const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
      return hid > 0 && !removedSet.has(hid);
    });

 // Log attractions analysis
 console.log('[buildMatrixRouteTimelineAfterLowPriorityRemoval] ATTRACTIONS ANALYSIS', {
      totalAttractionRows: attractionRows.length,
      keptAttractionsCount: keptAttractions.length,
      keptIds: keptAttractions.map((r: any) => Number(r?.locationId || r?.hotspot_ID || r?.hotspotId || 0)),
      allAttractionIds: attractionRows.map((r: any) => ({
        id: Number(r?.locationId || r?.hotspot_ID || r?.hotspotId || 0),
        text: r?.text,
        isRemoved: removedSet.has(Number(r?.locationId || r?.hotspot_ID || r?.hotspotId || 0)),
      })),
    });

    if (keptAttractions.length === 0) {
 console.log('[buildMatrixRouteTimelineAfterLowPriorityRemoval] Early return - no kept attractions');
      return ordered;
    }


    const firstKeptAttraction = keptAttractions[0];
    const firstKeptIndex = ordered.findIndex((row: any) => row === firstKeptAttraction);
    const prefixRows = ordered
      .slice(0, Math.max(0, firstKeptIndex))
      .filter((row: any) => !isHotelLikeRow(row) && !isTravelToHotelRow(row))
      .filter((row: any) => {
 // Only remove if this row IS a removed hotspot (for attractions)
 // or if this travel row points TO a removed hotspot
        const isAttractionRow = () => {
          const type = String(row?.type || '').toLowerCase();
          return type === 'attraction' || Number(row?.item_type || 0) === 4;
        };
        const isTravelRow = () => {
          const type = String(row?.type || '').toLowerCase();
          return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
        };

        if (isAttractionRow()) {
          const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
          if (hid > 0 && removedSet.has(hid)) return false;
        }

        if (isTravelRow()) {
          const toHotspotId = Number(row?.toHotspotId || 0);
          if (toHotspotId > 0 && removedSet.has(toHotspotId)) return false;
        }

        return true;
      });

    const hotelTravelTemplate = [...ordered].reverse().find((row: any) => isTravelToHotelRow(row)) || null;
    const hotelRows = ordered.filter((row: any) => isHotelLikeRow(row)).map((row: any) => ({ ...row }));

    const rebuilt: any[] = [];
    let cursor = this.parseSegmentStartMinutes(ordered[0]) ?? 8 * 60;

    for (const row of prefixRows) {
      const scheduled = scheduleRowAtCursor(row, cursor);
      cursor = scheduled.cursor;
      rebuilt.push(scheduled.row);
    }

    const firstKeptHotspotId = Number(
      firstKeptAttraction?.locationId
      || firstKeptAttraction?.hotspot_ID
      || firstKeptAttraction?.hotspotId
      || 0,
    );
    const fallbackInitialTravel = ordered.find((row: any) => {
      if (!isTravelRow(row) || isTravelToHotelRow(row)) return false;
      const toHotspotId = Number(row?.toHotspotId || 0);
      const toName = String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();
      const targetName = String(firstKeptAttraction?.text || firstKeptAttraction?.name || '').trim().toLowerCase();
      return (
        (firstKeptHotspotId > 0 && toHotspotId === firstKeptHotspotId)
        || (!!targetName && toName.includes(targetName))
      );
    }) || ordered.find((row: any, index: number) => (
      index < firstKeptIndex
      && isTravelRow(row)
      && !isTravelToHotelRow(row)
    )) || null;
    if (Number(options?.routeId || 0) > 0 && firstKeptHotspotId > 0) {
      const sourceLeg = await this.resolveSourceToHotspotLeg(tx, Number(options?.routeId || 0), firstKeptHotspotId);
      const initialDistanceKm = this.chooseReliableTravelDistanceKm(
        sourceLeg.distanceKm != null ? Number(sourceLeg.distanceKm) : null,
        fallbackInitialTravel?.matrixDistanceKm != null
          ? Number(fallbackInitialTravel.matrixDistanceKm)
          : (fallbackInitialTravel?.distanceKm != null ? Number(fallbackInitialTravel.distanceKm) : null),
      );
      const initialTravelDuration = Math.max(
        1,
        Math.round(
          Number(
            fallbackInitialTravel?.matrixDurationMin
            ?? this.getPreviewRowDurationMinutes(fallbackInitialTravel)
            ?? sourceLeg.durationMin
            ?? 10,
          ),
        ),
      );
      if (initialTravelDuration > 0) {
        const toLabel = String(firstKeptAttraction?.text || firstKeptAttraction?.name || `Hotspot #${firstKeptHotspotId}`).trim();
        const fromLabel = String(
          sourceLeg.sourceName
          || fallbackInitialTravel?.fromName
          || fallbackInitialTravel?.from
          || 'Route Start',
        ).trim();
        const scheduledInitialTravel = scheduleRowAtCursor(
          {
            ...(fallbackInitialTravel || {}),
            type: 'travel',
            item_type: Number(fallbackInitialTravel?.item_type || 3),
            text: `Travel to ${toLabel}`,
            name: `Travel to ${toLabel}`,
            fromName: fromLabel,
            toName: toLabel,
            from: fromLabel,
            to: toLabel,
            displayFromName: fromLabel,
            displayToName: toLabel,
            matrixDistanceKm: initialDistanceKm,
            distanceKm: initialDistanceKm,
            travelDistanceKm: initialDistanceKm,
            matrixDurationMin: initialTravelDuration,
            duration: `${initialTravelDuration} min`,
            distance:
              initialDistanceKm != null ? `${Number(initialDistanceKm).toFixed(1)} km` : (fallbackInitialTravel?.distance || null),
            isMatrixReconnectedTravel: true,
            id: undefined,
            locationId: undefined,
            hotspot_ID: undefined,
            hotspotId: undefined,
            hotspot_id: undefined,
            fromHotspotId: undefined,
            toHotspotId: firstKeptHotspotId,
            isEstimatedTravel:
              fallbackInitialTravel?.matrixDurationMin == null
              && this.getPreviewRowDurationMinutes(fallbackInitialTravel) == null
              && sourceLeg.durationMin == null,
          },
          cursor,
          initialTravelDuration,
        );
        cursor = scheduledInitialTravel.cursor;
        rebuilt.push(scheduledInitialTravel.row);
      }
    }

    const firstAttractionScheduled = scheduleRowAtCursor(firstKeptAttraction, cursor);
    cursor = firstAttractionScheduled.cursor;
    rebuilt.push(firstAttractionScheduled.row);

    for (let idx = 1; idx < keptAttractions.length; idx += 1) {
      const fromAttraction = keptAttractions[idx - 1];
      const toAttraction = keptAttractions[idx];

      const fromId = Number(fromAttraction?.locationId || fromAttraction?.hotspot_ID || fromAttraction?.hotspotId || 0);
      const toId = Number(toAttraction?.locationId || toAttraction?.hotspot_ID || toAttraction?.hotspotId || 0);
      const leg = await this.getCachedRouteMatrixLeg(tx, fromId, toId);

      const fallbackRow = ordered.find((row: any) => {
        if (!isTravelRow(row) || isTravelToHotelRow(row)) return false;
        const toName = String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();
        const targetName = String(toAttraction?.text || toAttraction?.name || '').trim().toLowerCase();
        return !!toName && !!targetName && toName.includes(targetName);
      }) || null;

      const estimatedDuration = Number(
        fallbackRow?.matrixDurationMin
        || this.getPreviewRowDurationMinutes(fallbackRow)
        || this.estimateDurationFromDistance(leg.distanceKm)
        || 10,
      );
      const durationMin = leg.durationMin != null
        ? Math.max(1, Math.round(Number(leg.durationMin)))
        : Math.max(1, Math.round(Number(estimatedDuration || 10)));
      const distanceKm = this.chooseReliableTravelDistanceKm(
        leg.distanceKm != null ? Number(leg.distanceKm) : null,
        fallbackRow?.matrixDistanceKm != null
          ? Number(fallbackRow.matrixDistanceKm)
          : (fallbackRow?.distanceKm != null ? Number(fallbackRow.distanceKm) : null),
      );
      const fromLabel = String(fromAttraction?.text || fromAttraction?.name || `Hotspot #${fromId}`).trim();
      const toLabel = String(toAttraction?.text || toAttraction?.name || `Hotspot #${toId}`).trim();

      if (leg.durationMin == null) {
 console.warn(`Cached matrix missing for ${fromLabel} -> ${toLabel}; estimated duration used.`);
      }

      const reconnectTravelRow = {
        ...(fallbackRow || {}),
        type: 'travel',
        item_type: Number(fallbackRow?.item_type || 3),
        text: `Travel to ${toLabel}`,
        name: `Travel to ${toLabel}`,
        fromName: fromLabel,
        toName: toLabel,
        from: fromLabel,
        to: toLabel,
        displayFromName: fromLabel,
        displayToName: toLabel,
        matrixDistanceKm: distanceKm,
        distanceKm: distanceKm,
        travelDistanceKm: distanceKm,
        matrixDurationMin: durationMin,
        duration: `${durationMin} min`,
        distance: distanceKm != null ? `${Number(distanceKm).toFixed(1)} km` : (fallbackRow?.distance || null),
        isMatrixReconnectedTravel: true,
 // CRITICAL: Clear hotspot ID fields from fallbackRow to ensure this travel row doesn't get filtered as removed hotspot
        id: undefined,
        locationId: undefined,
        hotspot_ID: undefined,
        hotspotId: undefined,
        hotspot_id: undefined,
 toHotspotId: toId, // Set toHotspotId to the destination hotspot
 fromHotspotId: fromId, // Set fromHotspotId to the source hotspot
        isEstimatedTravel: leg.durationMin == null,
      };

      const scheduledTravel = scheduleRowAtCursor(reconnectTravelRow, cursor, durationMin);
      cursor = scheduledTravel.cursor;
      rebuilt.push(scheduledTravel.row);

      const scheduledAttraction = scheduleRowAtCursor(toAttraction, cursor);
      cursor = scheduledAttraction.cursor;
      rebuilt.push(scheduledAttraction.row);
    }

    const hotelTravelDuration = Math.max(
      1,
      Math.round(
        Number(
          hotelTravelTemplate?.matrixDurationMin
          || this.getPreviewRowDurationMinutes(hotelTravelTemplate)
          || 10,
        ),
      ),
    );
    if (hotelTravelTemplate) {
      const lastAttractionLabel = String(
        keptAttractions[keptAttractions.length - 1]?.text
        || keptAttractions[keptAttractions.length - 1]?.name
        || 'Previous Stop',
      ).trim();
      const hotelCheckinText = String(hotelRows[0]?.text || hotelRows[0]?.name || '').trim();
      const hotelCheckinMatch = hotelCheckinText.match(/check-?in\s+at\s+(.+)/i);
      const hotelNameFromCheckin = String(hotelCheckinMatch?.[1] || '').trim();
      const hotelLabel = hotelNameFromCheckin && hotelNameFromCheckin.toLowerCase() !== 'hotel'
        ? hotelNameFromCheckin
        : 'Hotel';
      const scheduledHotelTravel = scheduleRowAtCursor(
        {
          ...hotelTravelTemplate,
          item_type: 5,
          text: `Travel to ${hotelLabel}`,
          name: `Travel to ${hotelLabel}`,
          fromName: lastAttractionLabel,
          toName: hotelLabel,
          from: lastAttractionLabel,
          to: hotelLabel,
          displayFromName: lastAttractionLabel,
          displayToName: hotelLabel,
          isMatrixReconnectedTravel: true,
          matrixDurationMin: hotelTravelDuration,
          duration: `${hotelTravelDuration} min`,
 // CRITICAL: Clear hotspot ID fields to prevent false matching with removed hotspots
          id: undefined,
          locationId: undefined,
          hotspot_ID: undefined,
          hotspotId: undefined,
          hotspot_id: undefined,
          toHotspotId: undefined,
          fromHotspotId: undefined,
        },
        cursor,
        hotelTravelDuration,
      );
      cursor = scheduledHotelTravel.cursor;
      rebuilt.push(scheduledHotelTravel.row);
    }

    for (const hotelRow of hotelRows) {
      rebuilt.push({
        ...hotelRow,
        timeRange: this.minutesRangeToTimeString(cursor, cursor),
        hotspot_start_time: null,
        hotspot_end_time: null,
        isZeroDurationHotel: true,
      });
    }

    const normalizedRebuilt = this.normalizeTravelLabelsToNextStop(rebuilt);

 // Final sanitization: remove only rows that ARE removed hotspots or point TO removed hotspots
    const sanitized = normalizedRebuilt.filter((row: any) => {
      const isAttractionRow = () => {
        const type = String(row?.type || '').toLowerCase();
        return type === 'attraction' || Number(row?.item_type || 0) === 4;
      };
      const isTravelRow = () => {
        const type = String(row?.type || '').toLowerCase();
        return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
      };

 // Remove if this attraction IS a removed hotspot
      if (isAttractionRow()) {
        const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
        return hid <= 0 || !removedSet.has(hid);
      }

 // Remove if this travel row points TO a removed hotspot
      if (isTravelRow()) {
        const toHotspotId = Number(row?.toHotspotId || 0);
        if (toHotspotId > 0 && removedSet.has(toHotspotId)) return false;
      }

      return true;
    });

 // Log final timeline before returning
    const finalAttractionIds = sanitized
      .filter((row: any) => {
        const type = String(row?.type || '').toLowerCase();
        return type === 'attraction' || Number(row?.item_type || 0) === 4;
      })
      .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
      .filter((id: number) => id > 0);

 console.log('[buildMatrixRouteTimelineAfterLowPriorityRemoval] BEFORE RETURN', {
      sanitizedLength: sanitized.length,
      finalAttractionIds,
      still_contains_220: finalAttractionIds.includes(220),
      removedSet: Array.from(removedSet),
    });

    if (finalAttractionIds.includes(220)) {
 console.error('[buildMatrixRouteTimelineAfterLowPriorityRemoval] CRITICAL: Hotspot 220 still in sanitized result!');
 console.error('Sanitized rows containing 220:');
      for (const row of sanitized) {
        const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
        if (hid === 220) {
 console.error(` Row type=${row?.type} id=${hid} text="${row?.text}" name="${row?.name}"`);
        }
      }
    }

    return sanitized.map((row: any, index: number) => ({
      ...row,
      previewOrder: index,
      matrixPreviewOrder: index,
    }));
  }

}
