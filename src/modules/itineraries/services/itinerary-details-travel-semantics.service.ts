type TravelSemanticsParams = {
  routeHotspots: any[];
  hotspotMap: Map<number, any>;
  location: any;
  route: any;
  plan: any;
  index: number;
  routes: any[];
  routeHotelMap: Map<number, any>;
  formatTime: (value?: Date | string | null) => string | null;
  timeToMinutes: (value: string | null) => number;
  isForcedManualConflictAttractionRow: (row: any) => boolean;
  getRouteHotelName: () => string;
};

export type TravelSemantic = {
  from: string;
  to: string;
  fromHotspotId: number | null;
  toHotspotId: number | null;
};

/** Reconstructs semantic origins and destinations for persisted travel rows. */
export class ItineraryDetailsTravelSemanticsService {
  build(params: TravelSemanticsParams): Map<number, TravelSemantic> {
    const {
      routeHotspots,
      hotspotMap,
      location,
      route,
      plan,
      index,
      routes,
      routeHotelMap,
      formatTime,
      timeToMinutes,
      isForcedManualConflictAttractionRow,
      getRouteHotelName,
    } = params;
    const travelSemantics = new Map<number, TravelSemantic>();
    const visitSequence: Array<{ hotspotId: number; hotspotName: string }> = [];
    let routeStartLoc = location?.source_location ?? route.location_name ?? plan.arrival_location ?? '';

    if (index > 0) {
      const prevRouteHotelInfo = routeHotelMap.get(routes[index - 1].itinerary_route_ID);
      if (prevRouteHotelInfo?.hotel_name) routeStartLoc = prevRouteHotelInfo.hotel_name;
    }

    let lastUniqueLocation = routeStartLoc;
    const getHotelCheckinTimeMinutes = (row: any): number | null => {
      const start = formatTime((row as any)?.hotspot_start_time ?? null);
      const end = formatTime((row as any)?.hotspot_end_time ?? null);
      const checkInTime = end || start;
      return checkInTime ? timeToMinutes(checkInTime) : null;
    };
    const hasPriorHotelCheckinBeforeTravel = (travelRow: any): boolean => {
      const travelStart = formatTime((travelRow as any)?.hotspot_start_time ?? null);
      if (!travelStart) return false;
      const travelStartMins = timeToMinutes(travelStart);
      return routeHotspots.some((candidate) => {
        if (Number((candidate as any).item_type ?? 0) !== 6) return false;
        const checkInMins = getHotelCheckinTimeMinutes(candidate);
        return checkInMins !== null && checkInMins <= travelStartMins;
      });
    };

    for (const row of routeHotspots) {
      const itemType = Number((row as any).item_type ?? 0);
      const hotspotId = Number(row.hotspot_ID ?? 0);
      if (itemType !== 4 || hotspotId <= 0 || isForcedManualConflictAttractionRow(row)) continue;
      const master = hotspotMap.get(hotspotId);
      if (master?.hotspot_name?.trim()) {
        visitSequence.push({ hotspotId, hotspotName: master.hotspot_name });
        lastUniqueLocation = master.hotspot_name;
      }
    }

    for (const row of routeHotspots) {
      const itemType = Number((row as any).item_type ?? 0);
      const hotspotId = Number(row.hotspot_ID ?? 0);
      if (itemType !== 3 || hotspotId <= 0) continue;

      const destMaster = hotspotMap.get(hotspotId);
      const destination = destMaster?.hotspot_name ?? lastUniqueLocation;
      let origin = routeStartLoc;
      const destIndex = visitSequence.findIndex((visit) => visit.hotspotId === hotspotId);
      if (destIndex > 0) {
        origin = visitSequence[destIndex - 1].hotspotName;
      } else if (destIndex === 0 && visitSequence.length > 0) {
        origin = hasPriorHotelCheckinBeforeTravel(row) ? getRouteHotelName() : routeStartLoc;
      }

      travelSemantics.set(row.route_hotspot_ID, {
        from: origin,
        to: destination,
        fromHotspotId: destIndex > 0 ? visitSequence[destIndex - 1].hotspotId : null,
        toHotspotId: hotspotId > 0 ? hotspotId : null,
      });
    }

    return travelSemantics;
  }
}
