// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/helpers/distance.helper.ts

import { Prisma } from "@prisma/client";
import { minutesToDurationTime, minutesToTime } from "./time.helper";

type Tx = Prisma.TransactionClient;

// In-memory cache for distance lookups
const distanceCache = new Map<string, any>();

export interface DistanceResult {
  distanceKm: number; // e.g. 8.42
  travelTime: string; // HH:MM:SS
  bufferTime: string; // HH:MM:SS
}

/**
 * Parse dvi_stored_locations.duration into TOTAL MINUTES.
 * Supports:
 * - "49 mins"
 * - "1 hour 56 mins"
 * - "3 hours 5 mins"
 * - "1 day 1 hour"
 * - "1 day 0 hours"
 * - "1 day 2 hours 15 mins"
 * Also supports numeric durations (treated as minutes).
 */
/** Minimum travel time in minutes — accounts for vehicle loading/unloading */
const MIN_TRAVEL_MINUTES = 5;

function parseDurationToMinutes(duration: any): number | null {
  if (duration == null) return null;

  if (typeof duration === "number" && Number.isFinite(duration)) {
    return Math.max(0, Math.floor(duration));
  }

  const s = String(duration).trim().toLowerCase();
  if (!s) return null;

  let days = 0;
  let hours = 0;
  let mins = 0;

  const dMatch = s.match(/(\d+)\s*day/);
  const hMatch = s.match(/(\d+)\s*hour/);
  const mMatch = s.match(/(\d+)\s*min/);

  if (dMatch) days = Number(dMatch[1] || 0);
  if (hMatch) hours = Number(hMatch[1] || 0);
  if (mMatch) mins = Number(mMatch[1] || 0);

  if (!dMatch && !hMatch && !mMatch) {
    const n = Number(s);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    return null;
  }

  return days * 1440 + hours * 60 + mins;
}

export class DistanceHelper {
  private globalSettings: any = null;

  /**
   * Set global settings to avoid redundant DB queries.
   */
  setGlobalSettings(gs: any) {
    this.globalSettings = gs;
  }

  /**
   * Pre-populate the distance cache with provided locations.
   */
  prePopulateCache(locations: any[]) {
    for (const loc of locations) {
      const key = `${loc.source_location}|${loc.destination_location}`;
      if (!distanceCache.has(key)) {
        distanceCache.set(key, loc);
      }
    }
  }

  /**
   * Standalone Haversine calculation for simple distance checks.
   */
  calculateHaversine(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
  ): number {
    const earthRadius = 6371;

    const startLatRad = (startLat * Math.PI) / 180;
    const startLonRad = (startLon * Math.PI) / 180;
    const endLatRad = (endLat * Math.PI) / 180;
    const endLonRad = (endLon * Math.PI) / 180;

    const latDiff = endLatRad - startLatRad;
    const lonDiff = endLonRad - startLonRad;

    const a =
      Math.pow(Math.sin(latDiff / 2), 2) +
      Math.cos(startLatRad) * Math.cos(endLatRad) * Math.pow(Math.sin(lonDiff / 2), 2);

    const distance = 2 * earthRadius * Math.asin(Math.sqrt(a));
    return distance * 1.5; // Apply same 1.5x correction factor as fromCoordinates
  }

  async fromCoordinates(
    tx: Tx,
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    travelLocationType: 1 | 2,
  ): Promise<DistanceResult> {
    const earthRadius = 6371;

    const startLatRad = (startLat * Math.PI) / 180;
    const startLonRad = (startLon * Math.PI) / 180;
    const endLatRad = (endLat * Math.PI) / 180;
    const endLonRad = (endLon * Math.PI) / 180;

    const latDiff = endLatRad - startLatRad;
    const lonDiff = endLonRad - startLonRad;

    const a =
      Math.pow(Math.sin(latDiff / 2), 2) +
      Math.cos(startLatRad) * Math.cos(endLatRad) * Math.pow(Math.sin(lonDiff / 2), 2);

    const distance = 2 * earthRadius * Math.asin(Math.sqrt(a));

    const correctionFactor = 1.5;
    const correctedDistance = distance * correctionFactor;

    const gs = this.globalSettings || await (tx as any).dvi_global_settings.findFirst({
      where: { deleted: 0, status: 1 },
    });

    let avgSpeedKmPerHr =
      travelLocationType === 1
        ? Number(gs?.itinerary_local_speed_limit ?? 40)
        : Number(gs?.itinerary_outstation_speed_limit ?? 60);

// ⚡ PERFORMANCE/LOGIC: If distance is significant (> 10km),
    // don't use the very slow local speed (often 15km/h in DB).
    // This handles cases where hotspots are in the same "city" but far apart.
    if (travelLocationType === 1 && correctedDistance > 10 && avgSpeedKmPerHr < 40) {
      avgSpeedKmPerHr = 40;
    }

    const durationHours = correctedDistance / avgSpeedKmPerHr;
    const rawTotalMinutes = Math.round(durationHours * 60);
    const clampedMinutes = Math.max(rawTotalMinutes, MIN_TRAVEL_MINUTES);
    const wholeHours = Math.floor(clampedMinutes / 60);
    const minutes = clampedMinutes % 60;

    // This is a computed travel time (not from DB). It should never exceed 24h normally.
    const travelTime = `${String(wholeHours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

    const bufferTime = await this.getBufferTime(tx, travelLocationType);

    return { distanceKm: correctedDistance, travelTime, bufferTime };
  }

  async fromLocationId(tx: Tx, locationId: number, travelLocationType: 1 | 2): Promise<DistanceResult> {
    const loc = await (tx as any).dvi_stored_locations.findFirst({
      where: { location_ID: locationId },
    });

    if (!loc) {
      return { distanceKm: 0, travelTime: "00:00:00", bufferTime: "00:00:00" };
    }

    const distance = Number(loc.distance ?? 0);

    // ✅ duration in DB is string like "3 hours 5 mins" / "1 day 1 hour"
    const totalMinutes = parseDurationToMinutes(loc.duration);

    // ✅ IMPORTANT: use *duration* formatter (NO wrap)
    const travelTime = minutesToDurationTime(Math.max(totalMinutes ?? 0, MIN_TRAVEL_MINUTES));

    const bufferTime = await this.getBufferTime(tx, travelLocationType);

    return { distanceKm: distance, travelTime, bufferTime };
  }

  async fromSourceAndDestination(
    tx: Tx,
    sourceLocation: string,
    destinationLocation: string,
    travelLocationType: 1 | 2,
    sourceCoords?: { lat: number; lon: number },
    destCoords?: { lat: number; lon: number },
  ): Promise<DistanceResult> {
    const trimmedSource = String(sourceLocation ?? "").trim();
    const trimmedDest = String(destinationLocation ?? "").trim();

    // ✅ PHP PARITY: For hotspots (which provide coordinates), PHP ALWAYS uses
    // Haversine formula instead of looking up in dvi_stored_locations.
    // This prevents using city-to-city distances for specific hotspots.
    if (sourceCoords && destCoords &&
        (sourceCoords.lat !== 0 || sourceCoords.lon !== 0) &&
        (destCoords.lat !== 0 || destCoords.lon !== 0)) {
      return this.fromCoordinates(
        tx,
        sourceCoords.lat,
        sourceCoords.lon,
        destCoords.lat,
        destCoords.lon,
        travelLocationType,
      );
    }

    const logMsg = `[DistanceHelper] Looking up: "${trimmedSource}" → "${trimmedDest}"\n`;

    // Check cache first
    const cacheKey = `${trimmedSource}|${trimmedDest}`;
    let loc = distanceCache.get(cacheKey);

    if (!loc) {
      // 1) Try exact match
      loc = await (tx as any).dvi_stored_locations.findFirst({
        where: {
          deleted: 0,
          source_location: trimmedSource,
          destination_location: trimmedDest,
        },
        orderBy: { location_ID: "desc" },
      });

      // 2) Fallback: Try splitting by pipe | (common in hotspot_location)
      if (!loc && (trimmedSource.includes('|') || trimmedDest.includes('|'))) {
        const s = trimmedSource.split('|')[0].trim();
        const d = trimmedDest.split('|')[0].trim();
        loc = await (tx as any).dvi_stored_locations.findFirst({
          where: {
            deleted: 0,
            source_location: s,
            destination_location: d,
          },
          orderBy: { location_ID: "desc" },
        });
      }

      if (loc) {
        distanceCache.set(cacheKey, loc);
      }
    }

    if (loc) {
      const distance = Number(loc.distance ?? 0);
      const totalMinutes = parseDurationToMinutes(loc.duration);
      const travelTime = minutesToDurationTime(Math.max(totalMinutes ?? 0, MIN_TRAVEL_MINUTES));
      const bufferTime = await this.getBufferTime(tx, travelLocationType);
      return { distanceKm: distance, travelTime, bufferTime };
    }

    // 3) Fallback: If we have at least one set of coords, try to find the other and use Haversine
    if (destCoords && (destCoords.lat !== 0 || destCoords.lon !== 0)) {
      // Try to find coords for source city
      const s = trimmedSource.split('|')[0].trim();
      const sourceLoc = await (tx as any).dvi_stored_locations.findFirst({
        where: { source_location: s, deleted: 0 },
      });
      if (sourceLoc?.source_location_lattitude && sourceLoc?.source_location_longitude) {
        return this.fromCoordinates(
          tx,
          Number(sourceLoc.source_location_lattitude),
          Number(sourceLoc.source_location_longitude),
          destCoords.lat,
          destCoords.lon,
          travelLocationType,
        );
      }
    }

    return { distanceKm: 0, travelTime: "00:00:00", bufferTime: "00:00:00" };
  }

  private async getBufferTime(tx: Tx, travelLocationType: 1 | 2): Promise<string> {
    const gs = this.globalSettings || await (tx as any).dvi_global_settings.findFirst({
      where: { deleted: 0, status: 1 },
    });

    if (!gs) return "00:00:00";

    /**
     * ✅ FIX-1 (your issue):
     * For LOCAL sightseeing hops (travelLocationType === 1),
     * do NOT add the global road/common buffer.
     *
     * Otherwise travel rows become:
     *   travelTime + 1:00 buffer  => looks like 2 hours vs Google’s < 1 hour
     */
    if (travelLocationType === 1) {
      return "00:00:00";
    }

    // OUTSTATION / inter-city legs: keep your existing logic
    // PHP PARITY: Use itinerary_travel_by_road_buffer_time for road travel
    // If not available, fallback to itinerary_common_buffer_time
    const bufferTimeField =
      gs.itinerary_travel_by_road_buffer_time || gs.itinerary_common_buffer_time;

    if (bufferTimeField instanceof Date) {
      const hours = bufferTimeField.getUTCHours();
      const minutes = bufferTimeField.getUTCMinutes();
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
    }

    return "00:00:00";
  }
}
