// FILE: src/modules/hotels/hotels.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  ParseIntPipe,
  DefaultValuePipe,
  BadRequestException,
  Req,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { Express } from 'express';
import { HotelsService } from './hotels.service';
import { PaginationQueryDto } from './dto/pagination.dto';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';

/* =======================================================================================
 * DTOs
 * =======================================================================================
 */
class UpsertHotelMealPriceBookDto {
  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  breakfastCost?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lunchCost?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dinnerCost?: number;
}

class UpsertAmenityPricebookDto {
  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  hoursCharge?: number | string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dayCharge?: number | string;
}

class BulkRoomPricebookItemDto {
  @Type(() => Number)
  @IsInt()
  room_id!: number;

  @IsDateString()
  startDate!: string | Date;

  @IsDateString()
  endDate!: string | Date;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  roomPrice?: number | string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  extraBed?: number | string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  childWithBed?: number | string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  childWithoutBed?: number | string;

  @IsOptional()
  @IsString()
  axisroomsRoomId?: string;

  @IsOptional()
  @IsString()
  rateplanId?: string;

  @IsOptional()
  @IsString()
  ratePlanName?: string;
}

class BulkRoomPricebookDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkRoomPricebookItemDto)
  items!: BulkRoomPricebookItemDto[];
}

/** Minimal DTO for reviews */
class ReviewDto {
  rating?: string | number;
  description?: string;
  status?: number;
}
@ApiTags('hotels')
@ApiBearerAuth()          // <-- uses default 'bearer'
@Controller('hotels')
export class HotelsController {
  constructor(private readonly hotels: HotelsService) {}

  // =============================================================================
  // Listing & basic helpers
  // =============================================================================
  @Get()
  list(@Query() q: PaginationQueryDto) {
    return this.hotels.list(q);
  }

  @Get('options')
  options(@Query('q') q = '', @Query('limit') limit?: string) {
    return this.hotels.options(q, Number(limit ?? 50));
  }

  @Get('categories')
  getCategories() {
    return this.hotels.getCategories();
  }

  @Get('meta/countries')
  countries() {
    return this.hotels.countries();
  }

  @Get('meta/states')
  states(@Query('countryId') countryId: string, @Query('all') all?: string) {
    if (String(all) === '1') return this.hotels.statesAll();
    return this.hotels.states(Number(countryId));
  }

  @Get('meta/cities')
  cities(@Query('stateId') stateId: string, @Query('all') all?: string) {
    if (String(all) === '1') return this.hotels.citiesAll();
    return this.hotels.cities(Number(stateId));
  }

  @Get('meta/states/:id')
  stateById(@Param('id') id: string) {
    return this.hotels.stateById(Number(id));
  }

  @Get('meta/cities/:id')
  cityById(@Param('id') id: string) {
    return this.hotels.cityById(Number(id));
  }

  @Get('meta/gst/types')
  gstTypes() {
    return this.hotels.gstTypes();
  }

  @Get('meta/gst/percentages')
  gstPercentages() {
    return this.hotels.gstPercentages();
  }

  @Get('inbuilt-amenities')
  inbuiltAmenities() {
    return this.hotels.inbuiltAmenities();
  }

  @Get('derived/cities-by-state')
  citiesByState(@Query('state') state: string) {
    return this.hotels.citiesByState(state);
  }

  @Get('code')
  generateCode(@Query('cityId') cityId?: string, @Query('city') city?: string) {
    const key = city ?? cityId ?? '';
    return this.hotels.generateCode(key);
  }

  @Get('room-types')
  roomTypes() {
    return this.hotels.roomTypes();
  }

  // NEW: simple meal types meta (1=B, 2=L, 3=D)
  @Get('meal-types')
  mealTypes() {
    return this.hotels.mealTypes();
  }

  @Get(':id/roomtypes')
  roomTypesAliasPlain(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.roomTypesByHotel(id);
  }

  @Get(':id/room-types')
  roomTypesAliasKebab(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.roomTypesByHotel(id);
  }

  // =============================================================================
  // Core Hotel CRUD
  // =============================================================================
  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.getOne(id);
  }

  @Post()
  create(@Body() dto: CreateHotelDto) {
    const payload: any = { ...dto };
    const catId =
      Number(
        (dto as any)?.hotel_category ??
          (dto as any)?.hotel_category_id ??
          (dto as any)?.categoryId ??
          (dto as any)?.hotelCategoryId,
      ) || 0;
    if (catId > 0) payload.hotel_category = catId;
    return this.hotels.create(payload);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateHotelDto) {
    const payload: any = { ...dto };
    const hasCat =
      Object.prototype.hasOwnProperty.call(dto, 'hotel_category') ||
      Object.prototype.hasOwnProperty.call(dto, 'hotel_category_id') ||
      Object.prototype.hasOwnProperty.call(dto, 'categoryId') ||
      Object.prototype.hasOwnProperty.call(dto, 'hotelCategoryId');

    if (hasCat) {
      const catId =
        Number(
          (dto as any)?.hotel_category ??
            (dto as any)?.hotel_category_id ??
            (dto as any)?.categoryId ??
            (dto as any)?.hotelCategoryId,
        ) || 0;
      if (catId > 0) payload.hotel_category = catId;
    }
    return this.hotels.update(id, payload);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.remove(id);
  }

  // =============================================================================
  // Step 2: Rooms
  // =============================================================================

  @Get(':id/rooms')
  listRooms(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.listRooms(id);
  }

  // NEW: bulk rooms endpoint used by React RoomsStep
  // POST /api/v1/hotels/:id/rooms/bulk  with body: { items: [ { ...roomPayload } ] }
  @Post(':id/rooms/bulk')
  async saveRoomsBulk(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    const items: any[] = Array.isArray(body?.items)
      ? body.items
      : Array.isArray(body)
      ? body
      : [];

    if (!items.length) {
      throw new BadRequestException('items array is required');
    }

    const results: any[] = [];
    const errors: any[] = [];
    for (const raw of items) {
      const payload = { ...(raw ?? {}), hotel_id: id };
      try {
        const res = await this.hotels.saveRoom(payload as any);
        results.push(res);
      } catch (e: any) {
        errors.push({
          room_id: payload?.room_id ?? payload?.room_ID ?? null,
          message: e?.message || 'Failed to save room row',
        });
      }
    }

    if (!results.length) {
      throw new BadRequestException(
        errors[0]?.message || 'Failed to save rooms',
      );
    }

    return {
      success: true,
      count: results.length,
      items: results,
      failedCount: errors.length,
      errors,
    };
  }

  @Post(':id/rooms')
  createRoom(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.hotels.addRoom({ ...(body ?? {}), hotel_id: id } as any);
  }

  @Patch(':id/rooms/:roomId')
  updateRoom(
    @Param('id', ParseIntPipe) id: number,
    @Param('roomId') roomId: string,
    @Body() body: any,
  ) {
    const rid = Number(roomId);
    return this.hotels.updateRoom({
      ...(body ?? {}),
      hotel_id: id,
      room_ID: rid,
    } as any);
  }

  @Delete(':id/rooms/:roomId')
  removeRoom(
    @Param('id', ParseIntPipe) id: number,
    @Param('roomId') roomId: string,
  ) {
    return this.hotels.removeRoom(id, Number(roomId));
  }

  // === NEW: Room gallery upload (files saved & DB rows inserted in service) =====
  // POST /api/v1/hotels/:id/rooms/:roomId/gallery
  // - multipart/form-data
  // - field name for files: room_gallery
  // - body should contain roomRefCode or room_ref_code
  @Post(':id/rooms/:roomId/gallery')
  @UseInterceptors(
    FilesInterceptor('room_gallery', 20, {
      dest: 'uploads/tmp-room-gallery',
    }),
  )
  async uploadRoomGallery(
    @Param('id', ParseIntPipe) id: number,
    @Param('roomId', ParseIntPipe) roomId: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any,
    @Req() req: any,
  ) {
    const roomRefCode: string = body?.roomRefCode ?? body?.room_ref_code;

    if (!roomRefCode) {
      throw new BadRequestException('roomRefCode (or room_ref_code) is required');
    }

    const userId =
      Number(req?.user?.id) ||
      Number(req?.user?.user_id) ||
      Number(req?.userId) ||
      0;

    await this.hotels.saveRoomGallery({
      hotelId: id,
      roomId,
      roomRefCode,
      files: files || [],
      createdBy: userId || 0,
    });

    return { success: true };
  }

  @Post('/rooms')
  saveRoomFromRoot(@Body() body: any) {
    return this.hotels.saveRoom(body);
  }

  @Get('rooms/pref-for')
  roomPrefFor() {
    return ['Family', 'Friends', 'Adults', 'Couples'];
  }

  // =============================================================================
  // Step 3: Amenities
  // =============================================================================

  /** Hotel amenities list */
  @Get(':id/amenities')
  listAmenities(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.listAmenities(id);
  }

  /** Create amenity (single or bulk detection) */
  @Post(':id/amenities')
  async addAmenity(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    if (Array.isArray(body?.items)) {
      return this.hotels.addAmenitiesBulk(id, body.items);
    }
    return this.hotels.addAmenity({ ...(body ?? {}), hotel_id: id } as any);
  }

  /** Explicit bulk endpoint to match UI call: POST /api/v1/hotels/:id/amenities/bulk */
  @Post(':id/amenities/bulk')
  addAmenityBulk(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const items = Array.isArray(body?.items)
      ? body.items
      : Array.isArray(body)
      ? body
      : [];
    return this.hotels.addAmenitiesBulk(id, items);
  }

  @Patch(':id/amenities/:amenityId')
  updateAmenity(
    @Param('id', ParseIntPipe) id: number,
    @Param('amenityId') amenityId: string,
    @Body() body: any,
  ) {
    return this.hotels.updateAmenity({
      ...(body ?? {}),
      hotel_id: id,
      amenity_id: Number(amenityId),
    } as any);
  }

  @Delete(':id/amenities/:amenityId')
  removeAmenity(
    @Param('id', ParseIntPipe) id: number,
    @Param('amenityId') amenityId: string,
  ) {
    return this.hotels.removeAmenity(id, Number(amenityId));
  }

  /** SINGLE amenity details for UI header on pricebook card */
  @Get(':id/amenities/:amenityId/detail')
  async amenityDetail(
    @Param('id', ParseIntPipe) id: number,
    @Param('amenityId') amenityId: string,
  ) {
    const rows = (await this.hotels.listAmenities(id)) as any[];
    const found = rows.find(
      (r) =>
        Number(r.hotel_amenities_id ?? r.amenity_id ?? r.id) ===
        Number(amenityId),
    );
    if (!found) {
      throw new BadRequestException('Amenity not found for this hotel');
    }
    return {
      id: Number(found.hotel_amenities_id ?? found.amenity_id ?? found.id),
      name: found.amenities_title ?? found.amenities_code ?? 'Amenity',
      code: found.amenities_code ?? null,
    };
  }

  /** Amenities pricebook writer (hours/day) across date range */
  @Post(':id/amenities/:amenityId/pricebook')
  upsertAmenityPricebook(
    @Param('id', ParseIntPipe) id: number,
    @Param('amenityId') amenityId: string,
    @Body() dto: UpsertAmenityPricebookDto,
  ) {
    return this.hotels.upsertAmenitiesPricebookRange(id, {
      hotel_amenities_id: Number(amenityId),
      startDate: dto.startDate,
      endDate: dto.endDate,
      hoursCharge: dto.hoursCharge,
      dayCharge: dto.dayCharge,
    });
  }

  // =============================================================================
  // Step 4: Price Book (Rate Plans)
  // =============================================================================
  @Get(':id/pricebook')
  getPricebook(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.getPricebook(id);
  }

  @Get(':id/price-book')
  getPricebookAlias(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.getPricebook(id);
  }

  @Post(':id/pricebook')
  addPrice(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.hotels.addPrice({ ...(body ?? {}), hotel_id: id } as any);
  }

  @Patch(':id/pricebook')
  upsertPricebook(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.hotels.upsertPricebook(id, body ?? {});
  }

  /** Bulk room pricebook */
  @Post(':id/rooms/pricebook/bulk')
  bulkRoomPricebook(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BulkRoomPricebookDto,
  ) {
    return this.hotels.bulkUpsertRoomPricebook(id, dto);
  }

  // =============================================================================
  // Step 4A: Meal Price Book
  // =============================================================================

  @Post(':hotelId/meal-pricebook')
  upsertMealPriceBookPrimary(
    @Param('hotelId', ParseIntPipe) hotelId: number,
    @Body() dto: UpsertHotelMealPriceBookDto,
    @Req() _req: any,
  ) {
    return this.hotels.upsertMealPricebook(hotelId, dto);
  }

  @Post('meal-pricebook/:hotelId')
  upsertMealPriceBookAliasParam(
    @Param('hotelId', ParseIntPipe) hotelId: number,
    @Body() dto: UpsertHotelMealPriceBookDto,
    @Req() _req: any,
  ) {
    return this.hotels.upsertMealPricebook(hotelId, dto);
  }

  // =============================================================================
  // Step 5: Reviews (new)
  // =============================================================================

  /** GET /api/v1/hotels/:id/reviews */
  @Get(':id/reviews')
  listReviews(@Param('id', ParseIntPipe) id: number) {
    return this.hotels.listReviews(id);
  }

  /** POST /api/v1/hotels/:id/reviews  (UI primary) */
@Post(':id/reviews')
addReviewForHotel(
  @Param('id', ParseIntPipe) id: number,
  @Body() body: any,
  @Req() req: any,
) {
  return this.hotels.addReviewUnified(
    {
      ...(body ?? {}),
      hotel_id: id,
      hotelId: id,
    },
    Number(req?.user?.id) || 1,
  );
}


  /** Alias: POST /api/v1/hotels/:id/feedback */
  @Post(':id/feedback')
addFeedbackAlias(
  @Param('id', ParseIntPipe) id: number,
  @Body() body: any,
  @Req() req: any,
) {
  return this.hotels.addReviewUnified(
    {
      ...(body ?? {}),
      hotel_id: id,
      hotelId: id,
    },
    Number(req?.user?.id) || 1,
  );
}

  /** Root POST for cases where UI sends { hotel_id, ... } to /api/v1/hotels/reviews */
 @Post('reviews')
addReviewRoot(
  @Body() body: any,
  @Req() req: any,
) {
  const hid = Number(body?.hotel_id ?? body?.hotelId);
  if (!Number.isFinite(hid) || hid <= 0) {
    throw new BadRequestException('hotel_id is required');
  }

  return this.hotels.addReviewUnified(
    {
      ...(body ?? {}),
      hotel_id: hid,
      hotelId: hid,
    },
    Number(req?.user?.id) || 1,
  );
}

  /** PATCH /api/v1/hotels/:id/reviews/:reviewId */
  @Patch(':id/reviews/:reviewId')
  updateReview(
    @Param('id', ParseIntPipe) id: number,
    @Param('reviewId', ParseIntPipe) reviewId: number,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.hotels.updateReviewUnified(
      reviewId,
      id,
      body,
      Number(req?.user?.id) || 1,
    );
  }

  /** DELETE /api/v1/hotels/:id/reviews/:reviewId */
  @Delete(':id/reviews/:reviewId')
  removeReview(
    @Param('id', ParseIntPipe) id: number,
    @Param('reviewId', ParseIntPipe) reviewId: number,
  ) {
    return this.hotels.removeReview(id, reviewId);
  }
}

// ---------- Aliases & preview endpoints ----------
@Controller('locations')
export class LocationsController {
  constructor(private readonly hotels: HotelsService) {}

  @Get('states')
  async allStates(
    @Query('all') all?: string,
    @Query('countryId') countryId?: string,
  ) {
    if (String(all) === '1') {
      return this.hotels.statesAll();
    }
    return this.hotels.states(Number(countryId ?? 0));
  }

  @Get('cities')
  async allCities(
    @Query('all') all?: string,
    @Query('stateId') stateId?: string,
  ) {
    if (String(all) === '1') {
      return this.hotels.citiesAll();
    }
    return this.hotels.cities(Number(stateId ?? 0));
  }
}

@Controller('states')
export class RootStatesController {
  constructor(private readonly hotels: HotelsService) {}

  @Get()
  async rootStates(
    @Query('all') all?: string,
    @Query('countryId') countryId?: string,
  ) {
    if (String(all) === '1') {
      return this.hotels.statesAll();
    }
    return this.hotels.states(Number(countryId ?? 0));
  }
}

@Controller('cities')
export class RootCitiesController {
  constructor(private readonly hotels: HotelsService) {}

  @Get()
  async rootCities(
    @Query('all') all?: string,
    @Query('stateId') stateId?: string,
  ) {
    if (String(all) === '1') {
      return this.hotels.citiesAll();
    }
    return this.hotels.cities(Number(stateId ?? 0));
  }
}

@Controller('dvi')
export class DviGeoController {
  constructor(private readonly hotels: HotelsService) {}

  @Get('states')
  async dviStates(
    @Query('all') all?: string,
    @Query('countryId') countryId?: string,
  ) {
    if (String(all) === '1') {
      return this.hotels.statesAll();
    }
    return this.hotels.states(Number(countryId ?? 0));
  }

  @Get('cities')
  async dviCities(
    @Query('all') all?: string,
    @Query('stateId') stateId?: string,
  ) {
    if (String(all) === '1') {
      return this.hotels.citiesAll();
    }
    return this.hotels.cities(Number(stateId ?? 0));
  }
}

@Controller()
export class PreviewAliasesController {
  constructor(private readonly hotels: HotelsService) {}

  // PHP JSON parity aliases:
  // - engine/json/__JSONsearchhotel.php?phrase=...
  // - engine/json/__JSONsearchroomtype.php?phrase=...
  @Get('json/searchhotel')
  searchHotelNames(@Query('phrase') phrase = '') {
    return this.hotels.searchHotelNames(phrase);
  }

  @Get('json/searchroomtype')
  searchRoomTypeNames(@Query('phrase') phrase = '') {
    return this.hotels.searchRoomTypeNames(phrase);
  }

  // ===== Amenities aliases that your UI calls =====

  // GET /api/v1/hotel-amenities?hotelId=119
  @Get('hotel-amenities')
  listAmenitiesByQuery(
    @Query('hotelId', new DefaultValuePipe('')) hotelId: string,
  ) {
    const id = Number(hotelId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new BadRequestException(
        'Validation failed (numeric string is expected)',
      );
    }
    return this.hotels.listAmenities(id);
  }

  // GET /api/v1/hotel-amenities/119
  @Get('hotel-amenities/:hotelId')
  listAmenitiesByParam(@Param('hotelId', ParseIntPipe) hotelId: number) {
    return this.hotels.listAmenities(hotelId);
  }

  // POST /api/v1/hotel-amenities  (single or bulk)
  @Post('hotel-amenities')
  addAmenityRoot(@Body() body: any) {
    const hotelId = Number(body?.hotel_id ?? body?.hotelId);
    if (!Number.isFinite(hotelId) || hotelId <= 0) {
      throw new BadRequestException('hotel_id is required');
    }
    if (Array.isArray(body?.items)) {
      return this.hotels.addAmenitiesBulk(hotelId, body.items);
    }
    return this.hotels.addAmenity({ ...(body ?? {}), hotel_id: hotelId } as any);
  }

  // POST /api/v1/hotel-amenities/bulk
  @Post('hotel-amenities/bulk')
  addAmenityRootBulk(@Body() body: any) {
    const hotelId = Number(body?.hotel_id ?? body?.hotelId);
    const items = Array.isArray(body?.items)
      ? body.items
      : Array.isArray(body)
      ? body
      : [];
    if (!Number.isFinite(hotelId) || hotelId <= 0) {
      throw new BadRequestException('hotel_id is required');
    }
    return this.hotels.addAmenitiesBulk(hotelId, items);
  }

  // ===== Pricebook preview aliases =====

  @Get('pricebook')
  getPricebookByQuery(
    @Query('hotelId', new DefaultValuePipe('')) hotelId: string,
  ) {
    const id = Number(hotelId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new BadRequestException(
        'Validation failed (numeric string is expected)',
      );
    }
    return this.hotels.getPricebook(id);
  }

  @Post('hotel-meal-pricebook')
  upsertHotelMealPriceBookByQuery(
    @Query('hotelId', new DefaultValuePipe('')) hotelId: string,
    @Body() dto: UpsertHotelMealPriceBookDto,
    @Req() _req: any,
  ) {
    const id = Number(hotelId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new BadRequestException(
        'Validation failed (numeric string is expected)',
      );
    }
    return this.hotels.upsertMealPricebook(id, dto);
  }

  @Post('hotel-amenities-pricebook')
  upsertAmenityPricebookByQuery(
    @Query('hotelId', new DefaultValuePipe('')) hotelId: string,
    @Query('amenityId', new DefaultValuePipe('')) amenityId: string,
    @Body() dto: UpsertAmenityPricebookDto,
  ) {
    const hid = Number(hotelId);
    const aid = Number(amenityId);
    if (
      !Number.isFinite(hid) ||
      hid <= 0 ||
      !Number.isFinite(aid) ||
      aid <= 0
    ) {
      throw new BadRequestException(
        'Validation failed (numeric string is expected)',
      );
    }
    return this.hotels.upsertAmenitiesPricebookRange(hid, {
      hotel_amenities_id: aid,
      startDate: dto.startDate,
      endDate: dto.endDate,
      hoursCharge: dto.hoursCharge,
      dayCharge: dto.dayCharge,
    });
  }
}
