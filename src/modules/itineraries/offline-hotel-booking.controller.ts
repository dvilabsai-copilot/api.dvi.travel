import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, Param, ParseIntPipe, Post, Put, Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, dvi_itinerary_offline_hotel_booking } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../../prisma.service';
import { getRoleId, isLegacyTravelExpertUser, SystemRole } from '../auth/constants/system-role.constants';
import { ReadOfflineHotelContactsDto, SaveOfflineHotelBookingDto } from './dto/offline-hotel-booking.dto';
import { ItineraryAccessService, ItineraryViewer } from './services/itinerary-access.service';
import { loadOfflineHotelContacts } from './services/offline-hotel-contacts';

type BookingRequest = Request & { user?: ItineraryViewer & { userId?: number | string } };

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

@ApiTags('Offline hotel bookings')
@ApiBearerAuth()
@Controller('itineraries/:planId/offline-hotel-bookings/:groupType')
export class OfflineHotelBookingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ItineraryAccessService,
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
    @Req() request: BookingRequest,
  ) {
    this.assertScope(request, planId, groupType);
    await this.access.assertCanViewPlan(planId, request.user);
    return loadOfflineHotelContacts(this.prisma, body.hotelKeys);
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
    if (details.status === 'confirmed' && (!confirmedBy || !details.emails.length || !phone)) {
      throw new BadRequestException('Enter the confirmer, email address and phone for a confirmed stay.');
    }
    const rooms = details.rooms.map((room) => ({ ...room, category: room.category.trim() }));
    if (rooms.some((room) => !room.category)) {
      throw new BadRequestException('Enter a category for each room.');
    }

    const scope = {
      itinerary_plan_id: planId,
      group_type: groupType,
      route_id: routeId,
      hotel_key: hotelKey,
      check_in: new Date(checkIn),
      check_out: new Date(checkOut),
    };
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
    const bookings = this.prisma.dvi_itinerary_offline_hotel_booking;
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
