import { TimelineDataAccessService } from './timeline-data-access.service';

export interface TimelineBuildContext {
  plan: any;
  routes: any[];
  scopedRoutes: any[];
  previousRouteByRouteId: Map<number, any>;
  allHotspots: any[];
  filteredHotspots: any[];
  hotspotMap: Map<number, any>;
  allTimings: any[];
  timingMap: Map<number, Map<number, any[]>>;
  permanentlyClosedHotspotIds: Set<number>;
}

type TimelineBuildContextCallbacks = {
  logTimeline?: (...args: any[]) => void;
  logBookingRule?: (payload: Record<string, unknown>) => void;
  isHotspotClosedOnAllDays?: (timingMap: Map<number, Map<number, any[]>>, hotspotId: number) => boolean;
  setGlobalSettings?: (settings: any) => void;
};

/** Hydrates the immutable inputs shared by every route in a timeline build. */
export class TimelineBuildContextService {
  private callbacks: TimelineBuildContextCallbacks = {};

  constructor(private readonly dataAccessService: TimelineDataAccessService) {}

  setCallbacks(callbacks: TimelineBuildContextCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  async load(
    tx: any,
    planId: number,
    scopeToRouteId?: number,
  ): Promise<TimelineBuildContext | null> {
    let operationStart = Date.now();
    const plan = await this.dataAccessService.loadPlan(tx, planId);
    this.callbacks.logTimeline?.('[TIMELINE] Fetch plan:', Date.now() - operationStart, 'ms');
    if (!plan) return null;

    operationStart = Date.now();
    const routes = await this.dataAccessService.loadRoutes(tx, planId);
    this.callbacks.logTimeline?.('[TIMELINE] Fetch routes:', Date.now() - operationStart, 'ms, count:', routes.length);
    if (!routes.length) return null;

    const scopedRoutes = scopeToRouteId
      ? routes.filter((route: any) => route.itinerary_route_ID === scopeToRouteId)
      : routes;
    if (scopeToRouteId && scopedRoutes.length === 0) return null;

    const previousRouteByRouteId = new Map<number, any>();
    for (let index = 1; index < routes.length; index += 1) {
      previousRouteByRouteId.set(
        Number(routes[index]?.itinerary_route_ID || 0),
        routes[index - 1],
      );
    }

    operationStart = Date.now();
    const allHotspots = await this.dataAccessService.loadAllActiveHotspots(tx);
    this.callbacks.logTimeline?.('[TIMELINE] Fetch ALL hotspots ONCE:', Date.now() - operationStart, 'ms, count:', allHotspots.length);

    const globalSettings = await tx.dvi_global_settings?.findFirst({
      where: { status: 1, deleted: 0 },
    });
    if (globalSettings) this.callbacks.setGlobalSettings?.(globalSettings);

    const hotspotMap = new Map<number, any>();
    for (const hotspot of allHotspots) {
      hotspotMap.set(hotspot.hotspot_ID, {
        hotspot_ID: hotspot.hotspot_ID,
        hotspot_name: hotspot.hotspot_name,
        hotspot_location: hotspot.hotspot_location,
        hotspot_to_location: hotspot.hotspot_to_location,
        hotspot_type: hotspot.hotspot_type,
        hotspot_priority: hotspot.hotspot_priority,
        hotspot_latitude: hotspot.hotspot_latitude,
        hotspot_longitude: hotspot.hotspot_longitude,
        hotspot_duration: hotspot.hotspot_duration,
      });
    }
    this.callbacks.logTimeline?.('[TIMELINE] Created hotspot lookup map');

    operationStart = Date.now();
    const allTimings = await this.dataAccessService.loadAllActiveTimings(tx);
    const timingMap = this.dataAccessService.buildTimingMap(allTimings);
    this.callbacks.logTimeline?.('[TIMELINE] Batch-fetched ALL timing data:', Date.now() - operationStart, 'ms, records:', allTimings.length);

    const permanentlyClosedHotspotIds = new Set<number>();
    for (const hotspot of allHotspots) {
      const hotspotId = Number(hotspot?.hotspot_ID || 0);
      if (hotspotId && this.callbacks.isHotspotClosedOnAllDays?.(timingMap, hotspotId)) {
        permanentlyClosedHotspotIds.add(hotspotId);
      }
    }
    const filteredHotspots = allHotspots.filter((hotspot: any) => {
      const hotspotId = Number(hotspot?.hotspot_ID || 0);
      return hotspotId > 0 && !permanentlyClosedHotspotIds.has(hotspotId);
    });

    this.callbacks.logBookingRule?.({
      rule: 'HOTSPOT_PREFILTER_ALL_DAYS_CLOSED',
      quoteId: plan.quote_id ?? plan.quoteId ?? plan.quote_ID ?? null,
      planId,
      closedHotspotCount: permanentlyClosedHotspotIds.size,
      closedHotspotSample: Array.from(permanentlyClosedHotspotIds.values()).slice(0, 30),
      beforeCount: allHotspots.length,
      afterCount: filteredHotspots.length,
    });

    return {
      plan,
      routes,
      scopedRoutes,
      previousRouteByRouteId,
      allHotspots,
      filteredHotspots,
      hotspotMap,
      allTimings,
      timingMap,
      permanentlyClosedHotspotIds,
    };
  }
}
