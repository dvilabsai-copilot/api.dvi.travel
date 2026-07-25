// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/hotspot-engine.service.ts

import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;
type TimeLike = string | Date | number | null | undefined;

interface PlanHeader {
  itinerary_plan_ID: number;
  trip_start_date: Date;
  trip_end_date: Date;
  pick_up_date_and_time: Date;
  arrival_type: number;
  departure_type: number;
  entry_ticket_required: number;
  nationality: number;
  total_adult: number;
  total_children: number;
  total_infants: number;
}

interface RouteRow {
  itinerary_route_ID: number;
  itinerary_plan_ID: number;
  itinerary_route_date: Date;
  location_name: string;
  next_visiting_location: string;
  no_of_days: number;
  no_of_km: string | null;
  direct_to_next_visiting_place: number;
  via_route: string | null;
}

interface HotspotCandidate {
  hotspot_ID: number;
  hotspot_name: string | null;
  hotspot_location: string | null;
  hotspot_latitude: string | null;
  hotspot_longitude: string | null;
 hotspot_duration: string; // "HH:MM:SS"
  previous_hotspot_location: string | null;
}

/**
 * This engine is responsible ONLY for building:
 *   dvi_itinerary_route_hotspot_details
 *
 * We keep TIME fields as JS Date objects because Prisma @db.Time(0)
 * expects Date – you already fixed this part locally.
 */
@Injectable()
export class HotspotEngineService {
  private readonly logger = new Logger(HotspotEngineService.name);

 /* ---------- TIME HELPERS ---------- */

  private toSec(t: TimeLike): number {
    if (!t) return 0;
    if (t instanceof Date) {
      return t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds();
    }
    if (typeof t === "number") return Math.floor(t);
    const parts = String(t).trim().split(":");
    const h = Number(parts[0] ?? "0") || 0;
    const m = Number(parts[1] ?? "0") || 0;
    const s = Number(parts[2] ?? "0") || 0;
    return h * 3600 + m * 60 + s;
  }

 // Used only for calculations / debugging if needed.
  private secToHms(sec: number): string {
    if (!Number.isFinite(sec)) sec = 0;
    let total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    total -= h * 3600;
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

 // Convert seconds to a Prisma TIME Date object for @db.Time(0) fields
  private secToTimeDate(sec: number): Date {
    if (!Number.isFinite(sec)) sec = 0;
    const d = new Date(1970, 0, 1, 0, 0, 0);
    d.setSeconds(Math.max(0, Math.floor(sec)));
    return d;
  }

 /* ---------- PUBLIC ENTRY POINT ---------- */

 /**
   * Rebuild all rows in dvi_itinerary_route_hotspot_details for a given plan.
   * This is called from ItinerariesService inside the big transaction.
 */
  async rebuildRouteHotspots(
    planId: number,
    tx: Tx,
    userId: number,
  ): Promise<void> {
 // 1) Collect plan header using Prisma query builder
    const plan = await (tx as any).dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });

    if (!plan || plan.deleted === 1) {
 this.logger.warn(`No plan header for itinerary_plan_ID=${planId}`);
      return;
    }

 // 2) Collect routes for this plan ordered by itinerary_route_date / ID
    const routes = await (tx as any).dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: [
        { itinerary_route_date: "asc" },
        { itinerary_route_ID: "asc" },
      ],
    });

    if (!routes.length) {
 this.logger.warn(`No routes for itinerary_plan_ID=${planId}`);
 // still delete any old hotspot rows if present
      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: { itinerary_plan_ID: planId },
        data: { deleted: 1, status: 0 },
      });
      return;
    }

 // 3) Clean existing rows for this plan (soft-delete like PHP)
    await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
      where: { itinerary_plan_ID: planId },
      data: { deleted: 1, status: 0 },
    });

 // 4) Rebuild hotspots for each route (PHP-like behaviour)
    let globalOrder = 0;

    for (const route of routes) {
      globalOrder = await this.rebuildTimelineForRoute(
        tx,
        plan as any,
        route as any,
        userId,
        globalOrder,
      );
    }
  }

 /* ---------- CORE ROUTE TIMELINE ---------- */

  private async rebuildTimelineForRoute(
    tx: Tx,
    plan: PlanHeader,
    route: RouteRow,
    userId: number,
    startingOrder: number,
  ): Promise<number> {
    const planId = plan.itinerary_plan_ID;
    const routeId = route.itinerary_route_ID;

 // --- DAY START / END TIME (fixed 08:0020:00) ---
    const dayStartSec = this.toSec("08:00:00");
    const routeEndSec = this.toSec("20:00:00");

 // ~1 hour refresh at day start (08:0009:00)
    const refreshSec = this.toSec("01:00:00");

    let cursorSec = dayStartSec;
    let order = startingOrder;

 // PHASE 0: Insert REFRESH ROW (item_type=1)
    order++;
    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
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
        hotspot_traveling_time: this.secToTimeDate(refreshSec),
        itinerary_travel_type_buffer_time: this.secToTimeDate(0),
        hotspot_travelling_distance: null,
        hotspot_start_time: this.secToTimeDate(cursorSec),
        hotspot_end_time: this.secToTimeDate(cursorSec + refreshSec),
        allow_break_hours: 0,
        allow_via_route: 0,
        via_location_name: null,
        hotspot_plan_own_way: 0,
        createdby: userId,
        createdon: new Date(),
        updatedon: null,
        status: 1,
        deleted: 0,
      } as any,
    });

    cursorSec += refreshSec;

 // PHASE 1: Build hotspot TRAVEL + VISIT rows (item_type=3 & 4)
    const hotspotCandidates: HotspotCandidate[] =
      await this.fetchHotspotsForRoute(tx, route);

    let lastLat: number | null = null;
    let lastLng: number | null = null;

    for (const h of hotspotCandidates) {
      const hotId = h.hotspot_ID;
      const visitDurSec =
        this.toSec(h.hotspot_duration || "01:00:00") ||
        this.toSec("01:00:00");

 // --- TRAVEL SEGMENT (item_type=3) ---
 const travelSec = this.toSec("00:30:00"); // stub until real distance calc
      const travelStart = cursorSec;
      const travelEnd = cursorSec + travelSec;

      order++;
      await (tx as any).dvi_itinerary_route_hotspot_details.create({
        data: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          item_type: 3,
          hotspot_order: order,
          hotspot_ID: hotId,
          hotspot_adult_entry_cost: 0,
          hotspot_child_entry_cost: 0,
          hotspot_infant_entry_cost: 0,
          hotspot_foreign_adult_entry_cost: 0,
          hotspot_foreign_child_entry_cost: 0,
          hotspot_foreign_infant_entry_cost: 0,
          hotspot_amout: 0,
          hotspot_traveling_time: this.secToTimeDate(travelSec),
          itinerary_travel_type_buffer_time: this.secToTimeDate(0),
          hotspot_travelling_distance: null,
          hotspot_start_time: this.secToTimeDate(travelStart),
          hotspot_end_time: this.secToTimeDate(travelEnd),
          allow_break_hours: 0,
          allow_via_route: 0,
          via_location_name: null,
          hotspot_plan_own_way: 0,
          createdby: userId,
          createdon: new Date(),
          updatedon: null,
          status: 1,
          deleted: 0,
        } as any,
      });

      cursorSec = travelEnd;

 // --- HOTSPOT VISIT SEGMENT (item_type=4) ---
      const visitStart = cursorSec;
      const visitEnd = cursorSec + visitDurSec;

      const costs = await this.computeHotspotCosts(
        tx,
        plan,
        hotId,
        plan.nationality,
      );

      const totalAmount = costs.totalAmount;

      order++;
      await (tx as any).dvi_itinerary_route_hotspot_details.create({
        data: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          item_type: 4,
          hotspot_order: order,
          hotspot_ID: hotId,
          hotspot_adult_entry_cost: costs.adultCost,
          hotspot_child_entry_cost: costs.childCost,
          hotspot_infant_entry_cost: costs.infantCost,
          hotspot_foreign_adult_entry_cost: costs.foreignAdultCost,
          hotspot_foreign_child_entry_cost: costs.foreignChildCost,
          hotspot_foreign_infant_entry_cost: costs.foreignInfantCost,
          hotspot_amout: totalAmount,
          hotspot_traveling_time: this.secToTimeDate(visitDurSec),
          itinerary_travel_type_buffer_time: this.secToTimeDate(0),
          hotspot_travelling_distance: null,
          hotspot_start_time: this.secToTimeDate(visitStart),
          hotspot_end_time: this.secToTimeDate(visitEnd),
          allow_break_hours: 0,
          allow_via_route: 0,
          via_location_name: null,
          hotspot_plan_own_way: 0,
          createdby: userId,
          createdon: new Date(),
          updatedon: null,
          status: 1,
          deleted: 0,
        } as any,
      });

      cursorSec = visitEnd;

 // remember last hotspot coord if needed later
      lastLat = h.hotspot_latitude ? Number(h.hotspot_latitude) : lastLat;
      lastLng = h.hotspot_longitude ? Number(h.hotspot_longitude) : lastLng;

 // stop if we exceed route end time
      if (cursorSec >= routeEndSec) break;
    }

 // PHASE 2: Travel to hotel (item_type=5) and end at hotel (item_type=6)
    const toHotelSec = this.toSec("00:05:00");
    const toHotelStart = cursorSec;
    const toHotelEnd = cursorSec + toHotelSec;

    order++;
    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 5,
        hotspot_order: order,
        hotspot_ID: 0,
        hotspot_adult_entry_cost: 0,
        hotspot_child_entry_cost: 0,
        hotspot_infant_entry_cost: 0,
        hotspot_foreign_adult_entry_cost: 0,
        hotspot_foreign_child_entry_cost: 0,
        hotspot_foreign_infant_entry_cost: 0,
        hotspot_amout: 0,
        hotspot_traveling_time: this.secToTimeDate(toHotelSec),
        itinerary_travel_type_buffer_time: this.secToTimeDate(0),
        hotspot_travelling_distance: null,
        hotspot_start_time: this.secToTimeDate(toHotelStart),
        hotspot_end_time: this.secToTimeDate(toHotelEnd),
        allow_break_hours: 0,
        allow_via_route: 0,
        via_location_name: null,
        hotspot_plan_own_way: 0,
        createdby: userId,
        createdon: new Date(),
        updatedon: null,
        status: 1,
        deleted: 0,
      } as any,
    });

 // End at hotel (zero duration, item_type=6)
    order++;
    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 6,
        hotspot_order: order,
        hotspot_ID: 0,
        hotspot_adult_entry_cost: 0,
        hotspot_child_entry_cost: 0,
        hotspot_infant_entry_cost: 0,
        hotspot_foreign_adult_entry_cost: 0,
        hotspot_foreign_child_entry_cost: 0,
        hotspot_foreign_infant_entry_cost: 0,
        hotspot_amout: 0,
        hotspot_traveling_time: this.secToTimeDate(0),
        itinerary_travel_type_buffer_time: this.secToTimeDate(0),
        hotspot_travelling_distance: null,
        hotspot_start_time: this.secToTimeDate(toHotelEnd),
        hotspot_end_time: this.secToTimeDate(toHotelEnd),
        allow_break_hours: 0,
        allow_via_route: 0,
        via_location_name: null,
        hotspot_plan_own_way: 0,
        createdby: userId,
        createdon: new Date(),
        updatedon: null,
        status: 1,
        deleted: 0,
      } as any,
    });

 // PHASE 3: If this is the *last* route, add RETURN row (item_type=7)
    const isLastRoute = await this.isLastRouteForPlan(tx, planId, routeId);
    if (isLastRoute) {
 const retTravelSec = this.toSec("00:36:00"); // matches your sample
      const bufSec = this.toSec("02:00:00");

      const retStart = cursorSec;
      const retEnd = cursorSec + retTravelSec;

      order++;
      await (tx as any).dvi_itinerary_route_hotspot_details.create({
        data: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          item_type: 7,
          hotspot_order: order,
          hotspot_ID: 0,
          hotspot_adult_entry_cost: 0,
          hotspot_child_entry_cost: 0,
          hotspot_infant_entry_cost: 0,
          hotspot_foreign_adult_entry_cost: 0,
          hotspot_foreign_child_entry_cost: 0,
          hotspot_foreign_infant_entry_cost: 0,
          hotspot_amout: 0,
          hotspot_traveling_time: this.secToTimeDate(retTravelSec),
          itinerary_travel_type_buffer_time: this.secToTimeDate(bufSec),
          hotspot_travelling_distance: null,
          hotspot_start_time: this.secToTimeDate(retStart),
          hotspot_end_time: this.secToTimeDate(retEnd),
          allow_break_hours: 0,
          allow_via_route: 0,
          via_location_name: null,
          hotspot_plan_own_way: 0,
          createdby: userId,
          createdon: new Date(),
          updatedon: null,
          status: 1,
          deleted: 0,
        } as any,
      });
    }

    return order;
  }

 /* ---------- AUX: fetch hotspots for route ---------- */

  private async fetchHotspotsForRoute(
    tx: Tx,
    route: RouteRow,
  ): Promise<HotspotCandidate[]> {
 // PHP side effectively uses the day's location.
 // 1. Try next_visiting_location
 // 2. If empty OR no hotspots, fall back to location_name
    let loc = route.next_visiting_location?.trim();
    if (!loc) {
      loc = route.location_name?.trim();
    }

    if (!loc) {
 this.logger.debug(
        `Route ${route.itinerary_route_ID}: no location for hotspot lookup`,
      );
      return [];
    }

    let hotspots = await (tx as any).dvi_hotspot_place.findMany({
      where: {
        hotspot_location: loc,
        status: 1,
        deleted: 0,
      },
      orderBy: { hotspot_ID: "asc" },
    });

 // If nothing found with next_visiting_location, try location_name explicitly
    if (!hotspots.length && route.location_name && route.location_name.trim()) {
      const fallbackLoc = route.location_name.trim();
      if (fallbackLoc !== loc) {
 this.logger.debug(
          `Route ${route.itinerary_route_ID}: no hotspots for "${loc}", trying fallback "${fallbackLoc}"`,
        );

        hotspots = await (tx as any).dvi_hotspot_place.findMany({
          where: {
            hotspot_location: fallbackLoc,
            status: 1,
            deleted: 0,
          },
          orderBy: { hotspot_ID: "asc" },
        });
      }
    }

 this.logger.debug(
      `Route ${route.itinerary_route_ID}: using location "${loc}" -> ${hotspots.length} hotspot(s)`,
    );

    return hotspots.map((h: any) => ({
      hotspot_ID: h.hotspot_ID,
      hotspot_name: h.hotspot_name,
      hotspot_location: h.hotspot_location,
      hotspot_latitude: h.hotspot_latitude as any,
      hotspot_longitude: h.hotspot_longitude as any,
      hotspot_duration: (h.hotspot_duration as any) ?? "01:00:00",
      previous_hotspot_location: null,
    }));
  }

 /* ---------- AUX: hotspot costs ---------- */

  private async computeHotspotCosts(
    tx: Tx,
    plan: PlanHeader,
    hotspotId: number,
    nationality: number,
  ) {
    const costRow = await (tx as any).dvi_hotspot_place.findFirst({
      where: { hotspot_ID: hotspotId, status: 1, deleted: 0 },
    });

    if (!costRow) {
      return {
        adultCost: 0,
        childCost: 0,
        infantCost: 0,
        foreignAdultCost: 0,
        foreignChildCost: 0,
        foreignInfantCost: 0,
        totalAmount: 0,
      };
    }

    const {
      hotspot_adult_entry_cost,
      hotspot_child_entry_cost,
      hotspot_infant_entry_cost,
      hotspot_foreign_adult_entry_cost,
      hotspot_foreign_child_entry_cost,
      hotspot_foreign_infant_entry_cost,
    } = costRow as any;

    const totalAdult = plan.total_adult || 0;
    const totalChild = plan.total_children || 0;
    const totalInfant = plan.total_infants || 0;

    let totalAmount = 0;
    if (nationality !== 101) {
      totalAmount =
        totalAdult * (hotspot_foreign_adult_entry_cost ?? 0) +
        totalChild * (hotspot_foreign_child_entry_cost ?? 0) +
        totalInfant * (hotspot_foreign_infant_entry_cost ?? 0);
    } else {
      totalAmount =
        totalAdult * (hotspot_adult_entry_cost ?? 0) +
        totalChild * (hotspot_child_entry_cost ?? 0) +
        totalInfant * (hotspot_infant_entry_cost ?? 0);
    }

    return {
      adultCost: hotspot_adult_entry_cost ?? 0,
      childCost: hotspot_child_entry_cost ?? 0,
      infantCost: hotspot_infant_entry_cost ?? 0,
      foreignAdultCost: hotspot_foreign_adult_entry_cost ?? 0,
      foreignChildCost: hotspot_foreign_child_entry_cost ?? 0,
      foreignInfantCost: hotspot_foreign_infant_entry_cost ?? 0,
      totalAmount,
    };
  }

 /* ---------- AUX: is last route ---------- */

  private async isLastRouteForPlan(
    tx: Tx,
    planId: number,
    routeId: number,
  ): Promise<boolean> {
    const last = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: [
        { itinerary_route_date: "desc" },
        { itinerary_route_ID: "desc" },
      ],
    });

    if (!last) return false;
    return last.itinerary_route_ID === routeId;
  }
}
