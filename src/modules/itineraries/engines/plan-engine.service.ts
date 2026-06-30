// REPLACE-WHOLE-FILE
// FILE: src/itineraries/engines/plan-engine.service.ts
//
// Single source of truth for dvi_itinerary_plan_details header row.

import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  CreatePlanDto,
  CreateTravellerDto,
} from "../dto/create-itinerary.dto";
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealFlags,
} from "../../hotels/hotel-rate-plans";

type Tx = Prisma.TransactionClient;

@Injectable()
export class PlanEngineService {
  /* ------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------ */

  /**
   * Parse an IST datetime string coming from the UI and convert it to a JS Date
   * such that MySQL finally stores the SAME wall-clock time.
   *
   * Example:
   *   UI sends        : "2025-12-10T11:00:00+05:30"
   *   new Date(value) : 2025-12-10T05:30:00.000Z
   *   We ADD +05:30   : 2025-12-10T11:00:00.000Z
   *   Prisma -> MySQL : '2025-12-10 11:00:00'
   *
   * So phpMyAdmin shows 11:00 — PHP parity.
   */
  private parseDate(value: string | undefined | null): Date {
    if (!value) return new Date();

    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return new Date();

    // Try to detect an explicit timezone offset at the end, like +05:30 or -04:00
    const m = value.match(/([+-])(\d{2}):?(\d{2})$/);
    if (m) {
      const sign = m[1] === "-" ? -1 : 1;
      const hours = parseInt(m[2], 10);
      const minutes = parseInt(m[3], 10);
      const offsetMs = sign * (hours * 60 + minutes) * 60 * 1000;

      // Shift by the offset so that stored UTC time == local IST wall time.
      return new Date(d.getTime() + offsetMs);
    }

    // If no offset present, just use as-is.
    return d;
  }

  /** preferred_room_count = max room_id (min 1) */
  private getPreferredRoomCount(travellers: CreateTravellerDto[]): number {
    let maxRoom = 0;
    for (const t of travellers || []) {
      if (t && typeof t.room_id === "number") {
        if (t.room_id > maxRoom) maxRoom = t.room_id;
      }
    }
    return maxRoom || 1;
  }

  /**
   * PHP parity:
   * - child_bed_type: 1 => without bed, 2 => with bed
   * - total_extra_bed: +1 per room where adult count is greater than 2
   */
  private getBedAndChildTotals(travellers: CreateTravellerDto[]): {
    totalExtraBed: number;
    totalChildWithBed: number;
    totalChildWithoutBed: number;
  } {
    let totalChildWithBed = 0;
    let totalChildWithoutBed = 0;
    const adultsByRoom = new Map<number, number>();

    for (const t of travellers || []) {
      if (!t) continue;

      if (Number(t.traveller_type) === 1) {
        const roomId = Number(t.room_id || 0);
        if (roomId > 0) {
          adultsByRoom.set(roomId, (adultsByRoom.get(roomId) || 0) + 1);
        }
        continue;
      }

      if (Number(t.traveller_type) === 2) {
        const bedType = Number(t.child_bed_type ?? 0);
        if (bedType === 2) totalChildWithBed += 1;
        if (bedType === 1) totalChildWithoutBed += 1;
      }
    }

    let totalExtraBed = 0;
    for (const adultCount of adultsByRoom.values()) {
      if (adultCount > 2) {
        totalExtraBed += 1;
      }
    }

    return {
      totalExtraBed,
      totalChildWithBed,
      totalChildWithoutBed,
    };
  }

    private isChildAgeFiveOrAbove(age: string | undefined | null): boolean {
    const rawAge = String(age ?? "").trim();

    if (!rawAge) {
      return true;
    }

    const numericAge = Number(rawAge);
    return Number.isFinite(numericAge) && numericAge >= 5;
  }

  private assertChildExtraBedOccupancyRule(
    travellers: CreateTravellerDto[],
  ): void {
    const childrenByRoom = new Map<number, CreateTravellerDto[]>();

    for (const traveller of travellers || []) {
      if (Number(traveller?.traveller_type) !== 2) {
        continue;
      }

      if (!this.isChildAgeFiveOrAbove(traveller.traveller_age)) {
        continue;
      }

      const roomId = Number(traveller.room_id || 0);
      if (roomId <= 0) {
        continue;
      }

      const roomChildren = childrenByRoom.get(roomId) || [];
      roomChildren.push(traveller);
      childrenByRoom.set(roomId, roomChildren);
    }

    for (const [roomId, roomChildren] of childrenByRoom.entries()) {
      if (roomChildren.length < 2) {
        continue;
      }

      const unresolvedChild = roomChildren.slice(1).find((child) => {
        const hasExtraBed = Number(child.child_bed_type ?? 0) === 2;
        const hasHotelApproval =
          Number(
            (child as any).child_extra_bed_hotel_approval_required ?? 0,
          ) === 1;

        return !hasExtraBed && !hasHotelApproval;
      });

      if (unresolvedChild) {
        throw new BadRequestException(
          `Occupancy alert: Room ${roomId} has two children aged 5 or above. Add one extra bed, add another room, or proceed without extra bed subject to hotel approval.`,
        );
      }
    }
  }

  private normalizeStringList(list: string[] | undefined | null): string {
    if (!list || !Array.isArray(list)) return "";
    return list
      .map((x) => String(x ?? "").trim())
      .filter((x) => x.length > 0)
      .join(",");
  }

  private normalizeNumberList(list: number[] | undefined | null): string {
    if (!list || !Array.isArray(list)) return "";
    return list
      .map((x) => (Number.isFinite(x as any) ? Number(x) : null))
      .filter((x) => x !== null)
      .join(",");
  }

  /**
   * Resolve location_id from arrival + departure locations (PHP parity).
   */
  private async resolveLocationId(
    tx: Tx,
    arrivalLocation: string,
    departureLocation: string,
  ): Promise<number> {
    const a = (arrivalLocation || "").trim();
    const d = (departureLocation || "").trim();

    if (!a || !d) {
      return 0;
    }

    // Primary: exact source + destination match
    const row = await (tx as any).dvi_stored_locations.findFirst({
      where: {
        source_location: a,
        destination_location: d,
        deleted: 0,
        status: 1,
      },
      select: {
        location_ID: true,
      },
    });

    if (row) {
      return Number((row as any).location_ID ?? 0);
    }

    // Fallback: try any row with this arrival as source OR this departure as destination
    const fallback = await (tx as any).dvi_stored_locations.findFirst({
      where: {
        OR: [{ source_location: a }, { destination_location: d }],
        deleted: 0,
        status: 1,
      },
      select: {
        location_ID: true,
      },
    });

    if (fallback) {
      return Number((fallback as any).location_ID ?? 0);
    }

    return 0;
  }

  /**
   * PHP-parity quote ID generator.
   */
  private async buildQuoteId(
    tx: Tx,
    now: Date,
    excludePlanId?: number,
  ): Promise<string> {
    const year = now.getFullYear();
    const monthIndex = now.getMonth(); // 0–11
    const mm = String(monthIndex + 1).padStart(2, "0"); // PHP date('m')

    const prefix = `DVI${year}${mm}`; // "DVIyyyymm"

    const monthStart = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0);

    const last = await (tx as any).dvi_itinerary_plan_details.findFirst({
      where: {
        itinerary_quote_ID: {
          not: "",
        },
        createdon: {
          gte: monthStart,
          lt: monthEnd,
        },
      },
      orderBy: {
        itinerary_plan_ID: "desc",
      },
      select: {
        itinerary_quote_ID: true,
      },
    });

    if (!last || !last.itinerary_quote_ID) {
      return `${prefix}1`;
    }

    const lastId: string = last.itinerary_quote_ID;
    let nextSequence = 1;

    if (lastId.startsWith(prefix)) {
      const numericPart = lastId.slice(prefix.length);
      const n = parseInt(numericPart, 10);
      if (!Number.isNaN(n) && n >= 1) {
        nextSequence = n + 1;
      }
    }

    return `${prefix}${nextSequence}`;
  }

  private async buildSafeQuoteId(
    tx: Tx,
    now: Date,
    excludePlanId?: number,
  ): Promise<string> {
    const year = now.getFullYear();
    const monthIndex = now.getMonth();
    const mm = String(monthIndex + 1).padStart(2, '0');
    const prefix = `DVI${year}${mm}`;
    const lockName = `dvi_itinerary_quote_${prefix}`;

    const lockRows = await (tx as any).$queryRawUnsafe(
      'SELECT GET_LOCK(?, 10) AS acquired',
      lockName,
    );
    const acquired = Number((lockRows as any)?.[0]?.acquired ?? 0);
    if (acquired !== 1) {
      throw new Error(`Unable to acquire itinerary quote lock for prefix ${prefix}`);
    }

    try {
      const activeRows = await (tx as any).dvi_itinerary_plan_details.findMany({
        where: {
          deleted: 0,
          itinerary_quote_ID: {
            startsWith: prefix,
          },
        },
        select: {
          itinerary_quote_ID: true,
        },
      });

      let maxSequence = 0;
      for (const row of activeRows as any[]) {
        const quoteId = String(row?.itinerary_quote_ID || '').trim();
        const numericPart = quoteId.startsWith(prefix)
          ? quoteId.slice(prefix.length)
          : '';
        if (!/^\d+$/.test(numericPart)) continue;
        const sequence = Number.parseInt(numericPart, 10);
        if (Number.isFinite(sequence) && sequence > maxSequence) {
          maxSequence = sequence;
        }
      }

      let nextSequence = maxSequence + 1;
      while (true) {
        const candidate = `${prefix}${nextSequence}`;
        const existing = await (tx as any).dvi_itinerary_plan_details.findFirst({
          where: {
            itinerary_quote_ID: candidate,
            deleted: 0,
            ...(excludePlanId && excludePlanId > 0
              ? { itinerary_plan_ID: { not: excludePlanId } }
              : {}),
          },
          select: {
            itinerary_plan_ID: true,
          },
        });

        if (!existing) {
          return candidate;
        }
        nextSequence += 1;
      }
    } finally {
      await (tx as any).$queryRawUnsafe(
        'SELECT RELEASE_LOCK(?) AS released',
        lockName,
      );
    }
  }

  private async getActiveQuoteOwners(
    tx: Tx,
    quoteId: string,
  ): Promise<Array<{ itinerary_plan_ID: number; createdon: Date | null }>> {
    const normalizedQuoteId = String(quoteId || '').trim();
    if (!normalizedQuoteId) return [];

    const rows = await (tx as any).dvi_itinerary_plan_details.findMany({
      where: {
        itinerary_quote_ID: normalizedQuoteId,
        deleted: 0,
      },
      select: {
        itinerary_plan_ID: true,
        createdon: true,
      },
      orderBy: [
        { createdon: 'asc' },
        { itinerary_plan_ID: 'asc' },
      ],
    });

    return (rows as any[]).map((row) => ({
      itinerary_plan_ID: Number(row?.itinerary_plan_ID || 0),
      createdon: row?.createdon ?? null,
    }));
  }

  /* ------------------------------------------------------------------
   * Public API – used from ItinerariesService
   * ------------------------------------------------------------------ */

  async upsertPlanHeader(
    plan: CreatePlanDto,
    travellers: CreateTravellerDto[],
    tx: Tx,
    userId: number,
  ): Promise<number> {
    const now = new Date();

    // 🔵 Incoming from UI (ISO with +05:30)
    const tripStart = this.parseDate(plan.trip_start_date);
    const tripEnd = this.parseDate(plan.trip_end_date);
    const pickup = this.parseDate(plan.pick_up_date_and_time);

        const totalAdult = Number(plan.adult_count ?? 0);
    const totalChildren = Number(plan.child_count ?? 0);
    const totalInfants = Number(plan.infant_count ?? 0);

    this.assertChildExtraBedOccupancyRule(travellers || []);

    const {
      totalExtraBed,
      totalChildWithBed,
      totalChildWithoutBed,
    } = this.getBedAndChildTotals(travellers || []);

    const preferredRoomCount = this.getPreferredRoomCount(travellers || []);

    const meal_plan_breakfast = Number((plan as any).meal_plan_breakfast ?? 0) ? 1 : 0;
    const meal_plan_lunch = Number((plan as any).meal_plan_lunch ?? 0) ? 1 : 0;
    const meal_plan_dinner = Number((plan as any).meal_plan_dinner ?? 0) ? 1 : 0;
    const explicitMealPlanCode = inferCanonicalHotelRatePlanCode((plan as any).meal_plan_code);
    const hasExplicitMealFlags = meal_plan_breakfast === 1 || meal_plan_lunch === 1 || meal_plan_dinner === 1;
    const meal_plan_code = explicitMealPlanCode
      || (hasExplicitMealFlags
        ? inferCanonicalHotelRatePlanCodeFromMealFlags(
            meal_plan_breakfast,
            meal_plan_lunch,
            meal_plan_dinner,
          )
        : null);

    const preferred_hotel_category = this.normalizeNumberList(
      (plan as any).preferred_hotel_category,
    );
    const hotel_facilities = this.normalizeStringList(
      (plan as any).hotel_facilities,
    );

    const hotel_rates_visibility = 0;
    const quotation_status = 0;
    const agent_margin = 10;

    const locationId = await this.resolveLocationId(
      tx,
      plan.arrival_point ?? "",
      plan.departure_point ?? "",
    );

    const baseData: any = {
      // Identity / foreign keys
      agent_id: Number(plan.agent_id ?? 0),
      staff_id: Number(plan.staff_id ?? 0),

      // Location & summary
      location_id: locationId,
      arrival_location: plan.arrival_point ?? "",
      departure_location: plan.departure_point ?? "",

      // Trip times (JS Date → Prisma → MySQL DATETIME)
      trip_start_date_and_time: tripStart,
      trip_end_date_and_time: tripEnd,
      pick_up_date_and_time: pickup,

      // Types and flags
      arrival_type: Number(plan.arrival_type ?? 0),
      departure_type: Number(plan.departure_type ?? 0),
      expecting_budget: Number((plan as any).budget ?? 0),
      itinerary_type: Number(plan.itinerary_type ?? 0),
      entry_ticket_required: Number(plan.entry_ticket_required ?? 0),
      itinerary_preference: Number(plan.itinerary_preference ?? 0),

      // Nights / days
      no_of_nights: Number(plan.no_of_nights ?? 0),
      no_of_days: Number(plan.no_of_days ?? 0),

      // Totals
      total_adult: totalAdult,
      total_children: totalChildren,
      total_infants: totalInfants,
      nationality: Number((plan as any).nationality ?? 0),

      // Meal plan flags
      meal_plan_code,
      meal_plan_breakfast,
      meal_plan_lunch,
      meal_plan_dinner,

      // Room / bed totals
      preferred_room_count: preferredRoomCount,
      total_extra_bed: totalExtraBed,
      total_child_with_bed: totalChildWithBed,
      total_child_without_bed: totalChildWithoutBed,

      // Guide / food
      guide_for_itinerary: Number(plan.guide_for_itinerary ?? 0),
      food_type: Number((plan as any).food_type ?? 0),

      // Misc
      special_instructions: plan.special_instructions ?? "",

      // Hotel extra fields
      hotel_rates_visibility,
      quotation_status,
      agent_margin,
      preferred_hotel_category,
      hotel_facilities,

      // Always active rows in this engine
      status: 1,
      deleted: 0,
    };

    const existingId = Number(plan.itinerary_plan_id ?? 0);

    if (existingId > 0) {
      const existingPlan = await (tx as any).dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: existingId },
        select: {
          itinerary_quote_ID: true,
        },
      });
      if (!existingPlan) {
        throw new Error(`Itinerary plan ${existingId} not found for update`);
      }

      const currentQuoteId = String(existingPlan?.itinerary_quote_ID || '').trim();
      let safeQuoteId = currentQuoteId;
      if (!safeQuoteId) {
        safeQuoteId = await this.buildSafeQuoteId(tx, now, existingId);
      } else {
        const owners = await this.getActiveQuoteOwners(tx, safeQuoteId);
        if (owners.length > 1) {
          const canonicalOwnerId = Number(owners[0]?.itinerary_plan_ID || 0);
          const shouldKeepCurrentQuote = canonicalOwnerId === existingId;
          if (!shouldKeepCurrentQuote) {
            safeQuoteId = await this.buildSafeQuoteId(tx, now, existingId);
          }
          console.warn('[ITINERARY_QUOTE_DUPLICATE_GUARD]', {
            existingId,
            currentQuoteId,
            keptCurrentQuote: shouldKeepCurrentQuote,
            reassignedQuoteId: shouldKeepCurrentQuote ? null : safeQuoteId,
            ownerPlanIds: owners.map((owner) => Number(owner.itinerary_plan_ID || 0)),
          });
        }
      }

      await (tx as any).dvi_itinerary_plan_details.update({
        where: { itinerary_plan_ID: existingId },
        data: {
          ...baseData,
          itinerary_quote_ID: safeQuoteId,
          updatedon: now,
        },
      });

      return existingId;
    }

    const itinerary_quote_ID = await this.buildSafeQuoteId(tx, now);

    const createdRow = await (tx as any).dvi_itinerary_plan_details.create({
      data: {
        ...baseData,
        itinerary_quote_ID,
        no_of_routes: 1,
        createdby: userId,
        createdon: now,
        updatedon: now,
      },
      select: {
        itinerary_plan_ID: true,
      },
    });

    return Number(createdRow.itinerary_plan_ID);
  }

  /**
   * After routes are rebuilt, sync no_of_routes to actual count.
   */
  async updateNoOfRoutes(planId: number, tx: Tx): Promise<void> {
    const count = await (tx as any).dvi_itinerary_route_details.count({
      where: { itinerary_plan_ID: planId },
    });

    await (tx as any).dvi_itinerary_plan_details.update({
      where: { itinerary_plan_ID: planId },
      data: { no_of_routes: count },
    });
  }
}
