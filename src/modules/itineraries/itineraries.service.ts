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
    private readonly smartActivityService: ItinerarySmartActivityService = new ItinerarySmartActivityService(prisma),
    private readonly hotspotWorkflowService: ItineraryHotspotWorkflowService = new ItineraryHotspotWorkflowService(
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
  ) {
    this.vehicleBuildService.setVehicleVendorSelector((data) => this.selectVehicleVendor(data));
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
      resolveRouteSourceEndpoint: (...args) => (this.resolveRouteSourceEndpoint as any)(...args),
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
    const userId = 1;
    const normalizedPlanId = Number(planId || 0);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedHotspotParam = Number(hotspotId || 0);

    const rebuildResult = await this.prisma.$transaction(async (tx) => {
      // Accept either route_hotspot_ID or hotspot_ID from caller and resolve to master hotspot_ID.
      let hotspotRecord = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          route_hotspot_ID: normalizedHotspotParam,
          deleted: 0,
        },
      });

      if (!hotspotRecord) {
        hotspotRecord = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            hotspot_ID: normalizedHotspotParam,
            item_type: 4,
            deleted: 0,
          },
          orderBy: [{ hotspot_order: 'asc' }, { route_hotspot_ID: 'asc' }],
        });
      }

      if (!hotspotRecord) {
        throw new BadRequestException('Hotspot not found');
      }

      const actualHotspotId = Number(hotspotRecord.hotspot_ID || 0);

      // Delete all timeline rows tied to this hotspot in the route so it cannot survive via pair rows.
      const routeRowsForHotspot = actualHotspotId > 0
        ? await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
            where: {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              hotspot_ID: actualHotspotId,
              deleted: 0,
            },
            select: { route_hotspot_ID: true },
          })
        : [];

      const routeHotspotIdsToDelete = routeRowsForHotspot
        .map((r: any) => Number(r.route_hotspot_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);

      if (routeHotspotIdsToDelete.length > 0) {
        await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            route_hotspot_ID: { in: routeHotspotIdsToDelete },
          },
        });
      }

      const deleted = await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
        where: routeHotspotIdsToDelete.length > 0
          ? {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              route_hotspot_ID: { in: routeHotspotIdsToDelete },
            }
          : {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              route_hotspot_ID: normalizedHotspotParam,
            },
      });

      if (deleted.count === 0) {
        throw new BadRequestException('Hotspot not found');
      }

      if (actualHotspotId > 0) {
        console.log(`[deleteHotspot] Excluding hotspotId ${actualHotspotId} only for route ${normalizedRouteId}`);

        const targetRoute = await (tx as any).dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            deleted: 0,
          },
          select: {
            itinerary_route_ID: true,
            excluded_hotspot_ids: true,
          },
        });

        if (targetRoute) {
          const current = Array.isArray(targetRoute.excluded_hotspot_ids)
            ? targetRoute.excluded_hotspot_ids
                .map((id: any) => Number(id))
                .filter((id: number) => Number.isFinite(id) && id > 0)
            : [];

          if (!current.includes(actualHotspotId)) {
            await (tx as any).dvi_itinerary_route_details.update({
              where: {
                itinerary_route_ID: Number(targetRoute.itinerary_route_ID),
              },
              data: {
                excluded_hotspot_ids: [...current, actualHotspotId],
                updatedon: new Date(),
              },
            });
          }
        }
      }

      // Trigger a full rebuild of the hotspots for this plan
      // This ensures travel times and hotel arrival are recalculated after deletion
      return await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId);
    }, { timeout: 60000 });

        // Rebuild parking charges after deletion
    await this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, userId);

    // Force full vehicle pricing rebuild from current rebuilt hotspot timeline.
    await this.forceRebuildVehiclePricingAfterHotspotChange(normalizedPlanId, normalizedRouteId);

    return {
      success: true,
      message: 'Hotspot deleted and vehicle pricing rebuilt from updated route timeline',
      parkingChargesRebuilt: true,
      vehiclePricingRebuilt: true,
      rebuildSummary: rebuildResult.rebuildSummary,
      warnings: rebuildResult.warnings,
    };
  }

  /**
   * Get available activities for a hotspot location
   */
async getAvailableActivities(hotspotId: number, planId?: number, routeId?: number) {
  const activities = await (this.prisma as any).dvi_activity.findMany({
    where: {
      hotspot_id: hotspotId,
      deleted: 0,
      status: 1,
    },
    select: {
      activity_id: true,
      activity_title: true,
      activity_description: true,
      activity_duration: true,
      max_allowed_person_count: true,
    },
    orderBy: { activity_title: 'asc' },
  });

  const activitiesWithSlots = await Promise.all(
    activities.map(async (a: any) => {
      const [timeSlots, pricing] = await Promise.all([
        (this.prisma as any).dvi_activity_time_slot_details.findMany({
          where: {
            activity_id: a.activity_id,
            deleted: 0,
            status: 1,
          },
          select: {
            activity_time_slot_ID: true,
            time_slot_type: true,
            special_date: true,
            start_time: true,
            end_time: true,
          },
          orderBy: { start_time: 'asc' },
        }),
        this.calculateActivityPlanPricing({
          planId,
          routeId,
          activityId: Number(a.activity_id || 0),
          hotspotId,
        }),
      ]);

      return {
        id: a.activity_id,
        title: a.activity_title || '',
        description: a.activity_description || '',
        duration: a.activity_duration || null,
        maxPersons: a.max_allowed_person_count || 0,

        pricingUnitType: pricing.pricingUnitType,
        priceUnitLabel: pricing.priceUnitLabel,
        nationalityType: pricing.nationalityType,
        adultCount: pricing.adults,
        childCount: pricing.children,
        costAdult: pricing.adultRate,
        costChild: pricing.childRate,
        unitCost: pricing.unitRate,
        totalAmount: pricing.totalAmount,
        totalPrice: pricing.totalAmount,
        priceDate: pricing.priceDate,

        timeSlots: timeSlots.map((ts: any) => ({
          id: ts.activity_time_slot_ID,
          type: ts.time_slot_type,
          specialDate: ts.special_date,
          startTime: ts.start_time,
          endTime: ts.end_time,
        })),
      };
    }),
  );

  return activitiesWithSlots;
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

    private buildPluckCardData(plan: any, customer: any, settings: any) {
      return {
        guestName: customer
          ? `${String(customer.customer_salutation || '').trim()} ${String(customer.customer_name || '').trim()}`.trim()
          : 'N/A',
        contactNo: String(customer?.primary_contact_no || 'N/A'),
        arrivalLocation: String(customer?.arrival_place || plan?.arrival_location || ''),
        arrivalDateTime: customer?.arrival_date_and_time || plan?.trip_start_date_and_time || null,
        arrivalFlightDetails: String(customer?.arrival_flight_details || ''),
        departureLocation: String(customer?.departure_place || plan?.departure_location || ''),
        departureDateTime: customer?.departure_date_and_time || plan?.trip_end_date_and_time || null,
        departureFlightDetails: String(customer?.departure_flight_details || ''),
        companyName: String(settings?.company_name || 'DVI'),
        companyLogoUrl: settings?.company_logo ? `/uploads/logo/${String(settings.company_logo)}` : '',
      };
    }

    private getStateNameFromGstCode(gstNo?: string | null): string {
      const code = String(gstNo || '').trim().slice(0, 2);
      const labels: Record<string, string> = {
        '01': 'Jammu and Kashmir',
        '02': 'Himachal Pradesh',
        '03': 'Punjab',
        '04': 'Chandigarh',
        '05': 'Uttarakhand',
        '06': 'Haryana',
        '07': 'Delhi',
        '08': 'Rajasthan',
        '09': 'Uttar Pradesh',
        '10': 'Bihar',
        '11': 'Sikkim',
        '12': 'Arunachal Pradesh',
        '13': 'Nagaland',
        '14': 'Manipur',
        '15': 'Mizoram',
        '16': 'Tripura',
        '17': 'Meghalaya',
        '18': 'Assam',
        '19': 'West Bengal',
        '20': 'Jharkhand',
        '21': 'Odisha',
        '22': 'Chhattisgarh',
        '23': 'Madhya Pradesh',
        '24': 'Gujarat',
        '26': 'Dadra and Nagar Haveli and Daman and Diu',
        '27': 'Maharashtra',
        '28': 'Andhra Pradesh',
        '29': 'Karnataka',
        '30': 'Goa',
        '31': 'Lakshadweep',
        '32': 'Kerala',
        '33': 'Tamil Nadu',
        '34': 'Puducherry',
        '35': 'Andaman and Nicobar Islands',
        '36': 'Telangana',
        '37': 'Andhra Pradesh',
        '38': 'Ladakh',
      };
      return labels[code] || '';
    }

    async getPluckCardData(itineraryPlanId: number) {
      const [plan, customer, settings] = await Promise.all([
        this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
        }),
        this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
        }),
        this.prisma.dvi_global_settings.findFirst({
          where: { status: 1, deleted: 0 },
        }),
      ]);

      if (!plan) {
        throw new NotFoundException('Confirmed itinerary plan not found');
      }

      return this.buildPluckCardData(plan, customer, settings);
    }
  
    async getPluckCardDataByConfirmedId(confirmedPlanId: number) {
      const [plan, customer, settings] = await Promise.all([
        this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
        }),
        this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId, primary_customer: 1, deleted: 0 },
        }),
        this.prisma.dvi_global_settings.findFirst({
          where: { status: 1, deleted: 0 },
        }),
      ]);

      if (!plan) {
        throw new NotFoundException('Confirmed itinerary plan not found');
      }

      return this.buildPluckCardData(plan, customer, settings);
    }
  
    async getInvoiceData(itineraryPlanId: number) {
      const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
      });
  
      if (!plan) {
        throw new NotFoundException('Confirmed itinerary plan not found');
      }

      const [
        agent,
        agentConfig,
        customer,
        settings,
        accounts,
        hotels,
        vehicles,
        activities,
        guides,
        hotspots,
        travelExpert,
      ] = await Promise.all([
        this.prisma.dvi_agent.findUnique({
          where: { agent_ID: plan.agent_id },
        }),
        this.prisma.dvi_agent_configuration.findFirst({
          where: { agent_id: plan.agent_id, deleted: 0, status: 1 },
        }),
        this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
        }),
        this.prisma.dvi_global_settings.findFirst({
          where: { status: 1, deleted: 0 },
        }),
        this.prisma.dvi_accounts_itinerary_details.findFirst({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
        }),
        this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
          where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1 },
          orderBy: [{ itinerary_route_date: 'asc' }, { confirmed_itinerary_plan_hotel_details_ID: 'asc' }],
        }),
        this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
          where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1, itineary_plan_assigned_status: 1 },
          orderBy: [{ confirmed_itinerary_plan_vendor_eligible_ID: 'asc' }],
        }),
        this.prisma.dvi_accounts_itinerary_activity_details.findMany({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1 },
        }),
        this.prisma.dvi_accounts_itinerary_guide_details.findMany({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1 },
        }),
        this.prisma.dvi_accounts_itinerary_hotspot_details.findMany({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1 },
        }),
        plan.agent_id
          ? (async () => {
              const currentAgent = await this.prisma.dvi_agent.findUnique({
                where: { agent_ID: plan.agent_id },
                select: { travel_expert_id: true },
              });
              if (!currentAgent?.travel_expert_id) return null;
              return this.prisma.dvi_staff_details.findFirst({
                where: { staff_id: currentAgent.travel_expert_id, deleted: 0 },
              });
            })()
          : Promise.resolve(null),
      ]);

      const hotelIds = Array.from(new Set(hotels.map((row: any) => Number(row.hotel_id || 0)).filter((id) => id > 0)));
      const vendorIds = Array.from(new Set(vehicles.map((row: any) => Number(row.vendor_id || 0)).filter((id) => id > 0)));
      const vehicleTypeIds = Array.from(
        new Set(vehicles.map((row: any) => Number(row.vehicle_type_id || 0)).filter((id) => id > 0)),
      );

      const [hotelMasters, vendorMasters, vehicleTypeMasters] = await Promise.all([
        hotelIds.length
          ? this.prisma.dvi_hotel.findMany({
              where: { hotel_id: { in: hotelIds } as any },
              select: { hotel_id: true, hotel_name: true },
            })
          : Promise.resolve([] as any[]),
        vendorIds.length
          ? this.prisma.dvi_vendor_details.findMany({
              where: { vendor_id: { in: vendorIds } as any },
              select: { vendor_id: true, vendor_name: true },
            })
          : Promise.resolve([] as any[]),
        vehicleTypeIds.length
          ? this.prisma.dvi_vehicle_type.findMany({
              where: { vehicle_type_id: { in: vehicleTypeIds } as any },
              select: { vehicle_type_id: true, vehicle_type_title: true },
            })
          : Promise.resolve([] as any[]),
      ]);

      const hotelNameById = new Map<number, string>();
      hotelMasters.forEach((row: any) => hotelNameById.set(Number(row.hotel_id), String(row.hotel_name || 'Hotel')));
      const vendorNameById = new Map<number, string>();
      vendorMasters.forEach((row: any) => vendorNameById.set(Number(row.vendor_id), String(row.vendor_name || 'Vendor')));
      const vehicleTypeById = new Map<number, string>();
      vehicleTypeMasters.forEach((row: any) =>
        vehicleTypeById.set(Number(row.vehicle_type_id), String(row.vehicle_type_title || 'Vehicle')),
      );

      const hotelBaseAmount = hotels.reduce((sum: number, row: any) => sum + Number(row.total_hotel_cost || 0), 0);
      const hotelMarginAmount = hotels.reduce((sum: number, row: any) => sum + Number(row.hotel_margin_rate || 0), 0);
      const hotelMarginTaxAmount = hotels.reduce(
        (sum: number, row: any) => sum + Number(row.hotel_margin_rate_tax_amt || 0),
        0,
      );
      const vehicleMarginAmount = vehicles.reduce((sum: number, row: any) => sum + Number(row.vendor_margin_amount || 0), 0);
      const vehicleTaxAmount = vehicles.reduce(
        (sum: number, row: any) =>
          sum + Number(row.vendor_margin_gst_amount || 0) + Number(row.vehicle_gst_amount || 0),
        0,
      );
      const serviceBaseAmount =
        Number(plan.itinerary_agent_margin_charges || 0) +
        guides.reduce((sum: number, row: any) => sum + Number(row.total_payable || 0), 0) +
        hotspots.reduce((sum: number, row: any) => sum + Number(row.total_payable || 0), 0) +
        activities.reduce((sum: number, row: any) => sum + Number(row.total_payable || 0), 0);
      const serviceTaxAmount = serviceBaseAmount > 0
        ? (serviceBaseAmount * Number(plan.itinerary_agent_margin_gst_percentage || 0)) / 100
        : 0;

      const companyGst = String(settings?.company_gstin_no || '');
      const buyerGst = String(agentConfig?.invoice_gstin_no || '');
      const isSameState = companyGst.slice(0, 2) === buyerGst.slice(0, 2);
      const gstLabel = isSameState ? 'CGST, SGST' : 'IGST';
      const couponDiscount = Number(plan.itinerary_total_coupon_discount_amount || 0);
      const totalAmount = Number(
        accounts?.total_billed_amount ||
          plan.itinerary_total_net_payable_amount ||
          hotelBaseAmount + hotelMarginAmount + hotelMarginTaxAmount + vehicleMarginAmount + vehicleTaxAmount + serviceBaseAmount + serviceTaxAmount - couponDiscount,
      );

      return {
        meta: {
          invoiceNo: String(plan.itinerary_quote_ID || ''),
          invoiceDate: plan.trip_start_date_and_time,
          deliveryNote: String(plan.itinerary_quote_ID || ''),
          travelExpertName: String(travelExpert?.staff_name || ''),
          itineraryPreference: Number(plan.itinerary_preference || 0),
          gstLabel,
        },
        company: {
          name: String(settings?.company_name || ''),
          address: String(settings?.company_address || ''),
          pincode: String(settings?.company_pincode || ''),
          gstNo: companyGst,
          gstStateCode: companyGst.slice(0, 2),
          gstStateName: this.getStateNameFromGstCode(companyGst),
          cin: String(settings?.company_cin || ''),
          email: String(settings?.company_email_id || ''),
          contactNo: String(settings?.company_contact_no || ''),
          logoUrl: settings?.company_logo ? `/uploads/logo/${String(settings.company_logo)}` : '',
          bank: {
            accountName: String(settings?.bank_acc_holder_name || ''),
            accountNo: String(settings?.bank_acc_no || ''),
            branchName: String(settings?.branch_name || ''),
            ifscCode: String(settings?.bank_ifsc_code || ''),
            bankName: String(settings?.bank_name || ''),
          },
        },
        buyer: {
          companyName: String(agentConfig?.company_name || agent?.agent_name || ''),
          address: String(agentConfig?.invoice_address || ''),
          gstNo: buyerGst,
          gstStateCode: buyerGst.slice(0, 2),
          gstStateName: this.getStateNameFromGstCode(buyerGst),
          panNo: String(agentConfig?.invoice_pan_no || ''),
          agentName: `${String(agent?.agent_name || '').trim()} ${String(agent?.agent_lastname || '').trim()}`.trim(),
          email: String(agent?.agent_email_id || ''),
        },
        guest: {
          name: customer
            ? `${String(customer.customer_salutation || '').trim()} ${String(customer.customer_name || '').trim()}`.trim()
            : 'N/A',
          contactNo: String(customer?.primary_contact_no || ''),
          arrivalPlace: String(customer?.arrival_place || plan.arrival_location || ''),
          arrivalDateTime: customer?.arrival_date_and_time || null,
          departurePlace: String(customer?.departure_place || plan.departure_location || ''),
          departureDateTime: customer?.departure_date_and_time || null,
        },
        itinerary: {
          quoteId: String(plan.itinerary_quote_ID || ''),
          tripStartDateTime: plan.trip_start_date_and_time,
          tripEndDateTime: plan.trip_end_date_and_time,
          routeSummary: `${String(plan.arrival_location || '')} to ${String(plan.departure_location || '')}`.trim(),
        },
        lineItems: [
          {
            key: 'hotel_base',
            serialNo: 1,
            title: 'HOTEL BOOKING CHARGES ONLY A/C (GST PAID)',
            hsnSac: String(settings?.hotel_hsn || ''),
            amount: hotelBaseAmount,
            notes: hotels.map((row: any) => ({
              label: `${row.itinerary_route_date ? new Date(row.itinerary_route_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''} - ${String(row.itinerary_route_location || '').trim()} - ${hotelNameById.get(Number(row.hotel_id || 0)) || 'Hotel'}`.replace(/^\s*-\s*/, ''),
            })),
          },
          {
            key: 'hotel_margin',
            serialNo: '',
            title: `${gstLabel} SALES @ ${Number(hotels[0]?.hotel_margin_gst_percentage || 0)}% ACCOMMODATION SERVICES`,
            hsnSac: '',
            amount: hotelMarginAmount,
            notes: [],
          },
          {
            key: 'hotel_tax',
            serialNo: '',
            title: isSameState
              ? `OUTPUT CGST + SGST @ ${Number(hotels[0]?.hotel_margin_gst_percentage || 0) / 2}%`
              : `OUTPUT IGST @ ${Number(hotels[0]?.hotel_margin_gst_percentage || 0)}%`,
            hsnSac: '',
            amount: hotelMarginTaxAmount,
            notes: [],
          },
          ...(vehicles.length > 0
            ? [
                {
                  key: 'vehicle_margin',
                  serialNo: 2,
                  title: `${gstLabel} SALES @ ${Number(vehicles[0]?.vendor_margin_gst_percentage || 0)}% TRANSPORTATION SERVICES`,
                  hsnSac: String(settings?.vehicle_hsn || ''),
                  amount: vehicleMarginAmount,
                  notes: vehicles.map((row: any) => ({
                    label: `${vendorNameById.get(Number(row.vendor_id || 0)) || 'Vendor'} - ${vehicleTypeById.get(Number(row.vehicle_type_id || 0)) || 'Vehicle'}${row.vehicle_orign ? ` - ${String(row.vehicle_orign).trim()}` : ''}`,
                  })),
                },
                {
                  key: 'vehicle_tax',
                  serialNo: '',
                  title: isSameState
                    ? `OUTPUT CGST + SGST @ ${Number(vehicles[0]?.vendor_margin_gst_percentage || 0) / 2}%`
                    : `OUTPUT IGST @ ${Number(vehicles[0]?.vendor_margin_gst_percentage || 0)}%`,
                  hsnSac: '',
                  amount: vehicleTaxAmount,
                  notes: [],
                },
              ]
            : []),
          ...(serviceBaseAmount > 0
            ? [
                {
                  key: 'service_base',
                  serialNo: vehicles.length > 0 ? 3 : 2,
                  title: 'TOTAL GUIDE / HOTSPOT / ACTIVITY / SERVICE COMPONENTS',
                  hsnSac: String(settings?.service_component_hsn || ''),
                  amount: serviceBaseAmount,
                  notes: [],
                },
                {
                  key: 'service_tax',
                  serialNo: '',
                  title: isSameState
                    ? `OUTPUT CGST + SGST @ ${Number(plan.itinerary_agent_margin_gst_percentage || 0) / 2}%`
                    : `OUTPUT IGST @ ${Number(plan.itinerary_agent_margin_gst_percentage || 0)}%`,
                  hsnSac: '',
                  amount: serviceTaxAmount,
                  notes: [],
                },
              ]
            : []),
        ].filter((item: any) => Number(item.amount || 0) > 0),
        totals: {
          couponDiscount,
          totalAmount,
        },
        declaration:
          'The hotel bill charges are collected on behalf of the hotel hence the GST is payable by the hotel directly to the government.',
      };
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

  private validateResolvedLowPriorityTimeline(
    timeline: any[],
    plannedRemovals: Array<any>,
    dayEndMinutes: number,
  ): string | null {
    const rows = Array.isArray(timeline) ? timeline : [];
    const removals = Array.isArray(plannedRemovals) ? plannedRemovals : [];
    if (rows.length === 0) return 'Resolved timeline is empty.';

    const removedIds = new Set<number>(
      removals
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const removedNames = new Set<string>(
      removals
        .map((row: any) => String(row?.name || row?.hotspotName || '').trim().toLowerCase())
        .filter(Boolean),
    );

    const isAttractionRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isTravelRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };
    const isHotelRow = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || type === 'checkin' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel') || text.includes('check-in at ');
    };

    // Debug: Log what we're checking
    const timelineHotspotIds = rows
      .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
      .filter((id: number) => id > 0);
    const planDuplicates = timelineHotspotIds.filter((id: number) => removedIds.has(id));
    
    if (planDuplicates.length > 0) {
      console.error('[validateResolvedLowPriorityTimeline] FAIL: Removed hotspot IDs still in timeline:', {
        removedIds: Array.from(removedIds),
        duplicateIds: planDuplicates,
        timelineHotspotIds,
        timelineLength: rows.length,
      });
      console.error('[validateResolvedLowPriorityTimeline] Matching rows:');
      for (const row of rows) {
        const rowId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
        if (rowId > 0 && removedIds.has(rowId)) {
          console.error(`  - Row type=${row?.type} id=${rowId} text="${row?.text}" toName="${row?.toName}"`);
        }
      }
    }

    for (const row of rows) {
      const rowId = Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || 0);
      const rowText = String(row?.text || row?.name || row?.toName || row?.to || '').trim().toLowerCase();
      if (rowId > 0 && removedIds.has(rowId)) return `Resolved timeline still contains removed hotspot id ${rowId}.`;
      for (const removedName of removedNames) {
        if (removedName && rowText.includes(removedName)) {
          return `Resolved timeline still contains removed hotspot name ${removedName}.`;
        }
      }
      if (isTravelRow(row)) {
        const toName = String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();
        for (const removedName of removedNames) {
          if (removedName && toName.includes(removedName)) {
            return `Travel row still points to removed hotspot ${removedName}.`;
          }
        }
      }
    }

    const attractionIndices = rows
      .map((row: any, index: number) => ({ row, index }))
      .filter((entry: any) => isAttractionRow(entry.row));

    for (let i = 1; i < attractionIndices.length; i += 1) {
      const attractionIndex = attractionIndices[i].index;
      const prevRow = rows[attractionIndex - 1];
      if (!prevRow || !isTravelRow(prevRow)) {
        return `Attraction at index ${attractionIndex} is not preceded by a travel row.`;
      }
    }

    const sourceRows = Array.isArray(rows) ? rows : [];
    const sourceHasHotelRow = sourceRows.some((row: any) => isHotelRow(row));
    const hotelIndex = rows.findIndex((row: any) => isHotelRow(row));

    if (sourceHasHotelRow && hotelIndex < 0) {
      return 'Resolved timeline has no hotel/check-in row.';
    }

    if (hotelIndex >= 0) {
      const hasRowsAfterHotel = rows.slice(hotelIndex + 1).some((row: any) => {
        const type = String(row?.type || '').toLowerCase();
        return type !== '';
      });
      if (hasRowsAfterHotel) return 'Hotel/check-in row is not last in resolved timeline.';
    }

    const finalEnd = rows.reduce((max: number, row: any) => {
      const end = this.parseSegmentEndMinutes(row);
      return end == null ? max : Math.max(max, end);
    }, 0);
    if (finalEnd > dayEndMinutes) {
      return `Resolved timeline still exceeds day end by ${finalEnd - dayEndMinutes} minutes.`;
    }

    const orderSequential = rows.every((row: any, index: number) => Number(row?.matrixPreviewOrder ?? row?.previewOrder) === index);
    if (!orderSequential) return 'matrixPreviewOrder/previewOrder is not sequential.';

    return null;
  }

  private minutesToTimeRange(startMinutes: number, endMinutes: number): string {
    const toDisplay = (minutes: number): string => {
      const total = Math.max(0, Math.floor(Number(minutes || 0)));
      const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
      const mm = String(total % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    };

    return `${toDisplay(startMinutes)} - ${toDisplay(endMinutes)}`;
  }

  private sanitizeResolvedLowPriorityTimeline(
    timeline: any[],
    plannedRemovals: Array<any>,
  ): any[] {
    const source = Array.isArray(timeline) ? timeline : [];
    const removals = Array.isArray(plannedRemovals) ? plannedRemovals : [];

    const removedIds = new Set<number>(
      removals
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const removedNames = new Set<string>(
      removals
        .map((row: any) => String(row?.name || row?.hotspotName || '').trim().toLowerCase())
        .filter(Boolean),
    );

    return source
      .filter((row: any) => {
        const rowId = Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || 0);
        const rowText = String(row?.text || row?.name || row?.toName || row?.to || '').trim().toLowerCase();

        if (rowId > 0 && removedIds.has(rowId)) return false;

        for (const removedName of removedNames) {
          if (removedName && rowText.includes(removedName)) return false;
        }

        return true;
      })
      .map((row: any, idx: number) => ({
        ...row,
        previewOrder: idx,
        matrixPreviewOrder: idx,
      }));
  }

  private pruneRemovedHotspotsFromManualPreviewTimeline(
    timeline: any[],
    removedHotspots: any[],
  ): any[] {
    if (!Array.isArray(timeline) || timeline.length === 0) return [];

    const removedRows = Array.isArray(removedHotspots) ? removedHotspots : [];
    const removedIds = new Set(
      removedRows
        .map((row: any) => Number(row?.id ?? row?.hotspotId ?? row?.hotspot_ID ?? 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    if (removedIds.size === 0 && removedRows.length === 0) return timeline;

    return timeline.filter((row: any) => {
      const rowHotspotId = Number(
        row?.hotspotId
        ?? row?.hotspot_ID
        ?? row?.locationId
        ?? 0,
      );

      if (removedIds.has(rowHotspotId)) {
        return false;
      }

      const toHotspotId = Number(
        row?.toHotspotId
        ?? row?.to_location_id
        ?? 0,
      );

      if (removedIds.has(toHotspotId)) {
        return false;
      }

      const toName = String(row?.toName || row?.to || row?.displayToName || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();

      return !removedRows.some((removed: any) => {
        const removedName = String(removed?.name || '').toLowerCase().trim();
        if (!removedName) return false;

        return (
          toName.includes(removedName)
          || text.includes(`travel to ${removedName}`)
          || text === removedName
        );
      });
    });
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

  private isRetryableManualPreviewTransactionError(error: any): boolean {
    const code = String(error?.code || '').trim().toUpperCase();
    const message = String(error?.message || '').toLowerCase();

    return (
      code === 'P2034'
      || message.includes('write conflict')
      || message.includes('deadlock')
    );
  }

  private normalizeExactAnchorManualInsertionFit(params: {
    manualInsertionFit: any;
    anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
    afterHotspotId?: number | null;
    beforeHotspotId?: number | null;
    anchorLabel?: string | null;
  }): any {
    const fit = params.manualInsertionFit || {};
    const requestedSlot = fit.requestedSlot || {};

    const exactSlot = {
      ...requestedSlot,
      fromHotspotId: Number(params.afterHotspotId || 0) || null,
      toHotspotId: Number(params.beforeHotspotId || 0) || null,
      source: 'EXACT_ANCHOR',
      chosenSlotSource: 'EXACT_ANCHOR',
      selectedAsBest: true,
      attempted: true,
      exactAnchor: true,
      anchorIntent: params.anchorIntent || null,
      label: params.anchorLabel || requestedSlot.label || 'Selected Fit Here position',
      displayLabel: params.anchorLabel || requestedSlot.displayLabel || 'Selected Fit Here position',
      shortLabel: params.anchorLabel || requestedSlot.shortLabel || 'Selected Fit Here position',
    };

    return {
      ...fit,
      requestedSlot: exactSlot,
      chosenSlot: exactSlot,
      bestSlot: exactSlot,
      chosenSlotSource: 'EXACT_ANCHOR',
    };
  }

  private timelineContainsPlannedRemovalRows(
    timeline: any[],
    plannedRemovals: Array<any>,
  ): boolean {
    const source = Array.isArray(timeline) ? timeline : [];
    const removals = Array.isArray(plannedRemovals) ? plannedRemovals : [];
    if (source.length === 0 || removals.length === 0) return false;

    const removedIds = new Set<number>(
      removals
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || row?.locationId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const removedNames = new Set<string>(
      removals
        .map((row: any) => String(row?.name || row?.hotspotName || '').trim().toLowerCase())
        .filter(Boolean),
    );

    return source.some((row: any) => {
      const rowId = Number(row?.locationId || row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || 0);
      const rowText = String(row?.text || row?.name || row?.toName || row?.to || '').trim().toLowerCase();
      if (rowId > 0 && removedIds.has(rowId)) return true;
      for (const removedName of removedNames) {
        if (removedName && rowText.includes(removedName)) return true;
      }
      return false;
    });
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

  private finalizeMatrixPreviewTimeline(timeline: any[]): any[] {
    const normalized = this.normalizeTravelLabelsToNextStop(Array.isArray(timeline) ? timeline : []);
    const repaired = this.repairMatrixPreviewTimelineTimeRanges(normalized);
    const deduped: any[] = [];

    const rowFingerprint = (row: any): string => [
      String(row?.type || '').toLowerCase(),
      Number(row?.item_type || 0) || 0,
      Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || row?.id || 0) || 0,
      String(row?.fromName || row?.from || row?.displayFromName || '').trim().toLowerCase(),
      String(row?.toName || row?.to || row?.displayToName || '').trim().toLowerCase(),
      String(row?.timeRange || row?.time || '').trim().toLowerCase(),
    ].join('|');

    for (const row of repaired) {
      if (!row) continue;
      const prev = deduped[deduped.length - 1];
      if (prev && rowFingerprint(prev) === rowFingerprint(row)) {
        continue;
      }
      deduped.push(row);
    }

    return deduped.map((row: any, index: number) => ({
      ...row,
      previewOrder: index,
      matrixPreviewOrder: index,
    }));
  }

  private isManualPreviewTimelineWrapped(timeline: any[]): boolean {
    if (!Array.isArray(timeline) || timeline.length === 0) return false;

    const isRefreshmentRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'refreshment' || itemType === 1 || text.includes('refreshment / buffer');
    };

    const isCheckinRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || type === 'checkin' || itemType === 6 || text.includes('check-in at');
    };

    const isMeaningfulAfterTerminal = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      return (
        type === 'refreshment'
        || type === 'travel'
        || type === 'attraction'
        || type === 'waiting'
        || itemType === 1
        || itemType === 3
        || itemType === 4
        || itemType === 5
        || itemType === 7
      );
    };

    let refreshmentCount = 0;
    let firstCheckinIndex = -1;
    let checkinCount = 0;

    for (let index = 0; index < timeline.length; index += 1) {
      const row = timeline[index];
      if (isRefreshmentRow(row)) {
        refreshmentCount += 1;
        if (refreshmentCount > 1) return true;
      }

      if (isCheckinRow(row)) {
        checkinCount += 1;
        if (checkinCount > 1) return true;
        if (firstCheckinIndex < 0) firstCheckinIndex = index;
        continue;
      }

      if (firstCheckinIndex >= 0 && index > firstCheckinIndex && isMeaningfulAfterTerminal(row)) {
        return true;
      }
    }

    return false;
  }

  private repairMatrixPreviewTimelineTimeRanges(timeline: any[]): any[] {
    if (!Array.isArray(timeline) || timeline.length === 0) return [];

    const output: any[] = [];
    let cursor: number | null = null;

    const isHotelLikeRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || itemType === 6 || /check-?in\s+at\s+hotel/.test(text);
    };

    for (const row of timeline) {
      const rawRange = String(row?.timeRange || '').trim();
      const hasPlaceholderRange = /needs\s+recalculation|needs\s+reschedule/i.test(rawRange);
      const parsedStart = this.parseSegmentStartMinutes(row);
      const parsedEnd = this.parseSegmentEndMinutes(row);
      const hasValidRange = !hasPlaceholderRange
        && parsedStart !== null
        && parsedEnd !== null
        && parsedEnd >= parsedStart;

      if (hasValidRange) {
        output.push(row);
        cursor = parsedEnd;
        continue;
      }

      if (!hasPlaceholderRange) {
        output.push(row);
        if (parsedEnd !== null) cursor = parsedEnd;
        continue;
      }

      const hotelLike = isHotelLikeRow(row);
      const durationMin = hotelLike
        ? 0
        : Math.max(1, Math.round(Number(row?.matrixDurationMin || this.getPreviewRowDurationMinutes(row) || 10)));
      const startMin = cursor ?? 0;
      const endMin = hotelLike ? startMin : (startMin + durationMin);

      const patchedRow: any = {
        ...row,
        timeRange: this.minutesRangeToTimeString(startMin, endMin),
      };

      if (!hotelLike && row?.isMatrixSplitTravel === true) {
        patchedRow.matrixDurationMin = durationMin;
        patchedRow.duration = row?.duration || `${durationMin} Min`;
      }

      output.push(patchedRow);
      cursor = endMin;
    }

    return output;
  }

  private assertTimelineOrderForMatrixPreview(timeline: any[], selectedHotspotId: number): void {
    const debugMode = String(process.env.DEBUG_MATRIX_PREVIEW_ASSERT || '').toLowerCase() === 'true';
    const isTravel = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };
    const isAttraction = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isHotelLike = (row: any) => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
    };
    const getTarget = (row: any) => String(row?.toName || row?.text || row?.name || '').trim().toLowerCase();

    const errors: string[] = [];
    const hotelIndex = timeline.findIndex((row: any) => isHotelLike(row));
    if (hotelIndex >= 0) {
      for (let i = hotelIndex + 1; i < timeline.length; i += 1) {
        if (isTravel(timeline[i]) || isAttraction(timeline[i])) {
          errors.push('hotel/check-in appears before later travel/attraction rows');
          break;
        }
      }
    }

    const selectedIndex = timeline.findIndex(
      (row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === Number(selectedHotspotId),
    );
    if (hotelIndex >= 0 && selectedIndex > hotelIndex) {
      errors.push('selected hotspot appears after hotel/check-in');
    }

    for (let i = 1; i < timeline.length; i += 1) {
      const prev = timeline[i - 1];
      const curr = timeline[i];
      if (isTravel(prev) && isTravel(curr) && getTarget(prev) && getTarget(prev) === getTarget(curr)) {
        errors.push(`duplicate consecutive travel rows targeting same destination at index ${i - 1}/${i}`);
      }
    }

    const cToBIndex = timeline.findIndex((row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'C_TO_B');
    if (cToBIndex >= 0) {
      const next = timeline[cToBIndex + 1];
      if (!next || (!isAttraction(next) && !isHotelLike(next))) {
        errors.push('C_TO_B travel is not immediately before B attraction or destination hotel');
      }
    }

    const aToCIndex = timeline.findIndex((row: any) => row?.isMatrixSplitTravel === true && row?.matrixTravelLeg === 'A_TO_C');
    if (aToCIndex >= 0) {
      const next = timeline[aToCIndex + 1];
      if (!next || Number(next?.locationId || next?.hotspot_ID || next?.hotspotId || 0) !== Number(selectedHotspotId)) {
        errors.push('A_TO_C travel is not immediately before selected hotspot');
      }
    }

    if (selectedIndex >= 0) {
      const afterSelected = timeline[selectedIndex + 1];
      if (!afterSelected || !(afterSelected?.isMatrixSplitTravel === true && afterSelected?.matrixTravelLeg === 'C_TO_B')) {
        errors.push('selected hotspot is not immediately before C_TO_B travel');
      }
    }

    for (let i = 0; i < timeline.length; i += 1) {
      if (Number(timeline[i]?.matrixPreviewOrder) !== i) {
        errors.push('matrixPreviewOrder is not sequential from 0..n');
        break;
      }
    }

    if (errors.length > 0) {
      console.warn('[MatrixPreviewInvariant]', { errors });
      if (debugMode) {
        throw new Error(`Matrix preview invariant failed: ${errors.join('; ')}`);
      }
    }
  }

  private getPreviewRowDurationMinutes(row: any): number | null {
    const parseDurationLikeValue = (value: any): number | null => {
      if (value == null) return null;

      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.round(value);
      }

      if (value instanceof Date && Number.isFinite(value.getTime())) {
        const hours = value.getUTCHours();
        const minutes = value.getUTCMinutes();
        const seconds = value.getUTCSeconds();
        const total = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
        return total > 0 ? total : null;
      }

      const raw = String(value || '').trim();
      if (!raw) return null;

      const isoDate = new Date(raw);
      if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && Number.isFinite(isoDate.getTime())) {
        const hours = isoDate.getUTCHours();
        const minutes = isoDate.getUTCMinutes();
        const seconds = isoDate.getUTCSeconds();
        const total = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
        return total > 0 ? total : null;
      }

      const hourMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs|h)/i);
      const minMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:minute|minutes|min|mins|m)/i);
      if (hourMatch || minMatch) {
        const hours = hourMatch ? Number.parseFloat(hourMatch[1]) : 0;
        const minutes = minMatch ? Number.parseFloat(minMatch[1]) : 0;
        const total = Math.round((Number.isFinite(hours) ? hours * 60 : 0) + (Number.isFinite(minutes) ? minutes : 0));
        return total > 0 ? total : null;
      }

      const colonMatch = raw.match(/(?:^|T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (colonMatch) {
        const hours = Number(colonMatch[1] || 0);
        const minutes = Number(colonMatch[2] || 0);
        const seconds = Number(colonMatch[3] || 0);
        const total = hours * 60 + minutes + (seconds > 0 ? 1 : 0);
        return total > 0 ? total : null;
      }

      return null;
    };

    const explicitDuration =
      parseDurationLikeValue(row?.duration)
      ?? parseDurationLikeValue(row?.hotspot_traveling_time)
      ?? parseDurationLikeValue(row?.hotspot_duration);

    if (explicitDuration !== null) {
      return explicitDuration;
    }

    if (row?.timeRange && String(row.timeRange).includes('-')) {
      const startMinutes = this.parsePreviewTimeToMinutes(
        String(row.timeRange).split('-')[0]?.trim() || '',
      );
      const endMinutes = this.parsePreviewTimeToMinutes(
        String(row.timeRange).split('-')[1]?.trim() || '',
      );

      if (startMinutes !== null && endMinutes !== null) {
        const diff = endMinutes >= startMinutes
          ? endMinutes - startMinutes
          : (24 * 60 - startMinutes) + endMinutes;
        return diff > 0 ? diff : null;
      }
    }

    return null;
  }

  private getPreviewRowDurationFromDurationFieldsOnly(row: any): number | null {
    const parseDurationValue = (value: any): number | null => {
      if (value == null) return null;

      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.max(1, Math.round(value));
      }

      const text = String(value).trim().toLowerCase();
      if (!text) return null;

      const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*h(?:our)?s?/i);
      const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*m(?:in)?s?/i);
      if (hourMatch || minuteMatch) {
        const hours = hourMatch ? Number.parseFloat(hourMatch[1]) : 0;
        const minutes = minuteMatch ? Number.parseFloat(minuteMatch[1]) : 0;
        const total = (Number.isFinite(hours) ? hours * 60 : 0) + (Number.isFinite(minutes) ? minutes : 0);
        if (total > 0) return Math.max(1, Math.round(total));
      }

      const numeric = Number.parseFloat(text.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      return Math.max(1, Math.round(numeric));
    };

    const parseTravelingTimeValue = (value: any): number | null => {
      if (value == null) return null;

      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const mins = (value.getHours() * 60) + value.getMinutes();
        return mins > 0 ? mins : null;
      }

      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        const mins = (parsed.getHours() * 60) + parsed.getMinutes();
        return mins > 0 ? mins : null;
      }

      return null;
    };

    return (
      parseDurationValue(row?.duration)
      || parseDurationValue(row?.visitDuration)
      || parseTravelingTimeValue(row?.hotspot_traveling_time)
      || null
    );
  }

  private getHotspotDurationMinutesFromMasterFirst(master: any, row: any): number | null {
    const masterDuration = master?.hotspot_duration ? this.timeToMinutes(master.hotspot_duration) : 0;
    if (masterDuration > 0) return masterDuration;

    return this.getHotspotDurationMinutes(master, row);
  }

  private minutesRangeToTimeString(startMinutes: number, endMinutes: number): string {
    const toTimeStr = (mins: number): string => {
      const roundedMins = Math.round(mins);
      const hours = Math.floor(roundedMins / 60) % 24;
      const mins_remainder = roundedMins % 60;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = hours % 12 === 0 ? 12 : hours % 12;
      return `${String(displayHours).padStart(1, '0')}:${String(mins_remainder).padStart(2, '0')} ${ampm}`;
    };

    return `${toTimeStr(startMinutes)} - ${toTimeStr(endMinutes)}`;
  }

  private minutesRangeToFitPreviewLabel(startMinutes: number, endMinutes: number): string {
    const format = (minutes: number): string => {
      const roundedMinutes = Math.round(minutes);
      const dayOffset = Math.floor(roundedMinutes / (24 * 60));
      const normalized = ((roundedMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
      const hours = Math.floor(normalized / 60) % 24;
      const minsRemainder = normalized % 60;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = hours % 12 === 0 ? 12 : hours % 12;
      const label = `${String(displayHours).padStart(1, '0')}:${String(minsRemainder).padStart(2, '0')} ${ampm}`;
      return dayOffset > 0 ? `${label} +${dayOffset}d` : label;
    };

    return `${format(startMinutes)} - ${format(endMinutes)}`;
  }

  private normalizeTravelLabelsToNextStop(timeline: any[]): any[] {
    const rows = Array.isArray(timeline) ? timeline : [];
    if (rows.length === 0) return rows;

    const isTravelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };
    const isAttractionRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isHotelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
    };
    const stopLabel = (row: any, fallback: string): string => {
      if (!row) return fallback;
      if (isHotelRow(row)) {
        const raw = String(row?.text || row?.name || '').trim();
        const match = raw.match(/check-?in\s+at\s+(.+)/i);
        const hotelName = String(match?.[1] || '').trim();
        return hotelName && hotelName.toLowerCase() !== 'hotel' ? hotelName : 'Hotel';
      }
      return String(row?.text || row?.name || fallback).trim();
    };

    return rows.map((row: any, idx: number) => {
      if (!isTravelRow(row)) return row;

      const prevStop = [...rows]
        .slice(0, idx)
        .reverse()
        .find((candidate: any) => isAttractionRow(candidate) || isHotelRow(candidate));
      const nextStop = [...rows]
        .slice(idx + 1)
        .find((candidate: any) => isAttractionRow(candidate) || isHotelRow(candidate));
      const fromLabel = stopLabel(prevStop, 'Hotel / Route Start');
      const toLabel = stopLabel(nextStop, 'Hotel');
      const travelToHotel = isHotelRow(nextStop);

      return {
        ...row,
        type: 'travel',
        item_type: travelToHotel ? 5 : Number(row?.item_type || 3),
        text: `Travel to ${toLabel}`,
        name: `Travel to ${toLabel}`,
        fromName: fromLabel,
        toName: toLabel,
        from: fromLabel,
        to: toLabel,
        displayFromName: fromLabel,
        displayToName: toLabel,
        isMatrixReconnectedTravel: true,
      };
    });
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

  private formatManualDurationMinutes(minutes: number): string {
    const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    if (hours > 0 && mins > 0) return `${hours} hour ${mins} minute${mins === 1 ? '' : 's'}`;
    if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }

  private formatMinutesHuman(minutes: number): string {
    const safeMinutes = Math.max(0, Math.round(Number(minutes || 0)));

    if (safeMinutes < 60) {
      return `${safeMinutes} minute${safeMinutes === 1 ? '' : 's'}`;
    }

    const hours = Math.floor(safeMinutes / 60);
    const mins = safeMinutes % 60;

    if (mins === 0) {
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }

    return `${hours} hour${hours === 1 ? '' : 's'} ${mins} minute${mins === 1 ? '' : 's'}`;
  }

  private formatPreviewTravelDuration(minutes: number): string {
    const safeMinutes = Math.max(0, Math.round(Number(minutes || 0)));
    const hours = Math.floor(safeMinutes / 60);
    const mins = safeMinutes % 60;

    if (hours > 0 && mins > 0) {
      return `${hours} Hour${hours === 1 ? '' : 's'} ${mins} Min`;
    }
    if (hours > 0) {
      return `${hours} Hour${hours === 1 ? '' : 's'}`;
    }
    return `${mins} Min`;
  }

  private parseTimeRangeParts(value: unknown): { start: string | null; end: string | null } {
    const raw = String(value || '').trim();
    if (!raw) return { start: null, end: null };

    const parts = raw.split(/\s*-\s*/);
    return {
      start: parts[0]?.trim() || null,
      end: parts[1]?.trim() || null,
    };
  }

  private extractOpeningTimeFromOperatingHours(value: unknown): string | null {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const matches = raw.match(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/gi) || [];
    return matches[0] || null;
  }

  private extractClosingTimeFromOperatingHours(value: unknown): string | null {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const matches = raw.match(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/gi) || [];
    if (matches.length < 2) return null;

    return matches[matches.length - 1] || null;
  }

  private isAttractionTimelineRow(row: any): boolean {
    const type = String(row?.type || row?.rowType || '').trim().toLowerCase();
    const itemType = Number(row?.item_type || row?.itemType || 0);

    return (
      type === 'attraction' ||
      type === 'hotspot' ||
      itemType === 4
    );
  }

  private getTimelineRowHotspotId(row: any): number {
    return Number(
      row?.hotspotId ||
      row?.hotspot_ID ||
      row?.hotspot_id ||
      row?.locationId ||
      row?.location_id ||
      0,
    ) || 0;
  }

  private findAttemptedAttractionRowForHotspot(params: {
    attemptedTimeline?: any[];
    hotspotId: number;
  }): any | null {
    const hotspotId = Number(params.hotspotId || 0);
    if (!(hotspotId > 0) || !Array.isArray(params.attemptedTimeline)) {
      return null;
    }

    return params.attemptedTimeline.find((row: any) => (
      this.isAttractionTimelineRow(row) &&
      this.getTimelineRowHotspotId(row) === hotspotId
    )) || null;
  }

  private getPriorityLabel(priority: unknown): string {
    const value = Number(priority || 0);
    if (value === 1) return 'Priority 1';
    if (value === 2) return 'Priority 2';
    if (value === 3) return 'Priority 3';
    return 'Priority';
  }

  private getRemovedHotspotVisitTime(row: any): string | null {
    return String(
      row?.timeRange ||
      row?.visitTime ||
      row?.hotspot_visit_time ||
      (
        row?.startTime && row?.endTime
          ? `${row.startTime} - ${row.endTime}`
          : ''
      ) ||
      (
        row?.hotspot_start_time && row?.hotspot_end_time
          ? `${row.hotspot_start_time} - ${row.hotspot_end_time}`
          : ''
      ) ||
      '',
    ).trim() || null;
  }

  private getRemovedHotspotOperatingHours(row: any): string | null {
    return String(
      row?.timings ||
      row?.operatingHours ||
      row?.openingHours ||
      row?.hotspot_timing ||
      row?.hotspot_timings ||
      row?.hotspotTiming ||
      '',
    ).trim() || null;
  }

  private enrichRemovedHotspotCandidateWithAttempt(params: {
    candidate: any;
    attemptedTimeline?: any[];
    attemptedTimelineSource?:
      | 'EXACT_ANCHOR_SEQUENTIAL_REBUILD'
      | 'FAILED_BEFORE_REMOVAL'
      | 'AFTER_REMOVAL'
      | 'FINAL_PROPOSED_TIMELINE'
      | 'UNKNOWN';
  }): any {
    const candidateHotspotId = Number(
      params.candidate?.hotspotId ||
      params.candidate?.id ||
      params.candidate?.hotspot_ID ||
      0,
    );

    const attemptedAttractionRow = this.findAttemptedAttractionRowForHotspot({
      attemptedTimeline: params.attemptedTimeline,
      hotspotId: candidateHotspotId,
    });

    const attemptedVisitTime = attemptedAttractionRow
      ? String(
          attemptedAttractionRow?.visitTime ||
          attemptedAttractionRow?.timeRange ||
          attemptedAttractionRow?.hotspot_visit_time ||
          '',
        ).trim() || null
      : null;

    const attemptedRange = this.parseTimeRangeParts(attemptedVisitTime);

    return {
      ...params.candidate,

      // Never use travel-time rows as attraction visit attempts.
      attemptedVisitTime,
      attemptedArrivalTime:
        attemptedAttractionRow?.arrivalTime ||
        attemptedRange.start ||
        null,
      attemptedEndTime:
        attemptedAttractionRow?.departureTime ||
        attemptedRange.end ||
        null,
      operatingHours:
        params.candidate?.operatingHours ||
        params.candidate?.timings ||
        params.candidate?.hotspot_timing ||
        attemptedAttractionRow?.timings ||
        attemptedAttractionRow?.operatingHours ||
        null,
      outsideOperatingMinutes:
        attemptedAttractionRow?.outsideOperatingMinutes ||
        attemptedAttractionRow?.openingHoursOverflowMinutes ||
        attemptedAttractionRow?.closingOverflowMinutes ||
        params.candidate?.outsideOperatingMinutes ||
        0,
      attemptedVisitSource: attemptedAttractionRow ? 'ATTRACTION_ROW' : 'NONE',
      attemptedTimelineSource: params.attemptedTimelineSource || 'UNKNOWN',
    };
  }

  private buildRemovedHotspotExplanation(params: {
    row: any;
    priority: number;
    removalStage: 'P3_FIRST' | 'P2_AFTER_P3' | 'P1_AFTER_P3_P2' | 'OPTIONAL';
    reasonCode?:
      | 'ARRIVAL_AFTER_CLOSING'
      | 'VISIT_END_AFTER_CLOSING'
      | 'ARRIVAL_BEFORE_OPENING'
      | 'ROUTE_END_OVERFLOW'
      | 'LOWER_PRIORITY_REMOVAL_REQUIRED'
      | 'OPENING_HOURS_CONFLICT'
      | 'ANCHOR_PRESERVATION'
      | 'MANUAL_HOTSPOT_TIME_WINDOW'
      | 'UNPROVEN_REMOVAL'
      | 'UNKNOWN';
    manualHotspotName?: string;
    anchorLabel?: string | null;
    routeEndOverflowMinutes?: number;
    routeEndTime?: string | null;
    openingHourConflictCount?: number;
    openingHoursOverflowMinutes?: number;
  }): any {
    const priorityLabel = this.getPriorityLabel(params.priority);
    const name = String(
      params.row?.name ||
      params.row?.hotspotName ||
      params.row?.hotspot_name ||
      `Hotspot #${params.row?.hotspotId || params.row?.id || ''}`,
    ).trim();

    const originalVisitTime = this.getRemovedHotspotVisitTime(params.row);
    const operatingHours = this.getRemovedHotspotOperatingHours(params.row);
    const routeEndOverflowMinutes = Math.max(0, Number(params.routeEndOverflowMinutes || 0));
    const openingHourConflictCount = Number(params.openingHourConflictCount || 0);
    const manualHotspotName = String(params.manualHotspotName || 'the selected manual hotspot').trim();

    const attemptedVisitTime = String(
      params.row?.attemptedVisitTime ||
      params.row?.newVisitTime ||
      params.row?.proposedVisitTime ||
      params.row?.recalculatedVisitTime ||
      '',
    ).trim() || null;

    const attemptedRange = this.parseTimeRangeParts(attemptedVisitTime);

    const attemptedArrivalTime = String(
      params.row?.attemptedArrivalTime ||
      params.row?.arrivalTime ||
      attemptedRange.start ||
      '',
    ).trim() || null;

    const attemptedEndTime = String(
      params.row?.attemptedEndTime ||
      params.row?.departureTime ||
      attemptedRange.end ||
      '',
    ).trim() || null;

    const openingTime = String(
      params.row?.openingTime ||
      this.extractOpeningTimeFromOperatingHours(operatingHours) ||
      '',
    ).trim() || null;

    const closingTime = String(
      params.row?.closingTime ||
      this.extractClosingTimeFromOperatingHours(operatingHours) ||
      '',
    ).trim() || null;

    const outsideOperatingMinutes = Math.max(
      0,
      Number(
        params.row?.outsideOperatingMinutes ||
        params.row?.openingHoursOverflowMinutes ||
        params.row?.closingOverflowMinutes ||
        params.openingHoursOverflowMinutes ||
        0,
      ),
    );

    const routeEndTime = String(params.row?.routeEndTime || params.routeEndTime || '').trim() || null;
    const routeEndOverflowBeforeRemoval = Math.max(
      0,
      Number(params.row?.routeEndOverflowBeforeRemoval ?? params.routeEndOverflowMinutes ?? 0),
    );
    const routeEndOverflowAfterRemoval = Math.max(0, Number(params.row?.routeEndOverflowAfterRemoval ?? 0));
    const openingHourConflictCountBeforeRemoval = Math.max(
      0,
      Number(params.row?.openingHourConflictCountBeforeRemoval ?? params.openingHourConflictCount ?? 0),
    );
    const openingHourConflictCountAfterRemoval = Math.max(0, Number(params.row?.openingHourConflictCountAfterRemoval ?? 0));
    const removalImprovedFeasibility = params.row?.removalImprovedFeasibility === true;
    const attemptedTimelineSource = String(params.row?.attemptedTimelineSource || 'UNKNOWN');

    let removalReasonCode = params.reasonCode || 'LOWER_PRIORITY_REMOVAL_REQUIRED';

    let reason = '';
    if (params.removalStage === 'P3_FIRST') {
      reason = `Removed first because this is a ${priorityLabel} hotspot and lower-priority rows are removed before higher-priority rows.`;
    } else if (params.removalStage === 'P2_AFTER_P3') {
      reason = 'Removed after Priority 3 removals were not enough to fit the selected manual hotspot.';
    } else if (params.removalStage === 'P1_AFTER_P3_P2') {
      reason = 'Removed only after Priority 3 and Priority 2 removals were exhausted.';
    } else {
      reason = 'Removed because this optional/lower-priority hotspot conflicts with the selected manual hotspot insertion.';
    }

    let fitFailureExplanation = '';

    if (attemptedArrivalTime && closingTime && outsideOperatingMinutes > 0) {
      removalReasonCode = 'ARRIVAL_AFTER_CLOSING';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, the guest would reach ${name} at ${attemptedArrivalTime}, but it closes at ${closingTime}. It is outside operating hours by ${this.formatMinutesHuman(outsideOperatingMinutes)}.`;
    } else if (attemptedEndTime && closingTime && outsideOperatingMinutes > 0) {
      removalReasonCode = 'VISIT_END_AFTER_CLOSING';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, the visit to ${name} would continue until ${attemptedEndTime}, but it closes at ${closingTime}. It exceeds operating hours by ${this.formatMinutesHuman(outsideOperatingMinutes)}.`;
    } else if (attemptedArrivalTime && openingTime && outsideOperatingMinutes > 0) {
      removalReasonCode = 'ARRIVAL_BEFORE_OPENING';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, the guest would reach ${name} at ${attemptedArrivalTime}, before it opens at ${openingTime}. It is outside operating hours by ${this.formatMinutesHuman(outsideOperatingMinutes)}.`;
    } else if (routeEndOverflowMinutes > 0) {
      removalReasonCode = 'ROUTE_END_OVERFLOW';
      fitFailureExplanation =
        `Keeping ${name} would push the route beyond the allowed day${routeEndTime ? ` end time of ${routeEndTime}` : ' end time'} by ${this.formatMinutesHuman(routeEndOverflowMinutes)} after inserting ${manualHotspotName}.`;
    } else if (openingHourConflictCount > 0) {
      removalReasonCode = 'OPENING_HOURS_CONFLICT';
      fitFailureExplanation =
        `After inserting ${manualHotspotName}, keeping ${name} creates an opening-hours conflict in the recalculated route.`;
    } else if (attemptedVisitTime && operatingHours && outsideOperatingMinutes <= 0) {
      removalReasonCode = 'UNPROVEN_REMOVAL';
      fitFailureExplanation =
        `${name} is open during the recalculated visit time of ${attemptedVisitTime}. Its operating hours are ${operatingHours}. No direct operating-hours conflict or route-end overflow was proven for this hotspot, so this removal requires additional route-feasibility evidence.`;
    } else if (originalVisitTime && operatingHours) {
      removalReasonCode = 'UNPROVEN_REMOVAL';
      fitFailureExplanation =
        `${name} was originally planned at ${originalVisitTime}, and its operating hours are ${operatingHours}. The system did not prove a direct timing violation for this hotspot.`;
    } else {
      removalReasonCode = 'UNPROVEN_REMOVAL';
      fitFailureExplanation =
        `The optimizer selected ${name} for removal, but no direct operating-hours conflict, route-end overflow, or downstream route failure was attached as proof.`;
    }

    if (params.anchorLabel && !/selected fit here position/i.test(fitFailureExplanation)) {
      fitFailureExplanation += ` Selected position: ${params.anchorLabel}.`;
    }

    const attemptedVisitSource = String(params.row?.attemptedVisitSource || '').trim();
    const safeAttemptedVisitTime =
      attemptedVisitSource === 'ATTRACTION_ROW'
        ? attemptedVisitTime
        : null;

    const safeAttemptedArrivalTime =
      attemptedVisitSource === 'ATTRACTION_ROW'
        ? attemptedArrivalTime
        : null;

    const safeAttemptedEndTime =
      attemptedVisitSource === 'ATTRACTION_ROW'
        ? attemptedEndTime
        : null;
    const isWithinOperatingHours =
      Boolean(safeAttemptedVisitTime && operatingHours) &&
      outsideOperatingMinutes <= 0;
    const hasProvenTimingReason =
      outsideOperatingMinutes > 0 ||
      routeEndOverflowMinutes > 0 ||
      openingHourConflictCount > 0;

    return {
      id: Number(params.row?.hotspotId || params.row?.id || params.row?.hotspot_ID || 0),
      hotspotId: Number(params.row?.hotspotId || params.row?.id || params.row?.hotspot_ID || 0),
      routeHotspotId: Number(params.row?.routeHotspotId || params.row?.route_hotspot_ID || 0) || null,
      name,
      priority: params.priority,
      priorityLabel,
      originalVisitTime,
      attemptedVisitTime: safeAttemptedVisitTime,
      attemptedArrivalTime: safeAttemptedArrivalTime,
      attemptedEndTime: safeAttemptedEndTime,
      attemptedVisitSource,
      attemptedTimelineSource,
      openingTime,
      closingTime,
      outsideOperatingMinutes,
      operatingHours,
      isWithinOperatingHours,
      routeEndTime,
      routeEndOverflowMinutes,
      routeEndOverflowBeforeRemoval,
      routeEndOverflowAfterRemoval,
      openingHourConflictCount,
      openingHourConflictCountBeforeRemoval,
      openingHourConflictCountAfterRemoval,
      removalImprovedFeasibility,
      hasProvenTimingReason,
      removalStage: params.removalStage,
      removalReasonCode,
      reason: fitFailureExplanation || reason,
      fitFailureExplanation,
    };
  }

  private detectManualFitTimingRisk(params: {
    timeline: any[];
    selectedHotspotId: number;
  }): ManualFitTimingRisk | null {
    return detectManualFitTimingRiskImpl.call(this, params);
  }

  private buildRemovedPrioritySummary(removedRows: any[]) {
    return buildRemovedPrioritySummaryImpl.call(this, removedRows);
  }

  private getAuthoritativeManualFitRemovedHotspots(params: {
    bestCandidate?: any;
    selectedAttempt?: any;
    fallbackRemovedHotspots?: any[];
  }): any[] {
    const fromBestCandidate = [
      ...(Array.isArray(params.bestCandidate?.removedOptionalHotspots) ? params.bestCandidate.removedOptionalHotspots : []),
      ...(Array.isArray(params.bestCandidate?.removedTopPriorityHotspots) ? params.bestCandidate.removedTopPriorityHotspots : []),
    ];

    if (fromBestCandidate.length > 0) {
      return fromBestCandidate;
    }

    const fromSelectedAttempt = [
      ...(Array.isArray(params.selectedAttempt?.removedHotspots) ? params.selectedAttempt.removedHotspots : []),
      ...(Array.isArray(params.selectedAttempt?.removedOptionalHotspots) ? params.selectedAttempt.removedOptionalHotspots : []),
      ...(Array.isArray(params.selectedAttempt?.removedTopPriorityHotspots) ? params.selectedAttempt.removedTopPriorityHotspots : []),
    ];

    if (fromSelectedAttempt.length > 0) {
      return fromSelectedAttempt;
    }

    return Array.isArray(params.fallbackRemovedHotspots) ? params.fallbackRemovedHotspots : [];
  }

  private buildManualFitChangesRequiredDisplay(params: {
    removedHotspots?: any[];
    affectedPriorityHotspots?: any[];
    removedPrioritySummary?: any;
  }): {
    hasRemovals: boolean;
    title: string;
    removalOrderLabel: string;
    removedItems: Array<{
      hotspotId: number;
      routeHotspotId?: number | null;
      name: string;
      workPriority: number | null;
      workPriorityLabel: string;
      reason?: string | null;
      removalReasonCode?: string | null;
      fitFailureExplanation?: string | null;
    }>;
    noRemovalText: string;
  } {
    return buildManualFitChangesRequiredDisplayImpl.call(this, params);
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

  private routeFitTypeRank(type: string): number {
    switch (type) {
      case 'ON_ROUTE': return 1;
      case 'MINOR_DETOUR': return 2;
      case 'BACKTRACK': return 3;
      case 'OFF_ROUTE': return 4;
      case 'UNKNOWN': return 5;
      case 'MATRIX_UNAVAILABLE': return 6;
      default: return 5;
    }
  }

  private routeFitLabel(type: string): string {
    switch (type) {
      case 'ON_ROUTE': return 'Fits on the way';
      case 'MINOR_DETOUR': return 'Minor detour';
      case 'BACKTRACK': return 'Backtrack warning';
      case 'OFF_ROUTE': return 'Off route';
      case 'UNKNOWN': return 'Route data missing';
      case 'MATRIX_UNAVAILABLE': return 'Matrix unavailable for hotel/source segment';
      default: return 'Route data missing';
    }
  }

  private buildRouteFitDisplayMeta(params: {
    routeFitType: string;
    roadDetourKm?: number | null;
    insertedRouteDistanceKm?: number | null;
    abOsrmDistanceKm?: number | null;
    finalDecisionReason?: string | null;
  }): {
    displayLabel: string;
    shortLabel: string;
    isZeroExtraDetour: boolean;
    distanceComparisonNote: string | null;
    finalDecisionReason: string | null;
  } {
    const routeFitType = String(params?.routeFitType || '').toUpperCase();
    const roadDetourKmRaw = params?.roadDetourKm;
    const roadDetourKm = roadDetourKmRaw != null && Number.isFinite(Number(roadDetourKmRaw))
      ? Number(roadDetourKmRaw)
      : null;
    const insertedRouteDistanceKm = params?.insertedRouteDistanceKm != null && Number.isFinite(Number(params.insertedRouteDistanceKm))
      ? Number(params.insertedRouteDistanceKm)
      : null;
    const abOsrmDistanceKm = params?.abOsrmDistanceKm != null && Number.isFinite(Number(params.abOsrmDistanceKm))
      ? Number(params.abOsrmDistanceKm)
      : null;

    let displayLabel = this.routeFitLabel(routeFitType);
    let shortLabel = displayLabel;
    let finalDecisionReason = params?.finalDecisionReason ?? null;

    const isZeroExtraDetour = roadDetourKm != null ? roadDetourKm <= 0.5 : false;
    const distanceComparisonNote =
      insertedRouteDistanceKm != null
      && abOsrmDistanceKm != null
      && insertedRouteDistanceKm < abOsrmDistanceKm
        ? 'Via route is equivalent or slightly shorter based on cached road distance.'
        : null;

    if (routeFitType === 'MINOR_DETOUR') {
      if (isZeroExtraDetour) {
        displayLabel = 'Near route / no extra distance';
        shortLabel = 'No extra distance';
        if (!finalDecisionReason || !String(finalDecisionReason).toLowerCase().startsWith('not selected')) {
          finalDecisionReason = 'This hotspot is near the route and does not add meaningful extra travel distance.';
        }
      } else {
        displayLabel = 'Minor detour';
        shortLabel = 'Minor detour';
        if (!finalDecisionReason || !String(finalDecisionReason).trim()) {
          finalDecisionReason = 'This hotspot adds a small acceptable detour.';
        }
      }
    }

    return {
      displayLabel,
      shortLabel,
      isZeroExtraDetour,
      distanceComparisonNote,
      finalDecisionReason,
    };
  }

  private isFeasibleFitType(type: string): boolean {
    return type === 'ON_ROUTE' || type === 'MINOR_DETOUR';
  }

  private isUsableMatrixRouteFitType(type: string): boolean {
    return type === 'ON_ROUTE' || type === 'MINOR_DETOUR' || type === 'BACKTRACK' || type === 'OFF_ROUTE';
  }

  private hasValidManualMatrixSlot(manualInsertionFit: any): boolean {
    const slot = manualInsertionFit?.chosenSlot;
    const bestSlot = manualInsertionFit?.bestSlot;
    const chosenSlotType = String(slot?.routeFitType || '').toUpperCase();
    const bestSlotType = String(bestSlot?.routeFitType || '').toUpperCase();
    const chosenSlotContext = String(slot?.slotContext || '').toUpperCase();
    const bestSlotContext = String(bestSlot?.slotContext || '').toUpperCase();
    const manualTimingPolicy = manualInsertionFit?.manualTimingPolicy;
    const manualRelaxedRouteFit =
      manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
      && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
    const isManualAllowedFitType = (type: string) =>
      this.isFeasibleFitType(type)
      || (
        manualRelaxedRouteFit
        && this.isUsableMatrixRouteFitType(type)
      );

    const chosenSlotValid = (
      !!slot
      && manualInsertionFit?.routeFitAvailable !== false
      && (
        (
          isManualAllowedFitType(chosenSlotType)
          && Number(slot?.fromHotspotId || 0) > 0
          && Number(slot?.toHotspotId || 0) > 0
        )
        || (
          chosenSlotType === 'SINGLE_HOTSPOT_BEFORE'
          && Number(slot?.toHotspotId || 0) > 0
        )
        || (
          chosenSlotType === 'SINGLE_HOTSPOT_AFTER'
          && Number(slot?.fromHotspotId || 0) > 0
        )
        || (
          isManualAllowedFitType(chosenSlotType)
          && manualInsertionFit?.cityEndpointInsertionMode === true
          && (
            (chosenSlotContext === 'CITY_TO_HOTSPOT' && Number(slot?.toHotspotId || 0) > 0)
            || (chosenSlotContext === 'HOTSPOT_TO_CITY' && Number(slot?.fromHotspotId || 0) > 0)
            || (
              chosenSlotContext === 'CITY_TO_CITY'
              && manualInsertionFit?.emptyRouteCityEndpointMode === true
              && Number(manualInsertionFit?.selectedHotspotId || slot?.betweenHotspotId || 0) > 0
            )
          )
        )
      )
    );

    const sourceExitAnchorBestSlotValid = (
      !!bestSlot
      && (
        String(bestSlot?.source || '') === 'SOURCE_CITY_EXIT_ANCHOR'
        || String(bestSlot?.source || '') === 'OSRM_SOURCE_CITY_ROUTE_ANCHOR'
      )
      && isManualAllowedFitType(bestSlotType)
      && Number(bestSlot?.fromHotspotId || 0) > 0
      && Number(bestSlot?.toHotspotId || 0) > 0
    );

    const singleHotspotBestSlotValid = (
      !!bestSlot
      && (
        (bestSlotType === 'SINGLE_HOTSPOT_BEFORE' && Number(bestSlot?.toHotspotId || 0) > 0)
        || (bestSlotType === 'SINGLE_HOTSPOT_AFTER' && Number(bestSlot?.fromHotspotId || 0) > 0)
        || (
          isManualAllowedFitType(bestSlotType)
          && manualInsertionFit?.cityEndpointInsertionMode === true
          && (
            (bestSlotContext === 'CITY_TO_HOTSPOT' && Number(bestSlot?.toHotspotId || 0) > 0)
            || (bestSlotContext === 'HOTSPOT_TO_CITY' && Number(bestSlot?.fromHotspotId || 0) > 0)
            || (
              bestSlotContext === 'CITY_TO_CITY'
              && manualInsertionFit?.emptyRouteCityEndpointMode === true
              && Number(manualInsertionFit?.selectedHotspotId || bestSlot?.betweenHotspotId || 0) > 0
            )
          )
        )
      )
    );

    const destinationHotelSideBestSlotValid = (
      !!bestSlot
      && String(bestSlot?.source || '') === 'DESTINATION_HOTEL_SIDE'
      && isManualAllowedFitType(bestSlotType)
      && Number(bestSlot?.fromHotspotId || 0) > 0
      && Number(manualInsertionFit?.destinationAnchorOrder || 0) > 0
    );

    return chosenSlotValid || sourceExitAnchorBestSlotValid || singleHotspotBestSlotValid || destinationHotelSideBestSlotValid;
  }

  private isEmptyRouteSchedulerEligible(manualInsertionFit: any): boolean {
    return (
      String(manualInsertionFit?.chosenSlotSource || '') === 'EMPTY_ROUTE_SCHEDULER'
      && manualInsertionFit?.emptyRouteCityEndpointMode === true
      && manualInsertionFit?.selectedIncluded === true
      && manualInsertionFit?.canApply === true
    ) || (
      manualInsertionFit?.emptyRouteCityEndpointMode === true
      && manualInsertionFit?.routeFitAvailable === true
      && manualInsertionFit?.canApply === true
      && manualInsertionFit?.selectedIncluded === true
      && manualInsertionFit?.hasFeasibleMatrixSlot !== true
    );
  }

  private buildMissingMatrixBuildSuggestion(planId: number, routeId: number, candidateHotspotId: number) {
    const normalizedPlanId = Number(planId || 0);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedCandidateId = Number(candidateHotspotId || 0);

    return {
      routeId: normalizedRouteId,
      candidateHotspotId: normalizedCandidateId,
      command: `npx tsx scripts/build-missing-manual-hotspot-matrix.ts --planId ${normalizedPlanId} --routeId ${normalizedRouteId} --candidateHotspotId ${normalizedCandidateId}`,
    };
  }

  private normalizeLocationText(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const firstSegment = raw.includes('|') ? String(raw.split('|')[0] || '') : raw;
    return firstSegment.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private deriveLooseCityKey(value: string): string {
    const normalized = this.normalizeLocationText(value || '');
    if (!normalized) return '';

    const primary = String(normalized.split(',')[0] || '').trim();
    if (!primary) return '';

    const stopwords = new Set([
      'international',
      'domestic',
      'airport',
      'station',
      'railway',
      'junction',
      'bus',
      'stand',
      'terminal',
      'city',
      'district',
      'state',
      'india',
    ]);

    const tokens = primary
      .split(' ')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .filter((t) => !stopwords.has(t));

    if (tokens.length > 0) {
      return tokens[0];
    }

    return String(primary.split(' ')[0] || '').trim();
  }

  private classifyManualHotspotCityContext(route: any, hotspot: any): ManualHotspotCityContext {
    const sourceRaw = String(route?.location_name || route?.source_location || '').trim();
    const destinationRaw = String(route?.next_visiting_location || route?.destination_location || '').trim();

    const sourceKey = this.deriveLooseCityKey(sourceRaw);
    const destinationKey = this.deriveLooseCityKey(destinationRaw);

    const hotspotLocation = String(hotspot?.hotspot_location || hotspot?.locationMap || '').trim();
    const hotspotToLocation = String(hotspot?.hotspot_to_location || hotspot?.toLocation || hotspot?.hotspotToLocation || '').trim();
    const hotspotName = String(hotspot?.hotspot_name || hotspot?.name || '').trim();

    const locationNorm = this.normalizeLocationText(hotspotLocation);
    const toLocationNorm = this.normalizeLocationText(hotspotToLocation);
    const nameNorm = this.normalizeLocationText(hotspotName);
    const locationCityNorm = normalizeCityName(hotspotLocation);
    const toLocationCityNorm = normalizeCityName(hotspotToLocation);
    const nameCityNorm = normalizeCityName(hotspotName);

    const sourceNorm = normalizeCityName(sourceRaw);
    const destinationNorm = normalizeCityName(destinationRaw);

    const matchesSource = (
      (!!sourceKey && (locationNorm.includes(sourceKey) || nameNorm.includes(sourceKey)))
      || (!!sourceNorm && (locationCityNorm === sourceNorm || nameCityNorm === sourceNorm))
    );
    const toMatchesSource = (
      (!!sourceKey && toLocationNorm.includes(sourceKey))
      || (!!sourceNorm && toLocationCityNorm === sourceNorm)
    );

    const matchesDestination = (
      (!!destinationKey && (locationNorm.includes(destinationKey) || nameNorm.includes(destinationKey)))
      || (!!destinationNorm && (locationCityNorm === destinationNorm || nameCityNorm === destinationNorm))
    );
    const toMatchesDestination = (
      (!!destinationKey && toLocationNorm.includes(destinationKey))
      || (!!destinationNorm && toLocationCityNorm === destinationNorm)
    );

    const sameCityRoute = (
      (!!sourceNorm && !!destinationNorm && sourceNorm === destinationNorm)
      || (!!sourceKey && !!destinationKey && sourceKey === destinationKey)
    );

    if (!sameCityRoute) {
      const forwardRouteMovement = (matchesSource || toMatchesSource) && toMatchesDestination;
      const reverseRouteMovement = (matchesDestination || toMatchesDestination) && toMatchesSource;

      if (forwardRouteMovement && !reverseRouteMovement) return 'DESTINATION_CITY';
      if (reverseRouteMovement && !forwardRouteMovement) return 'SOURCE_CITY';
    }

    if (sameCityRoute && matchesSource && matchesDestination) return 'SOURCE_CITY';
    if (matchesDestination && !matchesSource) return 'DESTINATION_CITY';
    if (matchesSource && !matchesDestination) return 'SOURCE_CITY';
    if (matchesDestination) return 'DESTINATION_CITY';
    if (matchesSource) return 'SOURCE_CITY';
    return 'UNKNOWN';
  }

  private classifyManualRouteAttractionCityContext(route: any, hotspot: any): ManualHotspotCityContext {
    const sourceRaw = String(route?.location_name || route?.source_location || '').trim();
    const destinationRaw = String(route?.next_visiting_location || route?.destination_location || '').trim();
    const hotspotLocation = String(hotspot?.hotspot_location || hotspot?.locationMap || '').trim();
    const hotspotName = String(hotspot?.hotspot_name || hotspot?.name || '').trim();

    const sourceKey = this.deriveLooseCityKey(sourceRaw);
    const destinationKey = this.deriveLooseCityKey(destinationRaw);
    const sourceNorm = normalizeCityName(sourceRaw);
    const destinationNorm = normalizeCityName(destinationRaw);
    const locationNorm = this.normalizeLocationText(hotspotLocation);
    const nameNorm = this.normalizeLocationText(hotspotName);
    const locationCityNorm = normalizeCityName(hotspotLocation);
    const nameCityNorm = normalizeCityName(hotspotName);

    const matchesSource = (
      (!!sourceKey && (locationNorm.includes(sourceKey) || nameNorm.includes(sourceKey)))
      || (!!sourceNorm && (locationCityNorm === sourceNorm || nameCityNorm === sourceNorm))
    );
    const matchesDestination = (
      (!!destinationKey && (locationNorm.includes(destinationKey) || nameNorm.includes(destinationKey)))
      || (!!destinationNorm && (locationCityNorm === destinationNorm || nameCityNorm === destinationNorm))
    );

    const sameCityRoute = (
      (!!sourceNorm && !!destinationNorm && sourceNorm === destinationNorm)
      || (!!sourceKey && !!destinationKey && sourceKey === destinationKey)
    );

    if (sameCityRoute && matchesSource && matchesDestination) return 'SOURCE_CITY';
    if (matchesDestination && !matchesSource) return 'DESTINATION_CITY';
    if (matchesSource && !matchesDestination) return 'SOURCE_CITY';

    return this.classifyManualHotspotCityContext(route, hotspot);
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

  private getSavedRuleTravelLocationType(
    startLocation: string,
    endLocation: string,
  ): 1 | 2 {
    const startLocations = String(startLocation || '').split('|').map((s) => s.trim()).filter(Boolean);
    const endLocations = String(endLocation || '').split('|').map((e) => e.trim()).filter(Boolean);

    for (const start of startLocations) {
      for (const end of endLocations) {
        if (start === end) return 1;
      }
    }

    return 2;
  }

  private getPrimaryTravelLocationLabel(value: unknown): string {
    return String(value || '').split('|')[0].trim();
  }

  private hmsToMinutes(value: string | null | undefined): number {
    return Math.max(
      0,
      Math.round(
        this.hmsToSeconds(
          TimeConverter.toTimeString(value || '00:00:00'),
        ) / 60,
      ),
    );
  }

  private async resolveHotspotPreviewEndpoint(
    tx: any,
    hotspotId: number,
  ): Promise<{
    hotspotId: number;
    hotspotName: string;
    travelLocationName: string;
    latitude: number | null;
    longitude: number | null;
  } | null> {
    if (!(Number(hotspotId) > 0)) return null;

    const hotspot = await (tx as any).dvi_hotspot_place.findFirst({
      where: {
        hotspot_ID: Number(hotspotId),
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_location: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    if (!hotspot) return null;

    const travelLocationName = String(
      hotspot?.hotspot_location ||
      hotspot?.hotspot_name ||
      `Hotspot #${Number(hotspotId)}`,
    ).trim();
    const hotspotName = String(
      hotspot?.hotspot_name ||
      travelLocationName ||
      `Hotspot #${Number(hotspotId)}`,
    ).trim();

    const latitude = Number(hotspot?.hotspot_latitude);
    const longitude = Number(hotspot?.hotspot_longitude);

    return {
      hotspotId: Number(hotspot?.hotspot_ID || hotspotId),
      hotspotName,
      travelLocationName,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
    };
  }

  private async resolveSavedRuleTravelLeg(params: {
    tx: any;
    fromLocationName: string;
    toLocationName: string;
    sourceCoords?: { lat: number; lon: number } | null;
    destCoords?: { lat: number; lon: number } | null;
    includeBuffer: boolean;
  }): Promise<{
    distanceKm: number | null;
    travelMinutes: number;
    bufferMinutes: number;
    durationMin: number;
    travelLocationType: 1 | 2;
  }> {
    const fromLocationName = String(params.fromLocationName || '').trim();
    const toLocationName = String(params.toLocationName || '').trim();
    const travelLocationType = this.getSavedRuleTravelLocationType(fromLocationName, toLocationName);

    const sourceCoords = params.sourceCoords
      && Number.isFinite(Number(params.sourceCoords.lat))
      && Number.isFinite(Number(params.sourceCoords.lon))
      ? { lat: Number(params.sourceCoords.lat), lon: Number(params.sourceCoords.lon) }
      : undefined;
    const destCoords = params.destCoords
      && Number.isFinite(Number(params.destCoords.lat))
      && Number.isFinite(Number(params.destCoords.lon))
      ? { lat: Number(params.destCoords.lat), lon: Number(params.destCoords.lon) }
      : undefined;

    const result = await this.previewDistanceHelper.fromSourceAndDestination(
      params.tx,
      fromLocationName,
      toLocationName,
      travelLocationType,
      sourceCoords,
      destCoords,
    );

    const travelMinutes = this.hmsToMinutes(result?.travelTime || '00:00:00');
    const bufferMinutes = this.hmsToMinutes(result?.bufferTime || '00:00:00');
    const durationMin = Math.max(1, travelMinutes + (params.includeBuffer ? bufferMinutes : 0));
    const distanceKm = Number.isFinite(Number(result?.distanceKm))
      ? Number(result.distanceKm)
      : null;

    return {
      distanceKm,
      travelMinutes,
      bufferMinutes,
      durationMin,
      travelLocationType,
    };
  }

  private async resolveSavedRuleSourceToHotspotLeg(
    tx: any,
    routeId: number,
    hotspotId: number,
  ): Promise<{
    distanceKm: number | null;
    durationMin: number;
    sourceName: string;
    destinationName: string;
  } | null> {
    const source = await this.resolveRouteSourceEndpoint(tx, Number(routeId));
    const hotspot = await this.resolveHotspotPreviewEndpoint(tx, Number(hotspotId));
    if (!source?.sourceName || !hotspot?.travelLocationName) return null;

    const savedLeg = await this.resolveSavedRuleTravelLeg({
      tx,
      fromLocationName: source.sourceName,
      toLocationName: hotspot.travelLocationName,
      sourceCoords: Number.isFinite(Number(source.latitude)) && Number.isFinite(Number(source.longitude))
        ? { lat: Number(source.latitude), lon: Number(source.longitude) }
        : null,
      destCoords: hotspot.latitude != null && hotspot.longitude != null
        ? { lat: Number(hotspot.latitude), lon: Number(hotspot.longitude) }
        : null,
      includeBuffer: false,
    });

    return {
      distanceKm: savedLeg.distanceKm,
      durationMin: savedLeg.durationMin,
      sourceName: source.sourceName,
      destinationName: hotspot.hotspotName,
    };
  }

  private async resolveSavedRuleHotspotToHotspotLeg(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
  ): Promise<{
    distanceKm: number | null;
    durationMin: number;
    fromName: string;
    toName: string;
  } | null> {
    const fromHotspot = await this.resolveHotspotPreviewEndpoint(tx, Number(fromHotspotId));
    const toHotspot = await this.resolveHotspotPreviewEndpoint(tx, Number(toHotspotId));
    if (!fromHotspot?.travelLocationName || !toHotspot?.travelLocationName) return null;

    const savedLeg = await this.resolveSavedRuleTravelLeg({
      tx,
      fromLocationName: fromHotspot.travelLocationName,
      toLocationName: toHotspot.travelLocationName,
      sourceCoords: fromHotspot.latitude != null && fromHotspot.longitude != null
        ? { lat: Number(fromHotspot.latitude), lon: Number(fromHotspot.longitude) }
        : null,
      destCoords: toHotspot.latitude != null && toHotspot.longitude != null
        ? { lat: Number(toHotspot.latitude), lon: Number(toHotspot.longitude) }
        : null,
      includeBuffer: false,
    });

    return {
      distanceKm: savedLeg.distanceKm,
      durationMin: savedLeg.durationMin,
      fromName: fromHotspot.hotspotName,
      toName: toHotspot.hotspotName,
    };
  }

  private async resolveSavedRuleHotspotToRouteHotelLeg(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
  ): Promise<{
    distanceKm: number | null;
    durationMin: number;
    fromName: string;
    hotelLabel: string;
    sourceCity: string;
    destinationCity: string;
  } | null> {
    const hotspot = await this.resolveHotspotPreviewEndpoint(tx, Number(hotspotId));
    const destinationCityEndpoint = await this.resolveRouteDestinationCityEndpoint(tx, Number(routeId));
    const selectedHotelEndpoint = await this.resolveSelectedHotelEndpoint(tx, Number(planId), Number(routeId));
    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        next_visiting_location: true,
      },
    });

    if (!hotspot?.travelLocationName || !destinationCityEndpoint) return null;

    const sourceCity = this.getPrimaryTravelLocationLabel(hotspot.travelLocationName) || hotspot.travelLocationName;
    const destinationCity = this.getPrimaryTravelLocationLabel(
      route?.next_visiting_location ||
      destinationCityEndpoint.hotelName ||
      '',
    ) || String(route?.next_visiting_location || destinationCityEndpoint.hotelName || 'Destination').trim();

    const savedLeg = await this.resolveSavedRuleTravelLeg({
      tx,
      fromLocationName: sourceCity,
      toLocationName: destinationCity,
      sourceCoords: hotspot.latitude != null && hotspot.longitude != null
        ? { lat: Number(hotspot.latitude), lon: Number(hotspot.longitude) }
        : null,
      destCoords: Number.isFinite(Number(destinationCityEndpoint.latitude)) && Number.isFinite(Number(destinationCityEndpoint.longitude))
        ? { lat: Number(destinationCityEndpoint.latitude), lon: Number(destinationCityEndpoint.longitude) }
        : null,
      includeBuffer: true,
    });

    return {
      distanceKm: savedLeg.distanceKm,
      durationMin: savedLeg.durationMin,
      fromName: hotspot.hotspotName,
      hotelLabel: String(
        selectedHotelEndpoint?.hotelName ||
        destinationCityEndpoint?.hotelName ||
        'Hotel',
      ).trim(),
      sourceCity,
      destinationCity,
    };
  }

  private extractPreviewCheckinHotelName(row: any): string {
    const explicit = String(
      row?.hotelName ||
      row?.toName ||
      row?.to ||
      '',
    ).trim();
    if (explicit) return explicit;

    const text = String(row?.text || row?.name || '').trim();
    const match = text.match(/check-?in\s+(?:to|at)\s+(.+)/i);
    return String(match?.[1] || '').trim();
  }

  private normalizeManualFitTravelReplicaLabel(value: unknown): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^travel(?:ling)?\s+to\s+/i, '')
      .replace(/^travel(?:ling)?\s+from\s+/i, '')
      .replace(/\s+/g, ' ');
  }

  private parseManualFitTravelReplicaDistanceKm(value: unknown): number | null {
    if (value == null) return null;

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const raw = String(value || '').trim();
    if (!raw) return null;

    const match = raw.match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private getManualFitTravelReplicaDurationMinutes(row: any): number | null {
    const direct = Number(
      row?.matrixDurationMin ||
      row?.durationMinutes ||
      row?.duration_minutes ||
      row?.travelDurationMinutes ||
      0,
    );
    if (Number.isFinite(direct) && direct > 0) {
      return Math.max(1, Math.round(direct));
    }

    const previewMinutes = Number(this.getPreviewRowDurationMinutes(row) || 0);
    if (Number.isFinite(previewMinutes) && previewMinutes > 0) {
      return Math.max(1, Math.round(previewMinutes));
    }

    const startMinutes = this.parseSegmentStartMinutes(row);
    const endMinutes = this.parseSegmentEndMinutes(row);
    if (startMinutes !== null && endMinutes !== null && endMinutes > startMinutes) {
      return Math.max(1, endMinutes - startMinutes);
    }

    return null;
  }

  private buildManualFitMainTimelineTravelReplicaMap(timeline: any[]): Map<string, any> {
    const rows = Array.isArray(timeline) ? timeline : [];
    const map = new Map<string, any>();

    const isAttractionRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };

    const isTravelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'travel' || Number(row?.item_type || 0) === 3 || Number(row?.item_type || 0) === 5;
    };

    const getHotspotId = (row: any): number =>
      Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);

    const getLabel = (row: any): string =>
      String(row?.text || row?.name || row?.title || row?.hotspot_name || '').trim();

    const addKey = (key: string, row: any) => {
      if (!key || map.has(key)) return;
      map.set(key, row);
    };

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!isTravelRow(row)) continue;

      const explicitFromId = Number(row?.fromHotspotId || row?.from_hotspot_id || 0);
      const explicitToId = Number(row?.toHotspotId || row?.to_hotspot_id || 0);
      const explicitFromLabel = String(row?.fromName || row?.from || row?.displayFromName || '').trim();
      const explicitToLabel = String(row?.toName || row?.to || row?.displayToName || '').trim();

      let previousAttraction: any | null = null;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (isAttractionRow(rows[cursor])) {
          previousAttraction = rows[cursor];
          break;
        }
      }

      let nextAttraction: any | null = null;
      for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
        if (isAttractionRow(rows[cursor])) {
          nextAttraction = rows[cursor];
          break;
        }
      }

      const sequenceFromId = getHotspotId(previousAttraction);
      const sequenceToId = getHotspotId(nextAttraction);
      const sequenceFromLabel = getLabel(previousAttraction);
      const sequenceToLabel = getLabel(nextAttraction);

      const fromLabel = explicitFromLabel || sequenceFromLabel;
      const toLabel = explicitToLabel || sequenceToLabel;
      const normalizedFromLabel = this.normalizeManualFitTravelReplicaLabel(fromLabel);
      const normalizedToLabel = this.normalizeManualFitTravelReplicaLabel(toLabel);

      if (explicitFromId > 0 && explicitToId > 0) {
        addKey(`id:${explicitFromId}->${explicitToId}`, row);
      }
      if (sequenceFromId > 0 && sequenceToId > 0) {
        addKey(`id:${sequenceFromId}->${sequenceToId}`, row);
      }
      if (normalizedFromLabel && normalizedToLabel) {
        addKey(`label:${normalizedFromLabel}->${normalizedToLabel}`, row);
      }
      if (explicitToId > 0) {
        addKey(`to:${explicitToId}`, row);
      }
      if (sequenceToId > 0) {
        addKey(`to:${sequenceToId}`, row);
      }
    }

    return map;
  }

  private findManualFitMainTimelineTravelReplica(
    replicaMap: Map<string, any>,
    params: {
      fromHotspotId?: number | null;
      toHotspotId?: number | null;
      fromName?: string | null;
      toName?: string | null;
    },
  ): any | null {
    const keys: string[] = [];
    const fromHotspotId = Number(params.fromHotspotId || 0);
    const toHotspotId = Number(params.toHotspotId || 0);
    const fromName = this.normalizeManualFitTravelReplicaLabel(params.fromName);
    const toName = this.normalizeManualFitTravelReplicaLabel(params.toName);

    if (fromHotspotId > 0 && toHotspotId > 0) {
      keys.push(`id:${fromHotspotId}->${toHotspotId}`);
    }
    if (fromName && toName) {
      keys.push(`label:${fromName}->${toName}`);
    }
    if (toHotspotId > 0 && fromHotspotId <= 0 && !fromName) {
      keys.push(`to:${toHotspotId}`);
    }

    for (const key of keys) {
      const row = replicaMap.get(key);
      if (row) return row;
    }

    return null;
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

  private distancePointToRouteMeters(
    point: { lat: number; lng: number },
    routeGeometry: [number, number][],
  ): number {
    return Number(this.findNearestProgressOnRoute(point, routeGeometry).distanceMeters);
  }

  private projectPointProgressOnRoute(
    point: { lat: number; lng: number },
    routeGeometry: [number, number][],
  ): number {
    return Number(this.findNearestProgressOnRoute(point, routeGeometry).progressRatio);
  }

  private async ensureHotspotPlace(
    tx: any,
    data: {
      hotspotId?: number;
      hotspotName: string;
      hotspotLocation: string;
      lat?: number | null;
      lng?: number | null;
      createdBy?: number;
    },
  ): Promise<number | null> {
    const requestedHotspotId = Number(data?.hotspotId || 0);
    const normalizedName = this.normalizeLocationText(data?.hotspotName || '');
    const normalizedLocation = this.normalizeLocationText(data?.hotspotLocation || '');
    const lat = Number(data?.lat);
    const lng = Number(data?.lng);

    if (requestedHotspotId > 0) {
      const existingById = await (tx as any).dvi_hotspot_place.findFirst({
        where: { hotspot_ID: requestedHotspotId, deleted: 0 },
        select: { hotspot_ID: true },
      });
      if (existingById) {
        console.log('[HotspotPlaceEnsure] existing_found', { hotspotId: requestedHotspotId, mode: 'id' });
        return Number(existingById.hotspot_ID);
      }
    }

    const candidates: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT hotspot_ID, hotspot_name, hotspot_location, hotspot_latitude, hotspot_longitude
      FROM dvi_hotspot_place
      WHERE deleted = 0
        AND LOWER(COALESCE(hotspot_name, '')) = ?
        AND LOWER(COALESCE(hotspot_location, '')) LIKE ?
      LIMIT 20
      `,
      normalizedName,
      `%${normalizedLocation || normalizedName}%`,
    );

    if (Array.isArray(candidates) && candidates.length > 0) {
      const maxMatchMeters = 200;
      const exact = candidates.find((row: any) => {
        const rowId = Number(row?.hotspot_ID || 0);
        if (!rowId) return false;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
        const rowLat = Number(row?.hotspot_latitude);
        const rowLng = Number(row?.hotspot_longitude);
        if (!Number.isFinite(rowLat) || !Number.isFinite(rowLng)) return false;
        const distMeters = this.haversineKmForRouteProjection(lat, lng, rowLat, rowLng) * 1000;
        return distMeters <= maxMatchMeters;
      });

      const matched = exact || candidates[0];
      const matchedId = Number(matched?.hotspot_ID || 0);
      if (matchedId > 0) {
        console.log('[HotspotPlaceEnsure] existing_found', { hotspotId: matchedId, mode: 'name_location' });
        return matchedId;
      }
    }

    const now = new Date();
    const inserted = await (tx as any).dvi_hotspot_place.create({
      data: {
        hotspot_name: String(data?.hotspotName || '').trim() || null,
        hotspot_location: String(data?.hotspotLocation || '').trim() || null,
        hotspot_latitude: Number.isFinite(lat) ? String(lat) : null,
        hotspot_longitude: Number.isFinite(lng) ? String(lng) : null,
        status: 1,
        deleted: 0,
        createdby: Number(data?.createdBy || 0),
        createdon: now,
        updatedon: now,
      },
      select: { hotspot_ID: true },
    });

    const insertedId = Number(inserted?.hotspot_ID || 0);
    if (insertedId > 0) {
      console.log('[HotspotPlaceEnsure] inserted_new', { hotspotId: insertedId });
      return insertedId;
    }

    return null;
  }

  private async ensureRouteBetweenMapRow(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
    betweenHotspotId: number,
  ): Promise<any | null> {
    const fromId = Number(fromHotspotId || 0);
    const toId = Number(toHotspotId || 0);
    const betweenId = Number(betweenHotspotId || 0);
    if (!fromId || !toId || !betweenId) {
      console.log('[RouteBetweenMapEnsure] skipped_no_hotspot_id', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const existingRows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        route_fit_type,
        route_decision_reason,
        road_detour_km,
        road_detour_ratio,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        candidate_distance_from_ab_route_meters,
        destination_distance_from_ac_route_meters
      FROM hotspot_route_between_map
      WHERE (
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
        OR
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
      )
      LIMIT 1
      `,
      fromId,
      toId,
      betweenId,
      toId,
      fromId,
      betweenId,
    );

    if (Array.isArray(existingRows) && existingRows.length > 0) {
      console.log('[RouteBetweenMapEnsure] existing_found', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return existingRows[0];
    }

    const masters: any[] = await (tx as any).dvi_hotspot_place.findMany({
      where: {
        hotspot_ID: { in: [fromId, toId, betweenId] },
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_location: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    const masterMap = new Map<number, any>((masters || []).map((row: any) => [Number(row?.hotspot_ID || 0), row]));
    const from = masterMap.get(fromId);
    const to = masterMap.get(toId);
    const between = masterMap.get(betweenId);

    const fromLat = Number(from?.hotspot_latitude);
    const fromLng = Number(from?.hotspot_longitude);
    const toLat = Number(to?.hotspot_latitude);
    const toLng = Number(to?.hotspot_longitude);
    const betweenLat = Number(between?.hotspot_latitude);
    const betweenLng = Number(between?.hotspot_longitude);

    if (
      !from || !to || !between
      || !Number.isFinite(fromLat) || !Number.isFinite(fromLng)
      || !Number.isFinite(toLat) || !Number.isFinite(toLng)
      || !Number.isFinite(betweenLat) || !Number.isFinite(betweenLng)
    ) {
      console.warn('[RouteBetweenMapEnsure] invalid_coordinates', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const directRoute = await this.getOsrmRouteGeometry(fromLat, fromLng, toLat, toLng);
    if (!directRoute || directRoute.coordinates.length < 2) {
      console.warn('[RouteBetweenMapEnsure] osrm_failed', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const directKm = Number(directRoute.distanceKm);
    const acKm = await this.getOsrmDistanceKm(fromLat, fromLng, betweenLat, betweenLng);
    const cbKm = await this.getOsrmDistanceKm(betweenLat, betweenLng, toLat, toLng);
    if (!Number.isFinite(directKm) || !Number.isFinite(acKm) || !Number.isFinite(cbKm)) {
      console.warn('[RouteBetweenMapEnsure] osrm_failed', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const insertedRouteDistanceKm = Number(acKm) + Number(cbKm);
    const roadDetourKm = insertedRouteDistanceKm - Number(directKm);
    const roadDetourRatio = Number(directKm) > 0 ? roadDetourKm / Number(directKm) : null;
    const candidateDistanceFromRouteMeters = this.distancePointToRouteMeters(
      { lat: betweenLat, lng: betweenLng },
      directRoute.coordinates,
    );
    const candidateProgressOnAbRatio = this.projectPointProgressOnRoute(
      { lat: betweenLat, lng: betweenLng },
      directRoute.coordinates,
    );

    let routeFitType = 'MAJOR_DETOUR';
    if (candidateDistanceFromRouteMeters <= 1000 || roadDetourKm <= 2) {
      routeFitType = 'ON_ROUTE';
    } else if (roadDetourKm <= 10) {
      routeFitType = 'MINOR_DETOUR';
    }

    const routeDecisionReason =
      routeFitType === 'ON_ROUTE'
        ? 'Candidate is on/near OSRM route with low detour.'
        : routeFitType === 'MINOR_DETOUR'
          ? 'Candidate requires acceptable minor OSRM detour.'
          : 'Candidate causes major OSRM detour.';

    if (routeFitType === 'MAJOR_DETOUR') {
      console.log('[RouteBetweenMapEnsure] rejected_major_detour', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
        roadDetourKm: Number(roadDetourKm.toFixed(3)),
      });
    }

    await (tx as any).$executeRawUnsafe(
      `
      INSERT INTO hotspot_route_between_map (
        from_hotspot_id,
        from_hotspot_name,
        from_hotspot_location,
        to_hotspot_id,
        to_hotspot_name,
        to_hotspot_location,
        between_hotspot_id,
        between_hotspot_name,
        distance_from_route_meters,
        detour_km,
        detour_ratio,
        route_fit_type,
        candidate_distance_from_ab_route_meters,
        candidate_progress_on_ab_ratio,
        destination_distance_from_ac_route_meters,
        destination_progress_on_ac_ratio,
        crosses_destination_before_candidate,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        road_detour_km,
        road_detour_ratio,
        route_decision_reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        route_fit_type = VALUES(route_fit_type),
        route_decision_reason = VALUES(route_decision_reason),
        distance_from_route_meters = VALUES(distance_from_route_meters),
        detour_km = VALUES(detour_km),
        detour_ratio = VALUES(detour_ratio),
        candidate_distance_from_ab_route_meters = VALUES(candidate_distance_from_ab_route_meters),
        candidate_progress_on_ab_ratio = VALUES(candidate_progress_on_ab_ratio),
        ab_osrm_distance_km = VALUES(ab_osrm_distance_km),
        ac_osrm_distance_km = VALUES(ac_osrm_distance_km),
        cb_osrm_distance_km = VALUES(cb_osrm_distance_km),
        inserted_route_distance_km = VALUES(inserted_route_distance_km),
        road_detour_km = VALUES(road_detour_km),
        road_detour_ratio = VALUES(road_detour_ratio),
        updated_at = NOW()
      `,
      fromId,
      String(from?.hotspot_name || `Hotspot #${fromId}`),
      String(from?.hotspot_location || ''),
      toId,
      String(to?.hotspot_name || `Hotspot #${toId}`),
      String(to?.hotspot_location || ''),
      betweenId,
      String(between?.hotspot_name || `Hotspot #${betweenId}`),
      candidateDistanceFromRouteMeters,
      roadDetourKm,
      roadDetourRatio,
      routeFitType,
      candidateDistanceFromRouteMeters,
      candidateProgressOnAbRatio,
      null,
      null,
      Number(directKm),
      Number(acKm),
      Number(cbKm),
      insertedRouteDistanceKm,
      roadDetourKm,
      roadDetourRatio,
      routeDecisionReason,
    );

    const insertedRows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        route_fit_type,
        route_decision_reason,
        road_detour_km,
        road_detour_ratio,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        candidate_distance_from_ab_route_meters,
        destination_distance_from_ac_route_meters
      FROM hotspot_route_between_map
      WHERE (
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
        OR
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
      )
      LIMIT 1
      `,
      fromId,
      toId,
      betweenId,
      toId,
      fromId,
      betweenId,
    );

    const insertedRow = Array.isArray(insertedRows) && insertedRows.length > 0 ? insertedRows[0] : null;
    console.log('[RouteBetweenMapEnsure] inserted_new', {
      fromHotspotId: fromId,
      toHotspotId: toId,
      betweenHotspotId: betweenId,
      routeFitType,
    });
    return insertedRow;
  }

  private async getRouteBetweenRejectionRow(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
    betweenHotspotId: number,
  ): Promise<any | null> {
    const fromId = Number(fromHotspotId || 0);
    const toId = Number(toHotspotId || 0);
    const betweenId = Number(betweenHotspotId || 0);
    if (!fromId || !toId || !betweenId) {
      return null;
    }

    const rows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        rejection_code,
        rejection_reason,
        route_fit_type,
        candidate_distance_from_ab_route_meters,
        road_detour_km,
        road_detour_ratio,
        error_message
      FROM hotspot_route_between_rejections
      WHERE (
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
        OR
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
      )
      LIMIT 1
      `,
      fromId,
      toId,
      betweenId,
      toId,
      fromId,
      betweenId,
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    return rows[0];
  }

  private async findLastSourceCityHotspotOnOsrmRoute(
    tx: any,
    params: {
      routeId: number;
      sourceCityKey: string;
      destinationCityKey: string;
      candidateHotspotId: number;
      debug?: boolean;
    },
  ): Promise<{
    sourceAnchorHotspotId: number;
    sourceAnchorName: string;
    sourceAnchorDistanceFromRouteMeters: number;
    sourceAnchorProgressRatio: number;
    nextRouteHotspotId: number;
    osrmFailed: boolean;
    candidateDistanceFromRouteMeters: number | null;
    anchorSelectionWhy?: string;
    anchorSelectionDebug?: any;
  } | null> {
    const routeId = Number(params?.routeId || 0);
    const candidateHotspotId = Number(params?.candidateHotspotId || 0);
    const sourceCityKey = this.deriveLooseCityKey(params?.sourceCityKey || '');
    const destinationCityKey = this.deriveLooseCityKey(params?.destinationCityKey || '');
    const debug = params?.debug === true;
    if (!routeId || !candidateHotspotId) {
      return null;
    }

    const routeRows: any[] = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      orderBy: { hotspot_order: 'asc' },
      select: {
        hotspot_ID: true,
        hotspot_order: true,
      },
    });

    const routeHotspotIds = (routeRows || []).map((row: any) => Number(row?.hotspot_ID || 0)).filter((id: number) => id > 0);
    if (routeHotspotIds.length < 2) {
      return null;
    }

    const hotspotRows: any[] = await (tx as any).dvi_hotspot_place.findMany({
      where: { hotspot_ID: { in: routeHotspotIds.concat([candidateHotspotId]) }, deleted: 0 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_location: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });
    const hotspotMap = new Map<number, any>((hotspotRows || []).map((row: any) => [Number(row?.hotspot_ID || 0), row]));

    if (debug) {
      const routeDebugRows = (routeRows || []).map((rr: any) => {
        const hp = hotspotMap.get(Number(rr?.hotspot_ID || 0));
        return {
          hotspot_ID: Number(rr?.hotspot_ID || 0),
          hotspot_name: String(hp?.hotspot_name || ''),
          hotspot_location: String(hp?.hotspot_location || ''),
          latitude: Number(hp?.hotspot_latitude),
          longitude: Number(hp?.hotspot_longitude),
          hotspot_order: Number(rr?.hotspot_order || 0),
        };
      });
      console.log('[OSRMSourceRoute][AnchorSelectionDebug] active_route_hotspots_loaded', {
        routeId,
        hotspots: routeDebugRows,
      });
    }

    const orderedExisting = routeHotspotIds
      .map((id: number) => ({ id, row: hotspotMap.get(id) }))
      .filter((item: any) => {
        const lat = Number(item?.row?.hotspot_latitude);
        const lng = Number(item?.row?.hotspot_longitude);
        return Number.isFinite(lat) && Number.isFinite(lng);
      });

    if (orderedExisting.length < 2) {
      console.warn('[ManualMatrixEnsure] invalid_coordinates', { routeId, reason: 'No valid route endpoint coordinates.' });
      return null;
    }

    const start = orderedExisting[0];
    const end = orderedExisting[orderedExisting.length - 1];
    const startLat = Number(start.row?.hotspot_latitude);
    const startLng = Number(start.row?.hotspot_longitude);
    const endLat = Number(end.row?.hotspot_latitude);
    const endLng = Number(end.row?.hotspot_longitude);

    const routeGeometry = await this.getOsrmRouteGeometry(startLat, startLng, endLat, endLng);
    if (!routeGeometry || routeGeometry.coordinates.length < 2) {
      console.warn('[ManualMatrixEnsure] osrm_failed', { routeId, fromHotspotId: start.id, toHotspotId: end.id });
      return {
        sourceAnchorHotspotId: start.id,
        sourceAnchorName: String(start.row?.hotspot_name || `Hotspot #${start.id}`),
        sourceAnchorDistanceFromRouteMeters: 0,
        sourceAnchorProgressRatio: 0,
        nextRouteHotspotId: Number(orderedExisting[1]?.id || 0),
        osrmFailed: true,
        candidateDistanceFromRouteMeters: null,
        anchorSelectionWhy: debug ? 'OSRM route geometry unavailable; fallback anchor could not be evaluated with debug scoring.' : undefined,
        anchorSelectionDebug: debug ? { routeId, osrmFailed: true } : undefined,
      };
    }

    if (debug) {
      console.log('[OSRMSourceRoute][AnchorSelectionDebug] osrm_route_geometry_result', {
        routeId,
        sourceCoordinates: { lat: startLat, lng: startLng },
        destinationCoordinates: { lat: endLat, lng: endLng },
        totalRouteDistanceKm: Number(routeGeometry?.distanceKm ?? 0),
      });
    }

    console.log('[OSRMSourceRoute] route_geometry_loaded', {
      routeId,
      sourceCityKey,
      destinationCityKey,
      points: routeGeometry.coordinates.length,
    });

    const candidate = hotspotMap.get(candidateHotspotId);
    const candidateLat = Number(candidate?.hotspot_latitude);
    const candidateLng = Number(candidate?.hotspot_longitude);
    const candidateDistanceFromRouteMeters = Number.isFinite(candidateLat) && Number.isFinite(candidateLng)
      ? this.distancePointToRouteMeters({ lat: candidateLat, lng: candidateLng }, routeGeometry.coordinates)
      : null;

    console.log('[OSRMSourceRoute] candidate_distance_checked', {
      routeId,
      candidateHotspotId,
      candidateDistanceFromRouteMeters,
    });

    const maxRouteMeters = Number(process.env.SOURCE_CITY_EXIT_MAX_ROUTE_METERS || 1000);
    const mapped = orderedExisting.map((item: any, index: number) => {
      const row = item.row;
      const lat = Number(row?.hotspot_latitude);
      const lng = Number(row?.hotspot_longitude);
      const locationKey = this.deriveLooseCityKey(String(row?.hotspot_location || ''));
      const distance = this.distancePointToRouteMeters({ lat, lng }, routeGeometry.coordinates);
      const progress = this.projectPointProgressOnRoute({ lat, lng }, routeGeometry.coordinates);
      return {
        index,
        hotspotId: Number(item.id),
        hotspotName: String(row?.hotspot_name || `Hotspot #${item.id}`),
        hotspotLocation: String(row?.hotspot_location || ''),
        locationKey,
        distanceFromRouteMeters: Number(distance),
        progressRatio: Number(progress),
      };
    });

    const candidateEvaluation = mapped.map((row: any) => {
      const isCandidateSelf = Number(row.hotspotId) === Number(candidateHotspotId);
      const isWithinDistance = Number(row.distanceFromRouteMeters) <= maxRouteMeters;
      const isSourceCity = !!sourceCityKey && String(row.locationKey || '') === String(sourceCityKey || '');
      const isBeforeDestinationProgress = Number(row.progressRatio) < 0.95;
      const accepted = !isCandidateSelf && isWithinDistance && (isSourceCity || isBeforeDestinationProgress);

      let reason = 'accepted';
      if (isCandidateSelf) {
        reason = 'rejected: current manual candidate hotspot is not eligible as source anchor';
      } else if (!isWithinDistance) {
        reason = `rejected: distanceFromRouteMeters exceeds threshold (${maxRouteMeters})`;
      } else if (!(isSourceCity || isBeforeDestinationProgress)) {
        reason = 'rejected: neither source city nor before destination-progress cutoff';
      }

      return {
        hotspot_ID: Number(row.hotspotId),
        hotspot_name: String(row.hotspotName || ''),
        distanceFromRouteMeters: Number(row.distanceFromRouteMeters),
        progressRatio: Number(row.progressRatio),
        isSourceCity,
        accepted,
        reason,
      };
    });

    if (debug) {
      for (const evalRow of candidateEvaluation) {
        console.log('[OSRMSourceRoute][AnchorSelectionDebug] candidate_evaluation', {
          routeId,
          hotspot_ID: Number(evalRow.hotspot_ID),
          hotspot_name: String(evalRow.hotspot_name),
          distanceFromRouteMeters: Number(evalRow.distanceFromRouteMeters),
          progressRatio: Number(evalRow.progressRatio),
          isSourceCity: evalRow.isSourceCity,
          decision: evalRow.accepted ? 'accepted' : 'rejected',
          reason: String(evalRow.reason),
        });
      }
    }

    const candidates = mapped
      .filter((row: any) => row.hotspotId !== candidateHotspotId)
      .filter((row: any) => row.distanceFromRouteMeters <= maxRouteMeters)
      .filter((row: any) => (
        (!!sourceCityKey && row.locationKey === sourceCityKey)
        || row.progressRatio < 0.95
      ))
      .sort((a: any, b: any) => b.progressRatio - a.progressRatio || a.distanceFromRouteMeters - b.distanceFromRouteMeters);

    const selected = candidates[0] || mapped[0] || null;
    if (!selected) {
      return null;
    }

    const selectedIndex = mapped.findIndex((row: any) => Number(row.hotspotId) === Number(selected.hotspotId));
    const nextRouteHotspotId = selectedIndex >= 0 && selectedIndex + 1 < mapped.length
      ? Number(mapped[selectedIndex + 1].hotspotId)
      : Number(mapped[1]?.hotspotId || 0);

    const selectionWhy = [
      `Selected hotspot ${Number(selected.hotspotId)} as source anchor because it is active on route ${routeId}.`,
      `distanceFromRouteMeters=${Number(selected.distanceFromRouteMeters).toFixed(2)} (threshold ${maxRouteMeters}).`,
      `sourceCityMatch=${String((!!sourceCityKey && String(selected.locationKey || '') === String(sourceCityKey || '')))}.`,
      'Among accepted source-side/on-route hotspots it had highest progressRatio before route exits source side.',
    ].join(' ');

    if (debug) {
      console.log('[OSRMSourceRoute][AnchorSelectionDebug] final_selected_anchor', {
        routeId,
        selectedHotspotId: Number(selected.hotspotId),
        selectedHotspotName: String(selected.hotspotName),
        whySelected: selectionWhy,
        nextRouteHotspotId,
      });
    }

    console.log('[OSRMSourceRoute] source_anchor_selected', {
      routeId,
      sourceAnchorHotspotId: Number(selected.hotspotId),
      sourceAnchorName: String(selected.hotspotName),
      sourceAnchorProgressRatio: Number(selected.progressRatio),
      sourceAnchorDistanceFromRouteMeters: Number(selected.distanceFromRouteMeters),
      nextRouteHotspotId,
    });

    return {
      sourceAnchorHotspotId: Number(selected.hotspotId),
      sourceAnchorName: String(selected.hotspotName),
      sourceAnchorDistanceFromRouteMeters: Number(selected.distanceFromRouteMeters),
      sourceAnchorProgressRatio: Number(selected.progressRatio),
      nextRouteHotspotId,
      osrmFailed: false,
      candidateDistanceFromRouteMeters,
      anchorSelectionWhy: debug ? selectionWhy : undefined,
      anchorSelectionDebug: debug
        ? {
            routeId,
            sourceCityKey,
            destinationCityKey,
            maxRouteMeters,
            candidateDistanceFromRouteMeters,
            candidateEvaluation,
            selected: {
              hotspot_ID: Number(selected.hotspotId),
              hotspot_name: String(selected.hotspotName),
              distanceFromRouteMeters: Number(selected.distanceFromRouteMeters),
              progressRatio: Number(selected.progressRatio),
            },
            nextRouteHotspotId,
          }
        : undefined,
    };
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
    const explicit =
      Number(params?.options?.manualPriority || 0)
      || Number(params?.manualInsertionFit?.selectedManualPriority || 0)
      || Number(params?.manualInsertionFit?.manualPriority || 0);

    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }

    return 4;
  }

  /**
   * Build the manualInsertionFit block by querying hotspot_route_between_map
   * for every existing hotspot-to-hotspot slot in the route.
   */
  // ─────────────────────────────────────────────────────────────────────────────

  private buildManualSlotInsights(
    candidates: ManualInsertionCandidateResult[],
    manualHotspotIds: number[],
    baselineAttractions: any[],
    masterMap: Map<number, any>,
  ): Array<{
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
  }> {
    const manualSet = new Set((manualHotspotIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0));

    const sorted = [...(baselineAttractions || [])]
      .filter((r: any) => {
        const itemType = Number(r?.item_type ?? r?.itemType ?? 0);
        if (itemType > 0) return itemType === 4;
        return Number(r?.hotspotId ?? r?.hotspot_ID ?? 0) > 0;
      })
      .sort((a: any, b: any) => Number(a?.hotspotOrder ?? a?.hotspot_order ?? 0) - Number(b?.hotspotOrder ?? b?.hotspot_order ?? 0));

    // Get the manual hotspot ID (assuming single manual hotspot for now)
    const manualHotspotId = manualHotspotIds && manualHotspotIds.length > 0 ? manualHotspotIds[0] : 0;

    const built = (candidates || []).map((candidate, index) => {
      const selectedRow = (candidate?.fullTimeline || []).find((row: any) => {
        const hotspotId = Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || 0);
        return Number(row?.item_type || 0) === 4 && manualSet.has(hotspotId);
      });

      const fitsTiming = selectedRow?.isConflict !== true;
      const ci = Number(candidate?.candidateIndex ?? index);

      // For slot candidateIndex = i:
      //   from = sorted[i-1] (attraction before insertion point) or Route Start
      //   to   = sorted[i]   (attraction after insertion point) or Hotel/Destination
      const fromRow = ci > 0 ? sorted[ci - 1] : null;
      const toRow = ci < sorted.length ? sorted[ci] : null;
      const fromName = fromRow ? String(fromRow?.hotspot_name || fromRow?.name || `Stop ${ci}`) : 'Route Start';
      const toName = toRow ? String(toRow?.hotspot_name || toRow?.name || `Stop ${ci + 1}`) : 'Hotel / Destination';

      const fromId = Number(fromRow?.hotspot_ID || fromRow?.hotspotId || 0);
      const toId = Number(toRow?.hotspot_ID || toRow?.hotspotId || 0);

      const directKmRaw = fromId && toId
        ? this.distanceBetweenHotspots(masterMap, fromId, toId)
        : 0;
      const viaFromManualRaw = fromId && manualHotspotId
        ? this.distanceBetweenHotspots(masterMap, fromId, manualHotspotId)
        : 0;
      const viaManualToRaw = manualHotspotId && toId
        ? this.distanceBetweenHotspots(masterMap, manualHotspotId, toId)
        : 0;

      const directKm = Number(directKmRaw.toFixed(2));
      const localDetourKmRaw = (fromId && toId && manualHotspotId)
        ? Math.max(0, (viaFromManualRaw + viaManualToRaw) - directKmRaw)
        : 0;
      const extraKm = Number(localDetourKmRaw.toFixed(2));
      const viaKm = Number((directKmRaw + localDetourKmRaw).toFixed(2));

      // **GEOGRAPHIC FEASIBILITY CHECK**: Validate if the hotspot is actually on the route
      let isGeographicallyFeasible = true;
      let geoReason: string | null = null;
      
      if (fromId && toId && manualHotspotId && fromRow && toRow) {
        const detourRatio = directKmRaw > 0 ? (localDetourKmRaw / directKmRaw) : 0;
        const detourTooHigh = localDetourKmRaw > 0.5;
        const ratioTooHigh = directKmRaw > 0 && detourRatio > 0.08;
        isGeographicallyFeasible = !(detourTooHigh || ratioTooHigh);
        if (!isGeographicallyFeasible) {
          geoReason = `${String(selectedRow?.hotspot_name || 'Hotspot')} is geographically off the direct route between ${fromName} and ${toName} (detour ~${extraKm.toFixed(1)} km).`;
        }
      }

      // Combine feasibility: it must fit timing AND be geographically on-route AND pass candidate success
      const isOverallFeasible = candidate?.success === true && isGeographicallyFeasible;

      return {
        slotOrder: index,
        candidateIndex: ci,
        distanceDelta: extraKm,
        fromName,
        toName,
        directKm,
        viaKm,
        isBest: false, // assigned below
        proposedTimeRange: selectedRow?.timeRange || null,
        operatingHours: selectedRow?.timings || null,
        fitsTiming,
        fitsOverall: isOverallFeasible,
        reason: fitsTiming
          ? (isOverallFeasible
              ? null
              : (geoReason || String(candidate?.reason || 'This slot does not fit route constraints.')))
          : String(selectedRow?.conflictReason || candidate?.reason || 'Will not fit between these stops.'),
      };
    });

    // Mark the best candidate (lowest detour among feasible, else lowest overall)
    const feasible = built.filter((s) => s.fitsOverall);
    const pool = feasible.length > 0 ? feasible : built;
    if (pool.length > 0) {
      const best = pool.reduce((a, b) => a.distanceDelta <= b.distanceDelta ? a : b);
      best.isBest = true;
    }

    return built;
  }

  private async enrichManualFitPreviewTimelineWithOperatingHours(
    planId: number,
    routeId: number,
    timeline: any[],
  ): Promise<any[]> {
    const rows = Array.isArray(timeline) ? timeline : [];
    if (rows.length === 0) return rows;

    const attractionIds = Array.from(new Set(
      rows
        .filter((row: any) => (
          String(row?.type || '').toLowerCase() === 'attraction'
          || Number(row?.item_type || 0) === 4
        ))
        .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ));

    if (attractionIds.length === 0) return rows;

    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        itinerary_route_date: true,
      },
    });

    const routeDate = route?.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
    const dayOfWeek = routeDate ? (routeDate.getDay() + 6) % 7 : 0;
    const timingRows = await (this.prisma as any).dvi_hotspot_timing.findMany({
      where: {
        hotspot_ID: { in: attractionIds },
        status: 1,
        deleted: 0,
      },
      orderBy: [
        { hotspot_timing_day: 'asc' },
        { hotspot_start_time: 'asc' },
        { hotspot_timing_ID: 'asc' },
      ],
    });

    const timingMap = new Map<number, any[]>();
    for (const timing of timingRows || []) {
      const hotspotId = Number(timing?.hotspot_ID || 0);
      if (!hotspotId) continue;
      if (!timingMap.has(hotspotId)) {
        timingMap.set(hotspotId, []);
      }
      timingMap.get(hotspotId)!.push(timing);
    }

    const buildOperatingHours = (timings: any[]): {
      operatingHours: string | null;
      openingTime: string | null;
      closingTime: string | null;
    } => {
      const dayTimings = (timings || []).filter((row: any) => Number(row?.hotspot_timing_day) === dayOfWeek);
      const todayTimings = dayTimings.filter((row: any) => Number(row?.hotspot_closed || 0) !== 1);

      if (dayTimings.length > 0 && todayTimings.length === 0) {
        return {
          operatingHours: 'Closed',
          openingTime: null,
          closingTime: null,
        };
      }

      if (todayTimings.length === 0) {
        return {
          operatingHours: null,
          openingTime: null,
          closingTime: null,
        };
      }

      if (todayTimings.some((row: any) => Number(row?.hotspot_open_all_time || 0) === 1)) {
        return {
          operatingHours: 'Open 24 Hours',
          openingTime: '00:00:00',
          closingTime: '23:59:59',
        };
      }

      const operatingHours = todayTimings
        .map((row: any) => `${this.formatTime(row?.hotspot_start_time as any)} - ${this.formatTime(row?.hotspot_end_time as any)}`)
        .join(', ');

      const openingTime = todayTimings[0]?.hotspot_start_time
        ? this.formatTime(todayTimings[0].hotspot_start_time as any)
        : null;
      const closingTime = todayTimings[todayTimings.length - 1]?.hotspot_end_time
        ? this.formatTime(todayTimings[todayTimings.length - 1].hotspot_end_time as any)
        : null;

      return {
        operatingHours: operatingHours || null,
        openingTime,
        closingTime,
      };
    };

    return rows.map((row: any) => {
      const isAttractionLike =
        String(row?.type || '').toLowerCase() === 'attraction' ||
        Number(row?.item_type || 0) === 4;
      if (!isAttractionLike) return row;

      const hotspotId = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0);
      if (!hotspotId) return row;

      const timingSummary = buildOperatingHours(timingMap.get(hotspotId) || []);
      return {
        ...row,
        timings: timingSummary.operatingHours || row?.timings || null,
        operatingHours: timingSummary.operatingHours || row?.operatingHours || row?.timings || null,
        openingTime: timingSummary.openingTime || row?.openingTime || null,
        closingTime: timingSummary.closingTime || row?.closingTime || null,
      };
    });
  }

  private normalizeManualFitTimeText(value: any): string {
    return String(value || '')
      .replace(/\u2013|\u2014/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractTimeWindowsFromLabel(value: any): Array<{
    startLabel: string;
    endLabel: string;
    startMinutes: number;
    endMinutes: number;
  }> {
    const raw = this.normalizeManualFitTimeText(value);
    if (!raw || /open\s*24/i.test(raw)) return [];

    const windows: Array<{
      startLabel: string;
      endLabel: string;
      startMinutes: number;
      endMinutes: number;
    }> = [];

    const regex =
      /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*(?:-|to)\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/gi;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const startLabel = this.normalizeManualFitTimeText(match[1]);
      const endLabel = this.normalizeManualFitTimeText(match[2]);
      const startMinutes = this.parsePreviewTimeToMinutes(startLabel);
      const endMinutes = this.parsePreviewTimeToMinutes(endLabel);

      if (startMinutes === null || endMinutes === null) continue;

      windows.push({
        startLabel,
        endLabel,
        startMinutes,
        endMinutes,
      });
    }

    return windows;
  }

  private evaluateTimelineRowAgainstOperatingHours(row: any): {
    valid: boolean;
    reason: string | null;
    attemptedVisitTime: string | null;
    operatingHours: string | null;
    attemptedStartLabel: string | null;
    attemptedEndLabel: string | null;
    openingLabel: string | null;
    closingLabel: string | null;
  } {
    const attemptedVisitTime = this.normalizeManualFitTimeText(
      row?.timeRange || row?.visitTime || row?.attemptedVisitTime || '',
    );

    const operatingHours = this.normalizeManualFitTimeText(
      row?.timings || row?.operatingHours || row?.hotspot_timings || '',
    );

    if (!attemptedVisitTime || !attemptedVisitTime.includes('-')) {
      return {
        valid: false,
        reason: 'Selected hotspot has no valid attempted visit time in the preview timeline.',
        attemptedVisitTime: attemptedVisitTime || null,
        operatingHours: operatingHours || null,
        attemptedStartLabel: null,
        attemptedEndLabel: null,
        openingLabel: null,
        closingLabel: null,
      };
    }

    if (/^closed$/i.test(operatingHours)) {
      return {
        valid: false,
        reason: `Selected hotspot is closed on this route date. Attempted visit time is ${attemptedVisitTime}.`,
        attemptedVisitTime,
        operatingHours,
        attemptedStartLabel: null,
        attemptedEndLabel: null,
        openingLabel: null,
        closingLabel: null,
      };
    }

    if (!operatingHours || /open\s*24/i.test(operatingHours)) {
      return {
        valid: true,
        reason: null,
        attemptedVisitTime,
        operatingHours: operatingHours || null,
        attemptedStartLabel: null,
        attemptedEndLabel: null,
        openingLabel: null,
        closingLabel: null,
      };
    }

    const attemptedWindows = this.extractTimeWindowsFromLabel(attemptedVisitTime);
    const operatingWindows = this.extractTimeWindowsFromLabel(operatingHours);
    const attempted = attemptedWindows[0];

    if (!attempted || operatingWindows.length === 0) {
      return {
        valid: true,
        reason: null,
        attemptedVisitTime,
        operatingHours,
        attemptedStartLabel: attempted?.startLabel || null,
        attemptedEndLabel: attempted?.endLabel || null,
        openingLabel: operatingWindows[0]?.startLabel || null,
        closingLabel: operatingWindows[0]?.endLabel || null,
      };
    }

    const fitsAnyWindow = operatingWindows.some((window) => {
      if (window.endMinutes >= window.startMinutes) {
        return attempted.startMinutes >= window.startMinutes && attempted.endMinutes <= window.endMinutes;
      }

      const attemptedStart = attempted.startMinutes < window.startMinutes
        ? attempted.startMinutes + (24 * 60)
        : attempted.startMinutes;
      const attemptedEnd = attempted.endMinutes < window.startMinutes
        ? attempted.endMinutes + (24 * 60)
        : attempted.endMinutes;
      const operatingEnd = window.endMinutes + (24 * 60);

      return attemptedStart >= window.startMinutes && attemptedEnd <= operatingEnd;
    });

    if (fitsAnyWindow) {
      return {
        valid: true,
        reason: null,
        attemptedVisitTime,
        operatingHours,
        attemptedStartLabel: attempted.startLabel,
        attemptedEndLabel: attempted.endLabel,
        openingLabel: operatingWindows[0]?.startLabel || null,
        closingLabel: operatingWindows[0]?.endLabel || null,
      };
    }

    const firstWindow = operatingWindows[0];

    return {
      valid: false,
      reason: `Selected hotspot is closed at attempted visit time ${attemptedVisitTime}. Operating hours are ${operatingHours}.`,
      attemptedVisitTime,
      operatingHours,
      attemptedStartLabel: attempted.startLabel,
      attemptedEndLabel: attempted.endLabel,
      openingLabel: firstWindow?.startLabel || null,
      closingLabel: firstWindow?.endLabel || null,
    };
  }

  private adjustManualFitVisitStartToOperatingWindow(
    row: any,
    arrivalMinutes: number,
    durationMinutes: number,
  ): {
    valid: boolean;
    startMinutes: number;
    waitingMinutes: number;
    operatingHours: string | null;
  } {
    const operatingHours = this.normalizeManualFitTimeText(
      row?.timings || row?.operatingHours || row?.hotspot_timings || '',
    );

    if (!operatingHours || /open\s*24/i.test(operatingHours)) {
      return {
        valid: true,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours: operatingHours || null,
      };
    }

    if (/^closed$/i.test(operatingHours)) {
      return {
        valid: false,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours,
      };
    }

    const windows = this.extractTimeWindowsFromLabel(operatingHours);
    if (windows.length === 0) {
      return {
        valid: true,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours,
      };
    }

    const safeDurationMinutes = Math.max(1, Math.round(Number(durationMinutes || 0) || 0));
    let bestStart: number | null = null;

    for (const window of windows) {
      if (window.endMinutes < window.startMinutes) continue;

      const candidateStart = Math.max(arrivalMinutes, window.startMinutes);
      if ((candidateStart + safeDurationMinutes) <= window.endMinutes) {
        bestStart = candidateStart;
        break;
      }
    }

    if (bestStart === null) {
      return {
        valid: false,
        startMinutes: arrivalMinutes,
        waitingMinutes: 0,
        operatingHours,
      };
    }

    return {
      valid: true,
      startMinutes: bestStart,
      waitingMinutes: Math.max(0, bestStart - arrivalMinutes),
      operatingHours,
    };
  }

  private getSelectedManualClosingOverflow(params: {
    timeline: any[];
    selectedHotspotIds: number[];
  }): {
    hasClosingOverflow: boolean;
    hotspotId: number | null;
    hotspotName: string | null;
    attemptedVisitTime: string | null;
    operatingHours: string | null;
    overflowMinutes: number;
    latestAllowedEndMinutes: number | null;
    conflict: any | null;
  } {
    const selectedSet = new Set(
      (params.selectedHotspotIds || [])
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    const timeline = Array.isArray(params.timeline) ? params.timeline : [];

    for (const row of timeline) {
      const isAttraction =
        String(row?.type || '').toLowerCase() === 'attraction' ||
        Number(row?.item_type || 0) === 4;

      if (!isAttraction) continue;

      const hotspotId = Number(
        row?.locationId ||
        row?.hotspotId ||
        row?.hotspot_ID ||
        row?.hotspot_id ||
        0,
      );

      if (!selectedSet.has(hotspotId)) continue;

      const evaluation = this.evaluateTimelineRowAgainstOperatingHours(row);

      if (evaluation.valid) {
        return {
          hasClosingOverflow: false,
          hotspotId,
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          overflowMinutes: 0,
          latestAllowedEndMinutes: null,
          conflict: null,
        };
      }

      const attemptedWindows = this.extractTimeWindowsFromLabel(evaluation.attemptedVisitTime || '');
      const operatingWindows = this.extractTimeWindowsFromLabel(evaluation.operatingHours || '');
      const attempted = attemptedWindows[0];
      const operating = operatingWindows[0];

      if (!attempted || !operating) {
        return {
          hasClosingOverflow: false,
          hotspotId,
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          overflowMinutes: 0,
          latestAllowedEndMinutes: null,
          conflict: null,
        };
      }

      const overflowMinutes = Math.max(0, attempted.endMinutes - operating.endMinutes);

      if (overflowMinutes <= 0) {
        return {
          hasClosingOverflow: false,
          hotspotId,
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          overflowMinutes: 0,
          latestAllowedEndMinutes: operating.endMinutes,
          conflict: null,
        };
      }

      const hotspotName = String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`);
      const conflict = {
        hotspotId,
        hotspotName,
        attemptedVisitTime: evaluation.attemptedVisitTime,
        attemptedStartTime: evaluation.attemptedStartLabel,
        attemptedEndTime: evaluation.attemptedEndLabel,
        operatingHours: evaluation.operatingHours,
        openingTime: evaluation.openingLabel,
        closingTime: evaluation.closingLabel,
        overflowMinutes,
        reasonCode: 'SELECTED_HOTSPOT_EXCEEDS_CLOSING_TIME',
        reason: `${hotspotName} ends ${overflowMinutes} minute(s) after closing. Attempted: ${evaluation.attemptedVisitTime}. Operating hours: ${evaluation.operatingHours}.`,
      };

      return {
        hasClosingOverflow: true,
        hotspotId,
        hotspotName,
        attemptedVisitTime: evaluation.attemptedVisitTime,
        operatingHours: evaluation.operatingHours,
        overflowMinutes,
        latestAllowedEndMinutes: operating.endMinutes,
        conflict,
      };
    }

    return {
      hasClosingOverflow: false,
      hotspotId: null,
      hotspotName: null,
      attemptedVisitTime: null,
      operatingHours: null,
      overflowMinutes: 0,
      latestAllowedEndMinutes: null,
      conflict: null,
    };
  }

  private markSelectedManualOperatingHourConflicts(
    timeline: any[],
    selectedHotspotIds: number[],
  ): {
    timeline: any[];
    selectedOpeningConflict: any | null;
  } {
    const selectedSet = new Set(
      (selectedHotspotIds || [])
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    if (!Array.isArray(timeline) || selectedSet.size === 0) {
      return { timeline: Array.isArray(timeline) ? timeline : [], selectedOpeningConflict: null };
    }

    let selectedOpeningConflict: any | null = null;

    const nextTimeline = timeline.map((row: any) => {
      const isAttraction =
        String(row?.type || '').toLowerCase() === 'attraction' ||
        Number(row?.item_type || 0) === 4;

      if (!isAttraction) return row;

      const hotspotId = Number(
        row?.locationId ||
        row?.hotspot_ID ||
        row?.hotspotId ||
        row?.hotspot_id ||
        0,
      );

      if (!selectedSet.has(hotspotId)) return row;

      const evaluation = this.evaluateTimelineRowAgainstOperatingHours(row);

      if (evaluation.valid) {
        return {
          ...row,
          isConflict: false,
          is_conflict: 0,
          conflictReason: null,
          conflict_reason: null,
          selectedOpeningConflict: null,
          attemptedVisitTime: evaluation.attemptedVisitTime,
          operatingHours: evaluation.operatingHours,
          manualFitStatus: row?.manualFitStatus === 'INSERTED' ? row.manualFitStatus : null,
        };
      }

      const conflictPayload = {
        hotspotId,
        hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${hotspotId}`),
        attemptedVisitTime: evaluation.attemptedVisitTime,
        attemptedStartTime: evaluation.attemptedStartLabel,
        attemptedEndTime: evaluation.attemptedEndLabel,
        operatingHours: evaluation.operatingHours,
        openingTime: evaluation.openingLabel,
        closingTime: evaluation.closingLabel,
        reason: evaluation.reason,
        reasonCode: 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME',
      };

      selectedOpeningConflict = selectedOpeningConflict || conflictPayload;

      return {
        ...row,
        isConflict: true,
        is_conflict: 1,
        conflictReason: evaluation.reason,
        conflict_reason: evaluation.reason,
        selectedOpeningConflict: conflictPayload,
        attemptedVisitTime: evaluation.attemptedVisitTime,
        operatingHours: evaluation.operatingHours,
        manualFitStatus: 'CANNOT_INSERT',
      };
    });

    return { timeline: nextTimeline, selectedOpeningConflict };
  }

  private buildManualHotspotValidation(params: {
    route: any;
    requestedHotspotIds: number[];
    fullTimeline: any[];
    manualTimingPolicy: ManualHotspotTimingPolicy;
    adaptive: {
      requiresConfirmation: boolean;
      unscheduledManualHotspots: Array<{ id: number; name: string; reason: string }>;
      reason: string | null;
    };
  }): {
    passesScheduleRules: boolean;
    readyToApply: boolean;
    requiresPriorityConfirmation: boolean;
    requiresTimingRiskConfirmation?: boolean;
    requiresForceConfirmation: boolean;
    stillUnschedulable: boolean;
    softManualRouteFitConflict: boolean;
    routeEndOverflowMinutes: number;
    manualTimingPolicy: ManualHotspotTimingPolicy;
    openingHourConflictCount: number;
    selectedManualConflictCount: number;
    scheduledSelectedManualCount: number;
    unscheduledManualCount: number;
    reason: string | null;
    selectedOpeningConflict?: any | null;
  } {
    const { route, requestedHotspotIds, fullTimeline, manualTimingPolicy, adaptive } = params;
    const requestedHotspotIdSet = new Set(
      (requestedHotspotIds || [])
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );

    const routeEndOverflowMinutes = this.calculateRouteEndOverflowMinutes(
      fullTimeline || [],
      route,
      manualTimingPolicy.endTime,
    );
    const isAttractionRow = (row: any) => (
      String(row?.type || '').toLowerCase() === 'attraction'
      || Number(row?.item_type || 0) === 4
    );
    const getRowHotspotId = (row: any) => Number(
      row?.locationId
      || row?.hotspot_ID
      || row?.hotspotId
      || row?.hotspot_id
      || row?.id
      || 0,
    );
    const selectedAttractionRows = (fullTimeline || []).filter((row: any) => (
      isAttractionRow(row)
      && requestedHotspotIdSet.has(getRowHotspotId(row))
    ));
    const selectedAttractionRowIds = new Set<number>(
      selectedAttractionRows
        .map((row: any) => getRowHotspotId(row))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const selectedOpeningConflictRows: any[] = [];
    const openingHourConflictRows = selectedAttractionRows.filter((row: any) => {
      const operatingEvaluation = this.evaluateTimelineRowAgainstOperatingHours(row);

      if (operatingEvaluation.valid === false) {
        selectedOpeningConflictRows.push({
          hotspotId: getRowHotspotId(row),
          hotspotName: String(row?.name || row?.text || row?.hotspot_name || `Hotspot #${getRowHotspotId(row)}`),
          attemptedVisitTime: operatingEvaluation.attemptedVisitTime,
          attemptedStartTime: operatingEvaluation.attemptedStartLabel,
          attemptedEndTime: operatingEvaluation.attemptedEndLabel,
          operatingHours: operatingEvaluation.operatingHours,
          openingTime: operatingEvaluation.openingLabel,
          closingTime: operatingEvaluation.closingLabel,
          reason: operatingEvaluation.reason,
          reasonCode: 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME',
        });
        return true;
      }
      return false;
    });
    const selectedManualConflictRows = openingHourConflictRows;
    const scheduledSelectedRows = selectedAttractionRows.filter((row: any) => {
      const operatingEvaluation = this.evaluateTimelineRowAgainstOperatingHours(row);
      return (
        row?.isConflict !== true
        && Number(row?.is_conflict || 0) !== 1
        && operatingEvaluation.valid !== false
      );
    });
    const selectedOpeningConflict = selectedOpeningConflictRows[0] || null;

    const rawStillUnschedulable = Array.isArray(adaptive?.unscheduledManualHotspots)
      && adaptive.unscheduledManualHotspots.length > 0;
    const requiresPriorityConfirmation = adaptive?.requiresConfirmation === true;
    const manualRelaxedRouteFit =
      manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
      && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
    const selectedHasPreviewRow = selectedAttractionRows.length > 0;
    const stillUnschedulable =
      rawStillUnschedulable
      && !selectedHasPreviewRow;
    const unscheduledManualHotspots = Array.isArray(adaptive?.unscheduledManualHotspots)
      ? adaptive.unscheduledManualHotspots.filter((row: any) => !selectedAttractionRowIds.has(getRowHotspotId(row)))
      : [];
    const unscheduledReasons = [
      String(adaptive?.reason || ''),
      ...((adaptive?.unscheduledManualHotspots || []).map((row: any) => String(row?.reason || ''))),
    ].join(' ').toUpperCase();
    const onlySoftManualRouteFitConflict =
      manualRelaxedRouteFit
      && rawStillUnschedulable
      && routeEndOverflowMinutes === 0
      && selectedManualConflictRows.length === 0
      && (
        unscheduledReasons.includes('NO_FEASIBLE_ROUTE_SLOT')
        || unscheduledReasons.includes('OFF-ROUTE')
        || unscheduledReasons.includes('OFF_ROUTE')
        || unscheduledReasons.includes('BACKTRACK')
        || unscheduledReasons.includes('DETOUR')
      );
    const passesScheduleRules =
      routeEndOverflowMinutes === 0
      && selectedManualConflictRows.length === 0
      && (!stillUnschedulable || onlySoftManualRouteFitConflict);

    let reason: string | null = null;
    if (requiresPriorityConfirmation) {
      reason = 'Priority 3 hotspots would need to be removed. Confirmation required.';
    } else if (selectedOpeningConflict) {
      reason = selectedOpeningConflict.reason
        || `${selectedOpeningConflict.hotspotName} cannot be inserted here because attempted visit time is ${selectedOpeningConflict.attemptedVisitTime}, but operating hours are ${selectedOpeningConflict.operatingHours}.`;
    } else if (routeEndOverflowMinutes > 0) {
      reason = 'Route end time overflow after rebuilt manual hotspot insertion.';
    } else if (selectedManualConflictRows.length > 0) {
      const firstConflict = selectedManualConflictRows[0];
      const conflictReason = String(
        firstConflict?.conflictReason
        || firstConflict?.conflict_reason
        || '',
      ).trim();

      reason = conflictReason
        ? `Opening/timing conflict: ${conflictReason}`
        : 'Opening/timing conflict: selected manual hotspot does not fit the rebuilt time slot or operating window.';
    } else if (onlySoftManualRouteFitConflict) {
      reason = 'Manual hotspot adds extra distance or off-route travel, but it is allowed because the rebuilt route is within the manual timing window.';
    } else if (stillUnschedulable) {
      reason =
        adaptive?.reason
        || adaptive?.unscheduledManualHotspots?.[0]?.reason
        || 'Manual hotspot could not be scheduled within valid route constraints.';
    }

    const requiresForceConfirmation =
      routeEndOverflowMinutes === 0
      && selectedManualConflictRows.length > 0
      && !requiresPriorityConfirmation;

    return {
      passesScheduleRules,
      readyToApply: passesScheduleRules && !requiresPriorityConfirmation,
      requiresPriorityConfirmation,
      requiresForceConfirmation,
      stillUnschedulable: stillUnschedulable && !onlySoftManualRouteFitConflict,
      softManualRouteFitConflict: onlySoftManualRouteFitConflict,
      routeEndOverflowMinutes,
      manualTimingPolicy,
      openingHourConflictCount: openingHourConflictRows.length,
      selectedManualConflictCount: selectedManualConflictRows.length,
      scheduledSelectedManualCount: scheduledSelectedRows.length,
      unscheduledManualCount: unscheduledManualHotspots.length,
      reason,
      selectedOpeningConflict,
    };
  }

  private calculateTravelMetricsFromTimeline(
    timeline: any[],
    manualHotspotIdSet: Set<number>,
    masterMap: Map<number, any>,
  ): { totalTravelKm: number; extraTravelKm: number; toAndFroPenalty: number } {
    const attractions = (timeline || [])
      .filter((row: any) => Number(row?.item_type || 0) === 4)
      .map((row: any) => ({
        hotspotId: Number(row?.hotspot_ID || row?.locationId || 0),
        isManual: Number(row?.hotspot_plan_own_way || 0) === 1 || row?.isManual === true || manualHotspotIdSet.has(Number(row?.hotspot_ID || 0)),
      }))
      .filter((row: any) => Number(row.hotspotId) > 0);

    let totalTravelKm = 0;
    for (let i = 1; i < attractions.length; i += 1) {
      totalTravelKm += this.distanceBetweenHotspots(masterMap, attractions[i - 1].hotspotId, attractions[i].hotspotId);
    }

    const extraTravelKm = this.calculateInsertionExtraDistance(attractions, manualHotspotIdSet, masterMap);
    const toAndFroPenalty = this.calculateToAndFroPenalty(attractions, masterMap);
    return {
      totalTravelKm: Number(totalTravelKm.toFixed(2)),
      extraTravelKm,
      toAndFroPenalty,
    };
  }

  private detectTopPriorityImpact(
    baselineTopPriorityByHotspotId: Map<number, { id: number; name: string; priority: number }>,
    afterCandidates: any,
  ): Array<{ id: number; name: string; priority: number; reason: string }> {
    const afterTopPriorityIds = new Set<number>([
      ...((afterCandidates?.classified?.strictTopPriority || [])
        .map((row: any) => Number(row?.hotspotId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0)),
      ...((afterCandidates?.classified?.p3ConfirmationCandidates || [])
        .map((row: any) => Number(row?.hotspotId || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0)),
    ]);

    return Array.from(baselineTopPriorityByHotspotId.values())
      .filter((row) => !afterTopPriorityIds.has(Number(row.id)))
      .map((row) => ({
        ...row,
        reason: Number(row.priority || 0) <= this.PROTECTED_AUTO_PRIORITY_MAX
          ? `Protected P${row.priority || 0} hotspot would be removed or invalidated by this schedule attempt.`
          : `Priority ${row.priority || 0} hotspot would need confirmation before removal.`,
      }));
  }

  private buildManualScheduleAttemptFromCandidate(params: {
    strategy: ManualCandidateOrder;
    candidate: ManualInsertionCandidateResult;
  }): ManualScheduleAttempt {
    const routeEndOverflowMinutes = Number(params.candidate?.routeEndOverflowMinutes || 0);
    const openingHourConflictCount = Number(params.candidate?.openingHourConflictCount || 0);
    const topPriorityAffectedCount = Number(params.candidate?.topPriorityAffected?.length || 0);
    const readyToApply = params.candidate.success === true && params.candidate.requiresConfirmation !== true;
    const attempt: ManualScheduleAttempt = {
      source: 'CANDIDATE_WRAPPER',
      strategyKey: params.strategy.strategyKey,
      strategyLabel: params.strategy.strategyLabel,
      description: params.strategy.description,
      hotspotOrder: params.strategy.hotspotOrder,
      candidateIndex: Number(params.candidate?.candidateIndex ?? -1),
      previewTimeline: Array.isArray(params.candidate?.fullTimeline) ? params.candidate.fullTimeline : [],
      success: params.candidate.success === true,
      requiresConfirmation: params.candidate.requiresConfirmation === true,
      readyToApply,
      routeEndOverflowMinutes,
      openingHourConflictCount,
      topPriorityAffectedCount,
      removedOptionalCount: Number(params.candidate?.removedOptionalHotspots?.length || 0),
      removedTopPriorityCount: Number(params.candidate?.removedTopPriorityHotspots?.length || 0),
      waitingMinutes: Number(params.candidate?.waitingMinutes || 0),
      extraTravelKm: Number(params.candidate?.extraTravelKm || 0),
      totalTravelKm: Number(params.candidate?.totalTravelKm || 0),
      timingSafe: routeEndOverflowMinutes === 0 && openingHourConflictCount === 0,
      selected: false,
      summary: null,
      reason: params.candidate?.reason || null,
    };
    attempt.summary = this.explainManualScheduleAttempt(attempt);
    return attempt;
  }

  private buildExactAnchorSequentialScheduleAttempt(params: {
    strategy: ManualCandidateOrder;
    candidate: ManualInsertionCandidateResult;
  }): ManualScheduleAttempt {
    const timeline = Array.isArray(params.candidate?.fullTimeline) ? params.candidate.fullTimeline : [];
    const attractionRows = timeline.filter((row: any) => this.isAttractionTimelineRow(row));
    const actualOrder = attractionRows
      .map((row: any) => this.getTimelineRowHotspotId(row))
      .filter((id: number) => id > 0);
    const manualHotspotId = Number(
      params.candidate?.scheduledManualHotspots?.[0]?.id ||
      (params.strategy.hotspotOrder || [])[0] ||
      0,
    );
    const orderPreserved = manualHotspotId > 0
      && this.manualFitTimelinePreservesSelectedAnchor({
        timeline,
        selectedHotspotId: manualHotspotId,
        afterHotspotId: Number(params.strategy?.exactAfterHotspotId || 0) || null,
        beforeHotspotId: Number(params.strategy?.exactBeforeHotspotId || 0) || null,
        anchorIntent: params.strategy?.exactAnchorIntent || 'AFTER_ATTRACTION',
      });

    let overlapCount = 0;
    let previousEnd: number | null = null;
    for (const row of attractionRows) {
      const rawRange = String(row?.timeRange || row?.visitTime || '').trim();
      if (!rawRange.includes('-')) continue;
      const [startPart, endPart] = rawRange.split('-').map((value: string) => value.trim());
      const startMin = this.parsePreviewTimeToMinutes(startPart);
      const endMin = this.parsePreviewTimeToMinutes(endPart);
      if (startMin === null || endMin === null) continue;
      if (previousEnd !== null && startMin < previousEnd) {
        overlapCount += 1;
      }
      previousEnd = endMin;
    }

    const routeEndOverflowMinutes = Number(params.candidate?.routeEndOverflowMinutes || 0);
    const openingHourConflictCount = Number(params.candidate?.openingHourConflictCount || 0);
    const topPriorityAffectedCount = Number(params.candidate?.topPriorityAffected?.length || 0);
    const timingSafe =
      routeEndOverflowMinutes === 0 &&
      openingHourConflictCount === 0 &&
      overlapCount === 0;
    const readyToApply =
      params.candidate?.success === true &&
      params.candidate?.requiresConfirmation !== true &&
      timingSafe &&
      orderPreserved;

    const reason = !orderPreserved
      ? 'Exact-anchor sequential rebuild did not keep the selected manual hotspot in the clicked Fit Here gap.'
      : overlapCount > 0
        ? 'Exact-anchor sequential rebuild produced overlapping kept hotspot times.'
        : params.candidate?.reason || null;

    const attempt: ManualScheduleAttempt = {
      source: 'REAL_CLUSTER_SIMULATION',
      strategyKey: params.strategy.strategyKey,
      strategyLabel: params.strategy.strategyLabel,
      description: params.strategy.description,
      hotspotOrder: params.strategy.hotspotOrder,
      candidateIndex: Number(params.candidate?.candidateIndex ?? -1),
      previewTimeline: Array.isArray(params.candidate?.fullTimeline) ? params.candidate.fullTimeline : [],
      success: params.candidate?.success === true && orderPreserved && overlapCount === 0,
      requiresConfirmation: params.candidate?.requiresConfirmation === true,
      readyToApply,
      routeEndOverflowMinutes,
      openingHourConflictCount,
      topPriorityAffectedCount,
      removedOptionalCount: Number(params.candidate?.removedOptionalHotspots?.length || 0),
      removedTopPriorityCount: Number(params.candidate?.removedTopPriorityHotspots?.length || 0),
      waitingMinutes: Number(params.candidate?.waitingMinutes || 0),
      extraTravelKm: Number(params.candidate?.extraTravelKm || 0),
      totalTravelKm: Number(params.candidate?.totalTravelKm || 0),
      timingSafe,
      selected: false,
      summary: null,
      reason,
    };
    attempt.summary = this.explainManualScheduleAttempt(attempt);
    return attempt;
  }

  private async simulateManualClusterOrder(params: {
    strategy: ManualCandidateOrder;
    candidate: ManualInsertionCandidateResult;
  }): Promise<ManualScheduleAttempt> {
    if (params.strategy?.exactAnchorIntent) {
      return this.buildExactAnchorSequentialScheduleAttempt(params);
    }

    return this.buildManualScheduleAttemptFromCandidate(params);
  }

  private compareManualScheduleAttempts(a: ManualScheduleAttempt, b: ManualScheduleAttempt): number {
    const category = (attempt: ManualScheduleAttempt): number => {
      if (attempt.readyToApply && attempt.removedOptionalCount === 0 && attempt.removedTopPriorityCount === 0) return 0;
      if (attempt.readyToApply) return 1;
      if (attempt.requiresConfirmation) return 2;
      if (
        attempt.timingSafe &&
        attempt.topPriorityAffectedCount === 0 &&
        !String(attempt.reason || '').toLowerCase().includes('exact-anchor rebuild failed') &&
        !String(attempt.reason || '').toLowerCase().includes('did not keep the selected manual hotspot')
      ) return 3;
      return 4;
    };

    const totalRemovedCount = (attempt: ManualScheduleAttempt): number => (
      Number(attempt.removedOptionalCount || 0) + Number(attempt.removedTopPriorityCount || 0)
    );

    const ac = category(a);
    const bc = category(b);
    if (ac !== bc) return ac - bc;
    if (totalRemovedCount(a) !== totalRemovedCount(b)) return totalRemovedCount(a) - totalRemovedCount(b);
    if (a.removedTopPriorityCount !== b.removedTopPriorityCount) return a.removedTopPriorityCount - b.removedTopPriorityCount;
    if (a.topPriorityAffectedCount !== b.topPriorityAffectedCount) return a.topPriorityAffectedCount - b.topPriorityAffectedCount;
    if (a.openingHourConflictCount !== b.openingHourConflictCount) return a.openingHourConflictCount - b.openingHourConflictCount;
    if (a.routeEndOverflowMinutes !== b.routeEndOverflowMinutes) return a.routeEndOverflowMinutes - b.routeEndOverflowMinutes;
    if (a.waitingMinutes !== b.waitingMinutes) return a.waitingMinutes - b.waitingMinutes;
    if (a.extraTravelKm !== b.extraTravelKm) return a.extraTravelKm - b.extraTravelKm;
    if (a.totalTravelKm !== b.totalTravelKm) return a.totalTravelKm - b.totalTravelKm;
    return a.candidateIndex - b.candidateIndex;
  }

  private async simulateManualInsertionAtPosition(
    tx: any,
    planId: number,
    routeId: number,
    route: any,
    manualHotspotIds: number[],
    position: ManualInsertionPosition,
    baselineTopPriorityByHotspotId: Map<number, { id: number; name: string; priority: number }>,
    masterMap: Map<number, any>,
    options?: {
      allowTopPriorityRemoval?: boolean;
      removedOptionalHotspots?: any[];
      removedTopPriorityHotspots?: any[];
      manualTimingPolicy?: ManualHotspotTimingPolicy;
      preferredHotspotOrder?: number[];
      exactAnchorMode?: boolean;
      anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
      afterHotspotId?: number;
      beforeHotspotId?: number;
      sourceInsertionMode?: boolean;
      sourceMaxCandidateIndex?: number;
    },
  ): Promise<ManualInsertionCandidateResult> {
    const allowTopPriorityRemoval = options?.allowTopPriorityRemoval === true;

    await this.rebuildManualHotspotSet(
      tx,
      Number(planId),
      Number(routeId),
      manualHotspotIds,
      {
        anchorType: 'after_travel',
        anchorIndex: Math.max(0, Number(position.anchorOrder) - 1),
      },
      {
        preferredManualPlacementByRoute: {
          [Number(routeId)]: { hotspotOrder: Number(position.anchorOrder) },
        },
        preferredHotspotOrder: options?.preferredHotspotOrder,
        previewOnly: true,
      },
    );

    const afterCandidates = await this.buildRouteHotspotInsertionCandidates(tx, Number(planId), Number(routeId), manualHotspotIds);
    const scheduleState = await this.getManualHotspotScheduleState(
      tx,
      Number(planId),
      Number(routeId),
      manualHotspotIds,
      afterCandidates.masterMap,
    );

    let fullTimeline = await this.getRouteTimelineForScoring(tx, Number(planId), Number(routeId));
    let exactAnchorPreserved = true;
    let exactAnchorFailureReason: string | null = null;
    if (options?.exactAnchorMode === true) {
      const selectedHotspotId = Number(manualHotspotIds?.[0] || 0);
      const preservesAnchor = this.manualFitTimelinePreservesSelectedAnchor({
        timeline: fullTimeline,
        selectedHotspotId,
        afterHotspotId: Number(options?.afterHotspotId || 0) || null,
        beforeHotspotId: Number(options?.beforeHotspotId || 0) || null,
        anchorIntent: options?.anchorIntent,
      });

      exactAnchorPreserved = preservesAnchor === true;

      if (!exactAnchorPreserved && selectedHotspotId > 0) {
        const rebuiltExactAnchorTimeline = await this.buildExactAnchorSequentialTimelineAfterRemoval(
          tx,
          fullTimeline,
          {
            removedHotspotIds: [],
            targetHotspotId: selectedHotspotId,
            routeId: Number(routeId),
            planId: Number(planId),
            anchorIntent: options?.anchorIntent,
            afterHotspotId: options?.afterHotspotId,
            beforeHotspotId: options?.beforeHotspotId,
          },
        );

        if (Array.isArray(rebuiltExactAnchorTimeline) && rebuiltExactAnchorTimeline.length > 0) {
          const enrichedExactTimeline = await this.enrichManualFitPreviewTimelineWithOperatingHours(
            Number(planId),
            Number(routeId),
            rebuiltExactAnchorTimeline,
          );

          const rebuiltPreservesAnchor = this.manualFitTimelinePreservesSelectedAnchor({
            timeline: enrichedExactTimeline,
            selectedHotspotId,
            afterHotspotId: Number(options?.afterHotspotId || 0) || null,
            beforeHotspotId: Number(options?.beforeHotspotId || 0) || null,
            anchorIntent: options?.anchorIntent,
          });

          if (rebuiltPreservesAnchor) {
            fullTimeline = enrichedExactTimeline;
            exactAnchorPreserved = true;
          }
        }
      }

      if (!exactAnchorPreserved) {
        exactAnchorFailureReason =
          options?.anchorIntent === 'AFTER_START'
            ? 'Exact-anchor rebuild failed: selected manual hotspot is not the first attraction after route start.'
            : 'Exact-anchor rebuild failed: selected manual hotspot is not immediately after the clicked anchor attraction.';
      }
    }
    const manualHotspotIdSet = new Set<number>(manualHotspotIds.map((id: number) => Number(id)));
    const waitingMinutes = this.calculateWaitingMinutes(fullTimeline);
    const travelMetrics = this.calculateTravelMetricsFromTimeline(fullTimeline, manualHotspotIdSet, masterMap);
    const timelineAttractionIds = new Set<number>(
      (fullTimeline || [])
        .filter((row: any) => Number(row?.item_type || 0) === 4 || String(row?.type || '').toLowerCase() === 'attraction')
        .map((row: any) => Number(row?.hotspot_ID || row?.hotspotId || row?.locationId || row?.hotspot_id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const topPriorityAffected = this.detectTopPriorityImpact(baselineTopPriorityByHotspotId, afterCandidates)
      .filter((row) => !timelineAttractionIds.has(Number(row.id)));

    const openingHourConflictCount = Number((fullTimeline || []).filter((row: any) => row?.isConflict === true && Number(row?.item_type || 0) === 4).length || 0);
    const routeEndOverflowMinutes = this.calculateRouteEndOverflowMinutes(
      fullTimeline,
      route,
      options?.manualTimingPolicy?.endTime,
    );

    const score = this.scoreManualInsertionCandidate({
      waitingMinutes,
      extraTravelKm: travelMetrics.extraTravelKm,
      totalTravelKm: travelMetrics.totalTravelKm,
      toAndFroPenalty: travelMetrics.toAndFroPenalty,
      removedOptionalCount: Number(options?.removedOptionalHotspots?.length || 0),
      topPriorityAffectedCount: Number(topPriorityAffected.length || 0),
      routeEndOverflowMinutes,
      openingHourConflictCount,
    });

    const scheduledManualHotspots = scheduleState.scheduledHotspotIds.map((id: number) => {
      const master = afterCandidates.masterMap.get(Number(id));
      return {
        id: Number(id),
        name: String(master?.hotspot_name || `Hotspot #${id}`),
        priorityLabel: `Manual / P${this.getManualEffectivePriority()}`,
      };
    });

    const requiresConfirmation = topPriorityAffected.length > 0 && !allowTopPriorityRemoval;
    const success =
      exactAnchorPreserved === true
      && scheduleState.unscheduledManualHotspots.length === 0
      && routeEndOverflowMinutes === 0
      && openingHourConflictCount === 0
      && (!requiresConfirmation || allowTopPriorityRemoval);

    const reason = exactAnchorFailureReason || this.explainRejectedCandidate({
      unscheduledCount: scheduleState.unscheduledManualHotspots.length,
      routeEndOverflowMinutes,
      openingHourConflictCount,
      topPriorityAffectedCount: topPriorityAffected.length,
      allowTopPriorityRemoval,
    });

    console.log('[ManualInsertionOptimizer]', {
      candidateIndex: position.candidateIndex,
      positionLabel: position.positionLabel,
      waitingMinutes,
      extraTravelKm: travelMetrics.extraTravelKm,
      toAndFroPenalty: travelMetrics.toAndFroPenalty,
      removedOptionalCount: Number(options?.removedOptionalHotspots?.length || 0),
      topPriorityAffectedCount: topPriorityAffected.length,
      score,
      chosen: false,
    });

    return {
      success,
      candidateIndex: position.candidateIndex,
      rows: afterCandidates.hotspotRows,
      fullTimeline,
      score,
      waitingMinutes,
      totalTravelKm: travelMetrics.totalTravelKm,
      extraTravelKm: travelMetrics.extraTravelKm,
      toAndFroPenalty: travelMetrics.toAndFroPenalty,
      removedOptionalHotspots: [...(options?.removedOptionalHotspots || [])],
      removedTopPriorityHotspots: [...(options?.removedTopPriorityHotspots || [])],
      topPriorityAffected,
      scheduledManualHotspots,
      unscheduledManualHotspots: scheduleState.unscheduledManualHotspots,
      requiresConfirmation,
      reason,
      routeEndOverflowMinutes,
      openingHourConflictCount,
    };
  }

  private async findBestManualInsertionCandidate(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
    options?: {
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
      allowTopPriorityRemoval?: boolean;
      previewOnly?: boolean;
      exactAnchorMode?: boolean;
      anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
      afterHotspotId?: number;
      beforeHotspotId?: number;
      anchorIndex?: number;
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      destinationInsertionMode?: boolean;
      destinationMinCandidateIndex?: number;
      sourceInsertionMode?: boolean;
      sourceMaxCandidateIndex?: number;
      removedOptionalHotspots?: any[];
      removedTopPriorityHotspots?: any[];
      baselineTopPriorityByHotspotId?: Map<number, { id: number; name: string; priority: number }>;
      masterMap?: Map<number, any>;
      manualTimingPolicy?: ManualHotspotTimingPolicy;
      preferredHotspotOrder?: number[];
    },
  ): Promise<ManualInsertionCandidateResult> {
    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
    });

    const baseline = await this.buildRouteHotspotInsertionCandidates(tx, Number(planId), Number(routeId), manualHotspotIds);

    const preferredOrder = Array.isArray(options?.preferredHotspotOrder)
      ? options.preferredHotspotOrder.map(Number).filter((id) => id > 0)
      : [];

    const hotspotRowsForPositioning = preferredOrder.length > 1
      ? (() => {
          const orderIndex = new Map<number, number>(
            preferredOrder.map((hotspotId, index) => [hotspotId, index]),
          );

          const preferredRows = baseline.hotspotRows
            .filter((row: any) => orderIndex.has(Number(row.hotspotId || 0)))
            .sort((a: any, b: any) =>
              Number(orderIndex.get(Number(a.hotspotId || 0))) -
              Number(orderIndex.get(Number(b.hotspotId || 0))),
            );

          const preferredIds = new Set(preferredRows.map((row: any) => Number(row.hotspotId || 0)));

          const nonPreferredRows = baseline.hotspotRows
            .filter((row: any) => !preferredIds.has(Number(row.hotspotId || 0)));

          return [
            ...preferredRows,
            ...nonPreferredRows,
          ];
        })()
      : baseline.hotspotRows;

    const allPositions = this.buildManualInsertionPositions(hotspotRowsForPositioning);
    const preferredCandidateIndex = this.buildPreferredManualInsertionIndex(
      hotspotRowsForPositioning,
      options?.preferredHotspotOrder,
      manualHotspotIds,
    );
    const positions = (() => {
      const base = allPositions;
      const orderedBase = preferredCandidateIndex === null
        ? base
        : [...base].sort((a, b) => {
            const aDiff = Math.abs(Number(a.candidateIndex) - Number(preferredCandidateIndex));
            const bDiff = Math.abs(Number(b.candidateIndex) - Number(preferredCandidateIndex));
            if (aDiff !== bDiff) return aDiff - bDiff;
            return Number(a.candidateIndex) - Number(b.candidateIndex);
          });

      if (options?.exactAnchorMode === true && preferredCandidateIndex !== null) {
        const exactPositions = orderedBase.filter((pos) => (
          Number(pos.candidateIndex) === Number(preferredCandidateIndex)
        ));
        if (exactPositions.length > 0) {
          return exactPositions;
        }
      }

      if (options?.destinationInsertionMode === true) {
        const minIndex = Math.max(0, Number(options?.destinationMinCandidateIndex || 0));
        const destinationSide = orderedBase.filter((pos) => Number(pos.candidateIndex) >= minIndex);
        const sourceSide = orderedBase.filter((pos) => Number(pos.candidateIndex) < minIndex);
        return [...destinationSide, ...sourceSide];
      }

      if (options?.sourceInsertionMode === true) {
        const maxIndex = Math.max(0, Number(options?.sourceMaxCandidateIndex || 0));
        const sourceSide = orderedBase.filter((pos) => Number(pos.candidateIndex) <= maxIndex);
        const destinationSide = orderedBase.filter((pos) => Number(pos.candidateIndex) > maxIndex);
        return [...sourceSide, ...destinationSide];
      }
      return orderedBase;
    })();
    const baselineTopPriorityByHotspotId = options?.baselineTopPriorityByHotspotId || new Map<number, { id: number; name: string; priority: number }>();
    const masterMap = options?.masterMap || baseline.masterMap;

    const candidates: ManualInsertionCandidateResult[] = [];
    for (const position of positions) {
      const simulated = await this.simulateManualInsertionAtPosition(
        tx,
        Number(planId),
        Number(routeId),
        route,
        manualHotspotIds,
        position,
        baselineTopPriorityByHotspotId,
        masterMap,
        {
          allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
          removedOptionalHotspots: options?.removedOptionalHotspots || [],
          removedTopPriorityHotspots: options?.removedTopPriorityHotspots || [],
          manualTimingPolicy: options?.manualTimingPolicy,
          preferredHotspotOrder: options?.preferredHotspotOrder,
          exactAnchorMode: options?.exactAnchorMode === true,
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          sourceInsertionMode: options?.sourceInsertionMode === true,
          sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
        },
      );
      candidates.push(simulated);
    }

    const baselineAttractionsSorted = [...(baseline.hotspotRows || [])]
      .sort((a: any, b: any) => Number(a?.hotspotOrder ?? a?.hotspot_order ?? 0) - Number(b?.hotspotOrder ?? b?.hotspot_order ?? 0));
    const slotInsights = this.buildManualSlotInsights(candidates, manualHotspotIds, baselineAttractionsSorted, masterMap);

    const best = this.chooseBestManualInsertionCandidate(candidates);
    if (!best) {
      return {
        success: false,
        candidateIndex: -1,
        rows: [],
        fullTimeline: [],
        score: Number.MAX_SAFE_INTEGER,
        waitingMinutes: 0,
        totalTravelKm: 0,
        extraTravelKm: 0,
        toAndFroPenalty: 0,
        removedOptionalHotspots: [...(options?.removedOptionalHotspots || [])],
        removedTopPriorityHotspots: [...(options?.removedTopPriorityHotspots || [])],
        topPriorityAffected: [],
        scheduledManualHotspots: [],
        unscheduledManualHotspots: [],
        requiresConfirmation: false,
        reason: 'No insertion candidate evaluated.',
        slotInsights,
      };
    }

    best.slotInsights = slotInsights;

    const selectedPosition = positions.find((pos) => pos.candidateIndex === best.candidateIndex) || positions[0];
    if (selectedPosition) {
      await this.rebuildManualHotspotSet(
        tx,
        Number(planId),
        Number(routeId),
        manualHotspotIds,
        {
          anchorType: 'after_travel',
          anchorIndex: Math.max(0, Number(selectedPosition.anchorOrder) - 1),
        },
        {
          preferredManualPlacementByRoute: {
            [Number(routeId)]: { hotspotOrder: Number(selectedPosition.anchorOrder) },
          },
          preferredHotspotOrder: options?.preferredHotspotOrder,
          previewOnly: options?.previewOnly === true,
        },
      );
    }

    console.log('[ManualInsertionOptimizer]', {
      candidateIndex: best.candidateIndex,
      positionLabel: selectedPosition?.positionLabel || 'unknown',
      waitingMinutes: best.waitingMinutes,
      extraTravelKm: best.extraTravelKm,
      toAndFroPenalty: best.toAndFroPenalty,
      removedOptionalCount: Number(best.removedOptionalHotspots?.length || 0),
      topPriorityAffectedCount: Number(best.topPriorityAffected?.length || 0),
      score: best.score,
      chosen: true,
    });

    return best;
  }

  private async runManualClusterOptimizer(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
    baselineCandidates: any,
    options?: {
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
      allowTopPriorityRemoval?: boolean;
      previewOnly?: boolean;
      exactAnchorMode?: boolean;
      anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
      afterHotspotId?: number;
      beforeHotspotId?: number;
      anchorIndex?: number;
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      destinationInsertionMode?: boolean;
      destinationMinCandidateIndex?: number;
      sourceInsertionMode?: boolean;
      sourceMaxCandidateIndex?: number;
      removedOptionalHotspots?: any[];
      removedTopPriorityHotspots?: any[];
      baselineTopPriorityByHotspotId?: Map<number, { id: number; name: string; priority: number }>;
      manualTimingPolicy?: ManualHotspotTimingPolicy;
    },
  ): Promise<{
    bestCandidate: ManualInsertionCandidateResult;
    optimizerLog: ManualOptimizerAttemptLog;
  }> {
    const strategies = this.buildManualClusterCandidateOrders({
      hotspots: baselineCandidates?.hotspotRows || [],
      manualHotspotIds,
      anchorIndex: options?.anchorIndex,
      anchorIntent: options?.anchorIntent,
      afterHotspotId: options?.afterHotspotId,
      allowP3Removal: options?.allowP3Removal === true,
      allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
      exactAnchorMode: options?.exactAnchorMode === true,
      masterMap: baselineCandidates?.masterMap || new Map<number, any>(),
    });

    const attempts: Array<{ strategy: ManualCandidateOrder; candidate: ManualInsertionCandidateResult; attempt: ManualScheduleAttempt }> = [];
    for (const strategy of strategies) {
      const candidate = await this.findBestManualInsertionCandidate(
        tx,
        Number(planId),
        Number(routeId),
        manualHotspotIds,
        {
          allowP3Removal: options?.allowP3Removal === true,
          allowP1P2Removal: options?.allowP1P2Removal === true,
          allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
          previewOnly: options?.previewOnly === true,
          exactAnchorMode: options?.exactAnchorMode === true,
          anchorType: options?.anchorType,
          anchorIndex: options?.anchorIndex,
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          destinationInsertionMode: options?.destinationInsertionMode === true,
          destinationMinCandidateIndex: Number(options?.destinationMinCandidateIndex || 0) || undefined,
          sourceInsertionMode: options?.sourceInsertionMode === true,
          sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
          removedOptionalHotspots: options?.removedOptionalHotspots || [],
          removedTopPriorityHotspots: options?.removedTopPriorityHotspots || [],
          baselineTopPriorityByHotspotId: options?.baselineTopPriorityByHotspotId,
          masterMap: baselineCandidates?.masterMap,
          manualTimingPolicy: options?.manualTimingPolicy,
          preferredHotspotOrder: strategy.hotspotOrder,
        },
      );
      candidate.strategyKey = strategy.strategyKey;
      candidate.strategyLabel = strategy.strategyLabel;
      const attempt = await this.simulateManualClusterOrder({ strategy, candidate });
      attempts.push({ strategy, candidate, attempt });
    }

    const selected = [...attempts].sort((a, b) => this.compareManualScheduleAttempts(a.attempt, b.attempt))[0];
    if (selected) {
      selected.attempt.selected = true;
      selected.candidate.strategySummary = selected.attempt.summary;
    }

    return {
      bestCandidate: selected?.candidate || await this.findBestManualInsertionCandidate(
        tx,
        Number(planId),
        Number(routeId),
        manualHotspotIds,
        {
          allowP3Removal: options?.allowP3Removal === true,
          allowP1P2Removal: options?.allowP1P2Removal === true,
          allowTopPriorityRemoval: options?.allowTopPriorityRemoval === true,
          previewOnly: options?.previewOnly === true,
          exactAnchorMode: options?.exactAnchorMode === true,
          anchorType: options?.anchorType,
          anchorIndex: options?.anchorIndex,
          anchorIntent: options?.anchorIntent,
          afterHotspotId: options?.afterHotspotId,
          beforeHotspotId: options?.beforeHotspotId,
          destinationInsertionMode: options?.destinationInsertionMode === true,
          destinationMinCandidateIndex: Number(options?.destinationMinCandidateIndex || 0) || undefined,
          sourceInsertionMode: options?.sourceInsertionMode === true,
          sourceMaxCandidateIndex: Number(options?.sourceMaxCandidateIndex || 0) || undefined,
          removedOptionalHotspots: options?.removedOptionalHotspots || [],
          removedTopPriorityHotspots: options?.removedTopPriorityHotspots || [],
          baselineTopPriorityByHotspotId: options?.baselineTopPriorityByHotspotId,
          masterMap: baselineCandidates?.masterMap,
          manualTimingPolicy: options?.manualTimingPolicy,
          preferredHotspotOrder: selected?.strategy?.hotspotOrder || [],
        },
      ),
      optimizerLog: {
        decisionOrder: [
          'opening-hours feasibility',
          'selected manual hotspot scheduled without conflict',
          'P1/P2 preserved',
          'P3 preserved unless confirmed',
          'route end time',
          'wait time',
          'detour as tie-breaker',
        ],
        selectedStrategyKey: selected?.attempt.strategyKey || null,
        selectedStrategyLabel: selected?.attempt.strategyLabel || null,
        summary: selected?.attempt.summary || null,
        attempts: attempts.map((row) => row.attempt),
      },
    };
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

  private async buildRouteHotspotInsertionCandidates(
    tx: any,
    planId: number,
    routeId: number,
    manualHotspotIds: number[],
  ) {
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
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_order: true,
      },
    });

    const hotspotIds = this.normalizeManualHotspotIds([
      ...manualHotspotIds,
      ...(routeRows || []).map((row: any) => Number(row?.hotspot_ID || 0)),
    ]);

    const hotspotMasters = hotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_priority: true,
            hotspot_latitude: true,
            hotspot_longitude: true,
            hotspot_location: true,
            hotspot_to_location: true,
            hotspot_duration: true,
          },
        })
      : [];

    const timings = hotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_timing.findMany({
          where: {
            hotspot_ID: { in: hotspotIds },
            deleted: 0,
            status: 1,
          },
          orderBy: [
            { hotspot_ID: 'asc' },
            { hotspot_start_time: 'asc' },
          ],
          select: {
            hotspot_ID: true,
            hotspot_closed: true,
            hotspot_open_all_time: true,
            hotspot_start_time: true,
            hotspot_end_time: true,
          },
        })
      : [];

    const formatTime = (date: Date | null) => {
      if (!date) return '';
      const h = date.getUTCHours();
      const m = date.getUTCMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
    };

    const timingWindowsMap = new Map<number, Set<string>>();
    for (const timing of timings) {
      const hotspotId = Number(timing?.hotspot_ID || 0);
      if (hotspotId <= 0 || Number(timing?.hotspot_closed || 0) === 1) continue;

      let timeStr = '';
      if (Number(timing?.hotspot_open_all_time || 0) === 1) {
        timeStr = 'Open 24 Hours';
      } else if (timing?.hotspot_start_time && timing?.hotspot_end_time) {
        timeStr = `${formatTime(timing.hotspot_start_time)} - ${formatTime(timing.hotspot_end_time)}`;
      }

      if (!timeStr) continue;
      if (!timingWindowsMap.has(hotspotId)) {
        timingWindowsMap.set(hotspotId, new Set<string>());
      }
      timingWindowsMap.get(hotspotId)!.add(timeStr);
    }

    const timingMap = new Map<number, string>();
    for (const [hotspotId, windowSet] of timingWindowsMap.entries()) {
      timingMap.set(
        hotspotId,
        windowSet.has('Open 24 Hours')
          ? 'Open 24 Hours'
          : Array.from(windowSet).join(', '),
      );
    }

    const masterMap = new Map<number, any>(
      hotspotMasters.map((row: any) => [Number(row?.hotspot_ID || 0), row]),
    );

    const hotspotRows = (routeRows || []).map((row: any) => {
      const hotspotId = Number(row?.hotspot_ID || 0);
      const master = masterMap.get(hotspotId);
      const rawPriority = Number(master?.hotspot_priority ?? 0);
      const normalizedPriority = this.normalizeHotspotPriority(rawPriority);
      const isManual = Number(row?.hotspot_plan_own_way || 0) === 1 || manualHotspotIds.includes(hotspotId);
      const effectivePriority = isManual
        ? this.MANUAL_HOTSPOT_EFFECTIVE_PRIORITY
        : normalizedPriority;

      return {
        routeHotspotId: Number(row?.route_hotspot_ID || 0),
        hotspotId,
        name: String(master?.hotspot_name || `Hotspot #${hotspotId}`),
        rawPriority,
        normalizedPriority,
        priority: effectivePriority,
        effectivePriority,
        isManual,
        mustInclude: isManual,
        hotspotOrder: Number(row?.hotspot_order || 0),
        hotspotStartTime: row?.hotspot_start_time || null,
        hotspotEndTime: row?.hotspot_end_time || null,
        startTs: row?.hotspot_start_time ? new Date(row.hotspot_start_time).getTime() : 0,
        timings: timingMap.get(hotspotId) || '',
        hotspotLocation: String(master?.hotspot_location || '').trim(),
        hotspotToLocation: String(master?.hotspot_to_location || '').trim(),
        durationMinutes: this.getHotspotDurationMinutes(master, row),
      };
    });

    return {
      hotspotRows,
      masterMap,
      hotspotMasters,
      classified: this.classifyHotspotsForManualInsertion(hotspotRows),
    };
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


