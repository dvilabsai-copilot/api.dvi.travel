import { Prisma } from '@prisma/client';
import { HotspotDetailRow } from './types';

type Tx = Prisma.TransactionClient;

export interface ArrivalPolicyDecisionState {
  previousDayBillingDecisionProvided: boolean;
  previousDayBillingConfirmed: boolean;
}

export interface TimelinePlanInputs {
  plan: any | null;
  routes: any[];
  allHotspots: any[];
  allTimings: any[];
  timingMap: Map<number, Map<number, any[]>>;
}

/**
 * Database-facing helpers used by the timeline orchestrator.
 *
 * The SQL and fallback rules intentionally remain here unchanged. Keeping
 * this boundary small makes it possible to measure the reads independently
 * from the scheduling algorithm and later add request-scoped memoization.
 */
export class TimelineDataAccessService {
  async loadPlan(tx: Tx, planId: number): Promise<any | null> {
    return (await (tx as any).dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
    })) as any | null;
  }

  async loadRoutes(tx: Tx, planId: number): Promise<any[]> {
    return (await (tx as any).dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
      orderBy: [
        { itinerary_route_date: 'asc' },
        { itinerary_route_ID: 'asc' },
      ],
    })) as any[];
  }

  async loadAllActiveHotspots(tx: Tx): Promise<any[]> {
    return ((await (tx as any).dvi_hotspot_place?.findMany({
      where: { deleted: 0, status: 1 },
    })) || []) as any[];
  }

  async loadAllActiveTimings(tx: Tx): Promise<any[]> {
    return (await (tx as any).dvi_hotspot_timing.findMany({
      where: { deleted: 0, status: 1 },
    })) as any[];
  }

  buildTimingMap(timings: any[]): Map<number, Map<number, any[]>> {
    const timingMap = new Map<number, Map<number, any[]>>();
    for (const timing of timings || []) {
      const hotspotId = Number(timing.hotspot_ID);
      const day = Number(timing.hotspot_timing_day);
      if (!timingMap.has(hotspotId)) timingMap.set(hotspotId, new Map());
      const dayMap = timingMap.get(hotspotId)!;
      if (!dayMap.has(day)) dayMap.set(day, []);
      dayMap.get(day)!.push(timing);
    }
    return timingMap;
  }

  normalizeTravelRowDistance(
    row: HotspotDetailRow,
    sourceLocationName: string,
    destinationLocationName: string,
  ): HotspotDetailRow {
    const normalizePlace = (value: string) =>
      String(value || '')
        .split('|')[0]
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const namesDiffer =
      normalizePlace(sourceLocationName) !== normalizePlace(destinationLocationName);
    const distanceKm = Number(row?.hotspot_travelling_distance ?? 0);

    if (
      Number(row?.item_type || 0) === 3 &&
      namesDiffer &&
      Number.isFinite(distanceKm) &&
      distanceKm <= 0.01
    ) {
      return {
        ...row,
        hotspot_travelling_distance: null,
      };
    }

    return row;
  }

  toDateOnly(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  async getBetweenCandidatesForRouteSlots(
    tx: Tx,
    slotPairs: Array<{ fromId: number; toId: number }>,
  ): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();
    if (!Array.isArray(slotPairs) || slotPairs.length === 0) return result;

    const whereClauses: string[] = [];
    const params: any[] = [];
    for (const p of slotPairs) {
      const a = Number(p.fromId || 0);
      const b = Number(p.toId || 0);
      if (!a || !b || a === b) continue;
      whereClauses.push(`((from_hotspot_id = ? AND to_hotspot_id = ?) OR (from_hotspot_id = ? AND to_hotspot_id = ?))`);
      params.push(a, b, b, a);
    }

    if (whereClauses.length === 0) return result;

    const sql = `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        route_fit_type,
        route_decision_reason,
        road_detour_km,
        road_detour_ratio,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        candidate_distance_from_ab_route_meters,
        destination_distance_from_ac_route_meters
      FROM hotspot_route_between_map
      WHERE (${whereClauses.join(' OR ')})
        AND route_fit_type IN ('ON_ROUTE','MINOR_DETOUR')
    `;

    try {
      const rows: any[] = await (tx as any).$queryRawUnsafe(sql, ...params);
      if (!Array.isArray(rows) || rows.length === 0) return result;

      for (const r of rows) {
        const f = Number(r.from_hotspot_id || 0);
        const t = Number(r.to_hotspot_id || 0);
        const between = Number(r.between_hotspot_id || 0);
        if (!f || !t || !between) continue;

        const exactKey = `${f}_${t}`;
        const reverseKey = `${t}_${f}`;
        const rowCopy = { ...r };

        if (!result.has(exactKey)) result.set(exactKey, []);
        result.get(exactKey)!.push(rowCopy);

        if (!result.has(reverseKey)) result.set(reverseKey, []);
        result.get(reverseKey)!.push(rowCopy);
      }
    } catch (err) {
 console.error('[getBetweenCandidatesForRouteSlots] query error:', err);
    }

    return result;
  }

  async getBetweenCandidatesForSlot(tx: Tx, fromId: number, toId: number) {
    const map = await this.getBetweenCandidatesForRouteSlots(tx, [{ fromId, toId }]);
    return map.get(`${fromId}_${toId}`) || [];
  }

  async getArrivalPolicyDecisionStateForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
    routeDate: Date,
  ): Promise<ArrivalPolicyDecisionState> {
    const markerRows = await (tx as any).dvi_itinerary_plan_hotel_details?.findMany({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        hotel_required: 2,
        hotel_id: 0,
        deleted: 0,
        status: 1,
      },
      select: {
        group_type: true,
        itinerary_route_date: true,
      },
    });

    if (Array.isArray(markerRows) && markerRows.length > 0) {
      return {
        previousDayBillingDecisionProvided: true,
        previousDayBillingConfirmed: true,
      };
    }

    const hotelSelection = await (tx as any).dvi_itinerary_plan_hotel_details?.findFirst({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        group_type: 1,
        deleted: 0,
        status: 1,
      },
      orderBy: {
        itinerary_plan_hotel_details_ID: 'desc',
      },
      select: {
        itinerary_route_date: true,
      },
    });

    if (!hotelSelection?.itinerary_route_date) {
      return {
        previousDayBillingDecisionProvided: false,
        previousDayBillingConfirmed: false,
      };
    }

    const selectedHotelDate = this.toDateOnly(new Date(hotelSelection.itinerary_route_date));
    const normalizedRouteDate = this.toDateOnly(routeDate);

    return {
      previousDayBillingDecisionProvided: true,
      previousDayBillingConfirmed: selectedHotelDate.getTime() < normalizedRouteDate.getTime(),
    };
  }
}
