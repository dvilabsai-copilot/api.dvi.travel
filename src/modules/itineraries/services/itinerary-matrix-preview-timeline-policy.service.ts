import { Injectable } from '@nestjs/common';

type MatrixPreviewPolicyCallbacks = {
  parseSegmentStartMinutes?: (segment: any) => number | null;
  parseSegmentEndMinutes?: (segment: any) => number | null;
  parsePreviewTimeToMinutes?: (value: any) => number | null;
  timeToMinutes?: (value: any) => number;
  getHotspotDurationMinutes?: (master: any, row: any) => number;
};

@Injectable()
export class ItineraryMatrixPreviewTimelinePolicyService {
  private callbacks: MatrixPreviewPolicyCallbacks = {};

  setCallbacks(callbacks: MatrixPreviewPolicyCallbacks): void {
    this.callbacks = callbacks;
  }

  private parseSegmentStartMinutes(segment: any): number | null {
    return this.callbacks.parseSegmentStartMinutes?.(segment) ?? null;
  }

  private parseSegmentEndMinutes(segment: any): number | null {
    return this.callbacks.parseSegmentEndMinutes?.(segment) ?? null;
  }

  private parsePreviewTimeToMinutes(value: any): number | null {
    return this.callbacks.parsePreviewTimeToMinutes?.(value) ?? null;
  }

  private timeToMinutes(value: any): number {
    return Number(this.callbacks.timeToMinutes?.(value) || 0);
  }

  private getHotspotDurationMinutes(master: any, row: any): number {
    return Number(this.callbacks.getHotspotDurationMinutes?.(master, row) || 0);
  }


  public finalizeMatrixPreviewTimeline(timeline: any[]): any[] {
    const normalized = this.normalizeTravelLabelsToNextStop(Array.isArray(timeline) ? timeline : []);
    const repaired = this.repairMatrixPreviewTimelineTimeRanges(normalized);
    const deduped: any[] = [];

    const rowFingerprint = (row: any): string => [
      String(row?.type || '').toLowerCase(),
      Number(row?.item_type || 0) || 0,
      Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0) || 0,
      String(row?.fromName || row?.from || row?.displayFromName || '').trim().toLowerCase(),
      String(row?.toName || row?.to || row?.displayToName || '').trim().toLowerCase(),
      String(row?.timeRange || row?.time || '').trim().toLowerCase(),
    ].join('|');

    for (const row of repaired) {
      if (!row) continue;
      const prev = deduped[deduped.length - 1];
      if (prev && rowFingerprint(prev) === rowFingerprint(row)) {
        continue;
      }
      deduped.push(row);
    }

    return deduped.map((row: any, index: number) => ({
      ...row,
      previewOrder: index,
      matrixPreviewOrder: index,
    }));
  }

  public isManualPreviewTimelineWrapped(timeline: any[]): boolean {
    if (!Array.isArray(timeline) || timeline.length === 0) return false;

    const isRefreshmentRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'refreshment' || itemType === 1 || text.includes('refreshment / buffer');
    };

    const isCheckinRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || type === 'checkin' || itemType === 6 || text.includes('check-in at');
    };

    const isMeaningfulAfterTerminal = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      return (
        type === 'refreshment'
        || type === 'travel'
        || type === 'attraction'
        || type === 'waiting'
        || itemType === 1
        || itemType === 3
        || itemType === 4
        || itemType === 5
        || itemType === 7
      );
    };

    let refreshmentCount = 0;
    let firstCheckinIndex = -1;
    let checkinCount = 0;

    for (let index = 0; index < timeline.length; index += 1) {
      const row = timeline[index];
      if (isRefreshmentRow(row)) {
        refreshmentCount += 1;
        if (refreshmentCount > 1) return true;
      }

      if (isCheckinRow(row)) {
        checkinCount += 1;
        if (checkinCount > 1) return true;
        if (firstCheckinIndex < 0) firstCheckinIndex = index;
        continue;
      }

      if (firstCheckinIndex >= 0 && index > firstCheckinIndex && isMeaningfulAfterTerminal(row)) {
        return true;
      }
    }

    return false;
  }

  public repairMatrixPreviewTimelineTimeRanges(timeline: any[]): any[] {
    if (!Array.isArray(timeline) || timeline.length === 0) return [];

    const output: any[] = [];
    let cursor: number | null = null;

    const isHotelLikeRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || itemType === 6 || /check-?in\s+at\s+hotel/.test(text);
    };

    for (const row of timeline) {
      const rawRange = String(row?.timeRange || '').trim();
      const hasPlaceholderRange = /needs\s+recalculation|needs\s+reschedule/i.test(rawRange);
      const parsedStart = this.parseSegmentStartMinutes(row);
      const parsedEnd = this.parseSegmentEndMinutes(row);
      const hasValidRange = !hasPlaceholderRange
        && parsedStart !== null
        && parsedEnd !== null
        && parsedEnd >= parsedStart;

      if (hasValidRange) {
        output.push(row);
        cursor = parsedEnd;
        continue;
      }

      if (!hasPlaceholderRange) {
        output.push(row);
        if (parsedEnd !== null) cursor = parsedEnd;
        continue;
      }

      const hotelLike = isHotelLikeRow(row);
      const durationMin = hotelLike
        ? 0
        : Math.max(1, Math.round(Number(row?.matrixDurationMin || this.getPreviewRowDurationMinutes(row) || 10)));
      const startMin = cursor ?? 0;
      const endMin = hotelLike ? startMin : (startMin + durationMin);

      const patchedRow: any = {
        ...row,
        timeRange: this.minutesRangeToTimeString(startMin, endMin),
      };

      if (!hotelLike && row?.isMatrixSplitTravel === true) {
        patchedRow.matrixDurationMin = durationMin;
        patchedRow.duration = row?.duration || `${durationMin} Min`;
      }

      output.push(patchedRow);
      cursor = endMin;
    }

    return output;
  }

  public assertTimelineOrderForMatrixPreview(timeline: any[], selectedHotspotId: number): void {
    const debugMode = String(process.env.DEBUG_MATRIX_PREVIEW_ASSERT || '').toLowerCase() === 'true';
    const isTravel = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };
    const isAttraction = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isHotelLike = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
    };
    const getTarget = (row: any) => String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();

    const errors: string[] = [];
    const hotelIndex = timeline.findIndex((row: any) => isHotelLike(row));
    if (hotelIndex >= 0) {
      for (let i = hotelIndex + 1; i < timeline.length; i += 1) {
        if (isTravel(timeline[i]) || isAttraction(timeline[i])) {
          errors.push('hotel/check-in appears before later travel/attraction rows');
          break;
        }
      }
    }

    const selectedIndex = timeline.findIndex(
      (row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === Number(selectedHotspotId),
    );
    if (hotelIndex >= 0 && selectedIndex > hotelIndex) {
      errors.push('selected hotspot appears after hotel/check-in');
    }

    for (let i = 1; i < timeline.length; i += 1) {
      const prev = timeline[i - 1];
      const curr = timeline[i];
      if (isTravel(prev) && isTravel(curr) && getTarget(prev) && getTarget(prev) === getTarget(curr)) {
        errors.push(`duplicate consecutive travel rows targeting same destination at index ${i - 1}/${i}`);
      }
    }

    const cToBIndex = timeline.findIndex((row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'C_TO_B');
    if (cToBIndex >= 0) {
      const next = timeline[cToBIndex + 1];
      if (!next || (!isAttraction(next) && !isHotelLike(next))) {
        errors.push('C_TO_B travel is not immediately before B attraction or destination hotel');
      }
    }

    const aToCIndex = timeline.findIndex((row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'A_TO_C');
    if (aToCIndex >= 0) {
      const next = timeline[aToCIndex + 1];
      if (!next || Number(next?.locationId || next?.hotspot_ID || next?.hotspotId || 0) !== Number(selectedHotspotId)) {
        errors.push('A_TO_C travel is not immediately before selected hotspot');
      }
    }

    if (selectedIndex >= 0) {
      const afterSelected = timeline[selectedIndex + 1];
      if (!afterSelected || !(afterSelected?.isMatrixSplitTravel === true && afterSelected?.matrixTravelLeg === 'C_TO_B')) {
        errors.push('selected hotspot is not immediately before C_TO_B travel');
      }
    }

    for (let i = 0; i < timeline.length; i += 1) {
      if (Number(timeline[i]?.matrixPreviewOrder) !== i) {
        errors.push('matrixPreviewOrder is not sequential from 0..n');
        break;
      }
    }

    if (errors.length > 0) {
      console.warn('[MatrixPreviewInvariant]', { errors });
      if (debugMode) {
        throw new Error(`Matrix preview invariant failed: ${errors.join('; ')}`);
      }
    }
  }

  public getPreviewRowDurationMinutes(row: any): number | null {
    const parseDurationLikeValue = (value: any): number | null => {
      if (value == null) return null;

      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.round(value);
      }

      if (value instanceof Date && Number.isFinite(value.getTime())) {
        const hours = value.getUTCHours();
        const minutes = value.getUTCMinutes();
        const seconds = value.getUTCSeconds();
        const total = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
        return total > 0 ? total : null;
      }

      const raw = String(value || '').trim();
      if (!raw) return null;

      const isoDate = new Date(raw);
      if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && Number.isFinite(isoDate.getTime())) {
        const hours = isoDate.getUTCHours();
        const minutes = isoDate.getUTCMinutes();
        const seconds = isoDate.getUTCSeconds();
        const total = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
        return total > 0 ? total : null;
      }

      const hourMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs|h)/i);
      const minMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:minute|minutes|min|mins|m)/i);
      if (hourMatch || minMatch) {
        const hours = hourMatch ? Number.parseFloat(hourMatch[1]) : 0;
        const minutes = minMatch ? Number.parseFloat(minMatch[1]) : 0;
        const total = Math.round((Number.isFinite(hours) ? hours * 60 : 0) + (Number.isFinite(minutes) ? minutes : 0));
        return total > 0 ? total : null;
      }

      const colonMatch = raw.match(/(?:^|T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (colonMatch) {
        const hours = Number(colonMatch[1] || 0);
        const minutes = Number(colonMatch[2] || 0);
        const seconds = Number(colonMatch[3] || 0);
        const total = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
        return total > 0 ? total : null;
      }

      return null;
    };

    const explicitDuration =
      parseDurationLikeValue(row?.duration)
      ?? parseDurationLikeValue(row?.hotspot_traveling_time)
      ?? parseDurationLikeValue(row?.hotspot_duration);

    if (explicitDuration !== null) {
      return explicitDuration;
    }

    if (row?.timeRange && String(row.timeRange).includes('-')) {
      const startMinutes = this.parsePreviewTimeToMinutes(
        String(row.timeRange).split('-')[0]?.trim() || '',
      );
      const endMinutes = this.parsePreviewTimeToMinutes(
        String(row.timeRange).split('-')[1]?.trim() || '',
      );

      if (startMinutes !== null && endMinutes !== null) {
        const diff = endMinutes >= startMinutes
          ? endMinutes - startMinutes
          : (24 * 60 - startMinutes) + endMinutes;
        return diff > 0 ? diff : null;
      }
    }

    return null;
  }

  public getPreviewRowDurationFromDurationFieldsOnly(row: any): number | null {
    const parseDurationValue = (value: any): number | null => {
      if (value == null) return null;

      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.max(1, Math.round(value));
      }

      const text = String(value).trim().toLowerCase();
      if (!text) return null;

      const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*h(?:our)?s?/i);
      const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*m(?:in)?s?/i);
      if (hourMatch || minuteMatch) {
        const hours = hourMatch ? Number.parseFloat(hourMatch[1]) : 0;
        const minutes = minuteMatch ? Number.parseFloat(minuteMatch[1]) : 0;
        const total = (Number.isFinite(hours) ? hours * 60 : 0) + (Number.isFinite(minutes) ? minutes : 0);
        if (total > 0) return Math.max(1, Math.round(total));
      }

      const numeric = Number.parseFloat(text.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      return Math.max(1, Math.round(numeric));
    };

    const parseTravelingTimeValue = (value: any): number | null => {
      if (value == null) return null;

      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const mins = (value.getHours() * 60) + value.getMinutes();
        return mins > 0 ? mins : null;
      }

      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        const mins = (parsed.getHours() * 60) + parsed.getMinutes();
        return mins > 0 ? mins : null;
      }

      return null;
    };

    return (
      parseDurationValue(row?.duration)
      || parseDurationValue(row?.visitDuration)
      || parseTravelingTimeValue(row?.hotspot_traveling_time)
      || null
    );
  }

  public getHotspotDurationMinutesFromMasterFirst(master: any, row: any): number | null {
    const masterDuration = master?.hotspot_duration ? this.timeToMinutes(master.hotspot_duration) : 0;
    if (masterDuration > 0) return masterDuration;

    return this.getHotspotDurationMinutes(master, row);
  }

  public minutesRangeToTimeString(startMinutes: number, endMinutes: number): string {
    const toTimeStr = (mins: number): string => {
      const roundedMins = Math.round(mins);
      const hours = Math.floor(roundedMins / 60) % 24;
      const mins_remainder = roundedMins % 60;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = hours % 12 === 0 ? 12 : hours % 12;
      return `${String(displayHours).padStart(1, '0')}:${String(mins_remainder).padStart(2, '0')} ${ampm}`;
    };

    return `${toTimeStr(startMinutes)} - ${toTimeStr(endMinutes)}`;
  }

  public minutesRangeToFitPreviewLabel(startMinutes: number, endMinutes: number): string {
    const format = (minutes: number): string => {
      const roundedMinutes = Math.round(minutes);
      const dayOffset = Math.floor(roundedMinutes / (24 * 60));
      const normalized = ((roundedMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
      const hours = Math.floor(normalized / 60) % 24;
      const minsRemainder = normalized % 60;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = hours % 12 === 0 ? 12 : hours % 12;
      const label = `${String(displayHours).padStart(1, '0')}:${String(minsRemainder).padStart(2, '0')} ${ampm}`;
      return dayOffset > 0 ? `${label} +${dayOffset}d` : label;
    };

    return `${format(startMinutes)} - ${format(endMinutes)}`;
  }

  public normalizeTravelLabelsToNextStop(timeline: any[]): any[] {
    const rows = Array.isArray(timeline) ? timeline : [];
    if (rows.length === 0) return rows;

    const isTravelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };
    const isAttractionRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isHotelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
    };
    const stopLabel = (row: any, fallback: string): string => {
      if (!row) return fallback;
      if (isHotelRow(row)) {
        const raw = String(row?.text || row?.name || '').trim();
        const match = raw.match(/check-?in\s+at\s+(.+)/i);
        const hotelName = String(match?.[1] || '').trim();
        return hotelName && hotelName.toLowerCase() !== 'hotel' ? hotelName : 'Hotel';
      }
      return String(row?.text || row?.name || fallback).trim();
    };

    return rows.map((row: any, idx: number) => {
      if (!isTravelRow(row)) return row;

      const prevStop = [...rows]
        .slice(0, idx)
        .reverse()
        .find((candidate: any) => isAttractionRow(candidate) || isHotelRow(candidate));
      const nextStop = [...rows]
        .slice(idx + 1)
        .find((candidate: any) => isAttractionRow(candidate) || isHotelRow(candidate));
      const fromLabel = stopLabel(prevStop, 'Hotel / Route Start');
      const toLabel = stopLabel(nextStop, 'Hotel');
      const travelToHotel = isHotelRow(nextStop);

      return {
        ...row,
        type: 'travel',
        item_type: travelToHotel ? 5 : Number(row?.item_type || 3),
        text: `Travel to ${toLabel}`,
        name: `Travel to ${toLabel}`,
        fromName: fromLabel,
        toName: toLabel,
        from: fromLabel,
        to: toLabel,
        displayFromName: fromLabel,
        displayToName: toLabel,
        isMatrixReconnectedTravel: true,
      };
    });
  }
}
