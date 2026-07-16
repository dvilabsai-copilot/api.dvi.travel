import { Injectable } from '@nestjs/common';

type Callbacks = {
  computeRowDurationMinutes?: (...args: any[]) => number;
};

@Injectable()
export class ItineraryManualHotspotRowService {
  private callbacks: Callbacks = {};

  setCallbacks(callbacks: Callbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  async removeRouteHotspotFromExcludedList(tx: any, routeId: number, hotspotId: number, routeRow?: any): Promise<void> {
    const route = routeRow || await (tx as any).dvi_itinerary_route_details.findUnique({ where: { itinerary_route_ID: Number(routeId) } });
    const rawExcluded = Array.isArray(route?.excluded_hotspot_ids) ? route.excluded_hotspot_ids : [];
    const filteredExcluded = rawExcluded.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0 && id !== Number(hotspotId));
    if (filteredExcluded.length !== rawExcluded.length) {
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: Number(routeId) },
        data: { excluded_hotspot_ids: filteredExcluded, updatedon: new Date() },
      });
    }
  }

  async addRouteHotspotToExcludedList(tx: any, routeId: number, hotspotId: number): Promise<void> {
    const route = await (tx as any).dvi_itinerary_route_details.findUnique({ where: { itinerary_route_ID: Number(routeId) } });
    const current = Array.isArray(route?.excluded_hotspot_ids)
      ? route.excluded_hotspot_ids.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
      : [];
    if (!current.includes(Number(hotspotId))) {
      current.push(Number(hotspotId));
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: Number(routeId) },
        data: { excluded_hotspot_ids: current, updatedon: new Date() },
      });
    }
  }

  async ensureManualHotspotRow(tx: any, planId: number, routeId: number, hotspotId: number, userId: number): Promise<{ alreadyExisted: boolean }> {
    const existingRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), hotspot_ID: Number(hotspotId), item_type: 4, deleted: 0 },
      orderBy: [{ route_hotspot_ID: 'desc' }],
      select: { route_hotspot_ID: true, hotspot_plan_own_way: true, hotspot_start_time: true, hotspot_end_time: true, status: true, is_conflict: true },
    });
    const duration = this.callbacks.computeRowDurationMinutes || (() => 0);
    const validExisting = (existingRows || []).find((row: any) => Number(row?.status || 0) === 1 && duration(row) > 0 && Number(row?.is_conflict || 0) !== 1);
    if (validExisting) {
      if (Number(validExisting.hotspot_plan_own_way || 0) !== 1) {
        await (tx as any).dvi_itinerary_route_hotspot_details.update({
          where: { route_hotspot_ID: Number(validExisting.route_hotspot_ID) },
          data: { hotspot_plan_own_way: 1, updatedon: new Date() },
        });
      }
      return { alreadyExisted: true };
    }
    const staleActiveIds = (existingRows || [])
      .filter((row: any) => Number(row?.status || 0) === 1 && Number(row?.hotspot_plan_own_way || 0) === 1 && duration(row) <= 0)
      .map((row: any) => Number(row?.route_hotspot_ID || 0))
      .filter((id: number) => id > 0);
    if (staleActiveIds.length > 0) {
      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: { route_hotspot_ID: { in: staleActiveIds } },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
    }
    const placeholderTime = new Date('1970-01-01T00:00:00Z');
    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: 999,
        hotspot_start_time: placeholderTime,
        hotspot_end_time: placeholderTime,
        createdby: Number(userId || 1),
        createdon: new Date(),
        status: 0,
        deleted: 1,
      },
    });
    return { alreadyExisted: false };
  }
}
