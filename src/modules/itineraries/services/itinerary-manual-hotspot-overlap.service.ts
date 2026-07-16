import { Injectable } from '@nestjs/common';
import { TimeConverter } from '../engines/helpers/time-converter';

@Injectable()
export class ItineraryManualHotspotOverlapService {
  private hmsToSeconds(value: string): number {
    const parts = String(value || '').split(':').map(Number);
    if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return NaN;
    return (parts[0] * 3600) + (parts[1] * 60) + (parts[2] || 0);
  }

  async hasAnyNonOverlappingManualRow(
    tx: any,
    planId: number,
    routeId: number,
    rows: any[],
  ): Promise<boolean> {
    for (const row of rows) {
      if (await this.manualRowHasNoOverlap(tx, planId, routeId, row)) return true;
    }
    return false;
  }

  async manualRowHasNoOverlap(
    tx: any,
    planId: number,
    routeId: number,
    row: any,
  ): Promise<boolean> {
    const startSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_start_time));
    const endSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_end_time));

    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return false;

    const otherRows = await tx.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        route_hotspot_ID: { not: Number(row?.route_hotspot_ID || 0) },
      },
      select: { hotspot_start_time: true, hotspot_end_time: true, is_conflict: true },
    });

    return !(otherRows || []).some((other: any) => {
      if (Number(other?.is_conflict || 0) === 1) return false;

      const otherStart = this.hmsToSeconds(TimeConverter.toTimeString(other?.hotspot_start_time));
      const otherEnd = this.hmsToSeconds(TimeConverter.toTimeString(other?.hotspot_end_time));
      if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd) || otherEnd <= otherStart) return false;

      return startSec < otherEnd && endSec > otherStart;
    });
  }
}
