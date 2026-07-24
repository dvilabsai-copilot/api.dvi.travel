// FILE: src/modules/itineraries/engines/helpers/hotspot-segment.builder.ts

import { Prisma } from "@prisma/client";
import { HotspotDetailRow } from "./types";
import { addTimes, minutesToTime } from "./time.helper";
import { TimeConverter } from "./time-converter";

type Tx = Prisma.TransactionClient;

export class HotspotSegmentBuilder {
 /**
   * Builds item_type = 4 row using hotspot master.
   * Also supports entry ticket cost fields if your table has them.
 */
  async build(
    tx: Tx,
    opts: {
      planId: number;
      routeId: number;
      order: number;
      hotspotId: number;
 startTime: string; // HH:MM:SS
      userId: number;
      totalAdult: number;
      totalChildren: number;
      totalInfants: number;
 nationality: number; // from plan header
 itineraryPreference: number; // from plan header
      hotspotPlanOwnWay?: number;
      isConflict?: boolean;
      conflictReason?: string;
      isManual?: boolean;
    },
  ): Promise<{ row: HotspotDetailRow; nextTime: string }> {
    const {
      planId,
      routeId,
      order,
      hotspotId,
      startTime,
      userId,
      totalAdult,
      totalChildren,
      totalInfants,
      nationality,
      itineraryPreference,
      hotspotPlanOwnWay = 0,
      isConflict = false,
      conflictReason = "",
      isManual = false,
    } = opts;

 // TODO: adjust model & field names to match your hotspot master + pricebook.
    const hotspot = await (tx as any).dvi_hotspot_place.findFirst({
      where: { hotspot_ID: hotspotId, deleted: 0, status: 1 },
    });

 // Stay time: from hotspot_duration field (TIME type, stored as Date)
 // PHP uses hotspot_duration directly (sql_functions.php line 15117)
 let stayTime = "01:00:00"; // Default 1 hour
    if (hotspot?.hotspot_duration) {
 // hotspot_duration is a Date object (TIME field)
 // Use TimeConverter to extract it as HH:MM:SS string
      stayTime = TimeConverter.toTimeString(hotspot.hotspot_duration);
    }
    const endTime = addTimes(startTime, stayTime);

 // Ticket prices if you have pricebook table; else keep zero.
    let adultCost = 0;
    let childCost = 0;
    let infantCost = 0;
    let fAdultCost = 0;
    let fChildCost = 0;
    let fInfantCost = 0;

 // Example pricebook usage, adjust to your schema:
    const pricebook = await (tx as any).dvi_hotspot_entry_pricebook?.findFirst({
      where: {
        hotspot_ID: hotspotId,
        nationality,
        itinerary_preference: itineraryPreference,
        deleted: 0,
        status: 1,
      },
    });

    if (pricebook) {
      adultCost = Number(pricebook.adult_entry_cost ?? 0);
      childCost = Number(pricebook.child_entry_cost ?? 0);
      infantCost = Number(pricebook.infant_entry_cost ?? 0);
      fAdultCost = Number(pricebook.foreign_adult_entry_cost ?? 0);
      fChildCost = Number(pricebook.foreign_child_entry_cost ?? 0);
      fInfantCost = Number(pricebook.foreign_infant_entry_cost ?? 0);
    }

    const totalAmount =
      totalAdult * adultCost +
      totalChildren * childCost +
      totalInfants * infantCost;

    const now = new Date();

    const row: HotspotDetailRow = {
      itinerary_plan_ID: planId,
      itinerary_route_ID: routeId,
      item_type: 4,
      hotspot_order: order,
      hotspot_ID: hotspotId,

      hotspot_adult_entry_cost: adultCost,
      hotspot_child_entry_cost: childCost,
      hotspot_infant_entry_cost: infantCost,
      hotspot_foreign_adult_entry_cost: fAdultCost,
      hotspot_foreign_child_entry_cost: fChildCost,
      hotspot_foreign_infant_entry_cost: fInfantCost,
      hotspot_amout: totalAmount,

      hotspot_traveling_time: TimeConverter.toDate(stayTime),
      itinerary_travel_type_buffer_time: TimeConverter.toDate("00:00:00"),
      hotspot_travelling_distance: null,

      hotspot_start_time: TimeConverter.toDate(startTime),
      hotspot_end_time: TimeConverter.toDate(endTime),

      allow_break_hours: 0,
      allow_via_route: 0,
      via_location_name: null,
      hotspot_plan_own_way: (hotspotPlanOwnWay === 1 ? 1 : 0) as 0 | 1,

      createdby: userId,
      createdon: now,
      updatedon: null,
      status: 1,
      deleted: 0,
      isConflict,
      conflictReason,
      isManual,
    };

    return { row, nextTime: endTime };
  }
}
