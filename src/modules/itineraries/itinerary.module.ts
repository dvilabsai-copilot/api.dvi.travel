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
import { ItineraryVehicleBuildStatusService } from './services/itinerary-vehicle-build-status.service';
import { ItineraryVehicleBuildService } from './services/itinerary-vehicle-build.service';
import { ItineraryPlanPersistenceService } from './services/itinerary-plan-persistence.service';
import { ItineraryActivityWorkflowService } from './services/itinerary-activity-workflow.service';
import { ItinerarySmartActivityService } from './services/itinerary-smart-activity.service';
import { ItineraryHotspotWorkflowService } from './services/itinerary-hotspot-workflow.service';

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
    ItineraryVehicleBuildStatusService,
    ItineraryVehicleBuildService,
    ItineraryPlanPersistenceService,
    ItineraryActivityWorkflowService,
    ItinerarySmartActivityService,
    ItineraryHotspotWorkflowService,

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
