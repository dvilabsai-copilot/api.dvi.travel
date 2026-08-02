import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotelPricingService } from '../hotels/hotel-pricing.service';
import { HotelSearchResult, RoomType } from '../../hotels/interfaces/hotel-provider.interface';
import { HotelAvailabilityTimingLogger } from './hotel-availability-timing.logger';

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
  nightlySell: number[];
  totalStayPrice: number;
  pricePerNight: number;
  roomCount: number;
};

export type OfflineRateResolution = {
  canonicalHotelId: number;
  rateOptionId: string;
  roomId: number;
  roomTypeId: number;
  roomType: string;
  mealPlan: string;
  pricePerNight: number;
  totalStayPrice: number;
  numberOfNights: number;
  currency: string;
  nightlyRates: Array<{ date: string; baseAmount: number; sellAmount: number }>;
};

type OfflineCatalogRows = {
  roomsByHotel: Map<number, any[]>;
  activeRoomTypeIds: Set<number>;
  pricesByHotelRoomType: Map<string, any[]>;
};

@Injectable()
export class OfflineHotelCatalogService {
  private readonly logger = new Logger(OfflineHotelCatalogService.name);
  private readonly availabilityCache = new Map<string, { expiresAt: number; hotels: HotelSearchResult[] }>();
  private readonly availabilityCacheTtlMs = 15 * 60 * 1000;

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
  }): Promise<HotelSearchResult[]> {
    const hotels = await this.fetchOfflineHotelsForStayBlock({
      destination: String(criteria.cityCode || '').trim(),
      checkInDate: String(criteria.checkInDate || '').slice(0, 10),
      checkOutDate: String(criteria.checkOutDate || '').slice(0, 10),
      routeIds: [],
    }, Math.max(Number(criteria.roomCount || 1), 1), `adults:${Number(criteria.adultCount || 0)}|children:${Number(criteria.childCount || 0)}|ages:${(criteria.childAges || []).join(',')}`, Number(criteria.adultCount || 0), Number(criteria.childCount || 0));
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

    const occupancyKey = `adults:${adultCount}|children:${childCount}|ages:${childAges.join(',')}`;
    const now = Date.now();
    const cachePartitionStartedAt = Date.now();
    const uncachedBlocks = stayBlocks.filter((block) => {
      const cached = this.availabilityCache.get(this.blockCacheKey(block, roomCount, occupancyKey));
      return !cached || cached.expiresAt <= now;
    });
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_STAGE', {
      stage: 'cache-partition',
      durationMs: Date.now() - cachePartitionStartedAt,
      stayBlockCount: stayBlocks.length,
      uncachedBlockCount: uncachedBlocks.length,
    });

    const hotelLoadStartedAt = Date.now();
    const hotelsByBlock = await this.loadHotelsByStayBlock(uncachedBlocks, roomCount, occupancyKey);
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_STAGE', {
      stage: 'hotel-master-load',
      durationMs: Date.now() - hotelLoadStartedAt,
      uncachedBlockCount: uncachedBlocks.length,
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
      priceRowCount: Array.from(catalogRows.pricesByHotelRoomType.values()).reduce((sum, rows) => sum + rows.length, 0),
    });

    const offerBuildStartedAt = Date.now();
    for (const block of stayBlocks) {
      const hotels = await this.fetchOfflineHotelsForStayBlock(
        block,
        roomCount,
        occupancyKey,
        adultCount,
        childCount,
        catalogRows,
        hotelsByBlock.get(this.blockCacheKey(block, roomCount, occupancyKey)),
      );

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
      uncachedBlockCount: uncachedBlocks.length,
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
  ): Promise<HotelSearchResult[]> {
    const cacheKey = [
      block.destination,
      block.checkInDate,
      block.checkOutDate,
      Math.max(Number(roomCount || 1), 1),
      occupancyKey,
    ].join('|').toLowerCase();
    const cached = this.availabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.hotels;
    }
    if (cached) this.availabilityCache.delete(cacheKey);

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
      const offers = await this.buildRoomOffers(hotel, dateList, roomCount, adultCount, childCount, catalogRows);
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
        hotelName: String(hotel.hotel_name || 'Hotel'),
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
        totalStayPrice: bestOffer.totalStayPrice,
        numberOfNights: dateList.length,
        nightlyRates: dateList.map((date, index) => ({
          date,
          baseAmount: bestOffer.nightlyBase[index] || 0,
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
          totalStayPrice: offer.totalStayPrice,
          numberOfNights: dateList.length,
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
            sellAmount: offer.nightlySell[index] || 0,
          })),
        })),
      } as HotelSearchResult & Record<string, unknown>);
    }

    results.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    this.availabilityCache.set(cacheKey, {
      expiresAt: Date.now() + this.availabilityCacheTtlMs,
      hotels: results,
    });
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
        activeRoomTypeIds: new Set(),
        pricesByHotelRoomType: new Map(),
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

    const requestedPeriods = Array.from(new Set(
      requestedDates.map((date) => {
        const parsed = new Date(`${date}T00:00:00.000Z`);
        return Number.isNaN(parsed.getTime())
          ? ''
          : `${parsed.getUTCFullYear()}|${parsed.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}`;
      }).filter(Boolean),
    ));
    const requestedDayNumbers = Array.from(new Set(
      requestedDates.map((date) => {
        const parsed = new Date(`${date}T00:00:00.000Z`);
        return Number.isNaN(parsed.getTime()) ? 0 : parsed.getUTCDate();
      }).filter((day) => day > 0),
    ));
    const priceSelect: Record<string, boolean> = {
      hotel_id: true,
      room_type_id: true,
      year: true,
      month: true,
    };
    for (const dayNumber of requestedDayNumbers) {
      priceSelect[`day_${dayNumber}`] = true;
    }

    const priceRowsStartedAt = Date.now();
    const priceRows = roomTypeIds.length > 0
      ? await this.prisma.dvi_hotel_room_price_book.findMany({
          where: {
            hotel_id: { in: hotelIds },
            room_type_id: { in: roomTypeIds },
            price_type: 0,
            status: 1,
            deleted: 0,
            ...(requestedPeriods.length > 0
              ? { OR: requestedPeriods.map((period) => {
                  const [year, month] = period.split('|');
                  return { year, month };
                }) }
              : {}),
          },
          select: priceSelect as any,
        })
      : [];
    HotelAvailabilityTimingLogger.log('OFFLINE_CATALOG_QUERY', {
      query: 'room-price-book',
      durationMs: Date.now() - priceRowsStartedAt,
      hotelCount: hotelIds.length,
      roomTypeCount: roomTypeIds.length,
      requestedPeriods,
      requestedDayNumbers,
      rowCount: priceRows.length,
    });
    const pricesByHotelRoomType = new Map<string, any[]>();
    for (const row of priceRows as any[]) {
      const key = `${Number(row.hotel_id || 0)}|${Number(row.room_type_id || 0)}`;
      const rows = pricesByHotelRoomType.get(key) || [];
      rows.push(row);
      pricesByHotelRoomType.set(key, rows);
    }

    return { roomsByHotel, activeRoomTypeIds, pricesByHotelRoomType };
  }

  clearCache(): void {
    this.availabilityCache.clear();
  }

  private buildRoomOffersFromCatalogRows(
    hotel: any,
    dateList: string[],
    roomCount: number,
    adultCount: number,
    childCount: number,
    catalogRows: OfflineCatalogRows,
  ): OfflineRoomOffer[] {
    const hotelId = Number(hotel.hotel_id || 0);
    const roomsNeeded = Math.max(Number(roomCount || 1), 1);
    const activeRooms = (catalogRows.roomsByHotel.get(hotelId) || []).filter((room: any) => {
      const maxAdults = Number(room.total_max_adults || 0);
      const maxChildren = Number(room.total_max_childrens || 0);
      return (!adultCount || !maxAdults || maxAdults * roomsNeeded >= adultCount) &&
        (!childCount || !maxChildren || maxChildren * roomsNeeded >= childCount) &&
        catalogRows.activeRoomTypeIds.has(Number(room.room_type_id || 0));
    });
    const offers: OfflineRoomOffer[] = [];

    for (const room of activeRooms) {
      const roomTypeId = Number(room.room_type_id || 0);
      const matchingPriceRows = catalogRows.pricesByHotelRoomType.get(`${hotelId}|${roomTypeId}`) || [];
      if (matchingPriceRows.length === 0) continue;

      const nightlyBase: number[] = [];
      const nightlySell: number[] = [];
      let valid = true;
      for (const date of dateList) {
        const parsed = new Date(`${date}T00:00:00.000Z`);
        const dayKey = `day_${parsed.getUTCDate()}`;
        const year = String(parsed.getUTCFullYear());
        const month = parsed.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
        const nightlyPrices = matchingPriceRows
          .filter((row) => String(row.year || '') === year && String(row.month || '') === month)
          .map((row) => Number(row[dayKey] || 0))
          .filter((price) => Number.isFinite(price) && price > 0);
        if (nightlyPrices.length === 0) {
          valid = false;
          break;
        }

        const baseAmount = Math.min(...nightlyPrices);
        const sellAmount = this.hotelPricingService.applyInvisibleHotelMargin(baseAmount, hotel);
        nightlyBase.push(baseAmount);
        nightlySell.push(this.hotelPricingService.money(sellAmount * roomsNeeded));
      }

      if (!valid || nightlySell.length !== dateList.length) continue;
      offers.push({
        roomId: Number(room.room_ID || 0),
        roomTypeId,
        roomTitle: String(room.room_title || room.room_ref_code || `Room ${roomTypeId}`),
        bookingCode: `OFFLINE-${hotelId}-${room.room_ID}-${roomTypeId}`,
        mealPlan: this.resolveMealPlan(room),
        nightlyBase,
        nightlySell,
        totalStayPrice: this.hotelPricingService.money(nightlySell.reduce((sum, amount) => sum + amount, 0)),
        pricePerNight: this.hotelPricingService.money(Math.min(...nightlySell)),
        roomCount,
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
  ): Promise<OfflineRoomOffer[]> {
    if (catalogRows) {
      return this.buildRoomOffersFromCatalogRows(
        hotel,
        dateList,
        roomCount,
        adultCount,
        childCount,
        catalogRows,
      );
    }

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
    const roomsWithCapacity = activeRooms.filter((room: any) => {
      const maxAdults = Number(room.total_max_adults || 0);
      const maxChildren = Number(room.total_max_childrens || 0);
      const adultCapacityOk = !adultCount || !maxAdults || maxAdults * roomsNeeded >= adultCount;
      const childCapacityOk = !childCount || !maxChildren || maxChildren * roomsNeeded >= childCount;
      return adultCapacityOk && childCapacityOk;
    });
    if (roomsWithCapacity.length === 0) return [];
    activeRooms.splice(0, activeRooms.length, ...roomsWithCapacity);

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

        const baseAmount = Math.min(...nightlyPrices);
        const sellAmount = this.hotelPricingService.applyInvisibleHotelMargin(baseAmount, hotel);
        const totalSellAmount = this.hotelPricingService.money(sellAmount * Math.max(roomCount, 1));
        nightlyBase.push(baseAmount);
        nightlySell.push(totalSellAmount);
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

      offers.push({
        roomId: Number(room.room_ID || 0),
        roomTypeId,
        roomTitle: String(room.room_title || room.room_ref_code || `Room ${roomTypeId}`),
        bookingCode: `OFFLINE-${hotel.hotel_id}-${room.room_ID}-${roomTypeId}`,
        mealPlan: this.resolveMealPlan(room),
        nightlyBase,
        nightlySell,
        totalStayPrice,
        pricePerNight,
        roomCount,
      });
    }

    offers.sort((a, b) => a.totalStayPrice - b.totalStayPrice);
    return offers;
  }

  async resolveOfflineRateOption(input: {
    planId: number;
    routeId: number;
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

    const [plan, route, hotel] = await Promise.all([
      this.prisma.dvi_itinerary_plan_details.findUnique({ where: { itinerary_plan_ID: Number(input.planId) } }),
      (this.prisma as any).dvi_itinerary_route_details.findFirst({
        where: { itinerary_route_ID: Number(input.routeId), itinerary_plan_ID: Number(input.planId), deleted: 0 },
      }),
      this.prisma.dvi_hotel.findFirst({
        where: { hotel_id: hotelId, status: 1, deleted: false },
        select: { hotel_id: true, hotel_margin: true, hotel_margin_gst_type: true, hotel_margin_gst_percentage: true },
      }),
    ]);
    if (!plan || !route || !hotel) {
      throw new Error('Offline rate option is no longer available for this itinerary');
    }

    const routeDate = new Date(route.itinerary_route_date);
    const routeDateOnly = Number.isNaN(routeDate.getTime()) ? '' : routeDate.toISOString().slice(0, 10);
    if (routeDateOnly !== checkInDate) {
      throw new Error('Offline rate option is stale for the selected stay dates');
    }

    const dateList = this.getNightDates(checkInDate, checkOutDate);
    const offers = await this.buildRoomOffers(
      hotel,
      dateList,
      Math.max(Number(input.roomCount || 1), 1),
      Number((plan as any).total_adult || 0),
      Number((plan as any).total_children || 0),
    );
    const offer = offers.find((candidate) => candidate.roomId === roomId && candidate.roomTypeId === roomTypeId);
    if (!offer) {
      throw new Error('Offline rate option is no longer priced for every requested night');
    }

    return {
      canonicalHotelId: hotelId,
      rateOptionId: input.rateOptionId,
      roomId,
      roomTypeId,
      roomType: offer.roomTitle,
      mealPlan: offer.mealPlan,
      pricePerNight: offer.pricePerNight,
      totalStayPrice: offer.totalStayPrice,
      numberOfNights: dateList.length,
      currency: 'INR',
      nightlyRates: dateList.map((date, index) => ({
        date,
        baseAmount: offer.nightlyBase[index] || 0,
        sellAmount: offer.nightlySell[index] || 0,
      })),
    };
  }

  private getRateOptionId(hotelId: number, offer: OfflineRoomOffer, checkInDate: string, lastNightDate: string): string {
    const checkOutDate = new Date(`${lastNightDate}T00:00:00.000Z`);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 1);
    return `offline:${hotelId}:${offer.roomId}:${offer.roomTypeId}:${checkInDate}:${checkOutDate.toISOString().slice(0, 10)}`;
  }

  private resolveMealPlan(room: any): string {
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

    const lookupParts = uniqueDestinations.flatMap((destination) => {
      const firstPart = destination.split(/[,(-]/)[0].trim();
      return [
        { name: { equals: firstPart } },
        { name: { contains: firstPart } },
        { name: { equals: destination } },
        { name: { contains: destination } },
      ];
    });
    const cityRecords = await this.prisma.dvi_cities.findMany({
      where: { deleted: 0, OR: lookupParts },
      select: { id: true, name: true },
    });

    for (const destination of uniqueDestinations) {
      const firstPart = destination.split(/[,(-]/)[0].trim();
      const candidates = new Set<string>([destination, firstPart]);
      for (const city of cityRecords as any[]) {
        const cityName = String(city.name || '').trim();
        if (
          cityName === firstPart ||
          cityName.includes(firstPart) ||
          cityName === destination ||
          cityName.includes(destination)
        ) {
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
