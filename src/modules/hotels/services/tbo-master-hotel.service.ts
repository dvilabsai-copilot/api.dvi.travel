import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { TBOHotelProvider } from '../providers/tbo-hotel.provider';
import { TboMasterPricePreviewDto, UpdateTboMasterHotelDto } from '../dto/tbo-master.dto';

@Injectable()
export class TboMasterHotelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tboProvider: TBOHotelProvider,
  ) {}

  async list(query: { search?: string; cityCode?: string; page?: number; limit?: number; priority?: string }) {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const search = String(query.search || '').trim();
    const cityCode = String(query.cityCode || '').trim();
    const priority = query.priority === undefined || query.priority === '' ? undefined : Number(query.priority) ? 1 : 0;
    const where: any = {
      status: 1,
      ...(cityCode ? { tbo_city_code: cityCode } : {}),
      ...(priority === undefined ? {} : { is_priority: priority }),
      ...(search
        ? {
            OR: [
              { hotel_name: { contains: search } },
              { tbo_hotel_code: { contains: search } },
              { city_name: { contains: search } },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.tbo_hotel_master.count({ where }),
      this.prisma.tbo_hotel_master.findMany({
        where,
        orderBy: [{ is_priority: 'desc' }, { hotel_name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { page, limit, total, items: items.map((item) => this.toResponse(item)) };
  }

  async get(code: string) {
    const item = await this.prisma.tbo_hotel_master.findUnique({ where: { tbo_hotel_code: String(code).trim() } });
    if (!item) throw new NotFoundException('TBO master hotel not found');
    return this.toResponse(item);
  }

  async update(code: string, dto: UpdateTboMasterHotelDto, userId?: number) {
    const existing = await this.prisma.tbo_hotel_master.findUnique({ where: { tbo_hotel_code: String(code).trim() } });
    if (!existing) throw new NotFoundException('TBO master hotel not found');
    const data: any = {};
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.amenities !== undefined) data.amenities = dto.amenities;
    if (dto.reviews !== undefined) data.reviews = dto.reviews;
    if (dto.isPriority !== undefined) data.is_priority = dto.isPriority ? 1 : 0;
    const updated = await this.prisma.tbo_hotel_master.update({ where: { tbo_hotel_code: existing.tbo_hotel_code }, data });
    return this.toResponse(updated);
  }

  async setPriority(code: string, isPriority: boolean) {
    const updated = await this.prisma.tbo_hotel_master.updateMany({
      where: { tbo_hotel_code: String(code).trim() },
      data: { is_priority: isPriority ? 1 : 0 },
    });
    if (!updated.count) throw new NotFoundException('TBO master hotel not found');
    return this.get(code);
  }

  async pricePreview(code: string, dto: TboMasterPricePreviewDto) {
    const hotel = await this.prisma.tbo_hotel_master.findUnique({ where: { tbo_hotel_code: String(code).trim() } });
    if (!hotel) throw new NotFoundException('TBO master hotel not found');
    if (new Date(dto.checkOut) <= new Date(dto.checkIn)) throw new BadRequestException('Check-out must be after check-in');
    const results = await this.tboProvider.search({
      cityCode: hotel.tbo_city_code,
      hotelCodes: hotel.tbo_hotel_code,
      checkInDate: dto.checkIn,
      checkOutDate: dto.checkOut,
      roomCount: dto.rooms,
      guestCount: dto.adults + (dto.children || 0),
      guestNationality: 'IN',
      occupancies: [{ adults: dto.adults, children: dto.children || 0 }],
    }, { mealPlanCode: dto.mealPlanCode });
    const matches = results.filter((result) => String(result.providerHotelCode || result.hotelCode) === hotel.tbo_hotel_code);
    if (!matches.length) return { status: 'NO_AVAILABILITY', hotelCode: hotel.tbo_hotel_code, options: [] };
    return {
      status: 'AVAILABLE',
      hotelCode: hotel.tbo_hotel_code,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      options: matches.map((result) => ({
        hotelName: result.hotelName,
        roomType: result.roomType,
        mealPlan: result.mealPlan,
        price: result.price,
        totalStayPrice: result.totalStayPrice,
        currency: result.currency,
        cancellationPolicy: result.cancellationPolicy,
        rateOptionId: result.rateOptionId,
        expiresAt: result.expiresAt,
      })),
    };
  }

  private toResponse(item: any) {
    return {
      id: item.id,
      hotelCode: item.tbo_hotel_code,
      cityCode: item.tbo_city_code,
      name: item.hotel_name,
      city: item.city_name,
      address: item.hotel_address,
      rating: item.star_rating,
      imageUrl: item.hotel_image_url,
      description: item.description,
      checkInTime: item.check_in_time,
      checkOutTime: item.check_out_time,
      facilities: Array.isArray(item.facilities) ? item.facilities : [],
      amenities: Array.isArray(item.amenities) ? item.amenities : [],
      reviews: Array.isArray(item.reviews) ? item.reviews : [],
      latitude: item.hotel_latitude,
      longitude: item.hotel_longitude,
      isPriority: Number(item.is_priority) === 1,
      status: item.status,
      updatedAt: item.updated_at,
    };
  }
}
