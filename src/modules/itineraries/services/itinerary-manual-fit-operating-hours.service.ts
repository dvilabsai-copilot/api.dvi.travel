import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type ManualFitOperatingHoursCallbacks = {
  formatTime?: (...args: any[]) => string;
  parsePreviewTimeToMinutes?: (...args: any[]) => number | null;
};

@Injectable()
export class ItineraryManualFitOperatingHoursService {
  private callbacks: ManualFitOperatingHoursCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: ManualFitOperatingHoursCallbacks): void {
    this.callbacks = callbacks;
  }

  private formatTime(...args: any[]): string {
    return String(this.callbacks.formatTime?.(...args) || '');
  }

  private parsePreviewTimeToMinutes(...args: any[]): number | null {
    return this.callbacks.parsePreviewTimeToMinutes?.(...args) ?? null;
  }


  public async enrichManualFitPreviewTimelineWithOperatingHours(
    planId: number,
    routeId: number,
    timeline: any[],
  ): Promise<any[]> {
    const rows = Array.isArray(timeline) ? timeline : [];
    if (rows.length === 0) return rows;

    const attractionIds = Array.from(new Set(
      rows
        .filter((row: any) => (
          String(row?.type || '').toLowerCase() === 'attraction'
          || Number(row?.item_type || 0) === 4
        ))
        .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ));

    if (attractionIds.length === 0) return rows;

    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        itinerary_route_date: true,
      },
    });

    const routeDate = route?.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
    const dayOfWeek = routeDate ? (routeDate.getDay() + 6) % 7 : 0;
    const timingRows = await (this.prisma as any).dvi_hotspot_timing.findMany({
      where: {
        hotspot_ID: { in: attractionIds },
        status: 1,
        deleted: 0,
      },
      orderBy: [
        { hotspot_timing_day: 'asc' },
        { hotspot_start_time: 'asc' },
        { hotspot_timing_ID: 'asc' },
      ],
    });

    const timingMap = new Map<number, any[]>();
    for (const timing of timingRows || []) {
      const hotspotId = Number(timing?.hotspot_ID || 0);
      if (!hotspotId) continue;
      if (!timingMap.has(hotspotId)) {
        timingMap.set(hotspotId, []);
      }
      timingMap.get(hotspotId)!.push(timing);
    }

    const buildOperatingHours = (timings: any[]): {
      operatingHours: string | null;
      openingTime: string | null;
      closingTime: string | null;
    } => {
      const dayTimings = (timings || []).filter((row: any) => Number(row?.hotspot_timing_day) === dayOfWeek);
      const todayTimings = dayTimings.filter((row: any) => Number(row?.hotspot_closed || 0) !== 1);

      if (dayTimings.length > 0 && todayTimings.length === 0) {
        return {
          operatingHours: 'Closed',
          openingTime: null,
          closingTime: null,
        };
      }

      if (todayTimings.length === 0) {
        return {
          operatingHours: null,
          openingTime: null,
          closingTime: null,
        };
      }

      if (todayTimings.some((row: any) => Number(row?.hotspot_open_all_time || 0) === 1)) {
        return {
          operatingHours: 'Open 24 Hours',
          openingTime: '00:00:00',
          closingTime: '23:59:59',
        };
      }

      const operatingHours = todayTimings
        .map((row: any) => `${this.formatTime(row?.hotspot_start_time as any)} - ${this.formatTime(row?.hotspot_end_time as any)}`)
        .join(', ');

      const openingTime = todayTimings[0]?.hotspot_start_time
        ? this.formatTime(todayTimings[0].hotspot_start_time as any)
        : null;
      const closingTime = todayTimings[todayTimings.length - 1]?.hotspot_end_time
        ? this.formatTime(todayTimings[todayTimings.length - 1].hotspot_end_time as any)
        : null;

      return {
        operatingHours: operatingHours || null,
        openingTime,
        closingTime,
      };
    };

    return rows.map((row: any) => {
      const isAttractionLike =
        String(row?.type || '').toLowerCase() === 'attraction' ||
        Number(row?.item_type || 0) === 4;
      if (!isAttractionLike) return row;

      const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
      if (!hotspotId) return row;

      const timingSummary = buildOperatingHours(timingMap.get(hotspotId) || []);
      return {
        ...row,
        timings: timingSummary.operatingHours || row?.timings || null,
        operatingHours: timingSummary.operatingHours || row?.operatingHours || row?.timings || null,
        openingTime: timingSummary.openingTime || row?.openingTime || null,
        closingTime: timingSummary.closingTime || row?.closingTime || null,
      };
    });
  }

  public normalizeManualFitTimeText(value: any): string {
    return String(value || '')
      .replace(/\u2013|\u2014/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  public extractTimeWindowsFromLabel(value: any): Array<{
    startLabel: string;
    endLabel: string;
    startMinutes: number;
    endMinutes: number;
  }> {
    const raw = this.normalizeManualFitTimeText(value);
    if (!raw || /open\s*24/i.test(raw)) return [];

    const windows: Array<{
      startLabel: string;
      endLabel: string;
      startMinutes: number;
      endMinutes: number;
    }> = [];

    const regex =
      /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*(?:-|to)\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/gi;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const startLabel = this.normalizeManualFitTimeText(match[1]);
      const endLabel = this.normalizeManualFitTimeText(match[2]);
      const startMinutes = this.parsePreviewTimeToMinutes(startLabel);
      const endMinutes = this.parsePreviewTimeToMinutes(endLabel);

      if (startMinutes === null || endMinutes === null) continue;

      windows.push({
        startLabel,
        endLabel,
        startMinutes,
        endMinutes,
      });
    }

    return windows;
  }

  public evaluateTimelineRowAgainstOperatingHours(row: any): {
    valid: boolean;
    reason: string | null;
    attemptedVisitTime: string | null;
    operatingHours: string | null;
    attemptedStartLabel: string | null;
    attemptedEndLabel: string | null;
    openingLabel: string | null;
    closingLabel: string | null;
  } {
    const attemptedVisitTime = this.normalizeManualFitTimeText(
      row?.timeRange || row?.visitTime || row?.attemptedVisitTime || '',
    );

    const operatingHours = this.normalizeManualFitTimeText(
      row?.timings || row?.operatingHours || row?.hotspot_timings || '',
    );

    if (!attemptedVisitTime || !attemptedVisitTime.includes('-')) {
      return {
        valid: false,
        reason: 'Selected hotspot has no valid attempted visit time in the preview timeline.',
        attemptedVisitTime: attemptedVisitTime || null,
        operatingHours: operatingHours || null,
        attemptedStartLabel: null,
        attemptedEndLabel: null,
        openingLabel: null,
        closingLabel: null,
      };
    }

    if (/^closed$/i.test(operatingHours)) {
      return {
        valid: false,
        reason: `Selected hotspot is closed on this route date. Attempted visit time is ${attemptedVisitTime}.`,
        attemptedVisitTime,
        operatingHours,
        attemptedStartLabel: null,
        attemptedEndLabel: null,
        openingLabel: null,
        closingLabel: null,
      };
    }

    if (!operatingHours || /open\s*24/i.test(operatingHours)) {
      return {
        valid: true,
        reason: null,
        attemptedVisitTime,
        operatingHours: operatingHours || null,
        attemptedStartLabel: null,
        attemptedEndLabel: null,
        openingLabel: null,
        closingLabel: null,
      };
    }

    const attemptedWindows = this.extractTimeWindowsFromLabel(attemptedVisitTime);
    const operatingWindows = this.extractTimeWindowsFromLabel(operatingHours);
    const attempted = attemptedWindows[0];

    if (!attempted || operatingWindows.length === 0) {
      return {
        valid: true,
        reason: null,
        attemptedVisitTime,
        operatingHours,
        attemptedStartLabel: attempted?.startLabel || null,
        attemptedEndLabel: attempted?.endLabel || null,
        openingLabel: operatingWindows[0]?.startLabel || null,
        closingLabel: operatingWindows[0]?.endLabel || null,
      };
    }

    const fitsAnyWindow = operatingWindows.some((window) => {
      if (window.endMinutes >= window.startMinutes) {
        return attempted.startMinutes >= window.startMinutes && attempted.endMinutes <= window.endMinutes;
      }

      const attemptedStart = attempted.startMinutes < window.startMinutes
        ? attempted.startMinutes + (24 * 60)
        : attempted.startMinutes;
      const attemptedEnd = attempted.endMinutes < window.startMinutes
        ? attempted.endMinutes + (24 * 60)
        : attempted.endMinutes;
      const operatingEnd = window.endMinutes + (24 * 60);

      return attemptedStart >= window.startMinutes && attemptedEnd <= operatingEnd;
    });

    if (fitsAnyWindow) {
      return {
        valid: true,
        reason: null,
        attemptedVisitTime,
        operatingHours,
        attemptedStartLabel: attempted.startLabel,
        attemptedEndLabel: attempted.endLabel,
        openingLabel: operatingWindows[0]?.startLabel || null,
        closingLabel: operatingWindows[0]?.endLabel || null,
      };
    }

    const firstWindow = operatingWindows[0];

    return {
      valid: false,
      reason: `Selected hotspot is closed at attempted visit time ${attemptedVisitTime}. Operating hours are ${operatingHours}.`,
      attemptedVisitTime,
      operatingHours,
      attemptedStartLabel: attempted.startLabel,
      attemptedEndLabel: attempted.endLabel,
      openingLabel: firstWindow?.startLabel || null,
      closingLabel: firstWindow?.endLabel || null,
    };
  }

  public adjustManualFitVisitStartToOperatingWindow(
    row: any,
    arrivalMinutes: number,
    durationMinutes: number,
  ): {
    valid: boolean;
    startMinutes: number;
    waitingMinutes: number;
    operatingHours: string | null;
  } {
    const operatingHours = this.normalizeManualFitTimeText(
      row?.timings || row?.operatingHours || row?.hotspot_timings || '',
    );

    if (!operatingHours || /open\s*24/i.test(operatingHours)) {
      return {
        valid: true,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours: operatingHours || null,
      };
    }

    if (/^closed$/i.test(operatingHours)) {
      return {
        valid: false,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours,
      };
    }

    const windows = this.extractTimeWindowsFromLabel(operatingHours);
    if (windows.length === 0) {
      return {
        valid: true,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours,
      };
    }

    const safeDurationMinutes = Math.max(1, Math.round(Number(durationMinutes || 0) || 0));
    let bestStart: number | null = null;

    for (const window of windows) {
      if (window.endMinutes < window.startMinutes) continue;

      const candidateStart = Math.max(arrivalMinutes, window.startMinutes);
      if ((candidateStart + safeDurationMinutes) <= window.endMinutes) {
        bestStart = candidateStart;
        break;
      }
    }

    if (bestStart === null) {
      return {
        valid: false,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours,
      };
    }

    return {
      valid: true,
      startMinutes: bestStart,
      waitingMinutes: Math.max(0, bestStart - arrivalMinutes),
      operatingHours,
    };
  }

  public getSelectedManualClosingOverflow(params: {
    timeline: any[];
    selectedHotspotIds: number[];
  }): {
    hasClosingOverflow: boolean;
    hotspotId: number | null;
    hotspotName: string | null;
    attemptedVisitTime: string | null;
    operatingHours: string | null;
    overflowMinutes: number;
    latestAllowedEndMinutes: number | null;
    conflict: any | null;
  } {
    const selectedSet = new Set(
      (params.selectedHotspotIds || [])
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    const timeline = Array.isArray(params.timeline) ? params.timeline : [];

    for (const row of timeline) {
      const isAttraction =
        String(row?.type || '').toLowerCase() === 'attraction' ||
        Number(row?.item_type || 0) === 4;

      if (!isAttraction) continue;

      const hotspotId = Number(
        row?.locationId ||
        row?.hotspotId ||
        row?.hotspot_ID ||
        row?.hotspot_id ||
        0,
      );

      if (!selectedSet.has(hotspotId)) continue;

      const evaluation = this.evaluateTimelineRowAgainstOperatingHours(row);

      if (evaluation.valid) {
        return {
          hasClosingOverflow: false,
          hotspotId,
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          overflowMinutes: 0,
          latestAllowedEndMinutes: null,
          conflict: null,
        };
      }

      const attemptedWindows = this.extractTimeWindowsFromLabel(evaluation.attemptedVisitTime || '');
      const operatingWindows = this.extractTimeWindowsFromLabel(evaluation.operatingHours || '');
      const attempted = attemptedWindows[0];
      const operating = operatingWindows[0];

      if (!attempted || !operating) {
        return {
          hasClosingOverflow: false,
          hotspotId,
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          overflowMinutes: 0,
          latestAllowedEndMinutes: null,
          conflict: null,
        };
      }

      const overflowMinutes = Math.max(0, attempted.endMinutes - operating.endMinutes);

      if (overflowMinutes <= 0) {
        return {
          hasClosingOverflow: false,
          hotspotId,
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          overflowMinutes: 0,
          latestAllowedEndMinutes: operating.endMinutes,
          conflict: null,
        };
      }

      const hotspotName = String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`);
      const conflict = {
        hotspotId,
        hotspotName,
        attemptedVisitTime: evaluation.attemptedVisitTime,
        attemptedStartTime: evaluation.attemptedStartLabel,
        attemptedEndTime: evaluation.attemptedEndLabel,
        operatingHours: evaluation.operatingHours,
        openingTime: evaluation.openingLabel,
        closingTime: evaluation.closingLabel,
        overflowMinutes,
        reasonCode: 'SELECTED_HOTSPOT_EXCEEDS_CLOSING_TIME',
        reason: `${hotspotName} ends ${overflowMinutes} minute(s) after closing. Attempted: ${evaluation.attemptedVisitTime}. Operating hours: ${evaluation.operatingHours}.`,
      };

      return {
        hasClosingOverflow: true,
        hotspotId,
        hotspotName,
        attemptedVisitTime: evaluation.attemptedVisitTime,
        operatingHours: evaluation.operatingHours,
        overflowMinutes,
        latestAllowedEndMinutes: operating.endMinutes,
        conflict,
      };
    }

    return {
      hasClosingOverflow: false,
      hotspotId: null,
      hotspotName: null,
      attemptedVisitTime: null,
      operatingHours: null,
      overflowMinutes: 0,
      latestAllowedEndMinutes: null,
      conflict: null,
    };
  }

  public markSelectedManualOperatingHourConflicts(
    timeline: any[],
    selectedHotspotIds: number[],
  ): {
    timeline: any[];
    selectedOpeningConflict: any | null;
  } {
    const selectedSet = new Set(
      (selectedHotspotIds || [])
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    if (!Array.isArray(timeline) || selectedSet.size === 0) {
      return { timeline: Array.isArray(timeline) ? timeline : [], selectedOpeningConflict: null };
    }

    let selectedOpeningConflict: any | null = null;

    const nextTimeline = timeline.map((row: any) => {
      const isAttraction =
        String(row?.type || '').toLowerCase() === 'attraction' ||
        Number(row?.item_type || 0) === 4;

      if (!isAttraction) return row;

      const hotspotId = Number(
        row?.locationId ||
        row?.hotspot_ID ||
        row?.hotspotId ||
        row?.hotspot_id ||
        0,
      );

      if (!selectedSet.has(hotspotId)) return row;

      const evaluation = this.evaluateTimelineRowAgainstOperatingHours(row);

      if (evaluation.valid) {
        return {
          ...row,
          isConflict: false,
          is_conflict: 0,
          conflictReason: null,
          conflict_reason: null,
          selectedOpeningConflict: null,
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          manualFitStatus: row?.manualFitStatus === 'INSERTED' ? row.manualFitStatus : null,
        };
      }

      const conflictPayload = {
        hotspotId,
        hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
        attemptedVisitTime: evaluation.attemptedVisitTime,
        attemptedStartTime: evaluation.attemptedStartLabel,
        attemptedEndTime: evaluation.attemptedEndLabel,
        operatingHours: evaluation.operatingHours,
        openingTime: evaluation.openingLabel,
        closingTime: evaluation.closingLabel,
        reason: evaluation.reason,
        reasonCode: 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME',
      };

      selectedOpeningConflict = selectedOpeningConflict || conflictPayload;

      return {
        ...row,
        isConflict: true,
        is_conflict: 1,
        conflictReason: evaluation.reason,
        conflict_reason: evaluation.reason,
        selectedOpeningConflict: conflictPayload,
        attemptedVisitTime: evaluation.attemptedVisitTime,
        operatingHours: evaluation.operatingHours,
        manualFitStatus: 'CANNOT_INSERT',
      };
    });

    return { timeline: nextTimeline, selectedOpeningConflict };
  }
}
