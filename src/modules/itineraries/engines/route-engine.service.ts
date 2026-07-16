// REPLACE-WHOLE-FILE
// FILE: src/itineraries/engines/route-engine.service.ts
//
// PHP-PARITY ROUTE WRITER
// ------------------------
// This service rebuilds dvi_itinerary_route_details for a plan so that
// the rows for a NestJS-created plan (e.g. plan 4) match the rows that
// PHP would create for the same payload (e.g. plan 2).
//
// Key parity points:
//   • location_id      → looked up from dvi_stored_locations(source, destination)
//   • location_name    → source location name (string)
//   • itinerary_route_date → trip_start_date + leg index (1 day per leg)
//   • no_of_days       → ALWAYS 1 (PHP uses $selected_NO_OF_DAYS = 1)
//   • no_of_km         → distance from dvi_stored_locations.distance
//   • direct_to_next_visiting_place → 0 (current PHP has checkbox logic disabled)
//   • next_visiting_location       → destination name (string)
//   • route_start_time / route_end_time:
//         - first leg: trip_start_time (MUST be IST wall-clock, no UTC conversion)
//         - middle legs: 08:00:00 → 20:00:00
//         - sightseeing end: 20:00:00 (PHP parity)
//   • createdby / createdon / status / deleted → PHP-like semantics.
//
// IMPORTANT TIMEZONE NOTE (YOUR BUG FIX):
// MySQL TIME has NO timezone. Your UI sends ISO strings with +05:30.
// If we do `new Date("...+05:30")` and then extract hours, production (UTC)
// will shift 12:00 to 06:30 and you will save 06:30 into route_start_time.
// So: for tripStartTime/EndTime we extract the "wall-clock" HH:mm:ss directly
// from the incoming string.

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CreatePlanDto, CreateRouteDto } from "../dto/create-itinerary.dto";
import { normalizeCityName } from "../utils/city-normalization.util";
import { timeStringToPrismaTime } from "../utils/itinerary.utils";

type Tx = Prisma.TransactionClient;

type PermitLocationChainArgs = {
  routeCount: number;
  totalRoutes: number;
  vehicleOrigin: string | null;
  sourceLocation: string | null;
  viaLocations: string[];
  destinationLocation: string | null;
};

export function buildPermitLocationChain(args: PermitLocationChainArgs): string[] {
  const vehicleOrigin = String(args.vehicleOrigin ?? '').trim();
  const sourceLocation = String(args.sourceLocation ?? '').trim();
  const destinationLocation = String(args.destinationLocation ?? '').trim();
  const viaLocations = (args.viaLocations ?? [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);

  const chain: string[] = [];

  if (args.routeCount === 1 && vehicleOrigin) {
    chain.push(vehicleOrigin);
  }

  if (sourceLocation) {
    chain.push(sourceLocation);
  }

  if (viaLocations.length) {
    chain.push(...viaLocations);
  }

  if (destinationLocation) {
    chain.push(destinationLocation);
  }

  if (args.routeCount === args.totalRoutes && args.routeCount > 1 && vehicleOrigin) {
    chain.push(vehicleOrigin);
  }

  return chain.filter((value) => value.length > 0);
}

@Injectable()
export class RouteEngineService {
  /* ----------------------------------------------------------
   * Helpers: basic time formatting
   * --------------------------------------------------------*/

  private pad2(n: number): string {
  return String(Math.max(0, n | 0)).padStart(2, "0");
}

private normalizeKmValue(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const numeric = parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(numeric) || numeric <= 0) return "";

  return numeric.toFixed(2);
}

  /**
   * Parse dvi_stored_locations.duration into seconds.
   * Supports values like:
   * - "49 mins"
   * - "1 hour 56 mins"
   * - "1 day 2 hours 15 mins"
   * - numeric strings (treated as minutes)
   */
  private parseDurationToSeconds(duration: unknown): number | null {
    if (duration == null) return null;

    if (typeof duration === "number" && Number.isFinite(duration)) {
      return Math.max(0, Math.floor(duration)) * 60;
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
      if (Number.isFinite(n)) return Math.max(0, Math.floor(n)) * 60;
      return null;
    }

    return (days * 1440 + hours * 60 + mins) * 60;
  }

  /**
   * Fallback estimator when stored_locations.duration is missing.
   * Keeps short hops conservative for airport reporting reliability.
   */
  private estimateTravelSecondsFromKm(distanceKmText: string): number {
    const km = Number.parseFloat(String(distanceKmText || "0").replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(km) || km <= 0) return 30 * 60;

    if (km <= 5) return 30 * 60;
    if (km <= 20) return Math.ceil((km / 25) * 60) * 60;
    if (km <= 80) return Math.ceil((km / 35) * 60) * 60;
    return Math.ceil((km / 45) * 60) * 60;
  }

  private toHmsFromDate(d: Date): string {
    const hh = d.getHours();
    const mm = d.getMinutes();
    const ss = d.getSeconds();
    return `${this.pad2(hh)}:${this.pad2(mm)}:${this.pad2(ss)}`;
  }

  private parseHmsToSeconds(hms: string): number {
    const [h, m, s] = (hms || "00:00:00").split(":").map((x) => Number(x || 0));
    return (h | 0) * 3600 + (m | 0) * 60 + (s | 0);
  }

  private secondsToHms(sec: number): string {
    const S = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(S / 3600) % 24;
    const m = Math.floor((S % 3600) / 60);
    const s = S % 60;
    return `${this.pad2(h)}:${this.pad2(m)}:${this.pad2(s)}`;
  }

  /** Extract wall-clock HH:mm:ss from an ISO string WITHOUT timezone conversion. */
  private extractWallTimeHms(iso?: string | null): string | null {
    if (!iso) return null;
    // supports:
    //  - 2025-12-20T12:00:00+05:30
    //  - 2025-12-20T12:00:00.000Z
    //  - 2025-12-20 12:00:00
    const m = String(iso).match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
  }

  /** Extract wall-clock date YYYY-MM-DD from an ISO-ish string. */
  private extractWallDateYmd(iso?: string | null): { y: number; m: number; d: number } | null {
    if (!iso) return null;
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!y || !mo || !d) return null;
    return { y, m: mo, d };
  }

  /**
   * Extract trip_start_time and trip_end_time as HH:MM:SS from the plan DTO.
   * MUST be IST wall-clock parity (NO UTC conversion).
   */
  private extractTripTimes(plan: CreatePlanDto) {
    const anyPlan: any = plan || {};

    const startIso =
      anyPlan.trip_start_date ||
      anyPlan.pick_up_date_and_time ||
      anyPlan.tripStartDate ||
      anyPlan.pickUpDateAndTime;

    const endIso =
      anyPlan.trip_end_date ||
      anyPlan.tripEndDate ||
      anyPlan.trip_end_time ||
      anyPlan.tripEndTime;

    // ✅ Prefer wall-time extraction (prevents 12:00+05:30 turning into 06:30 in UTC env)
    const tripStartTimeHms =
      this.extractWallTimeHms(startIso) ??
      this.toHmsFromDate(startIso ? new Date(startIso) : new Date());

    const tripEndTimeHms =
      this.extractWallTimeHms(endIso) ??
      this.toHmsFromDate(endIso ? new Date(endIso) : new Date());

    return { tripStartTimeHms, tripEndTimeHms };
  }

  /**
   * PHP uses different buffer times for flight/train/road departures.
   * We don't have the global settings table wired, so we mirror the
   * typical values inferred from your sample:
   *   - Flight (1): 2 hours
   *   - Train  (2): 1 hour
   *   - Road   (3): 0 hours (leave at end time)
   */
  private getDepartureBufferSeconds(departureType: number | null | undefined) {
    switch (Number(departureType || 0)) {
      case 1: // flight
        return 2 * 3600;
      case 2: // train
        return 1 * 3600;
      case 3: // road
        return 0;
      default:
        return 0;
    }
  }

  /**
   * Resolve location_id + distance from dvi_stored_locations
   * for (source_location, destination_location).
   *
   * If no row found, returns { 0n, "" } exactly like PHP's
   * `$distanceKM = 0;` branch.
   */
  private async resolveSourceLocationAndKm(
    tx: Tx,
    sourceName: string,
    destName: string,
    requestedKm?: unknown,
  ): Promise<{ locationId: bigint; distanceKm: string; travelSeconds: number | null }> {
    const shouldDebugHotspotRca =
      process.env.DEBUG_HOTSPOT_WRITER === "1" ||
      process.env.NODE_ENV !== "production";
    const trimmedSource = String(sourceName ?? "").trim();
    const trimmedDest = String(destName ?? "").trim();

    if (!trimmedSource || !trimmedDest) {
      return { locationId: BigInt(0), distanceKm: "", travelSeconds: null };
    }

    const normalizeText = (value: string) =>
      value.replace(/\s+/g, " ").trim().toLowerCase();

    const normalizeCityKey = (value: string) => {
      const normalized = normalizeCityName(value);
      if (normalized) {
        return normalizeText(normalized);
      }

      return normalizeText(value)
        .replace(/\binternational\b/g, " ")
        .replace(/\bdomestic\b/g, " ")
        .replace(/\bair\s*port\b/g, " ")
        .replace(/\bairport\b/g, " ")
        .replace(/\brailway\b/g, " ")
        .replace(/\bstation\b/g, " ")
        .replace(/\bterminal\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };

    const normalizedSource = normalizeText(trimmedSource);
    const normalizedDest = normalizeText(trimmedDest);
    const sourceCityKey = normalizeCityKey(trimmedSource);
    const destCityKey = normalizeCityKey(trimmedDest);
    const requestedKmNumber = Number(this.normalizeKmValue(requestedKm as any) || 0);
    const hasRequestedKm = Number.isFinite(requestedKmNumber) && requestedKmNumber > 0;

    const sourceLike = `%${normalizedSource}%`;
    const destLike = `%${normalizedDest}%`;
    const sourceCityLike = `%${sourceCityKey}%`;
    const destCityLike = `%${destCityKey}%`;

    const rows = (await (tx as any).$queryRaw(Prisma.sql`
      SELECT
        sl.location_ID,
        sl.source_location,
        sl.source_location_city,
        sl.destination_location,
        sl.destination_location_city,
        sl.distance,
        sl.duration,
        CASE
          WHEN LOWER(TRIM(sl.source_location)) = ${normalizedSource}
           AND LOWER(TRIM(sl.destination_location)) = ${normalizedDest}
            THEN 0
          WHEN LOWER(TRIM(sl.source_location)) = ${normalizedSource}
           AND LOWER(TRIM(sl.destination_location_city)) = ${normalizedDest}
            THEN 1
          WHEN LOWER(TRIM(sl.source_location_city)) = ${normalizedSource}
           AND LOWER(TRIM(sl.destination_location)) = ${normalizedDest}
            THEN 2
          WHEN LOWER(TRIM(sl.source_location_city)) = ${normalizedSource}
           AND LOWER(TRIM(sl.destination_location_city)) = ${normalizedDest}
            THEN 3
          WHEN LOWER(sl.source_location) LIKE ${sourceLike}
           AND (
              LOWER(sl.destination_location) LIKE ${destLike}
              OR LOWER(sl.destination_location_city) LIKE ${destLike}
           )
            THEN 4
          WHEN LOWER(sl.source_location) LIKE ${sourceCityLike}
           AND (
              LOWER(sl.destination_location) LIKE ${destCityLike}
              OR LOWER(sl.destination_location_city) LIKE ${destCityLike}
           )
            THEN 5
          WHEN LOWER(sl.source_location_city) LIKE ${sourceCityLike}
           AND LOWER(sl.destination_location_city) LIKE ${destCityLike}
            THEN 6
          ELSE 99
        END AS match_rank,
        CASE
          WHEN LOWER(${normalizedSource}) LIKE '%airport%'
           AND LOWER(sl.source_location) LIKE '%airport%'
            THEN 0
          WHEN LOWER(${normalizedSource}) LIKE '%airport%'
           AND LOWER(sl.source_location) NOT LIKE '%airport%'
            THEN 10
          ELSE 0
        END AS airport_penalty,
        CASE
          WHEN ${hasRequestedKm ? 1 : 0} = 1
            THEN ABS(CAST(NULLIF(sl.distance, '') AS DECIMAL(10,2)) - ${requestedKmNumber})
          ELSE 999999
        END AS km_diff
      FROM dvi_stored_locations sl
      WHERE sl.deleted = 0
        AND sl.status = 1
        AND (
          (
            LOWER(TRIM(sl.source_location)) = ${normalizedSource}
            AND LOWER(TRIM(sl.destination_location)) = ${normalizedDest}
          )
          OR
          (
            LOWER(TRIM(sl.source_location)) = ${normalizedSource}
            AND LOWER(TRIM(sl.destination_location_city)) = ${normalizedDest}
          )
          OR
          (
            LOWER(TRIM(sl.source_location_city)) = ${normalizedSource}
            AND LOWER(TRIM(sl.destination_location)) = ${normalizedDest}
          )
          OR
          (
            LOWER(TRIM(sl.source_location_city)) = ${normalizedSource}
            AND LOWER(TRIM(sl.destination_location_city)) = ${normalizedDest}
          )
          OR
          (
            LOWER(sl.source_location) LIKE ${sourceLike}
            AND (
              LOWER(sl.destination_location) LIKE ${destLike}
              OR LOWER(sl.destination_location_city) LIKE ${destLike}
            )
          )
          OR
          (
            LOWER(sl.source_location) LIKE ${sourceCityLike}
            AND (
              LOWER(sl.destination_location) LIKE ${destCityLike}
              OR LOWER(sl.destination_location_city) LIKE ${destCityLike}
            )
          )
          OR
          (
            LOWER(sl.source_location_city) LIKE ${sourceCityLike}
            AND LOWER(sl.destination_location_city) LIKE ${destCityLike}
          )
        )
      ORDER BY
        match_rank ASC,
        airport_penalty ASC,
        km_diff ASC,
        sl.location_ID DESC
      LIMIT 1
    `)) as any[];

    const row = rows?.[0] || null;

    if (!row) {
      if (shouldDebugHotspotRca) {
        console.log("[HOTSPOT_RCA] route resolution", {
          sourceName: trimmedSource,
          destName: trimmedDest,
          normalizedSource,
          normalizedDest,
          normalizedSourceCity: sourceCityKey,
          normalizedDestCity: destCityKey,
          requestedKm: requestedKmNumber || null,
          locationId: 0,
        });
      }
      console.warn("[ROUTE_MASTER_LOOKUP_FAILED]", {
        sourceName: trimmedSource,
        destName: trimmedDest,
        requestedKm: requestedKmNumber || null,
        sourceCityKey,
        destCityKey,
      });

      if (process.env.STRICT_ROUTE_MASTER_LOOKUP === "1") {
        throw new Error(
          `[ROUTE_MASTER_LOOKUP_FAILED] ${trimmedSource} -> ${trimmedDest}. ` +
            `Cannot create itinerary route with location_id=0.`,
        );
      }

      return { locationId: BigInt(0), distanceKm: "", travelSeconds: null };
    }

    const rawId = (row as any).location_ID ?? 0;

    let locationId: bigint;
    try {
      if (typeof rawId === "bigint") {
        locationId = rawId;
      } else if (typeof rawId === "number") {
        locationId = BigInt(Math.trunc(rawId));
      } else {
        locationId = BigInt(String(rawId));
      }
    } catch {
      locationId = BigInt(0);
    }

    const distanceRaw = (row as any).distance;
    const distanceKm = this.normalizeKmValue(distanceRaw);
    const travelSeconds = this.parseDurationToSeconds((row as any).duration ?? null);

    if (shouldDebugHotspotRca) {
      console.log("[HOTSPOT_RCA] route resolution", {
        sourceName: trimmedSource,
        destName: trimmedDest,
        normalizedSource,
        normalizedDest,
        normalizedSourceCity: sourceCityKey,
        normalizedDestCity: destCityKey,
        locationId: Number(locationId || 0),
        matchedSource: String((row as any).source_location || ""),
        matchedDestination: String((row as any).destination_location || ""),
        matchedSourceCity: String((row as any).source_location_city || ""),
        matchedDestinationCity: String((row as any).destination_location_city || ""),
      });
    }

    return { locationId, distanceKm, travelSeconds };
  }

  /**
   * Normalize the base trip start date (date-only) from the plan.
   * MUST be PHP parity (IST wall-date), NOT UTC-converted date.
   */
  private getTripStartDateOnly(plan: CreatePlanDto): Date {
    const anyPlan: any = plan || {};
    const startIso =
      anyPlan.trip_start_date ||
      anyPlan.pick_up_date_and_time ||
      anyPlan.tripStartDate ||
      anyPlan.pickUpDateAndTime;

    // ✅ Prefer wall-date extraction from the incoming string
    const ymd = this.extractWallDateYmd(startIso);
    if (ymd) {
      return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
    }

    // Fallback (should rarely happen)
    const base = startIso ? new Date(startIso) : new Date();
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  }

  private normalizeLocationName(value: string): string {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * PHP parity guard: when incoming route rows contain blank placeholders,
   * rebuild a stable day-chain by inserting stay-day legs at intermediate cities.
   */
  private normalizeSparseRouteDays(routes: CreateRouteDto[]): CreateRouteDto[] {
    if (!Array.isArray(routes) || routes.length <= 1) return routes;

    const totalRows = routes.length;
    const trimmed = routes.map((r: any) => ({
      source: String(r?.location_name ?? "").trim(),
      dest: String(r?.next_visiting_location ?? "").trim(),
    }));

    const sparseRowCount = trimmed.filter((r) => !r.source || !r.dest).length;
    if (sparseRowCount === 0) return routes;

    const anchors: string[] = [];
    const pushAnchor = (name: string) => {
      const n = String(name || "").trim();
      if (!n) return;
      const prev = anchors[anchors.length - 1] || "";
      if (this.normalizeLocationName(prev) !== this.normalizeLocationName(n)) {
        anchors.push(n);
      }
    };

    for (const row of trimmed) {
      if (row.source) pushAnchor(row.source);
      if (row.dest) pushAnchor(row.dest);
    }

    if (anchors.length < 2) return routes;

    const intermediateStops = anchors.slice(1, -1);
    if (!intermediateStops.length) return routes;

    const extraStayDays = Math.max(0, totalRows - (anchors.length - 1));
    if (extraStayDays <= 0) return routes;

    const stayAlloc = new Map<string, number>();
    for (const stop of intermediateStops) {
      stayAlloc.set(stop, 0);
    }

    for (let i = 0; i < extraStayDays; i++) {
      const stop = intermediateStops[i % intermediateStops.length];
      stayAlloc.set(stop, Number(stayAlloc.get(stop) ?? 0) + 1);
    }

    const legPairs: Array<{ source: string; dest: string }> = [];
    let current = anchors[0];
    for (let i = 1; i < anchors.length; i++) {
      const next = anchors[i];
      const stayCount = Number(stayAlloc.get(current) ?? 0);
      for (let s = 0; s < stayCount; s++) {
        legPairs.push({ source: current, dest: current });
      }
      legPairs.push({ source: current, dest: next });
      current = next;
    }

    if (legPairs.length !== totalRows) return routes;

    return routes.map((r: any, idx) => {
      const originalSource = String((r as any)?.location_name ?? "").trim();
      const originalDest = String((r as any)?.next_visiting_location ?? "").trim();
      const mappedSource = legPairs[idx].source;
      const mappedDest = legPairs[idx].dest;
      const pairChanged =
        this.normalizeLocationName(originalSource) !== this.normalizeLocationName(mappedSource) ||
        this.normalizeLocationName(originalDest) !== this.normalizeLocationName(mappedDest);

      return {
        ...r,
        location_name: mappedSource,
        next_visiting_location: mappedDest,
        __normalizedPairChanged: pairChanged,
      };
    });
  }

  /**
   * Main entry: rebuild all routes for a plan.
   */
  async rebuildRoutes(
    planId: number,
    plan: CreatePlanDto,
    routes: CreateRouteDto[],
    tx: Tx,
    userId: number,
  ) {
    const anyPlan: any = plan || {};
    const arrivalLocation = String(anyPlan.arrival_point ?? "").trim();
    const departureLocation = String(anyPlan.departure_point ?? "").trim();
    const departureType = Number(anyPlan.departure_type ?? 0) || 0;

    const normalizedRoutes = this.normalizeSparseRouteDays(Array.isArray(routes) ? routes : []);
    const totalRoutes = normalizedRoutes.length;

    // If no routes, wipe existing and return.
    if (!totalRoutes) {
      await (tx as any).dvi_itinerary_route_details.deleteMany({
        where: { itinerary_plan_ID: planId },
      });
      return [];
    }

    // Compute trip-level wall-clock start/end from request payload.
    const { tripStartTimeHms, tripEndTimeHms } = this.extractTripTimes(plan);
    const bufferSec = this.getDepartureBufferSeconds(departureType);
    const tripEndSec = this.parseHmsToSeconds(tripEndTimeHms);
    const baseDate = this.getTripStartDateOnly(plan);

    // PHP deletes/rebuilds all routes for this plan.
    await (tx as any).dvi_itinerary_route_details.deleteMany({
      where: { itinerary_plan_ID: planId },
    });

    const created: any[] = [];
    let dayOffset = 0; // PHP increments $no_of_days by 1 per leg.

    for (let idx = 0; idx < totalRoutes; idx++) {
      const r: any = normalizedRoutes[idx] || {};
      const isFirst = idx === 0;
      const isLast = idx === totalRoutes - 1;

      const sourceName = String(r.location_name ?? "").trim();
      const destName = String(r.next_visiting_location ?? "").trim();

      // location_id from master stored locations table
// no_of_km should prefer request payload value, with master distance as fallback
  const { locationId, distanceKm, travelSeconds } = await this.resolveSourceLocationAndKm(
  tx,
  sourceName,
  destName,
  r.no_of_km,
);

const requestKm = this.normalizeKmValue(r.no_of_km);
const pairChanged = Boolean((r as any).__normalizedPairChanged);

const fallbackKm =
  this.normalizeKmValue(r.distance) ||
  this.normalizeKmValue(r.total_distance) ||
  this.normalizeKmValue(r.intercityDistance);

const finalKm = pairChanged
  ? distanceKm || fallbackKm || requestKm || ""
  : requestKm || distanceKm || fallbackKm || "";
      if (process.env.DEBUG_DVI20260594_INSERT === 'true') {
        console.log('[ROUTE_SAVE_INPUT]', {
          day: dayOffset + 1,
          location_name: sourceName,
          next_visiting_location: destName,
          request_no_of_km: requestKm,
          pairChanged,
          distanceKm,
          fallbackKm,
          finalKm,
        });
      }

      const dayNumber = dayOffset + 1;

      // itinerary_route_date = trip_start_date + dayOffset (one day per leg)
      const routeDate = new Date(baseDate.getTime());
      routeDate.setUTCDate(routeDate.getUTCDate() + dayOffset);
      dayOffset += 1; // PHP's $selected_NO_OF_DAYS = 1;

      // Start time defaults
      let startHms: string;
      if (r.route_start_time) {
        startHms = r.route_start_time;
      } else if (isLast) {
        // Default last-route sightseeing starts at 08:00, but tight departure
        // routes need an earlier envelope so the final terminal transfer can fit.
        const defaultLastRouteStartSec = 8 * 3600;
        const latestTerminalArrivalSec = Math.max(0, tripEndSec - bufferSec);
        const transferLeadSec = Math.max(0, Number(travelSeconds || 0));
        const derivedLastRouteStartSec = Math.max(
          0,
          latestTerminalArrivalSec - transferLeadSec,
        );

        startHms = this.secondsToHms(
          derivedLastRouteStartSec < defaultLastRouteStartSec
            ? derivedLastRouteStartSec
            : defaultLastRouteStartSec,
        );
      } else if (totalRoutes === 1 || (isFirst && sourceName === arrivalLocation)) {
        // First leg matching arrival location → trip_start_time (IST wall-clock)
        startHms = tripStartTimeHms;
      } else {
        // Default sightseeing day start
        startHms = "08:00:00";
      }

      // End time defaults
      let endHms: string;
      if (r.route_end_time) {
        endHms = r.route_end_time;
      } else {
        if (isLast) {
            // The last route's configured end is the latest allowed ARRIVAL at the
            // departure terminal. The timeline builder separately reserves transfer
            // time when picking hotspots and when anchoring the final return segment.
          const dayStartSec = this.parseHmsToSeconds(startHms);

          // Guard: route end should never be earlier than route start.
            endHms = this.secondsToHms(Math.max(dayStartSec, tripEndSec - bufferSec));
        } else {
          endHms = "20:00:00";
        }
      }

      // Prisma requires a Date object for @db.Time fields. This helper builds a Date-like
      // value that Prisma can write into MySQL TIME. The IMPORTANT part is: startHms/endHms
      // must be IST wall-clock (fixed above), not UTC-shifted.
      const prismaData = {
    itinerary_plan_ID: planId,
    location_id: locationId,
    location_name: sourceName,
    itinerary_route_date: routeDate,
    no_of_days: dayNumber,
    no_of_km: finalKm, // prefer request payload value; fallback to master distance
    direct_to_next_visiting_place: Number(r.direct_to_next_visiting_place || 0),
    next_visiting_location: destName,
    route_start_time: timeStringToPrismaTime(startHms),
    route_end_time: timeStringToPrismaTime(endHms),
    createdby: userId,
    createdon: new Date(),
    updatedon: null,
    status: 1,
    deleted: 0,
    excluded_hotspot_ids: [],
      };
      if (process.env.DEBUG_DVI20260594_INSERT === 'true') {
        console.log('[ROUTE_PRISMA_DATA]', prismaData);
      }
      const row = await (tx as any).dvi_itinerary_route_details.create({ data: prismaData });
      if (process.env.DEBUG_DVI20260594_INSERT === 'true') {
        console.log('[ROUTE_SAVE_RESULT]', {
          itinerary_route_ID: row?.itinerary_route_ID,
          no_of_days: row?.no_of_days,
          location_name: row?.location_name,
          next_visiting_location: row?.next_visiting_location,
          no_of_km: row?.no_of_km,
        });
      }

      created.push(row);

      // keep variable referenced (avoid lint complaints if reused later)
      void departureLocation;
    }

    return created;
  }

  // ---------------------------------------------------------------------------
  // PERMIT CHARGES POPULATION (PHP PARITY)
  // ---------------------------------------------------------------------------
  async rebuildPermitCharges(tx: Tx, planId: number, userId: number): Promise<void> {
    await (tx as any).dvi_itinerary_plan_route_permit_charge.deleteMany({
      where: { itinerary_plan_ID: planId },
    });

    const routes = await (tx as any).dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        location_id: true,
        location_name: true,
        next_visiting_location: true,
      },
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }],
    });

    const eligibleVehicles = await (tx as any).dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        itinerary_plan_id: planId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_vendor_eligible_ID: true,
        vendor_id: true,
        vendor_branch_id: true,
        vendor_vehicle_type_id: true,
        vehicle_id: true,
        vehicle_orign: true,
      },
    });

    const viaRouteRows = await (tx as any).dvi_itinerary_via_route_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        itinerary_via_location_name: true,
      },
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_via_route_ID: 'asc' }],
    });

    const viaRoutesByRouteId = new Map<number, string[]>();
    for (const row of viaRouteRows) {
      const routeId = Number(row.itinerary_route_ID ?? 0);
      if (!routeId) continue;
      const name = String(row.itinerary_via_location_name ?? '').trim();
      if (!name) continue;
      const existing = viaRoutesByRouteId.get(routeId) ?? [];
      existing.push(name);
      viaRoutesByRouteId.set(routeId, existing);
    }

    console.log('[PERMIT_REBUILD_START]', {
      planId,
      routeCount: routes.length,
      eligibleVehicleCount: eligibleVehicles.length,
    });

    let insertedRows = 0;
    const totalRoutes = routes.length;

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      const routeId = Number(route.itinerary_route_ID ?? 0);
      const routeCount = routeIndex + 1;
      const routeDate = route.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
      const viaLocations = viaRoutesByRouteId.get(routeId) ?? [];

      for (const eligibleVehicle of eligibleVehicles) {
        const vehicleStateId = await this.resolveVehiclePermitStateId(tx, {
          planId,
          eligibleId: Number(eligibleVehicle.itinerary_plan_vendor_eligible_ID ?? 0),
          vendorId: Number(eligibleVehicle.vendor_id ?? 0),
          vehicleId: Number(eligibleVehicle.vehicle_id ?? 0),
        });

        if (!vehicleStateId || !routeDate) {
          continue;
        }

        const locationChain = buildPermitLocationChain({
          routeCount,
          totalRoutes,
          vehicleOrigin: String(eligibleVehicle.vehicle_orign ?? ''),
          sourceLocation: String(route.location_name ?? ''),
          viaLocations,
          destinationLocation: String(route.next_visiting_location ?? ''),
        });

        const routeStateChain = await Promise.all(
          locationChain.map(async (locationName) => ({
            locationName,
            stateId: await this.getLocationState(tx, locationName),
          })),
        );

        for (let locationIndex = 1; locationIndex < routeStateChain.length; locationIndex++) {
          const previousLocation = routeStateChain[locationIndex - 1];
          const currentLocation = routeStateChain[locationIndex];

          if (!previousLocation?.stateId || !currentLocation?.stateId) {
            continue;
          }

          if (previousLocation.stateId === currentLocation.stateId) {
            console.log('[PERMIT_ROUTE_TRANSITION_RESOLVE]', {
              planId,
              routeId,
              previousLocationName: previousLocation.locationName,
              currentLocationName: currentLocation.locationName,
              previousStateId: previousLocation.stateId,
              currentStateId: currentLocation.stateId,
              vehicleStateId,
              reason: 'same_route_state',
            });
            continue;
          }

          if (vehicleStateId === currentLocation.stateId) {
            console.log('[PERMIT_ROUTE_TRANSITION_RESOLVE]', {
              planId,
              routeId,
              previousLocationName: previousLocation.locationName,
              currentLocationName: currentLocation.locationName,
              previousStateId: previousLocation.stateId,
              currentStateId: currentLocation.stateId,
              vehicleStateId,
              reason: 'returning_to_vehicle_state',
            });
            console.log('[PERMIT_COST_LOOKUP]', {
              planId,
              routeId,
              vendorId: Number(eligibleVehicle.vendor_id ?? 0),
              vendorVehicleTypeId: Number(eligibleVehicle.vendor_vehicle_type_id ?? 0),
              sourceStateId: vehicleStateId,
              destinationStateId: currentLocation.stateId,
              foundPermitCost: 0,
              reason: 'same_state',
            });
            continue;
          }

          console.log('[PERMIT_ROUTE_TRANSITION_RESOLVE]', {
            planId,
            routeId,
            previousLocationName: previousLocation.locationName,
            currentLocationName: currentLocation.locationName,
            previousStateId: previousLocation.stateId,
            currentStateId: currentLocation.stateId,
            vehicleStateId,
            reason: 'state_boundary_crossed',
          });
          const hasDuplicate = await this.hasRecentPermitCharge(tx, {
            itineraryPlanId: planId,
            itineraryRouteDate: routeDate,
            vendorId: Number(eligibleVehicle.vendor_id ?? 0),
            vendorBranchId: Number(eligibleVehicle.vendor_branch_id ?? 0),
            vendorVehicleTypeId: Number(eligibleVehicle.vendor_vehicle_type_id ?? 0),
            sourceStateId: vehicleStateId,
            destinationStateId: currentLocation.stateId,
          });

          if (hasDuplicate) {
            console.log('[PERMIT_COST_LOOKUP]', {
              planId,
              routeId,
              vendorId: Number(eligibleVehicle.vendor_id ?? 0),
              vendorVehicleTypeId: Number(eligibleVehicle.vendor_vehicle_type_id ?? 0),
              sourceStateId: vehicleStateId,
              destinationStateId: currentLocation.stateId,
              foundPermitCost: 0,
              reason: 'duplicate_within_7_days',
            });
            continue;
          }

          const permitCost = await this.getPermitCost(tx, {
            vendorId: Number(eligibleVehicle.vendor_id ?? 0),
            vendorVehicleTypeId: Number(eligibleVehicle.vendor_vehicle_type_id ?? 0),
            sourceStateId: vehicleStateId,
            destinationStateId: currentLocation.stateId,
          });

          console.log('[PERMIT_COST_LOOKUP]', {
            planId,
            routeId,
            vendorId: Number(eligibleVehicle.vendor_id ?? 0),
            vendorVehicleTypeId: Number(eligibleVehicle.vendor_vehicle_type_id ?? 0),
            sourceStateId: vehicleStateId,
            destinationStateId: currentLocation.stateId,
            foundPermitCost: Number(permitCost ?? 0),
          });

          if (!permitCost) {
            console.log('[PERMIT_COST_LOOKUP]', {
              planId,
              routeId,
              vendorId: Number(eligibleVehicle.vendor_id ?? 0),
              vendorVehicleTypeId: Number(eligibleVehicle.vendor_vehicle_type_id ?? 0),
              sourceStateId: vehicleStateId,
              destinationStateId: currentLocation.stateId,
              foundPermitCost: 0,
              reason: 'permit_cost_missing',
            });
            continue;
          }

          await (tx as any).dvi_itinerary_plan_route_permit_charge.create({
            data: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: routeId,
              itinerary_route_date: routeDate,
              vendor_id: Number(eligibleVehicle.vendor_id ?? 0),
              vendor_branch_id: Number(eligibleVehicle.vendor_branch_id ?? 0),
              vendor_vehicle_type_id: Number(eligibleVehicle.vendor_vehicle_type_id ?? 0),
              source_state_id: vehicleStateId,
              destination_state_id: currentLocation.stateId,
              permit_cost: permitCost,
              createdby: userId,
              createdon: new Date(),
              updatedon: null,
              status: 1,
              deleted: 0,
            },
          });
          insertedRows += 1;
        }
      }
    }

    console.log('[PERMIT_REBUILD_DONE]', {
      planId,
      insertedRows,
    });
  }

  private async getLocationState(tx: Tx, locationName: string): Promise<number | null> {
    try {
      const normalizedLocationName = String(locationName ?? '').trim();
      if (!normalizedLocationName) {
        return null;
      }

      const stored = await (tx as any).dvi_stored_locations.findFirst({
        where: {
          OR: [
            { source_location: normalizedLocationName },
            { destination_location: normalizedLocationName },
          ],
          status: 1,
          deleted: 0,
        },
        select: {
          source_location: true,
          source_location_state: true,
          destination_location: true,
          destination_location_state: true,
        },
        orderBy: { location_ID: 'desc' },
      });

      let stateName: string | null = null;
      if (stored) {
        if (stored.source_location === normalizedLocationName && stored.source_location_state) {
          stateName = stored.source_location_state;
        } else if (
          stored.destination_location === normalizedLocationName &&
          stored.destination_location_state
        ) {
          stateName = stored.destination_location_state;
        }
      }

      if (!stateName) {
        const viaRoute = await (tx as any).dvi_stored_location_via_routes.findFirst({
          where: {
            via_route_location: normalizedLocationName,
            status: 1,
            deleted: 0,
          },
          select: {
            via_route_location_state: true,
          },
          orderBy: { via_route_location_ID: 'desc' },
        });

        stateName = String(viaRoute?.via_route_location_state ?? '').trim() || null;
      }

      if (!stateName) {
        return null;
      }

      let permitState = await (tx as any).dvi_permit_state.findFirst({
        where: {
          state_name: stateName,
          deleted: 0,
          status: 1,
        },
        select: { permit_state_id: true },
      });

      // If not found and state is "Pondicherry", try "Puducherry" (spelling variation)
      if (!permitState && stateName.toLowerCase() === "pondicherry") {
        permitState = await (tx as any).dvi_permit_state.findFirst({
          where: {
            state_name: "Puducherry",
            deleted: 0,
            status: 1,
          },
          select: { permit_state_id: true },
        });
      }

      // If not found and state is "Puducherry", try "Pondicherry"
      if (!permitState && stateName.toLowerCase() === "puducherry") {
        permitState = await (tx as any).dvi_permit_state.findFirst({
          where: {
            state_name: "Pondicherry",
            deleted: 0,
            status: 1,
          },
          select: { permit_state_id: true },
        });
      }

      if (!permitState?.permit_state_id) {
        return null;
      }

      const stateId = Number(permitState.permit_state_id);
      return stateId;
    } catch (error) {
      console.error(
        `[getLocationState] Error looking up state for "${locationName}":`,
        error,
      );
      return null;
    }
  }

  private async resolveVehiclePermitStateId(
    tx: Tx,
    args: {
      planId: number;
      eligibleId: number;
      vendorId: number;
      vehicleId: number;
    },
  ): Promise<number | null> {
    const vehicle = await (tx as any).dvi_vehicle.findFirst({
      where: { vehicle_id: args.vehicleId, status: 1, deleted: 0 },
      select: {
        registration_number: true,
      },
    });

    const registrationNumber = String(vehicle?.registration_number ?? '').trim();
    if (!registrationNumber) {
      return null;
    }

    const stateCode = registrationNumber.substring(0, 2).toUpperCase();
    const vehicleState = await (tx as any).dvi_permit_state.findFirst({
      where: {
        state_code: stateCode,
        deleted: 0,
        status: 1,
      },
      select: { permit_state_id: true },
    });

    const vehiclePermitStateId = Number(vehicleState?.permit_state_id ?? 0) || null;
    console.log('[PERMIT_VEHICLE_STATE_RESOLVE]', {
      planId: args.planId,
      eligibleId: args.eligibleId,
      vendorId: args.vendorId,
      vehicleId: args.vehicleId,
      registrationNumber,
      stateCode,
      vehiclePermitStateId,
    });

    return vehiclePermitStateId;
  }

  private async hasRecentPermitCharge(
    tx: Tx,
    args: {
      itineraryPlanId: number;
      itineraryRouteDate: Date;
      vendorId: number;
      vendorBranchId: number;
      vendorVehicleTypeId: number;
      sourceStateId: number;
      destinationStateId: number;
    },
  ): Promise<boolean> {
    const windowStart = new Date(args.itineraryRouteDate);
    windowStart.setDate(windowStart.getDate() - 6);

    const existing = await (tx as any).dvi_itinerary_plan_route_permit_charge.findFirst({
      where: {
        itinerary_plan_ID: args.itineraryPlanId,
        vendor_id: args.vendorId,
        vendor_branch_id: args.vendorBranchId,
        vendor_vehicle_type_id: args.vendorVehicleTypeId,
        source_state_id: args.sourceStateId,
        destination_state_id: args.destinationStateId,
        itinerary_route_date: {
          gte: windowStart,
        },
        status: 1,
        deleted: 0,
      },
      select: {
        route_permit_charge_ID: true,
      },
      orderBy: { route_permit_charge_ID: 'asc' },
    });

    return Boolean(existing?.route_permit_charge_ID);
  }

  private async getPermitCost(
    tx: Tx,
    args: {
      vendorId: number;
      vendorVehicleTypeId: number;
      sourceStateId: number;
      destinationStateId: number;
    },
  ): Promise<number> {
    const permitCost = await (tx as any).dvi_permit_cost.findFirst({
      where: {
        vendor_id: args.vendorId,
        vehicle_type_id: args.vendorVehicleTypeId,
        source_state_id: args.sourceStateId,
        destination_state_id: args.destinationStateId,
        status: 1,
        deleted: 0,
      },
      select: {
        permit_cost: true,
      },
      orderBy: { permit_cost_id: 'asc' },
    });

    return Number(permitCost?.permit_cost ?? 0);
  }
}
