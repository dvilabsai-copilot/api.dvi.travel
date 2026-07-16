type ViaTravelContext = {
  row: any;
  location: any;
  route: any;
  hotspotMap: Map<number, any>;
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

export type ViaTravelResult = {
  previousStopName: string;
  totalDistanceKm: number;
  emittedTravelBeforeFirstAttraction: boolean;
};

/** Builds travel segments for item-type-3 via-route rows. */
export class ItineraryDetailsViaTravelService {
  async append(context: ViaTravelContext): Promise<ViaTravelResult> {
    const {
      row, location, route, hotspotMap, previousStopName, startTimeText, endTimeText,
      travelDuration, segments, seenAttraction, resolveTravelDistanceKm, formatTravelDistance,
      getTravelTimeRangeWithDuration, formatDuration, pushHotspotAnchorPlaceholder,
    } = context;
    const toName = String((row as any).via_location_name ?? '').trim();
    const resolvedDistanceKm = await resolveTravelDistanceKm({
      row,
      itemType: 3,
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
    };
  }
}
