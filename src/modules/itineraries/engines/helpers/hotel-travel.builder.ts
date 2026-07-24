// FILE: src/modules/itineraries/engines/helpers/hotel-travel.builder.ts

import { Prisma } from "@prisma/client";
import { HotspotDetailRow } from "./types";
import { TravelSegmentBuilder } from "./travel-segment.builder";

type Tx = Prisma.TransactionClient;

export class HotelTravelBuilder {
  private readonly travelBuilder = new TravelSegmentBuilder();

 /**
   * item_type = 5 → traveling to hotel location
 */
  async buildToHotel(
    tx: Tx,
    opts: {
      planId: number;
      routeId: number;
      order: number;
      startTime: string;
      travelLocationType: 1 | 2;
      userId: number;
 // You must pass either locationId or source/dest names.
      locationId?: number;
      sourceLocationName?: string;
      destinationLocationName?: string;
      transportMode?: 'road' | 'train' | 'flight';
 fromHotspotId?: number; // For cache-first
      sourceCoords?: { lat: number; lon: number };
      destCoords?: { lat: number; lon: number };
    },
  ): Promise<{ row: HotspotDetailRow; nextTime: string }> {
    return this.travelBuilder.buildTravelSegment(tx, {
      planId: opts.planId,
      routeId: opts.routeId,
      order: opts.order,
      item_type: 5,
      startTime: opts.startTime,
      travelLocationType: opts.travelLocationType,
      userId: opts.userId,
      locationId: opts.locationId,
      sourceLocationName: opts.sourceLocationName,
      destinationLocationName: opts.destinationLocationName,
      fromHotspotId: opts.fromHotspotId,
      sourceCoords: opts.sourceCoords,
      destCoords: opts.destCoords,
    });
  }

 /**
   * item_type = 6 → return to hotel (often zero-distance just to close the day)
 */
  async buildReturnToHotel(
    tx: Tx,
    opts: {
      planId: number;
      routeId: number;
      order: number;
      startTime: string;
      userId: number;
    },
  ): Promise<{ row: HotspotDetailRow; nextTime: string }> {
 // default 0 distance / 0 time
    return this.travelBuilder.buildTravelSegment(tx, {
      planId: opts.planId,
      routeId: opts.routeId,
      order: opts.order,
      item_type: 6,
      startTime: opts.startTime,
      travelLocationType: 1,
      userId: opts.userId,
    });
  }
}
