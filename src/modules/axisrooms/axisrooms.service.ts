import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  ProductInfoRequestDto,
  ProductInfoResponseDto,
  ProductInfoDataDto,
} from './dto/product-info.dto';
import {
  RatePlanInfoRequestDto,
  RatePlanInfoResponseDto,
  RatePlanDataDto,
} from './dto/rate-plan-info.dto';
import {
  InventoryUpdateRequestDto,
  InventoryUpdateResponseDto,
} from './dto/inventory-update.dto';
import {
  RateUpdateRequestDto,
  RateUpdateResponseDto,
} from './dto/rate-update.dto';
import {
  RestrictionUpdateRequestDto,
  RestrictionUpdateResponseDto,
} from './dto/restriction-update.dto';
import { AXISROOMS_MESSAGES } from './constants/axisrooms-messages';
import {
  CANONICAL_HOTEL_RATE_PLANS,
  getCanonicalHotelRatePlanDefinition,
} from '../hotels/hotel-rate-plans';

@Injectable()
export class AxisRoomsService {
  private readonly logger = new Logger(AxisRoomsService.name);
  private readonly axisroomsRatePlanOccupancy = [
    'SINGLE',
    'DOUBLE',
    'TRIPLE',
    'QUAD',
    'PENTA',
    'HEXA',
    'HEPTA',
    'OCTA',
    'NINE',
    'TEN',
    'EXTRABED',
    'EXTRAADULT',
    'EXTRACHILD',
    'EXTRAADULT2',
    'EXTRACHILD2',
    'EXTRAADULT3',
    'EXTRACHILD3',
    'EXTRAINFANT',
  ] as const;

  constructor(
    private prisma: PrismaService,
  ) {}

  private normalizeId(value: string): string {
    return value?.trim();
  }

  private monthName(date: Date): string {
    return date.toLocaleString('en-US', { month: 'long' });
  }

  private monthCandidatesForDate(date: Date): string[] {
    const monthNum = date.getMonth() + 1;
    return [
      this.monthName(date),
      String(monthNum).padStart(2, '0'),
      String(monthNum),
    ];
  }

  private toFiniteNumber(value: any): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  private extractRate(occupancyRates: Record<string, any>, keys: string[]): number | undefined {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(occupancyRates, k)) {
        const n = this.toFiniteNumber(occupancyRates[k]);
        if (n !== undefined) return n;
      }
    }
    return undefined;
  }

  private splitByMonth(start: Date, end: Date): Array<{ year: string; month: string; days: number[] }> {
    const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const to = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (to < from) return [];

    const map = new Map<string, { year: string; month: string; days: number[] }>();
    const cursor = new Date(from);
    while (cursor <= to) {
      const year = String(cursor.getFullYear());
      const month = this.monthName(cursor);
      const key = `${year}-${month}`;
      if (!map.has(key)) map.set(key, { year, month, days: [] });
      map.get(key)!.days.push(cursor.getDate());
      cursor.setDate(cursor.getDate() + 1);
    }
    return Array.from(map.values());
  }

  private buildDayPatch(rate: number, days: number[]): Record<string, number> {
    const patch: Record<string, number> = {};
    for (const d of days) patch[`day_${d}`] = rate;
    return patch;
  }

  private resolveExternalRatePlanDefinition(rateplanId: string) {
    const raw = String(rateplanId || '').trim();
    if (!raw) return null;
    return (
      CANONICAL_HOTEL_RATE_PLANS.find((definition) => {
        const externalId = String(definition.externalRateplanId || '').trim();
        return !!externalId && (raw === externalId || raw.startsWith(externalId));
      }) || null
    );
  }

  private async upsertHotelPricebookRows(
    hotelId: number,
    roomId: number,
    roomTypeId: number | null,
    startDate: Date,
    endDate: Date,
    occupancyRates: Record<string, any>,
  ): Promise<void> {
    const single = this.extractRate(occupancyRates, ['SINGLE', 'single']);
    const extraBed = this.extractRate(occupancyRates, ['EXTRABED', 'extraBed', 'EXTRA_BED']);

    const childWithBed = this.extractRate(occupancyRates, [
      'CHILD_WITH_BED',
      'CHILDWITHBED',
      'EXTRACHILD_WITH_BED',
    ]);
    const childWithoutBed = this.extractRate(occupancyRates, [
      'CHILD_WITHOUT_BED',
      'CHILDWITHOUTBED',
      'EXTRACHILD_WITHOUT_BED',
    ]);
    const extraChild = this.extractRate(occupancyRates, ['EXTRACHILD', 'extraChild']);

    const priceTypeRates: Array<{ priceType: number; value: number | undefined }> = [
      { priceType: 0, value: single },
      { priceType: 1, value: extraBed },
      { priceType: 2, value: childWithBed ?? extraChild },
      { priceType: 3, value: childWithoutBed ?? extraChild },
    ].filter((x) => x.value !== undefined) as Array<{ priceType: number; value: number }>;

    if (priceTypeRates.length === 0) return;

    const buckets = this.splitByMonth(startDate, endDate);
    for (const bucket of buckets) {
      const bucketDate = new Date(Number(bucket.year), new Date(`${bucket.month} 1, ${bucket.year}`).getMonth(), 1);
      const monthCandidates = this.monthCandidatesForDate(bucketDate);
      const canonicalMonth = monthCandidates[0] || bucket.month;

      for (const row of priceTypeRates) {
        const whereClause: any = {
          hotel_id: hotelId,
          room_id: roomId,
          price_type: row.priceType,
          year: bucket.year,
          month: { in: monthCandidates },
          deleted: 0,
        };
        if (roomTypeId && Number.isFinite(roomTypeId)) {
          whereClause.room_type_id = Number(roomTypeId);
        }

        const existing = await this.prisma.dvi_hotel_room_price_book.findFirst({
          where: whereClause,
          select: { hotel_price_book_id: true } as any,
          orderBy: { hotel_price_book_id: 'desc' } as any,
        });

        const dayPatch = this.buildDayPatch(row.value, bucket.days);
        if (existing) {
          await this.prisma.dvi_hotel_room_price_book.update({
            where: { hotel_price_book_id: (existing as any).hotel_price_book_id } as any,
            data: dayPatch as any,
          });
        } else {
          const createData: any = {
            hotel_id: hotelId,
            room_id: roomId,
            room_type_id: roomTypeId ?? undefined,
            price_type: row.priceType,
            year: bucket.year,
            month: canonicalMonth,
            status: 1,
            deleted: 0,
            ...dayPatch,
          };
          await this.prisma.dvi_hotel_room_price_book.create({ data: createData });
        }
      }
    }
  }

  private async ensureRatePlanExists(
    propertyId: string,
    roomId: string,
    rateplanId: string,
    details?: {
      ratePlanName?: string;
      occupancy?: string[];
      commissionPerc?: string;
      taxPerc?: string;
      currency?: string;
    },
  ): Promise<void> {
    const canonicalDefinition = getCanonicalHotelRatePlanDefinition(
      rateplanId || details?.ratePlanName,
    );
    const occupancy = Array.isArray(details?.occupancy)
      ? details?.occupancy.filter((item) => !!String(item || '').trim())
      : [];

    // Resolve hotel_id and room_id (integer) from propertyId and roomId (string)
    const hotelRow = await this.prisma.dvi_hotel.findFirst({
      where: { axisrooms_property_id: propertyId, deleted: { not: true } },
      select: { hotel_id: true },
    });
    if (!hotelRow?.hotel_id) return;
    const hid = Number(hotelRow.hotel_id);
    const roomRow = await this.prisma.dvi_hotel_rooms.findFirst({
      where: { hotel_id: hid, room_ref_code: roomId, deleted: 0 } as any,
      select: { room_ID: true } as any,
    });
    if (!(roomRow as any)?.room_ID) return;
    const rid = Number((roomRow as any).room_ID);

    await this.prisma.dvi_hotel_room_rate_plan.upsert({
      where: {
        hotel_id_room_id_rateplan_id: {
          hotel_id: hid,
          room_id: rid,
          rateplan_id: rateplanId,
        },
      } as any,
      update: {
        ...(details?.ratePlanName ? { rateplan_name: details.ratePlanName } : {}),
        ...(occupancy.length ? { occupancy } : {}),
        ...(details?.commissionPerc ? { commission_perc: details.commissionPerc } : {}),
        ...(details?.taxPerc ? { tax_perc: details.taxPerc } : {}),
        ...(details?.currency ? { currency: details.currency } : {}),
        updatedon: new Date(),
      } as any,
      create: {
        hotel_id: hid,
        room_id: rid,
        rateplan_id: rateplanId,
        rateplan_name: details?.ratePlanName || canonicalDefinition?.name || rateplanId,
        occupancy,
        commission_perc: details?.commissionPerc || '0.0',
        tax_perc: details?.taxPerc || '0.0',
        currency: details?.currency || 'INR',
        status: 1,
        deleted: 0,
        createdon: new Date(),
        updatedon: new Date(),
      } as any,
    });
  }

  /**
   * Validates if a propertyId is mapped and enabled in dvi_hotel
   */
  private async validatePropertyMapping(propertyId: string): Promise<boolean> {
    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: {
        axisrooms_property_id: propertyId,
        axisrooms_enabled: 1,
        deleted: { not: true },
      },
    });
    return !!hotel;
  }

  /**
   * Logs inbound request
   */
  private async logInbound(
    type: string,
    propertyId?: string,
    roomId?: string,
    rateplanId?: string,
    payload?: any,
  ): Promise<void> {
    try {
      await this.prisma.axisrooms_inbound_log.create({
        data: {
          type,
          axisrooms_property_id: propertyId || null,
          room_id: roomId || null,
          rateplan_id: rateplanId || null,
          payload: payload || {},
        },
      });
    } catch (error) {
      this.logger.error(`Failed to log inbound request: ${error.message}`);
    }
  }

  /**
   * GET productInfo - Returns list of rooms for a property
   * Now queries from dvi_hotel_rooms + dvi_hotel_roomtype tables
   */
  async getProductInfo(
    dto: ProductInfoRequestDto,
  ): Promise<ProductInfoResponseDto> {
    const propertyId = this.normalizeId(dto.propertyId);

    await this.logInbound('productInfo', propertyId, null, null, dto);

    // Find hotel by propertyId
    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: {
        axisrooms_property_id: propertyId,
        axisrooms_enabled: 1,
        deleted: { not: true },
      },
    });

    if (!hotel) {
      return {
        message: AXISROOMS_MESSAGES.INVALID_PROPERTY_ID,
        status: 'failure',
        data: [],
      };
    }

    // Get rooms for this hotel
    const rooms = await this.prisma.dvi_hotel_rooms.findMany({
      where: {
        hotel_id: hotel.hotel_id,
        deleted: 0,
        status: 1,
      },
      select: {
        room_ID: true,
        room_type_id: true,
        room_title: true,
        room_ref_code: true,
      },
    });

    if (!rooms || rooms.length === 0) {
      return {
        message: AXISROOMS_MESSAGES.NO_PRODUCTS_FOUND,
        status: 'failure',
        data: [],
      };
    }

    // Get unique room type IDs
    const roomTypeIds = [...new Set(rooms.map(r => r.room_type_id))];

    // Get room types
    const roomTypes = await this.prisma.dvi_hotel_roomtype.findMany({
      where: {
        room_type_id: { in: roomTypeIds },
        deleted: 0,
        status: 1,
      },
      select: {
        room_type_id: true,
        room_type_title: true,
      },
    });

    // Create a map for quick lookup
    const roomTypeMap = new Map(
      roomTypes.map(rt => [rt.room_type_id, rt.room_type_title]),
    );

    // Build response data
    const data: ProductInfoDataDto[] = rooms.map((room) => {
      // Prefer room_ref_code, fallback to room_ID as string
      const id = room.room_ref_code || String(room.room_ID);
      
      // Prefer room_type_title, fallback to room_title, final fallback "Room"
      const roomTypeName = roomTypeMap.get(room.room_type_id);
      const name = roomTypeName || room.room_title || 'Room';

      return { name, id };
    });

    return {
      message: AXISROOMS_MESSAGES.PRODUCT_INFO_SUCCESS,
      status: 'success',
      data,
    };
  }

  /**
   * GET ratePlanInfo - Returns list of rate plans for a room
   */
  async getRatePlanInfo(
    dto: RatePlanInfoRequestDto,
  ): Promise<RatePlanInfoResponseDto> {
    const propertyId = this.normalizeId(dto.propertyId);
    const roomId = this.normalizeId(dto.roomId);

    await this.logInbound('ratePlanInfo', propertyId, roomId, null, dto);

    const isValid = await this.validatePropertyMapping(propertyId);
    if (!isValid) {
      return {
        message: AXISROOMS_MESSAGES.INVALID_PROPERTY_ID,
        status: 'failure',
        data: [],
      };
    }

    // Resolve hotel_id and room_id (integer) from propertyId and roomId (string)
    const hotelForInfo = await this.prisma.dvi_hotel.findFirst({
      where: { axisrooms_property_id: propertyId, deleted: { not: true } },
      select: { hotel_id: true },
    });
    const hidForInfo = hotelForInfo?.hotel_id ? Number(hotelForInfo.hotel_id) : 0;
    const roomRowForInfo = hidForInfo
      ? await this.prisma.dvi_hotel_rooms.findFirst({
          where: { hotel_id: hidForInfo, room_ref_code: roomId, deleted: 0 } as any,
          select: { room_ID: true } as any,
        })
      : null;
    const ridForInfo = (roomRowForInfo as any)?.room_ID ? Number((roomRowForInfo as any).room_ID) : 0;

    if (!hidForInfo || !ridForInfo) {
      return {
        message: AXISROOMS_MESSAGES.NO_RATEPLANS_FOUND,
        status: 'failure',
        data: [],
      };
    }

    const ratePlans = await this.prisma.dvi_hotel_room_rate_plan.findMany({
      where: { hotel_id: hidForInfo, room_id: ridForInfo, deleted: 0, status: 1 } as any,
    });

    const selectedCanonicalPlans = CANONICAL_HOTEL_RATE_PLANS.map((definition) => {
      const matched = ratePlans.find((rp: any) => {
        const inferred = getCanonicalHotelRatePlanDefinition(rp.rateplan_id)
          || getCanonicalHotelRatePlanDefinition(rp.rateplan_name);
        return inferred?.code === definition.code;
      });

      return {
        definition,
        row: matched || null,
      };
    });

    const ratePlanIds = selectedCanonicalPlans
      .map((item) => String(item.row?.rateplan_id || item.definition.defaultRateplanId))
      .filter((value, index, arr) => arr.indexOf(value) === index);

    const rateRows = await this.prisma.dvi_hotel_occupancy_rate.findMany({
      where: {
        hotel_id: hidForInfo,
        room_id: ridForInfo,
        rateplan_id: { in: ratePlanIds },
      },
      select: {
        rateplan_id: true,
        start_date: true,
        end_date: true,
        occupancy_rates: true,
      } as any,
    });

    const toDateOnly = (value: unknown): string | null => {
      if (!value) {
        return null;
      }

      if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
      }

      if (typeof value === 'string') {
        return value.slice(0, 10);
      }

      return null;
    };

    const validityByRateplan = new Map<string, { startDate: string; endDate: string }>();
    for (const row of rateRows) {
      const startDate = toDateOnly(row.start_date);
      const endDate = toDateOnly(row.end_date);
      if (!startDate || !endDate) {
        continue;
      }
      const current = validityByRateplan.get(row.rateplan_id);

      if (!current) {
        validityByRateplan.set(row.rateplan_id, { startDate, endDate });
        continue;
      }

      validityByRateplan.set(row.rateplan_id, {
        startDate: startDate < current.startDate ? startDate : current.startDate,
        endDate: endDate > current.endDate ? endDate : current.endDate,
      });
    }

    const year = new Date().getFullYear();
    const fullYearValidity = {
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
    };

    const data: RatePlanDataDto[] = selectedCanonicalPlans.map(({ definition, row }) => {
      const resolvedRateplanId = String(definition.externalRateplanId || definition.defaultRateplanId);

      return {
        rateplanId: resolvedRateplanId,
        ratePlanName: definition.code,
        occupancy: [...this.axisroomsRatePlanOccupancy],
        validity: fullYearValidity,
        commissionPerc: String(row?.commission_perc || '0.0'),
        taxPerc: String(row?.tax_perc || '0.0'),
        currency: 'INR',
      };
    });

    return {
      message: AXISROOMS_MESSAGES.RATE_PLAN_INFO_SUCCESS,
      status: 'success',
      data,
    };
  }

  /**
   * POST inventoryUpdate - Stores or updates inventory
   * Dual-writes: axisrooms_inventory (audit log) + dvi_hotel_room_availability (native table)
   */
  async updateInventory(
    dto: InventoryUpdateRequestDto,
  ): Promise<InventoryUpdateResponseDto> {
    const propertyId = this.normalizeId(dto.data.propertyId);
    const roomId = this.normalizeId(dto.data.roomId);
    const { inventory } = dto.data;

    await this.logInbound('inventoryUpdate', propertyId, roomId, null, dto);

    const isValid = await this.validatePropertyMapping(propertyId);
    if (!isValid) {
      return {
        message: AXISROOMS_MESSAGES.INVALID_PROPERTY_ID,
        status: 'failure',
      };
    }

    try {
      // --- Write 1: axisrooms_inventory (audit log — unchanged) ---
      for (const inv of inventory) {
        await this.prisma.axisrooms_inventory.upsert({
          where: {
            axisrooms_property_id_room_id_start_date_end_date: {
              axisrooms_property_id: propertyId,
              room_id: roomId,
              start_date: new Date(inv.startDate),
              end_date: new Date(inv.endDate),
            },
          },
          update: {
            free: inv.free,
            received_at: new Date(),
          },
          create: {
            axisrooms_property_id: propertyId,
            room_id: roomId,
            start_date: new Date(inv.startDate),
            end_date: new Date(inv.endDate),
            free: inv.free,
          },
        });
      }

      // --- Write 2: dvi_hotel_room_availability (universal native table) ---
      // Resolve string IDs → integer IDs (same pattern as ensureRatePlanExists)
      const hotelRow = await this.prisma.dvi_hotel.findFirst({
        where: { axisrooms_property_id: propertyId, deleted: { not: true } },
        select: { hotel_id: true, hotel_name: true },
      });

      if (hotelRow?.hotel_id) {
        const hid = Number(hotelRow.hotel_id);
        const roomRow = await this.prisma.dvi_hotel_rooms.findFirst({
          where: { hotel_id: hid, room_ref_code: roomId, deleted: 0 } as any,
          select: { room_ID: true } as any,
        });

        if ((roomRow as any)?.room_ID) {
          const rid = Number((roomRow as any).room_ID);
          for (const inv of inventory) {
            await (this.prisma as any).dvi_hotel_room_availability.upsert({
              where: {
                hotel_id_room_id_start_date_end_date: {
                  hotel_id: hid,
                  room_id: rid,
                  start_date: new Date(inv.startDate),
                  end_date: new Date(inv.endDate),
                },
              },
              update: { free: inv.free, source: 'axisrooms', received_at: new Date() },
              create: {
                hotel_id: hid,
                room_id: rid,
                start_date: new Date(inv.startDate),
                end_date: new Date(inv.endDate),
                free: inv.free,
                source: 'axisrooms',
              },
            });
          }
        } else {
          this.logger.warn(`AxisRooms inventoryUpdate: room_ref_code "${roomId}" not found for hotel_id ${hid} — skipping native write`);
        }
      } else {
        this.logger.warn(`AxisRooms inventoryUpdate: propertyId "${propertyId}" not mapped to any hotel — skipping native write`);
      }

      return {
        message: AXISROOMS_MESSAGES.INVENTORY_UPDATE_SUCCESS,
        status: 'success',
      };
    } catch (error) {
      this.logger.error(`Inventory update error: ${error.message}`);
      return {
        message: `${AXISROOMS_MESSAGES.INVENTORY_UPDATE_FAILED} ${error.message}`,
        status: 'failure',
      };
    }
  }

  /**
   * POST rateUpdate - Accepts payload but intentionally does not write to DB.
   * Rates are managed from Admin dashboard flows.
   */
  async updateRate(
    dto: RateUpdateRequestDto,
  ): Promise<RateUpdateResponseDto> {
    const propertyId = this.normalizeId(dto.data.propertyId);
    const roomId = this.normalizeId(dto.data.roomId);
    const rateplanId = this.normalizeId(dto.data.rateplanId);
    const canonicalRatePlanDefinition = this.resolveExternalRatePlanDefinition(rateplanId);
    if (!canonicalRatePlanDefinition) {
      return {
        message: AXISROOMS_MESSAGES.INVALID_RATEPLAN_ID,
        status: 'failure',
      };
    }
    const internalRateplanId = canonicalRatePlanDefinition?.defaultRateplanId || rateplanId;
    const { rate } = dto.data;

    const isValid = await this.validatePropertyMapping(propertyId);
    if (!isValid) {
      return {
        message: AXISROOMS_MESSAGES.INVALID_PROPERTY_ID,
        status: 'failure',
      };
    }

    try {
      this.logger.log(
        `AxisRooms rateUpdate ignored for DB writes (propertyId=${propertyId}, roomId=${roomId}, rateplanId=${rateplanId}, rows=${Array.isArray(rate) ? rate.length : 0})`,
      );

      return {
        message: AXISROOMS_MESSAGES.RATE_UPDATE_SUCCESS,
        status: 'success',
      };
    } catch (error) {
      this.logger.error(`Rate update error: ${error.message}`);
      return {
        message: `${AXISROOMS_MESSAGES.RATE_UPDATE_FAILED} ${error.message}`,
        status: 'failure',
      };
    }
  }

  /**
   * POST restrictionUpdate - Stores restrictions (flattened by periods)
   */
  async updateRestriction(
    dto: RestrictionUpdateRequestDto,
  ): Promise<RestrictionUpdateResponseDto> {
    await this.logInbound('restrictionUpdate', null, null, null, dto);

    try {
      for (const property of dto.data) {
        const propertyId = this.normalizeId(property.propertyId);
        const { roomDetails } = property;
        let insertedRowsForProperty = 0;

        const hotel = await this.prisma.dvi_hotel.findFirst({
          where: {
            axisrooms_property_id: propertyId,
            axisrooms_enabled: 1,
            deleted: { not: true },
          },
          select: { hotel_id: true, hotel_name: true },
        });

        const isValid = await this.validatePropertyMapping(propertyId);
        if (!isValid) {
          return {
            message: AXISROOMS_MESSAGES.INVALID_PROPERTY_ID,
            status: 'failure',
          };
        }

        for (const roomDetail of roomDetails) {
          const roomId = this.normalizeId(roomDetail.roomId);
          const { ratePlanDetails } = roomDetail;

          for (const ratePlanDetail of ratePlanDetails) {
            const ratePlanId = this.normalizeId(ratePlanDetail.ratePlanId);
            const canonicalRatePlanDefinition = this.resolveExternalRatePlanDefinition(ratePlanId);
            if (!canonicalRatePlanDefinition) {
              return {
                message: AXISROOMS_MESSAGES.INVALID_RATEPLAN_ID,
                status: 'failure',
              };
            }
            const internalRatePlanId = canonicalRatePlanDefinition?.defaultRateplanId || ratePlanId;
            const { restrictions } = ratePlanDetail;
            const { periods, type, value } = restrictions;

            await this.ensureRatePlanExists(propertyId, roomId, internalRatePlanId, {
              ratePlanName: canonicalRatePlanDefinition?.code || undefined,
            });

            // Insert one row per period
            for (const period of periods) {
              await this.prisma.axisrooms_restriction.create({
                data: {
                  axisrooms_property_id: propertyId,
                  room_id: roomId,
                  rateplan_id: ratePlanId,
                  start_date: new Date(period.startDate),
                  end_date: new Date(period.endDate),
                  type,
                  value,
                },
              });
              insertedRowsForProperty += 1;
            }
          }
        }

      }

      return {
        message: AXISROOMS_MESSAGES.RESTRICTION_UPDATE_SUCCESS,
        status: 'success',
      };
    } catch (error) {
      this.logger.error(`Restriction update error: ${error.message}`);
      return {
        message: `${AXISROOMS_MESSAGES.RESTRICTION_UPDATE_FAILED} ${error.message}`,
        status: 'failure',
      };
    }
  }
}
