import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import {
  HotelArrivalPolicyRequestDto,
  HotelArrivalPolicyResponseDto,
} from '../dto/hotel-arrival-policy.dto';
import {
  areCitiesEquivalent,
  normalizeCityName,
} from '../utils/city-normalization.util';

export enum ArrivalWindow {
  NON_ARRIVAL_DAY = 'NON_ARRIVAL_DAY',
  EARLY_01_TO_0759 = 'EARLY_01_TO_0759',
  PRE_SIGHTSEEING_08_TO_0859 = 'PRE_SIGHTSEEING_08_TO_0859',
  MORNING_09_TO_1259 = 'MORNING_09_TO_1259',
  AFTERNOON_13_TO_1359 = 'AFTERNOON_13_TO_1359',
  AFTERNOON_14_TO_1659 = 'AFTERNOON_14_TO_1659',
  EVENING_17_PLUS = 'EVENING_17_PLUS',
  LATE_NIGHT_00_TO_0059 = 'LATE_NIGHT_00_TO_0059',
}

export enum HotelSearchMode {
  SAME_DAY = 'SAME_DAY',
  PREVIOUS_DAY = 'PREVIOUS_DAY',
}

export enum HotelFlowAction {
  DIRECT_HOTEL = 'DIRECT_HOTEL',
  DIRECT_SIGHTSEEING = 'DIRECT_SIGHTSEEING',
}

export enum PolicyResolutionStatus {
  AWAITING_PREVIOUS_DAY_BILLING_CONFIRMATION =
    'AWAITING_PREVIOUS_DAY_BILLING_CONFIRMATION',
  RESOLVED = 'RESOLVED',
}

export interface ArrivalPolicyEvaluationInput {
  isArrivalDay: boolean;
  arrivalMinutes: number;
  routeDate: Date;
  previousDayBillingDecisionProvided: boolean;
  previousDayBillingConfirmed: boolean;
}

export interface ArrivalPolicyEvaluationOutput {
  resolutionStatus: PolicyResolutionStatus;
  arrivalWindow: ArrivalWindow;
  requiresPreviousDayBillingConfirmation: boolean;
  shouldOpenHotelSearch: boolean;
  hotelSearchMode: HotelSearchMode;
  hotelFlowAction: HotelFlowAction;
  deferHotelToEndOfDay: boolean;
  goToHotelImmediately: boolean;
  skipSightseeing: boolean;
  effectiveCheckInDate: Date;
  effectiveCheckOutDate: Date;
  message: string;
}

export function evaluateArrivalHotelPolicy(
  input: ArrivalPolicyEvaluationInput,
): ArrivalPolicyEvaluationOutput {
  const sameDayCheckIn = atStartOfDay(input.routeDate);
  const sameDayCheckOut = addDays(sameDayCheckIn, 1);
  const previousDayCheckIn = addDays(sameDayCheckIn, -1);
  const previousDayCheckOut = sameDayCheckIn;

  if (!input.isArrivalDay) {
    return {
      resolutionStatus: PolicyResolutionStatus.RESOLVED,
      arrivalWindow: ArrivalWindow.NON_ARRIVAL_DAY,
      requiresPreviousDayBillingConfirmation: false,
      shouldOpenHotelSearch: true,
      hotelSearchMode: HotelSearchMode.SAME_DAY,
      hotelFlowAction: HotelFlowAction.DIRECT_SIGHTSEEING,
      deferHotelToEndOfDay: true,
      goToHotelImmediately: false,
      skipSightseeing: false,
      effectiveCheckInDate: sameDayCheckIn,
      effectiveCheckOutDate: sameDayCheckOut,
      message: 'Non-arrival day: keep same-day hotel search and standard flow.',
    };
  }

  const m = input.arrivalMinutes;

  if (m >= 60 && m < 480) {
    if (!input.previousDayBillingDecisionProvided) {
      return {
        resolutionStatus:
          PolicyResolutionStatus.AWAITING_PREVIOUS_DAY_BILLING_CONFIRMATION,
        arrivalWindow: ArrivalWindow.EARLY_01_TO_0759,
        requiresPreviousDayBillingConfirmation: true,
        shouldOpenHotelSearch: false,
        hotelSearchMode: HotelSearchMode.SAME_DAY,
        hotelFlowAction: HotelFlowAction.DIRECT_SIGHTSEEING,
        deferHotelToEndOfDay: true,
        goToHotelImmediately: false,
        skipSightseeing: false,
        effectiveCheckInDate: sameDayCheckIn,
        effectiveCheckOutDate: sameDayCheckOut,
        message:
          'Arrival is between 1:00 AM and 7:59 AM. Previous-day billing confirmation is required.',
      };
    }

    if (input.previousDayBillingConfirmed) {
      return {
        resolutionStatus: PolicyResolutionStatus.RESOLVED,
        arrivalWindow: ArrivalWindow.EARLY_01_TO_0759,
        requiresPreviousDayBillingConfirmation: false,
        shouldOpenHotelSearch: true,
        hotelSearchMode: HotelSearchMode.PREVIOUS_DAY,
        hotelFlowAction: HotelFlowAction.DIRECT_HOTEL,
        deferHotelToEndOfDay: false,
        goToHotelImmediately: true,
        skipSightseeing: false,
        effectiveCheckInDate: previousDayCheckIn,
        effectiveCheckOutDate: previousDayCheckOut,
        message:
          'Previous-day billing confirmed. Use previous-day hotel search and direct hotel check-in.',
      };
    }

    return {
      resolutionStatus: PolicyResolutionStatus.RESOLVED,
      arrivalWindow: ArrivalWindow.EARLY_01_TO_0759,
      requiresPreviousDayBillingConfirmation: false,
      shouldOpenHotelSearch: true,
      hotelSearchMode: HotelSearchMode.SAME_DAY,
      hotelFlowAction: HotelFlowAction.DIRECT_SIGHTSEEING,
      deferHotelToEndOfDay: true,
      goToHotelImmediately: false,
      skipSightseeing: false,
      effectiveCheckInDate: sameDayCheckIn,
      effectiveCheckOutDate: sameDayCheckOut,
      message:
        'Previous-day billing declined. Continue same-day flow with sightseeing first and hotel at end of day.',
    };
  }

  if (m >= 540 && m < 780) {
    return {
      resolutionStatus: PolicyResolutionStatus.RESOLVED,
      arrivalWindow: ArrivalWindow.MORNING_09_TO_1259,
      requiresPreviousDayBillingConfirmation: false,
      shouldOpenHotelSearch: true,
      hotelSearchMode: HotelSearchMode.SAME_DAY,
      hotelFlowAction: HotelFlowAction.DIRECT_SIGHTSEEING,
      deferHotelToEndOfDay: true,
      goToHotelImmediately: false,
      skipSightseeing: false,
      effectiveCheckInDate: sameDayCheckIn,
      effectiveCheckOutDate: sameDayCheckOut,
      message:
        'Arrival between 9:00 AM and 12:59 PM: sightseeing first, hotel check-in at end of day.',
    };
  }

  if (m >= 780 && m < 840) {
    return {
      resolutionStatus: PolicyResolutionStatus.RESOLVED,
      arrivalWindow: ArrivalWindow.AFTERNOON_13_TO_1359,
      requiresPreviousDayBillingConfirmation: false,
      shouldOpenHotelSearch: true,
      hotelSearchMode: HotelSearchMode.SAME_DAY,
      hotelFlowAction: HotelFlowAction.DIRECT_HOTEL,
      deferHotelToEndOfDay: false,
      goToHotelImmediately: true,
      skipSightseeing: false,
      effectiveCheckInDate: sameDayCheckIn,
      effectiveCheckOutDate: sameDayCheckOut,
      message:
        'Arrival between 1:00 PM and 1:59 PM: go to hotel first, then continue sightseeing.',
    };
  }

  if (m >= 840 && m < 1020) {
    return {
      resolutionStatus: PolicyResolutionStatus.RESOLVED,
      arrivalWindow: ArrivalWindow.AFTERNOON_14_TO_1659,
      requiresPreviousDayBillingConfirmation: false,
      shouldOpenHotelSearch: true,
      hotelSearchMode: HotelSearchMode.SAME_DAY,
      hotelFlowAction: HotelFlowAction.DIRECT_SIGHTSEEING,
      deferHotelToEndOfDay: true,
      goToHotelImmediately: false,
      skipSightseeing: false,
      effectiveCheckInDate: sameDayCheckIn,
      effectiveCheckOutDate: sameDayCheckOut,
      message:
        'Arrival between 2:00 PM and 4:59 PM: continue sightseeing first, hotel check-in at end of day.',
    };
  }

  if (m >= 1020) {
    return {
      resolutionStatus: PolicyResolutionStatus.RESOLVED,
      arrivalWindow: ArrivalWindow.EVENING_17_PLUS,
      requiresPreviousDayBillingConfirmation: false,
      shouldOpenHotelSearch: true,
      hotelSearchMode: HotelSearchMode.SAME_DAY,
      hotelFlowAction: HotelFlowAction.DIRECT_HOTEL,
      deferHotelToEndOfDay: false,
      goToHotelImmediately: true,
      skipSightseeing: true,
      effectiveCheckInDate: sameDayCheckIn,
      effectiveCheckOutDate: sameDayCheckOut,
      message: 'Arrival at or after 5:00 PM: skip sightseeing and proceed directly to hotel.',
    };
  }

  if (m >= 480 && m < 540) {
    return {
      resolutionStatus: PolicyResolutionStatus.RESOLVED,
      arrivalWindow: ArrivalWindow.PRE_SIGHTSEEING_08_TO_0859,
      requiresPreviousDayBillingConfirmation: false,
      shouldOpenHotelSearch: true,
      hotelSearchMode: HotelSearchMode.SAME_DAY,
      hotelFlowAction: HotelFlowAction.DIRECT_SIGHTSEEING,
      deferHotelToEndOfDay: true,
      goToHotelImmediately: false,
      skipSightseeing: false,
      effectiveCheckInDate: sameDayCheckIn,
      effectiveCheckOutDate: sameDayCheckOut,
      message:
        'Arrival between 8:00 AM and 8:59 AM: keep same-day search and start sightseeing flow.',
    };
  }

  return {
    resolutionStatus: PolicyResolutionStatus.RESOLVED,
    arrivalWindow: ArrivalWindow.LATE_NIGHT_00_TO_0059,
    requiresPreviousDayBillingConfirmation: false,
    shouldOpenHotelSearch: true,
    hotelSearchMode: HotelSearchMode.SAME_DAY,
    hotelFlowAction: HotelFlowAction.DIRECT_HOTEL,
    deferHotelToEndOfDay: false,
    goToHotelImmediately: true,
    skipSightseeing: true,
    effectiveCheckInDate: sameDayCheckIn,
    effectiveCheckOutDate: sameDayCheckOut,
    message: 'Arrival before 1:00 AM: use same-day booking and direct hotel flow.',
  };
}

@Injectable()
export class ArrivalHotelPolicyService {
  private readonly logger = new Logger(ArrivalHotelPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolvePolicy(
    request: HotelArrivalPolicyRequestDto,
  ): Promise<HotelArrivalPolicyResponseDto> {
    const context = await this.buildContext(request);

    const decision = evaluateArrivalHotelPolicy({
      isArrivalDay: context.isArrivalDay,
      arrivalMinutes: context.arrivalMinutes,
      routeDate: context.routeDate,
      previousDayBillingDecisionProvided: context.previousDayBillingDecisionProvided,
      previousDayBillingConfirmed: context.previousDayBillingConfirmed,
    });

 this.logger.log(
      JSON.stringify({
        rawArrivalDateTime: context.rawArrivalDateTime,
        normalizedArrivalCity: context.normalizedArrivalCity,
        normalizedNightStayCity: context.normalizedNightStayCity,
        sameCityArrival: context.sameCityArrival,
        arrivalWindow: decision.arrivalWindow,
        hotelSearchMode: decision.hotelSearchMode,
        effectiveCheckInDate: toDateOnly(decision.effectiveCheckInDate),
      }),
    );

    return {
      resolutionStatus: decision.resolutionStatus,
      arrivalWindow: decision.arrivalWindow,
      requiresPreviousDayBillingConfirmation:
        decision.requiresPreviousDayBillingConfirmation,
      shouldOpenHotelSearch: decision.shouldOpenHotelSearch,
      hotelSearchMode: decision.hotelSearchMode,
      hotelFlowAction: decision.hotelFlowAction,
      deferHotelToEndOfDay: decision.deferHotelToEndOfDay,
      goToHotelImmediately: decision.goToHotelImmediately,
      effectiveCheckInDate: toDateOnly(decision.effectiveCheckInDate),
      effectiveCheckOutDate: toDateOnly(decision.effectiveCheckOutDate),
      sameCityArrival: context.sameCityArrival,
      normalizationApplied:
        context.normalizedArrivalCity.length > 0 ||
        context.normalizedNightStayCity.length > 0,
      message: decision.message,
      debug: {
        rawArrivalDateTime: context.rawArrivalDateTime,
        normalizedArrivalCity: context.normalizedArrivalCity,
        normalizedNightStayCity: context.normalizedNightStayCity,
        routeDate: toDateOnly(context.routeDate),
        arrivalMinutes: context.arrivalMinutes,
        isArrivalDay: context.isArrivalDay,
        previousDayBillingDecisionProvided:
          context.previousDayBillingDecisionProvided,
        previousDayBillingConfirmed: context.previousDayBillingConfirmed,
      },
    };
  }

  private async buildContext(request: HotelArrivalPolicyRequestDto): Promise<{
    routeDate: Date;
    rawArrivalDateTime: string;
    arrivalMinutes: number;
    sameCityArrival: boolean;
    normalizedArrivalCity: string;
    normalizedNightStayCity: string;
    isArrivalDay: boolean;
    previousDayBillingDecisionProvided: boolean;
    previousDayBillingConfirmed: boolean;
  }> {
    const planId = Number(request.itineraryPlanId || 0);
    const routeId = Number(request.itineraryRouteId || 0);

    const [plan, route] = await Promise.all([
      planId > 0
        ? this.prisma.dvi_itinerary_plan_details.findFirst({
            where: { itinerary_plan_ID: planId, deleted: 0 },
            select: {
              itinerary_plan_ID: true,
              arrival_location: true,
              trip_start_date_and_time: true,
            },
          })
        : Promise.resolve(null),
      routeId > 0
        ? this.prisma.dvi_itinerary_route_details.findFirst({
            where: { itinerary_route_ID: routeId, deleted: 0 },
            select: {
              itinerary_route_ID: true,
              itinerary_route_date: true,
              location_name: true,
              next_visiting_location: true,
              location_id: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const routeDate = parseDateOrFallback(
      request.routeDate,
      route?.itinerary_route_date,
      new Date(),
    );

    const arrivalDateTime = parseDateOrFallback(
      request.arrivalDateTime,
      plan?.trip_start_date_and_time,
      routeDate,
    );

 // Compare the calendar dates supplied by the itinerary request, rather than
 // the server-local date of the parsed instant. An ISO value such as
 // 2026-07-29T02:00:00+05:30 is 2026-07-28 in UTC, but it is still an
 // arrival on 2026-07-29 for the itinerary.
    const routeDateOnly = toCalendarDateOnly(
      request.routeDate,
      route?.itinerary_route_date,
      routeDate,
    );
    const arrivalDateOnly = toCalendarDateOnly(
      request.arrivalDateTime,
      plan?.trip_start_date_and_time,
      arrivalDateTime,
    );

    const arrivalCityName =
      request.arrivalCityName ||
      plan?.arrival_location ||
      route?.location_name ||
      '';

    const nightStayCityName =
      request.nightStayCityName || route?.next_visiting_location || '';

    const sameCityArrival = areCitiesEquivalent({
      cityIdA: request.arrivalCityId,
      cityIdB: request.nightStayCityId,
      cityNameA: arrivalCityName,
      cityNameB: nightStayCityName,
    });

    const isArrivalDay =
      Number(request.routeDayNumber || 0) > 1
        ? false
        : routeDateOnly === arrivalDateOnly;

    return {
      routeDate,
      rawArrivalDateTime: arrivalDateTime.toISOString(),
      arrivalMinutes: getArrivalMinutes(
        request.arrivalDateTime,
        plan?.trip_start_date_and_time,
        arrivalDateTime,
      ),
      sameCityArrival,
      normalizedArrivalCity: normalizeCityName(arrivalCityName),
      normalizedNightStayCity: normalizeCityName(nightStayCityName),
      isArrivalDay,
      previousDayBillingDecisionProvided: Boolean(
        request.previousDayBillingDecisionProvided,
      ),
      previousDayBillingConfirmed: Boolean(request.previousDayBillingConfirmed),
    };
  }
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function atStartOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDateOrFallback(
  primary: unknown,
  secondary: unknown,
  fallback: Date,
): Date {
  const values = [primary, secondary];

  for (const value of values) {
    if (!value) continue;
    const parsed = new Date(value as any);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return new Date(fallback);
}

function getArrivalMinutes(
  primary: unknown,
  secondary: unknown,
  parsedDate: Date,
): number {
  const values = [primary, secondary];

  for (const value of values) {
    if (!value) continue;
    const text = String(value).trim();
    if (!text) continue;

 // Keep the intended wall-clock time from payload/DB string regardless of server timezone.
    const isoMatch = text.match(/T(\d{2}):(\d{2})(?::\d{2})?/);
    if (isoMatch) {
      const hh = Number(isoMatch[1]);
      const mm = Number(isoMatch[2]);
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        return hh * 60 + mm;
      }
    }

    const spaceMatch = text.match(/\b(\d{2}):(\d{2})(?::\d{2})?\b/);
    if (spaceMatch) {
      const hh = Number(spaceMatch[1]);
      const mm = Number(spaceMatch[2]);
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        return hh * 60 + mm;
      }
    }
  }

  return parsedDate.getHours() * 60 + parsedDate.getMinutes();
}

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toCalendarDateOnly(
  primary: unknown,
  secondary: unknown,
  fallback: Date,
): string {
  for (const value of [primary, secondary]) {
    if (typeof value !== 'string') continue;

    const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
    if (match) return match[1];
  }

  return toDateOnly(fallback);
}
