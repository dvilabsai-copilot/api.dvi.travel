import { Injectable } from '@nestjs/common';
import {
  buildManualFitChangesRequiredDisplayImpl,
  buildRemovedPrioritySummaryImpl,
  detectManualFitTimingRiskImpl,
} from '../helpers/manual-fit-here-preview.helper';

type RemovalExplanationCallbacks = {
  parsePreviewTimeToMinutes?: (value: any) => number | null;
  parseManualHotspotLatestClosingMinute?: (value: any) => number;
  formatTime?: (value: any) => string;
  minutesToUtcTimeDate?: (minutes: number) => Date;
};

type ManualFitTimingRisk = any;

@Injectable()
export class ItineraryManualFitRemovalExplanationService {
  private callbacks: RemovalExplanationCallbacks = {};

  setCallbacks(callbacks: RemovalExplanationCallbacks): void {
    this.callbacks = callbacks;
  }

  private parsePreviewTimeToMinutes(value: any): number | null {
    return this.callbacks.parsePreviewTimeToMinutes?.(value) ?? null;
  }

  private parseManualHotspotLatestClosingMinute(value: any): number {
    return Number(this.callbacks.parseManualHotspotLatestClosingMinute?.(value) || 0);
  }

  private formatTime(value: any): string {
    return String(this.callbacks.formatTime?.(value) || '');
  }

  private minutesToUtcTimeDate(minutes: number): Date {
    return this.callbacks.minutesToUtcTimeDate?.(minutes) || new Date(0);
  }


  public formatManualDurationMinutes(minutes: number): string {
    const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    if (hours > 0 && mins > 0) return `${hours} hour ${mins} minute${mins === 1 ? '' : 's'}`;
    if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }

  public formatMinutesHuman(minutes: number): string {
    const safeMinutes = Math.max(0, Math.round(Number(minutes || 0)));

    if (safeMinutes < 60) {
      return `${safeMinutes} minute${safeMinutes === 1 ? '' : 's'}`;
    }

    const hours = Math.floor(safeMinutes / 60);
    const mins = safeMinutes % 60;

    if (mins === 0) {
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }

    return `${hours} hour${hours === 1 ? '' : 's'} ${mins} minute${mins === 1 ? '' : 's'}`;
  }

  public formatPreviewTravelDuration(minutes: number): string {
    const safeMinutes = Math.max(0, Math.round(Number(minutes || 0)));
    const hours = Math.floor(safeMinutes / 60);
    const mins = safeMinutes % 60;

    if (hours > 0 && mins > 0) {
      return `${hours} Hour${hours === 1 ? '' : 's'} ${mins} Min`;
    }
    if (hours > 0) {
      return `${hours} Hour${hours === 1 ? '' : 's'}`;
    }
    return `${mins} Min`;
  }

  public parseTimeRangeParts(value: unknown): { start: string | null; end: string | null } {
    const raw = String(value || '').trim();
    if (!raw) return { start: null, end: null };

    const parts = raw.split(/\s*-\s*/);
    return {
      start: parts[0]?.trim() || null,
      end: parts[1]?.trim() || null,
    };
  }

  public extractOpeningTimeFromOperatingHours(value: unknown): string | null {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const matches = raw.match(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/gi) || [];
    return matches[0] || null;
  }

  public extractClosingTimeFromOperatingHours(value: unknown): string | null {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const matches = raw.match(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/gi) || [];
    if (matches.length < 2) return null;

    return matches[matches.length - 1] || null;
  }

  public isAttractionTimelineRow(row: any): boolean {
    const type = String(row?.type || row?.rowType || '').trim().toLowerCase();
    const itemType = Number(row?.item_type || row?.itemType || 0);

    return (
      type === 'attraction' ||
      type === 'hotspot' ||
      itemType === 4
    );
  }

  public getTimelineRowHotspotId(row: any): number {
    return Number(
      row?.hotspotId ||
      row?.hotspot_ID ||
      row?.hotspot_id ||
      row?.locationId ||
      row?.location_id ||
      0,
    ) || 0;
  }

  public findAttemptedAttractionRowForHotspot(params: {
    attemptedTimeline?: any[];
    hotspotId: number;
  }): any | null {
    const hotspotId = Number(params.hotspotId || 0);
    if (!(hotspotId > 0) || !Array.isArray(params.attemptedTimeline)) {
      return null;
    }

    return params.attemptedTimeline.find((row: any) => (
      this.isAttractionTimelineRow(row) &&
      this.getTimelineRowHotspotId(row) === hotspotId
    )) || null;
  }

  public getPriorityLabel(priority: unknown): string {
    const value = Number(priority || 0);
    if (value === 1) return 'Priority 1';
    if (value === 2) return 'Priority 2';
    if (value === 3) return 'Priority 3';
    return 'Priority';
  }

  public getRemovedHotspotVisitTime(row: any): string | null {
    return String(
      row?.timeRange ||
      row?.visitTime ||
      row?.hotspot_visit_time ||
      (
        row?.startTime && row?.endTime
          ? `${row.startTime} - ${row.endTime}`
          : ''
      ) ||
      (
        row?.hotspot_start_time && row?.hotspot_end_time
          ? `${row.hotspot_start_time} - ${row.hotspot_end_time}`
          : ''
      ) ||
      '',
    ).trim() || null;
  }

  public getRemovedHotspotOperatingHours(row: any): string | null {
    return String(
      row?.timings ||
      row?.operatingHours ||
      row?.openingHours ||
      row?.hotspot_timing ||
      row?.hotspot_timings ||
      row?.hotspotTiming ||
      '',
    ).trim() || null;
  }

  public enrichRemovedHotspotCandidateWithAttempt(params: {
    candidate: any;
    attemptedTimeline?: any[];
    attemptedTimelineSource?:
      | 'EXACT_ANCHOR_SEQUENTIAL_REBUILD'
      | 'FAILED_BEFORE_REMOVAL'
      | 'AFTER_REMOVAL'
      | 'FINAL_PROPOSED_TIMELINE'
      | 'UNKNOWN';
  }): any {
    const candidateHotspotId = Number(
      params.candidate?.hotspotId ||
      params.candidate?.id ||
      params.candidate?.hotspot_ID ||
      0,
    );

    const attemptedAttractionRow = this.findAttemptedAttractionRowForHotspot({
      attemptedTimeline: params.attemptedTimeline,
      hotspotId: candidateHotspotId,
    });

    const attemptedVisitTime = attemptedAttractionRow
      ? String(
          attemptedAttractionRow?.visitTime ||
          attemptedAttractionRow?.timeRange ||
          attemptedAttractionRow?.hotspot_visit_time ||
          '',
        ).trim() || null
      : null;

    const attemptedRange = this.parseTimeRangeParts(attemptedVisitTime);

    return {
      ...params.candidate,

      // Never use travel-time rows as attraction visit attempts.
      attemptedVisitTime,
      attemptedArrivalTime:
        attemptedAttractionRow?.arrivalTime ||
        attemptedRange.start ||
        null,
      attemptedEndTime:
        attemptedAttractionRow?.departureTime ||
        attemptedRange.end ||
        null,
      operatingHours:
        params.candidate?.operatingHours ||
        params.candidate?.timings ||
        params.candidate?.hotspot_timing ||
        attemptedAttractionRow?.timings ||
        attemptedAttractionRow?.operatingHours ||
        null,
      outsideOperatingMinutes:
        attemptedAttractionRow?.outsideOperatingMinutes ||
        attemptedAttractionRow?.openingHoursOverflowMinutes ||
        attemptedAttractionRow?.closingOverflowMinutes ||
        params.candidate?.outsideOperatingMinutes ||
        0,
      attemptedVisitSource: attemptedAttractionRow ? 'ATTRACTION_ROW' : 'NONE',
      attemptedTimelineSource: params.attemptedTimelineSource || 'UNKNOWN',
    };
  }

  public buildRemovedHotspotExplanation(params: {
    row: any;
    priority: number;
    removalStage: 'P3_FIRST' | 'P2_AFTER_P3' | 'P1_AFTER_P3_P2' | 'OPTIONAL';
    reasonCode?:
      | 'ARRIVAL_AFTER_CLOSING'
      | 'VISIT_END_AFTER_CLOSING'
      | 'ARRIVAL_BEFORE_OPENING'
      | 'ROUTE_END_OVERFLOW'
      | 'LOWER_PRIORITY_REMOVAL_REQUIRED'
      | 'OPENING_HOURS_CONFLICT'
      | 'ANCHOR_PRESERVATION'
      | 'MANUAL_HOTSPOT_TIME_WINDOW'
      | 'UNPROVEN_REMOVAL'
      | 'UNKNOWN';
    manualHotspotName?: string;
    anchorLabel?: string | null;
    routeEndOverflowMinutes?: number;
    routeEndTime?: string | null;
    openingHourConflictCount?: number;
    openingHoursOverflowMinutes?: number;
  }): any {
    const priorityLabel = this.getPriorityLabel(params.priority);
    const name = String(
      params.row?.name ||
      params.row?.hotspotName ||
      params.row?.hotspot_name ||
      `Hotspot #${params.row?.hotspotId || params.row?.id || ''}`,
    ).trim();

    const originalVisitTime = this.getRemovedHotspotVisitTime(params.row);
    const operatingHours = this.getRemovedHotspotOperatingHours(params.row);
    const routeEndOverflowMinutes = Math.max(0, Number(params.routeEndOverflowMinutes || 0));
    const openingHourConflictCount = Number(params.openingHourConflictCount || 0);
    const manualHotspotName = String(params.manualHotspotName || 'the selected manual hotspot').trim();

    const attemptedVisitTime = String(
      params.row?.attemptedVisitTime ||
      params.row?.newVisitTime ||
      params.row?.proposedVisitTime ||
      params.row?.recalculatedVisitTime ||
      '',
    ).trim() || null;

    const attemptedRange = this.parseTimeRangeParts(attemptedVisitTime);

    const attemptedArrivalTime = String(
      params.row?.attemptedArrivalTime ||
      params.row?.arrivalTime ||
      attemptedRange.start ||
      '',
    ).trim() || null;

    const attemptedEndTime = String(
      params.row?.attemptedEndTime ||
      params.row?.departureTime ||
      attemptedRange.end ||
      '',
    ).trim() || null;

    const openingTime = String(
      params.row?.openingTime ||
      this.extractOpeningTimeFromOperatingHours(operatingHours) ||
      '',
    ).trim() || null;

    const closingTime = String(
      params.row?.closingTime ||
      this.extractClosingTimeFromOperatingHours(operatingHours) ||
      '',
    ).trim() || null;

    const outsideOperatingMinutes = Math.max(
      0,
      Number(
        params.row?.outsideOperatingMinutes ||
        params.row?.openingHoursOverflowMinutes ||
        params.row?.closingOverflowMinutes ||
        params.openingHoursOverflowMinutes ||
        0,
      ),
    );

    const routeEndTime = String(params.row?.routeEndTime || params.routeEndTime || '').trim() || null;
    const routeEndOverflowBeforeRemoval = Math.max(
      0,
      Number(params.row?.routeEndOverflowBeforeRemoval ?? params.routeEndOverflowMinutes ?? 0),
    );
    const routeEndOverflowAfterRemoval = Math.max(0, Number(params.row?.routeEndOverflowAfterRemoval ?? 0));
    const openingHourConflictCountBeforeRemoval = Math.max(
      0,
      Number(params.row?.openingHourConflictCountBeforeRemoval ?? params.openingHourConflictCount ?? 0),
    );
    const openingHourConflictCountAfterRemoval = Math.max(0, Number(params.row?.openingHourConflictCountAfterRemoval ?? 0));
    const removalImprovedFeasibility = params.row?.removalImprovedFeasibility === true;
    const attemptedTimelineSource = String(params.row?.attemptedTimelineSource || 'UNKNOWN');

    let removalReasonCode = params.reasonCode || 'LOWER_PRIORITY_REMOVAL_REQUIRED';

    let reason = '';
    if (params.removalStage === 'P3_FIRST') {
      reason = `Removed first because this is a ${priorityLabel} hotspot and lower-priority rows are removed before higher-priority rows.`;
    } else if (params.removalStage === 'P2_AFTER_P3') {
      reason = 'Removed after Priority 3 removals were not enough to fit the selected manual hotspot.';
    } else if (params.removalStage === 'P1_AFTER_P3_P2') {
      reason = 'Removed only after Priority 3 and Priority 2 removals were exhausted.';
    } else {
      reason = 'Removed because this optional/lower-priority hotspot conflicts with the selected manual hotspot insertion.';
    }

    let fitFailureExplanation = '';

    if (attemptedArrivalTime && closingTime && outsideOperatingMinutes > 0) {
      removalReasonCode = 'ARRIVAL_AFTER_CLOSING';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, the guest would reach ${name} at ${attemptedArrivalTime}, but it closes at ${closingTime}. It is outside operating hours by ${this.formatMinutesHuman(outsideOperatingMinutes)}.`;
    } else if (attemptedEndTime && closingTime && outsideOperatingMinutes > 0) {
      removalReasonCode = 'VISIT_END_AFTER_CLOSING';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, the visit to ${name} would continue until ${attemptedEndTime}, but it closes at ${closingTime}. It exceeds operating hours by ${this.formatMinutesHuman(outsideOperatingMinutes)}.`;
    } else if (attemptedArrivalTime && openingTime && outsideOperatingMinutes > 0) {
      removalReasonCode = 'ARRIVAL_BEFORE_OPENING';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, the guest would reach ${name} at ${attemptedArrivalTime}, before it opens at ${openingTime}. It is outside operating hours by ${this.formatMinutesHuman(outsideOperatingMinutes)}.`;
    } else if (routeEndOverflowMinutes > 0) {
      removalReasonCode = 'ROUTE_END_OVERFLOW';
      fitFailureExplanation =
        `Keeping ${name} would push the route beyond the allowed day${routeEndTime ? ` end time of ${routeEndTime}` : ' end time'} by ${this.formatMinutesHuman(routeEndOverflowMinutes)} after inserting ${manualHotspotName}.`;
    } else if (openingHourConflictCount > 0) {
      removalReasonCode = 'OPENING_HOURS_CONFLICT';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, keeping ${name} creates an opening-hours conflict in the recalculated route.`;
    } else if (attemptedVisitTime && operatingHours && outsideOperatingMinutes <= 0) {
      removalReasonCode = 'UNPROVEN_REMOVAL';
      fitFailureExplanation =
        `${name} is open during the recalculated visit time of ${attemptedVisitTime}. Its operating hours are ${operatingHours}. No direct operating-hours conflict or route-end overflow was proven for this hotspot, so this removal requires additional route-feasibility evidence.`;
    } else if (originalVisitTime && operatingHours) {
      removalReasonCode = 'UNPROVEN_REMOVAL';
      fitFailureExplanation =
        `${name} was originally planned at ${originalVisitTime}, and its operating hours are ${operatingHours}. The system did not prove a direct timing violation for this hotspot.`;
    } else {
      removalReasonCode = 'UNPROVEN_REMOVAL';
      fitFailureExplanation =
        `The optimizer selected ${name} for removal, but no direct operating-hours conflict, route-end overflow, or downstream route failure was attached as proof.`;
    }

    if (params.anchorLabel && !/selected fit here position/i.test(fitFailureExplanation)) {
      fitFailureExplanation += ` Selected position: ${params.anchorLabel}.`;
    }

    const attemptedVisitSource = String(params.row?.attemptedVisitSource || '').trim();
    const safeAttemptedVisitTime =
      attemptedVisitSource === 'ATTRACTION_ROW'
        ? attemptedVisitTime
        : null;

    const safeAttemptedArrivalTime =
      attemptedVisitSource === 'ATTRACTION_ROW'
        ? attemptedArrivalTime
        : null;

    const safeAttemptedEndTime =
      attemptedVisitSource === 'ATTRACTION_ROW'
        ? attemptedEndTime
        : null;
    const isWithinOperatingHours =
      Boolean(safeAttemptedVisitTime && operatingHours) &&
      outsideOperatingMinutes <= 0;
    const hasProvenTimingReason =
      outsideOperatingMinutes > 0 ||
      routeEndOverflowMinutes > 0 ||
      openingHourConflictCount > 0;

    return {
      id: Number(params.row?.hotspotId || params.row?.id || params.row?.hotspot_ID || 0),
      hotspotId: Number(params.row?.hotspotId || params.row?.id || params.row?.hotspot_ID || 0),
      routeHotspotId: Number(params.row?.routeHotspotId || params.row?.route_hotspot_ID || 0) || null,
      name,
      priority: params.priority,
      priorityLabel,
      originalVisitTime,
      attemptedVisitTime: safeAttemptedVisitTime,
      attemptedArrivalTime: safeAttemptedArrivalTime,
      attemptedEndTime: safeAttemptedEndTime,
      attemptedVisitSource,
      attemptedTimelineSource,
      openingTime,
      closingTime,
      outsideOperatingMinutes,
      operatingHours,
      isWithinOperatingHours,
      routeEndTime,
      routeEndOverflowMinutes,
      routeEndOverflowBeforeRemoval,
      routeEndOverflowAfterRemoval,
      openingHourConflictCount,
      openingHourConflictCountBeforeRemoval,
      openingHourConflictCountAfterRemoval,
      removalImprovedFeasibility,
      hasProvenTimingReason,
      removalStage: params.removalStage,
      removalReasonCode,
      reason: fitFailureExplanation || reason,
      fitFailureExplanation,
    };
  }

  public detectManualFitTimingRisk(params: {
    timeline: any[];
    selectedHotspotId: number;
  }): ManualFitTimingRisk | null {
    return detectManualFitTimingRiskImpl.call(this, params);
  }

  public buildRemovedPrioritySummary(removedRows: any[]) {
    return buildRemovedPrioritySummaryImpl.call(this, removedRows);
  }

  public getAuthoritativeManualFitRemovedHotspots(params: {
    bestCandidate?: any;
    selectedAttempt?: any;
    fallbackRemovedHotspots?: any[];
  }): any[] {
    const fromBestCandidate = [
      ...(Array.isArray(params.bestCandidate?.removedOptionalHotspots) ? params.bestCandidate.removedOptionalHotspots : []),
      ...(Array.isArray(params.bestCandidate?.removedTopPriorityHotspots) ? params.bestCandidate.removedTopPriorityHotspots : []),
    ];

    if (fromBestCandidate.length > 0) {
      return fromBestCandidate;
    }

    const fromSelectedAttempt = [
      ...(Array.isArray(params.selectedAttempt?.removedHotspots) ? params.selectedAttempt.removedHotspots : []),
      ...(Array.isArray(params.selectedAttempt?.removedOptionalHotspots) ? params.selectedAttempt.removedOptionalHotspots : []),
      ...(Array.isArray(params.selectedAttempt?.removedTopPriorityHotspots) ? params.selectedAttempt.removedTopPriorityHotspots : []),
    ];

    if (fromSelectedAttempt.length > 0) {
      return fromSelectedAttempt;
    }

    return Array.isArray(params.fallbackRemovedHotspots) ? params.fallbackRemovedHotspots : [];
  }

  public buildManualFitChangesRequiredDisplay(params: {
    removedHotspots?: any[];
    affectedPriorityHotspots?: any[];
    removedPrioritySummary?: any;
  }): {
    hasRemovals: boolean;
    title: string;
    removalOrderLabel: string;
    removedItems: Array<{
      hotspotId: number;
      routeHotspotId?: number | null;
      name: string;
      workPriority: number | null;
      workPriorityLabel: string;
      reason?: string | null;
      removalReasonCode?: string | null;
      fitFailureExplanation?: string | null;
    }>;
    noRemovalText: string;
  } {
    return buildManualFitChangesRequiredDisplayImpl.call(this, params);
  }
}
