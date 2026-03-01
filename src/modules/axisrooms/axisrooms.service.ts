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

@Injectable()
export class AxisRoomsService {
  private readonly logger = new Logger(AxisRoomsService.name);

  constructor(private prisma: PrismaService) {}

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
    await this.logInbound('productInfo', dto.propertyId, null, null, dto);

    // Find hotel by propertyId
    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: {
        axisrooms_property_id: dto.propertyId,
        axisrooms_enabled: 1,
        deleted: { not: true },
      },
    });

    if (!hotel) {
      return {
        message: 'Invalid propertyId',
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
        message: 'No data found',
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
      message: '',
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
    await this.logInbound('ratePlanInfo', dto.propertyId, dto.roomId, null, dto);

    const isValid = await this.validatePropertyMapping(dto.propertyId);
    if (!isValid) {
      return {
        message: 'Invalid propertyId',
        status: 'failure',
        data: [],
      };
    }

    const ratePlans = await this.prisma.axisrooms_rateplan.findMany({
      where: {
        axisrooms_property_id: dto.propertyId,
        room_id: dto.roomId,
      },
    });

    if (!ratePlans || ratePlans.length === 0) {
      return {
        message: 'No data found',
        status: 'failure',
        data: [],
      };
    }

    const data: RatePlanDataDto[] = ratePlans.map((rp) => ({
      rateplanId: rp.rateplan_id,
      ratePlanName: rp.rateplan_name,
      occupancy: Array.isArray(rp.occupancy) ? rp.occupancy as string[] : [],
      validity: {
        startDate: '2014-06-02', // Placeholder - adjust based on your business logic
        endDate: '2099-12-31',
      },
      commissionPerc: rp.commission_perc || '0.0',
      taxPerc: rp.tax_perc || '0.0',
      currency: rp.currency || 'INR',
    }));

    return {
      message: '',
      status: 'success',
      data,
    };
  }

  /**
   * POST inventoryUpdate - Stores or updates inventory
   */
  async updateInventory(
    dto: InventoryUpdateRequestDto,
  ): Promise<InventoryUpdateResponseDto> {
    const { propertyId, roomId, inventory } = dto.data;

    await this.logInbound('inventoryUpdate', propertyId, roomId, null, dto);

    const isValid = await this.validatePropertyMapping(propertyId);
    if (!isValid) {
      return {
        message: 'Invalid propertyId',
        status: 'failure',
      };
    }

    try {
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

      return {
        message: '',
        status: 'success',
      };
    } catch (error) {
      this.logger.error(`Inventory update error: ${error.message}`);
      return {
        message: error.message,
        status: 'failure',
      };
    }
  }

  /**
   * POST rateUpdate - Stores or updates rates with dynamic occupancy
   */
  async updateRate(
    dto: RateUpdateRequestDto,
  ): Promise<RateUpdateResponseDto> {
    const { propertyId, roomId, rateplanId, rate } = dto.data;

    await this.logInbound('rateUpdate', propertyId, roomId, rateplanId, dto);

    const isValid = await this.validatePropertyMapping(propertyId);
    if (!isValid) {
      return {
        message: 'Invalid propertyId',
        status: 'failure',
      };
    }

    try {
      for (const rateEntry of rate) {
        const { startDate, endDate, ...occupancyRates } = rateEntry;

        await this.prisma.axisrooms_rate.upsert({
          where: {
            axisrooms_property_id_room_id_rateplan_id_start_date_end_date: {
              axisrooms_property_id: propertyId,
              room_id: roomId,
              rateplan_id: rateplanId,
              start_date: new Date(startDate),
              end_date: new Date(endDate),
            },
          },
          update: {
            occupancy_rates: occupancyRates,
            received_at: new Date(),
          },
          create: {
            axisrooms_property_id: propertyId,
            room_id: roomId,
            rateplan_id: rateplanId,
            start_date: new Date(startDate),
            end_date: new Date(endDate),
            occupancy_rates: occupancyRates,
          },
        });
      }

      return {
        message: '',
        status: 'success',
      };
    } catch (error) {
      this.logger.error(`Rate update error: ${error.message}`);
      return {
        message: error.message,
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
        const { propertyId, roomDetails } = property;

        const isValid = await this.validatePropertyMapping(propertyId);
        if (!isValid) {
          return {
            message: 'Invalid propertyId',
            status: 'failure',
          };
        }

        for (const roomDetail of roomDetails) {
          const { roomId, ratePlanDetails } = roomDetail;

          for (const ratePlanDetail of ratePlanDetails) {
            const { ratePlanId, restrictions } = ratePlanDetail;
            const { periods, type, value } = restrictions;

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
            }
          }
        }
      }

      return {
        message: '',
        status: 'success',
      };
    } catch (error) {
      this.logger.error(`Restriction update error: ${error.message}`);
      return {
        message: error.message,
        status: 'failure',
      };
    }
  }
}
