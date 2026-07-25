// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/helpers/timeline.cutoff-policy.ts

import { Prisma } from "@prisma/client";
import { timeToSeconds } from "./time.helper";
import { DistanceHelper } from "./distance.helper";

type Tx = Prisma.TransactionClient;

export type CutoffPolicy = {
 latestAllowedEnd: number; // seconds since 00:00
 hotelCutoff: number; // seconds since 00:00
  isAtDestination: boolean;

 // NOTE: builder mutates these as it schedules hotspots
  currentLocation: string;
  currentCoords: { lat: number; lon: number } | undefined;

 // destination city coords (used for hotel/final travel)
  destCityCoords: { lat: number; lon: number } | undefined;
};

function normalizeCity(name: any): string {
  return String(name ?? "").split("|")[0].trim();
}

function toTimeString(v: any, fallback: string): string {
  if (!v) return fallback;

 // Prisma TIME may come back as Date
  if (v instanceof Date) {
    const hh = String(v.getUTCHours()).padStart(2, "0");
    const mm = String(v.getUTCMinutes()).padStart(2, "0");
    const ss = String(v.getUTCSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  const s = String(v).trim();
  if (/^\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s;

  return fallback;
}

/**
 * Finds coordinates for a city name.
 * Your DB can store locations in multiple ways, so we try:
 *  1) source_location == city
 *  2) destination_location == city
 *
 * Returns {lat, lon} or undefined if not found.
 */
async function getCityCoords(
  tx: Tx,
  city: string,
): Promise<{ lat: number; lon: number } | undefined> {
  const c = normalizeCity(city);
  if (!c) return undefined;

 // Try as source_location
  const asSource = await (tx as any).dvi_stored_locations.findFirst({
    where: { source_location: c, deleted: 0 },
  });

  if (
    asSource?.source_location_lattitude != null &&
    asSource?.source_location_longitude != null
  ) {
    const lat = Number(asSource.source_location_lattitude);
    const lon = Number(asSource.source_location_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

 // Try as destination_location
  const asDest = await (tx as any).dvi_stored_locations.findFirst({
    where: { destination_location: c, deleted: 0 },
  });

  if (
    asDest?.destination_location_lattitude != null &&
    asDest?.destination_location_longitude != null
  ) {
    const lat = Number(asDest.destination_location_lattitude);
    const lon = Number(asDest.destination_location_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

 // Try as hotspot name (e.g. "Madurai Airport" is a hotspot)
  const asHotspot = await (tx as any).dvi_hotspot_place.findFirst({
    where: { hotspot_name: c, deleted: 0 },
  });
  if (asHotspot?.hotspot_latitude != null && asHotspot?.hotspot_longitude != null) {
    const lat = Number(asHotspot.hotspot_latitude);
    const lon = Number(asHotspot.hotspot_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

  return undefined;
}

/**
 * Cutoff Policy rules:
 * - Base cutoff is route.route_end_time (user-configurable). If missing, default to 20:00:00.
 * - Extend to 22:00:00 ONLY when the route end time is still default-ish (18:00 or 20:00)
 *   AND there are manual/boundary hotspots (PHP parity rule).
 * - latestAllowedEnd = hotelCutoff - (travelTimeToDestination)
 *   BUT only if not last route and not already in destination city.
 * - Clamp latestAllowedEnd to be >= currentTime, so we never produce a "past" deadline.
 */
export async function computeCutoffPolicy(
  tx: Tx,
  route: any,
 // kept for signature parity (unused currently)
 // eslint-disable-next-line @typescript-eslint/no-unused-vars
  plan: any,
  currentTime: string,
  distanceHelper: DistanceHelper,
  isLastRoute: boolean,
  hasManualOrBoundary: boolean,
): Promise<CutoffPolicy> {
  const sourceCity = normalizeCity(route?.location_name);
  const destCity = normalizeCity(route?.next_visiting_location);

  const isAtDestination =
    sourceCity.toLowerCase() !== "" &&
    destCity.toLowerCase() !== "" &&
    sourceCity.toLowerCase() === destCity.toLowerCase();

 // User-configurable end time (route_end_time can be Date or string)
  const routeEndTime = toTimeString(route?.route_end_time, "20:00:00");
  let hotelCutoff = timeToSeconds(routeEndTime);

 // PHP parity extension rule:
 // Extend to 10 PM only if user hasn't explicitly chosen a custom cutoff.
 // (i.e., only when it's default-ish 18:00 or 20:00)
  if (
    hasManualOrBoundary &&
    (routeEndTime === "20:00:00" || routeEndTime === "18:00:00")
  ) {
    hotelCutoff = timeToSeconds("22:00:00");
  }

 // Coords
  const currentCoords = await getCityCoords(tx, sourceCity);
  const destCityCoords = await getCityCoords(tx, destCity);

 // Deadline logic
  let latestAllowedEnd = hotelCutoff;

 // Guard: compute city-to-city travel when both cities exist
 // PHP Parity: On the last day, we MUST reserve time to reach the departure point (airport/railway).
  if (!isAtDestination && sourceCity && destCity) {
 // For now we compute travel time using city-to-city baseline.
 // Builder may later compute from currentCoords to destCityCoords dynamically.
    const travel = await distanceHelper.fromSourceAndDestination(
      tx,
      sourceCity,
      destCity,
      2,
    );

    const travelSec =
      timeToSeconds(travel.travelTime || "00:00:00") +
      timeToSeconds(travel.bufferTime || "00:00:00");

    latestAllowedEnd = hotelCutoff - travelSec;
  }

 // Clamp deadline to never be "before now"
  const nowSec = timeToSeconds(toTimeString(currentTime, "00:00:00"));
  if (latestAllowedEnd < nowSec) latestAllowedEnd = nowSec;

 // Also clamp to valid range
  if (latestAllowedEnd < 0) latestAllowedEnd = 0;
  if (hotelCutoff < 0) hotelCutoff = 0;

  return {
    latestAllowedEnd,
    hotelCutoff,
    isAtDestination,
    currentLocation: sourceCity,
    currentCoords,
    destCityCoords,
  };
}
