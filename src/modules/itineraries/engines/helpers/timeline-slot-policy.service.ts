import { HotspotDetailRow } from './types';
import { secondsToTime, timeToSeconds } from './time.helper';
import { TimeConverter } from './time-converter';

export type DayTimeSlot = 'MORNING' | 'EVENING';

const NO_WAIT_HOTSPOT_TYPES = new Set<string>(['restaurant', 'shopping_mall']);

export class TimelineSlotPolicyService {
  getDayTimeSlot(timeValue: string): DayTimeSlot {
    const seconds = timeToSeconds(timeValue);
    return seconds < timeToSeconds('12:00:00') ? 'MORNING' : 'EVENING';
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
