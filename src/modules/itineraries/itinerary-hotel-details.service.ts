// FILE: src/itineraries/itinerary-hotel-details.service.ts

import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { dvi_itinerary_plan_details, Prisma } from '@prisma/client';
import { haversineKm } from './utils/distance-utils';
import { resolvePersistedHotelIdentity } from './utils/hotel-selection-identity.util';
import {
  calculateHotelRouteNightPayable,
  resolveStoredHotelPayablePricing,
} from './utils/hotel-payable-pricing.util';
import {
  buildHotelSelectionState,
  HotelSelectionGroupView,
  resolveHotelRequiredRoutes,
} from './utils/hotel-selection-view-state.util';

export interface ItineraryHotelTabDto {
  groupType: number;
  label: string;
  totalAmount: number | null;
  partialTotal?: number;
  targetAmount?: number | null;
  complete?: boolean;
  diversityScore?: number;
  repeatedAcrossGroupsHotelIds?: string[];
  sameOptionAcrossGroups?: string[];
  duplicateWithinPackageHotelIds?: string[];
  repeatedFromGroups?: number[];
  stayResults?: Array<{
    stayKey: string;
    parentRouteId: number;
    routeIds: number[];
    destination: string;
    checkInDate: string;
    checkOutDate: string;
    nights: number;
    state: 'SELECTED' | 'OFFLINE_FALLBACK' | 'UNAVAILABLE';
    reason?: string;
    totalPrice?: number;
  }>;
}

export interface ItineraryHotelRowDto {
  groupType: number;
  itineraryRouteId: number;
  routeIds?: number[];
  stayKey?: string;
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
  baseTotalPrice?: number;
  hotelMarginPercentage?: number;
  hotelMarginAmount?: number;
  // Canonical aggregate margin alias consumed by hotel price breakdowns.
  // Keep this aligned with hotelMarginAmount for every provider.
  hotelMarginTotalAmount?: number;
  hotelMarginBaseAmount?: number;
  hotelMarginGstAmount?: number;
  hotelRoomGstAmount?: number;
  hotelMealPlanCost?: number;
  hotelMealPlanGstAmount?: number;
  totalExtraBedCost?: number;
  totalExtraBedCostGstAmount?: number;
  totalChildWithBedCost?: number;
  totalChildWithBedCostGstAmount?: number;
  totalChildWithoutBedCost?: number;
  totalChildWithoutBedCostGstAmount?: number;
  extraBedCount?: number;
  extraBedRate?: number;
  childWithBedCount?: number;
  childWithBedRate?: number;
  childWithoutBedCount?: number;
  childWithoutBedRate?: number;
  totalRoomCost?: number;
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
  rateOptions?: Array<Record<string, unknown>>;
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
  availableDates?: string[];
  unavailableDates?: string[];
  completeStayBookable?: boolean;
  completeStayRouteIds?: number[];
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
  optionKey?: string;
  isSelected?: boolean;
  selectionOrigin?: 'AUTO_SELECTED' | 'USER_SELECTED';
  selectionStatus?: 'AVAILABLE' | 'UNAVAILABLE' | 'REVIEW_REQUIRED';
  selectionReason?: string | null;
  distanceKm?: number | null;
  distanceStatus?: 'WITHIN_RADIUS' | 'OUTSIDE_RADIUS' | 'UNKNOWN';
  distanceReference?: 'HOTSPOT' | 'DESTINATION_CENTRE' | 'ROUTE_DESTINATION' | 'UNKNOWN';
  availabilityState?: 'AVAILABLE' | 'UNAVAILABLE' | 'RESTRICTED' | 'STALE' | 'UNKNOWN' | 'OFFLINE_APPROVAL_REQUIRED';
  selection?: {
    hotelName?: string | null;
    category?: number | null;
    provider?: string | null;
    hotelCode?: string | number | null;
    roomType?: string | null;
    mealPlan?: string | null;
    totalPrice?: number | null;
    pricePerNight?: number | null;
    currency?: string | null;
    optionKey?: string | null;
    rateOptionId?: string | null;
    rateId?: string | null;
    bookingCode?: string | null;
    searchReference?: string | null;
    searchRunId?: string | null;
    availabilityStatus?: string | null;
    status?: string;
    selectionOrigin?: string;
    selectionId?: number;
  };
  selectionId?: number;
  requiresPriceReacceptance?: boolean;
  selectedPriceSnapshot?: unknown;
  identityMismatch?: boolean;
  requestedMealPlanCode?: string;
  availableMealPlanCodes?: string[];
  autoSelectionBlocked?: boolean;
  autoSelectionBlockCode?: 'REQUESTED_MEAL_PLAN_PRICE_UNAVAILABLE';
  autoSelectionBlockMessage?: string;
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
  mealPlanCode?: string | null;
  hotelRatesVisible: boolean;
  showHotelMargins?: boolean;
  hotelTabs: ItineraryHotelTabDto[];
  /** Complete server-authoritative selection/total view for each package. */
  hotelSelectionState?: HotelSelectionGroupView[];
  hotels: ItineraryHotelRowDto[];
  restrictedHotels?: ItineraryHotelRowDto[];
  totalRoomCount: number;
  hotelAvailability?: HotelAvailabilityMetaDto;
  recommendationAlgorithm?: 'v1' | 'v2';
  recommendationGeneration?: RecommendationGenerationDto;
 /** Present when ?page param is used; one entry per groupType requested */
  pagination?: Record<number, HotelPaginationMeta>;
 /** Per-route/day pagination metadata keyed by `${groupType}-${routeId}` */
  routePagination?: Record<string, HotelRoutePaginationMeta>;
}

export interface RecommendationGenerationDto {
  version: 'v1' | 'v2';
  algorithm: 'LEGACY_PRICE_PACKAGE' | 'TARGET_PRICE_DIVERSITY_BEAM_SEARCH';
  searchRunId?: string;
  generatedAt?: string;
  warnings: string[];
}

export interface HotelAvailabilityMetaDto {
  /** Complete route/day inventory shared by every recommendation pane. */
  sharedHotelInventory?: ItineraryHotelRowDto[];
  /** Internal authoritative group candidates used by reset reconciliation. */
  authoritativeRecommendationRows?: any[];
  hasSupplierHotels: boolean;
  supplierHotelCount: number;
  placeholderRowCount: number;
  totalSearchRoutes: number;
  emptySearchRoutes: number;
  isPlaceholderOnly: boolean;
  message: string;
  availabilityState?: 'NOT_CHECKED' | 'CHECKING' | 'FRESH' | 'STALE' | 'PARTIAL' | 'FAILED';
  recommendationAlgorithm?: 'v1' | 'v2';
  searchRunId?: string;
  recommendationGeneration?: RecommendationGenerationDto;
  checkedAt?: string;
  expiresAt?: string | null;
  providerErrors?: Array<{ provider?: string; message?: string }>;
  unavailableSelectionCount?: number;
  emptyStayBlocks?: Array<{
    routeIds: number[];
    dayNumbers: number[];
    dates: string[];
    destination: string;
  }>;
  stayRoutes?: Array<{
    routeId: number;
    dayNumber: number;
    date: string;
    destination: string;
  }>;
  offlineFetch?: {
    requestedRouteIds: number[];
    fetchedHotelCount: number;
    noResultRouteIds: number[];
  };
  mealPlanAutoSelectionBlocks?: Array<{
    routeId: number;
    groupType: number;
    date: string;
    destination: string;
    requestedMealPlanCode: string;
    availableMealPlanCodes: string[];
    code: string;
    message: string;
  }>;
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
  date?: string;
  checkInDate?: string;
  checkOutDate?: string;
  itineraryRouteDate?: string;
  destination?: string;
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
  rateOptionId?: string;
  optionKey?: string;
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
  availableDates?: string[];
  unavailableDates?: string[];
  completeStayBookable?: boolean;
  completeStayRouteIds?: number[];
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

 // Occupancy / extras these are totals per (route,hotel,roomType,room)
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
 this.logger.log(`\n HOTEL DETAILS SERVICE: Looking up quote ID: ${quoteId}`);

    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
 this.logger.warn(` Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

 this.logger.log(` Found itinerary plan - ID: ${plan.itinerary_plan_ID}, Quote: ${plan.itinerary_quote_ID}`);

    const result = await this.getHotelDetailsForPlan(plan);

 this.logger.log(` Hotel details retrieved - Tabs: ${result.hotelTabs?.length || 0}, Rows: ${result.hotels?.length || 0}`);
 this.logger.log(` Service Processing Time: ${Date.now() - startTime}ms`);

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
      const identity = resolvePersistedHotelIdentity(hotelRow, hotelMaster);
      const hotelName = identity.hotelName || 'Hotel';
      const hotelCategory = identity.category || 2;

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
 { updatedon: 'desc' as const }, // Order by updatedon to get latest first
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
    const routeDetails = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        location_id: true,
        location_name: true,
        no_of_days: true,
      },
    });

    const routeLocationMap = new Map(
      routeDetails.map((r) => [
        Number((r as any).itinerary_route_ID),
        Number((r as any).location_id),
      ]),
    );
    const routeDestinationMap = new Map(
      routeDetails.map((r: any) => [
        Number(r.itinerary_route_ID),
        String(r.location_name ?? '').trim(),
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
      const rawSelectedPriceSnapshot = (h as any).selected_price_snapshot;
      let selectedPriceSnapshot: Record<string, unknown> = {};
      if (rawSelectedPriceSnapshot && typeof rawSelectedPriceSnapshot === 'object') {
        selectedPriceSnapshot = rawSelectedPriceSnapshot as Record<string, unknown>;
      } else if (rawSelectedPriceSnapshot) {
        try {
          const parsed = JSON.parse(String(rawSelectedPriceSnapshot));
          if (parsed && typeof parsed === 'object') {
            selectedPriceSnapshot = parsed as Record<string, unknown>;
          }
        } catch {
          // Preserve the raw snapshot below; malformed legacy snapshots do
          // not prevent the itinerary details response from loading.
        }
      }
      const persistedIdentity = resolvePersistedHotelIdentity(h, master);
      if (persistedIdentity.provider === 'offline' && !persistedIdentity.consistent) {
        this.logger.warn(JSON.stringify({
          event: 'PERSISTED_OFFLINE_HOTEL_IDENTITY_MISMATCH',
          planId,
          routeId,
          groupType: Number((h as any).group_type || 0),
          hotelId: Number((h as any).hotel_id || 0),
          mismatches: persistedIdentity.mismatches,
        }));
      }
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
      const snapshotBaseTotal = Number(
        selectedPriceSnapshot.baseTotalPrice ?? selectedPriceSnapshot.base_total_price ?? 0,
      );
      const snapshotBasePerNight = Number(
        selectedPriceSnapshot.basePricePerNight ?? selectedPriceSnapshot.base_price_per_night ?? 0,
      );
      const snapshotRoomCount = Math.max(
        Number((h as any).total_no_of_rooms ?? selectedPriceSnapshot.roomCount ?? 1),
        1,
      );
      const authoritativeBaseHotelCost = snapshotBaseTotal > 0
        ? snapshotBaseTotal
        : snapshotBasePerNight > 0
          ? snapshotBasePerNight * snapshotRoomCount
          // Legacy selected rows keep the room base in total_room_cost while
          // total_hotel_cost is the persisted payable column. Keep the room
          // base available so the margin can be reconstructed when an older
          // row has not stored a selected-price snapshot.
          : Number((h as any).total_room_cost ?? 0);
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

      const storedTotal = Number((h as any).total_hotel_cost ?? 0);
      const storedTax = Number((h as any).total_hotel_tax_amount ?? 0);
      const storedMargin = Number((h as any).hotel_margin_rate ?? 0);
      const storedMarginPercentage = Number((h as any).hotel_margin_percentage ?? 0);
      const provider = String((h as any).hotel_provider || '').trim().toLowerCase();
      const isDatabaseOccupancyProvider = provider === 'offline' || provider === 'axisrooms';
      const snapshotMarginPercentage = Number(
        selectedPriceSnapshot.hotelMarginPercentage ??
        selectedPriceSnapshot.hotel_margin_percentage ??
        0,
      );
      const storedPricing = resolveStoredHotelPayablePricing({
        storedTotal,
        baseTotal: authoritativeBaseHotelCost,
        marginAmount: storedMargin,
        marginPercentage: storedMarginPercentage,
      });
      const isOffline = provider === 'offline';
      const snapshotNightlyRates = Array.isArray(selectedPriceSnapshot.nightlyRates)
        ? selectedPriceSnapshot.nightlyRates as Record<string, unknown>[]
        : [];
      const snapshotPricingScope = String(selectedPriceSnapshot.pricingScope || '').trim().toUpperCase();
      const continuousStayRouteNight = snapshotNightlyRates.length > 1
        ? snapshotNightlyRates.find(
            (night) => String(night.date || '').slice(0, 10) === dateLabel,
          )
        : undefined;
      const legacyOfflineRouteNight = isOffline && snapshotPricingScope !== 'ROUTE_NIGHT' && snapshotNightlyRates.length > 1
        ? snapshotNightlyRates.find(
            (night) => String(night.date || '').slice(0, 10) === dateLabel,
          )
        : undefined;
      // Offline rate snapshots represent a continuous stay, while this API
      // row represents one itinerary route/night. Return the route-night
      // amount to the UI and retain the complete stay amount separately.
      // This keeps API totals authoritative and prevents a two-night amount
      // from being charged once on every daily row.
      const offlinePricePerNight = Number(
        selectedPriceSnapshot.pricePerNight ?? selectedPriceSnapshot.price_per_night ?? 0,
      );
      const offlineBasePerNight = Number(
        selectedPriceSnapshot.basePricePerNight ?? selectedPriceSnapshot.base_price_per_night ?? 0,
      );
      // Offline snapshots may have stored the all-room one-night base in
      // basePricePerNight. The response contract is explicit: expose the
      // per-room rate in basePricePerNight and the all-room one-night base in
      // baseTotalPrice. The payable row amount remains totalHotelCost.
      const snapshotRoomTotal = Number(
        selectedPriceSnapshot.totalRoomCost ??
        selectedPriceSnapshot.total_room_cost ??
        0,
      );
      const legacyOfflineNightBase = Number(legacyOfflineRouteNight?.baseAmount ?? 0);
      const offlineBaseTotal = legacyOfflineNightBase > 0
        ? legacyOfflineNightBase
        : snapshotRoomTotal > 0
          ? snapshotRoomTotal
        : snapshotBaseTotal > 0
          ? snapshotBaseTotal
          : offlineBasePerNight > 0
            ? Number((offlineBasePerNight * snapshotRoomCount).toFixed(2))
            : 0;
      const offlineBaseRoomRate = offlineBaseTotal > 0
        ? Number((offlineBaseTotal / snapshotRoomCount).toFixed(2))
        : offlineBasePerNight;
      const offlineMarginPerNight = Number(
        selectedPriceSnapshot.hotelMarginAmount ?? selectedPriceSnapshot.hotel_margin_amount ?? 0,
      );
      const payableHotelCost = (isOffline && offlinePricePerNight > 0
        ? offlinePricePerNight
        : storedPricing.payableTotal) * earlyCheckInBillingMultiplier;
      const baseHotelCost = (isOffline && offlineBaseTotal > 0
        ? offlineBaseRoomRate
        : authoritativeBaseHotelCost) * earlyCheckInBillingMultiplier;
      const storedHotelMarginAmount = (isOffline && offlineMarginPerNight > 0
        ? offlineMarginPerNight
        : storedPricing.marginAmount) * earlyCheckInBillingMultiplier;
      const positiveOr = (...values: unknown[]) => values.map(Number).find((value) => Number.isFinite(value) && value > 0) || 0;
      const extraBedCount = positiveOr(
        selectedPriceSnapshot.extraBedCount,
        selectedPriceSnapshot.extra_bed_count,
        (h as any).room_extra_bed_count,
        (h as any).total_extra_bed,
        (plan as any).total_extra_bed,
      );
      const childWithBedCount = positiveOr(
        selectedPriceSnapshot.childWithBedCount,
        selectedPriceSnapshot.child_with_bed_count,
        (h as any).room_cwb_count,
        (h as any).total_child_with_bed,
        (plan as any).total_child_with_bed,
      );
      const childWithoutBedCount = positiveOr(
        selectedPriceSnapshot.childWithoutBedCount,
        selectedPriceSnapshot.child_without_bed_count,
        (h as any).room_cnb_count,
        (h as any).total_child_without_bed,
        (plan as any).total_child_without_bed,
      );
      const storedExtraBedCost = Number((h as any).total_extra_bed_cost ?? 0);
      const storedChildWithBedCost = Number((h as any).total_childwith_bed_cost ?? 0);
      const storedChildWithoutBedCost = Number((h as any).total_childwithout_bed_cost ?? 0);
      // Offline/AxisRooms supplement values are database-authoritative. Do
      // not revive an old selected_price_snapshot value when the current
      // persisted DB amount is zero; zero means the required rate was not
      // available and the option must not be priced as available.
      const snapshotExtraBedCost = Number(selectedPriceSnapshot.totalExtraBedCost ?? selectedPriceSnapshot.extraBedAmount ?? 0);
      const snapshotChildWithBedCost = Number(selectedPriceSnapshot.totalChildWithBedCost ?? selectedPriceSnapshot.childWithBedAmount ?? 0);
      const snapshotChildWithoutBedCost = [
        selectedPriceSnapshot.totalChildWithoutBedCost,
        selectedPriceSnapshot.childWithoutBedAmount,
        selectedPriceSnapshot.extraChildAmount,
        selectedPriceSnapshot.extra_child_amount,
      ].map(Number).find((value) => Number.isFinite(value) && value > 0) || 0;
      const legacyExtraBedCost = Number(selectedPriceSnapshot.extraBedRate ?? 0) * extraBedCount;
      const legacyChildWithBedCost = Number(selectedPriceSnapshot.childWithBedRate ?? 0) * childWithBedCount;
      const legacyChildWithoutBedCost = Number(selectedPriceSnapshot.childWithoutBedRate ?? 0) * childWithoutBedCount;
      const extraBedCost = (legacyOfflineRouteNight && legacyExtraBedCost > 0
        ? legacyExtraBedCost
        : isDatabaseOccupancyProvider
          ? snapshotExtraBedCost > 0 ? snapshotExtraBedCost : storedExtraBedCost
          : storedExtraBedCost > 0 ? storedExtraBedCost : Number(selectedPriceSnapshot.extraBedAmount ?? 0)) * earlyCheckInBillingMultiplier;
      const childWithBedCost = (legacyOfflineRouteNight && legacyChildWithBedCost > 0
        ? legacyChildWithBedCost
        : isDatabaseOccupancyProvider
          ? snapshotChildWithBedCost > 0 ? snapshotChildWithBedCost : storedChildWithBedCost
          : storedChildWithBedCost > 0 ? storedChildWithBedCost : Number(selectedPriceSnapshot.childWithBedAmount ?? 0)) * earlyCheckInBillingMultiplier;
      const childWithoutBedCost = (legacyOfflineRouteNight && legacyChildWithoutBedCost > 0
        ? legacyChildWithoutBedCost
        : isDatabaseOccupancyProvider
          ? snapshotChildWithoutBedCost > 0 ? snapshotChildWithoutBedCost : storedChildWithoutBedCost
          : storedChildWithoutBedCost > 0 ? storedChildWithoutBedCost : snapshotChildWithoutBedCost) * earlyCheckInBillingMultiplier;
      const roomCountForMargin = Math.max(
        Number((h as any).total_no_of_rooms ?? 0),
        Number((plan as any).preferred_room_count ?? 0),
        1,
      );
      // total_room_cost / snapshot.totalRoomCost is already the room-only
      // amount for the requested room count. Do not multiply it by the room
      // count again; doing so inflated the margin while totalHotelCost still
      // came from the correctly persisted payable amount.
      const persistedRoomTotal = Number(
        selectedPriceSnapshot.totalRoomCost ??
        selectedPriceSnapshot.total_room_cost ??
        (h as any).total_room_cost ??
        0,
      );
      const marginRoomCost = Number((
        Number(continuousStayRouteNight?.baseAmount ?? continuousStayRouteNight?.totalRoomCost ?? 0) > 0
          ? Number(continuousStayRouteNight?.baseAmount ?? continuousStayRouteNight?.totalRoomCost) * earlyCheckInBillingMultiplier
          : persistedRoomTotal > 0
            ? persistedRoomTotal * earlyCheckInBillingMultiplier
          : baseHotelCost * roomCountForMargin
      ).toFixed(2));
      const hotelMarginBaseAmount = Number((
        marginRoomCost +
        Number((h as any).total_hotel_meal_plan_cost ?? 0) * earlyCheckInBillingMultiplier +
        extraBedCost +
        childWithBedCost +
        childWithoutBedCost
      ).toFixed(2));
      const effectiveMarginPercentage = storedPricing.marginPercentage > 0
        ? storedPricing.marginPercentage
        : snapshotMarginPercentage;
      const hotelMarginAmount = effectiveMarginPercentage > 0
        ? Number((hotelMarginBaseAmount * effectiveMarginPercentage / 100).toFixed(2))
        : storedHotelMarginAmount;
      const routeNightPayableHotelCost = continuousStayRouteNight
        ? calculateHotelRouteNightPayable({
            marginBaseAmount: hotelMarginBaseAmount,
            marginPercentage: effectiveMarginPercentage,
            fallbackMarginAmount: storedHotelMarginAmount,
            taxAmount: storedTax,
            billingMultiplier: earlyCheckInBillingMultiplier,
          })
        : payableHotelCost;
      const extraBedRate = isDatabaseOccupancyProvider
        ? Number(extraBedCount > 0 ? extraBedCost / earlyCheckInBillingMultiplier / extraBedCount : 0)
        : Number((h as any).extra_bed_rate ?? selectedPriceSnapshot.extraBedRate ?? (extraBedCount > 0 ? extraBedCost / extraBedCount : 0));
      const childWithBedRate = isDatabaseOccupancyProvider
        ? Number(childWithBedCount > 0 ? childWithBedCost / earlyCheckInBillingMultiplier / childWithBedCount : 0)
        : Number(selectedPriceSnapshot.childWithBedRate ?? (childWithBedCount > 0 ? childWithBedCost / childWithBedCount : 0));
      const childWithoutBedRate = isDatabaseOccupancyProvider
        ? Number(childWithoutBedCount > 0 ? childWithoutBedCost / earlyCheckInBillingMultiplier / childWithoutBedCount : 0)
        : Number(selectedPriceSnapshot.childWithoutBedRate ?? (childWithoutBedCount > 0 ? childWithoutBedCost / childWithoutBedCount : 0));

      return {
        groupType: Number((h as any).group_type ?? 0) || 0,
        itineraryRouteId: routeId,
        day: isSyntheticPreviousDayBilling
          ? `Day ${routeDayNumber} (Previous Day) | ${dateLabel}`
          : `Day ${routeDayNumber || 0} | ${dateLabel}`,
        destination:
          String((h as any).itinerary_route_location ?? '').trim() ||
          routeDestinationMap.get(routeId) ||
          '',
        hotelId: Number((h as any).hotel_id ?? 0) || 0,
        hotelName: persistedIdentity.hotelName,
        category: persistedIdentity.category,
        roomType: String(
          selectedPriceSnapshot.roomType ||
          selectedPriceSnapshot.roomTypeName ||
          (h as any).room_type ||
          '',
        ).trim(),
        mealPlan: String(
          selectedPriceSnapshot.mealPlan ||
          selectedPriceSnapshot.mealPlanCode ||
          (h as any).meal_plan ||
          '',
        ).trim(),
        totalHotelCost: routeNightPayableHotelCost,
        pricePerNight: routeNightPayableHotelCost,
        // The UI day-row contract is explicit: this is the complete payable
        // amount for this itinerary night, including all rooms and supplements.
        selectedPricePerNight: routeNightPayableHotelCost,
        selectedTotalPrice: routeNightPayableHotelCost,
        totalStayPrice: isOffline
          ? Number(selectedPriceSnapshot.totalStayPrice ?? selectedPriceSnapshot.total_price ?? routeNightPayableHotelCost)
          : routeNightPayableHotelCost,
        numberOfNights: 1,
        // Keep the rate shown beside the room-count multiplier explicit. The
        // aggregate room amount above is authoritative, but omitting this
        // field makes the tooltip render `0 × ...` even when totalRoomCost is
        // present in the persisted snapshot.
        roomRate: Number(baseHotelCost.toFixed(2)),
        basePricePerNight: baseHotelCost,
        baseTotalPrice: isOffline
          ? Number((baseHotelCost * snapshotRoomCount).toFixed(2))
          : authoritativeBaseHotelCost,
        totalHotelTaxAmount: storedTax * earlyCheckInBillingMultiplier,
        baseHotelCost,
        totalRoomCost: isOffline
          ? Number((baseHotelCost * snapshotRoomCount).toFixed(2))
          : baseHotelCost,
        hotelRoomGstAmount: Number((h as any).total_room_gst_amount ?? 0) * earlyCheckInBillingMultiplier,
        hotelMealPlanCost: Number((h as any).total_hotel_meal_plan_cost ?? 0) * earlyCheckInBillingMultiplier,
        hotelMealPlanGstAmount: Number((h as any).total_hotel_meal_plan_cost_gst_amount ?? 0) * earlyCheckInBillingMultiplier,
        totalExtraBedCost: extraBedCost,
        totalExtraBedCostGstAmount: Number((h as any).total_extra_bed_cost_gst_amount ?? 0) * earlyCheckInBillingMultiplier,
        totalChildWithBedCost: childWithBedCost,
        totalChildWithBedCostGstAmount: Number((h as any).total_childwith_bed_cost_gst_amount ?? 0) * earlyCheckInBillingMultiplier,
        totalChildWithoutBedCost: childWithoutBedCost,
        totalChildWithoutBedCostGstAmount: Number((h as any).total_childwithout_bed_cost_gst_amount ?? 0) * earlyCheckInBillingMultiplier,
        extraBedCount,
        extraBedRate,
        childWithBedCount,
        childWithBedRate,
        childWithoutBedCount,
        childWithoutBedRate,
        hotelMarginPercentage: effectiveMarginPercentage,
        hotelMarginAmount,
        hotelMarginTotalAmount: hotelMarginAmount,
        hotelMarginBaseAmount,
        hotelMarginGstAmount: Number((h as any).hotel_margin_rate_tax_amt ?? 0) * earlyCheckInBillingMultiplier,
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
        provider: provider || undefined,
        hotelCode: persistedIdentity.hotelCode || undefined,
        bookingCode: String((h as any).selected_rate_option_id || '').trim() || undefined,
        rateOptionId: String((h as any).selected_rate_option_id || '').trim() || undefined,
        priceSource: (h as any).price_source || undefined,
        bookingMode: (h as any).hotel_booking_mode || undefined,
        isLiveRate: (h as any).is_live_rate ?? undefined,
        approvalStatus: (h as any).hotel_approval_status || undefined,
        manualConfirmationStatus: (h as any).manual_confirmation_status || undefined,
        isSelected:
          Number((h as any).hotel_id || 0) > 0 ||
          Boolean(String((h as any).selected_rate_option_id || '').trim()) ||
          Boolean(String(selectedPriceSnapshot.rateOptionId || '').trim()),
        selectionOrigin: (String((h as any).selection_origin || '').trim().toUpperCase() ||
          (Number((h as any).hotel_id || 0) > 0 ? 'AUTO_SELECTED' : undefined)) as
          'AUTO_SELECTED' | 'USER_SELECTED' | undefined,
        selectionId: Number(hotelDetailsId || 0),
        requiresPriceReacceptance: Boolean((h as any).requires_price_reacceptance),
        selectedPriceSnapshot: rawSelectedPriceSnapshot || null,
        identityMismatch: !persistedIdentity.consistent,
      };
    });

    const hotelGroupTotals = new Map<number, number>();
    hotels.forEach((row: any) => {
      const groupType = Number(row.groupType ?? 0) || 0;
      const currentTotal = hotelGroupTotals.get(groupType) || 0;
      const rowTotal = Number(row.totalHotelCost ?? 0) + Number(row.totalHotelTaxAmount ?? 0);
      hotelGroupTotals.set(groupType, currentTotal + rowTotal);
    });
    const hotelTabs: ItineraryHotelTabDto[] = Array.from(hotelGroupTotals.entries())
      .map(([groupType, totalAmount]) => ({
        groupType,
        label: `Recommended #${groupType}`,
        totalAmount: Number(totalAmount.toFixed(2)),
      }))
      .sort((a, b) => a.groupType - b.groupType);

 // 6) Total room count (fallback)
    const totalRoomCount = hotelRowsRaw.reduce(
      (sum, h) => sum + ((h as any).total_no_of_rooms ?? 0),
      0,
    );
    const noOfNights = Math.max(Number((plan as any).no_of_nights || 0), 0);
    const requiredHotelRoutes = resolveHotelRequiredRoutes(routeDetails, noOfNights);
    const hotelSelectionState = buildHotelSelectionState({
      tabs: hotelTabs,
      rows: hotels,
      requiredRoutes: requiredHotelRoutes,
    });

    return {
      quoteId: plan.itinerary_quote_ID ?? '',
      planId,
      hotelRatesVisible,
      showHotelMargins: this.shouldShowHotelMargins(),
      hotelTabs,
      hotelSelectionState,
      hotels,
      totalRoomCount,
    };
  }
}
