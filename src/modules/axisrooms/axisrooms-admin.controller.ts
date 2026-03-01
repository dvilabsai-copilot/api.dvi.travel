import {
  Controller,
  Get,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../../auth/public.decorator';
import { AdminKeyGuard } from '../../common/guards/admin-key.guard';
import { PrismaService } from '../../prisma.service';

/**
 * Admin controller for AxisRooms hotel mapping exports
 * Requires x-admin-key header authentication
 */
@Controller('axisrooms/admin')
@Public() // Skip JWT auth
@UseGuards(AdminKeyGuard)
export class AxisRoomsAdminController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/v1/axisrooms/admin/hotels
   * Export AxisRooms hotel mappings in JSON format
   * 
   * Query params:
   * - enabled: Filter by axisrooms_enabled (default: 1)
   * - updatedAfter: ISO date string to filter hotels updated after this date
   * - limit: Number of results per page (default: 500)
   * - offset: Offset for pagination (default: 0)
   * - includeDetails: Include rooms and rate plans (default: false)
   */
  @Get('hotels')
  @HttpCode(HttpStatus.OK)
  async getHotels(
    @Query('enabled') enabled?: string,
    @Query('updatedAfter') updatedAfter?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('includeDetails') includeDetails?: string,
  ) {
    const enabledValue = enabled !== undefined ? parseInt(enabled) : 1;
    const limitValue = limit ? parseInt(limit) : 500;
    const offsetValue = offset ? parseInt(offset) : 0;
    const includeDetailsValue = includeDetails === 'true';

    // Build where clause
    const where: any = {
      axisrooms_enabled: enabledValue,
      deleted: { not: true },
      axisrooms_property_id: { not: null },
    };

    if (updatedAfter) {
      where.updatedon = { gt: new Date(updatedAfter) };
    }

    // Get total count
    const total = await this.prisma.dvi_hotel.count({ where });

    // Get hotels
    const hotels = await this.prisma.dvi_hotel.findMany({
      where,
      select: {
        hotel_id: true,
        hotel_name: true,
        hotel_city: true,
        hotel_state: true,
        hotel_country: true,
        axisrooms_property_id: true,
        axisrooms_enabled: true,
        updatedon: true,
      },
      orderBy: { updatedon: 'desc' },
      take: limitValue,
      skip: offsetValue,
    });

    // If includeDetails is true, fetch rooms and rate plans
    let data;
    if (includeDetailsValue) {
      data = await Promise.all(
        hotels.map(async (hotel) => {
          const rooms = await this.prisma.axisrooms_room.findMany({
            where: { axisrooms_property_id: hotel.axisrooms_property_id },
            select: {
              room_id: true,
              room_name: true,
            },
          });

          // For each room, get rate plans
          const roomsWithRatePlans = await Promise.all(
            rooms.map(async (room) => {
              const rateplans = await this.prisma.axisrooms_rateplan.findMany({
                where: {
                  axisrooms_property_id: hotel.axisrooms_property_id,
                  room_id: room.room_id,
                },
                select: {
                  rateplan_id: true,
                  rateplan_name: true,
                },
              });

              return {
                room_id: room.room_id,
                room_name: room.room_name,
                rateplans,
              };
            }),
          );

          return {
            hotel_id: hotel.hotel_id,
            hotel_name: hotel.hotel_name,
            hotel_city: hotel.hotel_city,
            hotel_state: hotel.hotel_state,
            hotel_country: hotel.hotel_country,
            propertyId: hotel.axisrooms_property_id,
            axisrooms_enabled: hotel.axisrooms_enabled,
            updatedon: hotel.updatedon,
            rooms: roomsWithRatePlans,
          };
        }),
      );
    } else {
      // Simple format without details
      data = hotels.map((hotel) => ({
        hotel_id: hotel.hotel_id,
        hotel_name: hotel.hotel_name,
        hotel_city: hotel.hotel_city,
        hotel_state: hotel.hotel_state,
        hotel_country: hotel.hotel_country,
        propertyId: hotel.axisrooms_property_id,
        axisrooms_enabled: hotel.axisrooms_enabled,
        updatedon: hotel.updatedon,
      }));
    }

    return {
      status: 'success',
      total,
      data,
    };
  }

  /**
   * GET /api/v1/axisrooms/admin/hotels/export
   * Export AxisRooms hotel mappings in CSV format
   * 
   * Query params: Same as /hotels endpoint (except includeDetails)
   */
  @Get('hotels/export')
  @HttpCode(HttpStatus.OK)
  async exportHotelsCsv(
    @Query('enabled') enabled?: string,
    @Query('updatedAfter') updatedAfter?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Res() res?: Response,
  ) {
    const enabledValue = enabled !== undefined ? parseInt(enabled) : 1;
    const limitValue = limit ? parseInt(limit) : 500;
    const offsetValue = offset ? parseInt(offset) : 0;

    // Build where clause
    const where: any = {
      axisrooms_enabled: enabledValue,
      deleted: { not: true },
      axisrooms_property_id: { not: null },
    };

    if (updatedAfter) {
      where.updatedon = { gt: new Date(updatedAfter) };
    }

    // Get hotels
    const hotels = await this.prisma.dvi_hotel.findMany({
      where,
      select: {
        axisrooms_property_id: true,
        hotel_name: true,
        hotel_city: true,
        hotel_state: true,
        hotel_country: true,
      },
      orderBy: { updatedon: 'desc' },
      take: limitValue,
      skip: offsetValue,
    });

    // Build CSV manually
    const csvHeader = 'propertyId,hotel_name,hotel_city,hotel_state,hotel_country\n';
    
    const csvRows = hotels.map((hotel) => {
      // Escape values that contain commas or quotes
      const escapeCSV = (value: string | null) => {
        if (!value) return '';
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      };

      return [
        escapeCSV(hotel.axisrooms_property_id),
        escapeCSV(hotel.hotel_name),
        escapeCSV(hotel.hotel_city),
        escapeCSV(hotel.hotel_state),
        escapeCSV(hotel.hotel_country),
      ].join(',');
    });

    const csv = csvHeader + csvRows.join('\n');

    // Set headers and send CSV
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="axisrooms_hotels.csv"');
    res.send(csv);
  }
}
