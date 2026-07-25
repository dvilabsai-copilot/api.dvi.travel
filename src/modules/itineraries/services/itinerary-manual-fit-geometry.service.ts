// FILE: src/modules/itineraries/services/itinerary-manual-fit-geometry.service.ts

import { Injectable } from '@nestjs/common';
import { haversineKm } from '../utils/distance-utils';

type ManualFitGeometryCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryManualFitGeometryService {
  private callbacks: ManualFitGeometryCallbacks = {};

  setCallbacks(callbacks: ManualFitGeometryCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public parseRouteCoordinates(raw: unknown): [number, number][] {
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is [number, number] =>
          Array.isArray(item) && item.length === 2 && Number.isFinite(Number(item[0])) && Number.isFinite(Number(item[1])),
      );
    } catch {
      return [];
    }
  }

  public degToRadForRouteProjection(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  public haversineKmForRouteProjection(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const earthRadiusKm = 6371;
    const dLat = this.degToRadForRouteProjection(lat2 - lat1);
    const dLng = this.degToRadForRouteProjection(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(this.degToRadForRouteProjection(lat1))
      * Math.cos(this.degToRadForRouteProjection(lat2))
      * Math.sin(dLng / 2)
      * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  }

  public projectToMetersForRouteProjection(lat: number, lng: number, refLat: number): { x: number; y: number } {
    const earthRadiusMeters = 6371000;
    const x = this.degToRadForRouteProjection(lng) * earthRadiusMeters * Math.cos(this.degToRadForRouteProjection(refLat));
    const y = this.degToRadForRouteProjection(lat) * earthRadiusMeters;
    return { x, y };
  }

  public findNearestProgressOnRoute(
    point: { lat: number; lng: number },
    coordinates: [number, number][],
  ): { distanceMeters: number; progressRatio: number } {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return { distanceMeters: Number.POSITIVE_INFINITY, progressRatio: 0 };
    }

    let bestDistanceMeters = Number.POSITIVE_INFINITY;
    let bestProgressMeters = 0;
    let totalMeters = 0;
    let cumulativeMeters = 0;

    for (let i = 0; i < coordinates.length - 1; i += 1) {
      const aLng = Number(coordinates[i][0]);
      const aLat = Number(coordinates[i][1]);
      const bLng = Number(coordinates[i + 1][0]);
      const bLat = Number(coordinates[i + 1][1]);

      const segmentMeters = this.haversineKmForRouteProjection(aLat, aLng, bLat, bLng) * 1000;
      totalMeters += segmentMeters;

      const refLat = (point.lat + aLat + bLat) / 3;
      const p = this.projectToMetersForRouteProjection(point.lat, point.lng, refLat);
      const a = this.projectToMetersForRouteProjection(aLat, aLng, refLat);
      const b = this.projectToMetersForRouteProjection(bLat, bLng, refLat);

      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const wx = p.x - a.x;
      const wy = p.y - a.y;
      const vv = vx * vx + vy * vy;
      const t = vv === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));

      const projX = a.x + t * vx;
      const projY = a.y + t * vy;
      const dx = p.x - projX;
      const dy = p.y - projY;
      const distanceMeters = Math.sqrt(dx * dx + dy * dy);

      if (distanceMeters < bestDistanceMeters) {
        bestDistanceMeters = distanceMeters;
        bestProgressMeters = cumulativeMeters + (segmentMeters * t);
      }

      cumulativeMeters += segmentMeters;
    }

    return {
      distanceMeters: bestDistanceMeters,
      progressRatio: totalMeters > 0 ? bestProgressMeters / totalMeters : 0,
    };
  }

  public async getOsrmRouteGeometry(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<{ coordinates: [number, number][]; distanceKm: number | null; durationMin: number | null } | null> {
    if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng) || !Number.isFinite(toLat) || !Number.isFinite(toLng)) {
      return null;
    }

 const osrmBaseUrl = String(process.env.OSRM_BASE_URL || 'http://localhost:5000/route/v1/driving').trim();
    const url = `${osrmBaseUrl}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const payload: any = await response.json();
      const route = Array.isArray(payload?.routes) ? payload.routes[0] : null;
      const coordinates = this.parseRouteCoordinates(route?.geometry?.coordinates || null);
      if (coordinates.length < 2) return null;
      return {
        coordinates,
        distanceKm: route?.distance != null ? Number(route.distance) / 1000 : null,
        durationMin: route?.duration != null ? Number(route.duration) / 60 : null,
      };
    } catch {
      return null;
    }
  }

  public async resolveSelectedHotelEndpoint(
    tx: any,
    planId: number,
    routeId: number,
  ): Promise<{ hotelId: number; hotelName: string; latitude: number; longitude: number } | null> {
    const rows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        phd.hotel_id,
        h.hotel_name,
        h.hotel_latitude,
        h.hotel_longitude
      FROM dvi_itinerary_plan_hotel_details phd
      JOIN dvi_hotel h ON h.hotel_id = phd.hotel_id
      WHERE phd.itinerary_plan_id = ?
        AND phd.itinerary_route_id = ?
        AND phd.deleted = 0
        AND phd.status = 1
        AND phd.hotel_id IS NOT NULL
        AND phd.hotel_id > 0
        AND h.deleted = 0
      ORDER BY phd.itinerary_plan_hotel_details_ID DESC
      LIMIT 1
      `,
      Number(planId),
      Number(routeId),
    );

    const pickWithValidCoords = (list: any[]): { hotelId: number; hotelName: string; latitude: number; longitude: number } | null => {
      if (!Array.isArray(list) || list.length === 0) return null;
      for (const row of list) {
        const hotelId = Number(row?.hotel_id || 0);
        const latitude = Number(row?.hotel_latitude);
        const longitude = Number(row?.hotel_longitude);
        if (!hotelId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        return {
          hotelId,
          hotelName: String(row?.hotel_name || `Hotel #${hotelId}`),
          latitude,
          longitude,
        };
      }
      return null;
    };

    const directPick = pickWithValidCoords(rows);
    if (directPick) return directPick;

 // Fallback 1: same mapping table with relaxed status, because some routes hold valid hotel_id with non-1 status flags.
    const relaxedRows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        phd.hotel_id,
        h.hotel_name,
        h.hotel_latitude,
        h.hotel_longitude
      FROM dvi_itinerary_plan_hotel_details phd
      JOIN dvi_hotel h ON h.hotel_id = phd.hotel_id
      WHERE phd.itinerary_plan_id = ?
        AND phd.itinerary_route_id = ?
        AND phd.deleted = 0
        AND phd.hotel_id IS NOT NULL
        AND phd.hotel_id > 0
        AND h.deleted = 0
      ORDER BY phd.itinerary_plan_hotel_details_ID DESC
      LIMIT 5
      `,
      Number(planId),
      Number(routeId),
    );

    const relaxedPick = pickWithValidCoords(relaxedRows);
    if (relaxedPick) return relaxedPick;

 // Fallback 2: pick any active mapped hotel for the plan when route-specific mapping is missing.
    const planWideRows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        phd.hotel_id,
        h.hotel_name,
        h.hotel_latitude,
        h.hotel_longitude
      FROM dvi_itinerary_plan_hotel_details phd
      JOIN dvi_hotel h ON h.hotel_id = phd.hotel_id
      WHERE phd.itinerary_plan_id = ?
        AND phd.deleted = 0
        AND phd.hotel_id IS NOT NULL
        AND phd.hotel_id > 0
        AND h.deleted = 0
      ORDER BY
        CASE WHEN phd.status = 1 THEN 0 ELSE 1 END,
        phd.itinerary_plan_hotel_details_ID DESC
      LIMIT 10
      `,
      Number(planId),
    );

    const planWidePick = pickWithValidCoords(planWideRows);
    if (planWidePick) return planWidePick;

 // Fallback 3 intentionally does not call quote-level hotel details/TBO.
 // Manual Fit Here only needs an endpoint for timing/distance preview, so avoid
 // expensive live hotel package rebuilds from the hotspot insertion path.

 // Fallback 4: derive hotel name from item_type=6 route segment hotspot master row and map to dvi_hotel.
    const routeHotelNameRows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT hp.hotspot_name
      FROM dvi_itinerary_route_hotspot_details rhd
      JOIN dvi_hotspot_place hp ON hp.hotspot_ID = rhd.hotspot_ID
      WHERE rhd.itinerary_plan_ID = ?
        AND rhd.itinerary_route_ID = ?
        AND rhd.item_type = 6
        AND rhd.status = 1
        AND rhd.deleted = 0
        AND hp.deleted = 0
      ORDER BY rhd.hotspot_order DESC
      LIMIT 5
      `,
      Number(planId),
      Number(routeId),
    );

    const routeHotelName = String(
      Array.isArray(routeHotelNameRows)
        ? (routeHotelNameRows.find((r: any) => String(r?.hotspot_name || '').trim().length > 0)?.hotspot_name || '')
        : '',
    ).trim();

    if (routeHotelName.length > 0) {
      const hotelByNameRows: any[] = await (tx as any).$queryRawUnsafe(
        `
        SELECT hotel_id, hotel_name, hotel_latitude, hotel_longitude
        FROM dvi_hotel
        WHERE deleted = 0
          AND (
            LOWER(hotel_name) = LOWER(?)
            OR LOWER(hotel_name) LIKE CONCAT('%', LOWER(?), '%')
            OR LOWER(?) LIKE CONCAT('%', LOWER(hotel_name), '%')
          )
        ORDER BY (CASE WHEN LOWER(hotel_name) = LOWER(?) THEN 0 ELSE 1 END), hotel_id DESC
        LIMIT 10
        `,
        routeHotelName,
        routeHotelName,
        routeHotelName,
        routeHotelName,
      );

      const byRouteNamePick = pickWithValidCoords(hotelByNameRows);
      if (byRouteNamePick) return byRouteNamePick;
    }

    return null;
  }

  public async resolveRouteDestinationCityEndpoint(
    tx: any,
    routeId: number,
  ): Promise<{ hotelId: number; hotelName: string; latitude: number; longitude: number } | null> {
    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        location_id: true,
        next_visiting_location: true,
      },
    });

    const locationId = Number(route?.location_id || 0);
    if (!locationId) return null;

    const stored = await (tx as any).dvi_stored_locations.findFirst({
      where: {
        location_ID: locationId,
        deleted: 0,
      },
      select: {
        destination_location: true,
        destination_location_lattitude: true,
        destination_location_longitude: true,
      },
    });

    const destinationName = String(
      stored?.destination_location || route?.next_visiting_location || 'Destination',
    ).trim();

    const latitude = Number(stored?.destination_location_lattitude);
    const longitude = Number(stored?.destination_location_longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    return {
      hotelId: 0,
      hotelName: `${destinationName} Hotel`,
      latitude,
      longitude,
    };
  }

  public async resolveHotelEndpointByLooseName(
    tx: any,
    rawName: string,
  ): Promise<{ hotelId: number; hotelName: string; latitude: number; longitude: number } | null> {
    const name = String(rawName || '').trim();
    if (!name) return null;

    const rows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT hotel_id, hotel_name, hotel_latitude, hotel_longitude
      FROM dvi_hotel
      WHERE deleted = 0
        AND (
          LOWER(hotel_name) = LOWER(?)
          OR LOWER(hotel_name) LIKE CONCAT('%', LOWER(?), '%')
          OR LOWER(?) LIKE CONCAT('%', LOWER(hotel_name), '%')
        )
      ORDER BY (CASE WHEN LOWER(hotel_name) = LOWER(?) THEN 0 ELSE 1 END), hotel_id DESC
      LIMIT 10
      `,
      name,
      name,
      name,
      name,
    );

    for (const row of Array.isArray(rows) ? rows : []) {
      const hotelId = Number(row?.hotel_id || 0);
      const latitude = Number(row?.hotel_latitude);
      const longitude = Number(row?.hotel_longitude);
      if (!hotelId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      return {
        hotelId,
        hotelName: String(row?.hotel_name || `Hotel #${hotelId}`),
        latitude,
        longitude,
      };
    }

    return null;
  }

  public async resolveHotspotToHotelLeg(
    tx: any,
    hotspotId: number,
    hotel: { latitude: number; longitude: number } | null,
  ): Promise<{ distanceKm: number | null; durationMin: number | null; osrmUsed: boolean }> {
    if (!hotel || !Number.isFinite(Number(hotel.latitude)) || !Number.isFinite(Number(hotel.longitude))) {
      return { distanceKm: null, durationMin: null, osrmUsed: false };
    }

    const hotspot = await (tx as any).dvi_hotspot_place.findFirst({
      where: {
        hotspot_ID: Number(hotspotId),
        deleted: 0,
      },
      select: {
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    const fromLat = Number(hotspot?.hotspot_latitude);
    const fromLng = Number(hotspot?.hotspot_longitude);
    if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) {
      return { distanceKm: null, durationMin: null, osrmUsed: false };
    }

    const osrmRoute = await this.getOsrmRouteGeometry(
      Number(fromLat),
      Number(fromLng),
      Number(hotel.latitude),
      Number(hotel.longitude),
    );

    if (osrmRoute && Number.isFinite(Number(osrmRoute.distanceKm))) {
      return {
        distanceKm: osrmRoute.distanceKm != null ? Number(osrmRoute.distanceKm) : null,
        durationMin: osrmRoute.durationMin != null ? Number(osrmRoute.durationMin) : this.callbacks.estimateDurationFromDistance(osrmRoute.distanceKm ?? null),
        osrmUsed: true,
      };
    }

    const fallbackDistanceKm = haversineKm(
      Number(fromLat),
      Number(fromLng),
      Number(hotel.latitude),
      Number(hotel.longitude),
    );
    return {
      distanceKm: Number.isFinite(Number(fallbackDistanceKm)) ? Number(fallbackDistanceKm) : null,
      durationMin: this.callbacks.estimateDurationFromDistance(Number.isFinite(Number(fallbackDistanceKm)) ? Number(fallbackDistanceKm) : null),
      osrmUsed: false,
    };
  }

}
