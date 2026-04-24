import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { LocationResponseDto } from './dto/location.dto';

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
  source_location_state: string;
  source_location_lattitude: string;
  source_location_longitude: string;
};

type AutosuggestQuery = {
  phrase?: string;
  format?: string;
  type?: string;
};

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Convert database row to API response format
   * Handles field mapping from DB schema to API contract
   */
  private mapRowToResponse(row: any): LocationResponseDto {
    return {
      location_ID: Number(row.location_ID),
      source_location: row.source_location || '',
      source_city: row.source_location_city || '',
      source_state: row.source_location_state || '',
      source_latitude: String(row.source_location_lattitude || ''),
      source_longitude: String(row.source_location_longitude || ''),
      destination_location: row.destination_location || '',
      destination_city: row.destination_location_city || '',
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

  if (q.source) where.source_location = q.source;
  if (q.destination) where.destination_location = q.destination;

  if (q.search) {
    where.OR = [
      { source_location: { contains: q.search } },
      { destination_location: { contains: q.search } },
      { source_location_city: { contains: q.search } },
      { destination_location_city: { contains: q.search } },
    ];
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

  const [rows, total] = await this.prisma.$transaction([
    this.prisma.dvi_stored_locations.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    this.prisma.dvi_stored_locations.count({ where }),
  ]);

  return {
    rows: rows.map((r) => this.mapRowToResponse(r)),
    total,
    page,
    pageSize,
  };
}

  async dropdowns() {
    const [src, dst] = await this.prisma.$transaction([
      this.prisma.dvi_stored_locations.findMany({
        where: { deleted: 0 },
        select: { source_location: true },
        distinct: ['source_location'],
        orderBy: { source_location: 'asc' },
      }),
      this.prisma.dvi_stored_locations.findMany({
        where: { deleted: 0 },
        select: { destination_location: true },
        distinct: ['destination_location'],
        orderBy: { destination_location: 'asc' },
      }),
    ]);
    return {
      sources: src.map((x) => x.source_location).filter(Boolean),
      destinations: dst.map((x) => x.destination_location).filter(Boolean),
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
      source_location_state: this.normalizeLocationName(payload?.source_state),
      source_location_lattitude: sourceLat.toFixed(6),
      source_location_longitude: sourceLng.toFixed(6),
    };

    const itineraryDistanceLimit = await this.getItineraryDistanceLimit();
    const existingSources = await this.getDistinctExistingSourceLocations();

    const result = await this.createReplicatedLocationRows(
      newSourceSeed,
      existingSources,
      itineraryDistanceLimit,
      payload?.location_description,
    );

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
    await this.get(id);
    const data = this.mapDtoToSchema(payload);
    const updated = await this.prisma.dvi_stored_locations.update({
      where: { location_ID: BigInt(id) },
      data: { ...data, updatedon: new Date() },
    });
    return this.mapRowToResponse(updated);
  }



  private mapDtoToSchema(dto: any) {
  const mapped: any = {};

  if (dto.source_location !== undefined) mapped.source_location = dto.source_location;
  if (dto.source_city !== undefined) mapped.source_location_city = dto.source_city;
  if (dto.source_state !== undefined) mapped.source_location_state = dto.source_state;

  if (dto.source_latitude !== undefined || dto.source_longitude !== undefined) {
    const { latitude, longitude } = this.resolveCoordinateInput(
      dto.source_latitude,
      dto.source_longitude,
    );

    if (latitude !== null) {
      mapped.source_location_lattitude = latitude.toFixed(6);
    }

    if (longitude !== null) {
      mapped.source_location_longitude = longitude.toFixed(6);
    }
  }

  if (dto.destination_location !== undefined) mapped.destination_location = dto.destination_location;
  if (dto.destination_city !== undefined) mapped.destination_location_city = dto.destination_city;
  if (dto.destination_state !== undefined) mapped.destination_location_state = dto.destination_state;

  if (dto.destination_latitude !== undefined || dto.destination_longitude !== undefined) {
    const { latitude, longitude } = this.resolveCoordinateInput(
      dto.destination_latitude,
      dto.destination_longitude,
    );

    if (latitude !== null) {
      mapped.destination_location_lattitude = latitude.toFixed(6);
    }

    if (longitude !== null) {
      mapped.destination_location_longitude = longitude.toFixed(6);
    }
  }

  if (dto.distance_km !== undefined) mapped.distance = Number(dto.distance_km);
  if (dto.duration_text !== undefined) mapped.duration = dto.duration_text;
  if (dto.location_description !== undefined) mapped.location_description = dto.location_description;

  return mapped;
}

private parseCoordinatePair(value: unknown): { latitude: number; longitude: number } | null {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const match = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

private resolveCoordinateInput(
  latitudeValue: unknown,
  longitudeValue: unknown,
): { latitude: number | null; longitude: number | null } {
  const combinedFromLatitude = this.parseCoordinatePair(latitudeValue);
  if (combinedFromLatitude) {
    return {
      latitude: combinedFromLatitude.latitude,
      longitude: combinedFromLatitude.longitude,
    };
  }

  const combinedFromLongitude = this.parseCoordinatePair(longitudeValue);
  if (combinedFromLongitude) {
    return {
      latitude: combinedFromLongitude.latitude,
      longitude: combinedFromLongitude.longitude,
    };
  }

  return {
    latitude: this.toCoordinate(latitudeValue),
    longitude: this.toCoordinate(longitudeValue),
  };
}

private toCoordinate(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;

  const num = Number(value);
  if (!Number.isFinite(num)) return null;

  return num;
}

private toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

private normalizeLocationName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

private uniqueStringsCaseInsensitive(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);
  }

  return result;
}

private estimateDurationText(distanceKm: number): string {
  const averageSpeedKmPerHour = 25;
  const totalHours = distanceKm / averageSpeedKmPerHour;
  let hours = Math.floor(totalHours);
  let mins = Math.round((totalHours - hours) * 60);

  if (mins === 60) {
    hours += 1;
    mins = 0;
  }

  return `${hours} hours ${mins} mins`;
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
    source_location_state: source.source_location_state,
    destination_location: destination.source_location,
    destination_location_lattitude: destination.source_location_lattitude,
    destination_location_longitude: destination.source_location_longitude,
    destination_location_city: destination.source_location_city,
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

    const isSelfRoute =
      newSource.source_location.toLowerCase() ===
      candidate.source_location.toLowerCase();

    if (isSelfRoute) {
      continue;
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

  const selfNameKey = pairKey(newSource.source_location, newSource.source_location);
  if (rowsToInsert.length === 0 && !existingNamePairs.has(selfNameKey)) {
    rowsToInsert.push({
      ...this.buildLocationRowData(newSource, newSource, 0, locationDescription),
      distance: 0,
      duration: '0 hours 0 mins',
    });
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
  });
}

private calculateDistanceKm(
  sourceLat: number,
  sourceLng: number,
  destLat: number,
  destLng: number,
): number {
  const earthRadiusKm = 6371;

  const dLat = this.toRadians(destLat - sourceLat);
  const dLng = this.toRadians(destLng - sourceLng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(this.toRadians(sourceLat)) *
      Math.cos(this.toRadians(destLat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = earthRadiusKm * c;

  return Number(distance.toFixed(6));
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

  return {
    ok: true,
    deletedLocation: name,
    deletedCount: result.count,
  };
}

    async softDelete(id: number) {
    const row = await this.get(id);

    await this.prisma.dvi_stored_locations.update({
      where: { location_ID: BigInt(id) },
      data: { deleted: 1, updatedon: new Date() },
    });

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
