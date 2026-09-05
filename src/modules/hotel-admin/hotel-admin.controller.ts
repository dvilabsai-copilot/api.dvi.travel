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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
} from '@nestjs/swagger';
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
    @Query('page')
    page?: string,
    @Query('limit')
    limit?: string,
    @Query('search')
    search?: string,
  ) {
    return this.readService.listHotels(
      req.user?.userId,
      {
        page,
        limit,
        search,
      },
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