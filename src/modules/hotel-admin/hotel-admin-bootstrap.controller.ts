import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import {
  CreateHotelAdminUserDto,
} from './dto/hotel-admin-user.dto';
import {
  HotelAdminBootstrapService,
} from './hotel-admin-bootstrap.service';

@ApiTags('Hotel Admin Bootstrap')
@ApiBearerAuth()
@Controller('hotel-admin-bootstrap')
@UseGuards(JwtAuthGuard)
export class HotelAdminBootstrapController {
  constructor(
    private readonly service:
      HotelAdminBootstrapService,
  ) {}

  @Post('users')
  createHotelAdmin(
    @Req() req: any,
    @Body() dto: CreateHotelAdminUserDto,
  ) {
    return this.service.createBySuperAdmin(
      req.user?.userId,
      dto,
    );
  }
}
