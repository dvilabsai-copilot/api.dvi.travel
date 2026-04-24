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

function sortWithIndiaPinnedAndRetained(
  options: SimpleOption[],
): SimpleOption[] {
  const normalized = options
    .map((item) => ({
      id: String(item.id),
      label: String(item.label ?? '').trim(),
    }))
    .filter((item) => item.label.length > 0);

  const alphabetical = [...normalized].sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  const india = alphabetical.find(
    (item) => item.label.toLowerCase() === 'india',
  );

  return india ? [india, ...alphabetical] : alphabetical;
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
  private async getItineraryDistanceLimit(): Promise<number | null> {
    const row = await this.prisma.dvi_global_settings.findFirst({
      where: {
        deleted: 0,
        status: 1,
      } as any,
      select: {
        itinerary_distance_limit: true,
      },
    } as any);

    if (!row || row.itinerary_distance_limit == null) return null;
    return Number(row.itinerary_distance_limit);
  }

  async getLocations(
    type: LocationType = 'source',
    sourceLocation?: string,
    dayNo?: string,
    totalNoOfDays?: string,
    departureLocation?: string,
  ): Promise<LocationOption[]> {
    const isDestination = type === 'destination';

    let rows:
      | Array<{ source_location?: string | null; destination_location?: string | null }>
      | Array<{ destination_location?: string | null }>;

    if (isDestination && isNonEmptyString(sourceLocation)) {
      const trimmedSourceLocation = sourceLocation.trim();
      const trimmedDepartureLocation = isNonEmptyString(departureLocation)
        ? departureLocation.trim()
        : '';
      const parsedDayNo = Number(dayNo);
      const parsedTotalNoOfDays = Number(totalNoOfDays);
      const hasDayContext =
        Number.isFinite(parsedDayNo) &&
        parsedDayNo > 0 &&
        Number.isFinite(parsedTotalNoOfDays) &&
        parsedTotalNoOfDays > 0;

      const whereClauses: string[] = ['deleted = 0', 'status = 1'];
      const params: Array<string | number> = [];

      if (
        hasDayContext &&
        parsedTotalNoOfDays - 1 === parsedDayNo &&
        trimmedDepartureLocation
      ) {
        whereClauses.push('(source_location = ? OR source_location = ?)');
        params.push(trimmedSourceLocation, trimmedDepartureLocation);
      } else {
        whereClauses.push('source_location = ?');
        params.push(trimmedSourceLocation);
      }

      if (
        hasDayContext &&
        parsedTotalNoOfDays === parsedDayNo &&
        trimmedDepartureLocation
      ) {
        whereClauses.push('destination_location = ?');
        params.push(trimmedDepartureLocation);
      }

      const itineraryDistanceLimit = await this.getItineraryDistanceLimit();
      if (
        itineraryDistanceLimit != null &&
        Number.isFinite(itineraryDistanceLimit) &&
        itineraryDistanceLimit > 0
      ) {
        whereClauses.push('distance <= ?');
        params.push(itineraryDistanceLimit);
      }

      rows = await (this.prisma as any).$queryRawUnsafe(
        `
        SELECT destination_location
        FROM dvi_stored_locations
        WHERE ${whereClauses.join(' AND ')}
          AND destination_location IS NOT NULL
          AND TRIM(destination_location) <> ''
        GROUP BY destination_location
        ORDER BY MIN(CAST(distance AS DECIMAL(10,2))) ASC, destination_location ASC
        `,
        ...params,
      );
    } else {
      rows = await this.prisma.dvi_stored_locations.findMany({
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
    }

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

    // 3. Prefer locations that match a city having active hotels, but do NOT drop
// newly added stored locations that may not yet map to an active hotel city.
// This keeps the old itinerary ordering for the matched set while still showing
// everything currently stored in dvi_stored_locations.
const hotelMatchedLocations = locations.filter((loc) => {
  const lowerLoc = loc.toLowerCase();
  return allValidNames.some(
    (cityName) => lowerLoc.includes(cityName) || cityName.includes(lowerLoc),
  );
});

const seenLocationKeys = new Set<string>();
const mergedLocations: string[] = [];

for (const loc of [...hotelMatchedLocations, ...locations]) {
  const trimmed = loc.trim();
  if (!trimmed) continue;

  const key = trimmed.toLowerCase();
  if (seenLocationKeys.has(key)) continue;

  seenLocationKeys.add(key);
  mergedLocations.push(trimmed);
}

return mergedLocations.map((loc) => ({
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
  const countries: SimpleOption[] = [
    { id: '101', label: 'India' },

    { id: '102', label: 'Afghanistan' },
    { id: '103', label: 'Albania' },
    { id: '104', label: 'Algeria' },
    { id: '105', label: 'Andorra' },
    { id: '106', label: 'Angola' },
    { id: '107', label: 'Antigua and Barbuda' },
    { id: '108', label: 'Argentina' },
    { id: '109', label: 'Armenia' },
    { id: '110', label: 'Australia' },
    { id: '111', label: 'Austria' },
    { id: '112', label: 'Azerbaijan' },
    { id: '113', label: 'Bahamas' },
    { id: '114', label: 'Bahrain' },
    { id: '115', label: 'Bangladesh' },
    { id: '116', label: 'Barbados' },
    { id: '117', label: 'Belarus' },
    { id: '118', label: 'Belgium' },
    { id: '119', label: 'Belize' },
    { id: '120', label: 'Benin' },
    { id: '121', label: 'Bhutan' },
    { id: '122', label: 'Bolivia' },
    { id: '123', label: 'Bosnia and Herzegovina' },
    { id: '124', label: 'Botswana' },
    { id: '125', label: 'Brazil' },
    { id: '126', label: 'Brunei' },
    { id: '127', label: 'Bulgaria' },
    { id: '128', label: 'Burkina Faso' },
    { id: '129', label: 'Burundi' },
    { id: '130', label: 'Cabo Verde' },
    { id: '131', label: 'Cambodia' },
    { id: '132', label: 'Cameroon' },
    { id: '133', label: 'Canada' },
    { id: '134', label: 'Central African Republic' },
    { id: '135', label: 'Chad' },
    { id: '136', label: 'Chile' },
    { id: '137', label: 'China' },
    { id: '138', label: 'Colombia' },
    { id: '139', label: 'Comoros' },
    { id: '140', label: 'Congo' },
    { id: '141', label: 'Costa Rica' },
    { id: '142', label: 'Croatia' },
    { id: '143', label: 'Cuba' },
    { id: '144', label: 'Cyprus' },
    { id: '145', label: 'Czech Republic' },
    { id: '146', label: 'Democratic Republic of the Congo' },
    { id: '147', label: 'Denmark' },
    { id: '148', label: 'Djibouti' },
    { id: '149', label: 'Dominica' },
    { id: '150', label: 'Dominican Republic' },
    { id: '151', label: 'Ecuador' },
    { id: '152', label: 'Egypt' },
    { id: '153', label: 'El Salvador' },
    { id: '154', label: 'Equatorial Guinea' },
    { id: '155', label: 'Eritrea' },
    { id: '156', label: 'Estonia' },
    { id: '157', label: 'Eswatini' },
    { id: '158', label: 'Ethiopia' },
    { id: '159', label: 'Fiji' },
    { id: '160', label: 'Finland' },
    { id: '161', label: 'France' },
    { id: '162', label: 'Gabon' },
    { id: '163', label: 'Gambia' },
    { id: '164', label: 'Georgia' },
    { id: '165', label: 'Germany' },
    { id: '166', label: 'Ghana' },
    { id: '167', label: 'Greece' },
    { id: '168', label: 'Grenada' },
    { id: '169', label: 'Guatemala' },
    { id: '170', label: 'Guinea' },
    { id: '171', label: 'Guinea-Bissau' },
    { id: '172', label: 'Guyana' },
    { id: '173', label: 'Haiti' },
    { id: '174', label: 'Honduras' },
    { id: '175', label: 'Hungary' },
    { id: '176', label: 'Iceland' },
    { id: '177', label: 'India' },
    { id: '178', label: 'Indonesia' },
    { id: '179', label: 'Iran' },
    { id: '180', label: 'Iraq' },
    { id: '181', label: 'Ireland' },
    { id: '182', label: 'Israel' },
    { id: '183', label: 'Italy' },
    { id: '184', label: 'Jamaica' },
    { id: '185', label: 'Japan' },
    { id: '186', label: 'Jordan' },
    { id: '187', label: 'Kazakhstan' },
    { id: '188', label: 'Kenya' },
    { id: '189', label: 'Kiribati' },
    { id: '190', label: 'Kuwait' },
    { id: '191', label: 'Kyrgyzstan' },
    { id: '192', label: 'Laos' },
    { id: '193', label: 'Latvia' },
    { id: '194', label: 'Lebanon' },
    { id: '195', label: 'Lesotho' },
    { id: '196', label: 'Liberia' },
    { id: '197', label: 'Libya' },
    { id: '198', label: 'Liechtenstein' },
    { id: '199', label: 'Lithuania' },
    { id: '200', label: 'Luxembourg' },
    { id: '201', label: 'Madagascar' },
    { id: '202', label: 'Malawi' },
    { id: '203', label: 'Malaysia' },
    { id: '204', label: 'Maldives' },
    { id: '205', label: 'Mali' },
    { id: '206', label: 'Malta' },
    { id: '207', label: 'Marshall Islands' },
    { id: '208', label: 'Mauritania' },
    { id: '209', label: 'Mauritius' },
    { id: '210', label: 'Mexico' },
    { id: '211', label: 'Micronesia' },
    { id: '212', label: 'Moldova' },
    { id: '213', label: 'Monaco' },
    { id: '214', label: 'Mongolia' },
    { id: '215', label: 'Montenegro' },
    { id: '216', label: 'Morocco' },
    { id: '217', label: 'Mozambique' },
    { id: '218', label: 'Myanmar' },
    { id: '219', label: 'Namibia' },
    { id: '220', label: 'Nauru' },
    { id: '221', label: 'Nepal' },
    { id: '222', label: 'Netherlands' },
    { id: '223', label: 'New Zealand' },
    { id: '224', label: 'Nicaragua' },
    { id: '225', label: 'Niger' },
    { id: '226', label: 'Nigeria' },
    { id: '227', label: 'North Korea' },
    { id: '228', label: 'North Macedonia' },
    { id: '229', label: 'Norway' },
    { id: '230', label: 'Oman' },
    { id: '231', label: 'Pakistan' },
    { id: '232', label: 'Palau' },
    { id: '233', label: 'Panama' },
    { id: '234', label: 'Papua New Guinea' },
    { id: '235', label: 'Paraguay' },
    { id: '236', label: 'Peru' },
    { id: '237', label: 'Philippines' },
    { id: '238', label: 'Poland' },
    { id: '239', label: 'Portugal' },
    { id: '240', label: 'Qatar' },
    { id: '241', label: 'Romania' },
    { id: '242', label: 'Russia' },
    { id: '243', label: 'Rwanda' },
    { id: '244', label: 'Saint Kitts and Nevis' },
    { id: '245', label: 'Saint Lucia' },
    { id: '246', label: 'Saint Vincent and the Grenadines' },
    { id: '247', label: 'Samoa' },
    { id: '248', label: 'San Marino' },
    { id: '249', label: 'Sao Tome and Principe' },
    { id: '250', label: 'Saudi Arabia' },
    { id: '251', label: 'Senegal' },
    { id: '252', label: 'Serbia' },
    { id: '253', label: 'Seychelles' },
    { id: '254', label: 'Sierra Leone' },
    { id: '255', label: 'Singapore' },
    { id: '256', label: 'Slovakia' },
    { id: '257', label: 'Slovenia' },
    { id: '258', label: 'Solomon Islands' },
    { id: '259', label: 'Somalia' },
    { id: '260', label: 'South Africa' },
    { id: '261', label: 'South Korea' },
    { id: '262', label: 'South Sudan' },
    { id: '263', label: 'Spain' },
    { id: '264', label: 'Sri Lanka' },
    { id: '265', label: 'Sudan' },
    { id: '266', label: 'Suriname' },
    { id: '267', label: 'Sweden' },
    { id: '268', label: 'Switzerland' },
    { id: '269', label: 'Syria' },
    { id: '270', label: 'Taiwan' },
    { id: '271', label: 'Tajikistan' },
    { id: '272', label: 'Tanzania' },
    { id: '273', label: 'Thailand' },
    { id: '274', label: 'Timor-Leste' },
    { id: '275', label: 'Togo' },
    { id: '276', label: 'Tonga' },
    { id: '277', label: 'Trinidad and Tobago' },
    { id: '278', label: 'Tunisia' },
    { id: '279', label: 'Turkey' },
    { id: '280', label: 'Turkmenistan' },
    { id: '281', label: 'Tuvalu' },
    { id: '282', label: 'Uganda' },
    { id: '283', label: 'Ukraine' },
    { id: '284', label: 'United Arab Emirates' },
    { id: '285', label: 'United Kingdom' },
    { id: '286', label: 'United States' },
    { id: '287', label: 'Uruguay' },
    { id: '288', label: 'Uzbekistan' },
    { id: '289', label: 'Vanuatu' },
    { id: '290', label: 'Vatican City' },
    { id: '291', label: 'Venezuela' },
    { id: '292', label: 'Vietnam' },
    { id: '293', label: 'Yemen' },
    { id: '294', label: 'Zambia' },
    { id: '295', label: 'Zimbabwe' },
  ];

  return sortWithIndiaPinnedAndRetained(countries);
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
