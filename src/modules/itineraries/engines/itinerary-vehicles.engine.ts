// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/itinerary-vehicles.engine.ts

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";
import {
  VehicleCalculationContext,
  RouteData,
  calculateRouteVehicleDetails,
  getVehicleLocationDetails,
  getLocationIdFromSourceDest,
  getStoredLocationCity,
  getEffectiveTimeLimitKm,
} from "./vehicle-calculation.helpers";
import { timeStringToPrismaTime } from "../utils/itinerary.utils";

function toNum(v: any) {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function monthName(d: Date) {
  return d.toLocaleString("en-US", { month: "long" }); // PHP date('F')
}

function safeDate(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function hhmmFromMs(ms: number) {
  const total = Math.max(0, ms);
  const hh = Math.floor(total / 3600000);
  const mm = Math.floor((total % 3600000) / 60000);
  return `${hh}.${String(mm).padStart(2, "0")}`; // PHP-like "H.i"
}

function normalizeCityToken(value: string): string {
  const base = String(value || '').toLowerCase().trim();
  if (!base) return '';
  const firstPart = base.split(',')[0] || base;
  const normalized = firstPart
    .replace(/\b(international|domestic|airport|railway|station|bus|stand|hotel|lodge|temple|mall|palace|park|garden|museum|planetarium|aquarium)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cityAliases: Record<string, string> = {
    bengaluru: "bangalore",
    bangaluru: "bangalore",
    bengalore: "bangalore",
  };

  return cityAliases[normalized] || normalized;
}

// ---------------------------------------------------------------------------
// PHP SUM(CASE WHEN total_vehicle_qty=0 THEN 1 ELSE total_vehicle_qty END)
// = SUM(total_vehicle_qty) + COUNT(total_vehicle_qty=0)
// ---------------------------------------------------------------------------
async function getPhpTotalVehicleQty(tx: any, whereBase: any): Promise<number> {
  const runOnce = async () => {
    // Use sequential calls on the same tx client for connection stability.
    const sumAgg = await tx.dvi_itinerary_plan_vendor_eligible_list.aggregate({
      where: whereBase,
      _sum: { total_vehicle_qty: true },
    });

    const zeroCount = await tx.dvi_itinerary_plan_vendor_eligible_list.count({
      where: { ...whereBase, total_vehicle_qty: 0 },
    });

    return { sumAgg, zeroCount };
  };

  let sumAgg: any;
  let zeroCount: number;

  try {
    const result = await runOnce();
    sumAgg = result.sumAgg;
    zeroCount = result.zeroCount;
  } catch (err: any) {
    const code = String(err?.code || "");
    const message = String(err?.message || "").toLowerCase();
    const isTransientDisconnect =
      code === "P1017" ||
      message.includes("server has closed the connection") ||
      message.includes("connection") && message.includes("closed");

    if (!isTransientDisconnect) {
      throw err;
    }

    const retry = await runOnce();
    sumAgg = retry.sumAgg;
    zeroCount = retry.zeroCount;
  }

  const sumVal = Number(sumAgg?._sum?.total_vehicle_qty ?? 0);
  return sumVal + Number(zeroCount ?? 0);
}

@Injectable()
export class ItineraryVehiclesEngine {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // LOGGING
  // ---------------------------------------------------------------------------
  private writeLog(_line: string) {}

  private escapeString(value: string): string {
    return value.replace(/'/g, "''");
  }

  private sqlLiteral(value: any): string {
    if (value === null || value === undefined) return "NULL";
    if (value instanceof Date) {
      const iso = value.toISOString().slice(0, 19).replace("T", " ");
      return `'${iso}'`;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "NULL";
      return String(value);
    }
    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }
    return `'${this.escapeString(String(value))}'`;
  }

  private sqlList(values: any[]): string {
    if (!values || !values.length) return "(NULL)";
    return "(" + values.map((v) => this.sqlLiteral(v)).join(", ") + ")";
  }

  // build WHERE clause from Prisma-like where object
  private buildWhereClause(where: any): string {
    if (!where || Object.keys(where).length === 0) return "1=1";

    const build = (obj: any): string => {
      if (!obj || typeof obj !== "object") return "1=1";

      const parts: string[] = [];

      for (const key of Object.keys(obj)) {
        if (key === "AND" && Array.isArray(obj[key])) {
          const inner = obj[key].map((w: any) => `(${build(w)})`).join(" AND ");
          if (inner) parts.push(inner);
          continue;
        }
        if (key === "OR" && Array.isArray(obj[key])) {
          const inner = obj[key].map((w: any) => `(${build(w)})`).join(" OR ");
          if (inner) parts.push(inner);
          continue;
        }
        if (key === "NOT" && Array.isArray(obj[key])) {
          const inner = obj[key].map((w: any) => `NOT (${build(w)})`).join(" AND ");
          if (inner) parts.push(inner);
          continue;
        }

        const value = obj[key];

        if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
          if (value.in) {
            parts.push(`\`${key}\` IN ${this.sqlList(value.in)}`);
          } else if (value.notIn) {
            parts.push(`\`${key}\` NOT IN ${this.sqlList(value.notIn)}`);
          } else if (value.contains !== undefined) {
            parts.push(`\`${key}\` LIKE ${this.sqlLiteral(`%${value.contains}%`)}`);
          } else if (value.gte !== undefined) {
            parts.push(`\`${key}\` >= ${this.sqlLiteral(value.gte)}`);
          } else if (value.gt !== undefined) {
            parts.push(`\`${key}\` > ${this.sqlLiteral(value.gt)}`);
          } else if (value.lte !== undefined) {
            parts.push(`\`${key}\` <= ${this.sqlLiteral(value.lte)}`);
          } else if (value.lt !== undefined) {
            parts.push(`\`${key}\` < ${this.sqlLiteral(value.lt)}`);
          } else if (value.equals !== undefined) {
            parts.push(`\`${key}\` = ${this.sqlLiteral(value.equals)}`);
          } else {
            parts.push(`/* ${key} = ${JSON.stringify(value)} */ 1=1`);
          }
        } else {
          parts.push(`\`${key}\` = ${this.sqlLiteral(value)}`);
        }
      }

      if (!parts.length) return "1=1";
      return parts.join(" AND ");
    };

    return build(where);
  }

  private buildSelectSql(table: string, where: any, extra?: string): string {
    const whereClause = this.buildWhereClause(where);
    const tail = extra ? ` ${extra.trim()}` : "";
    return `SELECT * FROM \`${table}\` WHERE ${whereClause}${tail};`;
  }

  private buildDeleteSql(table: string, where: any): string {
    const whereClause = this.buildWhereClause(where);
    return `DELETE FROM \`${table}\` WHERE ${whereClause};`;
  }

  private buildUpdateSql(table: string, data: any, where: any): string {
    const setParts: string[] = [];
    for (const key of Object.keys(data || {})) {
      if (data[key] === undefined) continue;
      setParts.push(`\`${key}\` = ${this.sqlLiteral(data[key])}`);
    }
    const setClause = setParts.length ? setParts.join(", ") : "/* no fields */ 1=1";
    const whereClause = this.buildWhereClause(where);
    return `UPDATE \`${table}\` SET ${setClause} WHERE ${whereClause};`;
  }

  private buildInsertSql(table: string, data: any): string {
    const keys = Object.keys(data || {});
    if (!keys.length) return `/* EMPTY INSERT for ${table} */`;
    const cols = keys.map((k) => `\`${k}\``).join(", ");
    const vals = keys.map((k) => this.sqlLiteral(data[k])).join(", ");
    return `INSERT INTO \`${table}\` (${cols}) VALUES (${vals});`;
  }

  private logSql(_label: string, _sql: string, _meta?: any) {}

  private log(_label: string, _payload: any) {}

  // ---------------------------------------------------------------------------
  // ROUTE KM SUMMARY (PHP-style helper; uses route.no_of_km ONLY)
  // ---------------------------------------------------------------------------
  private async buildRouteKmMap(
    tx: any,
    planId: number,
    routes: { itinerary_route_ID: number; no_of_km: string | null }[],
  ): Promise<Map<number, number>> {
    const routeKmMap = new Map<number, number>();

    for (const r of routes) {
      const routeId = Number(r.itinerary_route_ID ?? 0);
      if (!routeId) continue;
      const km = toNum(r.no_of_km);
      if (km > 0) {
        routeKmMap.set(routeId, km);
      }
    }

    return routeKmMap;
  }

  /**
   * Rebuilds:
   *   1) dvi_itinerary_plan_vendor_eligible_list
   *   2) dvi_itinerary_plan_vendor_vehicle_details
   *
   * Behaviour aligned with PHP `add_vehicle_plan`:
   * - Build vendor eligibles
   * - Mark cheapest per vehicle type as assigned
   * - Build vendor_vehicle_details for ALL eligibles (not just assigned)
   */
  async rebuildEligibleVendorList(args: {
    planId: number;
    createdBy: number;
    selectedTimeLimitByEligible?: Record<string, number>;
  }) {
    const planId = Number(args.planId);
    const createdBy = Number(args.createdBy ?? 0);
    const selectedTimeLimitByEligible = args.selectedTimeLimitByEligible ?? {};

    if (!Number.isFinite(planId) || planId <= 0) {
      return { planId, inserted: 0, reason: "Invalid planId" };
    }

    // use plain client (no $transaction) for now
    const tx: any = this.prisma;
    const tAny: any = this.prisma as any;

    const today = startOfDay(new Date());

    // ---------------------------------------------------------------------
    // 0) Plan
    // ---------------------------------------------------------------------
    const planWhere = { itinerary_plan_ID: planId };
    this.logSql(
      "PLAN_FIND_UNIQUE",
      this.buildSelectSql("dvi_itinerary_plan_details", planWhere, "LIMIT 1"),
      { where: planWhere },
    );

    const plan = await tx.dvi_itinerary_plan_details.findUnique({
      where: planWhere,
      select: {
        itinerary_plan_ID: true,
        itinerary_type: true,
        pick_up_date_and_time: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
        no_of_days: true,
      },
    });

    if (!plan) return { planId, inserted: 0, reason: "Plan not found" };

    // ---------------------------------------------------------------------
    // 1) Routes summary
    // ---------------------------------------------------------------------
    const routesWhere = { itinerary_plan_ID: planId, status: 1, deleted: 0 };
    this.logSql(
      "ROUTES_FIND_MANY",
      this.buildSelectSql(
        "dvi_itinerary_route_details",
        routesWhere,
        "ORDER BY `itinerary_route_ID` ASC",
      ),
      { where: routesWhere },
    );

    const routes = await tx.dvi_itinerary_route_details.findMany({
      where: routesWhere,
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        no_of_km: true,
        location_name: true,
        next_visiting_location: true,
        route_start_time: true,
        route_end_time: true,
      },
      orderBy: { itinerary_route_ID: "asc" },
    });

    const locationTokens = Array.from(
      new Set(
        routes
          .flatMap((r: any) => [
            String((r as any).location_name ?? "").trim(),
            String((r as any).next_visiting_location ?? "").trim(),
          ])
          .filter((v: string) => v.length > 0),
      ),
    );

    const firstRoute = routes.length ? routes[0] : null;
    const lastRoute = routes.length ? routes[routes.length - 1] : null;
    const overallStartCityRaw = firstRoute
      ? (await getStoredLocationCity(tx, String(firstRoute.location_name || ""))) ||
        String(firstRoute.location_name || "")
      : "";
    const overallEndCityRaw = lastRoute
      ? (await getStoredLocationCity(tx, String(lastRoute.next_visiting_location || ""))) ||
        String(lastRoute.next_visiting_location || "")
      : "";
    const overallStartCityToken = normalizeCityToken(overallStartCityRaw);
    const overallEndCityToken = normalizeCityToken(overallEndCityRaw);

    // ---------------------------------------------------------------------
    // 1.1) Build eligible cities from dvi_stored_locations (PHP UNION parity)
    // ---------------------------------------------------------------------
    let eligibleCities: string[] = [];
    if (locationTokens.length) {
      // 1️⃣ source_location side
      const storedSrcWhere = {
        deleted: 0,
        status: 1,
        source_location: { in: locationTokens },
      };
      this.logSql(
        "STORED_LOCATIONS_SRC_FIND_MANY",
        this.buildSelectSql(
          "dvi_stored_locations",
          storedSrcWhere,
        ),
        { where: storedSrcWhere },
      );

      const storedSrcRows = await tx.dvi_stored_locations.findMany({
        where: storedSrcWhere,
        select: {
          source_location_city: true,
        },
      });

      // 2️⃣ destination_location side
      const storedDestWhere = {
        deleted: 0,
        status: 1,
        destination_location: { in: locationTokens },
      };
      this.logSql(
        "STORED_LOCATIONS_DEST_FIND_MANY",
        this.buildSelectSql(
          "dvi_stored_locations",
          storedDestWhere,
        ),
        { where: storedDestWhere },
      );

      const storedDestRows = await tx.dvi_stored_locations.findMany({
        where: storedDestWhere,
        select: {
          destination_location_city: true,
        },
      });

      const citySet = new Set<string>();

      for (const row of storedSrcRows) {
        const s = String(row.source_location_city ?? "").trim();
        if (s) citySet.add(s);
      }

      for (const row of storedDestRows) {
        const d = String(row.destination_location_city ?? "").trim();
        if (d) citySet.add(d);
      }

      eligibleCities = Array.from(citySet);
    }

    // PHP: total km is sum of route.no_of_km ONLY
    const totalKmsNum = routes.reduce(
      (sum: number, r: { no_of_km: string | null }) => sum + toNum(r.no_of_km),
      0,
    );

    const totalOutstationKmNum = totalKmsNum;

    const tripStart = safeDate(plan.trip_start_date_and_time);
    const tripEnd = safeDate(plan.trip_end_date_and_time);
    const totalTimeStr =
      tripStart && tripEnd ? hhmmFromMs(tripEnd.getTime() - tripStart.getTime()) : "0.00";

    const routeDateBase =
      safeDate(plan.pick_up_date_and_time) ||
      safeDate(routes?.[0]?.itinerary_route_date) ||
      tripStart ||
      new Date();

    const yearStr = String(routeDateBase.getFullYear());
    const monthStr = monthName(routeDateBase);
    const dayOfMonth = Math.max(1, Math.min(31, routeDateBase.getDate()));
    const noOfDays = Math.max(1, Number(plan.no_of_days ?? 1) || 1);

    const totalNoOfPlanRouteDetails = Math.max(0, routes.length);

    // ---------------------------------------------------------------------
    // 2) Required vehicle entries from plan
    // ---------------------------------------------------------------------
    const reqWhere = { itinerary_plan_id: planId, status: 1, deleted: 0 };
    this.logSql(
      "PLAN_VEHICLE_DETAILS_FIND_MANY",
      this.buildSelectSql("dvi_itinerary_plan_vehicle_details", reqWhere),
      { where: reqWhere },
    );

    const reqRows = await tx.dvi_itinerary_plan_vehicle_details.findMany({
      where: reqWhere,
      select: { vehicle_type_id: true, vehicle_count: true },
    });

    if (!reqRows.length) {
      return { planId, inserted: 0, reason: "No vehicle requirements in plan" };
    }

    const requiredCountByType = new Map<number, number>();
    for (const r of reqRows) {
      const vt = Number(r.vehicle_type_id ?? 0);
      const c = Math.max(0, Number(r.vehicle_count ?? 0));
      if (vt > 0 && c > 0) requiredCountByType.set(vt, (requiredCountByType.get(vt) ?? 0) + c);
    }

    const requiredVehicleTypeIds = Array.from(requiredCountByType.keys());
    if (!requiredVehicleTypeIds.length) {
      return { planId, inserted: 0, reason: "No positive vehicle counts" };
    }

    // ---------------------------------------------------------------------
    // 3) Clear existing vendor data for this plan
    // ---------------------------------------------------------------------
    const delEligibleWhere = { itinerary_plan_id: planId };
    this.logSql(
      "ELIGIBLE_DELETE_MANY",
      this.buildDeleteSql("dvi_itinerary_plan_vendor_eligible_list", delEligibleWhere),
      { where: delEligibleWhere },
    );
    const delEligibleRes =
      await tx.dvi_itinerary_plan_vendor_eligible_list.deleteMany({
        where: delEligibleWhere,
      });

    if (tAny?.dvi_itinerary_plan_vendor_vehicle_details) {
      const delDetailsWhere: any = { itinerary_plan_id: planId };
      this.logSql(
        "VENDOR_VEHICLE_DETAILS_DELETE_MANY",
        this.buildDeleteSql("dvi_itinerary_plan_vendor_vehicle_details", delDetailsWhere),
        { where: delDetailsWhere },
      );
      const delDetailsRes =
        await tAny.dvi_itinerary_plan_vendor_vehicle_details.deleteMany({
          where: delDetailsWhere,
        });
    }

    const kmsLimitCache = new Map<string, { kmsLimitId: number; allowedKmPerDayNum: number }>();
    const priceBookCache = new Map<string, number>();
    const existingQtyCache = new Map<string, number>();
    const eligibleCityTokens = new Set<string>(
      eligibleCities
        .map((c) => normalizeCityToken(c))
        .filter((c) => c.length > 0),
    );
    const strictOperationalCityTokens = new Set<string>();
    if (
      overallStartCityToken.length > 0 &&
      overallStartCityToken === overallEndCityToken
    ) {
      strictOperationalCityTokens.add(overallStartCityToken);
    }
    const cityTokensForBranchFiltering = strictOperationalCityTokens.size
      ? strictOperationalCityTokens
      : eligibleCityTokens;

    const vendorIdsUsed = new Set<number>();
    let inserted = 0;

    // ---------------------------------------------------------------------
    // MAIN ELIGIBLE-LIST BUILD (PHP-style vendor loop)
    // ---------------------------------------------------------------------
    for (const [planVehicleTypeId, requiredCount] of requiredCountByType.entries()) {
      if (!planVehicleTypeId || requiredCount <= 0) continue;

      let mappingsWhere: any = { vehicle_type_id: planVehicleTypeId, status: 1 };
      this.logSql(
        "VENDOR_VEHICLE_TYPES_FIND_MANY_1",
        this.buildSelectSql("dvi_vendor_vehicle_types", mappingsWhere),
        { where: mappingsWhere },
      );

      let mappings = await tx.dvi_vendor_vehicle_types.findMany({
        where: mappingsWhere,
        select: {
          vendor_vehicle_type_ID: true,
          vendor_id: true,
          vehicle_type_id: true,
        },
      });

      if (!mappings.length) {
        mappingsWhere = { vendor_vehicle_type_ID: planVehicleTypeId, status: 1 };
        this.logSql(
          "VENDOR_VEHICLE_TYPES_FIND_MANY_2",
          this.buildSelectSql("dvi_vendor_vehicle_types", mappingsWhere),
          { where: mappingsWhere },
        );

        mappings = await tx.dvi_vendor_vehicle_types.findMany({
          where: mappingsWhere,
          select: {
            vendor_vehicle_type_ID: true,
            vendor_id: true,
            vehicle_type_id: true,
          },
        });
      }

      if (!mappings.length) continue;

      type VendorBranchRow = {
        vendor_branch_id: number;
        vendor_branch_name: string | null;
        vendor_branch_location: string | null;
        vendor_branch_gst_type: number | null;
        vendor_branch_gst: number | null;
      };

      const vendorBranchCache = new Map<
        number,
        {
          branches: VendorBranchRow[];
          strictBranchIds: number[];
        }
      >();
      let hasAnyStrictBranchForType = false;

      const uniqueVendorIds: number[] = Array.from(
        new Set<number>(
          mappings
            .map((m) => Number(m.vendor_id ?? 0))
            .filter((id) => id > 0),
        ),
      );

      for (const vendorId of uniqueVendorIds) {
        const branchWhere = {
          vendor_id: vendorId,
          status: 1,
          deleted: 0,
        };
        this.logSql(
          "VENDOR_BRANCHES_FIND_MANY_NO_FILTER",
          this.buildSelectSql("dvi_vendor_branches", branchWhere),
          { where: branchWhere },
        );

        const branches: VendorBranchRow[] = await tx.dvi_vendor_branches.findMany({
          where: branchWhere,
          select: {
            vendor_branch_id: true,
            vendor_branch_name: true,
            vendor_branch_location: true,
            vendor_branch_gst_type: true,
            vendor_branch_gst: true,
          },
        });

        let strictBranchIds = branches
          .map((b) => Number(b.vendor_branch_id ?? 0))
          .filter((id) => id > 0);

        if (cityTokensForBranchFiltering.size > 0) {
          strictBranchIds = branches
            .filter((b) => {
              const locationToken = normalizeCityToken(
                String(b.vendor_branch_location ?? ""),
              );
              const nameToken = normalizeCityToken(
                String(b.vendor_branch_name ?? ""),
              );
              return (
                (locationToken.length > 0 && cityTokensForBranchFiltering.has(locationToken)) ||
                (nameToken.length > 0 && cityTokensForBranchFiltering.has(nameToken))
              );
            })
            .map((b) => Number(b.vendor_branch_id ?? 0))
            .filter((id) => id > 0);
        }

        if (strictBranchIds.length > 0) {
          hasAnyStrictBranchForType = true;
        }

        vendorBranchCache.set(Number(vendorId), {
          branches,
          strictBranchIds,
        });
      }

      for (const map of mappings) {
        const vendorVehicleTypeId = Number(map.vendor_vehicle_type_ID ?? 0);
        const vendorId = Number(map.vendor_id ?? 0);
        const masterVehicleTypeId = Number(map.vehicle_type_id ?? 0);
        if (!vendorVehicleTypeId || !vendorId) continue;

        // Fetch vendor details for margin calculation (PHP parity)
        const vendorDetailsWhere = {
          vendor_id: vendorId,
          status: 1,
          deleted: 0,
        };
        this.logSql(
          "VENDOR_DETAILS_FIND_UNIQUE",
          this.buildSelectSql("dvi_vendor_details", { vendor_id: vendorId }, "LIMIT 1"),
          { where: vendorDetailsWhere },
        );

        const vendorDetails = await tx.dvi_vendor_details.findUnique({
          where: { vendor_id: vendorId },
          select: {
            vendor_margin: true,
            vendor_margin_gst_type: true,
            vendor_margin_gst_percentage: true,
          },
        });

        const vendorMarginPercentage = Number(vendorDetails?.vendor_margin ?? 10);
        const vendorMarginGstType = Number(vendorDetails?.vendor_margin_gst_type ?? 2);
        const vendorMarginGstPercentage = Number(vendorDetails?.vendor_margin_gst_percentage ?? 5);

        const cachedBranchData = vendorBranchCache.get(vendorId);
        const allowedBranches = cachedBranchData?.branches ?? [];
        const fallbackBranchIds = allowedBranches
          .map((b) => Number(b.vendor_branch_id ?? 0))
          .filter((id) => id > 0);
        const allowedBranchIds = hasAnyStrictBranchForType
          ? cachedBranchData?.strictBranchIds ?? []
          : fallbackBranchIds;

        if (!allowedBranchIds.length) continue;

        const vehicleWhere: any = {
          vendor_id: vendorId,
          vendor_branch_id: { in: allowedBranchIds },
          status: 1,
          deleted: 0,
          ...(eligibleCities.length
            ? {
                owner_city: { in: eligibleCities },
              }
            : {}),
          OR: [
            { vehicle_type_id: vendorVehicleTypeId },
            ...(masterVehicleTypeId ? [{ vehicle_type_id: masterVehicleTypeId }] : []),
            { vehicle_type_id: planVehicleTypeId },
          ],
        };

        this.logSql(
          "VEHICLE_FIND_MANY",
          this.buildSelectSql("dvi_vehicle", vehicleWhere, "ORDER BY `vehicle_id` ASC"),
          { where: vehicleWhere },
        );

        const vehicles = await tx.dvi_vehicle.findMany({
          where: vehicleWhere,
          select: {
            vehicle_id: true,
            vendor_branch_id: true,
            vehicle_location_id: true,
            extra_km_charge: true,
          },
          orderBy: { vehicle_id: "asc" },
        });

        if (!vehicles.length) continue;

        const branchNameById = new Map<number, string>(
          allowedBranches.map((b) => [
            Number(b.vendor_branch_id),
            String(b.vendor_branch_name ?? "").trim(),
          ]),
        );

        // PHP parity: Store vendor_branch_gst_type and vendor_branch_gst by branch_id
        const branchGstById = new Map<number, { type: number; percentage: number }>(
          allowedBranches.map((b) => [
            Number(b.vendor_branch_id),
            {
              type: Number(b.vendor_branch_gst_type ?? 2),
              percentage: Number(b.vendor_branch_gst ?? 5),
            },
          ]),
        );

        const maxToProcess = Math.min(vehicles.length, Math.max(requiredCount, 10));

        for (let idx = 0; idx < maxToProcess; idx++) {
          const vehicle = vehicles[idx];
          const vehicleId = Number(vehicle.vehicle_id ?? 0);
          const vendorBranchId = Number(vehicle.vendor_branch_id ?? 0);
          const vehicleLocationId = Number(vehicle.vehicle_location_id ?? 0);
          if (!vehicleId || !vendorBranchId) continue;

          // PHP parity: Fetch vehicle_origin from dvi_stored_locations.source_location
          let vehicleOrigin = "";
          if (vehicleLocationId) {
            const storedLocation = await tx.dvi_stored_locations.findUnique({
              where: { location_ID: vehicleLocationId },
              select: { source_location: true },
            });
            vehicleOrigin = String(storedLocation?.source_location ?? "").trim();
          }
          // Fallback to branch name if no stored location
          if (!vehicleOrigin) {
            vehicleOrigin = branchNameById.get(vendorBranchId) || "";
          }

          const comboKey = `${vendorId}:${vendorBranchId}:${vendorVehicleTypeId}`;

          let currentQty = existingQtyCache.get(comboKey);
          if (currentQty === undefined) {
            const qtyWhere = {
              itinerary_plan_id: planId,
              vendor_id: vendorId,
              vendor_vehicle_type_id: vendorVehicleTypeId,
              vendor_branch_id: vendorBranchId,
              status: 1,
              deleted: 0,
            };
            this.logSql(
              "ELIGIBLE_QTY_CHECK_AGGREGATE",
              this.buildSelectSql(
                "dvi_itinerary_plan_vendor_eligible_list",
                qtyWhere,
              ),
              { where: qtyWhere, note: "aggregate + count in getPhpTotalVehicleQty" },
            );

            currentQty = await getPhpTotalVehicleQty(tx, qtyWhere);
            existingQtyCache.set(comboKey, currentQty);
          }

          const kmsKey = `${vendorId}:${vendorVehicleTypeId}`;
          let kms = kmsLimitCache.get(kmsKey);
          if (!kms) {
            const kmsWhere1 = {
              vendor_id: vendorId,
              vendor_vehicle_type_id: vendorVehicleTypeId,
              status: 1,
              deleted: 0,
            };
            this.logSql(
              "KMS_LIMIT_FIND_FIRST_1",
              this.buildSelectSql(
                "dvi_kms_limit",
                kmsWhere1,
                "ORDER BY `kms_limit_id` DESC LIMIT 1",
              ),
              { where: kmsWhere1 },
            );

            let kmsLimit = await tx.dvi_kms_limit.findFirst({
              where: kmsWhere1,
              select: { kms_limit_id: true, kms_limit: true },
              orderBy: { kms_limit_id: "desc" },
            });

            if (!kmsLimit) {
              const kmsWhere2 = {
                vendor_id: vendorId,
                vendor_vehicle_type_id: vendorVehicleTypeId,
                status: 1,
              };
              this.logSql(
                "KMS_LIMIT_FIND_FIRST_2",
                this.buildSelectSql(
                  "dvi_kms_limit",
                  kmsWhere2,
                  "ORDER BY `kms_limit_id` DESC LIMIT 1",
                ),
                { where: kmsWhere2 },
              );

              kmsLimit = await tx.dvi_kms_limit.findFirst({
                where: kmsWhere2,
                select: { kms_limit_id: true, kms_limit: true },
                orderBy: { kms_limit_id: "desc" },
              });
            }

            kms = {
              kmsLimitId: Number(kmsLimit?.kms_limit_id ?? 0),
              allowedKmPerDayNum: toNum(kmsLimit?.kms_limit),
            };
            kmsLimitCache.set(kmsKey, kms);
          }

          const allowedKmPerDayNum = kms.allowedKmPerDayNum;
          
          // PHP parity: Count only OUTSTATION days (travel_type = 2) for allowed KMs calculation
          // This happens AFTER vehicle_details records are created, so we need to count them
          // For now during initial creation, we'll count based on route data when vehicle_details exists
          // Since we don't have vehicle_details yet, we'll use a placeholder and update later
          // PHP: SELECT COUNT(*) WHERE travel_type = '2'
          let outstationDaysCount = 0;
          
          // Try to get outstation days from existing vehicle_details for this vendor
          const existingDetailsWhere = {
            itinerary_plan_id: planId,
            vendor_id: vendorId,
            vendor_vehicle_type_id: vendorVehicleTypeId,
            vendor_branch_id: vendorBranchId,
            travel_type: 2, // outstation
            status: 1,
            deleted: 0,
          };
          
          if (tAny?.dvi_itinerary_plan_vendor_vehicle_details) {
            outstationDaysCount = await tAny.dvi_itinerary_plan_vendor_vehicle_details.count({
              where: existingDetailsWhere,
            });
          }
          
          // If no existing details yet, assume all days are outstation (will be updated later)
          // This is a temporary value that will be corrected in the update phase
          if (outstationDaysCount === 0) {
            outstationDaysCount = noOfDays;
          }
          
          const totalAllowedKmsNum =
            allowedKmPerDayNum > 0 ? allowedKmPerDayNum * outstationDaysCount : 0;

          const extraKmRateNum = toNum(vehicle.extra_km_charge) || 0;
          const totalExtraKmsNum =
            totalAllowedKmsNum > 0 ? Math.max(0, totalOutstationKmNum - totalAllowedKmsNum) : 0;
          const totalExtraKmsChargeNum = totalExtraKmsNum * extraKmRateNum;

          const pbKey = `${vendorId}:${vendorBranchId}:${vendorVehicleTypeId}:${yearStr}:${monthStr}:${kms.kmsLimitId}`;
          let rentalPerDayNum = priceBookCache.get(pbKey);
          if (rentalPerDayNum === undefined) {
            rentalPerDayNum = 0;

            if (kms.kmsLimitId) {
              const pbWhere1 = {
                year: yearStr,
                month: monthStr,
                vendor_id: vendorId,
                vendor_branch_id: vendorBranchId,
                vehicle_type_id: vendorVehicleTypeId,
                kms_limit_id: kms.kmsLimitId,
                status: 1,
                deleted: 0,
              };
              this.logSql(
                "OUTSTATION_PRICE_BOOK_FIND_FIRST_1",
                this.buildSelectSql(
                  "dvi_vehicle_outstation_price_book",
                  pbWhere1,
                  "ORDER BY `id` DESC LIMIT 1",
                ),
                { where: pbWhere1 },
              );

              let pb = await tx.dvi_vehicle_outstation_price_book.findFirst({
                where: pbWhere1,
              });

              if (!pb) {
                const pbWhere2 = {
                  year: yearStr,
                  month: monthStr,
                  vendor_id: vendorId,
                  vendor_branch_id: vendorBranchId,
                  vehicle_type_id: vendorVehicleTypeId,
                  kms_limit_id: kms.kmsLimitId,
                  status: 1,
                };
                this.logSql(
                  "OUTSTATION_PRICE_BOOK_FIND_FIRST_2",
                  this.buildSelectSql(
                    "dvi_vehicle_outstation_price_book",
                    pbWhere2,
                    "ORDER BY `id` DESC LIMIT 1",
                  ),
                  { where: pbWhere2 },
                );

                pb = await tx.dvi_vehicle_outstation_price_book.findFirst({
                  where: pbWhere2,
                });
              }

              const col = `day_${dayOfMonth}`;
              rentalPerDayNum = toNum((pb as any)?.[col]);
            }

            priceBookCache.set(pbKey, rentalPerDayNum);
          }

          if (!rentalPerDayNum || rentalPerDayNum === 0) continue;

          const totalRentalNum = rentalPerDayNum * noOfDays;
          
          // Aggregate parking charges from hotspot parking charge table
          const parkingAgg = await (tx as any).dvi_itinerary_route_hotspot_parking_charge.aggregate({
            where: {
              itinerary_plan_ID: planId,
              vehicle_type: planVehicleTypeId,
              status: 1,
              deleted: 0,
            },
            _sum: {
              parking_charges_amt: true,
            },
          });
          const totalParkingCharges = Number(parkingAgg._sum?.parking_charges_amt || 0);
          
          // NOTE: toll/permit charges set to 0 initially because vehicle_details doesn't exist yet
          // They will be aggregated and updated AFTER vehicle_details records are created
          const totalTollCharges = 0;
          const totalPermitCharges = 0;
          
          const totalDriverCharges = 0;

          const vehicleBaseTotal = totalRentalNum + totalExtraKmsChargeNum + 
                                   totalTollCharges + totalParkingCharges + 
                                   totalDriverCharges + totalPermitCharges;

          // GST calculation - use vendor_branch GST settings (PHP parity)
          const branchGst = branchGstById.get(vendorBranchId) || { type: 2, percentage: 5 };
          const vehicleGstType = branchGst.type;
          const vehicleGstPercentage = branchGst.percentage;
          const vehicleGstAmount = vehicleGstType === 2 ? 
            (vehicleBaseTotal * vehicleGstPercentage / 100) : 0;
          
          const vehicleTotalAmount = vehicleBaseTotal;

          // Vendor margin calculation - use values from vendor_details table (PHP parity)
          // Values fetched earlier in the loop from dvi_vendor_details
          const vendorMarginAmount = vehicleTotalAmount * vendorMarginPercentage / 100;
          const vendorMarginGstAmount = vendorMarginGstType === 2 ?
            (vendorMarginAmount * vendorMarginGstPercentage / 100) : 0;

          const vehicleGrandTotalNum = vehicleTotalAmount + vehicleGstAmount + 
                                       vendorMarginAmount + vendorMarginGstAmount;

          const baseData: any = {
            itinerary_plan_id: planId,
            itineary_plan_assigned_status: 0,
            vehicle_type_id: planVehicleTypeId,
            vendor_id: vendorId,
            vendor_vehicle_type_id: vendorVehicleTypeId,
            total_vehicle_qty: 1,
            vehicle_count: 1,
            vehicle_id: vehicleId,
            vendor_branch_id: vendorBranchId,
            vehicle_orign: vehicleOrigin,
            outstation_allowed_km_per_day: String(allowedKmPerDayNum),
            total_kms: String(totalKmsNum),
            total_outstation_km: String(totalOutstationKmNum),
            total_time: String(totalTimeStr),
            total_rental_charges: totalRentalNum,
            total_toll_charges: totalTollCharges,
            total_parking_charges: totalParkingCharges,
            total_driver_charges: totalDriverCharges,
            total_permit_charges: totalPermitCharges,
            extra_km_rate: String(extraKmRateNum),
            total_allowed_kms: String(totalAllowedKmsNum),
            total_extra_kms: String(totalExtraKmsNum),
            total_extra_kms_charge: totalExtraKmsChargeNum,
            vehicle_gst_type: vehicleGstType,
            vehicle_gst_percentage: vehicleGstPercentage,
            vehicle_gst_amount: vehicleGstAmount,
            vehicle_total_amount: vehicleTotalAmount,
            vendor_margin_percentage: vendorMarginPercentage,
            vendor_margin_gst_type: vendorMarginGstType,
            vendor_margin_gst_percentage: vendorMarginGstPercentage,
            vendor_margin_amount: vendorMarginAmount,
            vendor_margin_gst_amount: vendorMarginGstAmount,
            vehicle_grand_total: vehicleGrandTotalNum,
            createdby: createdBy,
            createdon: new Date(),
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          };

          if (currentQty < requiredCount) {
            this.logSql(
              "ELIGIBLE_INSERT",
              this.buildInsertSql(
                "dvi_itinerary_plan_vendor_eligible_list",
                baseData,
              ),
              { data: baseData },
            );

            const createdEligible =
              await tx.dvi_itinerary_plan_vendor_eligible_list.create({
                data: baseData,
                select: { itinerary_plan_vendor_eligible_ID: true },
              });

            inserted++;
            vendorIdsUsed.add(vendorId);

            currentQty += 1;
            existingQtyCache.set(comboKey, currentQty);
          } else {
            const updateWhere = {
              itinerary_plan_id: planId,
              vendor_vehicle_type_id: vendorVehicleTypeId,
              vehicle_id: vehicleId,
              vendor_branch_id: vendorBranchId,
            };

            const updateData = { ...baseData, createdon: undefined };
            this.logSql(
              "ELIGIBLE_UPDATE_MANY",
              this.buildUpdateSql(
                "dvi_itinerary_plan_vendor_eligible_list",
                updateData,
                updateWhere,
              ),
              { where: updateWhere, data: updateData },
            );

            const updRes =
              await tx.dvi_itinerary_plan_vendor_eligible_list.updateMany({
                where: updateWhere,
                data: updateData,
              });
          }
        }
      }
    }

    const vendorIdList = Array.from(vendorIdsUsed);

    if (vendorIdList.length > 0) {
      const delWhere = {
        itinerary_plan_id: planId,
        vendor_id: { notIn: vendorIdList },
      };
      this.logSql(
        "ELIGIBLE_DELETE_UNUSED_VENDORS",
        this.buildDeleteSql("dvi_itinerary_plan_vendor_eligible_list", delWhere),
        { where: delWhere },
      );
      const delRes =
        await tx.dvi_itinerary_plan_vendor_eligible_list.deleteMany({
          where: delWhere,
        });
    } else {
      const delAllWhere = { itinerary_plan_id: planId };
      this.logSql(
        "ELIGIBLE_DELETE_ALL_NO_VENDOR_MATCH",
        this.buildDeleteSql("dvi_itinerary_plan_vendor_eligible_list", delAllWhere),
        { where: delAllWhere },
      );
      const delAllRes =
        await tx.dvi_itinerary_plan_vendor_eligible_list.deleteMany({
          where: delAllWhere },
      );
    }

    const resetWhere = { itinerary_plan_id: planId };
    const resetData = { itineary_plan_assigned_status: 0 };
    this.logSql(
      "ELIGIBLE_RESET_ASSIGNED",
      this.buildUpdateSql(
        "dvi_itinerary_plan_vendor_eligible_list",
        resetData,
        resetWhere,
      ),
      { where: resetWhere, data: resetData },
    );
    const resetRes =
      await tx.dvi_itinerary_plan_vendor_eligible_list.updateMany({
        where: resetWhere,
        data: resetData,
      });

    for (const [planVehicleTypeId, requiredCount] of requiredCountByType.entries()) {
      const picksWhere = {
        itinerary_plan_id: planId,
        vehicle_type_id: planVehicleTypeId,
        vehicle_grand_total: { gt: 0 },
        status: 1,
        deleted: 0,
      };
      this.logSql(
        "ELIGIBLE_SELECT_CHEAPEST",
        this.buildSelectSql(
          "dvi_itinerary_plan_vendor_eligible_list",
          picksWhere,
          `ORDER BY \`vehicle_grand_total\` ASC, \`itinerary_plan_vendor_eligible_ID\` ASC LIMIT ${Math.max(
            0,
            requiredCount,
          )}`,
        ),
        { where: picksWhere },
      );

      const picks =
        await tx.dvi_itinerary_plan_vendor_eligible_list.findMany({
          where: picksWhere,
          orderBy: [
            { vehicle_grand_total: "asc" },
            { itinerary_plan_vendor_eligible_ID: "asc" },
          ],
          take: Math.max(0, requiredCount),
          select: { itinerary_plan_vendor_eligible_ID: true },
        });

      const ids = picks
        .map((p: any) => Number(p.itinerary_plan_vendor_eligible_ID ?? 0))
        .filter((x: any) => x > 0);

      if (ids.length) {
        const markWhere = {
          itinerary_plan_vendor_eligible_ID: { in: ids },
        };
        const markData = { itineary_plan_assigned_status: 1 };
        this.logSql(
          "ELIGIBLE_MARK_ASSIGNED",
          this.buildUpdateSql(
            "dvi_itinerary_plan_vendor_eligible_list",
            markData,
            markWhere,
          ),
          { where: markWhere, data: markData },
        );

        const markRes =
          await tx.dvi_itinerary_plan_vendor_eligible_list.updateMany({
            where: markWhere,
            data: markData },
        );
      }
    }

    const cleanWhere = {
      itinerary_plan_id: planId,
      vehicle_type_id: { notIn: requiredVehicleTypeIds },
    };
    this.logSql(
      "ELIGIBLE_DELETE_UNUSED_TYPES",
      this.buildDeleteSql("dvi_itinerary_plan_vendor_eligible_list", cleanWhere),
      { where: cleanWhere },
    );
    const cleanRes =
      await tx.dvi_itinerary_plan_vendor_eligible_list.deleteMany({
        where: cleanWhere },
    );

    // ---------------------------------------------------------------------
    // BUILD dvi_itinerary_plan_vendor_vehicle_details
    // FOR ALL ELIGIBLES (PHP parity - creates for both assigned and non-assigned)
    // ---------------------------------------------------------------------
    if (tAny?.dvi_itinerary_plan_vendor_vehicle_details && totalNoOfPlanRouteDetails > 0) {
      const delDetailsWhere2: any = { itinerary_plan_id: planId };
      this.logSql(
        "VENDOR_VEHICLE_DETAILS_DELETE_MANY_2",
        this.buildDeleteSql("dvi_itinerary_plan_vendor_vehicle_details", delDetailsWhere2),
        { where: delDetailsWhere2 },
      );
      const delDetRes2 =
        await tAny.dvi_itinerary_plan_vendor_vehicle_details.deleteMany({
          where: delDetailsWhere2 },
      );

      const eligiblesWhere = {
        itinerary_plan_id: planId,
        // REMOVED: itineary_plan_assigned_status: 1,
        // PHP creates vehicle_details for ALL vendors (assigned and non-assigned)
        status: 1,
        deleted: 0,
      };
      this.logSql(
        "ELIGIBLE_FIND_ALL_FOR_DETAILS",
        this.buildSelectSql(
          "dvi_itinerary_plan_vendor_eligible_list",
          eligiblesWhere,
        ),
        { where: eligiblesWhere },
      );

      const eligibles: any[] =
        await tx.dvi_itinerary_plan_vendor_eligible_list.findMany({
          where: eligiblesWhere },
      );
      if (process.env.DEBUG_LOCAL_KM_FIX === 'true') {
        this.log('VEHICLE_ELIGIBLE_ROWS', {
          planId,
          count: eligibles.length,
          rows: eligibles.map((x: any) => ({
            itinerary_plan_vendor_eligible_ID: x.itinerary_plan_vendor_eligible_ID,
            vehicle_id: x.vehicle_id,
            vehicle_type_id: x.vehicle_type_id,
            assigned_status: x.itineary_plan_assigned_status,
            deleted: x.deleted,
            status: x.status,
          })),
        });
      }

      const travelType = Number(plan.itinerary_type ?? 0) || 2; // 1=local, 2=outstation

      // keep helper call for logging / debugging (no hotspot override)
      const routeKmMap = await this.buildRouteKmMap(tx, planId, routes);

      // Overall trip local rule: if itinerary starts and ends in same normalized city, force LOCAL usage.
      const firstRoute = routes[0];
      const lastRoute = routes[routes.length - 1];
      const overallStartCityRaw = firstRoute
        ? (await getStoredLocationCity(tx, String(firstRoute.location_name || ''))) || String(firstRoute.location_name || '')
        : '';
      const overallEndCityRaw = lastRoute
        ? (await getStoredLocationCity(tx, String(lastRoute.next_visiting_location || ''))) || String(lastRoute.next_visiting_location || '')
        : '';
      const forceLocalTrip =
        normalizeCityToken(overallStartCityRaw) !== '' &&
        normalizeCityToken(overallStartCityRaw) === normalizeCityToken(overallEndCityRaw);

      for (const e of eligibles) {
        const eligibleId = Number(e.itinerary_plan_vendor_eligible_ID ?? 0);
        if (!eligibleId) continue;

        const vehicleTypeId = Number(e.vehicle_type_id ?? 0);
        const vendorId = Number(e.vendor_id ?? 0);
        const vvtId = Number(e.vendor_vehicle_type_id ?? 0);
        const vehicleId = Number(e.vehicle_id ?? 0);
        const vendorBranchId = Number(e.vendor_branch_id ?? 0);
        const qty = Number(e.total_vehicle_qty ?? 1) || 1;

        // Get vehicle details from dvi_vehicle table (PHP joins dvi_vehicle + dvi_vendor_vehicle_types)
        // In dvi_vehicle, vehicle_type_id actually stores vendor_vehicle_type_ID
        const vehicle = await tx.dvi_vehicle.findUnique({
          where: { vehicle_id: vehicleId },
          select: {
            vehicle_location_id: true,
            extra_km_charge: true,
            extra_hour_charge: true,
            early_morning_charges: true,
            evening_charges: true,
            vendor_id: true,
            vendor_branch_id: true,
            vehicle_type_id: true  // This is actually vendor_vehicle_type_ID
          }
        });

        if (!vehicle) continue;

        // Get vendor_vehicle_type details for driver charges
        // PHP: VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
        const vendorVehicleType = await tx.dvi_vendor_vehicle_types.findUnique({
          where: { vendor_vehicle_type_ID: vehicle.vehicle_type_id || 0 },
          select: {
            driver_batta: true,
            food_cost: true,
            accomodation_cost: true,
            extra_cost: true,
            driver_early_morning_charges: true,
            driver_evening_charges: true
          }
        });

        if (!vendorVehicleType) continue;

        // Get vehicle origin details from dvi_stored_locations
        const vehicleLocationId = vehicle.vehicle_location_id || 0;
        const vehicleLocationDetails = await getVehicleLocationDetails(
          tx,
          vehicleLocationId
        );

        // Build calculation context
        const eligibleCompositeKey = `${vendorId}:${vendorBranchId}:${vvtId}:${vehicleId}`;
        const selectedTimeLimitId =
          Number(selectedTimeLimitByEligible[String(eligibleId)] ?? 0) ||
          Number(selectedTimeLimitByEligible[eligibleCompositeKey] ?? 0) ||
          0;

        const calcCtx: VehicleCalculationContext = {
          prisma: tx,
          
          itinerary_plan_ID: planId,
          vehicle_type_id: vehicleTypeId,
          vendor_id: vendorId,
          vendor_vehicle_type_ID: vvtId,
          vendor_branch_id: vendorBranchId,
          vehicle_location_id: vehicleLocationId,
          vehicle_origin: vehicleLocationDetails.origin,
          vehicle_origin_city: vehicleLocationDetails.city,
          vehicle_origin_latitude: vehicleLocationDetails.latitude,
          vehicle_origin_longitude: vehicleLocationDetails.longitude,
          extra_km_charge: toNum(vehicle.extra_km_charge),  // From dvi_vehicle
          extra_hour_charge: toNum(vehicle.extra_hour_charge),
          selected_time_limit_id: selectedTimeLimitId || undefined,
          force_local_trip: forceLocalTrip,
          get_kms_limit: 250,  // Default outstation KM limit
          driver_batta: toNum(vendorVehicleType.driver_batta),
          food_cost: toNum(vendorVehicleType.food_cost),
          accomodation_cost: toNum(vendorVehicleType.accomodation_cost),
          extra_cost: toNum(vendorVehicleType.extra_cost),
          driver_early_morning_charges: toNum(vendorVehicleType.driver_early_morning_charges),
          driver_evening_charges: toNum(vendorVehicleType.driver_evening_charges),
          early_morning_charges: toNum(vehicle.early_morning_charges),  // From dvi_vehicle
          evening_charges: toNum(vehicle.evening_charges)  // From dvi_vehicle
        };

        let previous_destination_city = '';
        let route_count = 0;
        const total_routes = routes.length;

        for (const r of routes) {
          route_count++;
          const routeId = Number(r.itinerary_route_ID ?? 0);
          if (!routeId) continue;

          const routeDate = safeDate(r.itinerary_route_date) || routeDateBase;
          const routeDateKey = routeDate.toISOString().slice(0, 10);
          const prevRoute = route_count > 1 ? (routes[route_count - 2] as any) : null;
          const prevRouteDate = prevRoute ? (safeDate(prevRoute.itinerary_route_date) || routeDateBase) : null;
          const prevRouteDateKey = prevRouteDate ? prevRouteDate.toISOString().slice(0, 10) : null;
          const isFirstRouteOfDay = !prevRouteDateKey || prevRouteDateKey !== routeDateKey;
          const nextRoute = routes[route_count] as any;
          const nextRouteDate = nextRoute ? (safeDate(nextRoute.itinerary_route_date) || routeDateBase) : null;
          const nextRouteDateKey = nextRouteDate ? nextRouteDate.toISOString().slice(0, 10) : null;
          const isLastRouteOfDay = !nextRouteDateKey || nextRouteDateKey !== routeDateKey;

          const fromLoc = (r.location_name ?? null) as any;
          const toLoc = (r.next_visiting_location ?? null) as any;

          // Build route data for calculation
          const routeData: RouteData = {
            itinerary_route_ID: routeId,
            itinerary_route_date: routeDate,
            location_name: fromLoc,
            next_visiting_location: toLoc,
            no_of_km: r.no_of_km,
            route_start_time: r.route_start_time,
            route_end_time: r.route_end_time
          };
          if (process.env.DEBUG_LOCAL_KM_FIX === 'true') {
            this.log('VEHICLE_ROUTE_LOOP_START', {
              planId,
              routeId,
              routeDay: r.no_of_days,
              location_name: routeData.location_name,
              next_visiting_location: routeData.next_visiting_location,
              vehicle_id: vehicleId,
              vendor_id: vendorId,
            });
            this.log('VEHICLE_CALC_CALL', {
              planId,
              routeId,
              route_count,
              total_routes,
              vehicle_id: vehicleId,
              vendor_id: vendorId,
            });
          }
          if (process.env.DEBUG_DVI20260594_INSERT === 'true') {
            this.log('VEHICLE_CALC_INPUT', {
              route_count,
              total_routes,
              route_id: routeData.itinerary_route_ID,
              location_name: routeData.location_name,
              next_visiting_location: routeData.next_visiting_location,
              no_of_km: routeData.no_of_km,
              vehicle_id: vehicleId,
              vendor_id: vendorId,
              vendor_branch_id: vendorBranchId,
              vehicle_origin: calcCtx.vehicle_origin,
              vehicle_origin_city: calcCtx.vehicle_origin_city,
              vehicle_origin_latitude: calcCtx.vehicle_origin_latitude,
              vehicle_origin_longitude: calcCtx.vehicle_origin_longitude,
            });
          }

          // Calculate all route details using PHP-parity logic
          const result = await calculateRouteVehicleDetails(
            calcCtx,
            routeData,
            route_count,
            total_routes,
            previous_destination_city,
            isLastRouteOfDay,
            isFirstRouteOfDay
          );
          if (process.env.DEBUG_LOCAL_KM_FIX === 'true') {
            this.log('VEHICLE_CALC_RETURN', {
              planId,
              routeId,
              TOTAL_PICKUP_KM: result.TOTAL_PICKUP_KM,
              TOTAL_RUNNING_KM: result.TOTAL_RUNNING_KM,
              SIGHT_SEEING_TRAVELLING_KM: result.SIGHT_SEEING_TRAVELLING_KM,
              TOTAL_DROP_KM: result.TOTAL_DROP_KM,
              TOTAL_KM: result.TOTAL_KM,
            });
          }

          // Debug: log calculation result for each route
          this.log('VEHICLE_DETAIL_CALC', {
            routeId,
            vendorId,
            vendorVehicleTypeId: vvtId,
            vehicleId,
            vehicle_cost_for_the_day: result.vehicle_cost_for_the_day,
            travel_type: result.travel_type,
            time_limit_id: result.time_limit_id,
            total_km: result.TOTAL_KM,
            pricebook_debug: {
              total_allowed_local_km: result.TOTAL_ALLOWED_LOCAL_KM,
              total_local_extra_km: result.TOTAL_LOCAL_EXTRA_KM,
              total_local_extra_km_charges: result.TOTAL_LOCAL_EXTRA_KM_CHARGES
            }
          });

          // Skip if vehicle cost is 0 (PHP line 1771)
          if (result.vehicle_cost_for_the_day === 0) {
            this.log('SKIP_ZERO_COST', { routeId, vendorId, vvtId, vehicleId });
            continue;
          }

          // Helper: convert "HH:MM:SS" to Date object for DateTime fields
          function toTimeDate(val: any): Date | null {
            if (!val) return null;
            if (val instanceof Date) return val;
            if (typeof val === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(val)) {
              return timeStringToPrismaTime(val);
            }
            return null;
          }
          // Helper: ensure string or null for varchar fields
          function toTimeString(val: any): string | null {
            if (!val) return null;
            if (typeof val === 'string') return val;
            if (val instanceof Date) {
              return val.toISOString().split('T')[1].substring(0, 8);
            }
            return String(val);
          }

          const detailsData: any = {
            itinerary_plan_vendor_eligible_ID: eligibleId,
            itinerary_plan_id: planId,
            itinerary_route_id: routeId,
            itinerary_route_date: routeDate as any,
            vehicle_type_id: vehicleTypeId,
            vehicle_qty: qty,
            vendor_id: vendorId,
            vendor_vehicle_type_id: vvtId,
            vehicle_id: vehicleId,
            vendor_branch_id: vendorBranchId,
            time_limit_id: result.time_limit_id,
            kms_limit_id: 0,
            travel_type: result.travel_type,
            itinerary_route_location_from: fromLoc,
            itinerary_route_location_to: toLoc,

            // Distance fields (strings from calculation)
            total_running_km: result.TOTAL_RUNNING_KM,
            total_running_time: toTimeDate(result.TOTAL_TRAVELLING_TIME),
            total_siteseeing_km: result.SIGHT_SEEING_TRAVELLING_KM,
            total_siteseeing_time: toTimeDate(result.SIGHT_SEEING_TRAVELLING_TIME),
            total_pickup_km: result.TOTAL_PICKUP_KM,
            total_pickup_duration: toTimeDate(result.TOTAL_PICKUP_DURATION),
            total_drop_km: result.TOTAL_DROP_KM,
            total_drop_duration: toTimeDate(result.TOTAL_DROP_DURATION),
            total_extra_km: result.TOTAL_LOCAL_EXTRA_KM.toFixed(2),
            extra_km_rate: calcCtx.extra_km_charge,
            total_extra_km_charges: result.TOTAL_LOCAL_EXTRA_KM_CHARGES,
            total_travelled_km: result.TOTAL_KM,
            total_travelled_time: toTimeString(result.TOTAL_TIME),

            // Money fields (numbers from calculation)
            vehicle_rental_charges: result.vehicle_cost_for_the_day,
            vehicle_toll_charges: result.VEHICLE_TOLL_CHARGE,
            vehicle_parking_charges: result.VEHICLE_PARKING_CHARGE,
            vehicle_driver_charges: result.TOTAL_DRIVER_CHARGES,
            vehicle_permit_charges: result.permit_charges,
            before_6_am_extra_time: toTimeString(result.morning_extra_time),
            after_8_pm_extra_time: toTimeString(result.evening_extra_time),
            before_6_am_charges_for_driver: result.DRIVER_MORINING_CHARGES,
            before_6_am_charges_for_vehicle: result.VENDOR_VEHICLE_MORNING_CHARGES,
            after_8_pm_charges_for_driver: result.DRIVER_EVEINING_CHARGES,
            after_8_pm_charges_for_vehicle: result.VENDOR_VEHICLE_EVENING_CHARGES,
            total_vehicle_amount: result.TOTAL_VEHICLE_AMOUNT,

            createdby: createdBy,
            createdon: new Date(),
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          };

          this.logSql(
            "VENDOR_VEHICLE_DETAILS_INSERT",
            this.buildInsertSql(
              "dvi_itinerary_plan_vendor_vehicle_details",
              detailsData,
            ),
            { data: detailsData },
          );
          if (process.env.DEBUG_LOCAL_KM_FIX === 'true') {
            this.log('VEHICLE_DETAIL_INSERT_ATTEMPT', {
              planId,
              routeId,
              data: detailsData,
            });
          }

          let createdDetails: any = null;
          try {
            createdDetails =
              await tAny.dvi_itinerary_plan_vendor_vehicle_details.create({
                data: detailsData,
              });
          } catch (error: any) {
            this.log('VEHICLE_DETAIL_INSERT_ERROR', {
              planId,
              routeId,
              error: String(error?.message || error),
              fullError: error,
            });
            throw error;
          }
          if (process.env.DEBUG_LOCAL_KM_FIX === 'true') {
            this.log('VEHICLE_DETAIL_INSERT_SUCCESS', {
              planId,
              routeId,
              insertedId: createdDetails?.itinerary_plan_vendor_vehicle_details_ID ?? null,
            });
          }
          if (process.env.DEBUG_DVI20260594_INSERT === 'true') {
            this.log('VEHICLE_DETAILS_INSERT_DATA', {
              itinerary_plan_id: detailsData.itinerary_plan_id,
              itinerary_route_id: detailsData.itinerary_route_id,
              itinerary_route_location_from: detailsData.itinerary_route_location_from,
              itinerary_route_location_to: detailsData.itinerary_route_location_to,
              total_pickup_km: detailsData.total_pickup_km,
              total_running_km: detailsData.total_running_km,
              total_siteseeing_km: detailsData.total_siteseeing_km,
              total_drop_km: detailsData.total_drop_km,
              total_travelled_km: detailsData.total_travelled_km,
            });
            this.log('VEHICLE_DETAILS_INSERT_RESULT', createdDetails);
          }

          // Update previous destination city for next iteration
          previous_destination_city = await getStoredLocationCity(tx, toLoc);
        }
      }
    }

    // NOW update eligible_list with toll/permit charges from vehicle_details
    // (this runs AFTER all vehicle_details records have been created above)
    this.writeLog(`[vehiclesEngine] Starting eligible_list update for plan ${planId}`);
    const eligibleRecords = await tx.dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        itinerary_plan_id: planId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_vendor_eligible_ID: true,
        vendor_vehicle_type_id: true,
        vehicle_type_id: true,
        outstation_allowed_km_per_day: true,
        extra_km_rate: true,
        total_rental_charges: true,
        total_parking_charges: true,
        total_extra_kms_charge: true,
        total_driver_charges: true,
        vehicle_gst_type: true,
        vehicle_gst_percentage: true,
        vendor_margin_percentage: true,
        vendor_margin_gst_type: true,
        vendor_margin_gst_percentage: true,
      },
    });
    this.writeLog(`[vehiclesEngine] Found ${eligibleRecords.length} eligible records to update`);

    for (const eligible of eligibleRecords) {
      this.writeLog(`[vehiclesEngine] Updating eligible ${eligible.itinerary_plan_vendor_eligible_ID} (vendor_veh_type=${eligible.vendor_vehicle_type_id}, veh_type=${eligible.vehicle_type_id})`);
      
      // Count outstation days (travel_type = 2) for this vendor/vehicle type (PHP parity)
      const outstationDaysCount = await tx.dvi_itinerary_plan_vendor_vehicle_details.count({
        where: {
          itinerary_plan_id: planId,
          vendor_vehicle_type_id: eligible.vendor_vehicle_type_id,
          vehicle_type_id: eligible.vehicle_type_id,
          travel_type: 2, // outstation only
          status: 1,
          deleted: 0,
        },
      });
      this.writeLog(`[vehiclesEngine] Outstation days count: ${outstationDaysCount}`);
      
      // Recalculate total_allowed_kms based on outstation days (PHP parity)
      // PHP: $TOTAL_ITINEARY_ALLOWED_KM = ($PER_DAY_KM_LIMIT * $total_outstation_day_available_count);
      const allowedKmPerDay = Number(eligible.outstation_allowed_km_per_day || 250);
      const totalAllowedKms = allowedKmPerDay * outstationDaysCount;
      this.writeLog(`[vehiclesEngine] Allowed KM per day: ${allowedKmPerDay}, Total allowed KMs: ${totalAllowedKms}`);
      
      // Aggregate total travelled km and all charge components from vehicle_details.
      const vehicleDetailsRecords = await tx.dvi_itinerary_plan_vendor_vehicle_details.findMany({
        where: {
          itinerary_plan_id: planId,
          itinerary_plan_vendor_eligible_ID: eligible.itinerary_plan_vendor_eligible_ID,
          status: 1,
          deleted: 0,
        },
        select: {
          time_limit_id: true,
          total_travelled_km: true,
          total_travelled_time: true,
          travel_type: true,
          total_extra_km: true,
          total_extra_km_charges: true,
          vehicle_rental_charges: true,
          vehicle_toll_charges: true,
          vehicle_parking_charges: true,
          vehicle_driver_charges: true,
          vehicle_permit_charges: true,
          before_6_am_extra_time: true,
          after_8_pm_extra_time: true,
          before_6_am_charges_for_driver: true,
          before_6_am_charges_for_vehicle: true,
          after_8_pm_charges_for_driver: true,
          after_8_pm_charges_for_vehicle: true,
        },
      });

      const totalKms = vehicleDetailsRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.total_travelled_km || 0);
      }, 0);
      const localRecords = vehicleDetailsRecords.filter((r: any) => Number(r.travel_type || 0) === 1);
      const outstationRecords = vehicleDetailsRecords.filter((r: any) => Number(r.travel_type || 0) === 2);
      const totalOutstationKm = outstationRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.total_travelled_km || 0);
      }, 0);
      const totalLocalKms = localRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.total_travelled_km || 0);
      }, 0);

      const localTimeLimitIds = Array.from(
        new Set(
          localRecords
            .map((r: any) => Number(r.time_limit_id || 0))
            .filter((id: number) => id > 0),
        ),
      );
      const localSlabRows = localTimeLimitIds.length
        ? await tx.dvi_time_limit.findMany({
            where: { time_limit_id: { in: localTimeLimitIds } },
            select: { time_limit_id: true, km_limit: true, time_limit_title: true },
          })
        : [];
      const localKmByTimeLimit = new Map<number, number>(
        localSlabRows.map((r: any) => [Number(r.time_limit_id || 0), getEffectiveTimeLimitKm(r)]),
      );
      const totalAllowedLocalKms = localRecords.reduce((sum: number, r: any) => {
        return sum + Number(localKmByTimeLimit.get(Number(r.time_limit_id || 0)) || 0);
      }, 0);
      const totalExtraLocalKms = localRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.total_extra_km || 0);
      }, 0);
      const totalExtraLocalKmsCharge = localRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.total_extra_km_charges || 0);
      }, 0);
      const totalExtraOutstationKms = outstationRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.total_extra_km || 0);
      }, 0);
      const totalExtraOutstationKmsCharge = outstationRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.total_extra_km_charges || 0);
      }, 0);
      const totalRentalCharges = vehicleDetailsRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.vehicle_rental_charges || 0);
      }, 0);
      const totalTollCharges = vehicleDetailsRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.vehicle_toll_charges || 0);
      }, 0);
      const totalParkingCharges = vehicleDetailsRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.vehicle_parking_charges || 0);
      }, 0);
      const totalPermitCharges = vehicleDetailsRecords.reduce((sum: number, record: any) => {
        return sum + Number(record.vehicle_permit_charges || 0);
      }, 0);

      this.writeLog(`[vehiclesEngine] Total kms: ${totalKms}, Local kms: ${totalLocalKms}, Local extra: ${totalExtraLocalKms}, Local extra charge: ${totalExtraLocalKmsCharge}, records count: ${vehicleDetailsRecords.length}`);
      this.writeLog(`[vehiclesEngine] Outstation extra kms: ${totalExtraOutstationKms}, Outstation extra charge: ${totalExtraOutstationKmsCharge}`);
      
      // Convert HH:MM:SS format to decimal hours and sum
      const totalTime = vehicleDetailsRecords.reduce((sum: number, record: any) => {
        const timeStr = record.total_travelled_time || '0';
        // Handle both HH:MM:SS format and decimal format
        if (timeStr.includes(':')) {
          // Parse HH:MM:SS
          const parts = timeStr.split(':');
          const hours = Number(parts[0] || 0);
          const minutes = Number(parts[1] || 0);
          const seconds = Number(parts[2] || 0);
          const decimalHours = hours + (minutes / 60) + (seconds / 3600);
          return sum + decimalHours;
        } else {
          // Already in decimal format
          return sum + Number(timeStr);
        }
      }, 0);

      // Aggregate driver + 6AM/8PM charges from vehicle_details (PHP parity)
      const totalDriverCharges = vehicleDetailsRecords.reduce((sum: number, r: any) => sum + Number(r.vehicle_driver_charges || 0), 0);
      const totalBefore6amDriver = vehicleDetailsRecords.reduce((sum: number, r: any) => sum + Number(r.before_6_am_charges_for_driver || 0), 0);
      const totalBefore6amVehicle = vehicleDetailsRecords.reduce((sum: number, r: any) => sum + Number(r.before_6_am_charges_for_vehicle || 0), 0);
      const totalAfter8pmDriver = vehicleDetailsRecords.reduce((sum: number, r: any) => sum + Number(r.after_8_pm_charges_for_driver || 0), 0);
      const totalAfter8pmVehicle = vehicleDetailsRecords.reduce((sum: number, r: any) => sum + Number(r.after_8_pm_charges_for_vehicle || 0), 0);
      const totalBefore6amExtraTime = vehicleDetailsRecords.reduce((sum: number, r: any) => sum + Number(r.before_6_am_extra_time || 0), 0);
      const totalAfter8pmExtraTime = vehicleDetailsRecords.reduce((sum: number, r: any) => sum + Number(r.after_8_pm_extra_time || 0), 0);

      const vehicleBaseTotal = totalRentalCharges +
               totalExtraLocalKmsCharge +
               totalExtraOutstationKmsCharge +
               totalTollCharges + totalParkingCharges +
                               totalDriverCharges + totalPermitCharges +
                               totalBefore6amDriver + totalBefore6amVehicle +
                               totalAfter8pmDriver + totalAfter8pmVehicle;

      const vehicleGstType = Number(eligible.vehicle_gst_type || 2);
      const vehicleGstPercentage = Number(eligible.vehicle_gst_percentage || 5);
      const vehicleGstAmount = vehicleGstType === 2 ?
        (vehicleBaseTotal * vehicleGstPercentage / 100) : 0;

      const vehicleTotalAmount = vehicleBaseTotal;

      const vendorMarginPercentage = Number(eligible.vendor_margin_percentage || 10);
      const vendorMarginGstType = Number(eligible.vendor_margin_gst_type || 2);
      const vendorMarginGstPercentage = Number(eligible.vendor_margin_gst_percentage || 5);
      const vendorMarginAmount = vehicleTotalAmount * vendorMarginPercentage / 100;
      const vendorMarginGstAmount = vendorMarginGstType === 2 ?
        (vendorMarginAmount * vendorMarginGstPercentage / 100) : 0;

      const vehicleGrandTotalNum = vehicleTotalAmount + vehicleGstAmount +
                                   vendorMarginAmount + vendorMarginGstAmount;

      // Update eligible_list record with correct toll/permit charges and recalculated totals
      await tx.dvi_itinerary_plan_vendor_eligible_list.update({
        where: {
          itinerary_plan_vendor_eligible_ID: eligible.itinerary_plan_vendor_eligible_ID,
        },
        data: {
          total_kms: String(totalKms),
          total_outstation_km: String(totalOutstationKm),
          total_time: String(totalTime),
          total_rental_charges: totalRentalCharges,
          total_allowed_kms: String(totalAllowedKms),
          total_extra_kms: String(totalExtraOutstationKms),
          total_extra_kms_charge: totalExtraOutstationKmsCharge,
          total_allowed_local_kms: String(totalAllowedLocalKms),
          total_extra_local_kms: String(totalExtraLocalKms),
          total_extra_local_kms_charge: totalExtraLocalKmsCharge,
          total_driver_charges: totalDriverCharges,
          total_before_6_am_extra_time: String(totalBefore6amExtraTime),
          total_after_8_pm_extra_time: String(totalAfter8pmExtraTime),
          total_before_6_am_charges_for_driver: totalBefore6amDriver,
          total_before_6_am_charges_for_vehicle: totalBefore6amVehicle,
          total_after_8_pm_charges_for_driver: totalAfter8pmDriver,
          total_after_8_pm_charges_for_vehicle: totalAfter8pmVehicle,
          total_toll_charges: totalTollCharges,
          total_parking_charges: totalParkingCharges,
          total_permit_charges: totalPermitCharges,
          vehicle_total_amount: vehicleTotalAmount,
          vehicle_gst_amount: vehicleGstAmount,
          vendor_margin_amount: vendorMarginAmount,
          vendor_margin_gst_amount: vendorMarginGstAmount,
          vehicle_grand_total: vehicleGrandTotalNum,
          updatedon: new Date(),
        },
      });
      this.writeLog(`[vehiclesEngine] Updated eligible ${eligible.itinerary_plan_vendor_eligible_ID} with toll=${totalTollCharges}, permit=${totalPermitCharges}, rental=${totalRentalCharges}, kms=${totalKms}, allowed_kms=${totalAllowedKms}, extra_kms=${totalExtraOutstationKms}, local_allowed=${totalAllowedLocalKms}, local_extra=${totalExtraLocalKms}, local_extra_charge=${totalExtraLocalKmsCharge}`);
    }

    // Re-assign cheapest vendors AFTER final totals update.
    // Earlier assignment can be based on provisional totals before toll/permit recalculation.
    for (const [planVehicleTypeId, requiredCount] of requiredCountByType.entries()) {
      await tx.dvi_itinerary_plan_vendor_eligible_list.updateMany({
        where: {
          itinerary_plan_id: planId,
          vehicle_type_id: planVehicleTypeId,
          status: 1,
          deleted: 0,
        },
        data: { itineary_plan_assigned_status: 0 },
      });

      const finalPicks = await tx.dvi_itinerary_plan_vendor_eligible_list.findMany({
        where: {
          itinerary_plan_id: planId,
          vehicle_type_id: planVehicleTypeId,
          vehicle_grand_total: { gt: 0 },
          status: 1,
          deleted: 0,
        },
        orderBy: [
          { vehicle_grand_total: "asc" },
          { itinerary_plan_vendor_eligible_ID: "asc" },
        ],
        take: Math.max(0, requiredCount),
        select: { itinerary_plan_vendor_eligible_ID: true, vehicle_grand_total: true },
      });

      const finalIds = finalPicks
        .map((p: any) => Number(p.itinerary_plan_vendor_eligible_ID || 0))
        .filter((id: number) => id > 0);

      if (finalIds.length > 0) {
        await tx.dvi_itinerary_plan_vendor_eligible_list.updateMany({
          where: { itinerary_plan_vendor_eligible_ID: { in: finalIds } },
          data: { itineary_plan_assigned_status: 1 },
        });

        this.writeLog(
          `[vehiclesEngine] Final cheapest assigned for vehicle_type_id=${planVehicleTypeId}: ids=[${finalIds.join(',')}]`,
        );
      }
    }

    return { planId, inserted };
  }
}



