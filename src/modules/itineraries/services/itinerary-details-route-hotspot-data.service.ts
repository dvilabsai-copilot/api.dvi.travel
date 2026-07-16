type RouteHotspotDataParams = {
  prisma: any;
  planId: number;
  routeId: number;
  formatTime: (value?: Date | string | null) => string | null;
  timeToMinutes: (value: string | null) => number;
};

export type RouteHotspotData = {
  routeHotspots: any[];
  hotspotIds: number[];
  hotspotMap: Map<number, any>;
  normalizeLookupName: (value?: string | null) => string;
  hotspotNameToIdMap: Map<string, number>;
  hotspotTimingMap: Map<number, any[]>;
  hotspotGalleryMap: Map<number, string[]>;
};

/** Loads and indexes all hotspot data needed by one itinerary-details route. */
export class ItineraryDetailsRouteHotspotDataService {
  async load(params: RouteHotspotDataParams): Promise<RouteHotspotData> {
    const { prisma, planId, routeId, formatTime, timeToMinutes } = params;
    const routeHotspots = await prisma.$queryRawUnsafe(`
          SELECT 
            route_hotspot_ID,
            itinerary_plan_ID,
            itinerary_route_ID,
            item_type,
            hotspot_order,
            hotspot_ID,
            hotspot_adult_entry_cost,
            hotspot_child_entry_cost,
            hotspot_infant_entry_cost,
            hotspot_foreign_adult_entry_cost,
            hotspot_foreign_child_entry_cost,
            hotspot_foreign_infant_entry_cost,
            hotspot_amout,
            CAST(hotspot_traveling_time AS CHAR) as hotspot_traveling_time,
            CAST(itinerary_travel_type_buffer_time AS CHAR) as itinerary_travel_type_buffer_time,
            hotspot_travelling_distance,
            hotspot_start_time,
            hotspot_end_time,
            allow_break_hours,
            allow_via_route,
            via_location_name,
            hotspot_plan_own_way,
            is_conflict,
            conflict_reason,
            createdby,
            createdon,
            updatedon,
            status,
            deleted
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ${planId}
            AND itinerary_route_ID = ${routeId}
            AND deleted = 0
            AND status = 1
          ORDER BY hotspot_order ASC
        `) as any[];

    routeHotspots.sort((a: any, b: any) => {
      const aStart = formatTime((a as any).hotspot_start_time ?? null);
      const bStart = formatTime((b as any).hotspot_start_time ?? null);
      const aStartMins = aStart ? timeToMinutes(aStart) : Number.MAX_SAFE_INTEGER;
      const bStartMins = bStart ? timeToMinutes(bStart) : Number.MAX_SAFE_INTEGER;
      if (aStartMins !== bStartMins) return aStartMins - bStartMins;

      const aEnd = formatTime((a as any).hotspot_end_time ?? null);
      const bEnd = formatTime((b as any).hotspot_end_time ?? null);
      const aEndMins = aEnd ? timeToMinutes(aEnd) : Number.MAX_SAFE_INTEGER;
      const bEndMins = bEnd ? timeToMinutes(bEnd) : Number.MAX_SAFE_INTEGER;
      if (aEndMins !== bEndMins) return aEndMins - bEndMins;

      const itemDiff = Number(a.item_type ?? 0) - Number(b.item_type ?? 0);
      return itemDiff !== 0 ? itemDiff : Number(a.hotspot_order ?? 0) - Number(b.hotspot_order ?? 0);
    });

    const hotspotIds = Array.from(
      new Set(
        routeHotspots
          .map((h) => h.hotspot_ID)
          .filter((id) => typeof id === 'number' && id > 0),
      ),
    );
    const hotspotMasters = hotspotIds.length
      ? await prisma.dvi_hotspot_place.findMany({ where: { hotspot_ID: { in: hotspotIds }, deleted: 0 } })
      : [];
    const hotspotMap = new Map<number, any>(hotspotMasters.map((h: any) => [h.hotspot_ID, h]));
    const normalizeLookupName = (value?: string | null): string =>
      String(value ?? '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s*\([^)]*\)\s*$/g, '')
        .trim()
        .toLowerCase();
    const hotspotNameToIdMap = new Map<string, number>();
    for (const hotspot of hotspotMasters) {
      const name = normalizeLookupName((hotspot as any)?.hotspot_name);
      if (name && !hotspotNameToIdMap.has(name)) {
        hotspotNameToIdMap.set(name, Number((hotspot as any)?.hotspot_ID || 0));
      }
    }

    const hotspotTimings = hotspotIds.length
      ? await prisma.dvi_hotspot_timing.findMany({ where: { hotspot_ID: { in: hotspotIds }, deleted: 0, status: 1 } })
      : [];
    const hotspotTimingMap = new Map<number, any[]>();
    for (const timing of hotspotTimings) {
      if (!hotspotTimingMap.has(timing.hotspot_ID)) hotspotTimingMap.set(timing.hotspot_ID, []);
      hotspotTimingMap.get(timing.hotspot_ID)!.push(timing);
    }

    const hotspotGalleryRows = hotspotIds.length
      ? await prisma.dvi_hotspot_gallery_details.findMany({
          where: { hotspot_ID: { in: hotspotIds }, deleted: 0 },
          orderBy: { hotspot_gallery_details_id: 'asc' },
          select: { hotspot_ID: true, hotspot_gallery_name: true },
        })
      : [];
    const hotspotGalleryMap = new Map<number, string[]>();
    for (const gallery of hotspotGalleryRows) {
      const name = (gallery.hotspot_gallery_name ?? '').toString().trim();
      if (!name) continue;
      const urls = hotspotGalleryMap.get(gallery.hotspot_ID) ?? [];
      urls.push(`/uploads/hotspot_gallery/${name}`);
      hotspotGalleryMap.set(gallery.hotspot_ID, urls);
    }

    return {
      routeHotspots,
      hotspotIds,
      hotspotMap,
      normalizeLookupName,
      hotspotNameToIdMap,
      hotspotTimingMap,
      hotspotGalleryMap,
    };
  }
}
