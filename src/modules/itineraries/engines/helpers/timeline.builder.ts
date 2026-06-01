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
import { normalizeCityName as normalizeCityNameShared } from '../../utils/city-normalization.util';
import {
  evaluateArrivalHotelPolicy,
  ArrivalWindow,
  HotelFlowAction,
  HotelSearchMode,
  PolicyResolutionStatus,
} from '../../services/arrival-hotel-policy.service';
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

interface ArrivalPolicyDecisionState {
  previousDayBillingDecisionProvided: boolean;
  previousDayBillingConfirmed: boolean;
}

// Minimal view of a selected hotspot row.
// ⚠️ You MUST adjust table/field names in fetchSelectedHotspotsForRoute().
interface SelectedHotspot {
  hotspot_ID: number;
  display_order?: number;
  hotspot_priority?: number;
  matched_bucket?: string;
  hotspot_distance?: number;
}

type DayTimeSlot = 'MORNING' | 'EVENING';

interface CarryForwardHotspot extends SelectedHotspot {
  carryOrder: number;
  carriedFromRouteId: number;
  carriedFromDate: string;
}

interface FixedTimelineAnchor {
  kind: 'route_start' | 'hotspot' | 'route_end';
  startSeconds: number;
  endSeconds: number;
  hotspotId?: number;
}

interface RealGapInterval {
  start: number;
  end: number;
  durationSeconds: number;
}

interface SameCityContinuationContext {
  isSameCityChainContinuation: boolean;
  previousDayHotspotIds: Set<number>;
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
const FREE_TIME_THRESHOLD_SECONDS = 45 * 60;
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
  private readonly routeRejectionSummaryByRoute = new Map<number, RouteRejectionSummary>();
  private readonly routeEndBufferMinutes = Math.max(
    0,
    Number.parseInt(process.env.HOTSPOT_ROUTE_END_BUFFER_MINUTES || '0', 10) || 0,
  );
  private readonly routeEndBufferRouteIds = new Set<number>(
    String(process.env.HOTSPOT_ROUTE_END_BUFFER_ROUTE_IDS || '')
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0),
  );

  private toDateOnly(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  // Batch-query precomputed between-map rows for many slot pairs.
  // Returns Map keyed by `${fromId}_${toId}` -> Array<row>
  private async getBetweenCandidatesForRouteSlots(tx: Tx, slotPairs: Array<{ fromId: number; toId: number }>) {
    const result = new Map<string, any[]>();
    if (!Array.isArray(slotPairs) || slotPairs.length === 0) return result;

    const whereClauses: string[] = [];
    const params: any[] = [];
    for (const p of slotPairs) {
      const a = Number(p.fromId || 0);
      const b = Number(p.toId || 0);
      if (!a || !b || a === b) continue;
      // accept either direction on read
      whereClauses.push(`((from_hotspot_id = ? AND to_hotspot_id = ?) OR (from_hotspot_id = ? AND to_hotspot_id = ?))`);
      params.push(a, b, b, a);
    }

    if (whereClauses.length === 0) return result;

    const sql = `
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
      WHERE (${whereClauses.join(' OR ')})
        AND route_fit_type IN ('ON_ROUTE','MINOR_DETOUR')
    `;

    try {
      const rows: any[] = await (tx as any).$queryRawUnsafe(sql, ...params);
      if (!Array.isArray(rows) || rows.length === 0) return result;

      // Index rows by both canonical and reverse slot keys, but make them available
      for (const r of rows) {
        const f = Number(r.from_hotspot_id || 0);
        const t = Number(r.to_hotspot_id || 0);
        const between = Number(r.between_hotspot_id || 0);
        if (!f || !t || !between) continue;

        const exactKey = `${f}_${t}`;
        const reverseKey = `${t}_${f}`;
        const rowCopy = { ...r };

        if (!result.has(exactKey)) result.set(exactKey, []);
        result.get(exactKey)!.push(rowCopy);

        if (!result.has(reverseKey)) result.set(reverseKey, []);
        result.get(reverseKey)!.push(rowCopy);
      }
    } catch (err) {
      console.error('[getBetweenCandidatesForRouteSlots] query error:', err);
    }

    return result;
  }

  private async getBetweenCandidatesForSlot(tx: Tx, fromId: number, toId: number) {
    const map = await this.getBetweenCandidatesForRouteSlots(tx, [{ fromId, toId }]);
    return map.get(`${fromId}_${toId}`) || [];
  }

  private async getArrivalPolicyDecisionStateForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
    routeDate: Date,
  ): Promise<ArrivalPolicyDecisionState> {
    const markerRows = await (tx as any).dvi_itinerary_plan_hotel_details?.findMany({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        hotel_required: 2,
        hotel_id: 0,
        deleted: 0,
        status: 1,
      },
      select: {
        group_type: true,
        itinerary_route_date: true,
      },
    });

    // Source-of-truth: explicit marker rows created by updateRouteTimes() when user clicks YES.
    // They are persisted as one row per recommendation group (group_type 1..4), so presence
    // of any active marker row means previous-day billing is confirmed.
    if (Array.isArray(markerRows) && markerRows.length > 0) {
      return {
        previousDayBillingDecisionProvided: true,
        previousDayBillingConfirmed: true,
      };
    }

    // Fallback for legacy rows where marker is absent.
    const hotelSelection = await (tx as any).dvi_itinerary_plan_hotel_details?.findFirst({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        group_type: 1,
        deleted: 0,
        status: 1,
      },
      orderBy: {
        itinerary_plan_hotel_details_ID: 'desc',
      },
      select: {
        itinerary_route_date: true,
      },
    });

    if (!hotelSelection?.itinerary_route_date) {
      return {
        previousDayBillingDecisionProvided: false,
        previousDayBillingConfirmed: false,
      };
    }

    const selectedHotelDate = this.toDateOnly(new Date(hotelSelection.itinerary_route_date));
    const normalizedRouteDate = this.toDateOnly(routeDate);
    const selectedHotelDateMs = selectedHotelDate.getTime();
    const routeDateMs = normalizedRouteDate.getTime();

    if (selectedHotelDateMs < routeDateMs) {
      return {
        previousDayBillingDecisionProvided: true,
        previousDayBillingConfirmed: true,
      };
    }

    return {
      previousDayBillingDecisionProvided: true,
      previousDayBillingConfirmed: false,
    };
  }

  constructor() {
    // Logging removed for performance
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

  private formatTimingTime(value: any): string | null {
    if (!value) return null;
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      const hhmmss = trimmed.match(/(\d{2}:\d{2}:\d{2})/);
      if (hhmmss?.[1]) return hhmmss[1];

      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return `${String(parsed.getUTCHours()).padStart(2, '0')}:${String(parsed.getUTCMinutes()).padStart(2, '0')}:${String(parsed.getUTCSeconds()).padStart(2, '0')}`;
      }
      return null;
    }
    if (value instanceof Date) {
      return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
    }
    if (typeof value === 'object' && typeof value.getUTCHours === 'function') {
      return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
    }
    return null;
  }

  private getTimingWindowSummary(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
    dayOfWeek: number,
  ): { openingTime: string | null; closingTime: string | null } {
    const timingRecords = timingMap.get(hotspotId)?.get(dayOfWeek) || [];
    if (!timingRecords.length) {
      return { openingTime: null, closingTime: null };
    }

    let openingTime: string | null = null;
    let closingTime: string | null = null;

    for (const timing of timingRecords) {
      if (Number(timing?.hotspot_closed || 0) === 1) continue;
      if (Number(timing?.hotspot_open_all_time || 0) === 1) {
        return { openingTime: '00:00:00', closingTime: '23:59:59' };
      }

      const start = this.formatTimingTime(timing?.hotspot_start_time);
      const end = this.formatTimingTime(timing?.hotspot_end_time);
      if (!start || !end) continue;

      if (!openingTime || timeToSeconds(start) < timeToSeconds(openingTime)) {
        openingTime = start;
      }
      if (!closingTime || timeToSeconds(end) > timeToSeconds(closingTime)) {
        closingTime = end;
      }
    }

    return { openingTime, closingTime };
  }

  private isHotspotClosedOnDay(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
    dayOfWeek: number,
  ): boolean {
    const timingRecords = timingMap.get(hotspotId)?.get(dayOfWeek) || [];
    if (!timingRecords.length) return false;

    return timingRecords.every((timing) => Number((timing as any)?.hotspot_closed || 0) === 1);
  }

  private isHotspotClosedOnAllDays(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
  ): boolean {
    const dayMap = timingMap.get(hotspotId);
    if (!dayMap || dayMap.size === 0) return false;

    const allRows = Array.from(dayMap.values()).flat();
    if (!allRows.length) return false;

    return allRows.every((timing) => Number((timing as any)?.hotspot_closed || 0) === 1);
  }

  private getRouteVisitDaysForClosedFilter(
    route: RouteRow,
    previousRoute: RouteRow | undefined,
  ): Set<number> {
    const visitDays = new Set<number>();

    if (route.itinerary_route_date) {
      const jsDay = new Date(route.itinerary_route_date).getDay();
      visitDays.add((jsDay + 6) % 7); // PHP convention: Monday=0
    }

    if (!previousRoute?.itinerary_route_date) {
      return visitDays;
    }

    const currentCityKey = this.canonicalCityKey(
      String((route as any).location_name || (route as any).next_visiting_location || ''),
    );
    const prevDestKey = this.canonicalCityKey(String((previousRoute as any).next_visiting_location || ''));
    const prevSourceKey = this.canonicalCityKey(String((previousRoute as any).location_name || ''));

    const isSameCityStayAcrossDays = !!currentCityKey && (currentCityKey === prevDestKey || currentCityKey === prevSourceKey);
    if (!isSameCityStayAcrossDays) {
      return visitDays;
    }

    const prevJsDay = new Date(previousRoute.itinerary_route_date).getDay();
    visitDays.add((prevJsDay + 6) % 7);

    return visitDays;
  }

  private getDayTimeSlot(timeValue: string): DayTimeSlot {
    const seconds = timeToSeconds(timeValue);
    return seconds < timeToSeconds('12:00:00') ? 'MORNING' : 'EVENING';
  }

  private getNextSlotStart(currentSlot: DayTimeSlot): string | null {
    if (currentSlot === 'MORNING') return '12:00:00';
    return null;
  }

  private maxTimeString(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return timeToSeconds(a) >= timeToSeconds(b) ? a : b;
  }

  private buildFreeTimeBreakRow(params: {
    planId: number;
    routeId: number;
    order: number;
    startTime: string;
    endTime: string;
    userId: number;
  }): HotspotDetailRow {
    const durationSeconds = Math.max(0, timeToSeconds(params.endTime) - timeToSeconds(params.startTime));
    const duration = secondsToTime(durationSeconds);
    const now = new Date();

    return {
      itinerary_plan_ID: params.planId,
      itinerary_route_ID: params.routeId,
      item_type: 3,
      hotspot_order: params.order,
      hotspot_ID: 0,

      hotspot_adult_entry_cost: 0,
      hotspot_child_entry_cost: 0,
      hotspot_infant_entry_cost: 0,
      hotspot_foreign_adult_entry_cost: 0,
      hotspot_foreign_child_entry_cost: 0,
      hotspot_foreign_infant_entry_cost: 0,
      hotspot_amout: 0,

      hotspot_traveling_time: TimeConverter.toDate(duration),
      itinerary_travel_type_buffer_time: TimeConverter.toDate('00:00:00'),
      hotspot_travelling_distance: null,

      hotspot_start_time: TimeConverter.toDate(params.startTime),
      hotspot_end_time: TimeConverter.toDate(params.endTime),

      allow_break_hours: 1,
      allow_via_route: 0,
      via_location_name: null,
      hotspot_plan_own_way: 0,

      createdby: params.userId,
      createdon: now,
      updatedon: null,
      status: 1,
      deleted: 0,
    };
  }

  private getCarryPriorityBucket(priority: number): number {
    if (priority >= 1 && priority <= 3) return 0;
    if (priority > 3) return 1;
    return 2;
  }

  private sortCarryForwardHotspots(list: CarryForwardHotspot[]): CarryForwardHotspot[] {
    return [...list].sort((a, b) => {
      const ap = Number(a.hotspot_priority ?? 0);
      const bp = Number(b.hotspot_priority ?? 0);
      const ab = this.getCarryPriorityBucket(ap);
      const bb = this.getCarryPriorityBucket(bp);
      if (ab !== bb) return ab - bb;

      const apr = ap > 0 ? ap : 9999;
      const bpr = bp > 0 ? bp : 9999;
      if (apr !== bpr) return apr - bpr;

      if (a.carryOrder !== b.carryOrder) return a.carryOrder - b.carryOrder;
      return Number(a.hotspot_ID ?? 0) - Number(b.hotspot_ID ?? 0);
    });
  }

  private mergeCarryForwardIntoCandidates(
    carryForwardHotspots: CarryForwardHotspot[],
    selectedHotspots: SelectedHotspot[],
    addedHotspotIds: Set<number>,
  ): SelectedHotspot[] {
    const merged: SelectedHotspot[] = [];
    const seen = new Set<number>();

    const appendIfUnique = (hotspot: SelectedHotspot) => {
      const hotspotId = Number(hotspot.hotspot_ID ?? 0);
      if (!hotspotId) return;
      if (addedHotspotIds.has(hotspotId)) return;
      if (seen.has(hotspotId)) return;
      seen.add(hotspotId);
      merged.push(hotspot);
    };

    const sortedCarry = this.sortCarryForwardHotspots(carryForwardHotspots);
    for (const hotspot of sortedCarry) {
      appendIfUnique({
        ...hotspot,
        matched_bucket: hotspot.matched_bucket || 'carry_forward',
      });
    }

    for (const hotspot of selectedHotspots) {
      appendIfUnique(hotspot);
    }

    return merged;
  }

  private logHotspotCandidateEvaluation(payload: {
    routeId: number;
    hotspotId: number;
    name: string;
    matchedBucket?: string | null;
    priority: number;
    isMustVisit: boolean;
    distanceFromRoute: number | null;
    openingTime: string | null;
    closingTime: string | null;
    visitTime: string;
    isOpenAtVisitTime: boolean;
    selected: boolean;
    rejectedReasons: string[];
  }): void {
    this.recordHotspotCandidateEvaluation(payload);

    const rejectionGateBreakdown = this.buildRejectionGateBreakdown(payload.rejectedReasons);

    const rejectedReason = payload.rejectedReasons.length
      ? payload.rejectedReasons.join('; ')
      : null;

    const evalPayload = JSON.stringify({
      routeId: payload.routeId,
      hotspotId: payload.hotspotId,
      name: payload.name,
      matchedBucket: payload.matchedBucket ?? null,
      priority: payload.priority,
      isMustVisit: payload.isMustVisit,
      distanceFromRoute: payload.distanceFromRoute,
      openingTime: payload.openingTime,
      closingTime: payload.closingTime,
      visitTime: payload.visitTime,
      isOpenAtVisitTime: payload.isOpenAtVisitTime,
      selected: payload.selected,
      rejectedReason,
      rejectedReasons: payload.rejectedReasons,
      rejectionGateBreakdown,
    });

    if (this.verboseTimelineProofLogs) {
      console.log('[HOTSPOT_CANDIDATE_EVAL]', evalPayload);
      this.appendProofTrace(`[HOTSPOT_CANDIDATE_EVAL] ${evalPayload}`);
    }
  }

  private shouldApplyRouteEndBuffer(routeId: number): boolean {
    if (this.routeEndBufferMinutes <= 0) return false;
    if (this.routeEndBufferRouteIds.size === 0) return true;
    return this.routeEndBufferRouteIds.has(routeId);
  }

  private getRouteEndBufferSeconds(routeId: number): number {
    if (!this.shouldApplyRouteEndBuffer(routeId)) {
      return 0;
    }
    return this.routeEndBufferMinutes * 60;
  }

  private classifyRejectionReason(reason: string): keyof RouteRejectionSummary {
    const normalized = String(reason || '').toLowerCase();
    if (normalized.includes('php_gate_route_end') || normalized.includes('route end')) {
      return 'routeEnd';
    }
    if (normalized.includes('operating hours') || normalized.includes('closed')) {
      return 'operatingHours';
    }
    if (normalized.includes('duplicate')) {
      return 'duplicate';
    }
    if (normalized.includes('no remaining day window')) {
      return 'noRemainingWindow';
    }
    return 'other';
  }

  private buildRejectionGateBreakdown(rejectedReasons: string[]): {
    alreadyUsedOnAnotherRoute: boolean;
    outsideOperatingHours: boolean;
    routeEndDeadline: boolean;
    duplicateSuppression: boolean;
    noRemainingWindow: boolean;
    other: boolean;
  } {
    const normalizedReasons = (Array.isArray(rejectedReasons) ? rejectedReasons : [])
      .map((reason) => String(reason || '').toLowerCase());

    const hasMatch = (...needles: string[]) =>
      normalizedReasons.some((reason) => needles.some((needle) => reason.includes(needle)));

    const alreadyUsedOnAnotherRoute = hasMatch('duplicate_plan_scope', 'already used on another route', 'already on another day');
    const outsideOperatingHours = hasMatch('operating hours', 'outside operating hours', 'closed on this day');
    const routeEndDeadline = hasMatch('php_gate_route_end', 'route end', 'exceeds route end');
    const duplicateSuppression = hasMatch('duplicate', 'dedup', 'de-dup');
    const noRemainingWindow = hasMatch('no remaining day window', 'no remaining window');

    return {
      alreadyUsedOnAnotherRoute,
      outsideOperatingHours,
      routeEndDeadline,
      duplicateSuppression,
      noRemainingWindow,
      other: !alreadyUsedOnAnotherRoute && !outsideOperatingHours && !routeEndDeadline && !duplicateSuppression && !noRemainingWindow,
    };
  }

  private recordHotspotCandidateEvaluation(payload: {
    routeId: number;
    selected: boolean;
    rejectedReasons: string[];
  }): void {
    const routeId = Number(payload.routeId || 0);
    if (!routeId) return;

    const existing = this.routeRejectionSummaryByRoute.get(routeId) || {
      totalRejectedCandidates: 0,
      totalSelectedCandidates: 0,
      routeEnd: 0,
      operatingHours: 0,
      duplicate: 0,
      noRemainingWindow: 0,
      other: 0,
    };

    if (payload.selected) {
      existing.totalSelectedCandidates += 1;
      this.routeRejectionSummaryByRoute.set(routeId, existing);
      return;
    }

    if (!Array.isArray(payload.rejectedReasons) || payload.rejectedReasons.length === 0) {
      this.routeRejectionSummaryByRoute.set(routeId, existing);
      return;
    }

    existing.totalRejectedCandidates += 1;
    const matchedCategories = new Set<keyof RouteRejectionSummary>();
    for (const reason of payload.rejectedReasons) {
      const category = this.classifyRejectionReason(reason);
      if (matchedCategories.has(category)) continue;
      matchedCategories.add(category);
      existing[category] += 1;
    }

    this.routeRejectionSummaryByRoute.set(routeId, existing);
  }

  /**
   * Normalize city names for comparison (single source of truth)
   * Removes airport, railway, station, etc. and normalizes to lowercase
   */
  private normalizeCityName(name: string): string {
    return normalizeCityNameShared(name);
  }

  /**
   * Canonical city key used for branch decisions.
   * Examples:
   * - "Hyderabad, Telangana, India" -> "hyderabad"
   * - "Hyderabad, Rajiv Gandhi International Airport" -> "hyderabad"
   * - "Chennai International Airport" -> "chennai"
   */
  private canonicalCityKey(name: string): string {
    const raw = String(name ?? '').split('|')[0]?.trim() ?? '';
    if (!raw) return '';

    const beforeComma = raw.split(',')[0]?.trim() ?? '';
    const normalizedPrimary = this.normalizeCityName(beforeComma);
    if (normalizedPrimary) return normalizedPrimary;

    return this.normalizeCityName(raw);
  }

  private isSameCity(a: string, b: string): boolean {
    const aa = this.canonicalCityKey(a);
    const bb = this.canonicalCityKey(b);
    return !!aa && !!bb && aa === bb;
  }

  private getSameCityRouteKey(route: Partial<RouteRow> | null | undefined): string {
    const sourceKey = this.canonicalCityKey(String((route as any)?.location_name || ''));
    const destinationKey = this.canonicalCityKey(
      String((route as any)?.next_visiting_location || ''),
    );

    if (!sourceKey || !destinationKey || sourceKey !== destinationKey) {
      return '';
    }

    return sourceKey;
  }

  private buildReservedSameCityHotspotIdsByRoute(
    routes: RouteRow[],
    existingHotspots: any[] | undefined,
    scopeToRouteId?: number,
  ): Map<number, Set<number>> {
    const routeCityKeyById = new Map<number, string>();
    for (const route of routes) {
      const routeId = Number((route as any)?.itinerary_route_ID || 0);
      if (!routeId) continue;

      const cityKey = this.getSameCityRouteKey(route);
      if (!cityKey) continue;

      routeCityKeyById.set(routeId, cityKey);
    }

    if (routeCityKeyById.size === 0 || !Array.isArray(existingHotspots) || existingHotspots.length === 0) {
      return new Map<number, Set<number>>();
    }

    const cityReservedIds = new Map<string, Set<number>>();
    const routeReservedIds = new Map<number, Set<number>>();

    for (const row of existingHotspots) {
      if (Number((row as any)?.deleted || 0) !== 0) continue;

      const routeId = Number((row as any)?.itinerary_route_ID || 0);
      const hotspotId = Number((row as any)?.hotspot_ID || 0);
      if (!routeId || !hotspotId) continue;

      const cityKey = routeCityKeyById.get(routeId);
      if (!cityKey) continue;

      const isManual = Number((row as any)?.hotspot_plan_own_way || 0) === 1;
      const shouldReserveForOtherRoutes = scopeToRouteId ? true : isManual;
      if (!shouldReserveForOtherRoutes) continue;

      if (!cityReservedIds.has(cityKey)) {
        cityReservedIds.set(cityKey, new Set<number>());
      }
      cityReservedIds.get(cityKey)!.add(hotspotId);

      if (!routeReservedIds.has(routeId)) {
        routeReservedIds.set(routeId, new Set<number>());
      }
      routeReservedIds.get(routeId)!.add(hotspotId);
    }

    const reservedByRoute = new Map<number, Set<number>>();
    for (const route of routes) {
      const routeId = Number((route as any)?.itinerary_route_ID || 0);
      if (!routeId) continue;

      const cityKey = routeCityKeyById.get(routeId);
      if (!cityKey) continue;

      const cityIds = cityReservedIds.get(cityKey);
      if (!cityIds || cityIds.size === 0) continue;

      const ownIds = routeReservedIds.get(routeId) || new Set<number>();
      const reservedIds = new Set<number>();
      for (const hotspotId of cityIds) {
        if (ownIds.has(hotspotId)) continue;
        reservedIds.add(hotspotId);
      }

      if (reservedIds.size > 0) {
        reservedByRoute.set(routeId, reservedIds);
      }
    }

    return reservedByRoute;
  }

  // Match a hotspot location token to a route city using normalized city keys.
  // This is intentionally broader than strict token equality so entries like
  // "Chennai Egmore Station" can match route city "Chennai" globally.
  private hotspotLocationMatchesCity(
    hotspotLocation: string | null | undefined,
    targetCity: string | null | undefined,
  ): boolean {
    const targetKey = this.canonicalCityKey(String(targetCity || ''));
    if (!targetKey) return false;

    const parts = String(hotspotLocation || '')
      .split('|')
      .map((p) => this.canonicalCityKey(p))
      .filter(Boolean);

    if (!parts.length) return false;

    for (const part of parts) {
      if (part === targetKey) return true;
      if (part.startsWith(`${targetKey} `)) return true;
      if (part.includes(` ${targetKey} `)) return true;
      if (part.endsWith(` ${targetKey}`)) return true;
    }

    return false;
  }

  // Estimate how many hotspots a route can realistically absorb based on the
  // available route window. Used for reservation feasibility checks.
  private estimateRouteHotspotCapacity(route: RouteRow | null | undefined): number {
    if (!route) return 0;

    const startRaw = typeof (route as any).route_start_time === 'string'
      ? String((route as any).route_start_time)
      : '09:00:00';
    const endRaw = typeof (route as any).route_end_time === 'string'
      ? String((route as any).route_end_time)
      : '18:00:00';

    let startSecs = timeToSeconds(startRaw);
    let endSecs = timeToSeconds(endRaw);
    if (endSecs < startSecs) endSecs += 86400;

    const availableSecs = Math.max(0, endSecs - startSecs);
    const routeBufferSecs = 60 * 60;
    const effectiveSecs = Math.max(0, availableSecs - routeBufferSecs);

    // Heuristic per hotspot block: travel + visit + transition.
    const avgPerHotspotSecs = 100 * 60;
    const estimated = Math.floor(effectiveSecs / avgPerHotspotSecs);
    return Math.max(1, estimated);
  }

  /**
   * Check if hotspot operating hours allow visit during the specified time window.
   * PHP: checkHOTSPOTOPERATINGHOURS() in sql_functions.php line 10388-10429
   * 
   * ⚠️ CRITICAL FIX (2026-04-12):
   * Uses ABSOLUTE seconds for all validation logic, not wrapped display times.
   * Handles overnight windows correctly by normalizing time ranges.
   * 
   * PHP Logic (line 10419-10423):
   * if (($start_timestamp >= $operating_start_timestamp) && ($end_timestamp <= $operating_end_timestamp))
   * 
   * Returns object with:
   * - canVisitNow: true if BOTH start AND end time fall within THE SAME operating hours window
   * - nextWindowStart: start time of next available window (if canVisitNow is false)
   * 
   * @param timingMap - Pre-fetched timing data map for all hotspots (performance optimization)
   * @param hotspotId - Hotspot ID
   * @param dayOfWeek - Day of week (0=Monday, 6=Sunday)
   * @param visitStartSeconds - ABSOLUTE visit start time in seconds (not wrapped)
   * @param visitEndSeconds - ABSOLUTE visit end time in seconds (may exceed 86400 if overnight)
   */
  private checkHotspotOperatingHoursFromMap(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
    dayOfWeek: number,
    visitStartSeconds: number,
    visitEndSeconds: number,
  ): { canVisitNow: boolean; nextWindowStart: string | null; isClosedForDay: boolean } {
    // Get timing records from pre-fetched map (NO DB QUERY)
    const timingRecords = timingMap.get(hotspotId)?.get(dayOfWeek) || [];

    if (!timingRecords || timingRecords.length === 0) {
      // Global engine behavior: missing timing rows should not block scheduling.
      // Treat as open-all-day fallback and let route-time constraints decide fit.
      return { canVisitNow: true, nextWindowStart: null, isClosedForDay: false };
    }

    let nextWindowStart: string | null = null;
    let hasUsableOpenWindow = false;

    // Check if any timing window allows the full visit (start AND end within same window)
    for (const timing of timingRecords) {
      // Skip if hotspot is closed
      if (Number(timing?.hotspot_closed || 0) === 1) {
        continue;
      }

      hasUsableOpenWindow = true;
      
      // Open all time = always available
      if (Number(timing?.hotspot_open_all_time || 0) === 1) {
        return { canVisitNow: true, nextWindowStart: null, isClosedForDay: false };
      }
      
      // Get operating window times (in absolute seconds)
      const operatingStart = this.formatTimingTime(timing?.hotspot_start_time) || '00:00:00';
      const operatingEnd = this.formatTimingTime(timing?.hotspot_end_time) || '23:59:59';
      
      const opStartSeconds = timeToSeconds(operatingStart);
      const opEndSeconds = timeToSeconds(operatingEnd);
      
      // ⚠️ CRITICAL: Handle overnight operating windows (e.g., 18:00-08:00)
      const { isOvernight: opOvernight, absoluteEndSeconds: opAbsoluteEnd } = 
        normalizeTimeRange(opStartSeconds, opEndSeconds);
      
      // ⚠️ CRITICAL: Compare ABSOLUTE visit times against ABSOLUTE operating window
      // Do NOT wrap times before comparison
      // PHP Logic: BOTH start and end must fall within the SAME operating window
      if (visitStartSeconds >= opStartSeconds && visitEndSeconds <= opAbsoluteEnd) {
        return { canVisitNow: true, nextWindowStart: null, isClosedForDay: false };
      }
      
      // Track next available window that's after current start time
      if (opStartSeconds > visitStartSeconds) {
        if (nextWindowStart === null || opStartSeconds < timeToSeconds(nextWindowStart)) {
          nextWindowStart = operatingStart;
        }
      }
    }
    
    // No timing window accommodates the current visit, but return next window if available
    return { canVisitNow: false, nextWindowStart, isClosedForDay: !hasUsableOpenWindow };
  }

  /**
   * Main orchestrator for one plan.
   * Returns in-memory arrays that hotspot-engine.service.ts will insert.
   */
  async buildTimelineForPlan(
    tx: Tx,
    planId: number,
    existingHotspots?: any[],
    options?: {
      manualPlacementByRoute?: Record<number, {
        hotspotOrder?: number;
      }>;
      /** When set, only process/rebuild this route instead of the entire plan. */
      scopeToRouteId?: number;
    },
  ): Promise<{
    hotspotRows: HotspotDetailRow[];
    parkingRows: ParkingChargeRow[];
    routeRejectionSummaryByRoute: Record<number, RouteRejectionSummary>;
  }> {
    this.routeRejectionSummaryByRoute.clear();

    const buildStart = Date.now();
    this.logTimeline('[TIMELINE] buildTimelineForPlan started for planId:', planId, existingHotspots ? `with ${existingHotspots.length} pre-loaded hotspots` : '');
    
    let opStart = Date.now();
    const plan = (await (tx as any).dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
    })) as PlanHeader | null;
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
    const routes = (await (tx as any).dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
      orderBy: [
        { itinerary_route_date: "asc" },
        { itinerary_route_ID: "asc" },
      ],
    })) as RouteRow[];
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
    const allHotspots = (await (tx as any).dvi_hotspot_place?.findMany({
      where: {
        deleted: 0,
        status: 1,
      },
    })) || [];
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
        hotspot_priority: h.hotspot_priority,
        hotspot_latitude: h.hotspot_latitude,
        hotspot_longitude: h.hotspot_longitude,
        hotspot_duration: h.hotspot_duration,
      });
    }
    this.logTimeline('[TIMELINE] Created hotspot lookup map');

    // ⚡ Batch-fetch ALL timing data for ALL days at once (avoid 42+ individual queries)
    opStart = Date.now();
    const allTimings = await (tx as any).dvi_hotspot_timing.findMany({
      where: {
        deleted: 0,
        status: 1,
      },
    });
    
    // Group timings by hotspot_ID and day for O(1) lookup
    const timingMap = new Map<number, Map<number, any[]>>();
    for (const timing of allTimings) {
      const hotspotId = Number(timing.hotspot_ID);
      const day = Number(timing.hotspot_timing_day);
      
      if (!timingMap.has(hotspotId)) {
        timingMap.set(hotspotId, new Map());
      }
      const dayMap = timingMap.get(hotspotId)!;
      if (!dayMap.has(day)) {
        dayMap.set(day, []);
      }
      dayMap.get(day)!.push(timing);
    }
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

    // Track hotspots already added to THIS plan during rebuild to avoid duplicates
    const addedHotspotIds = new Set<number>();
    
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
      
      if (route.location_id) {
        const storedLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: {
            location_ID: Number(route.location_id),
            deleted: 0,
            status: 1,
          },
        });
        
        if (storedLoc) {
          sourceCity = storedLoc.source_location || "";
          destinationCity = storedLoc.destination_location || "";
          currentCoords = {
            lat: Number(storedLoc.source_location_lattitude ?? 0),
            lon: Number(storedLoc.source_location_longitude ?? 0),
          };
          destCityCoords = {
            lat: Number(storedLoc.destination_location_lattitude ?? 0),
            lon: Number(storedLoc.destination_location_longitude ?? 0),
          };
        }
      }

      // Fallback to route fields if not found
      if (!sourceCity) sourceCity = ((route.location_name as string) || "").split('|')[0].trim();
      if (!destinationCity) destinationCity = ((route.next_visiting_location as string) || "").split('|')[0].trim();

      const routeStartLocationName = currentLocationName;
      const routeStartCoords = currentCoords
        ? { lat: Number(currentCoords.lat ?? 0), lon: Number(currentCoords.lon ?? 0) }
        : null;

      // Route-level hotel context is reused for both hotspot gating and final hotel segment.
      const hotelInfoForRoute = await this.getHotelDetailsForRoute(
        tx,
        planId,
        route.itinerary_route_ID,
      );

      const normalizedArrivalCity = this.canonicalCityKey(arrivalPoint);
      const isArrivalCityStayRoute =
        isFirstRoute &&
        this.canonicalCityKey(sourceCity) === normalizedArrivalCity &&
        this.canonicalCityKey(destinationCity) === normalizedArrivalCity;

      const routeDateForPolicy = route.itinerary_route_date
        ? this.toDateOnly(new Date(route.itinerary_route_date))
        : this.toDateOnly(new Date(plan.trip_start_date_and_time || plan.trip_start_date));

      const tripStartForPolicy =
        plan.trip_start_date_and_time instanceof Date
          ? plan.trip_start_date_and_time
          : null;

      const arrivalMinutesForPolicy = tripStartForPolicy
        ? tripStartForPolicy.getUTCHours() * 60 + tripStartForPolicy.getUTCMinutes()
        : 0;

      const arrivalDayForPolicy = tripStartForPolicy
        ? this.toDateOnly(tripStartForPolicy).getTime() === routeDateForPolicy.getTime()
        : false;

      const decisionState =
        isFirstRoute
          ? await this.getArrivalPolicyDecisionStateForRoute(
              tx,
              planId,
              route.itinerary_route_ID,
              routeDateForPolicy,
            )
          : {
              previousDayBillingDecisionProvided: false,
              previousDayBillingConfirmed: false,
            };

      const evaluatedArrivalPolicy =
        isFirstRoute && tripStartForPolicy
          ? evaluateArrivalHotelPolicy({
              isArrivalDay: arrivalDayForPolicy,
              arrivalMinutes: arrivalMinutesForPolicy,
              routeDate: routeDateForPolicy,
              previousDayBillingDecisionProvided:
                decisionState.previousDayBillingDecisionProvided,
              previousDayBillingConfirmed: decisionState.previousDayBillingConfirmed,
            })
          : null;

      const isEarlyArrivalDeclinedSameDayFlow =
        !!evaluatedArrivalPolicy &&
        evaluatedArrivalPolicy.arrivalWindow === ArrivalWindow.EARLY_01_TO_0759 &&
        evaluatedArrivalPolicy.resolutionStatus === PolicyResolutionStatus.RESOLVED &&
        evaluatedArrivalPolicy.hotelFlowAction === HotelFlowAction.DIRECT_SIGHTSEEING &&
        evaluatedArrivalPolicy.deferHotelToEndOfDay &&
        evaluatedArrivalPolicy.hotelSearchMode === HotelSearchMode.SAME_DAY;

      const isEarlyArrivalAwaitingDecisionSameDayFlow =
        !!evaluatedArrivalPolicy &&
        evaluatedArrivalPolicy.arrivalWindow === ArrivalWindow.EARLY_01_TO_0759 &&
        evaluatedArrivalPolicy.resolutionStatus ===
          PolicyResolutionStatus.AWAITING_PREVIOUS_DAY_BILLING_CONFIRMATION &&
        evaluatedArrivalPolicy.deferHotelToEndOfDay &&
        evaluatedArrivalPolicy.hotelSearchMode === HotelSearchMode.SAME_DAY;

      const suppressHotelInsertionUntilEndOfDay =
        isFirstRoute &&
        (isEarlyArrivalDeclinedSameDayFlow ||
          isEarlyArrivalAwaitingDecisionSameDayFlow);

      const enforceStrictDay1EarlyArrivalDeferredFlow =
        suppressHotelInsertionUntilEndOfDay;
      const firstSightseeingMovementTime =
        enforceStrictDay1EarlyArrivalDeferredFlow ? '09:00:00' : null;

      const isEarlyArrivalPrevDayConfirmed =
        !!evaluatedArrivalPolicy &&
        evaluatedArrivalPolicy.arrivalWindow === ArrivalWindow.EARLY_01_TO_0759 &&
        evaluatedArrivalPolicy.resolutionStatus === PolicyResolutionStatus.RESOLVED &&
        evaluatedArrivalPolicy.hotelFlowAction === HotelFlowAction.DIRECT_HOTEL &&
        evaluatedArrivalPolicy.hotelSearchMode === HotelSearchMode.PREVIOUS_DAY;

      if (enforceStrictDay1EarlyArrivalDeferredFlow) {
        // Hard policy rule: Day-1 deferred hotel flow must begin with 08:00-09:00 buffer.
        effectiveRouteStartTime = '08:00:00';
        currentTime = effectiveRouteStartTime;
        routeStartSeconds = timeToSeconds(effectiveRouteStartTime);
        routeEndSeconds = computeRouteEndSeconds(routeStartSeconds);
        if (isLastRoute) {
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
            lastRouteArrivalDeadlineSeconds = routeEndSeconds;
          }
        }
      }

      const arrivalHour =
        isFirstRoute && plan.trip_start_date_and_time instanceof Date
          ? plan.trip_start_date_and_time.getUTCHours()
          : null;
      const isArrivalAfterNoon =
        isFirstRoute && arrivalHour !== null && arrivalHour >= 12;
      const isSpecialDay1OnePmHotelFirstFlow =
        isFirstRoute &&
        isArrivalCityStayRoute &&
        arrivalHour === 13;

      const fullDayMarkerRaw =
        (route as any).is_full_day_trip ??
        (route as any).full_day_trip ??
        (route as any).day_trip ??
        (route as any).is_day_trip ??
        null;

      const hasReliableFullDayMarker =
        fullDayMarkerRaw !== null && fullDayMarkerRaw !== undefined;

      const isFullDayTrip = hasReliableFullDayMarker
        ? (typeof fullDayMarkerRaw === "boolean"
            ? fullDayMarkerRaw
            : Number(fullDayMarkerRaw) === 1)
        : false;

      const fallbackHotelCoords = hotelInfoForRoute?.coords || destCityCoords;

      let hotelDistanceFromArrivalKm: number | null = null;
      if (
        isFirstRoute &&
        isArrivalCityStayRoute &&
        currentCoords &&
        fallbackHotelCoords
      ) {
        hotelDistanceFromArrivalKm = this.distanceHelper.calculateHaversine(
          Number(currentCoords.lat || 0),
          Number(currentCoords.lon || 0),
          Number(fallbackHotelCoords.lat || 0),
          Number(fallbackHotelCoords.lon || 0),
        );
      }

      const shouldHotelFirstByDistance =
        isFirstRoute &&
        isArrivalCityStayRoute &&
        isArrivalAfterNoon &&
        hotelDistanceFromArrivalKm != null &&
        hotelDistanceFromArrivalKm <= 20;

      const shouldHotelLastByDistance =
        isFirstRoute &&
        isArrivalCityStayRoute &&
        hotelDistanceFromArrivalKm != null &&
        hotelDistanceFromArrivalKm > 20;

      this.logBookingRule({
        rule: 'HOTEL_DISTANCE_BRANCH',
        quoteId:
          (plan as any).quote_id ??
          (plan as any).quoteId ??
          (plan as any).quote_ID ??
          null,
        planId,
        routeId: route.itinerary_route_ID,
        isFirstRoute,
        sameCityStay: isArrivalCityStayRoute,
        arrivalAfterNoon: isArrivalAfterNoon,
        hotelDistanceFromArrivalKm:
          hotelDistanceFromArrivalKm != null
            ? Number(hotelDistanceFromArrivalKm.toFixed(2))
            : null,
        shouldHotelFirstByDistance,
        shouldHotelLastByDistance,
      });

      let didHotelFirstCheckin = false;

      // PHP parity:
      // - Keep houseboat suppression.
      // - Do NOT suppress sightseeing based on full-day marker heuristics.
      let forceNoSightseeingOnThisRoute =
        !!hotelInfoForRoute?.isHouseboat;

      // Final transfer routes (airport/station) are allowed to include sightseeing.
      // The effective route_end_time already represents the latest allowable sightseeing cutoff
      // after subtracting departure buffer and travel-to-terminal duration.

      // ✅ LATE ARRIVAL RULE: If arrival is 5 PM (17:00) or later on Day 1, skip all sightseeing
      // User goes directly to hotel check-in (no time for sightseeing same day).
      // Uses trip_start_date_and_time if available, falls back to route_start_time.
      if (isFirstRoute) {
        // Determine arrival hour: prefer plan-level field, fall back to route start time
        const lateArrivalHour = (plan.trip_start_date_and_time instanceof Date)
          ? plan.trip_start_date_and_time.getUTCHours()
          : parseInt(routeStartTime.split(':')[0], 10);

        // Hours 17-23 = 5 PM to midnight, hour 0 = midnight (treated as very late)
        const isLateOrNightArrival = lateArrivalHour >= 17 || lateArrivalHour === 0;

        if (isLateOrNightArrival) {
          forceNoSightseeingOnThisRoute = true;
          this.logTimeline('[TIMELINE] LATE_ARRIVAL_SKIP_SIGHTSEEING', {
            quoteId: this.currentQuoteId,
            routeId: route.itinerary_route_ID,
            lateArrivalHour,
            routeStartTime,
            message: 'Late arrival (5PM or later) - skipping Day 1 sightseeing, direct hotel check-in',
          });
        }
      }

      if (!!hotelInfoForRoute?.isHouseboat) {
        this.logBookingRule({
          rule: 'HOUSEBOAT_SUPPRESSION',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          triggered: true,
        });
      }

      if (hasReliableFullDayMarker) {
        this.logBookingRule({
          rule: 'FULL_DAY_MARKER_DETECTED',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          markerRaw: fullDayMarkerRaw,
          isFullDayTrip,
          suppressionTriggered: isFullDayTrip,
        });
      }

      this.logBookingRule({
        rule: 'DAY1_BRANCH_SELECTED',
        quoteId:
          (plan as any).quote_id ??
          (plan as any).quoteId ??
          (plan as any).quote_ID ??
          null,
        planId,
        routeId: route.itinerary_route_ID,
        isFirstRoute,
        arrivalHour,
        arrivalAfterNoon: isArrivalAfterNoon,
        sameCityStay: isArrivalCityStayRoute,
        forceNoSightseeingOnThisRoute,
        earlyArrivalDeclinedSameDayFlow: isEarlyArrivalDeclinedSameDayFlow,
        earlyArrivalPrevDayConfirmed: isEarlyArrivalPrevDayConfirmed,
        specialDay1OnePmHotelFirstFlow: isSpecialDay1OnePmHotelFirstFlow,
      });

      const skipInitialRefreshmentForImmediateHotelCheckin =
        isEarlyArrivalPrevDayConfirmed || isSpecialDay1OnePmHotelFirstFlow;

      // 1) ADD REFRESHMENT BREAK (PHP line 969-993)
      // PHP adds 1-hour refreshment at route start EXCEPT for last route
      // Last route starts directly with hotspots (order 2) and skips refreshment ROW
      // BUT PHP still advances currentTime by buffer amount for last route (without creating row)
      if (!isLastRoute && !skipInitialRefreshmentForImmediateHotelCheckin) {
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
      } else if (isLastRoute) {
        // PHP BEHAVIOR: Last route doesn't create refreshment ROW but still advances time
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

      // Day-1 same-city distance rule:
      // <=20 km and after noon -> allow hotel-first check-in with a 2h rest gap,
      // then continue current hotspot selection logic.
      // PHP parity: do not pre-empt hotspot selection with hotel-first check-in/rest flow.
      if (
        !isLastRoute &&
        !suppressHotelInsertionUntilEndOfDay &&
        (isEarlyArrivalPrevDayConfirmed || isSpecialDay1OnePmHotelFirstFlow || shouldHotelFirstByDistance)
      ) {
        const hotelOrder = order;
        const sourceCityForHotel = currentLocationName.split("|")[0].trim();
        const destinationCityForHotel =
          ((route.next_visiting_location as string) || currentLocationName)
            .split("|")[0]
            .trim();
        const resolvedHotelCoords = hotelInfoForRoute?.coords || destCityCoords || currentCoords;

        const { row: toHotelRow, nextTime: hotelArrivalTime } =
          await this.hotelBuilder.buildToHotel(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: hotelOrder,
            startTime: currentTime,
            travelLocationType: 1,
            userId: createdByUserId,
            sourceLocationName: sourceCityForHotel,
            destinationLocationName: destinationCityForHotel,
            sourceCoords: currentCoords,
            destCoords: resolvedHotelCoords,
          });

        this.logBookingRule({
          rule: 'HOTEL_FIRST_SELECTED',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          hotelDistanceFromArrivalKm:
            hotelDistanceFromArrivalKm != null
              ? Number(hotelDistanceFromArrivalKm.toFixed(2))
              : null,
          arrivalAfterNoon: isArrivalAfterNoon,
          sameCityStay: isArrivalCityStayRoute,
        });

        const checkInClampApplied =
          !isEarlyArrivalPrevDayConfirmed &&
          !isSpecialDay1OnePmHotelFirstFlow &&
          timeToSeconds(hotelArrivalTime) < timeToSeconds("14:00:00");
        const checkInTime = isSpecialDay1OnePmHotelFirstFlow
          ? "14:00:00"
          : (checkInClampApplied ? "14:00:00" : hotelArrivalTime);

        if (checkInClampApplied) {
          this.logBookingRule({
            rule: 'CHECKIN_CLAMP_APPLIED',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            clampTo: '14:00:00',
            context: 'hotel_first',
          });
        }

        hotspotRows.push({
          ...toHotelRow,
          hotspot_end_time: TimeConverter.toDate(checkInTime),
        });

        const { row: hotelCheckinRow, nextTime: checkinCloseTime } =
          await this.hotelBuilder.buildReturnToHotel(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: hotelOrder,
            startTime: checkInTime,
            userId: createdByUserId,
          });

        hotspotRows.push(hotelCheckinRow);
        order++;

        const restGap = isSpecialDay1OnePmHotelFirstFlow ? '01:00:00' : HOTEL_FIRST_REST_GAP;
        const { row: restRow, nextTime: afterRestTime } = this.refreshmentBuilder.build(
          planId,
          route.itinerary_route_ID,
          order++,
          checkinCloseTime,
          restGap,
          createdByUserId,
        );

        hotspotRows.push(restRow);
        this.logBookingRule({
          rule: 'REST_GAP_INSERTED',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          restMinutes: isSpecialDay1OnePmHotelFirstFlow ? 60 : 120,
          insertedAfter: 'hotel_checkin',
          hotelCoordsResolved: !!resolvedHotelCoords,
        });
        currentTime = afterRestTime;
        currentLocationName = hotelInfoForRoute?.hotelName ? "Hotel" : destinationCityForHotel;
        currentCoords = resolvedHotelCoords || currentCoords;
        didHotelFirstCheckin = true;
      }

      // 2) CALCULATE LATEST HOTSPOT END USING ROUTE'S CONFIGURED END TIME
      // Use route_end_time (not hardcoded cutoffs) so users can adjust end time
      let latestNonHotelEndSeconds = routeEndSeconds; // Default: route end time
      let latestNonHotelEndTime = routeEndTime; // Default string representation
      
      if (!isLastRoute) {
        // Get travel time for the intercity leg: source city → destination city (outstation type=2).
        // Must use sourceCity→destinationCity, NOT destinationCity→destinationCity,
        // otherwise same-city lookup returns ~0 and the cutoff is never reduced.
        const hotelTravelResult = await this.distanceHelper.fromSourceAndDestination(
          tx,
          sourceCity,
          destinationCity,
          2, // type=2 (outstation travel)
          undefined, // no coord bias — use DB city-level distance
          destCityCoords,
        );
        
        const travelPlusBufferSeconds = 
          timeToSeconds(hotelTravelResult.travelTime) + 
          timeToSeconds(hotelTravelResult.bufferTime);
        
        // Latest hotspot end = route end time - travel to hotel
        latestNonHotelEndSeconds = routeEndSeconds - travelPlusBufferSeconds;
        
        // Convert to time string for logging
        if (latestNonHotelEndSeconds > 0) {
          const hours = Math.floor(latestNonHotelEndSeconds / 3600);
          const minutes = Math.floor((latestNonHotelEndSeconds % 3600) / 60);
          const seconds = latestNonHotelEndSeconds % 60;
          latestNonHotelEndTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
        } else {
          latestNonHotelEndSeconds = 0;
          latestNonHotelEndTime = "00:00:00";
        }
      }

      // 2) SELECTED HOTSPOTS FOR THIS ROUTE
      // DAY-1 DIFFERENT CITIES: If Day 1 and source city != destination city, enforce max 3 priority hotspots
      let selectedHotspots: SelectedHotspot[] = [];

      if (forceNoSightseeingOnThisRoute) {
        selectedHotspots = [];
      }
      
      const day1SourceCompare = this.canonicalCityKey(String(sourceCity || ''));
      const day1DestinationCompare = this.canonicalCityKey(String(destinationCity || ''));
      const nextRoute = routeIndex < routes.length ? routes[routeIndex] : null;
      const previousRouteForCurrent = previousRouteByRouteId.get(Number((route as any).itinerary_route_ID || 0));
      const sameCityContinuationContextForRoute = this.buildSameCityContinuationContext(
        route,
        previousRouteForCurrent,
        hotspotRows,
      );
      const nextRouteSourceCompare = this.canonicalCityKey(String((nextRoute as any)?.location_name || ''));
      const nextRouteDestinationCompare = this.canonicalCityKey(
        String((nextRoute as any)?.next_visiting_location || ''),
      );
      const currentRouteCityForCarry = this.canonicalCityKey(String((route as any).next_visiting_location || (route as any).location_name || ''));
      const nextRouteSameCityContinuation =
        !!nextRoute &&
        !!currentRouteCityForCarry &&
        (currentRouteCityForCarry === nextRouteSourceCompare || currentRouteCityForCarry === nextRouteDestinationCompare);

      if (carryForwardHotspots.length > 0 && !sameCityContinuationContextForRoute.isSameCityChainContinuation) {
        this.logBookingRule({
          rule: 'STRICT_CARRY_FORWARD_EXPIRED',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          pendingHotspotIds: carryForwardHotspots.map((h) => Number((h as any).hotspot_ID || 0)).filter((id) => id > 0),
          reason: 'Same-city continuation chain ended before carry-forward consumption.',
        });
        carryForwardHotspots = [];
      }
      const isDay1DifferentCities =
        isFirstRoute &&
        day1SourceCompare &&
        day1DestinationCompare &&
        day1SourceCompare !== day1DestinationCompare &&
        (route as any).direct_to_next_visiting_place !== 1;
      const isEligibleForDestinationReservation =
        !isFirstRoute &&
        !isLastRoute &&
        day1SourceCompare !== '' &&
        day1DestinationCompare !== '' &&
        day1SourceCompare !== day1DestinationCompare &&
        !!nextRoute &&
        nextRouteSourceCompare !== '' &&
        nextRouteDestinationCompare !== '' &&
        nextRouteSourceCompare === day1DestinationCompare &&
        nextRouteDestinationCompare === day1DestinationCompare;
      const isRouteSourceTerminal = /airport|railway station/i.test(
        String(sourceCity || route.location_name || ''),
      );
      const tracePhpIncludeFlow = this.verboseTimelineProofLogs;
      const isLoopbackRoute =
        day1SourceCompare !== '' &&
        day1SourceCompare === day1DestinationCompare;
      const shouldApplySourceHotspotCutoff = !isLoopbackRoute;

      if (isDay1DifferentCities) {
        this.logBookingRule({
          rule: 'EN_ROUTE_SIGHTSEEING_BRANCH',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          sourceCity,
          destinationCity,
          directToNext: Number((route as any).direct_to_next_visiting_place || 0),
          enabled: true,
        });
      }
      
      if (!forceNoSightseeingOnThisRoute) {
        if (isDay1DifferentCities) {
        const directToNext = Number((route as any).direct_to_next_visiting_place || 0);

        if (directToNext === 1) {
          selectedHotspots = await this.fetchSelectedHotspotsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
          );
        } else {
          // PHP parity: for Day-1 different-cities non-direct routes, do not suppress
          // destination hotspots. Example: "Chennai International Airport -> Chennai"
          // should still allow Chennai destination hotspots on Day 1.
          selectedHotspots = await this.fetchSelectedHotspotsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
            undefined,
            false,
          );

          // Fallback to strict source-priority fetch if route matching returns nothing.
          if (!selectedHotspots.length) {
            selectedHotspots = await this.fetchDay1TopPrioritySourceHotspots(
              tx,
              planId,
              route.itinerary_route_ID,
              sourceCity,
              destinationCity,
            );
          }

          // PHP parity tuning for Day-1 non-direct airport/city routes:
          // keep tie-order deterministic for zero-priority carry spots.
          selectedHotspots.sort((a, b) => {
            const ap = Number((a as any).hotspot_priority ?? 0);
            const bp = Number((b as any).hotspot_priority ?? 0);
            const ar = ap > 0 ? ap : 9999;
            const br = bp > 0 ? bp : 9999;
            if (ar !== br) return ar - br;

            if (ar === 9999 && br === 9999) {
              return Number(a.hotspot_ID || 0) - Number(b.hotspot_ID || 0);
            }

            const ad = Number((a as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
            const bd = Number((b as any).hotspot_distance ?? Number.POSITIVE_INFINITY);
            if (ad !== bd) return ad - bd;
            return Number(a.hotspot_ID || 0) - Number(b.hotspot_ID || 0);
          });
        }
      } else if (isFirstRoute && shouldDeferDay1Sightseeing) {
        // Check if current route is STAYING in arrival city (not just passing through)
        // Only skip if both location_name AND next_visiting_location are in arrival city
        const currentCity = this.canonicalCityKey(currentLocationName);
        const nextCity = this.canonicalCityKey(route.next_visiting_location || '');
        const arrivalCity = this.canonicalCityKey(arrivalPoint);
        
        // CRITICAL FIX: Only skip if STAYING in arrival city, not just starting from there
        // Example: "Madurai Airport → Alleppey" should NOT skip (traveling away)
        // Example: "Madurai Airport → Madurai" SHOULD skip (staying in same city)
        const isStayingInArrivalCity = (currentCity === arrivalCity) && (nextCity === arrivalCity);
        
        if (isStayingInArrivalCity) {
          // Same-city Day 1 should not depend on source label (city vs airport/station).
          // Keep sightseeing enabled consistently for both cases.
          selectedHotspots = await this.fetchSelectedHotspotsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
            undefined,
            false,
          );
        } else {
          // Traveling away from arrival city on Day 1 - apply same direct/non-direct logic
          const directToNext = (route as any).direct_to_next_visiting_place || 0;
          
          if (directToNext === 1) {
            // Direct travel: Skip arrival city hotspots
            
            selectedHotspots = await this.fetchSelectedHotspotsForRoute(
              tx,
              planId,
              route.itinerary_route_ID,
              filteredHotspots,
              undefined, // No source limit for direct travel
            );
          } else {
            // Non-direct travel: Visit all available arrival city hotspots
            
            selectedHotspots = await this.fetchSelectedHotspotsForRoute(
              tx,
              planId,
              route.itinerary_route_ID,
              filteredHotspots,
              undefined, // No limit - schedule all top priority hotspots
              true, // Skip destination hotspots - they'll be added on Day 2
            );
          }
        }
      } else if (isFirstRoute && !shouldDeferDay1Sightseeing) {
        // Day 1 traveling to different city - check direct flag
        const directToNext = (route as any).direct_to_next_visiting_place || 0;
        
        if (directToNext === 1) {
          // Direct travel: Skip arrival city hotspots, go straight to destination
          // Fetch destination city hotspots only (fetchSelectedHotspotsForRoute handles direct flag internally)
          
          selectedHotspots = await this.fetchSelectedHotspotsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
            undefined, // No source limit for direct travel (will skip source anyway)
          );
        } else {
          // Non-direct travel: Visit all available arrival city hotspots
          
          // Fetch all available hotspots, skip destination (will be on Day 2)
          selectedHotspots = await this.fetchSelectedHotspotsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
            undefined, // No limit - schedule all top priority hotspots
            true, // Skip destination hotspots - they'll be added on Day 2
          );
        }
      } else if (isLastRoute && shouldDeferDay1Sightseeing) {
        // Last day in departure city - fetch hotspots for departure city sightseeing
        const currentCity = this.canonicalCityKey(currentLocationName);
        const departureCity = this.canonicalCityKey(departurePoint);
        
        if (currentCity === departureCity) {
          // Do local sightseeing on last day
          
          // Fetch hotspots for this city (will get popular spots)
          selectedHotspots = await this.fetchSelectedHotspotsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
          );
        } else {
          // Normal last route
          selectedHotspots = await this.fetchSelectedHotspotsForRoute(
            tx,
            planId,
            route.itinerary_route_ID,
            filteredHotspots,
          );
        }
      } else {
        // Normal route - fetch hotspots
        selectedHotspots = await this.fetchSelectedHotspotsForRoute(
          tx,
          planId,
          route.itinerary_route_ID,
          filteredHotspots,
        );
      }

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

      }

      // NO LUNCH BREAKS OR TIME CUTOFFS - User can schedule all hotspots and delete unwanted ones from UI
      // Day 1: Schedule ALL top priority hotspots without time constraints
      // User can reach hotel at any time

      // STRATEGY: For Day-1 different cities, process hotspots with strict priority walk
      // For other days, use multi-pass scheduling to fill gaps with deferred hotspots
      
      const manualPlacementByRoute = options?.manualPlacementByRoute || {};
      const manualExistingForRoute = (existingHotspots || []).filter((row: any) =>
        Number(row?.itinerary_route_ID || 0) === Number(route.itinerary_route_ID) &&
        Number(row?.hotspot_plan_own_way || 0) === 1 &&
        Number(row?.deleted || 0) === 0 &&
        Number(row?.hotspot_ID || 0) > 0,
      );

      if (manualExistingForRoute.length > 0) {
        const selectedById = new Map<number, any>();
        for (const sh of selectedHotspots as any[]) {
          const id = Number((sh as any).hotspot_ID || 0);
          if (id > 0 && !selectedById.has(id)) {
            selectedById.set(id, sh);
          }
        }

        const mergedManuals = manualExistingForRoute.map((manual: any, index: number) => {
          const hotspotId = Number(manual?.hotspot_ID || 0);
          const preferredOrder = Number((manualPlacementByRoute as any)?.[Number(route.itinerary_route_ID)]?.hotspotOrder || 0);
          const manualOrder = preferredOrder > 0
            ? preferredOrder
            : Number(manual?.hotspot_order || index + 1 || 1);
          const existing = selectedById.get(hotspotId) || {};

          return {
            ...existing,
            hotspot_ID: hotspotId,
            display_order: manualOrder,
            hotspot_priority: Number((existing as any)?.hotspot_priority ?? (manualOrder || 0)),
            matched_bucket: 'manual',
            isManualSelection: true,
          } as any;
        });

        for (const manual of mergedManuals) {
          selectedById.set(Number((manual as any).hotspot_ID || 0), manual);
        }

        selectedHotspots = Array.from(selectedById.values()).sort((a: any, b: any) => {
          const ao = Number((a as any).display_order || Number.MAX_SAFE_INTEGER);
          const bo = Number((b as any).display_order || Number.MAX_SAFE_INTEGER);
          if (ao !== bo) return ao - bo;
          const am = (a as any).isManualSelection ? 0 : 1;
          const bm = (b as any).isManualSelection ? 0 : 1;
          if (am !== bm) return am - bm;
          return Number((a as any).hotspot_ID || 0) - Number((b as any).hotspot_ID || 0);
        });
      }

      let shouldReserveDestinationHotspotsForNextLoopbackDay = false;
      let nextLoopbackAvailableCount = 0;
      let nextLoopbackMinimumRequired = MIN_DESTINATION_HOTSPOTS_FOR_RESERVATION;
      if (isEligibleForDestinationReservation && nextRoute) {
        const nextRouteCandidates = await this.fetchSelectedHotspotsForRoute(
          tx,
          planId,
          Number((nextRoute as any).itinerary_route_ID || 0),
          allHotspots,
        );
        const uniqueNextRouteIds = new Set<number>();
        for (const candidate of nextRouteCandidates as any[]) {
          const hotspotId = Number((candidate as any).hotspot_ID || 0);
          if (!hotspotId || uniqueNextRouteIds.has(hotspotId)) continue;
          uniqueNextRouteIds.add(hotspotId);
          if (addedHotspotIds.has(hotspotId)) continue;
          nextLoopbackAvailableCount++;
        }

        const nextRouteCapacity = this.estimateRouteHotspotCapacity(nextRoute as any);
        nextLoopbackMinimumRequired = Math.max(
          1,
          Math.min(MIN_DESTINATION_HOTSPOTS_FOR_RESERVATION, nextRouteCapacity),
        );

        shouldReserveDestinationHotspotsForNextLoopbackDay =
          nextLoopbackAvailableCount >= nextLoopbackMinimumRequired;

        this.logBookingRule({
          rule: 'DESTINATION_RESERVATION_FEASIBILITY_CHECK',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          sourceCity,
          destinationCity,
          nextRouteId: Number((nextRoute as any).itinerary_route_ID || 0),
          availableCount: nextLoopbackAvailableCount,
          minimumRequired: nextLoopbackMinimumRequired,
          staticMinimumCap: MIN_DESTINATION_HOTSPOTS_FOR_RESERVATION,
          willReserve: shouldReserveDestinationHotspotsForNextLoopbackDay,
          reason:
            'Reserve destination hotspots for next loopback day only when destination has enough candidates for estimated route capacity.',
        });
      }

      if (shouldReserveDestinationHotspotsForNextLoopbackDay) {
        const beforeCount = selectedHotspots.length;
        selectedHotspots = selectedHotspots.filter((h: any) => {
          if ((h as any).isManualSelection) return true;
          const bucket = String((h as any).matched_bucket || '').toLowerCase();
          return bucket !== 'destination' && bucket !== 'dest';
        });

        // Enforce plan-level uniqueness before scheduling to avoid Day2 repeats.
        // This keeps selectedHotspots focused on fresh candidates only.
        selectedHotspots = selectedHotspots.filter((h: any) => {
          if ((h as any).isManualSelection) return true;
          const hotspotId = Number((h as any).hotspot_ID || 0);
          if (!hotspotId) return false;
          return !addedHotspotIds.has(hotspotId);
        });

        const sourceFallback = await this.fetchDay1TopPrioritySourceHotspots(
          tx,
          planId,
          route.itinerary_route_ID,
          sourceCity,
          destinationCity,
          addedHotspotIds,
          Math.max(6, Math.min(20, this.estimateRouteHotspotCapacity(route as any) * 2)),
          true,
        );

        if (sourceFallback.length > 0) {
          const selectedById = new Map<number, any>();
          for (const hs of selectedHotspots as any[]) {
            const id = Number((hs as any).hotspot_ID || 0);
            if (id > 0 && !selectedById.has(id)) selectedById.set(id, hs);
          }

          const sourceFallbackRows = sourceFallback.map((h: any) => ({
            ...h,
            matched_bucket: 'source_fallback',
          }));

          for (const hs of sourceFallbackRows as any[]) {
            const id = Number((hs as any).hotspot_ID || 0);
            if (id > 0 && !selectedById.has(id)) selectedById.set(id, hs);
          }

          // Keep source fallback hotspots first so Day 2 favors Chennai-side fresh candidates.
          selectedHotspots = [
            ...sourceFallbackRows,
            ...selectedHotspots,
          ].filter((hs: any, idx: number, arr: any[]) => {
            const id = Number((hs as any).hotspot_ID || 0);
            if (!id) return false;
            return arr.findIndex((x: any) => Number((x as any).hotspot_ID || 0) === id) === idx;
          });
        }

        this.logBookingRule({
          rule: 'DESTINATION_HOTSPOTS_RESERVED_FOR_NEXT_LOOPBACK_DAY',
          quoteId:
            (plan as any).quote_id ??
            (plan as any).quoteId ??
            (plan as any).quote_ID ??
            null,
          planId,
          routeId: route.itinerary_route_ID,
          sourceCity,
          destinationCity,
          nextRouteId: Number((nextRoute as any)?.itinerary_route_ID || 0),
          nextRouteSource: String((nextRoute as any)?.location_name || ''),
          nextRouteDestination: String((nextRoute as any)?.next_visiting_location || ''),
          nextLoopbackAvailableCount,
          filteredCount: Math.max(0, beforeCount - selectedHotspots.length),
          remainingCount: selectedHotspots.length,
          usedSourceFallback: selectedHotspots.some((h: any) => String((h as any).matched_bucket || '') === 'source_fallback'),
          reason:
            'Intercity route before destination loopback day: reserve destination-city hotspots for next day to avoid same-plan dedup exhaustion.',
        });
      }

      if (!forceNoSightseeingOnThisRoute && carryForwardHotspots.length > 0 && sameCityContinuationContextForRoute.isSameCityChainContinuation) {
        const carryIds = carryForwardHotspots
          .map((h) => Number((h as any).hotspot_ID || 0))
          .filter((id) => id > 0);

        selectedHotspots = this.mergeCarryForwardIntoCandidates(
          carryForwardHotspots,
          selectedHotspots,
          addedHotspotIds,
        );

        this.logBookingRule({
          rule: 'STRICT_CARRY_FORWARD_ATTACHED',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          attachedHotspotIds: carryIds,
          mergedCandidateCount: selectedHotspots.length,
          reason: 'Merged carry-forward strict hotspots ahead of normal same-city candidates.',
        });
      }

      this.logTimeline('[TIMELINE] Selected hotspots for route:', selectedHotspots.length);
      // Matrix-assisted auto-build merge (optional, behind feature flag)
      try {
        const matrixEnabled = String(process.env.HOTSPOT_MATRIX_AUTOBUILD || 'false').toLowerCase() === 'true';
        if (matrixEnabled) {
          this.logTimeline('[MATRIX_AUTOBUILD_ENABLED] routeId', route.itinerary_route_ID);

          // Load route's active attraction hotspots to derive slot pairs
          const routeAttractions: any[] = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
            where: { itinerary_route_ID: Number(route.itinerary_route_ID), item_type: 4, deleted: 0, status: 1 },
            orderBy: { hotspot_order: 'asc' },
            select: { hotspot_ID: true },
          });

          const routeHotspotIds = (routeAttractions || []).map((r: any) => Number(r.hotspot_ID || 0)).filter((id: number) => id > 0);
          const slotPairs: Array<{ fromId: number; toId: number }> = [];
          for (let i = 0; i < routeHotspotIds.length - 1; i++) {
            const a = routeHotspotIds[i];
            const b = routeHotspotIds[i + 1];
            if (a && b && a !== b) slotPairs.push({ fromId: a, toId: b });
          }

          if (slotPairs.length > 0) {
            const matrixMap = await this.getBetweenCandidatesForRouteSlots(tx, slotPairs);

            for (const slot of slotPairs) {
              const key = `${slot.fromId}_${slot.toId}`;
              const rows = matrixMap.get(key) || [];
              if (!rows.length) continue;

              for (const r of rows) {
                this.logTimeline('[MATRIX] MATRIX_CANDIDATE_FOUND', { routeId: route.itinerary_route_ID, slotFrom: slot.fromId, slotTo: slot.toId, between: r.between_hotspot_id });

                const fitType = String(r.route_fit_type || '').toUpperCase();
                if (!['ON_ROUTE', 'MINOR_DETOUR'].includes(fitType)) {
                  this.logTimeline('[MATRIX] MATRIX_CANDIDATE_REJECTED_ROUTE_FIT', { routeId: route.itinerary_route_ID, between: r.between_hotspot_id, fitType });
                  continue;
                }

                const candidateId = Number(r.between_hotspot_id || 0);
                if (!candidateId) continue;
                const candidateMaster = (hotspotMap.get(candidateId) || {}) as any;
                const masterLocation = String(candidateMaster?.hotspot_location || '');
                const masterToLocation = String(candidateMaster?.hotspot_to_location || '');
                const masterLocationKey = this.canonicalCityKey(masterLocation);
                const masterToLocationKey = this.canonicalCityKey(masterToLocation);
                const isCorridorMasterHotspot = !!masterLocationKey && !!masterToLocationKey && masterLocationKey !== masterToLocationKey;
                const corridorBelongsToCurrentRoute =
                  this.hotspotLocationMatchesCity(masterLocation, sourceCity) &&
                  this.hotspotLocationMatchesCity(masterToLocation, destinationCity);
                if (isCorridorMasterHotspot && !corridorBelongsToCurrentRoute) {
                  if (candidateId === 228 || candidateId === 357) {
                    this.logBookingRule({
                      rule: 'BETWEEN_MAP_228_357_PROOF',
                      quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                      planId,
                      routeId: route.itinerary_route_ID,
                      fromHotspotId: slot.fromId,
                      toHotspotId: slot.toId,
                      betweenHotspotId: candidateId,
                      routeFitType: fitType,
                      currentTime,
                      accepted: false,
                      rejectedReason: 'corridor_between_hotspot_not_owned_by_current_route',
                      insertedBy: 'hotspot_route_between_map',
                    });
                  }
                  this.logBookingRule({
                    rule: 'CORRIDOR_BETWEEN_HOTSPOT_WRONG_ROUTE_BLOCKED',
                    quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                    planId,
                    routeId: route.itinerary_route_ID,
                    hotspotId: candidateId,
                    hotspotName: String(candidateMaster?.hotspot_name || ''),
                    sourceCity,
                    destinationCity,
                    masterLocation,
                    masterToLocation,
                    reason: 'corridor_between_hotspot_not_owned_by_current_route',
                  });
                  continue;
                }
                if (candidateId === 228 || candidateId === 357) {
                  this.logBookingRule({
                    rule: 'BETWEEN_MAP_228_357_PROOF',
                    quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                    planId,
                    routeId: route.itinerary_route_ID,
                    fromHotspotId: slot.fromId,
                    toHotspotId: slot.toId,
                    betweenHotspotId: candidateId,
                    routeFitType: fitType,
                    currentTime,
                    accepted: true,
                    rejectedReason: null,
                    insertedBy: 'hotspot_route_between_map',
                  });
                }

                // Respect route-level excluded_hotspot_ids if present on route
                const localExcluded = new Set<number>(Array.isArray((route as any)?.excluded_hotspot_ids) ? ((route as any).excluded_hotspot_ids || []).map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0) : []);
                if (localExcluded.has(candidateId)) {
                  this.logTimeline('[MATRIX] MATRIX_CANDIDATE_SKIPPED_DUPLICATE', { reason: 'excluded', candidateId });
                  continue;
                }

                if (addedHotspotIds.has(candidateId)) {
                  this.logTimeline('[MATRIX] MATRIX_CANDIDATE_SKIPPED_DUPLICATE', { reason: 'already_added', candidateId });
                  continue;
                }

                const exists = selectedHotspots.some((s: any) => Number(s.hotspot_ID || 0) === candidateId);
                if (exists) {
                  this.logTimeline('[MATRIX] MATRIX_CANDIDATE_SKIPPED_DUPLICATE', { reason: 'present_in_candidates', candidateId });
                  continue;
                }

                // Build candidate object (do not override priority/explicit buckets)
                const matrixMatchDirection = (Number(r.from_hotspot_id || 0) === slot.fromId && Number(r.to_hotspot_id || 0) === slot.toId)
                  ? 'EXACT_DIRECTION'
                  : 'REVERSE_CANONICAL_MATCH';

                const candidate: any = {
                  hotspot_ID: candidateId,
                  display_order: 0,
                  hotspot_priority: 0,
                  matched_bucket: 'matrix',
                  matrix_score: 0,
                  matrix_meta: {
                    route_fit_type: fitType,
                    road_detour_km: r.road_detour_km != null ? Number(r.road_detour_km) : null,
                    road_detour_ratio: r.road_detour_ratio != null ? Number(r.road_detour_ratio) : null,
                    candidate_distance_from_ab_route_meters: r.candidate_distance_from_ab_route_meters != null ? Number(r.candidate_distance_from_ab_route_meters) : null,
                    matrixMatchDirection,
                  },
                };

                // Compute a simple matrix score: prefer ON_ROUTE strongly, MINOR_DETOUR moderately,
                // penalize by detour ratio and distance-from-route.
                try {
                  let score = 0;
                  if (fitType === 'ON_ROUTE') score += 100;
                  else if (fitType === 'MINOR_DETOUR') score += 25;
                  const detourRatio = candidate.matrix_meta.road_detour_ratio;
                  if (typeof detourRatio === 'number' && !Number.isNaN(detourRatio)) score -= Math.round(detourRatio * 10);
                  const distMeters = candidate.matrix_meta.candidate_distance_from_ab_route_meters;
                  if (typeof distMeters === 'number' && !Number.isNaN(distMeters)) score -= Math.round(distMeters / 1000);
                  candidate.matrix_score = score;
                } catch (e) {
                  candidate.matrix_score = 0;
                }

                // Timing & route feasibility checks before merging candidate
                try {
                  const hotspotData = (hotspotMap.get(candidateId) || {}) as any;
                  const hotspotDuration = String(hotspotData?.hotspot_duration || '01:00:00');
                  const durationSecs = timeToSeconds(hotspotDuration);
                  const nowSecs = Math.max(routeStartSeconds, timeToSeconds(currentTime));
                  const visitStartSecs = nowSecs;
                  const visitEndSecs = visitStartSecs + Math.max(60, durationSecs);

                  // Reject if visit would exceed route end deadline
                  if (visitEndSecs > routeEndSeconds) {
                    this.logTimeline('[MATRIX] MATRIX_CANDIDATE_REJECTED_ROUTE_END', { routeId: route.itinerary_route_ID, candidateId, visitEndSecs, routeEndSeconds });
                    continue;
                  }

                  // If route date is available, compute php-style day-of-week and consult timingMap
                  const routeDateForMatrix = route.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
                  const localPhpDow = routeDateForMatrix ? ((routeDateForMatrix.getDay() + 6) % 7) : undefined;
                  if (typeof localPhpDow === 'number') {
                    const opCheck = this.checkHotspotOperatingHoursFromMap(timingMap, candidateId, localPhpDow, visitStartSecs, visitEndSecs);
                    if (!opCheck.canVisitNow) {
                      this.logTimeline('[MATRIX] MATRIX_CANDIDATE_REJECTED_TIMING', { routeId: route.itinerary_route_ID, candidateId, nextWindowStart: opCheck.nextWindowStart });
                      continue;
                    }
                  }

                  // Passed checks — merge (append) as optional candidate
                  selectedHotspots.push(candidate);
                  this.logTimeline('[MATRIX] MATRIX_CANDIDATE_MERGED', { routeId: route.itinerary_route_ID, candidateId, matrixMatchDirection, matrix_score: candidate.matrix_score });
                } catch (e) {
                  this.logTimeline('[MATRIX] MATRIX_CANDIDATE_MERGE_ERROR', { err: String(e), candidateId });
                  continue;
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[MATRIX] autobuild merge error:', err);
      }
      // Re-order candidates: preserve manual selections and priority>0 first (protected),
      // then sort remaining candidates by matrix_score desc, then distance asc.
      try {
        const priorityCandidates: any[] = [];
        const nonPriorityCandidates: any[] = [];
        for (const s of selectedHotspots) {
          const priority = Number((s as any).hotspot_priority ?? 0);
          const isManualSelection = Boolean((s as any).isManualSelection);
          if (isManualSelection || priority > 0) priorityCandidates.push(s);
          else nonPriorityCandidates.push(s);
        }

        nonPriorityCandidates.sort((a: any, b: any) => {
          const sa = Number(a.matrix_score ?? 0);
          const sb = Number(b.matrix_score ?? 0);
          if (sa !== sb) return sb - sa; // higher score first
          const da = Number(a.hotspot_distance ?? Number.POSITIVE_INFINITY);
          const db = Number(b.hotspot_distance ?? Number.POSITIVE_INFINITY);
          return da - db; // closer first
        });

        selectedHotspots = [...priorityCandidates, ...nonPriorityCandidates];
        this.logTimeline('[TIMELINE] Candidates reordered (priority preserved, matrix_score applied)');
      } catch (e) {
        this.logTimeline('[TIMELINE] Candidate reorder error', String(e));
      }

      const routeLoopStart = Date.now();
      let hotspotQueryCount = 0;
      let distanceCalcCount = 0;
      let operatingHoursCount = 0;
      
      if (isDay1DifferentCities) {
        // DAY-1 DIFFERENT CITIES: Strict priority walk with operating hour waiting
        // Process each hotspot in priority order, wait for next operating window if needed
        
        for (const sh of selectedHotspots) {
          const bucket = (sh as any).matched_bucket as string | undefined;
          const hotspotPriority = Number((sh as any).hotspot_priority ?? 0);
          const isManualSelection = Boolean((sh as any).isManualSelection);

          if (!isManualSelection && hotspotPriority === 0) {
            this.logHotspotCandidateEvaluation({
              routeId: route.itinerary_route_ID,
              hotspotId: Number(sh.hotspot_ID || 0),
              name: `hotspot_${Number(sh.hotspot_ID || 0)}`,
              matchedBucket: bucket ?? null,
              priority: hotspotPriority,
              isMustVisit: false,
              distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                ? Number((sh as any).hotspot_distance)
                : null,
              openingTime: null,
              closingTime: null,
              visitTime: `${currentTime} - ${currentTime}`,
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: ['Rejected: Day1 strict pass skips priority=0 fillers'],
            });
            continue;
          }

          if (!isManualSelection && hotspotPriority > 3) {
            this.logHotspotCandidateEvaluation({
              routeId: route.itinerary_route_ID,
              hotspotId: Number(sh.hotspot_ID || 0),
              name: `hotspot_${Number(sh.hotspot_ID || 0)}`,
              matchedBucket: bucket ?? null,
              priority: hotspotPriority,
              isMustVisit: false,
              distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                ? Number((sh as any).hotspot_distance)
                : null,
              openingTime: null,
              closingTime: null,
              visitTime: `${currentTime} - ${currentTime}`,
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: ['Rejected: Day1 strict pass skips priority>3'],
            });
            continue;
          }

          if (!isManualSelection && isRouteSourceTerminal && hotspotPriority === 1) {
            this.logHotspotCandidateEvaluation({
              routeId: route.itinerary_route_ID,
              hotspotId: Number(sh.hotspot_ID || 0),
              name: `hotspot_${Number(sh.hotspot_ID || 0)}`,
              matchedBucket: bucket ?? null,
              priority: hotspotPriority,
              isMustVisit: true,
              distanceFromRoute: Number.isFinite(Number((sh as any).hotspot_distance))
                ? Number((sh as any).hotspot_distance)
                : null,
              openingTime: null,
              closingTime: null,
              visitTime: `${currentTime} - ${currentTime}`,
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: ['Rejected: Day1 terminal-arrival priority1 suppression'],
            });
            continue;
          }

          // Skip if already added
          if (addedHotspotIds.has(sh.hotspot_ID)) {
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

          // PHP CUTOFF TIME PARITY (config.php)
          {
            const currentSecs = timeToSeconds(currentTime);
            const sourceCutoffSecs = timeToSeconds('12:00:00');
            const viaCutoffSecs    = timeToSeconds('19:00:00');
            const destCutoffSecs   = timeToSeconds('21:00:00');
            let cutoffHit = false;
            if (bucket === 'source'      && shouldApplySourceHotspotCutoff && currentSecs >= sourceCutoffSecs) cutoffHit = true;
            if (bucket === 'via'         && currentSecs >= viaCutoffSecs)    cutoffHit = true;
            if (bucket === 'destination' && currentSecs >= destCutoffSecs)   cutoffHit = true;
            if (cutoffHit) {
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

          // Get hotspot details from pre-fetched map (NO DB QUERY)
          const hotspotData = hotspotMap.get(sh.hotspot_ID);
          if (!hotspotData) {
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

          const hotspotLocationName = hotspotData.hotspot_location as string || currentLocationName;
          const hotspotDuration = hotspotData.hotspot_duration || '01:00:00';
          const destCoords = {
            lat: Number(hotspotData.hotspot_latitude ?? 0),
            lon: Number(hotspotData.hotspot_longitude ?? 0),
          };
          
          if (!currentCoords) currentCoords = destCoords;

          // Calculate travel time
          distanceCalcCount++;
          const travelTimeToHotspot = await this.calculateTravelTimeWithCoords(
            tx,
            currentLocationName,
            hotspotLocationName,
            currentCoords,
            destCoords,
          );

          const travelDurationSeconds = timeToSeconds(travelTimeToHotspot);
          const currentTimeSeconds = timeToSeconds(currentTime);
          const hotspotDurationSeconds = timeToSeconds(hotspotDuration);
          
          // ⚠️ CRITICAL FIX: Use ABSOLUTE seconds for all validation logic
          // Do NOT wrap until final DB storage
          let absoluteVisitStartSeconds = currentTimeSeconds + travelDurationSeconds;
          let absoluteVisitEndSeconds = absoluteVisitStartSeconds + hotspotDurationSeconds;
          
          // Wrapped times are ONLY for display/builder calls (not for tracking state!)
          // KEY FIX: DO NOT use these for currentTime; keep currentTime in absolute seconds
          let timeAfterTravelWrapped = secondsToTime(wrapToDay(absoluteVisitStartSeconds));
          let timeAfterSightseeingWrapped = secondsToTime(wrapToDay(absoluteVisitEndSeconds));
          
          // For DB persistence, we need wrapped times
          let timeAfterTravel = timeAfterTravelWrapped;
          let timeAfterSightseeing = timeAfterSightseeingWrapped;

          if (tracePhpIncludeFlow) {
            console.log('[PHP_INCLUDE_TRACE_CANDIDATE]', JSON.stringify({
              routeId: route.itinerary_route_ID,
              dayMode: 'day1_different_cities',
              hotspotId: Number(sh.hotspot_ID || 0),
              bucket: (sh as any).matched_bucket ?? null,
              priority: Number((sh as any).hotspot_priority ?? 0),
              gateCurrentTime: currentTime,
              gateTravelStart: timeAfterTravel,
              gateVisitEnd: timeAfterSightseeing,
              routeEndTime,
              phpGates: [
                'duplicate_plan_scope',
                'bucket_cutoff',
                'route_end_time',
                'operating_hours',
              ],
            }));
          }

          // For non-last routes, decide by projected arrival to destination after this visit,
          // not by a fixed route-wide cutoff. This allows additional hotspots when the candidate
          // itself is already close to the destination city/hotel.
          let routeEndRejectionReason: string | null = null;
          let projectedArrivalSeconds: number | null = null;
          let travelToDestSeconds: number | null = null;

          {
            if (!isLastRoute) {
              const projectedArrival = await this.calculateProjectedArrivalToRouteDestination(
                tx,
                route,
                hotspotLocationName,
                absoluteVisitEndSeconds,
                destCoords,
                destCityCoords,
              );
              projectedArrivalSeconds = projectedArrival.projectedArrivalSeconds;
              travelToDestSeconds = projectedArrival.travelToDestSeconds;

              if (projectedArrivalSeconds > routeEndSeconds) {
                routeEndRejectionReason = `Rejected: PHP_GATE_ROUTE_END projected arrival ${secondsToTime(wrapToDay(projectedArrivalSeconds))} exceeds route end ${secondsToTime(routeEndSeconds)}`;
              }
            } else if (absoluteVisitEndSeconds > routeEndSeconds) {
              routeEndRejectionReason = `Rejected: PHP_GATE_ROUTE_END hotspot end ${secondsToTime(wrapToDay(absoluteVisitEndSeconds))} exceeds route end ${secondsToTime(routeEndSeconds)}`;
            }
          }

          if (routeEndRejectionReason) {
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
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: [routeEndRejectionReason],
            });
            continue;
          }


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

          // If hotspot opens later today, wait and schedule in the opening window.
          if (!operatingCheck.canVisitNow && operatingCheck.nextWindowStart) {
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
                    operatingCheck.nextWindowStart
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

          // Add travel segment
          const currentOrder = order;
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
                'Early-arrival declined same-day flow: suppress hotel insertion during hotspot scheduling.',
            });
            continue;
          }
          
          const { row: travelRow } = await this.travelBuilder.buildTravelSegment(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder,
            item_type: 3,
            travelLocationType,
            startTime: currentTime,
            userId: createdByUserId,
            sourceLocationName: currentLocationName,
            destinationLocationName: hotspotLocationName,
            hotspotId: sh.hotspot_ID,
            fromHotspotId: lastAddedHotspotId ?? undefined,
            sourceCoords: currentCoords,
            destCoords: destCoords,
          });

          hotspotRows.push(travelRow);
          const travelArrivalTime = secondsToTime(wrapToDay(currentTimeSeconds + travelDurationSeconds));
          const waitGapSeconds = Math.max(0, timeToSeconds(timeAfterTravel) - timeToSeconds(travelArrivalTime));

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
          addedHotspotIds.add(sh.hotspot_ID);
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
        const skippedHotspots = selectedHotspots.filter(sh => !addedHotspotIds.has(sh.hotspot_ID));

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
                  
                  hotspotRows.push(travelRow);
                  
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
                  addedHotspotIds.add(sh.hotspot_ID);
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

        const isIntercityNonDirectRoute =
          routeSourceKeyForPhase !== '' &&
          routeDestinationKeyForPhase !== '' &&
          routeSourceKeyForPhase !== routeDestinationKeyForPhase &&
          directToNextForPhase !== 1;

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

            if (
              isIntercityNonDirectRoute &&
              this.hotspotLocationMatchesCity(masterLocation, sourceCity) &&
              this.hotspotLocationMatchesCity(masterToLocation, destinationCity)
            ) {
              afterBucket = 'en_route';
              reason = 'scheduler_final_master_source_to_destination_override';
            }

            const next = {
              ...hs,
              matched_bucket: afterBucket,
              __bucket: afterBucket,
              __bucket_reason: reason,
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
          return (
            this.hotspotLocationMatchesCity(master?.hotspot_location, sourceCity) &&
            this.hotspotLocationMatchesCity(master?.hotspot_to_location, destinationCity)
          );
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

          if (priority >= 1 && priority <= 3) {
            return true;
          }
          if (
            isIntercityNonDirectRoute &&
            (bucket === 'en_route' || bucket === 'source_to_destination') &&
            priority >= 1 &&
            priority < 9999
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
            return id > 0 && !addedHotspotIds.has(id);
          });
        };
        const getPendingOptionalCorridorHotspots = (): Array<SelectedHotspot> => {
          return optionalCorridorHotspots.filter((hs: any) => {
            const id = Number(hs?.hotspot_ID || 0);
            return id > 0 && !addedHotspotIds.has(id);
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
                alreadyAdded: addedHotspotIds.has(hotspotId),
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

          if (destinationStrict.length > 0 && nonDestinationStrict.length > 0) {
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

            strictPassHotspots = isIntercityNonDirectRoute
              ? [
                  ...sourceStrict,
                  ...enRouteStrict,
                  ...viaStrict,
                  ...destinationOnlyStrict,
                ]
              : [
                  ...viaStrict,
                  ...sourceStrict,
                  ...destinationOnlyStrict,
                ];

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
                reason:
                'Intercity non-direct route: source hotspots are processed before via/destination to avoid source-city backtracking.',
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
            .filter((id) => id > 0 && addedHotspotIds.has(id))
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
          const hotspotLocation = String((hotspotMap.get(Number(hs?.hotspot_ID || 0)) as any)?.hotspot_location || '');

          if (bucket === 'source') return true;

          if (bucket === 'source_fallback') {
            return this.hotspotLocationMatchesCity(hotspotLocation, sourceCity);
          }

          if (
            bucket === 'matrix' ||
            bucket === 'manual' ||
            bucket === '' ||
            bucket === 'unknown' ||
            bucket === 'carry_forward'
          ) {
            return this.hotspotLocationMatchesCity(hotspotLocation, sourceCity);
          }

          return false;
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

          return (priority * 10) + bucketBias + distanceScore + waitScore + windowFitScore;
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
          if (addedHotspotIds.has(hotspotId)) return false;
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
            scored.sort((a, b) => b.score - a.score);

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
          if (isIntercityNonDirectRoute && pass === PASS_STRICT) {
            const currentSecs = timeToSeconds(currentTime);
            if (currentSecs < sourcePhaseEndSeconds) {
              const remainingSourceCandidates = strictPassHotspots.filter((hs: any) => {
                const id = Number(hs?.hotspot_ID || 0);
                const bucket = String(hs?.matched_bucket || hs?.__bucket || '').toLowerCase();
                return !addedHotspotIds.has(id) && (bucket === 'source' || bucket === 'source_fallback');
              });
              if (remainingSourceCandidates.length > 0) {
                hotspotsToTry = remainingSourceCandidates;
              } else {
                currentTime = secondsToTime(sourcePhaseEndSeconds);
                hotspotsToTry = corridorHotspots.filter((hs: any) => !addedHotspotIds.has(Number(hs?.hotspot_ID || 0)));
              }
            } else {
              hotspotsToTry = pendingPositiveCorridorHotspots.length > 0
                ? pendingPositiveCorridorHotspots
                : corridorHotspots.filter((hs: any) => !addedHotspotIds.has(Number(hs?.hotspot_ID || 0)));
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
                    alreadyAdded: addedHotspotIds.has(hotspotId),
                  };
                }),
            });
          }
          const sourcePhaseActiveNow = isIntercityNonDirectRoute && timeToSeconds(currentTime) < sourcePhaseEndSeconds;
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
                alreadyAdded: addedHotspotIds.has(hotspotId),
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
                added: addedHotspotIds.has(228),
                rejectedReason: null,
              },
              valara: {
                present: !!valara,
                bucket: String((valara as any)?.matched_bucket || (valara as any)?.__bucket || '').toLowerCase(),
                priority: Number((valara as any)?.hotspot_priority ?? 0),
                corridorRank: valara ? getCorridorPriorityRank(valara) : null,
                added: addedHotspotIds.has(357),
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
          .filter((id: number) => id > 0 && !addedHotspotIds.has(id) && !resolvedPositiveCorridorIds.has(id));
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
        if (addedHotspotIds.has(sh.hotspot_ID)) {
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
          const sourcePhaseActive = currentSecs < sourcePhaseEndSeconds;
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
                valaraAlreadyAdded: addedHotspotIds.has(357),
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
          if (isSourceLikeBucket && shouldApplySourceHotspotCutoff && currentSecs >= sourceCutoffSecs && !allowSourceCutoffRetryBypass) cutoffHit = true;
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
                valaraAlreadyAdded: addedHotspotIds.has(357),
              });
            }
            logHotspotBucketTrace({
              hotspotId,
              hotspotName: String((sh as any).hotspot_name || ''),
              bucket: normalizedBucket,
              priority: hotspotPriority,
              currentTime,
              sourcePhaseActive: isIntercityNonDirectRoute && currentSecs < sourcePhaseEndSeconds,
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
          timingMap,
          plan,
          destinationCity,
          lastRouteArrivalDeadlineSeconds,
          allowWaitUntilOpen: true,
          rejectIfOutsideOperatingWindow: true,
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
              valaraAlreadyAdded: addedHotspotIds.has(357),
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

        // 2.c) Build TRAVEL SEGMENT (item_type = 3)
        // PHP BEHAVIOR: Travel and Visit segments share the SAME hotspot_order
        const currentOrder = order;

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
              'Early-arrival declined same-day flow: suppress hotel insertion during hotspot scheduling.',
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
            startTime: currentTime,
            userId: createdByUserId,
            sourceLocationName: currentLocationName,
            destinationLocationName: hotspotLocationName,
            hotspotId: sh.hotspot_ID, // PHP sets hotspot_ID for item_type=3
            fromHotspotId: lastAddedHotspotId ?? undefined,
            sourceCoords: currentCoords, // Use current location coordinates
            destCoords: destCoords,
          });

        hotspotRows.push(travelRow);
        currentTime = tToHotspot;

        const gapBeforeVisitSeconds = Math.max(0, timeToSeconds(timeAfterTravel) - timeToSeconds(currentTime));
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
        addedHotspotIds.add(sh.hotspot_ID);
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
        lastAddedHotspotId = sh.hotspot_ID; // Update for next hotspot-to-hotspot travel segment
        
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
          if (addedHotspotIds.has(slot.hotspotId)) {
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

          const currentOrder = order;
          const travelLocationType = this.getTravelLocationType(currentLocationName, hotspotLocationName);
          const { row: routeTravelRow } = await this.travelBuilder.buildTravelSegment(tx, {
            planId,
            routeId: route.itinerary_route_ID,
            order: currentOrder,
            item_type: 3,
            travelLocationType,
            startTime: currentTime,
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
          if (arrivalSeconds < slot.startSeconds) {
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
          addedHotspotIds.add(slot.hotspotId);
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

      const unscheduledStrictIds = Array.from(strictHotspotIdSet.values()).filter((id) => !addedHotspotIds.has(id));
      const remainingFillerHotspotIds = (fillerHotspots as Array<SelectedHotspot>)
        .map((h) => Number((h as any).hotspot_ID || 0))
        .filter((id) => id > 0 && !addedHotspotIds.has(id));

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
            timingMap,
            plan,
            destinationCity,
            lastRouteArrivalDeadlineSeconds,
            allowWaitUntilOpen: true,
            rejectIfOutsideOperatingWindow: true,
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

          hotspotRows.push(travelRow);
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
          addedHotspotIds.add((sh as any).hotspot_ID);
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
            return id > 0 && p >= 1 && p < 9999 && !addedHotspotIds.has(id);
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
          if (addedHotspotIds.has(hotspotId)) continue;
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
            if (carryExistingIds.has(hotspotId) || addedHotspotIds.has(hotspotId)) continue;
            const strictHotspot = strictPassHotspots.find((h) => Number((h as any).hotspot_ID || 0) === hotspotId);
            if (!strictHotspot) continue;
            const protectedSlot = protectedStrictSlots.find(
              (slot) => slot.routeId === Number(route.itinerary_route_ID || 0) && slot.hotspotId === hotspotId,
            );

            carryForwardHotspots.push({
              ...(strictHotspot as any),
              carryOrder: carryForwardOrder++,
              carriedFromRouteId: Number(route.itinerary_route_ID || 0),
              carriedFromDate: String((route as any).itinerary_route_date || ''),
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
          .filter((h) => !addedHotspotIds.has(Number((h as any).hotspot_ID || 0)));

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
            timingMap,
            plan,
            destinationCity,
            lastRouteArrivalDeadlineSeconds,
            allowWaitUntilOpen: true,
            rejectIfOutsideOperatingWindow: false, // Very permissive for manual
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
                timingMap,
                plan,
                destinationCity,
                lastRouteArrivalDeadlineSeconds,
                allowWaitUntilOpen: true,
                rejectIfOutsideOperatingWindow: false,
              });

              if (reevaluatedManualFeasibility.feasible) {
                canInsert = true;
                break;
              }
            }
          }

          // Now insert the manual hotspot if we have space
          if (canInsert) {
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

            hotspotRows.push(travelRow);
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
            addedHotspotIds.add(manualHotspotId);
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

        const remainingGapSeconds = routeEndSeconds - currentSeconds;
        const hasScheduledVisitOnRoute = hotspotRows.some(
          (row) =>
            Number((row as any).itinerary_route_ID || 0) === Number(route.itinerary_route_ID || 0) &&
            Number((row as any).item_type || 0) === 4,
        );
        // For non-last intercity routes, cap the trailing gap end to latestNonHotelEndSeconds
        // so currentTime stops at the hotel departure window, not at routeEnd.
        // This prevents hotelStartTime = routeEndTime which causes 08:00 PM - 08:00 PM travel rows.
        const trailingGapEndSeconds = !isLastRoute ? Math.min(routeEndSeconds, latestNonHotelEndSeconds) : routeEndSeconds;
        const trailingRemainingGapSeconds = trailingGapEndSeconds - currentSeconds;
        if (trailingRemainingGapSeconds >= FREE_TIME_THRESHOLD_SECONDS && hasScheduledVisitOnRoute) {
          this.logBookingRule({
            rule: 'FREE_TIME_SKIPPED_TRAILING_GAP_PHP_PARITY',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            reason: 'PHP parity: skip explicit trailing free-time segment and continue directly to end-of-day travel/hotel flow.',
            gapStart: currentTime,
            gapMinutes: Math.floor(trailingRemainingGapSeconds / 60),
          });
        } else if (trailingRemainingGapSeconds >= FREE_TIME_THRESHOLD_SECONDS && !hasScheduledVisitOnRoute) {
          this.logBookingRule({
            rule: 'FREE_TIME_SKIPPED_EMPTY_DAY',
            quoteId:
              (plan as any).quote_id ??
              (plan as any).quoteId ??
              (plan as any).quote_ID ??
              null,
            planId,
            routeId: route.itinerary_route_ID,
            reason: 'No hotspots scheduled for this route; skip explicit all-day free-time block.',
            gapStart: currentTime,
            gapMinutes: Math.floor(remainingGapSeconds / 60),
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
            reason: 'Early-arrival declined same-day flow: hotel insertion deferred until end-of-day block.',
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
          cheeyapparaAdded: addedHotspotIds.has(228),
          valaraAdded: addedHotspotIds.has(357),
          valaraInsertedBy: null,
          cheeyapparaRejectedReasons: [],
          conclusion: 'diagnostics_only_rca_trace',
        });
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

    const routeRejectionSummaryByRoute = Object.fromEntries(this.routeRejectionSummaryByRoute.entries());

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
    try {
      const route = (await (tx as any).dvi_itinerary_route_details?.findFirst({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          deleted: 0,
          status: 1,
        },
      })) as RouteRow | null;

      if (!route) return [];

      // Get route date for operating hours check
      const routeDate = route.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
      const phpDow = routeDate ? ((routeDate.getDay() + 6) % 7) : undefined;

      // Get starting location coordinates
      let startLat = 0;
      let startLon = 0;
      
      if (route.location_id) {
        const storedLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: { location_ID: BigInt(route.location_id), deleted: 0, status: 1 },
        });
        
        if (storedLoc) {
          startLat = Number(storedLoc.source_location_lattitude ?? 0);
          startLon = Number(storedLoc.source_location_longitude ?? 0);
        }
      }

      // Fetch all active hotspots
      const allHotspots = (await (tx as any).dvi_hotspot_place?.findMany({
        where: includeZeroPriority
          ? { deleted: 0, status: 1 }
          : { deleted: 0, status: 1, hotspot_priority: { gt: 0 } },
      })) || [];

      // Filter to source city only and calculate distances
      const normalizedSourceCity = this.normalizeCityName(sourceCity);
      const sourceHotspots: any[] = [];

      for (const h of allHotspots) {
        const hotspotId = Number(h.hotspot_ID ?? 0);
        if (hotspotId <= 0) {
          continue;
        }
        if (excludedHotspotIds?.has(hotspotId)) {
          continue;
        }

        // Normalize hotspot location and check if it matches source city.
        // Use broader city equivalence so "Chennai Egmore Station" also matches "Chennai".
        const sourceMatch = this.hotspotLocationMatchesCity(
          String(h.hotspot_location || ''),
          normalizedSourceCity,
        );

        if (!sourceMatch) {
          continue; // Skip if not in source city
        }

        // Calculate distance from starting location
        const hsLat = Number(h.hotspot_latitude ?? 0);
        const hsLon = Number(h.hotspot_longitude ?? 0);
        let distance = 0;
        
        if (startLat && startLon && hsLat && hsLon) {
          const earthRadius = 6371;
          const dLat = ((hsLat - startLat) * Math.PI) / 180;
          const dLon = ((hsLon - startLon) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((startLat * Math.PI) / 180) *
              Math.cos((hsLat * Math.PI) / 180) *
              Math.sin(dLon / 2) *
              Math.sin(dLon / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          distance = earthRadius * c * 1.5;
        }

        sourceHotspots.push({ ...h, hotspot_distance: distance });
      }

      // Sort by priority asc, then distance asc
      sourceHotspots.sort((a: any, b: any) => {
        const aPriority = Number(a.hotspot_priority ?? 0);
        const bPriority = Number(b.hotspot_priority ?? 0);
        
        if (aPriority !== bPriority) {
          return aPriority - bPriority; // Lower priority first
        }
        return a.hotspot_distance - b.hotspot_distance; // Closer first
      });

      const limit = Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 3;
      const topThree = sourceHotspots.slice(0, limit);

      return topThree.map((h: any) => ({
        hotspot_ID: Number(h.hotspot_ID ?? 0),
        display_order: Number(h.hotspot_priority ?? 0),
        hotspot_priority: Number(h.hotspot_priority ?? 0),
      }));
    } catch (err) {
      console.error("[fetchDay1TopPrioritySourceHotspots] Error:", err);
      return [];
    }
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
    const fetchStart = Date.now();
    try {
      // 1) Load route context (dates + locations)
      let opStart = Date.now();
      const route = (await (tx as any).dvi_itinerary_route_details?.findFirst({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          deleted: 0,
          status: 1,
        },
      })) as RouteRow | null;
      this.logTimeline('[TIMELINE] fetchSelectedHotspotsForRoute - fetch route:', Date.now() - opStart, 'ms');

      if (!route) {
        return [];
      }

      // PHP LINE 1023-1033: Get location names from stored_locations table, NOT from route fields
      // $location_name = getSTOREDLOCATIONDETAILS($start_location_id, 'SOURCE_LOCATION');
      // $next_visiting_name = getSTOREDLOCATIONDETAILS($start_location_id, 'DESTINATION_LOCATION');
      opStart = Date.now();
      let targetLocation = "";
      let nextLocation = "";
      
      if (route.location_id) {
        const storedLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: {
            location_ID: BigInt(route.location_id),
            deleted: 0,
            status: 1,
          },
        });
        
        if (storedLoc) {
          targetLocation = storedLoc.source_location || "";
          nextLocation = storedLoc.destination_location || "";
        }
      }
      
      // Fallback: If location_id is missing/0, try to find by route location names
      if (!targetLocation && !nextLocation) {
        // Try exact match first
        if (route.location_name) {
          const foundBySource = await (tx as any).dvi_stored_locations?.findFirst({
            where: {
              source_location: route.location_name,
              deleted: 0,
              status: 1,
            },
          });
          
          if (foundBySource) {
            targetLocation = foundBySource.source_location || "";
            nextLocation = foundBySource.destination_location || "";
          }
        }
        
        // Fuzzy match if exact didn't work
        if (!targetLocation && !nextLocation && route.location_name) {
          const foundFuzzy = await (tx as any).dvi_stored_locations?.findFirst({
            where: {
              OR: [
                { source_location: { contains: route.location_name } },
                { destination_location: { contains: route.location_name } },
              ],
              deleted: 0,
              status: 1,
            },
          });
          
          if (foundFuzzy) {
            targetLocation = foundFuzzy.source_location || "";
            nextLocation = foundFuzzy.destination_location || "";
          }
        }
        
        // If still not found, try next_visiting_location
        if (!targetLocation && !nextLocation && route.next_visiting_location) {
          // Try exact match
          const foundByNext = await (tx as any).dvi_stored_locations?.findFirst({
            where: {
              OR: [
                { source_location: route.next_visiting_location },
                { destination_location: route.next_visiting_location },
              ],
              deleted: 0,
              status: 1,
            },
          });
          
          if (foundByNext) {
            targetLocation = foundByNext.source_location || "";
            nextLocation = foundByNext.destination_location || "";
          }
          
          // Fuzzy match as last resort
          if (!targetLocation && !nextLocation) {
            const foundFuzzyNext = await (tx as any).dvi_stored_locations?.findFirst({
              where: {
                OR: [
                  { source_location: { contains: route.next_visiting_location } },
                  { destination_location: { contains: route.next_visiting_location } },
                ],
                deleted: 0,
                status: 1,
              },
            });
            
            if (foundFuzzyNext) {
              targetLocation = foundFuzzyNext.source_location || "";
              nextLocation = foundFuzzyNext.destination_location || "";
            }
          }
        }
      }

      if (!targetLocation && !nextLocation) {
        return [];
      }
      this.logTimeline('[TIMELINE] fetchSelectedHotspotsForRoute - location lookup:', Date.now() - opStart, 'ms');

      // PHP uses day-of-week filtering via dvi_hotspot_timing (date('N')-1 => Monday=0)
      const routeDate = route.itinerary_route_date
        ? new Date(route.itinerary_route_date)
        : null;
      const phpDow = routeDate
        ? ((routeDate.getDay() + 6) % 7) // JS: Sunday=0; PHP: Monday=0, Sunday=6
        : undefined;

      // 2) Preload hotspot timings for this day (if available)
      // PHP uses LEFT JOIN without filtering hotspot_closed - includes all hotspots with timing records
      opStart = Date.now();
      let allowedHotspotIds: Set<number> | null = null;
      if (phpDow !== undefined) {
        const timingRows = await (tx as any).dvi_hotspot_timing?.findMany({
          where: {
            hotspot_timing_day: phpDow,
            deleted: 0,
            status: 1,
          },
        });
        // Keep timing rows for downstream checks, but avoid hard candidate prefilter.
        // Missing weekday timing should remain eligible and be handled later.
        if ((timingRows || []).length > 0) {
          allowedHotspotIds = null;
        }
      }

      const routeExcluded = (route as any).excluded_hotspot_ids || [];
      const excludedHotspotIds: Set<number> = new Set<number>(
        Array.isArray(routeExcluded)
          ? routeExcluded.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
          : [],
      );
      
      if (excludedHotspotIds.size > 0) {
        console.log(`[Timeline] Route ${routeId} has excluded_hotspot_ids:`, Array.from(excludedHotspotIds));
      }
      
      this.logTimeline('[TIMELINE] fetchSelectedHotspotsForRoute - fetch timings:', Date.now() - opStart, 'ms');

      

      // 3) Use pre-fetched hotspots array (passed as parameter for performance)
      // Note: allHotspots is now passed from buildTimelineForPlan to avoid redundant queries

      // 3b) Fetch operating hours for all hotspots to enable time-aware sorting
      // PHP behavior: sortHotspots() re-orders to prioritize time-critical hotspots
      // Include all timing records (even closed) - checkHotspotOperatingHours will filter later
      const hotspotTimings = phpDow !== undefined
        ? await (tx as any).dvi_hotspot_timing?.findMany({
            where: {
              hotspot_timing_day: phpDow,
              deleted: 0,
              status: 1,
            },
          }) || []
        : [];

      // Map hotspot_ID -> earliest closing time for quick lookup
      const closingTimeMap = new Map<number, string>();
      for (const timing of hotspotTimings) {
        const hotspotId = Number(timing.hotspot_ID ?? 0);
        const endTime = timing.hotspot_end_time || '23:59:59';
        
        // Keep earliest closing time if multiple slots exist
        if (!closingTimeMap.has(hotspotId) || endTime < closingTimeMap.get(hotspotId)!) {
          closingTimeMap.set(hotspotId, endTime);
        }
      }

      const targetLower = targetLocation.toLowerCase();
      const nextLower = nextLocation.toLowerCase();
      const directToNextVisitingPlace = (route as any).direct_to_next_visiting_place || 0;
      const debugBucketIds = new Set<number>([245, 243, 241, 228]);

      // Get starting location coordinates from stored_locations (already fetched above)
      // PHP line 1108-1109: Uses source coordinates for starting point
      let startLat = 0;
      let startLon = 0;
      
      if (route.location_id) {
        const storedLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: {
            location_ID: BigInt(route.location_id),
            deleted: 0,
            status: 1,
          },
        });
        
        if (storedLoc) {
          // Use source coordinates (PHP uses source for starting point)
          startLat = Number(storedLoc.source_location_lattitude ?? 0);
          startLon = Number(storedLoc.source_location_longitude ?? 0);
        }
      }
      
      // Fallback: If location_id is missing/0 and no coordinates, try by location_name
      if (!startLat && !startLon && targetLocation) {
        // Try exact match first
        let foundLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: {
            source_location: targetLocation,
            deleted: 0,
            status: 1,
          },
        });
        
        // Fuzzy match if exact didn't work
        if (!foundLoc && route.location_name) {
          foundLoc = await (tx as any).dvi_stored_locations?.findFirst({
            where: {
              source_location: { contains: route.location_name },
              deleted: 0,
              status: 1,
            },
          });
        }
        
        if (foundLoc) {
          startLat = Number(foundLoc.source_location_lattitude ?? 0);
          startLon = Number(foundLoc.source_location_longitude ?? 0);
        }
      }

      // PHP LINE 1003-1011: Filter includes source location when direct_to_next_visiting_place != 1
      // Categorize hotspots like PHP does (lines 1197-1210)
      let sourceLocationHotspots: any[] = [];
      const destinationHotspots: any[] = [];
      const viaRouteHotspots: any[] = [];
      const enRouteHotspots: any[] = [];

      // Helper function to match location with normalization
      // PHP parity: containsLocation() uses strict lowercase+trim exact matching
      // between target location and pipe-delimited hotspot_location tokens.
      const containsLocation = (hotspotLocation: string | null, targetLocation: string | null): boolean => {
        return this.hotspotLocationMatchesCity(hotspotLocation, targetLocation);
      };

      for (const h of allHotspots) {
        const debugHotspotId = Number(h.hotspot_ID ?? 0);
        // Check if timing allows this hotspot on this day
        if (allowedHotspotIds && !allowedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
          this.logHotspotCandidateEvaluation({
            routeId,
            hotspotId: Number(h.hotspot_ID ?? 0),
            name: String(h.hotspot_name || h.hotspot_location || `hotspot_${Number(h.hotspot_ID ?? 0)}`),
            matchedBucket: 'prefilter',
            priority: Number(h.hotspot_priority ?? 0),
            isMustVisit: Number(h.hotspot_priority ?? 0) > 0,
            distanceFromRoute: null,
            openingTime: null,
            closingTime: null,
            visitTime: '',
            isOpenAtVisitTime: false,
            selected: false,
            rejectedReasons: ['Rejected: day-of-week mismatch'],
          });
          continue;
        }

        // ⚡ PERF FIX 2: city-match BEFORE the expensive distance call.
        // With 774 hotspots in DB, ~750 are in different cities and can be skipped immediately.
        const hotspotFromLocation = String(h.hotspot_location || '').trim();
        const hotspotToLocation = String(h.hotspot_to_location || h.hotspot_location || '').trim();

        const hotspotPrimaryLocation = hotspotFromLocation
          .split('|')[0]
          .trim();

        const isRouteSpecificHotspot =
          hotspotFromLocation.toLowerCase() !== hotspotToLocation.toLowerCase();

        const matchesSource = containsLocation(hotspotFromLocation, targetLocation);
        const matchesDestination = containsLocation(hotspotFromLocation, nextLocation);

        const matchesRouteFrom = containsLocation(hotspotFromLocation, targetLocation);
        const matchesRouteTo = containsLocation(hotspotToLocation, nextLocation);
        const isIntercityNonDirectForBucket =
          this.canonicalCityKey(String(targetLocation || '')) !== '' &&
          this.canonicalCityKey(String(nextLocation || '')) !== '' &&
          this.canonicalCityKey(String(targetLocation || '')) !== this.canonicalCityKey(String(nextLocation || '')) &&
          Number(directToNextVisitingPlace || 0) !== 1;

        if (isRouteSpecificHotspot) {
          if (!matchesRouteFrom || !matchesRouteTo) {
            console.log('[HOTSPOT ROUTE SKIP]', {
              routeId,
              hotspot_ID: h.hotspot_ID,
              hotspot_name: h.hotspot_name,
              hotspot_location: hotspotFromLocation,
              hotspot_to_location: hotspotToLocation,
              route_from: targetLocation,
              route_to: nextLocation,
              reason: 'route-specific hotspot does not match current route',
            });
            continue;
          }
        } else {
          if (!matchesSource && !matchesDestination) {
            continue;
          }
        }

        // PHP parity: use travel-distance engine for ordering, not haversine approximation.
        const hsLat = Number(h.hotspot_latitude ?? 0);
        const hsLon = Number(h.hotspot_longitude ?? 0);
        let distance = Number.POSITIVE_INFINITY;

        if (startLat && startLon && hsLat && hsLon && hotspotPrimaryLocation) {
          const distanceResult = await this.distanceHelper.fromSourceAndDestination(
            tx,
            targetLocation,
            hotspotPrimaryLocation,
            this.getTravelLocationType(targetLocation, hotspotPrimaryLocation),
            { lat: startLat, lon: startLon },
            { lat: hsLat, lon: hsLon },
          );

          const numericDistance = Number(
            String(distanceResult.distanceKm ?? '')
              .replace(/[^0-9.]/g, ''),
          );
          if (Number.isFinite(numericDistance) && numericDistance > 0) {
            distance = numericDistance;
          }
        }

        if (!Number.isFinite(distance)) {
          distance = 999999;
        }

        const hotspotWithDistance = { ...h, hotspot_distance: distance };

        if (excludedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
          const hotspotId = Number(h.hotspot_ID ?? 0);
          console.log(`[Timeline] Hotspot ${hotspotId} (${h.hotspot_name}) REJECTED for route ${routeId} - it's in excluded list`);
          this.logHotspotCandidateEvaluation({
            routeId,
            hotspotId: hotspotId,
            name: String(h.hotspot_name || h.hotspot_location || `hotspot_${hotspotId}`),
            matchedBucket: 'prefilter',
            priority: Number(h.hotspot_priority ?? 0),
            isMustVisit: Number(h.hotspot_priority ?? 0) > 0,
            distanceFromRoute: Number.isFinite(distance) ? distance : null,
            openingTime: null,
            closingTime: null,
            visitTime: '',
            isOpenAtVisitTime: false,
            selected: false,
            rejectedReasons: ['Rejected: excluded'],
          });
          continue;
        }

        
        // PHP PARITY: Lines showing categorization:
        // if ($source_match) :
        //     $source_location_hotspots[] = $hotspot_details;
        // endif;
        // if ($destination_match) :
        //     $destination_hotspots[] = $hotspot_details;
        // endif;
        
        // CRITICAL: Hotspot can be in BOTH buckets (e.g., hotspot_location = "Chennai|Pondicherry")
        // Deduplication happens AFTER bucket selection based on direct flag
        if (isRouteSpecificHotspot) {
          if (isIntercityNonDirectForBucket && matchesRouteFrom && matchesRouteTo) {
            enRouteHotspots.push({ ...hotspotWithDistance, __bucket: 'en_route' });
            if (debugBucketIds.has(debugHotspotId)) {
              console.log('[FETCH_SELECTED_BUCKETS_DEBUG]', {
                routeId,
                sourceCity: targetLocation,
                destinationCity: nextLocation,
                locationId: Number((route as any)?.location_id || 0),
                candidate: {
                  hotspot_ID: debugHotspotId,
                  hotspot_name: String(h.hotspot_name || ''),
                  __bucket: 'en_route',
                  matched_bucket: null,
                  hotspot_location: String(h.hotspot_location || ''),
                  hotspot_to_location: String(h.hotspot_to_location || h.hotspot_location || ''),
                  hotspot_priority: Number(h.hotspot_priority ?? 0),
                },
              });
            }
            continue;
          }
          console.log('[HOTSPOT ROUTE INCLUDE]', {
            routeId,
            hotspot_ID: h.hotspot_ID,
            hotspot_name: h.hotspot_name,
            hotspot_location: hotspotFromLocation,
            hotspot_to_location: hotspotToLocation,
            route_from: targetLocation,
            route_to: nextLocation,
            bucket: 'via',
          });

          viaRouteHotspots.push({ ...hotspotWithDistance, __bucket: 'via' });
          if (debugBucketIds.has(debugHotspotId)) {
            console.log('[FETCH_SELECTED_BUCKETS_DEBUG]', {
              routeId,
              sourceCity: targetLocation,
              destinationCity: nextLocation,
              locationId: Number((route as any)?.location_id || 0),
              candidate: {
                hotspot_ID: debugHotspotId,
                hotspot_name: String(h.hotspot_name || ''),
                __bucket: 'via',
                matched_bucket: null,
                hotspot_location: String(h.hotspot_location || ''),
                hotspot_to_location: String(h.hotspot_to_location || h.hotspot_location || ''),
                hotspot_priority: Number(h.hotspot_priority ?? 0),
              },
            });
          }
        } else {
          if (matchesSource) {
            sourceLocationHotspots.push({ ...hotspotWithDistance, __bucket: 'source' });
            if (debugBucketIds.has(debugHotspotId)) {
              console.log('[FETCH_SELECTED_BUCKETS_DEBUG]', {
                routeId,
                sourceCity: targetLocation,
                destinationCity: nextLocation,
                locationId: Number((route as any)?.location_id || 0),
                candidate: {
                  hotspot_ID: debugHotspotId,
                  hotspot_name: String(h.hotspot_name || ''),
                  __bucket: 'source',
                  matched_bucket: null,
                  hotspot_location: String(h.hotspot_location || ''),
                  hotspot_to_location: String(h.hotspot_to_location || h.hotspot_location || ''),
                  hotspot_priority: Number(h.hotspot_priority ?? 0),
                },
              });
            }
          }

          if (matchesDestination) {
            destinationHotspots.push({ ...hotspotWithDistance, __bucket: 'destination' });
            if (debugBucketIds.has(debugHotspotId)) {
              console.log('[FETCH_SELECTED_BUCKETS_DEBUG]', {
                routeId,
                sourceCity: targetLocation,
                destinationCity: nextLocation,
                locationId: Number((route as any)?.location_id || 0),
                candidate: {
                  hotspot_ID: debugHotspotId,
                  hotspot_name: String(h.hotspot_name || ''),
                  __bucket: 'destination',
                  matched_bucket: null,
                  hotspot_location: String(h.hotspot_location || ''),
                  hotspot_to_location: String(h.hotspot_to_location || h.hotspot_location || ''),
                  hotspot_priority: Number(h.hotspot_priority ?? 0),
                },
              });
            }
          }
        }
      }
      
      // Fetch via routes for this route and match hotspots
      const viaRoutes = await (tx as any).dvi_itinerary_via_route_details?.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          deleted: 0,
          status: 1,
        },
      }) || [];
      
      // For each via location, find matching hotspots
      for (const viaRoute of viaRoutes) {
        const viaLocationName = String(
          (viaRoute as any)?.itinerary_via_location_name ??
            (viaRoute as any)?.via_route_name ??
            "",
        ).trim();
        if (!viaLocationName) continue;
        
        for (const h of allHotspots) {
          // Check if timing allows this hotspot on this day
          if (allowedHotspotIds && !allowedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
            this.logHotspotCandidateEvaluation({
              routeId,
              hotspotId: Number(h.hotspot_ID ?? 0),
              name: String(h.hotspot_name || h.hotspot_location || `hotspot_${Number(h.hotspot_ID ?? 0)}`),
              matchedBucket: 'via',
              priority: Number(h.hotspot_priority ?? 0),
              isMustVisit: Number(h.hotspot_priority ?? 0) > 0,
              distanceFromRoute: null,
              openingTime: null,
              closingTime: null,
              visitTime: '',
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: ['Rejected: day-of-week mismatch'],
            });
            continue;
          }

          // ⚡ PERF: Check city match FIRST before any expensive distance calculation.
          // ~750 of 774 hotspots are in completely different cities and can be skipped immediately.
          const hotspotFromLocation = String(h.hotspot_location || '').trim();
          const hotspotToLocation = String(h.hotspot_to_location || h.hotspot_location || '').trim();

          const hotspotPrimaryLocation = hotspotFromLocation
            .split('|')[0]
            .trim();

          const isRouteSpecificHotspot =
            hotspotFromLocation.toLowerCase() !== hotspotToLocation.toLowerCase();

          if (isRouteSpecificHotspot) {
            const matchesRouteFrom = containsLocation(hotspotFromLocation, targetLocation);
            const matchesRouteTo = containsLocation(hotspotToLocation, nextLocation);

            if (!matchesRouteFrom || !matchesRouteTo) {
              continue;
            }
          } else {
            const matchesViaEarly = containsLocation(hotspotFromLocation, viaLocationName);
            if (!matchesViaEarly) {
              continue;
            }
          }

          // PHP parity: use travel-distance engine for ordering, not haversine approximation.
          const hsLat = Number(h.hotspot_latitude ?? 0);
          const hsLon = Number(h.hotspot_longitude ?? 0);
          let distance = Number.POSITIVE_INFINITY;

          if (startLat && startLon && hsLat && hsLon && hotspotPrimaryLocation) {
            const distanceResult = await this.distanceHelper.fromSourceAndDestination(
              tx,
              targetLocation,
              hotspotPrimaryLocation,
              this.getTravelLocationType(targetLocation, hotspotPrimaryLocation),
              { lat: startLat, lon: startLon },
              { lat: hsLat, lon: hsLon },
            );

            const numericDistance = Number(
              String(distanceResult.distanceKm ?? '')
                .replace(/[^0-9.]/g, ''),
            );
            if (Number.isFinite(numericDistance) && numericDistance > 0) {
              distance = numericDistance;
            }
          }

          if (!Number.isFinite(distance)) {
            distance = 999999;
          }

          if (excludedHotspotIds.has(Number(h.hotspot_ID ?? 0))) {
            const hotspotId = Number(h.hotspot_ID ?? 0);
            console.log(`[Timeline] Hotspot ${hotspotId} (${h.hotspot_name}) REJECTED for route ${routeId} VIA - it's in excluded list`);
            this.logHotspotCandidateEvaluation({
              routeId,
              hotspotId: hotspotId,
              name: String(h.hotspot_name || h.hotspot_location || `hotspot_${hotspotId}`),
              matchedBucket: 'via',
              priority: Number(h.hotspot_priority ?? 0),
              isMustVisit: Number(h.hotspot_priority ?? 0) > 0,
              distanceFromRoute: Number.isFinite(distance) ? distance : null,
              openingTime: null,
              closingTime: null,
              visitTime: '',
              isOpenAtVisitTime: false,
              selected: false,
              rejectedReasons: ['Rejected: excluded'],
            });
            continue;
          }
          
          const hotspotWithDistance = { ...h, hotspot_distance: distance };
          
          // Check if hotspot matches via location
          const matchesVia = isRouteSpecificHotspot
            ? true
            : containsLocation(hotspotFromLocation, viaLocationName);
          
          if (matchesVia) {
            viaRouteHotspots.push({ ...hotspotWithDistance, __bucket: 'via' });
          }
        }
      }

      // PHP parity: keep bucket ordering simple (priority then distance), no greedy re-scoring.
      const sortHotspots = (hotspots: any[]) => {
        hotspots.sort((a: any, b: any) => {
          const ap = Number(a.hotspot_priority ?? 0);
          const bp = Number(b.hotspot_priority ?? 0);
          const ar = ap > 0 ? ap : 9999;
          const br = bp > 0 ? bp : 9999;
          if (ar !== br) return ar - br;

          if (ar === 9999 && br === 9999) {
            const bucket = String(a.__bucket || b.__bucket || '');
            if (bucket === 'source') {
              return Number(a.hotspot_ID ?? 0) - Number(b.hotspot_ID ?? 0);
            }
          }

          const ad = Number(a.hotspot_distance ?? Number.POSITIVE_INFINITY);
          const bd = Number(b.hotspot_distance ?? Number.POSITIVE_INFINITY);
          if (ad !== bd) return ad - bd;

          return Number(a.hotspot_ID ?? 0) - Number(b.hotspot_ID ?? 0);
        });
      };

      // PHP BEHAVIOR: Sort individual location buckets, NOT the final combined list
      sortHotspots(sourceLocationHotspots);
      sortHotspots(enRouteHotspots);
      sortHotspots(destinationHotspots);
      sortHotspots(viaRouteHotspots);
      
      // Apply max source hotspots limit if specified (for Day 1 arrival city)
      if (maxSourceHotspots && maxSourceHotspots > 0 && sourceLocationHotspots.length > maxSourceHotspots) {
        // Limit to top priority hotspots only
        sourceLocationHotspots = sourceLocationHotspots.slice(0, maxSourceHotspots);
      }
      
      // PHP does NOT filter priority=0, it just sorts them to the END
      // Time constraints and route_end_time will naturally prevent low-priority hotspots
      // from being added if there's not enough time

      // PHP PARITY: Process hotspots based on direct_to_next_visiting_place
      // Concatenate buckets in the order PHP processes them
      let matchingHotspots: any[] = [];
      
      const sameSourceAndDestination =
        String(targetLocation || '').trim().toLowerCase() ===
        String(nextLocation || '').trim().toLowerCase();
      const hasViaHotspots = viaRouteHotspots.length > 0;

      if (sameSourceAndDestination && hasViaHotspots) {
        // Same-city route with via is treated as outstation movement for hotspot selection.
        matchingHotspots = [...viaRouteHotspots];
      } else if (directToNextVisitingPlace === 1) {
        // Direct routes: prioritize via-city hotspots when present, otherwise destination hotspots.
        matchingHotspots = hasViaHotspots ? [...viaRouteHotspots, ...destinationHotspots] : [...destinationHotspots];
      } else {
        // PHP ELSE BRANCH (direct == 0): Process source, via, then destination
        // Order: source_location_hotspots → via_route_hotspots → destination_hotspots
        
        // DAY 1 NON-DIRECT: Skip destination hotspots entirely
        // User requirement: "Day 1 should have max 3 Madurai hotspots, Day 2 will have Alleppey hotspots"
        if (skipDestinationHotspots) {
          matchingHotspots = [...sourceLocationHotspots, ...enRouteHotspots, ...viaRouteHotspots];
        } else {
          matchingHotspots = [...sourceLocationHotspots, ...enRouteHotspots, ...viaRouteHotspots, ...destinationHotspots];
        }
      }

      // PHP parity: keep bucket-level candidates distinct.
      // The same hotspot can be tested in source and later in destination loops.
      // De-dup only exact (hotspot_ID + bucket) duplicates.
      const seen = new Set<string>();
      const uniqueHotspots: any[] = [];
      for (const h of matchingHotspots) {
        const id = Number(h.hotspot_ID ?? 0) || 0;
        const bucket = String(h.__bucket || 'unknown');
        const key = `${id}:${bucket}`;
        if (!id || seen.has(key)) continue;
        seen.add(key);
        uniqueHotspots.push(h);
      }

      const isIntercityNonDirectForFinalOverride =
        this.canonicalCityKey(String(targetLocation || '')) !== '' &&
        this.canonicalCityKey(String(nextLocation || '')) !== '' &&
        this.canonicalCityKey(String(targetLocation || '')) !== this.canonicalCityKey(String(nextLocation || '')) &&
        Number(directToNextVisitingPlace || 0) !== 1;

      const finalCandidates = uniqueHotspots.map((h: any) => {
        const hotspotId = Number(h.hotspot_ID || 0);
        const master = allHotspots.find((x: any) => Number(x.hotspot_ID || 0) === hotspotId) || h;
        const masterLocation = String(master.hotspot_location || '');
        const masterToLocation = String(master.hotspot_to_location || master.hotspot_location || '');
        const sourceMatch = containsLocation(masterLocation, targetLocation);
        const destMatch = containsLocation(masterToLocation, nextLocation);
        const forceEnRoute = isIntercityNonDirectForFinalOverride && sourceMatch && destMatch;
        const finalBucket = forceEnRoute ? 'en_route' : String(h.__bucket || 'unknown').toLowerCase();
        return {
          ...h,
          __bucket: finalBucket,
          __master_location: masterLocation,
          __master_to_location: masterToLocation,
          __bucket_reason: forceEnRoute ? 'master_source_to_destination_override' : 'original',
        };
      });

      this.logBookingRule({
        rule: 'FINAL_BUCKET_CLASSIFICATION_PROOF',
        quoteId: null,
        planId,
        routeId,
        sourceCity: String(targetLocation || ''),
        destinationCity: String(nextLocation || ''),
        candidates: finalCandidates.map((h: any) => ({
          hotspotId: Number(h.hotspot_ID || 0),
          name: String(h.hotspot_name || ''),
          masterLocation: String(h.__master_location || ''),
          masterToLocation: String(h.__master_to_location || ''),
          finalBucket: String(h.__bucket || ''),
          reason: String(h.__bucket_reason || ''),
        })),
      });

      return finalCandidates.map((h: any, index: number) => ({
        hotspot_ID: Number(h.hotspot_ID ?? 0) || 0,
        display_order: Number(h.hotspot_priority ?? index + 1) || index + 1,
        hotspot_priority: Number(h.hotspot_priority ?? 0) || 0,
        matched_bucket: String(h.__bucket || 'unknown'),
        hotspot_distance: Number(h.hotspot_distance ?? 0) || 0,
      }));
    } catch (err) {
      console.error("[fetchSelectedHotspots] Error:", err);
      return [];
    }
  }

  /**
   * Get the "location name" (city) of a hotspot.
   *
   * In PHP, this is whatever you used in getSTOREDLOCATION_ID_FROM_SOURCE_AND_DESTINATION
   * when travelling to a hotspot.
   *
   * TODO: Adjust the field you return:
   *   - hotspot_location
   *   - hotspot_city
   *   - city
   *   - etc. depending on your dvi_hotspot_place schema.
   */
  private async getHotspotLocationName(
    tx: Tx,
    hotspotId: number,
  ): Promise<string | null> {
    if (!hotspotId) return null;

    const hs = await (tx as any).dvi_hotspot_place?.findFirst({
      where: { hotspot_ID: hotspotId, deleted: 0, status: 1 },
    });

    if (!hs) return null;

    return (
      hs.hotspot_location ??
      hs.hotspot_city ??
      hs.city ??
      hs.location_name ??
      null
    );
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
    // Example placeholder:
    //  - It tries to find a hotel row for this plan/route/date and returns
    //    hotel_city_name (adjust field names).
    const hotel = await (tx as any).dvi_itinerary_plan_hotel_details?.findFirst(
      {
        where: {
          itinerary_plan_id: planId,
          itinerary_route_id: routeId,
          deleted: 0,
          status: 1,
        },
      },
    );

    if (!hotel) return null;

    const h = hotel.hotel || hotel;

    return (
      h.hotel_city ??
      h.city ??
      h.hotel_location ??
      h.hotel_name ??
      null
    );
  }

  private async getHotelDetailsForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
  ): Promise<{ hotelId: number; hotelName: string | null; hotelCity: string | null; isHouseboat?: boolean; coords?: { lat: number; lon: number } } | null> {
    const details = await (tx as any).dvi_itinerary_plan_hotel_details?.findFirst({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        group_type: 1,
        deleted: 0,
        status: 1,
      },
      select: {
        hotel_id: true,
      },
    });

    const hotelId = Number(details?.hotel_id ?? 0) || 0;
    if (!hotelId) return null;

    const hotel = await (tx as any).dvi_hotel?.findFirst({
      where: {
        hotel_id: hotelId,
      },
      select: {
        hotel_name: true,
        hotel_city: true,
        hotel_category: true,
        hotel_latitude: true,
        hotel_longitude: true,
      },
    });

    if (!hotel) {
      return { hotelId, hotelName: null, hotelCity: null };
    }

    // Try to get the location name if hotel_city is a location_id
    let hotelCity: string | null = null;
    const citySafe = Number(hotel.hotel_city) || 0;
    if (citySafe > 0) {
      // hotel_city is a location_id reference, look it up
      try {
        const location = await (tx as any).dvi_stored_locations?.findFirst({
          where: { location_id: citySafe },
          select: { location_name: true },
        });
        hotelCity = (location?.location_name as string) ?? null;
      } catch {
        hotelCity = null;
      }
    } else {
      // hotel_city is a direct string
      hotelCity = (hotel.hotel_city as string) ?? null;
    }

    const lat = Number(hotel.hotel_latitude);
    const lon = Number(hotel.hotel_longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    let categoryTitle: string | null = null;
    const categoryId = Number((hotel as any).hotel_category ?? 0);
    if (categoryId > 0) {
      const category = await (tx as any).dvi_hotel_category?.findFirst({
        where: {
          hotel_category_id: categoryId,
          deleted: 0,
          status: 1,
        },
        select: {
          hotel_category_title: true,
          hotel_category_code: true,
        },
      });

      categoryTitle =
        String(category?.hotel_category_title || category?.hotel_category_code || "").trim() || null;
    }

    const houseboatTag = `${String(hotel.hotel_name || "")} ${String(categoryTitle || "")}`;
    const isHouseboat = /house\s*boat/i.test(houseboatTag);

    return {
      hotelId,
      hotelName: (hotel.hotel_name as string) ?? null,
      hotelCity,
      isHouseboat,
      coords: hasCoords ? { lat, lon } : undefined,
    };
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
    const distanceResult = await this.distanceHelper.fromSourceAndDestination(
      tx,
      sourceLocationName,
      destinationLocationName,
      1, // travelLocationType: 1 = local
    );
    
    // PHP parity for hotspot timeline checks: use pure travel time (no buffer).
    const totalSeconds = timeToSeconds(distanceResult.travelTime);
    return addSeconds('00:00:00', totalSeconds);
  }

  private async calculateTravelTimeWithCoords(
    tx: Tx,
    sourceLocationName: string,
    destinationLocationName: string,
    sourceCoords?: { lat: number; lon: number },
    destCoords?: { lat: number; lon: number },
  ): Promise<string> {
    const travelLocationType = this.getTravelLocationType(
      sourceLocationName,
      destinationLocationName,
    );
    const distanceResult = await this.distanceHelper.fromSourceAndDestination(
      tx,
      sourceLocationName,
      destinationLocationName,
      travelLocationType,
      sourceCoords,
      destCoords,
    );
    
    // PHP parity for hotspot timeline checks: use pure travel time (no buffer).
    const totalSeconds = timeToSeconds(distanceResult.travelTime);
    return addSeconds('00:00:00', totalSeconds);
  }

  private async calculateProjectedArrivalToRouteDestination(
    tx: Tx,
    route: RouteRow,
    hotspotLocationName: string,
    visitEndSeconds: number,
    hotspotCoords?: { lat: number; lon: number },
    destCityCoords?: { lat: number; lon: number },
  ): Promise<{ projectedArrivalSeconds: number; travelToDestSeconds: number }> {
    const parsedHotspotLocation = hotspotLocationName.split('|')[0].trim();
    const rawDestination = (route.next_visiting_location as string) || parsedHotspotLocation;
    const destinationCity = rawDestination.split('|')[0].trim();
    const travelLocationType = this.getTravelLocationType(parsedHotspotLocation, destinationCity);

    const usableHotspotCoords = hotspotCoords && hotspotCoords.lat !== 0 && hotspotCoords.lon !== 0
      ? hotspotCoords
      : undefined;
    const usableDestCoords = destCityCoords && destCityCoords.lat !== 0 && destCityCoords.lon !== 0
      ? destCityCoords
      : undefined;

    const travelToDestResult = await this.distanceHelper.fromSourceAndDestination(
      tx,
      parsedHotspotLocation,
      destinationCity,
      travelLocationType,
      usableHotspotCoords,
      usableDestCoords,
    );

    const travelToDestSeconds =
      timeToSeconds(travelToDestResult.travelTime) +
      timeToSeconds(travelToDestResult.bufferTime);

    return {
      projectedArrivalSeconds: visitEndSeconds + travelToDestSeconds,
      travelToDestSeconds,
    };
  }

  private toAbsoluteSecondsForRoute(timeValue: string, routeStartSeconds: number): number {
    let seconds = timeToSeconds(timeValue);
    if (seconds < routeStartSeconds) {
      seconds += 86400;
    }
    return seconds;
  }

  private buildFixedTimelineAnchors(
    hotspotRows: HotspotDetailRow[],
    routeId: number,
    routeStartSeconds: number,
    routeEndSeconds: number,
    currentTime: string,
  ): FixedTimelineAnchor[] {
    const currentAbs = this.toAbsoluteSecondsForRoute(currentTime, routeStartSeconds);
    const anchors: FixedTimelineAnchor[] = [
      {
        kind: 'route_start',
        startSeconds: Math.max(routeStartSeconds, currentAbs),
        endSeconds: Math.max(routeStartSeconds, currentAbs),
      },
    ];

    const routeVisits = hotspotRows
      .filter((row) => Number((row as any).itinerary_route_ID || 0) === routeId && Number((row as any).item_type || 0) === 4)
      .map((row) => {
        const start = this.toStoredTimeString((row as any).hotspot_start_time) || '00:00:00';
        const end = this.toStoredTimeString((row as any).hotspot_end_time) || start;
        const absStart = this.toAbsoluteSecondsForRoute(start, routeStartSeconds);
        const absEndRaw = this.toAbsoluteSecondsForRoute(end, routeStartSeconds);
        const absEnd = absEndRaw < absStart ? absEndRaw + 86400 : absEndRaw;

        return {
          kind: 'hotspot' as const,
          startSeconds: absStart,
          endSeconds: absEnd,
          hotspotId: Number((row as any).hotspot_ID || 0),
        };
      })
      .sort((a, b) => a.startSeconds - b.startSeconds);

    anchors.push(...routeVisits);
    anchors.push({
      kind: 'route_end',
      startSeconds: routeEndSeconds,
      endSeconds: routeEndSeconds,
    });

    return anchors;
  }

  private buildRealGapIntervals(anchors: FixedTimelineAnchor[]): RealGapInterval[] {
    if (!anchors.length) return [];

    const sorted = [...anchors].sort((a, b) => a.startSeconds - b.startSeconds);
    const gaps: RealGapInterval[] = [];

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      const gapStart = Math.max(current.endSeconds, current.startSeconds);
      const gapEnd = Math.max(next.startSeconds, gapStart);
      const durationSeconds = Math.max(0, gapEnd - gapStart);

      if (durationSeconds > 0) {
        gaps.push({ start: gapStart, end: gapEnd, durationSeconds });
      }
    }

    return gaps;
  }

  private buildSameCityContinuationContext(
    route: RouteRow,
    previousRoute: RouteRow | undefined,
    hotspotRows: HotspotDetailRow[],
  ): SameCityContinuationContext {
    const previousDayHotspotIds = new Set<number>();
    if (!previousRoute) {
      return { isSameCityChainContinuation: false, previousDayHotspotIds };
    }

    const currentCityKey = this.canonicalCityKey(String((route as any).location_name || (route as any).next_visiting_location || ''));
    const prevDestKey = this.canonicalCityKey(String((previousRoute as any).next_visiting_location || ''));
    const prevSourceKey = this.canonicalCityKey(String((previousRoute as any).location_name || ''));
    const isSameCityChainContinuation = !!currentCityKey && (currentCityKey === prevDestKey || currentCityKey === prevSourceKey);

    if (isSameCityChainContinuation) {
      const prevRouteId = Number((previousRoute as any).itinerary_route_ID || 0);
      for (const row of hotspotRows) {
        if (Number((row as any).itinerary_route_ID || 0) !== prevRouteId) continue;
        if (Number((row as any).item_type || 0) !== 4) continue;
        const hotspotId = Number((row as any).hotspot_ID || 0);
        if (hotspotId > 0) {
          previousDayHotspotIds.add(hotspotId);
        }
      }
    }

    return {
      isSameCityChainContinuation,
      previousDayHotspotIds,
    };
  }

  private async evaluateCandidateInsertion(
    input: CandidateFeasibilityInput,
  ): Promise<CandidateFeasibilityResult> {
    const travelTimeToHotspot = await this.calculateTravelTimeWithCoords(
      input.tx,
      input.currentLocationName,
      input.hotspotLocationName,
      input.currentCoords,
      input.hotspotCoords,
    );

    const travelDurationSeconds = timeToSeconds(travelTimeToHotspot);
    const currentTimeSeconds = this.toAbsoluteSecondsForRoute(input.currentTime, input.routeStartSeconds);
    const hotspotDurationSeconds = timeToSeconds(input.hotspotDuration || '01:00:00');

    let startSeconds = currentTimeSeconds + travelDurationSeconds;
    let endSeconds = startSeconds + hotspotDurationSeconds;
    let usedWaitUntilOpen = false;
    let waitGapSeconds = 0;

    let operatingHoursCheck = this.checkHotspotOperatingHoursFromMap(
      input.timingMap,
      input.hotspotId,
      input.dayOfWeek,
      startSeconds,
      endSeconds,
    );

    if (!operatingHoursCheck.canVisitNow && input.allowWaitUntilOpen && operatingHoursCheck.nextWindowStart) {
      let nextWindowStartSeconds = timeToSeconds(operatingHoursCheck.nextWindowStart);
      while (nextWindowStartSeconds < startSeconds) {
        nextWindowStartSeconds += 86400;
      }

      const waitedEndSeconds = nextWindowStartSeconds + hotspotDurationSeconds;
      if (waitedEndSeconds <= input.routeEndSeconds) {
        const waitedCheck = this.checkHotspotOperatingHoursFromMap(
          input.timingMap,
          input.hotspotId,
          input.dayOfWeek,
          nextWindowStartSeconds,
          waitedEndSeconds,
        );
        if (waitedCheck.canVisitNow) {
          waitGapSeconds = Math.max(0, nextWindowStartSeconds - startSeconds);
          startSeconds = nextWindowStartSeconds;
          endSeconds = waitedEndSeconds;
          operatingHoursCheck = { canVisitNow: true, nextWindowStart: null, isClosedForDay: false };
          usedWaitUntilOpen = true;
        }
      }
    }

    if (input.rejectIfOutsideOperatingWindow && (operatingHoursCheck.isClosedForDay || !operatingHoursCheck.canVisitNow)) {
      return {
        feasible: false,
        reason: operatingHoursCheck.isClosedForDay
          ? 'closed_for_day_at_visit_time'
          : 'outside_operating_hours_for_visit_window',
      };
    }

    if (endSeconds > input.routeEndSeconds) {
      return {
        feasible: false,
        reason: 'visit_overflows_route_end_after_travel_and_duration',
      };
    }

    if (!input.isLastRoute) {
      const projectedArrival = await this.calculateProjectedArrivalToRouteDestination(
        input.tx,
        input.route,
        input.hotspotLocationName,
        endSeconds,
        input.hotspotCoords,
        input.destinationCoords,
      );

      if (projectedArrival.projectedArrivalSeconds > input.routeEndSeconds) {
        return {
          feasible: false,
          reason: 'route_end_return_check_failed',
          rejectedByDayEndReturnCheck: true,
        };
      }
    }

    if (input.isLastRoute) {
      const departureTargetName = String((input.plan.departure_location as string) || input.destinationCity || input.currentLocationName)
        .split('|')[0]
        .trim();
      const candidateCity = input.hotspotLocationName.split('|')[0].trim();
      const travelToDepartureType = this.getTravelLocationType(candidateCity, departureTargetName);
      const travelToDeparture = await this.distanceHelper.fromSourceAndDestination(
        input.tx,
        candidateCity,
        departureTargetName,
        travelToDepartureType,
        input.hotspotCoords,
        input.destinationCoords,
      );
      const toDepartureSeconds =
        timeToSeconds(travelToDeparture.travelTime) +
        timeToSeconds(travelToDeparture.bufferTime);

      const projectedArrivalAtDeparture = endSeconds + toDepartureSeconds;
      if (projectedArrivalAtDeparture > input.lastRouteArrivalDeadlineSeconds) {
        return {
          feasible: false,
          reason: 'last_route_departure_deadline_failed',
          rejectedByDayEndReturnCheck: true,
        };
      }
    }

    return {
      feasible: true,
      startSeconds,
      endSeconds,
      timeAfterTravel: secondsToTime(startSeconds),
      timeAfterSightseeing: secondsToTime(endSeconds),
      travelTimeToHotspot,
      usedWaitUntilOpen,
      waitGapSeconds,
    };
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
    const anchors = this.buildFixedTimelineAnchors(
      hotspotRows,
      routeId,
      routeStartSeconds,
      routeEndSeconds,
      currentTime,
    );

    const currentAbsSeconds = this.toAbsoluteSecondsForRoute(currentTime, routeStartSeconds);
    const nextHotspotAnchor = anchors
      .filter((a) => a.kind === 'hotspot' && a.startSeconds >= currentAbsSeconds)
      .sort((a, b) => a.startSeconds - b.startSeconds)[0];

    const nextProtectedSlot = (protectedStrictSlots || [])
      .filter((slot) => slot.routeId === routeId && slot.startSeconds >= currentAbsSeconds)
      .sort((a, b) => a.startSeconds - b.startSeconds)[0];

    let nextAnchorHotspotId: number | null = null;
    let nextAnchorStartSeconds: number | null = null;
    if (nextHotspotAnchor && nextHotspotAnchor.hotspotId) {
      nextAnchorHotspotId = nextHotspotAnchor.hotspotId;
      nextAnchorStartSeconds = nextHotspotAnchor.startSeconds;
    }
    if (
      nextProtectedSlot &&
      (nextAnchorStartSeconds === null || nextProtectedSlot.startSeconds < nextAnchorStartSeconds)
    ) {
      nextAnchorHotspotId = nextProtectedSlot.hotspotId;
      nextAnchorStartSeconds = nextProtectedSlot.startSeconds;
    }

    if (!nextAnchorHotspotId || nextAnchorStartSeconds === null) {
      return { feasible: true };
    }

    const nextHotspotData = hotspotMap.get(nextAnchorHotspotId);
    if (!nextHotspotData) {
      return {
        feasible: false,
        reason: 'next_anchor_hotspot_metadata_missing',
        nextAnchorHotspotId,
        nextAnchorStartSeconds,
      };
    }

    const nextAnchorLocationName = String(nextHotspotData.hotspot_location || '').trim();
    const nextAnchorCoords = {
      lat: Number(nextHotspotData.hotspot_latitude ?? 0),
      lon: Number(nextHotspotData.hotspot_longitude ?? 0),
    };

    const travelToNextAnchor = await this.calculateTravelTimeWithCoords(
      tx,
      candidateLocationName,
      nextAnchorLocationName,
      candidateCoords,
      nextAnchorCoords,
    );
    const travelToNextAnchorSeconds = timeToSeconds(travelToNextAnchor);
    const arrivalAtNextAnchorSeconds = candidateEndSeconds + travelToNextAnchorSeconds;

    if (arrivalAtNextAnchorSeconds > nextAnchorStartSeconds) {
      return {
        feasible: false,
        reason: 'next_anchor_timing_broken',
        nextAnchorHotspotId,
        nextAnchorStartSeconds,
        arrivalAtNextAnchorSeconds,
        travelToNextAnchorSeconds,
      };
    }

    return {
      feasible: true,
      nextAnchorHotspotId,
      nextAnchorStartSeconds,
      arrivalAtNextAnchorSeconds,
      travelToNextAnchorSeconds,
    };
  }

  private parsePlanDateTime(value: unknown): Date | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  private extractPlanTimeOfDaySeconds(value: unknown): number | null {
    if (typeof value === 'string' && value.trim()) {
      const isoTimeMatch = value.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (isoTimeMatch) {
        return (
          Number(isoTimeMatch[1]) * 3600 +
          Number(isoTimeMatch[2]) * 60 +
          Number(isoTimeMatch[3] ?? 0)
        );
      }
    }

    const parsed = this.parsePlanDateTime(value);
    if (!parsed) return null;

    return (
      parsed.getUTCHours() * 3600 +
      parsed.getUTCMinutes() * 60 +
      parsed.getUTCSeconds()
    );
  }

  private toStoredTimeString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`;
    }
    return null;
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
    const startLocations = startLocation.split('|').map((s) => s.trim());
    const endLocations = endLocation.split('|').map((e) => e.trim());

    // Check if any start location matches any end location
    for (const start of startLocations) {
      for (const end of endLocations) {
        if (start === end) {
          return 1; // Same location (local)
        }
      }
    }
    return 2; // Different location (outstation)
  }
}

// --- RECENT EDITS BELOW --- //
