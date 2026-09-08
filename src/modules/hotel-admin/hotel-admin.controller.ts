import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
} from '@nestjs/swagger';
import { FilesInterceptor } from '@nestjs/platform-express';
import { HotelAdminGuard } from './guards/hotel-admin.guard';
import { HotelAdminService } from './hotel-admin.service';
import { HotelAdminReadService } from './hotel-admin-read.service';
import {
  CreateHotelAdminUserDto,
  SetHotelAdminPermissionsDto,
  UpdateHotelAdminUserDto,
} from './dto/hotel-admin-user.dto';

@ApiTags('Hotel Admin')
@ApiBearerAuth()
@Controller('hotel-admin')
@UseGuards(HotelAdminGuard)
export class HotelAdminController {
  constructor(
    private readonly service:
      HotelAdminService,
    private readonly readService:
      HotelAdminReadService,
  ) {}

  @Get('me')
  getMe(@Req() req: any) {
    return this.readService.getContext(
      req.user?.userId,
    );
  }

  @Get('dashboard')
  dashboard(@Req() req: any) {
    return this.readService.getDashboard(
      req.user?.userId,
    );
  }

  @Get('hotels')
  hotels(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('hotel_state') hotelState?: string,
    @Query('hotel_city') hotelCity?: string,
    @Query('provider') provider?: string,
  ) {
    return this.readService.listHotels(
      req.user?.userId,
      {
        page,
        limit,
        search,
        hotel_state: hotelState,
        hotel_city: hotelCity,
        provider,
      },
    );
  }

  @Post('hotels')
  createHotel(
    @Req() req: any,
    @Body() body: any,
  ) {
    return this.service.createHotel(
      req.user?.userId,
      body,
    );
  }

  @Get('hotels/:hotelId')
  hotel(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
  ) {
    return this.service.getHotel(
      req.user?.userId,
      hotelId,
    );
  }

  @Patch('hotels/:hotelId')
  updateHotel(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.updateHotel(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Delete('hotels/:hotelId')
  deleteHotel(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
  ) {
    return this.service.deleteHotel(
      req.user?.userId,
      hotelId,
    );
  }
  // HOTEL_ADMIN_ALL_ROOMS_ROUTE
  @Get('rooms')
  allRooms(
    @Req() req: any,

    @Query('page')
    page?: string,

    @Query('limit')
    limit?: string,

    @Query('search')
    search?: string,
  ) {
    return this.readService
      .listRoomsIndex(
        req.user?.userId,
        {
          page,
          limit,
          search,
        },
      );
  }
  @Get('hotels/:hotelId/rooms')
  rooms(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
  ) {
    return this.service.listRooms(
      req.user?.userId,
      hotelId,
    );
  }

  @Post('hotels/:hotelId/rooms')
  createRoom(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.createRoom(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Patch(
    'hotels/:hotelId/rooms/:roomId',
  )
  updateRoom(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Param(
      'roomId',
      ParseIntPipe,
    )
    roomId: number,
    @Body() body: any,
  ) {
    return this.service.updateRoom(
      req.user?.userId,
      hotelId,
      roomId,
      body,
    );
  }

  @Delete(
    'hotels/:hotelId/rooms/:roomId',
  )
  deleteRoom(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Param(
      'roomId',
      ParseIntPipe,
    )
    roomId: number,
  ) {
    return this.service.deleteRoom(
      req.user?.userId,
      hotelId,
      roomId,
    );
  }

  @Get(
    'hotels/:hotelId/rooms/:roomId/rate-plans',
  )
  ratePlans(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Param(
      'roomId',
      ParseIntPipe,
    )
    roomId: number,
  ) {
    return this.service.listRatePlans(
      req.user?.userId,
      hotelId,
      roomId,
    );
  }
  @Get('hotels/:hotelId/rates')
  rates(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Query('startDate')
    startDate: string,
    @Query('endDate')
    endDate: string,
    @Query('roomId')
    roomId: string,
    @Query('rateplanId')
    rateplanId: string,
  ) {
    return this.service.getRates(
      req.user?.userId,
      hotelId,
      {
        startDate,
        endDate,
        roomId:
          Number(roomId),
        rateplanId,
      },
    );
  }

  @Post('hotels/:hotelId/rates')
  saveRates(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.saveRates(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Get(
    'hotels/:hotelId/rooms/:roomId/availability',
  )
  availability(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Param(
      'roomId',
      ParseIntPipe,
    )
    roomId: number,
    @Query('startDate')
    startDate: string,
    @Query('endDate')
    endDate: string,
  ) {
    return this.service.getAvailability(
      req.user?.userId,
      hotelId,
      roomId,
      startDate,
      endDate,
    );
  }

  @Post(
    'hotels/:hotelId/rooms/:roomId/availability',
  )
  saveAvailability(
    @Req() req: any,
    @Param(
      'hotelId',
      ParseIntPipe,
    )
    hotelId: number,
    @Param(
      'roomId',
      ParseIntPipe,
    )
    roomId: number,
    @Body()
    body: {
      items?: Array<{
        startDate?: string;
        endDate?: string;
        freeRooms?: number;
      }>;
    },
  ) {
    return this.service.saveAvailability(
      req.user?.userId,
      hotelId,
      roomId,
      body?.items ?? [],
    );
  }

  @Get('hotels/:hotelId/roomtypes')
  roomTypes(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
  ) {
    return this.service.listRoomTypes(
      req.user?.userId,
      hotelId,
    );
  }

  @Get('hotels/:hotelId/room-types')
  roomTypesAlias(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
  ) {
    return this.service.listRoomTypes(
      req.user?.userId,
      hotelId,
    );
  }

  @Post('hotels/:hotelId/rooms/bulk')
  saveRoomsBulk(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.saveRoomsBulk(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Post(
    'hotels/:hotelId/rooms/:roomId/gallery',
  )
  @UseInterceptors(
    FilesInterceptor(
      'files',
      20,
      {
        dest: 'uploads/tmp-room-gallery',
      },
    ),
  )
  uploadRoomGallery(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('roomId', ParseIntPipe)
    roomId: number,
    @UploadedFiles()
    files: Express.Multer.File[],
    @Body() body: any,
  ) {
    return this.service.uploadRoomGallery(
      req.user?.userId,
      hotelId,
      roomId,
      body?.roomRefCode ??
        body?.room_ref_code,
      files ?? [],
    );
  }

  @Get(
    'hotels/:hotelId/rooms/:roomId/availability/range-view',
  )
  availabilityRangeView(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('roomId', ParseIntPipe)
    roomId: number,
    @Query('startDate')
    startDate: string,
    @Query('endDate')
    endDate: string,
  ) {
    return this.service.getAvailability(
      req.user?.userId,
      hotelId,
      roomId,
      startDate,
      endDate,
    );
  }

  @Get('hotels/:hotelId/amenities')
  amenities(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
  ) {
    return this.service.listAmenities(
      req.user?.userId,
      hotelId,
    );
  }

  @Post('hotels/:hotelId/amenities')
  createAmenity(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.createAmenity(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Post(
    'hotels/:hotelId/amenities/bulk',
  )
  saveAmenitiesBulk(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.saveAmenitiesBulk(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Patch(
    'hotels/:hotelId/amenities/:amenityId',
  )
  updateAmenity(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('amenityId', ParseIntPipe)
    amenityId: number,
    @Body() body: any,
  ) {
    return this.service.updateAmenity(
      req.user?.userId,
      hotelId,
      amenityId,
      body,
    );
  }

  @Delete(
    'hotels/:hotelId/amenities/:amenityId',
  )
  deleteAmenity(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('amenityId', ParseIntPipe)
    amenityId: number,
  ) {
    return this.service.deleteAmenity(
      req.user?.userId,
      hotelId,
      amenityId,
    );
  }

  @Get(
    'hotels/:hotelId/amenities/:amenityId/detail',
  )
  amenityDetail(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('amenityId', ParseIntPipe)
    amenityId: number,
  ) {
    return this.service.getAmenityDetail(
      req.user?.userId,
      hotelId,
      amenityId,
    );
  }

  @Post(
    'hotels/:hotelId/amenities/:amenityId/pricebook',
  )
  amenityPricebook(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('amenityId', ParseIntPipe)
    amenityId: number,
    @Body() body: any,
  ) {
    return this.service.upsertAmenityPricebook(
      req.user?.userId,
      hotelId,
      amenityId,
      body,
    );
  }

  @Get('hotels/:hotelId/pricebook')
  pricebook(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
  ) {
    return this.service.getPricebook(
      req.user?.userId,
      hotelId,
    );
  }

  @Get('hotels/:hotelId/price-book')
  pricebookAlias(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
  ) {
    return this.service.getPricebook(
      req.user?.userId,
      hotelId,
    );
  }

  @Post('hotels/:hotelId/pricebook')
  createPricebook(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.createPricebook(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Patch('hotels/:hotelId/pricebook')
  updatePricebook(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.updatePricebook(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Post(
    'hotels/:hotelId/rooms/pricebook/bulk',
  )
  roomPricebookBulk(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.saveRates(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Get(
    'hotels/:hotelId/pricebook/range-view',
  )
  pricebookRangeView(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Query('startDate')
    startDate: string,
    @Query('endDate')
    endDate: string,
    @Query('roomId')
    roomId: string,
    @Query('rateplanId')
    rateplanId: string,
  ) {
    return this.service.getRates(
      req.user?.userId,
      hotelId,
      {
        startDate,
        endDate,
        roomId: Number(roomId),
        rateplanId,
      },
    );
  }

  @Get(
    'hotels/:hotelId/meal-pricebook/range-view',
  )
  mealPricebookRangeView(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Query('startDate')
    startDate: string,
    @Query('endDate')
    endDate: string,
  ) {
    return this.service.getMealPricebook(
      req.user?.userId,
      hotelId,
      startDate,
      endDate,
    );
  }

  @Post(
    'hotels/:hotelId/meal-pricebook',
  )
  saveMealPricebook(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.saveMealPricebook(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Get('hotels/:hotelId/reviews')
  reviews(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
  ) {
    return this.service.listReviews(
      req.user?.userId,
      hotelId,
    );
  }

  @Get('hotels/:hotelId/feedback')
  feedback(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
  ) {
    return this.service.listReviews(
      req.user?.userId,
      hotelId,
    );
  }

  @Post('hotels/:hotelId/reviews')
  createReview(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.createReview(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Post('hotels/:hotelId/feedback')
  createFeedback(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Body() body: any,
  ) {
    return this.service.createReview(
      req.user?.userId,
      hotelId,
      body,
    );
  }

  @Patch(
    'hotels/:hotelId/reviews/:reviewId',
  )
  updateReview(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('reviewId', ParseIntPipe)
    reviewId: number,
    @Body() body: any,
  ) {
    return this.service.updateReview(
      req.user?.userId,
      hotelId,
      reviewId,
      body,
    );
  }

  @Delete(
    'hotels/:hotelId/reviews/:reviewId',
  )
  deleteReview(
    @Req() req: any,
    @Param('hotelId', ParseIntPipe)
    hotelId: number,
    @Param('reviewId', ParseIntPipe)
    reviewId: number,
  ) {
    return this.service.deleteReview(
      req.user?.userId,
      hotelId,
      reviewId,
    );
  }
  @Get('bookings/pending-approval')
  pendingBookingApprovals(
    @Req() req: any,
  ) {
    return this.service
      .listPendingBookingApprovals(
        req.user?.userId,
      );
  }
  @Post('bookings/bulk-action')
  bulkBookingAction(
    @Req() req: any,
    @Body()
    body: {
      bookingIds?: Array<number | string>;
      action?: 'approve' | 'reject' | 'confirm';
      notes?: string;
    },
  ) {
    return this.service.bulkBookingAction(
      req.user?.userId,
      body,
    );
  }
  @Get('bookings')
  bookings(@Req() req: any) {
    return this.service.listBookings(
      req.user?.userId,
    );
  }

  @Get('users')
  users(@Req() req: any) {
    return this.service.listHotelUsers(
      req.user?.userId,
    );
  }

  @Post('users')
  createUser(
    @Req() req: any,
    @Body()
    dto: CreateHotelAdminUserDto,
  ) {
    return this.service.createHotelUser(
      req.user?.userId,
      dto,
    );
  }

  @Patch('users/:userId')
  updateUser(
    @Req() req: any,
    @Param('userId')
    userId: string,
    @Body()
    dto: UpdateHotelAdminUserDto,
  ) {
    return this.service.updateHotelUser(
      req.user?.userId,
      userId,
      dto,
    );
  }

  @Delete('users/:userId')
  deleteUser(
    @Req() req: any,
    @Param('userId')
    userId: string,
  ) {
    return this.service.deleteHotelUser(
      req.user?.userId,
      userId,
    );
  }

  @Get('users/:userId/permissions')
  permissions(
    @Req() req: any,
    @Param('userId')
    userId: string,
  ) {
    return this.service.getUserPermissions(
      req.user?.userId,
      userId,
    );
  }

  @Patch('users/:userId/permissions')
  setPermissions(
    @Req() req: any,
    @Param('userId')
    userId: string,
    @Body()
    dto: SetHotelAdminPermissionsDto,
  ) {
    return this.service.setUserPermissions(
      req.user?.userId,
      userId,
      dto,
    );
  }
}