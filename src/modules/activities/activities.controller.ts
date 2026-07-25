// FILE: src/modules/activities/activities.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActivitiesService } from './activities.service';
import { CreateActivityDto } from './dto/create-activity.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';
import { SaveTimeSlotsDto } from './dto/save-timeslots.dto';
import { SavePriceBookDto } from './dto/save-pricebook.dto';
import { SaveReviewDto } from './dto/save-review.dto';
import { ToggleStatusDto } from './dto/toggle-status.dto';
import { ActivityStorefrontQueryDto } from './dto/activity-storefront-query.dto';
import { CreateActivityBookingDto } from './dto/create-activity-booking.dto';

// NEW: Multer imports (non-breaking)
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomBytes } from 'crypto';
import * as fs from 'fs';

function resolveBackendRoot(): string {
 // Walk up from __dirname until we find package.json at the api root
  let dir = __dirname;
  while (dir !== join(dir, '..')) {
    if (fs.existsSync(join(dir, 'package.json'))) return dir;
    dir = join(dir, '..');
  }
  return process.cwd();
}

// Activity gallery stored alongside hotspot_gallery under public/uploads
function activityGalleryDir(): string {
  const dir = join(resolveBackendRoot(), 'public', 'uploads', 'activity_gallery');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Helper to generate unique file names
function randomName(original: string) {
  const id = randomBytes(8).toString('hex');
  const ext = extname(original || '');
  return `${Date.now()}-${id}${ext}`;
}

@ApiTags('activities')
@ApiBearerAuth()
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly service: ActivitiesService) {}

 // === LIST (DataTables style shape, but clean JSON) ===
  @Get()
  async list(@Query('q') q?: string, @Query('status') status?: '0' | '1') {
    return this.service.list({ q, status: status as any });
  }

 // === HOTSPOTS (for dropdown) ===
  @Get('hotspots')
  async hotspots(@Query('q') q?: string) {
    return this.service.hotspots(q);
  }

 // Keep static storefront routes above dynamic :id routes.
  @Get('storefront/categories')
  async storefrontCategories() {
    return this.service.getStorefrontCategories();
  }

  @Get('storefront/locations')
  async storefrontLocations(@Query('q') q?: string) {
    return this.service.getStorefrontActivityLocations(q);
  }

  @Get('storefront/agents')
  async storefrontAgents() {
    return this.service.getStorefrontAgents();
  }

  @Get('storefront/agents/:agentId/wallet')
  async storefrontAgentWallet(@Param('agentId', ParseIntPipe) agentId: number) {
    return this.service.getStorefrontAgentWallet(agentId);
  }

  @Get('storefront/wishlist')
  async storefrontWishlist(@Query('userKey') userKey?: string) {
    return this.service.getStorefrontWishlist(userKey);
  }

  @Post('storefront/wishlist/toggle')
  async toggleStorefrontWishlist(
    @Body() body: { activityId: number; userKey?: string },
  ) {
    return this.service.toggleStorefrontWishlist(body);
  }

  @Delete('storefront/wishlist/:activityId')
  async removeStorefrontWishlist(
    @Param('activityId', ParseIntPipe) activityId: number,
    @Query('userKey') userKey?: string,
  ) {
    return this.service.removeStorefrontWishlist(activityId, userKey);
  }

  @Get('storefront/bookings')
  async storefrontBookings(
    @Query('agentId') agentId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getStorefrontBookings({ agentId, status, q, limit });
  }

  @Get('storefront')
  async storefront(@Query() query: ActivityStorefrontQueryDto) {
    return this.service.getStorefrontActivities(query);
  }

  @Post('storefront/bookings')
  async createStorefrontBooking(@Body() dto: CreateActivityBookingDto) {
    return this.service.createStorefrontBooking(dto);
  }

 // === BASIC INFO (Create) ===
  @Post()
  async create(@Body() dto: CreateActivityDto) {
    return this.service.createActivity(dto);
  }

 // === BASIC INFO (Update) ===
  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateActivityDto) {
    return this.service.updateActivity(id, dto);
  }

 // === STATUS TOGGLE ===
  @Patch(':id/status')
  async toggleStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: ToggleStatusDto) {
    return this.service.toggleStatus(id, dto.status);
  }

 // === DELETE (soft) ===
  @Delete(':id')
  async softDelete(@Param('id', ParseIntPipe) id: number) {
    return this.service.softDelete(id);
  }

 // === GALLERY (existing JSON-based insert; kept as-is) ===
  @Post(':id/images')
  async addImages(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { imageNames: string[]; createdby?: number },
  ) {
    return this.service.addImages(id, body.imageNames ?? [], body.createdby ?? 0);
  }

 // NEW: GALLERY (multipart upload to /uploads + DB save of filenames)
 // Route name chosen to avoid breaking existing /:id/images JSON endpoint
  @Post(':id/images/upload')
  @UseInterceptors(
    FilesInterceptor('images', 12, {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, activityGalleryDir()),
        filename: (_req, file, cb) => cb(null, randomName(file.originalname)),
      }),
 limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
      fileFilter: (_req, file, cb) => {
 const ok = /^image\//.test(file.mimetype);
 cb(ok ? null : new Error('Only image/* files are allowed'), ok);
      },
    }),
  )
  async uploadImages(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('createdby') createdby?: string,
  ) {
    const creator = Number(createdby ?? 0);
 // Persist filenames in dvi_activity_image_gallery_details
    return this.service.saveUploadedImages(id, files, creator);
  }

  @Delete(':id/images/:imageId')
  async deleteImage(
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    return this.service.deleteImage(id, imageId);
  }

 // === TIME SLOTS (default + special) ===
  @Post(':id/time-slots')
  async saveTimeSlots(@Param('id', ParseIntPipe) id: number, @Body() dto: SaveTimeSlotsDto) {
    return this.service.saveTimeSlots(id, dto);
  }

 // === PRICE BOOK (month rows with day_1..day_31) ===
  @Get(':id/pricebook')
  async getPriceBook(@Param('id', ParseIntPipe) id: number) {
    return this.service.getPriceBook(id);
  }

  @Post(':id/pricebook')
  async savePriceBook(@Param('id', ParseIntPipe) id: number, @Body() dto: SavePriceBookDto) {
    return this.service.savePriceBook(id, dto);
  }

 // === REVIEWS ===
  @Post(':id/reviews')
  async addReview(@Param('id', ParseIntPipe) id: number, @Body() dto: SaveReviewDto) {
    return this.service.addOrUpdateReview(id, dto);
  }

  @Put(':id/reviews/:reviewId')
  async updateReview(
    @Param('id', ParseIntPipe) id: number,
    @Param('reviewId', ParseIntPipe) reviewId: number,
    @Body() dto: SaveReviewDto,
  ) {
    return this.service.addOrUpdateReview(id, { ...dto, reviewId });
  }

  @Delete(':id/reviews/:reviewId')
  async deleteReview(
    @Param('id', ParseIntPipe) id: number,
    @Param('reviewId', ParseIntPipe) reviewId: number,
  ) {
    return this.service.deleteReview(id, reviewId);
  }

 // === PREVIEW (aggregate read) ===
  @Get(':id/preview')
  async preview(@Param('id', ParseIntPipe) id: number) {
    return this.service.preview(id);
  }

 // === DETAILS (basic info + gallery + latest slots) ===
  @Get(':id')
  async details(@Param('id', ParseIntPipe) id: number) {
    return this.service.details(id);
  }
}
