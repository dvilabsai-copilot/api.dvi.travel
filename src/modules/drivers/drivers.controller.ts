// NEW FILE: src/modules/drivers/drivers.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Request } from 'express';
import { DriversService } from './drivers.service';
import { UpdateDriverStatusDto } from './dto/update-driver-status.dto';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';

const PROFILE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DOCUMENT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

function getExtension(fileName: string): string {
  return path.extname(fileName || '').toLowerCase();
}

function profileFileFilter(_req: Request, file: Express.Multer.File, cb: (error: Error | null, acceptFile: boolean) => void) {
  const ext = getExtension(file?.originalname || '');
  if (!PROFILE_EXTENSIONS.has(ext)) {
    cb(new BadRequestException('Invalid profile file type. Allowed: jpg, jpeg, png, webp'), false);
    return;
  }
  cb(null, true);
}

function documentFileFilter(_req: Request, file: Express.Multer.File, cb: (error: Error | null, acceptFile: boolean) => void) {
  const ext = getExtension(file?.originalname || '');
  if (!DOCUMENT_EXTENSIONS.has(ext)) {
    cb(new BadRequestException('Invalid document file type. Allowed: jpg, jpeg, png, webp, pdf'), false);
    return;
  }
  cb(null, true);
}

function driverGalleryStorage() {
  return diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(process.cwd(), 'public', 'uploads', 'driver_gallery');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // ignored
      }
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
      const base = crypto.randomBytes(10).toString('hex');
      cb(null, `${base}-${Date.now()}${ext}`);
    },
  });
}

@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get('lookups')
  async lookups() {
    return this.driversService.getLookups();
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('profileFile', {
      storage: driverGalleryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: profileFileFilter,
    }),
  )
  async create(@Body() body: CreateDriverDto | any, @UploadedFile() profileFile?: Express.Multer.File) {
    return this.driversService.create(body, profileFile?.filename);
  }

  @Put(':id/basic')
  @UseInterceptors(
    FileInterceptor('profileFile', {
      storage: driverGalleryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: profileFileFilter,
    }),
  )
  async updateBasic(
    @Param('id') id: string,
    @Body() body: any,
    @UploadedFile() profileFile?: Express.Multer.File,
  ) {
    return this.driversService.updateBasic(Number(id), body, profileFile?.filename);
  }

  @Put(':id/cost')
  async updateCost(@Param('id') id: string, @Body() body: any) {
    return this.driversService.upsertCost(Number(id), body);
  }

  @Get(':id/documents')
  async listDocuments(@Param('id') id: string) {
    return this.driversService.listDocuments(Number(id));
  }

  @Post(':id/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: driverGalleryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: documentFileFilter,
    }),
  )
  async uploadDocument(
    @Param('id') id: string,
    @Body() body: { documentType?: string },
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.driversService.uploadDocument(Number(id), body?.documentType || '', file.filename);
  }

@Get(':id/reviews')
async listReviews(@Param('id') id: string) {
  return this.driversService.listReviews(Number(id));
}

@Post(':id/reviews')
async createReview(
  @Param('id') id: string,
  @Body() body: { rating?: number | string; description?: string },
) {
  return this.driversService.createReview(Number(id), body);
}

@Put('reviews/:reviewId')
async updateReview(
  @Param('reviewId') reviewId: string,
  @Body() body: { rating?: number | string; description?: string },
) {
  return this.driversService.updateReview(Number(reviewId), body);
}

@Delete('reviews/:reviewId')
async deleteReview(@Param('reviewId') reviewId: string) {
  await this.driversService.deleteReview(Number(reviewId));
  return { success: true };
}

@Get(':id')
async findOne(@Param('id') id: string) {
  return this.driversService.findOneForWizard(Number(id));
}


  @Put(':id')
  async update(@Param('id') id: string, @Body() body: UpdateDriverDto) {
    return this.driversService.update(Number(id), body);
  }

  /**
   * GET /drivers
   * - Returns list of drivers for listing page
   * - If req.user.vendor_id exists, it will filter by that vendor
   * - Otherwise optional ?vendorId= can be used
   */
  @Get()
  async findAll(@Req() req: any, @Query('vendorId') vendorId?: string) {
    const userVendorId =
      req && req.user && (req.user.vendor_id || req.user.vendorId);

    let resolvedVendorId: number | undefined;
    if (typeof userVendorId === 'number') {
      resolvedVendorId = userVendorId;
    } else if (typeof userVendorId === 'string') {
      const n = Number(userVendorId);
      resolvedVendorId = Number.isNaN(n) ? undefined : n;
    } else if (vendorId) {
      const n = Number(vendorId);
      resolvedVendorId = Number.isNaN(n) ? undefined : n;
    }

    return this.driversService.findAll(resolvedVendorId);
  }

  /**
   * PATCH /drivers/:id/status
   * - Toggle active/inactive from the UI switch
   */
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: UpdateDriverStatusDto,
  ) {
    await this.driversService.updateStatus(Number(id), body.status);
    return { success: true };
  }

  /**
   * DELETE /drivers/:id
   * - Delete driver (used by trash icon)
   */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.driversService.remove(Number(id));
    return { success: true };
  }
}
