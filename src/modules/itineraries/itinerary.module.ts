// REPLACE-WHOLE-FILE
// FILE: src/itineraries/itineraries.module.ts (adjust path if different)

import { Module } from '@nestjs/common';
import { ItinerariesController } from './itineraries.controller';
import ResAvenueTestController from './resavenue-test.controller';
import { ItinerariesService } from './itineraries.service';
import { ItineraryDetailsService } from './itinerary-details.service';
import { ItineraryHotelDetailsService } from './itinerary-hotel-details.service';
import { ItineraryHotelDetailsTboService } from './itinerary-hotel-details-tbo.service';
import { ItineraryExportService } from './itinerary-export.service';
import { TboHotelBookingService } from './services/tbo-hotel-booking.service';
import { ResAvenueHotelBookingService } from './services/resavenue-hotel-booking.service';
import { HobseHotelBookingService } from './services/hobse-hotel-booking.service';
import { AxisRoomsBookingPushService } from './services/axisrooms-booking-push.service';
import { StaahBookingPushService } from './services/staah-booking-push.service';
import { HotelVoucherService } from './hotel-voucher.service';
import { VehicleVoucherService } from './vehicle-voucher.service';
import { HotelEngineService } from './engines/hotel-engine.service';
import { HotelPricingService } from './hotels/hotel-pricing.service';

import { ItineraryHotspotsEngine } from './engines/itinerary-hotspots.engine';
import { ItineraryVehiclesEngine } from './engines/itinerary-vehicles.engine';

// ✅ New engines + helpers
import { PlanEngineService } from './engines/plan-engine.service';
import { RouteEngineService } from './engines/route-engine.service';
import { HotspotEngineService } from './engines/hotspot-engine.service';
import { TravellersEngineService } from './engines/travellers-engine.service';
import { VehiclesEngineService } from './engines/vehicles-engine.service';
import { ViaRoutesEngine } from './engines/via-routes.engine';
import { RouteValidationService } from './validation/route-validation.service';
import { RouteSuggestionsService } from './route-suggestions.service';
import { RouteSuggestionsV2Service } from './route-suggestions-v2.service';
import { ArrivalHotelPolicyService } from './services/arrival-hotel-policy.service';
import { HotelStayBlockValidationService } from './services/hotel-stay-block-validation.service';
import { VehicleVoucherEmailNotifierService } from './services/vehicle-voucher-email-notifier.service';
import { SameCityCrossDayOptimizerService } from './services/same-city-cross-day-optimizer.service';
import { ItineraryRouteNormalizationService } from './services/itinerary-route-normalization.service';
import { HotelsModule } from '../hotels/hotels.module';
import { ItineraryClipboardService } from './itinerary-clipboard.service';
import { ItineraryPdfService } from './itinerary-pdf.service';
import { ItineraryScenarioSourceController } from './itinerary-scenario-source.controller';
import { ItineraryScenarioSourceService } from './itinerary-scenario-source.service';
import { ItineraryGuideAssignmentService } from './services/itinerary-guide-assignment.service';
import { ItineraryGuideAssignmentWriteService } from './services/itinerary-guide-assignment-write.service';
import { ItineraryConfirmedGuideAssignmentService } from './services/itinerary-confirmed-guide-assignment.service';
import { ItineraryConfirmedGuideCancellationService } from './services/itinerary-confirmed-guide-cancellation.service';
import { ItineraryVehicleBuildStatusService } from './services/itinerary-vehicle-build-status.service';
import { ItineraryVehicleBuildService } from './services/itinerary-vehicle-build.service';
import { ItineraryPlanPersistenceService } from './services/itinerary-plan-persistence.service';
import { ItineraryActivityWorkflowService } from './services/itinerary-activity-workflow.service';
import { ItinerarySmartActivityService } from './services/itinerary-smart-activity.service';
import { ItineraryHotspotWorkflowService } from './services/itinerary-hotspot-workflow.service';
import { ItinerarySelectionWorkflowService } from './services/itinerary-selection-workflow.service';
import { ItineraryQuoteContextService } from './services/itinerary-quote-context.service';
import { ItineraryConfirmationService } from './services/itinerary-confirmation.service';
import { ItineraryHotelConfirmationSupportService } from './services/itinerary-hotel-confirmation-support.service';
import { ItineraryHotelPrebookService } from './services/itinerary-hotel-prebook.service';
import { ItineraryHotelBookingFulfillmentService } from './services/itinerary-hotel-booking-fulfillment.service';
import { ItineraryConfirmedPlanCopyService } from './services/itinerary-confirmed-plan-copy.service';
import { ItineraryCancellationService } from './services/itinerary-cancellation.service';
import { ItineraryListingService } from './services/itinerary-listing.service';
import { ItineraryVoucherReadService } from './services/itinerary-voucher-read.service';
import { ItineraryManualHotspotMatrixService } from './services/itinerary-manual-hotspot-matrix.service';
import { ItineraryManualHotspotPreviewService } from './services/itinerary-manual-hotspot-preview.service';
import { ItineraryManualHotspotMutationService } from './services/itinerary-manual-hotspot-mutation.service';
import { ItineraryManualFitMatrixPlanningService } from './services/itinerary-manual-fit-matrix-planning.service';
import { ItineraryExactAnchorRebuildService } from './services/itinerary-exact-anchor-rebuild.service';
import { ItineraryLowPriorityRemovalService } from './services/itinerary-low-priority-removal.service';
import { ItineraryMatrixSafeInsertionService } from './services/itinerary-matrix-safe-insertion.service';
import { ItineraryPreviewTimelineApplicationService } from './services/itinerary-preview-timeline-application.service';
import { ItineraryRouteLegCacheService } from './services/itinerary-route-leg-cache.service';
import { ItineraryManualHotspotBatchService } from './services/itinerary-manual-hotspot-batch.service';
import { ItineraryManualInsertionFitService } from './services/itinerary-manual-insertion-fit.service';
import { ItineraryProgressivePriorityRemovalService } from './services/itinerary-progressive-priority-removal.service';
import { ItineraryAdaptiveManualHotspotInsertionService } from './services/itinerary-adaptive-manual-hotspot-insertion.service';
import { ItineraryMatrixRescheduledPreviewService } from './services/itinerary-matrix-rescheduled-preview.service';
import { ItineraryConfirmedItineraryDetailsService } from './services/itinerary-confirmed-itinerary-details.service';
import { ItineraryRouteTimingService } from './services/itinerary-route-timing.service';
import { ItineraryManualFitTravelReplicaService } from './services/itinerary-manual-fit-travel-replica.service';
import { ItineraryManualFitGeometryService } from './services/itinerary-manual-fit-geometry.service';
import { ItineraryManualFitAttemptStoreService } from './services/itinerary-manual-fit-attempt-store.service';
import { ItineraryManualFitTimelinePolicyService } from './services/itinerary-manual-fit-timeline-policy.service';
import { ItineraryMatrixPreviewTimelinePolicyService } from './services/itinerary-matrix-preview-timeline-policy.service';
import { ItineraryManualFitRemovalExplanationService } from './services/itinerary-manual-fit-removal-explanation.service';
import { ItineraryManualFitRoutePolicyService } from './services/itinerary-manual-fit-route-policy.service';
import { ItineraryManualFitRouteMatrixPersistenceService } from './services/itinerary-manual-fit-route-matrix-persistence.service';
import { ItineraryManualFitOperatingHoursService } from './services/itinerary-manual-fit-operating-hours.service';
import { ItineraryActivityAvailabilityService } from './services/itinerary-activity-availability.service';
import { ItineraryInvoiceReadService } from './services/itinerary-invoice-read.service';
import { ItineraryHotspotDeletionService } from './services/itinerary-hotspot-deletion.service';
import { ItineraryManualFitValidationService } from './services/itinerary-manual-fit-validation.service';
import { ItineraryManualFitScheduleAttemptService } from './services/itinerary-manual-fit-schedule-attempt.service';
import { ItineraryManualFitCandidateSimulationService } from './services/itinerary-manual-fit-candidate-simulation.service';
import { ItineraryManualFitCandidateSearchService } from './services/itinerary-manual-fit-candidate-search.service';
import { ItineraryManualFitCandidateDataService } from './services/itinerary-manual-fit-candidate-data.service';
import { ItineraryManualHotspotRowService } from './services/itinerary-manual-hotspot-row.service';
import { ItineraryManualHotspotScheduleStateService } from './services/itinerary-manual-hotspot-schedule-state.service';
import { ItineraryManualHotspotRowTimingService } from './services/itinerary-manual-hotspot-row-timing.service';
import { ItineraryManualHotspotOverlapService } from './services/itinerary-manual-hotspot-overlap.service';

@Module({
  imports: [HotelsModule],
  controllers: [ItinerariesController, ResAvenueTestController, ItineraryScenarioSourceController],
  providers: [
    // core services
    ItinerariesService,
    ItineraryDetailsService,
    ItineraryHotelDetailsService,
    ItineraryHotelDetailsTboService,
    ItineraryExportService,
    TboHotelBookingService,
    ResAvenueHotelBookingService,
    HobseHotelBookingService,
    AxisRoomsBookingPushService,
    StaahBookingPushService,
    HotelVoucherService,
    VehicleVoucherService,
    VehicleVoucherEmailNotifierService,
    SameCityCrossDayOptimizerService,
    ItineraryRouteNormalizationService,
    ItineraryGuideAssignmentService,
    ItineraryGuideAssignmentWriteService,
    ItineraryConfirmedGuideAssignmentService,
    ItineraryConfirmedGuideCancellationService,
    ItineraryVehicleBuildStatusService,
    ItineraryVehicleBuildService,
    ItineraryPlanPersistenceService,
    ItineraryActivityWorkflowService,
    ItinerarySmartActivityService,
    ItineraryHotspotWorkflowService,
    ItinerarySelectionWorkflowService,
    ItineraryQuoteContextService,
    ItineraryConfirmationService,
    ItineraryHotelConfirmationSupportService,
    ItineraryHotelPrebookService,
    ItineraryHotelBookingFulfillmentService,
    ItineraryConfirmedPlanCopyService,
    ItineraryCancellationService,
    ItineraryListingService,
    ItineraryVoucherReadService,
    ItineraryManualHotspotMatrixService,
    ItineraryManualHotspotPreviewService,
    ItineraryManualHotspotMutationService,
    ItineraryManualFitMatrixPlanningService,
    ItineraryExactAnchorRebuildService,
    ItineraryLowPriorityRemovalService,
    ItineraryMatrixSafeInsertionService,
    ItineraryPreviewTimelineApplicationService,
    ItineraryRouteLegCacheService,
    ItineraryManualHotspotBatchService,
    ItineraryManualInsertionFitService,
    ItineraryProgressivePriorityRemovalService,
    ItineraryAdaptiveManualHotspotInsertionService,
    ItineraryMatrixRescheduledPreviewService,
    ItineraryConfirmedItineraryDetailsService,
    ItineraryRouteTimingService,
    ItineraryManualFitTravelReplicaService,
    ItineraryManualFitGeometryService,
    ItineraryManualFitAttemptStoreService,
    ItineraryManualFitTimelinePolicyService,
    ItineraryMatrixPreviewTimelinePolicyService,
    ItineraryManualFitRemovalExplanationService,
    ItineraryManualFitRoutePolicyService,
    ItineraryManualFitRouteMatrixPersistenceService,
    ItineraryManualFitOperatingHoursService,
    ItineraryActivityAvailabilityService,
    ItineraryInvoiceReadService,
    ItineraryHotspotDeletionService,
    ItineraryManualFitValidationService,
    ItineraryManualFitScheduleAttemptService,
    ItineraryManualFitCandidateSimulationService,
    ItineraryManualFitCandidateSearchService,
    ItineraryManualFitCandidateDataService,
    ItineraryManualHotspotRowService,
    ItineraryManualHotspotScheduleStateService,
    ItineraryManualHotspotRowTimingService,
    ItineraryManualHotspotOverlapService,

    // existing engines you already had
    HotelEngineService,
    HotelPricingService,
    ItineraryHotspotsEngine,
    ItineraryVehiclesEngine,

    // new quote + engines (PHP-parity + no-hardcoding)
    PlanEngineService,
    RouteEngineService,
    HotspotEngineService,
    TravellersEngineService,
    VehiclesEngineService,
    ViaRoutesEngine,
    RouteValidationService,
    RouteSuggestionsService,
    RouteSuggestionsV2Service,
    ItineraryClipboardService,
    ArrivalHotelPolicyService,
    HotelStayBlockValidationService,
    ItineraryPdfService,
    ItineraryScenarioSourceService,
  ],
})
export class ItinerariesModule {}
