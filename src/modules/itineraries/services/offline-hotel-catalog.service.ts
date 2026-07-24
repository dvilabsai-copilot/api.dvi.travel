import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotelPricingService } from '../hotels/hotel-pricing.service';
import { HotelSearchResult, RoomType } from '../../hotels/interfaces/hotel-provider.interface';

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
  }): Promise<HotelSearchResult[]> {
    const hotels = await this.fetchOfflineHotelsForStayBlock({
      destination: String(criteria.cityCode || '').trim(),
      checkInDate: String(criteria.checkInDate || '').slice(0, 10),
      checkOutDate: String(criteria.checkOutDate || '').slice(0, 10),
      routeIds: [],
    }, Math.max(Number(criteria.roomCount || 1), 1));
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
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const stayBlocks = this.buildStayBlocks(routes, noOfNights);

 this.logger.log(
      `Offline hotel catalog processing ${stayBlocks.length} stay block(s) ` +
        `for roomCount=${roomCount}, adults=${adultCount}, children=${childCount}, nationality=${guestNationality || 'n/a'}`,
    );

    for (const block of stayBlocks) {
      const hotels = await this.fetchOfflineHotelsForStayBlock(
        block,
        roomCount,
      );

      for (const routeId of block.routeIds) {
        hotelsByRoute.set(routeId, hotels);
      }
    }

    for (const route of routes || []) {
      const routeId = Number((route as any)?.itinerary_route_ID || 0);
      if (routeId > 0 && !hotelsByRoute.has(routeId)) {
        hotelsByRoute.set(routeId, []);
      }
    }

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
  ): Promise<HotelSearchResult[]> {
    const dateList = this.getNightDates(block.checkInDate, block.checkOutDate);
    if (dateList.length === 0) {
      return [];
    }

    const cityCandidates = await this.resolveCityCandidates(block.destination);
    if (cityCandidates.length === 0) {
      return [];
    }

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

    const results: HotelSearchResult[] = [];
    for (const hotel of hotels as any[]) {
      const offers = await this.buildRoomOffers(hotel, dateList, roomCount);
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
    return results;
  }

  private async buildRoomOffers(
    hotel: any,
    dateList: string[],
    roomCount: number,
  ): Promise<OfflineRoomOffer[]> {
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
        breakfast_included: true,
        lunch_included: true,
        dinner_included: true,
      },
      orderBy: [{ room_type_id: 'asc' }, { room_ID: 'asc' }],
    });

    if (activeRooms.length === 0) {
      return [];
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
    const offers = await this.buildRoomOffers(hotel, dateList, Math.max(Number(input.roomCount || 1), 1));
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
    const raw = String(destination || '').trim();
    if (!raw) {
      return [];
    }

    const firstPart = raw.split(/[,(-]/)[0].trim();
    const cityRecords = await this.prisma.dvi_cities.findMany({
      where: {
        deleted: 0,
        OR: [
          { name: { equals: firstPart } },
          { name: { contains: firstPart } },
          { name: { equals: raw } },
          { name: { contains: raw } },
        ],
      },
      select: { id: true, name: true },
    });

    const candidates = new Set<string>([raw, firstPart]);
    for (const city of cityRecords as any[]) {
      candidates.add(String(city.id || '').trim());
      candidates.add(String(city.name || '').trim());
      const prefix = String(city.name || '').split(',')[0].trim();
      if (prefix) {
        candidates.add(prefix);
      }
    }

    return Array.from(candidates).filter(Boolean);
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
