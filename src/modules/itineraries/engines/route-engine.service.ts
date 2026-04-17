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
import { timeStringToPrismaTime } from "../utils/itinerary.utils";

type Tx = Prisma.TransactionClient;

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
): Promise<{ locationId: bigint; distanceKm: string; travelSeconds: number | null }> {
  const trimmedSource = String(sourceName ?? "").trim();
  const trimmedDest = String(destName ?? "").trim();

  if (!trimmedSource || !trimmedDest) {
    return { locationId: BigInt(0), distanceKm: "", travelSeconds: null };
  }

  const normalizeText = (value: string) =>
    value.replace(/\s+/g, " ").trim().toLowerCase();

  const normalizedSource = normalizeText(trimmedSource);
  const normalizedDest = normalizeText(trimmedDest);

  let row =
    await (tx as any).dvi_stored_locations.findFirst({
      where: {
        source_location: trimmedSource,
        destination_location: trimmedDest,
        deleted: 0,
      },
      orderBy: {
        location_ID: "desc",
      },
      select: {
        location_ID: true,
        distance: true,
        duration: true,
      },
    });

  if (!row) {
    const rows = await (tx as any).dvi_stored_locations.findMany({
      where: { deleted: 0 },
      orderBy: { location_ID: "desc" },
      select: {
        location_ID: true,
        source_location: true,
        destination_location: true,
        distance: true,
        duration: true,
      },
    });

    row =
      rows.find((r: any) => {
        const src = normalizeText(String(r.source_location ?? ""));
        const dest = normalizeText(String(r.destination_location ?? ""));
        return src === normalizedSource && dest === normalizedDest;
      }) ||
      rows.find((r: any) => {
        const src = normalizeText(String(r.source_location ?? ""));
        const dest = normalizeText(String(r.destination_location ?? ""));
        return src === normalizedDest && dest === normalizedSource;
      }) ||
      null;
  }

  if (!row) {
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

    const totalRoutes = Array.isArray(routes) ? routes.length : 0;

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
      const r: any = routes[idx] || {};
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
);

const requestKm = this.normalizeKmValue(r.no_of_km);

const fallbackKm =
  this.normalizeKmValue(r.distance) ||
  this.normalizeKmValue(r.total_distance) ||
  this.normalizeKmValue(r.intercityDistance);

const finalKm = requestKm || distanceKm || fallbackKm || "";

      // itinerary_route_date = trip_start_date + dayOffset (one day per leg)
      const routeDate = new Date(baseDate.getTime());
      routeDate.setUTCDate(routeDate.getUTCDate() + dayOffset);
      dayOffset += 1; // PHP's $selected_NO_OF_DAYS = 1;

      // Start time defaults
      let startHms: string;
      if (r.route_start_time) {
        startHms = r.route_start_time;
      } else if (isLast) {
        // Last route still gets the timeline builder's 1-hour pre-sightseeing buffer,
        // so keep route start at 08:00 to make sightseeing begin at 09:00.
        startHms = "08:00:00";
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
     const row = await (tx as any).dvi_itinerary_route_details.create({
  data: {
    itinerary_plan_ID: planId,
    location_id: locationId,
    location_name: sourceName,
    itinerary_route_date: routeDate,
    no_of_days: 1, // PHP: $selected_NO_OF_DAYS = 1
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
  },
});

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
    // Delete existing permit charges for this plan
    await (tx as any).dvi_itinerary_plan_route_permit_charge.deleteMany({
      where: { itinerary_plan_ID: planId },
    });

    // Get all routes for this plan
    const routes = await (tx as any).dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        location_name: true,
        next_visiting_location: true,
      },
    });

    // Get all eligible vendors/vehicles for this plan
    const eligibleVehicles = await (tx as any).dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        itinerary_plan_id: planId,
        status: 1,
        deleted: 0,
      },
      select: {
        vendor_id: true,
        vendor_vehicle_type_id: true,
        vehicle_id: true,
      },
    });

    const permitRows = [];
    // Track vendor/state pairs to avoid duplicates (PHP parity: one permit per vendor per state pair)
    const addedPermits = new Set<string>();

    for (const route of routes) {
      // Get destination state for this route
      const destState = await this.getLocationState(tx, route.next_visiting_location);

      if (!destState) {
        continue;
      }

      // PHP parity: For each eligible vehicle, check if vehicle's registration state != destination state
      for (const eligibleVehicle of eligibleVehicles) {
        // Get vehicle details including registration number
        const vehicle = await (tx as any).dvi_vehicle.findUnique({
          where: { vehicle_id: eligibleVehicle.vehicle_id },
          select: {
            registration_number: true,
          },
        });

        if (!vehicle?.registration_number) {
          continue;
        }

        // Extract state code from registration (first 2 characters)
        // PHP: $state_code = substr($registration_number, 0, 2);
        const stateCode = vehicle.registration_number.substring(0, 2);

        // Get vehicle's registration state from permit_state table
        const vehicleState = await (tx as any).dvi_permit_state.findFirst({
          where: {
            state_code: stateCode,
            deleted: 0,
            status: 1,
          },
          select: { permit_state_id: true },
        });

        if (!vehicleState) {
          continue;
        }

        const vehicleStateId = Number(vehicleState.permit_state_id);

        // PHP parity: If vehicle state == destination state, permit cost = 0 (no permit needed)
        if (vehicleStateId === destState) {
          continue;
        }

        // PHP parity: source_state_id = vehicle registration state, destination_state_id = route destination
        const permitCost = await (tx as any).dvi_permit_cost.findFirst({
          where: {
            vendor_id: eligibleVehicle.vendor_id,
            vehicle_type_id: eligibleVehicle.vendor_vehicle_type_id,
            source_state_id: vehicleStateId,
            destination_state_id: destState,
            status: 1,
            deleted: 0,
          },
          select: {
            permit_cost: true,
          },
        });

        if (!permitCost) {
          continue;
        }

        // PHP parity: Only create one permit per vendor per state pair
        const permitKey = `${eligibleVehicle.vendor_id}-${vehicleStateId}-${destState}`;
        if (addedPermits.has(permitKey)) {
          continue;
        }
        addedPermits.add(permitKey);

        permitRows.push({
          itinerary_plan_ID: planId,
          itinerary_route_ID: route.itinerary_route_ID,
          itinerary_route_date: route.itinerary_route_date,
          vendor_id: eligibleVehicle.vendor_id,
          vendor_branch_id: 0,
          vendor_vehicle_type_id: eligibleVehicle.vendor_vehicle_type_id,
          source_state_id: vehicleStateId,
          destination_state_id: destState,
          permit_cost: permitCost.permit_cost,
          createdby: userId,
          createdon: new Date(),
          updatedon: null,
          status: 1,
          deleted: 0,
        });
      }
    }

    // Insert permit charges
    if (permitRows.length) {
      await (tx as any).dvi_itinerary_plan_route_permit_charge.createMany({
        data: permitRows,
      });
    }
  }

  // Helper to get permit state ID from location name (PHP parity)
  private async getLocationState(tx: Tx, locationName: string): Promise<number | null> {
    try {
      // Step 1: Get state NAME from stored_locations (PHP parity)
      const stored = await (tx as any).dvi_stored_locations.findFirst({
        where: {
          OR: [{ source_location: locationName }, { destination_location: locationName }],
          status: 1,
          deleted: 0,
        },
        select: {
          source_location: true,
          source_location_state: true,
          destination_location: true,
          destination_location_state: true,
        },
      });

      let stateName = null;
      if (stored) {
        if (stored.source_location === locationName && stored.source_location_state) {
          stateName = stored.source_location_state;
        } else if (stored.destination_location === locationName && stored.destination_location_state) {
          stateName = stored.destination_location_state;
        }
      }

      if (!stateName) {
        return null;
      }

      // Step 2: Get permit_state_id from dvi_permit_state table (PHP parity)
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
}
