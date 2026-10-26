// FILE: src/modules/itineraries/engines/helpers/travel-segment.builder.ts

import { Prisma } from "@prisma/client";
import { HotspotDetailRow } from "./types";
import { DistanceHelper } from "./distance.helper";
import { addTimes, secondsToTime, timeToSeconds } from "./time.helper";
import { TimeConverter } from "./time-converter";

type Tx = Prisma.TransactionClient;

export class TravelSegmentBuilder {
  private readonly distanceHelper = new DistanceHelper();

 /**
   * Generic travel segment (item_type = 3 by default).
   * You can reuse this for item_type 5/6/7 by overriding item_type.
 */
  async buildTravelSegment(
    tx: Tx,
    opts: {
      planId: number;
      routeId: number;
      order: number;
 item_type: number; // 3 / 5 / 6 / 7
 locationId?: number; // preferred if you have it
      sourceLocationName?: string;
      destinationLocationName?: string;
 travelLocationType: 1 | 2; // local vs outstation
 startTime: string; // HH:MM:SS
      userId: number;
      allowViaRoute?: boolean;
      viaLocationName?: string | null;
 hotspotId?: number; // For item_type=3 (site-seeing travel), set to target hotspot_ID
 fromHotspotId?: number; // For cache-first: origin hotspot ID
      sourceCoords?: { lat: number; lon: number };
      destCoords?: { lat: number; lon: number };
      isConflict?: boolean;
      conflictReason?: string;
    },
  ): Promise<{ row: HotspotDetailRow; nextTime: string }> {
    const {
      planId,
      routeId,
      order,
      item_type,
      locationId,
      sourceLocationName,
      destinationLocationName,
      travelLocationType,
      startTime,
      userId,
      allowViaRoute = false,
      viaLocationName = null,
      hotspotId = 0,
      fromHotspotId,
      sourceCoords,
      destCoords,
      isConflict = false,
      conflictReason = "",
    } = opts;

    let distanceResult;

 // ===== CACHE-FIRST FOR HOTSPOT-TO-HOTSPOT LEGS =====
    if (
      fromHotspotId &&
      hotspotId &&
      sourceCoords &&
      destCoords &&
      sourceCoords.lat !== 0 &&
      sourceCoords.lon !== 0 &&
      destCoords.lat !== 0 &&
      destCoords.lon !== 0
    ) {
 // Both hotspots with coordinates use cache-first
      distanceResult = await this.distanceHelper.fromSourceAndDestination(
        tx,
        sourceLocationName,
        destinationLocationName,
        travelLocationType,
        sourceCoords,
        destCoords,
      );
  } else if (
  item_type === 5 &&
  sourceLocationName?.trim() &&
  destinationLocationName?.trim()
) {
  // Final hotel journey must use the latest source and destination,
  // not a potentially stale route-level locationId.
  distanceResult = await this.distanceHelper.fromSourceAndDestination(
    tx,
    sourceLocationName,
    destinationLocationName,
    travelLocationType,
    sourceCoords,
    destCoords,
  );
} else if (locationId != null) {
  distanceResult = await this.distanceHelper.fromLocationId(
    tx,
    locationId,
    travelLocationType,
  );
} else if (sourceLocationName && destinationLocationName) {
  distanceResult = await this.distanceHelper.fromSourceAndDestination(
    tx,
    sourceLocationName,
    destinationLocationName,
    travelLocationType,
    sourceCoords,
    destCoords,
  );
} else {
      distanceResult = {
        distanceKm: 0,
        travelTime: "00:00:00",
        bufferTime: "00:00:00",
      };
    }

const normalizeTravelName = (value: string) =>
  String(value || '')
    .split('|')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const namesDiffer =
  normalizeTravelName(sourceLocationName || '') !==
  normalizeTravelName(destinationLocationName || '');

// SCRUM-440: Trace suspicious final-travel distance.
// The DistanceHelper may produce a minimum-distance fallback.
if (
  item_type === 5 &&
  namesDiffer &&
  Number(distanceResult.distanceKm) === 0.1
) {
  console.warn('[SCRUM-440][FINAL_TRAVEL_MIN_DISTANCE]', {
    planId,
    routeId,
    sourceLocationName,
    destinationLocationName,
    sourceCoords,
    destCoords,
    distanceKm: distanceResult.distanceKm,
  });
}

    if (
      item_type === 3 &&
      namesDiffer &&
      Number.isFinite(Number(distanceResult.distanceKm)) &&
      Number(distanceResult.distanceKm) <= 0.01
    ) {
      distanceResult = {
        ...distanceResult,
        distanceKm: 0.1,
        travelTime: '00:05:00',
      };
    }
// SCRUM-440: Final hotel travel must not silently lose a required KM.
if (item_type === 5 && namesDiffer) {
  const rawDistance = distanceResult.distanceKm;
  const distanceKm =
    rawDistance == null || String(rawDistance).trim() === ""
      ? NaN
      : Number(rawDistance);

  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    console.error("[SCRUM-440][FINAL_TRAVEL_KM_UNRESOLVED]", {
      planId,
      routeId,
      sourceLocationName,
      destinationLocationName,
      locationId,
      sourceCoords,
      destCoords,
      rawDistance,
    });

    throw new Error(
      `[SCRUM-440] Unable to calculate final travel KM for route ${routeId}: ` +
      `${sourceLocationName} -> ${destinationLocationName}`,
    );
  }
}
 // PHP parity:
 // - sightseeing travel segments (item_type=3) use travel time only
 // - final return/drop rows (item_type=7) are already anchored against the
 // last-route arrival deadline, so adding the road/common buffer again
 // would double-count it and can push the airport segment beyond route_end_time
    const effectiveBufferTime =
      item_type === 3 || item_type === 7
        ? "00:00:00"
        : distanceResult.bufferTime;
    const totalSegmentTime = secondsToTime(
      timeToSeconds(distanceResult.travelTime) +
        timeToSeconds(effectiveBufferTime),
    );

    const endTime = addTimes(startTime, totalSegmentTime);

    const now = new Date();

    const row: HotspotDetailRow = {
      itinerary_plan_ID: planId,
      itinerary_route_ID: routeId,
      item_type,
      hotspot_order: order,
 hotspot_ID: hotspotId, // For item_type=3, this is the target hotspot; for others, 0

      hotspot_adult_entry_cost: 0,
      hotspot_child_entry_cost: 0,
      hotspot_infant_entry_cost: 0,
      hotspot_foreign_adult_entry_cost: 0,
      hotspot_foreign_child_entry_cost: 0,
      hotspot_foreign_infant_entry_cost: 0,
      hotspot_amout: 0,

      hotspot_traveling_time: TimeConverter.toDate(distanceResult.travelTime),
      itinerary_travel_type_buffer_time: TimeConverter.toDate(effectiveBufferTime),
     hotspot_travelling_distance:
  Number.isFinite(Number(distanceResult.distanceKm)) &&
  Number(distanceResult.distanceKm) > 0
    ? Number(distanceResult.distanceKm).toFixed(2)
    : null,

      hotspot_start_time: TimeConverter.toDate(startTime),
      hotspot_end_time: TimeConverter.toDate(endTime),

      allow_break_hours: 0,
      allow_via_route: allowViaRoute ? 1 : 0,
      via_location_name: viaLocationName,
      hotspot_plan_own_way: 0,

      createdby: userId,
      createdon: now,
      updatedon: null,
      status: 1,
      deleted: 0,
      isConflict,
      conflictReason,
    };

    return { row, nextTime: endTime };
  }
}
