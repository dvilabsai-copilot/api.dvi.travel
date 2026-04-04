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
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 10));

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

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.dvi_stored_locations.findMany({
        where,
        orderBy: { location_ID: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.dvi_stored_locations.count({ where }),
    ]);

    return {
      rows: rows.map(r => this.mapRowToResponse(r)),
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
    const sourceLat = this.toCoordinate(payload?.source_latitude);
    const sourceLng = this.toCoordinate(payload?.source_longitude);

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
  if (dto.source_latitude !== undefined) mapped.source_location_lattitude = dto.source_latitude;
  if (dto.source_longitude !== undefined) mapped.source_location_longitude = dto.source_longitude;

  if (dto.destination_location !== undefined) mapped.destination_location = dto.destination_location;
  if (dto.destination_city !== undefined) mapped.destination_location_city = dto.destination_city;
  if (dto.destination_state !== undefined) mapped.destination_location_state = dto.destination_state;
  if (dto.destination_latitude !== undefined) mapped.destination_location_lattitude = dto.destination_latitude;
  if (dto.destination_longitude !== undefined) mapped.destination_location_longitude = dto.destination_longitude;

  if (dto.distance_km !== undefined) mapped.distance = Number(dto.distance_km);
  if (dto.duration_text !== undefined) mapped.duration = dto.duration_text;
  if (dto.location_description !== undefined) mapped.location_description = dto.location_description;

  return mapped;
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
    maxWait: 10000,
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

  async softDelete(id: number) {
    await this.get(id);
    await this.prisma.dvi_stored_locations.update({
      where: { location_ID: BigInt(id) },
      data: { deleted: 1, updatedon: new Date() },
    });
    return { ok: true };
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
