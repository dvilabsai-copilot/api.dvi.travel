import { secondsToTime, timeToSeconds, wrapToDay } from './time.helper';

export interface TimelineDay1TravelProjectionInput {
  tx: any;
  route: any;
  hotspot: any;
  hotspotData: any;
  currentLocationName: string;
  hotspotLocationName: string;
  currentCoords?: { lat: number; lon: number };
  sourceCity: string;
  destCoords: { lat: number; lon: number };
  destCityCoords?: { lat: number; lon: number };
  currentTime: string;
  hotspotDuration: string;
  routeStartSeconds: number;
  routeEndSeconds: number;
  routeEndTime: string;
  isLastRoute: boolean;
  tracePhpIncludeFlow: boolean;
  distanceCalcCount: number;
  hasUsableCoords: (...args: any[]) => boolean;
  resolvePlaceCoords: (...args: any[]) => Promise<any>;
  calculateTravelTimeWithCoords: (...args: any[]) => Promise<string>;
  calculateProjectedArrivalToRouteDestination: (...args: any[]) => Promise<any>;
  logHotspotCandidateEvaluation: (...args: any[]) => void;
}

export interface TimelineDay1TravelProjectionResult {
  currentCoords?: { lat: number; lon: number };
  distanceCalcCount: number;
  travelTimeToHotspot: string;
  travelDurationSeconds: number;
  currentTimeSeconds: number;
  hotspotDurationSeconds: number;
  absoluteVisitStartSeconds: number;
  absoluteVisitEndSeconds: number;
  timeAfterTravel: string;
  timeAfterSightseeing: string;
  projectedArrivalSeconds: number | null;
  travelToDestSeconds: number | null;
}

export class TimelineDay1TravelProjectionService {
  async project(input: TimelineDay1TravelProjectionInput): Promise<TimelineDay1TravelProjectionResult | null> {
    let currentCoords = input.currentCoords;
    if (!input.hasUsableCoords(currentCoords)) {
      currentCoords =
        (await input.resolvePlaceCoords(input.tx, input.currentLocationName, 'source')) ||
        (await input.resolvePlaceCoords(input.tx, input.sourceCity, 'source')) ||
        undefined;
    }

    const distanceCalcCount = input.distanceCalcCount + 1;
    const travelTimeToHotspot = await input.calculateTravelTimeWithCoords(
      input.tx,
      input.currentLocationName,
      input.hotspotLocationName,
      currentCoords,
      input.destCoords,
    );
    const travelDurationSeconds = timeToSeconds(travelTimeToHotspot);
    const currentTimeSeconds = timeToSeconds(input.currentTime);
    const hotspotDurationSeconds = timeToSeconds(input.hotspotDuration);
    const absoluteVisitStartSeconds = currentTimeSeconds + travelDurationSeconds;
    const absoluteVisitEndSeconds = absoluteVisitStartSeconds + hotspotDurationSeconds;
    const timeAfterTravel = secondsToTime(wrapToDay(absoluteVisitStartSeconds));
    const timeAfterSightseeing = secondsToTime(wrapToDay(absoluteVisitEndSeconds));

    if (input.tracePhpIncludeFlow) {
 console.log('[PHP_INCLUDE_TRACE_CANDIDATE]', JSON.stringify({
        routeId: input.route.itinerary_route_ID,
        dayMode: 'day1_different_cities',
        hotspotId: Number(input.hotspot?.hotspot_ID || 0),
        bucket: input.hotspot?.matched_bucket ?? null,
        priority: Number(input.hotspot?.hotspot_priority ?? 0),
        gateCurrentTime: input.currentTime,
        gateTravelStart: timeAfterTravel,
        gateVisitEnd: timeAfterSightseeing,
        routeEndTime: input.routeEndTime,
        phpGates: ['duplicate_plan_scope', 'bucket_cutoff', 'route_end_time', 'operating_hours'],
      }));
    }

    let routeEndRejectionReason: string | null = null;
    let projectedArrivalSeconds: number | null = null;
    let travelToDestSeconds: number | null = null;
    if (!input.isLastRoute) {
      const projectedArrival = await input.calculateProjectedArrivalToRouteDestination(
        input.tx,
        input.route,
        input.hotspotLocationName,
        absoluteVisitEndSeconds,
        input.destCoords,
        input.destCityCoords,
      );
      projectedArrivalSeconds = projectedArrival.projectedArrivalSeconds;
      travelToDestSeconds = projectedArrival.travelToDestSeconds;
      if (projectedArrivalSeconds > input.routeEndSeconds) {
        routeEndRejectionReason = `Rejected: PHP_GATE_ROUTE_END projected arrival ${secondsToTime(wrapToDay(projectedArrivalSeconds))} exceeds route end ${secondsToTime(input.routeEndSeconds)}`;
      }
    } else if (absoluteVisitEndSeconds > input.routeEndSeconds) {
      routeEndRejectionReason = `Rejected: PHP_GATE_ROUTE_END hotspot end ${secondsToTime(wrapToDay(absoluteVisitEndSeconds))} exceeds route end ${secondsToTime(input.routeEndSeconds)}`;
    }

    if (routeEndRejectionReason) {
      const hotspotId = Number(input.hotspot?.hotspot_ID || 0);
      input.logHotspotCandidateEvaluation({
        routeId: input.route.itinerary_route_ID,
        hotspotId,
        name: String(input.hotspotData?.hotspot_location || `hotspot_${hotspotId}`),
        matchedBucket: input.hotspot?.matched_bucket ?? null,
        priority: Number(input.hotspot?.hotspot_priority ?? 0),
        isMustVisit: Number(input.hotspot?.hotspot_priority ?? 0) > 0,
        distanceFromRoute: Number.isFinite(Number(input.hotspot?.hotspot_distance)) ? Number(input.hotspot.hotspot_distance) : null,
        openingTime: null,
        closingTime: null,
        visitTime: `${timeAfterTravel} - ${timeAfterSightseeing}`,
        isOpenAtVisitTime: false,
        selected: false,
        rejectedReasons: [routeEndRejectionReason],
      });
      return null;
    }

    return {
      currentCoords,
      distanceCalcCount,
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
    };
  }
}
