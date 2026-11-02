import {
  isTerminalLocation,
  normalizeRouteCityKey,
} from "../../services/same-city-cross-day-optimizer.shared";

export type SameCityHotspotPolicyConfig = {
  enabled: boolean;
  maxPriority: number;
  baseIncrement: number;
  distributionMode: string;
};

export type SameCityRoutePolicyContext = {
  routeId: number;
  cityKey: string;
  cityDay: number;
  groupId: string;
  routeDateKey: string;
  eligible: boolean;
  isArrivalRoute: boolean;
  isLocalSameCityRoute: boolean;
};

export type SameCityPoolDiagnostics = {
  cityKey: string;
  poolCount: number;
  effectiveCount: number;
  invalidPriorityIds: number[];
  missingPriorities: number[];
  duplicatePriorities: number[];
};

export type SameCityCandidatePolicyResult<T> = {
  candidates: T[];
  removed: T[];
  limit: number;
  diagnostics: SameCityPoolDiagnostics;
  capacity: SameCityCapacityAllocation;
};

export type SameCityCapacityAllocation = {
  estimatedCapacity: number;
  softTarget: number;
  reserveForFutureDays: number;
};

export type SameCityPolicyViolation = {
  routeId: number;
  hotspotId: number;
  priority: number;
  limit: number;
  cityKey: string;
  reason: string;
};

type RouteLike = {
  itinerary_route_ID?: number | string | null;
  itinerary_route_date?: Date | string | null;
  location_name?: string | null;
  next_visiting_location?: string | null;
};

type HotspotLike = {
  hotspot_ID?: number | string | null;
  hotspot_location?: string | null;
  hotspot_to_location?: string | null;
  matched_bucket?: string | null;
  __bucket?: string | null;
  hotspot_priority?: number | string | null;
  status?: number | string | null;
  deleted?: number | string | null;
};

type CandidateLike = HotspotLike & {
  matched_bucket?: string | null;
  __bucket?: string | null;
  isManualSelection?: boolean | number | null;
  isManual?: boolean | number | null;
  hotspot_plan_own_way?: number | string | null;
};

export function shouldDeferSameCityAutomaticCandidate({
  candidate,
  context,
  config,
  scheduledCount,
  softTarget,
  isLocalCandidate,
}: {
  candidate: CandidateLike;
  context: SameCityRoutePolicyContext | undefined;
  config: SameCityHotspotPolicyConfig;
  scheduledCount: number;
  softTarget: number | null | undefined;
  isLocalCandidate: boolean;
}): boolean {
  if (!config.enabled || config.distributionMode !== "BALANCED") return false;
  if (!context?.eligible || !isLocalCandidate) return false;
  if (softTarget === null || softTarget === undefined) return false;
  if (Boolean(candidate.isManualSelection) || Boolean(candidate.isManual)) return false;
  if (Number(candidate.hotspot_plan_own_way || 0) === 1) return false;
  return Math.max(0, Math.floor(Number(scheduledCount) || 0)) >= Math.max(0, Math.floor(Number(softTarget) || 0));
}

const toFinitePositiveInt = (value: unknown, fallback: number): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.floor(numberValue)
    : fallback;
};

const routeDateKey = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
};

const cityKeyForRouteStay = (route: RouteLike): string => {
  const source = String(route.location_name || "").split("|")[0].trim();
  const destination = String(route.next_visiting_location || "").split("|")[0].trim();
  const sourceIsTerminal = isTerminalLocation(source);
  const destinationIsTerminal = isTerminalLocation(destination);

  if (sourceIsTerminal && !destinationIsTerminal) {
    return normalizeRouteCityKey("", destination);
  }
  if (!sourceIsTerminal && destinationIsTerminal) {
    return normalizeRouteCityKey(source, "");
  }
  if (source && destination && normalizeRouteCityKey(source, "") === normalizeRouteCityKey(destination, "")) {
    return normalizeRouteCityKey(source, destination);
  }
  return "";
};

export function buildSameCityRoutePolicyContexts(
  routes: RouteLike[],
  canonicalCityKey: (value: string) => string,
): Map<number, SameCityRoutePolicyContext> {
  const contexts = new Map<number, SameCityRoutePolicyContext>();
  const rows = (routes || []).map((route, index) => {
    const source = String(route.location_name || "").split("|")[0].trim();
    const destination = String(route.next_visiting_location || "").split("|")[0].trim();
    const sourceKey = canonicalCityKey(source);
    const destinationKey = canonicalCityKey(destination);
    const cityKey = canonicalCityKey(cityKeyForRouteStay(route));
    const isArrivalRoute = isTerminalLocation(source) && !!destinationKey && destinationKey === cityKey;
    const isLocalSameCityRoute = !!sourceKey && sourceKey === destinationKey && !isTerminalLocation(source) && !isTerminalLocation(destination);

    return {
      route,
      index,
      routeId: Number(route.itinerary_route_ID || 0),
      routeDateKey: routeDateKey(route.itinerary_route_date),
      cityKey,
      cityDay: 0,
      isArrivalRoute,
      isLocalSameCityRoute,
    };
  });

  let groupIndex = 0;
  let currentCity = "";
  let currentDate = "";
  let currentDay = 0;
  let groupRows: typeof rows = [];

  const flushGroup = (): void => {
    if (!groupRows.length || !currentCity) {
      groupRows = [];
      currentDay = 0;
      return;
    }

    const distinctDates = new Set(groupRows.map((row) => row.routeDateKey).filter(Boolean));
    const isMultiDayGroup = distinctDates.size >= 2;
    for (const row of groupRows) {
      contexts.set(row.routeId, {
        routeId: row.routeId,
        cityKey: row.cityKey,
        cityDay: row.cityDay,
        groupId: `same-city-${groupIndex}`,
        routeDateKey: row.routeDateKey,
        eligible: isMultiDayGroup && (row.isArrivalRoute || row.isLocalSameCityRoute),
        isArrivalRoute: row.isArrivalRoute,
        isLocalSameCityRoute: row.isLocalSameCityRoute,
      });
    }
    groupRows = [];
    currentDay = 0;
  };

  for (const row of rows) {
    if (!row.cityKey) {
      flushGroup();
      contexts.set(row.routeId, {
        routeId: row.routeId,
        cityKey: "",
        cityDay: 0,
        groupId: "",
        routeDateKey: row.routeDateKey,
        eligible: false,
        isArrivalRoute: row.isArrivalRoute,
        isLocalSameCityRoute: row.isLocalSameCityRoute,
      });
      currentCity = "";
      currentDate = "";
      continue;
    }

    if (row.cityKey !== currentCity) {
      flushGroup();
      groupIndex += 1;
      currentCity = row.cityKey;
      currentDate = "";
    }

    if (row.routeDateKey !== currentDate) {
      currentDay += 1;
      currentDate = row.routeDateKey;
    }

    groupRows.push({ ...row, cityDay: currentDay });
  }
  flushGroup();

  return contexts;
}
export function calculateSameCityPriorityLimit(
  poolCount: number,
  maxPriority: number,
  baseIncrement: number,
  cityDay: number,
): { effectiveCount: number; scaledIncrement: number; stages: number; limit: number } {
  const safeMaxPriority = toFinitePositiveInt(maxPriority, 30);
  const safeBaseIncrement = Math.min(toFinitePositiveInt(baseIncrement, 10), safeMaxPriority);
  const effectiveCount = Math.min(Math.max(0, Math.floor(Number(poolCount) || 0)), safeMaxPriority);

  if (!effectiveCount || cityDay < 1) {
    return { effectiveCount, scaledIncrement: 0, stages: Math.ceil(safeMaxPriority / safeBaseIncrement), limit: 0 };
  }

  const scaledIncrement = Math.max(1, Math.floor((effectiveCount * safeBaseIncrement) / safeMaxPriority));
  const stages = Math.ceil(safeMaxPriority / safeBaseIncrement);
  const limit = cityDay >= stages
    ? effectiveCount
    : Math.min(effectiveCount, cityDay * scaledIncrement);

  return { effectiveCount, scaledIncrement, stages, limit };
}

/**
 * Capacity is deliberately a soft scheduling target. The timeline scheduler
 * remains the authority for operating hours, travel time, and real fit; this
 * helper must not remove an unlocked candidate before that scheduler evaluates
 * it. A rough route-window estimate is useful for reservation diagnostics and
 * future-day balancing, but it cannot replace candidate-specific feasibility
 * (travel, opening hours, manual anchors, meals, hotel timing, or departure).
 */
export function buildSameCityCapacityAllocation({
  candidateCount,
  effectiveCount,
  estimatedCapacity,
  currentDayLimit,
  futureCapacity = 0,
}: {
  candidateCount: number;
  effectiveCount: number;
  estimatedCapacity: number;
  currentDayLimit: number;
  futureCapacity?: number;
}): SameCityCapacityAllocation {
  const safeCapacity = Math.max(0, Math.floor(Number(estimatedCapacity) || 0));
  const safeFutureCapacity = Math.max(
    0,
    Math.min(Math.floor(Number(effectiveCount) || 0), Math.floor(Number(futureCapacity) || 0)),
  );
  const currentDayDemand = Math.max(
    0,
    Math.floor(Number(effectiveCount) || 0) - safeFutureCapacity,
  );
  const softTarget = Math.min(
    Math.max(0, Math.floor(Number(candidateCount) || 0)),
    Math.max(0, Math.min(
      Math.floor(Number(effectiveCount) || 0),
      Math.floor(Number(currentDayLimit) || 0),
      safeCapacity,
      currentDayDemand,
    )),
  );

  return {
    estimatedCapacity: safeCapacity,
    softTarget,
    reserveForFutureDays: Math.max(0, Math.floor(Number(effectiveCount) || 0) - softTarget),
  };
}

export function buildSameCityPoolDiagnostics(
  cityKey: string,
  pool: HotspotLike[],
  maxPriority: number,
): SameCityPoolDiagnostics {
  const effectiveCount = Math.min(pool.length, toFinitePositiveInt(maxPriority, 30));
  const priorityCounts = new Map<number, number>();
  const invalidPriorityIds: number[] = [];

  for (const row of pool) {
    const id = Number(row.hotspot_ID || 0);
    const priority = Number(row.hotspot_priority ?? 0);
    if (!Number.isInteger(priority) || priority < 1 || priority > effectiveCount) {
      if (id > 0) invalidPriorityIds.push(id);
      continue;
    }
    priorityCounts.set(priority, (priorityCounts.get(priority) || 0) + 1);
  }

  const missingPriorities: number[] = [];
  for (let priority = 1; priority <= effectiveCount; priority += 1) {
    if (!priorityCounts.has(priority)) missingPriorities.push(priority);
  }

  const duplicatePriorities = Array.from(priorityCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([priority]) => priority)
    .sort((a, b) => a - b);

  return {
    cityKey,
    poolCount: pool.length,
    effectiveCount,
    invalidPriorityIds: Array.from(new Set(invalidPriorityIds)).sort((a, b) => a - b),
    missingPriorities,
    duplicatePriorities,
  };
}
export function filterSameCityAutomaticCandidates<T extends CandidateLike>({
  candidates,
  allHotspots,
  context,
  config,
  estimatedCapacity = Number.MAX_SAFE_INTEGER,
  futureCapacity = 0,
  routeOnlyHotspotIds = new Set<number>(),
  hotspotLocationMatchesCity,
}: {
  candidates: T[];
  allHotspots: HotspotLike[];
  context: SameCityRoutePolicyContext | undefined;
  config: SameCityHotspotPolicyConfig;
  estimatedCapacity?: number;
  futureCapacity?: number;
  routeOnlyHotspotIds?: Set<number>;
  hotspotLocationMatchesCity: (location: string, cityKey: string) => boolean;
}): SameCityCandidatePolicyResult<T> {
  if (!config.enabled || !context?.eligible || !context.cityKey || config.distributionMode !== "BALANCED") {
    return {
      candidates,
      removed: [],
      limit: 0,
      capacity: { estimatedCapacity: 0, softTarget: 0, reserveForFutureDays: 0 },
      diagnostics: {
        cityKey: context?.cityKey || "",
        poolCount: 0,
        effectiveCount: 0,
        invalidPriorityIds: [],
        missingPriorities: [],
        duplicatePriorities: [],
      },
    };
  }

  const poolById = new Map<number, HotspotLike>();
  for (const hotspot of allHotspots || []) {
    const id = Number(hotspot.hotspot_ID || 0);
    const location = String(hotspot.hotspot_location || "");
    const toLocation = String(hotspot.hotspot_to_location || "").trim();
    const bucket = String(hotspot.matched_bucket || hotspot.__bucket || "").toLowerCase();
    const active = Number(hotspot.deleted || 0) === 0 && Number(hotspot.status ?? 1) !== 0;
    if (["en_route", "enroute", "source_to_destination", "via", "boundary", "corridor"].includes(bucket)) continue;
    if (routeOnlyHotspotIds.has(id)) continue;
    if (!id || !active || !hotspotLocationMatchesCity(location, context.cityKey)) continue;
    if (toLocation && !hotspotLocationMatchesCity(toLocation, context.cityKey)) continue;
    if (!poolById.has(id)) poolById.set(id, hotspot);
  }

  const pool = Array.from(poolById.values());
  const diagnostics = buildSameCityPoolDiagnostics(context.cityKey, pool, config.maxPriority);
  const calculation = calculateSameCityPriorityLimit(
    pool.length,
    config.maxPriority,
    config.baseIncrement,
    context.cityDay,
  );

  const isManual = (candidate: CandidateLike): boolean =>
    Boolean(candidate.isManualSelection) ||
    Boolean(candidate.isManual) ||
    Number(candidate.hotspot_plan_own_way || 0) === 1;

  const isLocalCandidate = (candidate: CandidateLike): boolean => {
    const bucket = String(candidate.matched_bucket || candidate.__bucket || "").toLowerCase();
    if (["en_route", "enroute", "source_to_destination", "via", "boundary", "corridor"].includes(bucket)) return false;
    const master = poolById.get(Number(candidate.hotspot_ID || 0)) || candidate;
    const location = String(master.hotspot_location || "");
    const toLocation = String(master.hotspot_to_location || "").trim();
    return hotspotLocationMatchesCity(location, context.cityKey) &&
      (!toLocation || hotspotLocationMatchesCity(toLocation, context.cityKey));
  };

  const localAutomaticCandidates = (candidates || []).filter(
    (candidate) => !isManual(candidate) && isLocalCandidate(candidate),
  );
  const capacity = buildSameCityCapacityAllocation({
    candidateCount: new Set(
      localAutomaticCandidates
        .map((candidate) => Number(candidate.hotspot_ID || 0))
        .filter((id) => id > 0),
    ).size,
    effectiveCount: calculation.effectiveCount,
    estimatedCapacity,
    currentDayLimit: calculation.limit,
    futureCapacity,
  });

  const removed: T[] = [];
  const priorityEligible = (candidates || []).filter((candidate) => {
    if (isManual(candidate) || !isLocalCandidate(candidate)) return true;
    const priority = Number(candidate.hotspot_priority ?? poolById.get(Number(candidate.hotspot_ID || 0))?.hotspot_priority ?? 0);
    const allowed = Number.isInteger(priority) && priority >= 1 && priority <= calculation.limit;
    if (!allowed) removed.push(candidate);
    return allowed;
  });

  return {
    // Keep every candidate in the unlocked priority range. The timeline
    // scheduler evaluates these in priority order and can fall through to a
    // lower-priority candidate when an earlier candidate is infeasible. Hard
    // trimming here caused valid lower-priority candidates to disappear.
    candidates: priorityEligible,
    removed,
    limit: calculation.limit,
    diagnostics,
    capacity,
  };
}

export function findSameCityPolicyViolations<T extends CandidateLike>({
  rows,
  allHotspots,
  contexts,
  config,
  hotspotLocationMatchesCity,
  protectedHotspotIds = new Set<number>(),
  routeOnlyHotspotIds = new Set<number>(),
}: {
  rows: T[];
  allHotspots: HotspotLike[];
  contexts: Map<number, SameCityRoutePolicyContext>;
  config: SameCityHotspotPolicyConfig;
  hotspotLocationMatchesCity: (location: string, cityKey: string) => boolean;
  protectedHotspotIds?: Set<number>;
  routeOnlyHotspotIds?: Set<number>;
}): SameCityPolicyViolation[] {
  if (!config.enabled || config.distributionMode !== "BALANCED") return [];

  const poolById = new Map<number, HotspotLike>();
  for (const hotspot of allHotspots || []) {
    const id = Number(hotspot.hotspot_ID || 0);
    if (id > 0 && !poolById.has(id)) poolById.set(id, hotspot);
  }

  const violations: SameCityPolicyViolation[] = [];
  for (const row of rows || []) {
    if (Number((row as any).item_type || 0) !== 4) continue;

    const hotspotId = Number(row.hotspot_ID || 0);
    const routeId = Number((row as any).itinerary_route_ID || 0);
    if (!hotspotId || protectedHotspotIds.has(hotspotId)) continue;
    if (Number((row as any).hotspot_plan_own_way || 0) === 1 || Boolean((row as any).isManual)) continue;

    const context = contexts.get(routeId);
    if (!context?.eligible || !context.cityKey) continue;

    const master = poolById.get(hotspotId) || row;
    const bucket = String((row as any).matched_bucket || (row as any).__bucket || "").toLowerCase();
    const location = String(master.hotspot_location || row.hotspot_location || "");
    const toLocation = String(master.hotspot_to_location || row.hotspot_to_location || "").trim();
    if (["en_route", "enroute", "source_to_destination", "via", "boundary", "corridor"].includes(bucket)) continue;
    if (routeOnlyHotspotIds.has(hotspotId)) continue;
    if (!hotspotLocationMatchesCity(location, context.cityKey)) continue;
    if (toLocation && !hotspotLocationMatchesCity(toLocation, context.cityKey)) continue;

    const pool = (allHotspots || []).filter((candidate) => {
      const candidateId = Number(candidate.hotspot_ID || 0);
      const candidateLocation = String(candidate.hotspot_location || "");
      const candidateToLocation = String(candidate.hotspot_to_location || "").trim();
      return candidateId > 0 &&
        !routeOnlyHotspotIds.has(candidateId) &&
        Number(candidate.deleted || 0) === 0 &&
        Number(candidate.status ?? 1) !== 0 &&
        hotspotLocationMatchesCity(candidateLocation, context.cityKey) &&
        (!candidateToLocation || hotspotLocationMatchesCity(candidateToLocation, context.cityKey));
    });
    const calculation = calculateSameCityPriorityLimit(
      new Set(pool.map((candidate) => Number(candidate.hotspot_ID || 0))).size,
      config.maxPriority,
      config.baseIncrement,
      context.cityDay,
    );
    const priority = Number(row.hotspot_priority ?? master.hotspot_priority ?? 0);
    if (!Number.isInteger(priority) || priority < 1 || priority > calculation.limit) {
      violations.push({
        routeId,
        hotspotId,
        priority,
        limit: calculation.limit,
        cityKey: context.cityKey,
        reason: "automatic hotspot is outside the unlocked same-city priority range",
      });
    }
  }

  return violations;
}
