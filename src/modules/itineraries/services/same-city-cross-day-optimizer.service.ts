import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma.service";
import { HotspotEngineService } from "../engines/hotspot-engine.service";
import { TimeConverter } from "../engines/helpers/time-converter";
import {
  buildContiguousSameCityGroups,
  clusterMovableHotspotsByDistance,
  haversineKm,
  MovableHotspotCluster,
  MovableHotspotPoint,
  isFixedRouteHotspot,
  isMovableAutoRouteHotspot,
  isManualRouteHotspot,
  isTerminalLocation,
  normalizeRouteCityKey,
  safeDurationMinutes,
  safeNumber,
} from "./same-city-cross-day-optimizer.shared";

type Tx = Prisma.TransactionClient;

type RouteRecord = {
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
};

type RouteHotspotRecord = {
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

type HotspotMasterRecord = {
  hotspot_ID: number;
  hotspot_name: string | null;
  hotspot_location: string | null;
  hotspot_to_location: string | null;
  hotspot_priority: number | null;
  hotspot_duration: Date | string | null;
  hotspot_latitude: number | string | null;
  hotspot_longitude: number | string | null;
};

export type CrossDayOptimizerMove = {
  fromRouteId: number;
  toRouteId: number;
  hotspotId: number;
  routeHotspotId: number;
  hotspotName: string;
  rawPriority: number;
  hotspotOrder: number;
  reason: string;
  score: number;
  anchorHotspotId?: number;
  anchorHotspotName?: string | null;
  distanceKm?: number | null;
  direction?: "FORWARD" | "BACKWARD";
  sourceRouteHotspotCount?: number;
  targetRouteHotspotCount?: number;
  clusterId?: string;
  clusterMemberNames?: string[];
  clusterMemberHotspotIds?: number[];
  targetRouteClusterCount?: number;
};

export type CrossDayOptimizerRouteSnapshot = {
  routeId: number;
  dayNo: number;
  source: string;
  destination: string;
  cityKey: string;
  isSameCity: boolean;
  isTerminalDestination: boolean;
  transferOnly: boolean;
  startTime: string;
  endTime: string;
  autoHotspotCount: number;
  manualHotspotCount: number;
  totalHotspotCount: number;
  excludedHotspotIds: number[];
};

export type CrossDayOptimizerAnalysis = {
  enabled: boolean;
  dryRunDefault: boolean;
  planId: number;
  quoteId: string | null;
  routeSnapshots: CrossDayOptimizerRouteSnapshot[];
  proposedMoves: CrossDayOptimizerMove[];
  allocationPlan: SameCityAllocationPlan | null;
  applied: boolean;
  skippedReason: string | null;
  affectedRouteIds: number[];
  beforeCounts: Record<number, number>;
  afterCounts: Record<number, number> | null;
};

export type SameCityAllocationPlan = {
  cityGroupId: string;
  fixedAnchorsByRoute: Record<number, Array<{
    routeHotspotId: number;
    hotspotId: number;
    routeId: number;
    itemType: number;
    order: number;
    startSeconds: number;
    endSeconds: number;
    originalStartTime: string;
    originalEndTime: string;
    reason: string;
  }>>;
  desiredMovableHotspotIdsByRoute: Record<number, number[]>;
  desiredMovableOrderByRoute: Record<number, number[]>;
  preferredAdjacencyPairsByRoute: Record<number, Array<[number, number]>>;
  unallocatedHotspotIds: number[];
  rejectedAllocations: Array<{
    hotspotId: number;
    hotspotName: string;
    reason: string;
  }>;
};

@Injectable()
export class SameCityCrossDayOptimizerService {
  private readonly logger = new Logger(SameCityCrossDayOptimizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
  ) {}

  private isEnabled(): boolean {
    return true;
  }

  private isDryRunDefault(): boolean {
    return true;
  }

  private normalizeRouteCity(source: string | null | undefined, destination: string | null | undefined): string {
    return normalizeRouteCityKey(source, destination);
  }

  private toTimeString(value: Date | string | null | undefined, fallback = "00:00:00"): string {
    if (typeof value === "string" && value.trim()) {
      return TimeConverter.toTimeString(value.trim());
    }
    if (value instanceof Date) {
      return TimeConverter.toTimeString(value);
    }
    return fallback;
  }

  private toSeconds(value: Date | string | null | undefined): number {
    const time = this.toTimeString(value, "00:00:00");
    const [h, m, s] = time.split(":").map((part) => Number(part || 0));
    return (h * 3600) + (m * 60) + s;
  }

  private formatTime(value: Date | string | null | undefined): string {
    const time = this.toTimeString(value, "00:00:00");
    return time;
  }

  private toDurationMinutes(value: Date | string | null | undefined): number {
    return Math.max(0, Math.floor(this.toSeconds(value) / 60));
  }

  private parseExcluded(value: unknown): number[] {
    if (Array.isArray(value)) {
      return value.map((item) => Number(item || 0)).filter((item) => Number.isFinite(item) && item > 0);
    }
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        return this.parseExcluded(parsed);
      } catch {
        return [];
      }
    }
    return [];
  }

  private getEffectivePriority(row: RouteHotspotRecord, hotspot?: HotspotMasterRecord | null): number {
    const rawPriority = Number(
      hotspot?.hotspot_priority ??
      row?.hotspot_priority ??
      0,
    );

    if (Number(row?.hotspot_plan_own_way || 0) === 1) {
      return 4;
    }
    if (!Number.isFinite(rawPriority) || rawPriority === 0) {
      return 9999;
    }
    return rawPriority;
  }

  private buildRouteLoad(route: RouteRecord, rows: RouteHotspotRecord[]): CrossDayOptimizerRouteSnapshot {
    const selectedRows = rows.filter((row) => Number(row.deleted || 0) !== 1 && Number(row.status || 1) !== 0);
    const autoRows = selectedRows.filter((row) => Number(row.item_type || 0) === 4 && Number(row.hotspot_plan_own_way || 0) !== 1);
    const manualRows = selectedRows.filter((row) => Number(row.item_type || 0) === 4 && Number(row.hotspot_plan_own_way || 0) === 1);
    const excludedHotspotIds = this.parseExcluded(route.excluded_hotspot_ids);
    const source = String(route.location_name || "").trim();
    const destination = String(route.next_visiting_location || "").trim();
    const cityKey = this.normalizeRouteCity(source, destination);
    const hasTransferRow = rows.some((row) => Number(row.item_type || 0) === 7);
    const transferOnly =
      hasTransferRow &&
      isTerminalLocation(destination) &&
      selectedRows.filter((row) => Number(row.item_type || 0) === 4).length === 0;

    return {
      routeId: Number(route.itinerary_route_ID || 0),
      dayNo: Number(route.no_of_days || 0),
      source,
      destination,
      cityKey,
      isSameCity: Boolean(cityKey),
      isTerminalDestination: isTerminalLocation(destination),
      transferOnly,
      startTime: this.formatTime(route.route_start_time),
      endTime: this.formatTime(route.route_end_time),
      autoHotspotCount: autoRows.length,
      manualHotspotCount: manualRows.length,
      totalHotspotCount: autoRows.length + manualRows.length,
      excludedHotspotIds,
    };
  }

  private getHotspotPoint(hotspot?: HotspotMasterRecord | null): { lat: number; lon: number } | null {
    const lat = safeNumber(hotspot?.hotspot_latitude, 0);
    const lon = safeNumber(hotspot?.hotspot_longitude, 0);
    if (!lat || !lon) return null;
    return { lat, lon };
  }

  private getRouteClusterPriorityScore(
    routeId: number,
    cluster: MovableHotspotCluster,
    rowsByRoute: Map<number, RouteHotspotRecord[]>,
    hotspotMasterById: Map<number, HotspotMasterRecord>,
  ): number {
    const routeRows = rowsByRoute.get(routeId) || [];
    const partition = this.classifyRouteHotspots(routeRows, hotspotMasterById);
    const clusterMemberCount = cluster.members.filter((member) => Number(member.routeId || 0) === routeId).length;
    const fixedAnchorCount = partition.fixedRows.length;
    const movableCount = partition.movableRows.length;
    const sameRouteBonus = clusterMemberCount * 2000;
    const movablePoolBonus = movableCount * 100;
    const anchorBonus = fixedAnchorCount * 50;
    const balanceBonus = Math.max(0, 10 - movableCount) * 25;
    return sameRouteBonus + movablePoolBonus + anchorBonus + balanceBonus;
  }

  private buildClusterProposal(
    cluster: MovableHotspotCluster,
    rowsByRoute: Map<number, RouteHotspotRecord[]>,
    hotspotMasterById: Map<number, HotspotMasterRecord>,
  ): CrossDayOptimizerMove | null {
    const memberRouteIds = Array.from(new Set(cluster.members.map((member) => Number(member.routeId || 0)).filter((id) => id > 0)));
    if (memberRouteIds.length < 2) return null;

    const targetRouteId = memberRouteIds
      .map((routeId) => ({
        routeId,
        score: this.getRouteClusterPriorityScore(routeId, cluster, rowsByRoute, hotspotMasterById),
      }))
      .sort((a, b) => b.score - a.score || a.routeId - b.routeId)[0]?.routeId || 0;

    if (!targetRouteId) return null;

    const sourceMembers = cluster.members
      .filter((member) => Number(member.routeId || 0) !== targetRouteId)
      .sort((a, b) => a.rawPriority - b.rawPriority || a.routeHotspotId - b.routeHotspotId);

    const targetMembers = cluster.members.filter((member) => Number(member.routeId || 0) === targetRouteId);
    if (sourceMembers.length === 0 || targetMembers.length === 0) return null;

    let bestSource = sourceMembers[0];
    let bestAnchor: MovableHotspotPoint | null = null;
    let bestDistanceKm = Number.POSITIVE_INFINITY;

    for (const sourceMember of sourceMembers) {
      for (const targetMember of targetMembers) {
        const distanceKm = haversineKm(sourceMember.point, targetMember.point);
        if (distanceKm == null || !Number.isFinite(distanceKm)) continue;
        if (distanceKm < bestDistanceKm) {
          bestDistanceKm = distanceKm;
          bestSource = sourceMember;
          bestAnchor = targetMember;
        }
      }
    }

    if (!bestAnchor || !Number.isFinite(bestDistanceKm)) return null;

    const sourcePriorityPenalty = Math.max(0, 500 - bestSource.rawPriority * 25);
    const clusterDensityBonus = cluster.members.length * 1000;
    const routeRetentionBonus = this.getRouteClusterPriorityScore(targetRouteId, cluster, rowsByRoute, hotspotMasterById);
    const distanceScore = Math.max(0, Math.round((15 - bestDistanceKm) * 1000));
    const score = 20000 + clusterDensityBonus + routeRetentionBonus + distanceScore - sourcePriorityPenalty;

    return {
      fromRouteId: bestSource.routeId,
      toRouteId: targetRouteId,
      hotspotId: bestSource.hotspotId,
      routeHotspotId: bestSource.routeHotspotId,
      hotspotName: bestSource.hotspotName,
      rawPriority: bestSource.rawPriority,
      hotspotOrder: 0,
      reason: [
        `cluster ${cluster.clusterId} with ${cluster.members.length} movable hotspot(s)`,
        `move ${bestSource.hotspotName} beside movable companion ${bestAnchor.hotspotName}`,
        `distance=${bestDistanceKm.toFixed(2)}km`,
        `target route cluster count=${targetMembers.length}`,
      ].join("; "),
      score,
      anchorHotspotId: bestAnchor.hotspotId,
      anchorHotspotName: bestAnchor.hotspotName,
      distanceKm: bestDistanceKm,
      direction: bestSource.routeId <= targetRouteId ? "FORWARD" : "BACKWARD",
      sourceRouteHotspotCount: rowsByRoute.get(bestSource.routeId)?.length || 0,
      targetRouteHotspotCount: rowsByRoute.get(targetRouteId)?.length || 0,
      clusterId: cluster.clusterId,
      clusterMemberNames: cluster.memberNames,
      clusterMemberHotspotIds: cluster.members.map((member) => member.hotspotId),
      targetRouteClusterCount: targetMembers.length,
    };
  }

  private classifyRouteHotspots(
    rows: RouteHotspotRecord[],
    hotspotMasterById: Map<number, HotspotMasterRecord>,
  ): {
    fixedRows: Array<RouteHotspotRecord & { hotspot: HotspotMasterRecord }>;
    movableRows: Array<RouteHotspotRecord & { hotspot: HotspotMasterRecord }>;
    fixedRouteHotspotIds: number[];
    fixedHotspotIds: number[];
  } {
    const fixedRows: Array<RouteHotspotRecord & { hotspot: HotspotMasterRecord }> = [];
    const movableRows: Array<RouteHotspotRecord & { hotspot: HotspotMasterRecord }> = [];
    const fixedRouteHotspotIds: number[] = [];
    const fixedHotspotIds: number[] = [];

    for (const row of rows) {
      if (Number(row.item_type || 0) !== 4) continue;
      const hotspot = hotspotMasterById.get(Number(row.hotspot_ID || 0));
      if (!hotspot) continue;

      if (isFixedRouteHotspot(row, hotspot)) {
        fixedRows.push({ ...row, hotspot });
        fixedRouteHotspotIds.push(Number(row.route_hotspot_ID || 0));
        fixedHotspotIds.push(Number(row.hotspot_ID || 0));
        continue;
      }

      if (isMovableAutoRouteHotspot(row, hotspot)) {
        movableRows.push({ ...row, hotspot });
      }
    }

    return { fixedRows, movableRows, fixedRouteHotspotIds, fixedHotspotIds };
  }

  private buildDirectionalProposal(
    source: CrossDayOptimizerRouteSnapshot,
    target: CrossDayOptimizerRouteSnapshot,
    rowsByRoute: Map<number, RouteHotspotRecord[]>,
    hotspotMasterById: Map<number, HotspotMasterRecord>,
    direction: "FORWARD" | "BACKWARD",
    sourceIndex: number,
    targetIndex: number,
  ): CrossDayOptimizerMove | null {
    if (!source.cityKey || source.cityKey !== target.cityKey) return null;
    if (source.transferOnly || target.transferOnly) return null;

    const sourceRows = rowsByRoute.get(source.routeId) || [];
    const targetRows = rowsByRoute.get(target.routeId) || [];
    const sourcePartition = this.classifyRouteHotspots(sourceRows, hotspotMasterById);
    const targetPartition = this.classifyRouteHotspots(targetRows, hotspotMasterById);

    if (sourcePartition.movableRows.length === 0 || targetPartition.fixedRows.length === 0) return null;

    const targetAnchors = targetPartition.fixedRows
      .map((row) => {
        const point = this.getHotspotPoint(row.hotspot);
        if (!point) return null;
        return {
          row,
          hotspot: row.hotspot,
          point,
          rawPriority: safeNumber(row.hotspot.hotspot_priority ?? row.hotspot_priority ?? 0, 0),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    if (targetAnchors.length === 0) return null;

    const movableCandidates = sourcePartition.movableRows
      .map((row) => {
        const hotspot = row.hotspot;
        const rawPriority = safeNumber(hotspot.hotspot_priority ?? row.hotspot_priority ?? 0, 0);
        if (rawPriority !== 0 || isManualRouteHotspot(row)) return null;

        const sourcePoint = this.getHotspotPoint(hotspot);
        if (!sourcePoint) return null;

        let nearestAnchor = null as null | {
          row: RouteHotspotRecord;
          hotspot: HotspotMasterRecord;
          point: { lat: number; lon: number };
          rawPriority: number;
          distanceKm: number;
        };

        for (const anchor of targetAnchors) {
          const distanceKm = haversineKm(sourcePoint, anchor.point);
          if (distanceKm == null || !Number.isFinite(distanceKm)) continue;
          if (distanceKm > 15) continue;
          if (!nearestAnchor || distanceKm < nearestAnchor.distanceKm) {
            nearestAnchor = {
              row: anchor.row,
              hotspot: anchor.hotspot,
              point: anchor.point,
              rawPriority: anchor.rawPriority,
              distanceKm,
            };
          }
        }

        if (!nearestAnchor) return null;

        const refillPotential = Math.max(0, sourcePartition.movableRows.length - 1);
        const directionScore = direction === "FORWARD" ? 1000 : 0;
        const priorityScore = 10000;
        const proximityScore = Math.max(0, Math.round((15 - nearestAnchor.distanceKm) * 1000));
        const anchorStrengthScore = Number(nearestAnchor.row.hotspot_plan_own_way || 0) === 1
          ? 500
          : Math.max(250, Math.min(1000, nearestAnchor.rawPriority * 25));
        const refillScore = refillPotential * 500;
        const score = priorityScore + proximityScore + anchorStrengthScore + refillScore + directionScore;

        return {
          row,
          hotspot,
          rawPriority,
          sourcePoint,
          nearestAnchor,
          refillPotential,
          score,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.nearestAnchor.distanceKm !== b.nearestAnchor.distanceKm) return a.nearestAnchor.distanceKm - b.nearestAnchor.distanceKm;
        if (a.rawPriority !== b.rawPriority) return a.rawPriority - b.rawPriority;
        return Number(a.row.route_hotspot_ID || 0) - Number(b.row.route_hotspot_ID || 0);
      });

    const best = movableCandidates[0];
    if (!best || !best.hotspot || !best.nearestAnchor) return null;

    const hotspotName = String(best.hotspot.hotspot_name || `Hotspot ${Number(best.row.hotspot_ID || 0)}`).trim();
    const anchorName = String(best.nearestAnchor.hotspot.hotspot_name || `Hotspot ${Number(best.nearestAnchor.row.hotspot_ID || 0)}`).trim();

    return {
      fromRouteId: source.routeId,
      toRouteId: target.routeId,
      hotspotId: Number(best.row.hotspot_ID || 0),
      routeHotspotId: Number(best.row.route_hotspot_ID || 0),
      hotspotName,
      rawPriority: best.rawPriority,
      hotspotOrder: Number(best.row.hotspot_order || 0),
      reason: [
        `same-city pair ${source.routeId} -> ${target.routeId}`,
        `move movable hotspot ${hotspotName} beside fixed anchor ${anchorName}`,
        `distance=${best.nearestAnchor.distanceKm.toFixed(2)}km`,
        `source movable hotspots=${sourcePartition.movableRows.length}`,
        `target fixed anchors=${targetPartition.fixedRows.length}`,
        `refill potential=${best.refillPotential}`,
      ].join("; "),
      score: Number.isFinite(best.score) ? best.score : Number.NEGATIVE_INFINITY,
      anchorHotspotId: Number(best.nearestAnchor.row.hotspot_ID || 0),
      anchorHotspotName: anchorName,
      distanceKm: best.nearestAnchor.distanceKm,
      direction,
      sourceRouteHotspotCount: sourceRows.length,
      targetRouteHotspotCount: targetRows.length,
    };
  }

  private async loadPlanContext(tx: Tx, planId: number) {
    const [plan, routes, allRows] = await Promise.all([
      (tx as any).dvi_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: planId, deleted: 0 },
        select: {
          itinerary_plan_ID: true,
          itinerary_quote_ID: true,
          arrival_location: true,
          departure_location: true,
        },
      }),
      (tx as any).dvi_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
        orderBy: [{ no_of_days: "asc" }, { itinerary_route_ID: "asc" }],
      }),
      (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          deleted: 0,
          status: 1,
        },
        orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
      }),
    ]);

    const hotspotIds = Array.from(
      new Set(
        (allRows as RouteHotspotRecord[])
          .map((row) => Number(row.hotspot_ID || 0))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );

    const hotspotMasters = hotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds }, deleted: 0, status: 1 },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_location: true,
            hotspot_to_location: true,
            hotspot_priority: true,
            hotspot_duration: true,
            hotspot_latitude: true,
            hotspot_longitude: true,
          },
        })
      : [];

    const hotspotMasterById = new Map<number, HotspotMasterRecord>();
    for (const hotspot of hotspotMasters as HotspotMasterRecord[]) {
      hotspotMasterById.set(Number(hotspot.hotspot_ID || 0), hotspot);
    }

    return {
      plan,
      routes: routes as RouteRecord[],
      allRows: allRows as RouteHotspotRecord[],
      hotspotMasterById,
    };
  }

  private buildProposals(
    routes: RouteRecord[],
    rowsByRoute: Map<number, RouteHotspotRecord[]>,
    hotspotMasterById: Map<number, HotspotMasterRecord>,
  ): CrossDayOptimizerMove[] {
    const routeSnapshots = routes.map((route) => {
      const routeRows = rowsByRoute.get(Number(route.itinerary_route_ID || 0)) || [];
      return this.buildRouteLoad(route, routeRows);
    });

    const routePairs = buildContiguousSameCityGroups(routeSnapshots);
    const proposals: CrossDayOptimizerMove[] = [];

    for (const group of routePairs) {
      if (group.length < 2) continue;

      const movablePool: MovableHotspotPoint[] = [];

      for (const snapshot of group) {
        const routeRows = rowsByRoute.get(snapshot.routeId) || [];
        const partition = this.classifyRouteHotspots(routeRows, hotspotMasterById);

        for (const row of partition.movableRows) {
          movablePool.push({
            routeId: snapshot.routeId,
            routeHotspotId: Number(row.route_hotspot_ID || 0),
            hotspotId: Number(row.hotspot_ID || 0),
            hotspotName: String(row.hotspot.hotspot_name || `Hotspot ${Number(row.hotspot_ID || 0)}`).trim(),
            rawPriority: safeNumber(row.hotspot.hotspot_priority ?? row.hotspot_priority ?? 0, 0),
            point: this.getHotspotPoint(row.hotspot) || { lat: 0, lon: 0 },
            visitMinutes: this.toDurationMinutes(row.hotspot.hotspot_duration),
          });
        }
      }

      const clusters = clusterMovableHotspotsByDistance(movablePool, 5, 7);
      for (const cluster of clusters) {
        if (cluster.members.length < 2) continue;
        const proposal = this.buildClusterProposal(cluster, rowsByRoute, hotspotMasterById);
        if (proposal) proposals.push(proposal);
      }

      for (const cluster of clusters) {
        if (cluster.members.length !== 1) continue;
        const member = cluster.members[0];
        const sourceRoute = group.find((route) => route.routeId === member.routeId);
        if (!sourceRoute) continue;

        for (const targetRoute of group) {
          if (targetRoute.routeId === sourceRoute.routeId) continue;
          const fallback = this.buildDirectionalProposal(
            sourceRoute,
            targetRoute,
            rowsByRoute,
            hotspotMasterById,
            "FORWARD",
            0,
            1,
          );
          if (fallback) {
            fallback.reason = `${fallback.reason}; fallback independent movable hotspot`;
            fallback.score = fallback.score - 5000;
            proposals.push(fallback);
          }
        }
      }
    }

    const unique = new Map<string, CrossDayOptimizerMove>();
    for (const proposal of proposals) {
      const key = [
        proposal.fromRouteId,
        proposal.toRouteId,
        proposal.hotspotId,
        proposal.anchorHotspotId || 0,
        proposal.direction || "",
        proposal.clusterId || "",
      ].join("|");
      const existing = unique.get(key);
      if (!existing || existing.score < proposal.score) {
        unique.set(key, proposal);
      }
    }

    return Array.from(unique.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.distanceKm != null && b.distanceKm != null && a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      if (a.rawPriority !== b.rawPriority) return a.rawPriority - b.rawPriority;
      return a.hotspotId - b.hotspotId;
    });
  }

  async analyzeQuoteId(
    quoteId: string,
    options?: {
      dryRun?: boolean;
      maxMoves?: number;
    },
  ): Promise<CrossDayOptimizerAnalysis> {
    const enabled = this.isEnabled();
    const dryRunDefault = this.isDryRunDefault();
    const normalizedQuoteId = String(quoteId || "").trim();

    if (!normalizedQuoteId) {
      throw new BadRequestException("quoteId is required");
    }

    const plan = await (this.prisma as any).dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: normalizedQuoteId, deleted: 0 },
      select: { itinerary_plan_ID: true, itinerary_quote_ID: true },
    });

    if (!plan) {
      throw new BadRequestException(`Quote ${normalizedQuoteId} was not found`);
    }

    return this.analyzePlanId(Number(plan.itinerary_plan_ID || 0), {
      quoteId: normalizedQuoteId,
      dryRun: options?.dryRun ?? dryRunDefault,
      maxMoves: options?.maxMoves,
    });
  }

  async analyzePlanId(
    planId: number,
    options?: {
      quoteId?: string | null;
      dryRun?: boolean;
      maxMoves?: number;
    },
  ): Promise<CrossDayOptimizerAnalysis> {
    const enabled = this.isEnabled();
    const dryRunDefault = this.isDryRunDefault();
    const normalizedPlanId = Number(planId || 0);

    if (!Number.isFinite(normalizedPlanId) || normalizedPlanId <= 0) {
      throw new BadRequestException("planId must be a positive integer");
    }

    const result: CrossDayOptimizerAnalysis = {
      enabled,
      dryRunDefault,
      planId: normalizedPlanId,
      quoteId: options?.quoteId ?? null,
      routeSnapshots: [],
      proposedMoves: [],
      allocationPlan: null,
      applied: false,
      skippedReason: null,
      affectedRouteIds: [],
      beforeCounts: {},
      afterCounts: null,
    };

    const analysis = await this.prisma.$transaction(async (tx) => {
      const { plan, routes, allRows, hotspotMasterById } = await this.loadPlanContext(tx, normalizedPlanId);

      const rowsByRoute = new Map<number, RouteHotspotRecord[]>();
      for (const row of allRows) {
        const routeId = Number(row.itinerary_route_ID || 0);
        if (!rowsByRoute.has(routeId)) rowsByRoute.set(routeId, []);
        rowsByRoute.get(routeId)!.push(row);
      }

      const routeSnapshots = routes.map((route) => {
        const routeRows = rowsByRoute.get(Number(route.itinerary_route_ID || 0)) || [];
        return this.buildRouteLoad(route, routeRows);
      });
      const fixedAnchorByRoute = new Map<number, { routeHotspotIds: number[]; hotspotIds: number[] }>();
      for (const route of routes) {
        const routeId = Number(route.itinerary_route_ID || 0);
        const routeRows = rowsByRoute.get(routeId) || [];
        const partition = this.classifyRouteHotspots(routeRows, hotspotMasterById);
        fixedAnchorByRoute.set(routeId, {
          routeHotspotIds: partition.fixedRouteHotspotIds,
          hotspotIds: partition.fixedHotspotIds,
        });
      }
      const proposedMoves = this.buildProposals(routes, rowsByRoute, hotspotMasterById)
        .filter((move) => Number.isFinite(move.score))
        .slice(0, Math.max(1, Number(options?.maxMoves || 3)));

      const beforeCounts = Object.fromEntries(
        routeSnapshots.map((snapshot) => [snapshot.routeId, snapshot.totalHotspotCount]),
      ) as Record<number, number>;

      const resultPayload: CrossDayOptimizerAnalysis = {
        enabled,
        dryRunDefault,
        planId: normalizedPlanId,
        quoteId: String((plan as any)?.itinerary_quote_ID || options?.quoteId || "") || null,
        routeSnapshots,
        proposedMoves,
        allocationPlan: null,
        applied: false,
        skippedReason: null,
        affectedRouteIds: Array.from(new Set(proposedMoves.flatMap((move) => [move.fromRouteId, move.toRouteId]))),
        beforeCounts,
        afterCounts: null,
      };
      const allocationPlan = this.buildAllocationPlan(routeSnapshots, rowsByRoute, hotspotMasterById, proposedMoves);

      const effectiveDryRun = options?.dryRun ?? dryRunDefault;

      if (effectiveDryRun) {
        resultPayload.skippedReason = "dry-run mode is enabled; no database changes were made";
        resultPayload.allocationPlan = allocationPlan;
        return resultPayload;
      }

      if (proposedMoves.length === 0) {
        resultPayload.skippedReason = "No same-city cross-day move opportunities were found";
        resultPayload.allocationPlan = allocationPlan;
        return resultPayload;
      }

      const routeById = new Map<number, RouteRecord>();
      for (const route of routes) routeById.set(Number(route.itinerary_route_ID || 0), route);
      const protectedRouteHotspotIds = new Set<number>();
      const protectedHotspotIds = new Set<number>();
      for (const value of fixedAnchorByRoute.values()) {
        for (const routeHotspotId of value.routeHotspotIds) {
          protectedRouteHotspotIds.add(routeHotspotId);
        }
        for (const hotspotId of value.hotspotIds) {
          protectedHotspotIds.add(hotspotId);
        }
      }
      for (const move of proposedMoves) {
        protectedHotspotIds.add(Number(move.hotspotId || 0));
      }

      const refreshedSourceRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
          status: 1,
        },
        orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
      });
      const transplantedRows = (refreshedSourceRows as RouteHotspotRecord[]).map((row) => {
        const moved = proposedMoves.find(
          (move) =>
            Number(move.fromRouteId || 0) === Number(row.itinerary_route_ID || 0) &&
            Number(move.hotspotId || 0) === Number(row.hotspot_ID || 0),
        );
        if (!moved) return row;
        const targetRoute = routeById.get(moved.toRouteId);
        return {
          ...row,
          itinerary_route_ID: moved.toRouteId,
          updatedon: new Date(),
        };
      });

      await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId, transplantedRows, {
        protectedRouteHotspotIds: Array.from(protectedRouteHotspotIds),
        protectedHotspotIds: Array.from(protectedHotspotIds),
        sameCityAllocationPlan: allocationPlan,
      });

      const refreshedAfterRebuild = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
          status: 1,
        },
        orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
      });

      const rowsByRouteAfterRebuild = new Map<number, RouteHotspotRecord[]>();
      for (const row of refreshedAfterRebuild as RouteHotspotRecord[]) {
        const routeId = Number(row.itinerary_route_ID || 0);
        if (!rowsByRouteAfterRebuild.has(routeId)) rowsByRouteAfterRebuild.set(routeId, []);
        rowsByRouteAfterRebuild.get(routeId)!.push(row);
      }

      for (const move of proposedMoves) {
        const targetRows = rowsByRouteAfterRebuild.get(move.toRouteId) || [];
        const alreadyPresent = targetRows.some((row) => Number(row.hotspot_ID || 0) === Number(move.hotspotId || 0));
        if (alreadyPresent) continue;

        const sourceSeedRow = (refreshedSourceRows as RouteHotspotRecord[]).find((row) =>
          Number(row.itinerary_route_ID || 0) === Number(move.fromRouteId || 0) &&
          Number(row.hotspot_ID || 0) === Number(move.hotspotId || 0),
        );
        if (!sourceSeedRow) {
          throw new Error(
            `[SameCityCrossDayOptimizer] source hotspot ${move.hotspotId} was not present before the rebuild move from route ${move.fromRouteId}`,
          );
        }

        throw new Error(
          `[SameCityCrossDayOptimizer] rebuilt target route ${move.toRouteId} did not materialize hotspot ${move.hotspotId} after moving from route ${move.fromRouteId}`,
        );
      }

      const refreshedByRoute = new Map<number, number>();
      for (const row of (await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
          status: 1,
        },
        orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
      })) as RouteHotspotRecord[]) {
        if (Number(row.item_type || 0) !== 4) continue;
        const routeId = Number(row.itinerary_route_ID || 0);
        refreshedByRoute.set(routeId, (refreshedByRoute.get(routeId) || 0) + 1);
      }

      resultPayload.applied = true;
      resultPayload.afterCounts = Object.fromEntries(
        routeSnapshots.map((snapshot) => [snapshot.routeId, refreshedByRoute.get(snapshot.routeId) || 0]),
      ) as Record<number, number>;
      resultPayload.allocationPlan = allocationPlan;

      return resultPayload;
    }, { timeout: 120000 });

    this.logger.log(
      `[SameCityCrossDayOptimizer] planId=${analysis.planId} enabled=${analysis.enabled} dryRun=${options?.dryRun ?? this.isDryRunDefault()} proposedMoves=${analysis.proposedMoves.length} applied=${analysis.applied}`,
    );

    return analysis;
  }

  private buildAllocationPlan(
    routeSnapshots: CrossDayOptimizerRouteSnapshot[],
    rowsByRoute: Map<number, RouteHotspotRecord[]>,
    hotspotMasterById: Map<number, HotspotMasterRecord>,
    proposedMoves: CrossDayOptimizerMove[],
  ): SameCityAllocationPlan | null {
    if (!routeSnapshots.length) return null;

    const fixedAnchorsByRoute: SameCityAllocationPlan["fixedAnchorsByRoute"] = {};
    const desiredMovableHotspotIdsByRoute: SameCityAllocationPlan["desiredMovableHotspotIdsByRoute"] = {};
    const desiredMovableOrderByRoute: SameCityAllocationPlan["desiredMovableOrderByRoute"] = {};
    const preferredAdjacencyPairsByRoute: SameCityAllocationPlan["preferredAdjacencyPairsByRoute"] = {};
    const unallocatedHotspotIds = new Set<number>();
    const rejectedAllocations: SameCityAllocationPlan["rejectedAllocations"] = [];

    const insertMovedHotspotAfterAnchor = (
      currentOrder: number[],
      anchorHotspotId: number,
      movedHotspotId: number,
      clusterMemberHotspotIds: number[] = [],
    ): number[] => {
      const extraMembers = clusterMemberHotspotIds
        .map((id) => Number(id || 0))
        .filter((id) => id > 0 && id !== movedHotspotId && id !== Number(anchorHotspotId || 0));
      const insertionBlock = [Number(movedHotspotId || 0), ...extraMembers].filter((id) => id > 0);
      const sanitizedCurrent = currentOrder
        .map((id) => Number(id || 0))
        .filter((id) => id > 0 && !insertionBlock.includes(id));
      const anchorIndex = sanitizedCurrent.findIndex((id) => id === Number(anchorHotspotId || 0));

      if (anchorIndex < 0) {
        return Array.from(new Set([...sanitizedCurrent, ...insertionBlock]));
      }

      return [
        ...sanitizedCurrent.slice(0, anchorIndex + 1),
        ...insertionBlock,
        ...sanitizedCurrent.slice(anchorIndex + 1),
      ];
    };

    for (const snapshot of routeSnapshots) {
      const routeRows = rowsByRoute.get(snapshot.routeId) || [];
      const partition = this.classifyRouteHotspots(routeRows, hotspotMasterById);
      fixedAnchorsByRoute[snapshot.routeId] = partition.fixedRows.map((row) => ({
        routeHotspotId: Number(row.route_hotspot_ID || 0),
        hotspotId: Number(row.hotspot_ID || 0),
        routeId: snapshot.routeId,
        itemType: Number(row.item_type || 0),
        order: Number(row.hotspot_order || 0),
        startSeconds: this.toSeconds(row.hotspot_start_time),
        endSeconds: this.toSeconds(row.hotspot_end_time),
        originalStartTime: this.formatTime(row.hotspot_start_time),
        originalEndTime: this.formatTime(row.hotspot_end_time),
        reason: Number(row.hotspot_plan_own_way || 0) === 1
          ? "manual hotspot pinned by plan_own_way"
          : `priority hotspot pinned on route ${snapshot.routeId}`,
      }));
      desiredMovableHotspotIdsByRoute[snapshot.routeId] = partition.movableRows.map((row) => Number(row.hotspot_ID || 0));
      desiredMovableOrderByRoute[snapshot.routeId] = partition.movableRows
        .map((row) => Number(row.hotspot_ID || 0))
        .filter((id) => id > 0);
    }

    for (const move of proposedMoves) {
      const targetRouteHotspots = desiredMovableHotspotIdsByRoute[move.toRouteId] || [];
      const sourceRouteHotspots = desiredMovableHotspotIdsByRoute[move.fromRouteId] || [];
      if (!targetRouteHotspots.includes(move.hotspotId)) {
        targetRouteHotspots.push(move.hotspotId);
      }
      desiredMovableHotspotIdsByRoute[move.toRouteId] = Array.from(new Set(targetRouteHotspots));
      desiredMovableOrderByRoute[move.toRouteId] = insertMovedHotspotAfterAnchor(
        desiredMovableOrderByRoute[move.toRouteId] || [],
        Number(move.anchorHotspotId || 0),
        move.hotspotId,
        move.clusterMemberHotspotIds || [],
      );
      desiredMovableHotspotIdsByRoute[move.fromRouteId] = sourceRouteHotspots.filter((id) => id !== move.hotspotId);
      desiredMovableOrderByRoute[move.fromRouteId] = (desiredMovableOrderByRoute[move.fromRouteId] || [])
        .filter((id) => id !== move.hotspotId);
      preferredAdjacencyPairsByRoute[move.toRouteId] = [
        ...(preferredAdjacencyPairsByRoute[move.toRouteId] || []),
        [Number(move.anchorHotspotId || 0), move.hotspotId] as [number, number],
      ];

      for (const hotspotId of move.clusterMemberHotspotIds || []) {
        if (hotspotId > 0 && hotspotId !== move.hotspotId) {
          desiredMovableHotspotIdsByRoute[move.toRouteId] = Array.from(
            new Set([...(desiredMovableHotspotIdsByRoute[move.toRouteId] || []), hotspotId]),
          );
        }
      }
    }

    for (const snapshot of routeSnapshots) {
      const routeRows = rowsByRoute.get(snapshot.routeId) || [];
      const partition = this.classifyRouteHotspots(routeRows, hotspotMasterById);
      for (const row of partition.movableRows) {
        const hotspotId = Number(row.hotspot_ID || 0);
        if (!Object.values(desiredMovableHotspotIdsByRoute).some((ids) => ids.includes(hotspotId))) {
          unallocatedHotspotIds.add(hotspotId);
        }
      }
    }

    return {
      cityGroupId: routeSnapshots.map((snapshot) => snapshot.cityKey).join('|'),
      fixedAnchorsByRoute,
      desiredMovableHotspotIdsByRoute,
      desiredMovableOrderByRoute,
      preferredAdjacencyPairsByRoute,
      unallocatedHotspotIds: Array.from(unallocatedHotspotIds),
      rejectedAllocations,
    };
  }
}
