import { Injectable } from '@nestjs/common';

@Injectable()
export class ItineraryDetailsTimelinePresentationService {
  private parseDisplayTimeMinutesStrict(timeStr: string | null): number | null {
    if (!timeStr) return null;
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const ampm = match[3].toUpperCase();
    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  private minutesToDisplayTime(minutes: number): string {
    const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
    let hours = Math.floor(normalized / 60);
    const minutePart = normalized % 60;
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours %= 12;
    if (hours === 0) hours = 12;
    return `${String(hours).padStart(2, '0')}:${String(minutePart).padStart(2, '0')} ${ampm}`;
  }

  private extractRangeFromSegment(seg: any): {
    field: 'timeRange' | 'visitTime';
    suffix: string;
    start: number;
    end: number;
  } | null {
    if (!seg) return null;
    const field: 'timeRange' | 'visitTime' | null =
      seg.type === 'attraction' ? 'visitTime' :
      (seg.type === 'start' || seg.type === 'travel' || seg.type === 'return' || seg.type === 'break') ? 'timeRange' :
      null;
    if (!field || typeof seg[field] !== 'string') return null;
    const raw = String(seg[field]);
    const suffixStart = raw.indexOf(' (');
    const core = (suffixStart >= 0 ? raw.slice(0, suffixStart) : raw).trim();
    const suffix = suffixStart >= 0 ? raw.slice(suffixStart) : '';
    const parts = core.split(' - ').map((part) => part.trim());
    if (parts.length !== 2) return null;
    const start = this.parseDisplayTimeMinutesStrict(parts[0]);
    const end = this.parseDisplayTimeMinutesStrict(parts[1]);
    return start === null || end === null ? null : { field, suffix, start, end };
  }

  normalizeSegmentChronology(segments: any[]): void {
    let previousEnd: number | null = null;
    for (const segment of segments || []) {
      if (segment?.type === 'checkin' && typeof segment.time === 'string') {
        const checkinTime = this.parseDisplayTimeMinutesStrict(String(segment.time).trim());
        if (checkinTime !== null) {
          const normalized = previousEnd !== null && checkinTime < previousEnd ? previousEnd : checkinTime;
          segment.time = this.minutesToDisplayTime(normalized);
          previousEnd = normalized;
        }
        continue;
      }

      const parsed = this.extractRangeFromSegment(segment);
      if (!parsed) continue;
      let start = parsed.start;
      let end = parsed.end;
      if (end < start) end += 24 * 60;
      if (segment?.type === 'attraction') {
        previousEnd = end;
        continue;
      }
      if (segment?.type === 'break') {
        if (previousEnd !== null && start < previousEnd) start = previousEnd;
        if (end < start) end = start;
        segment[parsed.field] = `${this.minutesToDisplayTime(start)} - ${this.minutesToDisplayTime(end)}${parsed.suffix}`;
        previousEnd = end;
        continue;
      }
      if (previousEnd !== null && start < previousEnd) {
        const duration = Math.max(0, end - start);
        start = previousEnd;
        end = start + duration;
      }
      segment[parsed.field] = `${this.minutesToDisplayTime(start)} - ${this.minutesToDisplayTime(end)}${parsed.suffix}`;
      previousEnd = end;
    }
  }

  normalizeConfirmedTravelLabelsFromSequence(segments: any[], fallbackHotelName?: string | null): any[] {
    const rows = Array.isArray(segments) ? segments : [];
    if (rows.length === 0) return rows;
    const clean = (value?: string | null) => String(value ?? '').trim();
    const lower = (value?: string | null) => clean(value).toLowerCase();
    const canonical = (value?: string | null) => clean(value)
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\s*\([^)]*\)\s*$/g, '').trim();
    const attractionName = (row: any) => canonical(row?.name || row?.text);
    const checkinName = (row: any) => clean(row?.hotelName) || clean(fallbackHotelName) || 'Hotel';
    const travelFrom = (row: any) => clean(row?.from) || clean(row?.fromName) || clean(row?.displayFromName);
    const travelTo = (row: any) => clean(row?.to) || clean(row?.toName) || clean(row?.displayToName);
    const isAttraction = (row: any) => row?.type === 'attraction';
    const isTravel = (row: any) => row?.type === 'travel';
    const isCheckin = (row: any) => row?.type === 'checkin';
    const previousVisibleStop = (index: number) => {
      for (let i = index - 1; i >= 0; i -= 1) {
        const row = rows[i];
        const name = isAttraction(row) ? attractionName(row) : isCheckin(row) ? checkinName(row) : '';
        if (name) return name;
      }
      return '';
    };
    const nextSemanticStop = (index: number): { type: 'attraction' | 'checkin'; name: string } | null => {
      for (let i = index + 1; i < rows.length; i += 1) {
        const row = rows[i];
        if (isAttraction(row)) {
          const name = attractionName(row);
          if (name) return { type: 'attraction', name };
        } else if (isCheckin(row)) {
          const name = checkinName(row);
          if (name) return { type: 'checkin', name };
        }
      }
      return null;
    };

    let previousStopName = '';
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (isAttraction(row)) {
        previousStopName = attractionName(row) || previousStopName;
        continue;
      }
      if (isCheckin(row)) {
        previousStopName = checkinName(row) || previousStopName;
        continue;
      }
      if (!isTravel(row)) continue;
      const persistedFrom = travelFrom(row);
      const persistedTo = travelTo(row);
      if (!previousStopName) previousStopName = persistedFrom || previousVisibleStop(index);
      const nextStop = nextSemanticStop(index);
      const nextName = clean(nextStop?.name);
      let resolvedFrom = clean(previousStopName) || persistedFrom || 'Route Start';
      let resolvedTo = nextName || persistedTo || clean(fallbackHotelName) || 'Hotel';
      if (nextStop?.type === 'attraction' && nextName && lower(resolvedTo) === lower(clean(fallbackHotelName) || '')) resolvedTo = nextName;
      if (nextStop?.type === 'attraction' && clean(fallbackHotelName) && resolvedFrom && lower(resolvedFrom) !== lower(clean(fallbackHotelName)) && lower(clean(fallbackHotelName)).includes(lower(resolvedFrom))) {
        resolvedFrom = clean(fallbackHotelName);
      }
      row.from = resolvedFrom;
      row.to = resolvedTo;
      row.fromName = resolvedFrom;
      row.toName = resolvedTo;
      row.displayFromName = resolvedFrom;
      row.displayToName = resolvedTo;
      row.text = `Travelling from ${resolvedFrom} to ${resolvedTo}`;
      previousStopName = resolvedTo;
    }
    return rows;
  }
}
