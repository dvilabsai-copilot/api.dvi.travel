// FILE: src/modules/itineraries/services/itinerary-route-leg-cache.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type RouteLegCacheCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryRouteLegCacheService {
  private readonly osrmLegRuntimeCache = new Map<string, any>();
  private callbacks: RouteLegCacheCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: RouteLegCacheCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private getOsrmRouteGeometry(...args: any[]): any { return this.callbacks.getOsrmRouteGeometry?.(...args); }
  public async getCachedRouteDurationMinutes(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
  ): Promise<number | null> {
    const leg = await this.getCachedRouteMatrixLeg(tx, fromHotspotId, toHotspotId);
    if (leg.durationMin != null && Number.isFinite(Number(leg.durationMin)) && Number(leg.durationMin) > 0) {
      return Number(leg.durationMin);
    }
    return null;
  }

  public getOsrmLegCacheTtlMs(): number {
    const raw = Number(process.env.MANUAL_HOTSPOT_OSRM_CACHE_TTL_MS || 10 * 60 * 1000);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10 * 60 * 1000;
  }

  public getOsrmLegCacheKey(fromHotspotId: number, toHotspotId: number): string {
    return `${Number(fromHotspotId || 0)}_${Number(toHotspotId || 0)}`;
  }

  public getOsrmLegFromRuntimeCache(
    fromHotspotId: number,
    toHotspotId: number,
    allowReverse: boolean,
  ): {
    distanceKm: number | null;
    durationMin: number | null;
    coordinates: [number, number][];
    usedReverse: boolean;
  } | null {
    const ttlMs = this.getOsrmLegCacheTtlMs();
    const now = Date.now();

    const directKey = this.getOsrmLegCacheKey(fromHotspotId, toHotspotId);
    const direct = this.osrmLegRuntimeCache.get(directKey);
    if (direct && now - direct.cachedAt <= ttlMs) {
      return {
        distanceKm: direct.distanceKm,
        durationMin: direct.durationMin,
        coordinates: Array.isArray(direct.coordinates) ? [...direct.coordinates] : [],
        usedReverse: false,
      };
    }

    if (direct && now - direct.cachedAt > ttlMs) {
      this.osrmLegRuntimeCache.delete(directKey);
    }

    if (!allowReverse) {
      return null;
    }

    const reverseKey = this.getOsrmLegCacheKey(toHotspotId, fromHotspotId);
    const reverse = this.osrmLegRuntimeCache.get(reverseKey);
    if (!reverse) return null;
    if (now - reverse.cachedAt > ttlMs) {
      this.osrmLegRuntimeCache.delete(reverseKey);
      return null;
    }

    return {
      distanceKm: reverse.distanceKm,
      durationMin: reverse.durationMin,
      coordinates: Array.isArray(reverse.coordinates) ? [...reverse.coordinates].reverse() : [],
      usedReverse: true,
    };
  }

  public setOsrmLegRuntimeCache(
    fromHotspotId: number,
    toHotspotId: number,
    payload: {
      distanceKm: number | null;
      durationMin: number | null;
      coordinates: [number, number][];
    },
  ): void {
    const key = this.getOsrmLegCacheKey(fromHotspotId, toHotspotId);
    this.osrmLegRuntimeCache.set(key, {
      distanceKm: payload.distanceKm,
      durationMin: payload.durationMin,
      coordinates: Array.isArray(payload.coordinates) ? [...payload.coordinates] : [],
      cachedAt: Date.now(),
    });
  }

  public async resolveOsrmLegBetweenHotspots(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
    allowReverse: boolean,
  ): Promise<{
    distanceKm: number | null;
    durationMin: number | null;
    coordinates: [number, number][];
    usedReverse: boolean;
    osrmFailed: boolean;
  }> {
    const fromId = Number(fromHotspotId || 0);
    const toId = Number(toHotspotId || 0);
    if (!fromId || !toId || fromId === toId) {
      return {
        distanceKm: null,
        durationMin: null,
        coordinates: [],
        usedReverse: false,
        osrmFailed: true,
      };
    }

    const cached = this.getOsrmLegFromRuntimeCache(fromId, toId, allowReverse);
    if (cached) {
      return {
        distanceKm: cached.distanceKm,
        durationMin: cached.durationMin,
        coordinates: cached.coordinates,
        usedReverse: cached.usedReverse,
        osrmFailed: false,
      };
    }

    const endpoints = await (tx as any).dvi_hotspot_place.findMany({
      where: {
        hotspot_ID: { in: [fromId, toId] },
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    const endpointMap = new Map<number, any>((endpoints || []).map((row: any) => [Number(row?.hotspot_ID || 0), row]));
    const from = endpointMap.get(fromId);
    const to = endpointMap.get(toId);

    const fromLat = Number(from?.hotspot_latitude);
    const fromLng = Number(from?.hotspot_longitude);
    const toLat = Number(to?.hotspot_latitude);
    const toLng = Number(to?.hotspot_longitude);

    if (!from || !to || !Number.isFinite(fromLat) || !Number.isFinite(fromLng) || !Number.isFinite(toLat) || !Number.isFinite(toLng)) {
      return {
        distanceKm: null,
        durationMin: null,
        coordinates: [],
        usedReverse: false,
        osrmFailed: true,
      };
    }

    const route = await this.getOsrmRouteGeometry(fromLat, fromLng, toLat, toLng);
    if (!route || !Array.isArray(route.coordinates) || route.coordinates.length < 2) {
      return {
        distanceKm: null,
        durationMin: null,
        coordinates: [],
        usedReverse: false,
        osrmFailed: true,
      };
    }

    this.setOsrmLegRuntimeCache(fromId, toId, {
      distanceKm: route.distanceKm != null ? Number(route.distanceKm) : null,
      durationMin: route.durationMin != null ? Number(route.durationMin) : null,
      coordinates: route.coordinates,
    });

    return {
      distanceKm: route.distanceKm != null ? Number(route.distanceKm) : null,
      durationMin: route.durationMin != null ? Number(route.durationMin) : null,
      coordinates: route.coordinates,
      usedReverse: false,
      osrmFailed: false,
    };
  }

  public async getCachedRouteDistanceKm(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
  ): Promise<number | null> {
    const leg = await this.getCachedRouteMatrixLeg(tx, fromHotspotId, toHotspotId);
    if (leg.distanceKm != null && Number.isFinite(Number(leg.distanceKm)) && Number(leg.distanceKm) >= 0) {
      return Number(leg.distanceKm);
    }
    return null;
  }

  public async getCachedRouteMatrixLeg(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
  ): Promise<{ distanceKm: number | null; durationMin: number | null }> {
    if (!tx || !fromHotspotId || !toHotspotId || Number(fromHotspotId) === Number(toHotspotId)) {
      return { distanceKm: null, durationMin: null };
    }
    try {
      const leg = await this.resolveOsrmLegBetweenHotspots(
        tx,
        Number(fromHotspotId),
        Number(toHotspotId),
        true,
      );

      const distanceKm = Number(leg?.distanceKm ?? null);
      const durationMin = Number(leg?.durationMin ?? null);
      return {
        distanceKm: Number.isFinite(distanceKm) && distanceKm >= 0 ? distanceKm : null,
        durationMin: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : null,
      };
    } catch {
      return { distanceKm: null, durationMin: null };
    }
  }

  public estimateDurationFromDistance(distanceKm: number | null): number | null {
    if (distanceKm == null || !Number.isFinite(Number(distanceKm)) || distanceKm <= 0) return null;
 // Conservative hill-road speed: ~25 km/h for Munnar region
    const speedKmPerHour = 25;
    const durationMin = Math.max(5, Math.round((Number(distanceKm) / speedKmPerHour) * 60));
    return Number.isFinite(durationMin) ? durationMin : null;
  }

  public chooseReliableTravelDistanceKm(
    preferredDistanceKm: number | null | undefined,
    fallbackDistanceKm: number | null | undefined,
  ): number | null {
    const preferred = Number(preferredDistanceKm);
    const fallback = Number(fallbackDistanceKm);

    const preferredValid = Number.isFinite(preferred) && preferred > 0.15;
    const fallbackValid = Number.isFinite(fallback) && fallback > 0.15;

    if (preferredValid) return preferred;
    if (fallbackValid) return fallback;
    if (Number.isFinite(preferred) && preferred > 0) return preferred;
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
    return null;
  }

}
