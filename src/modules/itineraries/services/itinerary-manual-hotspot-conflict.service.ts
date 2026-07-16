import { Injectable } from '@nestjs/common';

@Injectable()
export class ItineraryManualHotspotConflictService {
  private minutesToUtcTimeDate(minutes: number): Date {
    const date = new Date(Date.UTC(1970, 0, 1));
    date.setUTCMinutes(Math.max(0, Math.round(minutes)));
    return date;
  }

  async forceInsertManualHotspotConflictRow(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
    userId: number,
    preferredTimes?: { start: Date; end: Date },
    minutesToUtcTimeDate: (...args: any[]) => Date = (minutes) => this.minutesToUtcTimeDate(minutes),
  ): Promise<boolean> {
    const existing = await tx.dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        deleted: 0,
      },
      select: { route_hotspot_ID: true },
    });

    if (existing) {
      const preferredDuration = preferredTimes?.start && preferredTimes?.end
        ? Math.max(1, Math.round((preferredTimes.end.getTime() - preferredTimes.start.getTime()) / 60000))
        : 0;

      await tx.dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(existing.route_hotspot_ID) },
        data: {
          hotspot_plan_own_way: 1,
          hotspot_start_time: preferredTimes?.start || undefined,
          hotspot_end_time: preferredTimes?.end || undefined,
          hotspot_traveling_time: preferredDuration > 0 ? minutesToUtcTimeDate(preferredDuration) : undefined,
          is_conflict: 1,
          conflict_reason: 'Forced manual insertion after user confirmation.',
          updatedon: new Date(),
        },
      });
      return true;
    }

    const route = await tx.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
      select: { route_start_time: true, route_end_time: true },
    });

    const fallbackStartTime = preferredTimes?.start || route?.route_end_time || route?.route_start_time || new Date('1970-01-01T00:00:00Z');
    const fallbackEndTime = preferredTimes?.end || fallbackStartTime;
    const fallbackDurationMinutes = Math.max(1, Math.round((fallbackEndTime.getTime() - fallbackStartTime.getTime()) / 60000));

    const currentMaxOrderRow = await tx.dvi_itinerary_route_hotspot_details.findFirst({
      where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), deleted: 0 },
      orderBy: { hotspot_order: 'desc' },
      select: { hotspot_order: true },
    });
    const nextOrder = Number(currentMaxOrderRow?.hotspot_order || 0) + 1;

    await tx.dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: Number.isFinite(nextOrder) && nextOrder > 0 ? nextOrder : 999,
        hotspot_start_time: fallbackStartTime,
        hotspot_end_time: fallbackEndTime,
        hotspot_traveling_time: minutesToUtcTimeDate(fallbackDurationMinutes),
        is_conflict: 1,
        conflict_reason: 'Forced manual insertion after user confirmation.',
        createdby: Number(userId || 1),
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    return true;
  }
}
