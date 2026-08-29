export interface TimelineDay1CandidateGateInput {
  route: any;
  hotspot: any;
  currentTime: string;
  isRouteSourceTerminal: boolean;
  hasLaterOvernightInSourceCity: boolean;
  isShoppingHotspot?: boolean;
  isHotspotAlreadyPlanned: (hotspotId: number) => boolean;
  resolveTimelineBucket: (hotspot: any) => string;
  isRouteMovementBucket: (bucket: string) => boolean;
  isSourceBucket: (bucket: string) => boolean;
  logHotspotCandidateEvaluation: (...args: any[]) => void;
}

export class TimelineDay1CandidateGateService {
  shouldSkip(input: TimelineDay1CandidateGateInput): boolean {
    const { route, hotspot, currentTime } = input;
    const bucket = input.resolveTimelineBucket(hotspot);
    const priority = Number(hotspot?.hotspot_priority ?? 0);
    const isManualSelection = Boolean(hotspot?.isManualSelection);
    const isRouteMovementBucket = input.isRouteMovementBucket(bucket);
    const isSourceBucket = input.isSourceBucket(bucket);
    const isShoppingHotspot = Boolean(input.isShoppingHotspot);

    if (
      !isManualSelection &&
      !isShoppingHotspot &&
      !isRouteMovementBucket &&
      priority === 0
    ) {
      this.logRejected(
        input,
        bucket,
        priority,
        currentTime,
        false,
        'Rejected: Day1 strict pass skips non-movement priority=0 fillers',
      );
      return true;
    }

    if (
      !isManualSelection &&
      !isShoppingHotspot &&
      !isRouteMovementBucket &&
      priority > 3
    ) {
      this.logRejected(
        input,
        bucket,
        priority,
        currentTime,
        false,
        'Rejected: Day1 strict pass skips non-movement priority>3',
      );
      return true;
    }

    if (
      !isManualSelection &&
      input.isRouteSourceTerminal &&
      input.hasLaterOvernightInSourceCity &&
      isSourceBucket &&
      priority === 1
    ) {
      this.logRejected(
        input,
        bucket,
        priority,
        currentTime,
        true,
        'Rejected: Day1 terminal-arrival source-bucket priority1 suppression with later overnight return/stay',
      );
      return true;
    }

    if (input.isHotspotAlreadyPlanned(Number(hotspot?.hotspot_ID || 0))) {
      this.logRejected(
        input,
        input.hotspot?.matched_bucket ?? null,
        priority,
        currentTime,
        priority > 0,
        'Rejected: duplicate',
      );
      return true;
    }

    return false;
  }

  private logRejected(
    input: TimelineDay1CandidateGateInput,
    matchedBucket: string | null,
    priority: number,
    currentTime: string,
    isMustVisit: boolean,
    reason: string,
  ): void {
    const hotspotId = Number(input.hotspot?.hotspot_ID || 0);
    input.logHotspotCandidateEvaluation({
      routeId: input.route.itinerary_route_ID,
      hotspotId,
      name: `hotspot_${hotspotId}`,
      matchedBucket,
      priority,
      isMustVisit,
      distanceFromRoute: Number.isFinite(Number(input.hotspot?.hotspot_distance))
        ? Number(input.hotspot.hotspot_distance)
        : null,
      openingTime: null,
      closingTime: null,
      visitTime: `${currentTime} - ${currentTime}`,
      isOpenAtVisitTime: false,
      selected: false,
      rejectedReasons: [reason],
    });
  }
}
