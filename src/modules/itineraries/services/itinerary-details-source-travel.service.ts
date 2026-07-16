type SourceTravelContext = {
  row: any;
  location: any;
  route: any;
  hotspotMap: Map<number, any>;
  routeHotelMap: Map<number, any>;
  previousStopName: string;
  startTimeText: string | null;
  endTimeText: string | null;
  travelDuration: Date | string | null;
  segments: any[];
  seenAttraction: boolean;
  resolveTravelDistanceKm: (params: any) => Promise<number | null>;
  formatTravelDistance: (value: number | null) => string;
  getTravelTimeRangeWithDuration: (start: string | null, end: string | null, duration: Date | string | null) => string | null;
  formatDuration: (value: Date | string | null) => string | null;
  pushHotspotAnchorPlaceholder: (payload: { from: string; to: string; timeRange: string | null }) => void;
};

export type SourceTravelResult = {
  previousStopName: string;
  totalDistanceKm: number;
  emittedTravelBeforeFirstAttraction: boolean;
  handled: boolean;
};

/** Builds source-to-location travel segments for route timeline rows. */
export class ItineraryDetailsSourceTravelService {
  async append(context: SourceTravelContext): Promise<SourceTravelResult> {
    const {
      row,
      location,
      route,
      hotspotMap,
      routeHotelMap,
      previousStopName,
      startTimeText,
      endTimeText,
      travelDuration,
      segments,
      seenAttraction,
      resolveTravelDistanceKm,
      formatTravelDistance,
      getTravelTimeRangeWithDuration,
      formatDuration,
      pushHotspotAnchorPlaceholder,
    } = context;
    let toName = route.next_visiting_location ?? location?.destination_location ?? '';
    if (toName === 'Hotel') {
      const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
      if (hotelInfo?.hotel_name) toName = hotelInfo.hotel_name;
    }
    if (previousStopName.trim() === toName.trim()) {
      return {
        previousStopName: toName,
        totalDistanceKm: 0,
        emittedTravelBeforeFirstAttraction: false,
        handled: true,
      };
    }

    const resolvedDistanceKm = await resolveTravelDistanceKm({
      row,
      itemType: 2,
      location,
      route,
      fromName: previousStopName,
      toName,
      hotspotMap,
    });
    const distanceNum = resolvedDistanceKm ?? 0;
    const travelRange = getTravelTimeRangeWithDuration(startTimeText, endTimeText, travelDuration);
    pushHotspotAnchorPlaceholder({ from: previousStopName, to: toName, timeRange: travelRange });
    segments.push({
      type: 'travel' as const,
      from: previousStopName,
      to: toName,
      timeRange: travelRange,
      distance: formatTravelDistance(resolvedDistanceKm),
      duration: formatDuration(travelDuration),
      note: 'This may vary due to traffic conditions',
    });
    return {
      previousStopName: toName,
      totalDistanceKm: Number.isFinite(distanceNum) && distanceNum > 0 ? distanceNum : 0,
      emittedTravelBeforeFirstAttraction: !seenAttraction,
      handled: true,
    };
  }
}
