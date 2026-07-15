import { Prisma } from '@prisma/client';
import { HotspotDetailRow } from './types';
import { addSeconds, secondsToTime, timeToSeconds } from './time.helper';
import { DistanceHelper } from './distance.helper';
import { TimelineAnchorPolicyService, FixedTimelineAnchor } from './timeline-anchor-policy.service';
import { TimelineOperatingHoursService } from './timeline-operating-hours.service';
import { TimelineSlotPolicyService } from './timeline-slot-policy.service';
import { TimelineTravelDataService } from './timeline-travel-data.service';

type Tx = Prisma.TransactionClient;

export interface CandidatePlanHeader {
  departure_location?: string | null;
}

export interface CandidateRoute {
  next_visiting_location: string | null;
}

export interface CandidateFeasibilityInput {
  tx: Tx;
  route: CandidateRoute;
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
  plan: CandidatePlanHeader;
  destinationCity: string;
  lastRouteArrivalDeadlineSeconds: number;
  allowWaitUntilOpen: boolean;
  rejectIfOutsideOperatingWindow: boolean;
}

export interface CandidateFeasibilityResult {
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

export interface AnchorGapFeasibilityResult {
  feasible: boolean;
  reason?: string;
  nextAnchorHotspotId?: number;
  nextAnchorStartSeconds?: number;
  arrivalAtNextAnchorSeconds?: number;
  travelToNextAnchorSeconds?: number;
}

export interface ProtectedStrictSlot {
  hotspotId: number;
  routeId: number;
  startSeconds: number;
  endSeconds: number;
  sourceCandidate: any;
  locked: true;
}

export interface CandidateFeasibilityRouteAnchor {
  itinerary_route_ID?: number;
  next_visiting_location: string | null;
}

/**
 * Encapsulates timeline candidate admission rules. It performs no writes and
 * returns the same reason strings consumed by the builder's rejection report.
 */
export class TimelineCandidateFeasibilityService {
  private readonly anchorPolicyService = new TimelineAnchorPolicyService();
  private readonly operatingHoursService = new TimelineOperatingHoursService();
  private readonly slotPolicyService = new TimelineSlotPolicyService();
  private readonly travelDataService: TimelineTravelDataService;

  constructor(private readonly distanceHelper: DistanceHelper = new DistanceHelper()) {
    this.travelDataService = new TimelineTravelDataService(distanceHelper);
  }

  async evaluateCandidateInsertion(
    input: CandidateFeasibilityInput,
  ): Promise<CandidateFeasibilityResult> {
    const travelTimeToHotspot = await this.travelDataService.calculateTravelTimeWithCoords(
      input.tx,
      input.currentLocationName,
      input.hotspotLocationName,
      input.currentCoords,
      input.hotspotCoords,
    );

    const travelDurationSeconds = timeToSeconds(travelTimeToHotspot);
    const currentTimeSeconds = this.anchorPolicyService.toAbsoluteSecondsForRoute(
      input.currentTime,
      input.routeStartSeconds,
    );
    const hotspotDurationSeconds = timeToSeconds(input.hotspotDuration || '01:00:00');
    const hotspotType = String(input.hotspotType || '').trim().toLowerCase();

    let startSeconds = currentTimeSeconds + travelDurationSeconds;
    let endSeconds = startSeconds + hotspotDurationSeconds;
    let usedWaitUntilOpen = false;
    let waitGapSeconds = 0;

    let operatingHoursCheck = this.operatingHoursService.checkHotspotOperatingHoursFromMap(
      input.timingMap,
      input.hotspotId,
      input.dayOfWeek,
      startSeconds,
      endSeconds,
    );

    if (
      !operatingHoursCheck.canVisitNow &&
      input.allowWaitUntilOpen &&
      operatingHoursCheck.nextWindowStart &&
      this.slotPolicyService.shouldAllowWaitUntilOpenForCandidate(input.hotspotPriority, hotspotType)
    ) {
      let nextWindowStartSeconds = timeToSeconds(operatingHoursCheck.nextWindowStart);
      while (nextWindowStartSeconds < startSeconds) {
        nextWindowStartSeconds += 86400;
      }

      const waitedEndSeconds = nextWindowStartSeconds + hotspotDurationSeconds;
      if (waitedEndSeconds <= input.routeEndSeconds) {
        const waitedCheck = this.operatingHoursService.checkHotspotOperatingHoursFromMap(
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
      const projectedArrival = await this.travelDataService.calculateProjectedArrivalToRouteDestination(
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
      const departureTargetName = String(
        input.plan.departure_location || input.destinationCity || input.currentLocationName,
      ).split('|')[0].trim();
      const candidateCity = input.hotspotLocationName.split('|')[0].trim();
      const travelToDepartureType = this.anchorPolicyService.getTravelLocationType(candidateCity, departureTargetName);
      const travelToDeparture = await this.distanceHelper.fromSourceAndDestination(
        input.tx,
        candidateCity,
        departureTargetName,
        travelToDepartureType,
        input.hotspotCoords,
        input.destinationCoords,
      );
      const toDepartureSeconds = timeToSeconds(travelToDeparture.travelTime) + timeToSeconds(travelToDeparture.bufferTime);
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

  async evaluateAnchorGapInsertion(
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
    const anchors: FixedTimelineAnchor[] = this.anchorPolicyService.buildFixedTimelineAnchors(
      hotspotRows,
      routeId,
      routeStartSeconds,
      routeEndSeconds,
      currentTime,
    );
    const currentAbsSeconds = this.anchorPolicyService.toAbsoluteSecondsForRoute(currentTime, routeStartSeconds);
    const nextHotspotAnchor = anchors
      .filter((anchor) => anchor.kind === 'hotspot' && anchor.startSeconds >= currentAbsSeconds)
      .sort((a, b) => a.startSeconds - b.startSeconds)[0];
    const nextProtectedSlot = (protectedStrictSlots || [])
      .filter((slot) => slot.routeId === routeId && slot.startSeconds >= currentAbsSeconds)
      .sort((a, b) => a.startSeconds - b.startSeconds)[0];

    let nextAnchorHotspotId: number | null = null;
    let nextAnchorStartSeconds: number | null = null;
    if (nextHotspotAnchor?.hotspotId) {
      nextAnchorHotspotId = nextHotspotAnchor.hotspotId;
      nextAnchorStartSeconds = nextHotspotAnchor.startSeconds;
    }
    if (nextProtectedSlot && (nextAnchorStartSeconds === null || nextProtectedSlot.startSeconds < nextAnchorStartSeconds)) {
      nextAnchorHotspotId = nextProtectedSlot.hotspotId;
      nextAnchorStartSeconds = nextProtectedSlot.startSeconds;
    }

    if (!nextAnchorHotspotId || nextAnchorStartSeconds === null) return { feasible: true };

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
    const travelToNextAnchor = await this.travelDataService.calculateTravelTimeWithCoords(
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
}
