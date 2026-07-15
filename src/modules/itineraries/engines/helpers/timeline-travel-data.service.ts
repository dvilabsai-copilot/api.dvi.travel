import { Prisma } from '@prisma/client';
import { addSeconds, timeToSeconds } from './time.helper';
import { DistanceHelper } from './distance.helper';
import { TimelineAnchorPolicyService } from './timeline-anchor-policy.service';

type Tx = Prisma.TransactionClient;

export interface TimelineTravelRoute {
  next_visiting_location: string | null;
}

export interface HotelRouteDetails {
  hotelId: number;
  hotelName: string | null;
  hotelCity: string | null;
  isHouseboat?: boolean;
  coords?: { lat: number; lon: number };
}

export interface ProjectedArrival {
  projectedArrivalSeconds: number;
  travelToDestSeconds: number;
}

/**
 * Resolves itinerary locations and delegates route-distance calculations.
 * The shared DistanceHelper is supplied by TimelineBuilder so its global
 * settings cache and provider behaviour remain unchanged.
 */
export class TimelineTravelDataService {
  private readonly anchorPolicyService = new TimelineAnchorPolicyService();

  constructor(private readonly distanceHelper: DistanceHelper = new DistanceHelper()) {}

  async getHotspotLocationName(tx: Tx, hotspotId: number): Promise<string | null> {
    if (!hotspotId) return null;

    const hs = await (tx as any).dvi_hotspot_place?.findFirst({
      where: { hotspot_ID: hotspotId, deleted: 0, status: 1 },
    });

    if (!hs) return null;

    return hs.hotspot_location ?? hs.hotspot_city ?? hs.city ?? hs.location_name ?? null;
  }

  async getHotelLocationNameForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
  ): Promise<string | null> {
    const hotel = await (tx as any).dvi_itinerary_plan_hotel_details?.findFirst({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        deleted: 0,
        status: 1,
      },
    });

    if (!hotel) return null;

    const h = hotel.hotel || hotel;
    return h.hotel_city ?? h.city ?? h.hotel_location ?? h.hotel_name ?? null;
  }

  async getHotelDetailsForRoute(
    tx: Tx,
    planId: number,
    routeId: number,
  ): Promise<HotelRouteDetails | null> {
    const details = await (tx as any).dvi_itinerary_plan_hotel_details?.findFirst({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        group_type: 1,
        deleted: 0,
        status: 1,
      },
      select: { hotel_id: true },
    });

    const hotelId = Number(details?.hotel_id ?? 0) || 0;
    if (!hotelId) return null;

    const hotel = await (tx as any).dvi_hotel?.findFirst({
      where: { hotel_id: hotelId },
      select: {
        hotel_name: true,
        hotel_city: true,
        hotel_category: true,
        hotel_latitude: true,
        hotel_longitude: true,
      },
    });

    if (!hotel) return { hotelId, hotelName: null, hotelCity: null };

    let hotelCity: string | null = null;
    const citySafe = Number(hotel.hotel_city) || 0;
    if (citySafe > 0) {
      try {
        const location = await (tx as any).dvi_stored_locations?.findFirst({
          where: { location_id: citySafe },
          select: { location_name: true },
        });
        hotelCity = (location?.location_name as string) ?? null;
      } catch {
        hotelCity = null;
      }
    } else {
      hotelCity = (hotel.hotel_city as string) ?? null;
    }

    const lat = Number(hotel.hotel_latitude);
    const lon = Number(hotel.hotel_longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    let categoryTitle: string | null = null;
    const categoryId = Number((hotel as any).hotel_category ?? 0);
    if (categoryId > 0) {
      const category = await (tx as any).dvi_hotel_category?.findFirst({
        where: { hotel_category_id: categoryId, deleted: 0, status: 1 },
        select: { hotel_category_title: true, hotel_category_code: true },
      });
      categoryTitle = String(category?.hotel_category_title || category?.hotel_category_code || '').trim() || null;
    }

    const houseboatTag = `${String(hotel.hotel_name || '')} ${String(categoryTitle || '')}`;
    return {
      hotelId,
      hotelName: (hotel.hotel_name as string) ?? null,
      hotelCity,
      isHouseboat: /house\s*boat/i.test(houseboatTag),
      coords: hasCoords ? { lat, lon } : undefined,
    };
  }

  async calculateTravelTime(
    tx: Tx,
    sourceLocationName: string,
    destinationLocationName: string,
  ): Promise<string> {
    const distanceResult = await this.distanceHelper.fromSourceAndDestination(
      tx,
      sourceLocationName,
      destinationLocationName,
      1,
    );
    return addSeconds('00:00:00', timeToSeconds(distanceResult.travelTime));
  }

  hasUsableCoords(coords?: { lat: number; lon: number } | null): coords is { lat: number; lon: number } {
    return this.anchorPolicyService.hasUsableCoords(coords);
  }

  normalizePlaceLookupKey(value: string | null | undefined): string {
    return this.anchorPolicyService.normalizePlaceLookupKey(value);
  }

  async resolvePlaceCoords(
    tx: Tx,
    cityName: string | null | undefined,
    preferredSide: 'source' | 'destination' = 'source',
  ): Promise<{ lat: number; lon: number } | undefined> {
    const city = String(cityName || '').split('|')[0].replace(/\s+/g, ' ').trim();
    if (!city || city.toLowerCase() === 'hotel') return undefined;

    const normalizedCity = city.toLowerCase();
    const normalizedKey = this.normalizePlaceLookupKey(city);
    const cityLike = `%${normalizedCity}%`;
    const keyLike = `%${normalizedKey}%`;
    const rows = (await (tx as any).$queryRaw(Prisma.sql`
      SELECT
        location_ID,
        source_location,
        source_location_city,
        source_location_lattitude,
        source_location_longitude,
        destination_location,
        destination_location_city,
        destination_location_lattitude,
        destination_location_longitude
      FROM dvi_stored_locations
      WHERE deleted = 0
        AND status = 1
        AND (
          LOWER(TRIM(source_location)) = ${normalizedCity}
          OR LOWER(TRIM(source_location_city)) = ${normalizedCity}
          OR LOWER(TRIM(destination_location)) = ${normalizedCity}
          OR LOWER(TRIM(destination_location_city)) = ${normalizedCity}
          OR LOWER(source_location) LIKE ${cityLike}
          OR LOWER(source_location_city) LIKE ${cityLike}
          OR LOWER(destination_location) LIKE ${cityLike}
          OR LOWER(destination_location_city) LIKE ${cityLike}
          OR LOWER(source_location) LIKE ${keyLike}
          OR LOWER(source_location_city) LIKE ${keyLike}
          OR LOWER(destination_location) LIKE ${keyLike}
          OR LOWER(destination_location_city) LIKE ${keyLike}
        )
      ORDER BY
        CASE
          WHEN LOWER(TRIM(source_location)) = ${normalizedCity} THEN 0
          WHEN LOWER(TRIM(source_location_city)) = ${normalizedCity} THEN 1
          WHEN LOWER(TRIM(destination_location)) = ${normalizedCity} THEN 2
          WHEN LOWER(TRIM(destination_location_city)) = ${normalizedCity} THEN 3
          WHEN LOWER(TRIM(source_location)) = ${normalizedKey} THEN 4
          WHEN LOWER(TRIM(source_location_city)) = ${normalizedKey} THEN 5
          WHEN LOWER(TRIM(destination_location)) = ${normalizedKey} THEN 6
          WHEN LOWER(TRIM(destination_location_city)) = ${normalizedKey} THEN 7
          ELSE 8
        END,
        location_ID DESC
      LIMIT 1
    `)) as any[];

    const row = rows?.[0];
    if (!row) return undefined;

    const sourceCoords = {
      lat: Number(row.source_location_lattitude ?? 0),
      lon: Number(row.source_location_longitude ?? 0),
    };
    const destinationCoords = {
      lat: Number(row.destination_location_lattitude ?? 0),
      lon: Number(row.destination_location_longitude ?? 0),
    };

    if (preferredSide === 'destination') {
      if (this.hasUsableCoords(destinationCoords)) return destinationCoords;
      if (this.hasUsableCoords(sourceCoords)) return sourceCoords;
    }
    if (this.hasUsableCoords(sourceCoords)) return sourceCoords;
    if (this.hasUsableCoords(destinationCoords)) return destinationCoords;
    return undefined;
  }

  async resolveCityCoords(
    tx: Tx,
    cityName: string | null | undefined,
    preferredSide: 'source' | 'destination' = 'source',
  ): Promise<{ lat: number; lon: number } | undefined> {
    return this.resolvePlaceCoords(tx, cityName, preferredSide);
  }

  async calculateTravelTimeWithCoords(
    tx: Tx,
    sourceLocationName: string,
    destinationLocationName: string,
    sourceCoords?: { lat: number; lon: number },
    destCoords?: { lat: number; lon: number },
  ): Promise<string> {
    const travelLocationType = this.anchorPolicyService.getTravelLocationType(sourceLocationName, destinationLocationName);
    const distanceResult = await this.distanceHelper.fromSourceAndDestination(
      tx,
      sourceLocationName,
      destinationLocationName,
      travelLocationType,
      sourceCoords,
      destCoords,
    );
    return addSeconds('00:00:00', timeToSeconds(distanceResult.travelTime));
  }

  async calculateProjectedArrivalToRouteDestination(
    tx: Tx,
    route: TimelineTravelRoute,
    hotspotLocationName: string,
    visitEndSeconds: number,
    hotspotCoords?: { lat: number; lon: number },
    destCityCoords?: { lat: number; lon: number },
  ): Promise<ProjectedArrival> {
    const parsedHotspotLocation = hotspotLocationName.split('|')[0].trim();
    const rawDestination = route.next_visiting_location || parsedHotspotLocation;
    const destinationCity = rawDestination.split('|')[0].trim();
    const travelLocationType = this.anchorPolicyService.getTravelLocationType(parsedHotspotLocation, destinationCity);
    const usableHotspotCoords = hotspotCoords && hotspotCoords.lat !== 0 && hotspotCoords.lon !== 0 ? hotspotCoords : undefined;
    const usableDestCoords = destCityCoords && destCityCoords.lat !== 0 && destCityCoords.lon !== 0 ? destCityCoords : undefined;
    const travelToDestResult = await this.distanceHelper.fromSourceAndDestination(
      tx,
      parsedHotspotLocation,
      destinationCity,
      travelLocationType,
      usableHotspotCoords,
      usableDestCoords,
    );
    const travelToDestSeconds = timeToSeconds(travelToDestResult.travelTime) + timeToSeconds(travelToDestResult.bufferTime);
    return { projectedArrivalSeconds: visitEndSeconds + travelToDestSeconds, travelToDestSeconds };
  }
}
