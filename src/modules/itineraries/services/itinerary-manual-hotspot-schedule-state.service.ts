import { Injectable } from '@nestjs/common';
import { TimeConverter } from '../engines/helpers/time-converter';

type Callbacks = {
  computeRowDurationMinutes?: (...args: any[]) => number;
  hasAnyNonOverlappingManualRow?: (...args: any[]) => Promise<boolean>;
  manualRowHasNoOverlap?: (...args: any[]) => Promise<boolean>;
};

@Injectable()
export class ItineraryManualHotspotScheduleStateService {
  private callbacks: Callbacks = {};

  setCallbacks(callbacks: Callbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private hmsToSeconds(value: string): number {
    const [h, m, s] = String(value || '00:00:00').split(':').map((part) => Number(part || 0));
    return (Number.isFinite(h) ? h : 0) * 3600
      + (Number.isFinite(m) ? m : 0) * 60
      + (Number.isFinite(s) ? s : 0);
  }

  async isManualHotspotScheduled(tx: any, planId: number, routeId: number, hotspotId: number): Promise<boolean> {
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        hotspot_plan_own_way: 1,
        deleted: 0,
      },
      select: { route_hotspot_ID: true, hotspot_start_time: true, hotspot_end_time: true, is_conflict: true },
    });
    const computeDuration = this.callbacks.computeRowDurationMinutes || (() => 0);
    const scheduledRows = (rows || []).filter((row: any) => computeDuration(row) > 0 && Number(row?.is_conflict || 0) !== 1);
    if (scheduledRows.length === 0) return false;

    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: Number(routeId), itinerary_plan_ID: Number(planId), deleted: 0 },
      select: { itinerary_route_date: true },
    });
    const fallback = this.callbacks.hasAnyNonOverlappingManualRow || (async () => true);
    if (!route?.itinerary_route_date) return fallback(tx, Number(planId), Number(routeId), scheduledRows);

    const timingDay = (new Date(route.itinerary_route_date).getDay() + 6) % 7;
    const timings = await (tx as any).dvi_hotspot_timing.findMany({
      where: { hotspot_ID: Number(hotspotId), hotspot_timing_day: Number(timingDay), deleted: 0, status: 1 },
      select: { hotspot_open_all_time: true, hotspot_start_time: true, hotspot_end_time: true },
    });
    if (!Array.isArray(timings) || timings.length === 0 || timings.some((timing: any) => Number(timing?.hotspot_open_all_time || 0) === 1)) {
      return fallback(tx, Number(planId), Number(routeId), scheduledRows);
    }

    const noOverlap = this.callbacks.manualRowHasNoOverlap || (async () => true);
    for (const row of scheduledRows) {
      const startSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_start_time));
      const endSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_end_time));
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) continue;
      const fitsOperatingHours = timings.some((timing: any) => {
        if (!timing?.hotspot_start_time || !timing?.hotspot_end_time) return false;
        const opening = this.hmsToSeconds(TimeConverter.toTimeString(timing.hotspot_start_time));
        const closing = this.hmsToSeconds(TimeConverter.toTimeString(timing.hotspot_end_time));
        if (closing < opening) {
          return (startSec >= opening && endSec >= startSec) || (startSec <= closing && endSec <= closing);
        }
        return startSec >= opening && endSec <= closing;
      });
      if (fitsOperatingHours && await noOverlap(tx, Number(planId), Number(routeId), row)) return true;
    }
    return false;
  }
}
