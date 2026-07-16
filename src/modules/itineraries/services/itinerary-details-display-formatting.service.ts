/** Pure date, clock and duration formatting policy for itinerary details. */
export class ItineraryDetailsDisplayFormattingService {
  public pad2(n: number): string {
    return String(n).padStart(2, '0');
  }

  public formatDbDateOnly(value?: Date | string | null): string {
    if (!value) return '';

    if (typeof value === 'string') {
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (match) return `${match[1]}-${match[2]}-${match[3]}`;

      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return '';

      return `${parsed.getUTCFullYear()}-${this.pad2(parsed.getUTCMonth() + 1)}-${this.pad2(
        parsed.getUTCDate(),
      )}`;
    }

    if (Number.isNaN(value.getTime())) return '';

    return `${value.getUTCFullYear()}-${this.pad2(value.getUTCMonth() + 1)}-${this.pad2(
      value.getUTCDate(),
    )}`;
  }

  public formatCreatedOn(d?: Date | string | null): string {
    const dt = d instanceof Date ? d : d ? new Date(d) : null;
    if (!dt || isNaN(dt.getTime())) return '';
    const weekday = dt.toLocaleString('en-US', { weekday: 'short' });
    const month = dt.toLocaleString('en-US', { month: 'short' });
    return `${weekday}, ${month} ${this.pad2(dt.getDate())}, ${dt.getFullYear()}`;
  }

  public formatTripDateTime(d?: Date | string | null): string | null {
    return this.formatUtcClock(d);
  }

  public formatTime(d?: Date | string | null): string | null {
    return this.formatUtcClock(d);
  }

  public formatDuration(d?: Date | string | null): string | null {
    if (!d) return null;
    let totalMinutes: number | null = null;

    if (d instanceof Date) {
      if (isNaN(d.getTime())) return null;
      totalMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    } else if (typeof d === 'string') {
      const raw = d.trim();
      const hhmmss = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);

      if (hhmmss) {
        totalMinutes = Number(hhmmss[1]) * 60 + Number(hhmmss[2]);
      } else {
        const dt = new Date(raw);
        if (!isNaN(dt.getTime())) {
          totalMinutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();
        }
      }
    }

    if (totalMinutes === null || totalMinutes <= 0) return null;

    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h > 0 && m > 0) return `${h} Hours ${m} Min`;
    if (h > 0) return `${h} Hours`;
    return `${m} Min`;
  }

  private formatUtcClock(d?: Date | string | null): string | null {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return null;

    let hh = dt.getUTCHours();
    const mm = this.pad2(dt.getUTCMinutes());
    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12;
    if (hh === 0) hh = 12;

    return `${this.pad2(hh)}:${mm} ${ampm}`;
  }
}
