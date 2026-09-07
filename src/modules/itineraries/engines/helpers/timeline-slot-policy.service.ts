import { HotspotDetailRow } from './types';
import { secondsToTime, timeToSeconds } from './time.helper';
import { TimeConverter } from './time-converter';

export type DayTimeSlot = 'MORNING' | 'EVENING';

const NO_WAIT_HOTSPOT_TYPES = new Set<string>(['restaurant', 'shopping_mall']);
const SHOPPING_HOTSPOT_TYPES = new Set<string>(['shopping_mall']);
const SHOPPING_ARRIVAL_CUTOFF_SECONDS = timeToSeconds('10:00:00');
const SHOPPING_ARRIVAL_START_SECONDS = timeToSeconds('12:00:00');
const SHOPPING_DEPARTURE_CUTOFF_SECONDS = timeToSeconds('10:00:00');
const SHOPPING_MIN_FREE_TIME_SECONDS = 2 * 60 * 60;

export interface ShoppingDayWindowPolicyResult {
  applies: boolean;
  allowed: boolean;
  schedulingStartSeconds: number;
  availableFreeTimeSeconds: number;
  reason: string | null;
}

export class TimelineSlotPolicyService {
  getDayTimeSlot(timeValue: string): DayTimeSlot {
    const seconds = timeToSeconds(timeValue);
    return seconds < timeToSeconds('12:00:00') ? 'MORNING' : 'EVENING';
  }

  isShoppingHotspotType(hotspotType?: string | null): boolean {
    const normalizedType = String(hotspotType || '').trim().toLowerCase();
    return SHOPPING_HOTSPOT_TYPES.has(normalizedType);
  }

  evaluateShoppingDayWindow(input: {
    hotspotType?: string | null;
    isArrivalDay: boolean;
    isDepartureDay: boolean;
    arrivalTimeSeconds?: number | null;
    departureTimeSeconds?: number | null;
    availableFromSeconds: number;
    availableUntilSeconds: number;
  }): ShoppingDayWindowPolicyResult {
    const availableFromSeconds = Math.max(
      0,
      Number(input.availableFromSeconds || 0),
    );

    const availableUntilSeconds = Math.max(
      availableFromSeconds,
      Number(input.availableUntilSeconds || 0),
    );

    if (
      !this.isShoppingHotspotType(input.hotspotType) ||
      (!input.isArrivalDay && !input.isDepartureDay)
    ) {
      return {
        applies: false,
        allowed: true,
        schedulingStartSeconds: availableFromSeconds,
        availableFreeTimeSeconds: Math.max(
          0,
          availableUntilSeconds - availableFromSeconds,
        ),
        reason: null,
      };
    }

    let schedulingStartSeconds = availableFromSeconds;

    if (input.isArrivalDay) {
      const arrivalTimeSeconds =
        input.arrivalTimeSeconds == null
          ? null
          : Number(input.arrivalTimeSeconds);

      if (
        arrivalTimeSeconds == null ||
        !Number.isFinite(arrivalTimeSeconds) ||
        arrivalTimeSeconds <= SHOPPING_ARRIVAL_CUTOFF_SECONDS
      ) {
        return {
          applies: true,
          allowed: false,
          schedulingStartSeconds,
          availableFreeTimeSeconds: 0,
          reason: 'shopping_arrival_requires_arrival_after_10_am',
        };
      }

      schedulingStartSeconds = Math.max(
        schedulingStartSeconds,
        SHOPPING_ARRIVAL_START_SECONDS,
      );
    }

    if (input.isDepartureDay) {
      const departureTimeSeconds =
        input.departureTimeSeconds == null
          ? null
          : Number(input.departureTimeSeconds);

      if (
        departureTimeSeconds == null ||
        !Number.isFinite(departureTimeSeconds) ||
        departureTimeSeconds <= SHOPPING_DEPARTURE_CUTOFF_SECONDS
      ) {
        return {
          applies: true,
          allowed: false,
          schedulingStartSeconds,
          availableFreeTimeSeconds: 0,
          reason: 'shopping_departure_requires_departure_after_10_am',
        };
      }
    }

    const availableFreeTimeSeconds = Math.max(
      0,
      availableUntilSeconds - schedulingStartSeconds,
    );

    if (availableFreeTimeSeconds <= SHOPPING_MIN_FREE_TIME_SECONDS) {
      return {
        applies: true,
        allowed: false,
        schedulingStartSeconds,
        availableFreeTimeSeconds,
        reason: 'shopping_requires_more_than_2_hours_free_time',
      };
    }

    return {
      applies: true,
      allowed: true,
      schedulingStartSeconds,
      availableFreeTimeSeconds,
      reason: null,
    };
  }

  shouldSkipWaitForOpening(hotspotType?: string | null): boolean {
    const normalizedType = String(hotspotType || '').trim().toLowerCase();
    return NO_WAIT_HOTSPOT_TYPES.has(normalizedType);
  }

  shouldAllowWaitUntilOpenForCandidate(
    hotspotPriority?: number | null,
    hotspotType?: string | null,
  ): boolean {
    const priority = Number(hotspotPriority ?? 0);
    return priority > 0 && !this.shouldSkipWaitForOpening(hotspotType);
  }

  getNextSlotStart(currentSlot: DayTimeSlot): string | null {
    return currentSlot === 'MORNING' ? '12:00:00' : null;
  }

  maxTimeString(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return timeToSeconds(a) >= timeToSeconds(b) ? a : b;
  }

  buildFreeTimeBreakRow(params: {
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
}
