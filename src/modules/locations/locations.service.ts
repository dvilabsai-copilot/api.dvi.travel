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

  // ------ CRUD ------
async create(payload: any) {
  const data = this.mapDtoToSchema(payload);

  const sourceLat = this.toCoordinate(payload?.source_latitude);
  const sourceLng = this.toCoordinate(payload?.source_longitude);
  const destLat = this.toCoordinate(payload?.destination_latitude);
  const destLng = this.toCoordinate(payload?.destination_longitude);

  if (payload?.source_latitude !== undefined && sourceLat === null) {
    throw new BadRequestException('Invalid source_latitude');
  }

  if (payload?.source_longitude !== undefined && sourceLng === null) {
    throw new BadRequestException('Invalid source_longitude');
  }

  if (payload?.destination_latitude !== undefined && destLat === null) {
    throw new BadRequestException('Invalid destination_latitude');
  }

  if (payload?.destination_longitude !== undefined && destLng === null) {
    throw new BadRequestException('Invalid destination_longitude');
  }

  const computedDistanceKm =
    sourceLat !== null &&
    sourceLng !== null &&
    destLat !== null &&
    destLng !== null
      ? this.calculateDistanceKm(sourceLat, sourceLng, destLat, destLng)
      : 0;

  const created = await this.prisma.dvi_stored_locations.create({
    data: {
      ...data,
      destination_location: data.destination_location ?? '',
      destination_location_city: data.destination_location_city ?? '',
      destination_location_state: data.destination_location_state ?? '',
      destination_location_lattitude:
        data.destination_location_lattitude ?? '',
      destination_location_longitude:
        data.destination_location_longitude ?? '',
      distance:
        data.distance !== undefined ? data.distance : computedDistanceKm,
      duration: data.duration ?? '',
      status: 1,
      deleted: 0,
      createdon: new Date(),
    },
  });

  return this.mapRowToResponse(created);
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
