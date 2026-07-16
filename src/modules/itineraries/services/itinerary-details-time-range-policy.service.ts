/** Pure display-time range and duration policy for itinerary details. */
export class ItineraryDetailsTimeRangePolicyService {
  public timeToMinutes(timeStr: string | null): number {
    if (!timeStr) return 0;

    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return 0;

    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const ampm = match[3].toUpperCase();

    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    return hours * 60 + minutes;
  }

  public parseDisplayTimeMinutesStrict(timeStr: string | null): number | null {
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

  public minutesToDisplayTime(minutes: number): string {
    const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
    let hh = Math.floor(normalized / 60);
    const mm = normalized % 60;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12;
    if (hh === 0) hh = 12;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${ampm}`;
  }

  public orderedTimeRange(startTimeText: string | null, endTimeText: string | null): string | null {
    if (!startTimeText || !endTimeText) return null;

    const startMins = this.parseDisplayTimeMinutesStrict(startTimeText);
    const endMins = this.parseDisplayTimeMinutesStrict(endTimeText);
    if (startMins === null || endMins === null) return `${startTimeText} - ${endTimeText}`;
    if (startMins <= endMins) return `${startTimeText} - ${endTimeText}`;
    return `${endTimeText} - ${startTimeText}`;
  }

  public getTravelTimeRangeWithDuration(
    startTimeText: string | null,
    endTimeText: string | null,
    durationRaw?: Date | string | null,
  ): string | null {
    const normalized = this.orderedTimeRange(startTimeText, endTimeText);
    if (!startTimeText) return normalized;

    const durationMinutes = this.durationToMinutes(durationRaw ?? null);
    if (!durationMinutes || durationMinutes <= 0) return normalized;

    const startMinutes = this.parseDisplayTimeMinutesStrict(startTimeText);
    const endMinutes = endTimeText ? this.parseDisplayTimeMinutesStrict(endTimeText) : null;
    if (startMinutes === null) return normalized;

    if (endMinutes === null || endMinutes === startMinutes) {
      const computedEnd = this.minutesToDisplayTime(startMinutes + durationMinutes);
      return this.orderedTimeRange(startTimeText, computedEnd);
    }

    return normalized;
  }

  public formatDurationFromDisplayRange(startTimeText: string | null, endTimeText: string | null): string | null {
    if (!startTimeText || !endTimeText) return null;

    const startMins = this.parseDisplayTimeMinutesStrict(startTimeText);
    const endMins = this.parseDisplayTimeMinutesStrict(endTimeText);
    if (startMins === null || endMins === null) return null;

    let delta = endMins - startMins;
    if (delta < 0) delta += 1440;
    if (delta <= 0) return null;

    const h = Math.floor(delta / 60);
    const m = delta % 60;
    if (h > 0 && m > 0) return `${h} Hours ${m} Min`;
    if (h > 0) return `${h} Hours`;
    return `${m} Min`;
  }

  private durationToMinutes(d?: Date | string | null): number | null {
    if (!d) return null;
    if (d instanceof Date) {
      if (isNaN(d.getTime())) return null;
      const total = d.getUTCHours() * 60 + d.getUTCMinutes();
      return total > 0 ? total : null;
    }

    if (typeof d === 'string') {
      const raw = d.trim();
      const hhmmss = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (hhmmss) {
        const total = Number(hhmmss[1]) * 60 + Number(hhmmss[2]);
        return total > 0 ? total : null;
      }
      const dt = new Date(raw);
      if (!isNaN(dt.getTime())) {
        const total = dt.getUTCHours() * 60 + dt.getUTCMinutes();
        return total > 0 ? total : null;
      }
    }

    return null;
  }
}
