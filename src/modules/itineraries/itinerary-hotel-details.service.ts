// FILE: src/itineraries/itinerary-hotel-details.service.ts

import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { dvi_itinerary_plan_details, Prisma } from '@prisma/client';
import { haversineKm } from './utils/distance-utils';

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
  canonicalHotelId?: number | null;
  hotelCode?: string;
  hotelName: string;
  category: number;
  roomType: string;
  mealPlan: string;
  baseHotelCost?: number;
  basePricePerNight?: number;
  hotelMarginPercentage?: number;
  hotelMarginAmount?: number;
  hotelMarginGstAmount?: number;
  hotelRoomGstAmount?: number;
  hotelMealPlanCost?: number;
  hotelMealPlanGstAmount?: number;
  totalHotelCost: number;
  totalHotelTaxAmount: number;
  noOfRooms?: number;
  // TBO Booking Code - for API interactions
  searchReference?: string;
  bookingCode?: string;
  roomId?: string;
  rateId?: string;
  // Provider source (tbo, resavenue, hobse)
  provider?: string;
  providerDisplayName?: string;
  providerHotelCode?: string;
  rateOptionId?: string;
  bookingMode?: 'LIVE_API' | 'MANUAL_APPROVAL';
  priceSource?: 'LIVE_API' | 'DATABASE' | 'LEGACY_UNKNOWN';
  priceLabel?: string;
  pricePerNight?: number;
  totalStayPrice?: number;
  numberOfNights?: number;
  nightlyRates?: Array<{
    date: string;
    baseAmount: number;
    sellAmount: number;
  }>;
  requiresHotelApproval?: boolean;
  isLiveRate?: boolean;
  isLiveBookable?: boolean;
  isSelectable?: boolean;
  approvalStatus?: 'NOT_REQUESTED' | 'NOT_REQUIRED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  manualConfirmationStatus?: 'NOT_STARTED' | 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
  isBookable?: boolean;
  externalStay?: boolean;
  availabilityStatus?: 'AVAILABLE' | 'LIVE_AVAILABLE' | 'OFFLINE_APPROVAL_REQUIRED' | 'NO_SUPPLIER_AVAILABILITY' | 'NO_AVAILABILITY' | 'NOT_BOOKABLE';
  availabilityMessage?: string | null;
  availableAgainFrom?: string | null;
  // Voucher cancellation status
  voucherCancelled?: boolean;
  itineraryPlanHotelDetailsId?: number;
  date?: string;
  hotelCheckInDate?: string | null;
  actualGuestArrivalAt?: string | null;
  checkOutDate?: string | null;
  earlyCheckIn?: boolean;
  earlyCheckInExtraPaymentApplicable?: boolean;
  earlyCheckInPaymentStatus?: string | null;
  hotelierEarlyCheckInNote?: string | null;
  previousDayBillingSynthetic?: boolean;
  // Distance from route location to hotel (in kilometers) - calculated using Haversine formula
  hotelDistance?: string | null;
  facilities?: string[];
  amenities?: string[];
  inclusions?: string[];
  rateConditions?: string[];
  cancellationPolicy?: string[];
  mandatorySupplements?: string[];
  supplementSummary?: {
    hasSupplements?: boolean;
    supplementCount?: number;
    atPropertyChargeCount?: number;
    requiresReview?: boolean;
  };
}

export interface HotelPaginationMeta {
  page: number;
  pageSize: number;
  /** total rows in this group stored in DB cache */
  total: number;
  hasMore: boolean;
}

export interface HotelRoutePaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  groupType: number;
}

export interface ItineraryHotelDetailsResponseDto {
  quoteId: string;
  planId: number;
  hotelRatesVisible: boolean;
  showHotelMargins?: boolean;
  hotelTabs: ItineraryHotelTabDto[];
  hotels: ItineraryHotelRowDto[];
  restrictedHotels?: ItineraryHotelRowDto[];
  totalRoomCount: number;
  hotelAvailability?: HotelAvailabilityMetaDto;
  /** Present when ?page param is used; one entry per groupType requested */
  pagination?: Record<number, HotelPaginationMeta>;
  /** Per-route/day pagination metadata keyed by `${groupType}-${routeId}` */
  routePagination?: Record<string, HotelRoutePaginationMeta>;
}

export interface HotelAvailabilityMetaDto {
  hasSupplierHotels: boolean;
  supplierHotelCount: number;
  placeholderRowCount: number;
  totalSearchRoutes: number;
  emptySearchRoutes: number;
  isPlaceholderOnly: boolean;
  message: string;
}

/**
 * Room type option for dropdown
 */
export interface RoomTypeOptionDto {
  roomTypeId: number;
  roomTypeTitle: string;
  bookingCode?: string;
}

/**
 * Room-level DTO, inspired by PHP structured_hotel_room_details[]
 */
export interface ItineraryHotelRoomDto {
  itineraryPlanId: number;
  itineraryRouteId: number;
  itineraryPlanHotelRoomDetailsId: number;
  hotelId: number;
  canonicalHotelId?: number | null;
  hotelName: string;
  hotelCategory: number | null;
  groupType: number;
  roomTypeId: number;
  roomTypeName: string;
  roomId: number;
  provider?: string;
  providerDisplayName?: string;
  bookingCode?: string;
  searchReference?: string;
  availableRoomTypes: RoomTypeOptionDto[];
  mealPlan?: string;
  numberOfNights?: number;
  totalPrice?: number;
  currency?: string;
  facilities?: string[];
  amenities?: string[];
  inclusions?: string[];
  rateConditions?: string[];
  cancellationPolicy?: string[];
  pricePerNight?: number;
  totalStayPrice?: number;
  priceSource?: 'LIVE_API' | 'DATABASE' | 'LEGACY_UNKNOWN';
  bookingMode?: 'LIVE_API' | 'MANUAL_APPROVAL';
  priceLabel?: string;
  supplementSummary?: {
    hasSupplements: boolean;
    supplementCount: number;
    atPropertyChargeCount: number;
    requiresReview: boolean;
  };
  mandatorySupplements?: string[];
  isBookable?: boolean;
  externalStay?: boolean;
  availabilityStatus?: 'AVAILABLE' | 'LIVE_AVAILABLE' | 'OFFLINE_APPROVAL_REQUIRED' | 'NO_SUPPLIER_AVAILABILITY' | 'NO_AVAILABILITY' | 'NOT_BOOKABLE';
  availabilityMessage?: string | null;
  availableAgainFrom?: string | null;
  requiresHotelApproval?: boolean;
  isLiveRate?: boolean;
  isLiveBookable?: boolean;
  isSelectable?: boolean;
  approvalStatus?: 'NOT_REQUESTED' | 'NOT_REQUIRED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  manualConfirmationStatus?: 'NOT_STARTED' | 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';

  // Pricing & tax
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

@Injectable()
export class ItineraryHotelDetailsService {
  private readonly logger = new Logger(ItineraryHotelDetailsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private shouldShowHotelMargins(): boolean {
    return String(process.env.SHOW_HOTEL_MARGINS ?? '').trim().toLowerCase() === 'true';
  }

  /**
   * Public endpoint-style method: used by /itineraries/hotel_details/:quoteId
   */
  async getHotelDetailsByQuoteId(
    quoteId: string,
  ): Promise<ItineraryHotelDetailsResponseDto> {
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

    const pickLatestRow = (rows: any[]) => {
      return rows.reduce((latest: any, row: any) => {
        if (!latest) {
          return row;
        }

        if (!latest.updatedon && row.updatedon) {
          return row;
        }

        if (latest.updatedon && row.updatedon && new Date(row.updatedon) > new Date(latest.updatedon)) {
          return row;
        }

        return latest;
      }, null);
    };

    const actualHotelRowsByRouteAndGroup = new Map<string, any[]>();
    const previousDayBillingMarkerRowsByRouteAndGroup = new Map<string, any[]>();

    hotelRowsRaw.forEach((row: any) => {
      const key = `${row.itinerary_route_id}-${row.group_type}`;
      const isPreviousDayBillingMarker = Number(row.hotel_required ?? 0) === 2 && Number(row.hotel_id ?? 0) === 0;
      const targetMap = isPreviousDayBillingMarker
        ? previousDayBillingMarkerRowsByRouteAndGroup
        : actualHotelRowsByRouteAndGroup;
      const existingRows = targetMap.get(key) || [];
      existingRows.push(row);
      targetMap.set(key, existingRows);
    });

    const hotelRowsExpanded: any[] = [];
    actualHotelRowsByRouteAndGroup.forEach((rows, key) => {
      const actualRow = pickLatestRow(rows);
      if (!actualRow) {
        return;
      }

      const markerRow = pickLatestRow(previousDayBillingMarkerRowsByRouteAndGroup.get(key) || []);
      if (markerRow) {
        hotelRowsExpanded.push({
          ...actualRow,
          itinerary_route_date: markerRow.itinerary_route_date,
          itinerary_route_location:
            markerRow.itinerary_route_location || actualRow.itinerary_route_location,
          __actualHotelDate: actualRow.itinerary_route_date,
          __previousDayBillingSynthetic: true,
        });
      }

      hotelRowsExpanded.push(actualRow);
    });

    previousDayBillingMarkerRowsByRouteAndGroup.forEach((rows, key) => {
      if (actualHotelRowsByRouteAndGroup.has(key)) {
        return;
      }

      const markerRow = pickLatestRow(rows);
      if (markerRow) {
        hotelRowsExpanded.push(markerRow);
      }
    });

    hotelRowsExpanded.sort((a: any, b: any) => {
      const groupDiff = Number(a.group_type ?? 0) - Number(b.group_type ?? 0);
      if (groupDiff !== 0) {
        return groupDiff;
      }

      const aTime = a.itinerary_route_date ? new Date(a.itinerary_route_date).getTime() : 0;
      const bTime = b.itinerary_route_date ? new Date(b.itinerary_route_date).getTime() : 0;
      if (aTime !== bTime) {
        return aTime - bTime;
      }

      return Number(a.itinerary_route_id ?? 0) - Number(b.itinerary_route_id ?? 0);
    });

    // 3) Distinct hotels for name/category
    const hotelIds = Array.from(
      new Set(
        hotelRowsExpanded
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

    const hotelGroupTotals = new Map<number, number>();
    hotelRowsExpanded.forEach((row: any) => {
      const groupType = Number(row.group_type ?? 0) || 0;
      const currentTotal = hotelGroupTotals.get(groupType) || 0;
      const rowTotal =
        Number(row.total_hotel_cost ?? 0) + Number(row.total_hotel_tax_amount ?? 0);
      hotelGroupTotals.set(groupType, currentTotal + rowTotal);
    });

    const hotelTabs: ItineraryHotelTabDto[] = Array.from(hotelGroupTotals.entries())
      .map(([groupType, totalAmount]) => ({
        groupType,
        label: `Recommended #${groupType}`,
        totalAmount: Number(totalAmount),
      }))
      .sort((a, b) => a.groupType - b.groupType);

    // 5) Per-row hotel list (with group_type & per-row cost)
    // Also check voucher cancellation status
    const hotelDetailsIds = hotelRowsExpanded.map(h => (h as any).itinerary_plan_hotel_details_ID).filter(id => id);
    
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

    // Fetch route location IDs to get location coordinates for distance calculation
    const routeIds = Array.from(
      new Set(
        hotelRowsExpanded
          .map((h) => (h as any).itinerary_route_id as number | null)
          .filter((id): id is number => typeof id === 'number' && id > 0),
      ),
    );

    // Fetch route details to get location ID for each route
    const routeDetails = routeIds.length
      ? await this.prisma.dvi_itinerary_route_details.findMany({
          where: { itinerary_route_ID: { in: routeIds }, deleted: 0 },
          select: { itinerary_route_ID: true, location_id: true, no_of_days: true },
        })
      : [];

    const routeLocationMap = new Map(
      routeDetails.map((r) => [
        Number((r as any).itinerary_route_ID),
        Number((r as any).location_id),
      ]),
    );
    const routeDayNumberMap = new Map(
      routeDetails.map((r) => [
        Number((r as any).itinerary_route_ID),
        Number((r as any).no_of_days ?? 0),
      ]),
    );

    // Fetch stored location coordinates for destination locations
    const locationIds = Array.from(
      new Set(routeDetails.map((r) => Number((r as any).location_id)).filter((id) => id > 0)),
    );

    const storedLocations = locationIds.length
      ? await this.prisma.dvi_stored_locations.findMany({
          where: { location_ID: { in: locationIds }, deleted: 0 },
          select: {
            location_ID: true,
            destination_location_lattitude: true,
            destination_location_longitude: true,
          },
        })
      : [];

    const locationCoordinatesMap = new Map<number, { lat: number; lon: number }>();
    storedLocations.forEach((loc) => {
      const lat = Number((loc as any).destination_location_lattitude ?? 0);
      const lon = Number((loc as any).destination_location_longitude ?? 0);
      if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
        locationCoordinatesMap.set(Number((loc as any).location_ID), { lat, lon });
      }
    });

    const hotels: ItineraryHotelRowDto[] = hotelRowsExpanded.map((h) => {
      const master = hotelMap.get(Number((h as any).hotel_id)) || null;
      const dateLabel = h.itinerary_route_date
        ? h.itinerary_route_date.toISOString().slice(0, 10)
        : '';
      const hotelDetailsId = (h as any).itinerary_plan_hotel_details_ID;
      const routeId = Number((h as any).itinerary_route_id ?? 0);
      const routeDayNumber = routeDayNumberMap.get(routeId) || 0;
      const isSyntheticPreviousDayBilling = Boolean((h as any).__previousDayBillingSynthetic);
      const storedEarlyCheckIn = Number((h as any).early_checkin ?? 0) === 1;
      // The marker row represents the extra night; it must not hide the
      // structured metadata stored on the real selected hotel row. The
      // details page needs both rows to explain the billing date and the
      // guest's actual arrival/check-in date.
      const showEarlyCheckInDetails =
        isSyntheticPreviousDayBilling ||
        storedEarlyCheckIn;

      const toDateOnly = (value: unknown): string | null => {
        if (!value) return null;
        const parsed = value instanceof Date ? value : new Date(value as any);
        return Number.isNaN(parsed.getTime())
          ? null
          : parsed.toISOString().slice(0, 10);
      };

      const toIsoDateTime = (value: unknown): string | null => {
        if (!value) return null;
        const parsed = value instanceof Date ? value : new Date(value as any);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
      };

      const actualHotelDate = toDateOnly((h as any).__actualHotelDate);
      const fallbackCheckOutDate = actualHotelDate
        ? (() => {
            const parsed = new Date(`${actualHotelDate}T00:00:00.000Z`);
            parsed.setUTCDate(parsed.getUTCDate() + 1);
            return parsed.toISOString().slice(0, 10);
          })()
        : null;
      const hotelCheckInDate = showEarlyCheckInDetails
        ? toDateOnly((h as any).hotel_check_in_date) || dateLabel
        : null;
      const actualGuestArrivalAt = showEarlyCheckInDetails
        ? toIsoDateTime((h as any).actual_guest_arrival_at) ||
          toIsoDateTime((plan as any).trip_start_date_and_time)
        : null;
      const checkOutDate = showEarlyCheckInDetails
        ? toDateOnly((h as any).hotel_check_out_date) || fallbackCheckOutDate
        : null;
      const earlyCheckInExtraPaymentApplicable =
        showEarlyCheckInDetails &&
        (Number((h as any).early_checkin_extra_payment_applicable ?? 0) === 1 ||
          isSyntheticPreviousDayBilling);
      const earlyCheckInBillingMultiplier = earlyCheckInExtraPaymentApplicable ? 2 : 1;
      const earlyCheckInPaymentStatus = showEarlyCheckInDetails
        ? String(
            (h as any).early_checkin_payment_status ||
              'EXTRA_PAYMENT_APPLICABLE',
          )
        : null;
      const hotelierEarlyCheckInNote = showEarlyCheckInDetails
        ? String((h as any).early_checkin_note || '').trim() ||
          'Guest has opted for early morning check-in with extra payment. Room to be blocked from the previous night, with actual guest arrival/check-in on the next day early morning.'
        : null;

      // Calculate distance from route location to hotel using Haversine formula
      let hotelDistance: string | null = null;
      
      // Get hotel coordinates
      const hotelLat = master && (master as any).hotel_latitude ? 
        Number((master as any).hotel_latitude) : null;
      const hotelLon = master && (master as any).hotel_longitude ? 
        Number((master as any).hotel_longitude) : null;

      // Get route location coordinates
      const locationId = routeLocationMap.get(routeId);
      const routeCoords = locationId ? locationCoordinatesMap.get(locationId) : null;
      
      // Calculate distance if both hotel and route coordinates are available
      if (
        hotelLat &&
        hotelLon &&
        !isNaN(hotelLat) &&
        !isNaN(hotelLon) &&
        routeCoords &&
        routeCoords.lat &&
        routeCoords.lon
      ) {
        try {
          const distanceKm = haversineKm(
            routeCoords.lat,
            routeCoords.lon,
            hotelLat,
            hotelLon,
          );
          if (distanceKm > 0) {
            hotelDistance = `${distanceKm.toFixed(2)} KM`;
          }
        } catch (err) {
          // If calculation fails, leave as null
          hotelDistance = null;
        }
      }

      return {
        groupType: Number((h as any).group_type ?? 0) || 0,
        itineraryRouteId: routeId,
        day: isSyntheticPreviousDayBilling
          ? `Day ${routeDayNumber} (Previous Day) | ${dateLabel}`
          : `Day ${routeDayNumber || 0} | ${dateLabel}`,
        destination: (h as any).itinerary_route_location ?? '',
        hotelId: Number((h as any).hotel_id ?? 0) || 0,
        hotelName: master ? ((master as any).hotel_name ?? '') : '',
        category: master ? ((master as any).hotel_category ?? 0) : 0,
        roomType: '', // room/meal details can be wired later
        mealPlan: '',
        totalHotelCost: Number((h as any).total_hotel_cost ?? 0) * earlyCheckInBillingMultiplier,
        totalHotelTaxAmount: Number((h as any).total_hotel_tax_amount ?? 0) * earlyCheckInBillingMultiplier,
        voucherCancelled: voucherStatusMap.get(hotelDetailsId) || false,
        itineraryPlanHotelDetailsId: hotelDetailsId,
        date: dateLabel,
        hotelCheckInDate,
        actualGuestArrivalAt,
        checkOutDate,
        earlyCheckIn: showEarlyCheckInDetails,
        earlyCheckInExtraPaymentApplicable,
        earlyCheckInPaymentStatus,
        hotelierEarlyCheckInNote,
        previousDayBillingSynthetic: isSyntheticPreviousDayBilling,
        hotelDistance,
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
      showHotelMargins: this.shouldShowHotelMargins(),
      hotelTabs,
      hotels,
      totalRoomCount,
    };
  }
}
