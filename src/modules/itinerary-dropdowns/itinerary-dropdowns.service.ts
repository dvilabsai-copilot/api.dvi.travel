// REPLACE-WHOLE-FILE
// FILE: src/modules/itinerary-dropdowns/itinerary-dropdowns.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  EligibleVehicleTypesDto,
  EligibleVehicleTypesResponseDto,
} from './dto/eligible-vehicle-types.dto';

export type SimpleOption = {
  id: string;
  label: string;
};

export type LocationOption = {
  id: string; // same as PHP: <option value="LOCATION_NAME">
  name: string;
};

type LocationType = 'source' | 'destination';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

@Injectable()
export class ItineraryDropdownsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Extract seating capacity from vehicle type title
   * Fallback parsing if occupancy field is not available
   * Examples:
   * "INNOVA CRYSTA 7+1" → 8
   * "Tempo Traveller 10 Seater" → 10
   * "LEYLAND - 36 SEATER" → 36
   * "Sedan" → 4
   */
  private extractSeatCapacity(title: string): number {
    if (!title) return 0;

    // Try to find "X SEATER" pattern
    const seaterMatch = title.match(/(\d+)\s*(?:seater|seater)/i);
    if (seaterMatch) {
      return parseInt(seaterMatch[1], 10);
    }

    // Try to find "X+Y" pattern (e.g., "7+1" = 8)
    const plusMatch = title.match(/(\d+)\+(\d+)/);
    if (plusMatch) {
      const first = parseInt(plusMatch[1], 10);
      const second = parseInt(plusMatch[2], 10);
      return first + second;
    }

    // Special cases
    if (title.toLowerCase().includes('sedan')) return 4;
    if (title.toLowerCase().includes('suv')) return 5;

    return 0; // default if cannot parse
  }

  /**
   * Get locations to eligible cities mapping from dvi_stored_locations
   * Searches both source_location and destination_location fields
   */
  private async getLocationsToCitiesMapping(): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    const rows = await this.prisma.dvi_stored_locations.findMany({
      where: {
        deleted: 0,
        status: 1,
      } as any,
      select: {
        source_location: true,
        source_location_city: true,
        destination_location: true,
        destination_location_city: true,
      },
    } as any);

    for (const row of rows) {
      if (row.source_location && row.source_location_city) {
        map.set(row.source_location.trim(), row.source_location_city.trim());
      }
      if (row.destination_location && row.destination_location_city) {
        map.set(
          row.destination_location.trim(),
          row.destination_location_city.trim(),
        );
      }
    }

    return map;
  }

  /**
   * Convert location names to eligible city names
   * Uses dvi_stored_locations mapping
   */
  private async convertLocationsToEligibleCities(
    locations: string[],
  ): Promise<string[]> {
    const mapping = await this.getLocationsToCitiesMapping();
    const uniqueCities = new Set<string>();

    for (const loc of locations) {
      const trimmedLoc = loc.trim();
      if (trimmedLoc.length === 0) continue;

      // Look up the city for this location
      const city = mapping.get(trimmedLoc);
      if (city) {
        uniqueCities.add(city);
      } else {
        // Fallback: try to use the location name itself as city
        // (in case it's already a city name)
        uniqueCities.add(trimmedLoc);
      }
    }

    return Array.from(uniqueCities);
  }

  /**
   * Get eligible vehicle types for given locations
   * Matches PHP behavior: filters by cities, sorts by seating capacity
   */
  async getEligibleVehicleTypes(
    dto: EligibleVehicleTypesDto,
  ): Promise<EligibleVehicleTypesResponseDto> {
    try {
      console.log('[getEligibleVehicleTypes] Raw DTO:', JSON.stringify(dto));
      
      // 1. Merge and unique locations
      const allLocations = [
        ...(dto.sourceLocation || []),
        ...(dto.nextVisitingLocation || []),
      ];

      const uniqueLocations = Array.from(new Set(allLocations))
        .map((loc) => loc.trim())
        .filter(isNonEmptyString);

      console.log('[getEligibleVehicleTypes] Input locations:', uniqueLocations);

      if (uniqueLocations.length === 0) {
        console.log('[getEligibleVehicleTypes] No locations provided, returning empty');
        return {
          vehicleTypes: [],
          selectedVehicleIds: [],
        };
      }

      // 2. Convert locations to eligible cities
      const eligibleCities = await this.convertLocationsToEligibleCities(
        uniqueLocations,
      );

      console.log('[getEligibleVehicleTypes] Eligible cities:', eligibleCities);

      if (eligibleCities.length === 0) {
        console.log('[getEligibleVehicleTypes] No eligible cities found, returning empty');
        return {
          vehicleTypes: [],
          selectedVehicleIds: [],
        };
      }

      // 3. Query distinct vehicle types that have vehicles in eligible cities
      // Matches PHP logic: uses vendor_vehicle_types and vendor_details tables
      // SQL equivalent from PHP:
      // SELECT DISTINCT VENDOR_VEHICLE_TYPES.vehicle_type_id, VEHICLE_TYPES.vehicle_type_title
      // FROM dvi_vehicle VEHICLE
      // LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES ON ...
      // LEFT JOIN dvi_vendor_details VENDOR_DETAILS ON ...
      // LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS ON ...
      // LEFT JOIN dvi_vehicle_type VEHICLE_TYPES ON ...
      // WHERE VEHICLE.status = 1 AND VEHICLE.deleted = 0
      //   AND VENDOR_DETAILS.status = 1 AND VENDOR_DETAILS.deleted = 0
      //   AND VENDOR_BRANCH_DETAILS.status = 1 AND VENDOR_BRANCH_DETAILS.deleted = 0
      //   AND VEHICLE.owner_city IN (eligibleCities)
      const placeholders = eligibleCities.map(() => `?`).join(',');
      console.log('[getEligibleVehicleTypes] Executing SQL query with cities:', eligibleCities);

      const distinctVehicleTypes = await (this.prisma as any).$queryRawUnsafe(
        `
        SELECT DISTINCT 
          VENDOR_VEHICLE_TYPES.vehicle_type_id, 
          VEHICLE_TYPES.vehicle_type_title,
          VEHICLE_TYPES.occupancy
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES 
          ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID 
          AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
        LEFT JOIN dvi_vendor_details VENDOR_DETAILS 
          ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
        LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS 
          ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
        LEFT JOIN dvi_vehicle_type VEHICLE_TYPES 
          ON VEHICLE_TYPES.vehicle_type_id = VENDOR_VEHICLE_TYPES.vehicle_type_id
        WHERE VEHICLE.status = 1 
          AND VEHICLE.deleted = 0 
          AND VENDOR_DETAILS.status = 1 
          AND VENDOR_DETAILS.deleted = 0 
          AND VENDOR_BRANCH_DETAILS.status = 1 
          AND VENDOR_BRANCH_DETAILS.deleted = 0
          AND VEHICLE.owner_city IN (${placeholders})
        ORDER BY VEHICLE_TYPES.occupancy ASC, VEHICLE_TYPES.vehicle_type_title ASC
        `,
        ...eligibleCities,
      );

      console.log('[getEligibleVehicleTypes] Query returned:', distinctVehicleTypes.length, 'vehicle types');

      // 4. Map to response format
      const vehicleTypes = (
        distinctVehicleTypes as Array<{
          vehicle_type_id: number;
          vehicle_type_title: string;
          occupancy: number | null;
        }>
      )
        .map((vt) => {
          const capacity = vt.occupancy ?? this.extractSeatCapacity(vt.vehicle_type_title);
          return {
            id: String(vt.vehicle_type_id),
            label: vt.vehicle_type_title || '',
            capacity, // for sorting reference
          };
        })
        // Sort by capacity ascending (primary), then by label
        .sort((a, b) => {
          if (a.capacity !== b.capacity) {
            return a.capacity - b.capacity;
          }
          return a.label.localeCompare(b.label);
        })
        .map(({ id, label }) => ({ id, label })); // remove capacity from response

      console.log('[getEligibleVehicleTypes] Returning vehicleTypes:', vehicleTypes.length, 'items');

      // 5. Load selectedVehicleIds if itineraryPlanId provided
      let selectedVehicleIds: string[] = [];

      if (dto.itineraryPlanId) {
        const itineraryPlanId = Number(dto.itineraryPlanId);
        if (Number.isFinite(itineraryPlanId) && itineraryPlanId > 0) {
          const selectedVehicles = await this.prisma.dvi_itinerary_plan_vehicle_details.findMany(
            {
              where: {
                itinerary_plan_id: itineraryPlanId,
                status: 1,
                deleted: 0,
              } as any,
              select: {
                vehicle_type_id: true,
              },
            } as any,
          );

          selectedVehicleIds = selectedVehicles
            .map((v) => String(v.vehicle_type_id))
            .filter(isNonEmptyString);

          console.log('[getEligibleVehicleTypes] Selected vehicle IDs:', selectedVehicleIds);
        }
      }

      return {
        vehicleTypes,
        selectedVehicleIds,
      };
    } catch (error) {
      console.error('[getEligibleVehicleTypes] ERROR:', error.message, error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // LOCATIONS (source / destination) from dvi_stored_locations like old PHP
  // ---------------------------------------------------------------------------
  async getLocations(
    type: LocationType = 'source',
    sourceLocation?: string,
  ): Promise<LocationOption[]> {
    const isDestination = type === 'destination';

    const rows = await this.prisma.dvi_stored_locations.findMany({
      where: {
        deleted: 0,
        status: 1,
        ...(isDestination && sourceLocation ? { source_location: sourceLocation } : {}),
      } as any,
      select: {
        source_location: true,
        destination_location: true,
      },
      distinct: isDestination ? ['destination_location'] : ['source_location'],
    } as any);

    let locations = rows
      .map((r) => (isDestination ? r.destination_location : r.source_location))
      .filter(isNonEmptyString)
      .map((s) => s.trim());

    // Filter locations to only those that have hotels (overnight stay requirement)
    // 1. Get all city IDs that have active hotels
    const hotels = await this.prisma.dvi_hotel.findMany({
      where: { status: 1, deleted: false },
      select: { hotel_city: true },
      distinct: ['hotel_city'],
    });

    const cityIdsWithHotels = hotels
      .map((h) => h.hotel_city)
      .filter(isNonEmptyString)
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isFinite(id));

    if (!cityIdsWithHotels.length) {
      // no hotel cities found; return whatever stored_locations gave
      return locations.map((loc) => ({ id: loc, name: loc }));
    }

    // 2. Get names of these cities
    const cities = await (this.prisma as any).dvi_cities.findMany({
      where: { id: { in: cityIdsWithHotels }, deleted: 0 },
      select: { name: true },
    });

    // ✅ FIX TS2345: name can be null -> guard before toLowerCase()
    const cityNamesWithHotels: string[] = (cities as Array<{ name: string | null }>)

      .map((c) => (isNonEmptyString(c?.name) ? c.name.trim().toLowerCase() : ''))
      .filter(isNonEmptyString);

    // Add common aliases to the list of valid city names
    const CITY_ALIASES: Record<string, string[]> = {
      alappuzha: ['alleppey', 'alleppe'],
      kochi: ['cochin'],
      kozhikode: ['calicut'],
      thiruvananthapuram: ['trivandrum'],
      puducherry: ['pondicherry'],
      bengaluru: ['bangalore'],
    };

    const allValidNames: string[] = [...cityNamesWithHotels];

    // ✅ FIX TS7006: type the param
    cityNamesWithHotels.forEach((name: string) => {
      const aliases = CITY_ALIASES[name];
      if (aliases?.length) allValidNames.push(...aliases);
    });

    // 3. Filter locations: keep if it matches or contains a city name with hotels
    locations = locations.filter((loc) => {
      const lowerLoc = loc.toLowerCase();
      return allValidNames.some(
        (cityName) => lowerLoc.includes(cityName) || cityName.includes(lowerLoc),
      );
    });

    return locations.map((loc) => ({
      id: loc,
      name: loc,
    }));
  }

  async getItineraryTypes(): Promise<SimpleOption[]> {
    return [
      { id: '1', label: 'Default' },
      { id: '2', label: 'Customize' },
    ];
  }

  async getTravelTypes(): Promise<SimpleOption[]> {
    return [
      { id: '1', label: 'By Flight' },
      { id: '2', label: 'By Train' },
      { id: '3', label: 'By Road' },
    ];
  }

  async getEntryTicketOptions(): Promise<SimpleOption[]> {
    return [
      { id: '1', label: 'Yes' },
      { id: '0', label: 'No' },
    ];
  }

  async getGuideOptions(): Promise<SimpleOption[]> {
    return [
      { id: '1', label: 'Yes' },
      { id: '0', label: 'No' },
    ];
  }

  async getNationalities(): Promise<SimpleOption[]> {
    return [
      { id: '101', label: 'Indian T' },
      { id: '2', label: 'Non Indian' },
    ];
  }

  async getFoodPreferences(): Promise<SimpleOption[]> {
    return [
      { id: 'veg', label: 'Vegetarian' },
      { id: 'non-veg', label: 'Non-Vegetarian' },
      { id: 'egg', label: 'Eggetarian' },
    ];
  }

  async getVehicleTypes(): Promise<SimpleOption[]> {
    const rows = await this.prisma.dvi_vehicle_type.findMany({
      where: {
        status: 1,
        deleted: 0,
      } as any,
      select: {
        vehicle_type_id: true,
        vehicle_type_title: true,
      },
      orderBy: [{ vehicle_type_title: 'asc' }],
    } as any);

    return rows.map((r) => ({
      id: String(r.vehicle_type_id),
      label: r.vehicle_type_title ?? '',
    }));
  }

  async getHotelCategories(): Promise<SimpleOption[]> {
    const rows = await this.prisma.dvi_hotel_category.findMany({
      where: {
        status: 1,
        deleted: 0,
      } as any,
      select: {
        hotel_category_id: true,
        hotel_category_title: true,
        hotel_category_code: true,
      },
      orderBy: [{ hotel_category_title: 'asc' }],
    } as any);

    return rows.map((r) => ({
      id: String(r.hotel_category_id),
      label: r.hotel_category_title ?? r.hotel_category_code ?? '',
    }));
  }

  async getHotelFacilities(): Promise<SimpleOption[]> {
    return [
      { id: '24hr-business-center', label: '24 Hour business center' },
      { id: '24hr-checkin', label: '24 Hour Check-In' },
      { id: '24hr-frontdesk', label: '24 Hour Front Desk' },
      { id: '24hr-room-service', label: '24 Hour Room Service' },
      { id: 'fitness-centre', label: '24-hour fitness facilities' },
      { id: 'wifi', label: 'Free Wi-Fi' },
      { id: 'parking', label: 'Free Parking' },
      { id: 'pool', label: 'Swimming Pool' },
      { id: 'spa', label: 'Spa' },
      { id: 'restaurant', label: 'In-house Restaurant' },
    ];
  }

  // ---------------------------------------------------------------------------
  // VIA ROUTES – match old PHP behaviour (use DB: dvi_stored_locations +
  // dvi_stored_location_via_routes)
  // ---------------------------------------------------------------------------
  async getViaRoutes(
    source?: string,
    destination?: string,
    q?: string, // optional typed text from frontend
  ): Promise<SimpleOption[]> {
    const src = (source || '').trim();
    const dest = (destination || '').trim();

    if (!src || !dest) {
      console.warn('[ViaRoutes] Missing source or destination', 'source=', src, 'destination=', dest);
      return [];
    }

    // 1) Find location_ID from dvi_stored_locations (same as PHP)
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: {
        deleted: 0,
        status: 1,
        source_location: src,
        destination_location: dest,
      } as any,
      select: {
        location_ID: true,
      },
    } as any);

    if (!location) {
      console.warn(
        '[ViaRoutes] No location_ID found for source/destination',
        'source=',
        src,
        'destination=',
        dest,
      );
      return [];
    }

    // 2) Fetch via routes for that location_id
    const viaRoutes = await this.prisma.dvi_stored_location_via_routes.findMany({
      where: {
        deleted: 0,
        status: 1,
        location_id: location.location_ID,
        ...(q && q.trim()
          ? {
              via_route_location: {
                contains: q.trim(),
                mode: 'insensitive',
              } as any,
            }
          : {}),
      } as any,
      select: {
        via_route_location_ID: true,
        via_route_location: true,
      },
      orderBy: {
        via_route_location: 'asc',
      },
    } as any);

    if (!viaRoutes.length) return [];

    // 3) Map to SimpleOption[] (id = via_route_location_ID, label = name)
    return viaRoutes.map((r) => ({
      id: String(r.via_route_location_ID),
      label: r.via_route_location ?? '',
    }));
  }
}
