import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma.service';
import { STAAH_MESSAGES } from './constants/staah-messages';
import {
  ProductInfoRequestDto,
  ProductInfoResponseDto,
} from './dto/product-info.dto';
import {
  RatePlanInfoRequestDto,
  RatePlanInfoResponseDto,
} from './dto/rate-plan-info.dto';
import {
  InventoryUpdateRequestDto,
  InventoryUpdateResponseDto,
} from './dto/inventory-update.dto';
import { RateUpdateRequestDto, RateUpdateResponseDto } from './dto/rate-update.dto';
import {
  RestrictionUpdateRequestDto,
  RestrictionUpdateResponseDto,
} from './dto/restriction-update.dto';
import {
  ReservationRequestDto,
  ReservationAckDto,
  ReservationTrackingDto,
} from './dto/reservation.dto';
import {
  ModifyReservationRequestDto,
  ModifyReservationResponseDto,
} from './dto/modify-reservation.dto';
import {
  CancelReservationRequestDto,
  CancelReservationResponseDto,
} from './dto/cancel-reservation.dto';
import { ArrInfoRequestDto, ArrInfoResponseDto } from './dto/arr-info.dto';
import { YearInfoArrRequestDto, YearInfoArrResponseDto } from './dto/year-info-arr.dto';

@Injectable()
export class StaahService {
  private readonly logger = new Logger(StaahService.name);

  constructor(private prisma: PrismaService) {}

  private createTrackingId(): string {
    return randomUUID().toUpperCase();
  }

  private async validatePropertyMapping(propertyId: string): Promise<boolean> {
    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: {
        staah_property_id: propertyId,
        staah_enabled: 1,
        deleted: { not: true },
      },
    });

    return !!hotel;
  }

  private async logInbound(
    type: string,
    propertyId?: string,
    roomId?: string,
    rateplanId?: string,
    payload?: any,
  ): Promise<void> {
    try {
      await this.prisma.staah_inbound_log.create({
        data: {
          type,
          staah_property_id: propertyId || null,
          room_id: roomId || null,
          rateplan_id: rateplanId || null,
          payload: payload || {},
        },
      });
    } catch (error) {
      this.logger.error(`Failed to log inbound request: ${error.message}`);
    }
  }

  private ensureValidArrDateRange(fromDate: Date, toDate: Date): void {
    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException({
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_ARR_DATE_RANGE,
      });
    }
  }

  async getProductInfo(dto: ProductInfoRequestDto): Promise<ProductInfoResponseDto> {
    const trackingId = this.createTrackingId();
    await this.logInbound('productInfo', dto.propertyid, null, null, dto);

    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: {
        staah_property_id: dto.propertyid,
        staah_enabled: 1,
        deleted: { not: true },
      },
    });

    if (!hotel) {
      return {
        currency: 'INR',
        propertyname: '',
        checkintime: '',
        checkouttime: '',
        contactinfo: {
          zip: '',
          latitude: '',
          longitude: '',
          country: '',
          addressline: '',
          city: '',
          fax: '',
          telephone: '',
          location: '',
        },
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
        trackingId,
      };
    }

    return {
      currency: 'INR',
      propertyname: hotel.hotel_name || '',
      checkintime: '',
      checkouttime: '',
      contactinfo: {
        zip: hotel.hotel_pincode || '',
        latitude: hotel.hotel_latitude || '',
        longitude: hotel.hotel_longitude || '',
        country: hotel.hotel_country || '',
        addressline: hotel.hotel_address || '',
        city: hotel.hotel_city || '',
        fax: '',
        telephone: hotel.hotel_mobile || '',
        location: hotel.hotel_place || hotel.hotel_city || '',
      },
      trackingId,
      status: 'success',
      error_desc: '',
    };
  }

  async getRatePlanInfo(dto: RatePlanInfoRequestDto): Promise<RatePlanInfoResponseDto> {
    const trackingId = this.createTrackingId();
    await this.logInbound('ratePlanInfo', dto.propertyid, null, null, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        roomtypes: [],
        rateplans: [],
        room_rate_mapping: [],
        trackingId,
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
      };
    }

    const rooms = await this.prisma.dvi_hotel_rooms.findMany({
      where: {
        hotel_id: (await this.prisma.dvi_hotel.findFirst({
          where: {
            staah_property_id: dto.propertyid,
            staah_enabled: 1,
            deleted: { not: true },
          },
          select: { hotel_id: true },
        }))?.hotel_id || 0,
        status: 1,
        deleted: 0,
      },
      select: {
        room_ID: true,
        room_ref_code: true,
        room_title: true,
      },
    });

    const ratePlans = await this.prisma.staah_rateplan.findMany({
      where: {
        staah_property_id: dto.propertyid,
      },
    });

    const roomtypes = rooms.map((room) => ({
      room_id: room.room_ref_code || String(room.room_ID),
      room_name: room.room_title || 'Room',
    }));

    const plans = ratePlans.map((ratePlan) => ({
      room_id: ratePlan.room_id,
      rate_id: ratePlan.rateplan_id,
      rate_name: ratePlan.rateplan_name,
      currency: ratePlan.currency || 'INR',
    }));

    const roomRateMap = ratePlans.map((ratePlan) => ({
      room_id: ratePlan.room_id,
      rate_id: ratePlan.rateplan_id,
    }));

    return {
      roomtypes,
      rateplans: plans,
      room_rate_mapping: roomRateMap,
      trackingId,
      status: 'success',
      error_desc: '',
    };
  }

  async inventoryUpdate(
    dto: InventoryUpdateRequestDto,
  ): Promise<InventoryUpdateResponseDto> {
    const { propertyid, room_id, data } = dto;

    await this.logInbound('inventoryUpdate', propertyid, room_id, dto.rate_id, dto);

    const isValid = await this.validatePropertyMapping(propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
      };
    }

    try {
      for (const inventoryEntry of data) {
        await this.prisma.staah_inventory.upsert({
          where: {
            staah_property_id_room_id_start_date_end_date: {
              staah_property_id: propertyid,
              room_id,
              start_date: new Date(inventoryEntry.start_date),
              end_date: new Date(inventoryEntry.end_date),
            },
          },
          update: {
            free: inventoryEntry.free,
            received_at: new Date(),
          },
          create: {
            staah_property_id: propertyid,
            room_id,
            start_date: new Date(inventoryEntry.start_date),
            end_date: new Date(inventoryEntry.end_date),
            free: inventoryEntry.free,
          },
        });
      }

      return {
        status: 'success',
        error_desc: '',
      };
    } catch (error) {
      this.logger.error(`Inventory update error: ${error.message}`);
      return {
        status: 'fail',
        error_desc: `${STAAH_MESSAGES.INVENTORY_UPDATE_FAILED} ${error.message}`,
      };
    }
  }

  async rateUpdate(dto: RateUpdateRequestDto): Promise<RateUpdateResponseDto> {
    const { propertyid, room_id, rate_id, data } = dto;

    await this.logInbound('rateUpdate', propertyid, room_id, rate_id, dto);

    const isValid = await this.validatePropertyMapping(propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
      };
    }

    try {
      for (const rateEntry of data) {
        const { start_date, end_date, ...occupancyRates } = rateEntry;

        await this.prisma.staah_rate.upsert({
          where: {
            staah_property_id_room_id_rateplan_id_start_date_end_date: {
              staah_property_id: propertyid,
              room_id,
              rateplan_id: rate_id,
              start_date: new Date(start_date),
              end_date: new Date(end_date),
            },
          },
          update: {
            occupancy_rates: occupancyRates,
            received_at: new Date(),
          },
          create: {
            staah_property_id: propertyid,
            room_id,
            rateplan_id: rate_id,
            start_date: new Date(start_date),
            end_date: new Date(end_date),
            occupancy_rates: occupancyRates,
          },
        });
      }

      return {
        status: 'success',
        error_desc: '',
      };
    } catch (error) {
      this.logger.error(`Rate update error: ${error.message}`);
      return {
        status: 'fail',
        error_desc: `${STAAH_MESSAGES.RATE_UPDATE_FAILED} ${error.message}`,
      };
    }
  }

  async restrictionUpdate(
    dto: RestrictionUpdateRequestDto,
  ): Promise<RestrictionUpdateResponseDto> {
    await this.logInbound('restrictionUpdate', dto.propertyid, dto.room_id, dto.rate_id, dto);

    try {
      const isValid = await this.validatePropertyMapping(dto.propertyid);
      if (!isValid) {
        return {
          status: 'fail',
          error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
        };
      }

      for (const row of dto.data) {
        await this.prisma.staah_restriction.create({
          data: {
            staah_property_id: dto.propertyid,
            room_id: dto.room_id,
            rateplan_id: dto.rate_id,
            start_date: new Date(row.start_date),
            end_date: new Date(row.end_date),
            type: row.type,
            value: row.value,
          },
        });
      }

      return {
        status: 'success',
        error_desc: '',
      };
    } catch (error) {
      this.logger.error(`Restriction update error: ${error.message}`);
      return {
        status: 'fail',
        error_desc: `${STAAH_MESSAGES.RESTRICTION_UPDATE_FAILED} ${error.message}`,
      };
    }
  }

  async receiveReservation(
    dto: ReservationRequestDto,
  ): Promise<Array<ReservationAckDto | ReservationTrackingDto>> {
    const trackingId = dto.trackingId || this.createTrackingId();
    await this.logInbound('reservation', dto.propertyid, null, null, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return [
        {
          bookingId: '',
          status: 'fail',
          error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
        },
        { trackingId },
      ];
    }

    try {
      const list = Array.isArray(dto.reservations?.reservation)
        ? dto.reservations.reservation
        : [];

      const responses: ReservationAckDto[] = [];
      for (const reservation of list) {
        const bookingId = this.extractReservationId(reservation) || '';
        await this.prisma.staah_reservation.create({
          data: {
            type: 'reservation',
            staah_property_id: dto.propertyid,
            reservation_id: bookingId || null,
            payload: reservation,
          },
        });

        responses.push({
          bookingId,
          status: 'success',
          error_desc: '',
        });
      }

      if (responses.length === 0) {
        responses.push({
          bookingId: '',
          status: 'fail',
          error_desc: STAAH_MESSAGES.RESERVATION_RECEIVE_FAILED,
        });
      }

      return [...responses, { trackingId }];
    } catch (error) {
      this.logger.error(`Reservation receive error: ${error.message}`);
      return [
        {
          bookingId: '',
          status: 'fail',
          error_desc: `${STAAH_MESSAGES.RESERVATION_RECEIVE_FAILED} ${error.message}`,
        },
        { trackingId },
      ];
    }
  }

  async modifyReservation(
    dto: ModifyReservationRequestDto,
  ): Promise<ModifyReservationResponseDto> {
    await this.logInbound('modifyReservation', dto.propertyid, null, null, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
      };
    }

    try {
      await this.prisma.staah_reservation.create({
        data: {
          type: 'modifyReservation',
          staah_property_id: dto.propertyid,
          reservation_id: dto.reservationId || this.extractReservationId(dto),
          payload: dto,
        },
      });

      return {
        status: 'success',
        error_desc: '',
      };
    } catch (error) {
      this.logger.error(`Reservation modify error: ${error.message}`);
      return {
        status: 'fail',
        error_desc: `${STAAH_MESSAGES.RESERVATION_MODIFY_FAILED} ${error.message}`,
      };
    }
  }

  async cancelReservation(
    dto: CancelReservationRequestDto,
  ): Promise<CancelReservationResponseDto> {
    await this.logInbound('cancelReservation', dto.propertyid, null, null, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
      };
    }

    try {
      await this.prisma.staah_reservation.create({
        data: {
          type: 'cancelReservation',
          staah_property_id: dto.propertyid,
          reservation_id: dto.reservationId || this.extractReservationId(dto),
          payload: dto,
        },
      });

      return {
        status: 'success',
        error_desc: '',
      };
    } catch (error) {
      this.logger.error(`Reservation cancel error: ${error.message}`);
      return {
        status: 'fail',
        error_desc: `${STAAH_MESSAGES.RESERVATION_CANCEL_FAILED} ${error.message}`,
      };
    }
  }

  /**
   * ARR_info adapter endpoint.
   * Request body matches the verified STAAH v2 pull wrapper.
   * Response body is adapter-defined from local stored ARI records.
   */
  async getArrInfo(dto: ArrInfoRequestDto): Promise<ArrInfoResponseDto> {
    const trackingId = this.createTrackingId();
    await this.logInbound('arrInfo', dto.propertyid, dto.room_id, dto.rate_id, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
        trackingId,
      };
    }

    const fromDate = new Date(dto.from_date);
    const toDate = new Date(dto.to_date);
  this.ensureValidArrDateRange(fromDate, toDate);

    const [inventoryRecords, rateRecords] = await Promise.all([
      this.prisma.staah_inventory.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          start_date: { gte: fromDate },
          end_date: { lte: toDate },
        },
        orderBy: { start_date: 'asc' },
      }),
      this.prisma.staah_rate.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
          start_date: { gte: fromDate },
          end_date: { lte: toDate },
        },
        orderBy: { start_date: 'asc' },
      }),
    ]);

    return {
      status: 'success',
      error_desc: '',
      trackingId,
      inventory: inventoryRecords.map((record) => ({
        start_date: record.start_date.toISOString().slice(0, 10),
        end_date: record.end_date.toISOString().slice(0, 10),
        free: record.free,
      })),
      rates: rateRecords.map((record) => ({
        start_date: record.start_date.toISOString().slice(0, 10),
        end_date: record.end_date.toISOString().slice(0, 10),
        occupancy_rates: record.occupancy_rates as Record<string, any>,
      })),
    };
  }

  /**
   * year_info_ARR adapter endpoint.
   * Request body matches the verified STAAH v2 full-year pull wrapper.
   * Response body is adapter-defined from local stored ARI records.
   */
  async getYearInfoArr(dto: YearInfoArrRequestDto): Promise<YearInfoArrResponseDto> {
    const trackingId = this.createTrackingId();
    await this.logInbound('yearInfoArr', dto.propertyid, dto.room_id, dto.rate_id, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
        trackingId,
      };
    }

    const [inventoryRecords, rateRecords] = await Promise.all([
      this.prisma.staah_inventory.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
        },
        orderBy: { start_date: 'asc' },
      }),
      this.prisma.staah_rate.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
        },
        orderBy: { start_date: 'asc' },
      }),
    ]);

    return {
      status: 'success',
      error_desc: '',
      trackingId,
      inventory: inventoryRecords.map((record) => ({
        start_date: record.start_date.toISOString().slice(0, 10),
        end_date: record.end_date.toISOString().slice(0, 10),
        free: record.free,
      })),
      rates: rateRecords.map((record) => ({
        start_date: record.start_date.toISOString().slice(0, 10),
        end_date: record.end_date.toISOString().slice(0, 10),
        occupancy_rates: record.occupancy_rates as Record<string, any>,
      })),
    };
  }

  private extractReservationId(payload: any): string | null {
    const reservationId =
      payload?.reservationId ||
      payload?.bookingid ||
      payload?.bookingId ||
      payload?.data?.reservationId ||
      payload?.data?.bookingId;

    if (reservationId === undefined || reservationId === null) {
      return null;
    }

    return String(reservationId);
  }
}
