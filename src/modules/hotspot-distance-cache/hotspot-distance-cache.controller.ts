import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { HotspotDistanceCacheService } from './hotspot-distance-cache.service';
import { CacheListQueryDto } from './dto/cache-list.query.dto';
import { CacheCreateDto } from './dto/cache-create.dto';
import { CacheUpdateDto } from './dto/cache-update.dto';
import * as XLSX from 'xlsx';

@Controller('hotspot-distance-cache')
export class HotspotDistanceCacheController {
  constructor(private readonly svc: HotspotDistanceCacheService) {}

 /**
   * List cache entries with search and filtering
   * GET /hotspot-distance-cache?page=1&size=50&search=temple&sortBy=createdAt&sortOrder=desc
 */
  @Get()
  list(@Query() query: CacheListQueryDto) {
    return this.svc.list(query);
  }

 /**
   * Get form options (dropdowns for hotspots, travel types)
   * GET /hotspot-distance-cache/form-options
 */
  @Get('form-options')
  formOptions() {
    return this.svc.getFormOptions();
  }

 /**
   * Get single cache entry
   * GET /hotspot-distance-cache/:id
 */
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.svc.getOne(Number(id));
  }

 /**
   * Create new cache entry
   * POST /hotspot-distance-cache
 */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CacheCreateDto) {
    return this.svc.create(dto);
  }

 /**
   * Update cache entry
   * PUT /hotspot-distance-cache
 */
  @Put()
  @HttpCode(HttpStatus.OK)
  update(@Body() dto: CacheUpdateDto) {
    return this.svc.update(dto);
  }

 /**
   * Delete cache entry
   * DELETE /hotspot-distance-cache/:id
 */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  delete(@Param('id') id: string) {
    return this.svc.delete(Number(id));
  }

 /**
   * Bulk delete cache entries
   * POST /hotspot-distance-cache/bulk-delete
 */
  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  bulkDelete(@Body() body: { ids: number[] }) {
    if (!body.ids || !Array.isArray(body.ids)) {
      throw new BadRequestException('ids array is required');
    }
    return this.svc.bulkDelete(body.ids);
  }

 /**
   * Export cache to Excel
   * GET /hotspot-distance-cache/export/excel?search=temple
 */
  @Get('export/excel')
  @HttpCode(HttpStatus.OK)
  async exportExcel(@Query() query: CacheListQueryDto) {
    const data = await this.svc.getForExport(query);

    if (!data || data.length === 0) {
      throw new BadRequestException('No data to export');
    }

 // Create workbook
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Cache');

 // Set column widths
    worksheet['!cols'] = [
 { wch: 8 }, // ID
 { wch: 15 }, // From Hotspot ID
 { wch: 30 }, // From Hotspot Name
 { wch: 12 }, // To Hotspot ID
 { wch: 30 }, // To Hotspot Name
 { wch: 12 }, // Travel Type
 { wch: 12 }, // Haversine KM
 { wch: 15 }, // Correction Factor
 { wch: 12 }, // Distance KM
 { wch: 12 }, // Speed KMPH
 { wch: 12 }, // Travel Time
 { wch: 15 }, // Method
 { wch: 20 }, // Created At
 { wch: 20 }, // Updated At
    ];

 // Generate file buffer
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });

    return {
      ok: true,
      fileName: `hotspot-distance-cache-${new Date().toISOString().split('T')[0]}.xlsx`,
      data: buffer.toString('base64'),
    };
  }
}
