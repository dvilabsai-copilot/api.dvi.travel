import { Injectable } from '@nestjs/common';

type Callbacks = {
  normalizeManualHotspotIds?: (...args: any[]) => number[];
  normalizeHotspotPriority?: (...args: any[]) => number;
  getHotspotDurationMinutes?: (...args: any[]) => number;
  classifyHotspotsForManualInsertion?: (...args: any[]) => any;
};

@Injectable()
export class ItineraryManualFitCandidateDataService {
  private callbacks: Callbacks = {};

  setCallbacks(callbacks: Callbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  async buildRouteHotspotInsertionCandidates(tx: any, planId: number, routeId: number, manualHotspotIds: number[]): Promise<any> {
    const routeRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_plan_own_way: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_order: true,
      },
    });
    const normalizeIds = this.callbacks.normalizeManualHotspotIds || ((ids: any[]) => ids.map(Number).filter((id) => id > 0));
    const hotspotIds = normalizeIds([
      ...manualHotspotIds,
      ...(routeRows || []).map((row: any) => Number(row?.hotspot_ID || 0)),
    ]);
    const hotspotMasters = hotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_priority: true,
            hotspot_latitude: true,
            hotspot_longitude: true,
            hotspot_location: true,
            hotspot_to_location: true,
            hotspot_duration: true,
          },
        })
      : [];
    const timings = hotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_timing.findMany({
          where: { hotspot_ID: { in: hotspotIds }, deleted: 0, status: 1 },
          orderBy: [{ hotspot_ID: 'asc' }, { hotspot_start_time: 'asc' }],
          select: {
            hotspot_ID: true,
            hotspot_closed: true,
            hotspot_open_all_time: true,
            hotspot_start_time: true,
            hotspot_end_time: true,
          },
        })
      : [];
    const formatTime = (date: Date | null) => {
      if (!date) return '';
      const h = date.getUTCHours();
      const m = date.getUTCMinutes();
      const h12 = h % 12 || 12;
      return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    };
    const timingWindowsMap = new Map<number, Set<string>>();
    for (const timing of timings || []) {
      const hotspotId = Number(timing?.hotspot_ID || 0);
      if (hotspotId <= 0 || Number(timing?.hotspot_closed || 0) === 1) continue;
      let timeStr = '';
      if (Number(timing?.hotspot_open_all_time || 0) === 1) timeStr = 'Open 24 Hours';
      else if (timing?.hotspot_start_time && timing?.hotspot_end_time) timeStr = `${formatTime(timing.hotspot_start_time)} - ${formatTime(timing.hotspot_end_time)}`;
      if (!timeStr) continue;
      if (!timingWindowsMap.has(hotspotId)) timingWindowsMap.set(hotspotId, new Set<string>());
      timingWindowsMap.get(hotspotId)!.add(timeStr);
    }
    const timingMap = new Map<number, string>();
    for (const [hotspotId, windowSet] of timingWindowsMap.entries()) {
      timingMap.set(hotspotId, windowSet.has('Open 24 Hours') ? 'Open 24 Hours' : Array.from(windowSet).join(', '));
    }
    const masterMap = new Map<number, any>(hotspotMasters.map((row: any) => [Number(row?.hotspot_ID || 0), row]));
    const normalizePriority = this.callbacks.normalizeHotspotPriority || ((value: any) => Number(value || 9999));
    const getDuration = this.callbacks.getHotspotDurationMinutes || (() => 0);
    const hotspotRows = (routeRows || []).map((row: any) => {
      const hotspotId = Number(row?.hotspot_ID || 0);
      const master = masterMap.get(hotspotId);
      const rawPriority = Number(master?.hotspot_priority ?? 0);
      const normalizedPriority = normalizePriority(rawPriority);
      const isManual = Number(row?.hotspot_plan_own_way || 0) === 1 || manualHotspotIds.includes(hotspotId);
      const effectivePriority = isManual ? 4 : normalizedPriority;
      return {
        routeHotspotId: Number(row?.route_hotspot_ID || 0),
        hotspotId,
        name: String(master?.hotspot_name || `Hotspot #${hotspotId}`),
        rawPriority,
        normalizedPriority,
        priority: effectivePriority,
        effectivePriority,
        isManual,
        mustInclude: isManual,
        hotspotOrder: Number(row?.hotspot_order || 0),
        hotspotStartTime: row?.hotspot_start_time || null,
        hotspotEndTime: row?.hotspot_end_time || null,
        startTs: row?.hotspot_start_time ? new Date(row.hotspot_start_time).getTime() : 0,
        timings: timingMap.get(hotspotId) || '',
        hotspotLocation: String(master?.hotspot_location || '').trim(),
        hotspotToLocation: String(master?.hotspot_to_location || '').trim(),
        durationMinutes: getDuration(master, row),
      };
    });
    return {
      hotspotRows,
      masterMap,
      hotspotMasters,
      classified: this.callbacks.classifyHotspotsForManualInsertion
        ? this.callbacks.classifyHotspotsForManualInsertion(hotspotRows)
        : {},
    };
  }
}
