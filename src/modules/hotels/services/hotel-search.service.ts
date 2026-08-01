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
            adultCount: searchCriteria.adultCount,
            childCount: searchCriteria.childCount,
            childAges: searchCriteria.childAges,
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
            occupancies: normalizedOccupancies,
          },
          searchCriteria.preferences,
        ),
      );

      const results = await Promise.all(searchPromises);
      const allHotels = results.flat();

      if (allHotels.length === 0) {
 this.logger.warn(` No hotels found for the given criteria`);
 this.logger.log(` Total Time: ${Date.now() - startTime}ms`);
        return [];
      }

 this.logger.log(` Found ${allHotels.length} hotels across all providers`);
 this.logger.log(` Provider Search Time: ${Date.now() - startTime}ms`);

 // Deduplicate and rank hotels
      const uniqueHotels = this.deduplicateHotels(allHotels);
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
    const checkIn = new Date(`${String(criteria.checkInDate).slice(0, 10)}T00:00:00.000Z`);
    const requiredRoomCount = Math.max(Number(criteria.roomCount || 1), 1);
    const hotels = await (this.prisma as any).dvi_hotel.findMany({
      where: { axisrooms_enabled: 1, status: 1, OR: [{ deleted: false }, { deleted: null }] },
      select: { hotel_id: true, hotel_name: true, hotel_city: true, hotel_address: true, hotel_category: true, axisrooms_property_id: true },
    });
    const matching = hotels.filter((hotel: any) => String(hotel.hotel_city || '').trim().toLowerCase() === cityToken || String(hotel.hotel_id) === cityToken);
    const results: HotelSearchResult[] = [];
    for (const hotel of matching) {
      const availability = await (this.prisma as any).dvi_hotel_room_availability.findMany({
        where: { hotel_id: hotel.hotel_id, start_date: { lte: checkIn }, end_date: { gte: checkIn } },
        select: { room_id: true, free: true, start_date: true, end_date: true, received_at: true },
      });
      const effectiveAvailability = new Map<string, any>();
      for (const row of availability) {
        const startTime = new Date(row.start_date).getTime();
        const endTime = new Date(row.end_date).getTime();
        const rangeDays = Math.max(0, Math.round((endTime - startTime) / 86_400_000));
        const key = String(row.room_id);
        const current = effectiveAvailability.get(key);
        const currentRangeDays = current
          ? Math.max(0, Math.round((new Date(current.end_date).getTime() - new Date(current.start_date).getTime()) / 86_400_000))
          : Number.MAX_SAFE_INTEGER;
        const receivedAt = new Date(row.received_at).getTime();
        const currentReceivedAt = current ? new Date(current.received_at).getTime() : Number.NaN;
        if (!current || rangeDays < currentRangeDays || (rangeDays === currentRangeDays && receivedAt > currentReceivedAt)) {
          effectiveAvailability.set(key, row);
        }
      }
      const eligibleAvailability = Array.from(effectiveAvailability.values()).filter(
        (row: any) => Number(row.free || 0) >= requiredRoomCount,
      );
      if (!eligibleAvailability.length) continue;
      const roomIds = eligibleAvailability.map((row: any) => Number(row.room_id)).filter((id: number) => id > 0);
      const plans = await (this.prisma as any).dvi_hotel_room_rate_plan.findMany({ where: { hotel_id: hotel.hotel_id, room_id: { in: roomIds }, axisrooms_room_id: { not: null }, status: 1, deleted: 0 }, select: { room_id: true, rateplan_id: true, meal_plan_description: true } });
      if (!plans.length) continue;
      const occupancyRows = await (this.prisma as any).dvi_hotel_occupancy_rate.findMany({ where: { hotel_id: hotel.hotel_id, room_id: { in: roomIds }, start_date: { lte: checkIn }, end_date: { gte: checkIn } }, select: { room_id: true, rateplan_id: true, occupancy_rates: true, start_date: true, end_date: true, received_at: true } });
      const effectiveOccupancy = new Map<string, any>();
      for (const row of occupancyRows) {
        const startTime = new Date(row.start_date).getTime();
        const endTime = new Date(row.end_date).getTime();
        const rangeDays = Math.max(0, Math.round((endTime - startTime) / 86_400_000));
        const key = `${row.room_id}|${row.rateplan_id}`;
        const current = effectiveOccupancy.get(key);
        const currentRangeDays = current
          ? Math.max(0, Math.round((new Date(current.end_date).getTime() - new Date(current.start_date).getTime()) / 86_400_000))
          : Number.MAX_SAFE_INTEGER;
        const receivedAt = new Date(row.received_at).getTime();
        const currentReceivedAt = current ? new Date(current.received_at).getTime() : Number.NaN;
        if (!current || rangeDays < currentRangeDays || (rangeDays === currentRangeDays && receivedAt > currentReceivedAt)) {
          effectiveOccupancy.set(key, row);
        }
      }
      const occupancy = Array.from(effectiveOccupancy.values());
      const plan = plans.find((candidate: any) => occupancy.some((row: any) => String(row.room_id) === String(candidate.room_id) && String(row.rateplan_id) === String(candidate.rateplan_id)));
      const rateRow = plan ? occupancy.find((row: any) => String(row.room_id) === String(plan.room_id) && String(row.rateplan_id) === String(plan.rateplan_id)) : null;
      const rate = this.extractAxisRate(rateRow?.occupancy_rates);
      if (!plan || !rate) continue;
      const room = await (this.prisma as any).dvi_hotel_rooms.findFirst({ where: { room_ID: plan.room_id, deleted: 0 }, select: { room_title: true } });
      const optionId = `axisrooms:${hotel.hotel_id}:${plan.room_id}:${plan.rateplan_id}:${String(criteria.checkInDate).slice(0, 10)}`;
      results.push({
        provider: 'axisrooms', providerDisplayName: 'AxisRooms', canonicalHotelId: Number(hotel.hotel_id), providerHotelCode: String(hotel.axisrooms_property_id || hotel.hotel_id), rateOptionId: optionId,
        hotelCode: String(hotel.hotel_id), hotelName: String(hotel.hotel_name || 'Hotel'), cityCode: String(hotel.hotel_city || criteria.cityCode), address: String(hotel.hotel_address || ''), rating: Number(hotel.hotel_category || 0), facilities: [], amenities: [], inclusions: [], rateConditions: [], cancellationPolicy: [], images: [], price: rate, currency: 'INR', roomTypes: [{ roomCode: String(plan.room_id), roomName: String(room?.room_title || 'Room'), bedType: '', capacity: 0, price: rate, cancellationPolicy: '' }], roomType: String(room?.room_title || 'Room'), mealPlan: String(plan.meal_plan_description || '-'), searchReference: optionId, expiresAt: new Date(Date.now() + 15 * 60 * 1000), pricePerNight: rate, bookingMode: 'LIVE_API', priceSource: 'DATABASE', availabilityStatus: 'AVAILABLE', isLiveRate: false, isLiveBookable: true, isSelectable: true, requiresHotelApproval: false, approvalStatus: 'NOT_REQUIRED', manualConfirmationStatus: 'NOT_STARTED',
      });
    }
    return results;
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
