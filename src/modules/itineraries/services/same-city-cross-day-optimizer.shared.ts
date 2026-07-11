import { normalizeCityName } from "../utils/city-normalization.util";

export type GeoPoint = {
  lat: number;
  lon: number;
};

export type MovableHotspotPoint = {
  routeId: number;
  routeHotspotId: number;
  hotspotId: number;
  hotspotName: string;
  rawPriority: number;
  point: GeoPoint;
  visitMinutes?: number;
};

export type MovableHotspotCluster = {
  clusterId: string;
  members: MovableHotspotPoint[];
  routeIds: number[];
  memberNames: string[];
  centroid: GeoPoint | null;
  isIndependent: boolean;
  pairDistances: Array<{
    hotspotIdA: number;
    hotspotIdB: number;
    hotspotNameA: string;
    hotspotNameB: string;
    distanceKm: number;
  }>;
  maxPairDistanceKm: number;
  totalVisitMinutes: number;
};

export function isTerminalLocation(value: string | null | undefined): boolean {
  return /(airport|air\s*port|railway|station|bus\s*stand|bus\s*station|terminal|terminus|junction|stn)\b/i.test(
    String(value || ""),
  );
}

export function normalizeRouteCityKey(
  source: string | null | undefined,
  destination: string | null | undefined,
): string {
  const sourceName = String(source || "").trim();
  const destinationName = String(destination || "").trim();

  const sourceCore = isTerminalLocation(sourceName) ? "" : normalizeCityName(sourceName);
  const destinationCore = isTerminalLocation(destinationName) ? "" : normalizeCityName(destinationName);

  return sourceCore || destinationCore || normalizeCityName(sourceName) || normalizeCityName(destinationName);
}

export function haversineKm(from: GeoPoint, to: GeoPoint): number | null {
  const lat1 = Number(from?.lat || 0);
  const lon1 = Number(from?.lon || 0);
  const lat2 = Number(to?.lat || 0);
  const lon2 = Number(to?.lon || 0);

  if (!lat1 || !lon1 || !lat2 || !lon2) return null;

  const earthRadiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

export function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function safeDurationMinutes(startSeconds: number, endSeconds: number): number {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return 0;
  return Math.max(0, Math.floor((endSeconds - startSeconds) / 60));
}

export function getHotspotPriority(
  row: { hotspot_priority?: number | null } | null | undefined,
  hotspot?: { hotspot_priority?: number | null } | null,
): number {
  const rawPriority = Number(hotspot?.hotspot_priority ?? row?.hotspot_priority ?? 0);
  return Number.isFinite(rawPriority) ? rawPriority : 0;
}

export function isManualRouteHotspot(row: { item_type?: number | null; hotspot_plan_own_way?: number | null }): boolean {
  return Number(row?.item_type || 0) === 4 && Number(row?.hotspot_plan_own_way || 0) === 1;
}

export function isFixedRouteHotspot(
  row: {
    item_type?: number | null;
    hotspot_plan_own_way?: number | null;
    hotspot_priority?: number | null;
  },
  hotspot?: { hotspot_priority?: number | null } | null,
): boolean {
  if (isManualRouteHotspot(row)) return true;
  if (Number(row?.item_type || 0) !== 4) return false;
  return getHotspotPriority(row, hotspot) > 0;
}

export function isMovableAutoRouteHotspot(
  row: {
    item_type?: number | null;
    hotspot_plan_own_way?: number | null;
    hotspot_priority?: number | null;
  },
  hotspot?: { hotspot_priority?: number | null } | null,
): boolean {
  return Number(row?.item_type || 0) === 4 && !isManualRouteHotspot(row) && getHotspotPriority(row, hotspot) === 0;
}

export function buildContiguousSameCityGroups<T extends { cityKey: string }>(items: T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentKey = "";

  for (const item of items) {
    const key = String(item?.cityKey || "").trim();
    if (!key) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
        currentKey = "";
      }
      continue;
    }

    if (current.length === 0 || currentKey !== key) {
      if (current.length > 0) groups.push(current);
      current = [item];
      currentKey = key;
      continue;
    }

    current.push(item);
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

export function clusterMovableHotspotsByDistance(
  members: MovableHotspotPoint[],
  clusterThresholdKm = 5,
  maxClusterDiameterKm = 7,
): MovableHotspotCluster[] {
  if (!Array.isArray(members) || members.length === 0) return [];

  const remaining = [...members].sort((a, b) => {
    if (a.rawPriority !== b.rawPriority) return a.rawPriority - b.rawPriority;
    if (a.routeId !== b.routeId) return a.routeId - b.routeId;
    return a.hotspotId - b.hotspotId;
  });

  const clusters: MovableHotspotCluster[] = [];
  let clusterIndex = 0;

  const maxPairwiseDistance = (clusterMembers: MovableHotspotPoint[]): number => {
    let maxDistance = 0;
    for (let i = 0; i < clusterMembers.length; i += 1) {
      for (let j = i + 1; j < clusterMembers.length; j += 1) {
        const distanceKm = haversineKm(clusterMembers[i].point, clusterMembers[j].point);
        if (distanceKm != null && Number.isFinite(distanceKm)) {
          maxDistance = Math.max(maxDistance, distanceKm);
        }
      }
    }
    return maxDistance;
  };

  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const clusterMembers: MovableHotspotPoint[] = [seed];

    let expanded = true;
    while (expanded) {
      expanded = false;
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        let nearestDistance = Number.POSITIVE_INFINITY;
        let candidateFeasible = true;

        for (const existing of clusterMembers) {
          const distanceKm = haversineKm(existing.point, candidate.point);
          if (distanceKm == null || !Number.isFinite(distanceKm)) {
            candidateFeasible = false;
            break;
          }
          nearestDistance = Math.min(nearestDistance, distanceKm);
        }

        if (!candidateFeasible) continue;
        if (nearestDistance > clusterThresholdKm) continue;

        const trialMembers = [...clusterMembers, candidate];
        if (maxPairwiseDistance(trialMembers) > maxClusterDiameterKm) continue;

        if (
          nearestDistance < bestDistance ||
          (nearestDistance === bestDistance && candidate.rawPriority < remaining[bestIndex]?.rawPriority) ||
          (nearestDistance === bestDistance && candidate.rawPriority === remaining[bestIndex]?.rawPriority && candidate.hotspotId < remaining[bestIndex]?.hotspotId)
        ) {
          bestIndex = index;
          bestDistance = nearestDistance;
        }
      }

      if (bestIndex >= 0) {
        clusterMembers.push(remaining.splice(bestIndex, 1)[0]);
        expanded = true;
      }
    }

    const pairDistances: MovableHotspotCluster["pairDistances"] = [];
    let maxPairDistanceKm = 0;
    for (let i = 0; i < clusterMembers.length; i += 1) {
      for (let j = i + 1; j < clusterMembers.length; j += 1) {
        const distanceKm = haversineKm(clusterMembers[i].point, clusterMembers[j].point);
        if (distanceKm == null || !Number.isFinite(distanceKm)) continue;
        maxPairDistanceKm = Math.max(maxPairDistanceKm, distanceKm);
        pairDistances.push({
          hotspotIdA: clusterMembers[i].hotspotId,
          hotspotIdB: clusterMembers[j].hotspotId,
          hotspotNameA: clusterMembers[i].hotspotName,
          hotspotNameB: clusterMembers[j].hotspotName,
          distanceKm,
        });
      }
    }

    const routeIds = Array.from(new Set(clusterMembers.map((member) => Number(member.routeId || 0)).filter((id) => id > 0))).sort((a, b) => a - b);
    const memberNames = clusterMembers.map((member) => member.hotspotName).filter(Boolean);
    const centroid = clusterMembers.reduce<GeoPoint | null>((acc, member) => {
      if (!acc) {
        return { lat: member.point.lat, lon: member.point.lon };
      }
      return {
        lat: acc.lat + member.point.lat,
        lon: acc.lon + member.point.lon,
      };
    }, null);

    const normalizedCentroid = centroid
      ? {
          lat: centroid.lat / clusterMembers.length,
          lon: centroid.lon / clusterMembers.length,
        }
      : null;

    clusters.push({
      clusterId: `cluster-${clusterIndex += 1}`,
      members: clusterMembers,
      routeIds,
      memberNames,
      centroid: normalizedCentroid,
      isIndependent: clusterMembers.length === 1,
      pairDistances,
      maxPairDistanceKm,
      totalVisitMinutes: clusterMembers.reduce((sum, member) => sum + Math.max(0, Number(member.visitMinutes || 0)), 0),
    });
  }

  return clusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return a.clusterId.localeCompare(b.clusterId);
  });
}
