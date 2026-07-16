import { Injectable } from '@nestjs/common';

@Injectable()
export class TimelineCandidatePreparationService {
  constructor(
    private readonly manualPlacementOrderingService: any,
    private readonly destinationReservationService: any,
    private readonly carryForwardAttachmentService: any,
    private readonly matrixAutobuildService: any,
    private readonly candidateReorderingService: any,
  ) {}

  async prepare(context: any): Promise<any> {
    const {
      options,
      route,
      plan,
      planId,
      selectedHotspots: initialSelectedHotspots,
      existingHotspots,
      tx,
      routeIndex,
      nextRoute,
      sourceCity,
      destinationCity,
      currentRouteViaLocationNames,
      isEligibleForDestinationReservation,
      isIntercityMovementFirstTransfer,
      allHotspots,
      addedHotspotIds,
      hotspotMap,
      minimumReservationCount,
      estimateRouteHotspotCapacity,
      isHotspotAlreadyPlanned,
      fetchSelectedHotspots,
      fetchDay1TopPrioritySourceHotspots,
      hotspotLocationMatchesCity,
      logBookingRule,
      carryForwardHotspots,
      forceNoSightseeingOnThisRoute,
      sameCityChainContinuation,
      mergeCarryForwardIntoCandidates,
      logTimeline,
      currentTime,
      routeStartSeconds,
      routeEndSeconds,
      timingMap,
      getBetweenCandidatesForRouteSlots,
      canonicalCityKey,
      checkHotspotOperatingHoursFromMap,
    } = context;

    const manualPlacementOrdering = this.manualPlacementOrderingService.apply({
      options,
      route,
      plan,
      planId,
      selectedHotspots: initialSelectedHotspots,
      existingHotspots,
    });
    let selectedHotspots = manualPlacementOrdering.selectedHotspots;
    const { routeDesiredMovableSet, desiredMovableOrderRank, routePreferredAdjacencyPairs } = manualPlacementOrdering;

    selectedHotspots = await this.destinationReservationService.apply({
      tx,
      planId,
      routeIndex,
      route,
      plan,
      nextRoute,
      sourceCity,
      destinationCity,
      currentRouteViaLocationNames,
      isEligibleForDestinationReservation,
      isIntercityMovementFirstTransfer,
      allHotspots,
      addedHotspotIds,
      selectedHotspots,
      hotspotMap,
      minimumReservationCount,
      estimateRouteHotspotCapacity,
      isHotspotAlreadyPlanned,
      fetchSelectedHotspots,
      fetchDay1TopPrioritySourceHotspots,
      hotspotLocationMatchesCity,
      logBookingRule,
    });

    const carryForwardAttachment = this.carryForwardAttachmentService.apply({
      route,
      plan,
      planId,
      routeIndex,
      sourceCity,
      destinationCity,
      selectedHotspots,
      carryForwardHotspots,
      addedHotspotIds,
      forceNoSightseeingOnThisRoute,
      sameCityChainContinuation,
      mergeCarryForwardIntoCandidates,
      logBookingRule,
    });
    selectedHotspots = carryForwardAttachment.selectedHotspots;
    const { hasOnlySourceFallbackCandidates } = carryForwardAttachment;
    logTimeline('[TIMELINE] Selected hotspots for route:', selectedHotspots.length);

    selectedHotspots = await this.matrixAutobuildService.apply({
      tx,
      route,
      plan,
      planId,
      sourceCity,
      destinationCity,
      currentTime,
      routeStartSeconds,
      routeEndSeconds,
      timingMap,
      hotspotMap,
      selectedHotspots,
      isHotspotAlreadyPlanned,
      getBetweenCandidatesForRouteSlots,
      logTimeline,
      logBookingRule,
      canonicalCityKey,
      hotspotLocationMatchesCity,
      checkHotspotOperatingHoursFromMap,
    });

    selectedHotspots = this.candidateReorderingService.reorder(selectedHotspots, logTimeline);
    return {
      selectedHotspots,
      routeDesiredMovableSet,
      desiredMovableOrderRank,
      routePreferredAdjacencyPairs,
      hasOnlySourceFallbackCandidates,
    };
  }
}
