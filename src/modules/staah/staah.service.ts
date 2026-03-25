import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
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
import { MappingRequestDto, MappingResponseDto } from './dto/mapping.dto';
import { AriRequestDto, AriResponseDto } from './dto/ari.dto';
import {
  ReservationRequestDto,
  ReservationAckDto,
  ReservationResponseDto,
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

  private parseIsoDateOnly(value: unknown, fieldName: string): Date {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${fieldName} is required.`);
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${fieldName} must be a valid date in YYYY-MM-DD format.`);
    }

    return parsed;
  }

  private hasDefinedValue(value: unknown): boolean {
    return value !== undefined && value !== null;
  }

  private buildAriRatePayload(row: Record<string, any>): Record<string, any> | null {
    const occupancyRates: Record<string, any> = {};

    if (this.hasDefinedValue(row.amountBeforeTax)) {
      occupancyRates.amountBeforeTax = row.amountBeforeTax;
    }

    if (this.hasDefinedValue(row.amountAfterTax)) {
      occupancyRates.amountAfterTax = row.amountAfterTax;
    }

    return Object.keys(occupancyRates).length > 0 ? occupancyRates : null;
  }

  private extractAriRestrictionEntries(
    row: Record<string, any>,
  ): Array<{ type: string; value: string }> {
    const mappings = [
      { field: 'cta', type: 'cta' },
      { field: 'ctd', type: 'ctd' },
      { field: 'stopsell', type: 'stopsell' },
      { field: 'minstay', type: 'minstay' },
      { field: 'maxstay', type: 'maxstay' },
      { field: 'minstay_through', type: 'minstay_through' },
      { field: 'maxstay_through', type: 'maxstay_through' },
    ] as const;

    return mappings
      .filter(({ field }) => this.hasDefinedValue(row[field]))
      .map(({ field, type }) => ({
        type,
        value: String(row[field]),
      }));
  }

  private async upsertAriInventoryRow(
    tx: Prisma.TransactionClient,
    propertyId: string,
    roomId: string,
    startDate: Date,
    endDate: Date,
    inventoryValue: unknown,
  ): Promise<void> {
    const free = Number(inventoryValue);

    if (!Number.isFinite(free)) {
      throw new BadRequestException('inventory must be a number when provided.');
    }

    await tx.staah_inventory.upsert({
      where: {
        staah_property_id_room_id_start_date_end_date: {
          staah_property_id: propertyId,
          room_id: roomId,
          start_date: startDate,
          end_date: endDate,
        },
      },
      update: {
        free,
        received_at: new Date(),
      },
      create: {
        staah_property_id: propertyId,
        room_id: roomId,
        start_date: startDate,
        end_date: endDate,
        free,
      },
    });
  }

  private async upsertAriRateRow(
    tx: Prisma.TransactionClient,
    propertyId: string,
    roomId: string,
    rateId: string,
    startDate: Date,
    endDate: Date,
    row: Record<string, any>,
  ): Promise<void> {
    const occupancyRates = this.buildAriRatePayload(row);

    if (!occupancyRates) {
      return;
    }

    await tx.staah_rate.upsert({
      where: {
        staah_property_id_room_id_rateplan_id_start_date_end_date: {
          staah_property_id: propertyId,
          room_id: roomId,
          rateplan_id: rateId,
          start_date: startDate,
          end_date: endDate,
        },
      },
      update: {
        occupancy_rates: occupancyRates,
        received_at: new Date(),
      },
      create: {
        staah_property_id: propertyId,
        room_id: roomId,
        rateplan_id: rateId,
        start_date: startDate,
        end_date: endDate,
        occupancy_rates: occupancyRates,
      },
    });
  }

  private async upsertAriRestrictionRows(
    tx: Prisma.TransactionClient,
    propertyId: string,
    roomId: string,
    rateId: string,
    startDate: Date,
    endDate: Date,
    row: Record<string, any>,
  ): Promise<void> {
    const restrictions = this.extractAriRestrictionEntries(row);

    for (const restriction of restrictions) {
      const identityWhere = {
        staah_property_id: propertyId,
        room_id: roomId,
        rateplan_id: rateId,
        start_date: startDate,
        end_date: endDate,
        type: restriction.type,
      };

      const existing = await tx.staah_restriction.findFirst({
        where: identityWhere,
        select: { id: true },
      });

      if (existing) {
        await tx.staah_restriction.updateMany({
          where: identityWhere,
          data: {
            value: restriction.value,
            received_at: new Date(),
          },
        });
        continue;
      }

      await tx.staah_restriction.create({
        data: {
          ...identityWhere,
          value: restriction.value,
        },
      });
    }
  }

  private buildArrDataRows(
    inventoryRecords: Array<{ start_date: Date; end_date: Date; free: number }>,
    rateRecords: Array<{ start_date: Date; end_date: Date; occupancy_rates: Prisma.JsonValue }>,
    restrictionRecords: Array<{ start_date: Date; end_date: Date; type: string; value: string }>,
  ): Array<{
    start_date: string;
    end_date: string;
    free?: number;
    occupancy_rates?: Record<string, any>;
    restrictions?: Record<string, string>;
  }> {
    type ArrDataRow = {
      start_date: string;
      end_date: string;
      free?: number;
      occupancy_rates?: Record<string, any>;
      restrictions?: Record<string, string>;
    };

    const rows = new Map<
      string,
      ArrDataRow
    >();

    const keyFor = (startDate: Date, endDate: Date): string => {
      return `${startDate.toISOString().slice(0, 10)}|${endDate.toISOString().slice(0, 10)}`;
    };

    const getOrCreateRow = (startDate: Date, endDate: Date): ArrDataRow => {
      const key = keyFor(startDate, endDate);
      const existing = rows.get(key);
      if (existing) {
        return existing;
      }

      const created: ArrDataRow = {
        start_date: startDate.toISOString().slice(0, 10),
        end_date: endDate.toISOString().slice(0, 10),
      };
      rows.set(key, created);
      return created;
    };

    for (const record of inventoryRecords) {
      const row = getOrCreateRow(record.start_date, record.end_date);
      row.free = record.free;
    }

    for (const record of rateRecords) {
      const row = getOrCreateRow(record.start_date, record.end_date);
      row.occupancy_rates = (record.occupancy_rates || {}) as Record<string, any>;
    }

    for (const record of restrictionRecords) {
      const row = getOrCreateRow(record.start_date, record.end_date);
      row.restrictions = row.restrictions || {};
      row.restrictions[record.type] = record.value;
    }

    return [...rows.values()].sort((a, b) => {
      if (a.start_date === b.start_date) {
        return a.end_date.localeCompare(b.end_date);
      }
      return a.start_date.localeCompare(b.start_date);
    });
  }

  private dedupeRestrictions(
    rows: Array<{
      start_date: Date;
      end_date: Date;
      type: string;
      value: string;
      received_at: Date;
    }>,
  ): Array<{
    start_date: Date;
    end_date: Date;
    type: string;
    value: string;
  }> {
    const seen = new Set<string>();
    const deduped: Array<{
      start_date: Date;
      end_date: Date;
      type: string;
      value: string;
    }> = [];

    for (const row of rows) {
      const key = `${row.start_date.toISOString().slice(0, 10)}|${row.end_date
        .toISOString()
        .slice(0, 10)}|${row.type}`;

      // Rows are fetched newest-first for the same identity, so first match wins.
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push({
        start_date: row.start_date,
        end_date: row.end_date,
        type: row.type,
        value: row.value,
      });
    }

    return deduped.sort((a, b) => {
      const startCmp = a.start_date.getTime() - b.start_date.getTime();
      if (startCmp !== 0) {
        return startCmp;
      }

      const endCmp = a.end_date.getTime() - b.end_date.getTime();
      if (endCmp !== 0) {
        return endCmp;
      }

      return a.type.localeCompare(b.type);
    });
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
      OTA_room_id: room.room_ref_code || String(room.room_ID),
      room_name: room.room_title || 'Room',
    }));

    const plans = ratePlans.map((ratePlan) => ({
      room_id: ratePlan.room_id,
      rate_id: ratePlan.rateplan_id,
      OTA_room_id: ratePlan.room_id,
      OTA_rate_id: ratePlan.rateplan_id,
      rate_name: ratePlan.rateplan_name,
      currency: ratePlan.currency || 'INR',
    }));

    const roomRateMap = ratePlans.map((ratePlan) => ({
      room_id: ratePlan.room_id,
      rate_id: ratePlan.rateplan_id,
      OTA_room_id: ratePlan.room_id,
      OTA_rate_id: ratePlan.rateplan_id,
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

  async getMapping(dto: MappingRequestDto): Promise<MappingResponseDto> {
    await this.logInbound('mapping', dto.propertyid, null, null, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        room_rate_mapping: [],
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
      };
    }

    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: {
        staah_property_id: dto.propertyid,
        staah_enabled: 1,
        deleted: { not: true },
      },
      select: {
        hotel_id: true,
      },
    });

    const [rooms, ratePlans] = await Promise.all([
      this.prisma.dvi_hotel_rooms.findMany({
        where: {
          hotel_id: hotel?.hotel_id || 0,
          status: 1,
          deleted: 0,
        },
        select: {
          room_ID: true,
          room_ref_code: true,
          room_title: true,
        },
      }),
      this.prisma.staah_rateplan.findMany({
        where: {
          staah_property_id: dto.propertyid,
        },
        orderBy: [{ room_id: 'asc' }, { rateplan_id: 'asc' }],
      }),
    ]);

    const roomNameById = new Map<string, string>();
    for (const room of rooms) {
      const roomName = room.room_title || 'Room';
      roomNameById.set(String(room.room_ID), roomName);
      if (room.room_ref_code) {
        roomNameById.set(room.room_ref_code, roomName);
      }
    }

    return {
      room_rate_mapping: ratePlans.map((ratePlan) => ({
        room_id: ratePlan.room_id,
        room_name: roomNameById.get(ratePlan.room_id) || 'Room',
        rate_id: ratePlan.rateplan_id,
        rate_name: ratePlan.rateplan_name,
        manageable: 'Y',
      })),
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
        if (!rateEntry || typeof rateEntry !== 'object') {
          throw new BadRequestException('Each rate row must be a JSON object.');
        }

        const startDate = this.parseIsoDateOnly((rateEntry as any).start_date, 'start_date');
        const endDate = this.parseIsoDateOnly((rateEntry as any).end_date, 'end_date');

        const occupancyRates = Object.fromEntries(
          Object.entries(rateEntry).filter(
            ([key]) => key !== 'start_date' && key !== 'end_date',
          ),
        );

        if (Object.keys(occupancyRates).length === 0) {
          throw new BadRequestException(
            'At least one occupancy rate field is required in each data row.',
          );
        }

        await this.prisma.staah_rate.upsert({
          where: {
            staah_property_id_room_id_rateplan_id_start_date_end_date: {
              staah_property_id: propertyid,
              room_id,
              rateplan_id: rate_id,
              start_date: startDate,
              end_date: endDate,
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
            start_date: startDate,
            end_date: endDate,
            occupancy_rates: occupancyRates,
          },
        });
      }

      return {
        status: 'success',
        error_desc: '',
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Rate update error: ${error.message}`);
      return {
        status: 'fail',
        error_desc: `${STAAH_MESSAGES.RATE_UPDATE_FAILED} ${error.message}`,
      };
    }
  }

  /**
   * The final certification route is a single ARI endpoint, so dispatch read vs write
   * semantics here without removing the older adapter-specific routes.
   */
  async handleUnifiedAri(
    dto: AriRequestDto,
  ): Promise<AriResponseDto | ArrInfoResponseDto | YearInfoArrResponseDto> {
    if (dto.action === 'ARR_info') {
      return this.getArrInfo(dto as unknown as ArrInfoRequestDto);
    }

    if (dto.action === 'year_info_ARR') {
      return this.getYearInfoArr(dto as unknown as YearInfoArrRequestDto);
    }

    return this.ariUpdate(dto);
  }

  async ariUpdate(dto: AriRequestDto): Promise<AriResponseDto> {
    await this.logInbound('ari', dto.propertyid, dto.room_id, dto.rate_id, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
      };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        for (const rawRow of dto.data || []) {
          if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
            throw new BadRequestException('Each ARI data row must be a JSON object.');
          }

          const row = rawRow as Record<string, any>;
          const hasInventory = this.hasDefinedValue(row.inventory);
          const hasRate = this.hasDefinedValue(row.amountBeforeTax)
            || this.hasDefinedValue(row.amountAfterTax);
          const hasRestrictions = this.extractAriRestrictionEntries(row).length > 0;

          if (!hasInventory && !hasRate && !hasRestrictions) {
            continue;
          }

          const startDate = this.parseIsoDateOnly(row.from_date, 'from_date');
          const endDate = this.parseIsoDateOnly(row.to_date, 'to_date');

          if (hasInventory) {
            await this.upsertAriInventoryRow(
              tx,
              dto.propertyid,
              dto.room_id,
              startDate,
              endDate,
              row.inventory,
            );
          }

          if (hasRate) {
            await this.upsertAriRateRow(
              tx,
              dto.propertyid,
              dto.room_id,
              dto.rate_id,
              startDate,
              endDate,
              row,
            );
          }

          if (hasRestrictions) {
            await this.upsertAriRestrictionRows(
              tx,
              dto.propertyid,
              dto.room_id,
              dto.rate_id,
              startDate,
              endDate,
              row,
            );
          }
        }
      });

      return {
        status: 'success',
        error_desc: '',
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(`ARI update error: ${error.message}`);
      return {
        status: 'fail',
        error_desc: `Failed to process ARI update. ${error.message}`,
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
        const startDate = this.parseIsoDateOnly(row.start_date, 'start_date');
        const endDate = this.parseIsoDateOnly(row.end_date, 'end_date');

        const identityWhere = {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
          start_date: startDate,
          end_date: endDate,
          type: row.type,
        };

        const existing = await this.prisma.staah_restriction.findFirst({
          where: identityWhere,
          select: { id: true },
        });

        if (existing) {
          await this.prisma.staah_restriction.updateMany({
            where: identityWhere,
            data: {
              value: row.value,
              received_at: new Date(),
            },
          });
          continue;
        }

        await this.prisma.staah_restriction.create({
          data: {
            ...identityWhere,
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
  ): Promise<ReservationResponseDto> {
    const trackingId = dto.trackingId || this.createTrackingId();
    await this.logInbound('reservation', dto.propertyid, null, null, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyid);
    if (!isValid) {
      return {
        status: 'fail',
        trackingId,
        bookings: [
          {
            bookingId: '',
            status: 'fail',
            error_desc: STAAH_MESSAGES.INVALID_PROPERTY_ID,
          },
        ],
      };
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
            payload: reservation as unknown as Prisma.InputJsonValue,
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

      const status = responses.every((row) => row.status === 'success')
        ? 'success'
        : 'fail';

      return {
        status,
        trackingId,
        bookings: responses,
      };
    } catch (error) {
      this.logger.error(`Reservation receive error: ${error.message}`);
      return {
        status: 'fail',
        trackingId,
        bookings: [
          {
            bookingId: '',
            status: 'fail',
            error_desc: `${STAAH_MESSAGES.RESERVATION_RECEIVE_FAILED} ${error.message}`,
          },
        ],
      };
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
          payload: dto as unknown as Prisma.InputJsonValue,
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
          payload: dto as unknown as Prisma.InputJsonValue,
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

    const fromDate = this.parseIsoDateOnly(dto.from_date, 'from_date');
    const toDate = this.parseIsoDateOnly(dto.to_date, 'to_date');
    this.ensureValidArrDateRange(fromDate, toDate);

    const [inventoryRecords, rateRecords, restrictionRows, ratePlan] = await Promise.all([
      this.prisma.staah_inventory.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          start_date: { lte: toDate },
          end_date: { gte: fromDate },
        },
        orderBy: { start_date: 'asc' },
      }),
      this.prisma.staah_rate.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
          start_date: { lte: toDate },
          end_date: { gte: fromDate },
        },
        orderBy: { start_date: 'asc' },
      }),
      this.prisma.staah_restriction.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
          start_date: { lte: toDate },
          end_date: { gte: fromDate },
        },
        orderBy: [{ start_date: 'asc' }, { received_at: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.staah_rateplan.findFirst({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
        },
        select: {
          currency: true,
        },
      }),
    ]);

    const restrictionRecords = this.dedupeRestrictions(restrictionRows);
    const data = this.buildArrDataRows(inventoryRecords, rateRecords, restrictionRecords);

    return {
      status: 'success',
      error_desc: '',
      trackingId,
      propertyid: dto.propertyid,
      room_id: dto.room_id,
      rate_id: dto.rate_id,
      currency: ratePlan?.currency || 'INR',
      data,
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
      restrictions: restrictionRecords.map((record) => ({
        start_date: record.start_date.toISOString().slice(0, 10),
        end_date: record.end_date.toISOString().slice(0, 10),
        type: record.type,
        value: record.value,
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

    const [inventoryRecords, rateRecords, restrictionRows, ratePlan] = await Promise.all([
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
      this.prisma.staah_restriction.findMany({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
        },
        orderBy: [{ start_date: 'asc' }, { received_at: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.staah_rateplan.findFirst({
        where: {
          staah_property_id: dto.propertyid,
          room_id: dto.room_id,
          rateplan_id: dto.rate_id,
        },
        select: {
          currency: true,
        },
      }),
    ]);

    const restrictionRecords = this.dedupeRestrictions(restrictionRows);
    const data = this.buildArrDataRows(inventoryRecords, rateRecords, restrictionRecords);

    return {
      status: 'success',
      error_desc: '',
      trackingId,
      propertyid: dto.propertyid,
      room_id: dto.room_id,
      rate_id: dto.rate_id,
      currency: ratePlan?.currency || 'INR',
      data,
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
      restrictions: restrictionRecords.map((record) => ({
        start_date: record.start_date.toISOString().slice(0, 10),
        end_date: record.end_date.toISOString().slice(0, 10),
        type: record.type,
        value: record.value,
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
