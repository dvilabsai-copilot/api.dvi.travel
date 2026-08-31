// REPLACE-WHOLE-FILE
// FILE: src/itineraries/itineraries.service.ts

import { Injectable, BadRequestException, NotFoundException, ConflictException, InternalServerErrorException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma.service";
import {
  CreateItineraryDto,
} from "./dto/create-itinerary.dto";
import { ConfirmQuotationDto } from "./dto/confirm-quotation.dto";
import { CancelItineraryDto } from "./dto/cancel-itinerary.dto";
import { LatestItineraryQueryDto } from "./dto/latest-itinerary-query.dto";
import { TransportVoucherDetails } from "./dto/transport-voucher-details.dto";
import { PlanEngineService } from "./engines/plan-engine.service";
import { RouteEngineService } from "./engines/route-engine.service";
import { HotspotEngineService } from "./engines/hotspot-engine.service";
import { HotelEngineService } from "./engines/hotel-engine.service";
import { TravellersEngineService } from "./engines/travellers-engine.service";
import { VehiclesEngineService } from "./engines/vehicles-engine.service";
import { ViaRoutesEngine } from "./engines/via-routes.engine";
import { ItineraryVehiclesEngine } from "./engines/itinerary-vehicles.engine";
import { RouteValidationService } from "./validation/route-validation.service";
import { ItineraryDetailsService } from "./itinerary-details.service";
import { TimeConverter } from "./engines/helpers/time-converter";
import { DistanceHelper } from "./engines/helpers/distance.helper";
import { TboHotelBookingService } from "./services/tbo-hotel-booking.service";
import { ResAvenueHotelBookingService } from "./services/resavenue-hotel-booking.service";
import { HobseHotelBookingService } from "./services/hobse-hotel-booking.service";
import { AxisRoomsBookingPushService } from "./services/axisrooms-booking-push.service";
import { StaahBookingPushService } from "./services/staah-booking-push.service";
import { HotelStayBlockValidationService } from "./services/hotel-stay-block-validation.service";
import { SameCityCrossDayOptimizerService } from "./services/same-city-cross-day-optimizer.service";
import { ItineraryRouteNormalizationService } from './services/itinerary-route-normalization.service';
import { ItineraryHotelDetailsTboService } from "./itinerary-hotel-details-tbo.service";
import { HotelAvailabilitySnapshotService } from './services/hotel-availability-snapshot.service';
import { OfflineHotelCatalogService } from './services/offline-hotel-catalog.service';
import { TimelineEnricher } from "./engines/helpers/timeline.enricher";
import { normalizePassengerTitle } from "../../common/utils/passenger-title.util";
import { SupplementNormalizerService } from "../../modules/hotels/services/supplement-normalizer.service";
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from "../../modules/hotels/hotel-rate-plans";
import { normalizeCityName } from "./utils/city-normalization.util";
import { haversineKm } from "./utils/distance-utils";
import {
  normalizeSupplierRateIdentity,
  supplierRateIdentityMatches,
  resolvePersistedHotelIdentity,
  supplierSelectionKey,
} from './utils/hotel-selection-identity.util';
import { resolveHotelOccupancyPricing } from './utils/hotel-selection-pricing.util';
import {
  buildMissingManualHotspotMatrix as buildMissingManualHotspotMatrixHelper,
  ManualHotspotMatrixBuildResult,
} from './helpers/manual-hotspot-matrix-builder';
import {
  applyManualFitAttemptWithinTransactionImpl,
  assertConfirmedManualHotspotPersistedImpl,
  confirmManualHotspotFitHereImpl,
  extractManualFitPreferredSlotImpl,
  preflightManualFitAttemptConfirmationImpl,
  previewManualHotspotAutoFitHereImpl,
  previewManualHotspotFitHereImpl,
  resolveManualFitHereAnchorImpl,
} from "./helpers/manual-fit-here.helper";
import {
  buildManualFitAttemptComputedDisplayTimelineSnapshotImpl,
  buildManualFitAttemptDisplayTimelineSnapshotImpl,
  buildManualFitAttemptLogImpl,
  buildManualFitAttemptTimelineSnapshotImpl,
  buildManualFitChangesRequiredDisplayImpl,
  buildManualFitFinalizedPreviewTimelineImpl,
  buildManualFitPreviewEnvelopeImpl,
  buildRemovedPrioritySummaryImpl,
  detectManualFitTimingRiskImpl,
  manualFitTimelinePreservesSelectedAnchorImpl,
  removeManualFitDroppedRowsFromTimelineImpl,
  validateManualFitAttemptDisplayTimelineImpl,
} from "./helpers/manual-fit-here-preview.helper";
import { createHash, randomUUID } from "crypto";
import { ItineraryGuideAssignmentService } from './services/itinerary-guide-assignment.service';
import { ItineraryGuideAssignmentWriteService, SaveGuideAssignmentPayload } from './services/itinerary-guide-assignment-write.service';
import { ItineraryConfirmedGuideAssignmentService } from './services/itinerary-confirmed-guide-assignment.service';
import { ItineraryConfirmedGuideCancellationService } from './services/itinerary-confirmed-guide-cancellation.service';
import { ItineraryManualFitAttemptStoreService } from './services/itinerary-manual-fit-attempt-store.service';
import { ItineraryManualFitTimelinePolicyService } from './services/itinerary-manual-fit-timeline-policy.service';
import { ItineraryMatrixPreviewTimelinePolicyService } from './services/itinerary-matrix-preview-timeline-policy.service';
import { ItineraryManualFitRemovalExplanationService } from './services/itinerary-manual-fit-removal-explanation.service';
import { ItineraryManualFitRoutePolicyService } from './services/itinerary-manual-fit-route-policy.service';
import { ItineraryManualFitRouteMatrixPersistenceService } from './services/itinerary-manual-fit-route-matrix-persistence.service';
import { ItineraryManualFitOperatingHoursService } from './services/itinerary-manual-fit-operating-hours.service';
import { ItineraryManualFitValidationService } from './services/itinerary-manual-fit-validation.service';
import { ItineraryManualFitScheduleAttemptService } from './services/itinerary-manual-fit-schedule-attempt.service';
import { ItineraryManualFitCandidateSimulationService } from './services/itinerary-manual-fit-candidate-simulation.service';
import { ItineraryManualFitCandidateSearchService } from './services/itinerary-manual-fit-candidate-search.service';
import { ItineraryManualFitCandidateDataService } from './services/itinerary-manual-fit-candidate-data.service';
import { ItineraryManualHotspotRowService } from './services/itinerary-manual-hotspot-row.service';
import { ItineraryManualHotspotScheduleStateService } from './services/itinerary-manual-hotspot-schedule-state.service';
import { ItineraryManualHotspotRowTimingService } from './services/itinerary-manual-hotspot-row-timing.service';
import { ItineraryManualHotspotOverlapService } from './services/itinerary-manual-hotspot-overlap.service';
import { ItineraryManualHotspotConflictService } from './services/itinerary-manual-hotspot-conflict.service';
import { ItineraryRouteHotspotRebuildService } from './services/itinerary-route-hotspot-rebuild.service';
import { ItineraryHotelCancellationService } from './services/itinerary-hotel-cancellation.service';
import { ItineraryHotelRoomCategoryService } from './services/itinerary-hotel-room-category.service';
import { ItineraryRouteOptimizationService } from './services/itinerary-route-optimization.service';
import { ItineraryActivityImpactService } from './services/itinerary-activity-impact.service';
import { ItineraryTransportFormattingService } from './services/itinerary-transport-formatting.service';
import { ItineraryActivityPricingService } from './services/itinerary-activity-pricing.service';
import { ItineraryActivityTimingPolicyService } from './services/itinerary-activity-timing-policy.service';
import { ItineraryVehicleBuildStatusService } from './services/itinerary-vehicle-build-status.service';
import { ItineraryVehicleBuildService } from './services/itinerary-vehicle-build.service';
import {
  getHotelAvailabilityResetReason,
  ItineraryPlanPersistenceService,
} from './services/itinerary-plan-persistence.service';
import { TransportEarlyArrivalValidationService } from './validation/transport-early-arrival-validation.service';
import { RouteVehicleRestrictionService } from '../route-vehicle-restrictions/route-vehicle-restriction.service';
import { TransportEarlyArrivalOption } from './transport-early-arrival';
import { ItineraryActivityWorkflowService } from './services/itinerary-activity-workflow.service';
import { ItineraryActivityAvailabilityService } from './services/itinerary-activity-availability.service';
import { ItineraryInvoiceReadService } from './services/itinerary-invoice-read.service';
import { ItinerarySmartActivityService } from './services/itinerary-smart-activity.service';
import { ItineraryHotspotWorkflowService } from './services/itinerary-hotspot-workflow.service';
import { ItineraryHotspotDeletionService } from './services/itinerary-hotspot-deletion.service';
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

type ManualInsertionCandidateResult = {
  success: boolean;
  candidateIndex: number;
  rows: any[];
  fullTimeline: any[];
  score: number;
  waitingMinutes: number;
  totalTravelKm: number;
  extraTravelKm: number;
  toAndFroPenalty: number;
  removedOptionalHotspots: any[];
  removedTopPriorityHotspots: any[];
  topPriorityAffected: any[];
  scheduledManualHotspots: any[];
  unscheduledManualHotspots: any[];
  requiresConfirmation: boolean;
  reason: string | null;
  routeEndOverflowMinutes?: number;
  openingHourConflictCount?: number;
  strategyKey?: string;
  strategyLabel?: string;
  strategySummary?: string;
  slotInsights?: Array<{
    slotOrder: number;
    candidateIndex: number;
    distanceDelta: number;
    fromName: string;
    toName: string;
    directKm: number;
    viaKm: number;
    isBest: boolean;
    proposedTimeRange: string | null;
    operatingHours: string | null;
    fitsTiming: boolean;
    fitsOverall: boolean;
    reason: string | null;
  }>;
};

type ManualInsertionPosition = {
  candidateIndex: number;
  anchorOrder: number;
  positionLabel: string;
};

type ManualHotspotCityContext = 'SOURCE_CITY' | 'DESTINATION_CITY' | 'UNKNOWN';

type ManualHotspotTimingPolicy = {
  mode: 'MANUAL_HOTSPOT';
  startTime: string;
  endTime: string;
  isFirstRoute: boolean;
  isLastRoute: boolean;
  autoBuildCutoffBypassed: boolean;
  hotelCheckInCutoff: string;
  lastDayDepartureBufferApplied: boolean;
  allowOffRouteWhenTimePermits?: boolean;
  note: string;
};

type ManualClusterPoint = {
  hotspotId: number;
  routeHotspotId: number;
  name: string;
  hotspotOrder: number;
  effectivePriority: number;
  rawPriority: number;
  isManual: boolean;
  timings: string;
  closingMinute: number;
  startTs: number;
  durationMinutes: number;
  cityKey: string;
  lat: number | null;
  lng: number | null;
};

type ManualCandidateOrder = {
  strategyKey: string;
  strategyLabel: string;
  description: string;
  hotspotOrder: number[];
  removedHotspotIds?: number[];
  needsP3Confirmation?: boolean;
  exactAnchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
  exactAfterHotspotId?: number;
  exactBeforeHotspotId?: number;
};

type ManualScheduleAttempt = {
  source: 'REAL_CLUSTER_SIMULATION' | 'CANDIDATE_WRAPPER';
  strategyKey: string;
  strategyLabel: string;
  description: string;
  hotspotOrder: number[];
  candidateIndex: number;
  previewTimeline?: any[];
  success: boolean;
  requiresConfirmation: boolean;
  readyToApply: boolean;
  routeEndOverflowMinutes: number;
  openingHourConflictCount: number;
  topPriorityAffectedCount: number;
  removedOptionalCount: number;
  removedTopPriorityCount: number;
  waitingMinutes: number;
  extraTravelKm: number;
  totalTravelKm: number;
  timingSafe: boolean;
  selected: boolean;
  summary: string | null;
  reason: string | null;
};

type ManualFitTimingRisk = {
  type: 'PARTIAL_STAY_AFTER_CLOSING';
  severity: 'warning' | 'danger';
  hotspotId: number;
  hotspotName: string;
  proposedVisitStart: string;
  proposedVisitEnd: string;
  closingTime: string;
  requestedDurationMinutes: number;
  usableDurationMinutes: number;
  overflowMinutes: number;
  message: string;
  canForceConfirm: true;
};

type ManualOptimizerAttemptLog = {
  decisionOrder: string[];
  selectedStrategyKey: string | null;
  selectedStrategyLabel: string | null;
  summary: string | null;
  attempts: ManualScheduleAttempt[];
};

type ManualFitHereAnchorIntent = 'AFTER_START' | 'AFTER_ATTRACTION';

type ManualFitHereAnchorType = 'after_travel' | 'BETWEEN_ROWS';

type ManualFitAttemptCacheEntry = {
  attemptId: string;
  planId: number;
  routeId: number;
  selectedHotspotId: number;
  anchorType?: ManualFitHereAnchorType;
  anchorIntent?: ManualFitHereAnchorIntent;
  anchorIndex?: number;
  anchorLabel: string;
  anchorFrom?: string | null;
  anchorTo?: string | null;
  anchorTimeRange?: string | null;
  afterRowType?: string | null;
  beforeRowType?: string | null;
  afterRouteHotspotId?: number | null;
  afterHotspotId?: number | null;
  beforeRouteHotspotId?: number | null;
  beforeHotspotId?: number | null;
  exactSelectedGap?: boolean;
  allowP3Removal: boolean;
  allowP1P2Removal: boolean;
  canConfirm: boolean;
  requiresTimingRiskConfirmation?: boolean;
  requiresPriorityRemovalConfirmation?: boolean;
  timingRisk?: ManualFitTimingRisk | null;
  matrixPreferredSlot?: {
    fromHotspotId?: number;
    toHotspotId?: number;
    slotIndex?: number;
    source?: 'BEST_FIT' | 'EXACT_ANCHOR';
  } | null;
  manualInsertionFitSnapshot?: any;
  proposedTimelineSnapshot?: any[];
  removedHotspotsSnapshot?: any[];
  selectedAnchorSnapshot?: {
    anchorType?: ManualFitHereAnchorType;
    anchorIntent?: ManualFitHereAnchorIntent;
    anchorIndex?: number;
    anchorFrom?: string | null;
    anchorTo?: string | null;
    anchorLabel?: string | null;
    afterHotspotId?: number | null;
    beforeHotspotId?: number | null;
  };
  sourceFingerprint: string;
  proposedTimelineFingerprint: string;
  selectedAnchorPreserved?: boolean;
  selectedHotspotPreserved?: boolean;
  selectedOpeningConflict?: any | null;
  resultType?: string | null;
  acceptedReason?: string | null;
  rejectedReasons?: string[];
  authoritativeTimelineSource?: string | null;
  expiresAt: string;
};

type ResolvedManualFitHereAnchor = {
  anchorType: ManualFitHereAnchorType;
  anchorIntent: ManualFitHereAnchorIntent;
  anchorIndex: number;
  anchorLabel: string;
  anchorFrom?: string | null;
  anchorTo?: string | null;
  anchorTimeRange?: string | null;
  afterRowType?: string | null;
  beforeRowType?: string | null;
  afterRouteHotspotId?: number | null;
  afterHotspotId?: number | null;
  beforeRouteHotspotId?: number | null;
  beforeHotspotId?: number | null;
  exactSelectedGap: boolean;
};

type FitHereStepStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'warning'
  | 'failed'
  | 'info';

type FitHereAttemptLogItem = {
  id: string;
  label: string;
  status: FitHereStepStatus;
  message: string;
  details?: Record<string, any>;
  startedAt?: string;
  completedAt?: string;
};

type ItineraryGuideSlotOption = {
  id: number;
  label: string;
};

type ItineraryGuideAssignmentRow = {
  routeGuideId: number;
  planId: number;
  routeId: number | null;
  routeDate: string | null;
  guideType: number;
  guideId: number;
  guideName: string;
  guideLanguage: string;
  guideLanguageIds: number[];
  guideLanguageLabels: string[];
  guideSlot: string;
  guideSlotIds: number[];
  guideSlotLabels: string[];
  guideCost: number;
};

type ConfirmedGuideSlotRow = {
  confirmedGuideSlotCostId: number;
  guideSlotCostDetailsId: number;
  routeGuideId: number;
  itineraryRouteId: number;
  itineraryRouteDate: string | null;
  guideId: number;
  guideType: number;
  guideSlot: number;
  guideSlotLabel: string;
  guideSlotCost: number;
  cancellationStatus: number;
  cancellationDefectType: number;
};

type ConfirmedGuideAssignmentRow = {
  routeGuideId: number;
  itineraryRouteId: number;
  itineraryRouteDate: string | null;
  guideId: number;
  guideName: string;
  guideType: number;
  guideCost: number;
  guideLanguageIds: number[];
  guideLanguageLabels: string[];
  guideSlotIds: number[];
  guideSlotLabels: string[];
  cancellationStatus: number;
  slots: ConfirmedGuideSlotRow[];
};

const ITINERARY_GUIDE_SLOT_OPTIONS: ItineraryGuideSlotOption[] = [
  { id: 1, label: '8 AM to 1 PM' },
  { id: 2, label: '1 PM to 6 PM' },
  { id: 3, label: '8 AM to 6 PM' },
  { id: 4, label: '6 PM to 9 PM' },
];

function parseFilterDate(value?: string): Date | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;

  const match = raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  const date = match
    ? new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
    : new Date(raw);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function nextDay(date: Date): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + 1);
  return result;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

@Injectable()
export class ItinerariesService {
  private readonly previewDistanceHelper = new DistanceHelper();
  private readonly manualHotspotMatrixBuildLocks = new Set<string>();
  private manualFitAttemptStoreTableEnsured = false;
  private readonly MANUAL_HOTSPOT_EFFECTIVE_PRIORITY = 4;
  private readonly PROTECTED_AUTO_PRIORITY_MAX = 2;
  private readonly CONFIRMATION_REQUIRED_PRIORITY = 3;

  private logItineraryApiTiming(params: {
    api: 'save_basic_info';
    step: string;
    startedAt: number;
    stepStartedAt: number;
    planId?: number | null;
    quoteId?: string | null;
  }): number {
    const now = Date.now();
 console.log('[ITINERARY_API_TIMING]', {
      api: params.api,
      planId: params.planId ?? null,
      quoteId: params.quoteId ?? null,
      step: params.step,
      durationMs: now - params.stepStartedAt,
      totalElapsedMs: now - params.startedAt,
    });
    return now;
  }

  private parseRouteFamilyQuote(quoteId: string | undefined | null): {
    baseQuoteId: string;
    routeVariantIndex: number | null;
  } | null {
    const raw = String(quoteId || '').trim();
    if (!raw) return null;

    const match = raw.match(/^(.*)-R(\d+)$/i);
    if (!match) {
      return {
        baseQuoteId: raw,
        routeVariantIndex: null,
      };
    }

    const baseQuoteId = String(match[1] || '').trim();
    const routeVariantIndex = Number.parseInt(String(match[2] || ''), 10);

    if (!baseQuoteId || !Number.isFinite(routeVariantIndex) || routeVariantIndex <= 0) {
      return {
        baseQuoteId: raw,
        routeVariantIndex: null,
      };
    }

    return {
      baseQuoteId,
      routeVariantIndex,
    };
  }

  private async applySameCityCrossDayOptimizerAfterSave(planId: number, quoteId?: string | null): Promise<void> {
    const result = await this.sameCityCrossDayOptimizerService.analyzePlanId(planId, {
      quoteId: quoteId || undefined,
      dryRun: false,
      maxMoves: 10,
    });

 console.log('[ItinerariesService][SameCityCrossDayOptimizerAfterSave]', {
      planId,
      quoteId: quoteId || null,
      enabled: result.enabled,
      applied: result.applied,
      proposedMoves: result.proposedMoves.length,
      skippedReason: result.skippedReason,
    });
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly planEngine: PlanEngineService,
    private readonly routeEngine: RouteEngineService,
    private readonly hotspotEngine: HotspotEngineService,
    private readonly hotelEngine: HotelEngineService,
    private readonly travellersEngine: TravellersEngineService,
    private readonly vehiclesEngine: VehiclesEngineService,
    private readonly viaRoutesEngine: ViaRoutesEngine,
    private readonly itineraryVehiclesEngine: ItineraryVehiclesEngine,
    private readonly routeValidation: RouteValidationService,
    private readonly itineraryDetails: ItineraryDetailsService,
    private readonly tboHotelBooking: TboHotelBookingService,
    private readonly resavenueHotelBooking: ResAvenueHotelBookingService,
    private readonly hobseHotelBooking: HobseHotelBookingService,
    private readonly axisroomsBookingPushService: AxisRoomsBookingPushService,
    private readonly staahBookingPushService: StaahBookingPushService,
    private readonly hotelStayBlockValidationService: HotelStayBlockValidationService,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
    private readonly hotelAvailabilitySnapshotService: HotelAvailabilitySnapshotService,
    private readonly offlineHotelCatalogService: OfflineHotelCatalogService,
    private readonly supplementNormalizer: SupplementNormalizerService,
    private readonly sameCityCrossDayOptimizerService: SameCityCrossDayOptimizerService,
    private readonly routeNormalization: ItineraryRouteNormalizationService = new ItineraryRouteNormalizationService(),
    private readonly guideAssignmentService: ItineraryGuideAssignmentService = new ItineraryGuideAssignmentService(prisma),
    private readonly guideAssignmentWriteService: ItineraryGuideAssignmentWriteService = new ItineraryGuideAssignmentWriteService(
      prisma,
      guideAssignmentService,
    ),
    private readonly confirmedGuideAssignmentService: ItineraryConfirmedGuideAssignmentService = new ItineraryConfirmedGuideAssignmentService(
      prisma,
      guideAssignmentService,
    ),
    private readonly vehicleBuildStatusService: ItineraryVehicleBuildStatusService = new ItineraryVehicleBuildStatusService(prisma),
    private readonly vehicleBuildService: ItineraryVehicleBuildService = new ItineraryVehicleBuildService(
      prisma,
      routeEngine,
      vehiclesEngine,
      itineraryVehiclesEngine,
      vehicleBuildStatusService,
    ),
    private readonly planPersistenceService: ItineraryPlanPersistenceService = new ItineraryPlanPersistenceService(
      prisma,
      planEngine,
      routeEngine,
      hotspotEngine,
      hotelEngine,
      travellersEngine,
      viaRoutesEngine,
      routeValidation,
      vehicleBuildService,
      new TransportEarlyArrivalValidationService(),
      new RouteVehicleRestrictionService(prisma),
    ),
    private readonly activityWorkflowService: ItineraryActivityWorkflowService = new ItineraryActivityWorkflowService(
      prisma,
      hotspotEngine,
    ),
    private readonly activityAvailabilityService: ItineraryActivityAvailabilityService = new ItineraryActivityAvailabilityService(prisma),
    private readonly invoiceReadService: ItineraryInvoiceReadService = new ItineraryInvoiceReadService(prisma),
    private readonly smartActivityService: ItinerarySmartActivityService = new ItinerarySmartActivityService(prisma),
    private readonly hotspotWorkflowService: ItineraryHotspotWorkflowService = new ItineraryHotspotWorkflowService(
      prisma,
      hotspotEngine,
    ),
    private readonly hotspotDeletionService: ItineraryHotspotDeletionService = new ItineraryHotspotDeletionService(
      prisma,
      hotspotEngine,
    ),
    private readonly selectionWorkflowService: ItinerarySelectionWorkflowService = new ItinerarySelectionWorkflowService(
      prisma,
      routeEngine,
      itineraryVehiclesEngine,
      hotelDetailsTboService,
      undefined,
      hotelAvailabilitySnapshotService,
    ),
    private readonly quoteContextService: ItineraryQuoteContextService = new ItineraryQuoteContextService(prisma),
    private readonly confirmationService: ItineraryConfirmationService = new ItineraryConfirmationService(
      prisma,
      itineraryDetails,
      hotelStayBlockValidationService,
    ),
    private readonly hotelConfirmationSupportService: ItineraryHotelConfirmationSupportService = new ItineraryHotelConfirmationSupportService(
      prisma,
      itineraryDetails,
    ),
    private readonly hotelPrebookService: ItineraryHotelPrebookService = new ItineraryHotelPrebookService(
      prisma,
      tboHotelBooking,
      supplementNormalizer,
    ),
    private readonly hotelBookingFulfillmentService: ItineraryHotelBookingFulfillmentService = new ItineraryHotelBookingFulfillmentService(
      prisma,
      tboHotelBooking,
      resavenueHotelBooking,
      hobseHotelBooking,
      axisroomsBookingPushService,
      staahBookingPushService,
    ),
    private readonly confirmedPlanCopyService: ItineraryConfirmedPlanCopyService = new ItineraryConfirmedPlanCopyService(),
    private readonly cancellationService: ItineraryCancellationService = new ItineraryCancellationService(
      prisma,
      tboHotelBooking,
      resavenueHotelBooking,
      hobseHotelBooking,
    ),
    private readonly confirmedGuideCancellationService: ItineraryConfirmedGuideCancellationService = new ItineraryConfirmedGuideCancellationService(
      prisma,
      confirmedGuideAssignmentService,
    ),
    private readonly listingService: ItineraryListingService = new ItineraryListingService(prisma),
    private readonly voucherReadService: ItineraryVoucherReadService = new ItineraryVoucherReadService(prisma),
    private readonly manualHotspotMatrixService: ItineraryManualHotspotMatrixService = new ItineraryManualHotspotMatrixService(prisma),
    private readonly manualHotspotPreviewService: ItineraryManualHotspotPreviewService = new ItineraryManualHotspotPreviewService(prisma),
    private readonly manualInsertionFitService: ItineraryManualInsertionFitService = new ItineraryManualInsertionFitService(),
    private readonly progressivePriorityRemovalService: ItineraryProgressivePriorityRemovalService = new ItineraryProgressivePriorityRemovalService(),
    private readonly adaptiveManualHotspotInsertionService: ItineraryAdaptiveManualHotspotInsertionService = new ItineraryAdaptiveManualHotspotInsertionService(),
    private readonly matrixRescheduledPreviewService: ItineraryMatrixRescheduledPreviewService = new ItineraryMatrixRescheduledPreviewService(),
    private readonly confirmedItineraryDetailsService: ItineraryConfirmedItineraryDetailsService = new ItineraryConfirmedItineraryDetailsService(null as any),
    private readonly routeTimingService: ItineraryRouteTimingService = new ItineraryRouteTimingService(null as any, null as any, new RouteVehicleRestrictionService(prisma)),
    private readonly manualFitTravelReplicaService: ItineraryManualFitTravelReplicaService = new ItineraryManualFitTravelReplicaService(),
    private readonly manualFitGeometryService: ItineraryManualFitGeometryService = new ItineraryManualFitGeometryService(),
    private readonly manualHotspotBatchService: ItineraryManualHotspotBatchService = new ItineraryManualHotspotBatchService(hotspotEngine),
    private readonly manualHotspotMutationService: ItineraryManualHotspotMutationService = new ItineraryManualHotspotMutationService(
      prisma,
      hotspotEngine,
    ),
    private readonly manualFitMatrixPlanningService: ItineraryManualFitMatrixPlanningService = new ItineraryManualFitMatrixPlanningService(prisma),
    private readonly exactAnchorRebuildService: ItineraryExactAnchorRebuildService = new ItineraryExactAnchorRebuildService(prisma),
    private readonly lowPriorityRemovalService: ItineraryLowPriorityRemovalService = new ItineraryLowPriorityRemovalService(prisma),
    private readonly matrixSafeInsertionService: ItineraryMatrixSafeInsertionService = new ItineraryMatrixSafeInsertionService(prisma),
    private readonly previewTimelineApplicationService: ItineraryPreviewTimelineApplicationService = new ItineraryPreviewTimelineApplicationService(prisma),
    private readonly routeLegCacheService: ItineraryRouteLegCacheService = new ItineraryRouteLegCacheService(prisma),
    private readonly manualFitAttemptStoreService: ItineraryManualFitAttemptStoreService = new ItineraryManualFitAttemptStoreService(prisma),
    private readonly manualFitTimelinePolicyService: ItineraryManualFitTimelinePolicyService = new ItineraryManualFitTimelinePolicyService(),
    private readonly matrixPreviewTimelinePolicyService: ItineraryMatrixPreviewTimelinePolicyService = new ItineraryMatrixPreviewTimelinePolicyService(),
    private readonly manualFitRemovalExplanationService: ItineraryManualFitRemovalExplanationService = new ItineraryManualFitRemovalExplanationService(),
    private readonly manualFitRoutePolicyService: ItineraryManualFitRoutePolicyService = new ItineraryManualFitRoutePolicyService(),
    private readonly manualFitRouteMatrixPersistenceService: ItineraryManualFitRouteMatrixPersistenceService = new ItineraryManualFitRouteMatrixPersistenceService(),
    private readonly manualFitOperatingHoursService: ItineraryManualFitOperatingHoursService = new ItineraryManualFitOperatingHoursService(prisma),
    private readonly manualFitValidationService: ItineraryManualFitValidationService = new ItineraryManualFitValidationService(),
    private readonly manualFitScheduleAttemptService: ItineraryManualFitScheduleAttemptService = new ItineraryManualFitScheduleAttemptService(),
    private readonly manualFitCandidateSimulationService: ItineraryManualFitCandidateSimulationService = new ItineraryManualFitCandidateSimulationService(),
    private readonly manualFitCandidateSearchService: ItineraryManualFitCandidateSearchService = new ItineraryManualFitCandidateSearchService(),
    private readonly manualFitCandidateDataService: ItineraryManualFitCandidateDataService = new ItineraryManualFitCandidateDataService(),
    private readonly manualHotspotRowService: ItineraryManualHotspotRowService = new ItineraryManualHotspotRowService(),
    private readonly manualHotspotScheduleStateService: ItineraryManualHotspotScheduleStateService = new ItineraryManualHotspotScheduleStateService(),
    private readonly manualHotspotRowTimingService: ItineraryManualHotspotRowTimingService = new ItineraryManualHotspotRowTimingService(),
    private readonly manualHotspotOverlapService: ItineraryManualHotspotOverlapService = new ItineraryManualHotspotOverlapService(),
    private readonly manualHotspotConflictService: ItineraryManualHotspotConflictService = new ItineraryManualHotspotConflictService(),
    private readonly routeHotspotRebuildService: ItineraryRouteHotspotRebuildService = new ItineraryRouteHotspotRebuildService(prisma, hotspotEngine, new RouteVehicleRestrictionService(prisma)),
    private readonly hotelCancellationService: ItineraryHotelCancellationService = new ItineraryHotelCancellationService(prisma),
    private readonly hotelRoomCategoryService: ItineraryHotelRoomCategoryService = new ItineraryHotelRoomCategoryService(prisma, hotelDetailsTboService),
    private readonly routeOptimizationService: ItineraryRouteOptimizationService = new ItineraryRouteOptimizationService(prisma, routeNormalization),
    private readonly activityImpactService: ItineraryActivityImpactService = new ItineraryActivityImpactService(prisma, hotspotEngine),
    private readonly transportFormattingService: ItineraryTransportFormattingService = new ItineraryTransportFormattingService(),
    private readonly activityPricingService: ItineraryActivityPricingService = new ItineraryActivityPricingService(prisma),
    private readonly activityTimingPolicyService: ItineraryActivityTimingPolicyService = new ItineraryActivityTimingPolicyService(),
  ) {
    this.confirmedGuideCancellationService.setLogCancellationActionCallback(
      (...args) => (this.cancellationService.logCancellationAction as any)(...args),
    );
    this.manualFitTimelinePolicyService.setCallbacks({
      parseSegmentEndMinutes: (...args) => (this.parseSegmentEndMinutes as any)(...args),
    });
    this.matrixPreviewTimelinePolicyService.setCallbacks({
      parseSegmentStartMinutes: (...args) => (this.parseSegmentStartMinutes as any)(...args),
      parseSegmentEndMinutes: (...args) => (this.parseSegmentEndMinutes as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (this.parsePreviewTimeToMinutes as any)(...args),
      timeToMinutes: (...args) => (this.timeToMinutes as any)(...args),
      getHotspotDurationMinutes: (...args) => (this.getHotspotDurationMinutes as any)(...args),
    });
    this.manualFitRemovalExplanationService.setCallbacks({
      parsePreviewTimeToMinutes: (...args) => (this.parsePreviewTimeToMinutes as any)(...args),
      parseManualHotspotLatestClosingMinute: (...args) => (this.parseManualHotspotLatestClosingMinute as any)(...args),
      formatTime: (...args) => (this.formatTime as any)(...args),
      minutesToUtcTimeDate: (...args) => (this.minutesToUtcTimeDate as any)(...args),
    });
    this.manualFitRouteMatrixPersistenceService.setCallbacks({
      findNearestProgressOnRoute: (...args) => (this.findNearestProgressOnRoute as any)(...args),
      normalizeLocationText: (...args) => (this.normalizeLocationText as any)(...args),
      haversineKmForRouteProjection: (...args) => (this.haversineKmForRouteProjection as any)(...args),
      getOsrmRouteGeometry: (...args) => (this.getOsrmRouteGeometry as any)(...args),
      getOsrmDistanceKm: (...args) => (this.getOsrmDistanceKm as any)(...args),
      deriveLooseCityKey: (...args) => (this.deriveLooseCityKey as any)(...args),
    });
    this.manualFitOperatingHoursService.setCallbacks({
      formatTime: (...args) => (this.formatTime as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (this.parsePreviewTimeToMinutes as any)(...args),
    });
    this.manualFitValidationService.setCallbacks({
      distanceBetweenHotspots: (...args) => (this.distanceBetweenHotspots as any)(...args),
      evaluateTimelineRowAgainstOperatingHours: (...args) => (this.evaluateTimelineRowAgainstOperatingHours as any)(...args),
      calculateRouteEndOverflowMinutes: (...args) => (this.calculateRouteEndOverflowMinutes as any)(...args),
    });
    this.manualFitScheduleAttemptService.setCallbacks({
      distanceBetweenHotspots: (...args) => (this.distanceBetweenHotspots as any)(...args),
      calculateInsertionExtraDistance: (...args) => (this.calculateInsertionExtraDistance as any)(...args),
      calculateToAndFroPenalty: (...args) => (this.calculateToAndFroPenalty as any)(...args),
      isAttractionTimelineRow: (...args) => (this.isAttractionTimelineRow as any)(...args),
      getTimelineRowHotspotId: (...args) => (this.getTimelineRowHotspotId as any)(...args),
      manualFitTimelinePreservesSelectedAnchor: (...args) => (this.manualFitTimelinePreservesSelectedAnchor as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (this.parsePreviewTimeToMinutes as any)(...args),
      explainManualScheduleAttempt: (...args) => (this.explainManualScheduleAttempt as any)(...args),
    });
    this.manualFitCandidateSimulationService.setCallbacks({
      rebuildManualHotspotSet: (...args) => (this.rebuildManualHotspotSet as any)(...args),
      buildRouteHotspotInsertionCandidates: (...args) => (this.manualFitCandidateDataService.buildRouteHotspotInsertionCandidates as any)(...args),
      getManualHotspotScheduleState: (...args) => (this.getManualHotspotScheduleState as any)(...args),
      getRouteTimelineForScoring: (...args) => (this.getRouteTimelineForScoring as any)(...args),
      manualFitTimelinePreservesSelectedAnchor: (...args) => (this.manualFitTimelinePreservesSelectedAnchor as any)(...args),
      buildExactAnchorSequentialTimelineAfterRemoval: (...args) => (this.buildExactAnchorSequentialTimelineAfterRemoval as any)(...args),
      enrichManualFitPreviewTimelineWithOperatingHours: (...args) => (this.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args),
      calculateWaitingMinutes: (...args) => (this.calculateWaitingMinutes as any)(...args),
      calculateTravelMetricsFromTimeline: (...args) => (this.calculateTravelMetricsFromTimeline as any)(...args),
      detectTopPriorityImpact: (...args) => (this.detectTopPriorityImpact as any)(...args),
      calculateRouteEndOverflowMinutes: (...args) => (this.calculateRouteEndOverflowMinutes as any)(...args),
      scoreManualInsertionCandidate: (...args) => (this.scoreManualInsertionCandidate as any)(...args),
      getManualEffectivePriority: (...args) => (this.getManualEffectivePriority as any)(...args),
      explainRejectedCandidate: (...args) => (this.explainRejectedCandidate as any)(...args),
    });
    this.manualFitCandidateSearchService.setCallbacks({
      findRouteDetails: async (tx, planId, routeId) => (tx as any).dvi_itinerary_route_details.findFirst({
        where: { itinerary_plan_ID: Number(planId), itinerary_route_ID: Number(routeId), deleted: 0 },
      }),
      buildRouteHotspotInsertionCandidates: (...args) => (this.buildRouteHotspotInsertionCandidates as any)(...args),
      buildManualInsertionPositions: (...args) => (this.buildManualInsertionPositions as any)(...args),
      buildPreferredManualInsertionIndex: (...args) => (this.buildPreferredManualInsertionIndex as any)(...args),
      simulateManualInsertionAtPosition: (...args) => (this.simulateManualInsertionAtPosition as any)(...args),
      buildManualSlotInsights: (...args) => (this.buildManualSlotInsights as any)(...args),
      chooseBestManualInsertionCandidate: (...args) => (this.chooseBestManualInsertionCandidate as any)(...args),
      rebuildManualHotspotSet: (...args) => (this.rebuildManualHotspotSet as any)(...args),
      buildManualClusterCandidateOrders: (...args) => (this.buildManualClusterCandidateOrders as any)(...args),
      simulateManualClusterOrder: (...args) => (this.simulateManualClusterOrder as any)(...args),
      compareManualScheduleAttempts: (...args) => (this.compareManualScheduleAttempts as any)(...args),
    });
    this.manualFitCandidateDataService.setCallbacks({
      normalizeManualHotspotIds: (...args) => (this.normalizeManualHotspotIds as any)(...args),
      normalizeHotspotPriority: (...args) => (this.normalizeHotspotPriority as any)(...args),
      getHotspotDurationMinutes: (...args) => (this.getHotspotDurationMinutes as any)(...args),
      classifyHotspotsForManualInsertion: (...args) => (this.classifyHotspotsForManualInsertion as any)(...args),
    });
    this.manualHotspotRowService.setCallbacks({
      computeRowDurationMinutes: (...args) => (this.computeRowDurationMinutes as any)(...args),
    });
    this.manualHotspotScheduleStateService.setCallbacks({
      computeRowDurationMinutes: (...args) => (this.computeRowDurationMinutes as any)(...args),
      hasAnyNonOverlappingManualRow: (...args) => (this.manualHotspotOverlapService.hasAnyNonOverlappingManualRow as any)(...args),
      manualRowHasNoOverlap: (...args) => (this.manualHotspotOverlapService.manualRowHasNoOverlap as any)(...args),
    });
    this.manualHotspotRowTimingService.setCallbacks({
      normalizeManualHotspotIds: (...args) => (this.normalizeManualHotspotIds as any)(...args),
      computeRowDurationMinutes: (...args) => (this.computeRowDurationMinutes as any)(...args),
      minutesToUtcTimeDate: (...args) => (this.minutesToUtcTimeDate as any)(...args),
    });
    this.routeHotspotRebuildService.setCallbacks({
      applySameCityCrossDayOptimizerAfterSave: (...args) => (this.applySameCityCrossDayOptimizerAfterSave as any)(...args),
      forceRebuildVehiclePricingAfterHotspotChange: (...args) => (this.forceRebuildVehiclePricingAfterHotspotChange as any)(...args),
    });
    this.activityImpactService.setCallbacks({
      timeToMinutes: (...args) => (this.timeToMinutes as any)(...args),
      addMinutesToTime: (...args) => (this.addMinutesToTime as any)(...args),
    });
    this.transportFormattingService.setFormatTimeCallback((time) => this.formatTime(time));
    this.activityAvailabilityService.setCalculateActivityPlanPricingCallback(
      (params) => this.calculateActivityPlanPricing(params),
    );
    this.hotspotDeletionService.setForceRebuildVehiclePricingCallback(
      (planId, routeId) => this.forceRebuildVehiclePricingAfterHotspotChange(planId, routeId),
    );
    this.planPersistenceService.setCallbacks({
      optimizeRouteOrder: (routes) => this.optimizeRouteOrder(routes),
      applySameCityOptimizer: (planId, quoteId) => this.applySameCityCrossDayOptimizerAfterSave(planId, quoteId),
      getPlanForEdit: (planId) => this.getPlanForEdit(planId),
    });
    this.activityWorkflowService.setCallbacks({
      simulateActivityImpactBeforeAdd: (data) => this.simulateActivityImpactBeforeAdd(data),
      calculateActivityPlanPricing: (...args) => (this.calculateActivityPlanPricing as any)(...args),
      timeToMinutes: (time) => this.timeToMinutes(time),
      addMinutesToTime: (time, minutes) => this.addMinutesToTime(time, minutes),
      checkActivityTimingConflicts: (...args) => (this.checkActivityTimingConflicts as any)(...args),
    });
    this.smartActivityService.setCallbacks({
      timeToMinutes: (time) => this.timeToMinutes(time),
      addMinutesToTime: (time, minutes) => this.addMinutesToTime(time, minutes),
      checkActivityTimingConflicts: (...args) => (this.checkActivityTimingConflicts as any)(...args),
      formatTime: (time) => this.formatTime(time),
    });
    this.hotspotWorkflowService.setCallbacks({
      classifyManualHotspotCityContext: (...args) => (this.classifyManualHotspotCityContext as any)(...args),
      deriveLooseCityKey: (...args) => (this.deriveLooseCityKey as any)(...args),
      hmsToSeconds: (...args) => (this.hmsToSeconds as any)(...args),
      normalizeLocationText: (...args) => (this.normalizeLocationText as any)(...args),
      previewManualHotspot: (...args) => (this.previewManualHotspot as any)(...args),
    });
    this.confirmationService.setCallbacks({
      syncSelectedHotelDraftRowsForConfirmation: (...args) => (this.syncSelectedHotelDraftRowsForConfirmation as any)(...args),
      getAgentWalletBalance: (...args) => (this.getAgentWalletBalance as any)(...args),
      formatDateOnly: (...args) => (this.formatDateOnly as any)(...args),
      copyDraftToConfirmed: (...args) => (this.copyDraftToConfirmed as any)(...args),
    });
    this.hotelConfirmationSupportService.setCallbacks({
      mergeConsecutiveSupplierHotelBookings: (...args) => (this.confirmationService.mergeConsecutiveSupplierHotelBookings as any)(...args),
      pruneHotelBookingsCoveredByMultiNight: (...args) => (this.confirmationService.pruneHotelBookingsCoveredByMultiNight as any)(...args),
      getProviderBookableHotelBookings: (...args) => (this.confirmationService.getProviderBookableHotelBookings as any)(...args),
      getConfirmHotelGroupType: (...args) => (this.confirmationService.getConfirmHotelGroupType as any)(...args),
      uniquePositiveNumbers: (...args) => (this.confirmationService.uniquePositiveNumbers as any)(...args),
      bookingKey: (...args) => (this.confirmationService.bookingKey as any)(...args),
      assertConsistentMultiNightHotelSelection: (...args) => (this.confirmationService.assertConsistentMultiNightHotelSelection as any)(...args),
      getAgentWalletBalance: (...args) => (this.getAgentWalletBalance as any)(...args),
    });
    this.hotelPrebookService.setCallbacks({
      normalizeToArray: (...args) => (this.normalizeToArray as any)(...args),
      normalizeToUniqueStrings: (...args) => (this.normalizeToUniqueStrings as any)(...args),
      inferMealPlanFromInclusions: (...args) => (this.inferMealPlanFromInclusions as any)(...args),
      getProviderBookableHotelBookings: (...args) => (this.confirmationService.getProviderBookableHotelBookings as any)(...args),
    });
    this.hotelBookingFulfillmentService.setCallbacks({
      bookingKey: (...args) => (this.confirmationService.bookingKey as any)(...args),
      isBookingResultSuccess: (...args) => (this.confirmationService.isBookingResultSuccess as any)(...args),
      filterAlreadySuccessfulBookings: (...args) => (this.filterAlreadySuccessfulBookings as any)(...args),
      finalizeConfirmationFinancials: (...args) => (this.finalizeConfirmationFinancials as any)(...args),
      getConfirmedItineraryDetails: (...args) => (this.confirmedItineraryDetailsService.getConfirmedItineraryDetails as any)(...args),
      mergeConsecutiveSupplierHotelBookings: (...args) => (this.confirmationService.mergeConsecutiveSupplierHotelBookings as any)(...args),
      pruneHotelBookingsCoveredByMultiNight: (...args) => (this.confirmationService.pruneHotelBookingsCoveredByMultiNight as any)(...args),
      getProviderBookableHotelBookings: (...args) => (this.confirmationService.getProviderBookableHotelBookings as any)(...args),
    });
    this.voucherReadService.setCallbacks({
      toDateOnly: (...args) => (this.toDateOnly as any)(...args),
      getInvoiceToLabel: (...args) => (this.getInvoiceToLabel as any)(...args),
      getVoucherStatusLabel: (...args) => (this.getVoucherStatusLabel as any)(...args),
      formatTransportVoucherDate: (...args) => (this.formatTransportVoucherDate as any)(...args),
      buildTransportDateRange: (...args) => (this.buildTransportDateRange as any)(...args),
      buildPassengerMixLabel: (...args) => (this.buildPassengerMixLabel as any)(...args),
      buildTransportVoucherNumber: (...args) => (this.buildTransportVoucherNumber as any)(...args),
      shortTransportLocationName: (...args) => (this.shortTransportLocationName as any)(...args),
      decodeTransportHtml: (...args) => (this.decodeTransportHtml as any)(...args),
      parseTransportFlightDetails: (...args) => (this.parseTransportFlightDetails as any)(...args),
      formatTime: (...args) => (this.formatTime as any)(...args),
    });
    this.manualHotspotMatrixService.setCallbacks({
      deriveLooseCityKey: (value) => this.deriveLooseCityKey(value),
      normalizeLocationText: (value) => this.normalizeLocationText(value),
    });
    this.manualHotspotPreviewService.setCallbacks({
      ensureManualFitAttemptStoreTable: (...args) => (this.manualFitAttemptStoreService.ensureTable as any)(...args),
      normalizeManualHotspotIds: (...args) => (this.normalizeManualHotspotIds as any)(...args),
      isRetryableManualPreviewTransactionError: (...args) => (this.isRetryableManualPreviewTransactionError as any)(...args),
      runManualHotspotBatchWithinTransaction: (...args) => (this.manualHotspotBatchService.runManualHotspotBatchWithinTransaction as any)(...args),
      activateManualHotspotRowWithTimes: (...args) => (this.activateManualHotspotRowWithTimes as any)(...args),
      applyMatrixSafeManualHotspotInsertionInTx: (...args) => (this.applyMatrixSafeManualHotspotInsertionInTx as any)(...args),
      buildManualFitTravelReplicaDisplayFields: (...args) => (this.manualFitTravelReplicaService.buildManualFitTravelReplicaDisplayFields as any)(...args),
      cleanupStaleManualHotspotRows: (...args) => (this.cleanupStaleManualHotspotRows as any)(...args),
      deleteManualFitAttemptEntry: (...args) => (this.deleteManualFitAttemptEntry as any)(...args),
      getActiveRouteManualFitRemovalEvidence: (...args) => (this.getActiveRouteManualFitRemovalEvidence as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      getRouteTimelineForScoring: (...args) => (this.getRouteTimelineForScoring as any)(...args),
      loadManualFitAttemptEntry: (...args) => (this.loadManualFitAttemptEntry as any)(...args),
      manualFitTimelinePreservesSelectedAnchor: (...args) => (this.manualFitTimelinePreservesSelectedAnchor as any)(...args),
      buildExactAnchorSequentialTimelineAfterRemoval: (...args) => (this.buildExactAnchorSequentialTimelineAfterRemoval as any)(...args),
      buildManualFitChangesRequiredDisplay: (...args) => (this.buildManualFitChangesRequiredDisplay as any)(...args),
      buildManualFitFinalizedPreviewTimeline: (...args) => (this.buildManualFitFinalizedPreviewTimeline as any)(...args),
      buildRemovedPrioritySummary: (...args) => (this.buildRemovedPrioritySummary as any)(...args),
      enrichManualFitPreviewTimelineWithOperatingHours: (...args) => (this.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args),
      formatManualDurationMinutes: (...args) => (this.formatManualDurationMinutes as any)(...args),
      formatTime: (...args) => (this.formatTime as any)(...args),
      getManualFitRemovalHotspotId: (...args) => (this.getManualFitRemovalHotspotId as any)(...args),
      markSelectedManualOperatingHourConflicts: (...args) => (this.markSelectedManualOperatingHourConflicts as any)(...args),
      minutesToUtcTimeDate: (...args) => (this.minutesToUtcTimeDate as any)(...args),
      normalizeExactAnchorManualInsertionFit: (...args) => (this.normalizeExactAnchorManualInsertionFit as any)(...args),
      parseManualHotspotLatestClosingMinute: (...args) => (this.parseManualHotspotLatestClosingMinute as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (this.parsePreviewTimeToMinutes as any)(...args),
      parsePreviewTimeRangeToUtcDates: (...args) => (this.parsePreviewTimeRangeToUtcDates as any)(...args),
      sanitizeUserFacingManualFitRemovals: (...args) => (this.sanitizeUserFacingManualFitRemovals as any)(...args),
      saveManualFitAttemptEntry: (...args) => (this.saveManualFitAttemptEntry as any)(...args),
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
    this.manualInsertionFitService.setCallbacks(
      Object.fromEntries(
        manualInsertionFitCallbackNames.map((name) => [
          name,
          (...args: any[]) => (this as any)[name](...args),
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
    this.progressivePriorityRemovalService.setCallbacks(
      Object.fromEntries(
        progressivePriorityRemovalCallbackNames.map((name) => [
          name,
          (...args: any[]) => (this as any)[name](...args),
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
    this.adaptiveManualHotspotInsertionService.setCallbacks(
      Object.fromEntries(
        adaptiveManualHotspotInsertionCallbackNames.map((name) => [
          name,
          (...args: any[]) => (this as any)[name](...args),
        ]),
      ),
    );
    this.matrixRescheduledPreviewService.setCallbacks({
      assertTimelineOrderForMatrixPreview: (...args) => (this.assertTimelineOrderForMatrixPreview as any)(...args),
      finalizeMatrixPreviewTimeline: (...args) => (this.finalizeMatrixPreviewTimeline as any)(...args),
      getHotspotDurationMinutesFromMasterFirst: (...args) => (this.getHotspotDurationMinutesFromMasterFirst as any)(...args),
      getPreviewRowDurationFromDurationFieldsOnly: (...args) => (this.getPreviewRowDurationFromDurationFieldsOnly as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      hmsToSeconds: (...args) => (this.hmsToSeconds as any)(...args),
      minutesRangeToTimeString: (...args) => (this.minutesRangeToTimeString as any)(...args),
      minutesToUtcTimeDate: (...args) => (this.minutesToUtcTimeDate as any)(...args),
      parsePreviewTimeToMinutes: (...args) => (this.parsePreviewTimeToMinutes as any)(...args),
      normalizePreviewTimeText: (...args) => (this.normalizePreviewTimeText as any)(...args),
      parseSegmentStartMinutes: (...args) => (this.parseSegmentStartMinutes as any)(...args),
      parseSegmentEndMinutes: (...args) => (this.parseSegmentEndMinutes as any)(...args),
      formatPreviewTravelDuration: (...args) => (this.formatPreviewTravelDuration as any)(...args),
      getCachedRouteDurationMinutes: (...args) => (this.getCachedRouteDurationMinutes as any)(...args),
      estimateDurationFromDistance: (...args) => (this.estimateDurationFromDistance as any)(...args),
      chooseReliableTravelDistanceKm: (...args) => (this.chooseReliableTravelDistanceKm as any)(...args),
      resolveSavedRuleSourceToHotspotLeg: (...args) => (this.resolveSavedRuleSourceToHotspotLeg as any)(...args),
      resolveSavedRuleHotspotToHotspotLeg: (...args) => (this.resolveSavedRuleHotspotToHotspotLeg as any)(...args),
      resolveSavedRuleHotspotToRouteHotelLeg: (...args) => (this.resolveSavedRuleHotspotToRouteHotelLeg as any)(...args),
      timeToMinutes: (...args) => (this.timeToMinutes as any)(...args),
    });
    this.confirmedItineraryDetailsService.setCallbacks({
      listConfirmedGuideAssignments: (...args) => (this.listConfirmedGuideAssignments as any)(...args),
    });
    this.routeTimingService.setCallbacks({
      forceRebuildVehiclePricingAfterHotspotChange: (...args) => (this.forceRebuildVehiclePricingAfterHotspotChange as any)(...args),
    });
    this.manualFitTravelReplicaService.setCallbacks({
      ensureHotspotHotelBetweenMapTable: (...args) => (this.ensureHotspotHotelBetweenMapTable as any)(...args),
      estimateDurationFromDistance: (...args) => (this.estimateDurationFromDistance as any)(...args),
      extractPreviewCheckinHotelName: (...args) => (this.extractPreviewCheckinHotelName as any)(...args),
      finalizeMatrixPreviewTimeline: (...args) => (this.finalizeMatrixPreviewTimeline as any)(...args),
      formatPreviewTravelDuration: (...args) => (this.formatPreviewTravelDuration as any)(...args),
      getOsrmRouteGeometry: (...args) => (this.getOsrmRouteGeometry as any)(...args),
      minutesRangeToTimeString: (...args) => (this.minutesRangeToTimeString as any)(...args),
      parseSegmentEndMinutes: (...args) => (this.parseSegmentEndMinutes as any)(...args),
      parseSegmentStartMinutes: (...args) => (this.parseSegmentStartMinutes as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      resolveRouteSourceEndpoint: (...args) => (this.resolveRouteSourceEndpoint as any)(...args),
      resolveRouteDestinationCityEndpoint: (...args) => (this.resolveRouteDestinationCityEndpoint as any)(...args),
      resolveSelectedHotelEndpoint: (...args) => (this.resolveSelectedHotelEndpoint as any)(...args),
      resolveSavedRuleHotspotToRouteHotelLeg: (...args) => (this.resolveSavedRuleHotspotToRouteHotelLeg as any)(...args),
    });
    this.manualFitGeometryService.setCallbacks({
      classifyManualHotspotCityContext: (...args) => (this.classifyManualHotspotCityContext as any)(...args),
      estimateDurationFromDistance: (...args) => (this.estimateDurationFromDistance as any)(...args),
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
    this.manualHotspotBatchService.setCallbacks(
      Object.fromEntries(
        manualHotspotBatchCallbackNames.map((name) => [
          name,
          (...args: any[]) => (this as any)[name](...args),
        ]),
      ),
    );
    this.manualHotspotBatchService.setCallbacks({
      buildManualInsertionFit: (...args) => (this.manualInsertionFitService.buildManualInsertionFit as any)(...args),
      resolveProgressivePriorityRemovalForManualFitInTx: (...args) => (this.progressivePriorityRemovalService.resolveProgressivePriorityRemovalForManualFitInTx as any)(...args),
      runAdaptiveManualHotspotSetInsertion: (...args) => (this.adaptiveManualHotspotInsertionService.runAdaptiveManualHotspotSetInsertion as any)(...args),
      buildMatrixRescheduledPreviewTimeline: (...args) => (this.matrixRescheduledPreviewService.buildMatrixRescheduledPreviewTimeline as any)(...args),
      ensurePreviewTimelineHasComputedHotelTravel: (...args) => (this.manualFitTravelReplicaService.ensurePreviewTimelineHasComputedHotelTravel as any)(...args),
    });
    this.manualHotspotMutationService.setCallbacks({
      timeToMinutes: (...args) => (this.timeToMinutes as any)(...args),
      runManualHotspotBatchWithinTransaction: (...args) => (this.manualHotspotBatchService.runManualHotspotBatchWithinTransaction as any)(...args),
      cleanupStaleManualHotspotRows: (...args) => (this.cleanupStaleManualHotspotRows as any)(...args),
      forceRebuildVehiclePricingAfterHotspotChange: (...args) => (this.forceRebuildVehiclePricingAfterHotspotChange as any)(...args),
      estimateDurationFromDistance: (...args) => (this.estimateDurationFromDistance as any)(...args),
      computeRowDurationMinutes: (...args) => (this.computeRowDurationMinutes as any)(...args),
      parsePreviewTimeRangeToUtcDates: (...args) => (this.parsePreviewTimeRangeToUtcDates as any)(...args),
      minutesToUtcTimeDate: (...args) => (this.minutesToUtcTimeDate as any)(...args),
      normalizeManualHotspotIds: (...args) => (this.normalizeManualHotspotIds as any)(...args),
      isRetryableManualPreviewTransactionError: (...args) => (this.isRetryableManualPreviewTransactionError as any)(...args),
    });
    this.manualFitMatrixPlanningService.setCallbacks({
      sortTimelineSegmentsForPreview: (...args) => (this.sortTimelineSegmentsForPreview as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      minutesRangeToTimeString: (...args) => (this.minutesRangeToTimeString as any)(...args),
      parseSegmentStartMinutes: (...args) => (this.parseSegmentStartMinutes as any)(...args),
      resolveSourceToHotspotLeg: (...args) => (this.resolveSourceToHotspotLeg as any)(...args),
      chooseReliableTravelDistanceKm: (...args) => (this.chooseReliableTravelDistanceKm as any)(...args),
      getCachedRouteMatrixLeg: (...args) => (this.getCachedRouteMatrixLeg as any)(...args),
      estimateDurationFromDistance: (...args) => (this.estimateDurationFromDistance as any)(...args),
      normalizeTravelLabelsToNextStop: (...args) => (this.normalizeTravelLabelsToNextStop as any)(...args),
    });
    this.exactAnchorRebuildService.setCallbacks({
      adjustManualFitVisitStartToOperatingWindow: (...args) => (this.adjustManualFitVisitStartToOperatingWindow as any)(...args),
      buildExactAnchorSequentialTimelineCacheKey: (...args) => (this.buildExactAnchorSequentialTimelineCacheKey as any)(...args),
      buildManualFitMainTimelineTravelReplicaMap: (...args) => (this.buildManualFitMainTimelineTravelReplicaMap as any)(...args),
      buildManualFitTravelReplicaDisplayFields: (...args) => (this.manualFitTravelReplicaService.buildManualFitTravelReplicaDisplayFields as any)(...args),
      chooseReliableTravelDistanceKm: (...args) => (this.chooseReliableTravelDistanceKm as any)(...args),
      classifyManualHotspotCityContext: (...args) => (this.classifyManualHotspotCityContext as any)(...args),
      cloneTimelineRowsForPreview: (...args) => (this.cloneTimelineRowsForPreview as any)(...args),
      deriveLooseCityKey: (...args) => (this.deriveLooseCityKey as any)(...args),
      enrichManualFitPreviewTimelineWithOperatingHours: (...args) => (this.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args),
      estimateDurationFromDistance: (...args) => (this.estimateDurationFromDistance as any)(...args),
      findManualFitMainTimelineTravelReplica: (...args) => (this.findManualFitMainTimelineTravelReplica as any)(...args),
      getCachedRouteMatrixLeg: (...args) => (this.getCachedRouteMatrixLeg as any)(...args),
      getHotspotDurationMinutes: (...args) => (this.getHotspotDurationMinutes as any)(...args),
      getManualFitTravelReplicaDurationMinutes: (...args) => (this.getManualFitTravelReplicaDurationMinutes as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      minutesRangeToFitPreviewLabel: (...args) => (this.minutesRangeToFitPreviewLabel as any)(...args),
      normalizeTravelLabelsToNextStop: (...args) => (this.normalizeTravelLabelsToNextStop as any)(...args),
      parseManualFitTravelReplicaDistanceKm: (...args) => (this.parseManualFitTravelReplicaDistanceKm as any)(...args),
      parseSegmentStartMinutes: (...args) => (this.parseSegmentStartMinutes as any)(...args),
      rememberExactAnchorSequentialTimeline: (...args) => (this.rememberExactAnchorSequentialTimeline as any)(...args),
      resolveSourceToHotspotLeg: (...args) => (this.resolveSourceToHotspotLeg as any)(...args),
    });
    this.lowPriorityRemovalService.setCallbacks({
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      buildMatrixRouteTimelineAfterLowPriorityRemoval: (...args) => (this.buildMatrixRouteTimelineAfterLowPriorityRemoval as any)(...args),
      parseSegmentEndMinutes: (...args) => (this.parseSegmentEndMinutes as any)(...args),
      minutesRangeToTimeString: (...args) => (this.minutesRangeToTimeString as any)(...args),
      validateResolvedLowPriorityTimeline: (...args) => (this.validateResolvedLowPriorityTimeline as any)(...args),
      formatMinutesHuman: (...args) => (this.formatMinutesHuman as any)(...args),
      buildManualFitFinalizedPreviewTimelineImpl: (...args) => buildManualFitFinalizedPreviewTimelineImpl.call(this, ...args),
      buildManualFitAttemptTimelineSnapshotImpl: (...args) => buildManualFitAttemptTimelineSnapshotImpl.call(this, ...args),
      buildManualFitAttemptDisplayTimelineSnapshotImpl: (...args) => buildManualFitAttemptDisplayTimelineSnapshotImpl.call(this, ...args),
      buildManualFitAttemptComputedDisplayTimelineSnapshotImpl: (...args) => buildManualFitAttemptComputedDisplayTimelineSnapshotImpl.call(this, ...args),
      validateManualFitAttemptDisplayTimelineImpl: (...args) => validateManualFitAttemptDisplayTimelineImpl.call(this, ...args),
    });
    this.matrixSafeInsertionService.setCallbacks({
      activateManualHotspotRowWithTimes: (...args) => (this.activateManualHotspotRowWithTimes as any)(...args),
      addRouteHotspotToExcludedList: (...args) => (this.addRouteHotspotToExcludedList as any)(...args),
      buildManualFitTimelineFingerprint: (...args) => (this.buildManualFitTimelineFingerprint as any)(...args),
      buildMatrixRescheduledPreviewTimeline: (...args) => (this.matrixRescheduledPreviewService.buildMatrixRescheduledPreviewTimeline as any)(...args),
      calculateRouteEndOverflowMinutes: (...args) => (this.calculateRouteEndOverflowMinutes as any)(...args),
      cloneTimelineRowsForPreview: (...args) => (this.cloneTimelineRowsForPreview as any)(...args),
      computeRowDurationMinutes: (...args) => (this.computeRowDurationMinutes as any)(...args),
      enrichManualFitPreviewTimelineWithOperatingHours: (...args) => (this.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args),
      getCachedRouteMatrixLeg: (...args) => (this.getCachedRouteMatrixLeg as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      getRouteTimelineForScoring: (...args) => (this.getRouteTimelineForScoring as any)(...args),
      getSelectedManualClosingOverflow: (...args) => (this.getSelectedManualClosingOverflow as any)(...args),
      hmsToSeconds: (...args) => (this.hmsToSeconds as any)(...args),
      minutesToUtcTimeDate: (...args) => (this.minutesToUtcTimeDate as any)(...args),
      parsePreviewTimeRangeToUtcDates: (...args) => (this.parsePreviewTimeRangeToUtcDates as any)(...args),
      removeRouteHotspotFromExcludedList: (...args) => (this.removeRouteHotspotFromExcludedList as any)(...args),
      resolveProgressivePriorityRemovalForManualFitInTx: (...args) => (this.progressivePriorityRemovalService.resolveProgressivePriorityRemovalForManualFitInTx as any)(...args),
      resolveSelectedManualPriority: (...args) => (this.resolveSelectedManualPriority as any)(...args),
      resolveSourceToHotspotLeg: (...args) => (this.resolveSourceToHotspotLeg as any)(...args),
      validateStrictMatrixTimeline: (...args) => (this.validateStrictMatrixTimeline as any)(...args),
    });
    this.previewTimelineApplicationService.setCallbacks({
      classifyManualHotspotCityContext: (...args) => (this.classifyManualHotspotCityContext as any)(...args),
      deriveLooseCityKey: (...args) => (this.deriveLooseCityKey as any)(...args),
      finalizeMatrixPreviewTimeline: (...args) => (this.finalizeMatrixPreviewTimeline as any)(...args),
      getHotspotDurationMinutes: (...args) => (this.getHotspotDurationMinutes as any)(...args),
      getHotspotDurationMinutesFromMasterFirst: (...args) => (this.getHotspotDurationMinutesFromMasterFirst as any)(...args),
      getPreviewRowDurationFromDurationFieldsOnly: (...args) => (this.getPreviewRowDurationFromDurationFieldsOnly as any)(...args),
      getPreviewRowDurationMinutes: (...args) => (this.getPreviewRowDurationMinutes as any)(...args),
      minutesRangeToTimeString: (...args) => (this.minutesRangeToTimeString as any)(...args),
      normalizeHotspotPriority: (...args) => (this.normalizeHotspotPriority as any)(...args),
      parseSegmentEndMinutes: (...args) => (this.parseSegmentEndMinutes as any)(...args),
      parseSegmentStartMinutes: (...args) => (this.parseSegmentStartMinutes as any)(...args),
    });
    this.routeLegCacheService.setCallbacks({
      getOsrmRouteGeometry: (...args) => (this.getOsrmRouteGeometry as any)(...args),
    });
  }

  private parseCsvNumberList(value: unknown): number[] {
    return String(value ?? '')
      .split(',')
      .map((item) => Number(String(item).trim()))
      .filter((item) => Number.isFinite(item) && item > 0);
  }

  private formatDateOnly(value?: Date | string | null): string | null {
    if (!value) return null;
    const dt = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  }

  private calculateActivityPlanPricing(...args: any[]) {
    return (this.activityPricingService.calculateActivityPlanPricing as any)(...args);
  }

private getGuideSlotLabel(slotId: number): string {
    return this.guideAssignmentService.getGuideSlotLabel(slotId);
  }

  private getGuideCancellationDefectTypeId(defectType?: string): number {
    return String(defectType || 'dvi').trim().toLowerCase() === 'guest' ? 2 : 1;
  }

  private getGuidePaxBucket(totalPax: number): number {
    return this.guideAssignmentService.getGuidePaxBucket(totalPax);
  }

  private guideHasLanguage(guideLanguageProficiency: unknown, languageId: number): boolean {
    return this.guideAssignmentService.guideHasLanguage(guideLanguageProficiency, languageId);
  }

  private guideHasAllSlots(guideAvailableSlot: unknown, slotIds: number[]): boolean {
    return this.guideAssignmentService.guideHasAllSlots(guideAvailableSlot, slotIds);
  }

  private async guideDateHasAnyAvailablePrice(params: {
    routeDate: string;
    totalPaxCount: number;
  }): Promise<boolean> {
    return this.guideAssignmentService.guideDateHasAnyAvailablePrice(params);
  }

  async getGuideAvailability(planId: number) {
    return this.guideAssignmentService.getGuideAvailability(planId);
  }

  private applyGuideGst(totalCharges: number, guideGst: number, gstType: number): number {
    return this.guideAssignmentService.applyGuideGst(totalCharges, guideGst, gstType);
  }

  private async getPlanRouteDates(planId: number): Promise<string[]> {
    return this.guideAssignmentService.getPlanRouteDates(planId);
  }

  private async resolveEligibleGuideCost(params: {
    planId: number;
    routeId?: number | null;
    routeDate?: string | null;
    guideType: number;
    languageId: number;
    slotIds?: number[];
    totalPaxCount: number;
  }): Promise<{
    guideId: number | null;
    totalGuideCost: number;
    datewiseCost: Record<string, number>;
  }> {
    return this.guideAssignmentService.resolveEligibleGuideCost(params);
  }

  async listGuideAssignments(planId: number): Promise<ItineraryGuideAssignmentRow[]> {
    return this.guideAssignmentService.listGuideAssignments(planId);
  }

  async getGuideAssignmentOptions(planId: number, routeGuideId?: number) {
    return this.guideAssignmentService.getGuideAssignmentOptions(planId, routeGuideId);
  }

  async saveGuideAssignment(
    planId: number,
    payload: SaveGuideAssignmentPayload,
    userId: number,
  ) {
    return this.guideAssignmentWriteService.saveGuideAssignment(planId, payload, userId);
  }
  async deleteGuideAssignment(planId: number, routeGuideId: number, routeId?: number) {
    return this.guideAssignmentWriteService.deleteGuideAssignment(planId, routeGuideId, routeId);
  }
  async listConfirmedGuideAssignments(confirmedPlanId: number) {
    return this.confirmedGuideAssignmentService.listConfirmedGuideAssignments(confirmedPlanId);
  }
  async cancelConfirmedGuideSlot(
    confirmedPlanId: number,
    payload: {
      routeGuideId: number;
      guideSlotCostDetailsId: number;
      itineraryRouteId?: number;
      cancellationPercentage?: number;
      defectType?: string;
      reason?: string;
    },
    userId: number,
  ) {
    return this.confirmedGuideCancellationService.cancelConfirmedGuideSlot(confirmedPlanId, payload, userId);
  }
  private ensureManualFitAttemptStoreTable() {
    return this.manualFitAttemptStoreService.ensureTable();
  }
  async getAvailableActivities(hotspotId: number, planId?: number, routeId?: number) {
    return this.activityAvailabilityService.getAvailableActivities(hotspotId, planId, routeId);
  }
  private saveManualFitAttemptEntry(entry: any) {
    return this.manualFitAttemptStoreService.save(entry);
  }

  private loadManualFitAttemptEntry(attemptId: string) {
    return this.manualFitAttemptStoreService.load(attemptId);
  }

  private deleteManualFitAttemptEntry(attemptId: string) {
    return this.manualFitAttemptStoreService.delete(attemptId);
  }
  private createVehicleBuildRunId(planId: number): string {
    return this.vehicleBuildStatusService.createBuildRunId(planId);
  }

  private async startVehicleBuildRecord(planId: number, buildRunId: string, userId: number): Promise<void> {
    await this.vehicleBuildStatusService.startRecord(planId, buildRunId, userId);
  }

  async buildPermitsSync(planId: number, req: any) {
    return this.vehicleBuildService.buildPermitsSync(planId, req);
  }

  async buildVehiclesSync(planId: number, req: any) {
    return this.vehicleBuildService.buildVehiclesSync(planId, req);
  }

 /**
   * Normalize field values to arrays safely.
   * Handles string, array, object, null, undefined without spreading strings into characters.
 */
  private normalizeToArray(value: any): any[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (value && typeof value === 'object') return [value];
    return [];
  }

  private normalizeToUniqueStrings(items: any[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const item of items) {
      let text = '';

      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        text = String(item).trim();
      } else if (item && typeof item === 'object') {
        text = String(item?.name || item?.text || item?.description || item?.label || '').trim();
        if (!text) {
          try {
            text = JSON.stringify(item);
          } catch {
            text = '';
          }
        }
      }

      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }

    return out;
  }

  private inferMealPlanFromInclusions(items: string[]): string | null {
    const haystack = items.join(' ').toLowerCase();
    if (!haystack) return null;

    if (haystack.includes('full board')) return 'Full Board';
    if (haystack.includes('half board')) return 'Half Board';
    if (haystack.includes('room only') || haystack.includes('no meals')) return 'Room Only';
    if (haystack.includes('breakfast')) return 'Breakfast Included';

    return null;
  }

  async createPlan(
    dto: CreateItineraryDto,
    req: any,
    shouldOptimizeRoute: boolean = false,
    requestType?: string,
  ) {
    const isNewPlan = Number((dto?.plan as any)?.itinerary_plan_id || 0) <= 0;
    const result = await this.planPersistenceService.createPlan(dto, req, shouldOptimizeRoute, requestType);
    const hotelsRequired = Number((dto?.plan as any)?.itinerary_preference || 0) === 1 ||
      Number((dto?.plan as any)?.itinerary_preference || 0) === 3;

    // Route changes invalidate stay identities; itinerary meal-plan changes
    // invalidate the auto-selected hotel/rate choices. Reuse the same reset
    // path as the internal hotel reset operation after the plan transaction commits.
    // Meal-plan-only edits do not rebuild routes, hotspots, or transport data.
    const hotelResetReason = getHotelAvailabilityResetReason(result);
    if (!isNewPlan && hotelsRequired && hotelResetReason && result?.quoteId) {
      try {
        const hotelSearch = await this.hotelAvailabilitySnapshotService.resetAndPersist(
          String(result.quoteId),
          Number(req?.user?.userId || 0),
        );
        return {
          ...result,
          hotelSearch: {
            status: Number(hotelSearch.response.hotelAvailability?.emptySearchRoutes || 0) > 0 ||
              hotelSearch.response.hotelAvailability?.availabilityState === 'PARTIAL' ? 'PARTIAL' : 'COMPLETE',
            resetApplied: true,
            resetReason: hotelResetReason,
            searchRunId: hotelSearch.searchRunId,
            checkedAt: hotelSearch.response.hotelAvailability?.checkedAt,
            optionCount: hotelSearch.response.hotels?.length || 0,
            selectedCount: hotelSearch.response.hotels?.filter((row: any) => row.isSelected).length || 0,
            providerErrors: hotelSearch.response.hotelAvailability?.providerErrors || [],
          },
        };
      } catch (error) {
        // The itinerary transaction is already committed. Return the same
        // recoverable partial-save contract used by initial itinerary create,
        // so the UI opens the saved itinerary and can explicitly retry hotel
        // availability instead of claiming the old hotel is still valid.
        throw new UnprocessableEntityException({
          message: hotelResetReason === 'ROUTE_CHANGED'
            ? 'Itinerary routes were updated, but hotel availability could not be reset. Open the saved itinerary to retry automatically.'
            : hotelResetReason === 'ROOM_COUNT_CHANGED'
              ? 'Itinerary room count was updated, but hotel availability could not be reset. Open the saved itinerary to retry automatically.'
              : hotelResetReason === 'MEAL_PLAN_CHANGED'
                ? 'The itinerary meal plan was updated, but hotel availability could not be reset. Open the saved itinerary to retry automatically.'
              : hotelResetReason === 'EARLY_ARRIVAL_CONFIRMED'
                ? 'Early check-in was confirmed, but hotel availability could not be reset. Open the saved itinerary to retry automatically.'
                : 'The hotel category was updated, but hotel availability could not be reset. Open the saved itinerary to retry automatically.',
          planId: result.planId,
          quoteId: result.quoteId,
          creationStatus: 'PARTIAL',
          code: hotelResetReason === 'ROUTE_CHANGED'
            ? 'HOTEL_AVAILABILITY_ROUTE_RESET_FAILED'
            : hotelResetReason === 'ROOM_COUNT_CHANGED'
              ? 'HOTEL_AVAILABILITY_ROOM_COUNT_RESET_FAILED'
              : hotelResetReason === 'MEAL_PLAN_CHANGED'
                ? 'HOTEL_AVAILABILITY_MEAL_PLAN_RESET_FAILED'
              : hotelResetReason === 'EARLY_ARRIVAL_CONFIRMED'
                ? 'HOTEL_AVAILABILITY_EARLY_ARRIVAL_RESET_FAILED'
                : 'HOTEL_AVAILABILITY_CATEGORY_RESET_FAILED',
          routeChanged: Boolean(result?.routeChanged),
          roomCountChanged: Boolean(result?.roomCountChanged),
          mealPlanChanged: Boolean(result?.mealPlanChanged),
          hotelCategoryChanged: Boolean(result?.hotelCategoryChanged),
          hotelSearch: { status: 'FAILED' },
          cause: String((error as any)?.response?.message || (error as any)?.message || 'Hotel availability reset failed'),
        });
      }
    }

    if (!isNewPlan || !hotelsRequired || !result?.quoteId) {
      return { ...result, hotelSearch: { status: hotelsRequired ? 'NOT_REQUIRED' : 'NOT_REQUIRED' } };
    }

    try {
      // Fresh creation uses the same hotel snapshot lifecycle as Reset so
      // supplier inventory, persistence, and the response consumed by the UI
      // cannot diverge between the two flows.
      const hotelSearch = await this.hotelAvailabilitySnapshotService.resetAndPersist(
        String(result.quoteId),
        Number(req?.user?.userId || 0),
      );
      return {
        ...result,
        hotelDetails: hotelSearch.response,
        hotelChangeSummary: hotelSearch.changeSummary,
        hotelSearch: {
          status: Number(hotelSearch.response.hotelAvailability?.emptySearchRoutes || 0) > 0 ||
            hotelSearch.response.hotelAvailability?.availabilityState === 'PARTIAL' ? 'PARTIAL' : 'COMPLETE',
          searchRunId: hotelSearch.searchRunId,
          checkedAt: hotelSearch.response.hotelAvailability?.checkedAt,
          optionCount: hotelSearch.response.hotels?.length || 0,
          selectedCount: hotelSearch.response.hotels?.filter((row: any) => row.isSelected).length || 0,
          providerErrors: hotelSearch.response.hotelAvailability?.providerErrors || [],
        },
      };
    } catch (error) {
      throw new UnprocessableEntityException({
        message: 'Itinerary saved, but the initial hotel availability search failed. Open the saved itinerary to retry automatically.',
        planId: result.planId,
        quoteId: result.quoteId,
        creationStatus: 'PARTIAL',
        code: 'HOTEL_AVAILABILITY_FAILED',
        hotelSearch: { status: 'FAILED' },
        cause: String((error as any)?.response?.message || (error as any)?.message || 'Hotel search failed'),
      });
    }
  }

  async saveReusableTemplate(data: { planId: number; templateName?: string }, userId: number) {
    return this.planPersistenceService.saveReusableTemplate(data, userId);
  }

  async getReusableTemplateMatch(
    sourceLocation: string,
    destinationLocation: string,
    dayCount: number,
    scope?: string,
  ) {
    return this.planPersistenceService.getReusableTemplateMatch(
      sourceLocation,
      destinationLocation,
      dayCount,
      scope,
    );
  }


 /**
   * Delete a hotspot from an itinerary route
   * Hard deletes the hotspot from timeline and adds to excluded_hotspot_ids
 */
  async deleteHotspot(planId: number, routeId: number, hotspotId: number) {
    return this.hotspotDeletionService.deleteHotspot(planId, routeId, hotspotId);
  }
  async addActivity(data: {
    planId: number;
    routeId: number;
    routeHotspotId: number;
    hotspotId: number;
    activityId: number;
    amount?: number;
    startTime?: string;
    endTime?: string;
    duration?: string;
    skipConflictCheck?: boolean;
  }) {
    return this.activityWorkflowService.addActivity(data);
  }

  async previewActivityAddition(data: {
    planId: number;
    routeId: number;
    routeHotspotId: number;
    hotspotId: number;
    activityId: number;
  }) {
    return this.activityWorkflowService.previewActivityAddition(data);
  }

  async deleteActivity(planId: number, routeId: number, activityId: number) {
    return this.activityWorkflowService.deleteActivity(planId, routeId, activityId);
  }

  async previewActivityForAllHotspots(data: {
    planId: number;
    routeId: number;
    activityId: number;
  }) {
    return this.activityWorkflowService.previewActivityForAllHotspots(data);
  }



  async smartPreviewActivity(planId: number, data: any) {
    return this.smartActivityService.smartPreviewActivity(planId, data);
  }



  async smartInsertActivity(planId: number, data: any) {
    return this.smartActivityService.smartInsertActivity(planId, data);
  }

  private getHotspotDurationMinutes(master: any, row: any): number {
    const start = row?.hotspot_start_time ? new Date(row.hotspot_start_time) : null;
    const end = row?.hotspot_end_time ? new Date(row.hotspot_end_time) : null;
    if (start && end && end > start) {
      const mins = Math.round((end.getTime() - start.getTime()) / 60000);
      if (mins > 0) return mins;
    }

    const masterDuration = master?.hotspot_duration ? this.timeToMinutes(master.hotspot_duration) : 0;
    if (masterDuration > 0) return masterDuration;

    return 30;
  }



 /**
   * Get available hotspots for a route
 */
 /**
   * Get available hotspots for a route
   *
   * NEW RULES:
   * - direct_to_next_visiting_place === 1  => destination pool only, priority DESC
   * - direct_to_next_visiting_place === 0  => interleave source/destination in chunks of 3
  * - already added hotspots => exclude from addable list for this route/day
 */
  async getAvailableHotspots(routeId: number) {
    return this.hotspotWorkflowService.getAvailableHotspots(routeId);
  }

  async getAvailableHotspotsForAnchor(data: any) {
    return this.hotspotWorkflowService.getAvailableHotspotsForAnchor(data);
  }

  async addHotspot(data: { planId: number; routeId: number; hotspotId: number }) {
    return this.hotspotWorkflowService.addHotspot(data);
  }

  async previewAddHotspot(data: { planId: number; routeId: number; hotspotId: number }) {
    return this.hotspotWorkflowService.previewAddHotspot(data);
  }


  async getAvailableHotels(routeId: number) {
    return this.selectionWorkflowService.getAvailableHotels(routeId);
  }
  async selectHotel(data: {
    planId: number;
    routeId: number;
    hotelId: number | null;
    roomTypeId: number;
    routeDate?: string;
    groupType?: number;
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean };
  }) {
    return this.selectionWorkflowService.selectHotel(data);
  }

  /**
   * Server-owned selection intent.  The browser identifies what the user
   * meant; the current snapshot and supplier refresh determine the option and
   * price that are persisted.
   */
  async selectHotelIntent(data: any) {
    const groupType = Number(data.groupType || 0);
    if (!Number.isInteger(groupType) || groupType < 1 || groupType > 4) {
      throw new BadRequestException('Hotel selection requires a valid target groupType between 1 and 4');
    }
    return this.selectionWorkflowService.withHotelSelectionLock(
      Number(data.planId),
      groupType,
      () => this.selectHotelIntentUnlocked(data),
    );
  }

  /**
   * Resolve the same authoritative hotel intent as confirmation, without
   * persisting anything. The selection lock still serializes preview and
   * confirm resolution for the target plan/group.
   */
  async previewHotelIntent(data: any) {
    const groupType = Number(data.groupType || 0);
    if (!Number.isInteger(groupType) || groupType < 1 || groupType > 4) {
      throw new BadRequestException('Hotel selection requires a valid target groupType between 1 and 4');
    }
    return this.selectionWorkflowService.withHotelSelectionLock(
      Number(data.planId),
      groupType,
      async () => {
        try {
          return await this.selectHotelIntentUnlocked({ ...data, previewOnly: true });
        } catch (error: any) {
          const response = error?.response;
          const code = String(response?.code || error?.code || '').trim();
          console.error('[HOTEL_INTENT_PREVIEW_FAILED]', {
            code,
            message: String(error?.message || response?.message || error || 'Unknown hotel preview failure'),
            stack: error?.stack,
          });
          const noAvailability = new Set([
            'HOTEL_NO_AVAILABILITY',
            'HOTEL_INTENT_UNAVAILABLE',
            'HOTEL_RATE_STALE',
            'HOTEL_CONTINUOUS_STAY_UNAVAILABLE',
          ]).has(code);
          // Supplier unavailability is a domain result. Prisma/database,
          // timeout, and other unknown errors are refresh failures and must
          // remain retryable; reporting them as NO_AVAILABILITY hides defects
          // and incorrectly tells the user that inventory is absent.
          const knownRefreshFailure = code === 'HOTEL_REFRESH_FAILED' ||
            code === 'HOTEL_AVAILABILITY_REFRESH_FAILED' ||
            code === 'P2002' ||
            response?.status === 'REFRESH_FAILED';
          const status = knownRefreshFailure || (!noAvailability && !code)
            ? 'REFRESH_FAILED'
            : 'NO_AVAILABILITY';
          return {
            status,
            retryable: status === 'REFRESH_FAILED',
            message: status === 'REFRESH_FAILED'
              ? 'Hotel availability could not be checked right now. Please try again.'
              : String(response?.message || error?.message || 'The selected hotel is not available for the requested stay.'),
            code: code || (status === 'REFRESH_FAILED' ? 'HOTEL_REFRESH_FAILED' : 'HOTEL_NO_AVAILABILITY'),
             affectedRouteIds: response?.affectedRouteIds || response?.logicalStay?.routeIds || [],
            logicalStay: response?.logicalStay,
            // Multi-night itinerary selection is all-or-nothing. Even when
            // the validator finds inventory for the clicked night alone, do
            // not expose that as a bookable fallback to the client.
            canBookSingleNight: false,
            canBookMultiNight: response?.canBookMultiNight === true,
            blocked: response?.canBookMultiNight === false,
            restriction: response?.restriction,
            restrictionConflicts: response?.restriction?.restrictionConflicts || [],
            warnings: response?.restriction?.warnings || [],
          };
        }
      },
    );
  }

  private async selectHotelIntentUnlocked(data: any) {
    const intent = String(data.selectionIntent || 'RATE_OPTION').trim().toUpperCase();
    if (!['HOTEL', 'ROOM_TYPE', 'MEAL_PLAN', 'RATE_OPTION'].includes(intent)) {
      throw new BadRequestException('selectionIntent must be HOTEL, ROOM_TYPE, MEAL_PLAN, or RATE_OPTION');
    }
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: Number(data.planId) },
    });
    if (!plan) throw new NotFoundException('Itinerary plan not found');
    const quoteId = String((plan as any).itinerary_quote_ID || '');
    const provider = String(data.provider || '').trim().toLowerCase();
    const requestedCanonicalHotelId = Number(data.canonicalHotelId || data.hotelId || 0);
    let providerHotelCode = String(data.providerHotelCode || '').trim();
    if (!providerHotelCode && requestedCanonicalHotelId > 0 && provider !== 'offline') {
      const master = await this.prisma.dvi_hotel.findUnique({
        where: { hotel_id: requestedCanonicalHotelId },
        select: { hotel_id: true, staah_property_id: true, axisrooms_property_id: true },
      });
      providerHotelCode = provider === 'staah'
        ? String(master?.staah_property_id || '').trim()
        : provider === 'axisrooms' || provider === 'ax'
          ? String(master?.axisrooms_property_id || '').trim()
          : provider === 'offline'
            ? String(master?.hotel_id || requestedCanonicalHotelId)
            : '';
    }
    const hotelCode = providerHotelCode || String(data.hotelCode || data.hotelId || '').trim();
    const groupType = Number(data.groupType || 0);
    if (!Number.isInteger(groupType) || groupType < 1 || groupType > 4) {
      throw new BadRequestException('Hotel selection requires a valid target groupType between 1 and 4');
    }
    if (!Number(data.routeId) || !provider || !hotelCode) {
      throw new BadRequestException('Hotel intent requires routeId, provider, and providerHotelCode');
    }

    const requestedRoom = String(data.roomType || '').trim();
    const requestedRoomTypeId = Number(data.roomTypeId ?? data.room_type_id ?? 0);
    const requestedMeal = String(data.mealPlanCode || data.mealPlan || '').trim();
    const anchorRateOptionId = String(data.rateOptionId || data.optionKey || '').trim();
    const anchorSelectionKey = String(data.selectionKey || '').trim();

    // Rate-option identifiers are authoritative for the supplier rate. Do not
    // allow a stale AP/CP identifier to be saved with the opposite itinerary
    // meal-plan selection. This is especially important when a preview
    // snapshot is reused: reuse is safe only when the snapshot belongs to the
    // requested meal plan.
    const mealPlanFromReference = (...values: unknown[]): string => {
      for (const value of values) {
        const reference = String(value || '').trim().toUpperCase();
        if (!reference) continue;
        const planToken = reference.match(/(?:^|[:|_-])(MAP|AP|CP|AI)(?:_PLAN)?(?:$|[:|_-])/i);
        if (planToken?.[1]) return inferCanonicalHotelRatePlanCode(planToken[1]) || planToken[1].toUpperCase();
      }
      return '';
    };
    const requestedMealPlan =
      inferCanonicalHotelRatePlanCode(requestedMeal) ||
      inferCanonicalHotelRatePlanCodeFromMealText(requestedMeal) ||
      mealPlanFromReference(requestedMeal);
    const referencedMealPlan = mealPlanFromReference(
      data.rateOptionId,
      data.optionKey,
      data.selectionKey,
      data.bookingCode,
      data.searchReference,
    );
    if (requestedMealPlan && referencedMealPlan && requestedMealPlan !== referencedMealPlan) {
      console.error('[HOTEL_INTENT_MEAL_PLAN_MISMATCH]', JSON.stringify({
        planId: Number(data.planId),
        routeId: Number(data.routeId),
        provider,
        hotelCode,
        requestedMealPlan,
        referencedMealPlan,
        reusePreviewSnapshot: data.reusePreviewSnapshot === true,
      }));
      throw new BadRequestException({
        code: 'HOTEL_MEAL_PLAN_MISMATCH',
        message: `Selected rate plan ${referencedMealPlan} does not match requested meal plan ${requestedMealPlan}. Refresh hotel availability and select the ${requestedMealPlan} rate.`,
        requestedMealPlan,
        referencedMealPlan,
      });
    }

    // Resolve the complete contiguous same-destination block on the server.
    // The browser must not calculate previous/next route ids or send them as
    // authority because an anchor can be the first, middle, or last night.
    const anchorRoute = await this.prisma.dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: Number(data.routeId), itinerary_plan_ID: Number(data.planId), deleted: 0 },
      select: { itinerary_route_date: true },
    });
    const intentCheckInDate = data.routeDate
      ? String(data.routeDate).slice(0, 10)
      : anchorRoute?.itinerary_route_date instanceof Date
        ? anchorRoute.itinerary_route_date.toISOString().slice(0, 10)
        : String(anchorRoute?.itinerary_route_date || '').slice(0, 10);
    let stay: any;
    try {
      stay = await this.hotelStayBlockValidationService.buildContinuousStayCandidate({
        planId: Number(data.planId),
        routeId: Number(data.routeId),
        provider: provider as any,
        hotelCode,
        hotelName: String(data.hotelName || '').trim() || undefined,
        roomType: requestedRoom || undefined,
        mealPlan: requestedMeal || undefined,
        checkInDate: intentCheckInDate,
        allowRoomTypeChanges: intent === 'HOTEL',
      });
    } catch (error) {
      console.error('[HOTEL_INTENT] continuous stay resolution failed', error);
      throw new BadRequestException({
        code: 'HOTEL_CONTINUOUS_STAY_RESOLUTION_FAILED',
        message: error instanceof Error ? error.message : 'Continuous stay resolution failed',
        canBookSingleNight: false,
        canBookMultiNight: false,
        routeId: Number(data.routeId), provider, hotelCode,
      });
    }

    // The user may explicitly accept the anchor night after the continuous
    // stay preview reports that one or more follow-on nights are unavailable.
    // In that case the intent must be resolved against only the clicked route;
    // otherwise confirmation would immediately repeat the multi-night check.
    if (data.singleNightOnly === true) {
      const checkOut = new Date(`${intentCheckInDate}T00:00:00.000Z`);
      checkOut.setUTCDate(checkOut.getUTCDate() + 1);
      stay = {
        ...stay,
        routeIds: [Number(data.routeId)],
        stayDates: [intentCheckInDate],
        checkInDate: intentCheckInDate,
        checkOutDate: checkOut.toISOString().slice(0, 10),
        nights: 1,
      };
    }

    // The logical stay is known before any supplier work. Refresh every
    // affected route so no night is silently filled from an anchor-only rate.
    // Search results are never retained between requests. Resolve the selected
    // property again and keep those rates only in this request while building
    // the atomic stay selection.
    const requestScopedCandidates: any[] = [];
    if (provider !== 'offline') {
      if (['tbo', 'resavenue', 'hobse', 'axisrooms', 'staah'].includes(provider) &&
        typeof (this.hotelDetailsTboService as any).searchSelectedHotelForContinuousStay === 'function') {
        const continuousHotels = await this.hotelDetailsTboService.searchSelectedHotelForContinuousStay({
          planId: Number(data.planId),
          routeIds: stay.routeIds,
          provider,
          hotelCode,
          checkInDate: stay.checkInDate,
          checkOutDate: stay.checkOutDate,
        });
        const continuousMatch = provider === 'axisrooms' || provider === 'staah'
          ? continuousHotels.length > 0
          : continuousHotels.some((hotel: any) =>
              String(hotel?.hotelCode || hotel?.providerHotelCode || '').trim() === hotelCode,
            );
        if (!continuousMatch) {
          throw new BadRequestException({
            code: 'HOTEL_CONTINUOUS_STAY_UNAVAILABLE',
            status: 'NO_AVAILABILITY',
            retryable: false,
            message: `The selected hotel is not available for the complete stay ${stay.checkInDate} to ${stay.checkOutDate}.`,
            provider,
            hotelCode,
            affectedRouteIds: stay.routeIds,
            logicalStay: stay,
            canBookSingleNight: false,
            canBookMultiNight: false,
          });
        }
      }

      const refreshTimeoutMs = Math.max(Number(process.env.HOTEL_INTENT_REFRESH_TIMEOUT_MS || 15000), 1000);
      for (const routeId of stay.routeIds.map(Number)) {
        let refreshed: any;
        try {
          refreshed = await Promise.race([
            this.hotelDetailsTboService.getSelectedHotelRates(quoteId, routeId, provider, hotelCode, groupType),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('supplier refresh timeout')), refreshTimeoutMs)),
          ]);
        } catch (error) {
          throw new BadRequestException({
            code: 'HOTEL_REFRESH_FAILED', status: 'REFRESH_FAILED', retryable: true,
            message: error instanceof Error ? error.message : 'Supplier refresh failed',
            provider, hotelCode, routeId, affectedRouteIds: stay.routeIds,
            canBookSingleNight: false, canBookMultiNight: false,
          });
        }
        const refreshedHotels = Array.isArray(refreshed?.hotels) ? refreshed.hotels : [];
        if (refreshedHotels.length === 0) {
          throw new BadRequestException({
            code: 'HOTEL_NO_AVAILABILITY', status: 'NO_AVAILABILITY', retryable: false,
            message: `No sellable rates are available for ${hotelCode} on ${String(stay.stayDates[stay.routeIds.indexOf(routeId)] || '').slice(0, 10)}`,
            provider, hotelCode, routeId, affectedRouteIds: stay.routeIds,
            canBookSingleNight: false, canBookMultiNight: false,
          });
        }
        requestScopedCandidates.push(...refreshedHotels);
      }
    }

    const snapshotRows = requestScopedCandidates;
    let candidates = snapshotRows.flatMap((row: any) => {
      const options = Array.isArray(row?.rateOptions) && row.rateOptions.length > 0 ? row.rateOptions : [row];
      return options.map((option: any) => {
        // Nested supplier options are independent selectable rates. Do not
        // inherit the parent row's rateOptionId/optionKey: the parent is often
        // the cheapest Deluxe option while ROOM_TYPE may target Suite.
        const optionRateOptionId = String(
          option.rateOptionId ||
          option.rate_option_id ||
          option.optionKey ||
          option.option_key ||
          option.searchReference ||
          option.search_reference ||
          option.bookingCode ||
          option.booking_code ||
          option.rateId ||
          option.rate_id ||
          '',
        ).trim() || undefined;
        const optionIdentity = {
        ...row,
        ...option,
        provider: option.provider || row.provider,
        hotelId: option.hotelId ?? row.hotelId,
        canonicalHotelId: option.canonicalHotelId ?? row.canonicalHotelId ?? row.hotelId,
        hotelCode: option.hotelCode || row.hotelCode || row.providerHotelCode,
        hotelName: option.hotelName || row.hotelName,
        roomType: option.roomType || option.roomTypeName || row.roomType,
        mealPlan: option.mealPlan || option.mealPlanCode || row.mealPlan,
        rateOptionId: optionRateOptionId,
        optionKey: optionRateOptionId,
        routeIds: option.routeIds || row.routeIds,
        };
        return normalizeSupplierRateIdentity(optionIdentity);
      });
    });
    if (provider === 'offline') {
      try {
        candidates = await this.resolveOfflineIntentCandidates(plan, stay, data, groupType);
      } catch (error) {
        const errorCode = String((error as any)?.response?.code || (error as any)?.code || '').trim();
        if (errorCode === 'HOTEL_NO_AVAILABILITY' || errorCode === 'HOTEL_RATE_STALE' || data.previewOnly) {
          throw error;
        }
        throw new BadRequestException({
          code: 'HOTEL_REFRESH_FAILED',
          status: 'REFRESH_FAILED',
          retryable: true,
          message: error instanceof Error ? error.message : 'Offline hotel availability could not be checked',
          provider,
          hotelCode,
          affectedRouteIds: stay.routeIds,
        });
      }
    }
    const normalize = (value: unknown) => String(value || '').trim().toLowerCase();
    const normalizeMealPlan = (value: unknown) =>
      inferCanonicalHotelRatePlanCode(String(value || '')) ||
      inferCanonicalHotelRatePlanCodeFromMealText(String(value || '')) ||
      normalize(value);
    const routeIdOf = (option: any) => Number(option.itineraryRouteId || option.routeId || option.route_id || 0);
    const dateOf = (option: any) => String(option.date || option.checkInDate || option.routeDate || '').slice(0, 10);
    const propertyMatches = (option: any) => {
      const requestedCanonical = requestedCanonicalHotelId;
      const optionProvider = normalize(option.provider || option.hotelProvider || option.supplier);
      const requestedProvider = normalize(provider);
      const providerMatches = optionProvider === requestedProvider ||
        (requestedProvider === 'axisrooms' && optionProvider === 'ax');
      const optionCanonical = Number(option.canonicalHotelId || option.hotelId || 0);
      const optionProviderCode = normalize(option.providerHotelCode || option.provider_hotel_code || option.hotelCode);
      const providerCodeMatches = optionProviderCode === normalize(hotelCode);
      // Fresh supplier responses may not carry our internal canonical ID.
      // Once provider and provider hotel code match, allow that authoritative
      // supplier identity to match the persisted canonical selection too.
      return providerMatches && (providerCodeMatches || (requestedCanonical > 0 && optionCanonical === requestedCanonical));
    };
    const payableAmount = (option: any) => Number(
      option.totalStayPrice ?? option.totalPrice ?? option.totalAmountAfterTax ?? option.pricePerNight ?? option.price ?? Number.MAX_SAFE_INTEGER,
    );
    const hasPositiveRate = (...values: unknown[]) => values.some((value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0;
    });
    const hasRequiredSupplementRates = (option: any) => {
      const extraBedRequired = Number((plan as any).total_extra_bed || 0) > 0;
      const childWithBedRequired = Number((plan as any).total_child_with_bed || 0) > 0;
      const childWithoutBedRequired = Number((plan as any).total_child_without_bed || 0) > 0;
      return (!extraBedRequired || hasPositiveRate(option.extraBedRate, option.extra_bed_rate)) &&
        (!childWithBedRequired || hasPositiveRate(option.childWithBedRate, option.child_with_bed_rate)) &&
        (!childWithoutBedRequired || hasPositiveRate(option.childWithoutBedRate, option.child_without_bed_rate));
    };
    const routeOptions = (routeId: number, routeDate: string) => candidates.filter((option: any) => {
      const routeMatches = routeIdOf(option) === routeId || (Array.isArray(option.routeIds) && option.routeIds.map(Number).includes(routeId));
      const dateMatches = !dateOf(option) || dateOf(option) === routeDate;
      const candidateGroupType = Number(option.groupType ?? option.group_type ?? 0);
      const groupMatches = candidateGroupType === 0 || candidateGroupType === groupType;
      return routeMatches && dateMatches && groupMatches && propertyMatches(option) && option.isSelectable !== false && option.isBookable !== false;
    });
    const selectedByRoute: any[] = [];
    const anchorCandidates = routeOptions(Number(data.routeId), stay.stayDates[stay.routeIds.indexOf(Number(data.routeId))] || String(data.routeDate || '').slice(0, 10));
    // Prefer the exact supplier rate returned by preview. The TBO
    // selectionKey is deliberately session-agnostic and can otherwise match
    // a parent/zero-price row from another search session.
    let anchorOption: any = null;
    if (anchorRateOptionId) {
      anchorOption = anchorCandidates.find((option: any) => supplierRateIdentityMatches({
        provider,
        rateOptionId: anchorRateOptionId,
        bookingCode: data.bookingCode,
        searchReference: data.searchReference,
      }, option)) || null;
    }
    if (!anchorOption && !anchorRateOptionId && anchorSelectionKey) {
      anchorOption = anchorCandidates.find((option: any) => supplierSelectionKey(option) === anchorSelectionKey) || null;
    }
    if ((intent === 'RATE_OPTION' || Boolean(anchorRateOptionId)) && !anchorOption) {
      throw new BadRequestException({
        code: 'HOTEL_RATE_STALE',
        message: 'The selected hotel rate is stale or unavailable. No nights were changed.',
        selectionIntent: intent,
        logicalStay: stay,
        affectedRouteIds: stay.routeIds,
        canBookSingleNight: false,
        canBookMultiNight: false,
      });
    }
    const anchorRoom = String(anchorOption?.roomType || anchorOption?.roomTypeName || requestedRoom || '').trim();
    const anchorMeal = String(anchorOption?.mealPlan || anchorOption?.mealPlanCode || requestedMeal || '').trim();

    for (let index = 0; index < stay.routeIds.length; index += 1) {
      const routeId = Number(stay.routeIds[index]);
      const routeDate = String(stay.stayDates[index] || '').slice(0, 10);
      const options = routeOptions(routeId, routeDate).filter((option: any) => {
        const room = String(option.roomType || option.roomTypeName || '').trim();
        const meal = String(option.mealPlan || option.mealPlanCode || '').trim();
        if (intent === 'ROOM_TYPE' && requestedRoom && normalize(room) !== normalize(requestedRoom)) return false;
        if (intent === 'ROOM_TYPE' && requestedRoomTypeId > 0) {
          const candidateRoomTypeId = Number(option.roomTypeId ?? option.room_type_id ?? 0);
          if (candidateRoomTypeId !== requestedRoomTypeId) return false;
        }
        if (intent === 'MEAL_PLAN' && requestedRoom && normalize(room) !== normalize(requestedRoom)) return false;
        // HOTEL and ROOM_TYPE actions preserve the itinerary's global meal
        // plan just like MEAL_PLAN actions. Without this filter, a card that
        // displays CP could still select the cheapest AP option when its
        // concrete rate identity is omitted intentionally.
        if (requestedMeal &&
          (intent === 'HOTEL' || intent === 'ROOM_TYPE' || intent === 'MEAL_PLAN') &&
          normalizeMealPlan(meal) !== normalizeMealPlan(requestedMeal)) return false;
        if ((intent === 'RATE_OPTION' || intent === 'ROOM_TYPE' || intent === 'MEAL_PLAN') && index !== stay.routeIds.indexOf(Number(data.routeId))) {
          if (anchorRoom && normalize(room) !== normalize(anchorRoom)) return false;
          if (anchorMeal && normalizeMealPlan(meal) !== normalizeMealPlan(anchorMeal)) return false;
        }
        return true;
      }).sort((left: any, right: any) => payableAmount(left) - payableAmount(right));
      // HOTEL intent selects a property for the itinerary occupancy, not an
      // arbitrary room-only option. Exclude options missing a required
      // extra-bed/child rate before choosing or persisting the selection.
      const selectableOptions = options.filter(hasRequiredSupplementRates);
      const eligibleAnchorOption = anchorOption && hasRequiredSupplementRates(anchorOption)
        ? anchorOption
        : null;
      const selected = index === stay.routeIds.indexOf(Number(data.routeId)) && eligibleAnchorOption
        ? eligibleAnchorOption
        : selectableOptions[0];
      if (!selected) {
        console.warn('[HOTEL_INTENT_NO_REQUEST_SCOPED_OPTION]', {
          quoteId,
          provider,
          hotelCode,
          requestedCanonicalHotelId,
          groupType,
          routeId,
          routeDate,
          requestedRoom,
          requestedMeal,
          candidateCount: candidates.length,
          routeCandidateCount: candidates.filter((option: any) => {
            const candidateRouteId = routeIdOf(option);
            return candidateRouteId === routeId ||
              (Array.isArray(option.routeIds) && option.routeIds.map(Number).includes(routeId));
          }).length,
          candidateIdentities: candidates.slice(0, 8).map((option: any) => ({
            routeId: routeIdOf(option),
            routeIds: option.routeIds,
            date: dateOf(option),
            provider: option.provider,
            canonicalHotelId: option.canonicalHotelId,
            hotelId: option.hotelId,
            hotelCode: option.hotelCode,
            providerHotelCode: option.providerHotelCode,
            roomType: option.roomType,
            mealPlan: option.mealPlan,
            groupType: option.groupType,
            selectable: option.isSelectable,
            bookable: option.isBookable,
          })),
        });
        throw new BadRequestException({
          code: 'HOTEL_INTENT_UNAVAILABLE',
          message: `The requested hotel selection is unavailable for ${routeDate}. No partial selection was saved.`,
          selectionIntent: intent,
          logicalStay: stay,
          affectedRouteIds: stay.routeIds,
          canBookSingleNight: stay.nights <= 1,
          canBookMultiNight: false,
        });
      }
      const pricedSelected = provider === 'axisrooms'
        ? await this.resolveAxisRoomsSelectionPricing(selected, plan, routeDate)
        : selected;
      selectedByRoute.push({ ...pricedSelected, itineraryRouteId: routeId, routeId, date: routeDate });
    }

    if (stay.nights > 1 && provider !== 'offline') {
      // HOTEL intent has no explicit rate-option anchor. Use the freshly
      // selected supplier option for continuity validation; otherwise the
      // validator receives empty room/rate identity and cannot resolve the
      // supplier mapping even though the refreshed option is valid.
      const continuityAnchor = anchorOption || selectedByRoute[stay.routeIds.indexOf(Number(data.routeId))] || selectedByRoute[0];
      const selectedRouteIndex = stay.routeIds.indexOf(Number(data.routeId));
      const selectedRouteDate = stay.stayDates[selectedRouteIndex] || stay.checkInDate;
      const continuity = await this.hotelStayBlockValidationService.previewStayExtension({
        planId: Number(data.planId), routeId: Number(data.routeId), provider: provider as any, hotelCode,
        hotelName: String(continuityAnchor?.hotelName || data.hotelName || '').trim() || undefined,
         roomId: intent === 'HOTEL' ? undefined : String(continuityAnchor?.roomId || continuityAnchor?.providerRoomId || data.roomId || '').trim() || undefined,
         rateId: intent === 'HOTEL' ? undefined : String(continuityAnchor?.rateId || continuityAnchor?.ratePlanId || data.rateId || '').trim() || undefined,
         roomType: intent === 'HOTEL' ? undefined : String(continuityAnchor?.roomType || continuityAnchor?.roomTypeName || anchorRoom || '').trim() || undefined,
         mealPlan: String(continuityAnchor?.mealPlan || continuityAnchor?.mealPlanCode || anchorMeal || '').trim() || undefined,
         allowRoomTypeChanges: intent === 'HOTEL',
        // The validator is anchored to the clicked route. Passing the
        // overall stay start here made a later route (for example 10702 on
        // 2026-08-23) validate as 2026-08-22 and collapse to a false
        // single-night result.
        checkInDate: selectedRouteDate, groupType,
      });
      if (!continuity.canBookMultiNight || continuity.blocked) {
        throw new BadRequestException({
          code: 'HOTEL_CONTINUOUS_STAY_UNAVAILABLE',
          message: continuity.restrictionConflicts?.map((conflict: any) => conflict.message).join(' | ') || 'The selected hotel cannot be booked for the complete continuous stay.',
          selectionIntent: intent, logicalStay: stay, restriction: continuity,
          canBookSingleNight: false, canBookMultiNight: false,
        });
      }
    }

    if (data.previewOnly) {
      // Confirmation persists room-count-scaled payable totals with the
      // configured hotel margin for every provider. The preview must expose
      // that same financial basis; returning the raw supplier room rate here
      // makes the confirmation dialog claim a decrease while persistence later
      // increases the amount for multiple rooms.
      const previewRoomCount = Math.max(
        Number((plan as any)?.preferred_room_count || data.roomCount || 1),
        1,
      );
      let previewMarginPercentage = Number(data.hotelMarginPercentage || 0);
      if (previewMarginPercentage <= 0) {
        const settingsModel = (this.prisma as any).dvi_global_settings;
        if (settingsModel?.findFirst) {
          const settings = await settingsModel.findFirst({
            where: { deleted: 0, status: 1 },
            orderBy: { global_settings_ID: 'asc' },
            select: { hotel_margin: true },
          });
          previewMarginPercentage = Math.max(
            Number(settings?.hotel_margin ?? process.env.HOTEL_MARGIN ?? 0),
            0,
          );
        }
      }
      return {
        status: 'AVAILABLE',
        success: true,
        planId: Number(data.planId),
        groupType,
        selectionIntent: intent,
        logicalStay: stay,
        affectedRouteIds: stay.routeIds,
        selections: selectedByRoute.map((selection: any) => {
          const rawPricePerNight = Number(
            selection.pricePerNight ?? selection.amountAfterTax ?? selection.price ?? 0,
          );
          const isBaseRate =
            selection.amountIncludesHotelMargin !== true &&
            selection.pricingIncludesHotelMargin !== true;
          const selectionMarginPercentage = Number(
            selection.hotelMarginPercentage ?? selection.marginPercentage ?? 0,
          ) > 0
            ? Number(selection.hotelMarginPercentage ?? selection.marginPercentage)
            : previewMarginPercentage;
          const payablePricePerNight = isBaseRate && rawPricePerNight > 0
            ? Number((rawPricePerNight * (1 + selectionMarginPercentage / 100)).toFixed(2))
            : rawPricePerNight;
          const payableTotal = isBaseRate && rawPricePerNight > 0
            ? Number((payablePricePerNight * previewRoomCount).toFixed(2))
            : Number(
              selection.totalStayPrice ?? selection.totalPrice ?? selection.amountAfterTax ?? selection.price ?? 0,
            );
          return {
          ...selection,
          routeId: Number(selection.routeId || selection.itineraryRouteId),
          routeDate: String(selection.date || '').slice(0, 10),
          provider: selection.provider || provider,
          hotelCode: selection.hotelCode || hotelCode,
          providerHotelCode: selection.providerHotelCode || selection.provider_hotel_code || hotelCode,
          canonicalHotelId: Number(selection.canonicalHotelId || selection.hotelId || data.canonicalHotelId || data.hotelId || 0) || null,
          hotelId: Number(selection.hotelId || selection.canonicalHotelId || data.hotelId || 0) || null,
          hotelName: selection.hotelName || data.hotelName || hotelCode,
          roomType: selection.roomType || selection.roomTypeName || requestedRoom,
          mealPlan: selection.mealPlan || selection.mealPlanCode || requestedMeal,
          selectedRateOptionId: selection.rateOptionId || selection.optionKey,
          rateOptionId: selection.rateOptionId || selection.optionKey,
          optionKey: selection.optionKey || selection.rateOptionId,
          selectionKey: supplierSelectionKey(selection) || undefined,
          supplierBookingCode: selection.bookingCode || selection.searchReference || undefined,
          pricePerNight: payablePricePerNight,
          totalPrice: payableTotal,
          basePricePerNight: isBaseRate ? rawPricePerNight : Number(selection.basePricePerNight ?? 0),
          baseTotalPrice: isBaseRate
            ? Number((rawPricePerNight * previewRoomCount).toFixed(2))
            : Number(selection.baseTotalPrice ?? 0),
          hotelMarginPercentage: isBaseRate ? selectionMarginPercentage : Number(selection.hotelMarginPercentage ?? 0),
          hotelMarginAmount: isBaseRate
            ? Number(((payablePricePerNight - rawPricePerNight) * previewRoomCount).toFixed(2))
            : Number(selection.hotelMarginAmount ?? 0),
          hotelMarginTotalAmount: isBaseRate
            ? Number(((payablePricePerNight - rawPricePerNight) * previewRoomCount).toFixed(2))
            : Number(selection.hotelMarginTotalAmount ?? selection.hotelMarginStayAmount ?? 0),
          amountIncludesHotelMargin: isBaseRate
            ? true
            : selection.amountIncludesHotelMargin === true,
          pricingIncludesHotelMargin: isBaseRate
            ? true
            : selection.pricingIncludesHotelMargin === true,
          currency: selection.currency || 'INR',
          };
        }),
      };
    }

    const persistencePayloads = selectedByRoute.map((rawSelected: any) => {
      const selected = normalizeSupplierRateIdentity(rawSelected);
      const routeDate = String(selected.date || '').slice(0, 10);
      const isAnchorRoute = Number(selected.routeId) === Number(data.routeId);
      const requestedPricePerNight = Number(data.pricePerNight ?? 0);
      const requestedTotalPrice = Number(data.totalPrice ?? 0);
      const selectedProvider = String(selected.provider || provider).trim().toLowerCase();
      const routeNight = Array.isArray(selected.nightlyRates)
        ? selected.nightlyRates.find((night: any) => String(night?.date || '').slice(0, 10) === routeDate)
        : null;
      // Offline candidates describe the complete continuous stay. Persistence
      // owns one route/night row, so project the authoritative matching night
      // instead of attaching the complete stay total to every route.
      const routeScopedOffline = selectedProvider === 'offline' && routeNight;
      const basePricePerNight = Number(
        routeScopedOffline?.baseAmount ?? selected.basePricePerNight ?? 0,
      );
      const baseTotalPrice = Number(
        routeScopedOffline?.baseAmount ?? selected.baseTotalPrice ?? 0,
      );
      const hotelMarginPercentage = Number(
        routeScopedOffline?.marginPercentage ?? selected.hotelMarginPercentage ?? 0,
      );
      const hotelMarginAmount = Number(
        routeScopedOffline?.marginAmount ?? selected.hotelMarginAmount ?? 0,
      );
      const hotelMarginTotalAmount = Number(
        routeScopedOffline?.marginAmount ??
        selected.hotelMarginTotalAmount ??
        selected.hotelMarginStayAmount ??
        selected.hotelMarginAmount ??
        0,
      );
      const selectedPricePerNight = Number(
        routeScopedOffline?.sellAmount ?? selected.pricePerNight ?? selected.amountAfterTax ?? selected.price ?? 0,
      );
      const selectedTotalPrice = Number(
        routeScopedOffline?.sellAmount ??
        selected.totalStayPrice ??
        selected.totalPrice ??
        selected.amountAfterTax ??
        selected.price ??
        0,
      );
      // A preview snapshot can contain a zero-valued parent option even when
      // the browser has the exact selected rate and its payable amount. If
      // the identity already matched that anchor, retain the request's
      // positive price instead of passing a zero into the persistence layer.
      const pricePerNight = selectedPricePerNight > 0
        ? selectedPricePerNight
        : isAnchorRoute && requestedPricePerNight > 0
          ? requestedPricePerNight
          : 0;
      const totalPrice = selectedTotalPrice > 0
        ? selectedTotalPrice
        : isAnchorRoute && requestedTotalPrice > 0
          ? requestedTotalPrice
          : pricePerNight > 0
            ? Number((pricePerNight * Math.max(Number(data.roomCount || 1), 1)).toFixed(2))
            : 0;
      return {
        ...data,
        selectionIntent: data.selectionIntent,
        routeId: Number(selected.routeId), routeDate, groupType,
        hotelId: Number(selected.canonicalHotelId || selected.hotelId || data.hotelId || 0) || null,
        canonicalHotelId: Number(selected.canonicalHotelId || selected.hotelId || data.canonicalHotelId || 0) || null,
        roomTypeId: Number(selected.roomTypeId || data.roomTypeId || 1), provider: selected.provider || provider,
        providerHotelCode: selected.providerHotelCode || selected.provider_hotel_code || providerHotelCode || hotelCode,
        hotelCode: selected.providerHotelCode || selected.provider_hotel_code || providerHotelCode || selected.hotelCode || hotelCode,
        selectionKey: supplierSelectionKey(selected) || data.selectionKey || undefined,
        rateOptionId: selected.rateOptionId || selected.optionKey,
        optionKey: selected.optionKey || selected.rateOptionId, hotelName: selected.hotelName,
        roomType: selected.roomType || selected.roomTypeName, mealPlanCode: selected.mealPlanCode || selected.mealPlan,
        roomId: selected.roomId, rateId: selected.rateId, pricePerNight, totalPrice,
        basePricePerNight,
        baseTotalPrice,
        extraBedCount: selected.extraBedCount,
        extraBedRate: selected.extraBedRate,
        extraBedAmount: selected.extraBedAmount,
        childWithBedCount: selected.childWithBedCount,
        childWithBedRate: selected.childWithBedRate,
        childWithBedAmount: selected.childWithBedAmount,
        childWithoutBedCount: selected.childWithoutBedCount,
        childWithoutBedRate: selected.childWithoutBedRate,
        childWithoutBedAmount: selected.childWithoutBedAmount,
        hotelMarginPercentage,
        hotelMarginAmount,
        hotelMarginStayAmount: hotelMarginTotalAmount,
        hotelMarginTotalAmount,
        numberOfNights: routeScopedOffline ? 1 : Number(selected.numberOfNights || 1),
        nightlyRates: routeScopedOffline ? [routeNight] : selected.nightlyRates,
        amountIncludesHotelMargin: selected.amountIncludesHotelMargin === true,
        pricingIncludesHotelMargin: selected.pricingIncludesHotelMargin === true,
        bookingCode: selectedProvider === 'tbo'
          ? selected.bookingCode
          : selected.bookingCode || selected.rateOptionId || selected.optionKey,
        searchReference: selectedProvider === 'tbo'
          ? selected.searchReference || selected.bookingCode
          : selected.searchReference || selected.rateOptionId || selected.optionKey,
        currency: selected.currency || 'INR', selectionOrigin: 'USER_SELECTED',
        // This payload was resolved from the current supplier response above.
        // It is safe to persist its price; unlike a browser-supplied price,
        // it is not trusted merely because it came from the request body.
        selectionPricingSource: 'SERVER_RESOLVED',
      };
    });
    try {
      await this.selectionWorkflowService.bulkSaveHotels(Number(data.planId), persistencePayloads, Number(data.requestedBy || 1), true, true);
    } catch (error) {
      console.error('[HOTEL_INTENT] atomic persistence failed', error);
      throw new BadRequestException({
        code: 'HOTEL_INTENT_PERSIST_FAILED',
        message: error instanceof Error ? error.message : 'Hotel intent persistence failed',
        canBookSingleNight: false,
        canBookMultiNight: false,
        affectedRouteIds: stay.routeIds,
      });
    }

    const persisted = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: Number(data.planId), group_type: groupType, itinerary_route_id: { in: stay.routeIds }, hotel_required: 1, status: 1, deleted: 0 },
      orderBy: { itinerary_route_id: 'asc' },
    });
    const persistedHotelIds = Array.from(new Set(
      persisted.map((row: any) => Number(row.hotel_id || 0)).filter((hotelId: number) => hotelId > 0),
    ));
    const persistedHotelMasters = persistedHotelIds.length > 0
      ? await this.prisma.dvi_hotel.findMany({
          where: { hotel_id: { in: persistedHotelIds }, deleted: false },
          select: { hotel_id: true, hotel_name: true, hotel_category: true },
        })
      : [];
    const persistedHotelMasterMap = new Map(
      persistedHotelMasters.map((master: any) => [Number(master.hotel_id), master]),
    );
    const selections = persisted.map((row: any) => {
      let snapshot: any = {};
      try { snapshot = typeof row.selected_price_snapshot === 'string' ? JSON.parse(row.selected_price_snapshot) : (row.selected_price_snapshot || {}); } catch { snapshot = {}; }
      const persistedRouteDate = row.itinerary_route_date instanceof Date
        ? row.itinerary_route_date.toISOString().slice(0, 10)
        : String(row.itinerary_route_date || '').slice(0, 10);
      const identity = resolvePersistedHotelIdentity(
        row,
        persistedHotelMasterMap.get(Number(row.hotel_id || 0)) || null,
      );
      if (identity.provider === 'offline' && !identity.consistent) {
        console.error('[HOTEL_INTENT] persisted offline identity mismatch', {
          planId: Number(data.planId),
          routeId: Number(row.itinerary_route_id),
          groupType,
          hotelId: Number(row.hotel_id || 0),
          mismatches: identity.mismatches,
        });
      }
      return {
        routeId: Number(row.itinerary_route_id), routeDate: persistedRouteDate,
        hotelId: row.hotel_id, canonicalHotelId: row.hotel_id,
        hotelCode: row.hotel_code || snapshot.providerHotelCode || snapshot.hotelCode,
        providerHotelCode: snapshot.providerHotelCode || row.hotel_code || null,
        selectionKey: snapshot.selectionKey || supplierSelectionKey(snapshot) || undefined,
        provider: row.hotel_provider,
        hotelName: identity.provider === 'offline'
          ? identity.hotelName
          : snapshot.hotelName || row.hotel_name || data.hotelName || hotelCode,
        category: identity.provider === 'offline'
          ? identity.category
          : Number(snapshot.category || data.category || 0),
        selectedRateOptionId: row.selected_rate_option_id, rateOptionId: row.selected_rate_option_id,
        roomId: snapshot.roomId, roomTypeId: snapshot.roomTypeId, roomType: snapshot.roomType,
        rateId: snapshot.rateId, mealPlan: snapshot.mealPlan, mealPlanCode: snapshot.mealPlan,
        bookingCode: snapshot.bookingCode, searchReference: snapshot.searchReference,
        pricePerNight: Number(row.selected_price_per_night || 0), totalPrice: Number(row.selected_total_price || 0), currency: row.selected_currency || 'INR',
        selectedPriceSnapshot: snapshot,
        basePricePerNight: Number(snapshot.basePricePerNight ?? snapshot.base_price_per_night ?? 0),
        baseTotalPrice: Number(snapshot.baseTotalPrice ?? snapshot.base_total_price ?? 0),
        extraBedCount: Number(snapshot.extraBedCount ?? snapshot.extra_bed_count ?? 0),
        extraBedRate: Number(snapshot.extraBedRate ?? snapshot.extra_bed_rate ?? 0),
        extraBedAmount: Number(snapshot.extraBedAmount ?? snapshot.extra_bed_amount ?? 0),
        childWithBedCount: Number(snapshot.childWithBedCount ?? snapshot.child_with_bed_count ?? 0),
        childWithBedRate: Number(snapshot.childWithBedRate ?? snapshot.child_with_bed_rate ?? 0),
        childWithBedAmount: Number(snapshot.childWithBedAmount ?? snapshot.child_with_bed_amount ?? 0),
        childWithoutBedCount: Number(snapshot.childWithoutBedCount ?? snapshot.child_without_bed_count ?? 0),
        childWithoutBedRate: Number(snapshot.childWithoutBedRate ?? snapshot.child_without_bed_rate ?? 0),
        childWithoutBedAmount: Number(snapshot.childWithoutBedAmount ?? snapshot.child_without_bed_amount ?? 0),
        hotelMarginPercentage: Number(snapshot.hotelMarginPercentage ?? row.hotel_margin_percentage ?? 0),
        hotelMarginAmount: Number(snapshot.hotelMarginAmount ?? row.hotel_margin_rate ?? 0),
        hotelMarginTotalAmount: Number(
          snapshot.hotelMarginTotalAmount ?? snapshot.hotelMarginAmount ?? row.hotel_margin_rate ?? 0,
        ),
        numberOfNights: Number(snapshot.numberOfNights ?? 1),
        nightlyRates: Array.isArray(snapshot.nightlyRates) ? snapshot.nightlyRates : [],
        selectionOrigin: 'USER_SELECTED', selectionStatus: 'SAVED',
      };
    });
    // Return the same authoritative financial envelope used by availability
    // and reset. The mutation has already committed the DB rows, so this is a
    // read-after-write response and cannot be based on the browser's stale
    // Garden/previous-room totals.
    let itinerary: any = null;
    try {
      itinerary = await this.itineraryDetails.getItineraryDetails(
        quoteId,
        groupType,
        undefined,
      );
    } catch (error) {
      // Selection persistence remains successful even if response enrichment
      // fails; the client still receives the persisted selections and can
      // retry the normal itinerary read.
      console.error('[HOTEL_INTENT] financial response enrichment failed', error);
    }
    return {
      success: true, planId: Number(data.planId), groupType, selectionIntent: intent,
      logicalStay: stay,
      hotelDetails: selections,
      selections,
      financialSummary: {
        overallCost: itinerary?.overallCost ?? null,
        costBreakdown: itinerary?.costBreakdown ?? null,
      },
      totals: { totalPrice: selections.reduce((sum: number, selection: any) => sum + Number(selection.totalPrice || 0), 0) },
    };
  }

  /**
   * Resolve AxisRooms selection amounts from the current occupancy-rate row.
   * Selection responses must contain the complete API-owned breakdown; a
   * browser snapshot or supplier parent total must never be used as the room
   * cost when the occupancy table has the authoritative components.
   */
  private async resolveAxisRoomsSelectionPricing(option: any, plan: any, routeDate: string): Promise<any> {
    const reference = String(
      option?.rateOptionId || option?.rate_option_id || option?.bookingCode || option?.booking_code || '',
    ).trim();
    const match = reference.match(/(?:axisrooms:|AX-)([^:|-]+)[:|-]([^:|-]+)[:|-]([^:|-]+)/i);
    const hotelId = Number(option?.canonicalHotelId || option?.hotelId || option?.hotel_id || match?.[1] || 0);
    const roomId = Number(option?.roomId || option?.room_id || match?.[2] || 0);
    const rateplanId = String(option?.rateplanId || option?.ratePlanId || option?.rateplan_id || match?.[3] || '').trim();
    if (!hotelId || !roomId || !rateplanId || !/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return option;

    const rows = await (this.prisma as any).dvi_hotel_occupancy_rate.findMany({
      where: {
        hotel_id: hotelId,
        room_id: roomId,
        rateplan_id: rateplanId,
        start_date: { lte: new Date(`${routeDate}T00:00:00.000Z`) },
        end_date: { gte: new Date(`${routeDate}T00:00:00.000Z`) },
      },
      select: { occupancy_rates: true, received_at: true, start_date: true },
      orderBy: [{ received_at: 'desc' }, { start_date: 'desc' }],
    });
    let rates: Record<string, any> | null = null;
    for (const row of Array.isArray(rows) ? rows : []) {
      try {
        const parsed = typeof row.occupancy_rates === 'string' ? JSON.parse(row.occupancy_rates) : row.occupancy_rates;
        if (parsed && typeof parsed === 'object') { rates = parsed; break; }
      } catch { /* ignore malformed historical rows */ }
    }
    if (!rates) return option;

    const roomCount = Math.max(Number(plan?.preferred_room_count || plan?.total_no_of_rooms || 1), 1);
    const adults = Math.max(Number(plan?.total_adult || 0), 0);
    const hotel = await this.prisma.dvi_hotel.findUnique({ where: { hotel_id: hotelId }, select: { hotel_margin: true } });
    let marginPercentage = Number(hotel?.hotel_margin || 0);
    if (!(marginPercentage > 0)) {
      const settings = await (this.prisma as any).dvi_global_settings?.findFirst?.({
        where: { deleted: 0, status: 1 }, orderBy: { global_settings_ID: 'asc' }, select: { hotel_margin: true },
      });
      marginPercentage = Number(settings?.hotel_margin ?? process.env.HOTEL_MARGIN ?? 0);
    }
    const pricing = resolveHotelOccupancyPricing({
      rates,
      roomCount,
      adultCount: adults,
      extraBedCount: plan?.total_extra_bed,
      childWithBedCount: plan?.total_child_with_bed,
      childWithoutBedCount: plan?.total_child_without_bed,
      marginPercentage,
    });
    if (!(pricing.hotelMarginBaseAmount > 0)) return option;
    const marginAmount = pricing.hotelMarginAmount;
    const totalPrice = pricing.totalPrice;
    return {
      ...option,
      basePricePerNight: pricing.roomRate,
      baseTotalPrice: pricing.baseTotalPrice,
      baseHotelCost: pricing.baseTotalPrice,
      extraBedCount: pricing.extraBedCount, extraBedRate: pricing.extraBedRate, extraBedAmount: pricing.extraBedAmount,
      childWithBedCount: pricing.childWithBedCount, childWithBedRate: pricing.childWithBedRate, childWithBedAmount: pricing.childWithBedAmount,
      childWithoutBedCount: pricing.childWithoutBedCount, childWithoutBedRate: pricing.childWithoutBedRate, childWithoutBedAmount: pricing.childWithoutBedAmount,
      hotelMarginPercentage: pricing.hotelMarginPercentage,
      hotelMarginBaseAmount: pricing.hotelMarginBaseAmount,
      hotelMarginAmount: marginAmount,
      hotelMarginTotalAmount: marginAmount,
      amountIncludesHotelMargin: true,
      pricingIncludesHotelMargin: true,
      pricePerNight: Number((totalPrice / roomCount).toFixed(2)),
      totalPrice,
      totalStayPrice: totalPrice,
      totalHotelCost: totalPrice,
    };
  }

  /** Resolve offline offers from the current catalog, never from the search snapshot. */
  private async resolveOfflineIntentCandidates(plan: any, stay: any, data: any, groupType: number) {
    const routeRows = await this.prisma.dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: Number(data.planId),
        itinerary_route_ID: { in: stay.routeIds.map(Number) },
        deleted: 0,
        status: 1,
      } as any,
      orderBy: { itinerary_route_date: 'asc' },
    });
    if (routeRows.length !== stay.routeIds.length) {
      throw new BadRequestException({
        code: 'HOTEL_NO_AVAILABILITY',
        status: 'NO_AVAILABILITY',
        message: 'The selected hotel is not available for the requested stay.',
        affectedRouteIds: stay.routeIds,
      });
    }

    this.offlineHotelCatalogService.clearCache();
    const offlineByRoute = await this.offlineHotelCatalogService.fetchOfflineHotelsForRoutes(
      routeRows,
      Number(stay.nights || 1),
      '',
      Math.max(Number(plan?.preferred_room_count || 1), 1),
      Math.max(Number(plan?.total_adult || 0), 0),
      Math.max(Number(plan?.total_children || 0), 0),
    );
    const normalize = (value: unknown) => String(value || '').trim().toLowerCase();
    const requestedCanonical = Number(data.canonicalHotelId || data.hotelId || 0);
    const requestedCode = normalize(data.hotelCode || data.providerHotelCode || data.hotelId);
    const requestedRoom = normalize(data.roomType);
    const requestedMeal = normalize(data.mealPlanCode || data.mealPlan);
    const requestedRate = String(data.rateOptionId || data.optionKey || '').trim();

    const candidates: any[] = [];
    for (let index = 0; index < stay.routeIds.length; index += 1) {
      const routeId = Number(stay.routeIds[index]);
      const routeDate = String(stay.stayDates[index] || '').slice(0, 10);
      const hotels = offlineByRoute.get(routeId) || [];
      const hotel = hotels.find((candidate: any) => {
        const candidateId = Number(candidate.canonicalHotelId || candidate.hotelId || candidate.hotelCode || 0);
        return candidateId === requestedCanonical || (
          requestedCanonical <= 0 && normalize(candidate.hotelCode) === requestedCode
        );
      });
      const options = hotel
        ? (Array.isArray((hotel as any).rateOptions) && (hotel as any).rateOptions.length > 0
          ? (hotel as any).rateOptions
          : [hotel])
        : [];
      const matching = options
        .filter((option: any) => {
          const room = normalize(option.roomType || option.roomTypeName || hotel?.roomType);
          const meal = normalize(option.mealPlan || option.mealPlanCode || hotel?.mealPlan);
          if (requestedRate && String(option.rateOptionId || option.optionKey || '').trim() !== requestedRate) return false;
          if (requestedRoom && room !== requestedRoom) return false;
          if (requestedMeal && meal !== requestedMeal) return false;
          return option.isSelectable !== false && option.isBookable !== false;
        })
        .sort((left: any, right: any) => Number(left.totalStayPrice || left.totalPrice || 0) - Number(right.totalStayPrice || right.totalPrice || 0));
      const selected = matching[0];
      if (!selected) {
        throw new BadRequestException({
          code: 'HOTEL_NO_AVAILABILITY',
          status: 'NO_AVAILABILITY',
          message: `The selected hotel is not available for ${routeDate}.`,
          affectedRouteIds: stay.routeIds,
        });
      }
      candidates.push({
        ...hotel,
        ...selected,
        provider: 'offline',
        hotelCode: String(selected.providerHotelCode || selected.hotelCode || hotel?.hotelCode || requestedCode),
        canonicalHotelId: Number(selected.canonicalHotelId || hotel?.canonicalHotelId || requestedCanonical || 0),
        hotelId: Number(selected.hotelId || selected.canonicalHotelId || (hotel as any)?.hotelId || (hotel as any)?.canonicalHotelId || requestedCanonical || 0),
        hotelName: selected.hotelName || hotel?.hotelName || data.hotelName,
        itineraryRouteId: routeId,
        routeId,
        date: routeDate,
        routeDate,
        routeIds: stay.routeIds,
      });
    }
    return candidates;
  }

 /**
   * Bulk save hotel selections - used before confirming itinerary
 */
  async bulkSaveHotels(planId: number, hotels: any[], requestedBy = 1) {
    return this.selectionWorkflowService.bulkSaveHotels(planId, hotels, requestedBy);
  }

  async selectVehicleVendor(
  data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId: number;
  },
  viewerRole?: unknown,
) {
  const selection =
    await this.selectionWorkflowService.selectVehicleVendor(
      data,
    );

  const plan =
    await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: {
        itinerary_plan_ID: Number(data.planId),
      },
      select: {
        itinerary_quote_ID: true,
      },
    });

  const quoteId = String(
    plan?.itinerary_quote_ID || "",
  ).trim();

  const itinerary = quoteId
    ? await this.itineraryDetails.getItineraryDetails(
        quoteId,
        undefined,
        viewerRole,
      )
    : null;

  return {
    ...selection,
    costBreakdown:
      itinerary?.costBreakdown ?? null,
    vehicleSelections:
      itinerary?.vehicleSelections ?? [],
  };
}
  async selectVehicleSlab(data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId?: number;
    timeLimitId?: number;
  }) {
    return this.selectionWorkflowService.selectVehicleSlab(data);
  }
  async autoSelectVehicleSlabs(data: {
    planId: number;
    vehicleTypeId?: number;
  }) {
    return this.selectionWorkflowService.autoSelectVehicleSlabs(data);
  }
  private async forceRebuildVehiclePricingAfterHotspotChange(planId: number, routeId?: number) {
    return this.selectionWorkflowService.forceRebuildVehiclePricingAfterHotspotChange(planId, routeId);
  }
  async getPlanForEdit(planId: number) {
    return this.quoteContextService.getPlanForEdit(planId);
  }

  async getCustomerInfoForm(planId: number) {
    return this.quoteContextService.getCustomerInfoForm(planId);
  }

  async checkWalletBalance(agentId: number) {
    return this.quoteContextService.checkWalletBalance(agentId);
  }

  async getAgentWalletBalance(agentId: number) {
    return this.quoteContextService.getAgentWalletBalance(agentId);
  }
  async confirmQuotation(dto: ConfirmQuotationDto) {
    return this.confirmationService.confirmQuotation(dto);
  }
  private isBookingResultSuccess(result: any): boolean {
    return this.confirmationService.isBookingResultSuccess(result);
  }
  private bookingKey(provider: string, routeId: number): string {
    return this.confirmationService.bookingKey(provider, routeId);
  }
  private getProviderBookableHotelBookings<T extends any>(hotelBookings?: T[]): T[] {
    return this.confirmationService.getProviderBookableHotelBookings(hotelBookings);
  }
  private getConfirmHotelGroupType(dto: ConfirmQuotationDto): number {
    return this.confirmationService.getConfirmHotelGroupType(dto);
  }
  private uniquePositiveNumbers(values: any[]): number[] {
    return this.confirmationService.uniquePositiveNumbers(values);
  }
  private mergeConsecutiveSupplierHotelBookings<T extends any>(bookings: T[]): T[] {
    return this.confirmationService.mergeConsecutiveSupplierHotelBookings(bookings);
  }
  private pruneHotelBookingsCoveredByMultiNight<T extends any>(bookings: T[]): T[] {
    return this.confirmationService.pruneHotelBookingsCoveredByMultiNight(bookings);
  }
  private assertConsistentMultiNightHotelSelection(providerHotelBookings: any[]): void {
    return this.confirmationService.assertConsistentMultiNightHotelSelection(providerHotelBookings);
  }
  private async syncSelectedHotelDraftRowsForConfirmation(
    dto: ConfirmQuotationDto,
    userId: number,
  ) {
    return this.hotelConfirmationSupportService.syncSelectedHotelDraftRowsForConfirmation(dto, userId);
  }

  private async finalizeConfirmationFinancials(baseResult: any, dto: ConfirmQuotationDto, userId: number): Promise<void> {
    return this.hotelConfirmationSupportService.finalizeConfirmationFinancials(baseResult, dto, userId);
  }

  private async filterAlreadySuccessfulBookings(itineraryPlanId: number, bookings: any[]) {
    return this.hotelConfirmationSupportService.filterAlreadySuccessfulBookings(itineraryPlanId, bookings);
  }
  async prebookHotels(payload: any) {
    return this.hotelPrebookService.prebookHotels(payload);
  }
  async processConfirmationWithTboBookings(
    baseResult: any,
    dto: ConfirmQuotationDto,
    endUserIp: string = process.env.TBO_END_USER_IP || '134.209.145.185',
  ) {
    return this.hotelBookingFulfillmentService.processConfirmationWithTboBookings(baseResult, dto, endUserIp);
  }
  private async copyDraftToConfirmed(
    tx: any,
    draftPlanId: number,
    confirmedPlanId: number,
    userId: number,
    options: {
      copyHotels?: boolean;
      hotelGroupType?: number;
      selectedHotelRouteIds?: number[];
    } = {},
  ) {
    return this.confirmedPlanCopyService.copyDraftToConfirmed(
      tx,
      draftPlanId,
      confirmedPlanId,
      userId,
      options,
    );
  }
    async cancelItinerary(dto: CancelItineraryDto) {
    return this.cancellationService.cancelItinerary(dto);
  }

  async getItineraryCancellationDetails(itineraryPlanId: number) {
    return this.cancellationService.getCancellationDetails(itineraryPlanId);
  }
  private async logCancellationAction(...args: any[]) {
    return (this.cancellationService.logCancellationAction as any)(...args);
  }
  async getAgentsForFilter(req: any) {
    return this.listingService.getAgentsForFilter(req);
  }

  async getLocationsForFilter(req?: any) {
    return this.listingService.getLocationsForFilter(req);
  }

  async getLocationsForLatestFilter(req?: any): Promise<{ value: string; label: string }[]> {
    return this.listingService.getLocationsForLatestFilter(req);
  }

  async getConfirmedItineraries(query: LatestItineraryQueryDto, req: any) {
    return this.listingService.getConfirmedItineraries(query, req);
  }

  async getCancelledItineraries(query: LatestItineraryQueryDto, req: any) {
    return this.listingService.getCancelledItineraries(query, req);
  }

  async getAccountsItineraries(query: LatestItineraryQueryDto, req: any) {
    return this.listingService.getAccountsItineraries(query, req);
  }
  async getVoucherDetails(itineraryPlanId: number) {
    return this.voucherReadService.getVoucherDetails(itineraryPlanId);
  }

  async getTransportVoucherDetails(itineraryPlanId: number): Promise<TransportVoucherDetails> {
    return this.voucherReadService.getTransportVoucherDetails(itineraryPlanId);
  }
  private toDateOnly(value: Date | string | null | undefined): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().split('T')[0];
  }

  private getInvoiceToLabel(invoiceTo: number): string {
    switch (Number(invoiceTo || 0)) {
      case 1:
        return 'GST Bill Against DVI';
      case 2:
        return 'Hotel Direct';
      case 3:
        return 'Agent';
      default:
        return 'Not Set';
    }
  }

  private getVoucherStatusLabel(status: number, isCancelled: boolean): string {
    if (isCancelled) {
      return 'Cancelled';
    }

      switch (Number(status || 0)) {
        case 4:
          return 'Confirmed';
        case 6:
          return 'Cancelled';
        case 5:
          return 'Sold Out';
        case 3:
          return 'Blocked';
        case 2:
          return 'Waiting List';
        case 1:
          return 'Awaiting';
        default:
        return 'Not Created';
      }
    }

  async getPluckCardData(itineraryPlanId: number) {
    return this.invoiceReadService.getPluckCardData(itineraryPlanId);
  }

  async getPluckCardDataByConfirmedId(confirmedPlanId: number) {
    return this.invoiceReadService.getPluckCardDataByConfirmedId(confirmedPlanId);
  }

  async getInvoiceData(itineraryPlanId: number) {
    return this.invoiceReadService.getInvoiceData(itineraryPlanId);
  }
 /**
   * Preview manual hotspot addition.
 */
  async previewManualHotspot(
    planId: number,
    routeId: number,
    hotspotId: number,
    anchor?: {
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
      selectedHotspotIds?: number[];
      debug?: boolean;
    },
  ) {
    return this.manualHotspotPreviewService.previewManualHotspot(planId, routeId, hotspotId, anchor);
  }

  async previewManualHotspotsBatch(
    planId: number,
    routeId: number,
    hotspotIds: number[],
    options?: any,
  ) {
    return this.manualHotspotPreviewService.previewManualHotspotsBatch(planId, routeId, hotspotIds, options);
  }

  async previewManualHotspotFitHere(planId: number, payload: any) {
    return this.manualHotspotPreviewService.previewManualHotspotFitHere(planId, payload);
  }

  async previewManualHotspotAutoFitHere(planId: number, payload: any) {
    return this.manualHotspotPreviewService.previewManualHotspotAutoFitHere(planId, payload);
  }

  async confirmManualHotspotFitHere(planId: number, payload: any, userId: number = 1) {
    return this.manualHotspotPreviewService.confirmManualHotspotFitHere(planId, payload, userId);
  }

  private buildExactAnchorSequentialTimelineCacheKey(...args: any[]) {
    return (this.manualHotspotPreviewService.buildExactAnchorSequentialTimelineCacheKey as any)(...args);
  }

  private rememberExactAnchorSequentialTimeline(...args: any[]) {
    return (this.manualHotspotPreviewService.rememberExactAnchorSequentialTimeline as any)(...args);
  }

  private cloneTimelineRowsForPreview(...args: any[]) {
    return (this.manualHotspotPreviewService.cloneTimelineRowsForPreview as any)(...args);
  }

  private buildManualFitTimelineFingerprint(...args: any[]) {
    return (this.manualHotspotPreviewService.buildManualFitTimelineFingerprint as any)(...args);
  }

  private buildManualFitAnchorLabel(...args: any[]) {
    return (this.manualHotspotPreviewService.buildManualFitAnchorLabel as any)(...args);
  }
  async buildMissingManualHotspotMatrix(params: {
    planId: number;
    routeId: number;
    candidateHotspotId: number;
    userId?: number;
  }): Promise<ManualHotspotMatrixBuildResult> {
    return this.manualHotspotMatrixService.buildMissingManualHotspotMatrix(params);
  }
  async addManualHotspot(...args: any[]) {
    return (this.manualHotspotMutationService.addManualHotspot as any)(...args);
  }

  async applyManualHotspotsBatch(...args: any[]) {
    return (this.manualHotspotMutationService.applyManualHotspotsBatch as any)(...args);
  }
  private normalizeManualHotspotIds(ids: any[]): number[] {
    return Array.from(
      new Set(
        (ids || [])
          .map((id: any) => Number(id))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ),
    );
  }

  private async inferDetourOptimizedAnchorIndex(...args: any[]) {
    return (this.manualFitMatrixPlanningService.inferDetourOptimizedAnchorIndex as any)(...args);
  }

  private async resolveMatrixBestInsertionGap(...args: any[]) {
    return (this.manualFitMatrixPlanningService.resolveMatrixBestInsertionGap as any)(...args);
  }

  private async buildMatrixRouteTimelineAfterLowPriorityRemoval(...args: any[]) {
    return (this.manualFitMatrixPlanningService.buildMatrixRouteTimelineAfterLowPriorityRemoval as any)(...args);
  }
  private async buildExactAnchorSequentialTimelineAfterRemoval(...args: any[]) {
    return (this.exactAnchorRebuildService.buildExactAnchorSequentialTimelineAfterRemoval as any)(...args);
  }

  private async resolveLowPriorityRemovalForMatrixOverflowInTx(...args: any[]) {
    return (this.lowPriorityRemovalService.resolveLowPriorityRemovalForMatrixOverflowInTx as any)(...args);
  }

  private buildProgressiveRemovalReason(...args: any[]) {
    return (this.lowPriorityRemovalService.buildProgressiveRemovalReason as any)(...args);
  }

  private buildSelectedClosingRemovalReason(...args: any[]) {
    return (this.lowPriorityRemovalService.buildSelectedClosingRemovalReason as any)(...args);
  }

  private buildProgressiveRemovalSuccessMessage(...args: any[]) {
    return (this.lowPriorityRemovalService.buildProgressiveRemovalSuccessMessage as any)(...args);
  }

  private async getActiveRouteHotspotIdSetInTx(...args: any[]) {
    return (this.lowPriorityRemovalService.getActiveRouteHotspotIdSetInTx as any)(...args);
  }

  private async getActiveRouteManualFitRemovalEvidenceInTx(...args: any[]) {
    return (this.lowPriorityRemovalService.getActiveRouteManualFitRemovalEvidenceInTx as any)(...args);
  }

  private async getActiveRouteManualFitRemovalEvidence(...args: any[]) {
    return (this.lowPriorityRemovalService.getActiveRouteManualFitRemovalEvidence as any)(...args);
  }

  private getManualFitRemovalHotspotId(...args: any[]) {
    return (this.lowPriorityRemovalService.getManualFitRemovalHotspotId as any)(...args);
  }

  private getManualFitRemovalRouteHotspotId(...args: any[]) {
    return (this.lowPriorityRemovalService.getManualFitRemovalRouteHotspotId as any)(...args);
  }

  private getManualFitRemovalRouteId(...args: any[]) {
    return (this.lowPriorityRemovalService.getManualFitRemovalRouteId as any)(...args);
  }

  private sanitizeUserFacingManualFitRemovals(...args: any[]) {
    return (this.lowPriorityRemovalService.sanitizeUserFacingManualFitRemovals as any)(...args);
  }

  private buildManualFitFinalizedPreviewTimeline(...args: any[]) {
    return (this.lowPriorityRemovalService.buildManualFitFinalizedPreviewTimeline as any)(...args);
  }

  private buildManualFitAttemptTimelineSnapshot(...args: any[]) {
    return (this.lowPriorityRemovalService.buildManualFitAttemptTimelineSnapshot as any)(...args);
  }

  private buildManualFitAttemptDisplayTimelineSnapshot(...args: any[]) {
    return (this.lowPriorityRemovalService.buildManualFitAttemptDisplayTimelineSnapshot as any)(...args);
  }

  private buildManualFitAttemptComputedDisplayTimelineSnapshot(...args: any[]) {
    return (this.lowPriorityRemovalService.buildManualFitAttemptComputedDisplayTimelineSnapshot as any)(...args);
  }

  private validateManualFitAttemptDisplayTimeline(...args: any[]) {
    return (this.lowPriorityRemovalService.validateManualFitAttemptDisplayTimeline as any)(...args);
  }

  private async filterPlannedRemovalsToSameRouteInTx(...args: any[]) {
    return (this.lowPriorityRemovalService.filterPlannedRemovalsToSameRouteInTx as any)(...args);
  }
  private validateResolvedLowPriorityTimeline(...args: any[]): string | null {
    return (this.manualFitTimelinePolicyService.validateResolvedLowPriorityTimeline as any)(...args);
  }

  private minutesToTimeRange(...args: any[]): string {
    return (this.manualFitTimelinePolicyService.minutesToTimeRange as any)(...args);
  }

  private sanitizeResolvedLowPriorityTimeline(...args: any[]): any[] {
    return (this.manualFitTimelinePolicyService.sanitizeResolvedLowPriorityTimeline as any)(...args);
  }

  private pruneRemovedHotspotsFromManualPreviewTimeline(...args: any[]): any[] {
    return (this.manualFitTimelinePolicyService.pruneRemovedHotspotsFromManualPreviewTimeline as any)(...args);
  }

  private removeManualFitDroppedRowsFromTimeline(timeline: any[], removedRows: any[]): any[] {
    return removeManualFitDroppedRowsFromTimelineImpl.call(this, timeline, removedRows);
  }

  private manualFitTimelinePreservesSelectedAnchor(params: {
    timeline: any[];
    selectedHotspotId: number;
    afterHotspotId?: number | null;
    beforeHotspotId?: number | null;
    anchorIntent?: ManualFitHereAnchorIntent;
    allowBoundaryRescuePlacement?: boolean;
  }): boolean {
    return manualFitTimelinePreservesSelectedAnchorImpl.call(this, params);
  }
  private isRetryableManualPreviewTransactionError(...args: any[]): boolean {
    return (this.manualFitTimelinePolicyService.isRetryableManualPreviewTransactionError as any)(...args);
  }

  private normalizeExactAnchorManualInsertionFit(...args: any[]): any {
    return (this.manualFitTimelinePolicyService.normalizeExactAnchorManualInsertionFit as any)(...args);
  }

  private timelineContainsPlannedRemovalRows(...args: any[]): boolean {
    return (this.manualFitTimelinePolicyService.timelineContainsPlannedRemovalRows as any)(...args);
  }



  private async applyMatrixSafeManualHotspotInsertionInTx(...args: any[]) {
    return (this.matrixSafeInsertionService.applyMatrixSafeManualHotspotInsertionInTx as any)(...args);
  }
  private applyManualInsertionFitToPreviewTimeline(...args: any[]) {
    return (this.previewTimelineApplicationService.applyManualInsertionFitToPreviewTimeline as any)(...args);
  }
  private destinationSidePreviewDroppedBaselineRows(...args: any[]) {
    return (this.previewTimelineApplicationService.destinationSidePreviewDroppedBaselineRows as any)(...args);
  }
  private async pruneManualFitBacktrackingAfterSelectedPivotInTx(...args: any[]) {
    return (this.previewTimelineApplicationService.pruneManualFitBacktrackingAfterSelectedPivotInTx as any)(...args);
  }
  private rebuildDestinationSidePreviewFromBaseline(...args: any[]) {
    return (this.previewTimelineApplicationService.rebuildDestinationSidePreviewFromBaseline as any)(...args);
  }

  private async getCachedRouteDurationMinutes(...args: any[]) {
    return (this.routeLegCacheService.getCachedRouteDurationMinutes as any)(...args);
  }
  private getOsrmLegCacheTtlMs(...args: any[]) {
    return (this.routeLegCacheService.getOsrmLegCacheTtlMs as any)(...args);
  }
  private getOsrmLegCacheKey(...args: any[]) {
    return (this.routeLegCacheService.getOsrmLegCacheKey as any)(...args);
  }
  private getOsrmLegFromRuntimeCache(...args: any[]) {
    return (this.routeLegCacheService.getOsrmLegFromRuntimeCache as any)(...args);
  }
  private setOsrmLegRuntimeCache(...args: any[]) {
    return (this.routeLegCacheService.setOsrmLegRuntimeCache as any)(...args);
  }
  private async resolveOsrmLegBetweenHotspots(...args: any[]) {
    return (this.routeLegCacheService.resolveOsrmLegBetweenHotspots as any)(...args);
  }
  private async getCachedRouteDistanceKm(...args: any[]) {
    return (this.routeLegCacheService.getCachedRouteDistanceKm as any)(...args);
  }
  private async getCachedRouteMatrixLeg(...args: any[]) {
    return (this.routeLegCacheService.getCachedRouteMatrixLeg as any)(...args);
  }
  private estimateDurationFromDistance(...args: any[]) {
    return (this.routeLegCacheService.estimateDurationFromDistance as any)(...args);
  }
  private chooseReliableTravelDistanceKm(...args: any[]) {
    return (this.routeLegCacheService.chooseReliableTravelDistanceKm as any)(...args);
  }
  private finalizeMatrixPreviewTimeline(...args: any[]): any[] {
    return (this.matrixPreviewTimelinePolicyService.finalizeMatrixPreviewTimeline as any)(...args);
  }

  private isManualPreviewTimelineWrapped(...args: any[]): boolean {
    return (this.matrixPreviewTimelinePolicyService.isManualPreviewTimelineWrapped as any)(...args);
  }

  private repairMatrixPreviewTimelineTimeRanges(...args: any[]): any[] {
    return (this.matrixPreviewTimelinePolicyService.repairMatrixPreviewTimelineTimeRanges as any)(...args);
  }

  private assertTimelineOrderForMatrixPreview(...args: any[]): void {
    return (this.matrixPreviewTimelinePolicyService.assertTimelineOrderForMatrixPreview as any)(...args);
  }

  private getPreviewRowDurationMinutes(...args: any[]): number | null {
    return (this.matrixPreviewTimelinePolicyService.getPreviewRowDurationMinutes as any)(...args);
  }

  private getPreviewRowDurationFromDurationFieldsOnly(...args: any[]): number | null {
    return (this.matrixPreviewTimelinePolicyService.getPreviewRowDurationFromDurationFieldsOnly as any)(...args);
  }

  private getHotspotDurationMinutesFromMasterFirst(...args: any[]): number | null {
    return (this.matrixPreviewTimelinePolicyService.getHotspotDurationMinutesFromMasterFirst as any)(...args);
  }

  private minutesRangeToTimeString(...args: any[]): string {
    return (this.matrixPreviewTimelinePolicyService.minutesRangeToTimeString as any)(...args);
  }

  private minutesRangeToFitPreviewLabel(...args: any[]): string {
    return (this.matrixPreviewTimelinePolicyService.minutesRangeToFitPreviewLabel as any)(...args);
  }

  private normalizeTravelLabelsToNextStop(...args: any[]): any[] {
    return (this.matrixPreviewTimelinePolicyService.normalizeTravelLabelsToNextStop as any)(...args);
  }

  private resolveManualHotspotFocusId(
    requestedHotspotIds: number[],
    routeManualHotspotIds: number[],
    focusHotspotId?: number,
  ): number {
    const normalizedFocus = Number(focusHotspotId || 0);
    if (requestedHotspotIds.includes(normalizedFocus)) {
      return normalizedFocus;
    }

    if (requestedHotspotIds.length > 0) {
      return requestedHotspotIds[requestedHotspotIds.length - 1];
    }

    return routeManualHotspotIds[routeManualHotspotIds.length - 1];
  }

  private decorateScheduledManualHotspots(
    requestedHotspotIds: number[],
    hotspotMasters: any[],
    fullTimeline: any[],
  ) {
    const timelineByHotspot = new Map<number, any>();
    for (const row of fullTimeline || []) {
      if (String(row?.type || '').toLowerCase() !== 'attraction' && Number(row?.item_type || 0) !== 4) continue;
      const hotspotId = Number(row?.locationId || row?.hotspot_ID || 0);
      if (!requestedHotspotIds.includes(hotspotId)) continue;

      const existing = timelineByHotspot.get(hotspotId);
      const currentStart = this.parsePreviewStartMinutes(row?.timeRange);
      const existingStart = this.parsePreviewStartMinutes(existing?.timeRange);
      if (!existing || currentStart < existingStart) {
        timelineByHotspot.set(hotspotId, row);
      }
    }

    return requestedHotspotIds
      .map((hotspotId) => {
        const master = hotspotMasters.find((row: any) => Number(row?.hotspot_ID || 0) === Number(hotspotId));
        const timelineRow = timelineByHotspot.get(Number(hotspotId)) || null;
        if (!timelineRow) return null;

        return {
          id: Number(hotspotId),
          name: String(master?.hotspot_name || timelineRow?.text || `Hotspot #${hotspotId}`),
          visitTime: String(timelineRow?.timeRange || '').trim() || undefined,
        };
      })
      .filter(Boolean);
  }

  private parsePreviewStartMinutes(timeRange: any): number {
    const raw = String(timeRange || '').trim();
    const startPart = this.normalizePreviewTimeText(raw.split('-')[0]?.trim() || raw);
    const match = startPart.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return Number.MAX_SAFE_INTEGER;

    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const ampm = match[3].toUpperCase();
    if (ampm === 'AM' && hour === 12) hour = 0;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    return (hour * 60) + minute;
  }

  private parsePreviewTimeRangeToUtcDates(timeRange: any): { start: Date | null; end: Date | null } {
    const raw = String(timeRange || '').trim();
    if (!raw || !raw.includes('-')) {
      return { start: null, end: null };
    }

    const startPart = this.normalizePreviewTimeText(raw.split('-')[0]?.trim() || '');
    const endPart = this.normalizePreviewTimeText(raw.split('-')[1]?.trim() || '');
    const startMin = this.parsePreviewTimeToMinutes(startPart);
    const endMin = this.parsePreviewTimeToMinutes(endPart);
    if (startMin === null || endMin === null) {
      return { start: null, end: null };
    }

    const normalizedEndMin = endMin < startMin ? endMin + (24 * 60) : endMin;

    return {
      start: this.minutesToUtcTimeDate(startMin),
      end: this.minutesToUtcTimeDate(normalizedEndMin),
    };
  }

  private validateStrictMatrixTimeline(timeline: any[]): {
    passes: boolean;
    reason: string;
    issues: Array<{ index: number; issue: string }>;
  } {
    const rows = Array.isArray(timeline) ? timeline : [];
    const issues: Array<{ index: number; issue: string }> = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const type = String(row?.type || '').toLowerCase();
      if (type !== 'travel') continue;

      const rawRange = String(row?.timeRange || '').trim();
      if (!rawRange || /needs\s+recalculation|needs\s+reschedule/i.test(rawRange)) {
        issues.push({ index, issue: 'travel row has placeholder or missing timeRange' });
        continue;
      }

      const parsed = this.parsePreviewTimeRangeToUtcDates(rawRange);
      const recoveredFromDbTimes =
        !parsed.start || !parsed.end
          ? {
              start: this.parseSegmentStartMinutes(row),
              end: this.parseSegmentEndMinutes(row),
            }
          : null;
      const effectiveParsed = recoveredFromDbTimes && recoveredFromDbTimes.start != null && recoveredFromDbTimes.end != null
        ? {
            start: this.minutesToUtcTimeDate(recoveredFromDbTimes.start),
            end: this.minutesToUtcTimeDate(recoveredFromDbTimes.end),
          }
        : parsed;

      if (!effectiveParsed.start || !effectiveParsed.end) {
        issues.push({ index, issue: 'travel row has unparsable timeRange' });
        continue;
      }

      const parsedDurationMin = Math.round((effectiveParsed.end.getTime() - effectiveParsed.start.getTime()) / 60000);
      if (!Number.isFinite(parsedDurationMin) || parsedDurationMin <= 0) {
        issues.push({ index, issue: 'travel row has non-positive duration' });
        continue;
      }

 // matrixDurationMin is advisory metadata. A valid, positive parsed timeRange
 // is sufficient for strict apply in confirm-phase persistence.
    }

    if (issues.length > 0) {
      return {
        passes: false,
        reason: 'Strict timing mode blocked apply: all travel rows must have exact matrix/OSRM duration (no estimated fallback).',
        issues,
      };
    }

    return {
      passes: true,
      reason: 'Strict timing mode passed.',
      issues: [],
    };
  }

  private normalizeHotspotPriority(value: any): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return 9999;
    return n;
  }

  private async getRouteManualHotspotIds(
    tx: any,
    planId: number,
    routeId: number,
    seedHotspotIds: number[] = [],
  ): Promise<number[]> {
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        hotspot_plan_own_way: 1,
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
      },
    });

    return this.normalizeManualHotspotIds([
      ...seedHotspotIds,
      ...(rows || []).map((row: any) => Number(row?.hotspot_ID || 0)),
    ]);
  }

  private getHotspotCoords(master: any): { lat: number; lng: number } | null {
    const lat = Number(master?.hotspot_latitude);
    const lng = Number(master?.hotspot_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return { lat, lng };
  }

  private distanceBetweenHotspots(masterMap: Map<number, any>, fromHotspotId?: number | null, toHotspotId?: number | null): number {
    const fromId = Number(fromHotspotId || 0);
    const toId = Number(toHotspotId || 0);
    if (!fromId || !toId || fromId === toId) return 0;

    const fromCoords = this.getHotspotCoords(masterMap.get(fromId));
    const toCoords = this.getHotspotCoords(masterMap.get(toId));
    if (!fromCoords || !toCoords) return 0;

    return haversineKm(fromCoords.lat, fromCoords.lng, toCoords.lat, toCoords.lng);
  }

 /**
   * Check if a hotspot is geographically feasible between two others.
   * Uses bearing/cross-product to validate if mid-point lies on or near the path.
   * Returns true if the hotspot is reasonably on the route; false if it's clearly off-route.
 */
  private isHotspotGeographicallyFeasible(
    masterMap: Map<number, any>,
    fromId: number,
    midId: number,
    toId: number,
  ): boolean {
    try {
      const fromCoords = this.getHotspotCoords(masterMap.get(fromId));
      const midCoords = this.getHotspotCoords(masterMap.get(midId));
      const toCoords = this.getHotspotCoords(masterMap.get(toId));

      if (!fromCoords || !midCoords || !toCoords) {
 return true; // Assume feasible if we can't validate
      }

 // Calculate distances
      const d_from_mid = haversineKm(fromCoords.lat, fromCoords.lng, midCoords.lat, midCoords.lng);
      const d_mid_to = haversineKm(midCoords.lat, midCoords.lng, toCoords.lat, toCoords.lng);
      const d_from_to = haversineKm(fromCoords.lat, fromCoords.lng, toCoords.lat, toCoords.lng);

 // If direct distance sum of detour distances, it's roughly on the path (triangle inequality near equality)
 const tolerance = 0.15; // 15% tolerance for deviation
      const sum = d_from_mid + d_mid_to;
      const deviation = (sum - d_from_to) / d_from_to;

 // If deviation is too small (< tolerance), it might be on path
 // If deviation is large, the hotspot is definitely off-route
      if (deviation < tolerance) {
 return true; // Likely on the path or reasonably close
      }

 // Additional check: cross-product test to see if mid is on the correct "side" of the route
 // Using the cross product of vectors (fromto) and (frommid)
      const v1_lat = toCoords.lat - fromCoords.lat;
      const v1_lng = toCoords.lng - fromCoords.lng;
      const v2_lat = midCoords.lat - fromCoords.lat;
      const v2_lng = midCoords.lng - fromCoords.lng;

      const cross = v1_lat * v2_lng - v1_lng * v2_lat;

 // If cross product is very large relative to distances, mid is far off the path
      const crossMagnitude = Math.abs(cross);
      const pathMagnitude = Math.sqrt(v1_lat * v1_lat + v1_lng * v1_lng) * Math.sqrt(v2_lat * v2_lat + v2_lng * v2_lng);

 // Normalize: if cross magnitude > 20% of path magnitude squared, it's off-route
      if (pathMagnitude > 0 && crossMagnitude > 0.2 * pathMagnitude) {
 return false; // Hotspot is off the path
      }

 return true; // Assume feasible
    } catch (error) {
 console.warn('[isHotspotGeographicallyFeasible] Error:', error);
 return true; // Assume feasible on error
    }
  }

  private getManualEffectivePriority(): number {
    return this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY;
  }

  private buildManualInsertionPositions(baseTimeline: any[]): ManualInsertionPosition[] {
    const attractions = [...(baseTimeline || [])]
      .filter((row: any) => {
        const itemType = Number(row?.item_type ?? row?.itemType ?? 0);
        if (itemType > 0) return itemType === 4;
        return Number(row?.hotspotId ?? row?.hotspot_ID ?? 0) > 0;
      })
      .sort((a: any, b: any) => {
        const ao = Number(a?.hotspotOrder ?? a?.hotspot_order ?? 0);
        const bo = Number(b?.hotspotOrder ?? b?.hotspot_order ?? 0);
        if (ao !== bo) return ao - bo;
        const aStart = a?.hotspotStartTime ?? a?.hotspot_start_time;
        const bStart = b?.hotspotStartTime ?? b?.hotspot_start_time;
        const as = aStart ? new Date(aStart).getTime() : Number.MAX_SAFE_INTEGER;
        const bs = bStart ? new Date(bStart).getTime() : Number.MAX_SAFE_INTEGER;
        return as - bs;
      });

    if (attractions.length === 0) {
      return [{ candidateIndex: 0, anchorOrder: 1, positionLabel: 'before-first-attraction' }];
    }

    const out: ManualInsertionPosition[] = [];
    for (let i = 0; i <= attractions.length; i += 1) {
      const anchorOrder = i === 0
        ? Math.max(1, Number(attractions[0]?.hotspotOrder ?? attractions[0]?.hotspot_order ?? 1))
        : Math.max(1, Number(attractions[i - 1]?.hotspotOrder ?? attractions[i - 1]?.hotspot_order ?? i) + 1);

      const positionLabel = i === 0
        ? 'before-first-attraction'
        : (i === attractions.length ? 'before-hotel-drop' : `after-attraction-${i}`);

      out.push({
        candidateIndex: i,
        anchorOrder,
        positionLabel,
      });
    }

    return out;
  }

  private parsePreviewTimeToMinutes(value: any): number | null {
    const raw = this.normalizePreviewTimeText(value);
    if (!raw) return null;
    const twelveHourMatch = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (twelveHourMatch) {
      let hour = Number(twelveHourMatch[1]);
      const minute = Number(twelveHourMatch[2]);
      const ampm = String(twelveHourMatch[3] || '').toUpperCase();
      if (ampm === 'AM' && hour === 12) hour = 0;
      if (ampm === 'PM' && hour !== 12) hour += 12;
      return (hour * 60) + minute;
    }

    const twentyFourHourMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!twentyFourHourMatch) return null;
    const hour = Number(twentyFourHourMatch[1]);
    const minute = Number(twentyFourHourMatch[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return (hour * 60) + minute;
  }

  private normalizePreviewTimeText(value: any): string {
    const raw = String(value || '').trim();
    if (!raw) return '';

    return raw
      .replace(/\s*\+\d+d$/i, '')
      .trim();
  }
  private formatManualDurationMinutes(...args: any[]): string {
    return (this.manualFitRemovalExplanationService.formatManualDurationMinutes as any)(...args);
  }

  private formatMinutesHuman(...args: any[]): string {
    return (this.manualFitRemovalExplanationService.formatMinutesHuman as any)(...args);
  }

  private formatPreviewTravelDuration(...args: any[]): string {
    return (this.manualFitRemovalExplanationService.formatPreviewTravelDuration as any)(...args);
  }

  private parseTimeRangeParts(...args: any[]): { start: string | null; end: string | null } {
    return (this.manualFitRemovalExplanationService.parseTimeRangeParts as any)(...args);
  }

  private extractOpeningTimeFromOperatingHours(...args: any[]): string | null {
    return (this.manualFitRemovalExplanationService.extractOpeningTimeFromOperatingHours as any)(...args);
  }

  private extractClosingTimeFromOperatingHours(...args: any[]): string | null {
    return (this.manualFitRemovalExplanationService.extractClosingTimeFromOperatingHours as any)(...args);
  }

  private isAttractionTimelineRow(...args: any[]): boolean {
    return (this.manualFitRemovalExplanationService.isAttractionTimelineRow as any)(...args);
  }

  private getTimelineRowHotspotId(...args: any[]): number {
    return (this.manualFitRemovalExplanationService.getTimelineRowHotspotId as any)(...args);
  }

  private findAttemptedAttractionRowForHotspot(...args: any[]): any | null {
    return (this.manualFitRemovalExplanationService.findAttemptedAttractionRowForHotspot as any)(...args);
  }

  private getPriorityLabel(...args: any[]): string {
    return (this.manualFitRemovalExplanationService.getPriorityLabel as any)(...args);
  }

  private getRemovedHotspotVisitTime(...args: any[]): string | null {
    return (this.manualFitRemovalExplanationService.getRemovedHotspotVisitTime as any)(...args);
  }

  private getRemovedHotspotOperatingHours(...args: any[]): string | null {
    return (this.manualFitRemovalExplanationService.getRemovedHotspotOperatingHours as any)(...args);
  }

  private enrichRemovedHotspotCandidateWithAttempt(...args: any[]): any {
    return (this.manualFitRemovalExplanationService.enrichRemovedHotspotCandidateWithAttempt as any)(...args);
  }

  private buildRemovedHotspotExplanation(...args: any[]): any {
    return (this.manualFitRemovalExplanationService.buildRemovedHotspotExplanation as any)(...args);
  }

  private detectManualFitTimingRisk(...args: any[]): any {
    return (this.manualFitRemovalExplanationService.detectManualFitTimingRisk as any)(...args);
  }

  private buildRemovedPrioritySummary(...args: any[]): any {
    return (this.manualFitRemovalExplanationService.buildRemovedPrioritySummary as any)(...args);
  }

  private getAuthoritativeManualFitRemovedHotspots(...args: any[]): any[] {
    return (this.manualFitRemovalExplanationService.getAuthoritativeManualFitRemovedHotspots as any)(...args);
  }

  private buildManualFitChangesRequiredDisplay(...args: any[]): any {
    return (this.manualFitRemovalExplanationService.buildManualFitChangesRequiredDisplay as any)(...args);
  }

  private parseSegmentStartMinutes(segment: any): number | null {
    if (segment?.hotspot_start_time) {
      const dt = new Date(segment.hotspot_start_time);
      if (Number.isFinite(dt.getTime())) {
        return (dt.getUTCHours() * 60) + dt.getUTCMinutes();
      }
    }

    const timeRange = String(segment?.timeRange || '');
    const startPart = timeRange.split('-')[0]?.trim() || '';
    return this.parsePreviewTimeToMinutes(startPart);
  }

  private parseSegmentEndMinutes(segment: any): number | null {
    if (segment?.hotspot_end_time) {
      const dt = new Date(segment.hotspot_end_time);
      if (Number.isFinite(dt.getTime())) {
        return (dt.getUTCHours() * 60) + dt.getUTCMinutes();
      }
    }

    const timeRange = String(segment?.timeRange || '');
    const endPart = timeRange.split('-')[1]?.trim() || '';
    return this.parsePreviewTimeToMinutes(endPart);
  }

  private sortTimelineSegmentsForPreview(rows: any[]): any[] {
    return [...(rows || [])].sort((a: any, b: any) => {
      const routeDiff = Number(a?.itinerary_route_ID || 0) - Number(b?.itinerary_route_ID || 0);
      if (routeDiff !== 0) return routeDiff;

      const aStart = this.parseSegmentStartMinutes(a);
      const bStart = this.parseSegmentStartMinutes(b);
      if ((aStart ?? Number.MAX_SAFE_INTEGER) !== (bStart ?? Number.MAX_SAFE_INTEGER)) {
        return (aStart ?? Number.MAX_SAFE_INTEGER) - (bStart ?? Number.MAX_SAFE_INTEGER);
      }

      return Number(a?.hotspot_order || 0) - Number(b?.hotspot_order || 0);
    });
  }

  private calculateInsertionExtraDistance(
    sequence: Array<{ hotspotId: number; isManual: boolean }>,
    manualHotspotIdSet: Set<number>,
    masterMap: Map<number, any>,
  ): number {
    let extraKm = 0;

    for (let i = 0; i < sequence.length; i += 1) {
      const current = sequence[i];
      if (!manualHotspotIdSet.has(Number(current.hotspotId))) continue;

      const prev = i > 0 ? sequence[i - 1] : null;
      const next = i < sequence.length - 1 ? sequence[i + 1] : null;
      if (!prev || !next) continue;

      const dPrevManual = this.distanceBetweenHotspots(masterMap, prev.hotspotId, current.hotspotId);
      const dManualNext = this.distanceBetweenHotspots(masterMap, current.hotspotId, next.hotspotId);
      const dPrevNext = this.distanceBetweenHotspots(masterMap, prev.hotspotId, next.hotspotId);
      const triangleExtra = dPrevManual + dManualNext - dPrevNext;
      if (Number.isFinite(triangleExtra) && triangleExtra > 0) {
        extraKm += triangleExtra;
      }
    }

    return Number(extraKm.toFixed(2));
  }

  private calculateToAndFroPenalty(
    sequence: Array<{ hotspotId: number; isManual: boolean }>,
    masterMap: Map<number, any>,
  ): number {
    let penalty = 0;
    if (sequence.length < 3) return penalty;

    for (let i = 1; i < sequence.length - 1; i += 1) {
      const mid = sequence[i];
      if (!mid.isManual) continue;

      const left = sequence[i - 1];
      const right = sequence[i + 1];
      const direct = this.distanceBetweenHotspots(masterMap, left.hotspotId, right.hotspotId);
      const detour = this.distanceBetweenHotspots(masterMap, left.hotspotId, mid.hotspotId)
        + this.distanceBetweenHotspots(masterMap, mid.hotspotId, right.hotspotId);

      if (direct <= 0) continue;
      if (detour >= (direct * 2.5) && (detour - direct) >= 10) {
        penalty += 1;
      }
    }

    return penalty;
  }

  private calculateWaitingMinutes(timeline: any[]): number {
    const sorted = this.sortTimelineSegmentsForPreview(timeline);
    let total = 0;

    for (const segment of sorted) {
      const isWaiting = String(segment?.type || '').toLowerCase() === 'waiting' || segment?.isSyntheticWaiting === true;
      if (isWaiting) {
        const explicit = Number(segment?.gapMinutes || 0);
        if (Number.isFinite(explicit) && explicit > 0) {
          total += explicit;
          continue;
        }

        const s = this.parseSegmentStartMinutes(segment);
        const e = this.parseSegmentEndMinutes(segment);
        if (s !== null && e !== null && e > s) {
          total += (e - s);
        }
      }
    }

    return total;
  }

  private scoreManualInsertionCandidate(input: {
    waitingMinutes: number;
    extraTravelKm: number;
    totalTravelKm: number;
    toAndFroPenalty: number;
    removedOptionalCount: number;
    topPriorityAffectedCount: number;
    routeEndOverflowMinutes: number;
    openingHourConflictCount: number;
  }): number {
    return (
      (input.waitingMinutes * 20)
      + (input.extraTravelKm * 10)
      + (input.totalTravelKm * 2)
      + (input.toAndFroPenalty * 100)
      + (input.removedOptionalCount * 200)
      + (input.topPriorityAffectedCount * 100000)
      + (input.routeEndOverflowMinutes * 1000)
      + (input.openingHourConflictCount * 5000)
    );
  }

  private chooseBestManualInsertionCandidate(candidates: ManualInsertionCandidateResult[]): ManualInsertionCandidateResult {
    const category = (candidate: ManualInsertionCandidateResult): number => {
      const hasTimingConflict = Number(candidate.openingHourConflictCount || 0) > 0;
      const hasOverflow = Number(candidate.routeEndOverflowMinutes || 0) > 0;
      const protectedConflict = (candidate.topPriorityAffected || []).some((row: any) =>
        Number(row?.priority || 0) <= this.PROTECTED_AUTO_PRIORITY_MAX,
      );
      if (hasTimingConflict || hasOverflow || protectedConflict) return 4;
      if (candidate.success && !candidate.requiresConfirmation && (candidate.removedOptionalHotspots || []).length === 0) return 0;
      if (candidate.success && !candidate.requiresConfirmation) return 1;
      if (candidate.success && candidate.requiresConfirmation) return 2;
      return 3;
    };

    return [...(candidates || [])].sort((a, b) => {
      const ac = category(a);
      const bc = category(b);
      if (ac !== bc) return ac - bc;
      if (a.score !== b.score) return a.score - b.score;
      return a.candidateIndex - b.candidateIndex;
    })[0];
  }

  private explainRejectedCandidate(details: {
    unscheduledCount: number;
    routeEndOverflowMinutes: number;
    openingHourConflictCount: number;
    topPriorityAffectedCount: number;
    allowTopPriorityRemoval: boolean;
  }): string | null {
    if (details.unscheduledCount > 0) {
      return 'Manual hotspot could not be scheduled in this position.';
    }
    if (details.routeEndOverflowMinutes > 0) {
      return 'Route end time overflow for this position.';
    }
    if (details.openingHourConflictCount > 0) {
      return 'Opening-hour conflict for this position.';
    }
    if (details.topPriorityAffectedCount > 0 && !details.allowTopPriorityRemoval) {
      return 'Top-priority hotspots would need replacement for this position.';
    }
    return null;
  }

  private async getRouteTimelineForScoring(
    tx: any,
    planId: number,
    routeId: number,
  ): Promise<any[]> {
    const persistedRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const enriched = await TimelineEnricher.enrich(tx, Number(planId), persistedRows as any[]);
    return this.sortTimelineSegmentsForPreview(
      (enriched || []).filter((row: any) => Number(row?.itinerary_route_ID || 0) === Number(routeId)),
    );
  }

  private calculateRouteEndOverflowMinutes(
    fullTimeline: any[],
    route: any,
    overrideEndTime?: string,
  ): number {
    const routeEndRaw = overrideEndTime
      ? TimeConverter.toTimeString(overrideEndTime)
      : TimeConverter.toTimeString(route?.route_end_time || '00:00:00');
    const routeEndSec = this.hmsToSeconds(routeEndRaw);
    let maxEndSec = 0;

    for (const row of fullTimeline || []) {
      const endMinutes = this.parseSegmentEndMinutes(row);
      if (endMinutes === null) continue;
      const endSec = endMinutes * 60;
      if (endSec > maxEndSec) maxEndSec = endSec;
    }

    if (maxEndSec <= routeEndSec) return 0;
    return Math.ceil((maxEndSec - routeEndSec) / 60);
  }

  private async buildRouteTimelineSnapshotAfterManualConflictInsert(
    tx: any,
    planId: number,
    routeId: number,
  ): Promise<any[]> {
    try {
      return await this.getRouteTimelineForScoring(
        tx,
        Number(planId),
        Number(routeId),
      );
    } catch (error) {
 console.warn('[FitHere][force_conflict_timeline_refresh_failed]', {
        planId,
        routeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async getManualHotspotTimingPolicyInTx(
    tx: any,
    planId: number,
    route: any,
  ): Promise<ManualHotspotTimingPolicy> {
    const routeRows = await (tx as any).dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        route_start_time: true,
        route_end_time: true,
        itinerary_route_date: true,
      },
      orderBy: [
        { itinerary_route_date: 'asc' },
        { itinerary_route_ID: 'asc' },
      ],
    });

    const currentRouteId = Number(route?.itinerary_route_ID || 0);
    const currentIndex = routeRows.findIndex(
      (row: any) => Number(row?.itinerary_route_ID || 0) === currentRouteId,
    );

    const isFirstRoute = currentIndex <= 0;
    const isLastRoute = currentIndex >= 0 && currentIndex === routeRows.length - 1;

    const routeStartTime = TimeConverter.toTimeString(route?.route_start_time || '08:00:00');
    const routeEndTime = TimeConverter.toTimeString(route?.route_end_time || '20:00:00');

    const startTime = isFirstRoute ? routeStartTime : '05:00:00';
    const endTime = isLastRoute ? routeEndTime : '23:00:00';

    return {
      mode: 'MANUAL_HOTSPOT',
      startTime,
      endTime,
      isFirstRoute,
      isLastRoute,
      autoBuildCutoffBypassed: true,
      hotelCheckInCutoff: isLastRoute ? routeEndTime : '23:00:00',
      lastDayDepartureBufferApplied: isLastRoute,
      allowOffRouteWhenTimePermits: true,
      note: isLastRoute
        ? 'Manual hotspot follows last-day departure buffer. Off-route/manual detour is allowed if timing permits.'
        : 'Manual hotspot bypasses auto-build cutoff and can extend the day until 11:00 PM hotel check-in. Off-route/manual detour is allowed if timing permits.',
    };
  }

  private buildDistanceAndToFroLabels(metrics?: {
    totalTravelKm?: number;
    extraTravelKm?: number;
    toAndFroPenalty?: number;
    candidateIndex?: number;
  }) {
    return {
      labels: {
        distance: 'Distance (km)',
        extraDetour: 'Extra Detour (km)',
        toAndFro: 'To & Fro Detour Count',
      },
      values: {
        totalTravelKm: Number(metrics?.totalTravelKm || 0),
        extraTravelKm: Number(metrics?.extraTravelKm || 0),
        toAndFroPenalty: Number(metrics?.toAndFroPenalty || 0),
        candidateIndex: Number(metrics?.candidateIndex || 0),
      },
    };
  }

 // Route-intelligence: hotspot_route_between_map integration
  private routeFitTypeRank(...args: any[]): number {
    return (this.manualFitRoutePolicyService.routeFitTypeRank as any)(...args);
  }

  private routeFitLabel(...args: any[]): string {
    return (this.manualFitRoutePolicyService.routeFitLabel as any)(...args);
  }

  private buildRouteFitDisplayMeta(...args: any[]): any {
    return (this.manualFitRoutePolicyService.buildRouteFitDisplayMeta as any)(...args);
  }

  private isFeasibleFitType(...args: any[]): boolean {
    return (this.manualFitRoutePolicyService.isFeasibleFitType as any)(...args);
  }

  private isUsableMatrixRouteFitType(...args: any[]): boolean {
    return (this.manualFitRoutePolicyService.isUsableMatrixRouteFitType as any)(...args);
  }

  private hasValidManualMatrixSlot(...args: any[]): boolean {
    return (this.manualFitRoutePolicyService.hasValidManualMatrixSlot as any)(...args);
  }

  private isEmptyRouteSchedulerEligible(...args: any[]): boolean {
    return (this.manualFitRoutePolicyService.isEmptyRouteSchedulerEligible as any)(...args);
  }

  private buildMissingMatrixBuildSuggestion(...args: any[]): any {
    return (this.manualFitRoutePolicyService.buildMissingMatrixBuildSuggestion as any)(...args);
  }

  private normalizeLocationText(...args: any[]): string {
    return (this.manualFitRoutePolicyService.normalizeLocationText as any)(...args);
  }

  private deriveLooseCityKey(...args: any[]): string {
    return (this.manualFitRoutePolicyService.deriveLooseCityKey as any)(...args);
  }

  private classifyManualHotspotCityContext(...args: any[]): ManualHotspotCityContext {
    return (this.manualFitRoutePolicyService.classifyManualHotspotCityContext as any)(...args);
  }

  private classifyManualRouteAttractionCityContext(...args: any[]): ManualHotspotCityContext {
    return (this.manualFitRoutePolicyService.classifyManualRouteAttractionCityContext as any)(...args);
  }

  private parseRouteCoordinates(...args: any[]) {
    return (this.manualFitGeometryService.parseRouteCoordinates as any)(...args);
  }

  private async getOsrmRouteGeometry(...args: any[]) {
    return (this.manualFitGeometryService.getOsrmRouteGeometry as any)(...args);
  }

  private async resolveSelectedHotelEndpoint(...args: any[]) {
    return (this.manualFitGeometryService.resolveSelectedHotelEndpoint as any)(...args);
  }

  private async resolveRouteDestinationCityEndpoint(...args: any[]) {
    return (this.manualFitGeometryService.resolveRouteDestinationCityEndpoint as any)(...args);
  }

  private async resolveHotelEndpointByLooseName(...args: any[]) {
    return (this.manualFitGeometryService.resolveHotelEndpointByLooseName as any)(...args);
  }

  private async resolveHotspotToHotelLeg(...args: any[]) {
    return (this.manualFitGeometryService.resolveHotspotToHotelLeg as any)(...args);
  }

  private findNearestProgressOnRoute(...args: any[]) {
    return (this.manualFitGeometryService.findNearestProgressOnRoute as any)(...args);
  }

  private haversineKmForRouteProjection(...args: any[]) {
    return (this.manualFitGeometryService.haversineKmForRouteProjection as any)(...args);
  }
  private getSavedRuleTravelLocationType(...args: any[]): 1 | 2 {
    return (this.manualFitTravelReplicaService.getSavedRuleTravelLocationType as any)(...args);
  }

  private getPrimaryTravelLocationLabel(...args: any[]): string {
    return (this.manualFitTravelReplicaService.getPrimaryTravelLocationLabel as any)(...args);
  }

  private hmsToMinutes(...args: any[]): number {
    return (this.manualFitTravelReplicaService.hmsToMinutes as any)(...args);
  }

  private resolveHotspotPreviewEndpoint(...args: any[]): any {
    return (this.manualFitTravelReplicaService.resolveHotspotPreviewEndpoint as any)(...args);
  }

  private resolveSavedRuleTravelLeg(...args: any[]): any {
    return (this.manualFitTravelReplicaService.resolveSavedRuleTravelLeg as any)(...args);
  }

  private resolveSavedRuleSourceToHotspotLeg(...args: any[]): any {
    return (this.manualFitTravelReplicaService.resolveSavedRuleSourceToHotspotLeg as any)(...args);
  }

  private resolveSavedRuleHotspotToHotspotLeg(...args: any[]): any {
    return (this.manualFitTravelReplicaService.resolveSavedRuleHotspotToHotspotLeg as any)(...args);
  }

  private resolveSavedRuleHotspotToRouteHotelLeg(...args: any[]): any {
    return (this.manualFitTravelReplicaService.resolveSavedRuleHotspotToRouteHotelLeg as any)(...args);
  }
  private extractPreviewCheckinHotelName(...args: any[]): string {
    return (this.manualFitTravelReplicaService.extractPreviewCheckinHotelName as any)(...args);
  }

  private normalizeManualFitTravelReplicaLabel(...args: any[]): string {
    return (this.manualFitTravelReplicaService.normalizeManualFitTravelReplicaLabel as any)(...args);
  }

  private parseManualFitTravelReplicaDistanceKm(...args: any[]): number | null {
    return (this.manualFitTravelReplicaService.parseManualFitTravelReplicaDistanceKm as any)(...args);
  }

  private getManualFitTravelReplicaDurationMinutes(...args: any[]): number | null {
    return (this.manualFitTravelReplicaService.getManualFitTravelReplicaDurationMinutes as any)(...args);
  }

  private buildManualFitMainTimelineTravelReplicaMap(...args: any[]): Map<string, any> {
    return (this.manualFitTravelReplicaService.buildManualFitMainTimelineTravelReplicaMap as any)(...args);
  }

  private findManualFitMainTimelineTravelReplica(...args: any[]): any {
    return (this.manualFitTravelReplicaService.findManualFitMainTimelineTravelReplica as any)(...args);
  }

  private async resolveRouteSourceEndpoint(...args: any[]) {
    return (this.manualFitTravelReplicaService.resolveRouteSourceEndpoint as any)(...args);
  }

  private async resolveSourceToHotspotLeg(...args: any[]) {
    return (this.manualFitTravelReplicaService.resolveSourceToHotspotLeg as any)(...args);
  }

  private async ensureHotspotHotelBetweenMapTable(...args: any[]) {
    return (this.manualFitTravelReplicaService.ensureHotspotHotelBetweenMapTable as any)(...args);
  }

  private async getOsrmDistanceKm(...args: any[]) {
    return (this.manualFitTravelReplicaService.getOsrmDistanceKm as any)(...args);
  }
  private distancePointToRouteMeters(...args: any[]): number {
    return (this.manualFitRouteMatrixPersistenceService.distancePointToRouteMeters as any)(...args);
  }

  private projectPointProgressOnRoute(...args: any[]): number {
    return (this.manualFitRouteMatrixPersistenceService.projectPointProgressOnRoute as any)(...args);
  }

  private ensureHotspotPlace(...args: any[]): number | null {
    return (this.manualFitRouteMatrixPersistenceService.ensureHotspotPlace as any)(...args);
  }

  private ensureRouteBetweenMapRow(...args: any[]): any {
    return (this.manualFitRouteMatrixPersistenceService.ensureRouteBetweenMapRow as any)(...args);
  }

  private getRouteBetweenRejectionRow(...args: any[]): any {
    return (this.manualFitRouteMatrixPersistenceService.getRouteBetweenRejectionRow as any)(...args);
  }

  private findLastSourceCityHotspotOnOsrmRoute(...args: any[]): any {
    return (this.manualFitRouteMatrixPersistenceService.findLastSourceCityHotspotOnOsrmRoute as any)(...args);
  }

  private async getDoneMatrixRouteCoordinatesEitherDirection(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
  ): Promise<{
    routeCoordinates: [number, number][];
    distanceKm: number | null;
    durationMin: number | null;
    usedReverse: boolean;
    osrmFallbackUsed?: boolean;
    osrmFailed?: boolean;
  } | null> {
    const fromId = Number(fromHotspotId || 0);
    const toId = Number(toHotspotId || 0);
    if (!fromId || !toId || fromId === toId) return null;

    const leg = await this.resolveOsrmLegBetweenHotspots(tx, fromId, toId, true);
    if (!leg || leg.osrmFailed || !Array.isArray(leg.coordinates) || leg.coordinates.length < 2) {
      return {
        routeCoordinates: [],
        distanceKm: null,
        durationMin: null,
        usedReverse: false,
        osrmFallbackUsed: true,
        osrmFailed: true,
      };
    }

    return {
      routeCoordinates: leg.coordinates,
      distanceKm: leg.distanceKm,
      durationMin: leg.durationMin,
      usedReverse: leg.usedReverse,
      osrmFallbackUsed: true,
      osrmFailed: false,
    };
  }

  private async findLastSameLocationHotspotOnRoute(
    tx: any,
    params: {
      sourceLocation: string;
      fromHotspotId: number;
      toHotspotId: number;
      excludeHotspotIds?: number[];
    },
  ): Promise<{
    hotspotId: number;
    hotspotName: string;
    hotspotLocation: string;
    distanceFromRouteMeters: number;
    progressRatio: number;
  } | null> {
    const sourceLocation = this.normalizeLocationText(params?.sourceLocation || '');
    const fromHotspotId = Number(params?.fromHotspotId || 0);
    const toHotspotId = Number(params?.toHotspotId || 0);
    if (!sourceLocation || !fromHotspotId || !toHotspotId || fromHotspotId === toHotspotId) {
      return null;
    }

    const routeData = await this.getDoneMatrixRouteCoordinatesEitherDirection(tx, fromHotspotId, toHotspotId);
    if (routeData?.osrmFallbackUsed) {
 console.log('[SourceCityExitAnchor] osrm_fallback_used', {
        fromHotspotId,
        toHotspotId,
      });
    }
    if (!routeData || routeData.osrmFailed || routeData.routeCoordinates.length < 2) {
      if (routeData?.osrmFallbackUsed) {
 console.warn('[SourceCityExitAnchor] osrm_failed', {
          fromHotspotId,
          toHotspotId,
        });
      }
      return null;
    }

    const excludeIds = new Set<number>(
      [fromHotspotId, toHotspotId, ...((params?.excludeHotspotIds || []).map((id) => Number(id || 0)))].filter((id) => id > 0),
    );

    const rows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        hotspot_ID,
        hotspot_name,
        hotspot_location,
        hotspot_latitude,
        hotspot_longitude
      FROM dvi_hotspot_place
      WHERE deleted = 0
        AND hotspot_location LIKE ?
      `,
      `%${sourceLocation}%`,
    );

    const maxRouteMeters = Number(process.env.SOURCE_CITY_EXIT_MAX_ROUTE_METERS || 3000);

    const candidates = (rows || []).map((row: any) => {
      const hotspotId = Number(row?.hotspot_ID || 0);
      const lat = Number(row?.hotspot_latitude);
      const lng = Number(row?.hotspot_longitude);
      if (!hotspotId || excludeIds.has(hotspotId) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const nearest = this.findNearestProgressOnRoute(
        { lat, lng },
        routeData.routeCoordinates,
      );

      return {
        hotspotId,
        hotspotName: String(row?.hotspot_name || `Hotspot #${hotspotId}`),
        hotspotLocation: String(row?.hotspot_location || ''),
        distanceFromRouteMeters: Number(nearest.distanceMeters),
        progressRatio: Number(nearest.progressRatio),
      };
    }).filter((row: any) => row != null)
      .filter((row: any) => row.distanceFromRouteMeters <= maxRouteMeters)
      .filter((row: any) => row.progressRatio > 0.02 && row.progressRatio < 0.95)
      .sort((a: any, b: any) => {
        if (b.progressRatio !== a.progressRatio) return b.progressRatio - a.progressRatio;
        return a.distanceFromRouteMeters - b.distanceFromRouteMeters;
      });

    return candidates.length > 0 ? candidates[0] : null;
  }

  private resolveSelectedManualPriority(params: {
    selectedHotspotId: number;
    manualInsertionFit?: any;
    options?: any;
    selectedMaster?: any;
    focusMaster?: any;
  }): number {
    return (this.manualFitValidationService.resolveSelectedManualPriority as any)(params);
  }

 /**
   * Build the manualInsertionFit block by querying hotspot_route_between_map
   * for every existing hotspot-to-hotspot slot in the route.
 */
 //

  private buildManualSlotInsights(...args: any[]): any[] {
    return (this.manualFitValidationService.buildManualSlotInsights as any)(...args);
  }

  private enrichManualFitPreviewTimelineWithOperatingHours(...args: any[]): Promise<any[]> {
    return (this.manualFitOperatingHoursService.enrichManualFitPreviewTimelineWithOperatingHours as any)(...args);
  }

  private normalizeManualFitTimeText(...args: any[]): string {
    return (this.manualFitOperatingHoursService.normalizeManualFitTimeText as any)(...args);
  }

  private extractTimeWindowsFromLabel(...args: any[]): Array<{ start: string; end: string }> {
    return (this.manualFitOperatingHoursService.extractTimeWindowsFromLabel as any)(...args);
  }

  private evaluateTimelineRowAgainstOperatingHours(...args: any[]): any {
    return (this.manualFitOperatingHoursService.evaluateTimelineRowAgainstOperatingHours as any)(...args);
  }

  private adjustManualFitVisitStartToOperatingWindow(...args: any[]): any {
    return (this.manualFitOperatingHoursService.adjustManualFitVisitStartToOperatingWindow as any)(...args);
  }

  private getSelectedManualClosingOverflow(...args: any[]): any {
    return (this.manualFitOperatingHoursService.getSelectedManualClosingOverflow as any)(...args);
  }

  private markSelectedManualOperatingHourConflicts(...args: any[]): any {
    return (this.manualFitOperatingHoursService.markSelectedManualOperatingHourConflicts as any)(...args);
  }

  private buildManualHotspotValidation(...args: any[]): any {
    return (this.manualFitValidationService.buildManualHotspotValidation as any)(...args);
  }


  private calculateTravelMetricsFromTimeline(...args: any[]): any {
    return (this.manualFitScheduleAttemptService.calculateTravelMetricsFromTimeline as any)(...args);
  }

  private detectTopPriorityImpact(...args: any[]): any[] {
    return (this.manualFitScheduleAttemptService.detectTopPriorityImpact as any)(...args);
  }

  private buildManualScheduleAttemptFromCandidate(...args: any[]): any {
    return (this.manualFitScheduleAttemptService.buildManualScheduleAttemptFromCandidate as any)(...args);
  }

  private buildExactAnchorSequentialScheduleAttempt(...args: any[]): any {
    return (this.manualFitScheduleAttemptService.buildExactAnchorSequentialScheduleAttempt as any)(...args);
  }

  private async simulateManualClusterOrder(...args: any[]): Promise<any> {
    return (this.manualFitScheduleAttemptService.simulateManualClusterOrder as any)(...args);
  }

  private compareManualScheduleAttempts(...args: any[]): number {
    return (this.manualFitScheduleAttemptService.compareManualScheduleAttempts as any)(...args);
  }

  private async simulateManualInsertionAtPosition(...args: any[]): Promise<any> {
    return (this.manualFitCandidateSimulationService.simulateManualInsertionAtPosition as any)(...args);
  }


  private async findBestManualInsertionCandidate(...args: any[]): Promise<any> {
    return (this.manualFitCandidateSearchService.findBestManualInsertionCandidate as any)(...args);
  }

  private async runManualClusterOptimizer(...args: any[]): Promise<any> {
    return (this.manualFitCandidateSearchService.runManualClusterOptimizer as any)(...args);
  }


  private scoreManualInsertion(
    sequence: Array<{ hotspotId: number }>,
    insertIndex: number,
    candidateHotspotId: number,
    masterMap: Map<number, any>,
    preferredOrder?: number | null,
  ): number {
    const previous = insertIndex > 0 ? sequence[insertIndex - 1] : null;
    const next = insertIndex < sequence.length ? sequence[insertIndex] : null;

    const prevToManual = this.distanceBetweenHotspots(masterMap, previous?.hotspotId, candidateHotspotId);
    const manualToNext = this.distanceBetweenHotspots(masterMap, candidateHotspotId, next?.hotspotId);
    const prevToNext = this.distanceBetweenHotspots(masterMap, previous?.hotspotId, next?.hotspotId);
    const extraDistance = prevToManual + manualToNext - prevToNext;

    const anchorPenalty = preferredOrder && preferredOrder > 0
      ? Math.abs((insertIndex + 1) - Number(preferredOrder)) * 0.25
      : 0;

    return extraDistance + anchorPenalty;
  }

  private async assignManualHotspotPreferredOrders(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
    anchor?: {
      anchorType?: 'after_travel';
      anchorIndex?: number;
    },
  ): Promise<void> {
    const normalizedManualHotspotIds = this.normalizeManualHotspotIds(manualHotspotIds);
    if (normalizedManualHotspotIds.length === 0) return;

    const routeRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_plan_own_way: true,
        hotspot_order: true,
        hotspot_start_time: true,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const hotspotMasterIds = this.normalizeManualHotspotIds([
      ...normalizedManualHotspotIds,
      ...(routeRows || []).map((row: any) => Number(row?.hotspot_ID || 0)),
    ]);
    const hotspotMasters = hotspotMasterIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotMasterIds } },
            select: {
              hotspot_ID: true,
              hotspot_name: true,
              hotspot_priority: true,
              hotspot_latitude: true,
              hotspot_longitude: true,
              hotspot_location: true,
              hotspot_duration: true,
            },
    })
      : [];
    const masterMap = new Map<number, any>(
      hotspotMasters.map((row: any) => [Number(row?.hotspot_ID || 0), row]),
    );

    const baseSequence = (routeRows || [])
      .filter((row: any) => Number(row?.hotspot_plan_own_way || 0) !== 1)
      .map((row: any) => ({ hotspotId: Number(row?.hotspot_ID || 0) }))
      .filter((row: any) => Number(row?.hotspotId || 0) > 0);

    const pendingSequence = normalizedManualHotspotIds.map((hotspotId) => ({ hotspotId }));
    const workingSequence = [...baseSequence];
    const preferredOrder =
      anchor?.anchorType === 'after_travel' && Number.isInteger(Number(anchor?.anchorIndex))
        ? Number(anchor?.anchorIndex) + 1
        : null;

    while (pendingSequence.length > 0) {
      let bestCandidate: { hotspotId: number; insertIndex: number; score: number } | null = null;

      for (const pending of pendingSequence) {
        for (let insertIndex = 0; insertIndex <= workingSequence.length; insertIndex += 1) {
          const score = this.scoreManualInsertion(
            workingSequence,
            insertIndex,
            Number(pending.hotspotId),
            masterMap,
            preferredOrder,
          );

          if (!bestCandidate || score < bestCandidate.score) {
            bestCandidate = {
              hotspotId: Number(pending.hotspotId),
              insertIndex,
              score,
            };
          }
        }
      }

      if (!bestCandidate) break;

      const nextIndex = pendingSequence.findIndex((row) => Number(row.hotspotId) === Number(bestCandidate!.hotspotId));
      if (nextIndex >= 0) {
        pendingSequence.splice(nextIndex, 1);
      }
      workingSequence.splice(bestCandidate.insertIndex, 0, { hotspotId: bestCandidate.hotspotId });
    }

    const manualOrderMap = new Map<number, number>();
    workingSequence.forEach((row, index) => {
      if (normalizedManualHotspotIds.includes(Number(row.hotspotId))) {
        manualOrderMap.set(Number(row.hotspotId), index + 1);
      }
    });

    for (const hotspotId of normalizedManualHotspotIds) {
      const assignedOrder = Number(manualOrderMap.get(Number(hotspotId)) || 0);
      if (!assignedOrder) continue;

      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: {
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          hotspot_ID: Number(hotspotId),
          item_type: 4,
          hotspot_plan_own_way: 1,
          deleted: 0,
        },
        data: {
          hotspot_order: assignedOrder,
          updatedon: new Date(),
        },
      });
    }
  }

  private async rebuildManualHotspotSet(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
    anchor?: {
      anchorType?: 'after_travel';
      anchorIndex?: number;
    },
    rebuildOptions?: {
      preferredManualPlacementByRoute?: Record<number, {
        hotspotOrder?: number;
        hotspotStartTime?: Date | string | null;
        hotspotEndTime?: Date | string | null;
        replacedHotspotId?: number;
      }>;
      preferredHotspotOrder?: number[];
 /** When true, restricts delete+rebuild to this route only and skips parking. */
      previewOnly?: boolean;
    },
  ) {
    if (Array.isArray(rebuildOptions?.preferredHotspotOrder) && rebuildOptions.preferredHotspotOrder.length > 1) {
      const preferredOrder = rebuildOptions.preferredHotspotOrder
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0);

      if (preferredOrder.length > 1) {
        const existingRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: Number(planId),
            itinerary_route_ID: Number(routeId),
            item_type: 4,
            deleted: 0,
          },
          select: {
            hotspot_ID: true,
            hotspot_order: true,
            route_hotspot_ID: true,
          },
          orderBy: [
            { hotspot_order: 'asc' },
            { route_hotspot_ID: 'asc' },
          ],
        });

        const orderedIds = [
          ...preferredOrder,
          ...(existingRows || [])
            .map((row: any) => Number(row?.hotspot_ID || 0))
            .filter((id: number) => id > 0 && !preferredOrder.includes(id)),
        ];

        if (orderedIds.length > 0) {
          const orderRows = orderedIds.map((hotspotId, index) => Prisma.sql`
            SELECT ${Number(hotspotId)} AS hotspot_ID, ${index + 1} AS new_order
          `);

          await (tx as any).$executeRaw(Prisma.sql`
            UPDATE dvi_itinerary_route_hotspot_details AS h
            INNER JOIN (
              ${Prisma.join(orderRows, ' UNION ALL ')}
            ) AS ord ON ord.hotspot_ID = h.hotspot_ID
            SET
              h.hotspot_order = ord.new_order,
              h.updatedon = ${new Date()}
            WHERE h.itinerary_plan_ID = ${Number(planId)}
              AND h.itinerary_route_ID = ${Number(routeId)}
              AND h.item_type = 4
              AND h.deleted = 0
          `);
        }
      }
    }

    await this.assignManualHotspotPreferredOrders(tx, Number(planId), Number(routeId), manualHotspotIds, anchor);

    const preferredOrder =
      anchor?.anchorType === 'after_travel' && Number.isInteger(Number(anchor?.anchorIndex))
        ? Number(anchor?.anchorIndex) + 1
        : null;

    return this.hotspotEngine.rebuildRouteHotspots(tx, Number(planId), undefined, {
      protectedHotspotIds: manualHotspotIds,
      anchorOrderByRoute: preferredOrder !== null
        ? { [Number(routeId)]: Number(preferredOrder) }
        : undefined,
      preferredManualPlacementByRoute: rebuildOptions?.preferredManualPlacementByRoute,
      scopeToRouteId: rebuildOptions?.previewOnly === true ? Number(routeId) : undefined,
      skipParking: rebuildOptions?.previewOnly === true,
    });
  }

  private async getManualHotspotScheduleState(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
    masterMap: Map<number, any>,
    fallbackReason?: string,
  ) {
    const scheduledHotspotIds: number[] = [];
    const unscheduledManualHotspots: Array<{ id: number; name: string; reason: string }> = [];

    for (const hotspotId of manualHotspotIds) {
      const isScheduled = await this.isManualHotspotScheduled(tx, Number(planId), Number(routeId), Number(hotspotId));
      if (isScheduled) {
        scheduledHotspotIds.push(Number(hotspotId));
        continue;
      }

      const master = masterMap.get(Number(hotspotId));
      unscheduledManualHotspots.push({
        id: Number(hotspotId),
        name: String(master?.hotspot_name || `Hotspot #${hotspotId}`),
        reason: fallbackReason || 'Could not fit within opening hours and route time window.',
      });
    }

    return {
      scheduledHotspotIds,
      unscheduledManualHotspots,
      allScheduled: unscheduledManualHotspots.length === 0,
    };
  }

  private mapOptionalRemovalPriority(priority: number): number {
    const normalized = this.normalizeHotspotPriority(priority);

    if (normalized === 9999) return 0;
    if (normalized >= 5) return 1;
    if (normalized === this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY) return 2;
    return 99;
  }

  private parseManualHotspotLatestClosingMinute(timings: unknown): number {
    const raw = String(timings || '').trim();
    if (!raw) return 24 * 60;
    if (/open\s*24/i.test(raw)) return 24 * 60;

    const toMinutes = (value: string): number | null => {
      return this.parsePreviewTimeToMinutes(String(value || '').trim());
    };

    const closingMinutes: number[] = [];
    for (const part of raw.split(',')) {
      const pieces = part.split('-');
      if (pieces.length < 2) continue;

      const close = toMinutes(pieces[1]);
      if (close !== null) closingMinutes.push(close);
    }

    return closingMinutes.length > 0 ? Math.max(...closingMinutes) : 24 * 60;
  }

  private buildSameCityManualShuffleOrder(params: {
    hotspots: any[];
    manualHotspotIds: number[];
  }): number[] {
    const manualIds = new Set(
      (params.manualHotspotIds || []).map(Number).filter((id) => id > 0),
    );

    const rows = (params.hotspots || [])
      .filter((row: any) => Number(row?.hotspotId || 0) > 0)
      .map((row: any) => ({
        ...row,
        isManualCandidate: manualIds.has(Number(row.hotspotId || 0)),
        effectivePriority: this.getEffectivePriorityForManualInsertion(row),
        closingMinute: this.parseManualHotspotLatestClosingMinute(row?.timings),
      }));

    if (rows.length <= 1) return [];

    rows.sort((a: any, b: any) => {
      if (a.isManualCandidate !== b.isManualCandidate) {
        return a.isManualCandidate ? -1 : 1;
      }

      if (a.closingMinute !== b.closingMinute) {
        return a.closingMinute - b.closingMinute;
      }

      if (a.effectivePriority !== b.effectivePriority) {
        return a.effectivePriority - b.effectivePriority;
      }

      return Number(a.startTs || 0) - Number(b.startTs || 0);
    });

    return rows.map((row: any) => Number(row.hotspotId)).filter((id: number) => id > 0);
  }

  private buildManualClusterCityKey(row: any): string {
    const raw = String(
      row?.cityKey
      || row?.hotspotLocation
      || row?.hotspotToLocation
      || row?.location
      || row?.name
      || '',
    ).trim();
    if (!raw) return '';
    const firstPart = raw.split(',')[0]?.trim() || raw;
    return normalizeCityName(firstPart).toLowerCase();
  }

  private buildManualHotspotDestinationCluster(params: {
    hotspots: any[];
    manualHotspotIds: number[];
  }): {
    clusterKey: string;
    baseOrder: number[];
    clusterHotspots: ManualClusterPoint[];
    nonClusterHotspots: ManualClusterPoint[];
    manualPoint: ManualClusterPoint | null;
  } {
    const manualIds = new Set((params.manualHotspotIds || []).map(Number).filter((id) => id > 0));
    const points: ManualClusterPoint[] = (params.hotspots || [])
      .filter((row: any) => Number(row?.hotspotId || 0) > 0)
      .sort((a: any, b: any) => Number(a?.hotspotOrder || 0) - Number(b?.hotspotOrder || 0))
      .map((row: any) => ({
        hotspotId: Number(row?.hotspotId || 0),
        routeHotspotId: Number(row?.routeHotspotId || 0),
        name: String(row?.name || `Hotspot #${row?.hotspotId || 0}`),
        hotspotOrder: Number(row?.hotspotOrder || 0),
        effectivePriority: Number(row?.effectivePriority || row?.priority || 9999),
        rawPriority: Number(row?.rawPriority || row?.priority || 9999),
        isManual: manualIds.has(Number(row?.hotspotId || 0)) || row?.isManual === true,
        timings: String(row?.timings || ''),
        closingMinute: this.parseManualHotspotLatestClosingMinute(row?.timings),
        startTs: Number(row?.startTs || 0),
        durationMinutes: Number(row?.durationMinutes || 0),
        cityKey: this.buildManualClusterCityKey(row),
        lat: Number.isFinite(Number(row?.lat ?? row?.hotspot_latitude)) ? Number(row?.lat ?? row?.hotspot_latitude) : null,
        lng: Number.isFinite(Number(row?.lng ?? row?.hotspot_longitude)) ? Number(row?.lng ?? row?.hotspot_longitude) : null,
      }))
      .filter((row: ManualClusterPoint) => row.hotspotId > 0);

    const manualPoint = points.find((row) => row.isManual) || null;
    const clusterKey = manualPoint?.cityKey || points.find((row) => row.cityKey)?.cityKey || '';
    const clusterHotspots = points.filter((row) => (
      row.isManual
      || !clusterKey
      || row.cityKey === clusterKey
    ));
    const clusterIdSet = new Set(clusterHotspots.map((row) => Number(row.hotspotId)));

    return {
      clusterKey,
      baseOrder: points.map((row) => Number(row.hotspotId)),
      clusterHotspots,
      nonClusterHotspots: points.filter((row) => !clusterIdSet.has(Number(row.hotspotId))),
      manualPoint,
    };
  }

  private buildManualClusterOrderFromClusterPoints(
    baseOrder: number[],
    clusterPoints: ManualClusterPoint[],
    orderedClusterIds: number[],
  ): number[] {
    const clusterIdSet = new Set(clusterPoints.map((row) => Number(row.hotspotId)));
    const seen = new Set<number>();
    const output: number[] = [];
    let inserted = false;

    for (const hotspotId of baseOrder) {
      if (!clusterIdSet.has(Number(hotspotId))) {
        output.push(Number(hotspotId));
        continue;
      }

      if (!inserted) {
        for (const orderedId of orderedClusterIds) {
          if (!seen.has(Number(orderedId))) {
            output.push(Number(orderedId));
            seen.add(Number(orderedId));
          }
        }
        inserted = true;
      }
    }

    if (!inserted) {
      for (const orderedId of orderedClusterIds) {
        if (!seen.has(Number(orderedId))) {
          output.push(Number(orderedId));
          seen.add(Number(orderedId));
        }
      }
    }

    return output.filter((id) => Number.isFinite(Number(id)) && Number(id) > 0);
  }

  private buildManualClusterCandidateOrders(params: {
    hotspots: any[];
    manualHotspotIds: number[];
    anchorIndex?: number;
    anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
    afterHotspotId?: number;
    allowP3Removal?: boolean;
    allowTopPriorityRemoval?: boolean;
    exactAnchorMode?: boolean;
    masterMap: Map<number, any>;
  }): ManualCandidateOrder[] {
 // See docs/manual-hotspot-reorder-and-removal-rules.md before changing exact-anchor Fit Here logic.
    const cluster = this.buildManualHotspotDestinationCluster({
      hotspots: params.hotspots,
      manualHotspotIds: params.manualHotspotIds,
    });
    const manualId = Number(cluster.manualPoint?.hotspotId || params.manualHotspotIds?.[0] || 0);
    const currentCluster = cluster.clusterHotspots
 // Preserve every already-active manual hotspot in the cluster.
 // The only hotspot we may need to re-position here is the selected manual hotspot itself.
      .filter((row) => Number(row.hotspotId) !== manualId)
      .sort((a, b) => Number(a.hotspotOrder) - Number(b.hotspotOrder));
    const clusterWithManual = [...currentCluster];

    const exactAnchorAfterHotspotId = Number(params.afterHotspotId || 0);
    const anchorAfterIndex = (() => {
      if (params.exactAnchorMode === true) {
        if (String(params.anchorIntent || '').toUpperCase() === 'AFTER_START') {
          return 0;
        }

        if (exactAnchorAfterHotspotId > 0) {
          const exactAnchorClusterIndex = currentCluster.findIndex(
            (row) => Number(row.hotspotId || 0) === exactAnchorAfterHotspotId,
          );
          if (exactAnchorClusterIndex >= 0) {
            return exactAnchorClusterIndex + 1;
          }
        }
      }

      return Math.max(0, Number(params.anchorIndex || 0));
    })();
    const anchorBeforeIndex = Math.max(0, anchorAfterIndex - 1);

    const insertManualAt = (rows: ManualClusterPoint[], index: number): number[] => {
      const withoutManual = rows.filter((row) => Number(row.hotspotId) !== manualId).map((row) => Number(row.hotspotId));
      const safeIndex = Math.max(0, Math.min(Number(index), withoutManual.length));
      withoutManual.splice(safeIndex, 0, manualId);
      return withoutManual.filter((id) => id > 0);
    };
    const exactAnchorBeforeHotspotId = (() => {
      const routeWithoutManual = cluster.baseOrder
        .map(Number)
        .filter((id) => id > 0 && id !== manualId);

      if (String(params.anchorIntent || '').toUpperCase() === 'AFTER_START') {
        return Number(routeWithoutManual[0] || 0) || 0;
      }

      if (exactAnchorAfterHotspotId > 0) {
        const afterIndex = routeWithoutManual.findIndex((id) => id === exactAnchorAfterHotspotId);
        if (afterIndex >= 0) {
          return Number(routeWithoutManual[afterIndex + 1] || 0) || 0;
        }
      }

      const safeIndex = Math.max(0, Math.min(anchorAfterIndex, routeWithoutManual.length));
      return Number(routeWithoutManual[safeIndex] || 0) || 0;
    })();
    const buildExactAnchorPinnedOrder = (orderedIds: number[]): number[] => {
      const routeWithoutManual = cluster.baseOrder
        .map(Number)
        .filter((id) => id > 0 && id !== manualId);

      if (!(manualId > 0)) {
        return routeWithoutManual;
      }

      if (String(params.anchorIntent || '').toUpperCase() === 'AFTER_START') {
        const seen = new Set<number>([manualId]);
        const suffix = orderedIds
          .map(Number)
          .filter((id) => id > 0 && id !== manualId && routeWithoutManual.includes(id) && !seen.has(id));
        for (const id of routeWithoutManual) {
          if (!seen.has(id) && !suffix.includes(id)) {
            suffix.push(id);
          }
        }
        return [manualId, ...suffix];
      }

      let anchorPrefix: number[] = [];
      if (exactAnchorAfterHotspotId > 0) {
        const afterIndex = routeWithoutManual.findIndex((id) => id === exactAnchorAfterHotspotId);
        if (afterIndex >= 0) {
          anchorPrefix = routeWithoutManual.slice(0, afterIndex + 1);
        }
      }

      if (anchorPrefix.length === 0) {
        const safeIndex = Math.max(0, Math.min(anchorAfterIndex, routeWithoutManual.length));
        anchorPrefix = routeWithoutManual.slice(0, safeIndex);
      }

      const suffixBase = routeWithoutManual.filter((id) => !anchorPrefix.includes(id));
      const seen = new Set<number>([...anchorPrefix, manualId]);
      const orderedSuffix: number[] = [];

      for (const id of orderedIds.map(Number)) {
        if (id > 0 && suffixBase.includes(id) && !seen.has(id)) {
          orderedSuffix.push(id);
          seen.add(id);
        }
      }

      for (const id of suffixBase) {
        if (!seen.has(id)) {
          orderedSuffix.push(id);
          seen.add(id);
        }
      }

      return [...anchorPrefix, manualId, ...orderedSuffix];
    };

    const geoNearestIds = (() => {
      const points = clusterWithManual.filter((row) => Number(row.hotspotId) > 0);
      if (points.length <= 1) return points.map((row) => Number(row.hotspotId));
      const start = currentCluster[0] || cluster.manualPoint || points[0];
      const remaining = [...points].filter((row) => Number(row.hotspotId) !== Number(start?.hotspotId));
      const ordered = [Number(start?.hotspotId || 0)].filter((id) => id > 0);
      let cursor = start;
      while (remaining.length > 0) {
        remaining.sort((a, b) => (
          this.distanceBetweenHotspots(params.masterMap, Number(cursor?.hotspotId || 0), Number(a.hotspotId))
          - this.distanceBetweenHotspots(params.masterMap, Number(cursor?.hotspotId || 0), Number(b.hotspotId))
        ));
        const next = remaining.shift()!;
        ordered.push(Number(next.hotspotId));
        cursor = next;
      }
      return ordered;
    })();

    const openingUrgencyIds = [...clusterWithManual]
      .sort((a, b) => {
        if (a.closingMinute !== b.closingMinute) return a.closingMinute - b.closingMinute;
        if (a.isManual !== b.isManual) {
          return a.isManual ? -1 : 1;
        }
        if (a.effectivePriority !== b.effectivePriority) return a.effectivePriority - b.effectivePriority;
        return a.startTs - b.startTs;
      })
      .map((row) => Number(row.hotspotId));

    const priorityThenOpeningIds = [...clusterWithManual]
      .sort((a, b) => {
        const aRank = a.isManual ? 3.5 : a.effectivePriority;
        const bRank = b.isManual ? 3.5 : b.effectivePriority;
        if (aRank !== bRank) return aRank - bRank;
        if (a.closingMinute !== b.closingMinute) return a.closingMinute - b.closingMinute;
        return a.startTs - b.startTs;
      })
      .map((row) => Number(row.hotspotId));

    const p3DroppedIds = [...clusterWithManual]
      .filter((row) => row.isManual || !this.isP3ConfirmationHotspotForManualInsertion(row))
      .sort((a, b) => a.closingMinute - b.closingMinute || a.effectivePriority - b.effectivePriority || a.startTs - b.startTs)
      .map((row) => Number(row.hotspotId));

    const buildExactRouteOrder = (): number[] => {
      const routeWithoutManual = cluster.baseOrder
        .map(Number)
        .filter((id) => id > 0 && id !== manualId);

      if (!(manualId > 0)) {
        return routeWithoutManual;
      }

      if (String(params.anchorIntent || '').toUpperCase() === 'AFTER_START') {
        return [manualId, ...routeWithoutManual];
      }

      if (exactAnchorAfterHotspotId > 0) {
        const afterIndex = routeWithoutManual.findIndex((id) => id === exactAnchorAfterHotspotId);
        if (afterIndex >= 0) {
          routeWithoutManual.splice(afterIndex + 1, 0, manualId);
          return routeWithoutManual;
        }
      }

      const safeIndex = Math.max(0, Math.min(anchorAfterIndex, routeWithoutManual.length));
      routeWithoutManual.splice(safeIndex, 0, manualId);
      return routeWithoutManual;
    };

    const exactAnchorSequentialStrategy: ManualCandidateOrder = {
      strategyKey: 'exact_anchor_sequential_rebuild',
      strategyLabel: 'Selected Fit Here Sequence',
      description: 'Exact anchor rebuild: keep the clicked anchor fixed, then keep original downstream order.',
      exactAnchorIntent: String(params.anchorIntent || '').toUpperCase() === 'AFTER_START'
        ? 'AFTER_START'
        : 'AFTER_ATTRACTION',
      exactAfterHotspotId: exactAnchorAfterHotspotId || undefined,
      exactBeforeHotspotId: exactAnchorBeforeHotspotId || undefined,
      hotspotOrder: params.exactAnchorMode === true
        ? buildExactRouteOrder()
        : this.buildManualClusterOrderFromClusterPoints(
            cluster.baseOrder,
            cluster.clusterHotspots,
            insertManualAt(currentCluster, anchorAfterIndex),
          ),
    };

    const strategies: ManualCandidateOrder[] = [
      exactAnchorSequentialStrategy,
      {
        strategyKey: 'clicked_anchor_before',
        strategyLabel: 'Alternative Timing-Safe Suggestion',
        description: 'Suggestion only: existing order plus manual hotspot before the clicked anchor.',
        hotspotOrder: this.buildManualClusterOrderFromClusterPoints(cluster.baseOrder, cluster.clusterHotspots, insertManualAt(currentCluster, anchorBeforeIndex)),
      },
      {
        strategyKey: 'opening_urgency',
        strategyLabel: 'Opening-Hours Rescue Suggestion',
        description: 'Suggestion only: opening-hours rescue order inside the same-city cluster.',
        hotspotOrder: this.buildManualClusterOrderFromClusterPoints(cluster.baseOrder, cluster.clusterHotspots, openingUrgencyIds),
      },
      {
        strategyKey: 'priority_then_opening',
        strategyLabel: 'Priority-First Suggestion',
        description: 'Suggestion only: priority-first, then earlier-closing hotspots within the cluster.',
        hotspotOrder: this.buildManualClusterOrderFromClusterPoints(cluster.baseOrder, cluster.clusterHotspots, priorityThenOpeningIds),
      },
      {
        strategyKey: 'geo_nearest',
        strategyLabel: 'Nearest-Route Suggestion',
        description: 'Suggestion only: nearest-neighbor geographic order inside the same-city cluster.',
        hotspotOrder: this.buildManualClusterOrderFromClusterPoints(cluster.baseOrder, cluster.clusterHotspots, geoNearestIds),
      },
    ];

    if (params.exactAnchorMode === true) {
      const exactAnchorStrategies: ManualCandidateOrder[] = [
        exactAnchorSequentialStrategy,
        {
          strategyKey: 'exact_anchor_opening_urgency',
          strategyLabel: 'Selected Anchor Opening Rescue',
          description: 'Keep the clicked anchor fixed, then reorder downstream hotspots by earlier closing windows first.',
          exactAnchorIntent: exactAnchorSequentialStrategy.exactAnchorIntent,
          exactAfterHotspotId: exactAnchorSequentialStrategy.exactAfterHotspotId,
          exactBeforeHotspotId: exactAnchorSequentialStrategy.exactBeforeHotspotId,
          hotspotOrder: buildExactAnchorPinnedOrder(openingUrgencyIds),
        },
        {
          strategyKey: 'exact_anchor_priority_then_opening',
          strategyLabel: 'Selected Anchor Priority Rescue',
          description: 'Keep the clicked anchor fixed, then reorder downstream hotspots to preserve higher priorities before later-closing hotspots.',
          exactAnchorIntent: exactAnchorSequentialStrategy.exactAnchorIntent,
          exactAfterHotspotId: exactAnchorSequentialStrategy.exactAfterHotspotId,
          exactBeforeHotspotId: exactAnchorSequentialStrategy.exactBeforeHotspotId,
          hotspotOrder: buildExactAnchorPinnedOrder(priorityThenOpeningIds),
        },
        {
          strategyKey: 'exact_anchor_geo_nearest',
          strategyLabel: 'Selected Anchor Nearest Route',
          description: 'Keep the clicked anchor fixed, then reorder downstream hotspots by nearest next movement.',
          exactAnchorIntent: exactAnchorSequentialStrategy.exactAnchorIntent,
          exactAfterHotspotId: exactAnchorSequentialStrategy.exactAfterHotspotId,
          exactBeforeHotspotId: exactAnchorSequentialStrategy.exactBeforeHotspotId,
          hotspotOrder: buildExactAnchorPinnedOrder(geoNearestIds),
        },
      ];

      if (params.allowP3Removal === true) {
        exactAnchorStrategies.push({
          strategyKey: 'exact_anchor_drop_p3_confirmed',
          strategyLabel: 'Selected Anchor P3 Removal',
          description: 'Keep the clicked anchor fixed, allow confirmed P3 removals, then retry downstream reorder.',
          exactAnchorIntent: exactAnchorSequentialStrategy.exactAnchorIntent,
          exactAfterHotspotId: exactAnchorSequentialStrategy.exactAfterHotspotId,
          exactBeforeHotspotId: exactAnchorSequentialStrategy.exactBeforeHotspotId,
          hotspotOrder: buildExactAnchorPinnedOrder(p3DroppedIds),
          removedHotspotIds: cluster.clusterHotspots
            .filter((row) => !p3DroppedIds.includes(Number(row.hotspotId)))
            .map((row) => Number(row.hotspotId)),
          needsP3Confirmation: true,
        });
      }

      const seenExact = new Set<string>();
      return exactAnchorStrategies.filter((row) => {
        const key = row.hotspotOrder.join('>');
        if (!key || seenExact.has(key)) return false;
        seenExact.add(key);
        return true;
      });
    }

    if (params.allowP3Removal === true) {
      strategies.push({
        strategyKey: 'drop_p3_confirmed',
        strategyLabel: 'P3 Removal Required',
        description: 'Try again after confirmed P3 removal inside the cluster.',
        hotspotOrder: this.buildManualClusterOrderFromClusterPoints(cluster.baseOrder, cluster.clusterHotspots, p3DroppedIds),
        removedHotspotIds: cluster.clusterHotspots
          .filter((row) => !p3DroppedIds.includes(Number(row.hotspotId)))
          .map((row) => Number(row.hotspotId)),
        needsP3Confirmation: true,
      });
    }

    const seen = new Set<string>();
    return strategies.filter((row) => {
      const key = row.hotspotOrder.join('>');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private explainManualScheduleAttempt(attempt: ManualScheduleAttempt): string | null {
    if (attempt.readyToApply) {
      return `${attempt.strategyLabel}: schedule fits opening hours, route end time, and protected priority rules.`;
    }
    if (attempt.requiresConfirmation) {
      return 'P3 removal confirmation required before the manual hotspot can be applied.';
    }
    if (attempt.openingHourConflictCount > 0) {
      return attempt.strategyKey === 'opening_urgency'
        ? 'Opening-hours rescue was attempted, but the manual hotspot would still end after its closing window.'
        : 'Opening-hours conflict remains after this schedule attempt.';
    }
    if (attempt.routeEndOverflowMinutes > 0) {
      return `Route end time would overflow by ${attempt.routeEndOverflowMinutes} minutes after this schedule.`;
    }
    if (attempt.topPriorityAffectedCount > 0) {
      return 'This attempt would remove or invalidate protected priority hotspots.';
    }
    return attempt.reason || 'This schedule attempt could not be applied.';
  }

  private buildPreferredManualInsertionIndex(
    baseTimeline: any[],
    preferredHotspotOrder?: number[],
    manualHotspotIds?: number[],
  ): number | null {
    const manualSet = new Set((manualHotspotIds || []).map(Number).filter((id) => id > 0));
    const preferred = (preferredHotspotOrder || []).map(Number).filter((id) => id > 0);
    const manualIndex = preferred.findIndex((id) => manualSet.has(id));
    if (manualIndex < 0) return null;

    const attractions = [...(baseTimeline || [])]
      .filter((row: any) => Number(row?.hotspotId || row?.hotspot_ID || 0) > 0)
      .sort((a: any, b: any) => Number(a?.hotspotOrder ?? a?.hotspot_order ?? 0) - Number(b?.hotspotOrder ?? b?.hotspot_order ?? 0));

    const beforeIds = preferred
      .slice(0, manualIndex)
      .filter((id) => !manualSet.has(id));

    if (beforeIds.length === 0) return 0;

    let maxBaseIndex = -1;
    for (const hotspotId of beforeIds) {
      const idx = attractions.findIndex((row: any) => Number(row?.hotspotId || row?.hotspot_ID || 0) === Number(hotspotId));
      if (idx > maxBaseIndex) {
        maxBaseIndex = idx;
      }
    }

    return maxBaseIndex >= 0 ? maxBaseIndex + 1 : null;
  }

  private getEffectivePriorityForManualInsertion(row: any): number {
    const isManual =
      row?.isManual === true
      || row?.mustInclude === true
      || Number(row?.hotspot_plan_own_way || 0) === 1;

    if (isManual) {
      return this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY;
    }

    return this.normalizeHotspotPriority(
      Number(
        row?.effectivePriority
        ?? row?.normalizedPriority
        ?? row?.rawPriority
        ?? row?.priority
        ?? row?.hotspot_priority
        ?? 9999,
      ),
    );
  }

  private isStronglyProtectedAutoHotspotForManualInsertion(row: any): boolean {
    if (row?.isManual === true || row?.mustInclude === true) return false;
    const priority = this.getEffectivePriorityForManualInsertion(row);
    return priority >= 1 && priority <= this.PROTECTED_AUTO_PRIORITY_MAX;
  }

  private isP3ConfirmationHotspotForManualInsertion(row: any): boolean {
    if (row?.isManual === true || row?.mustInclude === true) return false;
    return this.getEffectivePriorityForManualInsertion(row) === this.CONFIRMATION_REQUIRED_PRIORITY;
  }

  private isAutoRemovableHotspotForManualInsertion(row: any): boolean {
    if (row?.isManual === true || row?.mustInclude === true) return false;
    if (this.isStronglyProtectedAutoHotspotForManualInsertion(row)) return false;
    if (this.isP3ConfirmationHotspotForManualInsertion(row)) return false;
    return this.getEffectivePriorityForManualInsertion(row) >= this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY;
  }

  private classifyHotspotsForManualInsertion(hotspots: any[]) {
    const normalizedRows = (hotspots || []).map((row: any) => ({
      ...row,
      effectivePriority: this.getEffectivePriorityForManualInsertion(row),
    }));

    const strictTopPriority = normalizedRows.filter((row: any) =>
      this.isStronglyProtectedAutoHotspotForManualInsertion(row),
    );
    const p3ConfirmationCandidates = normalizedRows.filter((row: any) =>
      this.isP3ConfirmationHotspotForManualInsertion(row),
    );
    const manualRequired = normalizedRows.filter((row: any) => (
      row.isManual === true
      || row.mustInclude === true
      || Number(row?.hotspot_plan_own_way || 0) === 1
    ));
    const optionalFillers = normalizedRows.filter((row: any) =>
      this.isAutoRemovableHotspotForManualInsertion(row),
    );

    return {
      strictTopPriority,
      p3ConfirmationCandidates,
      manualRequired,
      optionalFillers,
    };
  }

  private async buildRouteHotspotInsertionCandidates(...args: any[]): Promise<any> {
    return (this.manualFitCandidateDataService.buildRouteHotspotInsertionCandidates as any)(...args);
  }


  private async removeRouteHotspotFromExcludedList(...args: any[]): Promise<void> {
    return (this.manualHotspotRowService.removeRouteHotspotFromExcludedList as any)(...args);
  }

  private async addRouteHotspotToExcludedList(...args: any[]): Promise<void> {
    return (this.manualHotspotRowService.addRouteHotspotToExcludedList as any)(...args);
  }

  private async ensureManualHotspotRow(...args: any[]): Promise<any> {
    return (this.manualHotspotRowService.ensureManualHotspotRow as any)(...args);
  }


  private async isManualHotspotScheduled(...args: any[]): Promise<boolean> {
    return (this.manualHotspotScheduleStateService.isManualHotspotScheduled as any)(...args);
  }


  private hmsToSeconds(value: string): number {
    const [h, m, s] = String(value || '00:00:00').split(':').map((p) => Number(p || 0));
    const hh = Number.isFinite(h) ? h : 0;
    const mm = Number.isFinite(m) ? m : 0;
    const ss = Number.isFinite(s) ? s : 0;
    return (hh * 3600) + (mm * 60) + ss;
  }

  private computeRowDurationMinutes(row: any): number {
    const startRaw = row?.hotspot_start_time;
    const endRaw = row?.hotspot_end_time;
    if (!startRaw || !endRaw) return 0;

    const start = new Date(startRaw as any);
    const end = new Date(endRaw as any);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      return 0;
    }

    return Math.round((end.getTime() - start.getTime()) / 60000);
  }

  private async cleanupStaleManualHotspotRows(...args: any[]): Promise<void> {
    return (this.manualHotspotRowTimingService.cleanupStaleManualHotspotRows as any)(this.prisma, ...args);
  }

  private async activateManualHotspotRowWithTimes(...args: any[]): Promise<number> {
    return (this.manualHotspotRowTimingService.activateManualHotspotRowWithTimes as any)(...args);
  }

  private minutesToUtcTimeDate(minutes: number): Date {
    const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
    const d = new Date(Date.UTC(1970, 0, 1, 0, 0, 0));
    d.setUTCMinutes(safe);
    return d;
  }

  private async hasAnyNonOverlappingManualRow(...args: any[]): Promise<boolean> {
    return (this.manualHotspotOverlapService.hasAnyNonOverlappingManualRow as any)(...args);
  }

  private async manualRowHasNoOverlap(...args: any[]): Promise<boolean> {
    return (this.manualHotspotOverlapService.manualRowHasNoOverlap as any)(...args);
  }

  private async runAdaptiveManualHotspotInsertion(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
    anchor?: {
      anchorType?: 'after_travel';
      anchorIndex?: number;
    },
    options?: {
      allowTopPriorityRemoval?: boolean;
    },
  ): Promise<{
    scheduled: boolean;
    removedHotspots: Array<{ id: number; name: string; priority: number }>;
    requiresConfirmation: boolean;
    topPriorityAffected: Array<{ id: number; name: string; priority: number }>;
  }> {
    const result = await this.adaptiveManualHotspotInsertionService.runAdaptiveManualHotspotSetInsertion(
      tx,
      Number(planId),
      Number(routeId),
      [Number(hotspotId)],
      anchor,
      options,
    );

    return {
      scheduled: result.unscheduledManualHotspots.length === 0,
      removedHotspots: [...(result.removedOptionalHotspots || []), ...(result.removedTopPriorityHotspots || [])].map((row: any) => ({
        ...row,
        id: Number(row.id),
        name: row.name,
        priority: Number(row.priority || 0),
      })),
      requiresConfirmation: result.requiresConfirmation,
      topPriorityAffected: (result.topPriorityAffected || []).map((row: any) => ({
        id: Number(row.id),
        name: row.name,
        priority: Number(row.priority || 0),
      })),
    };
  }


  private async forceInsertManualHotspotConflictRow(...args: any[]): Promise<boolean> {
    return (this.manualHotspotConflictService.forceInsertManualHotspotConflictRow as any)(
      ...args,
      (...durationArgs: any[]) => (this.minutesToUtcTimeDate as any)(...durationArgs),
    );
  }

 /**
   * Remove a manual hotspot and rebuild the timeline.
 */
  async removeManualHotspot(planId: number, hotspotId: number, userId: number = 1) {
    const normalizedPlanId = Number(planId);
    const normalizedHotspotId = Number(hotspotId);

    const result = await this.prisma.$transaction(async (tx) => {
      const affectedRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          hotspot_ID: normalizedHotspotId,
          hotspot_plan_own_way: 1,
          deleted: 0,
        },
        select: {
          itinerary_route_ID: true,
        },
      });

      const affectedRouteIds = Array.from(
        new Set(
          (affectedRows || [])
            .map((row: any) => Number(row?.itinerary_route_ID || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0),
        ),
      );

      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          hotspot_ID: normalizedHotspotId,
          hotspot_plan_own_way: 1,
        },
        data: {
          deleted: 1,
          updatedon: new Date(),
        }
      });

      const rebuildResult = await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId);

      return {
        success: true,
        affectedRouteIds,
        rebuildSummary: rebuildResult.rebuildSummary,
        warnings: rebuildResult.warnings,
      };
       }, { timeout: 120000 });

    await this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, Number(userId || 1));

    if (result.affectedRouteIds.length > 0) {
      for (const affectedRouteId of result.affectedRouteIds) {
        await this.forceRebuildVehiclePricingAfterHotspotChange(
          normalizedPlanId,
          Number(affectedRouteId),
        );
      }
    } else {
      await this.forceRebuildVehiclePricingAfterHotspotChange(normalizedPlanId);
    }

    return {
      ...result,
      parkingChargesRebuilt: true,
      vehiclePricingRebuilt: true,
    };
  }

 /**
   * Rebuild a route: Clear excluded hotspots and rebuild fresh
   * This lets user get new auto-selected hotspots to replace deleted ones
 */
  async rebuildRoute(planId: number, routeId: number) {
    return this.rebuildRouteHotspotsForDay(planId, routeId, 1);
  }

 /**
   * Reset one route/day hotspot state (manual adds + exclusions) and rebuild timeline.
 */
  async rebuildRouteHotspotsForDay(planId: number, routeId: number, userId: number) {
    return this.routeHotspotRebuildService.rebuildRouteHotspotsForDay(planId, routeId, userId);
  }

 /** Compatibility facade for route timing persistence and rebuild. */
  async updateRouteTimes(
    planId: number,
    routeId: number,
    startTime: string,
    endTime: string,
    previousDayBillingDecisionProvided?: boolean,
    previousDayBillingConfirmed?: boolean,
    transportEarlyArrivalOption?: TransportEarlyArrivalOption | null,
    transportEarlyArrivalHotelName?: string | null,
    transportEarlyArrivalRestMinutes?: number | null,
    changeType?: 'ROUTE_START' | 'ROUTE_END' | 'FINAL_DAY_DEPARTURE',
    userId: number = 1,
  ) {
    return this.routeTimingService.updateRouteTimes(
      planId,
      routeId,
      startTime,
      endTime,
      previousDayBillingDecisionProvided,
      previousDayBillingConfirmed,
      transportEarlyArrivalOption,
      transportEarlyArrivalHotelName,
      transportEarlyArrivalRestMinutes,
      changeType,
      userId,
    );
  }

  async getConfirmedItineraryForCancellation(confirmedPlanId: number) {
    return this.hotelCancellationService.getConfirmedItineraryForCancellation(confirmedPlanId);
  }

 /**
   * Get cancellation charges for entire day
 */
  async getEntireDayCancellationCharges(
    confirmedPlanId: number,
    hotelId: number,
    date: string,
    cancellationPercentage: number = 10,
  ) {
    return this.hotelCancellationService.getEntireDayCancellationCharges(
      confirmedPlanId, hotelId, date, cancellationPercentage,
    );
  }

 /**
   * Execute hotel cancellation (entire day or room)
 */
  async cancelHotel(
    confirmedPlanId: number,
    hotelId: number,
    date: string,
    totalCancellationCharge: number,
    totalRefundAmount: number,
    defectType: string = 'dvi',
  ) {
    return this.hotelCancellationService.cancelHotel(
      confirmedPlanId,
      hotelId,
      date,
      totalCancellationCharge,
      totalRefundAmount,
      defectType,
    );
  }

 /** Compatibility facade for confirmed itinerary hotel projection. */
  async getConfirmedItineraryDetails(confirmedPlanId: number) {
    return this.confirmedItineraryDetailsService.getConfirmedItineraryDetails(confirmedPlanId);
  }

  private mapHotelGroupTypeToCategory(groupType: number): string {
    const categoryMap = {
      1: 'Budget',
      2: 'Mid-Range',
      3: 'Premium',
      4: 'Luxury',
    };
    return categoryMap[groupType] || 'Budget';
  }

 /**
   * Map hotel category (from dvi_hotel.hotel_category) to star rating
   * The hotel_category field is an integer, typically 1-5 or similar
 */
  private mapHotelCategoryToStars(category: number): number {
 // Map category ID to star rating
 // Assuming: 1=1star, 2=2star, 3=3star, 4=4star, 5=5star
 return Math.min(Math.max(category, 1), 5); // Clamp between 1-5
  }

 /**
   * Map hotel category to friendly name
 */
  private mapHotelCategoryToName(category: number): string {
    const categoryNames = {
      1: '1-Star',
      2: '2-Star',
      3: '3-Star',
      4: '4-Star',
      5: '5-Star',
    };
    return categoryNames[category] || 'Standard';
  }

 /**
   * Get hotel room categories for selection modal
   * Fetches room types from TBO API instead of local database
 */
  async getHotelRoomCategories(params: {
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
  }) {
    return this.hotelRoomCategoryService.getHotelRoomCategories(params);
  }

  async updateRoomCategory(params: {
    itinerary_plan_hotel_room_details_ID?: number;
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
    room_type_id: number;
    room_number?: number;
    room_qty?: number;
    all_meal_plan?: number;
    breakfast_meal_plan?: number;
    lunch_meal_plan?: number;
    dinner_meal_plan?: number;
  }) {
    return this.hotelRoomCategoryService.updateRoomCategory(params);
  }



 /**
   * 🚀 ROUTE OPTIMIZATION: Reorder routes using TSP algorithm
    * - For small candidate sets (<=8 movable stops): Exhaustive search
    * - For larger sets: Nearest Neighbor + Simulated Annealing
   *
   * This finds the optimal or near-optimal route that minimizes total travel distance/time
 */
  private async optimizeRouteOrder(routes: any[]): Promise<any[]> {
    return this.routeOptimizationService.optimizeRouteOrder(routes);
  }

  private async legacyOptimizeRouteOrder(routes: any[]): Promise<any[]> {
    if (!routes || routes.length <= 2) return routes;

    const debugOptimization = process.env.DEBUG_ROUTE_OPTIMIZER === 'true';
    const exhaustiveSafeLimit = 10;
 const log = (msg: string) => console.log(msg);
    const logDebug = (msg: string) => {
      if (debugOptimization) {
        log(msg);
      }
    };

    const context = this.routeNormalization.extractRouteOptimizationContext(routes);

    if (!context.start || !context.end) {
      log('[RouteOptimization] ⚠️ Missing start/end location. Returning original route order.');
      return routes;
    }

    if (this.routeNormalization.hasBrokenChain(routes)) {
      log('[RouteOptimization] ⚠️ Broken route chain detected. Returning original route order.');
      return routes;
    }

 // Preserve a valid route whose only removable nodes are repeated terminal anchors.
 // Duplicate movable stops are still normalized even when only one unique stop remains.
    if (
      context.movableStops.length <= 1 &&
      context.removedDuplicates.length === 0 &&
      context.removedInvalidTerminalNodes.length > 0
    ) {
      log('[RouteOptimization] Skipping optimization. Only terminal-anchor artifacts were found.');
      return routes;
    }

    const middleLocations = context.movableStops.map((stop) => stop.name);
    log(`[RouteOptimization] Start optimization (normalized). routeCount=${routes.length}, start=${context.start}, end=${context.end}, middleCount=${middleLocations.length}`);

    if (middleLocations.length === 0) {
      log('[RouteOptimization] Skipping optimization. No movable stops remain.');
      return routes;
    }

    let bestRouteLocations: string[] = [];

 // PHP parity: switch by total route count.
    if (routes.length <= exhaustiveSafeLimit) {
      log(`[RouteOptimization] Using exhaustive permutation (PHP parity). candidateCount=${middleLocations.length}`);
      bestRouteLocations = await this.optimizeWith_ExhaustivePermutation(
        context.start,
        context.end,
        middleLocations,
        log,
        logDebug,
      );
    } else {
      log(`[RouteOptimization] Using nearest-neighbor + annealing (PHP parity). candidateCount=${middleLocations.length}`);
      bestRouteLocations = await this.optimizeWith_NearestNeighborAndAnnealing(
        context.start,
        context.end,
        middleLocations,
        logDebug,
      );
    }

    if (!bestRouteLocations.length) {
      log(`[RouteOptimization] ⚠️ No optimized route generated. Returning original route order.`);
      return routes;
    }

    const optimizedRoutes = this.buildOptimizedRouteDtos(routes, bestRouteLocations, log);
    const finalChain = optimizedRoutes.map(r => `${r.location_name}→${r.next_visiting_location}`).join(' | ');
    log(`[RouteOptimization] ✅ Completed. optimizedRouteCount=${optimizedRoutes.length}. chain=${finalChain}`);
    return optimizedRoutes;
  }

  private validateOptimizationInputs(context: {
    start: string;
    end: string;
    movableStops: Array<{ name: string; normalizedName: string }>;
  }): { isValid: boolean; reason?: string } {
    const startNormalized = this.routeNormalization.normalizeLocationName(context.start);
    const endNormalized = this.routeNormalization.normalizeLocationName(context.end);

    if (!startNormalized || !endNormalized) {
      return { isValid: false, reason: 'missing-start-or-end' };
    }

    const seen = new Set<string>();
    for (const stop of context.movableStops) {
      if (!stop.name || !stop.normalizedName) {
        return { isValid: false, reason: 'empty-movable-stop' };
      }

      if (stop.normalizedName === startNormalized || stop.normalizedName === endNormalized) {
        return { isValid: false, reason: 'anchor-found-in-movable-stops' };
      }

      if (seen.has(stop.normalizedName)) {
        return { isValid: false, reason: 'duplicate-movable-stop' };
      }
      seen.add(stop.normalizedName);
    }

    return { isValid: true };
  }

  private logOptimizationSummary(
    context: {
      start: string;
      end: string;
      sourceLocations: string[];
      nextVisitingLocations: string[];
      rawFullPath: string[];
      cleanedFullPath: string[];
      rawMiddleLocations: string[];
      movableStops: Array<{ name: string; normalizedName: string }>;
      removedDuplicates: Array<{ name: string; normalizedName: string }>;
      removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
    },
    log: (msg: string) => void,
    debug: boolean,
  ): void {
    log(`[RouteOptimization] Raw route chain: ${context.sourceLocations.map((s, i) => `${s}→${context.nextVisitingLocations[i] || ''}`).join(' | ')}`);
    log(`[RouteOptimization] Full path raw=[${context.rawFullPath.join(', ')}], cleaned=[${context.cleanedFullPath.join(', ')}]`);
    log(`[RouteOptimization] Extracted anchors and movable: start=${context.start}, end=${context.end}, movable=[${context.movableStops.map((s) => s.name).join(', ')}]`);

    if (context.removedDuplicates.length > 0) {
      log(`[RouteOptimization] Removed duplicate movable stops: [${context.removedDuplicates.map((d) => d.name).join(', ')}]`);
    }

    if (context.removedInvalidTerminalNodes.length > 0) {
      log(`[RouteOptimization] Removed invalid terminal or anchor-like nodes: ${context.removedInvalidTerminalNodes.map((n) => `${n.name}(${n.reason})`).join(', ')}`);
    }

    log(`[RouteOptimization] Candidate movable stop count: ${context.movableStops.length}`);

    if (debug) {
      log(`[RouteOptimization][DEBUG] Raw middle locations: [${context.rawMiddleLocations.join(', ')}]`);
    }
  }

  private buildOptimizedRouteDtos(
    routes: any[],
    routeLocations: string[],
    log: (msg: string) => void,
    options?: { phpParity?: boolean },
  ): any[] {
    const cleanedLocations = options?.phpParity
      ? routeLocations.map((loc) => String(loc || '').trim()).filter((loc) => !!loc)
      : this.removeConsecutiveDuplicateLocations(routeLocations);

    if (cleanedLocations.length < 2) {
      log('[RouteOptimization] ⚠️ Optimized route locations are invalid after cleanup. Returning original route order.');
      return routes;
    }

    if (options?.phpParity && cleanedLocations.length !== routes.length + 1) {
      log(`[RouteOptimization] ⚠️ PHP parity route length mismatch. expected=${routes.length + 1}, actual=${cleanedLocations.length}. Returning original route order.`);
      return routes;
    }

    const optimizedRoutes: any[] = [];
    const routeCount = options?.phpParity
      ? routes.length
      : cleanedLocations.length - 1;

    for (let i = 0; i < routeCount; i++) {
      const templateRoute = routes[Math.min(i, routes.length - 1)];
      const newRoute = { ...templateRoute };
      newRoute.location_name = cleanedLocations[i];
      newRoute.next_visiting_location = cleanedLocations[i + 1];
      optimizedRoutes.push(newRoute);
    }

    const startDate = new Date(routes[0].itinerary_route_date);
    optimizedRoutes.forEach((route, index) => {
      const newDate = new Date(startDate);
      newDate.setDate(newDate.getDate() + index);
      route.itinerary_route_date = newDate.toISOString().split('T')[0];
      route.no_of_days = index + 1;
    });

    return optimizedRoutes;
  }

  private removeConsecutiveDuplicateLocations(locations: string[]): string[] {
    const cleaned: string[] = [];
    for (const location of locations) {
      const name = String(location || '').trim();
      if (!name) continue;
      if (cleaned.length === 0) {
        cleaned.push(name);
        continue;
      }

      const prev = cleaned[cleaned.length - 1];
      if (this.routeNormalization.normalizeLocationName(prev) === this.routeNormalization.normalizeLocationName(name)) {
        continue;
      }
      cleaned.push(name);
    }
    return cleaned;
  }

 /**
    * PHP-EXACT: small candidate sets only - EXHAUSTIVE PERMUTATION
   * Tries all permutations of middleLocations and finds the one with minimum total distance
 */
  private async optimizeWith_ExhaustivePermutation(
    start: string,
    end: string,
    middleLocations: string[],
    log: (msg: string) => void,
    logDebug: (msg: string) => void
  ): Promise<string[]> {
    const perms = this.generatePermutations_PHP([...middleLocations]);

 let bestPerm: string[] = middleLocations; // Default to original order
    let bestDistance = Infinity;
    let bestChain = '';

    log(`[ExhaustivePermutation] Testing ${perms.length} permutations...`);

    let tested = 0;
    for (const perm of perms) {
      tested++;
      let current = start;
      let totalDistance = 0;
      const chain: string[] = [current];

 // Evaluate cost: start -> perm[0] -> perm[1] -> ... -> perm[n-1] -> end
      for (const loc of perm) {
        const distance = await this.getDistance_PHP(current, loc);
        if (distance === Infinity) {
          totalDistance = Infinity;
 break; // Missing distance = invalid permutation
        }
        totalDistance += distance;
        current = loc;
        chain.push(current);
      }

 // Add final segment: last middle location -> end
      if (totalDistance !== Infinity) {
        const finalDist = await this.getDistance_PHP(current, end);
        if (finalDist === Infinity) {
          totalDistance = Infinity;
        } else {
          totalDistance += finalDist;
          chain.push(end);
        }
      }

      const chainStr = chain.join(' → ');

      if (totalDistance < bestDistance) {
        bestDistance = totalDistance;
        bestPerm = perm;
        bestChain = chainStr;
        log(`[ExhaustivePermutation] best-so-far=${bestDistance === Infinity ? 'INVALID' : bestDistance.toFixed(1) + ' km'} route=[${bestPerm.join(', ')}]`);
      } else if (tested % 250 === 0) {
        logDebug(`[ExhaustivePermutation][DEBUG] progress=${tested}/${perms.length} best=${bestDistance === Infinity ? 'INVALID' : bestDistance.toFixed(1) + ' km'}`);
      }
    }

    log(`[ExhaustivePermutation] ✅ Best permutation: [${bestPerm.join(',')}] = ${bestDistance.toFixed(1)} km`);
    log(`[ExhaustivePermutation] Best chain: ${bestChain}`);

 // Return final route locations: [start, ...bestPerm, end]
    return [start, ...bestPerm, end];
  }

 /**
   * PHP-EXACT: >10 routes - NEAREST NEIGHBOR + SIMULATED ANNEALING
 */
  private async optimizeWith_NearestNeighborAndAnnealing(
    start: string,
    end: string,
    middleLocations: string[],
    log: (msg: string) => void
  ): Promise<string[]> {
 // Build remainingLocationsCounts (like PHP's array_count_values for duplicates)
    const remainingLocationsCounts = this.buildLocationCounts_PHP(middleLocations);
    log(`[NearestNeighbor] Location counts: ${JSON.stringify(remainingLocationsCounts)}`);

 // Greedy nearest neighbor
    const greedyRoute = await this.nearestNeighbor_PHP(start, remainingLocationsCounts, log);
    log(`[NearestNeighbor] Greedy route: [${greedyRoute.join(', ')}]`);

 // Build initial route: [start, ...greedy, end]
    let initialRoute = [start, ...greedyRoute, end];
    let initialDistance = await this.calculateChainDistance_PHP(initialRoute, log);
    log(`[SimulatedAnnealing] Initial route distance: ${initialDistance.toFixed(1)} km`);

 // Simulated annealing
    const finalRoute = await this.simulatedAnnealing_PHP(
      initialRoute,
 1000, // initialTemp
 0.003, // coolingRate
      log
    );

    let finalDistance = await this.calculateChainDistance_PHP(finalRoute, log);
    log(`[SimulatedAnnealing] Final route distance: ${finalDistance.toFixed(1)} km`);

    return finalRoute;
  }

 /**
   * PHP-EXACT: Build location counts like array_count_values
 */
  private buildLocationCounts_PHP(locations: string[]): { [location: string]: number } {
    const counts: { [location: string]: number } = {};
    for (const loc of locations) {
      counts[loc] = (counts[loc] || 0) + 1;
    }
    return counts;
  }

 /**
   * PHP-EXACT: Nearest neighbor greedy algorithm
   * Returns ordered list of middle locations (not including start/end)
 */
  private async nearestNeighbor_PHP(
    start: string,
    remainingLocationsCounts: { [location: string]: number },
    log: (msg: string) => void
  ): Promise<string[]> {
    const route: string[] = [];
    let current = start;

 // Total locations to visit
    const totalLocations = Object.values(remainingLocationsCounts).reduce((a, b) => a + b, 0);

    log(`[NearestNeighbor] Total middle locations to visit: ${totalLocations}`);

    for (let step = 0; step < totalLocations; step++) {
      let nearestLocation: string | null = null;
      let minDistance = Infinity;

 // Find nearest unvisited location
      for (const [location, count] of Object.entries(remainingLocationsCounts)) {
        if (count > 0) {
          const distance = await this.getDistance_PHP(current, location);
          if (distance < minDistance) {
            minDistance = distance;
            nearestLocation = location;
          }
        }
      }

      if (nearestLocation === null) break;

      route.push(nearestLocation);
      remainingLocationsCounts[nearestLocation]--;
      current = nearestLocation;

      log(`[NearestNeighbor] Step ${step + 1}: Selected ${nearestLocation} (distance: ${minDistance.toFixed(1)} km)`);
    }

    return route;
  }

 /**
   * PHP-EXACT: Simulated annealing optimization
 */
  private async simulatedAnnealing_PHP(
    initialRoute: string[],
    initialTemp: number,
    coolingRate: number,
    log: (msg: string) => void
  ): Promise<string[]> {
    let currentRoute = [...initialRoute];
    let currentDistance = await this.calculateChainDistance_PHP(currentRoute, log);
    let bestRoute = [...currentRoute];
    let bestDistance = currentDistance;

    let temperature = initialTemp;
    const minTemp = 0.001;
    let iteration = 0;

    log(`[SimulatedAnnealing] Starting with temp=${temperature.toFixed(2)}, coolingRate=${coolingRate}`);

    while (temperature > minTemp) {
      iteration++;

 // Random swap of two middle indices (NOT first or last)
      const middleStart = 1;
 const middleEnd = currentRoute.length - 2; // Exclude end

 if (middleEnd <= middleStart) break; // Not enough locations to swap

      const i = middleStart + Math.floor(Math.random() * (middleEnd - middleStart + 1));
      const j = middleStart + Math.floor(Math.random() * (middleEnd - middleStart + 1));

      if (i === j) {
        temperature *= (1 - coolingRate);
        continue;
      }

 // Create neighbor solution
      const newRoute = [...currentRoute];
      [newRoute[i], newRoute[j]] = [newRoute[j], newRoute[i]];

      const newDistance = await this.calculateChainDistance_PHP(newRoute, log);
      const delta = newDistance - currentDistance;

 // Acceptance rule: accept if better OR accept with probability based on temperature
      if (delta < 0 || Math.random() < Math.exp(-delta / temperature)) {
        currentRoute = newRoute;
        currentDistance = newDistance;

        if (currentDistance < bestDistance) {
          bestRoute = [...currentRoute];
          bestDistance = currentDistance;
          log(`[SimulatedAnnealing] Iteration ${iteration}: New best distance = ${bestDistance.toFixed(1)} km (temp=${temperature.toFixed(4)})`);
        }
      }

      temperature *= (1 - coolingRate);

      if (iteration % 100 === 0) {
        log(`[SimulatedAnnealing] Iteration ${iteration}: current=${currentDistance.toFixed(1)} km, best=${bestDistance.toFixed(1)} km, temp=${temperature.toFixed(4)}`);
      }
    }

    log(`[SimulatedAnnealing] Completed ${iteration} iterations`);
    return bestRoute;
  }

 /**
   * PHP-EXACT: Calculate total distance for a route chain
 */
  private async calculateChainDistance_PHP(chain: string[], log?: (msg: string) => void): Promise<number> {
    let totalDistance = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const distance = await this.getDistance_PHP(chain[i], chain[i + 1]);
      if (distance === Infinity) return Infinity;
      totalDistance += distance;
    }
    return totalDistance;
  }

 /**
   * Calculate distance matrix between locations
   * In a real scenario, this would call Google Maps or similar API
   * For now, using a simplified distance calculation or mock data
 */




 /**
   * PHP-EXACT: Get distance between two locations from database
   * Returns Infinity if distance not found (matching PHP's PHP_INT_MAX behavior)
   * NO reverse fallback, NO default 100, ONLY exact match
 */
  private async getDistance_PHP(sourceLocation: string, destinationLocation: string): Promise<number> {
    if (sourceLocation === destinationLocation) return 0;

    try {
      const record = await this.prisma.dvi_stored_locations.findFirst({
        where: {
          source_location: sourceLocation,
          destination_location: destinationLocation,
        },
        select: {
          distance: true,
        },
      });

      if (record && record.distance) {
        const dist = typeof record.distance === 'string'
          ? parseFloat(record.distance)
          : record.distance;
        return isNaN(dist) ? Infinity : dist;
      }
 return Infinity; // Missing distance = Infinity (marks permutation as invalid)
    } catch (error) {
 return Infinity; // Error = Infinity (marks permutation as invalid)
    }
  }

 /**
   * PHP-EXACT: Generate all permutations of a location array (preserves duplicates)
   * Used for exhaustive search on ≤10 routes
 */
  private generatePermutations_PHP(arr: string[]): string[][] {
    if (arr.length <= 1) return [arr];

    const result: string[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const current = arr[i];
      const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
      const perms = this.generatePermutations_PHP(remaining);

      for (const perm of perms) {
        result.push([current, ...perm]);
      }
    }

    return result;
  }

  private async simulateActivityImpactBeforeAdd(...args: any[]): Promise<any> {
    return (this.activityImpactService.simulateActivityImpactBeforeAdd as any)(...args);
  }
  private timeToMinutes(time: Date | null): number {
    return this.activityTimingPolicyService.timeToMinutes(time);
  }

 /**
   * Helper: Format time for display
 */
  private formatTime(time: Date | null): string {
    return this.activityTimingPolicyService.formatTime(time);
  }

  private formatTransportVoucherDate(value: Date | string | null | undefined): string {
    return this.transportFormattingService.formatTransportVoucherDate(value);
  }

  private buildTransportDateRange(start: Date | string | null | undefined, end: Date | string | null | undefined): string {
    return this.transportFormattingService.buildTransportDateRange(start, end);
  }

  private buildPassengerMixLabel(adults: number, children: number, infants: number): string {
    return this.transportFormattingService.buildPassengerMixLabel(adults, children, infants);
  }

  private buildTransportVoucherNumber(planId: number, createdOn: Date | string | null | undefined): string {
    return this.transportFormattingService.buildTransportVoucherNumber(planId, createdOn);
  }

  private formatTransportTime(value: Date | string | null | undefined): string {
    return this.transportFormattingService.formatTransportTime(value);
  }

  private shortTransportLocationName(value: string): string {
    return this.transportFormattingService.shortTransportLocationName(value);
  }

  private decodeTransportHtml(value: string): string {
    return this.transportFormattingService.decodeTransportHtml(value);
  }

  private parseTransportFlightDetails(raw: unknown, fallbackDateTime?: Date | string | null) {
    return this.transportFormattingService.parseTransportFlightDetails(raw, fallbackDateTime);
  }

  private addMinutesToTime(time: Date, minutes: number): Date {
    return this.activityTimingPolicyService.addMinutesToTime(time, minutes);
  }

 /**
   * Check if proposed activity insertion timing conflicts with activity time slots.
 */
  private checkActivityTimingConflicts(
    activity: any,
    timeSlots: any[],
    proposedStartTime: Date,
    proposedEndTime: Date
  ): Array<{ reason: string; severity: string }> {
    return this.activityTimingPolicyService.checkActivityTimingConflicts(
      activity,
      timeSlots,
      proposedStartTime,
      proposedEndTime,
    );
  }


}


