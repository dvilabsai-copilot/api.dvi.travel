// FILE: src/modules/itineraries/engines/helpers/refreshment.builder.ts

import { HotspotDetailRow } from "./types";
import { addTimes } from "./time.helper";
import { TimeConverter } from "./time-converter";

/**
 * Builds refreshment segment (item_type = 1).
 * This mirrors the "break hour" row at start of route.
 */
export class RefreshmentBuilder {
  build(
    planId: number,
    routeId: number,
    order: number,
    routeStartTime: string,
 breakDuration: string, // HH:MM:SS (e.g. "01:00:00")
    userId: number,
  ): { row: HotspotDetailRow; nextTime: string } {
    const startTime = routeStartTime;
    const endTime = addTimes(startTime, breakDuration);

    const now = new Date();

    const row: HotspotDetailRow = {
      itinerary_plan_ID: planId,
      itinerary_route_ID: routeId,
      item_type: 1,
      hotspot_order: order,
      hotspot_ID: 0,

      hotspot_adult_entry_cost: 0,
      hotspot_child_entry_cost: 0,
      hotspot_infant_entry_cost: 0,
      hotspot_foreign_adult_entry_cost: 0,
      hotspot_foreign_child_entry_cost: 0,
      hotspot_foreign_infant_entry_cost: 0,
      hotspot_amout: 0,

      hotspot_traveling_time: TimeConverter.toDate(breakDuration),
      itinerary_travel_type_buffer_time: TimeConverter.toDate("00:00:00"),
      hotspot_travelling_distance: null,

      hotspot_start_time: TimeConverter.toDate(startTime),
      hotspot_end_time: TimeConverter.toDate(endTime),

      allow_break_hours: 1,
      allow_via_route: 0,
      via_location_name: null,
      hotspot_plan_own_way: 0,

      createdby: userId,
      createdon: now,
      updatedon: null,
      status: 1,
      deleted: 0,
    };

    return { row, nextTime: endTime };
  }
}
