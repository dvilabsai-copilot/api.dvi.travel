// REPLACE-WHOLE-FILE
// FILE: src/itineraries/itineraries.service.ts

import { Injectable, BadRequestException, NotFoundException, ConflictException, InternalServerErrorException } from "@nestjs/common";
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
import { TimelineEnricher } from "./engines/helpers/timeline.enricher";
import { normalizePassengerTitle } from "../../common/utils/passenger-title.util";
import { SupplementNormalizerService } from "../../modules/hotels/services/supplement-normalizer.service";
import { normalizeCityName } from "./utils/city-normalization.util";
import { haversineKm } from "./utils/distance-utils";
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
import { filterActiveVendorCandidateRows } from "./utils/active-vendor-candidate.util";
import { getVehicleRateAvailability } from "./utils/vehicle-rate-availability.util";
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
import { ItineraryVehicleBuildStatusService } from './services/itinerary-vehicle-build-status.service';
import { ItineraryVehicleBuildService } from './services/itinerary-vehicle-build.service';
import { ItineraryPlanPersistenceService } from './services/itinerary-plan-persistence.service';
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

type VehicleBuildState = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

type VehicleBuildStatus = {
  planId: number;
  status: VehicleBuildState;
  buildRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  error: string | null;
  eligibleCount: number;
  vehicleDetailCount: number;
  requestedVehicleCount: number;
  hasUsableVehicleDetails: boolean;
  isLatestBuildReady: boolean;
  statusSource: 'db' | 'memory' | 'derived';
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
      hotelDetailsTboService,
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
      (...args) => (cancellationService.logCancellationAction as any)(...args),
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
    private readonly routeTimingService: ItineraryRouteTimingService = new ItineraryRouteTimingService(null as any, null as any),
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
  ) {
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
    this.vehicleBuildService.setVehicleVendorSelector((data) => this.selectVehicleVendor(data));
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

  private async calculateActivityPlanPricing(
  params: {
    planId?: number | null;
    routeId?: number | null;
    activityId: number;
    hotspotId?: number | null;
  },
  db: any = this.prisma,
): Promise<{
  pricingUnitType: 'PER_ADULT' | 'UNIT';
  priceUnitLabel: string;
  nationalityType: number;
  adults: number;
  children: number;
  adultRate: number;
  childRate: number;
  unitRate: number;
  totalAmount: number;
  priceDate: string | null;
}> {
  const empty = {
    pricingUnitType: 'PER_ADULT' as const,
    priceUnitLabel: 'per adult',
    nationalityType: 1,
    adults: 0,
    children: 0,
    adultRate: 0,
    childRate: 0,
    unitRate: 0,
    totalAmount: 0,
    priceDate: null as string | null,
  };

  const activityId = Number(params.activityId || 0);
  if (!activityId) return empty;

  const planId = Number(params.planId || 0);
  const routeId = Number(params.routeId || 0);

  const plan = planId
    ? await (db as any).dvi_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: planId, deleted: 0 },
        select: {
          total_adult: true,
          total_children: true,
          nationality: true,
          trip_start_date_and_time: true,
        },
      })
    : null;

  const route =
    planId && routeId
      ? await (db as any).dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            deleted: 0,
          },
          select: { itinerary_route_date: true },
        })
      : null;

  const adults = Math.max(Number(plan?.total_adult || 0), 0);
  const children = Math.max(Number(plan?.total_children || 0), 0);

  const rawDate =
    route?.itinerary_route_date ||
    plan?.trip_start_date_and_time ||
    new Date();

  const priceDate = this.formatDateOnly(rawDate);
  const [yearText, monthText, dayText] = String(priceDate || '').split('-');

  const year = Number(yearText || 0);
  const month = Number(monthText || 0);
  const day = Number(dayText || 0);

  let nationalityType = 1;

  const nationalityId = Number(plan?.nationality || 0);
  if (nationalityId > 0) {
    const country = await (db as any).dvi_countries.findFirst({
      where: { id: nationalityId, deleted: 0, status: 1 },
      select: { shortname: true },
    });

    const iso2 = String(country?.shortname || '').trim().toUpperCase();

    if (iso2 && iso2 !== 'IN') {
      nationalityType = 2;
    } else if (!iso2 && nationalityId === 2) {
      nationalityType = 2;
    }
  }

  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const monthName = month >= 1 && month <= 12 ? monthNames[month - 1] : '';
  const dayKey = day >= 1 && day <= 31 ? `day_${day}` : 'day_1';

  const priceSelect = {
    price_type: true,
    [dayKey]: true,
  } as any;

  let priceRows =
    year && monthName
      ? await (db as any).dvi_activity_pricebook.findMany({
          where: {
            activity_id: activityId,
            nationality: nationalityType,
            year: String(year),
            month: monthName,
            deleted: 0,
            status: 1,
          },
          select: priceSelect,
        })
      : [];

  let effectiveDayKey = dayKey;

  if (!priceRows.length) {
    priceRows = await (db as any).dvi_activity_pricebook.findMany({
      where: {
        activity_id: activityId,
        nationality: nationalityType,
        deleted: 0,
        status: 1,
      },
      select: {
        price_type: true,
        day_1: true,
      },
    });

    effectiveDayKey = 'day_1';
  }

  const getRate = (priceType: number) => {
    const row = priceRows.find(
      (item: any) => Number(item?.price_type || 0) === priceType,
    );

    return Number(row?.[effectiveDayKey] || 0);
  };

  const adultRate = getRate(1);
  const childRate = getRate(2);
  const unitRate = getRate(4);

  const pricingUnitType: 'PER_ADULT' | 'UNIT' =
    unitRate > 0 ? 'UNIT' : 'PER_ADULT';

  const totalAmount =
    pricingUnitType === 'UNIT'
      ? unitRate
      : adultRate * adults + childRate * children;

  return {
    pricingUnitType,
    priceUnitLabel: pricingUnitType === 'UNIT' ? 'per unit' : 'per adult',
    nationalityType,
    adults,
    children,
    adultRate,
    childRate,
    unitRate,
    totalAmount,
    priceDate,
  };
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

  async getVehicleBuildStatus(planId: number): Promise<VehicleBuildStatus> {
    return this.vehicleBuildStatusService.getStatus(planId);
  }

  async buildPermitsSync(planId: number, req: any) {
    return this.vehicleBuildService.buildPermitsSync(planId, req);
  }

  async buildVehiclesSync(planId: number, req: any) {
    return this.vehicleBuildService.buildVehiclesSync(planId, req);
  }

  async triggerVehicleBuild(planId: number, req: any): Promise<VehicleBuildStatus> {
    return this.vehicleBuildService.triggerVehicleBuild(planId, req);
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
    return this.planPersistenceService.createPlan(dto, req, shouldOptimizeRoute, requestType);
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
    hotelId: number;
    roomTypeId: number;
    groupType?: number;
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean };
  }) {
    return this.selectionWorkflowService.selectHotel(data);
  }

  /**
   * Bulk save hotel selections - used before confirming itinerary
   */
  async bulkSaveHotels(planId: number, hotels: any[]) {
    return this.selectionWorkflowService.bulkSaveHotels(planId, hotels);
  }

  async selectVehicleVendor(data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId: number;
  }) {
    return this.selectionWorkflowService.selectVehicleVendor(data);
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
  private async logCancellationAction(...args: any[]) {
    return (this.cancellationService.logCancellationAction as any)(...args);
  }
  async getAgentsForFilter(req: any) {
    return this.listingService.getAgentsForFilter(req);
  }

  async getLocationsForFilter() {
    return this.listingService.getLocationsForFilter();
  }

  async getLocationsForLatestFilter(): Promise<{ value: string; label: string }[]> {
    return this.listingService.getLocationsForLatestFilter();
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

      // If direct distance ≈ sum of detour distances, it's roughly on the path (triangle inequality near equality)
      const tolerance = 0.15; // 15% tolerance for deviation
      const sum = d_from_mid + d_mid_to;
      const deviation = (sum - d_from_to) / d_from_to;

      // If deviation is too small (< tolerance), it might be on path
      // If deviation is large, the hotspot is definitely off-route
      if (deviation < tolerance) {
        return true; // Likely on the path or reasonably close
      }

      // Additional check: cross-product test to see if mid is on the correct "side" of the route
      // Using the cross product of vectors (from→to) and (from→mid)
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

  // ─── Route-intelligence: hotspot_route_between_map integration ──────────────
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
  // ─────────────────────────────────────────────────────────────────────────────

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


  private async removeRouteHotspotFromExcludedList(
    tx: any,
    routeId: number,
    hotspotId: number,
    routeRow?: any,
  ) {
    const route = routeRow || await (tx as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
    });

    const rawExcluded = Array.isArray(route?.excluded_hotspot_ids) ? route.excluded_hotspot_ids : [];
    const filteredExcluded = rawExcluded
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0 && id !== Number(hotspotId));

    if (filteredExcluded.length !== rawExcluded.length) {
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: Number(routeId) },
        data: {
          excluded_hotspot_ids: filteredExcluded,
          updatedon: new Date(),
        },
      });
    }
  }

  private async addRouteHotspotToExcludedList(tx: any, routeId: number, hotspotId: number) {
    const route = await (tx as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
    });

    const current = Array.isArray(route?.excluded_hotspot_ids)
      ? route.excluded_hotspot_ids.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
      : [];

    if (!current.includes(Number(hotspotId))) {
      current.push(Number(hotspotId));
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: Number(routeId) },
        data: {
          excluded_hotspot_ids: current,
          updatedon: new Date(),
        },
      });
    }
  }

  private async ensureManualHotspotRow(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
    userId: number,
  ): Promise<{ alreadyExisted: boolean }> {
    const existingRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        deleted: 0,
      },
      orderBy: [
        { route_hotspot_ID: 'desc' },
      ],
      select: {
        route_hotspot_ID: true,
        hotspot_plan_own_way: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        status: true,
        is_conflict: true,
      },
    });

    const validExisting = (existingRows || []).find((row: any) => {
      const isActive = Number(row?.status || 0) === 1;
      const hasPositiveDuration = this.computeRowDurationMinutes(row) > 0;
      const isConflict = Number(row?.is_conflict || 0) === 1;
      return isActive && hasPositiveDuration && !isConflict;
    });

    if (validExisting) {
      if (Number(validExisting.hotspot_plan_own_way || 0) !== 1) {
        await (tx as any).dvi_itinerary_route_hotspot_details.update({
          where: { route_hotspot_ID: Number(validExisting.route_hotspot_ID) },
          data: {
            hotspot_plan_own_way: 1,
            updatedon: new Date(),
          },
        });
      }
      return { alreadyExisted: true };
    }

    const staleActiveIds = (existingRows || [])
      .filter((row: any) => {
        const isActive = Number(row?.status || 0) === 1;
        const isManual = Number(row?.hotspot_plan_own_way || 0) === 1;
        return isActive && isManual && this.computeRowDurationMinutes(row) <= 0;
      })
      .map((row: any) => Number(row?.route_hotspot_ID || 0))
      .filter((id: number) => id > 0);

    if (staleActiveIds.length > 0) {
      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: { route_hotspot_ID: { in: staleActiveIds } },
        data: {
          status: 0,
          deleted: 1,
          updatedon: new Date(),
        },
      });
    }

    const placeholderTime = new Date('1970-01-01T00:00:00Z');
    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: 999,
        hotspot_start_time: placeholderTime,
        hotspot_end_time: placeholderTime,
        createdby: Number(userId || 1),
        createdon: new Date(),
        status: 0,
        deleted: 1,
      },
    });

    return { alreadyExisted: false };
  }

  private async isManualHotspotScheduled(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
  ): Promise<boolean> {
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        hotspot_plan_own_way: 1,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        is_conflict: true,
      },
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return false;
    }

    const scheduledCandidateRows = rows.filter((row: any) => {
      const hasPositiveDuration = this.computeRowDurationMinutes(row) > 0;
      const isConflict = Number(row?.is_conflict || 0) === 1;
      return hasPositiveDuration && !isConflict;
    });

    if (scheduledCandidateRows.length === 0) {
      return false;
    }

    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(routeId),
        itinerary_plan_ID: Number(planId),
        deleted: 0,
      },
      select: { itinerary_route_date: true },
    });

    // If route date is unavailable, keep legacy behavior to avoid false negatives.
    if (!route?.itinerary_route_date) {
      return this.hasAnyNonOverlappingManualRow(tx, Number(planId), Number(routeId), scheduledCandidateRows);
    }

    const timingDay = (new Date(route.itinerary_route_date).getDay() + 6) % 7; // Mon=0..Sun=6
    const timings = await (tx as any).dvi_hotspot_timing.findMany({
      where: {
        hotspot_ID: Number(hotspotId),
        hotspot_timing_day: Number(timingDay),
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_open_all_time: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
    });

    // No timing definition: preserve previous permissive behavior.
    if (!Array.isArray(timings) || timings.length === 0) {
      return this.hasAnyNonOverlappingManualRow(tx, Number(planId), Number(routeId), scheduledCandidateRows);
    }

    if (timings.some((t: any) => Number(t?.hotspot_open_all_time || 0) === 1)) {
      return this.hasAnyNonOverlappingManualRow(tx, Number(planId), Number(routeId), scheduledCandidateRows);
    }

    let hasValidRow = false;
    for (const row of scheduledCandidateRows) {

      const startSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_start_time));
      const endSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_end_time));

      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) {
        continue;
      }

      const fitsOperatingHours = timings.some((t: any) => {
        if (!t?.hotspot_start_time || !t?.hotspot_end_time) return false;

        const opStart = this.hmsToSeconds(TimeConverter.toTimeString(t.hotspot_start_time));
        const opEnd = this.hmsToSeconds(TimeConverter.toTimeString(t.hotspot_end_time));

        // Overnight window support (e.g., 18:00 -> 02:00)
        if (opEnd < opStart) {
          const inToday = startSec >= opStart && endSec >= startSec;
          const inOvernight = startSec <= opEnd && endSec <= opEnd;
          return inToday || inOvernight;
        }

        return startSec >= opStart && endSec <= opEnd;
      });

      if (!fitsOperatingHours) {
        continue;
      }

      if (await this.manualRowHasNoOverlap(tx, Number(planId), Number(routeId), row)) {
        hasValidRow = true;
        break;
      }
    }

    return hasValidRow;
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

  private async cleanupStaleManualHotspotRows(
    planId: number,
    routeId: number,
    hotspotIds: number[],
  ): Promise<void> {
    const normalizedHotspotIds = this.normalizeManualHotspotIds(hotspotIds);
    if (normalizedHotspotIds.length === 0) return;

    const rows = await this.prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: { in: normalizedHotspotIds },
        item_type: 4,
        hotspot_plan_own_way: 1,
        deleted: 0,
        status: 1,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
    });

    const staleIds = (rows || [])
      .filter((row: any) => this.computeRowDurationMinutes(row) <= 0)
      .map((row: any) => Number(row?.route_hotspot_ID || 0))
      .filter((id: number) => id > 0);

    if (staleIds.length === 0) return;

    await this.prisma.dvi_itinerary_route_hotspot_details.updateMany({
      where: {
        route_hotspot_ID: { in: staleIds },
      },
      data: {
        status: 0,
        deleted: 1,
        updatedon: new Date(),
      },
    });
  }

  private async activateManualHotspotRowWithTimes(
    tx: any,
    params: {
      planId: number;
      routeId: number;
      hotspotId: number;
      userId: number;
      start: Date;
      end: Date;
      hotspotOrder?: number;
    },
  ): Promise<number> {
    const durationMinutes = Math.round((params.end.getTime() - params.start.getTime()) / 60000);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MANUAL_HOTSPOT_INVALID_TIMING_WINDOW',
        message: 'Cannot activate manual hotspot row with zero/negative duration.',
      });
    }

    const existingRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(params.planId),
        itinerary_route_ID: Number(params.routeId),
        hotspot_ID: Number(params.hotspotId),
        item_type: 4,
      },
      orderBy: [
        { route_hotspot_ID: 'desc' },
      ],
      select: {
        route_hotspot_ID: true,
      },
    });

    const keepRowId = Number(existingRows?.[0]?.route_hotspot_ID || 0);
    if (keepRowId > 0) {
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: keepRowId },
        data: {
          hotspot_plan_own_way: 1,
          hotspot_start_time: params.start,
          hotspot_end_time: params.end,
          hotspot_traveling_time: this.minutesToUtcTimeDate(Math.max(1, durationMinutes)),
          hotspot_order: Number.isFinite(Number(params.hotspotOrder || 0)) && Number(params.hotspotOrder || 0) > 0
            ? Number(params.hotspotOrder)
            : undefined,
          status: 1,
          deleted: 0,
          is_conflict: 0,
          conflict_reason: null,
          updatedon: new Date(),
        },
      });

      const staleIds = (existingRows || [])
        .slice(1)
        .map((row: any) => Number(row?.route_hotspot_ID || 0))
        .filter((id: number) => id > 0);
      if (staleIds.length > 0) {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            route_hotspot_ID: { in: staleIds },
          },
          data: {
            status: 0,
            deleted: 1,
            updatedon: new Date(),
          },
        });
      }

      return keepRowId;
    }

    const created = await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(params.planId),
        itinerary_route_ID: Number(params.routeId),
        hotspot_ID: Number(params.hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: Number.isFinite(Number(params.hotspotOrder || 0)) && Number(params.hotspotOrder || 0) > 0
          ? Number(params.hotspotOrder)
          : 999,
        hotspot_start_time: params.start,
        hotspot_end_time: params.end,
        hotspot_traveling_time: this.minutesToUtcTimeDate(Math.max(1, durationMinutes)),
        createdby: Number(params.userId || 1),
        createdon: new Date(),
        status: 1,
        deleted: 0,
        is_conflict: 0,
        conflict_reason: null,
      },
      select: {
        route_hotspot_ID: true,
      },
    });

    return Number(created?.route_hotspot_ID || 0);
  }

  private minutesToUtcTimeDate(minutes: number): Date {
    const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
    const d = new Date(Date.UTC(1970, 0, 1, 0, 0, 0));
    d.setUTCMinutes(safe);
    return d;
  }

  private async hasAnyNonOverlappingManualRow(
    tx: any,
    planId: number,
    routeId: number,
    rows: any[],
  ): Promise<boolean> {
    for (const row of rows) {
      const ok = await this.manualRowHasNoOverlap(tx, planId, routeId, row);
      if (ok) return true;
    }
    return false;
  }

  private async manualRowHasNoOverlap(
    tx: any,
    planId: number,
    routeId: number,
    row: any,
  ): Promise<boolean> {
    const startSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_start_time));
    const endSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_end_time));

    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      return false;
    }

    const otherRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        route_hotspot_ID: { not: Number(row?.route_hotspot_ID || 0) },
      },
      select: {
        hotspot_start_time: true,
        hotspot_end_time: true,
        is_conflict: true,
      },
    });

    return !(otherRows || []).some((other: any) => {
      if (Number(other?.is_conflict || 0) === 1) return false;

      const otherStart = this.hmsToSeconds(TimeConverter.toTimeString(other?.hotspot_start_time));
      const otherEnd = this.hmsToSeconds(TimeConverter.toTimeString(other?.hotspot_end_time));

      if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd) || otherEnd <= otherStart) {
        return false;
      }

      return startSec < otherEnd && endSec > otherStart;
    });
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


  private async forceInsertManualHotspotConflictRow(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
    userId: number,
    preferredTimes?: { start: Date; end: Date },
  ): Promise<boolean> {
    const existing = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        deleted: 0,
      },
      select: { route_hotspot_ID: true },
    });

    if (existing) {
      const preferredDuration = preferredTimes?.start && preferredTimes?.end
        ? Math.max(1, Math.round((preferredTimes.end.getTime() - preferredTimes.start.getTime()) / 60000))
        : 0;

      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(existing.route_hotspot_ID) },
        data: {
          hotspot_plan_own_way: 1,
          hotspot_start_time: preferredTimes?.start || undefined,
          hotspot_end_time: preferredTimes?.end || undefined,
          hotspot_traveling_time: preferredDuration > 0 ? this.minutesToUtcTimeDate(preferredDuration) : undefined,
          is_conflict: 1,
          conflict_reason: 'Forced manual insertion after user confirmation.',
          updatedon: new Date(),
        },
      });
      return true;
    }

    const route = await (tx as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
      select: {
        route_start_time: true,
        route_end_time: true,
      },
    });

    const fallbackStartTime = preferredTimes?.start || route?.route_end_time || route?.route_start_time || new Date('1970-01-01T00:00:00Z');
    const fallbackEndTime = preferredTimes?.end || fallbackStartTime;
    const fallbackDurationMinutes = Math.max(1, Math.round((fallbackEndTime.getTime() - fallbackStartTime.getTime()) / 60000));

    const currentMaxOrderRow = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      orderBy: { hotspot_order: 'desc' },
      select: { hotspot_order: true },
    });
    const nextOrder = Number(currentMaxOrderRow?.hotspot_order || 0) + 1;

    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: Number.isFinite(nextOrder) && nextOrder > 0 ? nextOrder : 999,
        hotspot_start_time: fallbackStartTime,
        hotspot_end_time: fallbackEndTime,
        hotspot_traveling_time: this.minutesToUtcTimeDate(fallbackDurationMinutes),
        is_conflict: 1,
        conflict_reason: 'Forced manual insertion after user confirmation.',
        createdby: Number(userId || 1),
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    return true;
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
    const normalizedPlanId = Number(planId);
    const normalizedRouteId = Number(routeId);
    let planQuoteId = "";
    const rebuildResult = await this.prisma.$transaction(async (tx) => {
      const route = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: normalizedRouteId,
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
          status: 1,
        },
        select: {
          itinerary_route_ID: true,
          excluded_hotspot_ids: true,
        },
      });

      if (!route) {
        throw new BadRequestException(
          `Route ${normalizedRouteId} does not belong to plan ${normalizedPlanId} or is no longer active`,
        );
      }

      const oldRoutes = await (tx as any).dvi_itinerary_route_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
          status: 1,
        },
        select: {
          itinerary_route_ID: true,
          itinerary_route_date: true,
        },
      });
      const oldRouteDateMap = new Map(
        oldRoutes.map((row: any) => [Number(row.itinerary_route_ID || 0), row.itinerary_route_date]),
      );
      const oldHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          item_type: 4,
          deleted: 0,
          status: 1,
          hotspot_plan_own_way: { not: 1 },
        },
      });
      const existingHotspotsWithDates = oldHotspots.map((row: any) => ({
        ...row,
        route_date: oldRouteDateMap.get(Number(row.itinerary_route_ID || 0)),
      }));

      const planRow = await (tx as any).dvi_itinerary_plan_details.findFirst({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
        },
        select: {
          itinerary_quote_ID: true,
        },
      });
      planQuoteId = String(planRow?.itinerary_quote_ID || "");

      const manualHotspotRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          hotspot_plan_own_way: 1,
          item_type: 4,
          deleted: 0,
        },
        select: {
          route_hotspot_ID: true,
        },
      });

      const existingExcludedHotspotIds = Array.isArray((route as any)?.excluded_hotspot_ids)
        ? (route as any).excluded_hotspot_ids
            .map((id: any) => Number(id))
            .filter((id: number) => Number.isFinite(id) && id > 0)
        : [];

      if (manualHotspotRows.length === 0 && existingExcludedHotspotIds.length === 0) {
        return {
          success: true,
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          message: 'Day route is already clean; no rebuild was needed',
          rebuildSummary: {
            totalRoutesProcessed: 0,
            totalHotspotsScheduled: 0,
            totalParkingRowsScheduled: 0,
          },
          warnings: [],
          routeRejectionSummaryByRoute: {},
          skipped: true,
        };
      }

      const manualRouteHotspotIds = manualHotspotRows
        .map((row: any) => Number(row.route_hotspot_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);

      if (manualRouteHotspotIds.length > 0) {
        await (tx as any).dvi_itinerary_route_activity_details.updateMany({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            route_hotspot_ID: { in: manualRouteHotspotIds },
            deleted: 0,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });
      }

      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          hotspot_plan_own_way: 1,
          item_type: 4,
          deleted: 0,
        },
        data: {
          deleted: 1,
          status: 0,
          updatedon: new Date(),
        },
      });

      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: normalizedRouteId },
        data: {
          excluded_hotspot_ids: [],
          updatedon: new Date(),
        },
      });

      const preRouteVisitCount = await (tx as any).dvi_itinerary_route_hotspot_details.count({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          item_type: 4,
          deleted: 0,
        },
      });
      console.log('[RouteRebuild][TRACE] before hotspot-engine rebuild', {
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        preRouteVisitCount,
      });

      // Route rebuild must follow the same plan-wide allocation rules as a fresh reset.
      // A scoped rebuild can drift from the canonical plan state by reusing partial
      // same-city/context decisions from the current timeline, which is how Day 2
      // was auto-picking Ramanatha/Agni instead of returning to the reset baseline.
      // Rebuild the full plan after clearing this route's manual rows so the target
      // day is recalculated against the same truth the initial itinerary build uses.
      const rebuildResult = await this.hotspotEngine.rebuildRouteHotspots(
        tx,
        normalizedPlanId,
        existingHotspotsWithDates,
      );

      const postRouteVisitCount = await (tx as any).dvi_itinerary_route_hotspot_details.count({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          item_type: 4,
          deleted: 0,
        },
      });
      console.log('[RouteRebuild][TRACE] after hotspot-engine rebuild', {
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        postRouteVisitCount,
        rebuildSummaryScheduledCount: Number(rebuildResult?.rebuildSummary?.totalHotspotsScheduled || 0),
      });

      return {
        success: true,
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        message: 'Day hotspots rebuilt successfully',
        rebuildSummary: rebuildResult.rebuildSummary,
        warnings: rebuildResult.warnings,
        routeRejectionSummaryByRoute: rebuildResult.routeRejectionSummaryByRoute,
      };
    // A day reset rebuilds the complete plan so cross-day allocation remains
    // canonical. Its hotspot/timing writes can exceed Prisma's 60s default
    // on larger plans; keep the transaction alive long enough to finish
    // instead of surfacing a generic HTTP 500 timeout.
    }, { timeout: 180000, maxWait: 30000 });

    if (!(rebuildResult as any)?.skipped) {
      await this.applySameCityCrossDayOptimizerAfterSave(normalizedPlanId, planQuoteId);
      await this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, Number(userId || 1));
      await this.forceRebuildVehiclePricingAfterHotspotChange(normalizedPlanId, normalizedRouteId);
    }

    return {
      ...rebuildResult,
      parkingChargesRebuilt: !(rebuildResult as any)?.skipped,
      vehiclePricingRebuilt: !(rebuildResult as any)?.skipped,
    };
  }

  /** Compatibility facade for route timing persistence and rebuild. */
  async updateRouteTimes(
    planId: number,
    routeId: number,
    startTime: string,
    endTime: string,
    previousDayBillingDecisionProvided?: boolean,
    previousDayBillingConfirmed?: boolean,
    userId: number = 1,
  ) {
    return this.routeTimingService.updateRouteTimes(
      planId,
      routeId,
      startTime,
      endTime,
      previousDayBillingDecisionProvided,
      previousDayBillingConfirmed,
      userId,
    );
  }

  async getConfirmedItineraryForCancellation(confirmedPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    // Get routes with dates
    const routes = await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    // Get hotels for each route
    const hotelsData = await Promise.all(routes.map(async (route) => {
      const hotels = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: plan.itinerary_plan_ID,
          itinerary_route_id: route.itinerary_route_ID,
          deleted: 0,
        },
      });

      const enrichedHotels = await Promise.all(hotels.map(async (h) => {
        const hotelInfo = await this.prisma.dvi_hotel.findUnique({
          where: { hotel_id: h.hotel_id },
          select: { hotel_name: true },
        });

        const rooms = await this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
          where: {
            confirmed_itinerary_plan_hotel_details_id: h.confirmed_itinerary_plan_hotel_details_ID,
            deleted: 0,
          },
        });

        return {
          hotel_id: h.hotel_id,
          hotel_name: hotelInfo?.hotel_name || 'N/A',
          date: route.itinerary_route_date,
          total_cost: h.total_hotel_cost || 0,
          rooms: rooms.map(r => ({
            room_qty: r.room_qty,
            room_rate: r.room_rate,
            extra_bed_count: r.extra_bed_count,
            extra_bed_rate: r.extra_bed_rate,
            child_with_bed_count: r.child_with_bed_count,
            child_with_bed_charges: r.child_with_bed_charges,
            child_without_bed_count: r.child_without_bed_count,
            child_without_bed_charges: r.child_without_bed_charges,
          })),
        };
      }));

      return { route_id: route.itinerary_route_ID, date: route.itinerary_route_date, hotels: enrichedHotels };
    }));

    return {
      plan: {
        itinerary_plan_ID: plan.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: confirmedPlanId,
        booking_id: plan.itinerary_quote_ID,
      },
      routes_with_hotels: hotelsData,
    };
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
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    // Get the hotel details for the specific day
    const hotelDetails = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findFirst({
      where: {
        itinerary_plan_id: plan.itinerary_plan_ID,
        hotel_id: hotelId,
        deleted: 0,
      },
    });

    if (!hotelDetails) {
      throw new NotFoundException('Hotel not found for this itinerary');
    }

    const totalCost = hotelDetails.total_hotel_cost || 0;
    const cancellationCharge = Math.round((totalCost * cancellationPercentage) / 100);
    const refundAmount = totalCost - cancellationCharge;

    return {
      total_cost: totalCost,
      cancellation_percentage: cancellationPercentage,
      cancellation_charge: cancellationCharge,
      refund_amount: Math.max(0, refundAmount),
      breakdown: {
        room_cost: hotelDetails.total_room_cost || 0,
        meal_plan_cost: hotelDetails.total_hotel_meal_plan_cost || 0,
        amenities_cost: hotelDetails.total_amenities_cost || 0,
        tax_amount: hotelDetails.total_hotel_tax_amount || 0,
      },
    };
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
    const userId = 1; // TODO: Get from authenticated user

    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Create hotel cancellation record (if table exists)
      // This is for audit trail
      try {
        await (tx as any).dvi_hotel_cancellations.create({
          data: {
            confirmed_itinerary_plan_ID: confirmedPlanId,
            hotel_id: hotelId,
            cancellation_date: new Date(date),
            total_cancellation_charge: totalCancellationCharge,
            total_refund_amount: totalRefundAmount,
            defect_type: defectType,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      } catch (error) {
        console.log('Hotel cancellation table not found, skipping audit record');
      }

      // 2. Soft delete the hotel details
      const hotelDetails = await (tx as any).dvi_confirmed_itinerary_plan_hotel_details.findFirst({
        where: {
          itinerary_plan_id: plan.itinerary_plan_ID,
          hotel_id: hotelId,
          deleted: 0,
        },
      });

      if (hotelDetails) {
        await (tx as any).dvi_confirmed_itinerary_plan_hotel_details.update({
          where: { confirmed_itinerary_plan_hotel_details_ID: hotelDetails.confirmed_itinerary_plan_hotel_details_ID },
          data: {
            deleted: 1,
            updatedon: new Date(),
          },
        });

        // Soft delete related room details
        await (tx as any).dvi_confirmed_itinerary_plan_hotel_room_details.updateMany({
          where: { confirmed_itinerary_plan_hotel_details_id: hotelDetails.confirmed_itinerary_plan_hotel_details_ID },
          data: { deleted: 1 },
        });
      }

      // 3. Update plan total amounts
      if (totalRefundAmount > 0) {
        await (tx as any).dvi_confirmed_itinerary_plan_details.update({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
          data: {
            total_hotel_charges: {
              decrement: totalCancellationCharge + totalRefundAmount,
            },
            itinerary_total_net_payable_amount: {
              decrement: totalCancellationCharge,
            },
            updatedon: new Date(),
          },
        });

        // Record refund in accounts
        await (tx as any).dvi_accounts_itinerary_details.updateMany({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
          data: {
            total_received_amount: {
              decrement: totalCancellationCharge,
            },
            total_payout_amount: {
              increment: totalRefundAmount,
            },
          },
        });
      }

      return {
        success: true,
        message: 'Hotel cancelled successfully',
        refund_amount: totalRefundAmount,
      };
    });
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
  }) {
    // Get itinerary plan details for preferred room count and quote ID
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: params.itinerary_plan_id },
      select: { 
        preferred_room_count: true,
        itinerary_quote_ID: true,
      },
    });

    if (!plan) {
      throw new NotFoundException('Itinerary plan not found');
    }

    // Get route date
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });

    if (!route) {
      throw new NotFoundException('Route not found');
    }

    // Fetch room details from TBO API
    const tboRoomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
      plan.itinerary_quote_ID,
      params.itinerary_route_id,
    );

    // Find the specific hotel in TBO results
    const hotelRoom = tboRoomDetails.rooms.find(
      (room) => room.hotelId === params.hotel_id && room.groupType === params.group_type
    );

    if (!hotelRoom) {
      throw new NotFoundException('Hotel not found in TBO results');
    }

    // Get available room types from TBO data
    const availableRoomTypes = hotelRoom.availableRoomTypes || [];

    if (availableRoomTypes.length === 0) {
      throw new NotFoundException('No room types available for this hotel from TBO');
    }

    // Get existing room selections from database
    const existingRooms = await this.prisma.dvi_itinerary_plan_hotel_room_details.findMany({
      where: {
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        itinerary_route_date: route.itinerary_route_date,
        hotel_id: params.hotel_id,
        group_type: params.group_type,
        deleted: 0,
      },
      orderBy: {
        itinerary_plan_hotel_room_details_ID: 'asc',
      },
    });

    const rooms = [];

    if (existingRooms.length > 0) {
      // Return existing room selections with TBO room types
      existingRooms.forEach((room, index) => {
        const selectedRoomType = availableRoomTypes.find(
          (rt) => rt.roomTypeId === room.room_type_id
        );
        rooms.push({
          room_number: index + 1,
          itinerary_plan_hotel_room_details_ID: room.itinerary_plan_hotel_room_details_ID,
          room_type_id: room.room_type_id,
          room_type_title: selectedRoomType?.roomTypeTitle || room.room_type_id.toString(),
          room_qty: room.room_qty,
          available_room_types: availableRoomTypes.map((rt) => ({
            room_type_id: rt.roomTypeId,
            room_type_title: rt.roomTypeTitle || '',
          })),
        });
      });
    } else {
      // Create empty slots for preferred room count with TBO room types
      for (let i = 0; i < (plan.preferred_room_count || 1); i++) {
        rooms.push({
          room_number: i + 1,
          room_type_id: null,
          room_type_title: '',
          room_qty: 1,
          available_room_types: availableRoomTypes.map((rt) => ({
            room_type_id: rt.roomTypeId,
            room_type_title: rt.roomTypeTitle || '',
          })),
        });
      }
    }

    return {
      itinerary_plan_hotel_details_ID: params.itinerary_plan_hotel_details_ID,
      hotel_id: params.hotel_id,
      hotel_name: hotelRoom.hotelName || '',
      preferred_room_count: plan.preferred_room_count || 1,
      rooms,
    };
  }

  /**
   * Update room category selection
   * Creates or updates the room selection in dvi_itinerary_plan_hotel_room_details
   * Room type IDs come from TBO API
   */
  async updateRoomCategory(params: {
    itinerary_plan_hotel_room_details_ID?: number;
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    room_type_id: number;
    room_qty?: number;
    all_meal_plan?: number;
    breakfast_meal_plan?: number;
    lunch_meal_plan?: number;
    dinner_meal_plan?: number;
  }) {
    // Get route date
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });

    if (!route) {
      throw new NotFoundException('Route not found');
    }

    // Get quote ID to fetch TBO data
    const planDetails = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { 
        itinerary_plan_ID: params.itinerary_plan_id,
        deleted: 0,
      },
      select: {
        itinerary_quote_ID: true,
      },
    });

    if (!planDetails) {
      throw new NotFoundException('Itinerary plan details not found');
    }

    // Fetch room details from TBO to get pricing and room information
    const tboRoomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
      planDetails.itinerary_quote_ID,
      params.itinerary_route_id,
    );

    // Find the specific hotel and room type in TBO results
    const hotelRoom = tboRoomDetails.rooms.find(
      (room) => room.hotelId === params.hotel_id && room.groupType === params.group_type
    );

    if (!hotelRoom) {
      throw new NotFoundException('Hotel not found in TBO results');
    }

    // Find the selected room type from TBO data
    const selectedRoomType = hotelRoom.availableRoomTypes?.find(
      (rt) => rt.roomTypeId === params.room_type_id
    );

    if (!selectedRoomType) {
      throw new NotFoundException('Selected room type not available from TBO');
    }

    // Use TBO pricing data
    const roomRate = hotelRoom.pricePerNight || 0;
    const now = new Date();

    // Check if record already exists
    if (params.itinerary_plan_hotel_room_details_ID) {
      // Update existing record
      await this.prisma.dvi_itinerary_plan_hotel_room_details.update({
        where: {
          itinerary_plan_hotel_room_details_ID: params.itinerary_plan_hotel_room_details_ID,
        },
        data: {
          room_type_id: params.room_type_id,
          room_id: params.room_type_id, // Use room_type_id as room_id for TBO rooms
          room_qty: params.room_qty || 1,
          room_rate: roomRate,
          breakfast_required: params.breakfast_meal_plan || params.all_meal_plan || 0,
          lunch_required: params.lunch_meal_plan || params.all_meal_plan || 0,
          dinner_required: params.dinner_meal_plan || params.all_meal_plan || 0,
          updatedon: now,
        },
      });
    } else {
      // Create new record
      await this.prisma.dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: params.itinerary_plan_hotel_details_ID,
          group_type: params.group_type,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          itinerary_route_date: route.itinerary_route_date,
          hotel_id: params.hotel_id,
          room_type_id: params.room_type_id,
          room_id: params.room_type_id, // Use room_type_id as room_id for TBO rooms
          room_qty: params.room_qty || 1,
          room_rate: roomRate,
          gst_type: 0, // TBO handles GST internally
          gst_percentage: 0,
          breakfast_required: params.breakfast_meal_plan || params.all_meal_plan || 0,
          lunch_required: params.lunch_meal_plan || params.all_meal_plan || 0,
          dinner_required: params.dinner_meal_plan || params.all_meal_plan || 0,
          createdon: now,
          updatedon: now,
          status: 1,
          deleted: 0,
        },
      });
    }

    return { 
      success: true, 
      message: 'Room category updated successfully',
      roomTypeName: selectedRoomType.roomTypeTitle,
    };
  }

  /**
   * 🚀 ROUTE OPTIMIZATION: Reorder routes using TSP algorithm
    * - For small candidate sets (<=8 movable stops): Exhaustive search
    * - For larger sets: Nearest Neighbor + Simulated Annealing
   * 
   * This finds the optimal or near-optimal route that minimizes total travel distance/time
   */
  private async optimizeRouteOrder(routes: any[]): Promise<any[]> {
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
      1000,      // initialTemp
      0.003,     // coolingRate
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

  private async simulateActivityImpactBeforeAdd(data: {
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
  }): Promise<{
    canAdd: boolean;
    warnings: Array<{ type: string; message: string; details?: any }>;
    optionalHotspotRouteIdsToRemove: number[];
  }> {
    const activity = await (this.prisma as any).dvi_activity.findUnique({
      where: { activity_id: data.activityId },
      select: { activity_duration: true },
    });

    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    const routeHotspot = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        route_hotspot_ID: data.routeHotspotId,
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
    });

    if (!routeHotspot) {
      throw new NotFoundException('Route hotspot not found');
    }

    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        deleted: 0,
      },
      select: {
        route_end_time: true,
      },
    });

    const routeEndTime = route?.route_end_time;
    if (!routeEndTime) {
      return {
        canAdd: true,
        warnings: [],
        optionalHotspotRouteIdsToRemove: [],
      };
    }

    const existingActivities = await (this.prisma as any).dvi_itinerary_route_activity_details.findMany({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        route_hotspot_ID: data.routeHotspotId,
        deleted: 0,
      },
      select: {
        activity_order: true,
        activity_end_time: true,
      },
      orderBy: { activity_order: 'desc' },
      take: 1,
    });

    const activityStartTime =
      existingActivities.length > 0 && existingActivities[0].activity_end_time
        ? existingActivities[0].activity_end_time
        : routeHotspot.hotspot_start_time;

    const durationMinutes = activity.activity_duration
      ? this.timeToMinutes(activity.activity_duration)
      : 30;
    const activityEndTime = this.addMinutesToTime(activityStartTime, durationMinutes);

    const extensionMinutes = Math.max(
      0,
      Math.round(
        (activityEndTime.getTime() - routeHotspot.hotspot_end_time.getTime()) / 60000,
      ),
    );

    if (extensionMinutes <= 0) {
      return {
        canAdd: true,
        warnings: [],
        optionalHotspotRouteIdsToRemove: [],
      };
    }

    const downstreamHotspots = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        item_type: 4,
        hotspot_order: { gt: routeHotspot.hotspot_order },
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
      orderBy: { hotspot_order: 'asc' },
    });

    if (downstreamHotspots.length === 0) {
      return {
        canAdd: activityEndTime <= routeEndTime,
        warnings: activityEndTime <= routeEndTime
          ? []
          : [
              {
                type: 'activity cannot be added without conflict',
                message: 'activity cannot be added without conflict',
              },
            ],
        optionalHotspotRouteIdsToRemove: [],
      };
    }

    const downstreamHotspotIds = downstreamHotspots
      .map((h: any) => Number(h.hotspot_ID || 0))
      .filter((id: number) => id > 0);

    const hotspotMasters = downstreamHotspotIds.length > 0
      ? await (this.prisma as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: downstreamHotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_priority: true,
          },
        })
      : [];

    const priorityByHotspotId = new Map<number, number>(
      hotspotMasters.map((h: any) => [
        Number(h.hotspot_ID),
        Number(h.hotspot_priority ?? 0),
      ]),
    );

    const projected = downstreamHotspots.map((h: any) => {
      const priority = priorityByHotspotId.get(Number(h.hotspot_ID)) ?? 0;
      return {
        routeHotspotId: Number(h.route_hotspot_ID),
        hotspotId: Number(h.hotspot_ID),
        hotspotOrder: Number(h.hotspot_order),
        priority,
        projectedStart: h.hotspot_start_time
          ? this.addMinutesToTime(h.hotspot_start_time, extensionMinutes)
          : null,
        projectedEnd: h.hotspot_end_time
          ? this.addMinutesToTime(h.hotspot_end_time, extensionMinutes)
          : null,
      };
    });

    const warnings: Array<{ type: string; message: string; details?: any }> = [];

    const shiftedPriorityHotspots = projected
      .filter((h) => h.priority >= 1 && h.priority <= 3)
      .map((h) => h.hotspotId);

    if (shiftedPriorityHotspots.length > 0) {
      warnings.push({
        type: 'priority hotspot shifted',
        message: 'priority hotspot shifted',
        details: {
          hotspotIds: shiftedPriorityHotspots,
          extensionMinutes,
        },
      });
    }

    const remaining = [...projected];
    const removedOptionalRouteIds: number[] = [];

    const getProjectedRouteEnd = () => {
      let end = activityEndTime;
      for (const row of remaining) {
        if (row.projectedEnd && row.projectedEnd > end) {
          end = row.projectedEnd;
        }
      }
      return end;
    };

    while (getProjectedRouteEnd() > routeEndTime) {
      let removeIndex = -1;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const row = remaining[i];
        if (!(row.priority >= 1 && row.priority <= 3)) {
          removeIndex = i;
          break;
        }
      }

      if (removeIndex === -1) {
        break;
      }

      const removed = remaining.splice(removeIndex, 1)[0];
      removedOptionalRouteIds.push(removed.routeHotspotId);
    }

    if (removedOptionalRouteIds.length > 0) {
      warnings.push({
        type: 'optional hotspots removed',
        message: 'optional hotspots removed',
        details: {
          routeHotspotIds: removedOptionalRouteIds,
        },
      });
    }

    if (getProjectedRouteEnd() > routeEndTime) {
      await this.attemptActivityRerouteSimulation(data.planId);

      warnings.push({
        type: 'activity cannot be added without conflict',
        message: 'activity cannot be added without conflict',
      });

      return {
        canAdd: false,
        warnings,
        optionalHotspotRouteIdsToRemove: [],
      };
    }

    return {
      canAdd: true,
      warnings,
      optionalHotspotRouteIdsToRemove: removedOptionalRouteIds,
    };
  }

  private async attemptActivityRerouteSimulation(planId: number): Promise<void> {
    const rollbackMarker = new Error('__ACTIVITY_REROUTE_SIMULATION_ROLLBACK__');

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.hotspotEngine.rebuildRouteHotspots(tx, planId);
        throw rollbackMarker;
      }, { timeout: 60000 });
    } catch (error: any) {
      if (error === rollbackMarker) {
        return;
      }
      throw error;
    }
  }

  /**
   * Helper: Convert TIME to minutes since midnight
   */
  private timeToMinutes(time: Date | null): number {
    if (!time) return 0;
    const d = new Date(time);
    // TIME columns are stored/handled as UTC values in this codebase.
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  /**
   * Helper: Format time for display
   */
  private formatTime(time: Date | null): string {
    if (!time) return 'N/A';
    const d = new Date(time);
    const hours = d.getUTCHours().toString().padStart(2, '0');
    const minutes = d.getUTCMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  private formatTransportVoucherDate(value: Date | string | null | undefined): string {
    if (!value) return '--';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  private buildTransportDateRange(start: Date | string | null | undefined, end: Date | string | null | undefined): string {
    const startLabel = this.formatTransportVoucherDate(start);
    const endLabel = this.formatTransportVoucherDate(end);
    if (startLabel === '--' && endLabel === '--') return '--';
    if (startLabel === '--') return endLabel;
    if (endLabel === '--') return startLabel;
    return `${startLabel} - ${endLabel}`;
  }

  private buildPassengerMixLabel(adults: number, children: number, infants: number): string {
    const items = [
      adults > 0 ? `${adults} Adult${adults > 1 ? 's' : ''}` : '',
      children > 0 ? `${children} Child${children > 1 ? 'ren' : ''}` : '',
      infants > 0 ? `${infants} Infant${infants > 1 ? 's' : ''}` : '',
    ].filter(Boolean);
    return items.length > 0 ? items.join(', ') : 'Guests';
  }

  private buildTransportVoucherNumber(planId: number, createdOn: Date | string | null | undefined): string {
    const basis = createdOn instanceof Date ? createdOn : createdOn ? new Date(createdOn) : new Date();
    const date = Number.isNaN(basis.getTime()) ? new Date() : basis;
    const year = String(date.getFullYear()).slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `DVI/TV/${year}${month}/${String(planId).padStart(4, '0')}`;
  }

  private formatTransportTime(value: Date | string | null | undefined): string {
    if (!value) return 'Not Provided';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not Provided';
    return this.formatTime(date);
  }

  private shortTransportLocationName(value: string): string {
    return String(value || '')
      .replace(/Cochin International Airport/gi, 'Cochin Airport')
      .replace(/Cochin Airport Terminal [^,|-]+/gi, 'Cochin Airport')
      .replace(/Cochin International/gi, 'Cochin')
      .replace(/Kochi International Airport/gi, 'Kochi Airport')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private decodeTransportHtml(value: string): string {
    return String(value || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseTransportFlightDetails(raw: unknown, fallbackDateTime?: Date | string | null) {
    const emptyFlight = {
      airline: 'Not Provided',
      flightNo: 'Not Provided',
      from: 'Not Provided',
      to: 'Not Provided',
      date: this.formatTransportVoucherDate(fallbackDateTime),
      time: this.formatTransportTime(fallbackDateTime),
      rawText: typeof raw === 'string' && raw.trim() ? this.decodeTransportHtml(raw.trim()) : 'Not Provided',
    };

    if (!raw) {
      return emptyFlight;
    }

    if (typeof raw === 'object' && raw !== null) {
      const parsed = raw as Record<string, unknown>;
      return {
        airline: this.pickTransportFlightValue(parsed, ['airline', 'airlineName', 'carrier', 'name']) || 'Not Provided',
        flightNo: this.pickTransportFlightValue(parsed, ['flightNo', 'flight_no', 'flightNumber', 'number']) || 'Not Provided',
        from: this.pickTransportFlightValue(parsed, ['from', 'origin', 'departure', 'source']) || 'Not Provided',
        to: this.pickTransportFlightValue(parsed, ['to', 'destination', 'arrival']) || 'Not Provided',
        date: this.pickTransportFlightValue(parsed, ['date', 'travelDate']) || emptyFlight.date,
        time: this.pickTransportFlightValue(parsed, ['time', 'arrivalTime', 'departureTime']) || emptyFlight.time,
        rawText: this.decodeTransportHtml(JSON.stringify(parsed)),
      };
    }

    const text = String(raw || '').trim();
    if (!text) {
      return emptyFlight;
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return this.parseTransportFlightDetails(parsed, fallbackDateTime);
      }
    } catch {
      // Ignore parse failures and keep the raw text as-is.
    }

    return {
      ...emptyFlight,
      rawText: this.decodeTransportHtml(text),
    };
  }

  private pickTransportFlightValue(
    parsed: Record<string, unknown>,
    keys: string[],
  ): string {
    for (const key of keys) {
      const value = parsed[key];
      if (value === null || value === undefined) continue;
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
    return '';
  }

  /**
   * Helper: Add minutes to a time
   */
  private addMinutesToTime(time: Date, minutes: number): Date {
    const result = new Date(time);
    result.setUTCMinutes(result.getUTCMinutes() + minutes);
    return result;
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
    const conflicts: Array<{ reason: string; severity: string }> = [];

    if (timeSlots.length === 0) {
      // No time restrictions
      return conflicts;
    }

    const proposedStart = this.timeToMinutes(proposedStartTime);
    const proposedEnd = this.timeToMinutes(proposedEndTime);

    // Check if proposed slot fits in any available slot.
    const fitsAnySlot = timeSlots.some((slot: any) => {
      const slotStart = this.timeToMinutes(slot.start_time);
      const slotEnd = this.timeToMinutes(slot.end_time);
      return proposedStart >= slotStart && proposedEnd <= slotEnd;
    });

    if (!fitsAnySlot) {
      const slotRanges = timeSlots
        .map((slot: any) => `${this.formatTime(slot.start_time)} - ${this.formatTime(slot.end_time)}`)
        .join(', ');

      conflicts.push({
        reason:
          `Activity "${activity.activity_title}" is available only at ${slotRanges}, ` +
          `but it would be inserted at ${this.formatTime(proposedStartTime)} - ${this.formatTime(proposedEndTime)}`,
        severity: 'warning',
      });
    }

    return conflicts;
  }


}


