// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/helpers/timeline.prefetch.ts

import { Prisma } from "@prisma/client";
import { TimeConverter } from "./time-converter";

type Tx = Prisma.TransactionClient;

export interface PlanHeader {
  itinerary_plan_ID: number;
  trip_start_date: Date;
  trip_end_date: Date;
  trip_start_date_and_time?: Date | null;
  trip_end_date_and_time?: Date | null;
  pick_up_date_and_time: Date;
  arrival_type: number;
  departure_type: number;
  entry_ticket_required: number;
  nationality: number;
  total_adult: number;
  total_children: number;
  total_infants: number;
  itinerary_preference: number;
  arrival_location?: string | null;
  departure_location?: string | null;
}

export interface RouteRow {
  itinerary_route_ID: number;
  itinerary_plan_ID: number;
  itinerary_route_date: Date;
  route_start_time: string | Date;
  route_end_time: string | Date;
  location_name: string | null;
  next_visiting_location: string | null;
  location_id: number | null;
  direct_to_next_visiting_place: number;
}

export type HotspotLite = {
  id: number;
  name: string;
  location: string;
  toLocation?: string;
  hotspotType?: string;
  lat: number;
  lon: number;
  duration: string;
  hotspot_priority: number;
};

export type TimingMap = Map<number, Map<number, any[]>>;

export interface PrefetchContext {
  plan: PlanHeader | null;
  routes: RouteRow[];
  gs: any;
  commonBufferTime: string;
  storedLocationMap: Map<number, any>;
  viaRouteMap: Map<number, any[]>;
  cityIdMap: Map<string, number>;
  allHotspots: any[];
  hotspotMap: Map<number, HotspotLite>;
  timingMap: TimingMap;
  cityDistanceRows: any[];
  lastRouteId: number;
  normalizeCityName: (name: string) => string;
  toTimeString: (v: any, fallback?: string) => string;
}

export class TimelinePrefetcher {
  async prefetchAll(tx: Tx, planId: number): Promise<PrefetchContext> {
    const normalizeCityName = (name: string) =>
      String(name || "")
        .toLowerCase()
        .replace(/[.,()]/g, " ")
        .replace(/\b(international|domestic)\b/g, " ")
        .replace(
          /\b(airport|air\s*port|railway|rail|station|stn|junction|jn|central|egmore|terminus|bus\s*stand|stand)\b/g,
          " ",
        )
        .replace(/\s+/g, " ")
        .trim();

    const toTimeString = (v: any, fallback: string = "09:00:00") => {
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v instanceof Date) return TimeConverter.toTimeString(v);
      if (v && typeof v === "object" && typeof v.getUTCHours === "function") {
        const h = String(v.getUTCHours()).padStart(2, "0");
        const m = String(v.getUTCMinutes()).padStart(2, "0");
        const s = String(v.getUTCSeconds()).padStart(2, "0");
        return `${h}:${m}:${s}`;
      }
      return fallback;
    };

    const plan = (await (tx as any).dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
    })) as PlanHeader | null;

    const routes = (await (tx as any).dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
      orderBy: [{ itinerary_route_date: "asc" }, { itinerary_route_ID: "asc" }],
    })) as RouteRow[];

    const lastRouteId = routes.length ? routes[routes.length - 1].itinerary_route_ID : 0;

    const gs = await (tx as any).dvi_global_settings.findFirst({
      where: { deleted: 0, status: 1 },
    });

    const commonBufferTime = toTimeString(gs?.itinerary_common_buffer_time, "01:00:00");

    // Stored Locations
    const locationIds = routes
      .map((r) => r.location_id)
      .filter((id): id is number => id !== null && id !== undefined);

    const storedLocations =
      locationIds.length > 0
        ? await (tx as any).dvi_stored_locations.findMany({
            where: {
              location_ID: { in: locationIds.map((id) => BigInt(id)) },
              deleted: 0,
              status: 1,
            },
          })
        : [];

    const storedLocationMap = new Map<number, any>();
    for (const sl of storedLocations) storedLocationMap.set(Number(sl.location_ID), sl);

    // Via Routes
    const viaRoutesAll = await (tx as any).dvi_itinerary_via_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
    });

    const viaRouteMap = new Map<number, any[]>();
    for (const vr of viaRoutesAll) {
      const rid = Number(vr.itinerary_route_ID);
      if (!viaRouteMap.has(rid)) viaRouteMap.set(rid, []);
      viaRouteMap.get(rid)!.push(vr);
    }

    // City IDs
    const allCities = await (tx as any).dvi_cities.findMany({
      where: { deleted: 0 },
      select: { id: true, name: true },
    });

    const cityIdMap = new Map<string, number>();
    for (const c of allCities) cityIdMap.set(normalizeCityName(c.name), c.id);

    // Hotspots
    const allHotspots = await (tx as any).dvi_hotspot_place.findMany({
      where: { deleted: 0, status: 1 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_location: true,
        hotspot_to_location: true,
        hotspot_type: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
        hotspot_duration: true,
        hotspot_priority: true,
        city_boundaries: true,
      },
    });

    const hotspotMap = new Map<number, HotspotLite>();
    for (const h of allHotspots) {
      hotspotMap.set(Number(h.hotspot_ID), {
        id: Number(h.hotspot_ID),
        name: String(h.hotspot_name || ""),
        location: String(h.hotspot_location || ""),
        toLocation: String(
          h.hotspot_to_location || h.hotspot_location || ""
        ),
        hotspotType: String(h.hotspot_type || ""),
        lat: Number(h.hotspot_latitude || 0),
        lon: Number(h.hotspot_longitude || 0),
        duration: toTimeString(h.hotspot_duration, "01:00:00"),
        hotspot_priority: Number(h.hotspot_priority || 0),
      });
    }

    // Timings
    const allTimings = await (tx as any).dvi_hotspot_timing.findMany({
      where: { deleted: 0, status: 1 },
    });

    const timingMap: TimingMap = new Map();
    for (const t of allTimings) {
      const hid = Number(t.hotspot_ID);
      const dayRaw = t.hotspot_timing_day;
      const day = Number.isFinite(Number(dayRaw)) ? Number(dayRaw) : 0;

      if (!timingMap.has(hid)) timingMap.set(hid, new Map());
      const dayMap = timingMap.get(hid)!;
      if (!dayMap.has(day)) dayMap.set(day, []);
      dayMap.get(day)!.push(t);
    }

    // Sort each day's timing rows by start time so checker is stable
    for (const [, dayMap] of timingMap) {
      for (const [day, arr] of dayMap) {
        arr.sort((a: any, b: any) => {
          const as = toTimeString(a?.hotspot_start_time, "00:00:00");
          const bs = toTimeString(b?.hotspot_start_time, "00:00:00");
          if (as < bs) return -1;
          if (as > bs) return 1;
          return 0;
        });
        dayMap.set(day, arr);
      }
    }

    // City Distances (used by DistanceHelper)
    const cities = new Set<string>();
    routes.forEach((r) => {
      if (r.location_name) cities.add(r.location_name.split("|")[0].trim());
      if (r.next_visiting_location) cities.add(r.next_visiting_location.split("|")[0].trim());
    });
    if (plan?.arrival_location) cities.add(plan.arrival_location.split("|")[0].trim());
    if (plan?.departure_location) cities.add(plan.departure_location.split("|")[0].trim());

    const cityList = Array.from(cities).filter((c) => !!c);

    const cityDistanceRows =
      cityList.length > 0
        ? await (tx as any).dvi_stored_locations.findMany({
            where: {
              OR: [{ source_location: { in: cityList } }, { destination_location: { in: cityList } }],
              deleted: 0,
              status: 1,
            },
          })
        : [];

    return {
      plan,
      routes,
      gs,
      commonBufferTime,
      storedLocationMap,
      viaRouteMap,
      cityIdMap,
      allHotspots,
      hotspotMap,
      timingMap,
      cityDistanceRows,
      lastRouteId,
      normalizeCityName,
      toTimeString,
    };
  }
}
