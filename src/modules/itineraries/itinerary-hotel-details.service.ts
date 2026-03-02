// FILE: src/itineraries/itinerary-hotel-details.service.ts
import itineraryDetailsMock from './mocks/itineraryDetails.json';
import itineraryHotelDetailsMock from './mocks/itineraryHotelDetails.json';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { dvi_itinerary_plan_details, Prisma } from '@prisma/client';

export interface ItineraryHotelTabDto {
  groupType: number;
  label: string;
  totalAmount: number;
}

export interface ItineraryHotelRowDto {
  groupType: number;
  itineraryRouteId: number;
  day: string;
  destination: string;
  hotelId: number;
  hotelName: string;
  category: number;
  roomType: string;
  mealPlan: string;
  totalHotelCost: number;
  totalHotelTaxAmount: number;
  // TBO Booking Code - for API interactions
  searchReference?: string;
  bookingCode?: string;
  // Provider source (tbo, resavenue, hobse)
  provider?: string;
  // Voucher cancellation status
  voucherCancelled?: boolean;
  itineraryPlanHotelDetailsId?: number;
  date?: string;
}

export interface ItineraryHotelDetailsResponseDto {
  quoteId: string;
  planId: number;
  hotelRatesVisible: boolean;
  hotelTabs: ItineraryHotelTabDto[];
  hotels: ItineraryHotelRowDto[];
  totalRoomCount: number;
}

/**
 * Room type option for dropdown
 */
export interface RoomTypeOptionDto {
  roomTypeId: number;
  roomTypeTitle: string;
}

/**
 * Room-level DTO, inspired by PHP structured_hotel_room_details[]
 */
export interface ItineraryHotelRoomDto {
  itineraryPlanId: number;
  itineraryRouteId: number;
  itineraryPlanHotelRoomDetailsId: number;
  hotelId: number;
  hotelName: string;
  hotelCategory: number | null;
  groupType: number;
  roomTypeId: number;
  roomTypeName: string;
  roomId: number;
  availableRoomTypes: RoomTypeOptionDto[];

  // Pricing & tax
  pricePerNight: number;
  gstType: string | null;
  gstPercentage: number;

  // Occupancy / extras – these are totals per (route,hotel,roomType,room)
  totalExtraBed: number;
  totalChildWithBed: number;
  totalChildWithoutBed: number;
  extraBedCharge: number;
  childWithBedCharge: number;
  childWithoutBedCharge: number;
}

export interface ItineraryHotelRoomDetailsResponseDto {
  quoteId: string;
  planId: number;
  rooms: ItineraryHotelRoomDto[];
}

const isMockMode = () =>
  String(process.env.ITINERARY_MOCK_MODE || '').toLowerCase() === 'true';

@Injectable()
export class ItineraryHotelDetailsService {
  private readonly logger = new Logger(ItineraryHotelDetailsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public endpoint-style method: used by /itineraries/hotel_details/:quoteId
   */
  async getHotelDetailsByQuoteId(
    quoteId: string,
  ): Promise<ItineraryHotelDetailsResponseDto> {

     // ✅ FIRST LINE inside method
  if (isMockMode()) {
    return {
      quoteId,
      planId: Number((itineraryDetailsMock as any).planId ?? 0),
      hotelRatesVisible: Boolean((itineraryHotelDetailsMock as any).hotelRatesVisible),
      hotelTabs: ((itineraryHotelDetailsMock as any).hotelTabs ?? []) as any,
      hotels: ((itineraryHotelDetailsMock as any).hotels ?? []) as any,
      totalRoomCount: Number((itineraryDetailsMock as any).roomCount ?? 0),
    };
  }

    const startTime = Date.now();
    this.logger.log(`\n🔍 HOTEL DETAILS SERVICE: Looking up quote ID: ${quoteId}`);

    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`⚠️  Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    this.logger.log(`✅ Found itinerary plan - ID: ${plan.itinerary_plan_ID}, Quote: ${plan.itinerary_quote_ID}`);
    
    const result = await this.getHotelDetailsForPlan(plan);
    
    this.logger.log(`📊 Hotel details retrieved - Tabs: ${result.hotelTabs?.length || 0}, Rows: ${result.hotels?.length || 0}`);
    this.logger.log(`⏱️  Service Processing Time: ${Date.now() - startTime}ms`);

    return result;
  }

  /**
   * Helper: Get available room types for a hotel based on route date
   * Mimics PHP getHOTEL_ROOM_TYPE_DETAIL('select_itineary_hotel')
   */
  private async getAvailableRoomTypesForHotel(
    hotelId: number,
    routeDate: Date,
  ): Promise<RoomTypeOptionDto[]> {
    const day = `day_${routeDate.getDate()}`;
    const month = routeDate.toLocaleString('en-US', { month: 'long' });
    const year = routeDate.getFullYear();

    // Query inspired by PHP: dvi_hotel_rooms + dvi_hotel_room_price_book + dvi_hotel_roomtype
    // Use Prisma.raw() for dynamic column names to avoid SQL injection and parameter issues
    const roomTypesRaw = await this.prisma.$queryRaw<any[]>`
      SELECT DISTINCT 
        PRICEBOOK.room_type_id, 
        ROOMTYPE.room_type_title
      FROM dvi_hotel_rooms ROOMS
      LEFT JOIN dvi_hotel_room_price_book PRICEBOOK 
        ON PRICEBOOK.hotel_id = ROOMS.hotel_id 
        AND ROOMS.room_type_id = PRICEBOOK.room_type_id
      LEFT JOIN dvi_hotel_roomtype ROOMTYPE 
        ON ROOMTYPE.room_type_id = ROOMS.room_type_id
      WHERE ROOMS.deleted = 0 
        AND ROOMS.status = 1 
        AND ROOMS.hotel_id = ${hotelId}
        AND PRICEBOOK.${Prisma.raw(day)} IS NOT NULL
        AND PRICEBOOK.month = ${month}
        AND PRICEBOOK.year = ${year}
        AND PRICEBOOK.price_type = 0
        AND PRICEBOOK.status = 1
        AND PRICEBOOK.deleted = 0
      GROUP BY PRICEBOOK.room_type_id
      ORDER BY PRICEBOOK.${Prisma.raw(day)} ASC
    `;

    return roomTypesRaw.map((rt) => ({
      roomTypeId: Number(rt.room_type_id ?? 0),
      roomTypeTitle: rt.room_type_title ?? '',
    }));
  }

 /**
 * NEW: Public endpoint-style method for /itineraries/hotel_room_details/:quoteId
 * ENHANCED: Returns room details from TBO API hotels with proper pricing
 * Shows multiple hotel options per category (Budget, Mid-Range, Premium, Luxury)
 */
async getHotelRoomDetailsByQuoteId(
  quoteId: string,
): Promise<ItineraryHotelRoomDetailsResponseDto> {
  const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_quote_ID: quoteId, deleted: 0 },
  });

  if (!plan) {
    throw new NotFoundException('Itinerary not found');
  }

  const planId = plan.itinerary_plan_ID;

  // 1) Get hotels from dvi_itinerary_plan_hotel_details (these are from TBO API)
  const hotelRowsRaw = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
    where: { itinerary_plan_id: planId, deleted: 0 },
    orderBy: [
      { group_type: 'asc' },
      { itinerary_route_id: 'asc' },
    ],
  });
  
  if (!hotelRowsRaw || hotelRowsRaw.length === 0) {
    return {
      quoteId: plan.itinerary_quote_ID ?? '',
      planId,
      rooms: [],
    };
  }

  // 2) Get routes for mapping
  const routes = await this.prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: planId, deleted: 0 },
  });

  const routeMap = new Map<number, any>(
    routes.map((r: any) => [Number(r.itinerary_route_ID), r]),
  );

  // 3) Get hotel master data to map hotel_id -> hotel_name
  const hotelIds = Array.from(
    new Set(
      hotelRowsRaw
        .map((h) => (h as any).hotel_id as number | null)
        .filter((id): id is number => typeof id === 'number' && id > 0),
    ),
  );

  const hotelMasters = hotelIds.length
    ? await this.prisma.dvi_hotel.findMany({
        where: { hotel_id: { in: hotelIds }, deleted: false },
      })
    : [];

  const hotelMap = new Map(
    hotelMasters.map((h) => [Number((h as any).hotel_id), h]),
  );

  // 4) Build room details from hotel rows - RETURN UNIQUE HOTELS ONLY
  // Group by hotel_id and route_id to avoid duplicates per room type
  const roomDetailsList: ItineraryHotelRoomDto[] = [];
  let roomDetailsId = 1;

  // Create a map to track unique hotels per route
  const hotelsByRoute = new Map<string, any[]>();

  hotelRowsRaw.forEach((hotelRow: any) => {
    const routeId = Number(hotelRow.itinerary_route_id ?? 0);
    const groupType = Number(hotelRow.group_type ?? 0);
    const hotelId = Number(hotelRow.hotel_id ?? 0);
    const key = `${routeId}-${groupType}`;

    if (!hotelsByRoute.has(key)) {
      hotelsByRoute.set(key, []);
    }
    hotelsByRoute.get(key)!.push(hotelRow);
  });

  // For each route/category group, create room entries for ALL unique hotels
  hotelsByRoute.forEach((hotelRowsForGroup, _key) => {
    // Get unique hotel IDs within this route/category group
    const uniqueHotels = new Map<number, any>();
    hotelRowsForGroup.forEach(row => {
      const hotelId = Number(row.hotel_id ?? 0);
      if (!uniqueHotels.has(hotelId)) {
        uniqueHotels.set(hotelId, row);
      }
    });

    // Create ONE room entry per UNIQUE hotel in this route/category
    uniqueHotels.forEach((hotelRow, hotelId) => {
      const routeId = Number(hotelRow.itinerary_route_id ?? 0);
      const groupType = Number(hotelRow.group_type ?? 0);
      
      // Get hotel master data for actual hotel name
      const hotelMaster = hotelMap.get(hotelId) || null;
      const hotelName = hotelMaster ? ((hotelMaster as any).hotel_name ?? 'Hotel') : 'Hotel';
      const hotelCategory = hotelMaster ? Number((hotelMaster as any).hotel_category ?? 2) : 2;
      
      // Create 1 room entry per unique hotel per category
      roomDetailsList.push({
        itineraryPlanId: planId,
        itineraryRouteId: routeId,
        itineraryPlanHotelRoomDetailsId: roomDetailsId++,
        hotelId,
        hotelName,
        hotelCategory,
        groupType,
        roomTypeId: groupType,
        roomTypeName: `${['Budget', 'Mid-Range', 'Premium', 'Luxury'][groupType - 1]} Room`,
        roomId: hotelId,
        availableRoomTypes: [
          {
            roomTypeId: groupType,
            roomTypeTitle: `${['Budget', 'Mid-Range', 'Premium', 'Luxury'][groupType - 1]} Room`,
          },
        ],
        pricePerNight: Number(hotelRow.total_hotel_cost ?? 0),
        gstType: '1',
        gstPercentage: 0,
        totalExtraBed: 0,
        totalChildWithBed: 0,
        totalChildWithoutBed: 0,
        extraBedCharge: 0,
        childWithBedCharge: 0,
        childWithoutBedCharge: 0,
      });
    });
  });

  return {
    quoteId: plan.itinerary_quote_ID ?? '',
    planId,
    rooms: roomDetailsList,
  };
}


  /**
   * Internal reusable method: used by ItineraryDetailsService when building the full details payload.
   */
  async getHotelDetailsForPlan(
    plan: dvi_itinerary_plan_details,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const planId = plan.itinerary_plan_ID;

    // 1) Visibility flag from plan (hotel_rates_visibility)
    const hotelRatesVisible: boolean =
      (plan as any).hotel_rates_visibility === 1 ||
      (plan as any).hotel_rates_visibility === true;

    // 2) Raw hotel rows from dvi_itinerary_plan_hotel_details
    const hotelRowsRaw =
      await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
        where: { itinerary_plan_id: planId, deleted: 0 },
        orderBy: [
          { group_type: 'asc' as const },
          { itinerary_route_date: 'asc' as const },
          { updatedon: 'desc' as const }, // ✅ Order by updatedon to get latest first
        ],
      });

    // ✅ Deduplicate: Keep only the LATEST hotel per (route, groupType)
    const hotelsByRouteAndGroup = new Map<string, any>();
    hotelRowsRaw.forEach((h: any) => {
      const key = `${h.itinerary_route_id}-${h.group_type}`;
      const existing = hotelsByRouteAndGroup.get(key);
      
      // Keep this one if: (1) No existing, (2) This has updatedon and existing doesn't, (3) This is newer
      if (!existing || 
          (!existing.updatedon && h.updatedon) ||
          (h.updatedon && existing.updatedon && new Date(h.updatedon) > new Date(existing.updatedon))) {
        hotelsByRouteAndGroup.set(key, h);
      }
    });
    
    const hotelRowsDeduped = Array.from(hotelsByRouteAndGroup.values());

    // 3) Distinct hotels for name/category
    const hotelIds = Array.from(
      new Set(
        hotelRowsDeduped
          .map((h) => (h as any).hotel_id as number | null)
          .filter((id): id is number => typeof id === 'number' && id > 0),
      ),
    );

    const hotelMasters = hotelIds.length
      ? await this.prisma.dvi_hotel.findMany({
          where: { hotel_id: { in: hotelIds }, deleted: false },
        })
      : [];

    const hotelMap = new Map(
      hotelMasters.map((h) => [Number((h as any).hotel_id), h]),
    );

    // 4) Per-group GRAND_TOTAL_OF_THE_HOTEL_CHARGES
    //    SUM(total_hotel_cost) + SUM(total_hotel_tax_amount)
    const hotelGroupsRaw =
      await this.prisma.dvi_itinerary_plan_hotel_details.groupBy({
        by: ['group_type'],
        where: { itinerary_plan_id: planId, deleted: 0 },
        _sum: {
          total_hotel_cost: true,
          total_hotel_tax_amount: true,
        },
      });

    const hotelTabs: ItineraryHotelTabDto[] = hotelGroupsRaw
      .map((g) => {
        const groupType = Number((g as any).group_type ?? 0) || 0;
        const totalHotelCost = Number(g._sum.total_hotel_cost ?? 0);
        const totalHotelTaxAmount = Number(g._sum.total_hotel_tax_amount ?? 0);
        const groupTotal = totalHotelCost + totalHotelTaxAmount;

        // NOTE: margins/markups are NOT applied here – this is pure SUM(cost + tax)
        return {
          groupType,
          label: `Recommended #${groupType}`,
          totalAmount: Number(groupTotal),
        };
      })
      .sort((a, b) => a.groupType - b.groupType);

    // 5) Per-row hotel list (with group_type & per-row cost)
    // Also check voucher cancellation status
    const hotelDetailsIds = hotelRowsDeduped.map(h => (h as any).itinerary_plan_hotel_details_ID).filter(id => id);
    
    // Fetch voucher cancellation statuses
    const voucherStatuses = hotelDetailsIds.length > 0
      ? await this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({
          where: {
            itinerary_plan_id: planId,
            itinerary_plan_hotel_details_ID: { in: hotelDetailsIds },
            deleted: 0,
          },
          select: {
            itinerary_plan_hotel_details_ID: true,
            hotel_voucher_cancellation_status: true,
          },
        })
      : [];

    const voucherStatusMap = new Map(
      voucherStatuses.map(v => [
        v.itinerary_plan_hotel_details_ID,
        v.hotel_voucher_cancellation_status === 1,
      ])
    );

    const hotels: ItineraryHotelRowDto[] = hotelRowsDeduped.map((h, idx) => {
      const master = hotelMap.get(Number((h as any).hotel_id)) || null;
      const dateLabel = h.itinerary_route_date
        ? h.itinerary_route_date.toISOString().slice(0, 10)
        : '';
      const hotelDetailsId = (h as any).itinerary_plan_hotel_details_ID;

      return {
        groupType: Number((h as any).group_type ?? 0) || 0,
        itineraryRouteId: Number((h as any).itinerary_route_id ?? 0) || 0,
        day: `Day ${idx + 1} | ${dateLabel}`,
        destination: (h as any).itinerary_route_location ?? '',
        hotelId: Number((h as any).hotel_id ?? 0) || 0,
        hotelName: master ? ((master as any).hotel_name ?? '') : '',
        category: master ? ((master as any).hotel_category ?? 0) : 0,
        roomType: '', // room/meal details can be wired later
        mealPlan: '',
        totalHotelCost: Number((h as any).total_hotel_cost ?? 0),
        totalHotelTaxAmount: Number((h as any).total_hotel_tax_amount ?? 0),
        voucherCancelled: voucherStatusMap.get(hotelDetailsId) || false,
        itineraryPlanHotelDetailsId: hotelDetailsId,
        date: dateLabel,
      };
    });

    // 6) Total room count (fallback)
    const totalRoomCount = hotelRowsRaw.reduce(
      (sum, h) => sum + ((h as any).total_no_of_rooms ?? 0),
      0,
    );

    return {
      quoteId: plan.itinerary_quote_ID ?? '',
      planId,
      hotelRatesVisible,
      hotelTabs,
      hotels,
      totalRoomCount,
    };
  }
}
