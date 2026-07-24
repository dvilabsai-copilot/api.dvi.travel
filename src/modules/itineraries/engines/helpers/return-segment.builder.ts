// FILE: src/modules/itineraries/engines/helpers/return-segment.builder.ts

import { Prisma } from "@prisma/client";
import { HotspotDetailRow } from "./types";
import { TravelSegmentBuilder } from "./travel-segment.builder";

type Tx = Prisma.TransactionClient;

export class ReturnSegmentBuilder {
  private readonly travelBuilder = new TravelSegmentBuilder();

 /**
   * item_type = 7 → return to departure location.
   * Uses plan.departure_location as destination.
 */
  async buildReturnToDeparture(
    tx: Tx,
    opts: {
      planId: number;
      routeId: number;
      order: number;
      startTime: string;
      travelLocationType: 1 | 2;
      userId: number;
      currentLocationName: string;
      transportMode?: 'road' | 'train' | 'flight';
 fromHotspotId?: number; // For cache-first
      sourceCoords?: { lat: number; lon: number };
      destCoords?: { lat: number; lon: number };
    },
  ): Promise<{ row: HotspotDetailRow; nextTime: string }> {
 // 1) Determine destination name.
 // If destCityName is provided (e.g. from route.next_visiting_place), use it.
 // Otherwise fallback to plan.departure_location.
    let destinationLocationName = (opts as any).destCityName;

    if (!destinationLocationName) {
      const plan = await (tx as any).dvi_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: opts.planId, deleted: 0 },
      });
      destinationLocationName = plan?.departure_location as string;
    }

    return this.travelBuilder.buildTravelSegment(tx, {
      planId: opts.planId,
      routeId: opts.routeId,
      order: opts.order,
      item_type: 7,
      startTime: opts.startTime,
      travelLocationType: opts.travelLocationType,
      userId: opts.userId,
      sourceLocationName: opts.currentLocationName,
      destinationLocationName,
      fromHotspotId: opts.fromHotspotId,
      destCoords: opts.destCoords,
      sourceCoords: opts.sourceCoords,
    });
  }
}
