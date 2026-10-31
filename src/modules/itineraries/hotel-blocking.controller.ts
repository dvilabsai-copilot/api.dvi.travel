import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../auth/public.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HotelBlockingService } from './services/hotel-blocking.service';
import { ItineraryAccessService } from './services/itinerary-access.service';

const staffRoles = new Set([1, 3, 8]);

@ApiTags('Hotel blocking')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('hotel-blocks')
export class HotelBlockingController {
  constructor(
    private readonly hotelBlocking: HotelBlockingService,
    private readonly itineraryAccessService: ItineraryAccessService,
  ) {}

  @Post('hold-group')
  @ApiOperation({ summary: 'Create provider-neutral manual hotel hold requests' })
  async holdGroup(@Body() body: any, @Req() request: Request) {
    this.assertStaffOrAgent(request);
    const planId = Number(body?.itineraryPlanId ?? body?.itinerary_plan_ID);
    await this.itineraryAccessService.assertCanEditPlan(planId, (request as any).user);
    const user = (request as any).user || {};
    return this.hotelBlocking.holdGroup({
      itineraryPlanId: planId,
      groupType: Number(body?.groupType ?? body?.group_type),
      hotelDetailsIds: Array.isArray(body?.hotelDetailsIds ?? body?.hotel_details_ids)
        ? (body?.hotelDetailsIds ?? body?.hotel_details_ids).map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
        : undefined,
      tboHoldBookings: Array.isArray(body?.tboHoldBookings ?? body?.tbo_hold_bookings)
        ? (body?.tboHoldBookings ?? body?.tbo_hold_bookings)
        : undefined,
      actor: { id: Number(user.userId || 0), name: String(user.name || user.email || ''), type: 'STAFF' },
      guest: { name: body?.guest?.name, email: body?.guest?.email, phone: body?.guest?.phone },
    });
  }

  @Get('guest-details/:planId')
  @ApiOperation({ summary: 'Load the saved package guest details' })
  async getGuestDetails(@Param('planId', ParseIntPipe) planId: number, @Req() request: Request) {
    this.assertStaffOrAgent(request);
    await this.itineraryAccessService.assertCanViewPlan(planId, (request as any).user);
    return this.hotelBlocking.getGuestDetails(planId);
  }

  @Post('guest-details/:planId')
  @ApiOperation({ summary: 'Save package guest details before hotel holds' })
  async saveGuestDetails(@Param('planId', ParseIntPipe) planId: number, @Body() body: any, @Req() request: Request) {
    this.assertStaffOrAgent(request);
    await this.itineraryAccessService.assertCanEditPlan(planId, (request as any).user);
    const user = (request as any).user || {};
    return this.hotelBlocking.saveGuestDetails(planId, body || {}, {
      id: Number(user.userId || 0),
      name: String(user.name || user.email || ''),
      type: 'STAFF',
    });
  }

  @Get('itinerary/:planId')
  @ApiOperation({ summary: 'List manual hotel hold requests for an itinerary' })
  async list(@Param('planId', ParseIntPipe) planId: number, @Req() request: Request) {
    this.assertStaffOrAgent(request);
    await this.itineraryAccessService.assertCanViewPlan(planId, (request as any).user);
    return this.hotelBlocking.listForItinerary(planId, Number((request as any).query?.groupType || 0));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one manual hotel hold request' })
  async getOne(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    this.assertStaffOrAgent(request);
    const result = await this.hotelBlocking.getById(id);
    await this.itineraryAccessService.assertCanViewPlan(result.itineraryPlanId, (request as any).user);
    return result;
  }

  @Post(':id/manual-response')
  @ApiOperation({ summary: 'Record a hotel response received by DVi staff' })
  async manualResponse(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() request: Request) {
    this.assertStaff(request);
    const user = (request as any).user || {};
    return this.hotelBlocking.recordManualResponse(id, body, {
      id: Number(user.userId || 0),
      name: String(user.name || user.email || ''),
      type: 'STAFF',
    });
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel one manual hotel hold request' })
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    this.assertStaff(request);
    const result = await this.hotelBlocking.getById(id);
    await this.itineraryAccessService.assertCanEditPlan(result.itineraryPlanId, (request as any).user);
    const user = (request as any).user || {};
    return this.hotelBlocking.cancel(id, {
      id: Number(user.userId || 0),
      name: String(user.name || user.email || ''),
      type: 'STAFF',
    });
  }

  @Post(':id/resend-email')
  @ApiOperation({ summary: 'Queue another hotel blocking email' })
  async resendEmail(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    this.assertStaff(request);
    const result = await this.hotelBlocking.getById(id);
    await this.itineraryAccessService.assertCanEditPlan(result.itineraryPlanId, (request as any).user);
    const user = (request as any).user || {};
    return this.hotelBlocking.resendEmail(id, {
      id: Number(user.userId || 0),
      name: String(user.name || user.email || ''),
      type: 'STAFF',
    });
  }

  @Post(':id/update-cutoff')
  @ApiOperation({ summary: 'Extend an existing hotel hold and notify the hotel' })
  async updateCutoff(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() request: Request) {
    this.assertStaff(request);
    const result = await this.hotelBlocking.getById(id);
    await this.itineraryAccessService.assertCanEditPlan(result.itineraryPlanId, (request as any).user);
    const user = (request as any).user || {};
    return this.hotelBlocking.updateCutoff(id, String(body?.cutoffAt || body?.cutoff_at || ''), {
      id: Number(user.userId || 0),
      name: String(user.name || user.email || ''),
      type: 'STAFF',
    });
  }

  private assertStaffOrAgent(request: Request) {
    const role = Number((request as any).user?.role ?? (request as any).user?.roleID ?? 0);
    if (!staffRoles.has(role)) throw new ForbiddenException('Only authorized DVi users can manage hotel holds.');
  }

  private assertStaff(request: Request) {
    const role = Number((request as any).user?.role ?? (request as any).user?.roleID ?? 0);
    if (![1, 3, 8].includes(role)) throw new ForbiddenException('Only staff can record hotel responses.');
  }
}

@ApiTags('Public hotel blocking')
@Controller('public/hotel-blocks')
export class HotelBlockingPublicController {
  constructor(private readonly hotelBlocking: HotelBlockingService) {}

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Read a scoped hotel response request' })
  get(@Param('token') token: string) {
    return this.hotelBlocking.getPublic(token);
  }

  @Public()
  @Post(':token/respond')
  @ApiOperation({ summary: 'Submit a hotel response through a scoped token' })
  respond(@Param('token') token: string, @Body() body: any) {
    return this.hotelBlocking.respondPublic(token, body);
  }
}
