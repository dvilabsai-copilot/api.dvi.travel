import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  normalizeCityName,
  resolveCityRecordByName,
} from '../itineraries/utils/city-normalization.util';
import { clearDistanceCache } from '../itineraries/engines/helpers/distance.helper';
import { clearStoredLocationCache as clearStoredLocationLookupCache } from './stored-location-cache.helper';
import {
  BetweenHotspotFiltersQueryDto,
  BetweenHotspotQueryDto,
  LocationResponseDto,
} from './dto/location.dto';
import { LocationGeoPolicyService } from './services/location-geo-policy.service';

type ListQuery = {
  search?: string;
  source?: string;
  destination?: string;
  page?: number;
  pageSize?: number;
};

type SourceLocationSeed = {
  source_location: string;
  source_location_city: string;
  source_city_id?: number | null;
  source_location_state: string;
  source_location_lattitude: string;
  source_location_longitude: string;
};

type AutosuggestQuery = {
  phrase?: string;
  format?: string;
  type?: string;
};

type StoredLocationContextRow = {
  location_ID: bigint;
  source_location: string | null;
  source_location_city: string | null;
  destination_location: string | null;
  destination_location_city: string | null;
};

type BetweenRoutePairCandidateRow = {
  from_hotspot_id: number;
  from_hotspot_name: string | null;
  from_hotspot_location: string | null;
  to_hotspot_id: number;
  to_hotspot_name: string | null;
  to_hotspot_location: string | null;
};

type BetweenHotspotCandidateRow = {
  hotspotId: number;
  hotspotName: string | null;
  hotspotLocation: string | null;
};

type LocationScope = {
  locationId: number;
  sourceKeys: string[];
  destinationKeys: string[];
  sourceLocation: string;
  sourceCity: string;
  destinationLocation: string;
  destinationCity: string;
  locationName: string;
};

@Injectable()
export class LocationsService {

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoPolicy: LocationGeoPolicyService = new LocationGeoPolicyService(),
  ) {}

  clearStoredLocationCache(reason: string) {
    clearStoredLocationLookupCache(reason);
  }

  private static readonly CITY_KEY_SYNONYMS: Record<string, string[]> = {
    bengaluru: ['bengaluru', 'bangalore'],
    chennai: ['chennai', 'madras'],
    kolkata: ['kolkata', 'calcutta'],
    mumbai: ['mumbai', 'bombay'],
    puducherry: ['puducherry', 'pondicherry'],
    thiruvananthapuram: ['thiruvananthapuram', 'trivandrum', 'tvm'],
  };

  /**
   * Convert database row to API response format
   * Handles field mapping from DB schema to API contract
   */
  private mapRowToResponse(row: any): LocationResponseDto {
    return {
      location_ID: Number(row.location_ID),
      source_location: row.source_location || '',
      source_city: row.source_location_city || '',
      source_city_id:
        row.source_city_id !== undefined && row.source_city_id !== null
          ? Number(row.source_city_id)
          : null,
      source_state: row.source_location_state || '',
      source_latitude: String(row.source_location_lattitude || ''),
      source_longitude: String(row.source_location_longitude || ''),
      destination_location: row.destination_location || '',
      destination_city: row.destination_location_city || '',
      destination_city_id:
        row.destination_city_id !== undefined && row.destination_city_id !== null
          ? Number(row.destination_city_id)
          : null,
      destination_state: row.destination_location_state || '',
      destination_latitude: String(row.destination_location_lattitude || ''),
      destination_longitude: String(row.destination_location_longitude || ''),
      distance_km: Number(row.distance || 0),
      duration_text: row.duration || '',
      location_description: row.location_description || null,
    };
  }

  // ------ LIST + FILTERS ------
  async list(q: ListQuery) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 10));

  const where: any = { deleted: 0 };

const source = String(q.source || "").trim();
const destination = String(q.destination || "").trim();
const search = String(q.search || "").trim();

if (source) {
  where.source_location = source;
}

if (destination) {
  where.destination_location = destination;
}

if (search) {
  where.OR = [
    { source_location: { contains: search } },
    { destination_location: { contains: search } },
    { source_location_city: { contains: search } },
    { destination_location_city: { contains: search } },
  ];
}

if (source && destination) {
  try {
    await this.ensureExactLocationRouteExists(source, destination);
  } catch (error) {
    console.error(
      '[locations] Failed to auto-create exact route',
      { source, destination, error },
    );
  }
}

  const orderBy: any[] = q.source
    ? [
        { distance: 'asc' },
        { destination_location: 'asc' },
        { location_ID: 'desc' },
      ]
    : [
        { location_ID: 'desc' },
      ];

  const rows = await this.prisma.dvi_stored_locations.findMany({
  where,
  orderBy,
  skip: (page - 1) * pageSize,
  take: pageSize,
});

const total = await this.prisma.dvi_stored_locations.count({ where });

  return {
    rows: rows.map((r) => this.mapRowToResponse(r)),
    total,
    page,
    pageSize,
  };
}

  async dropdowns() {
  const [sourceRows, destinationRows] = await Promise.all([
    this.prisma.dvi_stored_locations.findMany({
      where: {
        deleted: 0,
        source_location: {
          not: '',
        },
      },
      select: {
        source_location: true,
      },
      distinct: ['source_location'],
      orderBy: {
        source_location: 'asc',
      },
      take: 3000,
    }),

    this.prisma.dvi_stored_locations.findMany({
      where: {
        deleted: 0,
        destination_location: {
          not: '',
        },
      },
      select: {
        destination_location: true,
      },
      distinct: ['destination_location'],
      orderBy: {
        destination_location: 'asc',
      },
      take: 3000,
    }),
  ]);

  return {
    sources: this.uniqueStringsCaseInsensitive(
      sourceRows.map((x) => x.source_location).filter(Boolean),
    ),
    destinations: this.uniqueStringsCaseInsensitive(
      destinationRows.map((x) => x.destination_location).filter(Boolean),
    ),
  };
}

  private parseBooleanQuery(value: unknown): boolean {
    return ['1', 'true', 'yes'].includes(String(value ?? '').trim().toLowerCase());
  }

  private async resolveCityIdByName(value: unknown): Promise<number | null> {
    const city = await resolveCityRecordByName(
      this.prisma,
      this.normalizeLocationName(value),
    );
    return city?.id ?? null;
  }

  private canonicalCityKey(name: string): string {
    const raw = String(name ?? '').split('|')[0]?.trim() ?? '';
    if (!raw) return '';

    const beforeComma = raw.split(',')[0]?.trim() ?? '';
    const normalizedPrimary = normalizeCityName(beforeComma);
    if (normalizedPrimary) return normalizedPrimary;

    return normalizeCityName(raw);
  }

  private expandCityKeySynonyms(key: string): string[] {
    const normalizedKey = this.canonicalCityKey(key);
    if (!normalizedKey) return [];

    const configured = LocationsService.CITY_KEY_SYNONYMS[normalizedKey] || [normalizedKey];
    const keys = new Set<string>();

    for (const value of configured) {
      const canonical = this.canonicalCityKey(value);
      if (canonical) {
        keys.add(canonical);
      }

      const raw = String(value ?? '').trim().toLowerCase();
      if (raw) {
        keys.add(raw);
      }
    }

    keys.add(normalizedKey);
    return Array.from(keys);
  }

  private buildLocationSideKeys(...values: Array<string | null | undefined>): string[] {
    const keys = new Set<string>();

    for (const value of values) {
      const canonical = this.canonicalCityKey(String(value ?? ''));
      if (!canonical) continue;

      for (const expanded of this.expandCityKeySynonyms(canonical)) {
        if (expanded) {
          keys.add(expanded);
        }
      }
    }

    return Array.from(keys);
  }

  private hotspotLocationMatchesKeys(
    hotspotLocation: string | null | undefined,
    targetKeys: string[],
  ): boolean {
    if (!targetKeys.length) return false;

    const parts = String(hotspotLocation || '')
      .split('|')
      .map((part) => this.canonicalCityKey(part))
      .filter(Boolean);

    if (!parts.length) return false;

    for (const part of parts) {
      for (const key of targetKeys) {
        if (part === key) return true;
        if (part.startsWith(`${key} `)) return true;
        if (part.includes(` ${key} `)) return true;
        if (part.endsWith(` ${key}`)) return true;
      }
    }

    return false;
  }

  private buildLocationDisplayName(row: StoredLocationContextRow): string {
    const source = this.normalizeLocationName(row.source_location);
    const destination = this.normalizeLocationName(row.destination_location);
    const sourceKey = this.canonicalCityKey(source);
    const destinationKey = this.canonicalCityKey(destination);

    if (source && (!destination || sourceKey === destinationKey)) {
      return source;
    }

    if (source && destination) {
      return `${source} -> ${destination}`;
    }

    return source || destination || `Location ${Number(row.location_ID)}`;
  }

  private mapLocationScope(row: StoredLocationContextRow): LocationScope {
    return {
      locationId: Number(row.location_ID),
      sourceKeys: this.buildLocationSideKeys(row.source_location, row.source_location_city),
      destinationKeys: this.buildLocationSideKeys(row.destination_location, row.destination_location_city),
      sourceLocation: this.normalizeLocationName(row.source_location),
      sourceCity: this.normalizeLocationName(row.source_location_city),
      destinationLocation: this.normalizeLocationName(row.destination_location),
      destinationCity: this.normalizeLocationName(row.destination_location_city),
      locationName: this.buildLocationDisplayName(row),
    };
  }

  private async getLocationContextRow(locationId: number): Promise<StoredLocationContextRow | null> {
    if (!locationId) return null;

    return this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
      select: {
        location_ID: true,
        source_location: true,
        source_location_city: true,
        destination_location: true,
        destination_location_city: true,
      },
    });
  }

  private locationMatchesRoutePair(
    scope: LocationScope,
    pair: BetweenRoutePairCandidateRow,
  ): boolean {
    return (
      this.hotspotLocationMatchesKeys(pair.from_hotspot_location, scope.sourceKeys) &&
      this.hotspotLocationMatchesKeys(pair.to_hotspot_location, scope.destinationKeys)
    );
  }

  private async getBetweenRoutePairCandidates(
    onlyUsable: boolean,
    sourceHotspotId?: number,
  ): Promise<BetweenRoutePairCandidateRow[]> {
    const whereConditions: Prisma.Sql[] = [];

    if (onlyUsable) {
      whereConditions.push(Prisma.sql`bm.route_fit_type IN ('ON_ROUTE', 'MINOR_DETOUR')`);
    }

    if (sourceHotspotId) {
      whereConditions.push(Prisma.sql`bm.from_hotspot_id = ${sourceHotspotId}`);
    }

    const whereSql = whereConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, ' AND ')}`
      : Prisma.empty;

    return this.prisma.$queryRaw<BetweenRoutePairCandidateRow[]>(Prisma.sql`
      SELECT DISTINCT
        bm.from_hotspot_id,
        hs.hotspot_name AS from_hotspot_name,
        hs.hotspot_location AS from_hotspot_location,
        bm.to_hotspot_id,
        hd.hotspot_name AS to_hotspot_name,
        hd.hotspot_location AS to_hotspot_location
      FROM hotspot_route_between_map bm
      JOIN dvi_hotspot_place hs
        ON hs.hotspot_ID = bm.from_hotspot_id
       AND hs.deleted = 0
      JOIN dvi_hotspot_place hd
        ON hd.hotspot_ID = bm.to_hotspot_id
       AND hd.deleted = 0
      ${whereSql}
      ORDER BY hs.hotspot_name ASC, hd.hotspot_name ASC
    `);
  }

  private async getFilterLocationRows(search: string): Promise<StoredLocationContextRow[]> {
    if (!search) {
      return this.prisma.dvi_stored_locations.findMany({
        where: { deleted: 0 },
        select: {
          location_ID: true,
          source_location: true,
          source_location_city: true,
          destination_location: true,
          destination_location_city: true,
        },
        orderBy: { location_ID: 'desc' },
      });
    }

    return this.prisma.dvi_stored_locations.findMany({
      where: {
        deleted: 0,
        OR: [
          { source_location: { contains: search } },
          { source_location_city: { contains: search } },
          { destination_location: { contains: search } },
          { destination_location_city: { contains: search } },
        ],
      },
      select: {
        location_ID: true,
        source_location: true,
        source_location_city: true,
        destination_location: true,
        destination_location_city: true,
      },
      orderBy: { location_ID: 'desc' },
    });
  }

  private mapHotspotOption(
    row: BetweenHotspotCandidateRow,
    scope: LocationScope,
  ): { hotspotId: number; hotspotName: string; locationId: number; locationName: string } {
    return {
      hotspotId: Number(row.hotspotId),
      hotspotName: String(row.hotspotName || ''),
      locationId: scope.locationId,
      locationName: scope.locationName,
    };
  }

  private matchesSearch(texts: Array<string | null | undefined>, search: string): boolean {
    if (!search) return true;

    const haystack = texts
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter(Boolean)
      .join(' ');

    return haystack.includes(search);
  }

  async getBetweenHotspotFilterOptions(q: BetweenHotspotFiltersQueryDto) {
    const locationId = Number(q.locationId || 0);
    const sourceHotspotId = Number(q.sourceHotspotId || 0);
    const onlyUsable = this.parseBooleanQuery(q.onlyUsable);
    const search = String(q.search ?? '').trim().toLowerCase();

    const pairCandidates = await this.getBetweenRoutePairCandidates(onlyUsable, sourceHotspotId || undefined);

    if (!locationId) {
      const locationRows = await this.getFilterLocationRows(search);
      const locations = locationRows
        .map((row) => this.mapLocationScope(row))
        .filter((scope) => pairCandidates.some((pair) => this.locationMatchesRoutePair(scope, pair)))
        .map((scope) => ({
          locationId: scope.locationId,
          locationName: scope.locationName,
        }))
        .sort((a, b) => a.locationName.localeCompare(b.locationName));

      return {
        locations,
        sourceHotspots: [],
        destinationHotspots: [],
      };
    }

    const locationRow = await this.getLocationContextRow(locationId);
    if (!locationRow) {
      throw new NotFoundException('Location context not found.');
    }

    const scope = this.mapLocationScope(locationRow);
    const matchingPairs = pairCandidates.filter((pair) => this.locationMatchesRoutePair(scope, pair));

    const locations = matchingPairs.length
      ? [{ locationId: scope.locationId, locationName: scope.locationName }]
      : [];

    const sourceHotspotMap = new Map<number, { hotspotId: number; hotspotName: string; locationId: number; locationName: string }>();
    for (const pair of matchingPairs) {
      const candidate: BetweenHotspotCandidateRow = {
        hotspotId: pair.from_hotspot_id,
        hotspotName: pair.from_hotspot_name,
        hotspotLocation: pair.from_hotspot_location,
      };

      if (!this.hotspotLocationMatchesKeys(candidate.hotspotLocation, scope.sourceKeys)) {
        continue;
      }

      if (!this.matchesSearch([candidate.hotspotName, candidate.hotspotLocation, scope.locationName], search)) {
        continue;
      }

      if (!sourceHotspotMap.has(candidate.hotspotId)) {
        sourceHotspotMap.set(candidate.hotspotId, this.mapHotspotOption(candidate, scope));
      }
    }

    const sourceHotspots = Array.from(sourceHotspotMap.values()).sort((a, b) => a.hotspotName.localeCompare(b.hotspotName));

    let destinationHotspots: Array<{ hotspotId: number; hotspotName: string; locationId: number; locationName: string }> = [];
    if (sourceHotspotId) {
      const destinationMap = new Map<number, { hotspotId: number; hotspotName: string; locationId: number; locationName: string }>();

      for (const pair of matchingPairs) {
        if (Number(pair.from_hotspot_id) !== sourceHotspotId) {
          continue;
        }

        const candidate: BetweenHotspotCandidateRow = {
          hotspotId: pair.to_hotspot_id,
          hotspotName: pair.to_hotspot_name,
          hotspotLocation: pair.to_hotspot_location,
        };

        if (!this.hotspotLocationMatchesKeys(candidate.hotspotLocation, scope.destinationKeys)) {
          continue;
        }

        if (!this.matchesSearch([candidate.hotspotName, candidate.hotspotLocation, scope.locationName], search)) {
          continue;
        }

        if (!destinationMap.has(candidate.hotspotId)) {
          destinationMap.set(candidate.hotspotId, this.mapHotspotOption(candidate, scope));
        }
      }

      destinationHotspots = Array.from(destinationMap.values()).sort((a, b) => a.hotspotName.localeCompare(b.hotspotName));
    }

    return {
      locations,
      sourceHotspots,
      destinationHotspots,
    };
  }

  async getBetweenHotspots(q: BetweenHotspotQueryDto) {
    const sourceHotspotId = Number(q.sourceHotspotId || 0);
    const destinationHotspotId = Number(q.destinationHotspotId || 0);
    const locationId = q.locationId ? Number(q.locationId) : 0;
    const onlyUsable = this.parseBooleanQuery(q.onlyUsable);
    const search = String(q.search ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));

    if (!sourceHotspotId || !destinationHotspotId) {
      throw new BadRequestException('sourceHotspotId and destinationHotspotId are required.');
    }

    const [sourceHotspot, destinationHotspot] = await this.prisma.$transaction([
      this.prisma.dvi_hotspot_place.findFirst({
        where: { hotspot_ID: sourceHotspotId, deleted: 0 },
        select: { hotspot_ID: true, hotspot_name: true, hotspot_location: true },
      }),
      this.prisma.dvi_hotspot_place.findFirst({
        where: { hotspot_ID: destinationHotspotId, deleted: 0 },
        select: { hotspot_ID: true, hotspot_name: true, hotspot_location: true },
      }),
    ]);

    if (!sourceHotspot || !destinationHotspot) {
      throw new NotFoundException('Source or destination hotspot not found.');
    }

    let locationContext: LocationScope | null = null;

    if (locationId) {
      const locationRow = await this.getLocationContextRow(locationId);
      if (!locationRow) {
        throw new NotFoundException('Location context not found.');
      }

      locationContext = this.mapLocationScope(locationRow);

      const sourceMatchesLocation = this.hotspotLocationMatchesKeys(
        sourceHotspot.hotspot_location,
        locationContext.sourceKeys,
      );
      const destinationMatchesLocation = this.hotspotLocationMatchesKeys(
        destinationHotspot.hotspot_location,
        locationContext.destinationKeys,
      );

      if (!sourceMatchesLocation || !destinationMatchesLocation) {
        return {
          sourceHotspot,
          destinationHotspot,
          locationContext,
          rows: [],
          total: 0,
          page,
          pageSize,
        };
      }
    }

    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`bm.from_hotspot_id = ${sourceHotspotId}`,
      Prisma.sql`bm.to_hotspot_id = ${destinationHotspotId}`,
    ];

    if (onlyUsable) {
      whereConditions.push(Prisma.sql`bm.route_fit_type IN ('ON_ROUTE', 'MINOR_DETOUR')`);
    }

    if (search) {
      const pattern = `%${search}%`;
      whereConditions.push(
        Prisma.sql`(
          LOWER(COALESCE(c.hotspot_name, '')) LIKE ${pattern}
          OR LOWER(COALESCE(c.hotspot_location, '')) LIKE ${pattern}
        )`,
      );
    }

    const whereSql = Prisma.sql`${Prisma.join(whereConditions, ' AND ')}`;

    const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS total
      FROM hotspot_route_between_map bm
      JOIN dvi_hotspot_place c ON c.hotspot_ID = bm.between_hotspot_id
      WHERE ${whereSql}
    `);

    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT
        bm.from_hotspot_id,
        bm.to_hotspot_id,
        bm.between_hotspot_id,
        c.hotspot_name AS between_hotspot_name,
        c.hotspot_location AS between_hotspot_location,
        c.hotspot_latitude AS between_hotspot_latitude,
        c.hotspot_longitude AS between_hotspot_longitude,
        bm.route_fit_type,
        bm.road_detour_km,
        bm.road_detour_ratio,
        bm.candidate_distance_from_ab_route_meters,
        bm.route_decision_reason,
        bm.updated_at
      FROM hotspot_route_between_map bm
      JOIN dvi_hotspot_place c ON c.hotspot_ID = bm.between_hotspot_id
      WHERE ${whereSql}
      ORDER BY
        FIELD(bm.route_fit_type, 'ON_ROUTE', 'MINOR_DETOUR', 'BACKTRACK', 'OFF_ROUTE'),
        bm.road_detour_km ASC,
        bm.between_hotspot_id ASC
      LIMIT ${pageSize}
      OFFSET ${(page - 1) * pageSize}
    `);

    return {
      sourceHotspot,
      destinationHotspot,
      locationContext,
      rows,
      total: Number(countRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async searchCities(query: AutosuggestQuery) {
    const phrase = String(query?.phrase ?? '').trim();
    if (!phrase) return [];

    const rows = await this.prisma.dvi_cities.findMany({
      where: {
        deleted: 0,
        name: { contains: phrase },
      },
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    const names = this.uniqueStringsCaseInsensitive(rows.map((r) => r.name));
    if (!names.length) {
      return [{ get_city: phrase }];
    }

    return names.map((name) => ({ get_city: name }));
  }

  async searchStates(query: AutosuggestQuery) {
    const phrase = String(query?.phrase ?? '').trim();
    if (!phrase) return [];

    const rows = await this.prisma.dvi_states.findMany({
      where: {
        deleted: 0,
        name: { contains: phrase },
      },
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    const names = this.uniqueStringsCaseInsensitive(rows.map((r) => r.name));
    if (!names.length) {
      return [{ get_state: phrase }];
    }

    return names.map((name) => ({ get_state: name }));
  }

  // ------ CRUD ------
  async create(payload: any) {
       const { latitude: sourceLat, longitude: sourceLng } =
      this.resolveCoordinateInput(
        payload?.source_latitude,
        payload?.source_longitude,
      );

    if (sourceLat === null) {
      throw new BadRequestException('Invalid source_latitude');
    }

    if (sourceLng === null) {
      throw new BadRequestException('Invalid source_longitude');
    }

    const newSourceSeed: SourceLocationSeed = {
      source_location: this.normalizeLocationName(payload?.source_location),
      source_location_city: this.normalizeLocationName(payload?.source_city),
      source_city_id: await this.resolveCityIdByName(payload?.source_city),
      source_location_state: this.normalizeLocationName(payload?.source_state),
      source_location_lattitude: sourceLat.toFixed(6),
      source_location_longitude: sourceLng.toFixed(6),
    };

    const itineraryDistanceLimit = await this.getItineraryDistanceLimit();
    const existingSources = await this.getDistinctExistingSourceLocations();
   const citySeed =
  newSourceSeed.source_location_city &&
  newSourceSeed.source_location_city.toLowerCase() !==
    newSourceSeed.source_location.toLowerCase()
      ? {
          source_location: newSourceSeed.source_location_city,
          source_location_city: newSourceSeed.source_location_city,
          source_city_id: newSourceSeed.source_city_id ?? null,
          source_location_state: newSourceSeed.source_location_state,
          source_location_lattitude: newSourceSeed.source_location_lattitude,
          source_location_longitude: newSourceSeed.source_location_longitude,
      }
    : null;

    const result = await this.createReplicatedLocationRows(
  newSourceSeed,
  existingSources,
  itineraryDistanceLimit,
  payload?.location_description,
);

if (citySeed) {
  await this.createReplicatedLocationRows(
    citySeed,
    [newSourceSeed, ...existingSources],
    itineraryDistanceLimit,
    payload?.location_description,
  );
}
    if (result.createdRows.length === 1) {
      return this.mapRowToResponse(result.createdRows[0]);
    }

    return {
      createdCount: result.createdRows.length,
      skippedCount: result.skippedCount,
      rows: result.createdRows.map((r) => this.mapRowToResponse(r)),
    };
  }

  async get(id: number) {
    const row = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(id), deleted: 0 },
    });
    if (!row) throw new NotFoundException('Location not found');
    return this.mapRowToResponse(row);
  }

  async update(id: number, payload: any) {
    const existing = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(id), deleted: 0 },
    });

    if (!existing) throw new NotFoundException('Location not found');

    const normalizeIdentityValue = (value: unknown) =>
      this.normalizeLocationName(value).toLowerCase();
    const immutableIdentityFields: Array<{
      keys: string[];
      existingValue: unknown;
      label: string;
    }> = [
      {
        keys: ['source_location'],
        existingValue: existing.source_location,
        label: 'source location',
      },
      {
        keys: ['source_city', 'source_location_city'],
        existingValue: existing.source_location_city,
        label: 'source city',
      },
      {
        keys: ['source_state', 'source_location_state'],
        existingValue: existing.source_location_state,
        label: 'source state',
      },
      {
        keys: ['destination_location'],
        existingValue: existing.destination_location,
        label: 'destination location',
      },
      {
        keys: ['destination_city', 'destination_location_city'],
        existingValue: existing.destination_location_city,
        label: 'destination city',
      },
      {
        keys: ['destination_state', 'destination_location_state'],
        existingValue: existing.destination_location_state,
        label: 'destination state',
      },
    ];

    for (const field of immutableIdentityFields) {
      const providedKey = field.keys.find((key) => payload?.[key] !== undefined);
      if (
        providedKey &&
        normalizeIdentityValue(payload[providedKey]) !==
          normalizeIdentityValue(field.existingValue)
      ) {
        throw new BadRequestException(
          `The ${field.label} cannot be changed while editing a route`,
        );
      }
    }

    const nextSource = this.normalizeLocationName(
      payload?.source_location ?? existing.source_location,
    );
    const nextDestination = this.normalizeLocationName(
      payload?.destination_location ?? existing.destination_location,
    );
    const nextDistance =
      payload?.distance_km !== undefined
        ? Number(payload.distance_km)
        : payload?.distance !== undefined
          ? Number(payload.distance)
          : Number(existing.distance ?? 0);

    const distanceProvided =
      payload?.distance_km !== undefined || payload?.distance !== undefined;
    const durationProvided =
      payload?.duration_text !== undefined || payload?.duration !== undefined;

    if (distanceProvided && (!Number.isFinite(nextDistance) || nextDistance < 0)) {
      throw new BadRequestException('Distance must be a valid non-negative number');
    }

    if (
      nextSource &&
      nextDestination &&
      nextSource.toLowerCase() === nextDestination.toLowerCase() &&
      (!Number.isFinite(nextDistance) || nextDistance < 10)
    ) {
      throw new BadRequestException(
        'When source and destination are the same, minimum distance is 10 km',
      );
    }

    const data = this.mapDtoToSchema(payload);
    if (payload?.source_city !== undefined || payload?.source_location_city !== undefined) {
      data.source_city_id = await this.resolveCityIdByName(
        payload?.source_city ?? payload?.source_location_city,
      );
    }
    if (
      payload?.destination_city !== undefined ||
      payload?.destination_location_city !== undefined
    ) {
      data.destination_city_id = await this.resolveCityIdByName(
        payload?.destination_city ?? payload?.destination_location_city,
      );
    }

    // A route distance is symmetric in the stored-location master. Keep the
    // manually edited row and its reverse row in sync in one transaction.
    const nextDuration = durationProvided
      ? String(payload?.duration_text ?? payload?.duration ?? '').trim()
      : distanceProvided
        ? this.estimateDurationText(nextDistance)
        : String(existing.duration ?? '');

    if (distanceProvided) data.distance = nextDistance;
    if (distanceProvided || durationProvided) data.duration = nextDuration;

    const nextSourceName = String(data.source_location ?? nextSource).trim();
    const nextDestinationName = String(data.destination_location ?? nextDestination).trim();
    const shouldSyncReverse =
      (distanceProvided || durationProvided) &&
      nextSourceName.toLowerCase() !== nextDestinationName.toLowerCase();

    let updated: any;
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();

      updated = await tx.dvi_stored_locations.update({
        where: { location_ID: BigInt(id) },
        data: { ...data, updatedon: now },
      });

      if (!shouldSyncReverse) return;

      const reverseWhere = {
        deleted: 0,
        source_location: nextDestinationName,
        destination_location: nextSourceName,
      };

      const reverseUpdate: any = {
        distance: nextDistance,
        updatedon: now,
      };
      if (distanceProvided || durationProvided) reverseUpdate.duration = nextDuration;

      const reverseResult = await tx.dvi_stored_locations.updateMany({
        where: reverseWhere,
        data: reverseUpdate,
      });

      if (reverseResult.count > 0) return;

      const reverseData = {
        source_location: nextDestinationName,
        source_location_lattitude:
          data.destination_location_lattitude ?? existing.destination_location_lattitude,
        source_location_longitude:
          data.destination_location_longitude ?? existing.destination_location_longitude,
        source_location_city:
          data.destination_location_city ?? existing.destination_location_city,
        source_city_id:
          data.destination_city_id !== undefined
            ? data.destination_city_id
            : existing.destination_city_id,
        source_location_state:
          data.destination_location_state ?? existing.destination_location_state,
        destination_location: nextSourceName,
        destination_location_lattitude:
          data.source_location_lattitude ?? existing.source_location_lattitude,
        destination_location_longitude:
          data.source_location_longitude ?? existing.source_location_longitude,
        destination_location_city:
          data.source_location_city ?? existing.source_location_city,
        destination_city_id:
          data.source_city_id !== undefined
            ? data.source_city_id
            : existing.source_city_id,
        destination_location_state:
          data.source_location_state ?? existing.source_location_state,
        distance: nextDistance,
        duration: nextDuration,
        location_description:
          data.location_description !== undefined
            ? data.location_description
            : existing.location_description,
        created_from: existing.created_from ?? 0,
        createdby: existing.createdby ?? 0,
        createdon: now,
        updatedon: now,
        status: existing.status ?? 1,
        deleted: 0,
      };

      await tx.dvi_stored_locations.create({ data: reverseData });
    });

    this.clearStoredLocationCache(`locations.update:${id}`);
    clearDistanceCache();
    return this.mapRowToResponse(updated);
  }



  private mapDtoToSchema(dto: any) {
  const mapped: any = {};

  const sourceLocation = dto.source_location;
  const sourceCity = dto.source_city ?? dto.source_location_city;
  const sourceState = dto.source_state ?? dto.source_location_state;
  const sourceLatitude =
    dto.source_latitude ??
    dto.source_location_latitude ??
    dto.source_location_lattitude;
  const sourceLongitude =
    dto.source_longitude ??
    dto.source_location_longitude;

  const destinationLocation = dto.destination_location;
  const destinationCity = dto.destination_city ?? dto.destination_location_city;
  const destinationState = dto.destination_state ?? dto.destination_location_state;
  const destinationLatitude =
    dto.destination_latitude ??
    dto.destination_location_latitude ??
    dto.destination_location_lattitude;
  const destinationLongitude =
    dto.destination_longitude ??
    dto.destination_location_longitude;

  if (sourceLocation !== undefined) {
    mapped.source_location = this.normalizeLocationName(sourceLocation);
  }

  if (sourceCity !== undefined) {
    mapped.source_location_city = this.normalizeLocationName(sourceCity);
    mapped.source_city_id = undefined;
  }

  if (sourceState !== undefined) {
    mapped.source_location_state = this.normalizeLocationName(sourceState);
  }

  if (sourceLatitude !== undefined || sourceLongitude !== undefined) {
    const { latitude, longitude } = this.resolveCoordinateInput(
      sourceLatitude,
      sourceLongitude,
    );

    if (latitude !== null) {
      mapped.source_location_lattitude = latitude.toFixed(6);
    }

    if (longitude !== null) {
      mapped.source_location_longitude = longitude.toFixed(6);
    }
  }

  if (destinationLocation !== undefined) {
    mapped.destination_location = this.normalizeLocationName(destinationLocation);
  }

  if (destinationCity !== undefined) {
    mapped.destination_location_city = this.normalizeLocationName(destinationCity);
    mapped.destination_city_id = undefined;
  }

  if (destinationState !== undefined) {
    mapped.destination_location_state = this.normalizeLocationName(destinationState);
  }

  if (destinationLatitude !== undefined || destinationLongitude !== undefined) {
    const { latitude, longitude } = this.resolveCoordinateInput(
      destinationLatitude,
      destinationLongitude,
    );

    if (latitude !== null) {
      mapped.destination_location_lattitude = latitude.toFixed(6);
    }

    if (longitude !== null) {
      mapped.destination_location_longitude = longitude.toFixed(6);
    }
  }

  if (dto.distance_km !== undefined || dto.distance !== undefined) {
    mapped.distance = Number(dto.distance_km ?? dto.distance);
  }

  if (dto.duration_text !== undefined || dto.duration !== undefined) {
    mapped.duration = String(dto.duration_text ?? dto.duration ?? '').trim();
  }

  if (dto.location_description !== undefined) {
    mapped.location_description = dto.location_description;
  }

  return mapped;
}

private parseCoordinatePair(value: unknown): { latitude: number; longitude: number } | null {
  return this.geoPolicy.parseCoordinatePair(value);
}

private resolveCoordinateInput(
  latitudeValue: unknown,
  longitudeValue: unknown,
): { latitude: number | null; longitude: number | null } {
  return this.geoPolicy.resolveCoordinateInput(latitudeValue, longitudeValue);
}

private toCoordinate(value: unknown): number | null {
  return this.geoPolicy.toCoordinate(value);
}

private normalizeLocationName(value: unknown): string {
  return this.geoPolicy.normalizeLocationName(value);
}

private uniqueStringsCaseInsensitive(values: Array<string | null | undefined>): string[] {
  return this.geoPolicy.uniqueStringsCaseInsensitive(values);
}

private estimateDurationText(distanceKm: number): string {
  return this.geoPolicy.estimateDurationText(distanceKm);
}

private async getItineraryDistanceLimit(): Promise<number> {
  const settings = await this.prisma.dvi_global_settings.findFirst({
    where: { deleted: 0 },
    orderBy: { global_settings_ID: 'asc' },
    select: { itinerary_distance_limit: true },
  });

  const limit = Number(settings?.itinerary_distance_limit ?? 0);
  return Number.isFinite(limit) && limit >= 0 ? limit : 0;
}

private async getDistinctExistingSourceLocations(): Promise<SourceLocationSeed[]> {
  // PHP replication candidates come only from existing SOURCE-side values, not destination rows.
  const rows = await this.prisma.dvi_stored_locations.findMany({
    where: {
      deleted: 0,
    },
    select: {
      source_location: true,
      source_location_city: true,
      source_city_id: true,
      source_location_state: true,
      source_location_lattitude: true,
      source_location_longitude: true,
    },
    orderBy: { source_location: 'asc' },
  });

  const dedupMap = new Map<string, SourceLocationSeed>();

  for (const row of rows) {
    const seed: SourceLocationSeed = {
      source_location: this.normalizeLocationName(row.source_location),
      source_location_city: this.normalizeLocationName(row.source_location_city),
      source_city_id:
        row.source_city_id !== null && row.source_city_id !== undefined
          ? Number(row.source_city_id)
          : null,
      source_location_state: this.normalizeLocationName(row.source_location_state),
      source_location_lattitude: this.normalizeLocationName(row.source_location_lattitude),
      source_location_longitude: this.normalizeLocationName(row.source_location_longitude),
    };

    const key = [
      seed.source_location,
      seed.source_location_lattitude,
      seed.source_location_longitude,
      seed.source_location_city,
      seed.source_location_state,
    ].join('||');

    if (!dedupMap.has(key)) {
      dedupMap.set(key, seed);
    }
  }

  return Array.from(dedupMap.values());
}

private isCityLevelSeed(seed: SourceLocationSeed): boolean {
  const location = this.normalizeLocationName(seed.source_location).toLowerCase();
  const city = this.normalizeLocationName(seed.source_location_city).toLowerCase();

  return Boolean(location && city && location === city);
}

private async findSeedByLocationOrCityName(
  name: string,
): Promise<SourceLocationSeed | null> {
  const normalizedName = this.normalizeLocationName(name);
  if (!normalizedName) return null;

  const rows = await this.prisma.dvi_stored_locations.findMany({
    where: {
      deleted: 0,
      OR: [
        { source_location: normalizedName },
        { destination_location: normalizedName },
        { source_location_city: normalizedName },
        { destination_location_city: normalizedName },
      ],
    },
    select: {
      source_location: true,
      source_location_city: true,
      source_city_id: true,
      source_location_state: true,
      source_location_lattitude: true,
      source_location_longitude: true,
      destination_location: true,
      destination_location_city: true,
      destination_city_id: true,
      destination_location_state: true,
      destination_location_lattitude: true,
      destination_location_longitude: true,
    },
    take: 50,
  });

  for (const row of rows) {
    if (
      this.normalizeLocationName(row.source_location).toLowerCase() ===
      normalizedName.toLowerCase()
    ) {
      return {
        source_location: normalizedName,
        source_location_city: this.normalizeLocationName(row.source_location_city),
        source_city_id:
          row.source_city_id !== null && row.source_city_id !== undefined
            ? Number(row.source_city_id)
            : null,
        source_location_state: this.normalizeLocationName(row.source_location_state),
        source_location_lattitude: this.normalizeLocationName(row.source_location_lattitude),
        source_location_longitude: this.normalizeLocationName(row.source_location_longitude),
      };
    }

    if (
      this.normalizeLocationName(row.destination_location).toLowerCase() ===
      normalizedName.toLowerCase()
    ) {
      return {
        source_location: normalizedName,
        source_location_city: this.normalizeLocationName(row.destination_location_city),
        source_city_id:
          row.destination_city_id !== null && row.destination_city_id !== undefined
            ? Number(row.destination_city_id)
            : null,
        source_location_state: this.normalizeLocationName(row.destination_location_state),
        source_location_lattitude: this.normalizeLocationName(row.destination_location_lattitude),
        source_location_longitude: this.normalizeLocationName(row.destination_location_longitude),
      };
    }
  }

  for (const row of rows) {
    if (
      this.normalizeLocationName(row.source_location_city).toLowerCase() ===
      normalizedName.toLowerCase()
    ) {
      return {
        source_location: normalizedName,
        source_location_city: normalizedName,
        source_city_id:
          row.source_city_id !== null && row.source_city_id !== undefined
            ? Number(row.source_city_id)
            : null,
        source_location_state: this.normalizeLocationName(row.source_location_state),
        source_location_lattitude: this.normalizeLocationName(row.source_location_lattitude),
        source_location_longitude: this.normalizeLocationName(row.source_location_longitude),
      };
    }

    if (
      this.normalizeLocationName(row.destination_location_city).toLowerCase() ===
      normalizedName.toLowerCase()
    ) {
      return {
        source_location: normalizedName,
        source_location_city: normalizedName,
        source_city_id:
          row.destination_city_id !== null &&
          row.destination_city_id !== undefined
            ? Number(row.destination_city_id)
            : null,
        source_location_state: this.normalizeLocationName(row.destination_location_state),
        source_location_lattitude: this.normalizeLocationName(row.destination_location_lattitude),
        source_location_longitude: this.normalizeLocationName(row.destination_location_longitude),
      };
    }
  }

  return null;
}

private async ensureExactLocationRouteExists(
  sourceName: string,
  destinationName: string,
): Promise<void> {
  const source = this.normalizeLocationName(sourceName);
  const destination = this.normalizeLocationName(destinationName);

  if (!source || !destination) return;

  const existing = await this.prisma.dvi_stored_locations.findFirst({
  where: {
    deleted: 0,
    source_location: source,
    destination_location: destination,
  },
  select: {
    location_ID: true,
    distance: true,
  },
});

const isSameLocation = source.toLowerCase() === destination.toLowerCase();
const SELF_ROUTE_MIN_DISTANCE_KM = 10;

  if (existing) {
  const existingDistance = Number(existing.distance || 0);

  if (isSameLocation && existingDistance < SELF_ROUTE_MIN_DISTANCE_KM) {
    await this.prisma.dvi_stored_locations.update({
      where: { location_ID: existing.location_ID },
      data: {
        distance: SELF_ROUTE_MIN_DISTANCE_KM,
        duration: this.estimateDurationText(SELF_ROUTE_MIN_DISTANCE_KM),
        updatedon: new Date(),
      },
    });
    this.clearStoredLocationCache(`locations.ensureExactLocationRouteExists:update:${source}->${destination}`);
  }

  return;
}

  const sourceSeed = await this.findSeedByLocationOrCityName(source);
  const destinationSeed = await this.findSeedByLocationOrCityName(destination);

  if (!sourceSeed || !destinationSeed) return;

  const sourceLat = this.toCoordinate(sourceSeed.source_location_lattitude);
  const sourceLng = this.toCoordinate(sourceSeed.source_location_longitude);
  const destinationLat = this.toCoordinate(destinationSeed.source_location_lattitude);
  const destinationLng = this.toCoordinate(destinationSeed.source_location_longitude);

  if (
    sourceLat === null ||
    sourceLng === null ||
    destinationLat === null ||
    destinationLng === null
  ) {
    return;
  }

  //const isSameLocation = source.toLowerCase() === destination.toLowerCase();

  const distanceKm = isSameLocation
    ? 10
    : this.calculateDistanceKm(
        sourceLat,
        sourceLng,
        destinationLat,
        destinationLng,
      );

  await this.prisma.dvi_stored_locations.create({
    data: this.buildLocationRowData(sourceSeed, destinationSeed, distanceKm),
  });
  this.clearStoredLocationCache(`locations.ensureExactLocationRouteExists:create:${source}->${destination}`);
}

private async forwardRouteExists(
  tx: any,
  source: SourceLocationSeed,
  destination: SourceLocationSeed,
): Promise<boolean> {
  const existing = await tx.dvi_stored_locations.findFirst({
    where: {
      deleted: 0,
      source_location: source.source_location,
      destination_location: destination.source_location,
    },
    select: { location_ID: true },
  });

  return Boolean(existing);
}

private async reverseRouteExists(
  tx: any,
  source: SourceLocationSeed,
  destination: SourceLocationSeed,
): Promise<boolean> {
  const existing = await tx.dvi_stored_locations.findFirst({
    where: {
      deleted: 0,
      OR: [
        {
          source_location: destination.source_location,
          destination_location: source.source_location,
        },
        {
          source_location_lattitude: destination.source_location_lattitude,
          source_location_longitude: destination.source_location_longitude,
          destination_location_lattitude: source.source_location_lattitude,
          destination_location_longitude: source.source_location_longitude,
        },
      ],
    },
    select: { location_ID: true },
  });

  return Boolean(existing);
}

private buildLocationRowData(
  source: SourceLocationSeed,
  destination: SourceLocationSeed,
  distanceKm: number,
  locationDescription?: string | null,
) {
  return {
    source_location: source.source_location,
    source_location_lattitude: source.source_location_lattitude,
    source_location_longitude: source.source_location_longitude,
    source_location_city: source.source_location_city,
    source_city_id: source.source_city_id ?? null,
    source_location_state: source.source_location_state,
    destination_location: destination.source_location,
    destination_location_lattitude: destination.source_location_lattitude,
    destination_location_longitude: destination.source_location_longitude,
    destination_location_city: destination.source_location_city,
    destination_city_id: destination.source_city_id ?? null,
    destination_location_state: destination.source_location_state,
    distance: Number(distanceKm.toFixed(6)),
    duration: this.estimateDurationText(distanceKm),
    location_description:
      locationDescription === undefined ? null : locationDescription,
    status: 1,
    deleted: 0,
    createdon: new Date(),
  };
}

private async createReplicatedLocationRows(
  newSource: SourceLocationSeed,
  candidates: SourceLocationSeed[],
  itineraryDistanceLimit: number,
  locationDescription?: string | null,
) {
  const locationNames = Array.from(
    new Set([
      newSource.source_location,
      ...candidates.map((c) => c.source_location),
    ]),
  );

  const existingRoutes = await this.prisma.dvi_stored_locations.findMany({
    where: {
      deleted: 0,
      OR: [
        { source_location: { in: locationNames } },
        { destination_location: { in: locationNames } },
      ],
    },
    select: {
      source_location: true,
      destination_location: true,
      source_location_lattitude: true,
      source_location_longitude: true,
      destination_location_lattitude: true,
      destination_location_longitude: true,
    },
  });

  const pairKey = (s: string, d: string) => `${s}||${d}`;
  const coordKey = (slat: string, slng: string, dlat: string, dlng: string) =>
    `${slat}||${slng}||${dlat}||${dlng}`;

  const existingNamePairs = new Set<string>();
  const existingCoordPairs = new Set<string>();

  for (const row of existingRoutes) {
    existingNamePairs.add(pairKey(row.source_location, row.destination_location));
    existingCoordPairs.add(
      coordKey(
        row.source_location_lattitude,
        row.source_location_longitude,
        row.destination_location_lattitude,
        row.destination_location_longitude,
      ),
    );
  }

  const rowsToInsert: any[] = [];
  let skippedCount = 0;

  for (const candidate of candidates) {
    const candidateLat = this.toCoordinate(candidate.source_location_lattitude);
    const candidateLng = this.toCoordinate(candidate.source_location_longitude);
    const sourceLat = this.toCoordinate(newSource.source_location_lattitude);
    const sourceLng = this.toCoordinate(newSource.source_location_longitude);

    if (
      candidateLat === null ||
      candidateLng === null ||
      sourceLat === null ||
      sourceLng === null
    ) {
      skippedCount += 1;
      continue;
    }

    const distanceKm = this.calculateDistanceKm(
      sourceLat,
      sourceLng,
      candidateLat,
      candidateLng,
    );

    if (distanceKm > itineraryDistanceLimit) {
      skippedCount += 1;
      continue;
    }

    const isSelfRoute =
      newSource.source_location.toLowerCase() ===
      candidate.source_location.toLowerCase();

    if (isSelfRoute) {
      // Self-route is created unconditionally below with the minimum 10 km distance.
      continue;
    }

    const forwardNameKey = pairKey(newSource.source_location, candidate.source_location);
    const forwardCoordKey = coordKey(
      newSource.source_location_lattitude,
      newSource.source_location_longitude,
      candidate.source_location_lattitude,
      candidate.source_location_longitude,
    );

    if (!existingNamePairs.has(forwardNameKey)) {
      rowsToInsert.push(
        this.buildLocationRowData(
          newSource,
          candidate,
          distanceKm,
          locationDescription,
        ),
      );
      existingNamePairs.add(forwardNameKey);
      existingCoordPairs.add(forwardCoordKey);
    } else {
      skippedCount += 1;
    }

    const reverseNameKey = pairKey(candidate.source_location, newSource.source_location);
    const reverseCoordKey = coordKey(
      candidate.source_location_lattitude,
      candidate.source_location_longitude,
      newSource.source_location_lattitude,
      newSource.source_location_longitude,
    );

    if (
      !existingNamePairs.has(reverseNameKey) &&
      !existingCoordPairs.has(reverseCoordKey)
    ) {
      rowsToInsert.push(
        this.buildLocationRowData(
          candidate,
          newSource,
          distanceKm,
          locationDescription,
        ),
      );
      existingNamePairs.add(reverseNameKey);
      existingCoordPairs.add(reverseCoordKey);
    } else {
      skippedCount += 1;
    }
  }

  // Always create the self-route (A → A) with the minimum required distance of 10 km,
  // unless one already exists in the database.
  const SELF_ROUTE_MIN_DISTANCE_KM = 10;
  const selfNameKey = pairKey(newSource.source_location, newSource.source_location);
  if (!existingNamePairs.has(selfNameKey)) {
    rowsToInsert.push(
      this.buildLocationRowData(newSource, newSource, SELF_ROUTE_MIN_DISTANCE_KM, locationDescription),
    );
  }

  return this.prisma.$transaction(async (tx) => {
    const createdRows: any[] = [];
    for (const rowData of rowsToInsert) {
      const created = await tx.dvi_stored_locations.create({ data: rowData });
      createdRows.push(created);
    }
    return { createdRows, skippedCount };
  }, {
    maxWait: 5000,
    timeout: 60000,
  }).then((result) => {
    if (result.createdRows.length > 0) {
      this.clearStoredLocationCache(
        `locations.createReplicatedLocationRows:${newSource.source_location}:${result.createdRows.length}`,
      );
    }
    return result;
  });
}

private calculateDistanceKm(
  sourceLat: number,
  sourceLng: number,
  destLat: number,
  destLng: number,
): number {
  return this.geoPolicy.calculateDistanceKm(sourceLat, sourceLng, destLat, destLng);
}

async deleteLocationName(location: string) {
  const name = String(location || '').trim();

  if (!name) {
    throw new BadRequestException('Location is required');
  }

  const result = await this.prisma.dvi_stored_locations.updateMany({
    where: {
      deleted: 0,
      OR: [
        { source_location: name },
        { destination_location: name },
      ],
    },
    data: {
      deleted: 1,
      updatedon: new Date(),
    },
  });

  if (!result.count) {
    throw new NotFoundException('Location not found');
  }

  this.clearStoredLocationCache(`locations.deleteLocationName:${name}`);

  return {
    ok: true,
    deletedLocation: name,
    deletedCount: result.count,
  };
}

async updateLocationName(
  oldNameInput: string,
  newNameInput: string,
  scope: 'source' | 'destination' | 'both' = 'both',
) {
  const oldName = this.normalizeLocationName(oldNameInput);
  const newName = this.normalizeLocationName(newNameInput);

  if (!oldName) {
    throw new BadRequestException('Old location name is required');
  }

  if (!newName) {
    throw new BadRequestException('New location name is required');
  }

  if (oldName.toLowerCase() === newName.toLowerCase()) {
    throw new BadRequestException('Old and new location names cannot be the same');
  }

  const where =
    scope === 'source'
      ? { deleted: 0, source_location: oldName }
      : scope === 'destination'
        ? { deleted: 0, destination_location: oldName }
        : {
            deleted: 0,
            OR: [
              { source_location: oldName },
              { destination_location: oldName },
            ],
          };

  const data =
    scope === 'source'
      ? { source_location: newName, updatedon: new Date() }
      : scope === 'destination'
        ? { destination_location: newName, updatedon: new Date() }
        : undefined;

  let result: { count: number };

  if (scope === 'both') {
    const [sourceResult, destinationResult] = await this.prisma.$transaction([
      this.prisma.dvi_stored_locations.updateMany({
        where: {
          deleted: 0,
          source_location: oldName,
        },
        data: {
          source_location: newName,
          updatedon: new Date(),
        },
      }),
      this.prisma.dvi_stored_locations.updateMany({
        where: {
          deleted: 0,
          destination_location: oldName,
        },
        data: {
          destination_location: newName,
          updatedon: new Date(),
        },
      }),
    ]);

    result = {
      count: sourceResult.count + destinationResult.count,
    };
  } else {
    result = await this.prisma.dvi_stored_locations.updateMany({
      where,
      data,
    });
  }

  if (!result.count) {
    throw new NotFoundException('Location name not found');
  }

  this.clearStoredLocationCache(`locations.updateLocationName:${oldName}->${newName}:${scope}`);

  return {
    ok: true,
    oldName,
    newName,
    scope,
    updatedCount: result.count,
  };
}

    async softDelete(id: number) {
    const row = await this.get(id);

    await this.prisma.dvi_stored_locations.update({
      where: { location_ID: BigInt(id) },
      data: { deleted: 1, updatedon: new Date() },
    });
    this.clearStoredLocationCache(`locations.softDelete:${id}`);

    return {
      ok: true,
      row,
    };
  }

  async restore(id: number) {
    const row = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(id) },
    });

    if (!row) {
      throw new NotFoundException('Location not found');
    }

    const restored = await this.prisma.dvi_stored_locations.update({
      where: { location_ID: BigInt(id) },
      data: { deleted: 0, updatedon: new Date() },
    });
    this.clearStoredLocationCache(`locations.restore:${id}`);

    return {
      ok: true,
      row: this.mapRowToResponse(restored),
    };
  }

       async lookupViaRoutePlace(locationId: number, phrase: string) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

    const normalizedPhrase = this.normalizeLocationName(phrase);
    if (!normalizedPhrase) {
      throw new BadRequestException('place is required');
    }

    const rows = await this.prisma.dvi_stored_locations.findMany({
  where: {
    deleted: 0,
    OR: [
      { source_location: { equals: normalizedPhrase } },
      { destination_location: { equals: normalizedPhrase } },
    ],
  },
  select: {
    source_location: true,
    source_location_city: true,
    source_location_state: true,
    source_location_lattitude: true,
    source_location_longitude: true,
    destination_location: true,
    destination_location_city: true,
    destination_location_state: true,
    destination_location_lattitude: true,
    destination_location_longitude: true,
  },
  take: 20,
});

    const exactMatches: Array<{
  via_route_location: string;
  via_route_location_city: string;
  via_route_location_state: string;
  via_route_location_lattitude: string;
  via_route_location_longitude: string;
}> = [];

const collectMatch = (
  placeValue: unknown,
  cityValue: unknown,
  stateValue: unknown,
  latitudeValue: unknown,
  longitudeValue: unknown,
) => {
  const placeName = this.normalizeLocationName(placeValue);
  if (!placeName) return;

  if (placeName.toLowerCase() !== normalizedPhrase.toLowerCase()) {
    return;
  }

  exactMatches.push({
    via_route_location: placeName,
    via_route_location_city: this.normalizeLocationName(cityValue),
    via_route_location_state: this.normalizeLocationName(stateValue),
    via_route_location_lattitude: this.normalizeLocationName(latitudeValue),
    via_route_location_longitude: this.normalizeLocationName(longitudeValue),
  });
};

    for (const row of rows) {
      collectMatch(
        row.source_location,
        row.source_location_city,
        row.source_location_state,
        row.source_location_lattitude,
        row.source_location_longitude,
      );
      collectMatch(
        row.destination_location,
        row.destination_location_city,
        row.destination_location_state,
        row.destination_location_lattitude,
        row.destination_location_longitude,
      );
    }

    const match = exactMatches[0] ?? null;

    if (!match) {
      return { found: false, data: null };
    }

    const srcLat = this.toCoordinate(location.source_location_lattitude);
    const srcLng = this.toCoordinate(location.source_location_longitude);
    const viaLat = this.toCoordinate(match.via_route_location_lattitude);
    const viaLng = this.toCoordinate(match.via_route_location_longitude);

    let distanceText = '';
    let durationText = '';

    if (srcLat !== null && srcLng !== null && viaLat !== null && viaLng !== null) {
      const distanceKm = this.calculateDistanceKm(srcLat, srcLng, viaLat, viaLng);
      distanceText = String(Number(distanceKm.toFixed(6)));
      durationText = this.estimateDurationText(distanceKm);
    }

    return {
      found: true,
      data: {
        ...match,
        distance_from_source_location: distanceText,
        duration_from_source_location: durationText,
      },
    };
  }

  async getViaRoutes(locationId: number) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

const rows = await this.prisma.$queryRawUnsafe<any[]>(
  `
  SELECT
    via_route_location_ID,
    location_id,
    via_route_location,
    via_route_location_lattitude,
    via_route_location_longitude,
    via_route_location_city,
    via_route_location_state,
    distance_from_source_to_via_route,
    duration_from_source_to_via_route
  FROM dvi_stored_location_via_routes
  WHERE location_id = ? AND deleted = 0
  ORDER BY via_route_location_ID DESC
  `,
  locationId,
);
    return {
      data: rows.map((row, index) => ({
        count: String(index + 1),
        via_route_location_ID: Number(row.via_route_location_ID),
        location_id: Number(row.location_id),
        via_route_location: String(row.via_route_location ?? ''),
        via_route_location_lattitude: String(row.via_route_location_lattitude ?? ''),
        via_route_location_longitude: String(row.via_route_location_longitude ?? ''),
        via_route_location_city: String(row.via_route_location_city ?? ''),
        via_route_location_state: String(row.via_route_location_state ?? ''),
        distance_from_source_to_via_route: String(row.distance_from_source_to_via_route ?? ''),
        duration_from_source_to_via_route: String(row.duration_from_source_to_via_route ?? ''),
        modify: String(row.via_route_location_ID ?? ''),
      })),
    };
  }

    async addViaRoute(
    locationId: number,
    payload: {
      via_route_location: string;
      via_route_location_lattitude?: string;
      via_route_location_longitude?: string;
      via_route_location_city?: string;
      via_route_location_state?: string;
      distance_from_source_location?: string;
      duration_from_source_location?: string;
    },
  ) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

    const viaRouteLocation = String(payload?.via_route_location ?? '').trim();
    if (!viaRouteLocation) {
      throw new BadRequestException('via_route_location is required');
    }

    const existing = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT via_route_location_ID
      FROM dvi_stored_location_via_routes
      WHERE location_id = ? AND via_route_location = ? AND deleted = 0
      LIMIT 1
      `,
      locationId,
      viaRouteLocation,
    );

    if (existing.length) {
      return {
        ok: true,
        ...(await this.getViaRoutes(locationId)),
      };
    }

    const viaCity = String(payload?.via_route_location_city ?? '').trim();
    const viaState = String(payload?.via_route_location_state ?? '').trim();

    const { latitude: viaLat, longitude: viaLng } = this.resolveCoordinateInput(
      payload?.via_route_location_lattitude,
      payload?.via_route_location_longitude,
    );

    const srcLat = this.toCoordinate(location.source_location_lattitude);
    const srcLng = this.toCoordinate(location.source_location_longitude);

        let distanceText = String(payload?.distance_from_source_location ?? '').trim();
    let durationText = String(payload?.duration_from_source_location ?? '').trim();

    if (
      !distanceText &&
      !durationText &&
      viaLat !== null &&
      viaLng !== null &&
      srcLat !== null &&
      srcLng !== null
    ) {
      const distanceKm = this.calculateDistanceKm(srcLat, srcLng, viaLat, viaLng);
      distanceText = String(Number(distanceKm.toFixed(6)));
      durationText = this.estimateDurationText(distanceKm);
    }

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO dvi_stored_location_via_routes (
        location_id,
        via_route_location,
        via_route_location_lattitude,
        via_route_location_longitude,
        via_route_location_city,
        via_route_location_state,
        distance_from_source_to_via_route,
        duration_from_source_to_via_route,
        status,
        deleted,
        createdon
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NOW())
      `,
      locationId,
      viaRouteLocation,
      viaLat !== null ? viaLat.toFixed(6) : '',
      viaLng !== null ? viaLng.toFixed(6) : '',
      viaCity,
      viaState,
      distanceText,
      durationText,
    );

    return {
      ok: true,
      ...(await this.getViaRoutes(locationId)),
    };
  }

    async updateViaRoute(
    locationId: number,
    viaRouteId: number,
        payload: {
      via_route_location?: string;
      via_route_location_lattitude?: string;
      via_route_location_longitude?: string;
      via_route_location_city?: string;
      via_route_location_state?: string;
      distance_from_source_location?: string;
      duration_from_source_location?: string;
    },
  ) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

    const existingViaRoute = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT via_route_location_ID
      FROM dvi_stored_location_via_routes
      WHERE via_route_location_ID = ? AND location_id = ? AND deleted = 0
      LIMIT 1
      `,
      viaRouteId,
      locationId,
    );

    if (!existingViaRoute.length) {
      throw new NotFoundException('Via route not found');
    }

    const viaRouteLocation = String(payload?.via_route_location ?? '').trim();
    if (!viaRouteLocation) {
      throw new BadRequestException('via_route_location is required');
    }

    const viaCity = String(payload?.via_route_location_city ?? '').trim();
    const viaState = String(payload?.via_route_location_state ?? '').trim();

    const { latitude: viaLat, longitude: viaLng } = this.resolveCoordinateInput(
      payload?.via_route_location_lattitude,
      payload?.via_route_location_longitude,
    );

    const srcLat = this.toCoordinate(location.source_location_lattitude);
    const srcLng = this.toCoordinate(location.source_location_longitude);

    let distanceText = '';
    let durationText = '';

    if (
      viaLat !== null &&
      viaLng !== null &&
      srcLat !== null &&
      srcLng !== null
    ) {
      const distanceKm = this.calculateDistanceKm(srcLat, srcLng, viaLat, viaLng);
      distanceText = String(Number(distanceKm.toFixed(6)));
      durationText = this.estimateDurationText(distanceKm);
    }

    await this.prisma.$executeRawUnsafe(
      `
      UPDATE dvi_stored_location_via_routes
      SET
        via_route_location = ?,
        via_route_location_lattitude = ?,
        via_route_location_longitude = ?,
        via_route_location_city = ?,
        via_route_location_state = ?,
        distance_from_source_to_via_route = ?,
        duration_from_source_to_via_route = ?,
        updatedon = NOW()
      WHERE via_route_location_ID = ? AND location_id = ? AND deleted = 0
      `,
      viaRouteLocation,
      viaLat !== null ? viaLat.toFixed(6) : '',
      viaLng !== null ? viaLng.toFixed(6) : '',
      viaCity,
      viaState,
      distanceText,
      durationText,
      viaRouteId,
      locationId,
    );

    return {
      ok: true,
      ...(await this.getViaRoutes(locationId)),
    };
  }

  async deleteViaRoute(locationId: number, viaRouteId: number) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

    const existingViaRoute = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT via_route_location_ID
      FROM dvi_stored_location_via_routes
      WHERE via_route_location_ID = ? AND location_id = ? AND deleted = 0
      LIMIT 1
      `,
      viaRouteId,
      locationId,
    );

    if (!existingViaRoute.length) {
      throw new NotFoundException('Via route not found');
    }

    await this.prisma.$executeRawUnsafe(
      `
      UPDATE dvi_stored_location_via_routes
      SET deleted = 1, updatedon = NOW()
      WHERE via_route_location_ID = ? AND location_id = ? AND deleted = 0
      `,
      viaRouteId,
      locationId,
    );

    return {
      ok: true,
      ...(await this.getViaRoutes(locationId)),
    };
  }

  async getSuggestedRoutes(locationId: number) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

 const rows = await this.prisma.$queryRawUnsafe<any[]>(
  `
  SELECT
    r.stored_route_ID,
    r.route_name,
    r.no_of_nights,
    l.route_location_name
  FROM dvi_stored_routes r
  LEFT JOIN dvi_stored_route_location_details l
    ON r.stored_route_ID = l.stored_route_id
    AND l.deleted = 0
  WHERE r.deleted = 0
    AND r.location_id = ?
  ORDER BY r.stored_route_ID, l.stored_route_location_ID
  `,
  locationId,
);
    const grouped = new Map<number, { routeName: string; noOfNights: string; details: string[] }>();

    for (const row of rows) {
      const routeId = Number(row.stored_route_ID);
      if (!grouped.has(routeId)) {
        grouped.set(routeId, {
          routeName: String(row.route_name ?? ''),
          noOfNights: String(row.no_of_nights ?? ''),
          details: [],
        });
      }

      const entry = grouped.get(routeId)!;
      const detail = String(row.route_location_name ?? '').trim();
      if (detail) entry.details.push(detail);
    }

    return {
      data: Array.from(grouped.entries()).map(([routeId, entry], index) => ({
        count: String(index + 1),
        routes: entry.routeName,
        no_of_nights: entry.noOfNights,
        route_details: entry.details.join(' → '),
        modify: String(routeId),
      })),
    };
  }
   
  async addSuggestedRoute(
    locationId: number,
    payload: {
      routes: string;
      no_of_nights?: string;
      route_details?: string;
    },
  ) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

    const routeName = String(payload?.routes ?? '').trim();
    if (!routeName) {
      throw new BadRequestException('routes is required');
    }

    const noOfNights = String(payload?.no_of_nights ?? '').trim();
    const routeDetails = String(payload?.route_details ?? '').trim();

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `
        INSERT INTO dvi_stored_routes (
          location_id,
          route_name,
          no_of_nights,
          status,
          deleted,
          createdon
        )
        VALUES (?, ?, ?, 1, 0, NOW())
        `,
        locationId,
        routeName,
        noOfNights,
      );

      const insertedRoute = await tx.$queryRawUnsafe<any[]>(
        `
        SELECT stored_route_ID
        FROM dvi_stored_routes
        WHERE location_id = ? AND route_name = ? AND deleted = 0
        ORDER BY stored_route_ID DESC
        LIMIT 1
        `,
        locationId,
        routeName,
      );

      const storedRouteId = Number(insertedRoute?.[0]?.stored_route_ID || 0);

            if (storedRouteId > 0) {
  const detailItems = routeDetails
    .split(/\r?\n|→|,/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  for (const detail of detailItems) {
    await tx.$executeRawUnsafe(
      `
      INSERT INTO dvi_stored_route_location_details (
        stored_route_id,
        route_location_name,
        status,
        deleted,
        createdon
      )
      VALUES (?, ?, 1, 0, NOW())
      `,
      storedRouteId,
      detail,
    );
  }
}
    });

    return {
      ok: true,
      ...(await this.getSuggestedRoutes(locationId)),
    };
  }

  async updateSuggestedRoute(
    locationId: number,
    suggestedRouteId: number,
    payload: {
      routes?: string;
      no_of_nights?: string;
      route_details?: string;
    },
  ) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

    const existingRoute = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT stored_route_ID, route_name, no_of_nights
      FROM dvi_stored_routes
      WHERE stored_route_ID = ? AND location_id = ? AND deleted = 0
      LIMIT 1
      `,
      suggestedRouteId,
      locationId,
    );

    if (!existingRoute.length) {
      throw new NotFoundException('Suggested route not found');
    }

    const currentRoute = existingRoute[0];

    const routeName = String(
      payload?.routes ?? currentRoute.route_name ?? '',
    ).trim();

    if (!routeName) {
      throw new BadRequestException('routes is required');
    }

    const noOfNights = String(
      payload?.no_of_nights ?? currentRoute.no_of_nights ?? '',
    ).trim();

    const routeDetails = String(payload?.route_details ?? '').trim();

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `
        UPDATE dvi_stored_routes
        SET
          route_name = ?,
          no_of_nights = ?,
          updatedon = NOW()
        WHERE stored_route_ID = ? AND location_id = ? AND deleted = 0
        `,
        routeName,
        noOfNights,
        suggestedRouteId,
        locationId,
      );

      await tx.$executeRawUnsafe(
        `
        UPDATE dvi_stored_route_location_details
        SET
          deleted = 1,
          updatedon = NOW()
        WHERE stored_route_id = ? AND deleted = 0
        `,
        suggestedRouteId,
      );

            const detailItems = routeDetails
  .split(/\r?\n|→|,/g)
  .map((item) => item.trim())
  .filter((item) => item.length > 0);

      for (const detail of detailItems) {
        await tx.$executeRawUnsafe(
          `
          INSERT INTO dvi_stored_route_location_details (
            stored_route_id,
            route_location_name,
            status,
            deleted,
            createdon
          )
          VALUES (?, ?, 1, 0, NOW())
          `,
          suggestedRouteId,
          detail,
        );
      }
    });

    return {
      ok: true,
      ...(await this.getSuggestedRoutes(locationId)),
    };
  }

  async deleteSuggestedRoute(locationId: number, suggestedRouteId: number) {
    const location = await this.prisma.dvi_stored_locations.findFirst({
      where: { location_ID: BigInt(locationId), deleted: 0 },
    });

    if (!location) {
      throw new NotFoundException('Location not found');
    }

    const existingRoute = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT stored_route_ID
      FROM dvi_stored_routes
      WHERE stored_route_ID = ? AND location_id = ? AND deleted = 0
      LIMIT 1
      `,
      suggestedRouteId,
      locationId,
    );

    if (!existingRoute.length) {
      throw new NotFoundException('Suggested route not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `
        UPDATE dvi_stored_routes
        SET
          deleted = 1,
          updatedon = NOW()
        WHERE stored_route_ID = ? AND location_id = ? AND deleted = 0
        `,
        suggestedRouteId,
        locationId,
      );

      await tx.$executeRawUnsafe(
        `
        UPDATE dvi_stored_route_location_details
        SET
          deleted = 1,
          updatedon = NOW()
        WHERE stored_route_id = ? AND deleted = 0
        `,
        suggestedRouteId,
      );
    });

    return {
      ok: true,
      ...(await this.getSuggestedRoutes(locationId)),
    };
  }

  // ------ Modify Location Name (quick rename) ------
  async modifyName(id: number, scope: 'source' | 'destination', newName: string) {
    await this.get(id);
    const data =
      scope === 'source'
        ? { source_location: newName }
        : { destination_location: newName };
    const updated = await this.prisma.dvi_stored_locations.update({
      where: { location_ID: BigInt(id) },
      data: { ...data, updatedon: new Date() },
    });
    this.clearStoredLocationCache(`locations.modifyName:${id}:${scope}`);
    return this.mapRowToResponse(updated);
  }

  // ------ TOLL CHARGES ------
  async getTolls(locationId: number) {
    // Verify location exists
    await this.get(locationId);

    // 1) Get all vehicle types (to render full grid)
    const vehicleTypes = await this.prisma.dvi_vehicle_type.findMany({
      where: { deleted: 0, status: 1 },
      orderBy: { vehicle_type_id: 'asc' },
      select: {
        vehicle_type_id: true,
        vehicle_type_title: true,
      },
    });

    // 2) Get existing tolls for this location
    const existing = await this.prisma.dvi_vehicle_toll_charges.findMany({
      where: { location_id: BigInt(locationId), deleted: 0 },
      select: {
        vehicle_type_id: true,
        toll_charge: true,
      },
    });

    // Build toll map
    const tollMap = new Map<number, number>(
      existing.map((e) => [Number(e.vehicle_type_id), Number(e.toll_charge || 0)])
    );

    // 3) Return as array of toll objects
    return vehicleTypes.map((vt) => ({
      vehicle_type_id: vt.vehicle_type_id,
      vehicle_type_name: vt.vehicle_type_title ?? '',
      toll_charge: tollMap.get(Number(vt.vehicle_type_id)) ?? 0,
    }));
  }

  /**
   * Save toll charges for location
   * Deletes all existing and inserts new items from request
   */
  async upsertTolls(
    locationId: number,
    items: { vehicle_type_id: number; toll_charge: number }[],
    userId: number
  ) {
    const idBig = BigInt(locationId);
    await this.get(locationId);

    // Delete all existing tolls for this location
    await this.prisma.dvi_vehicle_toll_charges.deleteMany({
      where: { location_id: idBig },
    });

    // Insert new items if provided
    if (!items?.length) return { ok: true };

    await this.prisma.dvi_vehicle_toll_charges.createMany({
      data: items.map((it) => ({
        location_id: idBig,
        vehicle_type_id: it.vehicle_type_id,
        toll_charge: Number(it.toll_charge) || 0,
        createdby: Number(userId ?? 0),
        status: 1,
        deleted: 0,
        createdon: new Date(),
      })),
      skipDuplicates: true,
    });

    return { ok: true };
  }
}
