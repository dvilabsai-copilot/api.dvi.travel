import { normalizeTimeRange, timeToSeconds } from './time.helper';

export type TimingMap = Map<number, Map<number, any[]>>;

export class TimelineOperatingHoursService {
  formatTimingTime(value: any): string | null {
    if (!value) return null;
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      const hhmmss = trimmed.match(/(\d{2}:\d{2}:\d{2})/);
      if (hhmmss?.[1]) return hhmmss[1];
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return `${String(parsed.getUTCHours()).padStart(2, '0')}:${String(parsed.getUTCMinutes()).padStart(2, '0')}:${String(parsed.getUTCSeconds()).padStart(2, '0')}`;
      }
      return null;
    }
    if (value instanceof Date || (typeof value === 'object' && typeof value.getUTCHours === 'function')) {
      return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
    }
    return null;
  }

  getTimingWindowSummary(timingMap: TimingMap, hotspotId: number, dayOfWeek: number): { openingTime: string | null; closingTime: string | null } {
    const timingRecords = timingMap.get(hotspotId)?.get(dayOfWeek) || [];
    if (!timingRecords.length) return { openingTime: null, closingTime: null };
    let openingTime: string | null = null;
    let closingTime: string | null = null;
    for (const timing of timingRecords) {
      if (Number(timing?.hotspot_closed || 0) === 1) continue;
      if (Number(timing?.hotspot_open_all_time || 0) === 1) return { openingTime: '00:00:00', closingTime: '23:59:59' };
      const start = this.formatTimingTime(timing?.hotspot_start_time);
      const end = this.formatTimingTime(timing?.hotspot_end_time);
      if (!start || !end) continue;
      if (!openingTime || timeToSeconds(start) < timeToSeconds(openingTime)) openingTime = start;
      if (!closingTime || timeToSeconds(end) > timeToSeconds(closingTime)) closingTime = end;
    }
    return { openingTime, closingTime };
  }

  isHotspotClosedOnDay(timingMap: TimingMap, hotspotId: number, dayOfWeek: number): boolean {
    const timingRecords = timingMap.get(hotspotId)?.get(dayOfWeek) || [];
    return timingRecords.length > 0 && timingRecords.every((timing) => Number(timing?.hotspot_closed || 0) === 1);
  }

  isHotspotClosedOnAllDays(timingMap: TimingMap, hotspotId: number): boolean {
    const dayMap = timingMap.get(hotspotId);
    if (!dayMap || dayMap.size === 0) return false;
    const allRows = Array.from(dayMap.values()).flat();
    return allRows.length > 0 && allRows.every((timing) => Number(timing?.hotspot_closed || 0) === 1);
  }

  checkHotspotOperatingHoursFromMap(timingMap: TimingMap, hotspotId: number, dayOfWeek: number, visitStartSeconds: number, visitEndSeconds: number): { canVisitNow: boolean; nextWindowStart: string | null; isClosedForDay: boolean } {
    const timingRecords = timingMap.get(hotspotId)?.get(dayOfWeek) || [];
    if (!timingRecords.length) return { canVisitNow: false, nextWindowStart: null, isClosedForDay: true };
    let nextWindowStart: string | null = null;
    let hasUsableOpenWindow = false;
    for (const timing of timingRecords) {
      if (Number(timing?.hotspot_closed || 0) === 1) continue;
      hasUsableOpenWindow = true;
      if (Number(timing?.hotspot_open_all_time || 0) === 1) return { canVisitNow: true, nextWindowStart: null, isClosedForDay: false };
      const operatingStart = this.formatTimingTime(timing?.hotspot_start_time) || '00:00:00';
      const operatingEnd = this.formatTimingTime(timing?.hotspot_end_time) || '23:59:59';
      const opStartSeconds = timeToSeconds(operatingStart);
      const { absoluteEndSeconds: opAbsoluteEnd } = normalizeTimeRange(opStartSeconds, timeToSeconds(operatingEnd));
      if (visitStartSeconds >= opStartSeconds && visitEndSeconds <= opAbsoluteEnd) return { canVisitNow: true, nextWindowStart: null, isClosedForDay: false };
      if (opStartSeconds > visitStartSeconds && (nextWindowStart === null || opStartSeconds < timeToSeconds(nextWindowStart))) nextWindowStart = operatingStart;
    }
    return { canVisitNow: false, nextWindowStart, isClosedForDay: !hasUsableOpenWindow };
  }
}
