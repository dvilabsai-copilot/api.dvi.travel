import { PrismaClient } from "@prisma/client";
import { SameCityCrossDayOptimizerService } from "../src/modules/itineraries/services/same-city-cross-day-optimizer.service";
import {
  clusterMovableHotspotsByDistance,
  isMovableAutoRouteHotspot,
  safeNumber,
  type MovableHotspotPoint,
} from "../src/modules/itineraries/services/same-city-cross-day-optimizer.shared";

type Args = Record<string, string>;

type RouteRow = {
  itinerary_route_ID: number;
  itinerary_plan_ID: number;
  no_of_days: number;
  itinerary_route_date: Date | string | null;
  location_name: string | null;
  next_visiting_location: string | null;
  route_start_time: Date | string | null;
  route_end_time: Date | string | null;
  direct_to_next_visiting_place: number;
  excluded_hotspot_ids: unknown;
  status?: number;
  deleted?: number;
};

type RouteHotspotRow = {
  route_hotspot_ID: number;
  itinerary_route_ID: number;
  hotspot_ID: number;
  hotspot_name?: string | null;
  hotspot_priority?: number | null;
  hotspot_plan_own_way: number;
  item_type: number;
  hotspot_order: number;
  hotspot_start_time: Date | string | null;
  hotspot_end_time: Date | string | null;
  hotspot_traveling_time: Date | string | null;
  hotspot_travelling_distance?: string | null;
  deleted?: number;
  status?: number;
};

type HotspotMasterRow = {
  hotspot_ID: number;
  hotspot_name: string | null;
  hotspot_priority: number | null;
  hotspot_latitude: number | string | null;
  hotspot_longitude: number | string | null;
  hotspot_duration: Date | string | null;
  hotspot_location: string | null;
  hotspot_to_location: string | null;
  city_boundaries?: string | null;
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

function formatClock(value: Date | string | null | undefined): string {
  if (!value) return "N/A";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${String(displayHour).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

function toDurationMinutes(value: Date | string | null | undefined): number {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  return (hours * 60) + minutes;
}

function formatDistance(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${value.toFixed(2)} km`;
}

function buildPlanTitle(planId: number, quoteId: string | null): string {
  return [planId > 0 ? `plan ${planId}` : null, quoteId ? `quote ${quoteId}` : null].filter(Boolean).join(" / ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const previousEnabled = process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER;
  const previousDryRun = process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN;
  const previousApply = process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY;

  process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER = "true";
  process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN = "true";
  process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY = "false";

  try {
    const quoteId = String(args.quoteId || args.quote || "DVI20260798").trim();
    let planId = Number(args.planId || 0);

    if (!Number.isFinite(planId) || planId <= 0) {
      const plan = await prisma.dvi_itinerary_plan_details.findFirst({
        where: { itinerary_quote_ID: quoteId, deleted: 0 },
        select: { itinerary_plan_ID: true, itinerary_quote_ID: true },
      });
      if (!plan) {
        throw new Error(`Quote ${quoteId} was not found`);
      }
      planId = Number(plan.itinerary_plan_ID || 0);
    }

    const plan = await prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      select: {
        itinerary_plan_ID: true,
        itinerary_quote_ID: true,
        arrival_location: true,
        departure_location: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
      },
    });

    if (!plan) {
      throw new Error(`Plan ${planId} was not found`);
    }

    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
      orderBy: [{ itinerary_route_ID: "asc" }],
    }) as RouteRow[];

    const routeIds = routes.map((route) => Number(route.itinerary_route_ID || 0));
    const [routeRows, hotspotMasters] = await Promise.all([
      prisma.dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: { in: routeIds },
          deleted: 0,
          status: 1,
        },
        orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
      }) as Promise<RouteHotspotRow[]>,
      prisma.dvi_hotspot_place.findMany({
        where: { deleted: 0, status: 1 },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_priority: true,
          hotspot_latitude: true,
          hotspot_longitude: true,
          hotspot_duration: true,
          hotspot_location: true,
          hotspot_to_location: true,
          city_boundaries: true,
        },
      }) as Promise<HotspotMasterRow[]>,
    ]);

    const hotspotById = new Map<number, HotspotMasterRow>();
    for (const hotspot of hotspotMasters) {
      hotspotById.set(Number(hotspot.hotspot_ID || 0), hotspot);
    }

    const service = new SameCityCrossDayOptimizerService(
      {
        $transaction: async (callback: any) => callback(prisma),
      } as any,
      {
        rebuildRouteHotspots: async () => ({ rebuildSummary: { totalHotspotsScheduled: 0 } }),
      } as any,
    );

    const analysis = await service.analyzePlanId(planId, {
      quoteId: String(plan.itinerary_quote_ID || quoteId || ""),
      dryRun: true,
      maxMoves: Number(args.maxMoves || 10),
    });

    const rowsByRoute = new Map<number, RouteHotspotRow[]>();
    for (const row of routeRows) {
      const routeId = Number(row.itinerary_route_ID || 0);
      if (!rowsByRoute.has(routeId)) rowsByRoute.set(routeId, []);
      rowsByRoute.get(routeId)!.push(row);
    }

    const movablePool: MovableHotspotPoint[] = [];
    for (const snapshot of analysis.routeSnapshots) {
      const routeRowsForRoute = rowsByRoute.get(snapshot.routeId) || [];
      if (snapshot.transferOnly) continue;
      for (const row of routeRowsForRoute) {
        const hotspot = hotspotById.get(Number(row.hotspot_ID || 0));
        if (!hotspot) continue;
        if (!isMovableAutoRouteHotspot(row, hotspot)) continue;

        const lat = safeNumber(hotspot.hotspot_latitude, 0);
        const lon = safeNumber(hotspot.hotspot_longitude, 0);
        if (!lat || !lon) continue;

        movablePool.push({
          routeId: snapshot.routeId,
          routeHotspotId: Number(row.route_hotspot_ID || 0),
          hotspotId: Number(row.hotspot_ID || 0),
          hotspotName: String(hotspot.hotspot_name || row.hotspot_name || `Hotspot ${Number(row.hotspot_ID || 0)}`),
          rawPriority: safeNumber(hotspot.hotspot_priority ?? row.hotspot_priority ?? 0, 0),
          point: { lat, lon },
          visitMinutes: toDurationMinutes(hotspot.hotspot_duration),
        });
      }
    }

    const clusters = clusterMovableHotspotsByDistance(movablePool, 5, 7);
    const feasibleAllocationExists =
      analysis.proposedMoves.length > 0 &&
      (analysis.allocationPlan?.unallocatedHotspotIds.length || 0) === 0 &&
      !analysis.skippedReason;

    console.log(`Same-city cross-day allocation debug for ${buildPlanTitle(planId, String(plan.itinerary_quote_ID || quoteId || ""))}`);
    console.log(`Plan window: ${formatClock(plan.trip_start_date_and_time)} -> ${formatClock(plan.trip_end_date_and_time)}`);
    console.log(`Arrival: ${String(plan.arrival_location || "N/A")}`);
    console.log(`Departure: ${String(plan.departure_location || "N/A")}`);
    console.log("");
    console.log(`Optimizer enabled: ${analysis.enabled ? "yes" : "no"}`);
    console.log(`Dry-run default: ${analysis.dryRunDefault ? "yes" : "no"}`);
    console.log(`Applied: ${analysis.applied ? "yes" : "no"}`);
    console.log(`Feasible allocation exists: ${feasibleAllocationExists ? "yes" : "no"}`);
    if (analysis.skippedReason) {
      console.log(`Skip reason: ${analysis.skippedReason}`);
    }
    console.log("");

    console.log("Route snapshots:");
    for (const snapshot of analysis.routeSnapshots) {
      console.log(
        `- Route ${snapshot.routeId} day ${snapshot.dayNo} | ${snapshot.source} -> ${snapshot.destination} | cityKey=${snapshot.cityKey || "N/A"} | transferOnly=${snapshot.transferOnly ? "yes" : "no"} | auto=${snapshot.autoHotspotCount} | manual=${snapshot.manualHotspotCount} | total=${snapshot.totalHotspotCount}`,
      );
    }
    console.log("");

    console.log("Production proposals:");
    if (analysis.proposedMoves.length === 0) {
      console.log("- none");
    } else {
      for (const move of analysis.proposedMoves) {
        console.log(
          `- Move ${move.hotspotName} from route ${move.fromRouteId} to route ${move.toRouteId} beside ${move.anchorHotspotName || "N/A"} | raw priority ${move.rawPriority} | score ${Number.isFinite(move.score) ? move.score.toFixed(0) : "N/A"} | distance ${formatDistance(move.distanceKm)}`,
        );
        console.log(`  Reason: ${move.reason}`);
        if (move.clusterMemberNames?.length) {
          console.log(`  Cluster members: ${move.clusterMemberNames.join(", ")}`);
        }
      }
    }
    console.log("");

    console.log("Allocation plan:");
    if (!analysis.allocationPlan) {
      console.log("- none");
    } else {
      console.log(`- City group: ${analysis.allocationPlan.cityGroupId || "N/A"}`);
      for (const [routeId, anchors] of Object.entries(analysis.allocationPlan.fixedAnchorsByRoute)) {
        console.log(`- Route ${routeId} fixed anchors: ${anchors.map((anchor) => `${anchor.hotspotId}(${anchor.reason})`).join(", ") || "none"}`);
      }
      for (const [routeId, ids] of Object.entries(analysis.allocationPlan.desiredMovableHotspotIdsByRoute)) {
        console.log(`- Route ${routeId} desired movable hotspot IDs: ${ids.join(", ") || "none"}`);
      }
      for (const [routeId, order] of Object.entries(analysis.allocationPlan.desiredMovableOrderByRoute)) {
        console.log(`- Route ${routeId} desired movable order: ${order.join(", ") || "none"}`);
      }
      for (const [routeId, pairs] of Object.entries(analysis.allocationPlan.preferredAdjacencyPairsByRoute)) {
        console.log(`- Route ${routeId} preferred adjacency pairs: ${pairs.map(([a, b]) => `${a}-${b}`).join(", ") || "none"}`);
      }
      console.log(`- Unallocated hotspot IDs: ${analysis.allocationPlan.unallocatedHotspotIds.join(", ") || "none"}`);
      if (analysis.allocationPlan.rejectedAllocations.length > 0) {
        for (const rejected of analysis.allocationPlan.rejectedAllocations) {
          console.log(`- Rejected ${rejected.hotspotId} (${rejected.hotspotName}): ${rejected.reason}`);
        }
      }
    }
    console.log("");

    console.log("Cluster summaries:");
    if (clusters.length === 0) {
      console.log("- none");
    } else {
      for (const cluster of clusters) {
        console.log(
          `- ${cluster.clusterId}: members=${cluster.memberNames.join(", ") || "none"} | routes=${cluster.routeIds.join(", ") || "none"} | maxPair=${formatDistance(cluster.maxPairDistanceKm)} | totalVisit=${cluster.totalVisitMinutes}m`,
        );
        for (const pair of cluster.pairDistances) {
          console.log(`  - ${pair.hotspotNameA} <-> ${pair.hotspotNameB}: ${formatDistance(pair.distanceKm)}`);
        }
      }
    }
    console.log("");

    console.log("Current movable pool gaps:");
    if (movablePool.length === 0) {
      console.log("- no movable hotspots were found");
    } else {
      for (const member of movablePool) {
        console.log(
          `- ${member.hotspotName} on route ${member.routeId} | hotspot ${member.hotspotId} | priority ${member.rawPriority} | visit ${member.visitMinutes || 0}m`,
        );
      }
    }
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER;
    } else {
      process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER = previousEnabled;
    }
    if (previousDryRun === undefined) {
      delete process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN;
    } else {
      process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN = previousDryRun;
    }
    if (previousApply === undefined) {
      delete process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY;
    } else {
      process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY = previousApply;
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
