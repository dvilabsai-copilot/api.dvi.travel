import {
  buildManualFitAttemptComputedDisplayTimelineSnapshotImpl,
  buildManualFitAttemptDisplayTimelineSnapshotImpl,
  buildManualFitAttemptTimelineSnapshotImpl,
  buildManualFitFinalizedPreviewTimelineImpl,
  validateManualFitAttemptDisplayTimelineImpl,
} from '../helpers/manual-fit-here-preview.helper';
import {
  formatDateOnly,
  inferMealPlanFromInclusions,
  normalizeManualHotspotIds,
  normalizeToArray,
  normalizeToUniqueStrings,
  toDateOnly,
} from './itinerary-input-normalization.service';

/**
 * Installs the callback graph between the itinerary facade and its policy services.
 * The facade remains the owner of shared legacy helpers; this module only wires them.
 */
export function configureItineraryServiceCollaborators(service: any): void {
    service.manualFitTimelinePolicyService.setCallbacks({
      parseSegmentEndMinutes: (...args) => (service.parseSegmentEndMinutes as any)(...args),
    });
    service.matrixPreviewTimelinePolicyService.setCallbacks({
      parseSegmentStartMinutes: (...args) => (service.parseSegmentStartMinutes as any)(...args),
      parseSegmentEndMinutes: (...args) => (service.parseSegmentEndMinutes as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (service.parsePreviewTimeToMinutes as any)(...args),
      timeToMinutes: (...args) => (service.timeToMinutes as any)(...args),
      getHotspotDurationMinutes: (...args) => (service.getHotspotDurationMinutes as any)(...args),
    });
    service.manualFitRemovalExplanationService.setCallbacks({
      parsePreviewTimeToMinutes: (...args) => (service.parsePreviewTimeToMinutes as any)(...args),
      parseManualHotspotLatestClosingMinute: (...args) => (service.parseManualHotspotLatestClosingMinute as any)(...args),
      formatTime: (...args) => (service.formatTime as any)(...args),
      minutesToUtcTimeDate: (...args) => (service.minutesToUtcTimeDate as any)(...args),
    });
    service.manualFitRouteMatrixPersistenceService.setCallbacks({
      findNearestProgressOnRoute: (...args) => (service.findNearestProgressOnRoute as any)(...args),
      normalizeLocationText: (...args) => (service.normalizeLocationText as any)(...args),
      haversineKmForRouteProjection: (...args) => (service.haversineKmForRouteProjection as any)(...args),
      getOsrmRouteGeometry: (...args) => (service.getOsrmRouteGeometry as any)(...args),
      getOsrmDistanceKm: (...args) => (service.getOsrmDistanceKm as any)(...args),
      deriveLooseCityKey: (...args) => (service.deriveLooseCityKey as any)(...args),
    });
    service.manualFitOperatingHoursService.setCallbacks({
      formatTime: (...args) => (service.formatTime as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (service.parsePreviewTimeToMinutes as any)(...args),
    });
    service.manualFitValidationService.setCallbacks({
      distanceBetweenHotspots: (...args) => (service.distanceBetweenHotspots as any)(...args),
      evaluateTimelineRowAgainstOperatingHours: (...args) => (service.evaluateTimelineRowAgainstOperatingHours as any)(...args),
      calculateRouteEndOverflowMinutes: (...args) => (service.calculateRouteEndOverflowMinutes as any)(...args),
    });
    service.manualFitScheduleAttemptService.setCallbacks({
      distanceBetweenHotspots: (...args) => (service.distanceBetweenHotspots as any)(...args),
      calculateInsertionExtraDistance: (...args) => (service.calculateInsertionExtraDistance as any)(...args),
      calculateToAndFroPenalty: (...args) => (service.calculateToAndFroPenalty as any)(...args),
      isAttractionTimelineRow: (...args) => (service.isAttractionTimelineRow as any)(...args),
      getTimelineRowHotspotId: (...args) => (service.getTimelineRowHotspotId as any)(...args),
      manualFitTimelinePreservesSelectedAnchor: (...args) => (service.manualFitTimelinePreservesSelectedAnchor as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (service.parsePreviewTimeToMinutes as any)(...args),
      explainManualScheduleAttempt: (...args) => (service.explainManualScheduleAttempt as any)(...args),
    });
    service.manualFitCandidateSimulationService.setCallbacks({
      rebuildManualHotspotSet: (...args) => (service.rebuildManualHotspotSet as any)(...args),
      buildRouteHotspotInsertionCandidates: (...args) => (service.manualFitCandidateDataService.buildRouteHotspotInsertionCandidates as any)(...args),
      getManualHotspotScheduleState: (...args) => (service.getManualHotspotScheduleState as any)(...args),
      getRouteTimelineForScoring: (...args) => (service.getRouteTimelineForScoring as any)(...args),
      manualFitTimelinePreservesSelectedAnchor: (...args) => (service.manualFitTimelinePreservesSelectedAnchor as any)(...args),
      buildExactAnchorSequentialTimelineAfterRemoval: (...args) => (service.buildExactAnchorSequentialTimelineAfterRemoval as any)(...args),
      enrichManualFitPreviewTimelineWithOperatingHours: (...args) => (service.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args),
      calculateWaitingMinutes: (...args) => (service.calculateWaitingMinutes as any)(...args),
      calculateTravelMetricsFromTimeline: (...args) => (service.calculateTravelMetricsFromTimeline as any)(...args),
      detectTopPriorityImpact: (...args) => (service.detectTopPriorityImpact as any)(...args),
      calculateRouteEndOverflowMinutes: (...args) => (service.calculateRouteEndOverflowMinutes as any)(...args),
      scoreManualInsertionCandidate: (...args) => (service.scoreManualInsertionCandidate as any)(...args),
      getManualEffectivePriority: (...args) => (service.getManualEffectivePriority as any)(...args),
      explainRejectedCandidate: (...args) => (service.explainRejectedCandidate as any)(...args),
    });
    service.manualFitCandidateSearchService.setCallbacks({
      findRouteDetails: async (tx, planId, routeId) => (tx as any).dvi_itinerary_route_details.findFirst({
        where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), deleted: 0 },
      }),
      buildRouteHotspotInsertionCandidates: (...args) => (service.buildRouteHotspotInsertionCandidates as any)(...args),
      buildManualInsertionPositions: (...args) => (service.buildManualInsertionPositions as any)(...args),
      buildPreferredManualInsertionIndex: (...args) => (service.buildPreferredManualInsertionIndex as any)(...args),
      simulateManualInsertionAtPosition: (...args) => (service.simulateManualInsertionAtPosition as any)(...args),
      buildManualSlotInsights: (...args) => (service.buildManualSlotInsights as any)(...args),
      chooseBestManualInsertionCandidate: (...args) => (service.chooseBestManualInsertionCandidate as any)(...args),
      rebuildManualHotspotSet: (...args) => (service.rebuildManualHotspotSet as any)(...args),
      buildManualClusterCandidateOrders: (...args) => (service.buildManualClusterCandidateOrders as any)(...args),
      simulateManualClusterOrder: (...args) => (service.simulateManualClusterOrder as any)(...args),
      compareManualScheduleAttempts: (...args) => (service.compareManualScheduleAttempts as any)(...args),
    });
    service.manualFitCandidateDataService.setCallbacks({
      normalizeManualHotspotIds: (...args) => normalizeManualHotspotIds((args[0] || []) as any[]),
      normalizeHotspotPriority: (...args) => (service.normalizeHotspotPriority as any)(...args),
      getHotspotDurationMinutes: (...args) => (service.getHotspotDurationMinutes as any)(...args),
      classifyHotspotsForManualInsertion: (...args) => (service.classifyHotspotsForManualInsertion as any)(...args),
    });
    service.manualHotspotRowService.setCallbacks({
      computeRowDurationMinutes: (...args) => (service.computeRowDurationMinutes as any)(...args),
    });
    service.manualHotspotScheduleStateService.setCallbacks({
      computeRowDurationMinutes: (...args) => (service.computeRowDurationMinutes as any)(...args),
      hasAnyNonOverlappingManualRow: (...args) => (service.manualHotspotOverlapService.hasAnyNonOverlappingManualRow as any)(...args),
      manualRowHasNoOverlap: (...args) => (service.manualHotspotOverlapService.manualRowHasNoOverlap as any)(...args),
    });
    service.manualHotspotRowTimingService.setCallbacks({
      normalizeManualHotspotIds: (...args) => normalizeManualHotspotIds((args[0] || []) as any[]),
      computeRowDurationMinutes: (...args) => (service.computeRowDurationMinutes as any)(...args),
      minutesToUtcTimeDate: (...args) => (service.minutesToUtcTimeDate as any)(...args),
    });
    service.routeHotspotRebuildService.setCallbacks({
      applySameCityCrossDayOptimizerAfterSave: (...args) => (service.applySameCityCrossDayOptimizerAfterSave as any)(...args),
      forceRebuildVehiclePricingAfterHotspotChange: (...args) => (service.forceRebuildVehiclePricingAfterHotspotChange as any)(...args),
    });
    service.activityImpactService.setCallbacks({
      timeToMinutes: (...args) => (service.timeToMinutes as any)(...args),
      addMinutesToTime: (...args) => (service.addMinutesToTime as any)(...args),
    });
    service.transportFormattingService.setFormatTimeCallback((time) => service.formatTime(time));
    service.vehicleBuildService.setVehicleVendorSelector((data) => service.selectVehicleVendor(data));
    service.activityAvailabilityService.setCalculateActivityPlanPricingCallback(
      (params) => service.calculateActivityPlanPricing(params),
    );
    service.hotspotDeletionService.setForceRebuildVehiclePricingCallback(
      (planId, routeId) => service.forceRebuildVehiclePricingAfterHotspotChange(planId, routeId),
    );
    service.planPersistenceService.setCallbacks({
      optimizeRouteOrder: (routes) => service.optimizeRouteOrder(routes),
      applySameCityOptimizer: (planId, quoteId) => service.applySameCityCrossDayOptimizerAfterSave(planId, quoteId),
      getPlanForEdit: (planId) => service.getPlanForEdit(planId),
    });
    service.activityWorkflowService.setCallbacks({
      simulateActivityImpactBeforeAdd: (data) => service.simulateActivityImpactBeforeAdd(data),
      calculateActivityPlanPricing: (...args) => (service.calculateActivityPlanPricing as any)(...args),
      timeToMinutes: (time) => service.timeToMinutes(time),
      addMinutesToTime: (time, minutes) => service.addMinutesToTime(time, minutes),
      checkActivityTimingConflicts: (...args) => (service.checkActivityTimingConflicts as any)(...args),
    });
    service.smartActivityService.setCallbacks({
      timeToMinutes: (time) => service.timeToMinutes(time),
      addMinutesToTime: (time, minutes) => service.addMinutesToTime(time, minutes),
      checkActivityTimingConflicts: (...args) => (service.checkActivityTimingConflicts as any)(...args),
      formatTime: (time) => service.formatTime(time),
    });
    service.hotspotWorkflowService.setCallbacks({
      classifyManualHotspotCityContext: (...args) => (service.classifyManualHotspotCityContext as any)(...args),
      deriveLooseCityKey: (...args) => (service.deriveLooseCityKey as any)(...args),
      hmsToSeconds: (...args) => (service.hmsToSeconds as any)(...args),
      normalizeLocationText: (...args) => (service.normalizeLocationText as any)(...args),
      previewManualHotspot: (...args) => (service.previewManualHotspot as any)(...args),
    });
    service.confirmationService.setCallbacks({
      syncSelectedHotelDraftRowsForConfirmation: (...args) => (service.syncSelectedHotelDraftRowsForConfirmation as any)(...args),
      getAgentWalletBalance: (...args) => (service.getAgentWalletBalance as any)(...args),
      formatDateOnly: (...args) => formatDateOnly(args[0] as Date | string | null | undefined),
      copyDraftToConfirmed: (...args) => (service.copyDraftToConfirmed as any)(...args),
    });
    service.hotelConfirmationSupportService.setCallbacks({
      mergeConsecutiveSupplierHotelBookings: (...args) => (service.confirmationService.mergeConsecutiveSupplierHotelBookings as any)(...args),
      pruneHotelBookingsCoveredByMultiNight: (...args) => (service.confirmationService.pruneHotelBookingsCoveredByMultiNight as any)(...args),
      getProviderBookableHotelBookings: (...args) => (service.confirmationService.getProviderBookableHotelBookings as any)(...args),
      getConfirmHotelGroupType: (...args) => (service.confirmationService.getConfirmHotelGroupType as any)(...args),
      uniquePositiveNumbers: (...args) => (service.confirmationService.uniquePositiveNumbers as any)(...args),
      bookingKey: (...args) => (service.confirmationService.bookingKey as any)(...args),
      assertConsistentMultiNightHotelSelection: (...args) => (service.confirmationService.assertConsistentMultiNightHotelSelection as any)(...args),
      getAgentWalletBalance: (...args) => (service.getAgentWalletBalance as any)(...args),
    });
    service.hotelPrebookService.setCallbacks({
      normalizeToArray: (...args) => normalizeToArray(args[0]),
      normalizeToUniqueStrings: (...args) => normalizeToUniqueStrings((args[0] || []) as any[]),
      inferMealPlanFromInclusions: (...args) => inferMealPlanFromInclusions((args[0] || []) as string[]),
      getProviderBookableHotelBookings: (...args) => (service.confirmationService.getProviderBookableHotelBookings as any)(...args),
    });
    service.hotelBookingFulfillmentService.setCallbacks({
      bookingKey: (...args) => (service.confirmationService.bookingKey as any)(...args),
      isBookingResultSuccess: (...args) => (service.confirmationService.isBookingResultSuccess as any)(...args),
      filterAlreadySuccessfulBookings: (...args) => (service.filterAlreadySuccessfulBookings as any)(...args),
      finalizeConfirmationFinancials: (...args) => (service.finalizeConfirmationFinancials as any)(...args),
      getConfirmedItineraryDetails: (...args) => (service.confirmedItineraryDetailsService.getConfirmedItineraryDetails as any)(...args),
      mergeConsecutiveSupplierHotelBookings: (...args) => (service.confirmationService.mergeConsecutiveSupplierHotelBookings as any)(...args),
      pruneHotelBookingsCoveredByMultiNight: (...args) => (service.confirmationService.pruneHotelBookingsCoveredByMultiNight as any)(...args),
      getProviderBookableHotelBookings: (...args) => (service.confirmationService.getProviderBookableHotelBookings as any)(...args),
    });
    service.voucherReadService.setCallbacks({
      toDateOnly: (...args) => toDateOnly(args[0] as Date | string | null | undefined),
      getInvoiceToLabel: (...args) => (service.getInvoiceToLabel as any)(...args),
      getVoucherStatusLabel: (...args) => (service.getVoucherStatusLabel as any)(...args),
      formatTransportVoucherDate: (...args) => (service.formatTransportVoucherDate as any)(...args),
      buildTransportDateRange: (...args) => (service.buildTransportDateRange as any)(...args),
      buildPassengerMixLabel: (...args) => (service.buildPassengerMixLabel as any)(...args),
      buildTransportVoucherNumber: (...args) => (service.buildTransportVoucherNumber as any)(...args),
      shortTransportLocationName: (...args) => (service.shortTransportLocationName as any)(...args),
      decodeTransportHtml: (...args) => (service.decodeTransportHtml as any)(...args),
      parseTransportFlightDetails: (...args) => (service.parseTransportFlightDetails as any)(...args),
      formatTime: (...args) => (service.formatTime as any)(...args),
    });
    service.manualHotspotMatrixService.setCallbacks({
      deriveLooseCityKey: (value) => service.deriveLooseCityKey(value),
      normalizeLocationText: (value) => service.normalizeLocationText(value),
    });
    service.manualHotspotPreviewService.setCallbacks({
      ensureManualFitAttemptStoreTable: (...args) => (service.manualFitAttemptStoreService.ensureTable as any)(...args),
      normalizeManualHotspotIds: (...args) => normalizeManualHotspotIds((args[0] || []) as any[]),
      isRetryableManualPreviewTransactionError: (...args) => (service.isRetryableManualPreviewTransactionError as any)(...args),
      runManualHotspotBatchWithinTransaction: (...args) => (service.manualHotspotBatchService.runManualHotspotBatchWithinTransaction as any)(...args),
    });
    const manualInsertionFitCallbackNames = [
      'timeToMinutes',
      'classifyManualHotspotCityContext',
      'isFeasibleFitType',
      'isUsableMatrixRouteFitType',
      'ensureHotspotHotelBetweenMapTable',
      'resolveSelectedHotelEndpoint',
      'normalizeLocationText',
      'resolveHotelEndpointByLooseName',
      'resolveRouteDestinationCityEndpoint',
      'classifyManualRouteAttractionCityContext',
      'getCachedRouteMatrixLeg',
      'distanceBetweenHotspots',
      'estimateDurationFromDistance',
      'resolveHotspotToHotelLeg',
      'parseSegmentStartMinutes',
      'parseSegmentEndMinutes',
      'upsertHotspotHotelBetweenMapRow',
      'routeFitLabel',
      'getRouteBetweenRejectionRow',
      'ensureRouteBetweenMapRow',
      'buildRouteFitDisplayMeta',
      'deriveLooseCityKey',
      'findLastSourceCityHotspotOnOsrmRoute',
      'ensureHotspotPlace',
    ];
    service.manualInsertionFitService.setCallbacks(
      Object.fromEntries(
        manualInsertionFitCallbackNames.map((name) => [
          name,
          (...args: any[]) => (service as any)[name](...args),
        ]),
      ),
    );
    const progressivePriorityRemovalCallbackNames = [
      'isAttractionTimelineRow',
      'getRouteTimelineForScoring',
      'deriveLooseCityKey',
      'classifyManualHotspotCityContext',
      'normalizeHotspotPriority',
      'getHotspotDurationMinutes',
      'getPreviewRowDurationMinutes',
      'parseSegmentEndMinutes',
      'hmsToSeconds',
      'enrichManualFitPreviewTimelineWithOperatingHours',
      'getSelectedManualClosingOverflow',
      'markSelectedManualOperatingHourConflicts',
      'minutesRangeToFitPreviewLabel',
      'minutesRangeToTimeString',
      'buildExactAnchorSequentialTimelineAfterRemoval',
      'buildMatrixRouteTimelineAfterLowPriorityRemoval',
      'buildSelectedClosingRemovalReason',
      'buildProgressiveRemovalReason',
      'buildManualFitAttemptTimelineSnapshot',
      'buildManualFitAttemptComputedDisplayTimelineSnapshot',
      'validateManualFitAttemptDisplayTimeline',
      'buildProgressiveRemovalSuccessMessage',
    ];
    service.progressivePriorityRemovalService.setCallbacks(
      Object.fromEntries(
        progressivePriorityRemovalCallbackNames.map((name) => [
          name,
          (...args: any[]) => (service as any)[name](...args),
        ]),
      ),
    );
    const adaptiveManualHotspotInsertionCallbackNames = [
      'normalizeManualHotspotIds',
      'buildRouteHotspotInsertionCandidates',
      'runManualClusterOptimizer',
      'buildDistanceAndToFroLabels',
      'getEffectivePriorityForManualInsertion',
      'mapOptionalRemovalPriority',
      'addRouteHotspotToExcludedList',
      'enrichRemovedHotspotCandidateWithAttempt',
      'buildRemovedHotspotExplanation',
    ];
    service.adaptiveManualHotspotInsertionService.setCallbacks(
      Object.fromEntries(
        adaptiveManualHotspotInsertionCallbackNames.map((name) => [
          name,
          (...args: any[]) => (service as any)[name](...args),
        ]),
      ),
    );
    service.matrixRescheduledPreviewService.setCallbacks({
      assertTimelineOrderForMatrixPreview: (...args) => (service.assertTimelineOrderForMatrixPreview as any)(...args),
      finalizeMatrixPreviewTimeline: (...args) => (service.finalizeMatrixPreviewTimeline as any)(...args),
      getHotspotDurationMinutesFromMasterFirst: (...args) => (service.getHotspotDurationMinutesFromMasterFirst as any)(...args),
      getPreviewRowDurationFromDurationFieldsOnly: (...args) => (service.getPreviewRowDurationFromDurationFieldsOnly as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (service.getPreviewRowDurationMinutes as any)(...args),
      hmsToSeconds: (...args) => (service.hmsToSeconds as any)(...args),
      minutesRangeToTimeString: (...args) => (service.minutesRangeToTimeString as any)(...args),
      minutesToUtcTimeDate: (...args) => (service.minutesToUtcTimeDate as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (service.parsePreviewTimeToMinutes as any)(...args),
      normalizePreviewTimeText: (...args) => (service.normalizePreviewTimeText as any)(...args),
      parseSegmentStartMinutes: (...args) => (service.parseSegmentStartMinutes as any)(...args),
      parseSegmentEndMinutes: (...args) => (service.parseSegmentEndMinutes as any)(...args),
      formatPreviewTravelDuration: (...args) => (service.formatPreviewTravelDuration as any)(...args),
      getCachedRouteDurationMinutes: (...args) => (service.getCachedRouteDurationMinutes as any)(...args),
      estimateDurationFromDistance: (...args) => (service.estimateDurationFromDistance as any)(...args),
      chooseReliableTravelDistanceKm: (...args) => (service.chooseReliableTravelDistanceKm as any)(...args),
      resolveSavedRuleSourceToHotspotLeg: (...args) => (service.resolveSavedRuleSourceToHotspotLeg as any)(...args),
      resolveSavedRuleHotspotToHotspotLeg: (...args) => (service.resolveSavedRuleHotspotToHotspotLeg as any)(...args),
      resolveSavedRuleHotspotToRouteHotelLeg: (...args) => (service.resolveSavedRuleHotspotToRouteHotelLeg as any)(...args),
      timeToMinutes: (...args) => (service.timeToMinutes as any)(...args),
    });
    service.confirmedItineraryDetailsService.setCallbacks({
      listConfirmedGuideAssignments: (...args) => (service.listConfirmedGuideAssignments as any)(...args),
    });
    service.routeTimingService.setCallbacks({
      forceRebuildVehiclePricingAfterHotspotChange: (...args) => (service.forceRebuildVehiclePricingAfterHotspotChange as any)(...args),
    });
    service.manualFitTravelReplicaService.setCallbacks({
      ensureHotspotHotelBetweenMapTable: (...args) => (service.ensureHotspotHotelBetweenMapTable as any)(...args),
      estimateDurationFromDistance: (...args) => (service.estimateDurationFromDistance as any)(...args),
      extractPreviewCheckinHotelName: (...args) => (service.extractPreviewCheckinHotelName as any)(...args),
      finalizeMatrixPreviewTimeline: (...args) => (service.finalizeMatrixPreviewTimeline as any)(...args),
      formatPreviewTravelDuration: (...args) => (service.formatPreviewTravelDuration as any)(...args),
      getOsrmRouteGeometry: (...args) => (service.getOsrmRouteGeometry as any)(...args),
      minutesRangeToTimeString: (...args) => (service.minutesRangeToTimeString as any)(...args),
      parseSegmentEndMinutes: (...args) => (service.parseSegmentEndMinutes as any)(...args),
      parseSegmentStartMinutes: (...args) => (service.parseSegmentStartMinutes as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (service.getPreviewRowDurationMinutes as any)(...args),
      resolveRouteSourceEndpoint: (...args) => (service.resolveRouteSourceEndpoint as any)(...args),
      resolveRouteDestinationCityEndpoint: (...args) => (service.resolveRouteDestinationCityEndpoint as any)(...args),
      resolveSelectedHotelEndpoint: (...args) => (service.resolveSelectedHotelEndpoint as any)(...args),
      resolveSavedRuleHotspotToRouteHotelLeg: (...args) => (service.resolveSavedRuleHotspotToRouteHotelLeg as any)(...args),
    });
    service.manualFitGeometryService.setCallbacks({
      classifyManualHotspotCityContext: (...args) => (service.classifyManualHotspotCityContext as any)(...args),
      estimateDurationFromDistance: (...args) => (service.estimateDurationFromDistance as any)(...args),
    });
    const manualHotspotBatchCallbackNames = [
      'normalizeManualHotspotIds',
      'getRouteManualHotspotIds',
      'getManualHotspotTimingPolicyInTx',
      'inferDetourOptimizedAnchorIndex',
      'forceInsertManualHotspotConflictRow',
      'buildRouteTimelineSnapshotAfterManualConflictInsert',
      'buildDistanceAndToFroLabels',
      'getRouteTimelineForScoring',
      'resolveManualHotspotFocusId',
      'buildManualInsertionFit',
      'hasValidManualMatrixSlot',
      'isEmptyRouteSchedulerEligible',
      'buildMissingMatrixBuildSuggestion',
      'applyMatrixSafeManualHotspotInsertionInTx',
      'removeRouteHotspotFromExcludedList',
      'ensureManualHotspotRow',
      'resolveMatrixBestInsertionGap',
      'runAdaptiveManualHotspotSetInsertion',
      'buildManualFitAnchorLabel',
      'getAuthoritativeManualFitRemovedHotspots',
      'buildManualHotspotValidation',
      'hmsToSeconds',
      'buildMatrixRescheduledPreviewTimeline',
      'removeManualFitDroppedRowsFromTimeline',
      'applyManualInsertionFitToPreviewTimeline',
      'manualFitTimelinePreservesSelectedAnchor',
      'getManualFitRemovalHotspotId',
      'destinationSidePreviewDroppedBaselineRows',
      'buildExactAnchorSequentialTimelineAfterRemoval',
      'isManualPreviewTimelineWrapped',
      'rebuildDestinationSidePreviewFromBaseline',
      'resolveSelectedManualPriority',
      'calculateRouteEndOverflowMinutes',
      'resolveProgressivePriorityRemovalForManualFitInTx',
      'filterPlannedRemovalsToSameRouteInTx',
      'buildRouteFitDisplayMeta',
      'sanitizeResolvedLowPriorityTimeline',
      'validateResolvedLowPriorityTimeline',
      'enrichManualFitPreviewTimelineWithOperatingHours',
      'markSelectedManualOperatingHourConflicts',
      'pruneManualFitBacktrackingAfterSelectedPivotInTx',
      'getSelectedManualClosingOverflow',
      'parsePreviewTimeToMinutes',
      'parseTimeRangeParts',
      'extractClosingTimeFromOperatingHours',
      'normalizeHotspotPriority',
      'buildSelectedClosingRemovalReason',
      'getPreviewRowDurationMinutes',
      'detectManualFitTimingRisk',
      'validateStrictMatrixTimeline',
      'parsePreviewTimeRangeToUtcDates',
      'buildRemovedPrioritySummary',
      'buildManualFitChangesRequiredDisplay',
      'ensurePreviewTimelineHasComputedHotelTravel',
      'normalizeExactAnchorManualInsertionFit',
      'decorateScheduledManualHotspots',
    ];
    service.manualHotspotBatchService.setCallbacks(
      Object.fromEntries(
        manualHotspotBatchCallbackNames.map((name) => [
          name,
          (...args: any[]) => (service as any)[name](...args),
        ]),
      ),
    );
    service.manualHotspotBatchService.setCallbacks({
      buildManualInsertionFit: (...args) => (service.manualInsertionFitService.buildManualInsertionFit as any)(...args),
      resolveProgressivePriorityRemovalForManualFitInTx: (...args) => (service.progressivePriorityRemovalService.resolveProgressivePriorityRemovalForManualFitInTx as any)(...args),
      runAdaptiveManualHotspotSetInsertion: (...args) => (service.adaptiveManualHotspotInsertionService.runAdaptiveManualHotspotSetInsertion as any)(...args),
      buildMatrixRescheduledPreviewTimeline: (...args) => (service.matrixRescheduledPreviewService.buildMatrixRescheduledPreviewTimeline as any)(...args),
    });
    service.manualHotspotMutationService.setCallbacks({
      timeToMinutes: (...args) => (service.timeToMinutes as any)(...args),
      runManualHotspotBatchWithinTransaction: (...args) => (service.manualHotspotBatchService.runManualHotspotBatchWithinTransaction as any)(...args),
      cleanupStaleManualHotspotRows: (...args) => (service.cleanupStaleManualHotspotRows as any)(...args),
      forceRebuildVehiclePricingAfterHotspotChange: (...args) => (service.forceRebuildVehiclePricingAfterHotspotChange as any)(...args),
      estimateDurationFromDistance: (...args) => (service.estimateDurationFromDistance as any)(...args),
      computeRowDurationMinutes: (...args) => (service.computeRowDurationMinutes as any)(...args),
      parsePreviewTimeRangeToUtcDates: (...args) => (service.parsePreviewTimeRangeToUtcDates as any)(...args),
      minutesToUtcTimeDate: (...args) => (service.minutesToUtcTimeDate as any)(...args),
      normalizeManualHotspotIds: (...args) => normalizeManualHotspotIds((args[0] || []) as any[]),
      isRetryableManualPreviewTransactionError: (...args) => (service.isRetryableManualPreviewTransactionError as any)(...args),
    });
    service.manualFitMatrixPlanningService.setCallbacks({
      sortTimelineSegmentsForPreview: (...args) => (service.sortTimelineSegmentsForPreview as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (service.getPreviewRowDurationMinutes as any)(...args),
      minutesRangeToTimeString: (...args) => (service.minutesRangeToTimeString as any)(...args),
      parseSegmentStartMinutes: (...args) => (service.parseSegmentStartMinutes as any)(...args),
      resolveSourceToHotspotLeg: (...args) => (service.resolveSourceToHotspotLeg as any)(...args),
      chooseReliableTravelDistanceKm: (...args) => (service.chooseReliableTravelDistanceKm as any)(...args),
      getCachedRouteMatrixLeg: (...args) => (service.getCachedRouteMatrixLeg as any)(...args),
      estimateDurationFromDistance: (...args) => (service.estimateDurationFromDistance as any)(...args),
      normalizeTravelLabelsToNextStop: (...args) => (service.normalizeTravelLabelsToNextStop as any)(...args),
    });
    service.exactAnchorRebuildService.setCallbacks({
      adjustManualFitVisitStartToOperatingWindow: (...args) => (service.adjustManualFitVisitStartToOperatingWindow as any)(...args),
      buildExactAnchorSequentialTimelineCacheKey: (...args) => (service.buildExactAnchorSequentialTimelineCacheKey as any)(...args),
      buildManualFitMainTimelineTravelReplicaMap: (...args) => (service.buildManualFitMainTimelineTravelReplicaMap as any)(...args),
      buildManualFitTravelReplicaDisplayFields: (...args) => (service.manualFitTravelReplicaService.buildManualFitTravelReplicaDisplayFields as any)(...args),
      chooseReliableTravelDistanceKm: (...args) => (service.chooseReliableTravelDistanceKm as any)(...args),
      classifyManualHotspotCityContext: (...args) => (service.classifyManualHotspotCityContext as any)(...args),
      cloneTimelineRowsForPreview: (...args) => (service.cloneTimelineRowsForPreview as any)(...args),
      deriveLooseCityKey: (...args) => (service.deriveLooseCityKey as any)(...args),
      enrichManualFitPreviewTimelineWithOperatingHours: (...args) => (service.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args),
      estimateDurationFromDistance: (...args) => (service.estimateDurationFromDistance as any)(...args),
      findManualFitMainTimelineTravelReplica: (...args) => (service.findManualFitMainTimelineTravelReplica as any)(...args),
      getCachedRouteMatrixLeg: (...args) => (service.getCachedRouteMatrixLeg as any)(...args),
      getHotspotDurationMinutes: (...args) => (service.getHotspotDurationMinutes as any)(...args),
      getManualFitTravelReplicaDurationMinutes: (...args) => (service.getManualFitTravelReplicaDurationMinutes as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (service.getPreviewRowDurationMinutes as any)(...args),
      minutesRangeToFitPreviewLabel: (...args) => (service.minutesRangeToFitPreviewLabel as any)(...args),
      normalizeTravelLabelsToNextStop: (...args) => (service.normalizeTravelLabelsToNextStop as any)(...args),
      parseManualFitTravelReplicaDistanceKm: (...args) => (service.parseManualFitTravelReplicaDistanceKm as any)(...args),
      parseSegmentStartMinutes: (...args) => (service.parseSegmentStartMinutes as any)(...args),
      rememberExactAnchorSequentialTimeline: (...args) => (service.rememberExactAnchorSequentialTimeline as any)(...args),
      resolveSourceToHotspotLeg: (...args) => (service.resolveSourceToHotspotLeg as any)(...args),
    });
    service.lowPriorityRemovalService.setCallbacks({
      getPreviewRowDurationMinutes: (...args) => (service.getPreviewRowDurationMinutes as any)(...args),
      buildMatrixRouteTimelineAfterLowPriorityRemoval: (...args) => (service.buildMatrixRouteTimelineAfterLowPriorityRemoval as any)(...args),
      parseSegmentEndMinutes: (...args) => (service.parseSegmentEndMinutes as any)(...args),
      minutesRangeToTimeString: (...args) => (service.minutesRangeToTimeString as any)(...args),
      validateResolvedLowPriorityTimeline: (...args) => (service.validateResolvedLowPriorityTimeline as any)(...args),
      formatMinutesHuman: (...args) => (service.formatMinutesHuman as any)(...args),
      buildManualFitFinalizedPreviewTimelineImpl: (...args) => buildManualFitFinalizedPreviewTimelineImpl.call(service, ...args),
      buildManualFitAttemptTimelineSnapshotImpl: (...args) => buildManualFitAttemptTimelineSnapshotImpl.call(service, ...args),
      buildManualFitAttemptDisplayTimelineSnapshotImpl: (...args) => buildManualFitAttemptDisplayTimelineSnapshotImpl.call(service, ...args),
      buildManualFitAttemptComputedDisplayTimelineSnapshotImpl: (...args) => buildManualFitAttemptComputedDisplayTimelineSnapshotImpl.call(service, ...args),
      validateManualFitAttemptDisplayTimelineImpl: (...args) => validateManualFitAttemptDisplayTimelineImpl.call(service, ...args),
    });
    service.matrixSafeInsertionService.setCallbacks({
      activateManualHotspotRowWithTimes: (...args) => (service.activateManualHotspotRowWithTimes as any)(...args),
      addRouteHotspotToExcludedList: (...args) => (service.addRouteHotspotToExcludedList as any)(...args),
      buildManualFitTimelineFingerprint: (...args) => (service.buildManualFitTimelineFingerprint as any)(...args),
      buildMatrixRescheduledPreviewTimeline: (...args) => (service.matrixRescheduledPreviewService.buildMatrixRescheduledPreviewTimeline as any)(...args),
      calculateRouteEndOverflowMinutes: (...args) => (service.calculateRouteEndOverflowMinutes as any)(...args),
      cloneTimelineRowsForPreview: (...args) => (service.cloneTimelineRowsForPreview as any)(...args),
      computeRowDurationMinutes: (...args) => (service.computeRowDurationMinutes as any)(...args),
      enrichManualFitPreviewTimelineWithOperatingHours: (...args) => (service.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args),
      getCachedRouteMatrixLeg: (...args) => (service.getCachedRouteMatrixLeg as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (service.getPreviewRowDurationMinutes as any)(...args),
      getRouteTimelineForScoring: (...args) => (service.getRouteTimelineForScoring as any)(...args),
      getSelectedManualClosingOverflow: (...args) => (service.getSelectedManualClosingOverflow as any)(...args),
      hmsToSeconds: (...args) => (service.hmsToSeconds as any)(...args),
      minutesToUtcTimeDate: (...args) => (service.minutesToUtcTimeDate as any)(...args),
      parsePreviewTimeRangeToUtcDates: (...args) => (service.parsePreviewTimeRangeToUtcDates as any)(...args),
      removeRouteHotspotFromExcludedList: (...args) => (service.removeRouteHotspotFromExcludedList as any)(...args),
      resolveProgressivePriorityRemovalForManualFitInTx: (...args) => (service.progressivePriorityRemovalService.resolveProgressivePriorityRemovalForManualFitInTx as any)(...args),
      resolveSelectedManualPriority: (...args) => (service.resolveSelectedManualPriority as any)(...args),
      resolveSourceToHotspotLeg: (...args) => (service.resolveSourceToHotspotLeg as any)(...args),
      validateStrictMatrixTimeline: (...args) => (service.validateStrictMatrixTimeline as any)(...args),
    });
    service.previewTimelineApplicationService.setCallbacks({
      classifyManualHotspotCityContext: (...args) => (service.classifyManualHotspotCityContext as any)(...args),
      deriveLooseCityKey: (...args) => (service.deriveLooseCityKey as any)(...args),
      finalizeMatrixPreviewTimeline: (...args) => (service.finalizeMatrixPreviewTimeline as any)(...args),
      getHotspotDurationMinutes: (...args) => (service.getHotspotDurationMinutes as any)(...args),
      getHotspotDurationMinutesFromMasterFirst: (...args) => (service.getHotspotDurationMinutesFromMasterFirst as any)(...args),
      getPreviewRowDurationFromDurationFieldsOnly: (...args) => (service.getPreviewRowDurationFromDurationFieldsOnly as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (service.getPreviewRowDurationMinutes as any)(...args),
      minutesRangeToTimeString: (...args) => (service.minutesRangeToTimeString as any)(...args),
      normalizeHotspotPriority: (...args) => (service.normalizeHotspotPriority as any)(...args),
      parseSegmentEndMinutes: (...args) => (service.parseSegmentEndMinutes as any)(...args),
      parseSegmentStartMinutes: (...args) => (service.parseSegmentStartMinutes as any)(...args),
    });
    service.routeLegCacheService.setCallbacks({
      getOsrmRouteGeometry: (...args) => (service.getOsrmRouteGeometry as any)(...args),
    });
}
