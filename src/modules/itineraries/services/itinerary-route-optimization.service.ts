import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import {
  ItineraryRouteNormalizationService,
  RouteOptimizationContext,
} from './itinerary-route-normalization.service';
import {
  parseDurationToMinutes,
} from '../engines/helpers/distance.helper';

type RouteSegmentMetric = {
  source: string;
  destination: string;
  distanceKm: number;
  durationMinutes: number;
  valid: boolean;
};

export type RouteOptimizationScoreBreakdown = {
  totalDistanceKm: number;
  totalTravelMinutes: number;
  backtrackingKm: number;

  // Existing compatibility / relaxed-route metric.
  comfortPenalty: number;

  // DVI Dynamic Tourism Route Optimisation metrics.
  waitingMinutes: number;
  trafficRiskMinutes: number;
  futurePositionKm: number;
  constraintPenalty: number;

  // All weighted inputs are normalized to 0-100 before scoring.
  normalizedTravelTime: number;
  normalizedDistance: number;
  normalizedBacktracking: number;
  normalizedWaiting: number;
  normalizedTrafficRisk: number;
  normalizedFuturePosition: number;

  distanceCost: number;
  timeCost: number;
  backtrackingCost: number;
  waitingCost: number;
  trafficRiskCost: number;
  futurePositionCost: number;

  // Kept for existing Relaxed Route / response compatibility.
  comfortCost: number;

  totalCost: number;
};

export type RouteOptimizationCandidate = {
  rank: number;

  label:
    | 'Best Overall'
    | 'Least Driving'
    | 'Relaxed Route'
    | 'Alternative';

  routeScore: number;

  routeLocations: string[];

  routes: any[];

  metrics: RouteOptimizationScoreBreakdown;
};

export type RouteOptimizationPreview = {
  optimized: boolean;

  originalRouteCount: number;

  originalRouteLocations: string[];

  fixedArrival: string;

  fixedDeparture: string;

  candidates: RouteOptimizationCandidate[];

  fallbackReason: string | null;
};

type EvaluatedCandidate = {
  routeLocations: string[];
  metrics: RouteOptimizationScoreBreakdown;
};

@Injectable()
export class ItineraryRouteOptimizationService {
  private readonly routeMetricCache =
    new Map<
      string,
      Promise<RouteSegmentMetric>
    >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly routeNormalization: ItineraryRouteNormalizationService,
  ) {}

async optimizeRouteOrder(routes: any[], plan?: any): Promise<any[]> {
    const preview =
      await this.previewRouteOptions(
        routes,
        plan,
      );

    if (
      !preview.optimized ||
      preview.candidates.length === 0
    ) {
      return routes;
    }

    // Existing Show Better Route behaviour remains automatic.
    // The first candidate is always Best Overall.
    return preview.candidates[0].routes;
  }

  async previewRouteOptions(
    routes: any[],
    plan?: any,
  ): Promise<RouteOptimizationPreview> {
    const safeRoutes =
      Array.isArray(routes) ? routes : [];

    const originalRouteLocations =
      this.buildRawRouteLocations(safeRoutes);
    if (safeRoutes.length <= 2) {
      return this.buildFallbackPreview(
        safeRoutes,
        plan,
        'Not enough movable itinerary days to optimize.',
      );
    }

    // Never attempt optimization when itinerary header and route rows
    // already disagree.
    const planDayCount =
      Number(plan?.no_of_days || 0);

    if (
      planDayCount > 0 &&
      safeRoutes.length !== planDayCount
    ) {
      return this.buildFallbackPreview(
        safeRoutes,
        plan,
        `Incoming route count (${safeRoutes.length}) does not match plan day count (${planDayCount}).`,
      );
    }

        const debugOptimization =
      process.env.DEBUG_ROUTE_OPTIMIZER ===
      'true';

    /*
     * Do not use a fixed movable-day boundary.
     *
     * Exhaustive search is controlled by the actual number of
     * permutations the server is allowed to evaluate.
     *
     * Both limits are runtime configuration so they can be tuned
     * without changing or redeploying optimization logic.
     */
    const exhaustivePermutationBudget =
      this.getExhaustivePermutationBudget();

    const heuristicCandidateBudget =
      this.getHeuristicCandidateBudget();

    const log = (message: string) =>
      console.log(message);

    const logDebug = (message: string) => {
      if (debugOptimization) {
        log(message);
      }
    };

    const context =
      this.routeNormalization
        .extractRouteOptimizationContext(
          safeRoutes,
        );

    this.logOptimizationSummary(
      context,
      log,
      debugOptimization,
    );

    if (!context.start || !context.end) {
      return this.buildFallbackPreview(
        safeRoutes,
        plan,
        'Missing fixed arrival or departure location.',
      );
    }

    if (
      this.routeNormalization
        .hasBrokenChain(safeRoutes)
    ) {
      return this.buildFallbackPreview(
        safeRoutes,
        plan,
        'Broken route chain detected.',
      );
    }

    const validation =
      this.validateOptimizationInputs(
        context,
      );

    if (!validation.isValid) {
      return this.buildFallbackPreview(
        safeRoutes,
        plan,
        `Route normalization is not safe for optimization: ${
          validation.reason || 'unknown'
        }.`,
      );
    }

    const middleLocations =
      context.movableStops.map(
        (stop) => stop.name,
      );

    if (middleLocations.length === 0) {
      return this.buildFallbackPreview(
        safeRoutes,
        plan,
        'No movable intermediate destinations remain after normalization.',
      );
    }

    log(
      `[RouteOptimization] Start smart optimization. ` +
      `routeCount=${safeRoutes.length}, ` +
      `start=${context.start}, ` +
      `end=${context.end}, ` +
      `movableCount=${middleLocations.length}, ` +
      `stayDayCount=${
        context.stayDays.reduce(
          (sum, item) =>
            sum + item.count,
          0,
        )
      }`,
    );

    // Load each unique road metric once before factorial candidate scoring.
    await this.preloadRouteMetrics([
      context.start,
      ...middleLocations,
      context.end,
    ]);

    let movableOrders: string[][];

    const useExhaustiveSearch =
      this.shouldUseExhaustiveSearch(
        middleLocations.length,
        exhaustivePermutationBudget,
      );

    if (useExhaustiveSearch) {
      movableOrders =
        this.generatePermutations_PHP(
          [...middleLocations],
        );

      log(
        `[RouteOptimization] Smart exhaustive candidate generation. ` +
        `movable=${middleLocations.length}, ` +
        `permutationBudget=${exhaustivePermutationBudget}, ` +
        `candidates=${movableOrders.length}`,
      );
    } else {
      /*
       * IMPORTANT:
       * Existing Nearest Neighbor + Simulated Annealing logic remains
       * completely untouched and is still used as the distance seed.
       */
      const distanceSeedChain =
        await this
          .optimizeWith_NearestNeighborAndAnnealing(
            context.start,
            context.end,
            middleLocations,
            logDebug,
          );

      const distanceSeedMiddle =
        distanceSeedChain.slice(1, -1);

      movableOrders =
        this.buildHeuristicMovableOrders(
          middleLocations,
          distanceSeedMiddle,
          heuristicCandidateBudget,
        );

      log(
        `[RouteOptimization] Smart heuristic candidate generation. ` +
        `movable=${middleLocations.length}, ` +
        `permutationBudget=${exhaustivePermutationBudget}, ` +
        `candidateBudget=${heuristicCandidateBudget}, ` +
        `candidates=${movableOrders.length}`,
      );
    }

    const evaluated =
      await this.evaluateMovableOrders(
        safeRoutes,
        plan,
        context,
        movableOrders,
        logDebug,
      );

    if (evaluated.length === 0) {
      return this.buildFallbackPreview(
        safeRoutes,
        plan,
        'No candidate had usable distance and travel-time data.',
      );
    }

    const selected =
      this.selectDisplayCandidates(
        evaluated,
      );

    const bestCost =
      Math.max(
        0.0001,
        evaluated[0].metrics.totalCost,
      );

    const candidates =
      selected.map(
        (selection, index) => {
          const optimizedRoutes =
            this.buildOptimizedRouteDtos(
              safeRoutes,
              selection
                .candidate
                .routeLocations,
              log,
            );

          return {
            rank: index + 1,

            label:
              selection.label,

            routeScore:
              this.calculateRelativeRouteScore(
                selection
                  .candidate
                  .metrics
                  .totalCost,
                bestCost,
              ),

            routeLocations:
              selection
                .candidate
                .routeLocations,

            routes:
              optimizedRoutes,

            metrics:
              selection
                .candidate
                .metrics,
          } satisfies RouteOptimizationCandidate;
        },
      );

    const best = candidates[0];

    log(
      `[RouteOptimization] OK Smart optimization completed. ` +
      `bestScore=${best?.routeScore ?? 0}, ` +
      `bestCost=${best?.metrics.totalCost ?? 0}, ` +
      `bestRoute=[${
        best?.routeLocations.join(' -> ') ||
        ''
      }]`,
    );

    return {
      optimized: true,

      originalRouteCount:
        safeRoutes.length,

      originalRouteLocations,

      fixedArrival:
        context.start,

      fixedDeparture:
        context.end,

      candidates,

      fallbackReason: null,
    };
  }

  private validateOptimizationInputs(
  context: RouteOptimizationContext,
): {
  isValid: boolean;
  reason?: string;
} {
  if (
    !context.start ||
    !context.end
  ) {
    return {
      isValid: false,
      reason:
        'missing-start-or-end',
    };
  }

  for (
    const stop of
      context.movableStops
  ) {
    if (
      !stop.name ||
      !stop.normalizedName
    ) {
      return {
        isValid: false,
        reason:
          'empty-movable-stop',
      };
    }
  }

  /*
   * Repeated movable locations are valid.
   *
   * Example:
   * A -> B -> C -> B -> D
   *
   * Both B occurrences must participate in optimization.
   * Candidate integrity is already protected later by
   * hasSameLocationMultiset().
   */
  return {
    isValid: true,
  };
}
  private logOptimizationSummary(
  context: RouteOptimizationContext,
  log: (msg: string) => void,
  debug: boolean,
): void {
  log(
    `[RouteOptimization] Raw route chain: ${
      context.sourceLocations
        .map(
          (source, index) =>
            `${source} -> ${
              context.nextVisitingLocations[index] || ''
            }`,
        )
        .join(' | ')
    }`,
  );

  log(
    `[RouteOptimization] Full path raw=[${
      context.rawFullPath.join(', ')
    }], cleaned=[${
      context.cleanedFullPath.join(', ')
    }]`,
  );

  log(
    `[RouteOptimization] Fixed anchors: ` +
      `arrival=${context.start}, ` +
      `departure=${context.end}. ` +
      `Movable=[${
        context.movableStops
          .map((stop) => stop.name)
          .join(', ')
      }]`,
  );

  if (context.stayDays.length > 0) {
    log(
      `[RouteOptimization] Preserved stay days: ${
        context.stayDays
          .map(
            (item) =>
              `${item.name}x${item.count}`,
          )
          .join(', ')
      }`,
    );
  }

  if (context.removedDuplicates.length > 0) {
    log(
      `[RouteOptimization] Removed duplicate movable stops: [${
        context.removedDuplicates
          .map((item) => item.name)
          .join(', ')
      }]`,
    );
  }

  if (
    context.removedInvalidTerminalNodes.length > 0
  ) {
    log(
      `[RouteOptimization] Removed invalid anchor-like nodes: ${
        context.removedInvalidTerminalNodes
          .map(
            (item) =>
              `${item.name}(${item.reason})`,
          )
          .join(', ')
      }`,
    );
  }

  if (debug) {
    log(
      `[RouteOptimization][DEBUG] Raw middle locations: [${
        context.rawMiddleLocations.join(', ')
      }]`,
    );
  }
}

  private buildOptimizedRouteDtos(
    routes: any[],
    routeLocations: string[],
    log: (msg: string) => void,
  ): any[] {
    // IMPORTANT:
    // Never remove consecutive duplicate locations here.
    // They are explicit stay days reconstructed after optimization.
    const cleanedLocations =
      routeLocations
        .map((location) =>
          String(location || '').trim(),
        )
        .filter(Boolean);

    if (
      cleanedLocations.length < 2
    ) {
      log(
        '[RouteOptimization] WARN Optimized route locations are invalid. Returning original route order.',
      );

      return routes;
    }

    const expectedLocationCount =
      routes.length + 1;

    if (
      cleanedLocations.length !==
      expectedLocationCount
    ) {
      log(
        `[RouteOptimization] WARN Route length mismatch after optimization. ` +
        `expectedLocations=${expectedLocationCount}, ` +
        `actualLocations=${cleanedLocations.length}, ` +
        `expectedRoutes=${routes.length}. ` +
        `Returning original route order to preserve all itinerary days.`,
      );

      return routes;
    }

    const optimizedRoutes: any[] = [];

    const usedPairTemplateIndexes =
      new Set<number>();

    for (
      let index = 0;
      index < routes.length;
      index++
    ) {
      const source =
        cleanedLocations[index];

      const destination =
        cleanedLocations[index + 1];

      // Day-specific properties such as date/start/end remain associated
      // with the itinerary day.
      const dayTemplate =
        routes[index] || {};

      // Leg-specific properties such as via route and km should move only
      // when the exact original source/destination pair still exists.
      const pairTemplateIndex =
        routes.findIndex(
          (
            candidate: any,
            candidateIndex: number,
          ) =>
            !usedPairTemplateIndexes.has(
              candidateIndex,
            ) &&
            this.sameLiteralLocation(
              candidate?.location_name,
              source,
            ) &&
            this.sameLiteralLocation(
              candidate
                ?.next_visiting_location,
              destination,
            ),
        );

      const pairTemplate =
        pairTemplateIndex >= 0
          ? routes[pairTemplateIndex]
          : null;

      if (
        pairTemplateIndex >= 0
      ) {
        usedPairTemplateIndexes.add(
          pairTemplateIndex,
        );
      }

      const newRoute: any = {
        ...dayTemplate,

        location_name:
          source,

        next_visiting_location:
          destination,
      };

      if (pairTemplate) {
        // Exact road leg still exists; preserve its route-specific data.
        newRoute.no_of_km =
          pairTemplate.no_of_km ?? '';

        newRoute
          .direct_to_next_visiting_place =
          pairTemplate
            .direct_to_next_visiting_place ??
          dayTemplate
            .direct_to_next_visiting_place ??
          1;

        newRoute.via_route =
          pairTemplate.via_route ?? '';

        newRoute.via_routes =
          Array.isArray(
            pairTemplate.via_routes,
          )
            ? pairTemplate
                .via_routes
                .map(
                  (item: any) => ({
                    ...item,
                  }),
                )
            : [];
      } else {
        // This is a NEW road leg produced by optimization.
        //
        // Never reuse distance/via information belonging to the old
        // destination at this day index. RouteEngine will resolve the
        // new source/destination distance from dvi_stored_locations.
        newRoute.no_of_km = '';

        newRoute.via_route = '';

        newRoute.via_routes = [];
      }

      optimizedRoutes.push(
        newRoute,
      );
    }

        const startDate =
      new Date(
        routes[0]
          .itinerary_route_date,
      );

    optimizedRoutes.forEach(
      (route, index) => {
        const newDate =
          new Date(startDate);

        newDate.setDate(
          newDate.getDate() + index,
        );

        route.itinerary_route_date =
          newDate
            .toISOString()
            .split('T')[0];

        route.no_of_days =
          index + 1;
      },
    );

    return optimizedRoutes;
  }

  private async evaluateMovableOrders(
    routes: any[],
    plan: any,
    context: RouteOptimizationContext,
    movableOrders: string[][],
    logDebug: (msg: string) => void,
  ): Promise<EvaluatedCandidate[]> {
    const expectedLocationCount =
      routes.length + 1;

    const byKey =
      new Map<
        string,
        EvaluatedCandidate
      >();

    for (
      let index = 0;
      index < movableOrders.length;
      index++
    ) {
      const order =
        movableOrders[index];

      const baseChain = [
        context.start,
        ...order,
        context.end,
      ];

      const routeLocations =
        this.expandStayDays(
          baseChain,
          context,
        );

      // Absolute rule:
      // optimization cannot add or remove itinerary days.
      if (
        routeLocations.length !==
        expectedLocationCount
      ) {
        logDebug(
          `[RouteOptimization][DEBUG] Reject candidate because day count changed. ` +
          `expectedLocations=${expectedLocationCount}, ` +
          `actualLocations=${routeLocations.length}, ` +
          `chain=[${routeLocations.join(' -> ')}]`,
        );

        continue;
      }

      const key =
        this.routeLocationsKey(
          routeLocations,
        );

      if (byKey.has(key)) {
        continue;
      }

      const metrics =
        await this.scoreRouteLocations(
          routeLocations,
          routes,
          plan,
        );

      // Missing road metric makes this candidate unsafe.
      if (!metrics) {
        continue;
      }

      byKey.set(key, {
        routeLocations,
        metrics,
      });
    }

   const scoredCandidates =
  this.applyDynamicTourismScores(
    Array.from(byKey.values()),
  );

return scoredCandidates.sort(
  (left, right) =>
    // IMPORTANT:
    // Preserve B2B/DVI requirement: actual road distance is priority #1.
    left.metrics.totalDistanceKm -
      right.metrics.totalDistanceKm ||

    // When distance is equal/competitive, use the complete
    // normalized DVI Dynamic Tourism score.
    left.metrics.totalCost -
      right.metrics.totalCost ||

    left.metrics.totalTravelMinutes -
      right.metrics.totalTravelMinutes,
);
  }

  private expandStayDays(
    baseChain: string[],
    context: RouteOptimizationContext,
  ): string[] {
    const expanded: string[] = [];

    const consumedStayKeys =
      new Set<string>();

    for (
      const location of baseChain
    ) {
      expanded.push(location);

      const identity =
        this.routeLocationIdentity(
          location,
        );

      if (
        !identity ||
        consumedStayKeys.has(identity)
      ) {
        continue;
      }

      const stay =
        context.stayDays.find(
          (item) =>
            this.routeLocationIdentity(
              item.name,
            ) === identity,
        );

      if (
        !stay ||
        stay.count <= 0
      ) {
        continue;
      }

      consumedStayKeys.add(
        identity,
      );

      for (
        let count = 0;
        count < stay.count;
        count++
      ) {
        expanded.push(location);
      }
    }

    return expanded;
  }

  private async scoreRouteLocations(
  routeLocations: string[],
  routes: any[],
  plan: any,
): Promise<
  RouteOptimizationScoreBreakdown | null
> {
  let totalDistanceKm = 0;
  let totalTravelMinutes = 0;
  let waitingMinutes = 0;
  let trafficRiskMinutes = 0;
  let constraintPenalty = 0;

  const segmentDistances: number[] = [];

  for (
    let index = 0;
    index < routeLocations.length - 1;
    index++
  ) {
    const source =
      routeLocations[index];

    const destination =
      routeLocations[index + 1];

    const metric =
      await this.getRouteMetric(
        source,
        destination,
      );

    // Same safety behaviour as B2B:
    // unusable road data = unusable candidate.
    if (!metric.valid) {
      return null;
    }

    const availableMinutes =
      this.resolveDayAvailableMinutes(
        index,
        routes,
        plan,
      );

    // HARD CONSTRAINT:
    // If the road transfer itself cannot fit inside the available
    // itinerary window, reject the candidate instead of rewarding it
    // with a lower mathematical score.
    if (
      availableMinutes > 0 &&
      metric.durationMinutes >
        availableMinutes
    ) {
      return null;
    }

    totalDistanceKm +=
      metric.distanceKm;

    totalTravelMinutes +=
      metric.durationMinutes;

    segmentDistances.push(
      metric.distanceKm,
    );

    waitingMinutes +=
      this.calculateKnownWaitingMinutes(
        index,
        routes,
        plan,
      );

    trafficRiskMinutes +=
      this.calculateTrafficRiskMinutes(
        metric,
      );

    constraintPenalty +=
      this.calculateComfortPenalty(
        metric.durationMinutes,
        index,
        routes,
        plan,
      );
  }

  const backtrackingKm =
    await this.calculateBacktrackingKm(
      routeLocations,
    );

  const futurePositionKm =
    this.calculateFuturePositionPenalty(
      segmentDistances,
    );

  /*
   * Do NOT calculate the weighted score here.
   *
   * T, D, B, W, R and F must first be normalized
   * against all valid candidate routes.
   *
   * applyDynamicTourismScores() performs that second pass.
   */
  return {
    totalDistanceKm:
      this.round(
        totalDistanceKm,
      ),

    totalTravelMinutes:
      Math.round(
        totalTravelMinutes,
      ),

    backtrackingKm:
      this.round(
        backtrackingKm,
      ),

    comfortPenalty:
      this.round(
        constraintPenalty,
      ),

    waitingMinutes:
      Math.round(
        waitingMinutes,
      ),

    trafficRiskMinutes:
      this.round(
        trafficRiskMinutes,
      ),

    futurePositionKm:
      this.round(
        futurePositionKm,
      ),

    constraintPenalty:
      this.round(
        constraintPenalty,
      ),

    normalizedTravelTime: 0,
    normalizedDistance: 0,
    normalizedBacktracking: 0,
    normalizedWaiting: 0,
    normalizedTrafficRisk: 0,
    normalizedFuturePosition: 0,

    distanceCost: 0,
    timeCost: 0,
    backtrackingCost: 0,
    waitingCost: 0,
    trafficRiskCost: 0,
    futurePositionCost: 0,

    // Kept for Relaxed Route compatibility.
    comfortCost:
      this.round(
        constraintPenalty,
      ),

    totalCost: 0,
  };
}

private applyDynamicTourismScores(
  candidates: EvaluatedCandidate[],
): EvaluatedCandidate[] {
  if (candidates.length === 0) {
    return [];
  }

  const travelTimeRange =
    this.getMetricRange(
      candidates,
      (candidate) =>
        candidate.metrics
          .totalTravelMinutes,
    );

  const distanceRange =
    this.getMetricRange(
      candidates,
      (candidate) =>
        candidate.metrics
          .totalDistanceKm,
    );

  const backtrackingRange =
    this.getMetricRange(
      candidates,
      (candidate) =>
        candidate.metrics
          .backtrackingKm,
    );

  const waitingRange =
    this.getMetricRange(
      candidates,
      (candidate) =>
        candidate.metrics
          .waitingMinutes,
    );

  const trafficRiskRange =
    this.getMetricRange(
      candidates,
      (candidate) =>
        candidate.metrics
          .trafficRiskMinutes,
    );

  const futurePositionRange =
    this.getMetricRange(
      candidates,
      (candidate) =>
        candidate.metrics
          .futurePositionKm,
    );

  return candidates.map(
    (candidate) => {
      const metrics =
        candidate.metrics;

      const normalizedTravelTime =
        this.normalizeLowerIsBetter(
          metrics.totalTravelMinutes,
          travelTimeRange.min,
          travelTimeRange.max,
        );

      const normalizedDistance =
        this.normalizeLowerIsBetter(
          metrics.totalDistanceKm,
          distanceRange.min,
          distanceRange.max,
        );

      const normalizedBacktracking =
        this.normalizeLowerIsBetter(
          metrics.backtrackingKm,
          backtrackingRange.min,
          backtrackingRange.max,
        );

      const normalizedWaiting =
        this.normalizeLowerIsBetter(
          metrics.waitingMinutes,
          waitingRange.min,
          waitingRange.max,
        );

      const normalizedTrafficRisk =
        this.normalizeLowerIsBetter(
          metrics.trafficRiskMinutes,
          trafficRiskRange.min,
          trafficRiskRange.max,
        );

      const normalizedFuturePosition =
        this.normalizeLowerIsBetter(
          metrics.futurePositionKm,
          futurePositionRange.min,
          futurePositionRange.max,
        );

      /*
       * DVI Dynamic Tourism Route Optimisation Formula
       *
       * Lower score = better.
       *
       * T = 40%
       * D = 15%
       * B = 15%
       * W = 10%
       * R = 10%
       * F = 10%
       *
       * IMPORTANT:
       * Road distance is still the primary B2B/DVI sort criterion.
       * This formula is the smart secondary comparison.
       */
      const timeCost =
        normalizedTravelTime * 0.40;

      const distanceCost =
        normalizedDistance * 0.15;

      const backtrackingCost =
        normalizedBacktracking * 0.15;

      const waitingCost =
        normalizedWaiting * 0.10;

      const trafficRiskCost =
        normalizedTrafficRisk * 0.10;

      const futurePositionCost =
        normalizedFuturePosition * 0.10;

      const totalCost =
        timeCost +
        distanceCost +
        backtrackingCost +
        waitingCost +
        trafficRiskCost +
        futurePositionCost;

      return {
        ...candidate,

        metrics: {
          ...metrics,

          normalizedTravelTime:
            this.round(
              normalizedTravelTime,
            ),

          normalizedDistance:
            this.round(
              normalizedDistance,
            ),

          normalizedBacktracking:
            this.round(
              normalizedBacktracking,
            ),

          normalizedWaiting:
            this.round(
              normalizedWaiting,
            ),

          normalizedTrafficRisk:
            this.round(
              normalizedTrafficRisk,
            ),

          normalizedFuturePosition:
            this.round(
              normalizedFuturePosition,
            ),

          timeCost:
            this.round(
              timeCost,
            ),

          distanceCost:
            this.round(
              distanceCost,
            ),

          backtrackingCost:
            this.round(
              backtrackingCost,
            ),

          waitingCost:
            this.round(
              waitingCost,
            ),

          trafficRiskCost:
            this.round(
              trafficRiskCost,
            ),

          futurePositionCost:
            this.round(
              futurePositionCost,
            ),

          totalCost:
            this.round(
              totalCost,
            ),
        },
      };
    },
  );
}

private getMetricRange(
  candidates: EvaluatedCandidate[],
  selector: (
    candidate: EvaluatedCandidate,
  ) => number,
): {
  min: number;
  max: number;
} {
  let min = Infinity;
  let max = -Infinity;

  for (const candidate of candidates) {
    const value =
      Number(selector(candidate));

    if (!Number.isFinite(value)) {
      continue;
    }

    if (value < min) {
      min = value;
    }

    if (value > max) {
      max = value;
    }
  }

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max)
  ) {
    return {
      min: 0,
      max: 0,
    };
  }

  return {
    min,
    max,
  };
}

private normalizeLowerIsBetter(
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) {
    return 100;
  }

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    max <= min
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      100,
      (
        (value - min) /
        (max - min)
      ) * 100,
    ),
  );
}

private calculateKnownWaitingMinutes(
  dayIndex: number,
  routes: any[],
  plan: any,
): number {
  const route =
    routes[dayIndex] || {};

  /*
   * At Show Better Route stage the hotspot timeline has not
   * been rebuilt yet, so do not invent attraction waiting time.
   *
   * Use only waiting that is already known from the route's
   * planned start window.
   */
  if (!route?.route_start_time) {
    return 0;
  }

  const isFirst =
    dayIndex === 0;

  const baselineStartMinutes =
    isFirst
      ? this.parseWallClockMinutes(
          plan?.trip_start_date ||
            plan
              ?.pick_up_date_and_time,
          8 * 60,
        )
      : 8 * 60;

  const actualStartMinutes =
    this.parseWallClockMinutes(
      route.route_start_time,
      baselineStartMinutes,
    );

  return Math.max(
    0,
    actualStartMinutes -
      baselineStartMinutes,
  );
}

private calculateTrafficRiskMinutes(
  metric: RouteSegmentMetric,
): number {
  if (
    !metric.valid ||
    metric.distanceKm <= 0 ||
    metric.durationMinutes <= 0
  ) {
    return 0;
  }

  /*
   * No new Google/Mapbox dependency is introduced here.
   *
   * B2B/DVI already trusts stored road distance + duration.
   * A route materially slower than the normal reference road
   * speed naturally receives additional hill/congestion risk.
   */
  const referenceSpeedKmph =
    this.readPositiveNumber(
      process.env
        .ROUTE_OPT_REFERENCE_SPEED_KMPH,
      45,
    );

  if (referenceSpeedKmph <= 0) {
    return 0;
  }

  const referenceMinutes =
    (
      metric.distanceKm /
      referenceSpeedKmph
    ) * 60;

  return Math.max(
    0,
    metric.durationMinutes -
      referenceMinutes,
  );
}

private calculateFuturePositionPenalty(
  segmentDistances: number[],
): number {
  if (
    !Array.isArray(
      segmentDistances,
    ) ||
    segmentDistances.length <= 1
  ) {
    return 0;
  }

  /*
   * Penalise leaving large driving burdens for later days.
   *
   * Example:
   * if one route leaves a 200 KM transfer for the final part
   * of the itinerary while another progressively moves toward
   * the departure side, the second route receives a better
   * Future Position value.
   */
  let remainingDistance =
    segmentDistances.reduce(
      (sum, distance) =>
        sum +
        (
          Number.isFinite(distance)
            ? Math.max(0, distance)
            : 0
        ),
      0,
    );

  let futurePositionPenalty = 0;

  for (
    let index = 0;
    index <
      segmentDistances.length - 1;
    index++
  ) {
    remainingDistance -=
      Math.max(
        0,
        segmentDistances[index] || 0,
      );

    futurePositionPenalty +=
      Math.max(
        0,
        remainingDistance,
      );
  }

  return futurePositionPenalty;
}

  private calculateComfortPenalty(
    durationMinutes: number,
    dayIndex: number,
    routes: any[],
    plan: any,
  ): number {
    if (
      !Number.isFinite(
        durationMinutes,
      ) ||
      durationMinutes <= 0
    ) {
      return 0;
    }

    // Defaults can later be changed through environment values.
    const comfortableDriveMinutes =
      this.readPositiveNumber(
        process.env
          .ROUTE_OPT_COMFORT_DRIVE_MINUTES,
        240, // 4 hours
      );

    const hardDriveMinutes =
      Math.max(
        comfortableDriveMinutes,

        this.readPositiveNumber(
          process.env
            .ROUTE_OPT_HARD_DRIVE_MINUTES,
          360, // 6 hours
        ),
      );

    let penalty = 0;

    // Gradual penalty after 4h of driving.
    if (
      durationMinutes >
      comfortableDriveMinutes
    ) {
      penalty +=
        Math.ceil(
          (
            durationMinutes -
            comfortableDriveMinutes
          ) / 30,
        ) * 5;
    }

    // Additional strong penalty after 6h.
    if (
      durationMinutes >
      hardDriveMinutes
    ) {
      penalty +=
        Math.ceil(
          (
            durationMinutes -
            hardDriveMinutes
          ) / 30,
        ) * 10;
    }

    // Arrival/departure days have smaller usable windows.
    const availableMinutes =
      this.resolveDayAvailableMinutes(
        dayIndex,
        routes,
        plan,
      );

    if (
      availableMinutes > 0 &&
      durationMinutes >
        availableMinutes
    ) {
      penalty +=
        Math.ceil(
          (
            durationMinutes -
            availableMinutes
          ) / 30,
        ) * 20;
    }

    return penalty;
  }

  private resolveDayAvailableMinutes(
    dayIndex: number,
    routes: any[],
    plan: any,
  ): number {
    const isFirst =
      dayIndex === 0;

    const isLast =
      dayIndex ===
      routes.length - 1;

    const route =
      routes[dayIndex] || {};

    let startMinutes =
      this.parseWallClockMinutes(
        route?.route_start_time,

        isFirst
          ? this.parseWallClockMinutes(
              plan?.trip_start_date ||
                plan
                  ?.pick_up_date_and_time,
              8 * 60,
            )
          : 8 * 60,
      );

    let endMinutes =
      this.parseWallClockMinutes(
        route?.route_end_time,

        isLast
          ? this.parseWallClockMinutes(
              plan?.trip_end_date,
              20 * 60,
            )
          : 20 * 60,
      );

    // Match the same departure concept already used by RouteEngine:
    // Flight 2h buffer, Train 1h, Road 0.
    if (
      isLast &&
      !route?.route_end_time
    ) {
      endMinutes =
        Math.max(
          startMinutes,

          endMinutes -
            this.getDepartureBufferMinutes(
              plan?.departure_type,
            ),
        );
    }

    if (
      endMinutes <
      startMinutes
    ) {
      endMinutes +=
        24 * 60;
    }

    return Math.max(
      0,
      endMinutes -
        startMinutes,
    );
  }

  private async calculateBacktrackingKm(
    routeLocations: string[],
  ): Promise<number> {
    const departure =
      routeLocations[
        routeLocations.length - 1
      ];

    const toleranceKm =
      this.readPositiveNumber(
        process.env
          .ROUTE_OPT_BACKTRACK_TOLERANCE_KM,
        10,
      );

    let penaltyKm = 0;

    for (
      let index = 0;
      index <
      routeLocations.length - 2;
      index++
    ) {
      const current =
        routeLocations[index];

      const next =
        routeLocations[index + 1];

      const [
        currentToDeparture,
        nextToDeparture,
      ] =
        await Promise.all([
          this.getRouteMetric(
            current,
            departure,
          ),

          this.getRouteMetric(
            next,
            departure,
          ),
        ]);

      if (
        !currentToDeparture.valid ||
        !nextToDeparture.valid
      ) {
        continue;
      }

      // If the next city is materially farther from final departure,
      // the itinerary is geographically moving backwards.
      const movedAwayByKm =
        nextToDeparture.distanceKm -
        currentToDeparture.distanceKm;

      if (
        movedAwayByKm >
        toleranceKm
      ) {
        penaltyKm +=
          movedAwayByKm;
      }
    }

    return penaltyKm;
  }

  private selectDisplayCandidates(
    ranked: EvaluatedCandidate[],
  ): Array<{
    label:
      RouteOptimizationCandidate['label'];

    candidate:
      EvaluatedCandidate;
  }> {
    const selected: Array<{
      label:
        RouteOptimizationCandidate['label'];

      candidate:
        EvaluatedCandidate;
    }> = [];

    const used =
      new Set<string>();

    const add = (
      label:
        RouteOptimizationCandidate['label'],

      candidate?:
        EvaluatedCandidate,
    ) => {
      if (!candidate) {
        return;
      }

      const key =
        this.routeLocationsKey(
          candidate.routeLocations,
        );

      if (used.has(key)) {
        return;
      }

      used.add(key);

      selected.push({
        label,
        candidate,
      });
    };

    // Lowest combined cost.
    add(
      'Best Overall',
      ranked[0],
    );

    // Lowest road distance among remaining unique alternatives.
    add(
      'Least Driving',

      [...ranked]
        .filter(
          (candidate) =>
            !used.has(
              this.routeLocationsKey(
                candidate
                  .routeLocations,
              ),
            ),
        )
        .sort(
          (left, right) =>
            left.metrics
              .totalDistanceKm -
              right.metrics
                .totalDistanceKm ||

            left.metrics
              .totalTravelMinutes -
              right.metrics
                .totalTravelMinutes ||

            left.metrics.totalCost -
              right.metrics.totalCost,
        )[0],
    );

    // Smallest comfort penalty among remaining routes.
    add(
      'Relaxed Route',

      [...ranked]
        .filter(
          (candidate) =>
            !used.has(
              this.routeLocationsKey(
                candidate
                  .routeLocations,
              ),
            ),
        )
        .sort(
          (left, right) =>
            left.metrics
              .comfortPenalty -
              right.metrics
                .comfortPenalty ||

            left.metrics
              .totalTravelMinutes -
              right.metrics
                .totalTravelMinutes ||

            left.metrics
              .backtrackingKm -
              right.metrics
                .backtrackingKm ||

            left.metrics.totalCost -
              right.metrics.totalCost,
        )[0],
    );

    // A small itinerary may not have three distinct permutations.
    for (
      const candidate of ranked
    ) {
      if (
        selected.length >= 3
      ) {
        break;
      }

      add(
        'Alternative',
        candidate,
      );
    }

    return selected.slice(0, 3);
  }

    private buildHeuristicMovableOrders(
    original: string[],
    distanceSeed: string[],
    maxCandidates: number,
  ): string[][] {
    const orders: string[][] = [];

    const seen =
      new Set<string>();

    const hasCapacity = () =>
      orders.length <
      maxCandidates;

    const add = (
      order: string[],
    ) => {
      if (
        order.length !==
          original.length ||
        !hasCapacity() ||
        !this.hasSameLocationMultiset(
          order,
          original,
        )
      ) {
        return;
      }

      const key =
        order
          .map((item) =>
            this.routeLocationIdentity(
              item,
            ),
          )
          .join('>');

      if (
        !key ||
        seen.has(key)
      ) {
        return;
      }

      seen.add(key);

      orders.push([
        ...order,
      ]);
    };

    /*
     * Do not trust the annealing seed only because its length matches.
     * It must contain exactly the same movable destinations.
     */
    const validDistanceSeed =
      this.hasSameLocationMultiset(
        distanceSeed,
        original,
      )
        ? distanceSeed
        : original;

    const rawSeeds = [
      original,
      validDistanceSeed,
      [...original].reverse(),
      [...validDistanceSeed].reverse(),
    ];

    const seedMap =
      new Map<string, string[]>();

    for (
      const seed of rawSeeds
    ) {
      if (
        !this.hasSameLocationMultiset(
          seed,
          original,
        )
      ) {
        continue;
      }

      const key =
        seed
          .map((item) =>
            this.routeLocationIdentity(
              item,
            ),
          )
          .join('>');

      if (
        key &&
        !seedMap.has(key)
      ) {
        seedMap.set(
          key,
          [...seed],
        );
      }
    }

    const seeds =
      Array.from(
        seedMap.values(),
      );

    for (
      const seed of seeds
    ) {
      add(seed);
    }

    /*
     * Span-first traversal is important.
     *
     * Every itinerary position gets a chance to move before progressively
     * wider changes are attempted. This prevents later itinerary days
     * from being ignored when a candidate budget is reached.
     *
     * The existing scoring formula evaluates these candidates afterwards.
     */
    for (
      let span = 1;
      span < original.length;
      span++
    ) {
      for (
        let left = 0;
        left + span <
          original.length;
        left++
      ) {
        const right =
          left + span;

        for (
          const seed of seeds
        ) {
          /*
           * 1. Existing pair-swap style candidate.
           */
          const swapped =
            [...seed];

          [
            swapped[left],
            swapped[right],
          ] = [
            swapped[right],
            swapped[left],
          ];

          add(swapped);

          if (!hasCapacity()) {
            return orders;
          }

          /*
           * 2. Segment reversal / 2-opt style candidate.
           *
           * This lets the optimizer investigate several connected
           * itinerary positions instead of changing only one pair.
           */
          const segmentReversed =
            [...seed];

          const reversedSegment =
            segmentReversed
              .slice(
                left,
                right + 1,
              )
              .reverse();

          segmentReversed.splice(
            left,
            reversedSegment.length,
            ...reversedSegment,
          );

          add(segmentReversed);

          if (!hasCapacity()) {
            return orders;
          }

          /*
           * 3. Relocate left destination to the right.
           */
          const moveLeftToRight =
            [...seed];

          const [
            leftLocation,
          ] =
            moveLeftToRight.splice(
              left,
              1,
            );

          moveLeftToRight.splice(
            right,
            0,
            leftLocation,
          );

          add(moveLeftToRight);

          if (!hasCapacity()) {
            return orders;
          }

          /*
           * 4. Relocate right destination to the left.
           */
          const moveRightToLeft =
            [...seed];

          const [
            rightLocation,
          ] =
            moveRightToLeft.splice(
              right,
              1,
            );

          moveRightToLeft.splice(
            left,
            0,
            rightLocation,
          );

          add(moveRightToLeft);

          if (!hasCapacity()) {
            return orders;
          }
        }
      }
    }

    return orders;
  }
  private shouldUseExhaustiveSearch(
    movableCount: number,
    maxPermutations: number,
  ): boolean {
    if (
      !Number.isInteger(
        movableCount,
      ) ||
      movableCount < 0 ||
      !Number.isFinite(
        maxPermutations,
      ) ||
      maxPermutations < 1
    ) {
      return false;
    }

    /*
     * Calculate factorial progressively without ever constructing
     * the permutations first.
     *
     * Stop as soon as the configured workload would be exceeded.
     * This prevents factorial memory/CPU explosions.
     */
    let permutationCount = 1;

    for (
      let factor = 2;
      factor <= movableCount;
      factor++
    ) {
      if (
        permutationCount >
        maxPermutations /
          factor
      ) {
        return false;
      }

      permutationCount *=
        factor;
    }

    return (
      permutationCount <=
      maxPermutations
    );
  }

  private hasSameLocationMultiset(
    candidate: string[],
    expected: string[],
  ): boolean {
    if (
      !Array.isArray(candidate) ||
      candidate.length !==
        expected.length
    ) {
      return false;
    }

    const counts =
      new Map<string, number>();

    for (
      const location of expected
    ) {
      const identity =
        this.routeLocationIdentity(
          location,
        );

      if (!identity) {
        return false;
      }

      counts.set(
        identity,
        (counts.get(identity) || 0) +
          1,
      );
    }

    for (
      const location of candidate
    ) {
      const identity =
        this.routeLocationIdentity(
          location,
        );

      const remaining =
        counts.get(identity) || 0;

      if (
        !identity ||
        remaining <= 0
      ) {
        return false;
      }

      if (remaining === 1) {
        counts.delete(identity);
      } else {
        counts.set(
          identity,
          remaining - 1,
        );
      }
    }

    return counts.size === 0;
  }

  private calculateRelativeRouteScore(
    totalCost: number,
    bestCost: number,
  ): number {
    if (
      !Number.isFinite(totalCost) ||
      totalCost < 0
    ) {
      return 0;
    }

    if (
      !Number.isFinite(bestCost) ||
      bestCost <= 0
    ) {
      return 100;
    }

    const relativeLoss =
      Math.max(
        0,
        (
          totalCost -
          bestCost
        ) / bestCost,
      );

    return Math.max(
      1,
      Math.min(
        100,
        Math.round(
          100 -
          relativeLoss * 100,
        ),
      ),
    );
  }
  private async buildFallbackPreview(
    routes: any[],
    plan: any,
    reason: string,
  ): Promise<RouteOptimizationPreview> {
    const routeLocations =
      this.buildRawRouteLocations(routes);

const rawMetrics =
  routeLocations.length === routes.length + 1
    ? await this.scoreRouteLocations(
        routeLocations,
        routes,
        plan,
      )
    : null;

const fallbackCandidate =
  rawMetrics
    ? this.applyDynamicTourismScores([
        {
          routeLocations,
          metrics: rawMetrics,
        },
      ])[0]
    : null;

const metrics =
  fallbackCandidate?.metrics || null;
    return {
      optimized: false,

      originalRouteCount: routes.length,

      originalRouteLocations: routeLocations,

      fixedArrival:
        routeLocations[0] || '',

      fixedDeparture:
        routeLocations[
          routeLocations.length - 1
        ] || '',

      candidates: metrics
        ? [
            {
              rank: 1,

              label: 'Best Overall',

              routeScore: 100,

              routeLocations,

              routes,

              metrics,
            },
          ]
        : [],

      fallbackReason: reason,
    };
  }

  private buildRawRouteLocations(
    routes: any[],
  ): string[] {
    if (
      !Array.isArray(routes) ||
      routes.length === 0
    ) {
      return [];
    }

    const first =
      String(
        routes[0]?.location_name || '',
      ).trim();

    return [
      first,

      ...routes.map(
        (route) =>
          String(
            route?.next_visiting_location || '',
          ).trim(),
      ),
    ].filter(Boolean);
  }

  private async preloadRouteMetrics(
    locations: string[],
  ): Promise<void> {
    const unique =
      Array.from(
        new Set(
          locations
            .map((location) =>
              String(location || '').trim(),
            )
            .filter(Boolean),
        ),
      );

    const lookups: Array<
      Promise<RouteSegmentMetric>
    > = [];

    for (const source of unique) {
      for (const destination of unique) {
        if (
          this.sameLiteralLocation(
            source,
            destination,
          )
        ) {
          continue;
        }

        lookups.push(
          this.getRouteMetric(
            source,
            destination,
          ),
        );
      }
    }

    await Promise.all(lookups);
  }

  private async getRouteMetric(
    sourceLocation: string,
    destinationLocation: string,
  ): Promise<RouteSegmentMetric> {
    const source =
      String(sourceLocation || '').trim();

    const destination =
      String(destinationLocation || '').trim();

    if (!source || !destination) {
      return {
        source,
        destination,
        distanceKm: Infinity,
        durationMinutes: Infinity,
        valid: false,
      };
    }

    // Literal same-place route is an explicit stay day.
    if (
      this.sameLiteralLocation(
        source,
        destination,
      )
    ) {
      return {
        source,
        destination,
        distanceKm: 0,
        durationMinutes: 0,
        valid: true,
      };
    }

    const cacheKey =
      `${this.routeLocationIdentity(source)}|` +
      `${this.routeLocationIdentity(destination)}`;

    const cached =
      this.routeMetricCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const lookup =
      this.loadRouteMetric(
        source,
        destination,
      );

    this.routeMetricCache.set(
      cacheKey,
      lookup,
    );

    return lookup;
  }

  private async loadRouteMetric(
    source: string,
    destination: string,
  ): Promise<RouteSegmentMetric> {
    try {
      const record =
        await (this.prisma as any)
          .dvi_stored_locations
          .findFirst({
            where: {
              source_location: source,
              destination_location:
                destination,
              status: 1,
              deleted: 0,
            },

            orderBy: {
              location_ID: 'desc',
            },

            select: {
              distance: true,
              duration: true,
            },
          });

      const distanceKm =
        Number.parseFloat(
          String(
            record?.distance ?? '',
          ),
        );

      const storedDurationMinutes =
        parseDurationToMinutes(
          record?.duration,
        );

      const fallbackAverageSpeedKmph =
        this.readPositiveNumber(
          process.env
            .ROUTE_OPT_FALLBACK_SPEED_KMPH,
          45,
        );

      const durationMinutes =
        Number.isFinite(
          Number(storedDurationMinutes),
        ) &&
        Number(storedDurationMinutes) > 0
          ? Number(storedDurationMinutes)
          : Number.isFinite(distanceKm) &&
              distanceKm > 0 &&
              fallbackAverageSpeedKmph > 0
            ? Math.max(
                5,
                Math.round(
                  (
                    distanceKm /
                    fallbackAverageSpeedKmph
                  ) * 60,
                ),
              )
            : Infinity;

      const valid =
        Number.isFinite(distanceKm) &&
        distanceKm > 0 &&
        Number.isFinite(durationMinutes) &&
        durationMinutes > 0;

      return {
        source,
        destination,

        distanceKm:
          valid
            ? distanceKm
            : Infinity,

        durationMinutes:
          valid
            ? durationMinutes
            : Infinity,

        valid,
      };
    } catch (error) {
      console.warn(
        '[RouteOptimization] Route metric lookup failed',
        {
          source,
          destination,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );

      return {
        source,
        destination,
        distanceKm: Infinity,
        durationMinutes: Infinity,
        valid: false,
      };
    }
  }

  private routeLocationsKey(
    routeLocations: string[],
  ): string {
    return routeLocations
      .map((location) =>
        this.routeLocationIdentity(location),
      )
      .join('>');
  }

  private routeLocationIdentity(
    value: unknown,
  ): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  private sameLiteralLocation(
    left: unknown,
    right: unknown,
  ): boolean {
    return (
      this.routeLocationIdentity(left) ===
      this.routeLocationIdentity(right)
    );
  }

  private parseWallClockMinutes(
    value: unknown,
    fallback: number,
  ): number {
    const raw =
      String(value ?? '').trim();

    const match =
      raw.match(
        /(?:T|\s|^)(\d{1,2}):(\d{2})(?::\d{2})?/,
      );

    if (!match) {
      return fallback;
    }

    const hours =
      Number(match[1] || 0);

    const minutes =
      Number(match[2] || 0);

    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      return fallback;
    }

    return (
      hours * 60 +
      minutes
    );
  }

  private getDepartureBufferMinutes(
    departureType: unknown,
  ): number {
    switch (
      Number(departureType || 0)
    ) {
      case 1:
        // Flight
        return 120;

      case 2:
        // Train
        return 60;

      default:
        // Road / unknown
        return 0;
    }
  }

    private getExhaustivePermutationBudget(): number {
    return 100000;
  }

  private getHeuristicCandidateBudget(): number {
    return 5000;
  }

  private readPositiveNumber(
    value: unknown,
    fallback: number,
  ): number {
    const parsed =
      Number(value);

    return (
      Number.isFinite(parsed) &&
      parsed >= 0
    )
      ? parsed
      : fallback;
  }

  private round(
    value: number,
  ): number {
    return Number(
      Number(value || 0)
        .toFixed(2),
    );
  }

 /**
  * PHP-EXACT: small candidate sets only - EXHAUSTIVE PERMUTATION
   * Tries all permutations of middleLocations and finds the one with minimum total distance
 */
  private async optimizeWith_ExhaustivePermutation(
    start: string,
    end: string,
    middleLocations: string[],
    log: (msg: string) => void,
    logDebug: (msg: string) => void
  ): Promise<string[]> {
    const perms = this.generatePermutations_PHP([...middleLocations]);

 let bestPerm: string[] = middleLocations; // Default to original order
    let bestDistance = Infinity;
    let bestChain = '';

    log(`[ExhaustivePermutation] Testing ${perms.length} permutations...`);

    let tested = 0;
    for (const perm of perms) {
      tested++;
      let current = start;
      let totalDistance = 0;
      const chain: string[] = [current];

 // Evaluate cost: start -> perm[0] -> perm[1] -> ... -> perm[n-1] -> end
      for (const loc of perm) {
        const distance = await this.getDistance_PHP(current, loc);
        if (distance === Infinity) {
          totalDistance = Infinity;
 break; // Missing distance = invalid permutation
        }
        totalDistance += distance;
        current = loc;
        chain.push(current);
      }

 // Add final segment: last middle location -> end
      if (totalDistance !== Infinity) {
        const finalDist = await this.getDistance_PHP(current, end);
        if (finalDist === Infinity) {
          totalDistance = Infinity;
        } else {
          totalDistance += finalDist;
          chain.push(end);
        }
      }

      const chainStr = chain.join(' -> ');

      if (totalDistance < bestDistance) {
        bestDistance = totalDistance;
        bestPerm = perm;
        bestChain = chainStr;
        log(`[ExhaustivePermutation] best-so-far=${bestDistance === Infinity ? 'INVALID' : bestDistance.toFixed(1) + ' km'} route=[${bestPerm.join(', ')}]`);
      } else if (tested % 250 === 0) {
        logDebug(`[ExhaustivePermutation][DEBUG] progress=${tested}/${perms.length} best=${bestDistance === Infinity ? 'INVALID' : bestDistance.toFixed(1) + ' km'}`);
      }
    }

    log(`[ExhaustivePermutation] âœ… Best permutation: [${bestPerm.join(',')}] = ${bestDistance.toFixed(1)} km`);
    log(`[ExhaustivePermutation] Best chain: ${bestChain}`);

 // Return final route locations: [start, ...bestPerm, end]
    return [start, ...bestPerm, end];
  }

 /**
   * PHP-EXACT: large candidate sets - NEAREST NEIGHBOR + SIMULATED ANNEALING
 */
  private async optimizeWith_NearestNeighborAndAnnealing(
    start: string,
    end: string,
    middleLocations: string[],
    log: (msg: string) => void
  ): Promise<string[]> {
 // Build remainingLocationsCounts (like PHP's array_count_values for duplicates)
    const remainingLocationsCounts = this.buildLocationCounts_PHP(middleLocations);
    log(`[NearestNeighbor] Location counts: ${JSON.stringify(remainingLocationsCounts)}`);

 // Greedy nearest neighbor
    const greedyRoute = await this.nearestNeighbor_PHP(start, remainingLocationsCounts, log);
    log(`[NearestNeighbor] Greedy route: [${greedyRoute.join(', ')}]`);

 // Build initial route: [start, ...greedy, end]
    let initialRoute = [start, ...greedyRoute, end];
    let initialDistance = await this.calculateChainDistance_PHP(initialRoute, log);
    log(`[SimulatedAnnealing] Initial route distance: ${initialDistance.toFixed(1)} km`);

 // Simulated annealing
    const finalRoute = await this.simulatedAnnealing_PHP(
      initialRoute,
 1000, // initialTemp
 0.003, // coolingRate
      log
    );

    let finalDistance = await this.calculateChainDistance_PHP(finalRoute, log);
    log(`[SimulatedAnnealing] Final route distance: ${finalDistance.toFixed(1)} km`);

    return finalRoute;
  }

 /**
   * PHP-EXACT: Build location counts like array_count_values
 */
  private buildLocationCounts_PHP(locations: string[]): { [location: string]: number } {
    const counts: { [location: string]: number } = {};
    for (const loc of locations) {
      counts[loc] = (counts[loc] || 0) + 1;
    }
    return counts;
  }

 /**
   * PHP-EXACT: Nearest neighbor greedy algorithm
   * Returns ordered list of middle locations (not including start/end)
 */
  private async nearestNeighbor_PHP(
    start: string,
    remainingLocationsCounts: { [location: string]: number },
    log: (msg: string) => void
  ): Promise<string[]> {
    const route: string[] = [];
    let current = start;

 // Total locations to visit
    const totalLocations = Object.values(remainingLocationsCounts).reduce((a, b) => a + b, 0);

    log(`[NearestNeighbor] Total middle locations to visit: ${totalLocations}`);

    for (let step = 0; step < totalLocations; step++) {
      let nearestLocation: string | null = null;
      let minDistance = Infinity;

 // Find nearest unvisited location
      for (const [location, count] of Object.entries(remainingLocationsCounts)) {
        if (count > 0) {
          const distance = await this.getDistance_PHP(current, location);
          if (distance < minDistance) {
            minDistance = distance;
            nearestLocation = location;
          }
        }
      }

      if (nearestLocation === null) break;

      route.push(nearestLocation);
      remainingLocationsCounts[nearestLocation]--;
      current = nearestLocation;

      log(`[NearestNeighbor] Step ${step + 1}: Selected ${nearestLocation} (distance: ${minDistance.toFixed(1)} km)`);
    }

    return route;
  }

 /**
   * PHP-EXACT: Simulated annealing optimization
 */
  private async simulatedAnnealing_PHP(
    initialRoute: string[],
    initialTemp: number,
    coolingRate: number,
    log: (msg: string) => void
  ): Promise<string[]> {
    let currentRoute = [...initialRoute];
    let currentDistance = await this.calculateChainDistance_PHP(currentRoute, log);
    let bestRoute = [...currentRoute];
    let bestDistance = currentDistance;

    let temperature = initialTemp;
    const minTemp = 0.001;
    let iteration = 0;

    log(`[SimulatedAnnealing] Starting with temp=${temperature.toFixed(2)}, coolingRate=${coolingRate}`);

    while (temperature > minTemp) {
      iteration++;

 // Random swap of two middle indices (NOT first or last)
      const middleStart = 1;
 const middleEnd = currentRoute.length - 2; // Exclude end

 if (middleEnd <= middleStart) break; // Not enough locations to swap

      const i = middleStart + Math.floor(Math.random() * (middleEnd - middleStart + 1));
      const j = middleStart + Math.floor(Math.random() * (middleEnd - middleStart + 1));

      if (i === j) {
        temperature *= (1 - coolingRate);
        continue;
      }

 // Create neighbor solution
      const newRoute = [...currentRoute];
      [newRoute[i], newRoute[j]] = [newRoute[j], newRoute[i]];

      const newDistance = await this.calculateChainDistance_PHP(newRoute, log);
      const delta = newDistance - currentDistance;

 // Acceptance rule: accept if better OR accept with probability based on temperature
      if (delta < 0 || Math.random() < Math.exp(-delta / temperature)) {
        currentRoute = newRoute;
        currentDistance = newDistance;

        if (currentDistance < bestDistance) {
          bestRoute = [...currentRoute];
          bestDistance = currentDistance;
          log(`[SimulatedAnnealing] Iteration ${iteration}: New best distance = ${bestDistance.toFixed(1)} km (temp=${temperature.toFixed(4)})`);
        }
      }

      temperature *= (1 - coolingRate);

      if (iteration % 100 === 0) {
        log(`[SimulatedAnnealing] Iteration ${iteration}: current=${currentDistance.toFixed(1)} km, best=${bestDistance.toFixed(1)} km, temp=${temperature.toFixed(4)}`);
      }
    }

    log(`[SimulatedAnnealing] Completed ${iteration} iterations`);
    return bestRoute;
  }

 /**
   * PHP-EXACT: Calculate total distance for a route chain
 */
  private async calculateChainDistance_PHP(chain: string[], log?: (msg: string) => void): Promise<number> {
    let totalDistance = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const distance = await this.getDistance_PHP(chain[i], chain[i + 1]);
      if (distance === Infinity) return Infinity;
      totalDistance += distance;
    }
    return totalDistance;
  }

 /**
   * Calculate distance matrix between locations
   * In a real scenario, this would call Google Maps or similar API
   * For now, using a simplified distance calculation or mock data
 */




 /**
   * PHP-EXACT: Get distance between two locations from database
   * Returns Infinity if distance not found (matching PHP's PHP_INT_MAX behavior)
   * NO reverse fallback, NO default 100, ONLY exact match
 */
private async getDistance_PHP(
  sourceLocation: string,
  destinationLocation: string,
): Promise<number> {
  const metric =
    await this.getRouteMetric(
      sourceLocation,
      destinationLocation,
    );

  return metric.valid
    ? metric.distanceKm
    : Infinity;
}

 /**
   * PHP-EXACT: Generate all permutations of a location array (preserves duplicates)
   * Used only when the configured exhaustive permutation budget allows it.
 */
  private generatePermutations_PHP(arr: string[]): string[][] {
    if (arr.length <= 1) return [arr];

    const result: string[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const current = arr[i];
      const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
      const perms = this.generatePermutations_PHP(remaining);

      for (const perm of perms) {
        result.push([current, ...perm]);
      }
    }

    return result;
  }
}
