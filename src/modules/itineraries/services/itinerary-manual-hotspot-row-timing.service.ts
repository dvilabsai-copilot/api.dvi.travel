import { ConflictException, Injectable } from '@nestjs/common';

type RowTimingCallbacks = {
  normalizeManualHotspotIds: (...args: any[]) => number[];
  computeRowDurationMinutes: (...args: any[]) => number;
  minutesToUtcTimeDate: (...args: any[]) => Date;
};

@Injectable()
export class ItineraryManualHotspotRowTimingService {
  private callbacks: RowTimingCallbacks = {
    normalizeManualHotspotIds: (ids: any[]) => (ids || []).map(Number).filter((id) => id > 0),
    computeRowDurationMinutes: (row: any) => Math.round(
      (new Date(row?.hotspot_end_time).getTime() - new Date(row?.hotspot_start_time).getTime()) / 60000,
    ),
    minutesToUtcTimeDate: (minutes: number) => {
      const date = new Date(Date.UTC(1970, 0, 1));
      date.setUTCMinutes(minutes);
      return date;
    },
  };

  setCallbacks(callbacks: Partial<RowTimingCallbacks>) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  async cleanupStaleManualHotspotRows(
    prisma: any,
    planId: number,
    routeId: number,
    hotspotIds: number[],
  ): Promise<void> {
    const normalizedHotspotIds = this.callbacks.normalizeManualHotspotIds(hotspotIds);
    if (normalizedHotspotIds.length === 0) return;

    const rows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: { in: normalizedHotspotIds },
        item_type: 4,
        hotspot_plan_own_way: 1,
        deleted: 0,
        status: 1,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
    });

    const staleIds = (rows || [])
      .filter((row: any) => this.callbacks.computeRowDurationMinutes(row) <= 0)
      .map((row: any) => Number(row?.route_hotspot_ID || 0))
      .filter((id: number) => id > 0);

    if (staleIds.length === 0) return;

    await prisma.dvi_itinerary_route_hotspot_details.updateMany({
      where: { route_hotspot_ID: { in: staleIds } },
      data: { status: 0, deleted: 1, updatedon: new Date() },
    });
  }

  async activateManualHotspotRowWithTimes(
    tx: any,
    params: {
      planId: number;
      routeId: number;
      hotspotId: number;
      userId: number;
      start: Date;
      end: Date;
      hotspotOrder?: number;
    },
  ): Promise<number> {
    const durationMinutes = Math.round((params.end.getTime() - params.start.getTime()) / 60000);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MANUAL_HOTSPOT_INVALID_TIMING_WINDOW',
        message: 'Cannot activate manual hotspot row with zero/negative duration.',
      });
    }

    const existingRows = await tx.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(params.planId),
        itinerary_route_ID: Number(params.routeId),
        hotspot_ID: Number(params.hotspotId),
        item_type: 4,
      },
      orderBy: [{ route_hotspot_ID: 'desc' }],
      select: { route_hotspot_ID: true },
    });

    const keepRowId = Number(existingRows?.[0]?.route_hotspot_ID || 0);
    const hotspotOrder = Number.isFinite(Number(params.hotspotOrder || 0)) && Number(params.hotspotOrder || 0) > 0
      ? Number(params.hotspotOrder)
      : undefined;

    if (keepRowId > 0) {
      await tx.dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: keepRowId },
        data: {
          hotspot_plan_own_way: 1,
          hotspot_start_time: params.start,
          hotspot_end_time: params.end,
          hotspot_traveling_time: this.callbacks.minutesToUtcTimeDate(Math.max(1, durationMinutes)),
          hotspot_order: hotspotOrder,
          status: 1,
          deleted: 0,
          is_conflict: 0,
          conflict_reason: null,
          updatedon: new Date(),
        },
      });

      const staleIds = (existingRows || [])
        .slice(1)
        .map((row: any) => Number(row?.route_hotspot_ID || 0))
        .filter((id: number) => id > 0);
      if (staleIds.length > 0) {
        await tx.dvi_itinerary_route_hotspot_details.updateMany({
          where: { route_hotspot_ID: { in: staleIds } },
          data: { status: 0, deleted: 1, updatedon: new Date() },
        });
      }
      return keepRowId;
    }

    const created = await tx.dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(params.planId),
        itinerary_route_ID: Number(params.routeId),
        hotspot_ID: Number(params.hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: hotspotOrder || 999,
        hotspot_start_time: params.start,
        hotspot_end_time: params.end,
        hotspot_traveling_time: this.callbacks.minutesToUtcTimeDate(Math.max(1, durationMinutes)),
        createdby: Number(params.userId || 1),
        createdon: new Date(),
        status: 1,
        deleted: 0,
        is_conflict: 0,
        conflict_reason: null,
      },
      select: { route_hotspot_ID: true },
    });

    return Number(created?.route_hotspot_ID || 0);
  }
}
