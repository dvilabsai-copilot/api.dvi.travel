export interface TimelineManualPlacementOrderingResult {
  selectedHotspots: any[];
  routeDesiredMovableSet: Set<number>;
  desiredMovableOrderRank: Map<number, number>;
  routePreferredAdjacencyPairs: Array<[number, number]>;
}

/**
 * Applies route-scoped preview rules and persisted/manual same-city ordering
 * before the timeline scheduler evaluates hotspot feasibility.
 */
export class TimelineManualPlacementOrderingService {
  constructor(private readonly logBookingRule: (...args: any[]) => void) {}

  apply(input: {
    options?: any;
    route: any;
    plan: any;
    planId: number;
    selectedHotspots: any[];
    existingHotspots: any[];
  }): TimelineManualPlacementOrderingResult {
    const { options, route, plan, planId, existingHotspots } = input;
    let selectedHotspots = input.selectedHotspots;
    const manualPlacementByRoute = options?.manualPlacementByRoute || {};
    const sameCityAllocationPlan = options?.sameCityAllocationPlan || null;
    const routeId = Number(route.itinerary_route_ID || 0);
    const routeDesiredMovableOrder = Array.isArray(
      sameCityAllocationPlan?.desiredMovableOrderByRoute?.[routeId],
    )
      ? (sameCityAllocationPlan?.desiredMovableOrderByRoute?.[routeId] || [])
          .map((id: any) => Number(id || 0))
          .filter((id: number) => id > 0)
      : [];
    const routeDesiredMovableSet = new Set<number>(routeDesiredMovableOrder);
    const routePreferredAdjacencyPairs: Array<[number, number]> = Array.isArray(
      sameCityAllocationPlan?.preferredAdjacencyPairsByRoute?.[routeId],
    )
      ? (sameCityAllocationPlan?.preferredAdjacencyPairsByRoute?.[routeId] || [])
          .map((pair: any) => [Number(pair?.[0] || 0), Number(pair?.[1] || 0)] as [number, number])
          .filter(([anchorId, movedId]: [number, number]) => anchorId > 0 && movedId > 0)
      : [];
    const desiredMovableOrderRank = new Map<number, number>();
    routeDesiredMovableOrder.forEach((hotspotId: number, index: number) => {
      if (!desiredMovableOrderRank.has(hotspotId)) {
        desiredMovableOrderRank.set(hotspotId, index);
      }
    });

    const scopedPreviewAllowedHotspotIds = new Set<number>();
    if (options?.scopeToRouteId && Array.isArray(existingHotspots) && existingHotspots.length > 0) {
      for (const row of existingHotspots) {
        if (Number(row?.itinerary_route_ID || 0) !== routeId) continue;
        if (Number(row?.item_type || 0) !== 4) continue;

        const hotspotId = Number(row?.hotspot_ID || 0);
        if (!(hotspotId > 0)) continue;

        const isActiveRouteRow = Number(row?.deleted || 0) === 0;
        const isManualPlaceholder = Number(row?.hotspot_plan_own_way || 0) === 1;
        if (isActiveRouteRow || isManualPlaceholder) {
          scopedPreviewAllowedHotspotIds.add(hotspotId);
        }
      }
    }

    if (options?.scopeToRouteId && scopedPreviewAllowedHotspotIds.size > 0) {
      const beforeScopedPreviewFilterCount = selectedHotspots.length;
      selectedHotspots = selectedHotspots.filter((hotspot: any) => {
        const hotspotId = Number(hotspot?.hotspot_ID || 0);
        return hotspotId > 0 && scopedPreviewAllowedHotspotIds.has(hotspotId);
      });

      if (selectedHotspots.length !== beforeScopedPreviewFilterCount) {
        this.logBookingRule({
          rule: 'SCOPED_PREVIEW_ROUTE_HOTSPOT_FILTER',
          quoteId: plan?.quote_id ?? plan?.quoteId ?? plan?.quote_ID ?? null,
          planId,
          routeId: route.itinerary_route_ID,
          beforeCount: beforeScopedPreviewFilterCount,
          afterCount: selectedHotspots.length,
          allowedHotspotIds: Array.from(scopedPreviewAllowedHotspotIds.values()),
          reason:
            'Route-scoped manual preview must preserve only the current route hotspot set plus selected manual placeholders; sibling-route auto hotspots are not allowed to leak into this day.',
        });
      }
    }

    const existingRouteOrderByHotspotId = new Map<number, number>();
    for (const row of existingHotspots || []) {
      if (Number(row?.itinerary_route_ID || 0) !== routeId) continue;
      if (Number(row?.deleted || 0) !== 0) continue;
      if (Number(row?.item_type || 0) !== 4) continue;

      const hotspotId = Number(row?.hotspot_ID || 0);
      const hotspotOrder = Number(row?.hotspot_order || 0);
      if (!(hotspotId > 0) || !(hotspotOrder > 0)) continue;

      const existingOrder = Number(existingRouteOrderByHotspotId.get(hotspotId) || 0);
      if (!existingOrder || hotspotOrder < existingOrder) {
        existingRouteOrderByHotspotId.set(hotspotId, hotspotOrder);
      }
    }

    if (existingRouteOrderByHotspotId.size > 0) {
      selectedHotspots = [...selectedHotspots]
        .map((hotspot: any) => {
          const hotspotId = Number(hotspot?.hotspot_ID || 0);
          const existingOrder = Number(existingRouteOrderByHotspotId.get(hotspotId) || 0);
          if (!(existingOrder > 0)) return hotspot;

          return { ...hotspot, display_order: existingOrder };
        })
        .sort((a: any, b: any) => {
          const ao = Number(a?.display_order || Number.MAX_SAFE_INTEGER);
          const bo = Number(b?.display_order || Number.MAX_SAFE_INTEGER);
          if (ao !== bo) return ao - bo;
          return Number(a?.hotspot_ID || 0) - Number(b?.hotspot_ID || 0);
        });
    }

    if (desiredMovableOrderRank.size > 0) {
      const desiredBaseOrder = 1000;
      selectedHotspots = [...selectedHotspots]
        .map((hotspot: any) => {
          const hotspotId = Number(hotspot?.hotspot_ID || 0);
          const desiredRank = desiredMovableOrderRank.get(hotspotId);
          if (desiredRank == null) return hotspot;

          return {
            ...hotspot,
            display_order: desiredBaseOrder + desiredRank,
            __sameCityDesiredOrderRank: desiredRank,
            __sameCityDesiredMovable: true,
          };
        })
        .sort((a: any, b: any) => {
          const ar = Number(a?.__sameCityDesiredOrderRank ?? Number.MAX_SAFE_INTEGER);
          const br = Number(b?.__sameCityDesiredOrderRank ?? Number.MAX_SAFE_INTEGER);
          if (ar !== br) return ar - br;

          const ao = Number(a?.display_order || Number.MAX_SAFE_INTEGER);
          const bo = Number(b?.display_order || Number.MAX_SAFE_INTEGER);
          if (ao !== bo) return ao - bo;

          return Number(a?.hotspot_ID || 0) - Number(b?.hotspot_ID || 0);
        });

      this.logBookingRule({
        rule: 'SAME_CITY_DESIRED_MOVABLE_ORDER_APPLIED',
        quoteId: plan?.quote_id ?? plan?.quoteId ?? plan?.quote_ID ?? null,
        planId,
        routeId: route.itinerary_route_ID,
        desiredMovableOrder: routeDesiredMovableOrder,
        preferredAdjacencyPairs: routePreferredAdjacencyPairs,
      });
    }

    const manualExistingForRoute = (existingHotspots || []).filter((row: any) =>
      Number(row?.itinerary_route_ID || 0) === routeId &&
      Number(row?.hotspot_plan_own_way || 0) === 1 &&
      Number(row?.deleted || 0) === 0 &&
      Number(row?.hotspot_ID || 0) > 0,
    );

    if (manualExistingForRoute.length > 0) {
      const selectedById = new Map<number, any>();
      for (const sh of selectedHotspots) {
        const id = Number(sh?.hotspot_ID || 0);
        if (id > 0 && !selectedById.has(id)) {
          selectedById.set(id, sh);
        }
      }

      const mergedManuals = manualExistingForRoute.map((manual: any, index: number) => {
        const hotspotId = Number(manual?.hotspot_ID || 0);
        const preferredOrder = Number(manualPlacementByRoute?.[routeId]?.hotspotOrder || 0);
        const manualOrder = preferredOrder > 0
          ? preferredOrder
          : Number(manual?.hotspot_order || index + 1 || 1);
        const existing = selectedById.get(hotspotId) || {};

        return {
          ...existing,
          hotspot_ID: hotspotId,
          display_order: manualOrder,
          hotspot_priority: Number(existing?.hotspot_priority ?? (manualOrder || 0)),
          matched_bucket: 'manual',
          isManualSelection: true,
        };
      });

      for (const manual of mergedManuals) {
        selectedById.set(Number(manual?.hotspot_ID || 0), manual);
      }

      selectedHotspots = Array.from(selectedById.values()).sort((a: any, b: any) => {
        const ao = Number(a?.display_order || Number.MAX_SAFE_INTEGER);
        const bo = Number(b?.display_order || Number.MAX_SAFE_INTEGER);
        if (ao !== bo) return ao - bo;
        const am = a?.isManualSelection ? 0 : 1;
        const bm = b?.isManualSelection ? 0 : 1;
        if (am !== bm) return am - bm;
        return Number(a?.hotspot_ID || 0) - Number(b?.hotspot_ID || 0);
      });
    }

    return { selectedHotspots, routeDesiredMovableSet, desiredMovableOrderRank, routePreferredAdjacencyPairs };
  }
}
