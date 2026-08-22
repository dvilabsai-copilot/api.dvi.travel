import { Prisma } from '@prisma/client';
import { DistanceHelper } from './distance.helper';
import { secondsToTime, timeToSeconds, wrapToDay } from './time.helper';
import {
  ArrivalWindow,
  HotelFlowAction,
  HotelSearchMode,
  PolicyResolutionStatus,
  evaluateArrivalHotelPolicy,
} from '../../services/arrival-hotel-policy.service';

type Tx = Prisma.TransactionClient;

export interface TimelineArrivalHotelDecisionCallbacks {
  getHotelDetailsForRoute: (...args: any[]) => Promise<any>;
  canonicalCityKey: (...args: any[]) => any;
  toDateOnly: (...args: any[]) => Date;
  getArrivalPolicyDecisionStateForRoute: (...args: any[]) => Promise<any>;
  extractPlanTimeOfDaySeconds: (...args: any[]) => number | null;
  logBookingRule: (...args: any[]) => void;
  logTimeline: (...args: any[]) => void;
  getCurrentQuoteId: () => string | null;
}

export interface TimelineArrivalHotelDecisionInput {
  tx: Tx;
  planId: number;
  route: any;
  plan: any;
  isFirstRoute: boolean;
  isLastRoute: boolean;
  sourceCity: string;
  destinationCity: string;
  arrivalPoint: string;
  currentCoords?: { lat: number; lon: number };
  destCityCoords?: { lat: number; lon: number };
  routeStartTime: string;
  routeEndTime: string;
  effectiveRouteStartTime: string;
  currentTime: string;
  routeStartSeconds: number;
  routeEndSeconds: number;
  lastRouteArrivalDeadlineSeconds: number;
  computeRouteEndSeconds: (startSeconds: number) => number;
}

export class TimelineArrivalHotelDecisionService {
  private callbacks!: TimelineArrivalHotelDecisionCallbacks;

  constructor(private readonly distanceHelper: DistanceHelper = new DistanceHelper()) {}

  setCallbacks(callbacks: TimelineArrivalHotelDecisionCallbacks): void {
    this.callbacks = callbacks;
  }

  async evaluate(input: TimelineArrivalHotelDecisionInput): Promise<any> {
    const {
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
    } = input;
    let effectiveRouteStartTime = input.effectiveRouteStartTime;
    let currentTime = input.currentTime;
    let routeStartSeconds = input.routeStartSeconds;
    let routeEndSeconds = input.routeEndSeconds;
    let lastRouteArrivalDeadlineSeconds = input.lastRouteArrivalDeadlineSeconds;
    const computeRouteEndSeconds = input.computeRouteEndSeconds;

      const hotelInfoForRoute = await this.callbacks.getHotelDetailsForRoute(
        tx,
        planId,
        route.itinerary_route_ID,
      );

      const normalizedArrivalCity = this.callbacks.canonicalCityKey(arrivalPoint);
      const isArrivalCityStayRoute =
        isFirstRoute &&
        this.callbacks.canonicalCityKey(sourceCity) === normalizedArrivalCity &&
        this.callbacks.canonicalCityKey(destinationCity) === normalizedArrivalCity;

      const routeDateForPolicy = route.itinerary_route_date
        ? this.callbacks.toDateOnly(new Date(route.itinerary_route_date))
        : this.callbacks.toDateOnly(new Date(plan.trip_start_date_and_time || plan.trip_start_date));

      const tripStartForPolicy =
        plan.trip_start_date_and_time instanceof Date
          ? plan.trip_start_date_and_time
          : null;

      const arrivalMinutesForPolicy = tripStartForPolicy
        ? tripStartForPolicy.getUTCHours() * 60 + tripStartForPolicy.getUTCMinutes()
        : 0;

      const arrivalDayForPolicy = tripStartForPolicy
        ? this.callbacks.toDateOnly(tripStartForPolicy).getTime() === routeDateForPolicy.getTime()
        : false;

      const decisionState =
        isFirstRoute
          ? await this.callbacks.getArrivalPolicyDecisionStateForRoute(
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

      const arrivalPolicyWantsHotelDeferredToEnd =
        !!evaluatedArrivalPolicy &&
        evaluatedArrivalPolicy.resolutionStatus ===
          PolicyResolutionStatus.RESOLVED &&
        evaluatedArrivalPolicy.hotelFlowAction ===
          HotelFlowAction.DIRECT_SIGHTSEEING &&
        evaluatedArrivalPolicy.deferHotelToEndOfDay === true &&
        evaluatedArrivalPolicy.goToHotelImmediately !== true &&
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
        (arrivalPolicyWantsHotelDeferredToEnd ||
          isEarlyArrivalAwaitingDecisionSameDayFlow);

      const isEarlyArrivalResolvedSameDayDeferredFlow =
        !!evaluatedArrivalPolicy &&
        evaluatedArrivalPolicy.arrivalWindow === ArrivalWindow.EARLY_01_TO_0759 &&
        evaluatedArrivalPolicy.resolutionStatus ===
          PolicyResolutionStatus.RESOLVED &&
        evaluatedArrivalPolicy.hotelFlowAction ===
          HotelFlowAction.DIRECT_SIGHTSEEING &&
        evaluatedArrivalPolicy.deferHotelToEndOfDay === true &&
        evaluatedArrivalPolicy.goToHotelImmediately !== true &&
        evaluatedArrivalPolicy.hotelSearchMode === HotelSearchMode.SAME_DAY;

      const arrivalPolicyAllowsHotelFirst =
        !evaluatedArrivalPolicy ||
        evaluatedArrivalPolicy.hotelFlowAction ===
          HotelFlowAction.DIRECT_HOTEL ||
        evaluatedArrivalPolicy.goToHotelImmediately === true ||
        evaluatedArrivalPolicy.deferHotelToEndOfDay !== true;

// Keep the legacy 08:00 AM -> 09:00 AM buffer only while the
// early-arrival hotel decision is still unresolved.
// Once the guest chooses same-day/direct sightseeing, respect the saved route start time.
const enforceStrictDay1EarlyArrivalDeferredFlow =
  isFirstRoute &&
  isEarlyArrivalAwaitingDecisionSameDayFlow;

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
            this.callbacks.extractPlanTimeOfDaySeconds((plan as any).trip_end_date_and_time) ??
            this.callbacks.extractPlanTimeOfDaySeconds((plan as any).trip_end_date);
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
        arrivalPolicyAllowsHotelFirst &&
        hotelDistanceFromArrivalKm != null &&
        hotelDistanceFromArrivalKm <= 20;

      const shouldHotelLastByDistance =
        isFirstRoute &&
        isArrivalCityStayRoute &&
        hotelDistanceFromArrivalKm != null &&
        hotelDistanceFromArrivalKm > 20;

      this.callbacks.logBookingRule({
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

      let forceNoSightseeingOnThisRoute =
        !!hotelInfoForRoute?.isHouseboat;

      const wrappedLastRouteArrivalDeadlineSeconds = wrapToDay(lastRouteArrivalDeadlineSeconds);
      const isTransferOnlyLastRouteByReportDeadline =
        isLastRoute &&
        wrappedLastRouteArrivalDeadlineSeconds <= 12 * 3600;

      if (isFirstRoute) {
        const lateArrivalHour = (plan.trip_start_date_and_time instanceof Date)
          ? plan.trip_start_date_and_time.getUTCHours()
          : parseInt(routeStartTime.split(':')[0], 10);
        const isLateOrNightArrival = lateArrivalHour >= 17 || lateArrivalHour === 0;
        if (isLateOrNightArrival) {
          forceNoSightseeingOnThisRoute = true;
          this.callbacks.logTimeline('[TIMELINE] LATE_ARRIVAL_SKIP_SIGHTSEEING', {
            quoteId: this.callbacks.getCurrentQuoteId(),
            routeId: route.itinerary_route_ID,
            lateArrivalHour,
            routeStartTime,
            message: 'Late arrival (5PM or later) - skipping Day 1 sightseeing, direct hotel check-in',
          });
        }
      }

      if (isTransferOnlyLastRouteByReportDeadline) {
        forceNoSightseeingOnThisRoute = true;
        this.callbacks.logTimeline('[TIMELINE] LAST_ROUTE_REPORT_CUTOFF_SKIP_SIGHTSEEING', {
          quoteId: this.callbacks.getCurrentQuoteId(),
          routeId: route.itinerary_route_ID,
          routeStartTime,
          routeEndTime,
          wrappedLastRouteArrivalDeadline: secondsToTime(wrappedLastRouteArrivalDeadlineSeconds),
          message: 'Last-route airport report deadline is 12:00 PM or earlier - transfer only, no sightseeing.',
        });
      }

      if (!!hotelInfoForRoute?.isHouseboat) {
        this.callbacks.logBookingRule({
          rule: 'HOUSEBOAT_SUPPRESSION',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          triggered: true,
        });
      }

      if (hasReliableFullDayMarker) {
        this.callbacks.logBookingRule({
          rule: 'FULL_DAY_MARKER_DETECTED',
          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          markerRaw: fullDayMarkerRaw,
          isFullDayTrip,
          suppressionTriggered: isFullDayTrip,
        });
      }

      this.callbacks.logBookingRule({
        rule: 'DAY1_BRANCH_SELECTED',
        quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
        planId,
        routeId: route.itinerary_route_ID,
        isFirstRoute,
        arrivalHour,
        arrivalAfterNoon: isArrivalAfterNoon,
        sameCityStay: isArrivalCityStayRoute,
        forceNoSightseeingOnThisRoute,
        arrivalPolicyWantsHotelDeferredToEnd,
        earlyArrivalPrevDayConfirmed: isEarlyArrivalPrevDayConfirmed,
        specialDay1OnePmHotelFirstFlow: isSpecialDay1OnePmHotelFirstFlow,
      });

      const skipInitialRefreshmentForImmediateHotelCheckin =
        isEarlyArrivalPrevDayConfirmed || isSpecialDay1OnePmHotelFirstFlow;
    return {
      hotelInfoForRoute,
      normalizedArrivalCity,
      isArrivalCityStayRoute,
      routeDateForPolicy,
      tripStartForPolicy,
      arrivalMinutesForPolicy,
      arrivalDayForPolicy,
      decisionState,
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
      effectiveRouteStartTime,
      currentTime,
      routeStartSeconds,
      routeEndSeconds,
      lastRouteArrivalDeadlineSeconds,
      skipInitialRefreshmentForImmediateHotelCheckin,
    };
  }
}
