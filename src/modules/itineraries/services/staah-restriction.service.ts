import { Injectable } from '@nestjs/common';

export interface StaahRestrictionDecision {
  blocked: boolean;
  reason: string | null;
  availableAgainFrom: string | null;
}

/** Evaluates STAAH rate restrictions against a requested stay window. */
@Injectable()
export class StaahRestrictionService {
  evaluate(
    rows: any[],
    checkInDate: Date,
    checkOutDate: Date,
    lengthOfStay: number,
  ): StaahRestrictionDecision {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { blocked: false, reason: null, availableAgainFrom: null };
    }

    const checkInLabel = this.formatDateOnly(checkInDate);
    const checkOutLabel = this.formatDateOnly(checkOutDate);
    const stayEndDate = this.addDays(checkOutDate, -1);
    const stayEndLabel = this.formatDateOnly(stayEndDate);
    const overlapsStay = (row: any): boolean => {
      const rowStart = this.toIstDateOnly(row.start_date);
      const rowEnd = this.toIstDateOnly(row.end_date);
      return rowStart.getTime() <= stayEndDate.getTime() && rowEnd.getTime() >= checkInDate.getTime();
    };
    const activeOnDate = (row: any, date: Date): boolean => {
      const rowStart = this.toIstDateOnly(row.start_date);
      const rowEnd = this.toIstDateOnly(row.end_date);
      return rowStart.getTime() <= date.getTime() && rowEnd.getTime() >= date.getTime();
    };
    const numericValuesFor = (type: string, matcher: (row: any) => boolean): number[] =>
      rows
        .filter((row) => this.normalizeType(row.type) === type && matcher(row))
        .map((row) => Number(row.value))
        .filter((value) => Number.isFinite(value));

    for (const row of rows) {
      const type = this.normalizeType(row.type);
      if (!this.isTruthy(row.value)) continue;

      if ((type === 'stopsell' || type === 'status') && overlapsStay(row)) {
        return {
          blocked: true,
          reason:
            type === 'status'
              ? `status close active during stay ${checkInLabel} to ${stayEndLabel}`
              : `stop sell active during stay ${checkInLabel} to ${stayEndLabel}`,
          availableAgainFrom: this.availableAgainFrom(row),
        };
      }
      if (type === 'cta' && activeOnDate(row, checkInDate)) {
        return {
          blocked: true,
          reason: `CTA active on check-in date ${checkInLabel}`,
          availableAgainFrom: this.availableAgainFrom(row),
        };
      }
      if (type === 'ctd' && activeOnDate(row, checkOutDate)) {
        return {
          blocked: true,
          reason: `CTD active on check-out date ${checkOutLabel}`,
          availableAgainFrom: this.availableAgainFrom(row),
        };
      }
    }

    const minStay = Math.max(...numericValuesFor('minstay', (row) => activeOnDate(row, checkInDate)), 0);
    if (minStay > 0 && lengthOfStay < minStay) {
      return { blocked: true, reason: `minimum stay ${minStay} nights required for LOS ${lengthOfStay}`, availableAgainFrom: null };
    }

    const maxStay = Math.min(...numericValuesFor('maxstay', (row) => activeOnDate(row, checkInDate)), Number.POSITIVE_INFINITY);
    if (Number.isFinite(maxStay) && lengthOfStay > maxStay) {
      return { blocked: true, reason: `maximum stay ${maxStay} nights allows LOS ${lengthOfStay}`, availableAgainFrom: null };
    }

    const minStayThrough = Math.max(...numericValuesFor('minstay_through', overlapsStay), 0);
    if (minStayThrough > 0 && lengthOfStay < minStayThrough) {
      return { blocked: true, reason: `minimum stay through ${minStayThrough} nights required for LOS ${lengthOfStay}`, availableAgainFrom: null };
    }

    const maxStayThrough = Math.min(...numericValuesFor('maxstay_through', overlapsStay), Number.POSITIVE_INFINITY);
    if (Number.isFinite(maxStayThrough) && lengthOfStay > maxStayThrough) {
      return { blocked: true, reason: `maximum stay through ${maxStayThrough} nights allows LOS ${lengthOfStay}`, availableAgainFrom: null };
    }

    return { blocked: false, reason: null, availableAgainFrom: null };
  }

  private availableAgainFrom(row: any): string | null {
    if (!row?.end_date) return null;
    return this.formatDateOnly(this.addDays(this.toIstDateOnly(row.end_date), 1));
  }

  private isTruthy(value: unknown): boolean {
    return ['1', 'true', 'yes', 'y', 'close', 'closed'].includes(String(value ?? '').trim().toLowerCase());
  }

  private normalizeType(value: unknown): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'status') return 'status';
    if (normalized.includes('stopsell') || normalized.includes('stop_sell')) return 'stopsell';
    return normalized;
  }

  private toIstDateOnly(value: unknown): Date {
    const raw = new Date(String(value || ''));
    if (Number.isNaN(raw.getTime())) throw new Error(`Invalid route date: ${String(value || '')}`);
    const istMoment = new Date(raw.getTime() + 5.5 * 60 * 60 * 1000);
    return new Date(Date.UTC(istMoment.getUTCFullYear(), istMoment.getUTCMonth(), istMoment.getUTCDate()));
  }

  private formatDateOnly(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }
}
