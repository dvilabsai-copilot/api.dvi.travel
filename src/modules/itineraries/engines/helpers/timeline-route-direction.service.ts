import axios from 'axios';

export interface RoadPoint { lat: number; lon: number }
export interface RoadJourney {
  distanceKm: number;
  durationSeconds: number;
  legs: Array<{ distanceKm: number; durationSeconds: number }>;
}
export type RoadRouter = (points: RoadPoint[]) => Promise<RoadJourney | null>;

/** Directional road lookups for automatic scheduling only; never writes master data. */
export class TimelineRouteDirectionService {
  private static cache = new Map<string, { expires: number; value: RoadJourney }>();
  private requests = 0;
  private unavailable = false;

  constructor(private readonly router?: RoadRouter) {}

  static usable(point?: RoadPoint | null): point is RoadPoint {
    return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
      Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180 &&
      (point.lat !== 0 || point.lon !== 0);
  }

  async journey(points: RoadPoint[]): Promise<RoadJourney | null> {
    if (!points.every(TimelineRouteDirectionService.usable)) return null;
    if (this.router) return this.router(points);
    const base = String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').replace(/\/$/, '');
    const coordinates = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const key = `${base}/${coordinates}`;
    const cached = TimelineRouteDirectionService.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    // Bound provider work per route. A failed provider is not retried for every candidate.
    if (this.unavailable || this.requests >= 24) return null;
    this.requests++;
    try {
      const { data } = await axios.get(key, {
        params: { overview: 'false', steps: 'false' }, timeout: 2500,
      });
      const route = data?.code === 'Ok' ? data.routes?.[0] : null;
      if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) ||
          route.legs?.length !== points.length - 1 ||
          route.legs.some((leg: any) => !Number.isFinite(leg.distance) || !Number.isFinite(leg.duration))) {
        this.unavailable = true;
        return null;
      }
      const value: RoadJourney = {
        distanceKm: route.distance / 1000, durationSeconds: route.duration,
        legs: route.legs.map((leg: any) => ({ distanceKm: leg.distance / 1000, durationSeconds: leg.duration })),
      };
      if (TimelineRouteDirectionService.cache.size >= 512) TimelineRouteDirectionService.cache.clear();
      TimelineRouteDirectionService.cache.set(key, { expires: Date.now() + 600000, value });
      return value;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  async insertion(from: RoadPoint, candidate: RoadPoint, to: RoadPoint) {
    const direct = await this.journey([from, to]);
    if (!direct) return null;
    const inserted = await this.journey([from, candidate, to]);
    if (!inserted) return null;
    return {
      inserted,
      extraKm: Math.max(0, inserted.distanceKm - direct.distanceKm),
      extraSeconds: Math.max(0, inserted.durationSeconds - direct.durationSeconds),
      baselineKm: direct.distanceKm,
    };
  }

  static withinBudget(fit: { extraKm: number; extraSeconds: number; baselineKm: number } | null,
    usedKm = 0, usedSeconds = 0): boolean {
    const limit = (name: string, fallback: number) => {
      const value = Number(process.env[name]);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return !!fit && fit.extraKm + usedKm <= limit('HOTSPOT_ROUTE_MAX_DETOUR_KM', 5) &&
      fit.extraSeconds + usedSeconds <= limit('HOTSPOT_ROUTE_MAX_DETOUR_MINUTES', 15) * 60 &&
      // Avoid unstable ratios on short town legs; the absolute limits still apply.
      fit.extraKm / Math.max(20, fit.baselineKm) <= limit('HOTSPOT_ROUTE_MAX_DETOUR_RATIO', 0.25);
  }
}

/** Keep priority targets, inserting only proven, feasible stops along their approach. */
export async function orderPriorityApproach<T>(input: {
  queue: T[];
  candidates: T[];
  id: (candidate: T) => number;
  coords: (candidate: T) => RoadPoint;
  eligible: (candidate: T) => boolean;
  target: (candidate: T) => boolean;
  from: RoadPoint;
  startSeconds: number;
  roads: TimelineRouteDirectionService;
  project: (candidate: T, from: RoadPoint, startSeconds: number, roadSeconds: number) => Promise<number | null>;
}): Promise<{ queue: T[]; approachIds: Set<number> }> {
  const queue: T[] = [];
  const approachIds = new Set<number>();
  const emitted = new Set<number>();
  const insertedIds = new Set<number>();
  const processed = new Set<T>();
  let from = input.from;
  let seconds = input.startSeconds;
  let usedKm = 0;
  let usedSeconds = 0;
  for (const target of input.queue) {
    processed.add(target);
    if (insertedIds.has(input.id(target))) continue;
    if (!input.target(target)) {
      queue.push(target);
      emitted.add(input.id(target));
      const travel = await input.roads.journey([from, input.coords(target)]);
      const end = travel && await input.project(target, from, seconds, travel.durationSeconds);
      if (end == null) break;
      from = input.coords(target);
      seconds = end;
      continue;
    }
    const point = input.coords(target);
    const matches: Array<{ candidate: T; distance: number }> = [];
    for (const candidate of input.candidates.filter(input.eligible).slice(0, 8)) {
      if (input.id(candidate) === input.id(target) || emitted.has(input.id(candidate))) continue;
      const fit = await input.roads.insertion(from, input.coords(candidate), point);
      if (TimelineRouteDirectionService.withinBudget(fit)) {
        matches.push({ candidate, distance: fit!.inserted.legs[0].distanceKm });
      }
    }
    matches.sort((a, b) => a.distance - b.distance || input.id(a.candidate) - input.id(b.candidate));
    for (const { candidate } of matches) {
      const fit = await input.roads.insertion(from, input.coords(candidate), point);
      if (!TimelineRouteDirectionService.withinBudget(fit, usedKm, usedSeconds)) continue;
      const end = await input.project(candidate, from, seconds, fit!.inserted.legs[0].durationSeconds);
      if (end === null) continue;
      const targetEnd = await input.project(target, input.coords(candidate), end, fit!.inserted.legs[1].durationSeconds);
      if (targetEnd === null) continue;
      queue.push(candidate);
      emitted.add(input.id(candidate));
      insertedIds.add(input.id(candidate));
      approachIds.add(input.id(candidate));
      approachIds.add(input.id(target));
      from = input.coords(candidate);
      seconds = end;
      usedKm += fit!.extraKm;
      usedSeconds += fit!.extraSeconds;
    }
    queue.push(target);
    emitted.add(input.id(target));
    const travel = await input.roads.journey([from, point]);
    const end = travel && await input.project(target, from, seconds, travel.durationSeconds);
    // Do not plan later approaches from a stop that cannot itself be admitted.
    if (end == null) break;
    from = point;
    seconds = end;
  }
  // Unvisited candidates retain their original order and normal feasibility checks.
  for (const candidate of input.queue) {
    if (!processed.has(candidate) && !insertedIds.has(input.id(candidate))) queue.push(candidate);
  }
  return { queue, approachIds };
}
