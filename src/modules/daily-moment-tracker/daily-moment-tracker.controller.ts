// FILE: src/modules/daily-moment-tracker/daily-moment-tracker.controller.ts

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Patch,
  Delete,
  ParseIntPipe,
  DefaultValuePipe,
  UseInterceptors,
  UploadedFiles,
  UploadedFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FilesInterceptor } from '@nestjs/platform-express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomBytes } from 'crypto';
import * as fs from 'fs';

function resolveDmGalleryDir(): string {
  let dir = __dirname;
  while (dir !== join(dir, '..')) {
    if (fs.existsSync(join(dir, 'package.json'))) break;
    dir = join(dir, '..');
  }
  const dest = join(dir, 'public', 'uploads', 'driver_dailymoment_gallery');
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  return dest;
}

function dmRandomName(original: string) {
  const id = randomBytes(8).toString('hex');
  const ext = extname(original || '');
  return `${Date.now()}-${id}${ext}`;
}

function resolveDmSpeedometerDir(): string {
  let dir = __dirname;
  while (dir !== join(dir, '..')) {
    if (fs.existsSync(join(dir, 'package.json'))) break;
    dir = join(dir, '..');
  }
  const dest = join(dir, 'public', 'uploads', 'driver_speedmeter_gallery');
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  return dest;
}
import { DailyMomentTrackerService } from './daily-moment-tracker.service';
import { Public } from '../../auth/public.decorator';
import {
  ListDailyMomentQueryDto,
  UpsertDailyMomentChargeDto,
  DailyMomentHotspotRowDto,
  UpdateHotspotStatusDto,
  UpdateGuideStatusDto,
  UpdateWholedayGuideStatusDto,
  UpsertDriverRatingDto,
  UpsertGuideRatingDto,
  UpdateActivityStatusDto,
  SaveOpeningKmDto,
  SaveClosingKmDto,
} from './dto/daily-moment-tracker.dto';

@ApiTags('daily-moment-tracker')
@ApiBearerAuth()
@Controller('daily-moment-tracker')
export class DailyMomentTrackerController {
  constructor(private readonly service: DailyMomentTrackerService) {}

 // List of Daily Moment (main grid)
  @Get()
  @ApiOperation({ summary: 'List daily moments (main grid)' })
  async getDailyMoments(@Query() query: ListDailyMomentQueryDto) {
    return this.service.listDailyMoments(query);
  }

 // Day View
@Get('driver-assignment/:driverAssignmentId')
@Public()
@ApiOperation({
  summary: 'Resolve driver assignment ID to itinerary plan ID for share link',
})
async getDriverAssignmentShareDetails(
  @Param('driverAssignmentId', ParseIntPipe)
  driverAssignmentId: number,
) {
  return this.service.getDriverAssignmentShareDetails(driverAssignmentId);
}

@Get('day-view/:planId')
@Public()
@ApiOperation({ summary: 'Full multi-day accordion data for a plan' })
async getDayView(@Param('planId', ParseIntPipe) planId: number) {
  return this.service.getDayView(planId);
}

 // Charges
  @Get('charges')
  @ApiOperation({ summary: 'List extra charges for a day' })
  @ApiQuery({ name: 'itineraryPlanId', required: true, type: Number })
  @ApiQuery({ name: 'itineraryRouteId', required: false, type: Number })
  async getCharges(
    @Query('itineraryPlanId', new DefaultValuePipe(0), ParseIntPipe)
    itineraryPlanId: number,
    @Query('itineraryRouteId', new DefaultValuePipe(0), ParseIntPipe)
    itineraryRouteId: number,
  ) {
    return this.service.listCharges(itineraryPlanId, itineraryRouteId);
  }

  @Post('charges')
  @ApiOperation({ summary: 'Create or update an extra charge' })
  async upsertCharge(@Body() dto: UpsertDailyMomentChargeDto) {
    return this.service.upsertCharge(dto);
  }

  @Delete('charges/:id')
  @ApiOperation({ summary: 'Soft-delete an extra charge' })
  async deleteCharge(@Param('id', ParseIntPipe) id: number) {
    await this.service.deleteCharge(id);
    return { success: true };
  }

 // Driver Ratings
  @Get('driver-ratings')
  @ApiOperation({ summary: 'List driver ratings for itinerary' })
  @ApiQuery({ name: 'itineraryPlanId', required: true, type: Number })
  async getDriverRatings(
    @Query('itineraryPlanId', new DefaultValuePipe(0), ParseIntPipe)
    itineraryPlanId: number,
  ) {
    return this.service.listDriverRatings(itineraryPlanId);
  }

  @Post('driver-ratings')
  @ApiOperation({ summary: 'Create or update a driver rating' })
  async upsertDriverRating(@Body() dto: UpsertDriverRatingDto) {
    return this.service.upsertDriverRating(dto);
  }

  @Delete('driver-ratings/:id')
  @ApiOperation({ summary: 'Soft-delete a driver rating' })
  async deleteDriverRating(@Param('id', ParseIntPipe) id: number) {
    await this.service.deleteDriverRating(id);
    return { success: true };
  }

 // Guide Ratings
  @Get('guide-ratings')
  @ApiOperation({ summary: 'List guide ratings for itinerary' })
  @ApiQuery({ name: 'itineraryPlanId', required: true, type: Number })
  async getGuideRatings(
    @Query('itineraryPlanId', new DefaultValuePipe(0), ParseIntPipe)
    itineraryPlanId: number,
  ) {
    return this.service.listGuideRatings(itineraryPlanId);
  }

  @Post('guide-ratings')
  @ApiOperation({ summary: 'Create or update a guide rating' })
  async upsertGuideRating(@Body() dto: UpsertGuideRatingDto) {
    return this.service.upsertGuideRating(dto);
  }

  @Delete('guide-ratings/:id')
  @ApiOperation({ summary: 'Soft-delete a guide rating' })
  async deleteGuideRating(@Param('id', ParseIntPipe) id: number) {
    await this.service.deleteGuideRating(id);
    return { success: true };
  }

 // Route Hotspots
  @Get('route-hotspots')
  @ApiOperation({ summary: 'List hotspots for a route (Visited / Not Visited)' })
  @ApiQuery({ name: 'itineraryPlanId', required: true, type: Number })
  @ApiQuery({ name: 'itineraryRouteId', required: true, type: Number })
  async getRouteHotspots(
    @Query('itineraryPlanId', new DefaultValuePipe(0), ParseIntPipe)
    itineraryPlanId: number,
    @Query('itineraryRouteId', new DefaultValuePipe(0), ParseIntPipe)
    itineraryRouteId: number,
  ): Promise<DailyMomentHotspotRowDto[]> {
    return this.service.listRouteHotspots(itineraryPlanId, itineraryRouteId);
  }

 // Status Updates
  @Patch('hotspot-status')
  @ApiOperation({ summary: 'Update driver hotspot visit status' })
  async updateHotspotStatus(@Body() dto: UpdateHotspotStatusDto) {
    await this.service.updateHotspotStatus({
      confirmedRouteHotspotId: dto.confirmedRouteHotspotId,
      status: dto.status,
      description: dto.description,
      perspective: 'driver',
    });
    return { success: true };
  }

  @Patch('guide-hotspot-status')
  @ApiOperation({ summary: 'Update guide hotspot visit status' })
  async updateGuideHotspotStatus(@Body() dto: UpdateHotspotStatusDto) {
    await this.service.updateHotspotStatus({
      confirmedRouteHotspotId: dto.confirmedRouteHotspotId,
      status: dto.status,
      description: dto.description,
      perspective: 'guide',
    });
    return { success: true };
  }

  @Patch('activity-status')
  @ApiOperation({ summary: 'Update driver activity visit status' })
  async updateActivityStatus(@Body() dto: UpdateActivityStatusDto) {
    await this.service.updateActivityStatus({
      confirmedRouteActivityId: dto.confirmedRouteActivityId,
      status: dto.status,
      description: dto.description,
      perspective: 'driver',
    });
    return { success: true };
  }

  @Patch('guide-activity-status')
  @ApiOperation({ summary: 'Update guide activity visit status' })
  async updateGuideActivityStatus(@Body() dto: UpdateActivityStatusDto) {
    await this.service.updateActivityStatus({
      confirmedRouteActivityId: dto.confirmedRouteActivityId,
      status: dto.status,
      description: dto.description,
      perspective: 'guide',
    });
    return { success: true };
  }

  @Patch('guide-status')
  @ApiOperation({ summary: 'Update per-route guide visit status' })
  async updateGuideStatus(@Body() dto: UpdateGuideStatusDto) {
    await this.service.updateGuideStatus({
      confirmedRouteGuideId: dto.confirmedRouteGuideId,
      status: dto.status,
      description: dto.description,
    });
    return { success: true };
  }

  @Patch('wholeday-guide-status')
  @ApiOperation({ summary: 'Update whole-day guide visit status on a route' })
  async updateWholedayGuideStatus(@Body() dto: UpdateWholedayGuideStatusDto) {
    await this.service.updateWholedayGuideStatus({
      confirmedItineraryRouteId: dto.confirmedItineraryRouteId,
      status: dto.status,
      description: dto.description,
    });
    return { success: true };
  }

 // Day Images
  @Post('day-images')
  @ApiOperation({ summary: 'Upload driver day images for a route' })
  @UseInterceptors(
    FilesInterceptor('images', 20, {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, resolveDmGalleryDir()),
        filename: (_req, file, cb) => cb(null, dmRandomName(file.originalname)),
      }),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
 const ok = /^image\//.test(file.mimetype);
 cb(ok ? null : new Error('Only image/* files are allowed'), ok);
      },
    }),
  )
  async uploadDayImages(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('itineraryPlanId') itineraryPlanId: string,
    @Body('itineraryRouteId') itineraryRouteId: string,
    @Body('createdby') createdby?: string,
  ) {
    return this.service.saveDayImages(
      Number(itineraryPlanId),
      Number(itineraryRouteId),
      files,
      Number(createdby ?? 0),
    );
  }

  @Post('kilometer/opening-image')
  @ApiOperation({ summary: 'Upload opening speedometer image for a route' })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, resolveDmSpeedometerDir()),
        filename: (_req, file, cb) => cb(null, dmRandomName(file.originalname)),
      }),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
 const ok = /^image\//.test(file.mimetype);
 cb(ok ? null : new Error('Only image/* files are allowed'), ok);
      },
    }),
  )
  async uploadOpeningSpeedometerImage(
    @UploadedFile() file: Express.Multer.File,
    @Body('itineraryPlanId') itineraryPlanId: string,
    @Body('itineraryRouteId') itineraryRouteId: string,
  ) {
    return this.service.saveOpeningKmImage(
      Number(itineraryPlanId),
      Number(itineraryRouteId),
      file,
    );
  }

  @Post('kilometer/closing-image')
  @ApiOperation({ summary: 'Upload closing speedometer image for a route' })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, resolveDmSpeedometerDir()),
        filename: (_req, file, cb) => cb(null, dmRandomName(file.originalname)),
      }),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
 const ok = /^image\//.test(file.mimetype);
 cb(ok ? null : new Error('Only image/* files are allowed'), ok);
      },
    }),
  )
  async uploadClosingSpeedometerImage(
    @UploadedFile() file: Express.Multer.File,
    @Body('itineraryPlanId') itineraryPlanId: string,
    @Body('itineraryRouteId') itineraryRouteId: string,
  ) {
    return this.service.saveClosingKmImage(
      Number(itineraryPlanId),
      Number(itineraryRouteId),
      file,
    );
  }

 // Kilometer
  @Post('kilometer/opening')
  @ApiOperation({ summary: 'Save opening (starting) kilometer for a route' })
  async saveOpeningKm(@Body() dto: SaveOpeningKmDto) {
    await this.service.saveOpeningKm(dto);
    return { success: true };
  }

  @Post('kilometer/closing')
  @ApiOperation({ summary: 'Save closing kilometer and mark route completed' })
  async saveClosingKm(@Body() dto: SaveClosingKmDto) {
    await this.service.saveClosingKm(dto);
    return { success: true };
  }
}
