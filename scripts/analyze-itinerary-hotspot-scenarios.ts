import { PrismaClient } from "@prisma/client";
import { normalizeCityName } from "../src/modules/itineraries/utils/city-normalization.util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isManualRouteHotspot } from "../src/modules/itineraries/services/same-city-cross-day-optimizer.shared";
import { SameCityCrossDayOptimizerService } from "../src/modules/itineraries/services/same-city-cross-day-optimizer.service";

type RouteRow = {
  itinerary_route_ID: number;
  itinerary_plan_ID: number;
  location_id: bigint | number;
  location_name: string | null;
  next_visiting_location: string | null;
  itinerary_route_date: Date | null;
  no_of_days: number;
  no_of_km: string | null;
  direct_to_next_visiting_place: number;
  route_start_time: Date | null;
  route_end_time: Date | null;
  excluded_hotspot_ids: unknown;
};

type RouteHotspotRow = {
  route_hotspot_ID: number;
  itinerary_route_ID: number;
  hotspot_ID: number;
  item_type: number;
  hotspot_order: number;
  hotspot_plan_own_way: number;
  hotspot_start_time: Date;
  hotspot_end_time: Date;
  hotspot_traveling_time: Date;
  hotspot_travelling_distance: string | null;
  deleted?: number;
  hotspot_priority?: number;
};

type HotspotMaster = {
  hotspot_ID: number;
  hotspot_name: string | null;
  hotspot_priority: number;
  hotspot_location: string | null;
  hotspot_to_location: string | null;
  hotspot_duration: Date | null;
  hotspot_latitude: string | null;
  hotspot_longitude: string | null;
  city_boundaries: string | null;
};

type ViaRouteRow = {
  itinerary_via_route_ID: number;
  itinerary_route_ID: number;
  itinerary_via_location_name: string;
};

type TimingRow = {
  hotspot_ID: number;
  hotspot_timing_day: number | null;
  hotspot_start_time: Date | null;
  hotspot_end_time: Date | null;
  hotspot_closed: number;
  hotspot_open_all_time: number;
};

type CandidateRecord = {
  hotspotId: number;
  name: string;
  rawPriority: number;
  effectivePriority: number;
  membership: Array<"source" | "destination" | "via" | "boundary" | "manual">;
  viaMatches: string[];
  sourceMatch: boolean;
  destinationMatch: boolean;
  boundaryMatch: boolean;
  manual: boolean;
  location: string;
  toLocation: string;
  cityBoundaries: string;
  sourceDistanceKm: number | null;
};

type ScenarioState = {
  lastQuoteId: string;
  nextScenarioIndex: number;
};

type ScenarioScope = {
  dayNo?: number;
};

const prisma = new PrismaClient();

const DOCS_DIR = path.resolve(process.cwd(), "docs");
const OUTPUT_FILE = path.join(DOCS_DIR, "itinerary-hotspot-scenarios.md");
const STATE_FILE = path.join(DOCS_DIR, ".itinerary-hotspot-scenarios.state.json");

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
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

function parseOptionalDay(value: string | undefined): number | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid day value "${value}". Day must be a positive integer.`);
  }

  return parsed;
}

function canonicalCityKey(name: string): string {
  const raw = String(name ?? "").split("|")[0]?.trim() ?? "";
  if (!raw) return "";

  const beforeComma = raw.split(",")[0]?.trim() ?? "";
  const normalizedPrimary = normalizeCityName(beforeComma);
  if (normalizedPrimary) return normalizedPrimary;

  return normalizeCityName(raw);
}

function hotspotLocationMatchesCity(
  hotspotLocation: string | null | undefined,
  targetCity: string | null | undefined,
): boolean {
  const targetKey = canonicalCityKey(String(targetCity || ""));
  if (!targetKey) return false;

  const parts = String(hotspotLocation || "")
    .split("|")
    .flatMap((part) => String(part || "").split(","))
    .map((part) => canonicalCityKey(part))
    .filter(Boolean);

  if (!parts.length) return false;

  for (const part of parts) {
    if (part === targetKey) return true;
    if (part.startsWith(`${targetKey} `)) return true;
    if (part.includes(` ${targetKey} `)) return true;
    if (part.endsWith(` ${targetKey}`)) return true;
  }

  return false;
}

function boundaryMatchesRoute(
  cityBoundaries: string | null | undefined,
  sourceCity: string,
  destinationCity: string,
): boolean {
  const raw = String(cityBoundaries || "");
  if (!raw) return false;

  const tokens = raw
    .split(/\||,|\//g)
    .map((token) => canonicalCityKey(token))
    .filter(Boolean);

  const sourceKey = canonicalCityKey(sourceCity);
  const destinationKey = canonicalCityKey(destinationCity);
  if (!sourceKey || !destinationKey) return false;

  return tokens.includes(sourceKey) && tokens.includes(destinationKey);
}

function getEffectivePriority(rawPriority: number, manual = false): number {
  if (manual) return 4;
  if (!Number.isFinite(rawPriority) || rawPriority === 0) return 9999;
  return rawPriority;
}

function formatDateOnly(value: Date | null | undefined): string {
  if (!value) return "N/A";
  return value.toISOString().split("T")[0];
}

function formatClock(value: Date | null | undefined): string {
  if (!value) return "N/A";
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${String(displayHour).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

function formatTimeRange(start: Date | null | undefined, end: Date | null | undefined): string {
  return `${formatClock(start)} -> ${formatClock(end)}`;
}

function toSeconds(value: Date | null | undefined): number {
  if (!value) return 0;
  return value.getUTCHours() * 3600 + value.getUTCMinutes() * 60 + value.getUTCSeconds();
}

function formatDuration(start: Date | null | undefined, end: Date | null | undefined): string {
  if (!start || !end) return "N/A";
  const delta = Math.max(0, toSeconds(end) - toSeconds(start));
  const hours = Math.floor(delta / 3600);
  const minutes = Math.floor((delta % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function safeJsonArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item || 0)).filter((item) => item > 0);
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return safeJsonArray(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function haversineKm(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number | null {
  if (!fromLat || !fromLon || !toLat || !toLon) return null;
  const earthRadiusKm = 6371;
  const dLat = ((toLat - fromLat) * Math.PI) / 180;
  const dLon = ((toLon - fromLon) * Math.PI) / 180;
  const lat1 = (fromLat * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c * 1.5;
}

function getPhpDow(value: Date | null | undefined): number | null {
  if (!value) return null;
  return (value.getUTCDay() + 6) % 7;
}

function describeTiming(
  timingRows: TimingRow[],
  hotspotId: number,
  routeDate: Date | null | undefined,
): string {
  const phpDow = getPhpDow(routeDate);
  if (phpDow == null) return "operating hours unavailable";

  const match = timingRows.find(
    (row) => Number(row.hotspot_ID) === hotspotId && Number(row.hotspot_timing_day ?? -1) === phpDow,
  );

  if (!match) return "no timing row found for route day";
  if (Number(match.hotspot_closed || 0) === 1) return "marked closed on route day";
  if (Number(match.hotspot_open_all_time || 0) === 1) return "open all day";
  return `${formatClock(match.hotspot_start_time)} -> ${formatClock(match.hotspot_end_time)}`;
}

function compareCandidates(a: CandidateRecord, b: CandidateRecord): number {
  if (a.effectivePriority !== b.effectivePriority) {
    return a.effectivePriority - b.effectivePriority;
  }
  if (a.sourceDistanceKm != null && b.sourceDistanceKm != null && a.sourceDistanceKm !== b.sourceDistanceKm) {
    return a.sourceDistanceKm - b.sourceDistanceKm;
  }
  return a.hotspotId - b.hotspotId;
}

function uniqueCandidates(ids: number[], candidates: Map<number, CandidateRecord>): CandidateRecord[] {
  const seen = new Set<number>();
  const output: CandidateRecord[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const candidate = candidates.get(id);
    if (!candidate) continue;
    seen.add(id);
    output.push(candidate);
  }
  return output;
}

async function loadState(): Promise<ScenarioState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastQuoteId: String(parsed.lastQuoteId || "").trim(),
      nextScenarioIndex: Math.max(1, Number(parsed.nextScenarioIndex || 1)),
    };
  } catch {
    return { lastQuoteId: "", nextScenarioIndex: 1 };
  }
}

async function saveState(state: ScenarioState): Promise<void> {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function resolvePromptInputs(
  initialQuoteId?: string,
  initialScenarioLabel?: string,
): Promise<{ quoteId: string; scenarioLabel: string; previousState: ScenarioState }> {
  const previousState = await loadState();
  let quoteId = String(initialQuoteId || "").trim();
  let scenarioLabel = String(initialScenarioLabel || "").trim();

  if (quoteId && scenarioLabel) {
    return { quoteId, scenarioLabel, previousState };
  }

  const rl = createInterface({ input, output });
  try {
    if (!quoteId) {
      const quoteAnswer = await rl.question(
        `Quote ID${previousState.lastQuoteId ? ` [${previousState.lastQuoteId}]` : ""}: `,
      );
      quoteId = String(quoteAnswer || previousState.lastQuoteId || "").trim();
    }

    if (!scenarioLabel) {
      const suggestedScenario = `Scenario ${previousState.nextScenarioIndex}`;
      const scenarioAnswer = await rl.question(`Scenario label [${suggestedScenario}]: `);
      scenarioLabel = String(scenarioAnswer || suggestedScenario).trim();
    }
  } finally {
    rl.close();
  }

  return { quoteId, scenarioLabel, previousState };
}

function getRouteDayNumber(route: RouteRow, routeIndex: number): number {
  const declaredDay = Number(route.no_of_days || 0);
  if (Number.isInteger(declaredDay) && declaredDay > 0) {
    return declaredDay;
  }
  return routeIndex + 1;
}

function isRouteSelectedForScenario(route: RouteRow, routeIndex: number, scope?: ScenarioScope): boolean {
  if (!scope?.dayNo) return true;
  return getRouteDayNumber(route, routeIndex) === scope.dayNo;
}

function markdownHeader(): string {
  return [
    "# Itinerary Hotspot Scenario Analysis",
    "",
    "This file stores quote-specific hotspot-selection walkthroughs.",
    "",
    "How to refresh or add a scenario:",
    "",
    "```bash",
    "npm run analyze:itinerary:hotspots",
    "```",
    "",
    "You can also pass values directly:",
    "",
    "```bash",
    "npm run analyze:itinerary:hotspots -- --quote DVI20260798 --scenario \"Scenario 1\" --day 1",
    "```",
    "",
    "If `--day` is omitted, the script keeps the current all-day itinerary analysis.",
  ].join("\n");
}

async function ensureOutputFile(): Promise<void> {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  try {
    await fs.access(OUTPUT_FILE);
  } catch {
    await fs.writeFile(OUTPUT_FILE, markdownHeader(), "utf8");
  }
}

function routeRuleSummary(route: RouteRow, routeIndex: number, totalRoutes: number, viaNames: string[]): string[] {
  const sourceCity = String(route.location_name || "");
  const destinationCity = String(route.next_visiting_location || "");
  const sameCity = canonicalCityKey(sourceCity) === canonicalCityKey(destinationCity);
  const isLastRoute = routeIndex === totalRoutes - 1;
  const routeEndSeconds = toSeconds(route.route_end_time);

  const bullets: string[] = [];
  bullets.push(`direct_to_next_visiting_place = ${Number(route.direct_to_next_visiting_place || 0)}`);

  if (sameCity && viaNames.length > 0) {
    bullets.push("same-city route with via locations: auto pool prefers via/boundary hotspots over same-city source/destination auto hotspots");
  } else if (Number(route.direct_to_next_visiting_place || 0) === 1) {
    bullets.push("direct route: auto pool uses via/boundary + destination + manual, and excludes source auto hotspots");
  } else {
    bullets.push("non-direct route: auto pool uses top-3 source hotspots + via hotspots + destination hotspots + manual hotspots");
  }

  if (routeIndex === 0) {
    bullets.push("first route: Day-1 fallback helper can prioritize source-city hotspots by `priority ASC` then `distance ASC`");
  }

  if (isLastRoute && routeEndSeconds > 0 && routeEndSeconds <= 12 * 3600) {
    bullets.push("last route ends at or before 12 PM: current airport rule makes this a transfer-only route with no sightseeing");
  }

  return bullets;
}

function buildRouteCoreCity(route: RouteRow): string {
  const source = String(route.location_name || "").trim();
  const destination = String(route.next_visiting_location || "").trim();
  const sourceCore = isTerminalLocation(source) ? "" : canonicalCityKey(source);
  const destinationCore = isTerminalLocation(destination) ? "" : canonicalCityKey(destination);
  return sourceCore || destinationCore || canonicalCityKey(source) || canonicalCityKey(destination);
}

function isTerminalLocation(value: string | null | undefined): boolean {
  return /(airport|air\s*port|railway|station|bus\s*stand|bus\s*station|terminal|terminus|junction|stn)\b/i.test(String(value || ""));
}

async function buildCrossDayOptimizerNotes(params: {
  planId: number;
  db: typeof prisma;
}): Promise<string[]> {
  const { planId, db } = params;
  const previousEnabled = process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER;
  const previousDryRun = process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN;
  const previousApply = process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY;

  process.env.ENABLE_SAME_CITY_CROSS_DAY_OPTIMIZER = "true";
  process.env.SAME_CITY_CROSS_DAY_OPTIMIZER_DRY_RUN = "true";
  process.env.ALLOW_SAME_CITY_CROSS_DAY_OPTIMIZER_APPLY = "false";

  const lines: string[] = [];
  lines.push("### Cross-Day Optimizer Notes");
  lines.push("");
  lines.push("- The notes below come from the production `SameCityCrossDayOptimizerService` dry-run output, not a local approximation.");
  lines.push("");
  try {
    const optimizer = new SameCityCrossDayOptimizerService(
      {
        $transaction: async (callback: any) => callback(db),
      } as any,
      {
        rebuildRouteHotspots: async () => ({ rebuildSummary: { totalHotspotsScheduled: 0 } }),
      } as any,
    );
    const analysis = await optimizer.analyzePlanId(planId, {
      dryRun: true,
      maxMoves: 10,
    });

    lines.push(`- Optimizer enabled: ${analysis.enabled ? "yes" : "no"}`);
    lines.push(`- Dry-run default: ${analysis.dryRunDefault ? "yes" : "no"}`);
    lines.push(`- Applied: ${analysis.applied ? "yes" : "no"}`);
    if (analysis.skippedReason) {
      lines.push(`- Skip reason: ${analysis.skippedReason}`);
    }
    lines.push("");
    lines.push("Route snapshots from production optimizer:");
    for (const snapshot of analysis.routeSnapshots) {
      lines.push(
        `- Route ${snapshot.routeId} | Day ${snapshot.dayNo} | cityKey=${snapshot.cityKey || "N/A"} | transferOnly=${snapshot.transferOnly ? "yes" : "no"} | auto=${snapshot.autoHotspotCount} | manual=${snapshot.manualHotspotCount} | total=${snapshot.totalHotspotCount}`,
      );
    }
    lines.push("");

    if (analysis.proposedMoves.length === 0) {
      lines.push("- No safe cross-day redistribution was proposed for this quote.");
      lines.push("- Either the same-city chain is already balanced, the target day is protected, or no bounded hotspot cluster met the production optimizer rules.");
      lines.push("");
      return lines;
    }

    lines.push("Proposed cross-day move opportunities:");
    analysis.proposedMoves.forEach((proposal, index) => {
      lines.push(
        `${index + 1}. Move ${proposal.hotspotName} from route ${proposal.fromRouteId} to route ${proposal.toRouteId} beside ${proposal.anchorHotspotName} | raw priority ${proposal.rawPriority} | score ${proposal.score.toFixed(0)}`,
      );
      lines.push(`   Why: ${proposal.reason}`);
      if (proposal.clusterMemberNames?.length) {
        lines.push(`   Cluster members: ${proposal.clusterMemberNames.join(", ")}`);
      }
    });
    lines.push("");

    if (analysis.allocationPlan) {
      lines.push("Allocation plan from production optimizer:");
      lines.push(`- City group: ${analysis.allocationPlan.cityGroupId || "N/A"}`);
      for (const [routeId, anchors] of Object.entries(analysis.allocationPlan.fixedAnchorsByRoute)) {
        lines.push(`- Route ${routeId} fixed anchors: ${anchors.map((anchor) => anchor.hotspotId).join(", ") || "none"}`);
      }
      for (const [routeId, movableIds] of Object.entries(analysis.allocationPlan.desiredMovableHotspotIdsByRoute)) {
        lines.push(`- Route ${routeId} desired movable hotspots: ${movableIds.join(", ") || "none"}`);
      }
      for (const [routeId, order] of Object.entries(analysis.allocationPlan.desiredMovableOrderByRoute)) {
        lines.push(`- Route ${routeId} desired movable order: ${order.join(", ") || "none"}`);
      }
      for (const [routeId, pairs] of Object.entries(analysis.allocationPlan.preferredAdjacencyPairsByRoute)) {
        lines.push(
          `- Route ${routeId} preferred adjacency pairs: ${pairs.map(([a, b]) => `${a}-${b}`).join(", ") || "none"}`,
        );
      }
      lines.push(`- Unallocated hotspot IDs: ${analysis.allocationPlan.unallocatedHotspotIds.join(", ") || "none"}`);
      if (analysis.allocationPlan.rejectedAllocations.length > 0) {
        for (const rejected of analysis.allocationPlan.rejectedAllocations) {
          lines.push(`- Rejected allocation ${rejected.hotspotId} (${rejected.hotspotName}): ${rejected.reason}`);
        }
      }
      lines.push("");
    }

    return lines;
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
  }
}

function buildCandidateMap(
  route: RouteRow,
  routeRows: RouteHotspotRow[],
  viaNames: string[],
  allHotspots: HotspotMaster[],
  storedLocation: any | null,
): {
  candidateMap: Map<number, CandidateRecord>;
  mergedCandidates: CandidateRecord[];
  sourceTop3: CandidateRecord[];
  sourceCandidates: CandidateRecord[];
  destinationCandidates: CandidateRecord[];
  viaCandidates: CandidateRecord[];
  boundaryCandidates: CandidateRecord[];
  manualCandidates: CandidateRecord[];
} {
  const sourceCity = String(route.location_name || "").split("|")[0].trim();
  const destinationCity = String(route.next_visiting_location || "").split("|")[0].trim();
  const excludedIds = new Set<number>(safeJsonArray(route.excluded_hotspot_ids));
  const manualIds = new Set<number>(
    routeRows
      .filter((row) => Number(row.hotspot_plan_own_way || 0) === 1 && Number(row.hotspot_ID || 0) > 0)
      .map((row) => Number(row.hotspot_ID || 0)),
  );

  const sourceLat = storedLocation ? Number(storedLocation.source_location_lattitude || 0) : 0;
  const sourceLon = storedLocation ? Number(storedLocation.source_location_longitude || 0) : 0;

  const candidateMap = new Map<number, CandidateRecord>();

  const ensureCandidate = (hotspot: HotspotMaster): CandidateRecord => {
    const hotspotId = Number(hotspot.hotspot_ID || 0);
    const existing = candidateMap.get(hotspotId);
    if (existing) return existing;

    const sourceDistanceKm = haversineKm(
      sourceLat,
      sourceLon,
      Number(hotspot.hotspot_latitude || 0),
      Number(hotspot.hotspot_longitude || 0),
    );

    const created: CandidateRecord = {
      hotspotId,
      name: String(hotspot.hotspot_name || `Hotspot ${hotspotId}`),
      rawPriority: Number(hotspot.hotspot_priority || 0),
      effectivePriority: getEffectivePriority(Number(hotspot.hotspot_priority || 0), manualIds.has(hotspotId)),
      membership: [],
      viaMatches: [],
      sourceMatch: false,
      destinationMatch: false,
      boundaryMatch: false,
      manual: manualIds.has(hotspotId),
      location: String(hotspot.hotspot_location || ""),
      toLocation: String(hotspot.hotspot_to_location || hotspot.hotspot_location || ""),
      cityBoundaries: String(hotspot.city_boundaries || ""),
      sourceDistanceKm,
    };

    candidateMap.set(hotspotId, created);
    return created;
  };

  for (const hotspot of allHotspots) {
    const hotspotId = Number(hotspot.hotspot_ID || 0);
    if (hotspotId <= 0) continue;

    const isManual = manualIds.has(hotspotId);
    if (excludedIds.has(hotspotId) && !isManual) continue;

    const candidate = ensureCandidate(hotspot);
    const sourceMatch =
      hotspotLocationMatchesCity(hotspot.hotspot_location, sourceCity) ||
      hotspotLocationMatchesCity(hotspot.hotspot_to_location, sourceCity);
    const destinationMatch =
      hotspotLocationMatchesCity(hotspot.hotspot_location, destinationCity) ||
      hotspotLocationMatchesCity(hotspot.hotspot_to_location, destinationCity);
    const matchingViaNames = viaNames.filter(
      (viaName) =>
        hotspotLocationMatchesCity(hotspot.hotspot_location, viaName) ||
        hotspotLocationMatchesCity(hotspot.hotspot_to_location, viaName),
    );
    const boundaryMatch =
      !sourceMatch &&
      !destinationMatch &&
      boundaryMatchesRoute(hotspot.city_boundaries, sourceCity, destinationCity);

    if (isManual && !candidate.membership.includes("manual")) {
      candidate.membership.push("manual");
      candidate.manual = true;
      candidate.effectivePriority = getEffectivePriority(candidate.rawPriority, true);
    }

    if (sourceMatch && !candidate.membership.includes("source")) {
      candidate.membership.push("source");
      candidate.sourceMatch = true;
    }

    if (destinationMatch && !candidate.membership.includes("destination")) {
      candidate.membership.push("destination");
      candidate.destinationMatch = true;
    }

    for (const viaName of matchingViaNames) {
      if (!candidate.viaMatches.includes(viaName)) {
        candidate.viaMatches.push(viaName);
      }
    }
    if (matchingViaNames.length > 0 && !candidate.membership.includes("via")) {
      candidate.membership.push("via");
    }

    if (boundaryMatch && !candidate.membership.includes("boundary")) {
      candidate.membership.push("boundary");
      candidate.boundaryMatch = true;
    }
  }

  const sourceCandidates = [...candidateMap.values()].filter((candidate) => candidate.sourceMatch).sort(compareCandidates);
  const destinationCandidates = [...candidateMap.values()].filter((candidate) => candidate.destinationMatch).sort(compareCandidates);
  const viaCandidates = [...candidateMap.values()].filter((candidate) => candidate.viaMatches.length > 0).sort(compareCandidates);
  const boundaryCandidates = [...candidateMap.values()].filter((candidate) => candidate.boundaryMatch).sort(compareCandidates);
  const manualCandidates = [...candidateMap.values()].filter((candidate) => candidate.manual).sort(compareCandidates);

  const sourceTop3 = sourceCandidates.slice(0, 3);
  const sameSourceAndDestination =
    canonicalCityKey(sourceCity) !== "" && canonicalCityKey(sourceCity) === canonicalCityKey(destinationCity);
  const hasViaRoutes = viaNames.length > 0;
  const isSameCityViaOutstation = sameSourceAndDestination && hasViaRoutes;

  let mergedIds: number[] = [];
  if (isSameCityViaOutstation) {
    const base = viaCandidates.length > 0 ? viaCandidates : boundaryCandidates;
    mergedIds = [...base.map((candidate) => candidate.hotspotId), ...manualCandidates.map((candidate) => candidate.hotspotId)];
  } else if (Number(route.direct_to_next_visiting_place || 0) === 1) {
    const base = [
      ...(viaCandidates.length > 0 ? viaCandidates : boundaryCandidates),
      ...destinationCandidates,
    ];
    mergedIds = [...base.map((candidate) => candidate.hotspotId), ...manualCandidates.map((candidate) => candidate.hotspotId)];
  } else {
    const base = [...sourceTop3, ...viaCandidates, ...destinationCandidates];
    mergedIds = [...base.map((candidate) => candidate.hotspotId), ...manualCandidates.map((candidate) => candidate.hotspotId)];
  }

  const mergedCandidates = uniqueCandidates(mergedIds, candidateMap).sort(compareCandidates);

  return {
    candidateMap,
    mergedCandidates,
    sourceTop3,
    sourceCandidates,
    destinationCandidates,
    viaCandidates,
    boundaryCandidates,
    manualCandidates,
  };
}

function buildAttractionExplanation(params: {
  candidate: CandidateRecord | undefined;
  attractionRow: RouteHotspotRow;
  travelRow: RouteHotspotRow | undefined;
  route: RouteRow;
  routeIndex: number;
  totalRoutes: number;
  routeDate: Date | null;
  timingRows: TimingRow[];
}): string[] {
  const {
    candidate,
    attractionRow,
    travelRow,
    route,
    routeIndex,
    totalRoutes,
    routeDate,
    timingRows,
  } = params;

  const lines: string[] = [];
  if (!candidate) {
    lines.push("persisted attraction row exists, but the hotspot was not rebuilt into the current candidate map");
    return lines;
  }

  if (candidate.rawPriority > 0) {
    lines.push(`master priority is ${candidate.rawPriority}, so it is treated as a priority hotspot instead of optional filler`);
  } else {
    lines.push("master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered");
  }

  if (candidate.membership.length > 0) {
    lines.push(`candidate bucket matches: ${candidate.membership.join(", ")}`);
  }

  if (routeIndex === 0) {
    lines.push("this is on Day 1, so source-city ranking and the Day-1 arrival-day scheduler both influence whether it is considered early");
  }

  if (travelRow) {
    lines.push(
      `persisted travel leg reaches it at ${formatClock(travelRow.hotspot_end_time)}, which means the scheduler found a usable travel + visit slot inside the route window`,
    );
  }

  lines.push(`operating-hours evidence for route day: ${describeTiming(timingRows, candidate.hotspotId, routeDate)}`);

  if (candidate.rawPriority === 0) {
    lines.push("because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone");
  }

  if (routeIndex === totalRoutes - 1 && toSeconds(route.route_end_time) <= 12 * 3600) {
    lines.push("note: this route currently meets the transfer-only airport cutoff, so new optional sightseeing would normally be suppressed");
  }

  return lines;
}

function buildScenarioExecutiveSummary(
  quoteId: string,
  routes: RouteRow[],
  rowsByRoute: Map<number, RouteHotspotRow[]>,
  scope?: ScenarioScope,
): string[] {
  const routeSnapshots = routes.map((route, routeIndex) => {
    const routeRows = rowsByRoute.get(Number(route.itinerary_route_ID || 0)) || [];
    const selectedCount = routeRows.filter((row) => Number(row.item_type || 0) === 4).length;
    const routeEndSeconds = toSeconds(route.route_end_time);
    return {
      routeIndex,
      dayNo: getRouteDayNumber(route, routeIndex),
      selectedCount,
      isTransferOnly: routeIndex === routes.length - 1 && routeEndSeconds > 0 && routeEndSeconds <= 12 * 3600,
    };
  });

  const lines: string[] = [];
  if (scope?.dayNo) {
    const routeSnapshot = routeSnapshots.find((entry) => entry.dayNo === scope.dayNo);
    lines.push(`For quote \`${quoteId}\`, this analysis is scoped to Day ${scope.dayNo} only.`);
    if (!routeSnapshot) {
      lines.push(`Day ${scope.dayNo} does not exist in the persisted itinerary routes.`);
      return lines;
    }

    lines.push(
      `Day ${routeSnapshot.dayNo} keeps ${routeSnapshot.selectedCount} hotspot(s) and uses the same candidate-ranking rules as the full itinerary, but only for this single day.`,
    );
    if (routeSnapshot.isTransferOnly) {
      lines.push(
        "This day is the final transfer-only route, so sightseeing is suppressed by the airport-cutoff rule.",
      );
    }
    return lines;
  }

  lines.push(
    `For quote \`${quoteId}\`, the engine builds each day by first finding source / via / destination hotspot candidates, then ordering them by priority, and finally keeping only the ones that fit the day's timing window.`,
  );

  if (routeSnapshots.length > 0) {
    lines.push(
      `Selected hotspots by day: ${routeSnapshots.map((entry) => `Day ${entry.dayNo}=${entry.selectedCount}`).join(", ")}.`,
    );
  }

  if (routeSnapshots.some((entry) => entry.isTransferOnly)) {
    lines.push(
      "The last day is intentionally transfer-only because the airport-report cutoff is 12 PM or earlier, so sightseeing is suppressed before the return leg is built.",
    );
  }

  return lines;
}

function buildHumanReadableDayStory(params: {
  route: RouteRow;
  routeIndex: number;
  totalRoutes: number;
  viaNames: string[];
  candidateData: ReturnType<typeof buildCandidateMap>;
  selectedAttractions: RouteHotspotRow[];
}): string[] {
  const { route, routeIndex, totalRoutes, viaNames, candidateData, selectedAttractions } = params;
  const source = String(route.location_name || "N/A");
  const destination = String(route.next_visiting_location || "N/A");
  const direct = Number(route.direct_to_next_visiting_place || 0);
  const sameCity = canonicalCityKey(source) === canonicalCityKey(destination);
  const lines: string[] = [];

  if (routeIndex === 0) {
    lines.push(
      `This is the arrival day, so the engine starts from the arrival point (${source}) and tries to use the available post-arrival hours before the day ends.`,
    );
  } else {
    lines.push(
      `This day starts in ${source} and ends in ${destination}, so the engine treats it as a ${sameCity ? "same-city" : "city-to-city"} route for hotspot selection.`,
    );
  }

  if (sameCity && viaNames.length > 0) {
    lines.push(
      `Because source and destination normalize to the same city and a via route exists (${viaNames.join(", ")}), the engine gives more weight to via/boundary candidates than to repeating same-city auto hotspots.`,
    );
  } else if (direct === 1) {
    lines.push(
      "Because this route is marked direct, the engine skips source auto-hotspots and mainly looks at via/boundary and destination-side candidates.",
    );
  } else {
    lines.push(
      "Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.",
    );
  }

  if (selectedAttractions.length === 0) {
    if (routeIndex === totalRoutes - 1 && toSeconds(route.route_end_time) <= 12 * 3600) {
      lines.push(
        "No sightseeing survives on this day because the last-day airport cutoff converts the route into a transfer-only morning.",
      );
    } else {
      lines.push(
        "No attraction rows were persisted for this day, which means every sightseeing candidate lost to timing, fit, or route-end protection.",
      );
    }
    return lines;
  }

  const firstSelectedId = Number(selectedAttractions[0]?.hotspot_ID || 0);
  const firstSelected = candidateData.candidateMap.get(firstSelectedId);
  if (firstSelected) {
    const strongerMisses = candidateData.mergedCandidates
      .filter((candidate) => candidate.hotspotId !== firstSelected.hotspotId)
      .filter((candidate) => candidate.effectivePriority < firstSelected.effectivePriority)
      .slice(0, 3);

    lines.push(
      `${firstSelected.name} becomes the first persisted hotspot, which means it is the first candidate that both matched the route buckets and survived the actual schedule-fit checks.`,
    );

    if (strongerMisses.length > 0) {
      lines.push(
        `Even though ${strongerMisses.map((candidate) => candidate.name).join(", ")} had a stronger priority ranking, they were not persisted before ${firstSelected.name}, so they likely failed later timing/fit checks for this day's route shape.`,
      );
    }
  }

  if (selectedAttractions.length > 1) {
    lines.push(
      `After the first hotspot is fixed, the rest of the day is filled by whatever can still fit in the remaining time window without breaking route-end constraints.`,
    );
  }

  return lines;
}

function buildNearMissReason(params: {
  candidate: CandidateRecord;
  selectedAttractions: RouteHotspotRow[];
  timingRows: TimingRow[];
  routeDate: Date | null;
  route: RouteRow;
  routeIndex: number;
  totalRoutes: number;
  candidateData: ReturnType<typeof buildCandidateMap>;
}): string {
  const {
    candidate,
    selectedAttractions,
    timingRows,
    routeDate,
    route,
    routeIndex,
    totalRoutes,
    candidateData,
  } = params;

  const timingStatus = describeTiming(timingRows, candidate.hotspotId, routeDate);
  if (timingStatus === "marked closed on route day") {
    return "filtered out because the hotspot is marked closed on the route day";
  }
  if (timingStatus === "no timing row found for route day") {
    return "filtered out because there is no operating-hours row for this hotspot on the route day";
  }

  if (routeIndex === totalRoutes - 1 && toSeconds(route.route_end_time) <= 12 * 3600) {
    return "suppressed by the final transfer-only cutoff on the last route";
  }

  const selectedCandidates = selectedAttractions
    .map((row) => candidateData.candidateMap.get(Number(row.hotspot_ID || 0)))
    .filter((item): item is CandidateRecord => Boolean(item));

  if (selectedCandidates.length === 0) {
    return `not persisted because no hotspot rows were selected for Day ${Number(route.no_of_days || routeIndex + 1)}`;
  }

  const bestSelectedPriority = Math.min(...selectedCandidates.map((item) => item.rawPriority));
  const bestSelectedCandidates = selectedCandidates.filter((item) => item.rawPriority === bestSelectedPriority);

  if (candidate.rawPriority > bestSelectedPriority) {
    const names = bestSelectedCandidates.slice(0, 3).map((item) => item.name).join(", ");
    return `ranked below the persisted hotspot(s) ${names} because its priority is ${candidate.rawPriority} while the selected day was already filled by priority ${bestSelectedPriority} items`;
  }

  if (candidate.rawPriority === bestSelectedPriority) {
    const tiedNames = bestSelectedCandidates.slice(0, 3).map((item) => item.name).join(", ");
    return `tied on priority with persisted hotspot(s) ${tiedNames}, so the final choice came down to schedule-fit tie-breaking rather than priority`;
  }

  if (candidate.sourceDistanceKm != null) {
    return `remained eligible, but its source distance (${candidate.sourceDistanceKm.toFixed(1)} km) was farther than the persisted chain that fit the day`;
  }

  return "remained eligible, but the persisted chain filled the available route window before this hotspot could be placed";
}

export async function buildScenarioMarkdown(
  quoteId: string,
  scenarioLabel: string,
  scope?: ScenarioScope,
  db: typeof prisma = prisma,
): Promise<string> {
  const plan = await db.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_quote_ID: quoteId, deleted: 0 },
  });

  if (!plan) {
    throw new Error(`Quote ${quoteId} was not found in dvi_itinerary_plan_details.`);
  }

  const routes = (await db.dvi_itinerary_route_details.findMany({
    where: {
      itinerary_plan_ID: plan.itinerary_plan_ID,
      deleted: 0,
      status: 1,
    },
    orderBy: [{ itinerary_route_date: "asc" }, { itinerary_route_ID: "asc" }],
  })) as RouteRow[];

  if (scope?.dayNo) {
    const hasSelectedDay = routes.some((route, routeIndex) => getRouteDayNumber(route, routeIndex) === scope.dayNo);
    if (!hasSelectedDay) {
      throw new Error(`Day ${scope.dayNo} does not exist for quote ${quoteId}.`);
    }
  }

  const routeIds = routes.map((route) => Number(route.itinerary_route_ID || 0));

  const [routeRows, viaRoutes, allHotspots, allTimings, storedLocations] = await Promise.all([
    db.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: plan.itinerary_plan_ID,
        itinerary_route_ID: { in: routeIds },
        deleted: 0,
        status: 1,
      },
      orderBy: [{ itinerary_route_ID: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
    }) as Promise<RouteHotspotRow[]>,
    db.dvi_itinerary_via_route_details.findMany({
      where: {
        itinerary_plan_ID: plan.itinerary_plan_ID,
        itinerary_route_ID: { in: routeIds },
        deleted: 0,
        status: 1,
      },
      orderBy: [{ itinerary_route_ID: "asc" }, { itinerary_via_route_ID: "asc" }],
    }) as Promise<ViaRouteRow[]>,
    db.dvi_hotspot_place.findMany({
      where: { deleted: 0, status: 1 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_priority: true,
        hotspot_location: true,
        hotspot_to_location: true,
        hotspot_duration: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
        city_boundaries: true,
      },
      orderBy: [{ hotspot_priority: "asc" }, { hotspot_ID: "asc" }],
    }) as Promise<HotspotMaster[]>,
    db.dvi_hotspot_timing.findMany({
      where: { deleted: 0, status: 1 },
      orderBy: [{ hotspot_ID: "asc" }, { hotspot_timing_day: "asc" }],
    }) as Promise<TimingRow[]>,
    db.dvi_stored_locations.findMany({
      where: {
        location_ID: {
          in: routes
            .map((route) => Number(route.location_id || 0))
            .filter((value) => value > 0),
        },
        deleted: 0,
        status: 1,
      },
    }),
  ]);

  const rowsByRoute = new Map<number, RouteHotspotRow[]>();
  for (const row of routeRows) {
    const routeId = Number(row.itinerary_route_ID || 0);
    if (!rowsByRoute.has(routeId)) rowsByRoute.set(routeId, []);
    rowsByRoute.get(routeId)!.push(row);
  }

  const viaByRoute = new Map<number, ViaRouteRow[]>();
  for (const row of viaRoutes) {
    const routeId = Number(row.itinerary_route_ID || 0);
    if (!viaByRoute.has(routeId)) viaByRoute.set(routeId, []);
    viaByRoute.get(routeId)!.push(row);
  }

  const storedLocationById = new Map<number, any>();
  for (const row of storedLocations as any[]) {
    storedLocationById.set(Number(row.location_ID || 0), row);
  }

  const renderedLines: string[] = [];
  renderedLines.push(`## ${scenarioLabel}`);
  renderedLines.push("");
  renderedLines.push(`- Quote ID: \`${quoteId}\``);
  renderedLines.push(`- Plan ID: \`${plan.itinerary_plan_ID}\``);
  renderedLines.push(`- Generated: ${new Date().toISOString()}`);
  renderedLines.push("- Snapshot source: current persisted DB state at generation time");
  renderedLines.push(`- Scope: ${scope?.dayNo ? `Day ${scope.dayNo} only` : "all days"}`);
  renderedLines.push("");
  renderedLines.push("### Plan Summary");
  renderedLines.push("");
  renderedLines.push(`- Arrival: ${String(plan.arrival_location || "N/A")}`);
  renderedLines.push(`- Departure: ${String(plan.departure_location || "N/A")}`);
  renderedLines.push(`- Trip window: ${formatDateOnly(plan.trip_start_date_and_time)} ${formatClock(plan.trip_start_date_and_time)} -> ${formatDateOnly(plan.trip_end_date_and_time)} ${formatClock(plan.trip_end_date_and_time)}`);
  renderedLines.push(`- Days / nights: ${Number(plan.no_of_days || 0)} days, ${Number(plan.no_of_nights || 0)} nights`);
  renderedLines.push(`- Arrival type: ${Number(plan.arrival_type || 0)}`);
  renderedLines.push(`- Departure type: ${Number(plan.departure_type || 0)}`);
  renderedLines.push("");
  renderedLines.push("### Plain-English Overview");
  renderedLines.push("");
  buildScenarioExecutiveSummary(quoteId, routes, rowsByRoute, scope).forEach((line) => {
    renderedLines.push(`- ${line}`);
  });
  renderedLines.push("");
  if (!scope?.dayNo) {
    renderedLines.push("### Global Rules Used In This Analysis");
    renderedLines.push("");
    renderedLines.push("- Auto hotspot ranking uses lower numeric `hotspot_priority` first; `0` is treated as lowest/optional.");
    renderedLines.push("- `direct_to_next_visiting_place = 0` means the route can pull from source + via + destination buckets, with source auto hotspots limited to top 3.");
    renderedLines.push("- Manual hotspots would stay in the pool as effective priority `4`, but this quote currently has no manual hotspot rows.");
    renderedLines.push("- Last-route airport logic suppresses sightseeing when the final route ends at or before `12:00 PM`.");
    renderedLines.push("- Persisted attraction rows (`item_type = 4`) are treated as the final selected hotspots for the day.");
    renderedLines.push("- Candidate-pool ranking explains why a hotspot was eligible; the persisted order is the final source of truth for what actually survived schedule fit.");
    renderedLines.push("");
    renderedLines.push(...await buildCrossDayOptimizerNotes({
      planId: Number(plan.itinerary_plan_ID || 0),
      db,
    }));
  }

  routes.forEach((route, routeIndex) => {
    if (!isRouteSelectedForScenario(route, routeIndex, scope)) {
      return;
    }

    const routeId = Number(route.itinerary_route_ID || 0);
    const routeDate = route.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
    const perRouteRows = rowsByRoute.get(routeId) || [];
    const viaNames = (viaByRoute.get(routeId) || []).map((row) =>
      String(row.itinerary_via_location_name || "").split("|")[0].trim(),
    ).filter(Boolean);
    const storedLocation = storedLocationById.get(Number(route.location_id || 0)) || null;

    const candidateData = buildCandidateMap(route, perRouteRows, viaNames, allHotspots, storedLocation);
    const selectedAttractions = perRouteRows.filter((row) => Number(row.item_type || 0) === 4);
    const travelByHotspotId = new Map<number, RouteHotspotRow>();
    for (const row of perRouteRows) {
      if (Number(row.item_type || 0) === 3 && Number(row.hotspot_ID || 0) > 0 && !travelByHotspotId.has(Number(row.hotspot_ID || 0))) {
        travelByHotspotId.set(Number(row.hotspot_ID || 0), row);
      }
    }

    renderedLines.push(`### Day ${getRouteDayNumber(route, routeIndex)}`);
    renderedLines.push("");
    renderedLines.push(`- Route ID: \`${routeId}\``);
    renderedLines.push(`- Date: ${formatDateOnly(routeDate)}`);
    renderedLines.push(`- Source: ${String(route.location_name || "N/A")}`);
    renderedLines.push(`- Destination: ${String(route.next_visiting_location || "N/A")}`);
    renderedLines.push(`- Route window: ${formatTimeRange(route.route_start_time, route.route_end_time)}`);
    renderedLines.push(`- Via locations: ${viaNames.length > 0 ? viaNames.join(", ") : "none"}`);
    renderedLines.push(`- Distance on route row: ${String(route.no_of_km || "N/A")}`);
    renderedLines.push("");
    renderedLines.push("Human-readable selection story:");
    buildHumanReadableDayStory({
      route,
      routeIndex,
      totalRoutes: routes.length,
      viaNames,
      candidateData,
      selectedAttractions,
    }).forEach((line) => {
      renderedLines.push(`- ${line}`);
    });
    renderedLines.push("");
    renderedLines.push("Route-rule summary:");
    routeRuleSummary(route, routeIndex, routes.length, viaNames).forEach((line) => {
      renderedLines.push(`- ${line}`);
    });
    renderedLines.push("");
    renderedLines.push("Candidate pool snapshot:");
    renderedLines.push(`- Source matches: ${candidateData.sourceCandidates.length} total, top-3 used for non-direct source bucket`);
    renderedLines.push(`- Destination matches: ${candidateData.destinationCandidates.length}`);
    renderedLines.push(`- Via matches: ${candidateData.viaCandidates.length}`);
    renderedLines.push(`- Boundary matches: ${candidateData.boundaryCandidates.length}`);
    renderedLines.push(`- Manual matches: ${candidateData.manualCandidates.length}`);
    renderedLines.push(`- Final merged candidate count before schedule fit: ${candidateData.mergedCandidates.length}`);
    renderedLines.push("");
    if (candidateData.sourceTop3.length > 0) {
      renderedLines.push("Top source-side candidates that the engine is most willing to try first:");
      candidateData.sourceTop3.forEach((candidate, index) => {
        const distanceText =
          candidate.sourceDistanceKm != null ? `${candidate.sourceDistanceKm.toFixed(1)} km from source` : "distance unavailable";
        renderedLines.push(
          `${index + 1}. ${candidate.name} | priority ${candidate.rawPriority} | ${distanceText}`,
        );
      });
      renderedLines.push("");
    }

    if (candidateData.mergedCandidates.length > 0) {
      renderedLines.push("Top merged candidates before timing fit:");
      candidateData.mergedCandidates.slice(0, 8).forEach((candidate, index) => {
        const distanceText =
          candidate.sourceDistanceKm != null ? `${candidate.sourceDistanceKm.toFixed(1)} km from route source` : "distance unavailable";
        renderedLines.push(
          `${index + 1}. ${candidate.name} | raw priority ${candidate.rawPriority} | effective priority ${candidate.effectivePriority} | buckets: ${candidate.membership.join(", ")} | ${distanceText}`,
        );
      });
      renderedLines.push("");
    }

    if (selectedAttractions.length === 0) {
      renderedLines.push("Selected hotspots:");
      renderedLines.push("- None");
      renderedLines.push("");
      const hasTransferOnlyRow = perRouteRows.some((row) => Number(row.item_type || 0) === 7);
      if (hasTransferOnlyRow) {
        renderedLines.push("Why no hotspot was selected:");
        if (toSeconds(route.route_end_time) <= 12 * 3600) {
          renderedLines.push("- This is the last airport-return route and its end time is `12:00 PM` or earlier, so the current rule makes it transfer-only.");
        }
        renderedLines.push("- The persisted route only contains an `item_type = 7` airport transfer row, which means sightseeing rows were intentionally skipped.");
        if (candidateData.sourceTop3.length > 0) {
          renderedLines.push(
            `- Even though candidates such as ${candidateData.sourceTop3.map((candidate) => candidate.name).join(", ")} are eligible in the generic pool, the transfer-only rule stops them from being persisted on this last day.`,
          );
        }
        renderedLines.push("");
      }
      return;
    }

    renderedLines.push("Selected hotspots in persisted order:");
    selectedAttractions.forEach((row, index) => {
      const hotspotId = Number(row.hotspot_ID || 0);
      const candidate = candidateData.candidateMap.get(hotspotId);
      const travelRow = travelByHotspotId.get(hotspotId);
      const explanations = buildAttractionExplanation({
        candidate,
        attractionRow: row,
        travelRow,
        route,
        routeIndex,
        totalRoutes: routes.length,
        routeDate,
        timingRows: allTimings,
      });

      renderedLines.push(`${index + 1}. ${candidate?.name || `Hotspot ${hotspotId}`}`);
      renderedLines.push(`   Travel into hotspot: ${travelRow ? formatTimeRange(travelRow.hotspot_start_time, travelRow.hotspot_end_time) : "not found"}`);
      renderedLines.push(`   Visit window: ${formatTimeRange(row.hotspot_start_time, row.hotspot_end_time)} (${formatDuration(row.hotspot_start_time, row.hotspot_end_time)})`);
      renderedLines.push(`   Persisted route hotspot row: \`${row.route_hotspot_ID}\``);
      explanations.forEach((line) => {
        renderedLines.push(`   Why selected: ${line}`);
      });
    });
    renderedLines.push("");

    const selectedIds = new Set<number>(selectedAttractions.map((row) => Number(row.hotspot_ID || 0)));
    const nearMisses = candidateData.mergedCandidates.filter((candidate) => !selectedIds.has(candidate.hotspotId)).slice(0, 5);
    if (nearMisses.length > 0) {
      renderedLines.push("Notable eligible but unpersisted candidates:");
      nearMisses.forEach((candidate) => {
        const reason = buildNearMissReason({
          candidate,
          selectedAttractions,
          timingRows: allTimings,
          routeDate,
          route,
          routeIndex,
          totalRoutes: routes.length,
          candidateData,
        });
        renderedLines.push(
          `- ${candidate.name} | raw priority ${candidate.rawPriority} | buckets: ${candidate.membership.join(", ")} | reason: ${reason}`,
        );
      });
      renderedLines.push("");
    }
  });

  return `${renderedLines.join("\n")}\n`;
}

async function appendScenarioToFile(markdown: string): Promise<void> {
  await ensureOutputFile();
  await fs.appendFile(OUTPUT_FILE, `\n${markdown}`, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { quoteId, scenarioLabel, previousState } = await resolvePromptInputs(args.quote, args.scenario);
  const dayNo = parseOptionalDay(args.day ?? args.dayNo ?? args.day_no);

  if (!quoteId) {
    throw new Error("Quote ID is required.");
  }

  const markdown = await buildScenarioMarkdown(quoteId, scenarioLabel, dayNo ? { dayNo } : undefined);
  await appendScenarioToFile(markdown);

  const nextScenarioIndex = Math.max(
    previousState.nextScenarioIndex + 1,
    Number((scenarioLabel.match(/(\d+)/)?.[1] || 0)) + 1 || previousState.nextScenarioIndex + 1,
  );
  await saveState({
    lastQuoteId: quoteId,
    nextScenarioIndex,
  });

  console.log(`Scenario written to ${OUTPUT_FILE}`);
  console.log(`Quote: ${quoteId}`);
  console.log(`Scenario: ${scenarioLabel}`);
  console.log(`Scope: ${dayNo ? `Day ${dayNo} only` : "all days"}`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
