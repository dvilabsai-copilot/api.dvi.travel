import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { CacheListQueryDto } from './dto/cache-list.query.dto';
import { CacheListResponseDto, CacheListRow } from './dto/cache-list.response.dto';
import { CacheCreateDto } from './dto/cache-create.dto';
import { CacheUpdateDto } from './dto/cache-update.dto';
import { TimeConverter } from '../itineraries/engines/helpers/time-converter';

const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 50;
const MAX_SIZE = 10000;

function formatTimeFromDate(dateOrNull: any): string {
  if (!dateOrNull) return '00:00:00';

  if (dateOrNull instanceof Date) {
    const h = String(dateOrNull.getUTCHours()).padStart(2, '0');
    const m = String(dateOrNull.getUTCMinutes()).padStart(2, '0');
    const s = String(dateOrNull.getUTCSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  return String(dateOrNull);
}

@Injectable()
export class HotspotDistanceCacheService {
  constructor(private prisma: PrismaService) {}

 /**
   * List cache entries with search and filtering
 */
  async list(query: CacheListQueryDto): Promise<CacheListResponseDto> {
    const page = Math.max(1, query.page || DEFAULT_PAGE);
    const size = Math.min(query.size || DEFAULT_SIZE, MAX_SIZE);
    const skip = (page - 1) * size;

    const searchStr = (query.search || '').trim().toLowerCase();

 // Build where clause
    const where: any = {};

    if (searchStr) {
 // Search by hotspot names (OR condition)
      where.OR = [
        { fromHotspotName: { contains: searchStr, mode: 'insensitive' } },
        { toHotspotName: { contains: searchStr, mode: 'insensitive' } },
      ];
    }

    if (query.fromHotspotId) {
      where.fromHotspotId = query.fromHotspotId;
    }

    if (query.toHotspotId) {
      where.toHotspotId = query.toHotspotId;
    }

    if (query.travelLocationType) {
      where.travelLocationType = query.travelLocationType;
    }

 // Determine sort
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any = {};
    orderBy[sortBy] = sortOrder;

 // Fetch total count
    const total = await this.prisma.hotspotDistanceCache.count({ where });

 // Fetch rows
    const rows = await this.prisma.hotspotDistanceCache.findMany({
      where,
      select: {
        id: true,
        fromHotspotId: true,
        fromHotspotName: true,
        toHotspotId: true,
        toHotspotName: true,
        travelLocationType: true,
        haversineKm: true,
        correctionFactor: true,
        distanceKm: true,
        speedKmph: true,
        travelTime: true,
        method: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy,
      skip,
      take: size,
    });

    const formattedRows: CacheListRow[] = rows.map((row) => ({
      id: row.id,
      fromHotspotId: row.fromHotspotId,
      fromHotspotName: row.fromHotspotName || '',
      toHotspotId: row.toHotspotId,
      toHotspotName: row.toHotspotName || '',
      travelLocationType: row.travelLocationType,
      haversineKm: Number(row.haversineKm),
      correctionFactor: Number(row.correctionFactor),
      distanceKm: Number(row.distanceKm),
      speedKmph: Number(row.speedKmph),
      travelTime: formatTimeFromDate(row.travelTime),
      method: row.method,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    const pages = Math.ceil(total / size);

    return {
      total,
      page,
      size,
      pages,
      rows: formattedRows,
    };
  }

 /**
   * Get single cache entry
 */
  async getOne(id: number) {
    const row = await this.prisma.hotspotDistanceCache.findUnique({
      where: { id },
      select: {
        id: true,
        fromHotspotId: true,
        fromHotspotName: true,
        toHotspotId: true,
        toHotspotName: true,
        travelLocationType: true,
        haversineKm: true,
        correctionFactor: true,
        distanceKm: true,
        speedKmph: true,
        travelTime: true,
        method: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!row) {
      throw new NotFoundException(`Cache entry ${id} not found`);
    }

    return {
      ...row,
      haversineKm: Number(row.haversineKm),
      correctionFactor: Number(row.correctionFactor),
      distanceKm: Number(row.distanceKm),
      speedKmph: Number(row.speedKmph),
      travelTime: formatTimeFromDate(row.travelTime),
    };
  }

 /**
   * Create new cache entry
 */
  async create(dto: CacheCreateDto) {
    if (!dto.fromHotspotId || !dto.toHotspotId) {
      throw new BadRequestException('fromHotspotId and toHotspotId are required');
    }

 // Check if hotspots exist
    const [fromHotspot, toHotspot] = await Promise.all([
      this.prisma.dvi_hotspot_place.findUnique({
        where: { hotspot_ID: dto.fromHotspotId },
        select: { hotspot_name: true },
      }),
      this.prisma.dvi_hotspot_place.findUnique({
        where: { hotspot_ID: dto.toHotspotId },
        select: { hotspot_name: true },
      }),
    ]);

    if (!fromHotspot || !toHotspot) {
      throw new BadRequestException('One or both hotspots do not exist');
    }

 // Check if entry already exists
    const existing = await this.prisma.hotspotDistanceCache.findUnique({
      where: {
        fromHotspotId_toHotspotId_travelLocationType: {
          fromHotspotId: dto.fromHotspotId,
          toHotspotId: dto.toHotspotId,
          travelLocationType: dto.travelLocationType,
        },
      },
    });

    if (existing) {
      throw new BadRequestException(
        'Cache entry for this hotspot pair and travel type already exists',
      );
    }

    const travelTimeDate = TimeConverter.stringToDate(dto.travelTime);

    const result = await this.prisma.hotspotDistanceCache.create({
      data: {
        fromHotspotId: dto.fromHotspotId,
        toHotspotId: dto.toHotspotId,
        travelLocationType: dto.travelLocationType,
        fromHotspotName: fromHotspot.hotspot_name,
        toHotspotName: toHotspot.hotspot_name,
        haversineKm: dto.haversineKm,
        correctionFactor: dto.correctionFactor,
        distanceKm: dto.distanceKm,
        speedKmph: dto.speedKmph,
        travelTime: travelTimeDate,
        method: dto.method || 'HAVERSINE',
      },
    });

    return {
      ...result,
      haversineKm: Number(result.haversineKm),
      correctionFactor: Number(result.correctionFactor),
      distanceKm: Number(result.distanceKm),
      speedKmph: Number(result.speedKmph),
      travelTime: formatTimeFromDate(result.travelTime),
    };
  }

 /**
   * Update cache entry
 */
  async update(dto: CacheUpdateDto) {
    if (!dto.id) {
      throw new BadRequestException('id is required');
    }

 // Verify entry exists
    const existing = await this.prisma.hotspotDistanceCache.findUnique({
      where: { id: dto.id },
    });

    if (!existing) {
      throw new NotFoundException(`Cache entry ${dto.id} not found`);
    }

    const updateData: any = {};

    if (dto.haversineKm !== undefined) updateData.haversineKm = dto.haversineKm;
    if (dto.correctionFactor !== undefined) updateData.correctionFactor = dto.correctionFactor;
    if (dto.distanceKm !== undefined) updateData.distanceKm = dto.distanceKm;
    if (dto.speedKmph !== undefined) updateData.speedKmph = dto.speedKmph;
    if (dto.method !== undefined) updateData.method = dto.method;
    if (dto.travelTime) {
      updateData.travelTime = TimeConverter.stringToDate(dto.travelTime);
    }

    updateData.updatedAt = new Date();

    const result = await this.prisma.hotspotDistanceCache.update({
      where: { id: dto.id },
      data: updateData,
    });

    return {
      ...result,
      haversineKm: Number(result.haversineKm),
      correctionFactor: Number(result.correctionFactor),
      distanceKm: Number(result.distanceKm),
      speedKmph: Number(result.speedKmph),
      travelTime: formatTimeFromDate(result.travelTime),
    };
  }

 /**
   * Delete cache entry
 */
  async delete(id: number) {
    const existing = await this.prisma.hotspotDistanceCache.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Cache entry ${id} not found`);
    }

    await this.prisma.hotspotDistanceCache.delete({
      where: { id },
    });

    return { ok: true, message: 'Cache entry deleted successfully' };
  }

 /**
   * Get data for Excel export
 */
  async getForExport(query: CacheListQueryDto) {
    const searchStr = (query.search || '').trim().toLowerCase();

    const where: any = {};

    if (searchStr) {
      where.OR = [
        { fromHotspotName: { contains: searchStr, mode: 'insensitive' } },
        { toHotspotName: { contains: searchStr, mode: 'insensitive' } },
      ];
    }

    if (query.fromHotspotId) {
      where.fromHotspotId = query.fromHotspotId;
    }

    if (query.toHotspotId) {
      where.toHotspotId = query.toHotspotId;
    }

    if (query.travelLocationType) {
      where.travelLocationType = query.travelLocationType;
    }

    const rows = await this.prisma.hotspotDistanceCache.findMany({
      where,
      select: {
        id: true,
        fromHotspotId: true,
        fromHotspotName: true,
        toHotspotId: true,
        toHotspotName: true,
        travelLocationType: true,
        haversineKm: true,
        correctionFactor: true,
        distanceKm: true,
        speedKmph: true,
        travelTime: true,
        method: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
 take: 50000, // Limit to prevent memory issues
    });

    return rows.map((row) => ({
      ID: row.id,
      'From Hotspot ID': row.fromHotspotId,
      'From Hotspot Name': row.fromHotspotName || '',
      'To Hotspot ID': row.toHotspotId,
      'To Hotspot Name': row.toHotspotName || '',
      'Travel Type': row.travelLocationType === 1 ? 'Local' : 'Outstation',
      'Haversine KM': Number(row.haversineKm).toFixed(4),
      'Correction Factor': Number(row.correctionFactor).toFixed(3),
      'Distance KM': Number(row.distanceKm).toFixed(4),
      'Speed KMPH': Number(row.speedKmph).toFixed(2),
      'Travel Time': formatTimeFromDate(row.travelTime),
      Method: row.method,
      'Created At': new Date(row.createdAt).toLocaleString(),
      'Updated At': new Date(row.updatedAt).toLocaleString(),
    }));
  }

 /**
   * Get form options (hotspots dropdown)
 */
  async getFormOptions() {
    const hotspots = await this.prisma.dvi_hotspot_place.findMany({
      where: { deleted: 0, status: 1 },
      select: { hotspot_ID: true, hotspot_name: true },
      orderBy: { hotspot_name: 'asc' },
    });

    return {
      hotspots: hotspots.map((h) => ({
        id: h.hotspot_ID,
        name: h.hotspot_name,
      })),
      travelTypes: [
        { id: 1, name: 'Local' },
        { id: 2, name: 'Outstation' },
      ],
    };
  }

 /**
   * Bulk delete cache entries
 */
  async bulkDelete(ids: number[]) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('Invalid ids array');
    }

    const result = await this.prisma.hotspotDistanceCache.deleteMany({
      where: { id: { in: ids } },
    });

    return {
      ok: true,
      deleted: result.count,
      message: `${result.count} cache entries deleted`,
    };
  }
}
