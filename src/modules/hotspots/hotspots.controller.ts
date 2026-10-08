// FILE: src/modules/hotspots/hotspots.controller.ts

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HotspotsService } from './hotspots.service';
import { HotspotListQueryDto } from './dto/hotspot-list.query.dto';
import { HotspotListResponseDto } from './dto/hotspot-list.response.dto';

// Create/Update DTOs
import { HotspotCreateDto } from './dto/hotspot-create.dto';
import { HotspotUpdateDto } from './dto/hotspot-update.dto';

import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';

// -------------------- storage helpers --------------------
function resolveBackendRoot(): string {
 // Works for both src/* (ts-node) and dist/* (compiled) execution.
  const candidate = path.resolve(__dirname, '..', '..', '..', '..');
  return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : process.cwd();
}

// Gallery images go to public/uploads/hotspot_gallery (unchanged)
function galleryStorage() {
  return diskStorage({
    destination: (_req, _file, cb) => {
      const dest = path.join(resolveBackendRoot(), 'public', 'uploads', 'hotspot_gallery');
      try {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
        }
        cb(null, dest);
      } catch (e) {
        cb(e as Error, dest);
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const base = crypto.randomBytes(16).toString('hex');
      cb(null, `${base}${ext}`);
    },
  });
}

// CSV temporary storage (Parking Charge import)
// Ensures the folder exists to avoid ENOENT on Windows/Unix.
function csvTempStorage() {
 // Allow override via env, else default to <appRoot>/tmp/uploads
  const dest =
    (process.env.TMP_UPLOAD_DIR && process.env.TMP_UPLOAD_DIR.trim()) ||
    path.join(resolveBackendRoot(), 'tmp', 'uploads');

  try {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
  } catch (e) {
 // Fallback to OS temp dir if custom path can't be created
 console.warn('Could not create tmp/uploads folder, falling back to OS tmp:', e);
    return diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.csv';
        const base = crypto.randomBytes(16).toString('hex');
        cb(null, `${base}${ext}`);
      },
    });
  }

  return diskStorage({
    destination: (_req, _file, cb) => cb(null, dest),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.csv';
      const base = crypto.randomBytes(16).toString('hex');
      cb(null, `${base}${ext}`);
    },
  });
}

@ApiTags('hotspots')
@ApiBearerAuth()
@Controller('hotspots')
export class HotspotsController {
  constructor(private readonly svc: HotspotsService) {}

  @Patch(':id/opening-hours')
  saveOpeningHoursOnly(@Param('id') id: string, @Body() body: any) {
    return this.svc.saveOpeningHoursOnly(Number(id), body?.openingHours);
  }

 // -------------------- LIST & FORM --------------------
 // List JSON (DataTable)
  @Get()
  list(@Query() q: HotspotListQueryDto): Promise<HotspotListResponseDto> {
    return this.svc.list(q);
  }

 // Dynamic dropdowns for form
  @Get('form-options')
  formOptions() {
    return this.svc.formOptions();
  }

 // Full form payload for edit (master + children) + options
  @Get(':id/form')
  getForm(@Param('id') id: string) {
    return this.svc.getForm(Number(id));
  }

 // Save form (create or update) accepts either DTO
  @Post('form')
  saveForm(@Body() payload: HotspotCreateDto | HotspotUpdateDto) {
    return this.svc.saveForm(payload as any);
  }

 // Inline priority update
  @Patch(':id/priority-value')
  updatePriorityValue(
    @Param('id') id: string,
    @Body() body: { priority?: unknown },
  ) {
    return this.svc.updatePriorityValue(
      Number(id), typeof body?.priority === 'number' ? body.priority : Number.NaN
    );
  }

  @Patch(':id/priority-in-results')
  updatePriorityInResults(
    @Param('id') id: string,
    @Body() body: { priority: number; scope?: unknown },
  ) {
    return this.svc.updatePriority(
      Number(id), Number(body?.priority), body?.scope ?? null
    );
  }

  @Patch(':id/priority')
  updatePriority(@Param('id') id: string, @Body() body: { priority: number }) {
    const priority = Number(body?.priority);
    return this.svc.updatePriority(Number(id), priority);
  }

 // Soft delete
  @Delete(':id')
  softDelete(@Param('id') id: string) {
    return this.svc.softDelete(Number(id));
  }

 // Simple fetch
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.svc.getOne(Number(id));
  }

 // -------------------- GALLERY --------------------
 // Gallery upload endpoint (multipart/form-data; field name: file)
  @Post(':id/gallery/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: galleryStorage(),
 limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
    }),
  )
  async uploadGallery(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const row = await this.svc.createGalleryRow(Number(id), file.filename);
    return {
      ok: true,
      id: row.hotspot_gallery_details_id,
      name: file.filename,
      url: `/uploads/hotspot_gallery/${file.filename}`,
    };
  }

// -------------------- PARKING CHARGE CSV FLOW --------------------

// Download a database-generated sample, matching the B2B format.
// GET /hotspots/parking-charge/sample.csv
@Get('parking-charge/sample.csv')
@ApiOperation({ summary: 'Download parking charge sample CSV' })
async downloadParkingChargeSample(@Res() res: Response) {
  const csv = await this.svc.buildParkingChargeSampleCsv();

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="parking_charges_sample.csv"',
  );

  return res.send(csv);
}

// 1) Upload CSV -> stage each line into dvi_tempcsv with csvtype=4 (PHP parity)
  @Post('parking-charge/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: csvTempStorage(),
 limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
    }),
  )
  async uploadParkingCsv(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.svc.importParkingCsv(file.path);
  }

 // 2) Read staged rows (status=1) for a given sessionId
 // GET /hotspots/parking-charge/templist?sessionId=...
  @Get('parking-charge/templist')
  getParkingTemplist(@Query('sessionId') sessionId: string) {
    if (!sessionId) throw new BadRequestException('sessionId is required');
    return this.svc.getParkingTemplist(sessionId);
  }

// 3) Confirm import -> upsert into dvi_hotspot_vehicle_parking_charges and mark temp rows status=2
 // POST /hotspots/parking-charge/confirm { sessionId: string, tempIds?: number[] }
  @Post('parking-charge/confirm')
  confirmParkingImport(@Body() body: { sessionId: string; tempIds?: number[] }) {
    const { sessionId, tempIds } = body || {};
    if (!sessionId) throw new BadRequestException('sessionId is required');
    return this.svc.confirmParkingImport(sessionId, Array.isArray(tempIds) ? tempIds : undefined);
  }

  @Get('parking-charge/records')
  getParkingChargeRecords(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('hotspotId') hotspotId?: string,
    @Query('vehicleTypeId') vehicleTypeId?: string,
    @Query('hotspotIds') hotspotIds?: string,
    @Query('vehicleTypeIds') vehicleTypeIds?: string,
  ) {
    const parseIds = (
      plural: unknown,
      singular: unknown,
      label: string,
    ): number[] => {
      const raw = plural !== undefined ? plural : singular;
      if (raw === undefined || raw === '') return [];
      if (typeof raw !== 'string') {
        throw new BadRequestException(label + ' must be comma-separated IDs');
      }
      const tokens = raw.split(',').map((token) => token.trim());
      if (tokens.length > 5 || tokens.some((token) => !/^[1-9][0-9]*$/.test(token))) {
        throw new BadRequestException(label + ' requires one to five positive integer IDs');
      }
      const ids = tokens.map(Number);
      if (ids.some((id) => !Number.isSafeInteger(id))) {
        throw new BadRequestException(label + ' contains an invalid ID');
      }
      return [...new Set(ids)];
    };
    const parsePage = (raw: unknown, fallback: number, label: string): number => {
      if (raw === undefined || raw === '') return fallback;
      if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
        throw new BadRequestException(label + ' must be a positive integer');
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) {
        throw new BadRequestException(label + ' is invalid');
      }
      return value;
    };

    return this.svc.getParkingChargeRecords({
      page: parsePage(page, 1, 'page'),
      pageSize: parsePage(pageSize, 25, 'pageSize'),
      hotspotIds: parseIds(hotspotIds, hotspotId, 'hotspotIds'),
      vehicleTypeIds: parseIds(vehicleTypeIds, vehicleTypeId, 'vehicleTypeIds'),
    });
  }

  @Patch('parking-charge/records')
  updateParkingChargeRecords(
    @Body() body: {
      rows: Array<{
        hotspotId: number;
        vehicleTypeId: number;
        parkingCharge: number;
      }>;
    },
  ) {
    return this.svc.updateParkingChargeRecords(body?.rows);
  }

  @Delete('parking-charge/records/:id')
  deleteParkingChargeRecord(@Param('id') id: string) {
    return this.svc.deleteParkingChargeRecord(Number(id));
  }
}