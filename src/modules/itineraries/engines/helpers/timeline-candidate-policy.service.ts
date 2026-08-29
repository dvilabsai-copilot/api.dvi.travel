// FILE: src/modules/itineraries/engines/helpers/timeline-candidate-policy.service.ts

import { Injectable } from '@nestjs/common';
import { HotspotDetailRow, RouteRejectionSummary } from './types';
import { TimelineOperatingHoursService } from './timeline-operating-hours.service';
import { DayTimeSlot, TimelineSlotPolicyService } from './timeline-slot-policy.service';
import { TimelineRejectionPolicyService } from './timeline-rejection-policy.service';
import { CarryForwardRouteContext, TimelineRoutePolicyService } from './timeline-route-policy.service';

type TimelineCandidatePolicyCallbacks = Record<string, (...args: any[]) => any>;

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

@Injectable()
export class TimelineCandidatePolicyService {
  private callbacks: TimelineCandidatePolicyCallbacks = {};

  constructor(
    private readonly operatingHoursService: TimelineOperatingHoursService,
    private readonly slotPolicyService: TimelineSlotPolicyService,
    private readonly rejectionPolicyService: TimelineRejectionPolicyService,
    private readonly routePolicyService: TimelineRoutePolicyService,
  ) {}

  setCallbacks(callbacks: TimelineCandidatePolicyCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public formatTimingTime(value: any): string | null {
    return this.operatingHoursService.formatTimingTime(value);
  }

  public getTimingWindowSummary(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
    dayOfWeek: number,
  ): { openingTime: string | null; closingTime: string | null } {
    return this.operatingHoursService.getTimingWindowSummary(timingMap, hotspotId, dayOfWeek);
  }

  public isHotspotClosedOnDay(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
    dayOfWeek: number,
  ): boolean {
    return this.operatingHoursService.isHotspotClosedOnDay(timingMap, hotspotId, dayOfWeek);
  }

  public isHotspotClosedOnAllDays(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
  ): boolean {
    return this.operatingHoursService.isHotspotClosedOnAllDays(timingMap, hotspotId);
  }

  public getRouteVisitDaysForClosedFilter(
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

    const currentCityKey = this.callbacks.canonicalCityKey(
      String((route as any).location_name || (route as any).next_visiting_location || ''),
    );
    const prevDestKey = this.callbacks.canonicalCityKey(String((previousRoute as any).next_visiting_location || ''));
    const prevSourceKey = this.callbacks.canonicalCityKey(String((previousRoute as any).location_name || ''));

    const isSameCityStayAcrossDays = !!currentCityKey && (currentCityKey === prevDestKey || currentCityKey === prevSourceKey);
    if (!isSameCityStayAcrossDays) {
      return visitDays;
    }

    const prevJsDay = new Date(previousRoute.itinerary_route_date).getDay();
    visitDays.add((prevJsDay + 6) % 7);

    return visitDays;
  }

  public getDayTimeSlot(timeValue: string): DayTimeSlot {
    return this.slotPolicyService.getDayTimeSlot(timeValue);
  }

  public isShoppingHotspotType(hotspotType?: string | null): boolean {
    return this.slotPolicyService.isShoppingHotspotType(hotspotType);
  }

  public evaluateShoppingDayWindow(input: {
    hotspotType?: string | null;
    isArrivalDay: boolean;
    isDepartureDay: boolean;
    arrivalTimeSeconds?: number | null;
    departureTimeSeconds?: number | null;
    availableFromSeconds: number;
    availableUntilSeconds: number;
  }) {
    return this.slotPolicyService.evaluateShoppingDayWindow(input);
  }

  public resolveTimelineBucket(hotspot: any): string {
    return String(
      hotspot?.matched_bucket ||
      hotspot?.__bucket ||
      hotspot?.bucket ||
      '',
    )
      .trim()
      .toLowerCase();
  }

  public isRouteMovementBucket(bucket: string): boolean {
    return (
      bucket === 'via' ||
      bucket === 'en_route' ||
      bucket === 'enroute' ||
      bucket === 'boundary'
    );
  }

  public isSourceBucket(bucket: string): boolean {
    return (
      bucket === 'source' ||
      bucket === 'source_local' ||
      bucket === 'source_hotspot' ||
      bucket === 'source_fallback'
    );
  }

  public shouldSkipWaitForOpening(hotspotType?: string | null): boolean {
    return this.slotPolicyService.shouldSkipWaitForOpening(hotspotType);
  }

  public shouldAllowWaitUntilOpenForCandidate(
    hotspotPriority?: number | null,
    hotspotType?: string | null,
  ): boolean {
    return this.slotPolicyService.shouldAllowWaitUntilOpenForCandidate(hotspotPriority, hotspotType);
  }

  public getNextSlotStart(currentSlot: DayTimeSlot): string | null {
    return this.slotPolicyService.getNextSlotStart(currentSlot);
  }

  public maxTimeString(a: string | null, b: string | null): string | null {
    return this.slotPolicyService.maxTimeString(a, b);
  }

  public buildFreeTimeBreakRow(params: {
    planId: number;
    routeId: number;
    order: number;
    startTime: string;
    endTime: string;
    userId: number;
  }): HotspotDetailRow {
    return this.slotPolicyService.buildFreeTimeBreakRow(params);
  }

  public getCarryPriorityBucket(priority: number): number {
    if (priority >= 1 && priority <= 3) return 0;
    if (priority > 3) return 1;
    return 2;
  }

  public sortCarryForwardHotspots(list: CarryForwardHotspot[]): CarryForwardHotspot[] {
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

  public mergeCarryForwardIntoCandidates(
    carryForwardHotspots: CarryForwardHotspot[],
    selectedHotspots: SelectedHotspot[],
    addedHotspotIds: Set<number>,
    routeContext: CarryForwardRouteContext,
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
      const compatibility = this.isCarryForwardHotspotCompatibleWithRoute(hotspot as any, routeContext);
      if (!compatibility.compatible) {
        this.callbacks.logBookingRule({
          rule: 'CARRY_FORWARD_MERGE_REJECTED_ROUTE_MISMATCH',
          quoteId: this.callbacks.getCurrentQuoteId(),
          routeId: routeContext.routeId,
          routeDay: routeContext.routeDay,
          sourceCity: routeContext.sourceCity,
          destinationCity: routeContext.destinationCity,
          hotspotId: Number((hotspot as any).hotspot_ID || 0),
          hotspotName: String((hotspot as any).hotspot_name || ''),
          hotspotLocation: compatibility.hotspotLocation,
          hotspotToLocation: compatibility.hotspotToLocation,
          carriedFromRouteId: Number((hotspot as any).carriedFromRouteId || 0) || null,
          carriedFromRouteDay: Number((hotspot as any).carriedFromRouteDay || 0) || null,
          reason: compatibility.reason,
        });
        continue;
      }

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

  public logHotspotCandidateEvaluation(payload: {
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
    this.rejectionPolicyService.recordHotspotCandidateEvaluation(payload);

    const rejectionGateBreakdown = this.rejectionPolicyService.buildRejectionGateBreakdown(payload.rejectedReasons);

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

    if (this.callbacks.isVerboseTimelineProofLogs()) {
 console.log('[HOTSPOT_CANDIDATE_EVAL]', evalPayload);
      this.callbacks.appendProofTrace(`[HOTSPOT_CANDIDATE_EVAL] ${evalPayload}`);
    }
  }

  public shouldApplyRouteEndBuffer(routeId: number): boolean {
    return this.rejectionPolicyService.getRouteEndBufferSeconds(routeId) > 0;
  }

  public getRouteEndBufferSeconds(routeId: number): number {
    return this.rejectionPolicyService.getRouteEndBufferSeconds(routeId);
  }

  public classifyRejectionReason(reason: string): keyof RouteRejectionSummary {
    return this.rejectionPolicyService.classifyRejectionReason(reason);
  }

  public buildRejectionGateBreakdown(rejectedReasons: string[]): {
    alreadyUsedOnAnotherRoute: boolean;
    outsideOperatingHours: boolean;
    routeEndDeadline: boolean;
    duplicateSuppression: boolean;
    noRemainingWindow: boolean;
    other: boolean;
  } {
    return this.rejectionPolicyService.buildRejectionGateBreakdown(rejectedReasons);
  }

  public recordHotspotCandidateEvaluation(payload: {
    routeId: number;
    selected: boolean;
    rejectedReasons: string[];
  }): void {
    this.rejectionPolicyService.recordHotspotCandidateEvaluation(payload);
  }

 /**
   * Normalize city names for comparison (single source of truth)
   * Removes airport, railway, station, etc. and normalizes to lowercase
 */
  public normalizeCityName(name: string): string {
    return this.routePolicyService.normalizeCityName(name);
  }

 /**
   * Canonical city key used for branch decisions.
   * Examples:
   * - "Hyderabad, Telangana, India" -> "hyderabad"
   * - "Hyderabad, Rajiv Gandhi International Airport" -> "hyderabad"
   * - "Chennai International Airport" -> "chennai"
 */
  public canonicalCityKey(name: string): string {
    return this.routePolicyService.canonicalCityKey(name);
  }

  public isSameCity(a: string, b: string): boolean {
    return this.routePolicyService.isSameCity(a, b);
  }

  public getSameCityRouteKey(route: Partial<RouteRow> | null | undefined): string {
    return this.routePolicyService.getSameCityRouteKey(route);
  }

  public buildReservedSameCityHotspotIdsByRoute(
    routes: RouteRow[],
    existingHotspots: any[] | undefined,
    scopeToRouteId?: number,
  ): Map<number, Set<number>> {
    return this.routePolicyService.buildReservedSameCityHotspotIdsByRoute(routes, existingHotspots);
  }

 // Match a hotspot location token to a route city using normalized city keys.
 // This is intentionally broader than strict token equality so entries like
 // "Chennai Egmore Station" can match route city "Chennai" globally.
  public hotspotLocationMatchesCity(
    hotspotLocation: string | null | undefined,
    targetCity: string | null | undefined,
  ): boolean {
    return this.routePolicyService.hotspotLocationMatchesCity(hotspotLocation, targetCity);
  }

  public buildRouteLegs(
    sourceCity: string | null | undefined,
    viaLocationNames: string[],
    destinationCity: string | null | undefined,
  ): string[] {
    return this.routePolicyService.buildRouteLegs(sourceCity, viaLocationNames, destinationCity);
  }

  public routeSpecificHotspotMatchesRouteChain(
    hotspotLocation: string | null | undefined,
    hotspotToLocation: string | null | undefined,
    routeLegs: string[],
  ): { matches: boolean; fromIndex: number; toIndex: number } {
    return this.routePolicyService.routeSpecificHotspotMatchesRouteChain(hotspotLocation, hotspotToLocation, routeLegs);
  }

  public routeMovementOrder(
    fromIndex: number,
    toIndex: number,
    kind: 'en_route' | 'via_stop' | 'via_city' = 'en_route',
  ): number {
    return this.routePolicyService.routeMovementOrder(fromIndex, toIndex, kind);
  }

  public hotspotNameMatchesLocation(
    hotspot: any,
    locationName: string | null | undefined,
  ): boolean {
    return this.routePolicyService.hotspotNameMatchesLocation(hotspot, locationName);
  }

  public isCarryForwardHotspotCompatibleWithRoute(
    hotspot: Partial<SelectedHotspot> & Record<string, any>,
    routeContext: CarryForwardRouteContext,
  ): { compatible: boolean; reason: string; hotspotLocation: string; hotspotToLocation: string } {
    return this.routePolicyService.isCarryForwardHotspotCompatibleWithRoute(hotspot, routeContext);
  }

 // Estimate how many hotspots a route can realistically absorb based on the
 // available route window. Used for reservation feasibility checks.
  public estimateRouteHotspotCapacity(route: RouteRow | null | undefined): number {
    return this.routePolicyService.estimateRouteHotspotCapacity(route);
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
  public checkHotspotOperatingHoursFromMap(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
    dayOfWeek: number,
    visitStartSeconds: number,
    visitEndSeconds: number,
  ): { canVisitNow: boolean; nextWindowStart: string | null; isClosedForDay: boolean } {
    return this.operatingHoursService.checkHotspotOperatingHoursFromMap(
      timingMap,
      hotspotId,
      dayOfWeek,
      visitStartSeconds,
      visitEndSeconds,
    );
  }

 /**
   * Main orchestrator for one plan.
   * Returns in-memory arrays that hotspot-engine.service.ts will insert.
 */
}

