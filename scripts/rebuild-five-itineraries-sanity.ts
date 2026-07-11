import { PrismaClient } from "@prisma/client";
import { SameCityCrossDayOptimizerService } from "../src/modules/itineraries/services/same-city-cross-day-optimizer.service";

type Args = Record<string, string>;

type PlanRow = {
  itinerary_plan_ID: number;
  agent_id: number;
  staff_id: number;
  location_id: bigint | number | string;
  arrival_location: string | null;
  departure_location: string | null;
  itinerary_quote_ID: string | null;
  trip_start_date_and_time: Date | string | null;
  trip_end_date_and_time: Date | string | null;
  arrival_type: number;
  departure_type: number;
  expecting_budget: number;
  itinerary_type: number;
  entry_ticket_required: number;
  no_of_routes: number;
  no_of_days: number;
  no_of_nights: number;
  total_adult: number;
  total_children: number;
  total_infants: number;
  nationality: number;
  itinerary_preference: number;
  meal_plan_breakfast: number;
  meal_plan_lunch: number;
  meal_plan_dinner: number;
  preferred_room_count: number | null;
  total_extra_bed: number;
  total_child_with_bed: number;
  total_child_without_bed: number;
  guide_for_itinerary: number;
  food_type: number;
  special_instructions: string | null;
  // Some environments expose only trip_start_date_and_time, so keep this optional.
  pick_up_date_and_time?: Date | string | null;
  preferred_hotel_category: string | null;
  hotel_facilities: string | null;
  meal_plan_code: string | null;
  status?: number;
  deleted?: number;
};

type RouteRow = {
  itinerary_route_ID: number;
  itinerary_plan_ID: number;
  location_name: string | null;
  next_visiting_location: string | null;
  itinerary_route_date: Date | string | null;
  no_of_days: number;
  no_of_km: string | number | null;
  direct_to_next_visiting_place: number;
  via_route?: string | null;
  route_start_time?: Date | string | null;
  route_end_time?: Date | string | null;
  excluded_hotspot_ids?: unknown;
  status?: number;
  deleted?: number;
};

type ViaRouteRow = {
  itinerary_route_ID: number;
  itinerary_via_location_ID: number;
  itinerary_via_location_name: string;
};

type VehicleRow = {
  vehicle_details_ID: number;
  vehicle_type_id: number;
  vehicle_count: number;
};

type TravellerRow = {
  traveller_details_ID: number;
  room_id: number;
  traveller_type: number;
  traveller_age: string | null;
  child_bed_type: number;
};

type HotspotRow = {
  route_hotspot_ID: number;
  itinerary_route_ID: number;
  hotspot_ID: number;
  hotspot_order: number;
  item_type: number;
  hotspot_plan_own_way: number;
  hotspot_name?: string | null;
};

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.split("=", 2);
    const key = rawKey.replace(/^--/, "").trim();
    if (!key) continue;
    if (inlineValue !== undefined) {
      result[key] = inlineValue.trim();
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next.trim();
      index += 1;
    } else {
      result[key] = "true";
    }
  }
  return result;
}

function toLocalIso(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function parseCsvList(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumberList(value: string | null | undefined): number[] {
  return parseCsvList(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function fmtRouteRows(rows: HotspotRow[], hotspotNames: Map<number, string>): string {
  return rows
    .filter((row) => Number(row.item_type || 0) === 4)
    .map((row) => hotspotNames.get(Number(row.hotspot_ID || 0)) || `#${row.hotspot_ID}`)
    .join(" > ");
}

function buildRouteHotspotSignature(
  routes: RouteRow[],
  rowsByRoute: Map<number, HotspotRow[]>,
  hotspotNames: Map<number, string>,
) {
  return routes.map((route) => ({
    day: Number(route.no_of_days || 0),
    routeId: Number(route.itinerary_route_ID || 0),
    from: String(route.location_name || ""),
    to: String(route.next_visiting_location || ""),
    hotspots: fmtRouteRows(rowsByRoute.get(Number(route.itinerary_route_ID || 0)) || [], hotspotNames),
  }));
}

function buildPayload(
  plan: PlanRow,
  routes: RouteRow[],
  viaRoutes: ViaRouteRow[],
  vehicles: VehicleRow[],
  travellers: TravellerRow[],
  specialInstructionsSuffix: string,
) {
  const viaByRoute = new Map<number, ViaRouteRow[]>();
  for (const via of viaRoutes) {
    const routeId = Number(via.itinerary_route_ID || 0);
    if (!viaByRoute.has(routeId)) viaByRoute.set(routeId, []);
    viaByRoute.get(routeId)!.push(via);
  }

  return {
    plan: {
      itinerary_plan_id: Number(plan.itinerary_plan_ID || 0),
      agent_id: Number(plan.agent_id || 0),
      staff_id: Number(plan.staff_id || 0),
      location_id: Number(plan.location_id || 0),
      arrival_point: String(plan.arrival_location || ""),
      departure_point: String(plan.departure_location || ""),
      itinerary_preference: Number(plan.itinerary_preference || 0),
      itinerary_type: Number(plan.itinerary_type || 0),
      preferred_hotel_category: parseNumberList(plan.preferred_hotel_category),
      hotel_facilities: parseCsvList(plan.hotel_facilities),
      trip_start_date: toLocalIso(plan.trip_start_date_and_time),
      trip_end_date: toLocalIso(plan.trip_end_date_and_time),
      pick_up_date_and_time: toLocalIso(plan.pick_up_date_and_time || plan.trip_start_date_and_time),
      arrival_type: Number(plan.arrival_type || 0),
      departure_type: Number(plan.departure_type || 0),
      no_of_nights: Number(plan.no_of_nights || 0),
      no_of_days: Number(plan.no_of_days || routes.length),
      budget: Number(plan.expecting_budget || 0),
      entry_ticket_required: Number(plan.entry_ticket_required || 0),
      guide_for_itinerary: Number(plan.guide_for_itinerary || 0),
      nationality: Number(plan.nationality || 0),
      food_type: Number(plan.food_type || 0),
      meal_plan_breakfast: Number(plan.meal_plan_breakfast || 0),
      meal_plan_lunch: Number(plan.meal_plan_lunch || 0),
      meal_plan_dinner: Number(plan.meal_plan_dinner || 0),
      adult_count: Number(plan.total_adult || 0),
      child_count: Number(plan.total_children || 0),
      infant_count: Number(plan.total_infants || 0),
      special_instructions: `${String(plan.special_instructions || "")}${specialInstructionsSuffix}`,
      meal_plan_code: plan.meal_plan_code || undefined,
    },
    routes: routes.map((route) => ({
      itinerary_route_id: Number(route.itinerary_route_ID || 0),
      location_name: String(route.location_name || ""),
      next_visiting_location: String(route.next_visiting_location || ""),
      itinerary_route_date: toLocalIso(route.itinerary_route_date),
      no_of_days: Number(route.no_of_days || 0),
      no_of_km: String(route.no_of_km ?? "0"),
      direct_to_next_visiting_place: Number(route.direct_to_next_visiting_place || 0),
      via_route: String(route.via_route || ""),
      via_routes: (viaByRoute.get(Number(route.itinerary_route_ID || 0)) || []).map((via) => ({
        itinerary_via_location_ID: Number(via.itinerary_via_location_ID || 0),
        itinerary_via_location_name: String(via.itinerary_via_location_name || ""),
      })),
      route_start_time: toLocalIso(route.route_start_time).slice(11, 19) || undefined,
      route_end_time: toLocalIso(route.route_end_time).slice(11, 19) || undefined,
    })),
    vehicles: vehicles.map((vehicle) => ({
      vehicle_details_id: Number(vehicle.vehicle_details_ID || 0),
      vehicle_type_id: Number(vehicle.vehicle_type_id || 0),
      vehicle_count: Number(vehicle.vehicle_count || 0),
    })),
    travellers: travellers.map((traveller) => ({
      room_id: Number(traveller.room_id || 0),
      traveller_type: Number(traveller.traveller_type || 0),
      traveller_age: traveller.traveller_age ?? undefined,
      child_bed_type: Number(traveller.child_bed_type || 0),
    })),
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const planIds = (args.planIds || "9676,309,7,21,347")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  const prisma = new PrismaClient();
  const token = String(
    process.env.REGRESSION_BEARER_TOKEN ||
    process.env.DVI_JWT_TOKEN ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODMxOTQxNzMsImV4cCI6MTc4Mzc5ODk3M30.YKoeQHCI9qIpV33Nn27pqP_ArqtuNkXanrhzHhxyPg4",
  ).trim();

  process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER = "true";
  process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN = "true";
  process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY = "false";

  const optimizer = new SameCityCrossDayOptimizerService(
    {
      $transaction: async (fn: any, _opts?: any) => fn(prisma),
    } as any,
    {
      rebuildRouteHotspots: async () => ({ rebuildSummary: { totalHotspotsScheduled: 0 } }),
    } as any,
  );

  try {
    const hotspotMasters = await prisma.dvi_hotspot_place.findMany({
      where: { deleted: 0, status: 1 },
      select: { hotspot_ID: true, hotspot_name: true },
    });
    const hotspotNameById = new Map<number, string>(
      hotspotMasters.map((row) => [Number(row.hotspot_ID || 0), String(row.hotspot_name || "")]),
    );

    const summaries: Array<any> = [];

    for (const planId of planIds) {
      const plan = await prisma.dvi_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: planId, deleted: 0 },
      }) as PlanRow | null;

      if (!plan) {
        summaries.push({ planId, error: "plan not found" });
        continue;
      }

      const [routes, viaRoutes, vehicles, travellers, beforeHotspots] = await Promise.all([
        prisma.dvi_itinerary_route_details.findMany({
          where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
          orderBy: [{ no_of_days: "asc" }, { itinerary_route_ID: "asc" }],
        }) as Promise<RouteRow[]>,
        prisma.dvi_itinerary_via_route_details.findMany({
          where: { itinerary_plan_ID: planId, deleted: 0 },
          orderBy: [{ itinerary_route_ID: "asc" }, { itinerary_via_route_ID: "asc" }],
        }) as Promise<ViaRouteRow[]>,
        prisma.dvi_itinerary_plan_vehicle_details.findMany({
          where: { itinerary_plan_id: planId, deleted: 0 },
          orderBy: { vehicle_details_ID: "asc" },
        }) as Promise<VehicleRow[]>,
        prisma.dvi_itinerary_traveller_details.findMany({
          where: { itinerary_plan_ID: planId, deleted: 0 },
          orderBy: { traveller_details_ID: "asc" },
        }) as Promise<TravellerRow[]>,
        prisma.dvi_itinerary_route_hotspot_details.findMany({
          where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
          orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
        }) as Promise<HotspotRow[]>,
      ]);

      const beforeByRoute = new Map<number, HotspotRow[]>();
      for (const row of beforeHotspots) {
        const routeId = Number(row.itinerary_route_ID || 0);
        if (!beforeByRoute.has(routeId)) beforeByRoute.set(routeId, []);
        beforeByRoute.get(routeId)!.push(row);
      }

      const dryRun = await optimizer.analyzePlanId(planId, {
        quoteId: String(plan.itinerary_quote_ID || ""),
        dryRun: true,
        maxMoves: Number(args.maxMoves || 10),
      });

      const payload = buildPayload(
        plan,
        routes,
        viaRoutes,
        vehicles,
        travellers,
        ` [sanity-rebuild ${new Date().toISOString()}]`,
      );

      const beforeSignature = buildRouteHotspotSignature(routes, beforeByRoute, hotspotNameById);

      const response = await fetch("http://127.0.0.1:4006/api/v1/itineraries/?type=itineary_basic_info", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const responseText = await response.text();
      let responseJson: any = null;
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        responseJson = { rawText: responseText };
      }

      const [afterRoutes, afterHotspots] = await Promise.all([
        prisma.dvi_itinerary_route_details.findMany({
          where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
          orderBy: [{ no_of_days: "asc" }, { itinerary_route_ID: "asc" }],
        }) as Promise<RouteRow[]>,
        prisma.dvi_itinerary_route_hotspot_details.findMany({
          where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
          orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
        }) as Promise<HotspotRow[]>,
      ]);
      const afterByRoute = new Map<number, HotspotRow[]>();
      for (const row of afterHotspots) {
        const routeId = Number(row.itinerary_route_ID || 0);
        if (!afterByRoute.has(routeId)) afterByRoute.set(routeId, []);
        afterByRoute.get(routeId)!.push(row);
      }

      const afterSignature = buildRouteHotspotSignature(afterRoutes, afterByRoute, hotspotNameById);
      const changedRoutes = beforeSignature
        .map((beforeRoute) => {
          const afterRoute = afterSignature.find((candidate) => candidate.day === beforeRoute.day);
          if (!afterRoute) return beforeRoute.day;
          return beforeRoute.hotspots !== afterRoute.hotspots ? beforeRoute.day : null;
        })
        .filter((value): value is number => value !== null);

      summaries.push({
        planId,
        quoteId: String(plan.itinerary_quote_ID || ""),
        status: response.status,
        routeIdRemap: beforeSignature.map((beforeRoute) => {
          const afterRoute = afterSignature.find((candidate) => candidate.day === beforeRoute.day);
          return {
            day: beforeRoute.day,
            beforeRouteId: beforeRoute.routeId,
            afterRouteId: afterRoute?.routeId ?? null,
          };
        }),
        beforeRoutes: beforeSignature,
        afterRoutes: afterSignature,
        changedRoutes,
        proposedMoves: dryRun.proposedMoves.map((move) => ({
          hotspotName: move.hotspotName,
          fromRouteId: move.fromRouteId,
          toRouteId: move.toRouteId,
          anchorHotspotName: move.anchorHotspotName,
        })),
        skippedReason: dryRun.skippedReason,
        applied: responseJson?.applied ?? null,
        responseMessage: responseJson?.message ?? responseJson?.status ?? null,
      });
    }

    console.log(JSON.stringify({ summaries }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
