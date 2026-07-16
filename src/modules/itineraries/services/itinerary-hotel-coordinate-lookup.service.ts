import { Injectable } from '@nestjs/common';

export interface ItineraryHotelCoordinateLookupFilters {
  tboCodes: string[];
  resavenueCodes: string[];
  hobseCodes: string[];
  axisroomsHotelIds: number[];
  staahHotelIds: number[];
}

export interface ItineraryHotelCoordinateLookupResult {
  routeDestinationCoordsByLocationId: Map<number, { lat: number; lon: number }>;
  hotelCoordsByProviderCode: Map<string, { lat: number; lon: number }>;
}

/** Loads stored route/hotel coordinates with the TBO static-master fallback. */
@Injectable()
export class ItineraryHotelCoordinateLookupService {
  async load(input: {
    routes: any[];
    packages: Array<{ hotels: any[] }>;
    loadStoredLocations: (locationIds: number[]) => Promise<any[]>;
    loadHotelMasters: (filters: ItineraryHotelCoordinateLookupFilters) => Promise<any[]>;
    loadTboMasters: (tboCodes: string[]) => Promise<any[]>;
  }): Promise<ItineraryHotelCoordinateLookupResult> {
    const routeLocationIds = Array.from(
      new Set(
        input.routes
          .map((route) => Number(route.location_id || 0))
          .filter((id) => id > 0),
      ),
    );
    const storedLocations = routeLocationIds.length
      ? await input.loadStoredLocations(routeLocationIds)
      : [];
    const routeDestinationCoordsByLocationId = new Map<number, { lat: number; lon: number }>();
    for (const location of storedLocations) {
      const lat = Number(location.destination_location_lattitude ?? 0);
      const lon = Number(location.destination_location_longitude ?? 0);
      if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
        routeDestinationCoordsByLocationId.set(Number(location.location_ID), { lat, lon });
      }
    }

    const providerCodeSet = new Set<string>();
    for (const pkg of input.packages) {
      for (const hotel of pkg.hotels || []) {
        const provider = String(hotel?.provider || 'tbo').trim().toLowerCase();
        const code = String(hotel?.hotelCode || '').trim();
        if (code) providerCodeSet.add(`${provider}|${code}`);
      }
    }
    const axisroomsCodes = Array.from(providerCodeSet)
      .filter((key) => key.startsWith('axisrooms|'))
      .map((key) => key.slice('axisrooms|'.length));
    const filters: ItineraryHotelCoordinateLookupFilters = {
      tboCodes: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('tbo|'))
        .map((key) => key.slice('tbo|'.length)),
      resavenueCodes: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('resavenue|'))
        .map((key) => key.slice('resavenue|'.length)),
      hobseCodes: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('hobse|'))
        .map((key) => key.slice('hobse|'.length)),
      axisroomsHotelIds: axisroomsCodes
        .map((code) => Number(code))
        .filter((id) => Number.isFinite(id) && id > 0),
      staahHotelIds: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('staah|'))
        .map((key) => Number(key.slice('staah|'.length)))
        .filter((id) => Number.isFinite(id) && id > 0),
    };
    const hotelMasters = providerCodeSet.size ? await input.loadHotelMasters(filters) : [];
    const hotelCoordsByProviderCode = new Map<string, { lat: number; lon: number }>();
    for (const master of hotelMasters) {
      const lat = Number(master.hotel_latitude ?? 0);
      const lon = Number(master.hotel_longitude ?? 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) continue;
      const tboCode = String(master.tbo_hotel_code || '').trim();
      const resavenueCode = String(master.resavenue_hotel_code || '').trim();
      const hobseCode = String(master.hotel_code || '').trim();
      const hotelId = Number(master.hotel_id || 0);
      if (tboCode) hotelCoordsByProviderCode.set(`tbo|${tboCode}`, { lat, lon });
      if (resavenueCode) hotelCoordsByProviderCode.set(`resavenue|${resavenueCode}`, { lat, lon });
      if (hobseCode) hotelCoordsByProviderCode.set(`hobse|${hobseCode}`, { lat, lon });
      if (hotelId > 0) hotelCoordsByProviderCode.set(`axisrooms|${hotelId}`, { lat, lon });
      if (hotelId > 0) hotelCoordsByProviderCode.set(`staah|${hotelId}`, { lat, lon });
    }

    if (filters.tboCodes.length) {
      const tboMasterRows = await input.loadTboMasters(filters.tboCodes);
      for (const row of tboMasterRows) {
        const code = String(row.tbo_hotel_code || '').trim();
        const lat = Number(row.hotel_latitude ?? 0);
        const lon = Number(row.hotel_longitude ?? 0);
        if (!code || !Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) continue;
        const key = `tbo|${code}`;
        if (!hotelCoordsByProviderCode.has(key)) {
          hotelCoordsByProviderCode.set(key, { lat, lon });
        }
      }
    }
    return { routeDestinationCoordsByLocationId, hotelCoordsByProviderCode };
  }
}
