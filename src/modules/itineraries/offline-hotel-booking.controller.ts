import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, Param, ParseIntPipe, Post, Put, Query, Req, ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, dvi_itinerary_offline_hotel_booking } from '@prisma/client';
import { Request } from 'express';
import { plainToInstance } from 'class-transformer';
import { isEmail, validateSync } from 'class-validator';
import { PrismaService } from '../../prisma.service';
import { getRoleId, isLegacyTravelExpertUser, SystemRole } from '../auth/constants/system-role.constants';
import {
  OfflineHotelBookingDetailsDto, OfflineVoucherStayDto, PreviewOfflineVoucherDto,
  ReadOfflineHotelContactsDto, SaveOfflineHotelBookingDto, SendOfflineVouchersDto,
} from './dto/offline-hotel-booking.dto';
import { ItineraryAccessService, ItineraryViewer } from './services/itinerary-access.service';
import { loadOfflineHotelContacts } from './services/offline-hotel-contacts';
import { HotelBlockEmailService } from './services/hotel-block-email.service';
import { renderOfflineHotelVoucher } from './templates/offline-hotel-voucher.template';

type BookingRequest = Request & { user?: ItineraryViewer & { userId?: number | string } };

const stayKey = ({ routeId, hotelKey, checkIn, checkOut }: Pick<OfflineVoucherStayDto, 'routeId' | 'hotelKey' | 'checkIn' | 'checkOut'>) =>
  JSON.stringify([routeId, hotelKey, checkIn, checkOut]);

const bookingScope = (planId: number, groupType: number, stay: Pick<OfflineVoucherStayDto, 'routeId' | 'hotelKey' | 'checkIn' | 'checkOut'>) => ({
  itinerary_plan_id: planId,
  group_type: groupType,
  route_id: stay.routeId,
  hotel_key: stay.hotelKey,
  check_in: new Date(stay.checkIn),
  check_out: new Date(stay.checkOut),
});

function bookingResponse(row: dvi_itinerary_offline_hotel_booking) {
  return {
    routeId: row.route_id,
    hotelKey: row.hotel_key,
    checkIn: row.check_in.toISOString().slice(0, 10),
    checkOut: row.check_out.toISOString().slice(0, 10),
    details: row.details,
    version: row.version,
  };
}

type VoucherDeliveryResult = {
  key: string;
  status: 'sent' | 'demo' | 'partial' | 'failed' | 'skipped';
  message?: string;
};

@ApiTags('Offline hotel bookings')
@ApiBearerAuth()
@Controller('itineraries/:planId/offline-hotel-bookings/:groupType')
export class OfflineHotelBookingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ItineraryAccessService,
    private readonly email: HotelBlockEmailService,
  ) {}

  @Get()
  async list(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('groupType', ParseIntPipe) groupType: number,
    @Req() request: BookingRequest,
  ) {
    this.assertScope(request, planId, groupType);
    await this.access.assertCanViewPlan(planId, request.user);
    const rows = await this.prisma.dvi_itinerary_offline_hotel_booking.findMany({
      where: { itinerary_plan_id: planId, group_type: groupType },
    });
    return rows.map(bookingResponse);
  }

  @Post('contacts')
  async contacts(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('groupType', ParseIntPipe) groupType: number,
    @Body() body: ReadOfflineHotelContactsDto,
    @Query('includeConfirmedBy') includeConfirmedBy: string | undefined,
    @Req() request: BookingRequest,
  ) {
    this.assertScope(request, planId, groupType);
    await this.access.assertCanViewPlan(planId, request.user);
    if (includeConfirmedBy !== 'true') {
      return loadOfflineHotelContacts(this.prisma, body.hotelKeys);
    }

    const [contacts, expert] = await Promise.all([
      loadOfflineHotelContacts(this.prisma, body.hotelKeys),
      this.getAssignedTravelExpert(planId),
    ]);
    return { contacts, confirmedBy: expert?.staff_name?.trim() ?? '' };
  }

  @Post('voucher-preview')
  async previewVoucher(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('groupType', ParseIntPipe) groupType: number,
    @Body() body: PreviewOfflineVoucherDto,
    @Req() request: BookingRequest,
  ) {
    this.assertScope(request, planId, groupType);
    await this.access.assertCanViewPlan(planId, request.user);
    const voucher = await this.getVoucherContext(planId);
    const { subject, html } = renderOfflineHotelVoucher(voucher, body.stay, body.details);
    return { subject, html };
  }

  @Post('voucher-emails')
  async sendVouchers(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('groupType', ParseIntPipe) groupType: number,
    @Body() body: SendOfflineVouchersDto,
    @Req() request: BookingRequest,
  ) {
    this.assertScope(request, planId, groupType);
    await this.access.assertCanEditPlan(planId, request.user);
    if (!this.email.isDispatchEnabled()) {
      throw new ServiceUnavailableException('Hotel email delivery is disabled.');
    }

    const stays = [...new Map(body.stays.map((stay) => [stayKey(stay), stay])).values()];
    const routeIds = [...new Set(stays.map((stay) => stay.routeId))];
    const [voucher, bookings, routes, expert] = await Promise.all([
      this.getVoucherContext(planId),
      this.prisma.dvi_itinerary_offline_hotel_booking.findMany({
        where: { itinerary_plan_id: planId, group_type: groupType, route_id: { in: routeIds } },
      }),
      this.prisma.dvi_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: planId, itinerary_route_ID: { in: routeIds }, deleted: 0 },
        select: { itinerary_route_ID: true, itinerary_route_date: true },
      }),
      this.getAssignedTravelExpert(planId),
    ]);
    const expertEmail = expert?.staff_email?.trim();
    const replyTo = expertEmail && isEmail(expertEmail) ? expertEmail : undefined;
    const bookedByKey = new Map(bookings.map((row) => {
      const booking = bookingResponse(row);
      return [stayKey(booking), booking] as const;
    }));
    const dateByRoute = new Map(routes.map((route) => [route.itinerary_route_ID, route.itinerary_route_date?.toISOString().slice(0, 10)]));
    const results: VoucherDeliveryResult[] = [];

    for (const stay of stays) {
      const key = stayKey(stay);
      const booking = bookedByKey.get(key);
      const routeDate = dateByRoute.get(stay.routeId);
      if (!booking || !routeDate || routeDate < stay.checkIn || routeDate >= stay.checkOut) {
        results.push({ key, status: 'skipped', message: 'A current saved booking is required.' });
        continue;
      }
      if (stay.version !== booking.version) {
        results.push({ key, status: 'skipped', message: 'Booking details changed. Reopen Offline Booking before sending.' });
        continue;
      }
      const details = plainToInstance(OfflineHotelBookingDetailsDto, booking.details);
      if (!details || validateSync(details, { forbidUnknownValues: true }).length) {
        results.push({ key, status: 'skipped', message: 'Review and save the booking details before sending.' });
        continue;
      }
      const recipients = [...new Map(details.emails.map((email) => [email.toLowerCase(), email])).values()];
      if (!recipients.length) {
        results.push({ key, status: 'skipped', message: 'No hotel email is saved for this stay.' });
        continue;
      }
      try {
        const outcome = await this.email.dispatchOfflineVoucher(recipients, renderOfflineHotelVoucher(voucher, stay, details), replyTo);
        results.push({ key, status: outcome.partial ? 'partial' : outcome.demo ? 'demo' : 'sent' });
      } catch (error) {
        this.email.logFailure(error, 'offline voucher for ' + voucher.quote);
        results.push({ key, status: 'failed', message: 'Email delivery failed.' });
      }
    }
    return { results };
  }

  @Put()
  async save(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('groupType', ParseIntPipe) groupType: number,
    @Body() booking: SaveOfflineHotelBookingDto,
    @Req() request: BookingRequest,
  ) {
    this.assertScope(request, planId, groupType);
    await this.access.assertCanEditPlan(planId, request.user);
    const { routeId, hotelKey, checkIn, checkOut, version, details } = booking;
    const route = await this.prisma.dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        deleted: 0,
        itinerary_route_date: { gte: new Date(checkIn), lt: new Date(checkOut) },
      },
      select: { itinerary_route_ID: true },
    });
    if (!route || !hotelKey.trim()) {
      throw new BadRequestException('The hotel stay dates must include a current itinerary route.');
    }

    const confirmedBy = details.confirmedBy.trim();
    const phone = details.phone.trim();
    const scope = bookingScope(planId, groupType, booking);
    const bookings = this.prisma.dvi_itinerary_offline_hotel_booking;
    if (details.status === 'confirmed' && (!confirmedBy || !details.emails.length || !phone)) {
      const previous = version > 0 && details.emails.length
        ? await bookings.findUnique({
            where: { itinerary_plan_id_group_type_route_id_hotel_key_check_in_check_out: scope },
            select: { details: true, version: true },
          })
        : null;
      if (previous && previous.version !== version) {
        throw new ConflictException('This stay was updated. Reopen Offline Booking to load the latest details.');
      }
      const savedDetails = plainToInstance(OfflineHotelBookingDetailsDto, previous?.details);
      if (savedDetails?.status !== 'confirmed' || (!confirmedBy && savedDetails.confirmedBy?.trim())
        || (!phone && savedDetails.phone?.trim())) {
        throw new BadRequestException('Enter the confirmer, email address and phone for a confirmed stay.');
      }
    }
    const rooms = details.rooms.map((room) => ({ ...room, category: room.category.trim() }));
    if (rooms.some((room) => !room.category)) {
      throw new BadRequestException('Enter a category for each room.');
    }

    const data = {
      details: {
        ...details,
        confirmedBy,
        phone,
        rooms,
        cancellationPolicies: details.cancellationPolicies.map((policy) => ({ ...policy })),
      },
      updated_by: Number(request.user?.userId || 0),
      version: version + 1,
    };
    try {
      const row = version === 0
        ? await bookings.create({ data: { ...scope, ...data } })
        : await bookings.update({
            where: {
              itinerary_plan_id_group_type_route_id_hotel_key_check_in_check_out: scope,
              version,
            },
            data,
          });
      return bookingResponse(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2025'].includes(error.code)) {
        throw new ConflictException('This stay was updated. Reopen Offline Booking to load the latest details.');
      }
      throw error;
    }
  }

  private async getVoucherContext(planId: number) {
    const [plan, settings, confirmedPlan] = await Promise.all([
      this.prisma.dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: planId, deleted: 0 },
        select: { itinerary_quote_ID: true },
      }),
      this.prisma.dvi_global_settings.findFirst({
        where: { status: 1, deleted: 0 },
        orderBy: { global_settings_ID: 'asc' },
        select: { site_title: true },
      }),
      this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: planId, deleted: 0 },
        orderBy: { confirmed_itinerary_plan_ID: 'desc' },
        select: { confirmed_itinerary_plan_ID: true, itinerary_quote_ID: true },
      }),
    ]);
    if (!plan) throw new BadRequestException('The itinerary is no longer available.');
    const customer = await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
      where: {
        primary_customer: 1,
        deleted: 0,
        OR: [
          { itinerary_plan_ID: planId },
          ...(confirmedPlan ? [{ confirmed_itinerary_plan_ID: confirmedPlan.confirmed_itinerary_plan_ID }] : []),
        ],
      },
      orderBy: { confirmed_itinerary_customer_ID: 'asc' },
      select: { customer_name: true },
    });
    return {
      quote: confirmedPlan?.itinerary_quote_ID?.trim() || plan.itinerary_quote_ID?.trim() || String(planId),
      siteTitle: settings?.site_title?.trim() || 'DVi Travel',
      customerName: customer?.customer_name?.trim(),
    };
  }

  private async getAssignedTravelExpert(planId: number) {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      select: { agent_id: true },
    });
    if (!plan?.agent_id) return null;

    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: plan.agent_id, deleted: 0 },
      select: { travel_expert_id: true },
    });
    if (!agent?.travel_expert_id) return null;

    return this.prisma.dvi_staff_details.findFirst({
      where: { staff_id: agent.travel_expert_id, deleted: 0 },
      select: { staff_name: true, staff_email: true },
    });
  }

  private assertScope(request: BookingRequest, planId: number, groupType: number) {
    const role = getRoleId(request.user);
    if (role !== SystemRole.ADMIN && role !== SystemRole.TRAVEL_EXPERT && !isLegacyTravelExpertUser(request.user)) {
      throw new ForbiddenException('Offline booking is available to Travel Experts and Super Admins.');
    }
    if (![planId, groupType].every((id) => Number.isInteger(id) && id > 0 && id <= 2_147_483_647)) {
      throw new BadRequestException('Select a valid itinerary and hotel group.');
    }
  }
}
