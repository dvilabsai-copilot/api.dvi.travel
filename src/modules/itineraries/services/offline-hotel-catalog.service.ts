import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotelPricingService } from '../hotels/hotel-pricing.service';
import { HotelSearchResult, RoomType } from '../../hotels/interfaces/hotel-provider.interface';
import { inferCanonicalHotelRatePlanCode } from '../../hotels/hotel-rate-plans';
import { HotelAvailabilityTimingLogger } from './hotel-availability-timing.logger';
import { normalizeHotelDisplayName } from '../utils/hotel-selection-identity.util';

type StayBlock = {
  destination: string;
  checkInDate: string;
  checkOutDate: string;
  routeIds: number[];
};

type OfflineRoomOffer = {
  roomId: number;
  roomTypeId: number;
  roomTitle: string;
  bookingCode: string;
  mealPlan: string;
  nightlyBase: number[];
  nightlyMargin: number[];
  nightlySell: number[];
  hotelMarginPercentage: number;
  baseTotalPrice: number;
  hotelMarginTotalAmount: number;
  totalStayPrice: number;
  pricePerNight: number;
  roomCount: number;
  extraBedRate: number;
  childWithBedRate: number;
  childWithoutBedRate: number;
};

export function selectOfflineRouteNightlyRate(
  offer: Pick<OfflineRoomOffer, 'nightlyBase' | 'nightlyMargin' | 'nightlySell' | 'roomCount'>,
  dates: string[],
  routeDate: string,
) {
  const index = dates.indexOf(String(routeDate || '').slice(0, 10));
  const fallbackIndex = 0;
  const selectedIndex = index >= 0 ? index : fallbackIndex;
  const roomCount = Math.max(Number(offer.roomCount || 1), 1);
  const baseAmount = Number(offer.nightlyBase[selectedIndex] || 0);
  const marginAmount = Number(offer.nightlyMargin[selectedIndex] || 0);
  const sellAmount = Number(offer.nightlySell[selectedIndex] || 0);
  return {
    index: selectedIndex,
    baseAmount,
    marginAmount,
    sellAmount,
    basePricePerNight: Number((baseAmount / roomCount).toFixed(2)),
  };
}

/** Select the canonical room charge from SINGLE/DOUBLE only. */
export function selectOfflineRoomRate(
  occupancyRates: Record<string, unknown>,
  adults = 2,
  roomCount = 1,
): number {
  const adultsPerRoom = Math.max(
    Math.ceil(Math.max(Number(adults || 0), 1) / Math.max(Number(roomCount || 1), 1)),
    1,
  );
  const key = adultsPerRoom === 1 ? 'SINGLE' : 'DOUBLE';
  const rate = Number(occupancyRates?.[key]);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/** Resolve an occupancy row using the same latest-covering-row rule as admin. */
export function selectAdminMatchingOccupancyRow(rows: any[], target: number): any | undefined {
  return rows
    .filter((row: any) => {
      const start = new Date(row.start_date).getTime();
      const end = new Date(row.end_date).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && start <= target && end >= target;
    })
    .sort((a: any, b: any) => new Date(b.received_at || 0).getTime() - new Date(a.received_at || 0).getTime())[0];
}

// Offline availability exposes the room base for the selected occupancy as a
// one-night amount. The complete continuous-stay amount remains available in
// totalStayPrice and nightlyBase, but must not be sent as baseTotalPrice for a
// single room/night response field.
const oneNightRoomBase = (offer: OfflineRoomOffer): number =>
  Number((offer.nightlyBase[0] || 0).toFixed(2));

const oneRoomNightBase = (offer: OfflineRoomOffer): number =>
  Number((oneNightRoomBase(offer) / Math.max(Number(offer.roomCount || 1), 1)).toFixed(2));

export type OfflineRateResolution = {
  provider: 'offline';
  hotelId: number;
  canonicalHotelId: number;
  hotelCode: string;
  providerHotelCode: string;
  hotelName: string;
  category: number;
  /** The route that was actually matched after stale UI route IDs are reconciled. */
  routeId: number;
  routeDate: string;
  rateOptionId: string;
  bookingCode: string;
  searchReference: string;
  roomId: number;
  roomTypeId: number;
  roomType: string;
  mealPlan: string;
  roomCount: number;
  pricePerNight: number;
  basePricePerNight: number;
  baseTotalPrice: number;
  hotelMarginPercentage: number;
  hotelMarginAmount: number;
  hotelMarginTotalAmount: number;
  totalStayPrice: number;
  numberOfNights: number;
  extraBedRate: number;
  extraBedAmount: number;
  childWithBedRate: number;
  childWithBedAmount: number;
  currency: string;
  nightlyRates: Array<{ date: string; baseAmount: number; marginPercentage: number; marginAmount: number; sellAmount: number }>;
};

type OfflineCatalogRows = {
  roomsByHotel: Map<number, any[]>;
  ratePlansByRoom: Map<number, any[]>;
  activeRoomTypeIds: Set<number>;
  occupancyRatesByRoomPlan: Map<string, any[]>;
};

/**
 * Route data contains both customer-facing names and supplier/city-master
 * names. Keep this list deliberately small: aliases may broaden the hotel
 * search, so an unverified landmark must not silently become a city.
 */
const OFFLINE_DESTINATION_ALIASES: Record<string, string[]> = {
  bangalore: ['Bengaluru'],
  bengaluru: ['Bangalore'],
  cochin: ['Kochi'],
  kochi: ['Cochin'],
  chikmagaluru: ['Chikmagalur'],
  chikmagalur: ['Chikmagaluru'],
  trichy: ['Tiruchirappalli'],
  tiruchirappalli: ['Trichy'],
  tirupathi: ['Tirupati'],
  tirupati: ['Tirupathi'],
  pondicherry: ['Puducherry'],
  puducherry: ['Pondicherry'],
  // Route destinations may contain a locality/landmark while the hotel
  // catalog is keyed by the canonical city. Keep these verified Chennai
  // mappings explicit instead of broadening every unknown landmark.
  'chennai koyembedu': ['Chennai'],
  'ecr beach': ['Chennai'],
  trivandrum: ['Thiruvananthapuram'],
  thiruvananthapuram: ['Trivandrum'],
};

@Injectable()
export class OfflineHotelCatalogService {
  private readonly logger = new Logger(OfflineHotelCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelPricingService: HotelPricingService,
  ) {}

  async searchOfflineHotels(criteria: {
    cityCode: string;
    checkInDate: string;
    checkOutDate: string;
    roomCount: number;
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    requestedMealPlanCode?: string;
  }): Promise<HotelSearchResult[]> {
    const hotels = await this.fetchOfflineHotelsForStayBlock({
      destination: String(criteria.cityCode || '').trim(),
      checkInDate: String(criteria.checkInDate || '').slice(0, 10),
      checkOutDate: String(criteria.checkOutDate || '').slice(0, 10),
      routeIds: [],
    }, Math.max(Number(criteria.roomCount || 1), 1), `adults:${Number(criteria.adultCount || 0)}|children:${Number(criteria.childCount || 0)}|ages:${(criteria.childAges || []).join(',')}|meal:${inferCanonicalHotelRatePlanCode(criteria.requestedMealPlanCode) || 'ANY'}`, Number(criteria.adultCount || 0), Number(criteria.childCount || 0), undefined, undefined, String(criteria.requestedMealPlanCode || ''));
    return hotels;
  }

  async fetchOfflineHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    guestNationality: string,
    roomCount: number = 1,
    adultCount: number = 2,
    childCount: number = 0,
    childAges: number[] = [],
    requestedMealPlanCode = '',
    preferredCategories: number[] = [],
  ): Promise<Map<number, HotelSearchResult[]>> {
    const startedAt = Date.now();
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const stayBlocks = this.buildStayBlocks(routes, noOfNights);
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_STAGE', {
      stage: 'build-stay-blocks',
      durationMs: Date.now() - startedAt,
      routeCount: routes?.length || 0,
      stayBlockCount: stayBlocks.length,
    });

    this.logger.log(
      `Offline hotel catalog processing ${stayBlocks.length} stay block(s) ` +
        `for roomCount=${roomCount}, adults=${adultCount}, children=${childCount}, nationality=${guestNationality || 'n/a'}`,
    );

    const occupancyKey = `adults:${adultCount}|children:${childCount}|ages:${childAges.join(',')}|meal:${inferCanonicalHotelRatePlanCode(requestedMealPlanCode) || 'ANY'}`;
    const hotelLoadStartedAt = Date.now();
    const hotelsByBlock = await this.loadHotelsByStayBlock(stayBlocks, roomCount, occupancyKey);
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_STAGE', {
      stage: 'hotel-master-load',
      durationMs: Date.now() - hotelLoadStartedAt,
      stayBlockCount: stayBlocks.length,
      hotelCount: Array.from(hotelsByBlock.values()).reduce((sum, rows) => sum + rows.length, 0),
    });
    const allHotels = Array.from(
      new Map(
        Array.from(hotelsByBlock.values())
          .flat()
          .map((hotel: any) => [Number(hotel.hotel_id), hotel]),
      ).values(),
    );
    const catalogLoadStartedAt = Date.now();
    const requestedDates = Array.from(new Set(
      stayBlocks.flatMap((block) => this.getNightDates(block.checkInDate, block.checkOutDate)),
    ));
    const catalogRows = await this.loadCatalogRows(allHotels, requestedDates);
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_STAGE', {
      stage: 'room-and-price-catalog-load',
      durationMs: Date.now() - catalogLoadStartedAt,
      hotelCount: allHotels.length,
      roomCount: Array.from(catalogRows.roomsByHotel.values()).reduce((sum, rows) => sum + rows.length, 0),
      priceRowCount: Array.from(catalogRows.occupancyRatesByRoomPlan.values()).reduce((sum, rows) => sum + rows.length, 0),
    });

    const offerBuildStartedAt = Date.now();
    for (const block of stayBlocks) {
      const fetchedHotels = await this.fetchOfflineHotelsForStayBlock(
        block,
        roomCount,
        occupancyKey,
        adultCount,
        childCount,
        catalogRows,
        hotelsByBlock.get(this.blockCacheKey(block, roomCount, occupancyKey)),
        requestedMealPlanCode,
      );
      const preferredCategorySet = new Set(
        (preferredCategories || [])
          .map(Number)
          .filter((category) => Number.isFinite(category) && category > 0),
      );
      const hotels = preferredCategorySet.size > 0
        ? fetchedHotels.filter((hotel: any) => preferredCategorySet.has(Number(hotel.rating || hotel.category || 0)))
        : fetchedHotels;

      for (const routeId of block.routeIds) {
        hotelsByRoute.set(routeId, hotels);
      }
    }
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_STAGE', {
      stage: 'offer-build-and-response-shape',
      durationMs: Date.now() - offerBuildStartedAt,
      stayBlockCount: stayBlocks.length,
      routeCount: hotelsByRoute.size,
      hotelResultCount: Array.from(hotelsByRoute.values()).reduce((sum, rows) => sum + rows.length, 0),
    });

    for (const route of routes || []) {
      const routeId = Number((route as any)?.itinerary_route_ID || 0);
      if (routeId > 0 && !hotelsByRoute.has(routeId)) {
        hotelsByRoute.set(routeId, []);
      }
    }

    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_STAGE', {
      stage: 'total',
      durationMs: Date.now() - startedAt,
      stayBlockCount: stayBlocks.length,
      routeCount: hotelsByRoute.size,
    });
    return hotelsByRoute;
  }

  private buildStayBlocks(routes: any[], noOfNights: number): StayBlock[] {
    const blocks: StayBlock[] = [];
    const totalRoutes = routes.length;
    let currentBlock:
      | {
          destination: string;
          checkInDate: string;
          checkOutDate: string;
          routeIds: number[];
          lastDate: Date;
        }
      | null = null;

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      const isLastRoute = routeIndex === totalRoutes - 1;
      if (isLastRoute && routeIndex >= noOfNights) {
        continue;
      }

      const routeId = Number((route as any).itinerary_route_ID || 0);
      const destination = String((route as any).next_visiting_location || (route as any).location_name || '').trim();
      const routeDate = new Date((route as any).itinerary_route_date);
      if (!routeId || Number.isNaN(routeDate.getTime())) {
        continue;
      }

      const checkInDate = routeDate.toISOString().slice(0, 10);
      const nextDay = new Date(routeDate.getTime() + 24 * 60 * 60 * 1000);
      const checkOutDate = nextDay.toISOString().slice(0, 10);

      if (!currentBlock) {
        currentBlock = {
          destination,
          checkInDate,
          checkOutDate,
          routeIds: [routeId],
          lastDate: routeDate,
        };
        continue;
      }

      const isSameDestination = destination === currentBlock.destination;
      const isConsecutiveDay =
        routeDate.getTime() - currentBlock.lastDate.getTime() === 24 * 60 * 60 * 1000;

      if (isSameDestination && isConsecutiveDay) {
        currentBlock.checkOutDate = checkOutDate;
        currentBlock.routeIds.push(routeId);
        currentBlock.lastDate = routeDate;
      } else {
        blocks.push({
          destination: currentBlock.destination,
          checkInDate: currentBlock.checkInDate,
          checkOutDate: currentBlock.checkOutDate,
          routeIds: currentBlock.routeIds,
        });

        currentBlock = {
          destination,
          checkInDate,
          checkOutDate,
          routeIds: [routeId],
          lastDate: routeDate,
        };
      }
    }

    if (currentBlock) {
      blocks.push({
        destination: currentBlock.destination,
        checkInDate: currentBlock.checkInDate,
        checkOutDate: currentBlock.checkOutDate,
        routeIds: currentBlock.routeIds,
      });
    }

    return blocks;
  }

  private async fetchOfflineHotelsForStayBlock(
    block: StayBlock,
    roomCount: number,
    occupancyKey = '',
    adultCount = 0,
    childCount = 0,
    catalogRows?: OfflineCatalogRows,
    prefetchedHotels?: any[],
    requestedMealPlanCode = '',
  ): Promise<HotelSearchResult[]> {
    const dateList = this.getNightDates(block.checkInDate, block.checkOutDate);
    if (dateList.length === 0) {
      return [];
    }

    const cityCandidates = await this.resolveCityCandidates(block.destination);
    if (cityCandidates.length === 0) {
      return [];
    }

    const hotels = prefetchedHotels || await this.prisma.dvi_hotel.findMany({
      where: {
        status: 1,
        deleted: false,
        OR: [
          { hotel_city: { in: cityCandidates } },
          { hotel_state: { in: cityCandidates } },
        ],
      },
      select: {
        hotel_id: true,
        hotel_name: true,
        hotel_code: true,
        hotel_city: true,
        hotel_state: true,
        hotel_address: true,
        hotel_latitude: true,
        hotel_longitude: true,
        hotel_category: true,
        hotel_margin: true,
        hotel_margin_gst_type: true,
        hotel_margin_gst_percentage: true,
        hotel_cancel_policy: true,
      },
    });

    const results: HotelSearchResult[] = [];
    for (const hotel of hotels as any[]) {
      const offers = await this.buildRoomOffers(hotel, dateList, roomCount, adultCount, childCount, catalogRows, requestedMealPlanCode);
      if (offers.length === 0) {
        continue;
      }

      const bestOffer = offers[0];
      const roomTypes: RoomType[] = offers.map((offer) => ({
        roomCode: this.getRateOptionId(Number(hotel.hotel_id), offer, dateList[0], dateList[dateList.length - 1]),
        roomName: `${offer.roomTitle} - ${offer.mealPlan}`,
        bedType: '',
        capacity: roomCount,
        price: offer.totalStayPrice,
        cancellationPolicy: '',
      }));

      results.push({
        provider: 'offline',
        providerDisplayName: 'Offline',
        hotelCode: String(hotel.hotel_id),
        hotelName: normalizeHotelDisplayName(hotel.hotel_name) || 'Hotel',
        cityCode: String(hotel.hotel_city || ''),
        address: String(hotel.hotel_address || ''),
        latitude: hotel.hotel_latitude ?? null,
        longitude: hotel.hotel_longitude ?? null,
        rating: Number(hotel.hotel_category || 0),
        category: hotel.hotel_category ? String(hotel.hotel_category) : undefined,
        facilities: [],
        amenities: [],
        inclusions: [],
        rateConditions: [],
        cancellationPolicy: this.normalizeTextList(hotel.hotel_cancel_policy),
        images: [],
        price: bestOffer.totalStayPrice,
        netAmount: bestOffer.totalStayPrice,
        totalFare: bestOffer.totalStayPrice,
        currency: 'INR',
        roomTypes,
        roomType: bestOffer.roomTitle,
        mealPlan: bestOffer.mealPlan,
        searchReference: this.getRateOptionId(Number(hotel.hotel_id), bestOffer, dateList[0], dateList[dateList.length - 1]),
        bookingCode: this.getRateOptionId(Number(hotel.hotel_id), bestOffer, dateList[0], dateList[dateList.length - 1]),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        supplementSummary: {
          hasSupplements: false,
          supplementCount: 0,
          atPropertyChargeCount: 0,
          requiresReview: false,
        },
        canonicalHotelId: Number(hotel.hotel_id || 0) || null,
        pricePerNight: bestOffer.pricePerNight,
        basePricePerNight: oneRoomNightBase(bestOffer),
        baseTotalPrice: oneNightRoomBase(bestOffer),
        hotelMarginPercentage: bestOffer.hotelMarginPercentage,
        hotelMarginAmount: bestOffer.nightlyMargin[0] || 0,
        hotelMarginTotalAmount: bestOffer.hotelMarginTotalAmount,
        totalStayPrice: bestOffer.totalStayPrice,
        numberOfNights: dateList.length,
        extraBedRate: bestOffer.extraBedRate,
        childWithBedRate: bestOffer.childWithBedRate,
        childWithoutBedRate: bestOffer.childWithoutBedRate,
        nightlyRates: dateList.map((date, index) => ({
          date,
          baseAmount: bestOffer.nightlyBase[index] || 0,
          marginPercentage: bestOffer.hotelMarginPercentage,
          marginAmount: bestOffer.nightlyMargin[index] || 0,
          sellAmount: bestOffer.nightlySell[index] || 0,
        })),
        priceLabel: 'Price subject to hotel approval',
        priceSource: 'DATABASE',
        bookingMode: 'MANUAL_APPROVAL',
        availabilityStatus: 'OFFLINE_APPROVAL_REQUIRED',
        availabilityMessage: 'Price subject to hotel approval',
        requiresHotelApproval: true,
        isLiveRate: false,
        isLiveBookable: false,
        isSelectable: true,
        approvalStatus: 'NOT_REQUESTED',
        manualConfirmationStatus: 'NOT_STARTED',
        isBookable: true,
        externalStay: false,
        rateOptionId: this.getRateOptionId(Number(hotel.hotel_id), bestOffer, dateList[0], dateList[dateList.length - 1]),
        roomId: bestOffer.roomId,
        roomTypeId: bestOffer.roomTypeId,
        rateOptions: offers.map((offer) => ({
          rateOptionId: this.getRateOptionId(Number(hotel.hotel_id), offer, dateList[0], dateList[dateList.length - 1]),
          canonicalHotelId: Number(hotel.hotel_id),
          provider: 'offline',
          providerDisplayName: 'Offline',
          providerHotelCode: String(hotel.hotel_id),
          roomId: offer.roomId,
          roomTypeId: offer.roomTypeId,
          roomType: offer.roomTitle,
          mealPlan: offer.mealPlan,
          bookingMode: 'MANUAL_APPROVAL',
          priceSource: 'DATABASE',
          pricePerNight: offer.pricePerNight,
          basePricePerNight: oneRoomNightBase(offer),
          baseTotalPrice: oneNightRoomBase(offer),
          hotelMarginPercentage: offer.hotelMarginPercentage,
          hotelMarginAmount: offer.nightlyMargin[0] || 0,
          hotelMarginTotalAmount: offer.hotelMarginTotalAmount,
          totalStayPrice: offer.totalStayPrice,
          numberOfNights: dateList.length,
          extraBedRate: offer.extraBedRate,
          childWithBedRate: offer.childWithBedRate,
          childWithoutBedRate: offer.childWithoutBedRate,
          currency: 'INR',
          priceLabel: 'Price subject to hotel approval',
          isLiveRate: false,
          isLiveBookable: false,
          isSelectable: true,
          requiresHotelApproval: true,
          availabilityStatus: 'OFFLINE_APPROVAL_REQUIRED',
          approvalStatus: 'NOT_REQUESTED',
          manualConfirmationStatus: 'NOT_STARTED',
          nightlyRates: dateList.map((date, index) => ({
            date,
            baseAmount: offer.nightlyBase[index] || 0,
            marginPercentage: offer.hotelMarginPercentage,
            marginAmount: offer.nightlyMargin[index] || 0,
            sellAmount: offer.nightlySell[index] || 0,
          })),
        })),
      } as HotelSearchResult & Record<string, unknown>);
    }

    results.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    return results;
  }

  private blockCacheKey(block: StayBlock, roomCount: number, occupancyKey: string): string {
    return [
      block.destination,
      block.checkInDate,
      block.checkOutDate,
      Math.max(Number(roomCount || 1), 1),
      occupancyKey,
    ].join('|').toLowerCase();
  }

  /** Load hotel masters with SQL city predicates, once per logical stay block. */
  private async loadHotelsByStayBlock(
    blocks: StayBlock[],
    roomCount: number,
    occupancyKey: string,
  ): Promise<Map<string, any[]>> {
    const cityCandidatesByDestination = await this.resolveCityCandidatesForDestinations(
      blocks.map((block) => block.destination),
    );
    const entries = await Promise.all(blocks.map(async (block) => {
      const cacheKey = this.blockCacheKey(block, roomCount, occupancyKey);
      const cityCandidates = cityCandidatesByDestination.get(block.destination) || [];
      if (cityCandidates.length === 0) return [cacheKey, [] as any[]] as const;

      const hotels = await this.prisma.dvi_hotel.findMany({
        where: {
          status: 1,
          deleted: false,
          OR: [
            { hotel_city: { in: cityCandidates } },
            { hotel_state: { in: cityCandidates } },
          ],
        },
        select: {
          hotel_id: true,
          hotel_name: true,
          hotel_code: true,
          hotel_city: true,
          hotel_state: true,
          hotel_address: true,
          hotel_latitude: true,
          hotel_longitude: true,
          hotel_category: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
          hotel_cancel_policy: true,
        },
      });
      return [cacheKey, hotels as any[]] as const;
    }));

    return new Map(entries);
  }

  /** Load all room, room-type, and monthly price rows in three bulk queries. */
  private async loadCatalogRows(hotels: any[], requestedDates: string[] = []): Promise<OfflineCatalogRows> {
    const hotelIds = Array.from(new Set(
      hotels.map((hotel) => Number(hotel.hotel_id || 0)).filter((id) => id > 0),
    ));
    if (hotelIds.length === 0) {
      return {
        roomsByHotel: new Map(),
        ratePlansByRoom: new Map(),
        activeRoomTypeIds: new Set(),
        occupancyRatesByRoomPlan: new Map(),
      };
    }

    const activeRoomsStartedAt = Date.now();
    const activeRooms = await this.prisma.dvi_hotel_rooms.findMany({
      where: { hotel_id: { in: hotelIds }, status: 1, deleted: 0 },
      select: {
        hotel_id: true,
        room_ID: true,
        room_type_id: true,
        room_title: true,
        room_ref_code: true,
        total_max_adults: true,
        total_max_childrens: true,
        breakfast_included: true,
        lunch_included: true,
        dinner_included: true,
      },
      orderBy: [{ room_type_id: 'asc' }, { room_ID: 'asc' }],
    });
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_QUERY', {
      query: 'active-rooms',
      durationMs: Date.now() - activeRoomsStartedAt,
      hotelCount: hotelIds.length,
      rowCount: activeRooms.length,
    });
    const roomsByHotel = new Map<number, any[]>();
    for (const room of activeRooms as any[]) {
      const hotelId = Number(room.hotel_id || 0);
      const rows = roomsByHotel.get(hotelId) || [];
      rows.push(room);
      roomsByHotel.set(hotelId, rows);
    }

    const ratePlansByRoom = new Map<number, any[]>();
    const ratePlanModel = (this.prisma as any).dvi_hotel_room_rate_plan;
    if (ratePlanModel?.findMany) {
      const ratePlans = await ratePlanModel.findMany({
        where: { hotel_id: { in: hotelIds }, status: 1, deleted: 0 },
        select: { room_id: true, rateplan_id: true, rateplan_name: true, meal_plan_description: true, occupancy: true },
      });
      for (const plan of ratePlans as any[]) {
        const roomId = Number(plan.room_id || 0);
        if (roomId <= 0) continue;
        const rows = ratePlansByRoom.get(roomId) || [];
        rows.push(plan);
        ratePlansByRoom.set(roomId, rows);
      }
    }

    const roomTypeIds = Array.from(new Set(
      (activeRooms as any[]).map((room) => Number(room.room_type_id || 0)).filter((id) => id > 0),
    ));
    const roomTypeModel = (this.prisma as any).dvi_hotel_roomtype;
    const hasRoomTypeModel = Boolean(roomTypeModel?.findMany);
    const activeRoomTypesStartedAt = Date.now();
    const activeRoomTypes = hasRoomTypeModel && roomTypeIds.length > 0
      ? await roomTypeModel.findMany({
          where: { room_type_id: { in: roomTypeIds }, status: 1, deleted: 0 },
          select: { room_type_id: true },
        })
      : [];
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_QUERY', {
      query: 'active-room-types',
      durationMs: Date.now() - activeRoomTypesStartedAt,
      roomTypeCount: roomTypeIds.length,
      rowCount: activeRoomTypes.length,
    });
    const activeRoomTypeIds = new Set<number>(
      hasRoomTypeModel
        ? (activeRoomTypes as any[]).map((row) => Number(row.room_type_id)).filter((id) => id > 0)
        : roomTypeIds,
    );

    const occupancyRowsStartedAt = Date.now();
    const occupancyRows = await (this.prisma as any).dvi_hotel_occupancy_rate.findMany({
      where: {
        hotel_id: { in: hotelIds },
        // Fetch every rate interval intersecting the stay. Daily migrated
        // rows must not be filtered out by a multi-night range predicate.
        start_date: { lte: new Date(`${requestedDates[requestedDates.length - 1] || '2999-12-31'}T00:00:00.000Z`) },
        end_date: { gte: new Date(`${requestedDates[0] || '1900-01-01'}T00:00:00.000Z`) },
      },
      select: { hotel_id: true, room_id: true, rateplan_id: true, start_date: true, end_date: true, occupancy_rates: true, received_at: true },
    });
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_QUERY', {
      query: 'occupancy-rates', durationMs: Date.now() - occupancyRowsStartedAt,
      hotelCount: hotelIds.length, rowCount: occupancyRows.length,
    });
    const occupancyRatesByRoomPlan = new Map<string, any[]>();
    for (const row of occupancyRows as any[]) {
      const key = `${Number(row.hotel_id || 0)}|${Number(row.room_id || 0)}|${String(row.rateplan_id || '')}`;
      const rows = occupancyRatesByRoomPlan.get(key) || [];
      rows.push(row); occupancyRatesByRoomPlan.set(key, rows);

      // The canonical occupancy table is the source of truth for Offline
      // prices.  Some migrated hotels do not have a corresponding active row
      // in dvi_hotel_room_rate_plan, so synthesize only the metadata needed by
      // the offer builder from the canonical rate-plan id.  This does not
      // create or alter database rows and keeps the legacy rate-plan table out
      // of the Offline pricing path.
      const roomId = Number(row.room_id || 0);
      const rateplanId = String(row.rateplan_id || '').trim();
      if (roomId > 0 && rateplanId) {
        const plans = ratePlansByRoom.get(roomId) || [];
        if (!plans.some((plan: any) => String(plan.rateplan_id || '').trim() === rateplanId)) {
          plans.push({
            room_id: roomId,
            rateplan_id: rateplanId,
            rateplan_name: rateplanId,
            meal_plan_description: rateplanId,
            occupancy: null,
          });
          ratePlansByRoom.set(roomId, plans);
        }
      }
    }

    return { roomsByHotel, ratePlansByRoom, activeRoomTypeIds, occupancyRatesByRoomPlan };
  }

  clearCache(): void {
    // Kept for call-site compatibility; offline inventory is request-scoped.
  }

  private buildRoomOffersFromCatalogRows(
    hotel: any,
    dateList: string[],
    roomCount: number,
    adultCount: number,
    childCount: number,
    catalogRows: OfflineCatalogRows,
    marginPercentage: number,
    requestedMealPlanCode = '',
  ): OfflineRoomOffer[] {
    const hotelId = Number(hotel.hotel_id || 0);
    const roomsNeeded = Math.max(Number(roomCount || 1), 1);
    // Offline hotels do not publish live inventory or availability. The room
    // master is used only to identify the room and its configured price; the
    // hotel confirms whether it can fulfil the request after itinerary
    // confirmation. Do not use occupancy/capacity fields as an availability
    // gate here.
    const activeRooms = (catalogRows.roomsByHotel.get(hotelId) || []).filter((room: any) =>
      catalogRows.activeRoomTypeIds.has(Number(room.room_type_id || 0)),
    );
    const offers: OfflineRoomOffer[] = [];

    for (const room of activeRooms) {
      const roomTypeId = Number(room.room_type_id || 0);
      const roomPlans = catalogRows.ratePlansByRoom.get(Number(room.room_ID || 0)) || [];
      const matchingPlans = roomPlans.filter((plan: any) => {
        const requested = inferCanonicalHotelRatePlanCode(requestedMealPlanCode);
        return !requested || inferCanonicalHotelRatePlanCode(`${plan.rateplan_id || ''} ${plan.rateplan_name || ''} ${plan.meal_plan_description || ''}`) === requested;
      });
      const plan = matchingPlans[0] || roomPlans[0];
      if (!plan) continue;
      const matchingRateRows = catalogRows.occupancyRatesByRoomPlan.get(`${hotelId}|${Number(room.room_ID || 0)}|${String(plan.rateplan_id || '')}`) || [];
      if (matchingRateRows.length === 0) continue;

      const nightlyBase: number[] = [];
      const nightlyMargin: number[] = [];
      const nightlySell: number[] = [];
      let valid = true;
      for (const date of dateList) {
        const target = new Date(`${date}T00:00:00.000Z`).getTime();
        const selectedRateRow = selectAdminMatchingOccupancyRow(matchingRateRows, target);
        const rates = this.parseJsonObject(selectedRateRow?.occupancy_rates);
        // ROOM_RATE is the authoritative per-room nightly price used by the
        // itinerary. DOUBLE is the legacy/admin-form fallback only when the
        // pricebook row has no ROOM_RATE. Taking the minimum occupancy value
        // silently selected a different rate on nights where ROOM_RATE was
        // higher (for example 02-Sep: ₹3,675 instead of the stale lower value).
        const nightlyPrice = selectOfflineRoomRate(rates, adultCount, roomsNeeded);
        if (!(nightlyPrice > 0)) {
          valid = false;
          break;
        }

        const baseAmount = this.hotelPricingService.money(nightlyPrice * roomsNeeded);
        const breakdown = this.hotelPricingService.marginBreakdown(baseAmount, marginPercentage);
        nightlyBase.push(breakdown.baseAmount);
        nightlyMargin.push(breakdown.marginAmount);
        nightlySell.push(breakdown.sellAmount);
      }

      if (!valid || nightlySell.length !== dateList.length) continue;
      const supplements = this.resolveSupplementRatesFromOccupancy(matchingRateRows, dateList);
      offers.push({
        roomId: Number(room.room_ID || 0),
        roomTypeId,
        roomTitle: String(room.room_title || room.room_ref_code || `Room ${roomTypeId}`),
        bookingCode: `OFFLINE-${hotelId}-${room.room_ID}-${roomTypeId}`,
        mealPlan: this.resolveMealPlan(room, requestedMealPlanCode, catalogRows.ratePlansByRoom),
        nightlyBase,
        nightlyMargin,
        nightlySell,
        hotelMarginPercentage: marginPercentage,
        baseTotalPrice: this.hotelPricingService.money(nightlyBase.reduce((sum, amount) => sum + amount, 0)),
        hotelMarginTotalAmount: this.hotelPricingService.money(nightlyMargin.reduce((sum, amount) => sum + amount, 0)),
        totalStayPrice: this.hotelPricingService.money(nightlySell.reduce((sum, amount) => sum + amount, 0)),
        pricePerNight: this.hotelPricingService.money(Math.min(...nightlySell)),
        roomCount,
        extraBedRate: supplements.extraBedRate,
        childWithBedRate: supplements.childWithBedRate,
        childWithoutBedRate: supplements.childWithoutBedRate,
      });
    }

    return offers.sort((a, b) => a.totalStayPrice - b.totalStayPrice);
  }

  private async buildRoomOffers(
    hotel: any,
    dateList: string[],
    roomCount: number,
    adultCount = 0,
    childCount = 0,
    catalogRows?: OfflineCatalogRows,
    requestedMealPlanCode = '',
  ): Promise<OfflineRoomOffer[]> {
    const marginPercentage = await this.hotelPricingService.resolveEffectiveHotelMarginPercentage(hotel);
    if (catalogRows) {
      return this.buildRoomOffersFromCatalogRows(
        hotel,
        dateList,
        roomCount,
        adultCount,
        childCount,
        catalogRows,
        marginPercentage,
        requestedMealPlanCode,
      );
    }

    // Occupancy-rate rows are the canonical Offline price source. The legacy
    // monthly room-price table is intentionally not consulted during search.
    const canonicalRows = await this.loadCatalogRows([hotel], dateList);
    return this.buildRoomOffersFromCatalogRows(
      hotel, dateList, roomCount, adultCount, childCount, canonicalRows,
      marginPercentage, requestedMealPlanCode,
    );

    const activeRooms = await this.prisma.dvi_hotel_rooms.findMany({
      where: {
        hotel_id: Number(hotel.hotel_id || 0),
        status: 1,
        deleted: 0,
      },
      select: {
        room_ID: true,
        room_type_id: true,
        room_title: true,
        room_ref_code: true,
        total_max_adults: true,
        total_max_childrens: true,
        breakfast_included: true,
        lunch_included: true,
        dinner_included: true,
      },
      orderBy: [{ room_type_id: 'asc' }, { room_ID: 'asc' }],
    });

    if (activeRooms.length === 0) {
      return [];
    }

    const roomsNeeded = Math.max(Number(roomCount || 1), 1);
    const ratePlansByRoom = new Map<number, any[]>();
    const ratePlanModel = (this.prisma as any).dvi_hotel_room_rate_plan;
    if (ratePlanModel?.findMany) {
      const ratePlans = await ratePlanModel.findMany({
        where: { hotel_id: Number(hotel.hotel_id || 0), status: 1, deleted: 0 },
        select: { room_id: true, rateplan_id: true, rateplan_name: true, meal_plan_description: true, occupancy: true },
      });
      for (const plan of ratePlans as any[]) {
        const roomId = Number(plan.room_id || 0);
        if (roomId <= 0) continue;
        const rows = ratePlansByRoom.get(roomId) || [];
        rows.push(plan);
        ratePlansByRoom.set(roomId, rows);
      }
    }

    const roomTypeIds = Array.from(
      new Set(
        activeRooms
          .map((room) => Number((room as any).room_type_id || 0))
          .filter((roomTypeId) => roomTypeId > 0),
      ),
    );

    if (roomTypeIds.length === 0) {
      return [];
    }

    // A room row is usable only when its master room type is active too.
    // Otherwise deactivated room types can leak back into offline search.
    const roomTypeModel = (this.prisma as any).dvi_hotel_roomtype;
    if (roomTypeModel?.findMany) {
      const activeRoomTypes = await roomTypeModel.findMany({
        where: { room_type_id: { in: roomTypeIds }, status: 1, deleted: 0 },
        select: { room_type_id: true },
      });
      const activeRoomTypeIds = new Set(
        (activeRoomTypes as any[]).map((row) => Number(row.room_type_id)).filter((id) => id > 0),
      );
      if (activeRoomTypeIds.size === 0) return [];
      for (let index = activeRooms.length - 1; index >= 0; index -= 1) {
        if (!activeRoomTypeIds.has(Number((activeRooms[index] as any).room_type_id || 0))) {
          activeRooms.splice(index, 1);
        }
      }
      if (activeRooms.length === 0) return [];
    }

    const yearMonthPairs = Array.from(
      new Set(
        dateList.map((value) => {
          const parsed = new Date(`${value}T00:00:00.000Z`);
          return `${parsed.getUTCFullYear()}|${parsed.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}`;
        }),
      ),
    );

    const priceRows = await this.prisma.dvi_hotel_room_price_book.findMany({
      where: {
        hotel_id: Number(hotel.hotel_id || 0),
        room_type_id: { in: roomTypeIds },
        price_type: 0,
        status: 1,
        deleted: 0,
        OR: yearMonthPairs.map((pair) => {
          const [year, month] = pair.split('|');
          return { year, month };
        }),
      },
    });

    const priceRowsByRoomType = new Map<number, any[]>();
    for (const row of priceRows as any[]) {
      const roomTypeId = Number(row.room_type_id || 0);
      const rows = priceRowsByRoomType.get(roomTypeId) || [];
      rows.push(row);
      priceRowsByRoomType.set(roomTypeId, rows);
    }

    const offers: OfflineRoomOffer[] = [];

    for (const room of activeRooms as any[]) {
      const roomTypeId = Number(room.room_type_id || 0);
      const matchingPriceRows = priceRowsByRoomType.get(roomTypeId) || [];
      if (matchingPriceRows.length === 0) {
        continue;
      }

      const nightlyBase: number[] = [];
      const nightlyMargin: number[] = [];
      const nightlySell: number[] = [];
      let valid = true;

      for (const date of dateList) {
        const parsed = new Date(`${date}T00:00:00.000Z`);
        const dayKey = `day_${parsed.getUTCDate()}` as const;
        const year = String(parsed.getUTCFullYear());
        const month = parsed.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
        const nightlyCandidates = matchingPriceRows.filter((row) => String(row.year || '') === year && String(row.month || '') === month);
        const nightlyPrices = nightlyCandidates
          .map((row) => Number((row as any)[dayKey] || 0))
          .filter((price) => Number.isFinite(price) && price > 0);

        if (nightlyPrices.length === 0) {
          valid = false;
          break;
        }

        const baseAmount = this.hotelPricingService.money(Math.min(...nightlyPrices) * Math.max(roomCount, 1));
        const breakdown = this.hotelPricingService.marginBreakdown(baseAmount, marginPercentage);
        nightlyBase.push(breakdown.baseAmount);
        nightlyMargin.push(breakdown.marginAmount);
        nightlySell.push(breakdown.sellAmount);
      }

      if (!valid || nightlySell.length !== dateList.length) {
        continue;
      }

      const totalStayPrice = this.hotelPricingService.money(
        nightlySell.reduce((sum, amount) => sum + amount, 0),
      );
      const pricePerNight = this.hotelPricingService.money(
        Math.min(...nightlySell),
      );

      const supplements = this.resolveSupplementRates(room, requestedMealPlanCode, ratePlansByRoom);
      offers.push({
        roomId: Number(room.room_ID || 0),
        roomTypeId,
        roomTitle: String(room.room_title || room.room_ref_code || `Room ${roomTypeId}`),
        bookingCode: `OFFLINE-${hotel.hotel_id}-${room.room_ID}-${roomTypeId}`,
        mealPlan: this.resolveMealPlan(room, requestedMealPlanCode, ratePlansByRoom),
        nightlyBase,
        nightlyMargin,
        nightlySell,
        hotelMarginPercentage: marginPercentage,
        baseTotalPrice: this.hotelPricingService.money(nightlyBase.reduce((sum, amount) => sum + amount, 0)),
        hotelMarginTotalAmount: this.hotelPricingService.money(nightlyMargin.reduce((sum, amount) => sum + amount, 0)),
        totalStayPrice,
        pricePerNight,
        roomCount,
        extraBedRate: supplements.extraBedRate,
        childWithBedRate: supplements.childWithBedRate,
        childWithoutBedRate: supplements.childWithoutBedRate,
      });
    }

    offers.sort((a, b) => a.totalStayPrice - b.totalStayPrice);
    return offers;
  }

  async resolveOfflineRateOption(input: {
    planId: number;
    routeId: number;
    routeDate?: string;
    canonicalHotelId: number;
    rateOptionId: string;
    roomCount?: number;
  }): Promise<OfflineRateResolution> {
    const parts = String(input.rateOptionId || '').split(':');
    if (parts.length !== 6 || parts[0] !== 'offline') {
      throw new Error('Offline rate option identifier is invalid or expired');
    }

    const [, hotelIdText, roomIdText, roomTypeIdText, checkInDate, checkOutDate] = parts;
    const hotelId = Number(hotelIdText);
    const roomId = Number(roomIdText);
    const roomTypeId = Number(roomTypeIdText);
    if (
      hotelId !== Number(input.canonicalHotelId) ||
      !Number.isInteger(hotelId) || hotelId <= 0 ||
      !Number.isInteger(roomId) || roomId <= 0 ||
      !Number.isInteger(roomTypeId) || roomTypeId <= 0
    ) {
      throw new Error('Offline rate option does not belong to the selected hotel');
    }

    const [plan, requestedRoute, hotel] = await Promise.all([
      this.prisma.dvi_itinerary_plan_details.findUnique({ where: { itinerary_plan_ID: Number(input.planId) } }),
      (this.prisma as any).dvi_itinerary_route_details.findFirst({
        where: { itinerary_route_ID: Number(input.routeId), itinerary_plan_ID: Number(input.planId), deleted: 0 },
      }),
      this.prisma.dvi_hotel.findFirst({
        where: { hotel_id: hotelId, status: 1, deleted: false },
        select: {
          hotel_id: true,
          hotel_name: true,
          hotel_category: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
        },
      }),
    ]);
    if (!plan || !hotel) {
      throw new Error('Offline rate option is no longer available for this itinerary');
    }

    const dateList = this.getNightDates(checkInDate, checkOutDate);
    const requestedRouteDate = String(input.routeDate || '').slice(0, 10);
    const routeDateOnly = requestedRouteDate || (() => {
      const parsed = requestedRoute
        ? new Date(requestedRoute.itinerary_route_date)
        : null;
      return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
    })();

    // Availability rows can outlive an itinerary route edit. In that case the
    // browser still has the old route ID, but it does have the current route
    // date on the selected card. Reconcile that date to the current plan
    // before persisting instead of rejecting a valid offline option.
    let route = requestedRoute;
    if (requestedRoute && routeDateOnly && (() => {
      const parsed = new Date(requestedRoute.itinerary_route_date);
      return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== routeDateOnly;
    })()) {
      route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_plan_ID: Number(input.planId),
          deleted: 0,
          itinerary_route_date: new Date(`${routeDateOnly}T00:00:00.000Z`),
        },
        orderBy: { itinerary_route_ID: 'asc' },
      });
    }
    if (!route && routeDateOnly) {
      route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_plan_ID: Number(input.planId),
          deleted: 0,
          itinerary_route_date: new Date(`${routeDateOnly}T00:00:00.000Z`),
        },
        orderBy: { itinerary_route_ID: 'asc' },
      });
    }
    if (!route) {
      throw new Error('Offline rate option is no longer available for this itinerary');
    }

    const routeDate = new Date(route.itinerary_route_date);
    const resolvedRouteDateOnly = Number.isNaN(routeDate.getTime()) ? '' : routeDate.toISOString().slice(0, 10);
    // A continuous offline stay is exposed against each route in the block,
    // but its rate option is keyed by the block's first night. Selecting a
    // room/meal option from a later day must therefore validate against the
    // complete stay window, not only the first night.
    if (!dateList.includes(resolvedRouteDateOnly)) {
      throw new Error('Offline rate option is stale for the selected stay dates');
    }

    const offers = await this.buildRoomOffers(
      hotel,
      dateList,
      // The itinerary header is authoritative for the number of rooms being
      // priced. Confirmation requests may omit roomCount (and older clients
      // can send a stale value), so using the request first can incorrectly
      // reject a valid room on occupancy capacity during revalidation.
      Math.max(
        Number((plan as any).preferred_room_count || input.roomCount || 1),
        1,
      ),
      Number((plan as any).total_adult || 0),
      Number((plan as any).total_children || 0),
    );
    const offer = offers.find((candidate) => candidate.roomId === roomId && candidate.roomTypeId === roomTypeId);
    if (!offer) {
      throw new Error('Offline rate option is no longer priced for every requested night');
    }

    const routeNight = selectOfflineRouteNightlyRate(offer, dateList, resolvedRouteDateOnly);
    const routeBaseAmount = routeNight.baseAmount || oneNightRoomBase(offer);
    const routeMarginAmount = routeNight.marginAmount || Number(offer.nightlyMargin[0] || 0);
    const routeSellAmount = routeNight.sellAmount || Number(offer.nightlySell[0] || 0);

    return {
      provider: 'offline',
      hotelId,
      canonicalHotelId: hotelId,
      hotelCode: String(hotelId),
      providerHotelCode: String(hotelId),
      hotelName: normalizeHotelDisplayName(hotel.hotel_name),
      category: Number(hotel.hotel_category || 0),
      routeId: Number(route.itinerary_route_ID),
      routeDate: resolvedRouteDateOnly,
      rateOptionId: input.rateOptionId,
      bookingCode: input.rateOptionId,
      searchReference: input.rateOptionId,
      roomId,
      roomTypeId,
      roomType: offer.roomTitle,
      mealPlan: offer.mealPlan,
      roomCount: offer.roomCount,
      // The resolved option is consumed by a single itinerary route/night.
      // Keep totalStayPrice as the complete continuous-stay amount, but make
      // the route-night fields date-specific instead of reusing night one.
      pricePerNight: routeSellAmount,
      basePricePerNight: routeNight.basePricePerNight || oneRoomNightBase(offer),
      baseTotalPrice: routeBaseAmount,
      hotelMarginPercentage: offer.hotelMarginPercentage,
      hotelMarginAmount: routeMarginAmount,
      hotelMarginTotalAmount: offer.hotelMarginTotalAmount,
      totalStayPrice: offer.totalStayPrice,
      numberOfNights: dateList.length,
      extraBedRate: offer.extraBedRate,
      extraBedAmount: offer.extraBedRate * Math.max(Number(plan.total_extra_bed || 0), 0),
      childWithBedRate: offer.childWithBedRate || offer.extraBedRate,
      childWithBedAmount: (offer.childWithBedRate || offer.extraBedRate) * Math.max(Number(plan.total_child_with_bed || 0), 0),
      currency: 'INR',
      nightlyRates: dateList.map((date, index) => ({
        date,
        baseAmount: offer.nightlyBase[index] || 0,
        marginPercentage: offer.hotelMarginPercentage,
        marginAmount: offer.nightlyMargin[index] || 0,
        sellAmount: offer.nightlySell[index] || 0,
      })),
    };
  }

  private resolveSupplementRates(
    room: any,
    requestedMealPlanCode: string,
    ratePlansByRoom: Map<number, any[]>,
  ): { extraBedRate: number; childWithBedRate: number; childWithoutBedRate: number } {
    const plans = ratePlansByRoom.get(Number(room?.room_ID || 0)) || [];
    const requested = inferCanonicalHotelRatePlanCode(requestedMealPlanCode);
    const plan = plans.find((candidate: any) => {
      const text = `${candidate.rateplan_id || ''} ${candidate.rateplan_name || ''} ${candidate.meal_plan_description || ''}`;
      return requested ? inferCanonicalHotelRatePlanCode(text) === requested : true;
    }) || plans[0];
    const occupancy = this.parseJsonObject(plan?.occupancy);
    const extraBedRate = Number(occupancy.EXTRABED ?? occupancy.EXTRAADULT ?? occupancy.EXTRACHILD ?? 0);
    const childWithBedRate = Number(occupancy.CHILDWITHBED ?? occupancy.CHILD_WITH_BED ?? occupancy.CWB ?? 0);
    const childWithoutBedRate = Number(occupancy.CHILDWITHOUTBED ?? occupancy.CHILD_WITHOUT_BED ?? occupancy.CWOB ?? 0);
    return {
      extraBedRate: Number.isFinite(extraBedRate) && extraBedRate > 0 ? extraBedRate : 0,
      childWithBedRate: Number.isFinite(childWithBedRate) && childWithBedRate > 0 ? childWithBedRate : 0,
      childWithoutBedRate: Number.isFinite(childWithoutBedRate) && childWithoutBedRate > 0 ? childWithoutBedRate : 0,
    };
  }

  private resolveSupplementRatesFromOccupancy(rows: any[], dates: string[]): { extraBedRate: number; childWithBedRate: number; childWithoutBedRate: number } {
    const values = { extraBedRate: 0, childWithBedRate: 0, childWithoutBedRate: 0 };
    for (const date of dates) {
      const target = new Date(`${date}T00:00:00.000Z`).getTime();
      const row = selectAdminMatchingOccupancyRow(rows, target);
      const rates = this.parseJsonObject(row?.occupancy_rates);
      const extra = Number(rates.EXTRABED ?? rates.EXTRA_BED ?? rates.EXTRAADULT ?? 0);
      const child = Number(rates.CHILDWITHBED ?? rates.CHILD_WITH_BED ?? rates.CWB ?? 0);
      const childWithout = Number(rates.CHILDWITHOUTBED ?? rates.CHILD_WITHOUT_BED ?? rates.CWOB ?? 0);
      if (extra > 0) values.extraBedRate = extra;
      if (child > 0) values.childWithBedRate = child;
      if (childWithout > 0) values.childWithoutBedRate = childWithout;
    }
    return values;
  }

  private getRateOptionId(hotelId: number, offer: OfflineRoomOffer, checkInDate: string, lastNightDate: string): string {
    const checkOutDate = new Date(`${lastNightDate}T00:00:00.000Z`);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 1);
    return `offline:${hotelId}:${offer.roomId}:${offer.roomTypeId}:${checkInDate}:${checkOutDate.toISOString().slice(0, 10)}`;
  }

  /**
   * Prisma returns JSON columns as objects, but older deployments may still
   * have the canonical columns physically stored as LONGTEXT. Keep the
   * canonical occupancy-rate source compatible with both schemas while the
   * database migration is rolled out.
   */
  private parseJsonObject(value: unknown): Record<string, any> {
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
      return value as Record<string, any>;
    }
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private resolveMealPlan(room: any, requestedMealPlanCode = '', ratePlansByRoom?: Map<number, any[]>): string {
    const requested = inferCanonicalHotelRatePlanCode(requestedMealPlanCode);
    if (requested && ratePlansByRoom) {
      const roomPlans = ratePlansByRoom.get(Number(room?.room_ID || 0)) || [];
      const hasRequestedPlan = roomPlans.some((plan: any) =>
        inferCanonicalHotelRatePlanCode(
          plan?.meal_plan_description || plan?.rateplan_name || plan?.rateplan_id,
        ) === requested,
      );
      if (hasRequestedPlan) return requested;
    }

    const breakfast = Number(room?.breakfast_included || 0) === 1;
    const lunch = Number(room?.lunch_included || 0) === 1;
    const dinner = Number(room?.dinner_included || 0) === 1;

    if (breakfast && lunch && dinner) return 'AP';
    if (breakfast && (lunch || dinner)) return 'MAP';
    if (breakfast) return 'CP';
    return 'EP';
  }

  private getNightDates(checkInDate: string, checkOutDate: string): string[] {
    const start = new Date(`${checkInDate}T00:00:00.000Z`);
    const end = new Date(`${checkOutDate}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return [];
    }

    const dates: string[] = [];
    const cursor = new Date(start);
    while (cursor < end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }

  private async resolveCityCandidates(destination: string): Promise<string[]> {
    const candidatesByDestination = await this.resolveCityCandidatesForDestinations([destination]);
    return candidatesByDestination.get(String(destination || '').trim()) || [];
  }

  /** Resolve all requested destinations with one city-master query. */
  private async resolveCityCandidatesForDestinations(
    destinations: string[],
  ): Promise<Map<string, string[]>> {
    const uniqueDestinations = Array.from(new Set(
      destinations.map((destination) => String(destination || '').trim()).filter(Boolean),
    ));
    const result = new Map<string, string[]>();
    if (uniqueDestinations.length === 0) return result;

    const lookupTermsByDestination = new Map(
      uniqueDestinations.map((destination) => [destination, this.destinationLookupTerms(destination)]),
    );
    const lookupParts = Array.from(new Set(
      Array.from(lookupTermsByDestination.values())
        .flat()
        .filter(Boolean),
    )).flatMap((term) => [
      { name: { equals: term } },
      { name: { contains: term } },
    ]);
    const cityRecords = await this.prisma.dvi_cities.findMany({
      where: { deleted: 0, OR: lookupParts },
      select: { id: true, name: true },
    });

    for (const destination of uniqueDestinations) {
      const lookupTerms = lookupTermsByDestination.get(destination) || [destination];
      const normalizedTerms = new Set(lookupTerms.map((term) => this.normalizeCityLookupKey(term)));
      const candidates = new Set<string>(lookupTerms);
      for (const city of cityRecords as any[]) {
        const cityName = String(city.name || '').trim();
        const normalizedCityName = this.normalizeCityLookupKey(cityName);
        if (Array.from(normalizedTerms).some((term) => (
          normalizedCityName === term ||
          normalizedCityName.startsWith(`${term} `)
        ))) {
          candidates.add(String(city.id || '').trim());
          candidates.add(cityName);
          const prefix = cityName.split(',')[0].trim();
          if (prefix) candidates.add(prefix);
        }
      }
      result.set(destination, Array.from(candidates).filter(Boolean));
    }

    return result;
  }

  private destinationLookupTerms(destination: string): string[] {
    const raw = String(destination || '').trim();
    if (!raw) return [];

    const firstPart = raw.split(/[,(-]/)[0].trim();
    const withoutFacilitySuffix = firstPart
      .replace(/\b(international|domestic)?\s*airport\b/gi, '')
      .replace(/\brailway\s+station\b/gi, '')
      .replace(/\bbus\s+stand\b/gi, '')
      .replace(/\bport\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const base = withoutFacilitySuffix || firstPart || raw;
    const aliases = OFFLINE_DESTINATION_ALIASES[this.normalizeCityLookupKey(base)] || [];

    return Array.from(new Set([raw, firstPart, base, ...aliases].filter(Boolean)));
  }

  private normalizeCityLookupKey(value: string): string {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private normalizeTextList(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }

    return String(value)
      .split(/[\n,|;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
