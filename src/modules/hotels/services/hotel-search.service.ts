import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import {
  IHotelProvider,
  HotelSearchResult,
  HotelSearchCriteria,
  HotelPreferences,
} from '../interfaces/hotel-provider.interface';
import { HotelSearchDTO } from '../dto/hotel.dto';
import { TBOHotelProvider } from '../providers/tbo-hotel.provider';
import { ResAvenueHotelProvider } from '../providers/resavenue-hotel.provider';
import { HobseHotelProvider } from '../providers/hobse-hotel.provider';
import { OfflineHotelCatalogService } from '../../itineraries/services/offline-hotel-catalog.service';

@Injectable()
export class HotelSearchService {
 // General room limit for AxisRooms and other channel managers.
  private static readonly MAX_ROOMS = 25;

 // TBO supports only a maximum of 6 rooms per search.
  private static readonly TBO_MAX_ROOMS = 6;

  private static readonly MAX_ADULTS_PER_ROOM = 8;
  private static readonly MAX_CHILDREN_PER_ROOM = 4;
  private static readonly DEFAULT_CHILD_AGE = 6;
  private providers: Map<string, IHotelProvider>;
  private readonly logger = new Logger(HotelSearchService.name);

  constructor(
    private prisma: PrismaService,
    private tboProvider: TBOHotelProvider,
    private resavenueProvider: ResAvenueHotelProvider,
    private hobseProvider: HobseHotelProvider,
    private offlineHotelCatalog: OfflineHotelCatalogService,
  ) {
    this.providers = new Map<string, any>([
      ['tbo', this.tboProvider],
      ['resavenue', this.resavenueProvider],
      ['hobse', this.hobseProvider],
    ]);
  }

  private isAxisOnlyFetchEnabled(): boolean {
    const raw = String(process.env.HOTEL_FETCH_AXIS_ONLY || '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private isTboOnlyFetchEnabled(): boolean {
    const raw = String(process.env.HOTEL_FETCH_TBO_ONLY || '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private parseDateOnly(input: string): Date {
    const raw = String(input || '').trim();
    const datePart = raw.includes('T') ? raw.split('T')[0] : raw;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
    if (!match) {
      throw new BadRequestException(`Invalid date format: ${input}. Expected YYYY-MM-DD.`);
    }

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    return new Date(year, month, day, 0, 0, 0, 0);
  }

  private normalizeCityToken(value: unknown): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  async searchHotels(searchCriteria: HotelSearchDTO): Promise<HotelSearchResult[]> {
    const startTime = Date.now();
    try {
      if (this.isAxisOnlyFetchEnabled() && this.isTboOnlyFetchEnabled()) {
        throw new BadRequestException('HOTEL_FETCH_AXIS_ONLY and HOTEL_FETCH_TBO_ONLY cannot both be enabled');
      }
      if (this.isAxisOnlyFetchEnabled()) {
 this.logger.warn(
          'HOTEL_FETCH_AXIS_ONLY enabled: fetching Offline + AxisRooms only in HotelSearchService.',
        );
        const [offlineHotels, axisRoomsHotels] = await Promise.all([
          this.offlineHotelCatalog.searchOfflineHotels({
            cityCode: searchCriteria.cityCode,
            checkInDate: searchCriteria.checkInDate,
            checkOutDate: searchCriteria.checkOutDate,
            roomCount: searchCriteria.roomCount,
          }),
          this.searchAxisRoomsHotels(searchCriteria),
        ]);
        return [...axisRoomsHotels, ...offlineHotels];
      }

      const {
        cityCode,
        checkInDate,
        checkOutDate,
        roomCount,
        guestCount,
        adultCount,
        childCount,
        childAges,
        guestNationality,
        hotelName,
        occupancies,
 providers = ['tbo', 'resavenue', 'hobse'], // Search all providers by default
      } = searchCriteria;

 this.logger.log('\n HOTEL SEARCH SERVICE PROCESSING');
 this.logger.log(` Input Criteria:`);
 this.logger.log(` - City Code: ${cityCode}`);
 this.logger.log(` - Check-in: ${checkInDate}`);
 this.logger.log(` - Check-out: ${checkOutDate}`);
 this.logger.log(` - Rooms: ${roomCount}`);
 this.logger.log(` - Guests: ${guestCount}`);
      if (adultCount !== undefined || childCount !== undefined) {
  this.logger.log(` - Adults: ${adultCount ?? 'n/a'}`);
  this.logger.log(` - Children: ${childCount ?? 'n/a'}`);
      }
      if (guestNationality) {
 this.logger.log(` - Nationality: ${guestNationality}`);
      }
      if (hotelName) {
 this.logger.log(` - Hotel Name: ${hotelName}`);
      }
 this.logger.log(` - Providers: ${providers.join(', ')}`);

 // Validation
      if (!cityCode) {
        throw new BadRequestException('City code is required');
      }

     const requestedProviderKeys = (
  Array.isArray(providers) && providers.length > 0
    ? providers
    : ['tbo', 'resavenue', 'hobse']
)
  .map((provider) => String(provider || '').trim().toLowerCase())
  .filter(
    (provider, index, items) =>
      Boolean(provider) && items.indexOf(provider) === index,
  );

// For 725 rooms, do not send the search to TBO.
// Other registered channel managers will continue handling the search.
const providerKeysToSearch =
  Number(roomCount) > HotelSearchService.TBO_MAX_ROOMS
    ? requestedProviderKeys.filter((provider) => provider !== 'tbo')
    : requestedProviderKeys;

if (
  Number(roomCount) > HotelSearchService.TBO_MAX_ROOMS &&
  requestedProviderKeys.includes('tbo')
) {
 this.logger.log(
    `Skipping TBO because roomCount ${roomCount} exceeds the TBO limit of ${HotelSearchService.TBO_MAX_ROOMS}.`,
  );
}

const isTboRequested = providerKeysToSearch.includes('tbo');

if (
  isTboRequested &&
  (!guestNationality ||
    !/^[A-Z]{2}$/i.test(String(guestNationality).trim()))
) {
  throw new BadRequestException(
    'guestNationality is required as ISO-2 code when searching VSR hotels (example: IN).',
  );
}

      const checkIn = this.parseDateOnly(checkInDate);
      const checkOut = this.parseDateOnly(checkOutDate);

      if (checkIn >= checkOut) {
        throw new BadRequestException('Check-in must be before check-out');
      }

 // Compare at day granularity so same-day bookings remain valid after midnight.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (checkIn < today) {
        throw new BadRequestException('Check-in date cannot be in the past');
      }

  const normalizedRoomCount = Number(roomCount);

if (
  !Number.isInteger(normalizedRoomCount) ||
  normalizedRoomCount < 1
) {
  throw new BadRequestException(
    'roomCount must be a positive integer',
  );
}

if (normalizedRoomCount > HotelSearchService.MAX_ROOMS) {
  throw new BadRequestException(
    `roomCount cannot exceed ${HotelSearchService.MAX_ROOMS}`,
  );
}

      let normalizedOccupancies = occupancies;

      if (adultCount !== undefined || childCount !== undefined || (childAges && childAges.length > 0)) {
        const safeAdultCount = Number(adultCount ?? 0);
        const safeChildCount = Number(childCount ?? 0);
        const safeChildAges = Array.isArray(childAges)
          ? childAges.map((age) => Number(age)).filter((age) => !Number.isNaN(age))
          : [];
        const normalizedChildAges = this.normalizeChildAges(safeChildCount, safeChildAges);

        if (safeAdultCount < 1) {
          throw new BadRequestException('At least one adult is required for hotel search');
        }

        if (roomCount === 1 && safeAdultCount > HotelSearchService.MAX_ADULTS_PER_ROOM) {
          throw new BadRequestException(
            `adultCount cannot exceed ${HotelSearchService.MAX_ADULTS_PER_ROOM} for one room`,
          );
        }

        if (roomCount === 1 && safeChildCount > HotelSearchService.MAX_CHILDREN_PER_ROOM) {
          throw new BadRequestException(
            `childCount cannot exceed ${HotelSearchService.MAX_CHILDREN_PER_ROOM} for one room`,
          );
        }

        if (safeAdultCount + safeChildCount !== guestCount) {
          throw new BadRequestException(
            `guestCount (${guestCount}) must equal adultCount + childCount (${safeAdultCount + safeChildCount})`,
          );
        }

 // Derive occupancies from adult/child counts if not explicitly provided
        if (!normalizedOccupancies || normalizedOccupancies.length === 0) {
          normalizedOccupancies = this.deriveOccupancies(
            roomCount,
            safeAdultCount,
            safeChildCount,
            normalizedChildAges,
          );
        }
      }

      this.validateOccupancies(roomCount, guestCount, normalizedOccupancies);
// Get only providers eligible for the requested room count.
const activeProviders = providerKeysToSearch
  .map((providerKey) => this.providers.get(providerKey))
  .filter(
    (provider): provider is IHotelProvider =>
      provider !== undefined,
  );

if (activeProviders.length === 0) {
  if (Number(roomCount) > HotelSearchService.TBO_MAX_ROOMS) {
    throw new BadRequestException(
      `No eligible non-TBO hotel provider is available for ${roomCount} rooms. ` +
        `TBO supports a maximum of ${HotelSearchService.TBO_MAX_ROOMS} rooms.`,
    );
  }

  throw new BadRequestException(
    'No valid hotel providers specified',
  );
}

 this.logger.log(` Searching across ${activeProviders.length} provider(s): ${activeProviders.map(p => p.getName()).join(', ')}`);

 // Search in parallel across all providers
      const searchPromises = activeProviders.map((provider) =>
        this.executeProviderSearch(
          provider,
          {
            cityCode,
            checkInDate,
            checkOutDate,
            roomCount,
            guestCount,
            guestNationality,
            hotelName,
            occupancies: normalizedOccupancies,
          },
          searchCriteria.preferences,
        ),
      );

      if (!this.isTboOnlyFetchEnabled()) {
        searchPromises.push(this.searchAxisRoomsHotels(searchCriteria));
        searchPromises.push(this.searchStaahHotels(searchCriteria));
      }

      const results = await Promise.all(searchPromises);
      const allHotels = results.flat();

      const filteredHotels = this.filterHotelsByName(allHotels, hotelName);

      if (filteredHotels.length === 0) {
 this.logger.warn(` No hotels found for the given criteria`);
 this.logger.log(` Total Time: ${Date.now() - startTime}ms`);
        return [];
      }

 this.logger.log(` Found ${allHotels.length} hotels across all providers`);
 this.logger.log(` Returning ${filteredHotels.length} hotels after hotel-name filtering`);
 this.logger.log(` Provider Search Time: ${Date.now() - startTime}ms`);

 // Deduplicate and rank hotels
      const uniqueHotels = this.deduplicateHotels(filteredHotels);
      const rankedHotels = this.rankHotels(uniqueHotels, searchCriteria.preferences);

 this.logger.log(` Returning ${rankedHotels.length} unique, ranked hotels`);
 this.logger.log(` Total Service Time: ${Date.now() - startTime}ms\n`);

      return rankedHotels;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'No stack trace';
 this.logger.error(`\n Hotel search error: ${errorMessage}`);
 this.logger.error(`Error Stack: ${errorStack}`);
 this.logger.log(` Failed After: ${Date.now() - startTime}ms\n`);
      throw error;
    }
  }

  private async searchAxisRoomsHotels(criteria: HotelSearchDTO): Promise<HotelSearchResult[]> {
    const cityToken = String(criteria.cityCode || '').trim().toLowerCase();
    const hotelNameQuery = String(criteria.hotelName || '').trim().toLowerCase();
    const checkIn = new Date(`${String(criteria.checkInDate).slice(0, 10)}T00:00:00.000Z`);
    const hotels = await (this.prisma as any).dvi_hotel.findMany({
      where: { axisrooms_enabled: 1, status: 1, OR: [{ deleted: false }, { deleted: null }] },
      select: { hotel_id: true, hotel_name: true, hotel_city: true, hotel_address: true, hotel_category: true, axisrooms_property_id: true },
    });
    const matching = hotels.filter((hotel: any) => {
      const matchesCity =
        String(hotel.hotel_city || '').trim().toLowerCase() === cityToken ||
        String(hotel.hotel_id) === cityToken;
      if (!matchesCity) return false;
      if (!hotelNameQuery) return true;
      return String(hotel.hotel_name || '').trim().toLowerCase().includes(hotelNameQuery);
    });
    const results: HotelSearchResult[] = [];
    for (const hotel of matching) {
      const availability = await (this.prisma as any).dvi_hotel_room_availability.findMany({ where: { hotel_id: hotel.hotel_id, start_date: { lte: checkIn }, end_date: { gte: checkIn }, free: { gt: 0 } }, select: { room_id: true, free: true } });
      if (!availability.length) continue;
      const roomIds = availability.map((row: any) => Number(row.room_id)).filter((id: number) => id > 0);
      const plans = await (this.prisma as any).dvi_hotel_room_rate_plan.findMany({ where: { hotel_id: hotel.hotel_id, room_id: { in: roomIds }, axisrooms_room_id: { not: null }, status: 1, deleted: 0 }, select: { room_id: true, rateplan_id: true, meal_plan_description: true } });
      if (!plans.length) continue;
      const occupancy = await (this.prisma as any).dvi_hotel_occupancy_rate.findMany({ where: { hotel_id: hotel.hotel_id, room_id: { in: roomIds }, start_date: { lte: checkIn }, end_date: { gte: checkIn } }, select: { room_id: true, rateplan_id: true, occupancy_rates: true } });
      const plan = plans.find((candidate: any) => occupancy.some((row: any) => String(row.rateplan_id) === String(candidate.rateplan_id)));
      const rateRow = plan ? occupancy.find((row: any) => String(row.rateplan_id) === String(plan.rateplan_id)) : null;
      const rate = this.extractAxisRate(rateRow?.occupancy_rates);
      if (!plan || !rate) continue;
      const room = await (this.prisma as any).dvi_hotel_rooms.findFirst({ where: { room_ID: plan.room_id, deleted: 0 }, select: { room_title: true } });
      const optionId = `axisrooms:${hotel.hotel_id}:${plan.room_id}:${plan.rateplan_id}:${String(criteria.checkInDate).slice(0, 10)}`;
      results.push({
        provider: 'axisrooms', providerDisplayName: 'AxisRooms', canonicalHotelId: Number(hotel.hotel_id), providerHotelCode: String(hotel.axisrooms_property_id || hotel.hotel_id), rateOptionId: optionId,
        hotelCode: String(hotel.hotel_id), hotelName: String(hotel.hotel_name || 'Hotel'), cityCode: String(hotel.hotel_city || criteria.cityCode), address: String(hotel.hotel_address || ''), rating: Number(hotel.hotel_category || 0), facilities: [], amenities: [], inclusions: [], rateConditions: [], cancellationPolicy: [], images: [], price: rate, currency: 'INR', roomTypes: [{ roomCode: String(plan.room_id), roomName: String(room?.room_title || 'Room'), bedType: '', capacity: 0, price: rate, cancellationPolicy: '' }], roomType: String(room?.room_title || 'Room'), mealPlan: String(plan.meal_plan_description || '-'), searchReference: optionId, expiresAt: new Date(Date.now() + 15 * 60 * 1000), pricePerNight: rate, bookingMode: 'LIVE_API', priceSource: 'LIVE_API', availabilityStatus: 'LIVE_AVAILABLE', isLiveRate: true, isLiveBookable: true, isSelectable: true, requiresHotelApproval: false, approvalStatus: 'NOT_REQUIRED', manualConfirmationStatus: 'NOT_STARTED',
      });
    }
    return results;
  }

  private async searchStaahHotels(criteria: HotelSearchDTO): Promise<HotelSearchResult[]> {
    const cityToken = this.normalizeCityToken(criteria.cityCode);
    const hotelNameQuery = String(criteria.hotelName || '').trim().toLowerCase();
    const checkIn = new Date(`${String(criteria.checkInDate).slice(0, 10)}T00:00:00.000Z`);
    const roomCount = Math.max(Number(criteria.roomCount || 1), 1);
    const staahHotels = await (this.prisma as any).dvi_hotel.findMany({
      where: {
        staah_enabled: 1,
        status: 1,
        deleted: false,
        AND: [
          { staah_property_id: { not: null } },
          { staah_property_id: { not: '' } },
        ],
      },
      select: {
        hotel_id: true,
        hotel_name: true,
        hotel_city: true,
        hotel_address: true,
        hotel_category: true,
        staah_property_id: true,
      },
    });

    if (!staahHotels.length) {
      return [];
    }

    const cityIds = Array.from(
      new Set(
        staahHotels
          .map((hotel: any) => Number(hotel.hotel_city || 0))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    );
    const cityRows = cityIds.length
      ? await (this.prisma as any).dvi_cities.findMany({
          where: { id: { in: cityIds } },
          select: { id: true, name: true },
        })
      : [];
    const cityMap = new Map<number, string>(
      cityRows.map((row: any) => [Number(row.id), String(row.name || '')]),
    );

    const matchingHotels = staahHotels.filter((hotel: any) => {
      const cityId = Number(hotel.hotel_city || 0);
      const resolvedCity = cityMap.get(cityId) || String(hotel.hotel_city || '');
      const hotelCityToken = this.normalizeCityToken(resolvedCity);
      if (!hotelCityToken || hotelCityToken !== cityToken) {
        return false;
      }
      if (!hotelNameQuery) {
        return true;
      }
      return String(hotel.hotel_name || '').trim().toLowerCase().includes(hotelNameQuery);
    });

    if (!matchingHotels.length) {
      return [];
    }

    const propertyIds = matchingHotels
      .map((hotel: any) => String(hotel.staah_property_id || '').trim())
      .filter(Boolean);
    const [inventoryRows, ratePlanRows, rateRows] = await Promise.all([
      (this.prisma as any).staah_inventory.findMany({
        where: {
          staah_property_id: { in: propertyIds },
          start_date: { lte: checkIn },
          end_date: { gte: checkIn },
          free: { gte: roomCount },
        },
        orderBy: { received_at: 'desc' },
      }),
      (this.prisma as any).staah_rateplan.findMany({
        where: { staah_property_id: { in: propertyIds } },
      }),
      (this.prisma as any).staah_rate.findMany({
        where: {
          staah_property_id: { in: propertyIds },
          start_date: { lte: checkIn },
          end_date: { gte: checkIn },
        },
        orderBy: { received_at: 'desc' },
      }),
    ]);

    const results: HotelSearchResult[] = [];
    for (const hotel of matchingHotels) {
      const propertyId = String((hotel as any).staah_property_id || '').trim();
      const propertyInventory = (inventoryRows as any[]).filter(
        (row) => String(row.staah_property_id || '') === propertyId,
      );
      if (!propertyInventory.length) continue;

      for (const inventory of propertyInventory) {
        const roomId = String((inventory as any).room_id || '').trim();
        if (!roomId) continue;

        const matchingPlans = (ratePlanRows as any[]).filter(
          (row) =>
            String(row.staah_property_id || '') === propertyId &&
            String(row.room_id || '') === roomId,
        );
        for (const plan of matchingPlans) {
          const rate = (rateRows as any[]).find(
            (row) =>
              String(row.staah_property_id || '') === propertyId &&
              String(row.room_id || '') === roomId &&
              String(row.rateplan_id || '') === String((plan as any).rateplan_id || ''),
          );
          if (!rate) continue;

          const price = this.extractAxisRate((rate as any).occupancy_rates);
          if (!price) continue;

          const ratePlanName = String((plan as any).rateplan_name || '').trim();
          const mealPlanDescription = String((plan as any).meal_plan_description || ratePlanName || '').trim();
          const ratePlanId = String((plan as any).rateplan_id || '').trim();
          const optionId = `STAAH-${propertyId}-${roomId}-${ratePlanId}-${String(criteria.checkInDate).slice(0, 10).replace(/-/g, '')}`;

          results.push({
            provider: 'staah',
            providerDisplayName: 'STAAH',
            canonicalHotelId: Number((hotel as any).hotel_id || 0) || null,
            providerHotelCode: propertyId,
            rateOptionId: optionId,
            roomId,
            rateId: ratePlanId,
            hotelCode: String((hotel as any).hotel_id || ''),
            hotelName: String((hotel as any).hotel_name || 'Hotel'),
            cityCode: String(criteria.cityCode || ''),
            address: String((hotel as any).hotel_address || ''),
            rating: Number((hotel as any).hotel_category || 0),
            facilities: [],
            amenities: [],
            inclusions: [],
            rateConditions: [],
            images: [],
            price,
            netAmount: price,
            totalFare: price,
            currency: 'INR',
            roomType: roomId,
            mealPlan: mealPlanDescription || '-',
            roomTypes: [{
              roomCode: roomId,
              roomName: roomId,
              bedType: '',
              capacity: 0,
              price,
              cancellationPolicy: '',
            }],
            searchReference: optionId,
            bookingCode: optionId,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            pricePerNight: price,
            totalStayPrice: price,
            numberOfNights: 1,
            bookingMode: 'LIVE_API',
            priceSource: 'LIVE_API',
            availabilityStatus: 'LIVE_AVAILABLE',
            isLiveRate: true,
            isLiveBookable: true,
            isSelectable: true,
            requiresHotelApproval: false,
            approvalStatus: 'NOT_REQUIRED',
            manualConfirmationStatus: 'NOT_STARTED',
          });
        }
      }
    }

    return results;
  }

  private filterHotelsByName(
    hotels: HotelSearchResult[],
    hotelName?: string,
  ): HotelSearchResult[] {
    const query = String(hotelName || '').trim().toLowerCase();
    if (!query) {
      return hotels;
    }

    return hotels.filter((hotel) => {
      const name = String(hotel.hotelName || '').trim().toLowerCase();
      const address = String(hotel.address || '').trim().toLowerCase();
      const roomType = String(hotel.roomType || '').trim().toLowerCase();
      return name.includes(query) || address.includes(query) || roomType.includes(query);
    });
  }

  private extractAxisRate(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    if (!value || typeof value !== 'object') return 0;
    for (const candidate of Object.values(value as Record<string, unknown>)) {
      const rate = this.extractAxisRate(candidate);
      if (rate > 0) return rate;
    }
    return 0;
  }

  private async executeProviderSearch(
    provider: IHotelProvider,
    criteria: HotelSearchCriteria,
    preferences?: HotelPreferences,
  ): Promise<HotelSearchResult[]> {
    try {
 this.logger.log(` [${provider.getName()}] Starting search...`);
 this.logger.log(` [${provider.getName()}] Criteria: ${JSON.stringify(criteria)}`);
      const results = await provider.search(criteria, preferences);
 this.logger.log(` [${provider.getName()}] Found ${results.length} hotels`);
      if (results.length === 0) {
 this.logger.warn(` [${provider.getName()}] Returned empty array!`);
      }
      return results;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'No stack';
 this.logger.error(
        `   ❌ [${provider.getName()}] Search failed: ${errorMsg}`,
      );
 this.logger.error(` Stack: ${errorStack}`);
 // Return empty array instead of failing entire search
      return [];
    }
  }

  private deduplicateHotels(hotels: HotelSearchResult[]): HotelSearchResult[] {
 // Don't deduplicate - keep ALL room types for price tier generation
 // Each room type should be treated as a separate pricing option
 // for the tier generation algorithm
 this.logger.log(`Keeping all ${hotels.length} room types (no deduplication) for price tier diversity`);
    return hotels;
  }

  private rankHotels(
    hotels: HotelSearchResult[],
    preferences?: HotelPreferences,
  ): HotelSearchResult[] {
    return hotels.sort((a, b) => {
 // Priority 1: Rating (if preference set)
      if (preferences?.minRating) {
        const aRatingMatch = a.rating >= preferences.minRating ? 1 : 0;
        const bRatingMatch = b.rating >= preferences.minRating ? 1 : 0;
        if (aRatingMatch !== bRatingMatch) {
          return bRatingMatch - aRatingMatch;
        }
      }

 // Priority 2: Price (ascending)
      if (a.price !== b.price) {
        return a.price - b.price;
      }

 // Priority 3: Rating (descending)
      return b.rating - a.rating;
    });
  }

  private deriveOccupancies(
    roomCount: number,
    adultCount: number,
    childCount: number,
    childAges?: number[],
  ): Array<{ adults: number; children: number; childrenAges?: number[] }> {
 // Validate that even distribution across rooms won't exceed TBO limits
    const maxAdultsInAnyRoom = Math.ceil(adultCount / roomCount);
    const maxChildrenInAnyRoom = Math.ceil(childCount / roomCount);

    if (maxAdultsInAnyRoom > HotelSearchService.MAX_ADULTS_PER_ROOM) {
      throw new BadRequestException(
        `Cannot distribute ${adultCount} adults across ${roomCount} room(s). ` +
        `Minimum ${maxAdultsInAnyRoom} adults per room exceeds TBO limit of ${HotelSearchService.MAX_ADULTS_PER_ROOM}.`,
      );
    }

    if (maxChildrenInAnyRoom > HotelSearchService.MAX_CHILDREN_PER_ROOM) {
      throw new BadRequestException(
        `Cannot distribute ${childCount} children across ${roomCount} room(s). ` +
        `Minimum ${maxChildrenInAnyRoom} children per room exceeds TBO limit of ${HotelSearchService.MAX_CHILDREN_PER_ROOM}.`,
      );
    }

 // Distribute guests evenly across rooms
    const occupancies: Array<{ adults: number; children: number; childrenAges?: number[] }> = [];
    let remainingAdults = adultCount;
    let remainingChildren = childCount;
    let childAgeIndex = 0;

    for (let i = 0; i < roomCount; i++) {
      const roomsLeft = roomCount - i;
      const adultsInThisRoom = Math.ceil(remainingAdults / roomsLeft);
      const childrenInThisRoom = Math.ceil(remainingChildren / roomsLeft);

      const roomChildAges = (childAges || []).slice(childAgeIndex, childAgeIndex + childrenInThisRoom);

      occupancies.push({
        adults: adultsInThisRoom,
        children: childrenInThisRoom,
        childrenAges: roomChildAges.length > 0 ? roomChildAges : undefined,
      });

      remainingAdults -= adultsInThisRoom;
      remainingChildren -= childrenInThisRoom;
      childAgeIndex += childrenInThisRoom;
    }

    return occupancies;
  }

  private normalizeChildAges(childCount: number, childAges: number[]): number[] {
    if (childCount <= 0) {
      return [];
    }

    const sanitized = (childAges || [])
      .map((age) => Math.trunc(Number(age)))
      .filter((age) => Number.isFinite(age))
      .map((age) => Math.max(0, Math.min(11, age)));

    if (sanitized.length > childCount) {
 this.logger.warn(
        `Received ${sanitized.length} child ages for childCount ${childCount}; trimming extras.`,
      );
      return sanitized.slice(0, childCount);
    }

    if (sanitized.length < childCount) {
      const missing = childCount - sanitized.length;
 this.logger.warn(
        `Received ${sanitized.length} child ages for childCount ${childCount}; padding ${missing} age(s) with default ${HotelSearchService.DEFAULT_CHILD_AGE}.`,
      );
      return [
        ...sanitized,
        ...Array.from({ length: missing }, () => HotelSearchService.DEFAULT_CHILD_AGE),
      ];
    }

    return sanitized;
  }

  private validateOccupancies(
    roomCount: number,
    guestCount: number,
    occupancies?: Array<{ adults: number; children: number; childrenAges?: number[] }>,
  ): void {
    if (!occupancies || occupancies.length === 0) {
      throw new BadRequestException(
        'Occupancies must be provided and non-empty. This indicates a missing derivation from adultCount/childCount.',
      );
    }

    if (occupancies.length !== roomCount) {
      throw new BadRequestException(
        `occupancies length (${occupancies.length}) must match roomCount (${roomCount})`,
      );
    }

    let totalGuestsFromOccupancy = 0;
    for (let i = 0; i < occupancies.length; i++) {
      const occ = occupancies[i];
      const childrenAges = occ.childrenAges || [];
      totalGuestsFromOccupancy += occ.adults + occ.children;

      if (occ.adults > HotelSearchService.MAX_ADULTS_PER_ROOM) {
        throw new BadRequestException(
          `occupancies[${i}].adults cannot exceed ${HotelSearchService.MAX_ADULTS_PER_ROOM}`,
        );
      }

      if (occ.children > HotelSearchService.MAX_CHILDREN_PER_ROOM) {
        throw new BadRequestException(
          `occupancies[${i}].children cannot exceed ${HotelSearchService.MAX_CHILDREN_PER_ROOM}`,
        );
      }

      if (occ.children > 0 && childrenAges.length === 0) {
        throw new BadRequestException(
          `occupancies[${i}].childrenAges is required when children > 0`,
        );
      }

      if (childrenAges.length !== occ.children) {
        throw new BadRequestException(
          `occupancies[${i}].childrenAges length must equal children count`,
        );
      }

      const hasInvalidAge = childrenAges.some((age) => age < 0 || age > 11);
      if (hasInvalidAge) {
        throw new BadRequestException(
          `occupancies[${i}].childrenAges must be between 0 and 11`,
        );
      }
    }

    if (totalGuestsFromOccupancy !== guestCount) {
      throw new BadRequestException(
        `guestCount (${guestCount}) does not match occupancies total (${totalGuestsFromOccupancy})`,
      );
    }
  }
}
