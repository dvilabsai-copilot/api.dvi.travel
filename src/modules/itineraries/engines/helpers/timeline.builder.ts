// FILE: src/modules/itineraries/engines/helpers/timeline.builder.ts
//
// PURPOSE:
//   Orchestrate building rows for:
//     • dvi_itinerary_route_hotspot_details
//     • dvi_itinerary_route_hotspot_parking_charge
//   using the helper builders.
//
// IMPORTANT:
//   - This is a PHP-parity-oriented skeleton, not final parity.
//   - You MUST plug in the real “selected hotspots per route” table
//     and the real “hotel location per route” query where marked TODO.
//   - It keeps createdByUserId = 1 to avoid changing other services.
//     Later you can pass the real user id from controller → service → engine.

import { Prisma } from "@prisma/client";
import { HotspotDetailRow, RouteRejectionSummary } from "./types";
import { RefreshmentBuilder } from "./refreshment.builder";
import { TravelSegmentBuilder } from "./travel-segment.builder";
import { HotspotSegmentBuilder } from "./hotspot-segment.builder";
import { HotelTravelBuilder } from "./hotel-travel.builder";
import { ReturnSegmentBuilder } from "./return-segment.builder";
import {
  ParkingChargeBuilder,
  ParkingChargeRow,
} from "./parking-charge.builder";
import { timeToSeconds, addSeconds, secondsToTime, wrapToDay, normalizeTimeRange } from "./time.helper";
import { DistanceHelper } from "./distance.helper";
import { TimeConverter } from "./time-converter";
import { queueDeferredMustVisitHotspot } from "./deferred-retry.helper";
import {
  evaluateArrivalHotelPolicy,
  ArrivalWindow,
  HotelFlowAction,
  HotelSearchMode,
  PolicyResolutionStatus,
} from '../../services/arrival-hotel-policy.service';
import type { SameCityAllocationPlan } from '../../services/same-city-cross-day-optimizer.service';
import { CarryForwardRouteContext, TimelineRoutePolicyService } from './timeline-route-policy.service';
import { FixedTimelineAnchor, RealGapInterval, SameCityContinuationContext, TimelineAnchorPolicyService } from './timeline-anchor-policy.service';
import { TimelineOperatingHoursService } from './timeline-operating-hours.service';
import { DayTimeSlot, TimelineSlotPolicyService } from './timeline-slot-policy.service';
import { TimelineRejectionPolicyService } from './timeline-rejection-policy.service';
import { ArrivalPolicyDecisionState, TimelineDataAccessService } from './timeline-data-access.service';
import { TimelineTravelDataService } from './timeline-travel-data.service';
import { TimelineCandidateFeasibilityService } from './timeline-candidate-feasibility.service';
import { TimelineCandidatePolicyService } from './timeline-candidate-policy.service';
import { TimelineDay1SourceFallbackService } from './timeline-day1-source-fallback.service';
import { TimelineRouteHotspotSelectionService } from './timeline-route-hotspot-selection.service';
import { TimelineArrivalHotelDecisionService } from './timeline-arrival-hotel-decision.service';
import { TimelineHotelFirstInsertionService } from './timeline-hotel-first-insertion.service';
import { TimelineNonHotelCutoffService } from './timeline-non-hotel-cutoff.service';
import { TimelineRouteHotspotPlanningService } from './timeline-route-hotspot-planning.service';
import { TimelineManualPlacementOrderingService } from './timeline-manual-placement-ordering.service';
import { TimelineDestinationReservationService } from './timeline-destination-reservation.service';
import { TimelineCarryForwardAttachmentService } from './timeline-carry-forward-attachment.service';
import { TimelineMatrixAutobuildService } from './timeline-matrix-autobuild.service';
import { TimelineCandidateReorderingService } from './timeline-candidate-reordering.service';
import { TimelineDay1CandidateGateService } from './timeline-day1-candidate-gate.service';
import { TimelineDay1CutoffMasterService } from './timeline-day1-cutoff-master.service';
import { TimelineDay1TravelProjectionService } from './timeline-day1-travel-projection.service';
import { TransportEarlyArrivalTimelineService } from './transport-early-arrival-timeline.service';
import * as fs from 'fs';
import * as path from 'path';

type Tx = Prisma.TransactionClient;

interface PlanHeader {
  itinerary_plan_ID: number;
  trip_start_date: Date;
  trip_end_date: Date;
  trip_start_date_and_time?: Date | null;
  trip_end_date_and_time?: Date | null;
  pick_up_date_and_time: Date;
  arrival_type: number;
  departure_type: number;
  entry_ticket_required: number;
  nationality: number;
  total_adult: number;
  total_children: number;
  total_infants: number;
  itinerary_preference: number;
  arrival_location?: string | null;
  departure_location?: string | null;
}

interface RouteRow {
  itinerary_route_ID: number;
  itinerary_plan_ID: number;
  itinerary_route_date: Date;
  route_start_time: string;
  route_end_time: string;
  location_name: string | null;
  next_visiting_location: string | null;
  location_id: number | null;
}

// Minimal view of a selected hotspot row.
// ⚠️ You MUST adjust table/field names in fetchSelectedHotspotsForRoute().
interface SelectedHotspot {
  hotspot_ID: number;
  display_order?: number;
  hotspot_priority?: number;
  matched_bucket?: string;
  hotspot_distance?: number;
  hotspot_name?: string;
  hotspot_location?: string;
  hotspot_to_location?: string;
  hotspot_type?: string;
}

interface CarryForwardHotspot extends SelectedHotspot {
  carryOrder: number;
  carriedFromRouteId: number;
  carriedFromDate: string;
  carriedFromRouteDay?: number;
  carriedFromRouteSourceCity?: string;
  carriedFromRouteDestinationCity?: string;
  carriedProtectedSlotStartSeconds?: number;
  carriedProtectedSlotEndSeconds?: number;
}

interface CandidateFeasibilityInput {
  tx: Tx;
  route: RouteRow;
  isLastRoute: boolean;
  routeStartSeconds: number;
  routeEndSeconds: number;
  currentTime: string;
  currentLocationName: string;
  currentCoords?: { lat: number; lon: number };
  destinationCoords?: { lat: number; lon: number };
  dayOfWeek: number;
  hotspotId: number;
  hotspotLocationName: string;
  hotspotDuration: string;
  hotspotCoords: { lat: number; lon: number };
  hotspotType?: string;
  hotspotPriority?: number;
  timingMap: Map<number, Map<number, any[]>>;
  plan: PlanHeader;
  destinationCity: string;
  lastRouteArrivalDeadlineSeconds: number;
  allowWaitUntilOpen: boolean;
  rejectIfOutsideOperatingWindow: boolean;
}

interface CandidateFeasibilityResult {
  feasible: boolean;
  reason?: string;
  startSeconds?: number;
  endSeconds?: number;
  timeAfterTravel?: string;
  timeAfterSightseeing?: string;
  travelTimeToHotspot?: string;
  usedWaitUntilOpen?: boolean;
  waitGapSeconds?: number;
  rejectedByDayEndReturnCheck?: boolean;
}

interface AnchorGapFeasibilityResult {
  feasible: boolean;
  reason?: string;
  nextAnchorHotspotId?: number;
  nextAnchorStartSeconds?: number;
  arrivalAtNextAnchorSeconds?: number;
  travelToNextAnchorSeconds?: number;
}

interface ProtectedStrictSlot {
  hotspotId: number;
  routeId: number;
  startSeconds: number;
  endSeconds: number;
  sourceCandidate: SelectedHotspot;
  locked: true;
}

const HOTEL_FIRST_REST_GAP = "02:00:00";
const FREE_TIME_THRESHOLD_SECONDS = 30 * 60;
// If a hotspot won't open for this long, defer it (pass 1 only) so other hotspots fill the gap first.
const LARGE_WAIT_DEFER_THRESHOLD_SECONDS = 90 * 60;
const MIN_DESTINATION_HOTSPOTS_FOR_RESERVATION = 4;
const MAX_SCHEDULER_OPTIMIZATION_CYCLES = 4;
const MAX_MUST_VISIT_REPAIR_ATTEMPTS = 2;
export class TimelineBuilder {
  private currentQuoteId: string | null = null;
  private readonly verboseTimelineLogs =
    (process.env.DEBUG_TIMELINE_LOGS || 'false').toLowerCase() === 'true';
  private readonly verboseTimelineProofLogs =
    (process.env.DEBUG_TIMELINE_PROOF || 'true').toLowerCase() === 'true';

  private readonly refreshmentBuilder = new RefreshmentBuilder();
  private readonly travelBuilder = new TravelSegmentBuilder();
  private readonly hotspotBuilder = new HotspotSegmentBuilder();
  private readonly hotelBuilder = new HotelTravelBuilder();
  private readonly returnBuilder = new ReturnSegmentBuilder();
  // Make parkingBuilder public so HotspotEngineService can use it for rebuilding parking charges
  public readonly parkingBuilder = new ParkingChargeBuilder();
  private readonly distanceHelper = new DistanceHelper();
  private readonly operatingHoursService = new TimelineOperatingHoursService();
  private readonly slotPolicyService = new TimelineSlotPolicyService();
  private readonly rejectionPolicyService = new TimelineRejectionPolicyService();
  private readonly routePolicyService = new TimelineRoutePolicyService();
  private readonly anchorPolicyService = new TimelineAnchorPolicyService();
  private readonly dataAccessService = new TimelineDataAccessService();
  private readonly travelDataService = new TimelineTravelDataService(this.distanceHelper);
  private readonly candidateFeasibilityService = new TimelineCandidateFeasibilityService(this.distanceHelper);
  private readonly day1SourceFallbackService = new TimelineDay1SourceFallbackService();
  private readonly routeHotspotSelectionService = new TimelineRouteHotspotSelectionService(this.distanceHelper);
  private readonly arrivalHotelDecisionService = new TimelineArrivalHotelDecisionService(this.distanceHelper);
  private readonly hotelFirstInsertionService = new TimelineHotelFirstInsertionService(this.hotelBuilder, this.refreshmentBuilder);
  private readonly nonHotelCutoffService = new TimelineNonHotelCutoffService(this.distanceHelper);
  private readonly routeHotspotPlanningService = new TimelineRouteHotspotPlanningService();
  private readonly manualPlacementOrderingService = new TimelineManualPlacementOrderingService(
    (...args) => (this.logBookingRule as any)(...args),
  );
  private readonly destinationReservationService = new TimelineDestinationReservationService();
  private readonly carryForwardAttachmentService = new TimelineCarryForwardAttachmentService();
  private readonly matrixAutobuildService = new TimelineMatrixAutobuildService();
  private readonly candidateReorderingService = new TimelineCandidateReorderingService();
  private readonly day1CandidateGateService = new TimelineDay1CandidateGateService();
  private readonly day1CutoffMasterService = new TimelineDay1CutoffMasterService();
  private readonly day1TravelProjectionService = new TimelineDay1TravelProjectionService();
  private readonly transportEarlyArrivalTimelineService = new TransportEarlyArrivalTimelineService();
  private readonly candidatePolicyService = new TimelineCandidatePolicyService(
    this.operatingHoursService,
    this.slotPolicyService,
    this.rejectionPolicyService,
    this.routePolicyService,
  );

  constructor() {
    this.day1SourceFallbackService.setCallbacks({
      normalizeCityName: (...args) => (this.normalizeCityName as any)(...args),
      hotspotLocationMatchesCity: (...args) => (this.hotspotLocationMatchesCity as any)(...args),
    });
    this.routeHotspotSelectionService.setCallbacks({
      logTimeline: (...args) => (this.logTimeline as any)(...args),
      logBookingRule: (...args) => (this.logBookingRule as any)(...args),
      logHotspotCandidateEvaluation: (...args) => (this.logHotspotCandidateEvaluation as any)(...args),
      canonicalCityKey: (...args) => (this.canonicalCityKey as any)(...args),
      hotspotLocationMatchesCity: (...args) => (this.hotspotLocationMatchesCity as any)(...args),
      hotspotNameMatchesLocation: (...args) => (this.hotspotNameMatchesLocation as any)(...args),
      routeSpecificHotspotMatchesRouteChain: (...args) => (this.routeSpecificHotspotMatchesRouteChain as any)(...args),
      routeMovementOrder: (...args) => (this.routeMovementOrder as any)(...args),
      buildRouteLegs: (...args) => (this.buildRouteLegs as any)(...args),
      resolvePlaceCoords: (...args) => (this.resolvePlaceCoords as any)(...args),
      getTravelLocationType: (...args) => (this.getTravelLocationType as any)(...args),
    });
    this.arrivalHotelDecisionService.setCallbacks({
      getHotelDetailsForRoute: (...args) => (this.getHotelDetailsForRoute as any)(...args),
      canonicalCityKey: (...args) => (this.canonicalCityKey as any)(...args),
      toDateOnly: (...args) => (this.dataAccessService.toDateOnly as any)(...args),
      getArrivalPolicyDecisionStateForRoute: (...args) => (this.dataAccessService.getArrivalPolicyDecisionStateForRoute as any)(...args),
      extractPlanTimeOfDaySeconds: (...args) => (this.extractPlanTimeOfDaySeconds as any)(...args),
      logBookingRule: (...args) => (this.logBookingRule as any)(...args),
      logTimeline: (...args) => (this.logTimeline as any)(...args),
      getCurrentQuoteId: () => this.currentQuoteId,
    });
    this.hotelFirstInsertionService.setCallbacks({
      logBookingRule: (...args) => (this.logBookingRule as any)(...args),
    });
    this.nonHotelCutoffService.setCallbacks({
      canonicalCityKey: (...args) => (this.canonicalCityKey as any)(...args),
    });
    this.routeHotspotPlanningService.setCallbacks({
      fetchSelectedHotspots: (...args) => (this.fetchSelectedHotspotsForRoute as any)(...args),
      fetchDay1TopPrioritySourceHotspots: (...args) => (this.fetchDay1TopPrioritySourceHotspots as any)(...args),
      canonicalCityKey: (...args) => (this.canonicalCityKey as any)(...args),
      buildSameCityContinuationContext: (...args) => (this.buildSameCityContinuationContext as any)(...args),
      logBookingRule: (...args) => (this.logBookingRule as any)(...args),
    });
    this.candidatePolicyService.setCallbacks({
      canonicalCityKey: (...args) => (this.canonicalCityKey as any)(...args),
      logBookingRule: (...args) => (this.logBookingRule as any)(...args),
      appendProofTrace: (...args) => (this.appendProofTrace as any)(...args),
      getCurrentQuoteId: () => this.currentQuoteId,
      isVerboseTimelineProofLogs: () => this.verboseTimelineProofLogs,
    });
  }

  private logTimeline(...args: any[]): void {
    if (this.verboseTimelineLogs) {
      console.log(...args);
    }
  }

  private appendProofTrace(line: string): void {
    if (!this.verboseTimelineProofLogs) {
      return;
    }

    try {
      const outPath = path.resolve(process.cwd(), 'tmp', 'php-parity-trace.log');
      fs.appendFileSync(outPath, `${line}\n`, 'utf8');
    } catch {
      // Best-effort debugging only.
    }
  }

  // TODO: remove after validation
  private logBookingRule(payload: Record<string, unknown>): void {
    if (this.verboseTimelineProofLogs) {
      console.log('[BOOKING_RULE]', payload);
      try {
        this.appendProofTrace(`[BOOKING_RULE] ${JSON.stringify(payload)}`);
      } catch {
        // Best-effort debugging only.
      }
    }
  }

  private formatTimingTime(...args: any[]) { return (this.candidatePolicyService.formatTimingTime as any)(...args); }
  private getTimingWindowSummary(...args: any[]) { return (this.candidatePolicyService.getTimingWindowSummary as any)(...args); }
  private isHotspotClosedOnDay(...args: any[]) { return (this.candidatePolicyService.isHotspotClosedOnDay as any)(...args); }
  private isHotspotClosedOnAllDays(...args: any[]) { return (this.candidatePolicyService.isHotspotClosedOnAllDays as any)(...args); }
  private getRouteVisitDaysForClosedFilter(...args: any[]): Set<number> { return (this.candidatePolicyService.getRouteVisitDaysForClosedFilter as any)(...args) as Set<number>; }
  private getDayTimeSlot(...args: any[]) { return (this.candidatePolicyService.getDayTimeSlot as any)(...args); }
  private resolveTimelineBucket(...args: any[]) { return (this.candidatePolicyService.resolveTimelineBucket as any)(...args); }
  private isRouteMovementBucket(...args: any[]) { return (this.candidatePolicyService.isRouteMovementBucket as any)(...args); }
  private isSourceBucket(...args: any[]) { return (this.candidatePolicyService.isSourceBucket as any)(...args); }
  private shouldSkipWaitForOpening(...args: any[]) { return (this.candidatePolicyService.shouldSkipWaitForOpening as any)(...args); }
  private shouldAllowWaitUntilOpenForCandidate(...args: any[]) { return (this.candidatePolicyService.shouldAllowWaitUntilOpenForCandidate as any)(...args); }
  private getNextSlotStart(...args: any[]) { return (this.candidatePolicyService.getNextSlotStart as any)(...args); }
  private maxTimeString(...args: any[]) { return (this.candidatePolicyService.maxTimeString as any)(...args); }
  private buildFreeTimeBreakRow(...args: any[]) { return (this.candidatePolicyService.buildFreeTimeBreakRow as any)(...args); }
  private getCarryPriorityBucket(...args: any[]) { return (this.candidatePolicyService.getCarryPriorityBucket as any)(...args); }
  private sortCarryForwardHotspots(...args: any[]) { return (this.candidatePolicyService.sortCarryForwardHotspots as any)(...args); }
  private mergeCarryForwardIntoCandidates(...args: any[]) { return (this.candidatePolicyService.mergeCarryForwardIntoCandidates as any)(...args); }
  private logHotspotCandidateEvaluation(...args: any[]) { return (this.candidatePolicyService.logHotspotCandidateEvaluation as any)(...args); }
  private shouldApplyRouteEndBuffer(...args: any[]) { return (this.candidatePolicyService.shouldApplyRouteEndBuffer as any)(...args); }
  private getRouteEndBufferSeconds(...args: any[]) { return (this.candidatePolicyService.getRouteEndBufferSeconds as any)(...args); }
  private classifyRejectionReason(...args: any[]) { return (this.candidatePolicyService.classifyRejectionReason as any)(...args); }
  private buildRejectionGateBreakdown(...args: any[]) { return (this.candidatePolicyService.buildRejectionGateBreakdown as any)(...args); }
  private recordHotspotCandidateEvaluation(...args: any[]) { return (this.candidatePolicyService.recordHotspotCandidateEvaluation as any)(...args); }
  private normalizeCityName(...args: any[]) { return (this.candidatePolicyService.normalizeCityName as any)(...args); }
  private canonicalCityKey(...args: any[]) { return (this.candidatePolicyService.canonicalCityKey as any)(...args); }
  private isSameCity(...args: any[]) { return (this.candidatePolicyService.isSameCity as any)(...args); }
  private getSameCityRouteKey(...args: any[]) { return (this.candidatePolicyService.getSameCityRouteKey as any)(...args); }
  private buildReservedSameCityHotspotIdsByRoute(...args: any[]) { return (this.candidatePolicyService.buildReservedSameCityHotspotIdsByRoute as any)(...args); }
  private hotspotLocationMatchesCity(...args: any[]) { return (this.candidatePolicyService.hotspotLocationMatchesCity as any)(...args); }
  private buildRouteLegs(...args: any[]) { return (this.candidatePolicyService.buildRouteLegs as any)(...args); }
  private routeSpecificHotspotMatchesRouteChain(...args: any[]) { return (this.candidatePolicyService.routeSpecificHotspotMatchesRouteChain as any)(...args); }
  private routeMovementOrder(...args: any[]) { return (this.candidatePolicyService.routeMovementOrder as any)(...args); }
  private hotspotNameMatchesLocation(...args: any[]) { return (this.candidatePolicyService.hotspotNameMatchesLocation as any)(...args); }
  private isCarryForwardHotspotCompatibleWithRoute(...args: any[]) { return (this.candidatePolicyService.isCarryForwardHotspotCompatibleWithRoute as any)(...args); }
  private estimateRouteHotspotCapacity(...args: any[]) { return (this.candidatePolicyService.estimateRouteHotspotCapacity as any)(...args); }
  private checkHotspotOperatingHoursFromMap(...args: any[]) { return (this.candidatePolicyService.checkHotspotOperatingHoursFromMap as any)(...args); }

  async buildTimelineForPlan(
    tx: Tx,
    planId: number,
    existingHotspots?: any[],
    options?: {
      manualPlacementByRoute?: Record<number, {
        hotspotOrder?: number;
      }>;
      sameCityAllocationPlan?: SameCityAllocationPlan | null;
      /** When set, only process/rebuild this route instead of the entire plan. */
      scopeToRouteId?: number;
    },
  ): Promise<{
    hotspotRows: HotspotDetailRow[];
    parkingRows: ParkingChargeRow[];
    routeRejectionSummaryByRoute: Record<number, RouteRejectionSummary>;
  }> {
    this.rejectionPolicyService.clear();

    const buildStart = Date.now();
    this.logTimeline('[TIMELINE] buildTimelineForPlan started for planId:', planId, existingHotspots ? `with ${existingHotspots.length} pre-loaded hotspots` : '');
    
    let opStart = Date.now();
    const plan = (await this.dataAccessService.loadPlan(tx, planId)) as PlanHeader | null;
    this.logTimeline('[TIMELINE] Fetch plan:', Date.now() - opStart, 'ms');

    if (!plan) {
      return { hotspotRows: [], parkingRows: [], routeRejectionSummaryByRoute: {} };
    }

    this.currentQuoteId = String(
      (plan as any).quote_id ??
        (plan as any).quoteId ??
        (plan as any).quote_ID ??
        (plan as any).itinerary_quote_ID ??
        '',
    );
    if (this.verboseTimelineProofLogs) {
      this.appendProofTrace(`[TRACE_START] planId=${planId} quoteId=${this.currentQuoteId}`);
    }

    opStart = Date.now();
    const routes = (await this.dataAccessService.loadRoutes(tx, planId)) as RouteRow[];
    this.logTimeline('[TIMELINE] Fetch routes:', Date.now() - opStart, 'ms, count:', routes.length);

    if (!routes.length) {
      return { hotspotRows: [], parkingRows: [], routeRejectionSummaryByRoute: {} };
    }

    // When scoped to a single route (preview mode), skip all other routes.
    const scopedRoutes = options?.scopeToRouteId
      ? routes.filter((r) => r.itinerary_route_ID === options!.scopeToRouteId)
      : routes;

    const previousRouteByRouteId = new Map<number, RouteRow>();
    for (let i = 1; i < routes.length; i++) {
      previousRouteByRouteId.set(
        Number((routes[i] as any).itinerary_route_ID || 0),
        routes[i - 1],
      );
    }

    if (options?.scopeToRouteId && scopedRoutes.length === 0) {
      return { hotspotRows: [], parkingRows: [], routeRejectionSummaryByRoute: {} };
    }

    const reservedSameCityHotspotIdsByRoute = this.buildReservedSameCityHotspotIdsByRoute(
      routes,
      existingHotspots,
      options?.scopeToRouteId,
    );

    // SCENARIO 2: Check if arrival city == departure city
    // If yes AND departure time > 4 PM, skip Day 1 local sightseeing and do it on last day
    const arrivalPoint = String(plan.arrival_location ?? '').trim();
    const departurePoint = String(plan.departure_location ?? '').trim();
    
    const isSameArrivalDepartureCity = this.isSameCity(arrivalPoint, departurePoint);
    
    // Check departure time (extract hour from trip_end_date_and_time)
    let departureTimeAfter4PM = false;
    if (plan.trip_end_date_and_time && plan.trip_end_date_and_time instanceof Date) {
      const departureHour = plan.trip_end_date_and_time.getUTCHours();
      departureTimeAfter4PM = departureHour >= 16; // 4 PM or later
    }
    
    const shouldDeferDay1Sightseeing = isSameArrivalDepartureCity && departureTimeAfter4PM;

    // ⚡ PERFORMANCE OPTIMIZATION: Fetch all hotspots ONCE instead of once per route
    opStart = Date.now();
    const allHotspots = await this.dataAccessService.loadAllActiveHotspots(tx);
    this.logTimeline('[TIMELINE] Fetch ALL hotspots ONCE:', Date.now() - opStart, 'ms, count:', allHotspots.length);

    // ⚡ PERF: Pre-load global settings once so distanceHelper.getBufferTime never hits DB.
    // Without this, every fromSourceAndDestination / fromCoordinates call issues a
    // dvi_global_settings.findFirst query — that is 774+ serial queries just for hotspot scoring.
    const globalSettingsForBuilder = await (tx as any).dvi_global_settings?.findFirst({
      where: { status: 1, deleted: 0 },
    });
    if (globalSettingsForBuilder) {
      this.distanceHelper.setGlobalSettings(globalSettingsForBuilder);
    }

    // ⚡ Create hotspot lookup map for O(1) access (avoid repeated DB queries)
    const hotspotMap = new Map();
    for (const h of allHotspots) {
      hotspotMap.set(h.hotspot_ID, {
        hotspot_ID: h.hotspot_ID,
        hotspot_name: h.hotspot_name,
        hotspot_location: h.hotspot_location,
        hotspot_to_location: h.hotspot_to_location,
        hotspot_type: h.hotspot_type,
        hotspot_priority: h.hotspot_priority,
        hotspot_latitude: h.hotspot_latitude,
        hotspot_longitude: h.hotspot_longitude,
        hotspot_duration: h.hotspot_duration,
      });
    }
    this.logTimeline('[TIMELINE] Created hotspot lookup map');

    // ⚡ Batch-fetch ALL timing data for ALL days at once (avoid 42+ individual queries)
    opStart = Date.now();
    const allTimings = await this.dataAccessService.loadAllActiveTimings(tx);
    // Group timings by hotspot_ID and day for O(1) lookup
    const timingMap = this.dataAccessService.buildTimingMap(allTimings);
    this.logTimeline('[TIMELINE] Batch-fetched ALL timing data:', Date.now() - opStart, 'ms, records:', allTimings.length);

    const permanentlyClosedHotspotIds = new Set<number>();
    for (const h of allHotspots) {
      const hotspotId = Number((h as any).hotspot_ID || 0);
      if (!hotspotId) continue;
      if (this.isHotspotClosedOnAllDays(timingMap, hotspotId)) {
        permanentlyClosedHotspotIds.add(hotspotId);
      }
    }

    const filteredHotspots = allHotspots.filter((h) => {
      const hotspotId = Number((h as any).hotspot_ID || 0);
      return hotspotId > 0 && !permanentlyClosedHotspotIds.has(hotspotId);
    });

    this.logBookingRule({
      rule: 'HOTSPOT_PREFILTER_ALL_DAYS_CLOSED',
      quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
      planId,
      closedHotspotCount: permanentlyClosedHotspotIds.size,
      closedHotspotSample: Array.from(permanentlyClosedHotspotIds.values()).slice(0, 30),
      beforeCount: allHotspots.length,
      afterCount: filteredHotspots.length,
    });

    const hotspotRows: HotspotDetailRow[] = [];
    const parkingRows: ParkingChargeRow[] = [];

    // Track hotspots already added to THIS generated plan during this build.
    // IMPORTANT:
    // Always normalize hotspot_ID to Number before checking/adding.
    // Some Prisma/raw rows can return number/string/BigInt depending on query path.
    // If we add one shape and check another shape, duplicates can slip through.
    const addedHotspotIds = new Set<number>();

    const normalizePlannedHotspotId = (value: any): number => {
      const id = Number(value || 0);
      return Number.isFinite(id) && id > 0 ? id : 0;
    };

    const isHotspotAlreadyPlanned = (value: any): boolean => {
      const id = normalizePlannedHotspotId(value);
      return id > 0 && addedHotspotIds.has(id);
    };

    const markHotspotAsPlanned = (value: any): void => {
      const id = normalizePlannedHotspotId(value);
      if (id > 0) {
        addedHotspotIds.add(id);
      }
    };

    const rejectDuplicatePlanHotspot = (
      hotspotIdValue: any,
      context: {
        routeId: number;
        routeDay?: number;
        sourceCity?: string;
        destinationCity?: string;
        branch: string;
        hotspotName?: string;
      },
    ): boolean => {
      const hotspotId = normalizePlannedHotspotId(hotspotIdValue);
      if (!hotspotId) return true;

      if (!addedHotspotIds.has(hotspotId)) {
        return false;
      }

      this.logBookingRule({
        rule: 'DUPLICATE_PLAN_SCOPE_REJECTED_BEFORE_INSERT',
        quoteId:
          (plan as any).quote_id ??
          (plan as any).quoteId ??
          (plan as any).quote_ID ??
          null,
        planId,
        routeId: context.routeId,
        routeDay: context.routeDay ?? null,
        sourceCity: context.sourceCity ?? null,
        destinationCity: context.destinationCity ?? null,
        hotspotId,
        hotspotName: context.hotspotName || '',
        branch: context.branch,
        reason:
          'Hotspot already scheduled earlier in this generated plan. Rejecting before travel/hotspot row insertion.',
      });

      return true;
    };

    if (options?.scopeToRouteId && Array.isArray(existingHotspots) && existingHotspots.length > 0) {
      const scopedRouteId = Number(options.scopeToRouteId || 0);
      for (const row of existingHotspots) {
        if (Number((row as any)?.deleted || 0) !== 0) continue;
        if (Number((row as any)?.item_type || 0) !== 4) continue;
        const routeId = Number((row as any)?.itinerary_route_ID || 0);
        const hotspotId = Number((row as any)?.hotspot_ID || 0);
        if (!routeId || !hotspotId) continue;
        if (routeId === scopedRouteId) continue;
        addedHotspotIds.add(hotspotId);
      }
    }
    
    // Track last added hotspot ID for cache-first distance computation (hotspot→hotspot)
    let lastAddedHotspotId: number | null = null;

    // TODO (later): pass real user id from controller/service.
    const createdByUserId = 1;

    // Track first route for special Day 1 handling
    let routeIndex = 0;
    let carryForwardOrder = 0;
    let carryForwardHotspots: CarryForwardHotspot[] = [];

    for (const route of scopedRoutes) {
      const routeProcessStart = Date.now();
      this.logTimeline('[TIMELINE] Processing route', routeIndex + 1, '/', routes.length, '- routeId:', route.itinerary_route_ID);

      // PHP includeHotspotInItinerary checks duplicates at itinerary-plan scope.
      // Keep addedHotspotIds across routes, but reset chaining state per route.
      lastAddedHotspotId = null;
      
      const isFirstRoute = routeIndex === 0;
      routeIndex++;
      
      // Determine if this is the last route BEFORE processing
      const isLastRoute = await this.isLastRouteOfPlan(
        tx,
        planId,
        route.itinerary_route_ID,
      );
      
      // PHP BEHAVIOR: Last route starts at order 2 (no refreshment, order starts at 2)
      let order = isLastRoute ? 2 : 1;
      
      // Convert Date objects to HH:MM:SS time strings
      // IMPORTANT: Use UTC methods because database stores times as UTC timestamps
      const routeStartTime: string = typeof route.route_start_time === 'string' 
        ? route.route_start_time 
        : route.route_start_time && typeof route.route_start_time === 'object'
        ? `${String((route.route_start_time as any).getUTCHours()).padStart(2, '0')}:${String((route.route_start_time as any).getUTCMinutes()).padStart(2, '0')}:${String((route.route_start_time as any).getUTCSeconds()).padStart(2, '0')}`
        : '09:00:00';
        
      let routeEndTime: string = typeof route.route_end_time === 'string'
        ? route.route_end_time
        : route.route_end_time && typeof route.route_end_time === 'object'
        ? `${String((route.route_end_time as any).getUTCHours()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCMinutes()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCSeconds()).padStart(2, '0')}`
        : '18:00:00';

      // RULE: Use saved routeStartTime and routeEndTime from database as source of truth.
      // These are set by user manual edits via PATCH /api/v1/itineraries/:planId/route/:routeId/times
      // Do NOT override with hardcoded times here.
      // Conditional overrides (e.g., early-arrival deferred flow) are applied later after arrival policy evaluation.
      let effectiveRouteStartTime = routeStartTime;

      const computeRouteEndSeconds = (startSeconds: number): number => {
        let endSeconds = timeToSeconds(routeEndTime);
        if (endSeconds < startSeconds) {
          endSeconds += 86400; // Add 24 hours in seconds for overnight windows
        }
        endSeconds += this.getRouteEndBufferSeconds(route.itinerary_route_ID);
        return endSeconds;
      };
      
      let currentTime = effectiveRouteStartTime;
      let routeStartSeconds = timeToSeconds(effectiveRouteStartTime);
      let routeEndSeconds = computeRouteEndSeconds(routeStartSeconds);
      let lastRouteArrivalDeadlineSeconds = routeEndSeconds;
      if (isLastRoute) {
        // Strict report-time rule for departure terminal:
        // deadline = trip_end_date_and_time (flight/train/etc) - departure buffer.
        // Use route_end_time as fallback, and never exceed it.
        const departureSecondsRaw =
          this.extractPlanTimeOfDaySeconds((plan as any).trip_end_date_and_time) ??
          this.extractPlanTimeOfDaySeconds((plan as any).trip_end_date);
        if (departureSecondsRaw !== null) {
          let departureSeconds = departureSecondsRaw;

          if (departureSeconds < routeStartSeconds) {
            departureSeconds += 86400;
          }

          const departureBufferSeconds =
            Number((plan as any).departure_type || 0) === 1
              ? 2 * 3600
              : Number((plan as any).departure_type || 0) === 2
                ? 1 * 3600
                : 0;

          const reportDeadlineSeconds = Math.max(
            routeStartSeconds,
            departureSeconds - departureBufferSeconds,
          );

          lastRouteArrivalDeadlineSeconds = Math.min(routeEndSeconds, reportDeadlineSeconds);
        } else {
          // Fallback to route_end_time when no departure datetime is available.
          lastRouteArrivalDeadlineSeconds = routeEndSeconds;
        }
      }

      // Maintain current logical location name for distance calculations.
      // Start with the route's location_name (same as PHP "route start city").
      // Parse pipe-separated location to get first/main location only
      const rawStartLocation = (route.location_name as string) ||
        (route.next_visiting_location as string) ||
        (plan.departure_location as string) ||
        "";
      let currentLocationName: string = rawStartLocation.split('|')[0].trim();
      
      // Get starting coordinates from stored_locations using location_id (PHP: getITINEARYROUTE_DETAILS + getSTOREDLOCATIONDETAILS)
      // PHP line 1108-1109: $staring_location_latitude = getSTOREDLOCATIONDETAILS($start_location_id, 'source_location_lattitude');
      let currentCoords: { lat: number; lon: number } | undefined = undefined;
      let destCityCoords: { lat: number; lon: number } | undefined = undefined;
      let sourceCity = "";
      let destinationCity = "";
      
      // ✅ RULE 1: ENFORCE 22:00 CUTOFF (destination arrival deadline)
      // Calculate: latestAllowedHotspotEnd = 22:00 - (travel to destination + buffer)
      // This ensures user reaches destination city by 22:00 for hotel check-in
      // PHP includeHotspotInItinerary parity: gate by hotspot end <= route_end_time.
      // Do not pre-reserve extra time for later destination travel while selecting hotspots.
      
      // Route fields are the source of truth for scheduling/candidate matching.
      // location_id/stored_locations may be stale or reused, so use it only for coordinates.
      const routeSourceCity = String((route as any).location_name || '')
        .split('|')[0]
        .trim();

      const routeDestinationCity = String((route as any).next_visiting_location || '')
        .split('|')[0]
        .trim();

      sourceCity = routeSourceCity;
      destinationCity = routeDestinationCity;

      if (route.location_id) {
        const storedLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: {
            location_ID: Number(route.location_id),
            deleted: 0,
            status: 1,
          },
        });
        
        if (storedLoc) {
          // Use stored_locations only for coordinates.
          // Do NOT overwrite sourceCity/destinationCity when route fields already exist.
          currentCoords = {
            lat: Number(storedLoc.source_location_lattitude ?? 0),
            lon: Number(storedLoc.source_location_longitude ?? 0),
          };
          destCityCoords = {
            lat: Number(storedLoc.destination_location_lattitude ?? 0),
            lon: Number(storedLoc.destination_location_longitude ?? 0),
          };

          if (!sourceCity) {
            sourceCity = String(storedLoc.source_location || '').split('|')[0].trim();
          }

          if (!destinationCity) {
            destinationCity = String(storedLoc.destination_location || '').split('|')[0].trim();
          }
        }
      }

      // Fallback for routes where location_id is 0 or the stored row is missing coordinates.
      // This keeps source/destination coordinate resolution anchored to the route cities.
      if (!this.hasUsableCoords(currentCoords)) {
        currentCoords =
          (await this.resolvePlaceCoords(tx, sourceCity, 'source')) ||
          (await this.resolvePlaceCoords(tx, routeSourceCity, 'source')) ||
          undefined;
      }

      if (!this.hasUsableCoords(destCityCoords)) {
        destCityCoords =
          (await this.resolvePlaceCoords(tx, destinationCity, 'destination')) ||
          (await this.resolvePlaceCoords(tx, routeDestinationCity, 'destination')) ||
          undefined;
      }
      
      // Final fallback only if route fields and stored_locations are both missing.
      if (!sourceCity) sourceCity = String((route as any).location_name || '').split('|')[0].trim();
      if (!destinationCity) destinationCity = String((route as any).next_visiting_location || '').split('|')[0].trim();

      const routeStartLocationName = currentLocationName;
      const routeStartCoords = currentCoords
        ? { lat: Number(currentCoords.lat ?? 0), lon: Number(currentCoords.lon ?? 0) }
        : null;

      // Route-level hotel context is reused for both hotspot gating and final hotel segment.
      const arrivalHotelDecision = await this.arrivalHotelDecisionService.evaluate({
        tx,
        planId,
        route,
        plan,
        isFirstRoute,
        isLastRoute,
        sourceCity,
        destinationCity,
        arrivalPoint,
        currentCoords,
        destCityCoords,
        routeStartTime,
        routeEndTime,
        effectiveRouteStartTime,
        currentTime,
        routeStartSeconds,
        routeEndSeconds,
        lastRouteArrivalDeadlineSeconds,
        computeRouteEndSeconds,
      });

      effectiveRouteStartTime = arrivalHotelDecision.effectiveRouteStartTime;
      currentTime = arrivalHotelDecision.currentTime;
      routeStartSeconds = arrivalHotelDecision.routeStartSeconds;
      routeEndSeconds = arrivalHotelDecision.routeEndSeconds;
      lastRouteArrivalDeadlineSeconds = arrivalHotelDecision.lastRouteArrivalDeadlineSeconds;
      const {
        hotelInfoForRoute,
        normalizedArrivalCity,
        isArrivalCityStayRoute,
        evaluatedArrivalPolicy,
        arrivalPolicyWantsHotelDeferredToEnd,
        isEarlyArrivalAwaitingDecisionSameDayFlow,
        suppressHotelInsertionUntilEndOfDay,
        isEarlyArrivalResolvedSameDayDeferredFlow,
        arrivalPolicyAllowsHotelFirst,
        enforceStrictDay1EarlyArrivalDeferredFlow,
        firstSightseeingMovementTime,
        isEarlyArrivalPrevDayConfirmed,
        arrivalHour,
        isArrivalAfterNoon,
        isSpecialDay1OnePmHotelFirstFlow,
        fullDayMarkerRaw,
        hasReliableFullDayMarker,
        isFullDayTrip,
        fallbackHotelCoords,
        hotelDistanceFromArrivalKm,
        shouldHotelFirstByDistance,
        shouldHotelLastByDistance,
        forceNoSightseeingOnThisRoute,
        wrappedLastRouteArrivalDeadlineSeconds,
        isTransferOnlyLastRouteByReportDeadline,
        skipInitialRefreshmentForImmediateHotelCheckin,
      } = arrivalHotelDecision;

      let didHotelFirstCheckin = false;

      const transportEarlyArrivalResult =
        await this.transportEarlyArrivalTimelineService.apply({
          tx,
          planId,
          routeId: route.itinerary_route_ID,
          plan,
          isFirstRoute,
          isLastRoute,
          routeEndSeconds,
          currentTime,
          currentLocationName,
          order,
          createdByUserId,
        });
      hotspotRows.push(...transportEarlyArrivalResult.rows);
      if (transportEarlyArrivalResult.handled) {
        order += transportEarlyArrivalResult.rows.length;
        currentTime = transportEarlyArrivalResult.currentTime;
        currentLocationName = transportEarlyArrivalResult.currentLocationName;
        currentCoords = undefined;
      }
      const isVehicleHotelRestEarlyArrival =
        transportEarlyArrivalResult.handled &&
        Number(plan.itinerary_preference || 0) === 2 &&
        String((plan as any).transport_early_arrival_option || '').trim().toUpperCase() === 'HOTEL_REST';

      // 1) ADD REFRESHMENT BREAK (PHP line 969-993)
      // PHP adds 1-hour refreshment at route start EXCEPT for last route
      // Last route starts directly with hotspots (order 2) and skips refreshment ROW
      // BUT PHP still advances currentTime by buffer amount for last route (without creating row)
      const skipInitialRefreshment =
        transportEarlyArrivalResult.skipGenericRefreshment ||
        skipInitialRefreshmentForImmediateHotelCheckin;
      if (!isLastRoute && !skipInitialRefreshment) {
        const globalSettings = await (tx as any).dvi_global_settings?.findFirst({
          where: { status: 1, deleted: 0 },
          select: { itinerary_common_buffer_time: true },
        });
        
        const bufferTime = enforceStrictDay1EarlyArrivalDeferredFlow
          ? '01:00:00'
          : (globalSettings?.itinerary_common_buffer_time
            ? (globalSettings.itinerary_common_buffer_time instanceof Date
              ? `${String(globalSettings.itinerary_common_buffer_time.getUTCHours()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCMinutes()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCSeconds()).padStart(2, '0')}`
              : String(globalSettings.itinerary_common_buffer_time))
            : '01:00:00');
        
        const bufferSeconds = timeToSeconds(bufferTime);
        const refreshmentEndTime = enforceStrictDay1EarlyArrivalDeferredFlow && firstSightseeingMovementTime
          ? firstSightseeingMovementTime
          : addSeconds(currentTime, bufferSeconds);
        const refreshmentEndSeconds = timeToSeconds(refreshmentEndTime);
        
        // Only add refreshment if it fits within route time
        if (refreshmentEndSeconds <= routeEndSeconds) {
          // PHP line 978: refreshment fields - use TimeConverter to match other builders
          hotspotRows.push({
            itinerary_plan_ID: planId,
            itinerary_route_ID: route.itinerary_route_ID,
            item_type: 1,
            hotspot_order: order++,
            hotspot_traveling_time: TimeConverter.toDate(bufferTime),
            hotspot_start_time: TimeConverter.toDate(currentTime),
            hotspot_end_time: TimeConverter.toDate(refreshmentEndTime),
            createdby: createdByUserId,
            status: 1,
            deleted: 0,
          });
          
          // Update current time after refreshment
          currentTime = refreshmentEndTime;

          if (enforceStrictDay1EarlyArrivalDeferredFlow && firstSightseeingMovementTime) {
            // Hard policy rule: first sightseeing movement must start exactly at 09:00.
            currentTime = firstSightseeingMovementTime;
          }
        }
      } else if (isLastRoute && !transportEarlyArrivalResult.handled) {
        // PHP BEHAVIOR: Last route doesn't create refreshment ROW but still advances time
        if (!isTransferOnlyLastRouteByReportDeadline) {
          const globalSettings = await (tx as any).dvi_global_settings?.findFirst({
            where: { status: 1, deleted: 0 },
            select: { itinerary_common_buffer_time: true },
          });
          
          const bufferTime = globalSettings?.itinerary_common_buffer_time
            ? (globalSettings.itinerary_common_buffer_time instanceof Date
              ? `${String(globalSettings.itinerary_common_buffer_time.getUTCHours()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCMinutes()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCSeconds()).padStart(2, '0')}`  
              : String(globalSettings.itinerary_common_buffer_time))
            : '01:00:00';
          
          const bufferSeconds = timeToSeconds(bufferTime);
          currentTime = addSeconds(currentTime, bufferSeconds);
        }
      }

      const hotelFirstInsertion = await this.hotelFirstInsertionService.insert({
        tx,
        planId,
        routeId: route.itinerary_route_ID,
        plan,
        currentTime,
        currentLocationName,
        currentCoords,
        destinationLocationName: ((route.next_visiting_location as string) || currentLocationName).split('|')[0].trim(),
        destinationCoords: destCityCoords,
        hotelInfo: hotelInfoForRoute,
        order,
        createdByUserId,
        isLastRoute,
        suppressHotelInsertionUntilEndOfDay,
        isEarlyArrivalPrevDayConfirmed,
        isSpecialDay1OnePmHotelFirstFlow,
        shouldHotelFirstByDistance,
        hotelDistanceFromArrivalKm,
        isArrivalAfterNoon,
      });
      hotspotRows.push(...hotelFirstInsertion.rows);
      order = hotelFirstInsertion.order;
      currentTime = hotelFirstInsertion.currentTime;
      currentLocationName = hotelFirstInsertion.currentLocationName;
      currentCoords = hotelFirstInsertion.currentCoords;
      didHotelFirstCheckin = hotelFirstInsertion.didHotelFirstCheckin;
      const isHotelPreferenceEarlyArrival =
        Number(plan.itinerary_preference || 0) === 1 &&
        isFirstRoute &&
        arrivalHour !== null &&
        arrivalHour < 8;

      // 2) CALCULATE LATEST HOTSPOT END USING ROUTE'S CONFIGURED END TIME
      // Use route_end_time (not hardcoded cutoffs) so users can adjust end time
      const nonHotelCutoff = await this.nonHotelCutoffService.calculate({
        tx,
        route,
        isLastRoute,
        routeEndSeconds,
        routeEndTime,
        sourceCity,
        destinationCity,
        destCityCoords,
      });
      let latestNonHotelEndSeconds = nonHotelCutoff.latestNonHotelEndSeconds;
      let latestNonHotelEndTime = nonHotelCutoff.latestNonHotelEndTime;
      

      // 2) SELECTED HOTSPOTS FOR THIS ROUTE
      // DAY-1 DIFFERENT CITIES: If Day 1 and source city != destination city, enforce max 3 priority hotspots
      const routeHotspotPlanning = await this.routeHotspotPlanningService.select({
        tx,
        planId,
        route,
        plan,
        routes,
        scopedRoutes,
        routeIndex,
        previousRouteByRouteId,
        sourceCity,
        destinationCity,
        arrivalPoint,
        departurePoint,
        currentLocationName,
        filteredHotspots,
        hotspotRows,
        carryForwardHotspots,
        isFirstRoute,
        isLastRoute,
        shouldDeferDay1Sightseeing,
        forceNoSightseeingOnThisRoute,
        verboseTimelineProofLogs: this.verboseTimelineProofLogs,
      });
      let selectedHotspots = routeHotspotPlanning.selectedHotspots as SelectedHotspot[];
      carryForwardHotspots = routeHotspotPlanning.carryForwardHotspots;
      const {
        day1SourceCompare,
        day1DestinationCompare,
        nextRoute,
        currentRouteViaRows,
        currentRouteViaLocationNames,
        hasExplicitViaRouteOnCurrentRoute,
        isIntercityTransferWithExplicitVia,
        directToNextForCurrentRoute,
        isIntercityDirectDestinationTransfer,
        isIntercityMovementFirstTransfer,
        sameCityContinuationContextForRoute,
        nextRouteSameCityContinuation,
        isDay1DifferentCities,
        directToNextForDestinationReservation,
        isEligibleForDestinationReservation,
        isRouteSourceTerminal,
        remainingRoutes,
        hasLaterOvernightInSourceCity,
        tracePhpIncludeFlow,
        isLoopbackRoute,
        shouldApplySourceHotspotCutoff,
      } = routeHotspotPlanning;

      {
        const previousRoute = previousRouteByRouteId.get(Number((route as any).itinerary_route_ID || 0));
        const visitDays = this.getRouteVisitDaysForClosedFilter(route, previousRoute);

        const beforeClosedFilterCount = selectedHotspots.length;
        selectedHotspots = selectedHotspots.filter((h: any) => {
          const hotspotId = Number((h as any).hotspot_ID || 0);
          if (!hotspotId) return false;
          if (permanentlyClosedHotspotIds.has(hotspotId)) return false;

          for (const dayOfWeek of visitDays.values()) {
            if (this.isHotspotClosedOnDay(timingMap, hotspotId, dayOfWeek)) {
              return false;
            }
          }
          return true;
        });

        if (selectedHotspots.length !== beforeClosedFilterCount) {
          this.logBookingRule({
            rule: 'HOTSPOT_PREFILTER_VISIT_DAY_CLOSED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            visitDays: Array.from(visitDays.values()).sort((a, b) => a - b),
            filteredCount: beforeClosedFilterCount - selectedHotspots.length,
          });
        }
      }

      const reservedSameCityHotspotIds = reservedSameCityHotspotIdsByRoute.get(
        Number(route.itinerary_route_ID || 0),
      );
      if (reservedSameCityHotspotIds && reservedSameCityHotspotIds.size > 0) {
        const beforeCount = selectedHotspots.length;
        selectedHotspots = selectedHotspots.filter((h: any) => {
          if ((h as any).isManualSelection) return true;
          const hotspotId = Number((h as any).hotspot_ID || 0);
          return hotspotId > 0 && !reservedSameCityHotspotIds.has(hotspotId);
        });

        if (selectedHotspots.length !== beforeCount) {
          this.logBookingRule({
            rule: 'SAME_CITY_RESERVED_HOTSPOTS_FILTERED',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            filteredCount: Math.max(0, beforeCount - selectedHotspots.length),
            reservedHotspotIds: Array.from(reservedSameCityHotspotIds.values()),
            reason:
              options?.scopeToRouteId
                ? 'Route-scoped rebuild: keep same-city hotspots already present on sibling routes from being auto-selected again.'
                : 'Full rebuild: keep hotspots manually reserved on sibling same-city routes from being auto-selected earlier in the plan.',
          });
        }
      }

      if (didHotelFirstCheckin) {
        this.logBookingRule({
          rule: 'POST_HOTEL_SIGHTSEEING_PASS',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          ran: selectedHotspots.length > 0,
          selectedHotspotCount: selectedHotspots.length,
        });
      }

      if (this.verboseTimelineProofLogs) {
        const routeTrace = JSON.stringify({
          routeId: route.itinerary_route_ID,
          day: route.itinerary_route_date,
          selected: selectedHotspots.map((h: any) => ({
            id: Number(h.hotspot_ID || 0),
            bucket: String((h as any).matched_bucket || 'unknown'),
            priority: Number((h as any).hotspot_priority ?? 0),
            distance: Number((h as any).hotspot_distance ?? 0),
          })),
        });
        console.log('[TRACE_SELECTED_ROUTE]', routeTrace);
        this.appendProofTrace(`[TRACE_SELECTED_ROUTE] ${routeTrace}`);
      }

      if (String((plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? '') === 'DVI20260589') {
        console.log('[DVI20260589 HOTSPOT ORDER TRACE]', {
          routeId: route.itinerary_route_ID,
          sourceCity,
          destinationCity,
          selected: selectedHotspots.map((h: any) => ({
            matched_bucket: String((h as any).matched_bucket || 'unknown'),
            hotspot_priority: Number((h as any).hotspot_priority ?? 0),
            hotspot_name: String((h as any).hotspot_name || ''),
          })),
        });
      }

      // NO LUNCH BREAKS OR TIME CUTOFFS - User can schedule all hotspots and delete unwanted ones from UI
      // Day 1: Schedule ALL top priority hotspots without time constraints
      // User can reach hotel at any time

      // STRATEGY: For Day-1 different cities, process hotspots with strict priority walk
      // For other days, use multi-pass scheduling to fill gaps with deferred hotspots
      
      const manualPlacementOrdering = this.manualPlacementOrderingService.apply({
        options,
        route,
        plan,
        planId,
        selectedHotspots,
        existingHotspots,
      });
      selectedHotspots = manualPlacementOrdering.selectedHotspots;
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
        minimumReservationCount: MIN_DESTINATION_HOTSPOTS_FOR_RESERVATION,
        estimateRouteHotspotCapacity: (...args) => (this.estimateRouteHotspotCapacity as any)(...args),
        isHotspotAlreadyPlanned,
        fetchSelectedHotspots: (...args) => (this.fetchSelectedHotspotsForRoute as any)(...args),
        fetchDay1TopPrioritySourceHotspots: (...args) => (this.fetchDay1TopPrioritySourceHotspots as any)(...args),
        hotspotLocationMatchesCity: (...args) => (this.hotspotLocationMatchesCity as any)(...args),
        logBookingRule: (...args) => (this.logBookingRule as any)(...args),
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
        sameCityChainContinuation: sameCityContinuationContextForRoute.isSameCityChainContinuation,
        mergeCarryForwardIntoCandidates: (...args) => (this.mergeCarryForwardIntoCandidates as any)(...args),
        logBookingRule: (...args) => (this.logBookingRule as any)(...args),
      });
      selectedHotspots = carryForwardAttachment.selectedHotspots;
      const { hasOnlySourceFallbackCandidates } = carryForwardAttachment;
      this.logTimeline('[TIMELINE] Selected hotspots for route:', selectedHotspots.length);
      // Matrix-assisted auto-build merge (optional, behind feature flag)
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
        getBetweenCandidatesForRouteSlots: (...args) => (this.dataAccessService.getBetweenCandidatesForRouteSlots as any)(...args),
        logTimeline: (...args) => (this.logTimeline as any)(...args),
        logBookingRule: (...args) => (this.logBookingRule as any)(...args),
        canonicalCityKey: (...args) => (this.canonicalCityKey as any)(...args),
        hotspotLocationMatchesCity: (...args) => (this.hotspotLocationMatchesCity as any)(...args),
        checkHotspotOperatingHoursFromMap: (...args) => (this.checkHotspotOperatingHoursFromMap as any)(...args),
      });



      // Re-order candidates: preserve manual selections and priority>0 first (protected),
      // then sort remaining candidates by matrix_score desc, then distance asc.

      selectedHotspots = this.candidateReorderingService.reorder(
        selectedHotspots,
        (...args) => (this.logTimeline as any)(...args),
      );
      const routeLoopStart = Date.now();
      let hotspotQueryCount = 0;
      let distanceCalcCount = 0;
      let operatingHoursCount = 0;
      
      if (isDay1DifferentCities) {
        // DAY-1 DIFFERENT CITIES: Strict priority walk with operating hour waiting
        // Process each hotspot in priority order, wait for next operating window if needed
        
        for (const sh of selectedHotspots) {
          const bucket = this.resolveTimelineBucket(sh);
          const hotspotPriority = Number((sh as any).hotspot_priority ?? 0);
          const isManualSelection = Boolean((sh as any).isManualSelection);
          const isRouteMovementBucket = this.isRouteMovementBucket(bucket);
          const isSourceBucket = this.isSourceBucket(bucket);


          if (this.day1CandidateGateService.shouldSkip({
            route,
            hotspot: sh,
            currentTime,
            isRouteSourceTerminal,
            hasLaterOvernightInSourceCity,
            isHotspotAlreadyPlanned,
            resolveTimelineBucket: (...args) => (this.resolveTimelineBucket as any)(...args),
            isRouteMovementBucket: (...args) => (this.isRouteMovementBucket as any)(...args),
            isSourceBucket: (...args) => (this.isSourceBucket as any)(...args),
            logHotspotCandidateEvaluation: (...args) => (this.logHotspotCandidateEvaluation as any)(...args),
          })) {
            continue;
          }


          const hotspotData = this.day1CutoffMasterService.resolve({
            route,
            hotspot: sh,
            hotspotMap,
            bucket,
            currentTime,
            shouldApplySourceHotspotCutoff,
            logHotspotCandidateEvaluation: (...args) => (this.logHotspotCandidateEvaluation as any)(...args),
          });
          if (!hotspotData) continue;

          const hotspotLocationName = hotspotData.hotspot_location as string || currentLocationName;
          const hotspotDuration = hotspotData.hotspot_duration || '01:00:00';
          const hotspotType = String(hotspotData.hotspot_type || hotspotData.hotspotType || '').trim().toLowerCase();
          const destCoords = {
            lat: Number(hotspotData.hotspot_latitude ?? 0),
            lon: Number(hotspotData.hotspot_longitude ?? 0),
          };

          const travelProjection = await this.day1TravelProjectionService.project({
            tx,
            route,
            hotspot: sh,
            hotspotData,
            currentLocationName,
            hotspotLocationName,
            currentCoords,
            sourceCity,
            destCoords,
            destCityCoords,
            currentTime,
            hotspotDuration,
            routeStartSeconds,
            routeEndSeconds,
            routeEndTime,
            isLastRoute,
            tracePhpIncludeFlow,
            distanceCalcCount,
            hasUsableCoords: (...args) => (this.hasUsableCoords as any)(...args),
            resolvePlaceCoords: (...args) => (this.resolvePlaceCoords as any)(...args),
            calculateTravelTimeWithCoords: (...args) => (this.calculateTravelTimeWithCoords as any)(...args),
            calculateProjectedArrivalToRouteDestination: (...args) => (this.calculateProjectedArrivalToRouteDestination as any)(...args),
            logHotspotCandidateEvaluation: (...args) => (this.logHotspotCandidateEvaluation as any)(...args),
          });
          if (!travelProjection) continue;
          currentCoords = travelProjection.currentCoords;
          distanceCalcCount = travelProjection.distanceCalcCount;
          let {
            travelTimeToHotspot,
            travelDurationSeconds,
            currentTimeSeconds,
            hotspotDurationSeconds,
            absoluteVisitStartSeconds,
            absoluteVisitEndSeconds,
            timeAfterTravel,
            timeAfterSightseeing,
            projectedArrivalSeconds,
            travelToDestSeconds,
          } = travelProjection;

          // Get day of week for operating hours check
          const jsDay = route.itinerary_route_date ? new Date(route.itinerary_route_date).getDay() : 0;
          const dayOfWeek = (jsDay + 6) % 7;
          const timingSummary = this.getTimingWindowSummary(
            timingMap,
            sh.hotspot_ID,
            dayOfWeek,
          );

          // ⚠️ CRITICAL: Pass ABSOLUTE seconds to operating hours check, not wrapped times
          // Check operating hours (using pre-fetched timing map)
          operatingHoursCount++;
          let operatingCheck = this.checkHotspotOperatingHoursFromMap(
            timingMap,
            sh.hotspot_ID,
            dayOfWeek,
            absoluteVisitStartSeconds,
            absoluteVisitEndSeconds,
          );
          let openingWindowStartSeconds: number | null = null;

          // If hotspot opens later today, wait and schedule in the opening window only
          // for wait-friendly hotspot types.
          if (
            !operatingCheck.canVisitNow &&
            operatingCheck.nextWindowStart &&
            this.shouldAllowWaitUntilOpenForCandidate(Number((sh as any).hotspot_priority ?? 0), hotspotType)
          ) {
            let nextWindowStartSeconds = timeToSeconds(operatingCheck.nextWindowStart);
            while (nextWindowStartSeconds < absoluteVisitStartSeconds) {
              nextWindowStartSeconds += 86400;
            }

            const waitedVisitEndSeconds = nextWindowStartSeconds + hotspotDurationSeconds;
            if (waitedVisitEndSeconds <= routeEndSeconds) {
              const waitedCheck = this.checkHotspotOperatingHoursFromMap(
                timingMap,
                sh.hotspot_ID,
                dayOfWeek,
                nextWindowStartSeconds,
                waitedVisitEndSeconds,
              );

              if (waitedCheck.canVisitNow) {
                absoluteVisitStartSeconds = nextWindowStartSeconds;
                absoluteVisitEndSeconds = waitedVisitEndSeconds;
                openingWindowStartSeconds = nextWindowStartSeconds;
                timeAfterTravel = secondsToTime(wrapToDay(absoluteVisitStartSeconds));
                timeAfterSightseeing = secondsToTime(wrapToDay(absoluteVisitEndSeconds));
                operatingCheck = { canVisitNow: true, nextWindowStart: null, isClosedForDay: false };
              }
            }
          }


          if (!operatingCheck.canVisitNow) {
            // No operating hours available - skip
            this.logHotspotCandidateEvaluation({
              routeId: route.itinerary_route_ID,
              hotspotId: Number(sh.hotspot_ID || 0),
              name: String(hotspotData.hotspot_location || `hotspot_${Number(sh.hotspot_ID || 0)}`),
              matchedBucket: (sh as any).matched_bucket ?? null,
              priority: Number((sh as any).hotspot_priority ?? 0),
              isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
              distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                ? Number((sh as any).hotspot_distance)
                : null,
              openingTime: timingSummary.openingTime,
              closingTime: timingSummary.closingTime,
              visitTime: `${timeAfterTravel} - ${timeAfterSightseeing}`,
                isOpenAtVisitTime: false,
                selected: false,
                rejectedReasons: [
                  operatingCheck.isClosedForDay
                    ? 'Rejected: closed on this day'
                    : (
                        !this.shouldAllowWaitUntilOpenForCandidate(Number((sh as any).hotspot_priority ?? 0), hotspotType)
                          ? `Rejected: wait-to-open disabled for priority ${Number((sh as any).hotspot_priority ?? 0)} hotspot`
                          : operatingCheck.nextWindowStart
                            ? `Rejected: outside operating hours and wait window does not fit (next opens at ${operatingCheck.nextWindowStart})`
                            : 'Rejected: outside operating hours'
                      ),
              ],
            });
            continue;
          }

          // Last-route guard: keep enough time after this hotspot to travel to departure terminal.
          if (isLastRoute) {
            const departureTargetName = String((plan.departure_location as string) || destinationCity || currentLocationName)
              .split('|')[0]
              .trim();
            const candidateCity = hotspotLocationName.split('|')[0].trim();
            const travelToDepartureType = this.getTravelLocationType(candidateCity, departureTargetName);
            const travelToDeparture = await this.distanceHelper.fromSourceAndDestination(
              tx,
              candidateCity,
              departureTargetName,
              travelToDepartureType,
              destCoords,
              destCityCoords,
            );
            const toDepartureSeconds =
              timeToSeconds(travelToDeparture.travelTime) +
              timeToSeconds(travelToDeparture.bufferTime);
            const projectedArrivalAtDeparture = absoluteVisitEndSeconds + toDepartureSeconds;

            if (projectedArrivalAtDeparture > lastRouteArrivalDeadlineSeconds) {
              this.logHotspotCandidateEvaluation({
                routeId: route.itinerary_route_ID,
                hotspotId: Number(sh.hotspot_ID || 0),
                name: String(hotspotData.hotspot_location || `hotspot_${Number(sh.hotspot_ID || 0)}`),
                matchedBucket: (sh as any).matched_bucket ?? null,
                priority: Number((sh as any).hotspot_priority ?? 0),
                isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
                distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                  ? Number((sh as any).hotspot_distance)
                  : null,
                openingTime: timingSummary.openingTime,
                closingTime: timingSummary.closingTime,
                visitTime: `${timeAfterTravel} - ${timeAfterSightseeing}`,
                isOpenAtVisitTime: false,
                selected: false,
                rejectedReasons: [
                  `Rejected: last-route transfer to departure would end at ${secondsToTime(wrapToDay(projectedArrivalAtDeparture))}, beyond arrival deadline ${secondsToTime(wrapToDay(lastRouteArrivalDeadlineSeconds))}`,
                ],
              });
              continue;
            }
          }

          if (
            rejectDuplicatePlanHotspot(sh.hotspot_ID, {
              routeId: Number(route.itinerary_route_ID || 0),
              routeDay: Number((route as any).no_of_days || routeIndex || 0),
              sourceCity,
              destinationCity,
              branch: 'day1_open_window_fill',
              hotspotName: String((hotspotData as any)?.hotspot_name || ''),
            })
          ) {
            continue;
          }

          const isEarlyArrivalHotelDeparture =
            (isHotelPreferenceEarlyArrival || isVehicleHotelRestEarlyArrival) &&
            lastAddedHotspotId === null;
          const currentOrder = order;
          let travelStartTime = currentTime;
          let travelStartSeconds = currentTimeSeconds;
          let alignedDepartureFromHotel = false;

          if (isEarlyArrivalHotelDeparture && openingWindowStartSeconds !== null) {
            const desiredDepartureSeconds = openingWindowStartSeconds - travelDurationSeconds;
            if (desiredDepartureSeconds > currentTimeSeconds) {
              travelStartSeconds = desiredDepartureSeconds;
              travelStartTime = secondsToTime(wrapToDay(desiredDepartureSeconds));
              alignedDepartureFromHotel = true;

              const hotelWaitSeconds = desiredDepartureSeconds - currentTimeSeconds;
              if (hotelWaitSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
                const hotelWaitRow = this.buildFreeTimeBreakRow({
                  planId,
                  routeId: route.itinerary_route_ID,
                  order: currentOrder,
                  startTime: currentTime,
                  endTime: travelStartTime,
                  userId: createdByUserId,
                });
                hotelWaitRow.via_location_name =
                  `Wait at ${currentLocationName} before ${hotspotLocationName} opens`;
                hotspotRows.push(hotelWaitRow);

                this.logBookingRule({
                  rule: 'EARLY_ARRIVAL_HOTEL_DEPARTURE_ALIGNED_TO_OPENING',
                  quoteId:
                    (plan as any).quote_id ??
                    (plan as any).quoteId ??
                    (plan as any).quote_ID ??
                    null,
                  planId,
                  routeId: route.itinerary_route_ID,
                  hotspotId: sh.hotspot_ID,
                  sourceLocationName: currentLocationName,
                  destinationLocationName: hotspotLocationName,
                  departureTime: travelStartTime,
                  arrivalTime: timeAfterTravel,
                  waitMinutes: Math.floor(hotelWaitSeconds / 60),
                });
              }
            }
          }

          // Add travel segment
          const travelLocationType = this.getTravelLocationType(currentLocationName, hotspotLocationName);

          if (
            suppressHotelInsertionUntilEndOfDay &&
            this.normalizeCityName(hotspotLocationName) === 'hotel'
          ) {
            this.logBookingRule({
              rule: 'HOTEL_SEGMENT_SUPPRESSED_IN_HOTSPOT_LOOP',
              quoteId:
                (plan as any).quote_id ??
                (plan as any).quoteId ??
                (plan as any).quote_ID ??
                null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: sh.hotspot_ID,
              hotspotLocationName,
              reason:
                'Arrival policy requires sightseeing first: suppress hotel insertion during hotspot scheduling.',
            });
            continue;
          }
          
          const { row: travelRow } = await this.travelBuilder.buildTravelSegment(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder,
            item_type: 3,
            travelLocationType,
            startTime: travelStartTime,
            userId: createdByUserId,
            sourceLocationName: currentLocationName,
            destinationLocationName: hotspotLocationName,
            hotspotId: sh.hotspot_ID,
            fromHotspotId: lastAddedHotspotId ?? undefined,
            sourceCoords: currentCoords,
            destCoords: destCoords,
          });

          hotspotRows.push(
            this.dataAccessService.normalizeTravelRowDistance(
              travelRow,
              currentLocationName,
              hotspotLocationName,
            ),
          );
          const travelArrivalTime = secondsToTime(wrapToDay(travelStartSeconds + travelDurationSeconds));
          const waitGapSeconds = alignedDepartureFromHotel
            ? 0
            : Math.max(0, timeToSeconds(timeAfterTravel) - timeToSeconds(travelArrivalTime));

          if (waitGapSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
            hotspotRows.push(
              this.buildFreeTimeBreakRow({
                planId,
                routeId: route.itinerary_route_ID,
                order: currentOrder,
                startTime: travelArrivalTime,
                endTime: timeAfterTravel,
                userId: createdByUserId,
              }),
            );

            this.logBookingRule({
              rule: 'FREE_TIME_INSERTED_WAITING_WINDOW',
              quoteId:
                (plan as any).quote_id ??
                (plan as any).quoteId ??
                (plan as any).quote_ID ??
                null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: sh.hotspot_ID,
              reason: 'No feasible hotspot during waiting window after travel; inserted explicit free-time segment.',
              gapStart: travelArrivalTime,
              gapEnd: timeAfterTravel,
              gapMinutes: Math.floor(waitGapSeconds / 60),
            });
          }

          // KEY FIX: Update currentTime to wrapped open-window start for builder compatibility
          currentTime = timeAfterTravel;
          currentLocationName = hotspotLocationName;
          currentCoords = destCoords;

          // Add hotspot segment
          const { row: hotspotRow } = await this.hotspotBuilder.build(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder,
            hotspotId: sh.hotspot_ID,
            startTime: timeAfterTravel,  // Use wrapped time for builder input
            userId: createdByUserId,
            totalAdult: plan.total_adult,
            totalChildren: plan.total_children,
            totalInfants: plan.total_infants,
            nationality: plan.nationality,
            itineraryPreference: plan.itinerary_preference,
            isConflict: false,
            conflictReason: '',
          });

          hotspotRows.push(hotspotRow);
          markHotspotAsPlanned(sh.hotspot_ID);
          lastAddedHotspotId = sh.hotspot_ID;
          order++;
          currentTime = timeAfterSightseeing;

          // Parking charges
          const parkingRowsForHotspot = await this.parkingBuilder.buildForHotspot(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: sh.hotspot_ID,
            userId: createdByUserId,
          });

          if (parkingRowsForHotspot && parkingRowsForHotspot.length > 0) {
            parkingRows.push(...parkingRowsForHotspot);
          }

          this.logHotspotCandidateEvaluation({
            routeId: route.itinerary_route_ID,
            hotspotId: Number(sh.hotspot_ID || 0),
            name: String(hotspotData.hotspot_location || `hotspot_${Number(sh.hotspot_ID || 0)}`),
            matchedBucket: (sh as any).matched_bucket ?? null,
            priority: Number((sh as any).hotspot_priority ?? 0),
            isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
            distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
              ? Number((sh as any).hotspot_distance)
              : null,
            openingTime: null,
            closingTime: null,
            visitTime: `${timeAfterTravel} - ${timeAfterSightseeing}`,
            isOpenAtVisitTime: true,
            selected: true,
            rejectedReasons: [],
          });
        }

        // Legacy Day-1 prepend gap-fill mutates existing row orders and is disabled by default.
        // Enable only for controlled rollback testing.
        const enableDay1LegacyPrependGapFill = process.env.ENABLE_DAY1_LEGACY_PREPEND_GAP_FILL === '1';

        // ✅ GAP-FILLING: Try to insert skipped hotspots into time gaps before first hotspot
        const skippedHotspots = selectedHotspots.filter(sh => !isHotspotAlreadyPlanned(sh.hotspot_ID));

        if (!enableDay1LegacyPrependGapFill && skippedHotspots.length > 0) {
          this.logBookingRule({
            rule: 'DAY1_LEGACY_PREPEND_GAP_FILL_DISABLED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            skippedCount: skippedHotspots.length,
            reason: 'Disabled by default to avoid in-place order mutation risks.',
          });
        }

        if (enableDay1LegacyPrependGapFill && skippedHotspots.length > 0) {
          // Find first added hotspot
          const firstHotspotRow = hotspotRows.find((r) =>
            Number((r as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) &&
            Number((r as any).item_type || 0) === 4,
          );
          
          if (firstHotspotRow) {
            const firstHotspotStartTime = TimeConverter.toTimeString(firstHotspotRow.hotspot_start_time);
            const firstHotspotStartSeconds = timeToSeconds(firstHotspotStartTime);
            
            // Find when route actually starts (after arrival)
            const arrivalRow = hotspotRows.find((r) =>
              Number((r as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) &&
              Number((r as any).item_type || 0) === 1,
            );
            const routeStartTime = arrivalRow ? TimeConverter.toTimeString(arrivalRow.hotspot_end_time) : currentTime;
            const routeStartSeconds = timeToSeconds(routeStartTime);
            
            const gapBeforeFirst = firstHotspotStartSeconds - routeStartSeconds;
            
            // Try to fit skipped hotspots in this gap
            for (const sh of skippedHotspots) {
              const hotspotData = await tx.dvi_hotspot_place.findUnique({
                where: { hotspot_ID: sh.hotspot_ID },
                select: {
                  hotspot_location: true,
                  hotspot_latitude: true,
                  hotspot_longitude: true,
                  hotspot_duration: true,
                },
              });
              
              if (!hotspotData) continue;
              
              const hotspotLocationName = hotspotData.hotspot_location as string;
              const hotspotDuration = hotspotData.hotspot_duration || '01:00:00';
              const hotspotDurationSeconds = timeToSeconds(hotspotDuration);
              const destCoords = {
                lat: Number(hotspotData.hotspot_latitude ?? 0),
                lon: Number(hotspotData.hotspot_longitude ?? 0),
              };
              
              // Calculate travel from current location to this hotspot
              const travelToHotspot = await this.calculateTravelTimeWithCoords(
                tx,
                currentLocationName,
                hotspotLocationName,
                currentCoords,
                destCoords,
              );
              
              const travelSeconds = timeToSeconds(travelToHotspot);
              const totalNeeded = travelSeconds + hotspotDurationSeconds;
              
              // Check if it fits in the gap (leave buffer for travel to next hotspot)
              if (totalNeeded <= gapBeforeFirst - 1800) {
                // Check if adding it still allows reaching destination by 10 PM
                const visitEndTime = addSeconds(routeStartTime, totalNeeded);
                
                const parsedHotspotLocation = hotspotLocationName.split('|')[0].trim();
                const rawDestination = (route.next_visiting_location as string) || currentLocationName;
                const destinationCity = rawDestination.split('|')[0].trim();
                
                const travelToDestResult = await this.distanceHelper.fromSourceAndDestination(
                  tx,
                  parsedHotspotLocation,
                  destinationCity,
                  2,
                  destCoords,
                  destCityCoords,
                );
                
                const travelToDestSeconds = timeToSeconds(travelToDestResult.travelTime);
                
                // Use route's configured end time
                const projectedArrivalSeconds = timeToSeconds(visitEndTime) + travelToDestSeconds;
                
                if (projectedArrivalSeconds <= routeEndSeconds) {
                  if (
                    rejectDuplicatePlanHotspot(sh.hotspot_ID, {
                      routeId: Number(route.itinerary_route_ID || 0),
                      routeDay: Number((route as any).no_of_days || routeIndex || 0),
                      sourceCity,
                      destinationCity,
                      branch: 'legacy_prepend_gap_fill',
                      hotspotName: String((hotspotData as any)?.hotspot_name || ''),
                    })
                  ) {
                    continue;
                  }

                  // It fits! Insert it before first hotspot
                  const insertOrder = Math.max(1, Number(firstHotspotRow.hotspot_order || 1));
                  for (const row of hotspotRows as Array<any>) {
                    if (Number((row as any).itinerary_route_ID || 0) !== Number(route.itinerary_route_ID || 0)) continue;
                    const rowOrder = Number((row as any).hotspot_order || 0);
                    if (rowOrder >= insertOrder) {
                      (row as any).hotspot_order = rowOrder + 1;
                    }
                  }
                  
                  // Add travel segment
                  const travelLocationType = this.getTravelLocationType(currentLocationName, hotspotLocationName);
                  const { row: travelRow } = await this.travelBuilder.buildTravelSegment(tx, {
                    planId,
                    routeId: route.itinerary_route_ID,
                    order: insertOrder,
                    item_type: 3,
                    travelLocationType,
                    startTime: routeStartTime,
                    userId: createdByUserId,
                    sourceLocationName: currentLocationName,
                    destinationLocationName: hotspotLocationName,
                    hotspotId: sh.hotspot_ID,
                    fromHotspotId: lastAddedHotspotId ?? undefined,
                    sourceCoords: currentCoords,
                    destCoords: destCoords,
                  });
                  
                  hotspotRows.push(
                    this.dataAccessService.normalizeTravelRowDistance(
                      travelRow,
                      currentLocationName,
                      hotspotLocationName,
                    ),
                  );
                  
                  // Add hotspot segment
                  const visitStartTime = addSeconds(routeStartTime, travelSeconds);
                  const { row: hotspotRow } = await this.hotspotBuilder.build(tx, {
                    planId,
                    routeId: route.itinerary_route_ID,
                    order: insertOrder,
                    hotspotId: sh.hotspot_ID,
                    startTime: visitStartTime,
                    userId: createdByUserId,
                    totalAdult: plan.total_adult,
                    totalChildren: plan.total_children,
                    totalInfants: plan.total_infants,
                    nationality: plan.nationality,
                    itineraryPreference: plan.itinerary_preference,
                  });
                  
                  hotspotRows.push(hotspotRow);
                  markHotspotAsPlanned(sh.hotspot_ID);
                  lastAddedHotspotId = sh.hotspot_ID; // Update for next hotspot-to-hotspot travel segment
                  
                  // Add parking
                  const parkingRowsForHotspot = await this.parkingBuilder.buildForHotspot(tx, {
                    planId,
                    routeId: route.itinerary_route_ID,
                    hotspotId: sh.hotspot_ID,
                    userId: createdByUserId,
                  });
                  
                  if (parkingRowsForHotspot && parkingRowsForHotspot.length > 0) {
                    parkingRows.push(...parkingRowsForHotspot);
                  }
                  
                  // ✅ Update the first hotspot's segments to start AFTER the gap-filled hotspot
                  const visitEndTime = addSeconds(visitStartTime, hotspotDurationSeconds);
                  
                  // Find travel and visit segments for first hotspot (same order)
                  const firstHotspotTravelRow = hotspotRows.find((r: any) =>
                    Number((r as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) &&
                    Number((r as any).item_type || 0) === 3 &&
                    Number((r as any).hotspot_order || 0) === Number(firstHotspotRow.hotspot_order || 0) + 1,
                  );
                  
                  if (firstHotspotTravelRow && firstHotspotRow) {
                    // Get first hotspot data for recalculating travel
                    const firstHotspotData = await tx.dvi_hotspot_place.findUnique({
                      where: { hotspot_ID: firstHotspotRow.hotspot_ID },
                      select: { hotspot_location: true, hotspot_latitude: true, hotspot_longitude: true },
                    });
                    
                    if (firstHotspotData) {
                      const firstHotspotLocation = firstHotspotData.hotspot_location as string;
                      const firstHotspotCoords = {
                        lat: Number(firstHotspotData.hotspot_latitude ?? 0),
                        lon: Number(firstHotspotData.hotspot_longitude ?? 0),
                      };
                      
                      // Calculate travel from gap-filled hotspot to first hotspot
                      const travelToFirst = await this.calculateTravelTimeWithCoords(
                        tx,
                        hotspotLocationName,
                        firstHotspotLocation,
                        destCoords,
                        firstHotspotCoords,
                      );
                      
                      const travelToFirstSeconds = timeToSeconds(travelToFirst);
                      const travelEndTime = addSeconds(visitEndTime, travelToFirstSeconds);
                      
                      // Update travel segment times
                      firstHotspotTravelRow.hotspot_start_time = TimeConverter.toDate(visitEndTime);
                      firstHotspotTravelRow.hotspot_end_time = TimeConverter.toDate(travelEndTime);
                      
                      // Update first hotspot visit start time
                      firstHotspotRow.hotspot_start_time = TimeConverter.toDate(travelEndTime);
                      // End time stays as it is (will be waiting time until opening)
                    }
                  }
                  
                  break; // Only insert one hotspot to avoid complexity
                } else {
                }
              } else {
              }
            }
          }
        }
        
      } else {
        // OTHER DAYS: Multi-pass scheduling with deferred hotspots
        this.logTimeline('[TIMELINE] Day 1 loop stats - Queries:', hotspotQueryCount, '| Distance calcs:', distanceCalcCount, '| Operating hours:', operatingHoursCount, '| Time:', Date.now() - routeLoopStart, 'ms');

        const getCandidateBucket = (hs: any): string =>
          String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase();

        const getCandidatePriority = (hs: any): number =>
          Number(hs?.hotspot_priority ?? 0);

        const isSourcePhaseBucket = (hs: any): boolean => {
          const bucket = getCandidateBucket(hs);
          return bucket === 'source' || bucket === 'source_fallback';
        };

        const isConfiguredPriority = (priority: number): boolean => {
          return priority >= 1 && priority < 9999;
        };

        const routeSourceKeyForPhase = this.canonicalCityKey(
          String(sourceCity || currentLocationName || route.location_name || ''),
        );

        const routeDestinationKeyForPhase = this.canonicalCityKey(
          String(destinationCity || route.next_visiting_location || ''),
        );

        const directToNextForPhase = Number((route as any).direct_to_next_visiting_place || 0);

        const phaseViaRows =
          (await (tx as any).dvi_itinerary_via_route_details?.findMany({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: route.itinerary_route_ID,
              deleted: 0,
              status: 1,
            },
          })) || [];

        const phaseViaLocationNames = phaseViaRows
          .map((viaRoute: any) =>
            String(
              viaRoute?.itinerary_via_location_name ??
                viaRoute?.via_route_name ??
                '',
            ).trim(),
          )
          .filter(Boolean);

        const routeLegsForPhase = this.buildRouteLegs(
          sourceCity || currentLocationName || route.location_name || '',
          phaseViaLocationNames,
          destinationCity || route.next_visiting_location || '',
        );

        const hasExplicitViaRouteForPhase = phaseViaLocationNames.length > 0;

        const isIntercityRoute =
          routeSourceKeyForPhase !== '' &&
          routeDestinationKeyForPhase !== '' &&
          routeSourceKeyForPhase !== routeDestinationKeyForPhase;
        const isIntercityDirectRoute =
          isIntercityRoute &&
          directToNextForPhase === 1 &&
          !hasExplicitViaRouteForPhase;
        const isIntercityNonDirectRoute =
          isIntercityRoute &&
          (directToNextForPhase !== 1 || hasExplicitViaRouteForPhase);
        const shouldBypassSourcePhaseForViaTransfer =
          isIntercityRoute && hasExplicitViaRouteForPhase;
        const shouldBypassSourcePhaseForMovementTransfer =
          isIntercityRoute &&
          (hasExplicitViaRouteForPhase || directToNextForPhase === 1);

        const candidateKey = (hs: any): string =>
          `${Number(hs?.hotspot_ID || 0)}:${getCandidateBucket(hs)}`;

        const normalizeSchedulerBucketsForRoute = (
          input: Array<SelectedHotspot>,
        ): Array<SelectedHotspot> => {
          const proofRows: Array<any> = [];
          const normalized = (input || []).map((hs: any) => {
            const hotspotId = Number(hs?.hotspot_ID || 0);
            const beforeBucket = String(hs?.matched_bucket || hs?.__bucket || 'unknown').toLowerCase();
            const master = (hotspotMap.get(hotspotId) as any) || hs || {};
            const masterLocation = String(master?.hotspot_location || '');
            const masterToLocation = String(master?.hotspot_to_location || masterLocation || '');

            let afterBucket = beforeBucket;
            let reason = 'preserved';

            const routeChainMatch = this.routeSpecificHotspotMatchesRouteChain(
              masterLocation,
              masterToLocation,
              routeLegsForPhase,
            );

            if (isIntercityRoute && routeChainMatch.matches) {
              afterBucket = 'en_route';
              reason = isIntercityDirectRoute
                ? 'scheduler_direct_route_chain_corridor_override'
                : 'scheduler_route_chain_corridor_override';
            }

            const next = {
              ...hs,
              matched_bucket: afterBucket,
              __bucket: afterBucket,
              __bucket_reason: reason,
              __route_chain_from_index:
                Number((hs as any)?.__route_chain_from_index ?? (routeChainMatch.matches ? routeChainMatch.fromIndex : -1)),
              __route_chain_to_index:
                Number((hs as any)?.__route_chain_to_index ?? (routeChainMatch.matches ? routeChainMatch.toIndex : -1)),
              __route_movement_order:
                Number(
                  (hs as any)?.__route_movement_order ??
                    (routeChainMatch.matches
                      ? this.routeMovementOrder(routeChainMatch.fromIndex, routeChainMatch.toIndex, 'en_route')
                      : 999999),
                ),
            };

            proofRows.push({
              hotspotId,
              beforeBucket,
              afterBucket,
              masterLocation,
              masterToLocation,
              reason,
            });

            return next as SelectedHotspot;
          });

          this.logBookingRule({
            rule: 'SCHEDULER_BUCKET_NORMALIZATION_PROOF',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            candidates: proofRows,
          });

          return normalized;
        };

        selectedHotspots = normalizeSchedulerBucketsForRoute(selectedHotspots as Array<SelectedHotspot>);
        const getMasterHotspot = (hotspotId: number): any => {
          return (hotspotMap.get(hotspotId) as any) || {};
        };
        if (isIntercityDirectRoute) {
          const destinationCityKeyForDirect = routeDestinationKeyForPhase;
          const explicitViaRouteExistsForThisRoute =
            String((route as any).via_route || '').trim() !== '' ||
            (Array.isArray((route as any).via_routes) && (route as any).via_routes.length > 0);

          selectedHotspots = (selectedHotspots as Array<SelectedHotspot>).filter((hs: any) => {
            const bucket = String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase();
            const hotspotId = Number(hs?.hotspot_ID || 0);
            const master = getMasterHotspot(hotspotId);
            const masterLocation = String(master?.hotspot_location || '');
            const masterToLocation = String(master?.hotspot_to_location || masterLocation || '');

            const isDestinationByBucket = bucket === 'destination' || bucket === 'dest';
            const masterLocationKey = this.canonicalCityKey(masterLocation);
            const masterToLocationKey = this.canonicalCityKey(masterToLocation);
            const isRouteSpecificMaster =
              masterLocationKey !== '' &&
              masterToLocationKey !== '' &&
              masterLocationKey !== masterToLocationKey;
            const routeChainMatchForDirect = this.routeSpecificHotspotMatchesRouteChain(
              masterLocation,
              masterToLocation,
              routeLegsForPhase,
            );
            const isDirectRouteCorridorHotspot =
              isRouteSpecificMaster && routeChainMatchForDirect.matches;
            const isDestinationByLocation =
              this.hotspotLocationMatchesCity(masterLocation, destinationCityKeyForDirect) ||
              (!isRouteSpecificMaster &&
                this.hotspotLocationMatchesCity(masterToLocation, destinationCityKeyForDirect));
            const isViaBucket = bucket === 'via';

            if (isDirectRouteCorridorHotspot) {
              return true;
            }

            if (isDestinationByBucket || isDestinationByLocation) {
              return true;
            }
            if (isViaBucket && explicitViaRouteExistsForThisRoute) return true;

            this.logBookingRule({
              rule: 'DIRECT_ROUTE_NON_DESTINATION_BLOCKED',
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              hotspotName: String(master?.hotspot_name || ''),
              bucket,
              masterLocation,
              masterToLocation,
              isRouteSpecificMaster,
              routeChainMatchForDirect,
              isDirectRouteCorridorHotspot,
              destinationCity: routeDestinationKeyForPhase,
              reason: 'Direct route keeps only destination hotspots or explicit via hotspots',
            });

            return false;
          });
        }
        const isCorridorMasterHotspot = (hotspotId: number): boolean => {
          const master = getMasterHotspot(hotspotId);
          const masterLocationKey = this.canonicalCityKey(String(master?.hotspot_location || ''));
          const masterToLocationKey = this.canonicalCityKey(String(master?.hotspot_to_location || ''));

          return (
            !!masterLocationKey &&
            !!masterToLocationKey &&
            masterLocationKey !== masterToLocationKey
          );
        };
        const corridorBelongsToCurrentRoute = (hotspotId: number): boolean => {
          const master = getMasterHotspot(hotspotId);
          return this.routeSpecificHotspotMatchesRouteChain(
            String(master?.hotspot_location || ''),
            String(master?.hotspot_to_location || master?.hotspot_location || ''),
            routeLegsForPhase,
          ).matches;
        };
        selectedHotspots = (selectedHotspots as Array<SelectedHotspot>).filter((hs: any) => {
          const hotspotId = Number(hs?.hotspot_ID || 0);
          if (isCorridorMasterHotspot(hotspotId) && !corridorBelongsToCurrentRoute(hotspotId)) {
            this.logBookingRule({
              rule: 'CORRIDOR_HOTSPOT_WRONG_ROUTE_BLOCKED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              hotspotName: String(getMasterHotspot(hotspotId)?.hotspot_name || ''),
              sourceCity,
              destinationCity,
              masterLocation: String(getMasterHotspot(hotspotId)?.hotspot_location || ''),
              masterToLocation: String(getMasterHotspot(hotspotId)?.hotspot_to_location || ''),
              reason: 'corridor_hotspot_not_owned_by_current_route',
            });
            return false;
          }
          return true;
        });

        const strictHotspots = (selectedHotspots as Array<SelectedHotspot>).filter((hs: any) => {
          const priority = getCandidatePriority(hs);
          const bucket = String((hs as any).matched_bucket || (hs as any).__bucket || '').toLowerCase();
          const isExplicitViaStop = Boolean((hs as any).__explicit_via_stop);

          if (priority >= 1 && priority <= 3) {
            return true;
          }
          if (
            isIntercityNonDirectRoute &&
            hasExplicitViaRouteForPhase &&
            isExplicitViaStop &&
            bucket === 'via'
          ) {
            return true;
          }
          if (
            isIntercityRoute &&
            (bucket === 'en_route' || bucket === 'source_to_destination') &&
            corridorBelongsToCurrentRoute(Number(hs?.hotspot_ID || 0))
          ) {
            return true;
          }

          if (
            isIntercityNonDirectRoute &&
            isSourcePhaseBucket(hs) &&
            isConfiguredPriority(priority)
          ) {
            return true;
          }

          return false;
        });

        const strictCandidateKeys = new Set(
          strictHotspots.map((hs: any) => candidateKey(hs)),
        );

        let fillerHotspots = (selectedHotspots as Array<SelectedHotspot>).filter((hs: any) => {
          return !strictCandidateKeys.has(candidateKey(hs));
        });
        const isCorridorBucket = (hs: any): boolean => {
          const bucket = String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase();
          return bucket === 'en_route' || bucket === 'source_to_destination';
        };
        const getCorridorPriorityRank = (hs: any): number => {
          const priority = Number(hs?.hotspot_priority ?? 0);
          if (priority >= 1 && priority < 9999) return priority;
          return 9999;
        };
        const corridorHotspots = (selectedHotspots as Array<SelectedHotspot>)
          .filter((hs: any) => isCorridorBucket(hs))
          .sort((a: any, b: any) => {
            const priorityDiff = getCorridorPriorityRank(a) - getCorridorPriorityRank(b);
            if (priorityDiff !== 0) return priorityDiff;
            const distanceDiff = Number(a?.hotspot_distance ?? 999999) - Number(b?.hotspot_distance ?? 999999);
            if (distanceDiff !== 0) return distanceDiff;
            return Number(a?.hotspot_ID ?? 0) - Number(b?.hotspot_ID ?? 0);
          });
        const positiveCorridorHotspots = corridorHotspots.filter((hs: any) => {
          const priority = Number(hs?.hotspot_priority ?? 0);
          return priority >= 1 && priority < 9999;
        });
        const optionalCorridorHotspots = corridorHotspots.filter((hs: any) => {
          const priority = Number(hs?.hotspot_priority ?? 0);
          return priority <= 0 || priority >= 9999;
        });
        const getPendingPositiveCorridorHotspots = (): Array<SelectedHotspot> => {
          return positiveCorridorHotspots.filter((hs: any) => {
            const id = Number(hs?.hotspot_ID || 0);
            return id > 0 && !isHotspotAlreadyPlanned(id);
          });
        };
        const getPendingOptionalCorridorHotspots = (): Array<SelectedHotspot> => {
          return optionalCorridorHotspots.filter((hs: any) => {
            const id = Number(hs?.hotspot_ID || 0);
            return id > 0 && !isHotspotAlreadyPlanned(id);
          });
        };
        this.logBookingRule({
          rule: 'CORRIDOR_PRIORITY_QUEUE_PROOF',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          sourceCity: String(sourceCity || ''),
          destinationCity: String(destinationCity || ''),
          corridorCandidates: corridorHotspots.map((hs: any) => {
            const id = Number(hs?.hotspot_ID || 0);
            const master = hotspotMap.get(id) as any;
            return {
              hotspotId: id,
              name: String(master?.hotspot_name || hs?.hotspot_name || ''),
              bucket: String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase(),
              priority: Number(hs?.hotspot_priority ?? 0),
              corridorPriorityRank: getCorridorPriorityRank(hs),
              distance: Number(hs?.hotspot_distance ?? 999999),
            };
          }),
        });
        this.logBookingRule({
          rule: 'VALARA_CHEEYAPPARA_POOL_PROOF',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          sourceCity: String(sourceCity || ''),
          destinationCity: String(destinationCity || ''),
          selected: (selectedHotspots as Array<SelectedHotspot>)
            .filter((hs: any) => [228, 357].includes(Number(hs?.hotspot_ID || 0)))
            .map((hs: any) => {
              const hotspotId = Number(hs?.hotspot_ID || 0);
              const master = hotspotMap.get(hotspotId) as any;
              return {
                hotspotId,
                name: String(master?.hotspot_name || hs?.hotspot_name || ''),
                bucket: String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase(),
                priority: Number(hs?.hotspot_priority ?? 0),
                inStrictHotspots: strictHotspots.some((s: any) => Number(s?.hotspot_ID || 0) === hotspotId),
                inFillerHotspots: fillerHotspots.some((s: any) => Number(s?.hotspot_ID || 0) === hotspotId),
                inCorridorHotspots: corridorHotspots.some((s: any) => Number(s?.hotspot_ID || 0) === hotspotId),
                corridorRank: getCorridorPriorityRank(hs),
                masterLocation: String(master?.hotspot_location || ''),
                masterToLocation: String(master?.hotspot_to_location || ''),
                alreadyAdded: isHotspotAlreadyPlanned(hotspotId),
              };
            }),
        });

        let strictPassHotspots = [...strictHotspots];
        const sourcePhaseEndSeconds = timeToSeconds('12:00:00');
        if (isIntercityNonDirectRoute) {
          const destinationStrict = strictPassHotspots.filter((hs) => {
            const bucket = String((hs as any).matched_bucket || '').toLowerCase();
            return bucket === 'destination' || bucket === 'dest';
          });
          const nonDestinationStrict = strictPassHotspots.filter((hs) => {
            const bucket = String((hs as any).matched_bucket || '').toLowerCase();
            return !(bucket === 'destination' || bucket === 'dest');
          });

          if (nonDestinationStrict.length > 0 || destinationStrict.length > 0) {
            const viaStrict = strictPassHotspots.filter((hs) => {
              const bucket = String((hs as any).matched_bucket || '').toLowerCase();
              return bucket === 'via';
            });

            const sourceStrict = strictPassHotspots.filter((hs) => {
              const bucket = String((hs as any).matched_bucket || '').toLowerCase();
              return bucket === 'source' || bucket === 'source_fallback';
            });
            const enRouteStrict = strictPassHotspots.filter((hs) => {
              const bucket = String((hs as any).matched_bucket || '').toLowerCase();
              return bucket === 'en_route' || bucket === 'source_to_destination';
            });

            const destinationOnlyStrict = strictPassHotspots.filter((hs) => {
              const bucket = String((hs as any).matched_bucket || '').toLowerCase();
              return bucket === 'destination' || bucket === 'dest';
            });

            const compareSchedulerRouteMovementCandidates = (a: any, b: any) => {
              const ao = Number(a.__route_movement_order ?? 999999);
              const bo = Number(b.__route_movement_order ?? 999999);
              if (ao !== bo) return ao - bo;

              const ap = Number(a.hotspot_priority ?? 0);
              const bp = Number(b.hotspot_priority ?? 0);
              const ar = ap > 0 ? ap : 9999;
              const br = bp > 0 ? bp : 9999;
              if (ar !== br) return ar - br;

              const ad = Number(a.hotspot_distance ?? 999999);
              const bd = Number(b.hotspot_distance ?? 999999);
              if (ad !== bd) return ad - bd;

              return Number(a.hotspot_ID ?? 0) - Number(b.hotspot_ID ?? 0);
            };

            const routeMovementStrict = [
              ...enRouteStrict,
              ...viaStrict,
            ].sort(compareSchedulerRouteMovementCandidates);

            if (isIntercityDirectRoute) {
              strictPassHotspots = [
                ...routeMovementStrict,
                ...destinationOnlyStrict,
              ];
            } else {
              strictPassHotspots = isIntercityNonDirectRoute
                ? shouldBypassSourcePhaseForViaTransfer
                  ? [
                      ...routeMovementStrict,
                      ...destinationOnlyStrict,
                    ]
                  : [
                      ...sourceStrict,
                      ...routeMovementStrict,
                      ...destinationOnlyStrict,
                    ]
                : [
                    ...viaStrict,
                    ...sourceStrict,
                    ...destinationOnlyStrict,
                  ];
            }

            console.log('[HOTSPOT ORDER FIX]', {
              routeId: route.itinerary_route_ID,
              via: viaStrict.map((x: any) => ({
                id: x.hotspot_ID,
                name: x.hotspot_name,
                priority: x.hotspot_priority,
              })),
              source: sourceStrict.map((x: any) => ({
                id: x.hotspot_ID,
                name: x.hotspot_name,
                priority: x.hotspot_priority,
              })),
              destination: destinationOnlyStrict.map((x: any) => ({
                id: x.hotspot_ID,
                name: x.hotspot_name,
                priority: x.hotspot_priority,
              })),
              reason: shouldBypassSourcePhaseForMovementTransfer
                ? 'Explicit via or direct destination route: source sightseeing is suppressed; route movement is processed first.'
                : 'Intercity non-direct route without explicit via: source/corridor/destination order preserved.',
            });
            this.logBookingRule({
              rule: 'STRICT_PHASE_ORDER_DEBUG',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              sourceIds: sourceStrict.map((x: any) => Number(x.hotspot_ID || 0)),
              enRouteIds: enRouteStrict.map((x: any) => Number(x.hotspot_ID || 0)),
              viaIds: viaStrict.map((x: any) => Number(x.hotspot_ID || 0)),
              destinationIds: destinationOnlyStrict.map((x: any) => Number(x.hotspot_ID || 0)),
              finalOrder: strictPassHotspots.map((x: any) => ({
                id: Number(x.hotspot_ID || 0),
                bucket: String((x as any).matched_bucket || '').toLowerCase(),
              })),
            });
            this.logBookingRule({
              rule: 'CORRIDOR_PHASE_STARTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              sourceIds: sourceStrict.map((x: any) => Number(x.hotspot_ID || 0)),
              corridorIds: enRouteStrict.map((x: any) => Number(x.hotspot_ID || 0)),
            });
          }
        }
        
        const PASS_STRICT = 1;
        const PASS_FILLER_PRIMARY = 2;
        const PASS_DEFERRED_PRIMARY = 3;
        const PASS_REJECTED_RETRY = 4;
        const PASS_FILLER_SECONDARY = 5;
        const PASS_DEFERRED_SECONDARY = 6;
        const maxPasses = PASS_DEFERRED_SECONDARY;
        let pass = 1;
        let addedInLastPass = true;
        const deferredPriorityHotspots: SelectedHotspot[] = [];
        const deferredPriorityHotspotIds = new Set<number>();
        const rejectedRetryHotspots: SelectedHotspot[] = [];
        const rejectedRetryHotspotIds = new Set<number>();
        const resolvedPositiveCorridorIds = new Set<number>();
        const sourceCutoffRejectedHotspotIds = new Set<number>();
        const strictHotspotIdSet = new Set<number>(
          strictHotspots
            .map((hs) => Number((hs as any).hotspot_ID || 0))
            .filter((id) => id > 0),
        );
        const protectedStrictSlots: ProtectedStrictSlot[] = [];
        const enableProtectedStrictSlots = isLoopbackRoute;
        let optimizationCycle = 1;
        let mustVisitRepairAttempts = 0;
        let previousCycleStateHash = '';
        let enRoutePhaseStarted = false;
        // Cycle 4 relaxed-fill currently remains intentionally scoped to same-city routes.
        const isCycle4GapFillRoute =
          this.isSameCity(String(sourceCity || currentLocationName), String(destinationCity || route.next_visiting_location || currentLocationName));

        const previousDaySameCityHotspotIds = sameCityContinuationContextForRoute.previousDayHotspotIds;

        const buildRemainingGapIntervals = () => {
          const anchors = this.buildFixedTimelineAnchors(
            hotspotRows,
            Number((route as any).itinerary_route_ID || 0),
            routeStartSeconds,
            routeEndSeconds,
            currentTime,
          );
          const gaps = this.buildRealGapIntervals(anchors);
          if (gaps.length > 0) {
            this.logBookingRule({
              rule: 'GAP_INTERVAL_BUILT',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              intervalCount: gaps.length,
              intervals: gaps.slice(0, 12),
            });
            return gaps;
          }

          let currentSeconds = timeToSeconds(currentTime);
          if (currentSeconds < routeStartSeconds) currentSeconds += 86400;
          const remainingSeconds = Math.max(0, routeEndSeconds - currentSeconds);
          return [{ start: currentSeconds, end: routeEndSeconds, durationSeconds: remainingSeconds }];
        };

        const buildSchedulingStateHash = () => {
          const scheduled = selectedHotspots
            .map((hs) => Number((hs as any).hotspot_ID || 0))
            .filter((id) => id > 0 && isHotspotAlreadyPlanned(id))
            .sort((a, b) => a - b)
            .join(',');
          const deferred = Array.from(deferredPriorityHotspotIds.values()).sort((a, b) => a - b).join(',');
          const retried = Array.from(rejectedRetryHotspotIds.values()).sort((a, b) => a - b).join(',');
          return `${scheduled}|${deferred}|${retried}|${currentTime}`;
        };
        const traceHotspot241 = (reason: string, extra: Record<string, unknown> = {}) => {
          if (!this.verboseTimelineProofLogs) return;
          this.logBookingRule({
            rule: 'HOTSPOT_241_TRACE',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: 241,
            reason,
            ...extra,
          });
        };
        const isSourcePhaseEligibleCandidate = (hs: any): boolean => {
          const bucket = String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase();
          const hotspotId = Number(hs?.hotspot_ID || 0);
          const master = hotspotMap.get(hotspotId) as any;

          const hotspotLocation = String(
            hs?.hotspot_location ||
              master?.hotspot_location ||
              '',
          );

          const hotspotToLocation = String(
            hs?.hotspot_to_location ||
              master?.hotspot_to_location ||
              hotspotLocation ||
              '',
          );

          if (bucket === 'source') return true;

          if (bucket === 'source_fallback') {
            return (
              this.hotspotLocationMatchesCity(hotspotLocation, sourceCity) ||
              this.hotspotLocationMatchesCity(hotspotToLocation, sourceCity)
            );
          }

          if (
            bucket === 'matrix' ||
            bucket === 'manual' ||
            bucket === '' ||
            bucket === 'unknown' ||
            bucket === 'carry_forward'
          ) {
            return (
              this.hotspotLocationMatchesCity(hotspotLocation, sourceCity) ||
              this.hotspotLocationMatchesCity(hotspotToLocation, sourceCity)
            );
          }

          return false;
        };
        const getPendingSourcePhaseCandidates = (
          candidates: Array<SelectedHotspot>,
        ): Array<SelectedHotspot> => {
          return (Array.isArray(candidates) ? candidates : []).filter((hs: any) => {
            const hotspotId = Number(hs?.hotspot_ID || 0);
            return (
              hotspotId > 0 &&
              !isHotspotAlreadyPlanned(hotspotId) &&
              isSourcePhaseEligibleCandidate(hs)
            );
          });
        };
        const logHotspotBucketTrace = (payload: {
          hotspotId: number;
          hotspotName: string | null;
          bucket: string;
          priority: number;
          currentTime: string;
          sourcePhaseActive: boolean;
          accepted: boolean;
          rejectionReason: string | null;
        }) => {
          this.logBookingRule({
            rule: 'HOTSPOT_BUCKET_TRACE',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            ...payload,
          });
        };

        const scoreFillerHotspot = (hs: SelectedHotspot): number => {
          const hotspotId = Number((hs as any).hotspot_ID || 0);
          const distanceKm = Number((hs as any).hotspot_distance ?? 9999);
          const priority = Number((hs as any).hotspot_priority ?? 0);
          const bucket = String((hs as any).matched_bucket || '').toLowerCase();
          const routeDay = route.itinerary_route_date ? new Date(route.itinerary_route_date).getDay() : 0;
          const dayOfWeek = (routeDay + 6) % 7;
          const timingSummary = this.getTimingWindowSummary(timingMap, hotspotId, dayOfWeek);
          const nowSecondsRaw = timeToSeconds(currentTime);
          let nowSeconds = nowSecondsRaw;
          if (nowSeconds < routeStartSeconds) nowSeconds += 86400;

          // Real gaps currently influence filler scoring and diagnostics only.
          const remainingIntervals = buildRemainingGapIntervals();
          const remainingGapSeconds = remainingIntervals.reduce((sum, g) => sum + Math.max(0, g.durationSeconds), 0);
          const openingSecs = timingSummary.openingTime ? timeToSeconds(timingSummary.openingTime) : null;
          let waitPenaltyMinutes = 0;
          if (openingSecs !== null) {
            let openingCandidate = openingSecs;
            while (openingCandidate < nowSeconds) openingCandidate += 86400;
            waitPenaltyMinutes = Math.max(0, Math.floor((openingCandidate - nowSeconds) / 60));
          }

          const bucketBias = bucket === 'destination' ? 18 : (bucket === 'via' ? 8 : 0);
          const distanceScore = Number.isFinite(distanceKm) ? Math.max(0, 60 - Math.floor(distanceKm)) : 0;
          const waitScore = Math.max(0, 80 - waitPenaltyMinutes);
          const windowFitScore = Math.min(50, Math.floor(remainingGapSeconds / 900));
          const desiredRank = desiredMovableOrderRank.get(hotspotId);
          const desiredMovableScore =
            desiredRank == null
              ? 0
              : Math.max(0, 5000 - (desiredRank * 250));
          const adjacencyScore = routePreferredAdjacencyPairs.some(([anchorId, movedId]) => {
            return movedId === hotspotId && routeDesiredMovableSet.has(anchorId);
          })
            ? 2000
            : 0;

          return (priority * 10) + bucketBias + distanceScore + waitScore + windowFitScore + desiredMovableScore + adjacencyScore;
        };
        const getPhaseRank = (bucketRaw: string): number => {
          const bucket = String(bucketRaw || '').toLowerCase();
          if (bucket === 'source' || bucket === 'source_fallback') return 1;
          if (bucket === 'en_route' || bucket === 'source_to_destination') return 2;
          if (bucket === 'via') return 3;
          if (bucket === 'destination' || bucket === 'dest') return 4;
          return 5;
        };

        const queueRejectedHotspotForRetry = (hotspot: SelectedHotspot, reason: string): boolean => {
          if (pass !== PASS_STRICT) return false;
          const hotspotId = Number(hotspot?.hotspot_ID || 0);
          if (hotspotId <= 0) return false;
          if (isHotspotAlreadyPlanned(hotspotId)) return false;
          if (deferredPriorityHotspotIds.has(hotspotId)) return false;
          if (rejectedRetryHotspotIds.has(hotspotId)) return false;

          rejectedRetryHotspots.push(hotspot);
          rejectedRetryHotspotIds.add(hotspotId);

          this.logBookingRule({
            rule: 'REJECTED_HOTSPOT_QUEUED_FOR_RETRY',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId,
            reason,
          });

          return true;
        };

        const runPreFillerDistanceOptimization = async (): Promise<boolean> => {
          if (fillerHotspots.length < 3) {
            return false;
          }

          const locationFor = (hs: SelectedHotspot): string => {
            const data = hotspotMap.get(Number((hs as any).hotspot_ID || 0));
            return String((data as any)?.hotspot_location || currentLocationName);
          };

          const coordsFor = (hs: SelectedHotspot): { lat: number; lon: number } | undefined => {
            const data = hotspotMap.get(Number((hs as any).hotspot_ID || 0));
            if (!data) return undefined;
            return {
              lat: Number((data as any).hotspot_latitude ?? 0),
              lon: Number((data as any).hotspot_longitude ?? 0),
            };
          };

          let moved = false;
          const maxSwaps = Math.min(4, fillerHotspots.length - 1);
          for (let i = 0; i < maxSwaps; i++) {
            const prev = i === 0 ? null : fillerHotspots[i - 1];
            const a = fillerHotspots[i];
            const b = fillerHotspots[i + 1];
            if (!a || !b) break;

            const aPriority = Number((a as any).hotspot_priority ?? 0);
            const bPriority = Number((b as any).hotspot_priority ?? 0);
            if (aPriority >= 1 || bPriority >= 1) continue;

            const prevLocation = prev ? locationFor(prev) : currentLocationName;
            const prevCoords = prev ? coordsFor(prev) : currentCoords;

            const aLocation = locationFor(a);
            const bLocation = locationFor(b);
            const aCoords = coordsFor(a);
            const bCoords = coordsFor(b);

            const [prevToA, aToB, prevToB, bToA] = await Promise.all([
              this.calculateTravelTimeWithCoords(tx, prevLocation, aLocation, prevCoords, aCoords),
              this.calculateTravelTimeWithCoords(tx, aLocation, bLocation, aCoords, bCoords),
              this.calculateTravelTimeWithCoords(tx, prevLocation, bLocation, prevCoords, bCoords),
              this.calculateTravelTimeWithCoords(tx, bLocation, aLocation, bCoords, aCoords),
            ]);

            const currentDelta = timeToSeconds(prevToA) + timeToSeconds(aToB);
            const swappedDelta = timeToSeconds(prevToB) + timeToSeconds(bToA);
            const gain = currentDelta - swappedDelta;

            if (gain > 0) {
              const tmp = fillerHotspots[i];
              fillerHotspots[i] = fillerHotspots[i + 1];
              fillerHotspots[i + 1] = tmp;
              moved = true;

              this.logBookingRule({
                rule: 'OPTIMIZATION_REORDER_ACCEPTED',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                cycle: optimizationCycle,
                reason: 'pre_filler_distance_optimization_improved',
                hotspotA: Number((a as any).hotspot_ID || 0),
                hotspotB: Number((b as any).hotspot_ID || 0),
                distanceGainSeconds: gain,
              });
            } else {
              this.logBookingRule({
                rule: 'OPTIMIZATION_REORDER_REJECTED',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                cycle: optimizationCycle,
                reason: 'pre_filler_distance_optimization_not_improved',
                hotspotA: Number((a as any).hotspot_ID || 0),
                hotspotB: Number((b as any).hotspot_ID || 0),
                distanceGainSeconds: gain,
              });
            }
          }

          return moved;
        };
        
        // PHP includeHotspotInItinerary parity:
        // no precomputed "latest allowed to still reach destination" cutoff.
        
        while (optimizationCycle <= MAX_SCHEDULER_OPTIMIZATION_CYCLES) {
          pass = 1;
          let addedInCurrentCycle = false;

          const cycleAllowedPasses: number[] =
            optimizationCycle === 1
              ? [PASS_STRICT]
              : optimizationCycle === 2
                ? [PASS_FILLER_PRIMARY]
                : optimizationCycle === 3
                  ? [PASS_DEFERRED_PRIMARY, PASS_REJECTED_RETRY, PASS_DEFERRED_SECONDARY]
                  : [];

          this.logBookingRule({
            rule: 'SCHEDULER_OPTIMIZATION_CYCLE_STARTED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            remainingIntervals: buildRemainingGapIntervals(),
            cycleAllowedPasses,
          });

          if (optimizationCycle === 2) {
            const pendingPositiveCorridorIds = getPendingPositiveCorridorHotspots().map((hs: any) => Number((hs as any).hotspot_ID || 0));
            this.logBookingRule({
              rule: 'PREFILLER_ENTRY_PROOF',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              pendingPositiveCorridorIds,
              addedHotspotIds: Array.from(addedHotspotIds.values()),
              willRunPreFiller: fillerHotspots.length >= 3,
            });
            if (pendingPositiveCorridorIds.length > 0) {
              this.logBookingRule({
                rule: 'PREFILLER_BLOCKED_CORRIDOR_PENDING',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                cycle: optimizationCycle,
                pendingPositiveCorridorIds,
                reason: 'positive_priority_corridor_pending',
              });
            } else {
              const reordered = await runPreFillerDistanceOptimization();
              addedInCurrentCycle = reordered;
            }
          }

          while (pass <= maxPasses) {
          if (!cycleAllowedPasses.includes(pass)) {
            pass++;
            continue;
          }
          addedInLastPass = false;
          const isFillerPass = pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY;
          let sortedFillerHotspots: Array<SelectedHotspot> = [];
          if (isFillerPass) {
            const scored = [...(fillerHotspots as Array<SelectedHotspot>)].map((hs) => ({
              hs,
              score: scoreFillerHotspot(hs),
            }));
            scored.sort((a, b) => {
              const aPriority = Number((a.hs as any).hotspot_priority ?? 0);
              const bPriority = Number((b.hs as any).hotspot_priority ?? 0);
              if (aPriority === 0 && bPriority === 0) {
                const aDistance = Number((a.hs as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
                const bDistance = Number((b.hs as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
                if (aDistance !== bDistance) return aDistance - bDistance;
              }

              if (b.score !== a.score) return b.score - a.score;

              const aDistance = Number((a.hs as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
              const bDistance = Number((b.hs as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
              if (aDistance !== bDistance) return aDistance - bDistance;

              return Number((a.hs as any).hotspot_ID ?? 0) - Number((b.hs as any).hotspot_ID ?? 0);
            });

            const preview = scored.slice(0, 5).map((x) => ({ hotspotId: Number((x.hs as any).hotspot_ID || 0), score: x.score }));
            if (preview.length > 0) {
              this.logBookingRule({
                rule: 'FILLER_SCORING_PREVIEW',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                cycle: optimizationCycle,
                pass,
                preview,
              });
            }

            sortedFillerHotspots = scored.map((x) => x.hs);
          }

          let hotspotsToTry =
            pass === PASS_STRICT
              ? (strictPassHotspots as Array<SelectedHotspot>)
              : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                ? sortedFillerHotspots
                  : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                    ? [...(deferredPriorityHotspots as Array<SelectedHotspot>)].sort((a, b) => {
                        const pa = Number((a as any).hotspot_priority ?? 0);
                        const pb = Number((b as any).hotspot_priority ?? 0);
                        if (pa !== pb) return pa - pb;
                        return Number((a as any).hotspot_distance ?? 9999) - Number((b as any).hotspot_distance ?? 9999);
                      })
                  : (rejectedRetryHotspots as Array<SelectedHotspot>);
          const pendingPositiveCorridorHotspots = getPendingPositiveCorridorHotspots();
          const pendingPositiveCorridorIds = pendingPositiveCorridorHotspots.map((hs: any) => Number(hs?.hotspot_ID || 0));
          if (
            isIntercityNonDirectRoute &&
            pendingPositiveCorridorIds.length > 0 &&
            (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY || pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY || pass === PASS_REJECTED_RETRY)
          ) {
            const blockedFillerIds = hotspotsToTry
              .filter((hs: any) => !pendingPositiveCorridorIds.includes(Number(hs?.hotspot_ID || 0)))
              .map((hs: any) => Number(hs?.hotspot_ID || 0))
              .filter((id) => id > 0);
            this.logBookingRule({
              rule: 'FILLER_BLOCKED_CORRIDOR_PENDING',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              pass,
              passType:
                pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY
                  ? 'filler'
                  : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                    ? 'deferred'
                    : 'retry',
              pendingPositiveCorridorIds,
              blockedFillerIds,
              reason: 'positive_priority_corridor_pending',
            });
            hotspotsToTry =
              pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY
                ? [...pendingPositiveCorridorHotspots, ...getPendingOptionalCorridorHotspots()]
                : pendingPositiveCorridorHotspots;
          }
          const pendingOptionalCorridorHotspots = getPendingOptionalCorridorHotspots();
          if (
            isIntercityNonDirectRoute &&
            pendingPositiveCorridorIds.length === 0 &&
            pendingOptionalCorridorHotspots.length > 0 &&
            (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
          ) {
            hotspotsToTry = pendingOptionalCorridorHotspots;
            this.logBookingRule({
              rule: 'OPTIONAL_CORRIDOR_FILLER_STARTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              pass,
              optionalCorridorIds: pendingOptionalCorridorHotspots.map((hs: any) => Number(hs?.hotspot_ID || 0)),
            });
          }
          if (
            isIntercityNonDirectRoute &&
            pass === PASS_STRICT &&
            !shouldBypassSourcePhaseForMovementTransfer
          ) {
            const currentSecs = timeToSeconds(currentTime);
            if (currentSecs < sourcePhaseEndSeconds) {
              const remainingStrictSourceCandidates = getPendingSourcePhaseCandidates(
                strictPassHotspots as Array<SelectedHotspot>,
              );
              const pendingFillerSourceCandidates = getPendingSourcePhaseCandidates(
                fillerHotspots as Array<SelectedHotspot>,
              );
              const pendingDeferredSourceCandidates = getPendingSourcePhaseCandidates(
                deferredPriorityHotspots as Array<SelectedHotspot>,
              );
              const pendingRetrySourceCandidates = getPendingSourcePhaseCandidates(
                rejectedRetryHotspots as Array<SelectedHotspot>,
              );

              const remainingSourceCandidates = [
                ...remainingStrictSourceCandidates,
                ...pendingFillerSourceCandidates,
                ...pendingDeferredSourceCandidates,
                ...pendingRetrySourceCandidates,
              ].filter((hs: any, idx: number, arr: any[]) => {
                const id = Number(hs?.hotspot_ID || 0);
                return id > 0 && arr.findIndex((x: any) => Number(x?.hotspot_ID || 0) === id) === idx;
              });

              if (remainingSourceCandidates.length > 0) {
                hotspotsToTry = remainingSourceCandidates;
                this.logBookingRule({
                  rule: 'SOURCE_PHASE_CLOCK_PRESERVED_FOR_NON_STRICT_SOURCE_CANDIDATES',
                  quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                  planId,
                  routeId: route.itinerary_route_ID,
                  cycle: optimizationCycle,
                  pass,
                  currentTime,
                  sourcePhaseEndTime: secondsToTime(sourcePhaseEndSeconds),
                  strictSourceCount: remainingStrictSourceCandidates.length,
                  fillerSourceCount: pendingFillerSourceCandidates.length,
                  deferredSourceCount: pendingDeferredSourceCandidates.length,
                  retrySourceCount: pendingRetrySourceCandidates.length,
                  preservedCandidateIds: remainingSourceCandidates.map((hs: any) => Number(hs?.hotspot_ID || 0)),
                });
              } else {
                currentTime = secondsToTime(sourcePhaseEndSeconds);
                hotspotsToTry = corridorHotspots.filter(
                  (hs: any) => !isHotspotAlreadyPlanned(Number(hs?.hotspot_ID || 0)),
                );
                this.logBookingRule({
                  rule: 'SOURCE_PHASE_ADVANCED_TO_CORRIDOR_PHASE',
                  quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                  planId,
                  routeId: route.itinerary_route_ID,
                  cycle: optimizationCycle,
                  pass,
                  currentTime,
                  sourcePhaseEndTime: secondsToTime(sourcePhaseEndSeconds),
                  reason: 'No pending source-phase candidates remain across strict, filler, deferred, or retry pools.',
                });
              }
            } else {
              hotspotsToTry = pendingPositiveCorridorHotspots.length > 0
                ? pendingPositiveCorridorHotspots
                : corridorHotspots.filter((hs: any) => !isHotspotAlreadyPlanned(Number(hs?.hotspot_ID || 0)));
            }
          }
          const passCandidateIds = new Set<number>(hotspotsToTry.map((hs: any) => Number(hs?.hotspot_ID || 0)));
          if (passCandidateIds.has(228) || passCandidateIds.has(357)) {
            this.logBookingRule({
              rule: 'VALARA_CHEEYAPPARA_PASS_CANDIDATES',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              pass,
              passType:
                pass === PASS_STRICT
                  ? 'strict'
                  : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                    ? 'filler'
                    : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                      ? 'deferred'
                      : 'retry',
              currentTime,
              sourcePhaseActive: isIntercityNonDirectRoute && timeToSeconds(currentTime) < sourcePhaseEndSeconds,
              candidates: hotspotsToTry
                .filter((hs: any) => [228, 357].includes(Number(hs?.hotspot_ID || 0)))
                .map((hs: any) => {
                  const hotspotId = Number(hs?.hotspot_ID || 0);
                  const master = hotspotMap.get(hotspotId) as any;
                  return {
                    hotspotId,
                    name: String(master?.hotspot_name || hs?.hotspot_name || ''),
                    bucket: String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase(),
                    priority: Number(hs?.hotspot_priority ?? 0),
                    corridorRank: getCorridorPriorityRank(hs),
                    inStrictHotspots: strictHotspots.some((s: any) => Number(s?.hotspot_ID || 0) === hotspotId),
                    inFillerHotspots: fillerHotspots.some((s: any) => Number(s?.hotspot_ID || 0) === hotspotId),
                    inCorridorHotspots: corridorHotspots.some((s: any) => Number(s?.hotspot_ID || 0) === hotspotId),
                    alreadyAdded: isHotspotAlreadyPlanned(hotspotId),
                  };
                }),
            });
          }
          const sourcePhaseActiveNow =
            isIntercityNonDirectRoute &&
            !shouldBypassSourcePhaseForMovementTransfer &&
            timeToSeconds(currentTime) < sourcePhaseEndSeconds;
          if (sourcePhaseActiveNow) {
            const sourceOnlyCandidates = hotspotsToTry.filter((hs: any) => isSourcePhaseEligibleCandidate(hs));

            if (sourceOnlyCandidates.length > 0) {
              hotspotsToTry = sourceOnlyCandidates;
            } else if (timeToSeconds(currentTime) < sourcePhaseEndSeconds) {
              this.logBookingRule({
                rule: 'SOURCE_PHASE_ADVANCE_TO_NOON',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                cycle: optimizationCycle,
                pass,
                fromTime: currentTime,
                toTime: '12:00:00',
                reason: 'No source-phase candidates remain before noon; advance scheduler clock before intercity movement.',
              });
              currentTime = '12:00:00';
            }
          }
          this.logBookingRule({
            rule: 'SOURCE_PHASE_CANDIDATES',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            pass,
            currentTime,
            sourcePhaseActive: sourcePhaseActiveNow,
            candidates: hotspotsToTry.map((hs: any) => ({
              hotspotLocation: String((hotspotMap.get(Number(hs?.hotspot_ID || 0)) as any)?.hotspot_location || ''),
              sourceCity: String(sourceCity || ''),
              sourceCityKey: this.canonicalCityKey(String(sourceCity || '')),
              hotspotLocationMatchesSourceCity: this.hotspotLocationMatchesCity(
                String((hotspotMap.get(Number(hs?.hotspot_ID || 0)) as any)?.hotspot_location || ''),
                sourceCity,
              ),
              hotspotId: Number(hs?.hotspot_ID || 0),
              hotspotName: String(hs?.hotspot_name || ''),
              bucket: String(hs?.matched_bucket || '').toLowerCase(),
              priority: Number(hs?.hotspot_priority ?? 0),
              sourcePhaseActive: sourcePhaseActiveNow,
              allowedBySourcePhase: !sourcePhaseActiveNow ? true : isSourcePhaseEligibleCandidate(hs),
              reason: !sourcePhaseActiveNow
                ? 'source_phase_inactive'
                : 'pre_filtered_source_phase',
            })),
          });
          for (const hs of hotspotsToTry as any[]) {
            if (Number(hs?.hotspot_ID || 0) !== 228) continue;
            const bucket = String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase();
            const hotspotLocation = String((hotspotMap.get(Number(hs?.hotspot_ID || 0)) as any)?.hotspot_location || '');
            this.logBookingRule({
              rule: 'CHEEYAPPARA_SOURCE_PHASE_PROOF',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: 228,
              bucket,
              hotspotLocation,
              sourceCity: String(sourceCity || ''),
              sourceCityKey: this.canonicalCityKey(String(sourceCity || '')),
              allowedBySourcePhase: isSourcePhaseEligibleCandidate(hs),
            });
          }

          if (hotspotsToTry.length === 0) {
            pass++;
            continue;
          }
          const passType =
            pass === PASS_STRICT
              ? 'strict'
              : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                ? 'filler'
                : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                  ? 'deferred'
                  : 'retry';
          this.logBookingRule({
            rule: 'CYCLE_PASS_CANDIDATE_ORDER',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            pass,
            passType,
            currentTime,
            candidates: hotspotsToTry.map((hs: any) => {
              const hotspotId = Number(hs?.hotspot_ID || 0);
              const bucket = String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase();
              const meta = hotspotMap.get(hotspotId) as any;
              return {
                hotspotId,
                name: String(hs?.hotspot_name || ''),
                bucket,
                priority: Number(hs?.hotspot_priority ?? 0),
                phaseRank: getPhaseRank(bucket),
                sourceCity: String(sourceCity || ''),
                destinationCity: String(destinationCity || ''),
                hotspotLocation: String(meta?.hotspot_location || ''),
                hotspotToLocation: String(meta?.hotspot_to_location || meta?.hotspot_location || ''),
                alreadyAdded: isHotspotAlreadyPlanned(hotspotId),
                enRouteAlreadyScheduled: enRoutePhaseStarted,
              };
            }),
          });
          if (isIntercityNonDirectRoute) {
            const cheeyappara = corridorHotspots.find((hs: any) => Number(hs?.hotspot_ID || 0) === 228);
            const valara = corridorHotspots.find((hs: any) => Number(hs?.hotspot_ID || 0) === 357);
            this.logBookingRule({
              rule: 'CHEEYAPPARA_VALARA_ORDER_PROOF',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cheeyappara: {
                present: !!cheeyappara,
                bucket: String((cheeyappara as any)?.matched_bucket || (cheeyappara as any)?.__bucket || '').toLowerCase(),
                priority: Number((cheeyappara as any)?.hotspot_priority ?? 0),
                corridorRank: cheeyappara ? getCorridorPriorityRank(cheeyappara) : null,
                added: isHotspotAlreadyPlanned(228),
                rejectedReason: null,
              },
              valara: {
                present: !!valara,
                bucket: String((valara as any)?.matched_bucket || (valara as any)?.__bucket || '').toLowerCase(),
                priority: Number((valara as any)?.hotspot_priority ?? 0),
                corridorRank: valara ? getCorridorPriorityRank(valara) : null,
                added: isHotspotAlreadyPlanned(357),
                rejectedReason: null,
              },
            });
          }

        // Build travel + hotspot segments in order (NO LUNCH BREAKS OR CUTOFF CHECKS)
        for (let hsIdx = 0; hsIdx < hotspotsToTry.length; hsIdx++) {
        const sh = hotspotsToTry[hsIdx];

        const hotspotPriority = Number((sh as any).hotspot_priority ?? 0);
        const isStageAPriority = hotspotPriority >= 1 && hotspotPriority <= 3;
        const bucket = (sh as any).matched_bucket as string | undefined;
        const hotspotId = Number((sh as any).hotspot_ID || 0);
        const normalizedBucket = String(bucket || '').toLowerCase();
        const isOptionalCorridorCandidate =
          isCorridorBucket(sh) && (hotspotPriority <= 0 || hotspotPriority >= 9999);
        const unresolvedPositiveCorridorIds = positiveCorridorHotspots
          .map((h: any) => Number(h?.hotspot_ID || 0))
          .filter((id: number) => id > 0 && !isHotspotAlreadyPlanned(id) && !resolvedPositiveCorridorIds.has(id));
        if (
          isIntercityNonDirectRoute &&
          isOptionalCorridorCandidate &&
          unresolvedPositiveCorridorIds.length > 0
        ) {
          this.logBookingRule({
            rule: 'OPTIONAL_CORRIDOR_WAITING_FOR_POSITIVE',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            pass,
            hotspotId,
            unresolvedPositiveCorridorIds,
          });
          continue;
        }
        const isSourcePhaseBucketNow = normalizedBucket === 'source' || normalizedBucket === 'source_fallback';
        const allowSourceCutoffRetryBypass =
          pass === PASS_REJECTED_RETRY && sourceCutoffRejectedHotspotIds.has(hotspotId);


        hotspotQueryCount++;
        
        // USER REQUIREMENT: Day 1 schedules ALL hotspots - no route time limit
        // Other days: stop if we have run out of route time
        if (!isFirstRoute) {
          let currentSeconds = timeToSeconds(currentTime);
          // Handle overnight: if current time < start time, add 24 hours
          if (currentSeconds < routeStartSeconds) {
            currentSeconds += 86400;
          }
          
          if (currentSeconds >= routeEndSeconds) {
            for (let j = hsIdx; j < hotspotsToTry.length; j++) {
              const rem = hotspotsToTry[j] as any;
              this.logHotspotCandidateEvaluation({
                routeId: route.itinerary_route_ID,
                hotspotId: Number(rem.hotspot_ID || 0),
                name: `hotspot_${Number(rem.hotspot_ID || 0)}`,
                matchedBucket: rem.matched_bucket ?? null,
                priority: Number(rem.hotspot_priority ?? 0),
                isMustVisit: Number(rem.hotspot_priority ?? 0) > 0,
                distanceFromRoute: Number.isFinite(Number(rem.hotspot_distance))
                  ? Number(rem.hotspot_distance)
                  : null,
                openingTime: null,
                closingTime: null,
                visitTime: `${currentTime} - ${currentTime}`,
                isOpenAtVisitTime: false,
                selected: false,
                rejectedReasons: ['Rejected: no remaining day window'],
              });
            }
            break;
          }
        }

        // DAY 1 TRAVEL CUTOFF: We'll check if this hotspot would finish after cutoff
        // AFTER calculating timeAfterSightseeing (lines ~835-851)
        // Don't break here - we need to try scheduling and see if it fits

        // PHP CHECK: Skip if hotspot already added to THIS PLAN (any previous route in this rebuild)
        // Line 15159 in sql_functions.php: check_hotspot_already_added_the_itineary_plan
        if (isHotspotAlreadyPlanned(sh.hotspot_ID)) {
          logHotspotBucketTrace({
            hotspotId,
            hotspotName: String((sh as any).hotspot_name || ''),
            bucket: normalizedBucket,
            priority: hotspotPriority,
            currentTime,
            sourcePhaseActive: isIntercityNonDirectRoute && timeToSeconds(currentTime) < sourcePhaseEndSeconds,
            accepted: false,
            rejectionReason: 'duplicate_plan_scope',
          });
          if (hotspotId === 241) {
            traceHotspot241('rejected_duplicate_plan_scope', {
              pass,
              currentTime,
              bucket: normalizedBucket || null,
              priority: hotspotPriority,
            });
          }
          this.logHotspotCandidateEvaluation({
            routeId: route.itinerary_route_ID,
            hotspotId: Number(sh.hotspot_ID || 0),
            name: `hotspot_${Number(sh.hotspot_ID || 0)}`,
            matchedBucket: (sh as any).matched_bucket ?? null,
            priority: Number((sh as any).hotspot_priority ?? 0),
            isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
            distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
              ? Number((sh as any).hotspot_distance)
              : null,
            openingTime: null,
            closingTime: null,
            visitTime: `${currentTime} - ${currentTime}`,
            isOpenAtVisitTime: false,
            selected: false,
            rejectedReasons: ['Rejected: duplicate'],
          });
          continue;
        }

        if (isIntercityNonDirectRoute) {
          const currentSecs = timeToSeconds(currentTime);
          const sourcePhaseActive =
            !shouldBypassSourcePhaseForMovementTransfer &&
            currentSecs < sourcePhaseEndSeconds;
          if (
            enRoutePhaseStarted &&
            (normalizedBucket === 'source' || normalizedBucket === 'source_fallback')
          ) {
            this.logBookingRule({
              rule: 'PHASE_GUARD_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              pass,
              hotspotId,
              name: String((sh as any).hotspot_name || ''),
              bucket: normalizedBucket,
              phaseRank: getPhaseRank(normalizedBucket),
              reason: 'source_blocked_after_en_route_started',
            });
            logHotspotBucketTrace({
              hotspotId,
              hotspotName: String((sh as any).hotspot_name || ''),
              bucket: normalizedBucket,
              priority: hotspotPriority,
              currentTime,
              sourcePhaseActive,
              accepted: false,
              rejectionReason: 'source_blocked_after_en_route_started',
            });
            continue;
          }
          if (sourcePhaseActive && !isSourcePhaseEligibleCandidate(sh)) {
            if (hotspotId === 228 || hotspotId === 357) {
              this.logBookingRule({
                rule: 'CHEEYAPPARA_REJECTED_BEFORE_VALARA',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                cycle: optimizationCycle,
                pass,
                passType:
                  pass === PASS_STRICT
                    ? 'strict'
                    : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                      ? 'filler'
                      : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                        ? 'deferred'
                        : 'retry',
                currentTime,
                bucket: normalizedBucket,
                priority: hotspotPriority,
                reason: 'source_phase_gate_non_source_bucket',
                rejectionSource: 'source_phase_gate',
                valaraAlreadyAdded: isHotspotAlreadyPlanned(357),
              });
            }
            logHotspotBucketTrace({
              hotspotId,
              hotspotName: String((sh as any).hotspot_name || ''),
              bucket: normalizedBucket,
              priority: hotspotPriority,
              currentTime,
              sourcePhaseActive,
              accepted: false,
              rejectionReason: 'source_phase_gate_non_source_bucket',
            });
            if (hotspotId === 241) {
              traceHotspot241('rejected_source_phase_gate', {
                pass,
                currentTime,
                sourcePhaseEnd: '12:00:00',
                bucket: normalizedBucket || null,
                priority: hotspotPriority,
              });
            }
            continue;
          }
        }

        // PHP CUTOFF TIME PARITY (config.php):
        // $source_cutoff_time = '12:00:00'  → stop source hotspots after 12:00
        // $via_cutoff_time    = '19:00:00'  → stop via hotspots after 19:00
        // $destination_cutoff_time = '21:00:00' → stop destination hotspots after 21:00
        // PHP checks: if (strtotime($hotspot_siteseeing_travel_start_time) >= strtotime($xxx_cutoff_time)) break;
        // In Nest, currentTime is equivalent to $hotspot_siteseeing_travel_start_time
        {
          const currentSecs = timeToSeconds(currentTime);
          const sourceCutoffSecs = timeToSeconds('12:00:00'); // 43200
          const viaCutoffSecs    = timeToSeconds('19:00:00'); // 68400
          const destCutoffSecs   = timeToSeconds('21:00:00'); // 75600
          let cutoffHit = false;
          const isSourceLikeBucket = normalizedBucket === 'source' || normalizedBucket === 'source_fallback';
          if (
            isSourceLikeBucket &&
            shouldApplySourceHotspotCutoff &&
            currentSecs >= sourceCutoffSecs &&
            !allowSourceCutoffRetryBypass &&
            String(sourceCity || '').trim().toLowerCase() !== String(destinationCity || '').trim().toLowerCase() &&
            !hasOnlySourceFallbackCandidates
          ) cutoffHit = true;
          if (bucket === 'via'    && currentSecs >= viaCutoffSecs)    cutoffHit = true;
          if (bucket === 'destination' && currentSecs >= destCutoffSecs) cutoffHit = true;
          if (cutoffHit) {
            if (hotspotId === 228 || hotspotId === 357) {
              this.logBookingRule({
                rule: 'CHEEYAPPARA_REJECTED_BEFORE_VALARA',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                cycle: optimizationCycle,
                pass,
                passType:
                  pass === PASS_STRICT
                    ? 'strict'
                    : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                      ? 'filler'
                      : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                        ? 'deferred'
                        : 'retry',
                currentTime,
                bucket: normalizedBucket,
                priority: hotspotPriority,
                reason: `php_${normalizedBucket || 'unknown'}_cutoff`,
                rejectionSource: 'source_cutoff_branch',
                valaraAlreadyAdded: isHotspotAlreadyPlanned(357),
              });
            }
            logHotspotBucketTrace({
              hotspotId,
              hotspotName: String((sh as any).hotspot_name || ''),
              bucket: normalizedBucket,
              priority: hotspotPriority,
              currentTime,
              sourcePhaseActive:
                isIntercityNonDirectRoute &&
                !shouldBypassSourcePhaseForMovementTransfer &&
                currentSecs < sourcePhaseEndSeconds,
              accepted: false,
              rejectionReason: `php_${normalizedBucket || 'unknown'}_cutoff`,
            });
            if (pass === PASS_STRICT && normalizedBucket === 'source' && !(isIntercityNonDirectRoute && currentSecs >= sourceCutoffSecs)) {
              sourceCutoffRejectedHotspotIds.add(hotspotId);
              queueRejectedHotspotForRetry(
                sh,
                `source_cutoff_breached_at:${currentTime}`,
              );
            }
            this.logBookingRule({
              rule: 'SOURCE_CUTOFF_PROOF',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              pass,
              hotspotId,
              bucket: normalizedBucket,
              currentTime,
              cutoff: '12:00:00',
              intercityNonDirect: isIntercityNonDirectRoute,
              rejected: true,
            });
            if (hotspotId === 241) {
              traceHotspot241('rejected_cutoff', {
                pass,
                currentTime,
                bucket: normalizedBucket || null,
                priority: hotspotPriority,
                allowSourceCutoffRetryBypass,
              });
            }
            this.logHotspotCandidateEvaluation({
              routeId: route.itinerary_route_ID,
              hotspotId: Number(sh.hotspot_ID || 0),
              name: `hotspot_${Number(sh.hotspot_ID || 0)}`,
              matchedBucket: bucket ?? null,
              priority: Number((sh as any).hotspot_priority ?? 0),
              isMustVisit: false,
              distanceFromRoute: null,
              openingTime: null,
              closingTime: null,
              visitTime: `${currentTime} - ${currentTime}`,
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: [`Rejected: PHP ${bucket}_cutoff_time breached (currentTime=${currentTime})`],
            });
            continue;
          }
        }

        // 2.a) Get hotspot details from pre-fetched map (NO DB QUERY)
        const hotspotData = hotspotMap.get(sh.hotspot_ID);
        if (!hotspotData) {
          logHotspotBucketTrace({
            hotspotId,
            hotspotName: String((sh as any).hotspot_name || ''),
            bucket: normalizedBucket,
            priority: hotspotPriority,
            currentTime,
            sourcePhaseActive: isIntercityNonDirectRoute && timeToSeconds(currentTime) < sourcePhaseEndSeconds,
            accepted: false,
            rejectionReason: 'hotspot_master_missing',
          });
          if (hotspotId === 241) {
            traceHotspot241('rejected_hotspot_master_missing', {
              pass,
              currentTime,
              bucket: normalizedBucket || null,
              priority: hotspotPriority,
            });
          }
          this.logHotspotCandidateEvaluation({
            routeId: route.itinerary_route_ID,
            hotspotId: Number(sh.hotspot_ID || 0),
            name: `hotspot_${Number(sh.hotspot_ID || 0)}`,
            matchedBucket: (sh as any).matched_bucket ?? null,
            priority: Number((sh as any).hotspot_priority ?? 0),
            isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
            distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
              ? Number((sh as any).hotspot_distance)
              : null,
            openingTime: null,
            closingTime: null,
            visitTime: `${currentTime} - ${currentTime}`,
            isOpenAtVisitTime: false,
            selected: false,
            rejectedReasons: ['Rejected: hotspot master missing'],
          });
          continue;
        }
        logHotspotBucketTrace({
          hotspotId,
          hotspotName: String((hotspotData as any)?.hotspot_name || (sh as any).hotspot_name || ''),
          bucket: normalizedBucket,
          priority: hotspotPriority,
          currentTime,
          sourcePhaseActive: isIntercityNonDirectRoute && timeToSeconds(currentTime) < sourcePhaseEndSeconds,
          accepted: true,
          rejectionReason: null,
        });
        if (isIntercityNonDirectRoute && normalizedBucket === 'en_route') {
          enRoutePhaseStarted = true;
        }
        this.logBookingRule({
          rule: 'HOTSPOT_ACCEPTED_ORDER_PROOF',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          cycle: optimizationCycle,
          pass,
          acceptedIndex: hotspotRows.filter((r: any) => Number((r as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) && Number((r as any).item_type || 0) === 4).length + 1,
          hotspotId,
          name: String((hotspotData as any)?.hotspot_name || (sh as any).hotspot_name || ''),
          bucket: normalizedBucket,
          priority: hotspotPriority,
          phaseRank: getPhaseRank(normalizedBucket),
          currentTimeBefore: currentTime,
          currentTimeAfter: null,
          enRouteAlreadyScheduledBefore: (isIntercityNonDirectRoute && normalizedBucket !== 'en_route') ? enRoutePhaseStarted : (isIntercityNonDirectRoute ? false : false),
          enRouteAlreadyScheduledAfter: enRoutePhaseStarted,
          previousAcceptedHotspots: hotspotRows
            .filter((r: any) => Number((r as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) && Number((r as any).item_type || 0) === 4)
            .map((r: any) => Number((r as any).hotspot_ID || 0)),
        });

        // PHP parity: preserve full hotspot_location string for travel-type semantics.
        const hotspotLocationName = hotspotData.hotspot_location as string || currentLocationName;
        const hotspotDuration = hotspotData.hotspot_duration || '01:00:00';
        const hotspotType = String(hotspotData.hotspot_type || hotspotData.hotspotType || '').trim().toLowerCase();
        const destCoords = {
          lat: Number(hotspotData.hotspot_latitude ?? 0),
          lon: Number(hotspotData.hotspot_longitude ?? 0),
        };
        
        // If this is the first hotspot and we don't have starting coords,
        // assume minimal travel time (starting near the first hotspot)
        if (!currentCoords) {
          // Set currentCoords to first hotspot location for subsequent calculations
          currentCoords = destCoords;
        }

        const sharedJsDay = route.itinerary_route_date
          ? new Date(route.itinerary_route_date).getDay()
          : 0;
        const sharedDayOfWeek = (sharedJsDay + 6) % 7;
        const timingSummary = this.getTimingWindowSummary(
          timingMap,
          sh.hotspot_ID,
          sharedDayOfWeek,
        );

        const sharedFeasibility = await this.evaluateCandidateInsertion({
          tx,
          route,
          isLastRoute,
          routeStartSeconds,
          routeEndSeconds,
          currentTime,
          currentLocationName,
          currentCoords,
          destinationCoords: destCityCoords,
          dayOfWeek: sharedDayOfWeek,
          hotspotId,
          hotspotLocationName,
          hotspotDuration,
          hotspotCoords: destCoords,
          hotspotPriority: Number((sh as any).hotspot_priority ?? 0),
          timingMap,
          plan,
          destinationCity,
          lastRouteArrivalDeadlineSeconds,
          allowWaitUntilOpen: Number((sh as any).hotspot_priority ?? 0) > 0,
          rejectIfOutsideOperatingWindow: true,
          hotspotType,
        });

        if (!sharedFeasibility.feasible) {
          if (hotspotId === 228 || hotspotId === 357) {
            this.logBookingRule({
              rule: 'CHEEYAPPARA_REJECTED_BEFORE_VALARA',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              cycle: optimizationCycle,
              pass,
              passType:
                pass === PASS_STRICT
                  ? 'strict'
                  : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                    ? 'filler'
                    : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                      ? 'deferred'
                      : 'retry',
              currentTime,
              bucket: normalizedBucket,
              priority: hotspotPriority,
              reason: sharedFeasibility.reason || 'shared_feasibility_rejected',
              rejectionSource: 'shared_feasibility',
              valaraAlreadyAdded: isHotspotAlreadyPlanned(357),
            });
          }
          if (sharedFeasibility.rejectedByDayEndReturnCheck) {
            this.logBookingRule({
              rule: 'DAY_END_RETURN_CHECK_FAILED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              reason: sharedFeasibility.reason,
            });

            if (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY) {
              this.logBookingRule({
                rule: 'ANCHOR_APPEND_GATE_RETURN_CHECK_FAILED',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId,
                reason: sharedFeasibility.reason,
              });
            }
          }

          if (pass === PASS_STRICT && isStageAPriority) {
            queueDeferredMustVisitHotspot(
              deferredPriorityHotspots,
              deferredPriorityHotspotIds,
              sh,
              pass,
              isStageAPriority,
            );

            if (sharedFeasibility.reason === 'outside_operating_hours_for_visit_window') {
              queueRejectedHotspotForRetry(
                sh,
                `outside_operating_window_shared_eval`,
              );
            }
          }

          if (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY) {
            this.logBookingRule({
              rule: 'ANCHOR_APPEND_GATE_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              reason: sharedFeasibility.reason || 'shared_feasibility_rejected',
            });

            this.logBookingRule({
              rule: 'FILLER_INSERTION_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              reason: sharedFeasibility.reason || 'shared_feasibility_rejected',
            });
          }

          continue;
        }

        if (sharedFeasibility.usedWaitUntilOpen && pass === PASS_STRICT && isStageAPriority) {
          if (
            enableProtectedStrictSlots &&
            optimizationCycle === 1 &&
            sharedFeasibility.startSeconds !== undefined &&
            sharedFeasibility.endSeconds !== undefined
          ) {
            if (!protectedStrictSlots.some((s) => s.hotspotId === hotspotId && s.routeId === Number(route.itinerary_route_ID || 0))) {
              protectedStrictSlots.push({
                hotspotId,
                routeId: Number(route.itinerary_route_ID || 0),
                startSeconds: sharedFeasibility.startSeconds,
                endSeconds: sharedFeasibility.endSeconds,
                sourceCandidate: sh,
                locked: true,
              });
            }

            this.logBookingRule({
              rule: 'STRICT_DEFERRED_TO_LATER_WINDOW',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              resolvedStart: sharedFeasibility.timeAfterTravel,
              mode: 'protected_strict_slot_created',
            });
            continue;
          }

          if (!enableProtectedStrictSlots) {
            const waitGapSeconds = Number(sharedFeasibility.waitGapSeconds || 0);
            if (waitGapSeconds > LARGE_WAIT_DEFER_THRESHOLD_SECONDS) {
              queueDeferredMustVisitHotspot(
                deferredPriorityHotspots,
                deferredPriorityHotspotIds,
                sh,
                pass,
                isStageAPriority,
              );

              this.logBookingRule({
                rule: 'STRICT_DEFERRED_TO_LATER_WINDOW',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId,
                resolvedStart: sharedFeasibility.timeAfterTravel,
                waitGapMinutes: Math.floor(waitGapSeconds / 60),
                mode: 'intercity_deferred_without_protected_slot',
              });
              continue;
            }

            this.logBookingRule({
              rule: 'STRICT_DEFERRED_TO_LATER_WINDOW',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              resolvedStart: sharedFeasibility.timeAfterTravel,
              waitGapMinutes: Math.floor(waitGapSeconds / 60),
              mode: 'intercity_wait_window_scheduled_now',
            });
          }

          this.logBookingRule({
            rule: 'STRICT_DEFERRED_TO_LATER_WINDOW',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId,
            resolvedStart: sharedFeasibility.timeAfterTravel,
          });
        }

        const timeAfterTravel = sharedFeasibility.timeAfterTravel || currentTime;
        const timeAfterSightseeing = sharedFeasibility.timeAfterSightseeing || timeAfterTravel;

        if (hotspotId === 228 || hotspotId === 357) {
          this.logBookingRule({
            rule: 'VALARA_CHEEYAPPARA_ACCEPT_ATTEMPT',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            pass,
            passType:
              pass === PASS_STRICT
                ? 'strict'
                : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                  ? 'filler'
                  : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                    ? 'deferred'
                    : 'retry',
            hotspotId,
            name: String((hotspotData as any)?.hotspot_name || (sh as any).hotspot_name || ''),
            bucket: normalizedBucket,
            priority: hotspotPriority,
            currentTimeBefore: currentTime,
            currentLocationName,
            sourceCity: String(sourceCity || ''),
            destinationCity: String(destinationCity || ''),
            reason: 'about_to_push_hotspot_row',
            previousAcceptedHotspots: Array.from(addedHotspotIds.values()),
          });
        }

        if (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY) {
          const anchorGapFeasibility = await this.evaluateAnchorGapInsertion(
            tx,
            hotspotRows,
            hotspotMap,
            Number(route.itinerary_route_ID || 0),
            routeStartSeconds,
            routeEndSeconds,
            currentTime,
            hotspotLocationName,
            destCoords,
            Number(sharedFeasibility.endSeconds || timeToSeconds(timeAfterSightseeing)),
            enableProtectedStrictSlots ? protectedStrictSlots : undefined,
          );

          if (!anchorGapFeasibility.feasible) {
            if (positiveCorridorHotspots.some((h: any) => Number(h?.hotspot_ID || 0) === hotspotId)) {
              resolvedPositiveCorridorIds.add(hotspotId);
              this.logBookingRule({
                rule: 'POSITIVE_CORRIDOR_RESOLVED_BY_REJECTION',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId,
                reason: anchorGapFeasibility.reason || 'anchor_append_gate_rejected',
              });
            }
            if (anchorGapFeasibility.reason === 'next_anchor_timing_broken') {
              this.logBookingRule({
                rule: 'ANCHOR_APPEND_GATE_NEXT_POINT_BROKEN',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId,
                nextAnchorHotspotId: anchorGapFeasibility.nextAnchorHotspotId,
                nextAnchorStartTime: anchorGapFeasibility.nextAnchorStartSeconds !== undefined
                  ? secondsToTime(wrapToDay(anchorGapFeasibility.nextAnchorStartSeconds))
                  : null,
                projectedArrivalAtNextAnchor: anchorGapFeasibility.arrivalAtNextAnchorSeconds !== undefined
                  ? secondsToTime(wrapToDay(anchorGapFeasibility.arrivalAtNextAnchorSeconds))
                  : null,
              });
            }

            this.logBookingRule({
              rule: 'ANCHOR_APPEND_GATE_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              reason: anchorGapFeasibility.reason || 'anchor_append_gate_rejected',
            });

            this.logBookingRule({
              rule: 'FILLER_INSERTION_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId,
              reason: anchorGapFeasibility.reason || 'anchor_append_gate_rejected',
            });
            continue;
          }
        }

        distanceCalcCount++;

        if (tracePhpIncludeFlow) {
          console.log('[PHP_INCLUDE_TRACE_CANDIDATE]', JSON.stringify({
            routeId: route.itinerary_route_ID,
            dayMode: 'normal_multi_pass',
            hotspotId: Number(sh.hotspot_ID || 0),
            bucket: (sh as any).matched_bucket ?? null,
            priority: Number((sh as any).hotspot_priority ?? 0),
            pass,
            gateCurrentTime: currentTime,
            gateTravelStart: timeAfterTravel,
            gateVisitEnd: timeAfterSightseeing,
            routeEndTime,
            phpGates: [
              'duplicate_plan_scope',
              'bucket_cutoff',
              'shared_feasibility_gate',
            ],
          }));
        }

        if (
          rejectDuplicatePlanHotspot(hotspotId, {
            routeId: Number(route.itinerary_route_ID || 0),
            routeDay: Number((route as any).no_of_days || routeIndex || 0),
            sourceCity,
            destinationCity,
            branch: 'main_scheduling_loop',
            hotspotName: String((hotspotData as any)?.hotspot_name || (sh as any)?.hotspot_name || ''),
          })
        ) {
          continue;
        }

        // 2.c) Build TRAVEL SEGMENT (item_type = 3)
        // PHP BEHAVIOR: Travel and Visit segments share the SAME hotspot_order
        const currentOrder = order;

        const isEarlyArrivalHotelDeparture =
          (isHotelPreferenceEarlyArrival || isVehicleHotelRestEarlyArrival) &&
          lastAddedHotspotId === null;
        let travelStartTime = currentTime;
        let alignedDepartureFromHotel = false;

        if (
          isEarlyArrivalHotelDeparture &&
          sharedFeasibility.startSeconds !== undefined &&
          sharedFeasibility.travelTimeToHotspot
        ) {
          const travelDurationSeconds = timeToSeconds(sharedFeasibility.travelTimeToHotspot);
          const currentAbsoluteSeconds = this.toAbsoluteSecondsForRoute(currentTime, routeStartSeconds);
          const desiredDepartureSeconds = sharedFeasibility.startSeconds - travelDurationSeconds;

          if (desiredDepartureSeconds > currentAbsoluteSeconds) {
            travelStartTime = secondsToTime(wrapToDay(desiredDepartureSeconds));
            alignedDepartureFromHotel = true;

            const hotelWaitSeconds = desiredDepartureSeconds - currentAbsoluteSeconds;
            if (hotelWaitSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
              const hotelWaitRow = this.buildFreeTimeBreakRow({
                planId,
                routeId: route.itinerary_route_ID,
                order: currentOrder,
                startTime: currentTime,
                endTime: travelStartTime,
                userId: createdByUserId,
              });
              hotelWaitRow.via_location_name =
                `Wait at ${currentLocationName} before ${hotspotLocationName} opens`;
              hotspotRows.push(hotelWaitRow);

              this.logBookingRule({
                rule: 'EARLY_ARRIVAL_HOTEL_DEPARTURE_ALIGNED_TO_OPENING',
                quoteId:
                  (plan as any).quote_id ??
                  (plan as any).quoteId ??
                  (plan as any).quote_ID ??
                  null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId,
                sourceLocationName: currentLocationName,
                destinationLocationName: hotspotLocationName,
                departureTime: travelStartTime,
                arrivalTime: sharedFeasibility.timeAfterTravel,
                waitMinutes: Math.floor(hotelWaitSeconds / 60),
              });
            }
          }
        }

        if (
          suppressHotelInsertionUntilEndOfDay &&
          this.normalizeCityName(hotspotLocationName) === 'hotel'
        ) {
          this.logBookingRule({
            rule: 'HOTEL_SEGMENT_SUPPRESSED_IN_HOTSPOT_LOOP',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: sh.hotspot_ID,
            hotspotLocationName,
              reason:
                'Arrival policy requires sightseeing first: suppress hotel insertion during hotspot scheduling.',
          });
          continue;
        }
        
        const travelLocationType = this.getTravelLocationType(
          currentLocationName,
          hotspotLocationName,
        );
        const { row: travelRow, nextTime: tToHotspot } =
          await this.travelBuilder.buildTravelSegment(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder, // Use current order without incrementing
            item_type: 3, // Site Seeing Traveling
            travelLocationType,
            startTime: travelStartTime,
            userId: createdByUserId,
            sourceLocationName: currentLocationName,
            destinationLocationName: hotspotLocationName,
            hotspotId: sh.hotspot_ID, // PHP sets hotspot_ID for item_type=3
            fromHotspotId: lastAddedHotspotId ?? undefined,
            sourceCoords: currentCoords, // Use current location coordinates
            destCoords: destCoords,
          });

        hotspotRows.push(
          this.dataAccessService.normalizeTravelRowDistance(
            travelRow,
            currentLocationName,
            hotspotLocationName,
          ),
        );
        currentTime = tToHotspot;

        const gapBeforeVisitSeconds = alignedDepartureFromHotel
          ? 0
          : Math.max(0, timeToSeconds(timeAfterTravel) - timeToSeconds(currentTime));
        if (gapBeforeVisitSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
          const freeTimeRow = this.buildFreeTimeBreakRow({
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder,
            startTime: currentTime,
            endTime: timeAfterTravel,
            userId: createdByUserId,
          });
          hotspotRows.push(freeTimeRow);
          this.logBookingRule({
            rule: 'FREE_TIME_INSERTED_WAITING_WINDOW',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: sh.hotspot_ID,
            reason: 'No feasible hotspot during waiting window after travel; inserted explicit free-time segment.',
            gapStart: currentTime,
            gapEnd: timeAfterTravel,
            gapMinutes: Math.floor(gapBeforeVisitSeconds / 60),
          });
          currentTime = timeAfterTravel;
        }

        // If hotspot opens later than travel arrival, wait at location before visit.
        if (timeToSeconds(timeAfterTravel) > timeToSeconds(currentTime)) {
          currentTime = timeAfterTravel;
        }
        currentLocationName = hotspotLocationName;
        currentCoords = destCoords; // Update to hotspot coordinates

        // 2.d) Build HOTSPOT STAY SEGMENT (item_type = 4)
        const { row: hotspotRow, nextTime: tAfterHotspot } =
          await this.hotspotBuilder.build(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder, // Use same order as travel segment
            hotspotId: sh.hotspot_ID,
            startTime: currentTime,
            userId: createdByUserId,
            totalAdult: plan.total_adult,
            totalChildren: plan.total_children,
            totalInfants: plan.total_infants,
            nationality: plan.nationality,
            itineraryPreference: plan.itinerary_preference,
            isConflict: false,
            conflictReason: '',
          });

          hotspotRows.push(hotspotRow);
          if (positiveCorridorHotspots.some((h: any) => Number(h?.hotspot_ID || 0) === hotspotId)) {
            resolvedPositiveCorridorIds.add(hotspotId);
          }
        if (
          isIntercityNonDirectRoute &&
          isOptionalCorridorCandidate &&
          unresolvedPositiveCorridorIds.length === 0
        ) {
          this.logBookingRule({
            rule: 'OPTIONAL_CORRIDOR_ALLOWED_AFTER_POSITIVE',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            pass,
            positiveResolvedIds: Array.from(resolvedPositiveCorridorIds.values()),
            optionalHotspotId: hotspotId,
          });
        }
        if (hotspotId === 228 || hotspotId === 357) {
          this.logBookingRule({
            rule: 'VALARA_CHEEYAPPARA_ACCEPTED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            pass,
            passType:
              pass === PASS_STRICT
                ? 'strict'
                : (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY)
                  ? 'filler'
                  : (pass === PASS_DEFERRED_PRIMARY || pass === PASS_DEFERRED_SECONDARY)
                    ? 'deferred'
                    : 'retry',
            hotspotId,
            name: String((hotspotData as any)?.hotspot_name || (sh as any).hotspot_name || ''),
            bucket: normalizedBucket,
            priority: hotspotPriority,
            currentTimeBefore: timeAfterTravel,
            currentTimeAfter: tAfterHotspot,
            insertedBy: 'main_candidate_loop',
            addedHotspotIds: Array.from(addedHotspotIds.values()).concat([hotspotId]),
          });
        }
        
        // Mark this hotspot as added to prevent duplicates in subsequent routes
        markHotspotAsPlanned(hotspotId);
        if (carryForwardHotspots.some((h) => Number((h as any).hotspot_ID || 0) === hotspotId)) {
          carryForwardHotspots = carryForwardHotspots.filter((h) => Number((h as any).hotspot_ID || 0) !== hotspotId);
          this.logBookingRule({
            rule: 'STRICT_CARRY_FORWARD_CONSUMED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            consumedHotspotIds: [hotspotId],
            reason: 'Carried strict hotspot scheduled successfully and removed from in-memory queue.',
          });
        }
        lastAddedHotspotId = hotspotId; // Update for next hotspot-to-hotspot travel segment
        
        // NOW increment order after both travel and visit are added
        order++;
        
        currentTime = tAfterHotspot;
        // currentLocationName remains at the hotspot.

        // PHP parity: adjusted route hotspot end time is computed once per route.
        // Do not dynamically relax/recompute cutoff after each hotspot.

        // NO LUNCH BREAK LOGIC - removed per user request

        // 2.d) PARKING CHARGE ROWS for this hotspot (one per vendor vehicle)
        const parkingRowsForHotspot = await this.parkingBuilder.buildForHotspot(tx, {
          planId,
          routeId: route.itinerary_route_ID,
          hotspotId: sh.hotspot_ID,
          userId: createdByUserId,
        });

        if (parkingRowsForHotspot && parkingRowsForHotspot.length > 0) {
          parkingRows.push(...parkingRowsForHotspot);
        }

        addedInLastPass = true;
        addedInCurrentCycle = true;

        if (pass === PASS_FILLER_PRIMARY || pass === PASS_FILLER_SECONDARY) {
          this.logBookingRule({
            rule: 'ANCHOR_APPEND_GATE_ACCEPTED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId,
            startTime: timeAfterTravel,
            endTime: timeAfterSightseeing,
          });

          this.logBookingRule({
            rule: 'FILLER_INSERTION_ACCEPTED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId,
            startTime: timeAfterTravel,
            endTime: timeAfterSightseeing,
          });
        }

        this.logHotspotCandidateEvaluation({
          routeId: route.itinerary_route_ID,
          hotspotId: Number(sh.hotspot_ID || 0),
          name: String(hotspotData.hotspot_location || `hotspot_${Number(sh.hotspot_ID || 0)}`),
          matchedBucket: (sh as any).matched_bucket ?? null,
          priority: Number((sh as any).hotspot_priority ?? 0),
          isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
          distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
            ? Number((sh as any).hotspot_distance)
            : null,
          openingTime: timingSummary.openingTime,
          closingTime: timingSummary.closingTime,
          visitTime: `${timeAfterTravel} - ${timeAfterSightseeing}`,
          isOpenAtVisitTime: true,
          selected: true,
          rejectedReasons: [],
        });
      }
      
      // End of hotspot scheduling loop
      pass++;
      } // End of pass loop for this optimization cycle

      if (enableProtectedStrictSlots && optimizationCycle === 2 && protectedStrictSlots.length > 0) {
        const routeIdNum = Number(route.itinerary_route_ID || 0);
        const pendingSlots = [...protectedStrictSlots]
          .filter((slot) => slot.routeId === routeIdNum)
          .sort((a, b) => a.startSeconds - b.startSeconds);

        for (const slot of pendingSlots) {
          if (isHotspotAlreadyPlanned(slot.hotspotId)) {
            continue;
          }

          const strictSource = slot.sourceCandidate || strictPassHotspots.find((s) => Number((s as any).hotspot_ID || 0) === slot.hotspotId);
          if (!strictSource) {
            continue;
          }

          const hotspotData = hotspotMap.get(slot.hotspotId);
          if (!hotspotData) {
            continue;
          }

          const hotspotLocationName = String((hotspotData as any).hotspot_location || currentLocationName);
          const destCoords = {
            lat: Number((hotspotData as any).hotspot_latitude ?? 0),
            lon: Number((hotspotData as any).hotspot_longitude ?? 0),
          };

          const travelTime = await this.calculateTravelTimeWithCoords(
            tx,
            currentLocationName,
            hotspotLocationName,
            currentCoords,
            destCoords,
          );

          const travelSeconds = timeToSeconds(travelTime);
          const currentAbsSeconds = this.toAbsoluteSecondsForRoute(currentTime, routeStartSeconds);
          const arrivalSeconds = currentAbsSeconds + travelSeconds;

          if (arrivalSeconds > slot.startSeconds || slot.endSeconds > routeEndSeconds) {
            continue;
          }

          if (
            rejectDuplicatePlanHotspot(slot.hotspotId, {
              routeId: Number(route.itinerary_route_ID || 0),
              routeDay: Number((route as any).no_of_days || routeIndex || 0),
              sourceCity,
              destinationCity,
              branch: 'protected_strict_slot_repair',
              hotspotName: String((hotspotData as any)?.hotspot_name || ''),
            })
          ) {
            continue;
          }

          const currentOrder = order;
          const isEarlyArrivalHotelDeparture =
            (isHotelPreferenceEarlyArrival || isVehicleHotelRestEarlyArrival) &&
            lastAddedHotspotId === null;
          let travelStartTime = currentTime;
          let alignedDepartureFromHotel = false;

          if (isEarlyArrivalHotelDeparture) {
            const desiredDepartureSeconds = slot.startSeconds - travelSeconds;
            if (desiredDepartureSeconds > currentAbsSeconds) {
              travelStartTime = secondsToTime(wrapToDay(desiredDepartureSeconds));
              alignedDepartureFromHotel = true;

              const hotelWaitSeconds = desiredDepartureSeconds - currentAbsSeconds;
              if (hotelWaitSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
                const hotelWaitRow = this.buildFreeTimeBreakRow({
                  planId,
                  routeId: route.itinerary_route_ID,
                  order: currentOrder,
                  startTime: currentTime,
                  endTime: travelStartTime,
                  userId: createdByUserId,
                });
                hotelWaitRow.via_location_name =
                  `Wait at ${currentLocationName} before ${hotspotLocationName} opens`;
                hotspotRows.push(hotelWaitRow);
              }
            }
          }
          const travelLocationType = this.getTravelLocationType(currentLocationName, hotspotLocationName);
          const { row: routeTravelRow } = await this.travelBuilder.buildTravelSegment(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder,
            item_type: 3,
            travelLocationType,
            startTime: travelStartTime,
            userId: createdByUserId,
            sourceLocationName: currentLocationName,
            destinationLocationName: hotspotLocationName,
            hotspotId: slot.hotspotId,
            fromHotspotId: lastAddedHotspotId ?? undefined,
            sourceCoords: currentCoords,
            destCoords,
          });
          hotspotRows.push(routeTravelRow);

          const alignStartTime = secondsToTime(slot.startSeconds);
          if (!alignedDepartureFromHotel && arrivalSeconds < slot.startSeconds) {
            const travelEnd = secondsToTime(currentAbsSeconds + travelSeconds);
            const waitGapSeconds = slot.startSeconds - arrivalSeconds;
            if (waitGapSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
              hotspotRows.push(
                this.buildFreeTimeBreakRow({
                  planId,
                  routeId: route.itinerary_route_ID,
                  order: currentOrder,
                  startTime: travelEnd,
                  endTime: alignStartTime,
                  userId: createdByUserId,
                }),
              );
            }
          }

          currentTime = alignStartTime;

          const { row: strictRow } = await this.hotspotBuilder.build(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder,
            hotspotId: slot.hotspotId,
            startTime: alignStartTime,
            userId: createdByUserId,
            totalAdult: plan.total_adult,
            totalChildren: plan.total_children,
            totalInfants: plan.total_infants,
            nationality: plan.nationality,
            itineraryPreference: plan.itinerary_preference,
            isConflict: false,
            conflictReason: '',
          });

          hotspotRows.push(strictRow);
          markHotspotAsPlanned(slot.hotspotId);
          lastAddedHotspotId = slot.hotspotId;
          order = currentOrder + 1;
          currentTime = secondsToTime(slot.endSeconds);
          currentLocationName = hotspotLocationName;
          currentCoords = destCoords;
          addedInCurrentCycle = true;

          const protectedSlotParkingRows = await this.parkingBuilder.buildForHotspot(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: slot.hotspotId,
            userId: createdByUserId,
          });
          if (protectedSlotParkingRows && protectedSlotParkingRows.length > 0) {
            parkingRows.push(...protectedSlotParkingRows);
            this.logBookingRule({
              rule: 'PROTECTED_STRICT_SLOT_PARKING_ADDED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: slot.hotspotId,
              parkingRowCount: protectedSlotParkingRows.length,
            });
          }

          this.logBookingRule({
            rule: 'PROTECTED_STRICT_SLOT_INSERTED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: slot.hotspotId,
            slotStartSeconds: slot.startSeconds,
            slotEndSeconds: slot.endSeconds,
            mode: 'protected_slot_inserted_cycle2',
          });
        }
      }

      const unscheduledStrictIds = Array.from(strictHotspotIdSet.values()).filter((id) => !isHotspotAlreadyPlanned(id));
      const remainingFillerHotspotIds = (fillerHotspots as Array<SelectedHotspot>)
        .map((h) => Number((h as any).hotspot_ID || 0))
        .filter((id) => id > 0 && !isHotspotAlreadyPlanned(id));

      if (isCycle4GapFillRoute && optimizationCycle === MAX_SCHEDULER_OPTIMIZATION_CYCLES) {
        const jsDayForGapFill = route.itinerary_route_date
          ? new Date(route.itinerary_route_date).getDay()
          : 0;
        const dayOfWeekForGapFill = (jsDayForGapFill + 6) % 7;

        const persistedRouteRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: route.itinerary_route_ID,
            item_type: 4,
            status: 1,
            deleted: 0,
          },
          select: { hotspot_ID: true },
        });

        const persistedRouteHotspotIds = new Set<number>(
          persistedRouteRows
            .map((row: any) => Number(row.hotspot_ID || 0))
            .filter((id: number) => id > 0),
        );

        const routePlannedHotspotIds = new Set<number>(persistedRouteHotspotIds.values());
        for (const row of hotspotRows as Array<any>) {
          if (Number(row?.itinerary_route_ID || 0) !== Number(route.itinerary_route_ID || 0)) continue;
          if (Number(row?.item_type || 0) !== 4) continue;
          const id = Number(row?.hotspot_ID || 0);
          if (id > 0) {
            routePlannedHotspotIds.add(id);
          }
        }

        const cycle4PrefilterRejects: Array<{ hotspotId: number; reason: string }> = [];

        const cycle4Candidates = (selectedHotspots as Array<SelectedHotspot>)
          .filter((h) => {
            const hotspotId = Number((h as any).hotspot_ID || 0);
            if (hotspotId <= 0) return false;
            if (routePlannedHotspotIds.has(hotspotId)) {
              cycle4PrefilterRejects.push({ hotspotId, reason: 'already_persisted_or_planned_on_route' });
              return false;
            }
            if (previousDaySameCityHotspotIds.has(hotspotId)) {
              cycle4PrefilterRejects.push({ hotspotId, reason: 'exists_on_previous_day_same_city' });
              return false;
            }
            if (permanentlyClosedHotspotIds.has(hotspotId)) {
              cycle4PrefilterRejects.push({ hotspotId, reason: 'closed_all_days' });
              return false;
            }
            if (this.isHotspotClosedOnDay(timingMap, hotspotId, dayOfWeekForGapFill)) {
              cycle4PrefilterRejects.push({ hotspotId, reason: 'closed_on_visit_day' });
              return false;
            }
            return true;
          })
          .sort((a, b) => {
            const ap = Number((a as any).hotspot_priority ?? 0);
            const bp = Number((b as any).hotspot_priority ?? 0);
            if (ap !== bp) return bp - ap;
            const ad = Number((a as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
            const bd = Number((b as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
            if (ad !== bd) return ad - bd;
            return Number((a as any).hotspot_ID || 0) - Number((b as any).hotspot_ID || 0);
          });

        this.logBookingRule({
          rule: 'CYCLE4_SAME_CITY_GAP_FILL_START',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          cycle: optimizationCycle,
          previousDayExcludedIds: Array.from(previousDaySameCityHotspotIds.values()).slice(0, 30),
          persistedRouteHotspotCount: persistedRouteHotspotIds.size,
          prefilterRejectedCount: cycle4PrefilterRejects.length,
          prefilterRejectedSample: cycle4PrefilterRejects.slice(0, 40),
          candidateCount: cycle4Candidates.length,
        });

        for (const sh of cycle4Candidates) {
          let cycle4CurrentSeconds = timeToSeconds(currentTime);
          if (cycle4CurrentSeconds < routeStartSeconds) {
            cycle4CurrentSeconds += 86400;
          }
          if (cycle4CurrentSeconds >= routeEndSeconds) {
            this.logBookingRule({
                rule: 'ANCHOR_APPEND_GATE_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: Number((sh as any).hotspot_ID || 0),
              reason: 'route_time_window_exhausted_before_candidate',
            });

            this.logBookingRule({
              rule: 'CYCLE4_RELAXED_FILL_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: Number((sh as any).hotspot_ID || 0),
              reason: 'route_time_window_exhausted_before_candidate',
              currentTime,
              routeEndTime,
            });
            break;
          }

          const hotspotData = hotspotMap.get((sh as any).hotspot_ID);
          if (!hotspotData) {
            this.logBookingRule({
              rule: 'CYCLE4_RELAXED_FILL_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: Number((sh as any).hotspot_ID || 0),
              reason: 'missing_hotspot_metadata',
            });
            continue;
          }

          const hotspotLocationName = (hotspotData.hotspot_location as string) || currentLocationName;
          const hotspotDuration = hotspotData.hotspot_duration || '01:00:00';
          const hotspotType = String(hotspotData.hotspot_type || hotspotData.hotspotType || '').trim().toLowerCase();
          const destCoords = {
            lat: Number(hotspotData.hotspot_latitude ?? 0),
            lon: Number(hotspotData.hotspot_longitude ?? 0),
          };

          const sharedCycle4Feasibility = await this.evaluateCandidateInsertion({
            tx,
            route,
            isLastRoute,
            routeStartSeconds,
            routeEndSeconds,
            currentTime,
            currentLocationName,
            currentCoords,
            destinationCoords: destCityCoords,
            dayOfWeek: dayOfWeekForGapFill,
            hotspotId: Number((sh as any).hotspot_ID || 0),
            hotspotLocationName,
            hotspotDuration,
            hotspotCoords: destCoords,
            hotspotPriority: Number((sh as any).hotspot_priority ?? 0),
            timingMap,
            plan,
            destinationCity,
            lastRouteArrivalDeadlineSeconds,
            allowWaitUntilOpen: Number((sh as any).hotspot_priority ?? 0) > 0,
            rejectIfOutsideOperatingWindow: true,
            hotspotType,
          });

          if (!sharedCycle4Feasibility.feasible) {
            if (sharedCycle4Feasibility.rejectedByDayEndReturnCheck) {
              this.logBookingRule({
                rule: 'DAY_END_RETURN_CHECK_FAILED',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId: Number((sh as any).hotspot_ID || 0),
                reason: sharedCycle4Feasibility.reason,
              });

              this.logBookingRule({
                rule: 'ANCHOR_APPEND_GATE_RETURN_CHECK_FAILED',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId: Number((sh as any).hotspot_ID || 0),
                reason: sharedCycle4Feasibility.reason,
              });
            }

            this.logBookingRule({
              rule: 'CYCLE4_RELAXED_FILL_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: Number((sh as any).hotspot_ID || 0),
              reason: sharedCycle4Feasibility.reason || 'shared_feasibility_rejected',
            });
            continue;
          }

          const timeAfterTravel = sharedCycle4Feasibility.timeAfterTravel || currentTime;
          const timeAfterSightseeing = sharedCycle4Feasibility.timeAfterSightseeing || currentTime;
          const cycle4AnchorGapFeasibility = await this.evaluateAnchorGapInsertion(
            tx,
            hotspotRows,
            hotspotMap,
            Number(route.itinerary_route_ID || 0),
            routeStartSeconds,
            routeEndSeconds,
            currentTime,
            hotspotLocationName,
            destCoords,
            Number(sharedCycle4Feasibility.endSeconds || timeToSeconds(timeAfterSightseeing)),
            enableProtectedStrictSlots ? protectedStrictSlots : undefined,
          );

          if (!cycle4AnchorGapFeasibility.feasible) {
            if (cycle4AnchorGapFeasibility.reason === 'next_anchor_timing_broken') {
              this.logBookingRule({
                rule: 'ANCHOR_APPEND_GATE_NEXT_POINT_BROKEN',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                hotspotId: Number((sh as any).hotspot_ID || 0),
                nextAnchorHotspotId: cycle4AnchorGapFeasibility.nextAnchorHotspotId,
                nextAnchorStartTime: cycle4AnchorGapFeasibility.nextAnchorStartSeconds !== undefined
                  ? secondsToTime(wrapToDay(cycle4AnchorGapFeasibility.nextAnchorStartSeconds))
                  : null,
                projectedArrivalAtNextAnchor: cycle4AnchorGapFeasibility.arrivalAtNextAnchorSeconds !== undefined
                  ? secondsToTime(wrapToDay(cycle4AnchorGapFeasibility.arrivalAtNextAnchorSeconds))
                  : null,
              });
            }

            this.logBookingRule({
              rule: 'ANCHOR_APPEND_GATE_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: Number((sh as any).hotspot_ID || 0),
              reason: cycle4AnchorGapFeasibility.reason || 'anchor_append_gate_rejected',
            });

            this.logBookingRule({
              rule: 'CYCLE4_RELAXED_FILL_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: Number((sh as any).hotspot_ID || 0),
              reason: cycle4AnchorGapFeasibility.reason || 'anchor_append_gate_rejected',
            });
            continue;
          }

          const currentOrder = order;
          const travelLocationType = this.getTravelLocationType(
            currentLocationName,
            hotspotLocationName,
          );

          if (
            rejectDuplicatePlanHotspot((sh as any).hotspot_ID, {
              routeId: Number(route.itinerary_route_ID || 0),
              routeDay: Number((route as any).no_of_days || routeIndex || 0),
              sourceCity,
              destinationCity,
              branch: 'empty_intercity_emergency_fill',
              hotspotName: String((hotspotData as any)?.hotspot_name || (sh as any)?.hotspot_name || ''),
            })
          ) {
            continue;
          }

          const { row: travelRow, nextTime: tToHotspot } =
            await this.travelBuilder.buildTravelSegment(tx, {
              planId,
              routeId: route.itinerary_route_ID,
              order: currentOrder,
              item_type: 3,
              travelLocationType,
              startTime: currentTime,
              userId: createdByUserId,
              sourceLocationName: currentLocationName,
              destinationLocationName: hotspotLocationName,
              hotspotId: (sh as any).hotspot_ID,
              fromHotspotId: lastAddedHotspotId ?? undefined,
              sourceCoords: currentCoords,
              destCoords,
            });

          hotspotRows.push(
            this.dataAccessService.normalizeTravelRowDistance(
              travelRow,
              currentLocationName,
              hotspotLocationName,
            ),
          );
          currentTime = tToHotspot;

          const gapBeforeVisitSeconds = Math.max(0, timeToSeconds(timeAfterTravel) - timeToSeconds(currentTime));
          if (gapBeforeVisitSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
            hotspotRows.push(
              this.buildFreeTimeBreakRow({
                planId,
                routeId: route.itinerary_route_ID,
                order: currentOrder,
                startTime: currentTime,
                endTime: timeAfterTravel,
                userId: createdByUserId,
              }),
            );
            currentTime = timeAfterTravel;
          }

          if (timeToSeconds(timeAfterTravel) > timeToSeconds(currentTime)) {
            currentTime = timeAfterTravel;
          }

          currentLocationName = hotspotLocationName;
          currentCoords = destCoords;

          const { row: hotspotRow, nextTime: tAfterHotspot } =
            await this.hotspotBuilder.build(tx, {
              planId,
              routeId: route.itinerary_route_ID,
              order: currentOrder,
              hotspotId: (sh as any).hotspot_ID,
              startTime: currentTime,
              userId: createdByUserId,
              totalAdult: plan.total_adult,
              totalChildren: plan.total_children,
              totalInfants: plan.total_infants,
              nationality: plan.nationality,
              itineraryPreference: plan.itinerary_preference,
              isConflict: false,
              conflictReason: '',
            });

          hotspotRows.push(hotspotRow);
          routePlannedHotspotIds.add(Number((sh as any).hotspot_ID || 0));
          markHotspotAsPlanned((sh as any).hotspot_ID);
          if (carryForwardHotspots.some((h) => Number((h as any).hotspot_ID || 0) === Number((sh as any).hotspot_ID || 0))) {
            carryForwardHotspots = carryForwardHotspots.filter(
              (h) => Number((h as any).hotspot_ID || 0) !== Number((sh as any).hotspot_ID || 0),
            );
            this.logBookingRule({
              rule: 'STRICT_CARRY_FORWARD_CONSUMED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              consumedHotspotIds: [Number((sh as any).hotspot_ID || 0)],
              reason: 'Carried strict hotspot scheduled during cycle-4 relaxed fill and removed from queue.',
            });
          }
          lastAddedHotspotId = (sh as any).hotspot_ID;
          order++;
          currentTime = tAfterHotspot;
          addedInCurrentCycle = true;

          const parkingRowsForHotspot = await this.parkingBuilder.buildForHotspot(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: (sh as any).hotspot_ID,
            userId: createdByUserId,
          });

          if (parkingRowsForHotspot && parkingRowsForHotspot.length > 0) {
            parkingRows.push(...parkingRowsForHotspot);
          }

          this.logBookingRule({
            rule: 'ANCHOR_APPEND_GATE_ACCEPTED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: Number((sh as any).hotspot_ID || 0),
            startTime: timeAfterTravel,
            endTime: timeAfterSightseeing,
          });

          this.logBookingRule({
            rule: 'CYCLE4_RELAXED_FILL_ACCEPTED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            hotspotId: Number((sh as any).hotspot_ID || 0),
            visitTime: `${timeAfterTravel} - ${timeAfterSightseeing}`,
          });
        }
      } else if (optimizationCycle === MAX_SCHEDULER_OPTIMIZATION_CYCLES) {
        this.logBookingRule({
          rule: 'CYCLE4_RELAXED_FILL_SKIPPED_SCOPE',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          cycle: optimizationCycle,
          reason: 'Cycle4 relaxed fill is scoped to same-city routes only.',
          sourceCity: String(sourceCity || currentLocationName),
          destinationCity: String(destinationCity || route.next_visiting_location || currentLocationName),
        });
      }
      const stateHash = buildSchedulingStateHash();
      const cycleMadeProgress = addedInCurrentCycle || stateHash !== previousCycleStateHash;

      this.logBookingRule({
        rule: 'SCHEDULER_CYCLE_SUMMARY',
        quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
        planId,
        routeId: route.itinerary_route_ID,
        cycle: optimizationCycle,
        addedInCurrentCycle,
        cycleMadeProgress,
        previousCycleStateHash,
        stateHash,
        strictTotal: strictHotspotIdSet.size,
        strictUnscheduled: unscheduledStrictIds.length,
        fillerRemaining: remainingFillerHotspotIds.length,
        fillerRemainingSample: remainingFillerHotspotIds.slice(0, 10),
      });

      if (unscheduledStrictIds.length === 0) {
        const pendingPositiveCorridorIds = (corridorHotspots as Array<SelectedHotspot>)
          .filter((hs: any) => {
            const id = Number((hs as any).hotspot_ID || 0);
            const p = Number((hs as any).hotspot_priority ?? 0);
            return id > 0 && p >= 1 && p < 9999 && !isHotspotAlreadyPlanned(id);
          })
          .map((hs: any) => Number((hs as any).hotspot_ID || 0));
        if (isIntercityNonDirectRoute && pendingPositiveCorridorIds.length > 0) {
          this.logBookingRule({
            rule: 'FILLER_BLOCKED_CORRIDOR_PENDING',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            pendingPositiveCorridorIds,
            reason: 'positive_priority_corridor_pending_before_filler',
          });
        }
        const hasPendingNonStrictCandidates =
          remainingFillerHotspotIds.length > 0 ||
          deferredPriorityHotspotIds.size > 0 ||
          rejectedRetryHotspotIds.size > 0;

        if (
          hasPendingNonStrictCandidates &&
          optimizationCycle < MAX_SCHEDULER_OPTIMIZATION_CYCLES
        ) {
          this.logBookingRule({
            rule: 'SCHEDULER_CONTINUE_NON_STRICT_CYCLES',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            reason: 'Strict hotspots are satisfied, but filler/deferred/retry candidates remain; continue bounded optimization cycles.',
            fillerRemaining: remainingFillerHotspotIds.length,
            deferredRemaining: deferredPriorityHotspotIds.size,
            rejectedRetryRemaining: rejectedRetryHotspotIds.size,
          });
          previousCycleStateHash = stateHash;
          optimizationCycle++;
          continue;
        }

        if (isCycle4GapFillRoute && optimizationCycle < MAX_SCHEDULER_OPTIMIZATION_CYCLES) {
          this.logBookingRule({
            rule: 'SCHEDULER_CONTINUE_TO_CYCLE4_GAP_FILL',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            reason: 'Strict hotspots are satisfied; continue until cycle 4 to run isolated same-city gap fill pass.',
          });
          previousCycleStateHash = stateHash;
          optimizationCycle++;
          continue;
        }

        this.logBookingRule({
          rule: 'SCHEDULER_EXIT_NO_STRICT_PENDING',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          cycle: optimizationCycle,
          reason: 'No strict hotspots pending; optimization loop exits by design even when filler hotspots remain.',
          fillerRemaining: remainingFillerHotspotIds.length,
          fillerRemainingSample: remainingFillerHotspotIds.slice(0, 10),
        });
        this.logBookingRule({
          rule: 'MUST_VISIT_GUARANTEE_SATISFIED',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          cycle: optimizationCycle,
        });
        break;
      }

      if (!cycleMadeProgress && mustVisitRepairAttempts < MAX_MUST_VISIT_REPAIR_ATTEMPTS) {
        const repairQueued: number[] = [];
        for (const hotspotId of unscheduledStrictIds) {
          const hotspot = strictPassHotspots.find((h) => Number((h as any).hotspot_ID || 0) === hotspotId);
          if (!hotspot) continue;
          if (isHotspotAlreadyPlanned(hotspotId)) continue;
          if (deferredPriorityHotspotIds.has(hotspotId) || rejectedRetryHotspotIds.has(hotspotId)) continue;
          deferredPriorityHotspots.push(hotspot);
          deferredPriorityHotspotIds.add(hotspotId);
          rejectedRetryHotspots.push(hotspot);
          rejectedRetryHotspotIds.add(hotspotId);
          repairQueued.push(hotspotId);
        }

        if (repairQueued.length > 0) {
          mustVisitRepairAttempts++;
          this.logBookingRule({
            rule: 'MUST_VISIT_REPAIR_CYCLE_QUEUED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: optimizationCycle,
            repairAttempt: mustVisitRepairAttempts,
            unscheduledStrictIds,
            queuedForRepair: repairQueued,
            reason: 'No further scheduling progress; forcing must-visit retry queues for repair cycle.',
          });
        }
      } else if (!cycleMadeProgress || optimizationCycle >= MAX_SCHEDULER_OPTIMIZATION_CYCLES) {
        if (nextRouteSameCityContinuation && unscheduledStrictIds.length > 0) {
          const carryQueuedIds: number[] = [];
          const carryExistingIds = new Set<number>(
            carryForwardHotspots
              .map((h) => Number((h as any).hotspot_ID || 0))
              .filter((id) => id > 0),
          );

          for (const hotspotId of unscheduledStrictIds) {
            if (carryExistingIds.has(hotspotId) || isHotspotAlreadyPlanned(hotspotId)) continue;
            const strictHotspot = strictPassHotspots.find((h) => Number((h as any).hotspot_ID || 0) === hotspotId);
            if (!strictHotspot) continue;
            const master = hotspotMap.get(hotspotId) as any;
            const protectedSlot = protectedStrictSlots.find(
              (slot) => slot.routeId === Number(route.itinerary_route_ID || 0) && slot.hotspotId === hotspotId,
            );

            const carryCandidate: CarryForwardHotspot = {
              ...(strictHotspot as any),
              hotspot_name: String((strictHotspot as any).hotspot_name || master?.hotspot_name || ''),
              hotspot_location: String((strictHotspot as any).hotspot_location || master?.hotspot_location || ''),
              hotspot_to_location: String(
                (strictHotspot as any).hotspot_to_location ||
                  master?.hotspot_to_location ||
                  master?.hotspot_location ||
                  '',
              ),
              carryOrder: carryForwardOrder,
              carriedFromRouteId: Number(route.itinerary_route_ID || 0),
              carriedFromDate: String((route as any).itinerary_route_date || ''),
              carriedFromRouteDay: Number((route as any).no_of_days || routeIndex || 0),
              carriedFromRouteSourceCity: sourceCity,
              carriedFromRouteDestinationCity: destinationCity,
            };

            const nextRouteContext: CarryForwardRouteContext | null = nextRoute
              ? {
                  routeId: Number((nextRoute as any).itinerary_route_ID || 0),
                  routeDay: Number((nextRoute as any).no_of_days || 0),
                  sourceCity: String((nextRoute as any).location_name || ''),
                  destinationCity: String((nextRoute as any).next_visiting_location || ''),
                }
              : null;

            if (nextRouteContext) {
              const compatibility = this.isCarryForwardHotspotCompatibleWithRoute(carryCandidate as any, nextRouteContext);
              if (!compatibility.compatible) {
                this.logBookingRule({
                  rule: 'CARRY_FORWARD_QUEUE_REJECTED_ROUTE_MISMATCH',
                  quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                  planId,
                  routeId: route.itinerary_route_ID,
                  nextRouteId: nextRouteContext.routeId,
                  nextRouteDay: nextRouteContext.routeDay,
                  nextRouteSource: nextRouteContext.sourceCity,
                  nextRouteDestination: nextRouteContext.destinationCity,
                  hotspotId,
                  hotspotName: carryCandidate.hotspot_name,
                  hotspotLocation: compatibility.hotspotLocation,
                  hotspotToLocation: compatibility.hotspotToLocation,
                  reason: compatibility.reason,
                });
                continue;
              }
            }

            carryForwardHotspots.push({
              ...carryCandidate,
              carryOrder: carryForwardOrder++,
              carriedProtectedSlotStartSeconds: protectedSlot?.startSeconds,
              carriedProtectedSlotEndSeconds: protectedSlot?.endSeconds,
            });
            carryQueuedIds.push(hotspotId);
            carryExistingIds.add(hotspotId);
          }

          if (carryQueuedIds.length > 0) {
            this.logBookingRule({
              rule: 'STRICT_CARRY_FORWARD_QUEUED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              nextRouteId: Number((nextRoute as any)?.itinerary_route_ID || 0),
              queuedHotspotIds: carryQueuedIds,
              reason: 'Queued unresolved strict hotspots for immediate next same-city continuation route.',
            });
          }
        } else {
          if (carryForwardHotspots.length > 0) {
            this.logBookingRule({
              rule: 'STRICT_CARRY_FORWARD_EXPIRED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              pendingHotspotIds: carryForwardHotspots.map((h) => Number((h as any).hotspot_ID || 0)).filter((id) => id > 0),
              reason: 'Same-city continuation unavailable while strict carry-forward remained unresolved.',
            });
            carryForwardHotspots = [];
          }

          this.logBookingRule({
            rule: 'MUST_VISIT_GUARANTEE_UNRESOLVED',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            unscheduledStrictIds,
            repairAttempts: mustVisitRepairAttempts,
            maxCycles: MAX_SCHEDULER_OPTIMIZATION_CYCLES,
            reason: 'Must-visit hotspots remain unscheduled after bounded optimization/repair cycles.',
          });
        }

        break;
      }

      previousCycleStateHash = stateHash;
      optimizationCycle++;
      } // End of optimization cycles

      // ================================================================
      // CYCLE 5: MANUAL_HOTSPOT_FORCE_INSERT
      // ================================================================
      // Force-insert any remaining manual hotspots by removing lower-priority auto hotspots if needed
      {
        if (this.verboseTimelineProofLogs) {
          this.logBookingRule({
            rule: 'CYCLE5_MANUAL_HOTSPOT_FORCE_INSERT_START',
            quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
            planId,
            routeId: route.itinerary_route_ID,
            cycle: 5,
          });
        }

        // Find manual hotspots that haven't been added yet
        const manualHotspotsOnRoute = (selectedHotspots as Array<SelectedHotspot>)
          .filter((h) => (h as any).isManualSelection === true)
          .filter((h) => !isHotspotAlreadyPlanned(Number((h as any).hotspot_ID || 0)));

        for (const manualHotspot of manualHotspotsOnRoute) {
          const manualHotspotId = Number((manualHotspot as any).hotspot_ID || 0);
          if (manualHotspotId <= 0) continue;

          if (this.verboseTimelineProofLogs) {
            this.logBookingRule({
              rule: 'CYCLE5_ATTEMPTING_MANUAL_HOTSPOT_INSERT',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              manualHotspotId,
              currentTime,
            });
          }

          const hotspotData = hotspotMap.get(manualHotspotId);
          if (!hotspotData) {
            this.logBookingRule({
              rule: 'CYCLE5_MANUAL_HOTSPOT_REJECTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              manualHotspotId,
              reason: 'missing_hotspot_metadata',
            });
            continue;
          }

          const hotspotLocationName = (hotspotData.hotspot_location as string) || currentLocationName;
          const hotspotDuration = hotspotData.hotspot_duration || '01:00:00';
          const hotspotType = String(hotspotData.hotspot_type || hotspotData.hotspotType || '').trim().toLowerCase();
          const destCoords = {
            lat: Number(hotspotData.hotspot_latitude ?? 0),
            lon: Number(hotspotData.hotspot_longitude ?? 0),
          };

          const sharedManualFeasibility = await this.evaluateCandidateInsertion({
            tx,
            route,
            isLastRoute,
            routeStartSeconds,
            routeEndSeconds,
            currentTime,
            currentLocationName,
            currentCoords,
            destinationCoords: destCityCoords,
            dayOfWeek: (route.itinerary_route_date
              ? new Date(route.itinerary_route_date).getDay()
              : 0 + 6) % 7,
            hotspotId: manualHotspotId,
            hotspotLocationName,
            hotspotDuration,
            hotspotCoords: destCoords,
            hotspotPriority: Number((hotspotData as any).hotspot_priority ?? 0),
            timingMap,
            plan,
            destinationCity,
            lastRouteArrivalDeadlineSeconds,
            allowWaitUntilOpen: true,
            rejectIfOutsideOperatingWindow: false, // Very permissive for manual
            hotspotType,
          });

          let canInsert = sharedManualFeasibility.feasible;

          // If direct insert failed, try removing lower-priority auto hotspots
          if (!canInsert) {
            this.logBookingRule({
              rule: 'CYCLE5_DIRECT_INSERT_FAILED_ATTEMPTING_EVICTION',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              manualHotspotId,
              reason: sharedManualFeasibility.reason || 'shared_feasibility_rejected',
            });

            // Collect all auto-hotspots on this route (not manual, prefer removing lower priority first)
            const autoHotspotsOnRoute: Array<{ hotspotId: number; rowIndex: number; priority: number; hotspotRow: any }> = [];
            for (let i = 0; i < hotspotRows.length; i++) {
              const row = hotspotRows[i];
              if (
                Number((row as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) &&
                Number((row as any).item_type || 0) === 4 // Only hotspot segments
              ) {
                const rowHotspotId = Number((row as any).hotspot_ID || 0);
                if (rowHotspotId > 0 && rowHotspotId !== manualHotspotId) {
                  const rowHotspotData = hotspotMap.get(rowHotspotId);
                  const priority = Number((rowHotspotData as any)?.hotspot_priority ?? 0);
                  autoHotspotsOnRoute.push({
                    hotspotId: rowHotspotId,
                    rowIndex: i,
                    priority,
                    hotspotRow: row,
                  });
                }
              }
            }

            // Sort by priority (lowest first) so we remove the least important ones
            autoHotspotsOnRoute.sort((a, b) => a.priority - b.priority);

            // Try removing hotspots until we have space
            for (const autoHotspot of autoHotspotsOnRoute) {
              // Remove the travel segment before this hotspot (item_type = 3)
              let travelRowIndex = -1;
              for (let i = autoHotspot.rowIndex - 1; i >= 0; i--) {
                const row = hotspotRows[i];
                if (!row) continue; // indices may be stale after a prior splice
                if (
                  Number((row as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) &&
                  Number((row as any).item_type || 0) === 3 // Travel segment
                ) {
                  travelRowIndex = i;
                  break;
                }
              }

              // Remove the hotspot and its travel segment
              if (travelRowIndex >= 0) {
                hotspotRows.splice(travelRowIndex, 2); // Remove travel + hotspot
              } else {
                hotspotRows.splice(autoHotspot.rowIndex, 1); // Just remove hotspot
              }

              addedHotspotIds.delete(autoHotspot.hotspotId);

              this.logBookingRule({
                rule: 'CYCLE5_EVICTED_AUTO_HOTSPOT_FOR_MANUAL',
                quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                planId,
                routeId: route.itinerary_route_ID,
                evictedHotspotId: autoHotspot.hotspotId,
                evictedPriority: autoHotspot.priority,
                manualHotspotId,
              });

              // Recalculate timing for manual hotspot after eviction
              const reevaluatedManualFeasibility = await this.evaluateCandidateInsertion({
                tx,
                route,
                isLastRoute,
                routeStartSeconds,
                routeEndSeconds,
                currentTime,
                currentLocationName,
                currentCoords,
                destinationCoords: destCityCoords,
                dayOfWeek: (route.itinerary_route_date
                  ? new Date(route.itinerary_route_date).getDay()
                  : 0 + 6) % 7,
                hotspotId: manualHotspotId,
                hotspotLocationName,
                hotspotDuration,
                hotspotCoords: destCoords,
                hotspotPriority: Number((hotspotData as any).hotspot_priority ?? 0),
                timingMap,
                plan,
                destinationCity,
                lastRouteArrivalDeadlineSeconds,
                allowWaitUntilOpen: true,
                rejectIfOutsideOperatingWindow: false,
                hotspotType,
              });

              if (reevaluatedManualFeasibility.feasible) {
                canInsert = true;
                break;
              }
            }
          }

          // Now insert the manual hotspot if we have space
          if (canInsert) {
            if (
              rejectDuplicatePlanHotspot(manualHotspotId, {
                routeId: Number(route.itinerary_route_ID || 0),
                routeDay: Number((route as any).no_of_days || routeIndex || 0),
                sourceCity,
                destinationCity,
                branch: 'manual_hotspot_force_insert',
                hotspotName: String((hotspotData as any)?.hotspot_name || ''),
              })
            ) {
              continue;
            }

            const timeAfterTravel = sharedManualFeasibility.timeAfterTravel || currentTime;
            const timeAfterSightseeing = sharedManualFeasibility.timeAfterSightseeing || timeAfterTravel;
            const currentOrder = order;

            // Recalculate current state after any evictions
            let cycle5CurrentSeconds = timeToSeconds(currentTime);
            if (cycle5CurrentSeconds < routeStartSeconds) {
              cycle5CurrentSeconds += 86400;
            }

            const travelLocationType = this.getTravelLocationType(currentLocationName, hotspotLocationName);
            const { row: travelRow, nextTime: tToHotspot } =
              await this.travelBuilder.buildTravelSegment(tx, {
                planId,
                routeId: route.itinerary_route_ID,
                order: currentOrder,
                item_type: 3,
                travelLocationType,
                startTime: currentTime,
                userId: createdByUserId,
                sourceLocationName: currentLocationName,
                destinationLocationName: hotspotLocationName,
                hotspotId: manualHotspotId,
                fromHotspotId: lastAddedHotspotId ?? undefined,
                sourceCoords: currentCoords,
                destCoords,
              });

            hotspotRows.push(
              this.dataAccessService.normalizeTravelRowDistance(
                travelRow,
                currentLocationName,
                hotspotLocationName,
              ),
            );
            currentTime = tToHotspot;

            const gapBeforeVisitSeconds = Math.max(0, timeToSeconds(timeAfterTravel) - timeToSeconds(currentTime));
            if (gapBeforeVisitSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
              hotspotRows.push(
                this.buildFreeTimeBreakRow({
                  planId,
                  routeId: route.itinerary_route_ID,
                  order: currentOrder,
                  startTime: currentTime,
                  endTime: timeAfterTravel,
                  userId: createdByUserId,
                }),
              );
              currentTime = timeAfterTravel;
            }

            if (timeToSeconds(timeAfterTravel) > timeToSeconds(currentTime)) {
              currentTime = timeAfterTravel;
            }

            currentLocationName = hotspotLocationName;
            currentCoords = destCoords;

            const { row: hotspotRow, nextTime: tAfterHotspot } =
              await this.hotspotBuilder.build(tx, {
                planId,
                routeId: route.itinerary_route_ID,
                order: currentOrder,
                hotspotId: manualHotspotId,
                startTime: currentTime,
                userId: createdByUserId,
                totalAdult: plan.total_adult,
                totalChildren: plan.total_children,
                totalInfants: plan.total_infants,
                nationality: plan.nationality,
                itineraryPreference: plan.itinerary_preference,
                isConflict: false,
                conflictReason: '',
              });

            hotspotRows.push(hotspotRow);
            markHotspotAsPlanned(manualHotspotId);
            lastAddedHotspotId = manualHotspotId;
            order++;
            currentTime = tAfterHotspot;

            const parkingRowsForManual = await this.parkingBuilder.buildForHotspot(tx, {
              planId,
              routeId: route.itinerary_route_ID,
              hotspotId: manualHotspotId,
              userId: createdByUserId,
            });

            if (parkingRowsForManual && parkingRowsForManual.length > 0) {
              parkingRows.push(...parkingRowsForManual);
            }

            this.logBookingRule({
              rule: 'CYCLE5_MANUAL_HOTSPOT_FORCE_INSERTED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              manualHotspotId,
              startTime: timeAfterTravel,
              endTime: timeAfterSightseeing,
            });
          } else {
            this.logBookingRule({
              rule: 'CYCLE5_MANUAL_HOTSPOT_FORCE_INSERT_FAILED',
              quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
              planId,
              routeId: route.itinerary_route_ID,
              manualHotspotId,
              reason: 'Could not insert even after removing lower-priority auto hotspots',
              currentTime,
            });
          }
        }
      }

      {
        let currentSeconds = timeToSeconds(currentTime);
        if (currentSeconds < routeStartSeconds) {
          currentSeconds += 86400;
        }

        const hasScheduledVisitOnRoute = hotspotRows.some(
          (row) =>
            Number((row as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) &&
            Number((row as any).item_type || 0) === 4,
        );
        let trailingGapEndSeconds = routeEndSeconds;

        if (!isLastRoute) {
          const trailingSourceCity = currentLocationName.split('|')[0].trim();
          const trailingDestinationCity = String(
            (route.next_visiting_location as string) || currentLocationName,
          ).split('|')[0].trim();
          const trailingHotelTravel = await this.distanceHelper.fromSourceAndDestination(
            tx,
            trailingSourceCity,
            trailingDestinationCity,
            2,
            addedHotspotIds.size > 0 ? currentCoords : undefined,
            addedHotspotIds.size > 0 ? destCityCoords : undefined,
          );
          const trailingHotelTravelSeconds =
            timeToSeconds(trailingHotelTravel.travelTime) +
            timeToSeconds(trailingHotelTravel.bufferTime);

          trailingGapEndSeconds = Math.max(
            currentSeconds,
            routeEndSeconds - trailingHotelTravelSeconds,
          );
        }

        const trailingRemainingGapSeconds = trailingGapEndSeconds - currentSeconds;

        const canAddTrailingLeisure =
          !isLastRoute &&
          !forceNoSightseeingOnThisRoute &&
          !isVehicleHotelRestEarlyArrival &&
          (!didHotelFirstCheckin || shouldHotelLastByDistance) &&
          (hasScheduledVisitOnRoute || selectedHotspots.length > 0);

        if (
          trailingRemainingGapSeconds >= FREE_TIME_THRESHOLD_SECONDS &&
          canAddTrailingLeisure
        ) {
          const leisureEndTime = secondsToTime(wrapToDay(trailingGapEndSeconds));
          const leisureRow = this.buildFreeTimeBreakRow({
            planId,
            routeId: route.itinerary_route_ID,
            order: order++,
            startTime: currentTime,
            endTime: leisureEndTime,
            userId: createdByUserId,
          });
          leisureRow.via_location_name = 'Leisure / Shopping Time';
          hotspotRows.push(leisureRow);
          currentTime = leisureEndTime;

          this.logBookingRule({
            rule: 'FREE_TIME_INSERTED_BEFORE_HOTEL',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            gapStart: leisureRow.hotspot_start_time,
            gapEnd: leisureRow.hotspot_end_time,
            gapMinutes: Math.floor(trailingRemainingGapSeconds / 60),
            routeEndTime,
          });
        }
      }
      
      this.logTimeline('[TIMELINE] Other days loop stats - Queries:', hotspotQueryCount, '| Distance calcs:', distanceCalcCount, '| Operating hours:', operatingHoursCount, '| Time:', Date.now() - routeLoopStart, 'ms');
      } // End of else (OTHER DAYS)

      // ✅ RULE 2 + 3: TRAVEL TO HOTEL & FIX TIME BUG (item_type = 5)
      // BUSINESS RULE: Hotel check-in must be before 10 PM (22:00)
      // Last route SKIPS hotel rows
      if (!isLastRoute) {
        if (suppressHotelInsertionUntilEndOfDay) {
          this.logBookingRule({
            rule: 'HOTEL_SEGMENT_ALLOWED_AT_END_OF_DAY',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            reason:
              'Arrival policy requires sightseeing first: hotel insertion deferred until end-of-day block.',
            currentTime,
          });
        }

        if (didHotelFirstCheckin && !shouldHotelLastByDistance) {
          // Hotel-first already done; skip duplicate end-of-route hotel check-in rows.
          continue;
        }

        const hotelOrder = order;
        const hotelInfo =
          hotelInfoForRoute ??
          (await this.getHotelDetailsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
          ));

        // ✅ ALWAYS use DESTINATION CITY for distance calculation (not hotel coordinates)
        // This ensures consistent distance regardless of hotel selection
        // Parse pipe-separated location to get first/main location only
        const rawDestinationCity = (route.next_visiting_location as string) || currentLocationName;
        const destinationCity = rawDestinationCity.split('|')[0].trim();

        // Parse source location to remove pipe-separated alternatives
        const sourceCity = currentLocationName.split('|')[0].trim();
        
        // ✅ RULE 2: Always show final travel segment to destination (outstation type=2)
        // For early-arrival declined same-day flow, force hotel movement near end-of-day.
        let hotelStartTime = currentTime;

        if (suppressHotelInsertionUntilEndOfDay) {
          const estimatedHotelTravel = await this.distanceHelper.fromSourceAndDestination(
            tx,
            sourceCity,
            destinationCity,
            2,
            addedHotspotIds.size > 0 ? currentCoords : undefined,
            addedHotspotIds.size > 0 ? destCityCoords : undefined,
          );

          const estimatedHotelSegmentSeconds =
            timeToSeconds(estimatedHotelTravel.travelTime) +
            timeToSeconds(estimatedHotelTravel.bufferTime);

          const routeEndAnchoredStartSeconds = Math.max(
            timeToSeconds(currentTime),
            routeEndSeconds - estimatedHotelSegmentSeconds,
          );

          hotelStartTime = secondsToTime(wrapToDay(routeEndAnchoredStartSeconds));
        }

        if (
          suppressHotelInsertionUntilEndOfDay &&
          hotelStartTime !== currentTime
        ) {
          this.logBookingRule({
            rule: 'HOTEL_SEGMENT_ANCHORED_TO_END_OF_DAY',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            previousCurrentTime: currentTime,
            anchoredStartTime: hotelStartTime,
            routeEndTime,
          });
        }
        
        const { row: toHotelRow, nextTime: tAfterHotel } =
          await this.hotelBuilder.buildToHotel(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: hotelOrder,
            startTime: hotelStartTime,
            travelLocationType: 2, // Outstation to destination city
            userId: createdByUserId,
            sourceLocationName: sourceCity,
            destinationLocationName: destinationCity,
            // ✅ PHP PARITY: Only use coordinates (Haversine) if we actually visited hotspots.
            // If no hotspots were visited, PHP uses the direct city-to-city distance from DB.
            sourceCoords: addedHotspotIds.size > 0 ? currentCoords : undefined,
            destCoords: addedHotspotIds.size > 0 ? destCityCoords : undefined,
          });

        // ✅ RULE 3: Fix "06:58 AM" time bug using proper UTC date conversion
        // FIX: Hotel end time should be the actual arrival time from travel calculation,
        // NOT route_end_time. Route-end should only be a cutoff if we exceed it.
        let adjustedHotelRow = { ...toHotelRow };
        
        // Extract the computed hotel arrival time from the builder result
        // The builder's nextTime is the arrival at destination
        const hotelArrivalTimeWrapped = tAfterHotel;
        const hotelArrivalTimeSeconds = timeToSeconds(hotelArrivalTimeWrapped);
        const hotelStartTimeSeconds = timeToSeconds(hotelStartTime);

        // If wrapped arrival is earlier than start, treat it as next-day arrival.
        let hotelArrivalAbsoluteSeconds = hotelArrivalTimeSeconds;
        if (hotelArrivalAbsoluteSeconds < hotelStartTimeSeconds) {
          hotelArrivalAbsoluteSeconds += 86400;
        }
        
        // Log the calculation for proof
        if (this.verboseTimelineProofLogs) {
          const routeEndSeconds_local = timeToSeconds(routeEndTime);
          console.log('[TimelineBuilder][PROOF] Hotel travel and checkin calculation', {
            planId,
            routeId: route.itinerary_route_ID,
            hotelTravelStart: hotelStartTime,
            hotelTravelEnd: hotelArrivalTimeWrapped,
            hotelArrivalSeconds: hotelArrivalTimeSeconds,
            hotelArrivalAbsoluteSeconds,
            routeEndSeconds: routeEndSeconds_local,
            exceeds: hotelArrivalAbsoluteSeconds > routeEndSeconds_local,
            excessMinutes: hotelArrivalAbsoluteSeconds > routeEndSeconds_local ?
              Math.floor((hotelArrivalAbsoluteSeconds - routeEndSeconds_local) / 60) : 0,
          });
        }
        
        // Latest allowed arrival is the route's configured end time (route_end_time).
        const hotelCutoffSeconds = routeEndSeconds;
        
        // Use the actual arrival time, but respect the route cutoff
        const finalHotelEndSeconds = Math.min(hotelArrivalAbsoluteSeconds, hotelCutoffSeconds);
        const finalHotelEndTime = secondsToTime(wrapToDay(finalHotelEndSeconds));
        
        // Ensure start time uses proper UTC conversion
        adjustedHotelRow.hotspot_start_time = TimeConverter.toDate(hotelStartTime);
        adjustedHotelRow.hotspot_end_time = TimeConverter.toDate(finalHotelEndTime);

        hotspotRows.push(adjustedHotelRow);
        const adjustedHotelEndTime = finalHotelEndTime;
        currentTime = adjustedHotelEndTime;
        currentLocationName = "Hotel";
        if (hotelInfo?.coords) {
          currentCoords = hotelInfo.coords;
        }

        // 4) RETURN / CLOSING ROW FOR HOTEL (item_type = 6)
        // FIX: Checkin time should be the hotel arrival time, not route_end_time
        const { row: closeHotelRow, nextTime: tClose } =
          await this.hotelBuilder.buildReturnToHotel(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: hotelOrder,
            startTime: adjustedHotelEndTime,  // Use the actual arrival time
            userId: createdByUserId,
          });

        // Log checkin for proof
        if (this.verboseTimelineProofLogs) {
          console.log('[TimelineBuilder][PROOF] Hotel checkin anchoring', {
            planId,
            routeId: route.itinerary_route_ID,
            hotelArrivalWrapped: adjustedHotelEndTime,
            checkinTime: closeHotelRow.hotspot_start_time,
            checkinEndTime: closeHotelRow.hotspot_end_time,
            anchoredToArrival: true,
            previouslyWronglyAnchoredToRouteEnd: false,
          });
        }

        hotspotRows.push(closeHotelRow);
        order++;
        currentTime = tClose;

        this.logBookingRule({
          rule: 'DAY2_VALARA_RCA_SUMMARY',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          acceptedOrder: hotspotRows
            .filter((r: any) => Number((r as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) && Number((r as any).item_type || 0) === 4)
            .map((r: any) => Number((r as any).hotspot_ID || 0)),
          cheeyapparaAdded: isHotspotAlreadyPlanned(228),
          valaraAdded: isHotspotAlreadyPlanned(357),
          valaraInsertedBy: null,
          cheeyapparaRejectedReasons: [],
          conclusion: 'diagnostics_only_rca_trace',
        });
      }

      // 5.a) LAST ROUTE EMPTY-DAY RESCUE
      //
      // Case-06 pattern:
      // Last route Mahabalipuram -> Chennai has a large free gap before final
      // transfer, and runner proves timing-fit candidates exist, but normal
      // scheduling inserted no hotspots.
      //
      // This rescue is intentionally narrow:
      // - last route only
      // - only when this route has zero attraction rows
      // - only candidates already selected/classified for this route
      // - still respects duplicate guard, operating hours, route end, and
      //   final departure/arrival deadline.
      if (isLastRoute) {
        const currentRouteId = Number(route.itinerary_route_ID || 0);

        const hasAttractionOnCurrentRoute = hotspotRows.some(
          (row: any) =>
            Number((row as any).itinerary_route_ID || 0) === currentRouteId &&
            Number((row as any).item_type || 0) === 4 &&
            Number((row as any).hotspot_ID || 0) > 0,
        );

        if (!hasAttractionOnCurrentRoute && Array.isArray(selectedHotspots) && selectedHotspots.length > 0) {
          const departureCityNameForRescue = String(
            (plan.departure_location as string) ||
              destinationCity ||
              currentLocationName ||
              '',
          )
            .split('|')[0]
            .trim();

          const routeContextForRescue: CarryForwardRouteContext = {
            routeId: currentRouteId,
            routeDay: Number((route as any).no_of_days || routeIndex || 0),
            sourceCity,
            destinationCity,
          };

          const bucketRank = (bucketValue: any): number => {
            const bucket = String(bucketValue || '').toLowerCase();

            if (bucket === 'source' || bucket === 'source_fallback') return 1;
            if (
              bucket === 'via' ||
              bucket === 'en_route' ||
              bucket === 'corridor' ||
              bucket === 'matrix' ||
              bucket === 'source_to_destination'
            ) {
              return 2;
            }
            if (bucket === 'destination' || bucket === 'dest') return 3;
            return 4;
          };

          const rescueCandidates = [...(selectedHotspots as any[])]
            .filter((hs: any) => {
              const hotspotId = Number((hs as any).hotspot_ID || 0);
              if (!hotspotId) return false;
              if (isHotspotAlreadyPlanned(hotspotId)) return false;

              const master = hotspotMap.get(hotspotId) as any;
              const enriched = {
                ...hs,
                hotspot_location:
                  (hs as any).hotspot_location ||
                  master?.hotspot_location ||
                  '',
                hotspot_to_location:
                  (hs as any).hotspot_to_location ||
                  master?.hotspot_to_location ||
                  master?.hotspot_location ||
                  '',
              };

              const compatibility = this.isCarryForwardHotspotCompatibleWithRoute(
                enriched as any,
                routeContextForRescue,
              );

              return compatibility.compatible;
            })
            .sort((a: any, b: any) => {
              const bucketDiff =
                bucketRank((a as any).matched_bucket || (a as any).__bucket) -
                bucketRank((b as any).matched_bucket || (b as any).__bucket);
              if (bucketDiff !== 0) return bucketDiff;

              const ap = Number((a as any).hotspot_priority ?? 9999);
              const bp = Number((b as any).hotspot_priority ?? 9999);
              if (ap !== bp) return ap - bp;

              const ad = Number((a as any).hotspot_distance ?? 9999);
              const bd = Number((b as any).hotspot_distance ?? 9999);
              return ad - bd;
            });

          const rescueLimit = Math.max(
            1,
            Math.min(3, this.estimateRouteHotspotCapacity(route as any)),
          );

          let rescuedCount = 0;

          for (const sh of rescueCandidates) {
            if (rescuedCount >= rescueLimit) break;

            const hotspotId = Number((sh as any).hotspot_ID || 0);
            if (!hotspotId) continue;

            const hotspotData = hotspotMap.get(hotspotId) as any;
            if (!hotspotData) continue;

            if (
              rejectDuplicatePlanHotspot(hotspotId, {
                routeId: currentRouteId,
                routeDay: Number((route as any).no_of_days || routeIndex || 0),
                sourceCity,
                destinationCity,
                branch: 'last_route_empty_day_rescue',
                hotspotName: String(
                  hotspotData?.hotspot_name ||
                    (sh as any)?.hotspot_name ||
                    '',
                ),
              })
            ) {
              continue;
            }

            const hotspotLocationName = String(
              hotspotData.hotspot_location ||
                (sh as any).hotspot_location ||
                destinationCity ||
                currentLocationName,
            );

            const hotspotDuration = String(hotspotData.hotspot_duration || '01:00:00');
            const hotspotType = String(hotspotData.hotspot_type || hotspotData.hotspotType || '').trim().toLowerCase();

            const hotspotCoords = {
              lat: Number(hotspotData.hotspot_latitude ?? 0),
              lon: Number(hotspotData.hotspot_longitude ?? 0),
            };

            let currentAbsoluteSeconds = timeToSeconds(currentTime);
            if (currentAbsoluteSeconds < routeStartSeconds) {
              currentAbsoluteSeconds += 86400;
            }

            const travelToHotspotTime = await this.calculateTravelTimeWithCoords(
              tx,
              currentLocationName,
              hotspotLocationName,
              currentCoords,
              hotspotCoords,
            );

            const travelToHotspotSeconds = timeToSeconds(travelToHotspotTime);
            const hotspotDurationSeconds = timeToSeconds(hotspotDuration);

            let visitStartSeconds = currentAbsoluteSeconds + travelToHotspotSeconds;
            let visitEndSeconds = visitStartSeconds + hotspotDurationSeconds;

            if (visitEndSeconds > routeEndSeconds) {
              this.logHotspotCandidateEvaluation({
                routeId: currentRouteId,
                hotspotId,
                name: String(hotspotData.hotspot_name || `hotspot_${hotspotId}`),
                matchedBucket: (sh as any).matched_bucket ?? null,
                priority: Number((sh as any).hotspot_priority ?? 0),
                isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
                distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                  ? Number((sh as any).hotspot_distance)
                  : null,
                openingTime: null,
                closingTime: null,
                visitTime: `${secondsToTime(wrapToDay(visitStartSeconds))} - ${secondsToTime(wrapToDay(visitEndSeconds))}`,
                isOpenAtVisitTime: false,
                selected: false,
                rejectedReasons: [
                  'Rejected: last_route_empty_day_rescue visit exceeds route end',
                ],
              });
              continue;
            }

            const jsDay = route.itinerary_route_date
              ? new Date(route.itinerary_route_date).getDay()
              : 0;
            const dayOfWeek = (jsDay + 6) % 7;

            const timingSummary = this.getTimingWindowSummary(
              timingMap,
              hotspotId,
              dayOfWeek,
            );

            let operatingCheck = this.checkHotspotOperatingHoursFromMap(
              timingMap,
              hotspotId,
              dayOfWeek,
              visitStartSeconds,
              visitEndSeconds,
            );
            let openingWindowStartSeconds: number | null = null;

            if (
              !operatingCheck.canVisitNow &&
              operatingCheck.nextWindowStart &&
              this.shouldAllowWaitUntilOpenForCandidate(Number((sh as any).hotspot_priority ?? 0), hotspotType)
            ) {
              let nextWindowStartSeconds = timeToSeconds(operatingCheck.nextWindowStart);
              while (nextWindowStartSeconds < visitStartSeconds) {
                nextWindowStartSeconds += 86400;
              }

              const waitedVisitEndSeconds = nextWindowStartSeconds + hotspotDurationSeconds;

              if (waitedVisitEndSeconds <= routeEndSeconds) {
                const waitedCheck = this.checkHotspotOperatingHoursFromMap(
                  timingMap,
                  hotspotId,
                  dayOfWeek,
                  nextWindowStartSeconds,
                  waitedVisitEndSeconds,
                );

                if (waitedCheck.canVisitNow) {
                  visitStartSeconds = nextWindowStartSeconds;
                  visitEndSeconds = waitedVisitEndSeconds;
                  openingWindowStartSeconds = nextWindowStartSeconds;
                  operatingCheck = {
                    canVisitNow: true,
                    nextWindowStart: null,
                    isClosedForDay: false,
                  };
                }
              }
            }

            if (!operatingCheck.canVisitNow) {
              this.logHotspotCandidateEvaluation({
                routeId: currentRouteId,
                hotspotId,
                name: String(hotspotData.hotspot_name || `hotspot_${hotspotId}`),
                matchedBucket: (sh as any).matched_bucket ?? null,
                priority: Number((sh as any).hotspot_priority ?? 0),
                isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
                distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                  ? Number((sh as any).hotspot_distance)
                  : null,
                openingTime: timingSummary.openingTime,
                closingTime: timingSummary.closingTime,
                visitTime: `${secondsToTime(wrapToDay(visitStartSeconds))} - ${secondsToTime(wrapToDay(visitEndSeconds))}`,
                isOpenAtVisitTime: false,
                selected: false,
                rejectedReasons: [
                  operatingCheck.isClosedForDay
                    ? 'Rejected: last_route_empty_day_rescue closed on this day'
                    : (
                        !this.shouldAllowWaitUntilOpenForCandidate(Number((sh as any).hotspot_priority ?? 0), hotspotType)
                          ? `Rejected: wait-to-open disabled for priority ${Number((sh as any).hotspot_priority ?? 0)} hotspot`
                          : 'Rejected: last_route_empty_day_rescue outside operating hours'
                      ),
                ],
              });
              continue;
            }

            const candidateCity = hotspotLocationName.split('|')[0].trim();
            const travelToDepartureType = this.getTravelLocationType(
              candidateCity,
              departureCityNameForRescue,
            );

            const travelToDeparture = await this.distanceHelper.fromSourceAndDestination(
              tx,
              candidateCity,
              departureCityNameForRescue,
              travelToDepartureType,
              hotspotCoords,
              destCityCoords,
            );

            const travelToDepartureSeconds =
              timeToSeconds(travelToDeparture.travelTime) +
              timeToSeconds(travelToDeparture.bufferTime);

            const projectedArrivalAtDeparture =
              visitEndSeconds + travelToDepartureSeconds;

            if (projectedArrivalAtDeparture > lastRouteArrivalDeadlineSeconds) {
              this.logHotspotCandidateEvaluation({
                routeId: currentRouteId,
                hotspotId,
                name: String(hotspotData.hotspot_name || `hotspot_${hotspotId}`),
                matchedBucket: (sh as any).matched_bucket ?? null,
                priority: Number((sh as any).hotspot_priority ?? 0),
                isMustVisit: Number((sh as any).hotspot_priority ?? 0) > 0,
                distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                  ? Number((sh as any).hotspot_distance)
                  : null,
                openingTime: timingSummary.openingTime,
                closingTime: timingSummary.closingTime,
                visitTime: `${secondsToTime(wrapToDay(visitStartSeconds))} - ${secondsToTime(wrapToDay(visitEndSeconds))}`,
                isOpenAtVisitTime: false,
                selected: false,
                rejectedReasons: [
                  `Rejected: last_route_empty_day_rescue transfer to departure would end at ${secondsToTime(wrapToDay(projectedArrivalAtDeparture))}, beyond deadline ${secondsToTime(wrapToDay(lastRouteArrivalDeadlineSeconds))}`,
                ],
              });
              continue;
            }

            const isEarlyArrivalHotelDeparture =
              isHotelPreferenceEarlyArrival ||
              isVehicleHotelRestEarlyArrival;
            const currentOrder = order;
            let travelStartTime = currentTime;
            let alignedDepartureFromHotel = false;

            if (isEarlyArrivalHotelDeparture && openingWindowStartSeconds !== null) {
              const desiredDepartureSeconds = openingWindowStartSeconds - travelToHotspotSeconds;
              if (desiredDepartureSeconds > currentAbsoluteSeconds) {
                travelStartTime = secondsToTime(wrapToDay(desiredDepartureSeconds));
                alignedDepartureFromHotel = true;

                const hotelWaitSeconds = desiredDepartureSeconds - currentAbsoluteSeconds;
                if (hotelWaitSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
                  const hotelWaitRow = this.buildFreeTimeBreakRow({
                    planId,
                    routeId: currentRouteId,
                    order: currentOrder,
                    startTime: currentTime,
                    endTime: travelStartTime,
                    userId: createdByUserId,
                  });
                  hotelWaitRow.via_location_name =
                    `Wait at ${currentLocationName} before ${hotspotLocationName} opens`;
                  hotspotRows.push(hotelWaitRow);

                  this.logBookingRule({
                    rule: 'EARLY_ARRIVAL_HOTEL_DEPARTURE_ALIGNED_TO_OPENING',
                    quoteId:
                      (plan as any).quote_id ??
                      (plan as any).quoteId ??
                      (plan as any).quote_ID ??
                      null,
                    planId,
                    routeId: currentRouteId,
                    hotspotId,
                    sourceLocationName: currentLocationName,
                    destinationLocationName: hotspotLocationName,
                    departureTime: travelStartTime,
                    arrivalTime: secondsToTime(wrapToDay(visitStartSeconds)),
                    waitMinutes: Math.floor(hotelWaitSeconds / 60),
                  });
                }
              }
            }

            const travelLocationType = this.getTravelLocationType(
              currentLocationName,
              hotspotLocationName,
            );

            const { row: travelRow, nextTime: tToHotspot } =
              await this.travelBuilder.buildTravelSegment(tx, {
                planId,
                routeId: currentRouteId,
                order: currentOrder,
                item_type: 3,
                travelLocationType,
                startTime: travelStartTime,
                userId: createdByUserId,
                sourceLocationName: currentLocationName,
                destinationLocationName: hotspotLocationName,
                hotspotId,
                fromHotspotId: lastAddedHotspotId ?? undefined,
                sourceCoords: currentCoords,
                destCoords: hotspotCoords,
              });

            hotspotRows.push(
              this.dataAccessService.normalizeTravelRowDistance(
                travelRow,
                currentLocationName,
                hotspotLocationName,
              ),
            );
            currentTime = tToHotspot;

            const visitStartTime = secondsToTime(wrapToDay(visitStartSeconds));
            const visitEndTime = secondsToTime(wrapToDay(visitEndSeconds));

            const travelArrivalSeconds = timeToSeconds(tToHotspot);
            const visitStartWrappedSeconds = timeToSeconds(visitStartTime);

            if (!alignedDepartureFromHotel && visitStartWrappedSeconds > travelArrivalSeconds) {
              const waitGapSeconds = visitStartWrappedSeconds - travelArrivalSeconds;

              if (waitGapSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
                hotspotRows.push(
                  this.buildFreeTimeBreakRow({
                    planId,
                    routeId: currentRouteId,
                    order: currentOrder,
                    startTime: tToHotspot,
                    endTime: visitStartTime,
                    userId: createdByUserId,
                  }),
                );
              }

              currentTime = visitStartTime;
            }

            currentLocationName = hotspotLocationName;
            currentCoords = hotspotCoords;

            const { row: hotspotRow, nextTime: tAfterHotspot } =
              await this.hotspotBuilder.build(tx, {
                planId,
                routeId: currentRouteId,
                order: currentOrder,
                hotspotId,
                startTime: currentTime,
                userId: createdByUserId,
                totalAdult: plan.total_adult,
                totalChildren: plan.total_children,
                totalInfants: plan.total_infants,
                nationality: plan.nationality,
                itineraryPreference: plan.itinerary_preference,
                isConflict: false,
                conflictReason: '',
              });

            hotspotRows.push(hotspotRow);

            markHotspotAsPlanned(hotspotId);
            lastAddedHotspotId = hotspotId;
            order++;
            rescuedCount++;

            currentTime = tAfterHotspot;

            this.logBookingRule({
              rule: 'LAST_ROUTE_EMPTY_DAY_RESCUE_INSERTED',
              quoteId:
                (plan as any).quote_id ??
                (plan as any).quoteId ??
                (plan as any).quote_ID ??
                null,
              planId,
              routeId: currentRouteId,
              routeDay: Number((route as any).no_of_days || routeIndex || 0),
              sourceCity,
              destinationCity,
              departureCityName: departureCityNameForRescue,
              hotspotId,
              hotspotName: String(hotspotData.hotspot_name || ''),
              visitStartTime,
              visitEndTime,
              projectedArrivalAtDeparture: secondsToTime(
                wrapToDay(projectedArrivalAtDeparture),
              ),
              deadline: secondsToTime(wrapToDay(lastRouteArrivalDeadlineSeconds)),
              reason:
                'Last route had no attractions despite valid candidates. Inserted safe candidate before final transfer.',
            });

            const parkingRowsForHotspot = await this.parkingBuilder.buildForHotspot(tx, {
              planId,
              routeId: currentRouteId,
              hotspotId,
              userId: createdByUserId,
            });

            if (parkingRowsForHotspot && parkingRowsForHotspot.length > 0) {
              parkingRows.push(...parkingRowsForHotspot);
            }
          }

          if (rescuedCount === 0) {
            this.logBookingRule({
              rule: 'LAST_ROUTE_EMPTY_DAY_RESCUE_NO_FIT',
              quoteId:
                (plan as any).quote_id ??
                (plan as any).quoteId ??
                (plan as any).quote_ID ??
                null,
              planId,
              routeId: currentRouteId,
              routeDay: Number((route as any).no_of_days || routeIndex || 0),
              sourceCity,
              destinationCity,
              departureCityName: departureCityNameForRescue,
              candidateCount: rescueCandidates.length,
              deadline: secondsToTime(wrapToDay(lastRouteArrivalDeadlineSeconds)),
              reason:
                'Last-route rescue found candidates but none fit before final departure deadline.',
            });
          }
        }
      }

      // 5) LAST ROUTE ONLY → RETURN TO DEPARTURE LOCATION (item_type = 7)

      if (isLastRoute) {
        const departureCityName = String((plan.departure_location as string) || destinationCity || currentLocationName)
          .split('|')[0]
          .trim();

        let returnTrimGuard = 0;
        while (returnTrimGuard < 12) {
          const currentTimeSecondsForReturn = timeToSeconds(currentTime);
          const normalizedCurrentTimeSeconds =
            currentTimeSecondsForReturn < routeStartSeconds
              ? currentTimeSecondsForReturn + 86400
              : currentTimeSecondsForReturn;

          const estimatedReturnForFit = await this.distanceHelper.fromSourceAndDestination(
            tx,
            currentLocationName,
            departureCityName,
            this.getTravelLocationType(currentLocationName, departureCityName),
            currentCoords,
            destCityCoords,
          );
          const estimatedReturnSecondsForFit =
            timeToSeconds(estimatedReturnForFit.travelTime) +
            timeToSeconds(estimatedReturnForFit.bufferTime);

          if (normalizedCurrentTimeSeconds + estimatedReturnSecondsForFit <= lastRouteArrivalDeadlineSeconds) {
            break;
          }

          const lastAttractionIndex = [...hotspotRows]
            .map((row, idx) => ({ row, idx }))
            .filter(
              ({ row }) =>
                Number(row.item_type ?? 0) === 4 &&
                Number((row as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0),
            )
            .map(({ idx }) => idx)
            .pop();

          if (lastAttractionIndex == null) {
            break;
          }

          let removalStartIndex = lastAttractionIndex;
          while (removalStartIndex > 0) {
            const previousRow = hotspotRows[removalStartIndex - 1];
            if (
              Number(previousRow.item_type ?? 0) === 3 &&
              Number((previousRow as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0)
            ) {
              removalStartIndex -= 1;
              continue;
            }
            break;
          }

          const removedRows = hotspotRows.splice(removalStartIndex);
          for (const removedRow of removedRows) {
            if (Number(removedRow.item_type ?? 0) === 4 && Number(removedRow.hotspot_ID ?? 0) > 0) {
              addedHotspotIds.delete(Number(removedRow.hotspot_ID));
            }
          }

          currentTime = effectiveRouteStartTime;
          currentLocationName = routeStartLocationName;
          currentCoords = routeStartCoords
            ? { lat: routeStartCoords.lat, lon: routeStartCoords.lon }
            : currentCoords;

          for (const row of hotspotRows) {
            const rowEndTime = this.toStoredTimeString((row as any).hotspot_end_time);
            if (rowEndTime) {
              currentTime = rowEndTime;
            }

            if (Number(row.item_type ?? 0) === 4 && Number(row.hotspot_ID ?? 0) > 0) {
              const rowHotspotData = hotspotMap.get(Number(row.hotspot_ID));
              if (rowHotspotData) {
                currentLocationName = String(rowHotspotData.hotspot_location || currentLocationName)
                  .split('|')[0]
                  .trim();
                currentCoords = {
                  lat: Number(rowHotspotData.hotspot_latitude ?? 0),
                  lon: Number(rowHotspotData.hotspot_longitude ?? 0),
                };
              }
            }
          }

          returnTrimGuard += 1;
        }

        const returnTravelLocationType = this.getTravelLocationType(currentLocationName, departureCityName);
        const estimatedReturn = await this.distanceHelper.fromSourceAndDestination(
          tx,
          currentLocationName,
          departureCityName,
          returnTravelLocationType,
          addedHotspotIds.size > 0 ? currentCoords : undefined,
          addedHotspotIds.size > 0 ? destCityCoords : undefined,
        );
        const estimatedReturnSeconds =
          timeToSeconds(estimatedReturn.travelTime) +
          timeToSeconds(estimatedReturn.bufferTime);
        const anchoredReturnStartSeconds = Math.max(
          timeToSeconds(currentTime),
          lastRouteArrivalDeadlineSeconds - estimatedReturnSeconds,
        );
        const returnStartTime = secondsToTime(wrapToDay(anchoredReturnStartSeconds));
        const preDepartureLeisureSeconds =
          anchoredReturnStartSeconds - timeToSeconds(currentTime);

        if (preDepartureLeisureSeconds >= FREE_TIME_THRESHOLD_SECONDS) {
          const leisureRow = this.buildFreeTimeBreakRow({
            planId,
            routeId: route.itinerary_route_ID,
            order: order++,
            startTime: currentTime,
            endTime: returnStartTime,
            userId: createdByUserId,
          });
          leisureRow.via_location_name = 'Leisure / Shopping Time';
          hotspotRows.push(leisureRow);
        }

        const { row: returnRow, nextTime: tAfterReturn } =
          await this.returnBuilder.buildReturnToDeparture(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: order++,
            startTime: returnStartTime,
            travelLocationType: returnTravelLocationType,
            userId: createdByUserId,
            currentLocationName,
            // ✅ PHP PARITY: Only use coordinates (Haversine) if we actually visited hotspots.
            sourceCoords: addedHotspotIds.size > 0 ? currentCoords : undefined,
            destCoords: addedHotspotIds.size > 0 ? destCityCoords : undefined,
          });

        hotspotRows.push(returnRow);
        currentTime = tAfterReturn;
        currentLocationName = plan.departure_location as string;
      }
    }

    // ✅ FINAL VALIDATION: Enforce route_end_time constraints before returning
    // Check each row to ensure it doesn't exceed its route's end time
    const routeEndTimesMap = new Map<number, number>();
    const routeStartTimesMap = new Map<number, number>();  // ← NEW: Track start times too
    for (const route of routes) {
      const routeId = route.itinerary_route_ID;
      const routeStartSeconds = timeToSeconds(
        typeof route.route_start_time === 'string' 
          ? route.route_start_time 
          : `${String((route.route_start_time as any).getUTCHours()).padStart(2, '0')}:${String((route.route_start_time as any).getUTCMinutes()).padStart(2, '0')}:${String((route.route_start_time as any).getUTCSeconds()).padStart(2, '0')}`
      );
      let routeEndSeconds = timeToSeconds(
        typeof route.route_end_time === 'string'
          ? route.route_end_time
          : `${String((route.route_end_time as any).getUTCHours()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCMinutes()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCSeconds()).padStart(2, '0')}`
      );
      if (routeEndSeconds < routeStartSeconds) {
        routeEndSeconds += 86400;
      }
      routeStartTimesMap.set(routeId, routeStartSeconds);
      routeEndTimesMap.set(routeId, routeEndSeconds);
    }

    const validationCount = { violations: 0, marked: 0, hotelPreStart: 0 };
    for (const row of hotspotRows) {
      const routeId = row.itinerary_route_ID;
      const routeStartSeconds = routeStartTimesMap.get(routeId);
      const routeEndSeconds = routeEndTimesMap.get(routeId) || 86400;
      
      // ✅ NEW VALIDATION: Hotel rows before route start (day-boundary bug check)
      // Mark hotel rows (item_type=5 TRAVEL_TO_HOTEL, item_type=6 CHECKIN) that appear
      // before the current route's start time. These are previous-day hotel checkout rows
      // incorrectly attached to the current day.
      if ((row.item_type === 5 || row.item_type === 6) && routeStartSeconds != null) {
        const startTimeVal = row.hotspot_start_time;
        let rowStartSeconds = 0;
        if (startTimeVal instanceof Date) {
          rowStartSeconds = startTimeVal.getUTCHours() * 3600 + 
                            startTimeVal.getUTCMinutes() * 60 + 
                            startTimeVal.getUTCSeconds();
        } else {
          rowStartSeconds = timeToSeconds(String(startTimeVal || '00:00:00'));
        }
        
        // Check if hotel row starts before route start time
        if (rowStartSeconds < routeStartSeconds) {
          validationCount.hotelPreStart++;

          const rowStartString = secondsToTime(rowStartSeconds);
          if (this.verboseTimelineProofLogs) {
            console.log('[HotelDayBoundary][PROOF] Hotel row before route start - parity mode keeps row', {
              planId,
              routeId,
              itemType: row.item_type,
              itemTypeName: row.item_type === 5 ? 'TRAVEL_TO_HOTEL' : 'CHECKIN',
              rowStartString,
              rowStartSeconds,
              routeStartSeconds,
              gapSeconds: routeStartSeconds - rowStartSeconds,
              gapMinutes: Math.floor((routeStartSeconds - rowStartSeconds) / 60),
              action: 'No conflict mutation in PHP parity mode',
            });
          }
        }
      }
      
      // Get row's end time in seconds (handle Date objects)
      const endTimeVal = row.hotspot_end_time;
      let rowEndSeconds = 0;
      if (endTimeVal instanceof Date) {
        rowEndSeconds = endTimeVal.getUTCHours() * 3600 + 
                        endTimeVal.getUTCMinutes() * 60 + 
                        endTimeVal.getUTCSeconds();
      } else {
        rowEndSeconds = timeToSeconds(String(endTimeVal || '00:00:00'));
      }
      
      // Check if row end exceeds route end (allowing for overnight routes)
      if (rowEndSeconds > routeEndSeconds && rowEndSeconds < 86400 - routeEndSeconds) {
        // This is a violation (end time is past route end, accounting for wrapping)
        validationCount.violations++;

        if (this.verboseTimelineProofLogs) {
          console.log('[TimelineBuilder][PROOF] Route-end violation observed - parity mode keeps row', {
            planId,
            routeId,
            itemType: row.item_type,
            rowEndSeconds,
            routeEndSeconds,
            excessSeconds: rowEndSeconds - routeEndSeconds,
            excessMinutes: Math.floor((rowEndSeconds - routeEndSeconds) / 60),
          });
        }
      }
    }

    if (this.verboseTimelineProofLogs && validationCount.violations > 0) {
      console.log('[TimelineBuilder][PROOF] Route-end validation complete', {
        planId,
        totalViolations: validationCount.violations,
        markedAsConflict: validationCount.marked,
      });
    }

    const routeRejectionSummaryByRoute = this.rejectionPolicyService.getSummaryByRoute();

    return { hotspotRows, parkingRows, routeRejectionSummaryByRoute };
  }

  /**
   * Decide if this is the last route of the plan (used for item_type = 7).
   */
  private async isLastRouteOfPlan(
    tx: Tx,
    planId: number,
    routeId: number,
  ): Promise<boolean> {
    const last = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: [
        { itinerary_route_date: "desc" },
        { itinerary_route_ID: "desc" },
      ],
    });

    if (!last) return false;
    return last.itinerary_route_ID === routeId;
  }

  /**
   * Day-1 special: Fetch top 3 priority hotspots from source city only.
   * Enforces:
   * - hotspot_priority > 0 (priority hotspots only)
   * - normalized location matches source city
   * - sorted by priority asc, then distance asc
   * - limited to 3 hotspots
   */
  private async fetchDay1TopPrioritySourceHotspots(
    tx: Tx,
    planId: number,
    routeId: number,
    sourceCity: string,
    destinationCity: string,
    excludedHotspotIds?: Set<number>,
    maxResults: number = 3,
    includeZeroPriority: boolean = false,
  ): Promise<SelectedHotspot[]> {
    return (await this.day1SourceFallbackService.fetch(
      tx,
      planId,
      routeId,
      sourceCity,
      destinationCity,
      excludedHotspotIds,
      maxResults,
      includeZeroPriority,
    )) as SelectedHotspot[];
  }

  /**
   * Fetch available hotspots for a given route location.
   *
   * In PHP: the `includeHotspotInItinerary()` function is called for each hotspot
   * that is available at the route's location, in priority order.
   *
   * We replicate this by:
   * 1. Get the route's location_name or next_visiting_location
   * 2. Query dvi_hotspot_place for hotspots matching that location (by name)
   * 3. Return them sorted by priority
   *
   * NOTE: In the schema, dvi_hotspot_place doesn't have a location_id field.
   * Instead, it has hotspot_location (text) which must be matched against
   * the route's location_name or next_visiting_location.
   * 
   * @param allHotspots - Pre-fetched array of all active hotspots (performance optimization)
   * @param maxSourceHotspots - Optional limit for source location hotspots (for Day 1 arrival city)
   */
  private async fetchSelectedHotspotsForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
    allHotspots: any[],
    maxSourceHotspots?: number,
    skipDestinationHotspots?: boolean,
  ): Promise<SelectedHotspot[]> {
    return (await this.routeHotspotSelectionService.fetch(
      tx,
      planId,
      routeId,
      allHotspots,
      maxSourceHotspots,
      skipDestinationHotspots,
    )) as SelectedHotspot[];
  }

  private async getHotspotLocationName(
    tx: Tx,
    hotspotId: number,
  ): Promise<string | null> {
    return this.travelDataService.getHotspotLocationName(tx, hotspotId);
  }

  /**
   * Get the hotel city/location used for travel-to-hotel segment for a route.
   *
   * In PHP, this comes from your big hotel-selection query joining:
   *   dvi_itinerary_route_details + dvi_stored_locations + dvi_hotel + dvi_hotel_rooms
   *
   * TODO: Replace this placeholder with the real query and returned city field.
   */
  private async getHotelLocationNameForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
  ): Promise<string | null> {
    return this.travelDataService.getHotelLocationNameForRoute(tx, planId, routeId);
  }

  private async getHotelDetailsForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
  ): Promise<{ hotelId: number; hotelName: string | null; hotelCity: string | null; isHouseboat?: boolean; coords?: { lat: number; lon: number } } | null> {
    return this.travelDataService.getHotelDetailsForRoute(tx, planId, routeId);
  }

  /**
   * Calculate travel time between two locations (matching PHP logic).
   * Returns HH:MM:SS format string.
   */
  private async calculateTravelTime(
    tx: Tx,
    sourceLocationName: string,
    destinationLocationName: string,
  ): Promise<string> {
    return this.travelDataService.calculateTravelTime(tx, sourceLocationName, destinationLocationName);
  }

  private hasUsableCoords(
    coords?: { lat: number; lon: number } | null,
  ): coords is { lat: number; lon: number } {
    return this.travelDataService.hasUsableCoords(coords);
  }

  private normalizePlaceLookupKey(value: string | null | undefined): string {
    return this.travelDataService.normalizePlaceLookupKey(value);
  }

  private async resolvePlaceCoords(
    tx: Tx,
    cityName: string | null | undefined,
    preferredSide: 'source' | 'destination' = 'source',
  ): Promise<{ lat: number; lon: number } | undefined> {
    return this.travelDataService.resolvePlaceCoords(tx, cityName, preferredSide);
  }

  private async resolveCityCoords(
    tx: Tx,
    cityName: string | null | undefined,
    preferredSide: 'source' | 'destination' = 'source',
  ): Promise<{ lat: number; lon: number } | undefined> {
    return this.travelDataService.resolveCityCoords(tx, cityName, preferredSide);
  }

  private async calculateTravelTimeWithCoords(
    tx: Tx,
    sourceLocationName: string,
    destinationLocationName: string,
    sourceCoords?: { lat: number; lon: number },
    destCoords?: { lat: number; lon: number },
  ): Promise<string> {
    return this.travelDataService.calculateTravelTimeWithCoords(
      tx,
      sourceLocationName,
      destinationLocationName,
      sourceCoords,
      destCoords,
    );
  }

  private async calculateProjectedArrivalToRouteDestination(
    tx: Tx,
    route: RouteRow,
    hotspotLocationName: string,
    visitEndSeconds: number,
    hotspotCoords?: { lat: number; lon: number },
    destCityCoords?: { lat: number; lon: number },
  ): Promise<{ projectedArrivalSeconds: number; travelToDestSeconds: number }> {
    return this.travelDataService.calculateProjectedArrivalToRouteDestination(
      tx,
      route,
      hotspotLocationName,
      visitEndSeconds,
      hotspotCoords,
      destCityCoords,
    );
  }

  private toAbsoluteSecondsForRoute(timeValue: string, routeStartSeconds: number): number {
    return this.anchorPolicyService.toAbsoluteSecondsForRoute(timeValue, routeStartSeconds);
  }

  private buildFixedTimelineAnchors(
    hotspotRows: HotspotDetailRow[],
    routeId: number,
    routeStartSeconds: number,
    routeEndSeconds: number,
    currentTime: string,
  ): FixedTimelineAnchor[] {
    return this.anchorPolicyService.buildFixedTimelineAnchors(
      hotspotRows,
      routeId,
      routeStartSeconds,
      routeEndSeconds,
      currentTime,
    );
  }

  private buildRealGapIntervals(anchors: FixedTimelineAnchor[]): RealGapInterval[] {
    return this.anchorPolicyService.buildRealGapIntervals(anchors);
  }

  private buildSameCityContinuationContext(
    route: RouteRow,
    previousRoute: RouteRow | undefined,
    hotspotRows: HotspotDetailRow[],
  ): SameCityContinuationContext {
    return this.anchorPolicyService.buildSameCityContinuationContext(route, previousRoute, hotspotRows);
  }

  private async evaluateCandidateInsertion(
    input: CandidateFeasibilityInput,
  ): Promise<CandidateFeasibilityResult> {
    return this.candidateFeasibilityService.evaluateCandidateInsertion(input);
  }

  private async evaluateAnchorGapInsertion(
    tx: Tx,
    hotspotRows: HotspotDetailRow[],
    hotspotMap: Map<number, any>,
    routeId: number,
    routeStartSeconds: number,
    routeEndSeconds: number,
    currentTime: string,
    candidateLocationName: string,
    candidateCoords: { lat: number; lon: number },
    candidateEndSeconds: number,
    protectedStrictSlots?: ProtectedStrictSlot[],
  ): Promise<AnchorGapFeasibilityResult> {
    return this.candidateFeasibilityService.evaluateAnchorGapInsertion(
      tx,
      hotspotRows,
      hotspotMap,
      routeId,
      routeStartSeconds,
      routeEndSeconds,
      currentTime,
      candidateLocationName,
      candidateCoords,
      candidateEndSeconds,
      protectedStrictSlots,
    );
  }

  private parsePlanDateTime(value: unknown): Date | null {
    return this.anchorPolicyService.parsePlanDateTime(value);
  }

  private extractPlanTimeOfDaySeconds(value: unknown): number | null {
    return this.anchorPolicyService.extractPlanTimeOfDaySeconds(value);
  }

  private toStoredTimeString(value: unknown): string | null {
    return this.anchorPolicyService.toStoredTimeString(value);
  }

  /**
   * Determine travel location type (matches PHP getTravelLocationType)
   * @param startLocation - Starting location name (can contain pipe-separated values)
   * @param endLocation - Ending location name (can contain pipe-separated values)
   * @returns 1 if same location (local), 2 if different location (outstation)
   */
  private getTravelLocationType(
    startLocation: string,
    endLocation: string,
  ): 1 | 2 {
    return this.anchorPolicyService.getTravelLocationType(startLocation, endLocation);
  }
}

// --- RECENT EDITS BELOW --- //
