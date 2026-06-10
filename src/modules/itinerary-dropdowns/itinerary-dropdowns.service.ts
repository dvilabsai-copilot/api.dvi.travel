// REPLACE-WHOLE-FILE
// FILE: src/modules/itinerary-dropdowns/itinerary-dropdowns.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  CANONICAL_HOTEL_RATE_PLANS,
  HotelMealComposition,
  TboMealType,
} from '../hotels/hotel-rate-plans';
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

export type MealPlanOption = {
  id: string;
  label: string;
  code: string;
  description: string;
  mealComposition?: HotelMealComposition;
  tboMealType?: TboMealType;
  includesBreakfast: number;
  includesLunch: number;
  includesDinner: number;
};

type LocationType = 'source' | 'destination';

type StoredLocationMappingRow = {
  source_location: string | null;
  source_location_city: string | null;
  destination_location: string | null;
  destination_location_city: string | null;
};

type StoredLocationMaps = {
  exact: Map<string, string>;
  normalized: Map<string, string>;
};

type ResolvedCityRow = {
  id: number;
  name: string | null;
};

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

  private normalizeLocationKey(value: string): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  private extractFirstCityToken(value: string): string {
    return String(value ?? '')
      .split(',')[0]
      ?.trim() ?? '';
  }

  private buildLocationCandidateValues(value: string): string[] {
    const trimmed = String(value ?? '').trim();
    const firstToken = this.extractFirstCityToken(trimmed);
    const candidates = [trimmed];

    if (firstToken && firstToken.toLowerCase() !== trimmed.toLowerCase()) {
      candidates.push(firstToken);
    }

    return Array.from(new Set(candidates.filter(Boolean)));
  }

  private buildUniqueNormalizedStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
      const trimmed = String(value ?? '').trim();
      if (!trimmed) continue;

      const key = this.normalizeLocationKey(trimmed);
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(trimmed);
    }

    return result;
  }

  /**
   * Get locations to eligible cities mapping from dvi_stored_locations
   * Searches both source_location and destination_location fields
   */
  private async getLocationsToCitiesMapping(): Promise<StoredLocationMaps> {
    const exact = new Map<string, string>();
    const normalized = new Map<string, string>();

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

    for (const row of rows as StoredLocationMappingRow[]) {
      const sourceLocation = String(row.source_location ?? '').trim();
      const sourceCity = String(row.source_location_city ?? '').trim();
      const destinationLocation = String(row.destination_location ?? '').trim();
      const destinationCity = String(row.destination_location_city ?? '').trim();

      if (sourceLocation && sourceCity) {
        exact.set(sourceLocation, sourceCity);
        normalized.set(this.normalizeLocationKey(sourceLocation), sourceCity);
      }

      if (destinationLocation && destinationCity) {
        exact.set(destinationLocation, destinationCity);
        normalized.set(
          this.normalizeLocationKey(destinationLocation),
          destinationCity,
        );
      }
    }

    return { exact, normalized };
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

      const candidates = this.buildLocationCandidateValues(trimmedLoc);
      let resolvedCity = '';

      for (const candidate of candidates) {
        const exactMatch = mapping.exact.get(candidate);
        if (exactMatch) {
          resolvedCity = exactMatch.trim();
          break;
        }

        const normalizedMatch = mapping.normalized.get(
          this.normalizeLocationKey(candidate),
        );
        if (normalizedMatch) {
          resolvedCity = normalizedMatch.trim();
          break;
        }
      }

      if (resolvedCity) {
        uniqueCities.add(resolvedCity);
        continue;
      }

      const firstToken = this.extractFirstCityToken(trimmedLoc);
      if (firstToken) {
        uniqueCities.add(firstToken);
      }

      uniqueCities.add(trimmedLoc);
    }

    return Array.from(uniqueCities);
  }

  private async getVehicleCountsByCity(cities: string[]) {
    const uniqueCities = Array.from(
      new Set(cities.map((city) => city.trim()).filter(Boolean)),
    );

    const summaries: Array<{
      city: string;
      exactCount: number;
      normalizedCount: number;
      likeCount: number;
      activeExactCount: number;
    }> = [];

    for (const city of uniqueCities) {
      const [exactRows, normalizedRows, likeRows, activeExactRows] =
        await Promise.all([
          (this.prisma as any).$queryRawUnsafe(
            'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE owner_city = ?',
            city,
          ),
          (this.prisma as any).$queryRawUnsafe(
            'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE LOWER(TRIM(owner_city)) = LOWER(TRIM(?))',
            city,
          ),
          (this.prisma as any).$queryRawUnsafe(
            'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE owner_city LIKE ?',
            `%${city}%`,
          ),
          (this.prisma as any).$queryRawUnsafe(
            'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE owner_city = ? AND status = 1 AND deleted = 0',
            city,
          ),
        ]);

      const readTotal = (rows: any[]) => Number(rows?.[0]?.total ?? 0);

      summaries.push({
        city,
        exactCount: readTotal(exactRows),
        normalizedCount: readTotal(normalizedRows),
        likeCount: readTotal(likeRows),
        activeExactCount: readTotal(activeExactRows),
      });
    }

    return summaries;
  }

  private async resolveEligibleCityIds(
    cityNames: string[],
    originalLocations: string[],
  ): Promise<Array<{ id: number; name: string }>> {
    const candidates = this.buildUniqueNormalizedStrings([
      ...cityNames,
      ...originalLocations.flatMap((location) =>
        this.buildLocationCandidateValues(location),
      ),
    ]);

    if (candidates.length === 0) {
      return [];
    }

    const rows = (await (this.prisma as any).$queryRawUnsafe(
      `
      SELECT id, name
      FROM dvi_cities
      WHERE deleted = 0
        AND LOWER(TRIM(name)) IN (${candidates.map(() => 'LOWER(TRIM(?))').join(', ')})
      ORDER BY name ASC, id ASC
      `,
      ...candidates,
    )) as ResolvedCityRow[];

    return rows
      .map((row) => ({
        id: Number(row.id),
        name: String(row.name ?? '').trim(),
      }))
      .filter((row) => Number.isFinite(row.id) && row.id > 0 && !!row.name);
  }

  private async getEligibleVehicleTypeDebugCounts(args: {
    cityNames: string[];
    cityIds: number[];
  }) {
    const cityNames = this.buildUniqueNormalizedStrings(args.cityNames);
    const cityIds = Array.from(
      new Set(
        args.cityIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    );

    const cityNameClause = cityNames.length
      ? `VEHICLE.owner_city IN (${cityNames.map(() => '?').join(', ')})`
      : '1 = 0';
    const cityIdClause = cityIds.length
      ? `CAST(VEHICLE.owner_city AS UNSIGNED) IN (${cityIds.map(() => '?').join(', ')})`
      : '1 = 0';
    const branchCityClause = cityIds.length
      ? `VENDOR_BRANCH_DETAILS.vendor_branch_city IN (${cityIds.map(() => '?').join(', ')})`
      : '1 = 0';

    const cityNameParams = cityNames;
    const cityIdParams = cityIds;
    const branchCityParams = cityIds;

    const buildCountSql = (extraJoinSql: string, extraWhereSql: string) => `
      SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
      FROM dvi_vehicle VEHICLE
      LEFT JOIN dvi_vendor_details VENDOR_DETAILS
        ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
      LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
        ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
      ${extraJoinSql}
      WHERE VEHICLE.status = 1
        AND VEHICLE.deleted = 0
        AND VENDOR_DETAILS.status = 1
        AND VENDOR_DETAILS.deleted = 0
        AND VENDOR_BRANCH_DETAILS.status = 1
        AND VENDOR_BRANCH_DETAILS.deleted = 0
        AND (${cityNameClause} OR ${cityIdClause} OR ${branchCityClause})
        ${extraWhereSql}
    `;

    const readTotal = (rows: Array<{ total: number | bigint }>) =>
      Number(rows?.[0]?.total ?? 0);

    const commonParams = [...cityNameParams, ...cityIdParams, ...branchCityParams];

    const [
      cityNameMatches,
      cityIdMatches,
      branchCityMatches,
      legacyJoinMatches,
      modernJoinMatches,
    ] = await Promise.all([
      (this.prisma as any).$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_details VENDOR_DETAILS
          ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
        LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
          ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
        WHERE VEHICLE.status = 1
          AND VEHICLE.deleted = 0
          AND VENDOR_DETAILS.status = 1
          AND VENDOR_DETAILS.deleted = 0
          AND VENDOR_BRANCH_DETAILS.status = 1
          AND VENDOR_BRANCH_DETAILS.deleted = 0
          AND ${cityNameClause}
        `,
        ...cityNameParams,
      ),
      (this.prisma as any).$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_details VENDOR_DETAILS
          ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
        LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
          ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
        WHERE VEHICLE.status = 1
          AND VEHICLE.deleted = 0
          AND VENDOR_DETAILS.status = 1
          AND VENDOR_DETAILS.deleted = 0
          AND VENDOR_BRANCH_DETAILS.status = 1
          AND VENDOR_BRANCH_DETAILS.deleted = 0
          AND ${cityIdClause}
        `,
        ...cityIdParams,
      ),
      (this.prisma as any).$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_details VENDOR_DETAILS
          ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
        LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
          ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
        WHERE VEHICLE.status = 1
          AND VEHICLE.deleted = 0
          AND VENDOR_DETAILS.status = 1
          AND VENDOR_DETAILS.deleted = 0
          AND VENDOR_BRANCH_DETAILS.status = 1
          AND VENDOR_BRANCH_DETAILS.deleted = 0
          AND ${branchCityClause}
        `,
        ...branchCityParams,
      ),
      (this.prisma as any).$queryRawUnsafe(
        buildCountSql(
          `
          LEFT JOIN dvi_vendor_vehicle_types LEGACY_VENDOR_VEHICLE_TYPES
            ON LEGACY_VENDOR_VEHICLE_TYPES.vendor_id = VEHICLE.vendor_id
            AND LEGACY_VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID = VEHICLE.vehicle_type_id
            AND LEGACY_VENDOR_VEHICLE_TYPES.status = 1
            AND LEGACY_VENDOR_VEHICLE_TYPES.deleted = 0
          `,
          'AND LEGACY_VENDOR_VEHICLE_TYPES.vehicle_type_id IS NOT NULL',
        ),
        ...commonParams,
      ),
      (this.prisma as any).$queryRawUnsafe(
        buildCountSql(
          `
          LEFT JOIN dvi_vendor_vehicle_types MODERN_VENDOR_VEHICLE_TYPES
            ON MODERN_VENDOR_VEHICLE_TYPES.vendor_id = VEHICLE.vendor_id
            AND MODERN_VENDOR_VEHICLE_TYPES.vehicle_type_id = VEHICLE.vehicle_type_id
            AND MODERN_VENDOR_VEHICLE_TYPES.status = 1
            AND MODERN_VENDOR_VEHICLE_TYPES.deleted = 0
          `,
          'AND MODERN_VENDOR_VEHICLE_TYPES.vehicle_type_id IS NOT NULL',
        ),
        ...commonParams,
      ),
    ]);

    return {
      cityNameMatches: readTotal(cityNameMatches),
      cityIdMatches: readTotal(cityIdMatches),
      branchCityMatches: readTotal(branchCityMatches),
      legacyJoinMatches: readTotal(legacyJoinMatches),
      modernJoinMatches: readTotal(modernJoinMatches),
    };
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
      const resolvedCityRows = await this.resolveEligibleCityIds(
        eligibleCities,
        uniqueLocations,
      );
      const resolvedCityIds = Array.from(
        new Set(
          resolvedCityRows
            .map((row) => Number(row.id))
            .filter((value) => Number.isFinite(value) && value > 0),
        ),
      );

      console.log('[getEligibleVehicleTypes] Eligible cities:', eligibleCities);
      console.log('[getEligibleVehicleTypes] Resolved city IDs:', resolvedCityIds);

      if (eligibleCities.length === 0) {
        console.warn(
          '[getEligibleVehicleTypes] No eligible cities found',
          JSON.stringify({
            sourceLocation: dto.sourceLocation || [],
            nextVisitingLocation: dto.nextVisitingLocation || [],
          }),
        );
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
      const cityNameClause = eligibleCities.length
        ? `VEHICLE.owner_city IN (${eligibleCities.map(() => `?`).join(',')})`
        : '1 = 0';
      const cityIdClause = resolvedCityIds.length
        ? `CAST(VEHICLE.owner_city AS UNSIGNED) IN (${resolvedCityIds.map(() => `?`).join(',')})`
        : '1 = 0';
      const branchCityClause = resolvedCityIds.length
        ? `VENDOR_BRANCH_DETAILS.vendor_branch_city IN (${resolvedCityIds.map(() => `?`).join(',')})`
        : '1 = 0';
      const queryParams = [
        ...eligibleCities,
        ...resolvedCityIds,
        ...resolvedCityIds,
      ];

      console.log(
        '[getEligibleVehicleTypes] Executing SQL query with cities:',
        JSON.stringify({
          eligibleCities,
          resolvedCityIds,
        }),
      );

      const distinctVehicleTypes = await (this.prisma as any).$queryRawUnsafe(
        `
        SELECT DISTINCT 
          VEHICLE_TYPES.vehicle_type_id,
          VEHICLE_TYPES.vehicle_type_title,
          VEHICLE_TYPES.occupancy
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_vehicle_types LEGACY_VENDOR_VEHICLE_TYPES
          ON LEGACY_VENDOR_VEHICLE_TYPES.vendor_id = VEHICLE.vendor_id
          AND LEGACY_VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID = VEHICLE.vehicle_type_id
          AND LEGACY_VENDOR_VEHICLE_TYPES.status = 1
          AND LEGACY_VENDOR_VEHICLE_TYPES.deleted = 0
        LEFT JOIN dvi_vendor_vehicle_types MODERN_VENDOR_VEHICLE_TYPES
          ON MODERN_VENDOR_VEHICLE_TYPES.vendor_id = VEHICLE.vendor_id
          AND MODERN_VENDOR_VEHICLE_TYPES.vehicle_type_id = VEHICLE.vehicle_type_id
          AND MODERN_VENDOR_VEHICLE_TYPES.status = 1
          AND MODERN_VENDOR_VEHICLE_TYPES.deleted = 0
        LEFT JOIN dvi_vendor_details VENDOR_DETAILS 
          ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
        LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS 
          ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
        LEFT JOIN dvi_vehicle_type VEHICLE_TYPES 
          ON VEHICLE_TYPES.vehicle_type_id = COALESCE(
            MODERN_VENDOR_VEHICLE_TYPES.vehicle_type_id,
            LEGACY_VENDOR_VEHICLE_TYPES.vehicle_type_id
          )
          AND VEHICLE_TYPES.status = 1
          AND VEHICLE_TYPES.deleted = 0
        WHERE VEHICLE.status = 1 
          AND VEHICLE.deleted = 0 
          AND VENDOR_DETAILS.status = 1 
          AND VENDOR_DETAILS.deleted = 0 
          AND VENDOR_BRANCH_DETAILS.status = 1 
          AND VENDOR_BRANCH_DETAILS.deleted = 0
          AND (${cityNameClause} OR ${cityIdClause} OR ${branchCityClause})
          AND COALESCE(
            MODERN_VENDOR_VEHICLE_TYPES.vehicle_type_id,
            LEGACY_VENDOR_VEHICLE_TYPES.vehicle_type_id
          ) IS NOT NULL
        ORDER BY VEHICLE_TYPES.occupancy ASC, VEHICLE_TYPES.vehicle_type_title ASC
        `,
        ...queryParams,
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

      if (vehicleTypes.length === 0) {
        const vehicleCounts = await this.getVehicleCountsByCity(eligibleCities);
        const debugCounts = await this.getEligibleVehicleTypeDebugCounts({
          cityNames: eligibleCities,
          cityIds: resolvedCityIds,
        });
        const mappingWarnings = uniqueLocations
          .map((location) => ({
            location,
            normalized: this.normalizeLocationKey(location),
            firstToken: this.extractFirstCityToken(location),
          }))
          .filter(
            (item) =>
              !eligibleCities.some(
                (city) => this.normalizeLocationKey(city) === item.normalized,
              ),
          );

        console.warn(
          '[getEligibleVehicleTypes] Empty vehicle type result',
          JSON.stringify({
            sourceLocation: dto.sourceLocation || [],
            nextVisitingLocation: dto.nextVisitingLocation || [],
            eligibleCities,
            resolvedCityIds,
            vehicleCounts,
            debugCounts,
            reason:
              vehicleCounts.every((item) => item.activeExactCount === 0) &&
              debugCounts.cityIdMatches === 0 &&
              debugCounts.branchCityMatches === 0
                ? 'No active vehicles found for derived city names, city IDs, or branch city IDs.'
                : 'Vehicles exist, but rows may be dropped by vendor/branch/vendor_vehicle_type/vehicle_type joins.',
            mappingWarnings,
          }),
        );
      }

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
  const rows = await this.prisma.dvi_countries.findMany({
    where: { status: 1, deleted: 0 },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const countries: SimpleOption[] = rows.map((r) => ({
    id: String(r.id),
    label: r.name,
  }));
  return sortWithIndiaPinnedAndRetained(countries);
}

  async getFoodPreferences(): Promise<SimpleOption[]> {
    return [
      { id: 'veg', label: 'Vegetarian' },
      { id: 'non-veg', label: 'Non-Vegetarian' },
      { id: 'egg', label: 'Eggetarian' },
    ];
  }

  async getMealPlans(): Promise<MealPlanOption[]> {
    const rows = await this.prisma.dvi_hotel_rate_plan_master.findMany({
      where: {
        status: 1,
        deleted: 0,
      } as any,
      select: {
        rate_plan_code: true,
        rate_plan_name: true,
        description: true,
        includes_breakfast: true,
        includes_lunch: true,
        includes_dinner: true,
        sort_order: true,
      },
      orderBy: [{ sort_order: 'asc' }, { rate_plan_code: 'asc' }],
    } as any);

    const mapped = rows
      .map((r: any): MealPlanOption | null => {
        const code = String(r.rate_plan_code ?? '').trim().toUpperCase();
        const name = String(r.rate_plan_name ?? '').trim();
        if (!code) return null;

        const description = String(r.description ?? '').trim();
        const includesBreakfast = Number(r.includes_breakfast ?? 0) ? 1 : 0;
        const includesLunch = Number(r.includes_lunch ?? 0) ? 1 : 0;
        const includesDinner = Number(r.includes_dinner ?? 0) ? 1 : 0;

        return {
          id: code,
          code,
          description,
          label: name ? `${code} - ${name}` : code,
          mealComposition: CANONICAL_HOTEL_RATE_PLANS.find((plan) => plan.code === code)?.mealComposition,
          tboMealType: CANONICAL_HOTEL_RATE_PLANS.find((plan) => plan.code === code)?.tboMealType,
          includesBreakfast,
          includesLunch,
          includesDinner,
        };
      })
      .filter((x): x is MealPlanOption => x !== null);

    if (mapped.length > 0) {
      return mapped;
    }

    // Fallback to the canonical backend definitions when master data is not seeded.
    return CANONICAL_HOTEL_RATE_PLANS.map((plan) => ({
      id: plan.code,
      code: plan.code,
      label: `${plan.code} - ${plan.name}`,
      description: plan.description,
      mealComposition: plan.mealComposition,
      tboMealType: plan.tboMealType,
      includesBreakfast: plan.includesBreakfast,
      includesLunch: plan.includesLunch,
      includesDinner: plan.includesDinner,
    }));
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
