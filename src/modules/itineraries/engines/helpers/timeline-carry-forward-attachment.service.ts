export interface TimelineCarryForwardAttachmentInput {
  route: any;
  plan: any;
  planId: number;
  routeIndex: number;
  sourceCity: string;
  destinationCity: string;
  selectedHotspots: any[];
  carryForwardHotspots: any[];
  addedHotspotIds: Set<number>;
  forceNoSightseeingOnThisRoute: boolean;
  sameCityChainContinuation: boolean;
  mergeCarryForwardIntoCandidates: (...args: any[]) => any[];
  logBookingRule: (...args: any[]) => void;
}

export interface TimelineCarryForwardAttachmentResult {
  selectedHotspots: any[];
  hasOnlySourceFallbackCandidates: boolean;
}

export class TimelineCarryForwardAttachmentService {
  apply(input: TimelineCarryForwardAttachmentInput): TimelineCarryForwardAttachmentResult {
    let selectedHotspots = input.selectedHotspots;
    const hasOnlySourceFallbackCandidates =
      Array.isArray(selectedHotspots) &&
      selectedHotspots.length > 0 &&
      selectedHotspots.every(
        (hotspot: any) => String(hotspot?.matched_bucket || '').toLowerCase() === 'source_fallback',
      );

    if (
      !input.forceNoSightseeingOnThisRoute &&
      input.carryForwardHotspots.length > 0 &&
      input.sameCityChainContinuation
    ) {
      const carryIds = input.carryForwardHotspots
        .map((hotspot: any) => Number(hotspot?.hotspot_ID || 0))
        .filter((id: number) => id > 0);

      selectedHotspots = input.mergeCarryForwardIntoCandidates(
        input.carryForwardHotspots,
        selectedHotspots,
        input.addedHotspotIds,
        {
          routeId: Number(input.route.itinerary_route_ID || 0),
          routeDay: Number(input.route?.no_of_days || input.routeIndex || 0),
          sourceCity: input.sourceCity,
          destinationCity: input.destinationCity,
        },
      );

      input.logBookingRule({
        rule: 'STRICT_CARRY_FORWARD_ATTACHED',
        quoteId: input.plan?.quote_id ?? input.plan?.quoteId ?? input.plan?.quote_ID ?? null,
        planId: input.planId,
        routeId: input.route.itinerary_route_ID,
        attachedHotspotIds: carryIds,
        mergedCandidateCount: selectedHotspots.length,
        reason: 'Merged carry-forward strict hotspots ahead of normal same-city candidates.',
      });
    }

    return { selectedHotspots, hasOnlySourceFallbackCandidates };
  }
}
