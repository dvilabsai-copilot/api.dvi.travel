import { Injectable, InternalServerErrorException, Logger, Inject } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { HotelAvailabilityTimingLogger } from '../../itineraries/services/hotel-availability-timing.logger';
import { PrismaService } from '../../../prisma.service';
import {
  IHotelProvider,
  HotelSearchResult,
  RoomType,
  HotelSearchCriteria,
  HotelPreferences,
  HotelConfirmationDTO,
  HotelConfirmationResult,
  HotelConfirmationDetails,
  CancellationResult,
} from '../interfaces/hotel-provider.interface';
import { resolveProviderPassengerTitle } from '../../../common/utils/passenger-title.util';
import { SupplementNormalizerService } from '../services/supplement-normalizer.service';
import {
  inferCanonicalHotelRatePlanCodeFromMealText,
  getNormalizedMealPlanLabelFromMealText,
} from '../hotel-rate-plans';
import { resolveCityRecordByName } from '../../itineraries/utils/city-normalization.util';

type TboHotelMixSegment =
  | 'economy'
  | 'threeStar'
  | 'fourStar'
  | 'fiveStar';

type TboHotelCodeCandidate = {
  hotelCode: string;
  starRating: number;
  isPriority: boolean;
};

@Injectable()
export class TBOHotelProvider implements IHotelProvider {
 // TBO API Constraints - Certification Required
  private static readonly MAX_ROOMS = 6;
  private static readonly MAX_ADULTS_PER_ROOM = 8;
  private static readonly MAX_CHILDREN_PER_ROOM = 4;
  private static readonly DEFAULT_MIXED_HOTEL_LIMIT = 100;
  private static readonly MAX_MIXED_HOTEL_LIMIT = 500;
  private static readonly HOTEL_MIX_PERCENTAGES = {
    economy: 20,
    threeStar: 50,
    fourStar: 20,
    fiveStar: 10,
  } as const;

 // Production API Endpoints from Postman Collection
 private readonly SEARCH_API_URL = process.env.TBO_SEARCH_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI';
 private readonly BOOKING_API_URL = process.env.TBO_BOOKING_API_URL || 'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10';
  private readonly SHARED_API_URL =
    process.env.TBO_SHARED_API_URL ||
    process.env.TBO_AUTH_BASE_URL ||
 'https://api.travelboutiqueonline.com/SharedAPI';
 private readonly TBO_STATIC_API_URL = process.env.TBO_STATIC_API_URL || 'http://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI';
  private readonly TBO_STATIC_USERNAME = process.env.TBO_STATIC_USERNAME || process.env.TBO_USERNAME || 'IXMD112';
  private readonly TBO_STATIC_PASSWORD = process.env.TBO_STATIC_PASSWORD || process.env.TBO_PASSWORD || 'api-11#M$new';
  private readonly SEARCH_USERNAME = process.env.TBO_SEARCH_USERNAME || process.env.TBO_API_USERNAME || process.env.TBO_USERNAME || 'IXMD112';
  private readonly SEARCH_PASSWORD = process.env.TBO_SEARCH_PASSWORD || process.env.TBO_API_PASSWORD || process.env.TBO_PASSWORD || 'api-11#M$new';
  /** Maximum time allowed for one TBO hotel availability Search request. */
  private readonly SEARCH_TIMEOUT_MS = (() => {
    const configured = Number(process.env.TBO_SEARCH_TIMEOUT_MS || 5000);
    return Number.isFinite(configured) && configured > 0 ? configured : 5000;
  })();

 // Real Production Credentials (From Postman - Verified Working)
  private readonly USERNAME = process.env.TBO_API_USERNAME || process.env.TBO_USERNAME || 'IXMD112';
  private readonly PASSWORD = process.env.TBO_API_PASSWORD || process.env.TBO_PASSWORD || 'api-11#M$new';

  private logger = new Logger(TBOHotelProvider.name);
  private readonly verboseHotelLookupLogs =
    (process.env.TBO_VERBOSE_HOTEL_LOOKUP_LOGS || 'false').toLowerCase() === 'true';
  private tokenId: string | null = null;
  private tokenExpiry: Date | null = null;
  private http: AxiosInstance = axios;

  /** Persist raw supplier responses for traceability; never include auth headers. */
  private async persistRawSearchResponse(metadata: Record<string, unknown>, responseData: unknown): Promise<void> {
    const enabled = String(process.env.TBO_RAW_RESPONSE_LOG || 'true').trim().toLowerCase() !== 'false';
    if (!enabled) return;

    try {
      const directory = process.env.TBO_RAW_RESPONSE_LOG_DIR
        ? join(process.cwd(), process.env.TBO_RAW_RESPONSE_LOG_DIR)
        : join(process.cwd(), 'logs', 'tbo-raw');
      await fs.mkdir(directory, { recursive: true });
      const filePath = join(directory, `tbo-search-${new Date().toISOString().slice(0, 10)}.jsonl`);
      await fs.appendFile(
        filePath,
        `${JSON.stringify({ capturedAt: new Date().toISOString(), ...metadata, response: responseData })}\n`,
        'utf8',
      );
      this.logger.log(` TBO raw response persisted: ${filePath}`);
    } catch (error: any) {
      this.logger.warn(` TBO raw response persistence failed: ${error?.message || String(error)}`);
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly supplementNormalizer: SupplementNormalizerService,
  ) {
    if (!prisma) {
 this.logger.error(' PrismaService is NULL/UNDEFINED!');
    }
 this.logger.log(' TBO Hotel Provider initialized with production endpoints');
 this.logger.log(`TBO hotel search timeout: ${this.SEARCH_TIMEOUT_MS}ms`);
 this.logger.log(`Using credentials: ${this.USERNAME}`);
    if (
      (process.env.TBO_SEARCH_USERNAME && this.SEARCH_USERNAME !== this.USERNAME) ||
      (process.env.TBO_SEARCH_PASSWORD && this.SEARCH_PASSWORD !== this.PASSWORD)
    ) {
 this.logger.warn(
        '⚠️ TBO_SEARCH_* credentials differ from TBO_API/TBO credentials. Search and booking may use different accounts.',
      );
    }
  }

  getName(): string {
    return 'TBO';
  }

 /**
   * Authenticate and get TokenId from TBO API
   * Required for all hotel operations
 */
  private async authenticate(): Promise<string> {
    try {
 // Check if token is still valid
      if (this.tokenId && this.tokenExpiry && new Date() < this.tokenExpiry) {
 this.logger.debug(' Using cached TBO TokenId');
        return this.tokenId;
      }

 this.logger.log(` TBO Authentication Request:`);
 this.logger.log(` - Endpoint: POST ${this.SHARED_API_URL}/SharedData.svc/rest/Authenticate`);
 this.logger.log(` - Username: ${this.USERNAME}`);

      const authRequest = {
        ClientId: process.env.TBO_CLIENT_ID || 'tboprod',
        UserName: this.USERNAME,
        Password: this.PASSWORD,
        EndUserIp: process.env.TBO_END_USER_IP || '134.209.145.185',
      };

      const authStartTime = Date.now();
      const response = await this.http.post(
        `${this.SHARED_API_URL}/SharedData.svc/rest/Authenticate`,
        authRequest,
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const authTime = Date.now() - authStartTime;
      this.logger.log(` TBO Auth Response Time: ${authTime}ms`);
      this.logger.debug(` TBO Auth Status: ${response.data?.Status ?? 'unknown'}`);

 // TBO API returns Status: 1 for success, not Status.Code
      const status = response.data?.Status;
      if (status !== 1) {
        const errorMsg = response.data?.Error?.ErrorMessage || `Status ${status}`;
        throw new Error(`Authentication failed: ${errorMsg}`);
      }

      if (!response.data?.TokenId) {
        throw new Error('Authentication failed: No TokenId in response');
      }

      this.tokenId = response.data.TokenId;
 // Token valid for 24 hours, but we'll refresh every 12 hours
      this.tokenExpiry = new Date(Date.now() + 12 * 60 * 60 * 1000);

 this.logger.log(` TBO Authentication successful - TokenId: ${this.tokenId.substring(0, 8)}...`);
      return this.tokenId;
    } catch (error) {
 this.logger.error(` TBO Authentication Error: ${error.message}`);
 this.logger.error(` Error Details: ${JSON.stringify(error.response?.data || error)}`);
      throw new InternalServerErrorException(
        `TBO Authentication failed: ${error.message || 'Unknown error'}`
      );
    }
  }

  async search(
    criteria: HotelSearchCriteria,
    preferences?: HotelPreferences,
  ): Promise<HotelSearchResult[]> {
    const startTime = Date.now();
    if (!this.prisma) {
 this.logger.error(' this.prisma is NULL/UNDEFINED in search method!');
      throw new Error('PrismaService not injected');
    }
    try {
 this.logger.log(`\n TBO PROVIDER: Starting hotel search for city: ${criteria.cityCode}`);

 // Step 1: Resolve TBO city code from existing schema fields.
 // Supports: direct TBO city code, dvi_cities.id, and fallback via dvi_hotel.tbo_city_code.
      const resolvedCity = await this.resolveTboCityCode(criteria.cityCode);
      if (!resolvedCity?.tboCityCode) {
        throw new Error(
          `Unable to resolve TBO city code for input: ${criteria.cityCode}. ` +
          `Ensure dvi_cities.tbo_city_code or dvi_hotel.tbo_city_code is populated.`
        );
      }

      const resolvedTboCityCode = resolvedCity.tboCityCode;
 this.logger.log(
        `   🗺️  City Mapping: input ${criteria.cityCode} → TBO ${resolvedTboCityCode}` +
        `${resolvedCity.source ? ` (source: ${resolvedCity.source})` : ''}`
      );

      // Ensure DB has city/hotel master data for this TBO city before searching.
      await this.ensureCityAndHotelsInDb(criteria.cityCode, resolvedTboCityCode);

      const selectedStarRatings = Array.from(
        new Set(
          (preferences?.starRatings || [])
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5),
        ),
      ).sort((a, b) => a - b);

 // Step 2: Get hotel codes from TBO SharedData API or master database
 // Instead of hardcoding, fetch from TBO's master hotel list
      let hotelCodes: string | undefined;
      let isUsingDatabaseCodes = false;

      if (criteria.hotelCodes) {
 // If explicitly provided (for testing), use it
        hotelCodes = criteria.hotelCodes;
 this.logger.log(` Using provided hotel codes: ${hotelCodes}`);
      } else {
 // Query database for hotel codes from tbo_hotel_master table
 // This table is synced daily from TBO's GetHotels API via cron/scheduler
        hotelCodes = await this.getHotelCodesForCityFromDb(
          resolvedTboCityCode,
          selectedStarRatings,
        );
        if (!hotelCodes) {
 this.logger.warn(` No hotel codes in database for city ${resolvedTboCityCode} - trying static TBOHotelCodeList fallback`);
          hotelCodes = await this.fetchHotelCodesFromStaticApi(resolvedTboCityCode);

          if (!hotelCodes) {
 this.logger.error(
              `   ❌ No hotel codes available for city ${resolvedTboCityCode} from DB or static API. ` +
              `Skipping Search call because TBO requires HotelCodes.`
            );
            return [];
          }

 this.logger.log(` Fallback fetched ${hotelCodes.split(',').length} hotel codes from static API`);
        } else {
          isUsingDatabaseCodes = true;
 this.logger.log(` Fetched ${hotelCodes.split(',').length} hotel codes from database`);
        }
      }

 // CRITICAL FIX: If using database codes, verify they look like valid TBO codes
 // Real TBO codes are 7 digits starting with 10 (e.g., 1014829, 1089687, 1138045)
 // Note: All hotel codes in database are synced from TBO API, so they're already valid
      if (isUsingDatabaseCodes && hotelCodes) {
 this.logger.log(` Using ${hotelCodes.split(',').length} hotel codes from database`);
      }

 // Step 3: Chunk hotel codes (TBO recommends 100 codes per request)
 // Per TBO API docs: "send parallel searches for 100 hotel codes chunks"
      const hotelCodeChunks = this.chunkHotelCodes(hotelCodes, 100);

      if (hotelCodeChunks.length > 0) {
 this.logger.log(` Split ${hotelCodes?.split(',').length || 0} hotels into ${hotelCodeChunks.length} chunk(s) of max 100 codes`);
      }

 // If no hotel codes, search by city only (one request)
      const requestChunks = hotelCodeChunks.length > 0 ? hotelCodeChunks : [''];
      const paxRooms = this.buildSearchPaxRooms(criteria);
      const guestNationality = this.normalizeNationality(criteria.guestNationality);
      const selectedMealPlanCode = String(preferences?.mealPlanCode || '').trim().toUpperCase();
      const selectedTboMealType = String(preferences?.tboMealType || '').trim();
      const tboStarRatingFilter = selectedStarRatings.length === 1 ? selectedStarRatings[0] : 0;
      if (selectedStarRatings.length > 0) {
 this.logger.log(
          `   ⭐ Star filter requested: [${selectedStarRatings.join(', ')}] (TBO request StarRating=${tboStarRatingFilter})`,
        );
      }
 // Certification flow expects NoOfRooms=0 in search to fetch all available room options.
      const noOfRooms = 0;

 // Step 4: Make parallel searches for each chunk
      const basicAuth = Buffer.from(`${this.SEARCH_USERNAME}:${this.SEARCH_PASSWORD}`).toString('base64');
      const chunkPromises = requestChunks.map((chunk) =>
        this.executeTBOSearch(
          {
            CheckIn: this.formatDateToISO(criteria.checkInDate),
            CheckOut: this.formatDateToISO(criteria.checkOutDate),
            HotelCodes: chunk,
            CityCode: resolvedTboCityCode,
            GuestNationality: guestNationality,
            PaxRooms: paxRooms,
            ResponseTime: 23.0,
            IsDetailedResponse: true,
            Filters: {
              Refundable: false,
              NoOfRooms: noOfRooms,
              MealType: selectedTboMealType,
              OrderBy: 0,
              StarRating: tboStarRatingFilter,
              HotelName: null,
            },
          },
          basicAuth,
          chunk ? `(chunk: ${chunk.split(',').length} hotels)` : '(city-wide search)'
        )
      );

      const chunkResponses = await Promise.all(chunkPromises);
      const allHotels = chunkResponses.flat();

      if (allHotels.length === 0) {
 this.logger.warn(` No hotels found for city: ${criteria.cityCode}`);
        return [];
      }

      const hotels = allHotels;
 this.logger.log(` TBO API returned ${hotels.length} hotels across ${requestChunks.length} request(s)`);

      if (hotels.length === 0) {
 this.logger.warn(` No hotels found for city: ${criteria.cityCode}`);
        return [];
      }

 // Step 7: Transform to standard format
 // TBO returns rooms within hotels, we need to flatten and deduplicate
 const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min validity

      const results: HotelSearchResult[] = [];

      for (const hotel of hotels) {
 // Fetch actual hotel name from database (synced from TBO GetHotels API)
        const hotelMasterData = await this.getHotelMasterDataFromDb(hotel.HotelCode, resolvedTboCityCode);
        const hotelRating = Number(hotelMasterData?.star_rating || 0);
        if (selectedStarRatings.length > 0 && !selectedStarRatings.includes(hotelRating)) {
          continue;
        }
        const hotelDisplayName = hotelMasterData?.hotel_name ?? `Hotel ${hotel.HotelCode}`;

 // Process each room as a separate offering with the SAME real hotel name
 // (One HotelCode = One real hotel, not fake variants)
        for (let idx = 0; idx < (hotel.Rooms || []).length; idx++) {
          const room = hotel.Rooms[idx];
          const inferredMealPlanCode = inferCanonicalHotelRatePlanCodeFromMealText(room.Inclusion);
          if (selectedMealPlanCode && inferredMealPlanCode !== selectedMealPlanCode) {
            continue;
          }
          const netAmount = room.NetAmount || room.TotalFare || room.DayRates?.[0]?.[0]?.BasePrice || 0;
          const totalFare = room.TotalFare || room.NetAmount || room.DayRates?.[0]?.[0]?.BasePrice || 0;
          const formattedNetAmount = parseFloat(netAmount.toString());
          const formattedTotalFare = parseFloat(totalFare.toString());
          const roomName = room.Name?.[0] || 'Standard Room';
          const inclusionText = String(room.Inclusion || '').trim();
          const inclusions = inclusionText
            ? inclusionText
                .split(',')
                .map((item: string) => item.trim())
                .filter(Boolean)
            : [];
          const rateConditions = Array.isArray(room.RateConditions)
            ? room.RateConditions
            : room.RateConditions
              ? [room.RateConditions]
              : [];
          const amenities = Array.isArray(room.Amenities)
            ? room.Amenities.map((item: any) => String(item).trim()).filter(Boolean)
            : [];

 // Use REAL BookingCode from TBO Search API response (not generated)
          const realBookingCode = room.BookingCode || `${hotel.HotelCode}_${room.TBORoomID}`;
          const tboBookingParts = String(realBookingCode).split('!TB!');
          const selectionKey = tboBookingParts.length >= 2
            ? `tbo:${String(hotel.HotelCode || '')}:${tboBookingParts[1]}`
            : `tbo:${String(hotel.HotelCode || '')}:${String(room.TBORoomID || idx + 1)}`;

 // Extract and normalize supplements from search response
          const rawSupplements = room.Supplements || [];
          const supplementSummary = this.supplementNormalizer.createSupplementSummary(
            rawSupplements,
            'search',
          );

 // Build room type with supplement details
          const roomTypeObj: RoomType = {
            roomCode: realBookingCode,
            roomName: roomName,
            bedType: roomName.includes('King') ? 'King' : 'Twin',
            capacity: 2,
            price: formattedNetAmount,
            cancellationPolicy: room.CancelPolicies?.[0]?.ChargeType || 'Non-refundable',
 // Add supplements to room type
            supplements: rawSupplements.length > 0 ? rawSupplements : undefined,
          };

 this.logger.log(
            `   TBO search price formatting: hotel=${hotel.HotelCode} room="${roomName}" bookingCode=${realBookingCode} rawNetAmount=${room.NetAmount ?? 'null'} rawTotalFare=${room.TotalFare ?? 'null'} rawBasePrice=${room.DayRates?.[0]?.[0]?.BasePrice ?? 'null'} formattedPrice=${formattedNetAmount} formattedNetAmount=${formattedNetAmount} formattedTotalFare=${formattedTotalFare}`,
          );

          results.push({
            provider: 'tbo',
            providerDisplayName: 'VSR',
            hotelCode: hotel.HotelCode,
            providerHotelCode: String(hotel.HotelCode || ''),
            selectionKey,
 hotelName: hotelDisplayName, // Real hotel name from database
            cityCode: criteria.cityCode,
            address: hotelMasterData?.hotel_address ?? '',
            latitude:
              hotelMasterData?.hotel_latitude ??
              (hotel?.Latitude != null ? String(hotel.Latitude).trim() : null),
            longitude:
              hotelMasterData?.hotel_longitude ??
              (hotel?.Longitude != null ? String(hotel.Longitude).trim() : null),
            rating: hotelRating,
            category: hotelMasterData?.star_rating ? `${hotelMasterData.star_rating}-Star` : '-',
            facilities: Array.from(new Set([...inclusions, ...amenities])),
            amenities,
            inclusions,
            rateConditions,
            images: [],
            price: formattedNetAmount,
            netAmount: formattedNetAmount,
            totalFare: formattedTotalFare,
            currency: hotel.Currency || 'INR',
 roomType: roomName, // Room type name for display
            // Prefer TBO's structured MealType. Inclusion may contain only
            // parking/wifi text, which cannot identify Room_Only as EP.
            mealPlan: getNormalizedMealPlanLabelFromMealText(
              room.MealType || room.Inclusion,
            ),
            roomTypes: [roomTypeObj],
 // Use REAL BookingCode from TBO as searchReference
            searchReference: realBookingCode,
            // TBO search returned a real BookingCode and positive fare. Treat
            // that normalized rate as live/selectable; leaving these fields
            // undefined makes the recommendation engine reject it as an
            // unverifiable live rate before selection.
            isLiveRate: true,
            isLiveBookable: Boolean(realBookingCode && formattedTotalFare > 0),
            isBookable: Boolean(realBookingCode && formattedTotalFare > 0),
            isSelectable: Boolean(realBookingCode && formattedTotalFare > 0),
            availabilityStatus: realBookingCode && formattedTotalFare > 0 ? 'LIVE_AVAILABLE' : 'NO_AVAILABILITY',
            expiresAt: expiresAt,
 // Add hotel-level supplement summary
            supplementSummary: {
              hasSupplements: supplementSummary.rawSupplements.length > 0,
              supplementCount: supplementSummary.normalizedSupplements.length,
              atPropertyChargeCount: supplementSummary.atPropertyCharges.length,
              requiresReview:
                supplementSummary.unknownTypeCharges.length > 0 ||
                supplementSummary.mandatoryChargesCount > 0,
            },
          });
        }
      }

 this.logger.log(` Successfully transformed ${results.length} hotels`);
 this.logger.debug(` Hotel search output size: ${results.length}`);

      return results;
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.error(` Hotel Search Error: ${errorMsg}`);
 this.logger.error(` Stack: ${error?.stack?.substring(0, 200)}`);

 // CRITICAL: Throw so service can distinguish provider/system failure from genuine empty result
      const { ServiceUnavailableException } = require('@nestjs/common');
      throw new ServiceUnavailableException(`VSR provider failed: ${errorMsg}`);
    }
  }

  private async resolveTboCityCode(
    cityInput?: string,
  ): Promise<{ tboCityCode: string | null; source: string | null }> {
    const normalized = (cityInput || '').toString().trim();
    if (!normalized) {
      return { tboCityCode: null, source: null };
    }

    // Itinerary destinations can be stored as descriptive strings such as
    // "Bandipur National Park, Karnataka, India", while dvi_cities stores
    // the canonical city as "Bandipur". Try the useful city portion(s) as
    // well as the original value before falling back to the supplier list.
    const cityNameCandidates = Array.from(
      new Set(
        [
          normalized,
          normalized.split(',')[0]?.trim(),
          normalized.split(',')[0]?.trim().replace(/\s+national park$/i, ''),
        ].filter(Boolean),
      ),
    );

    const aliasMap: Record<string, string> = {
      cochin: 'Kochi',
      alleppey: 'Alappuzha',
      alleppe: 'Alappuzha',
      calicut: 'Kozhikode',
      trivandrum: 'Thiruvananthapuram',
      pondicherry: 'Puducherry',
      bangalore: 'Bengaluru',
    };
    const canonicalAlias = aliasMap[normalized.toLowerCase()];

    if (canonicalAlias) {
      const aliasedCity = await this.prisma.dvi_cities.findFirst({
        where: { name: canonicalAlias, tbo_city_code: { not: null }, status: 1 },
        orderBy: { id: 'asc' },
        select: { tbo_city_code: true },
      });
      if (aliasedCity?.tbo_city_code) {
        return { tboCityCode: aliasedCity.tbo_city_code, source: `alias:${normalized}->${canonicalAlias}` };
      }

      const aliasedStatic = await this.fetchTboCityCodeFromStaticCityList(canonicalAlias);
      if (aliasedStatic) {
        return { tboCityCode: aliasedStatic, source: `static-citylist-alias:${normalized}->${canonicalAlias}` };
      }
    }

 // 1) Input is already a TBO city code present in dvi_cities.
    const directCity = await this.prisma.dvi_cities.findFirst({
      where: { tbo_city_code: normalized },
      select: { tbo_city_code: true },
    });
    if (directCity?.tbo_city_code) {
      return { tboCityCode: directCity.tbo_city_code, source: 'dvi_cities.tbo_city_code' };
    }

 // 2) Input might be dvi_cities.id.
    const parsedId = Number(normalized);
    if (!Number.isNaN(parsedId) && Number.isInteger(parsedId)) {
      const byId = await this.prisma.dvi_cities.findFirst({
        where: { id: parsedId },
        select: { tbo_city_code: true, name: true },
      });
      if (byId?.tbo_city_code) {
        return { tboCityCode: byId.tbo_city_code, source: 'dvi_cities.id' };
      }

 // ID exists but has no tbo_city_code: try static CityList using city name.
      if (byId?.name) {
        const fromStaticByIdName = await this.fetchTboCityCodeFromStaticCityList(byId.name);
        if (fromStaticByIdName) {
          return { tboCityCode: fromStaticByIdName, source: 'static-citylist-from-dvi_cities.id-name' };
        }
      }
    }

 // 3) Input might be city name in dvi_cities (case-insensitive where supported).
    for (const cityName of cityNameCandidates) {
      const byName = await this.prisma.dvi_cities.findFirst({
        where: {
          name: { equals: cityName } as any,
          tbo_city_code: { not: null },
          status: 1,
        },
        orderBy: { id: 'asc' },
        select: { tbo_city_code: true },
      });
      if (byName?.tbo_city_code) {
        return { tboCityCode: byName.tbo_city_code, source: `dvi_cities.name:${cityName}` };
      }
    }

    // 3b) Resolve by static CityList (Postman certification flow).
    for (const cityName of cityNameCandidates) {
      const fromStaticByName = await this.fetchTboCityCodeFromStaticCityList(cityName);
      if (fromStaticByName) {
        return { tboCityCode: fromStaticByName, source: `static-citylist-by-name:${cityName}` };
      }
    }

 // 4) Fallback to existing dvi_hotel.tbo_city_code usage (no schema changes).
 // If the incoming value itself appears as tbo_city_code in dvi_hotel, accept it.
    const hotelByDirectCode = await this.prisma.dvi_hotel.findFirst({
      where: {
        tbo_city_code: normalized,
        deleted: false,
      },
      select: { tbo_city_code: true },
    });
    if (hotelByDirectCode?.tbo_city_code) {
      return { tboCityCode: hotelByDirectCode.tbo_city_code, source: 'dvi_hotel.tbo_city_code-direct' };
    }

 // 5) If input is city name used in dvi_hotel.hotel_city, derive mapped tbo_city_code.
    for (const cityName of cityNameCandidates) {
      const hotelByCityName = await this.prisma.dvi_hotel.findFirst({
        where: {
          hotel_city: { equals: cityName } as any,
          tbo_city_code: { not: null },
          deleted: false,
        },
        select: { tbo_city_code: true },
        orderBy: { hotel_id: 'desc' },
      });
      if (hotelByCityName?.tbo_city_code) {
        return { tboCityCode: hotelByCityName.tbo_city_code, source: `dvi_hotel.hotel_city:${cityName}` };
      }
    }

 // 6) Last resort: treat numeric input as direct TBO code when no mapping exists locally.
    if (!Number.isNaN(parsedId) && Number.isInteger(parsedId)) {
      return { tboCityCode: normalized, source: 'input-assumed-tbo-code' };
    }

    return { tboCityCode: null, source: null };
  }

  private async fetchTboCityCodeFromStaticCityList(cityName: string): Promise<string | null> {
    try {
      const basicAuth = Buffer.from(`${this.TBO_STATIC_USERNAME}:${this.TBO_STATIC_PASSWORD}`).toString('base64');
      const response = await this.http.post(
        `${this.TBO_STATIC_API_URL}/CityList`,
        { CountryCode: 'IN' },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${basicAuth}`,
          },
        },
      );

      const cityList = response.data?.CityList;
      const cities = Array.isArray(cityList) ? cityList : cityList ? [cityList] : [];
      if (!cities.length) {
        return null;
      }

      const target = cityName.trim().toLowerCase();
      const extractName = (city: any) => {
        const raw = String(city?.CityName || city?.Name || '').trim().toLowerCase();
 // Static API names are often "City, State".
        return raw.split(',')[0].trim();
      };
      const extractCode = (city: any) => String(city?.CityCode || city?.Code || '').trim();

      const exact = cities.find((c: any) => extractName(c) === target);
      const exactCode = exact ? extractCode(exact) : '';
      if (exactCode) {
        return exactCode;
      }

      const partial = cities.find((c: any) => extractName(c).includes(target));
      const partialCode = partial ? extractCode(partial) : '';
      if (partialCode) {
        return partialCode;
      }

      return null;
    } catch (error: any) {
 this.logger.warn(` Static CityList lookup failed for ${cityName}: ${error?.message || error}`);
      return null;
    }
  }

  private async fetchCityNameFromStaticCityListByCode(tboCityCode: string): Promise<string | null> {
    try {
      const basicAuth = Buffer.from(`${this.TBO_STATIC_USERNAME}:${this.TBO_STATIC_PASSWORD}`).toString('base64');
      const response = await this.http.post(
        `${this.TBO_STATIC_API_URL}/CityList`,
        { CountryCode: 'IN' },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${basicAuth}`,
          },
        },
      );

      const cityList = response.data?.CityList;
      const cities = Array.isArray(cityList) ? cityList : cityList ? [cityList] : [];
      if (!cities.length) {
        return null;
      }

      const found = cities.find((c: any) => String(c?.CityCode || c?.Code || '').trim() === tboCityCode);
      if (!found) {
        return null;
      }

      const cityName = String(found?.CityName || found?.Name || '').trim();
      return cityName || null;
    } catch (error: any) {
 this.logger.warn(` Static CityList(by code) lookup failed for ${tboCityCode}: ${error?.message || error}`);
      return null;
    }
  }

  private parseStaticStarRating(starValue: any): number {
    const text = String(starValue || '').toLowerCase().trim();
    if (!text) return 0;

    if (text.includes('five')) return 5;
    if (text.includes('four')) return 4;
    if (text.includes('three')) return 3;
    if (text.includes('two')) return 2;
    if (text.includes('one')) return 1;

    const parsed = Number(text.replace(/[^0-9]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async resolveStoredCityValue(cityName?: string | null): Promise<{ cityId: string | null; cityName: string | null }> {
    const raw = String(cityName ?? '').trim();
    if (!raw) {
      return { cityId: null, cityName: null };
    }

    if (/^\d+$/.test(raw)) {
      return { cityId: raw, cityName: raw };
    }

    const record = await resolveCityRecordByName(this.prisma, raw);
    if (record?.id) {
      return { cityId: String(record.id), cityName: record.name || raw };
    }

    return { cityId: null, cityName: raw };
  }

  private async fetchHotelsFromStaticApi(tboCityCode: string): Promise<any[]> {
    try {
      const basicAuth = Buffer.from(`${this.TBO_STATIC_USERNAME}:${this.TBO_STATIC_PASSWORD}`).toString('base64');
      const response = await this.http.post(
        `${this.TBO_STATIC_API_URL}/TBOHotelCodeList`,
        {
          CityCode: tboCityCode,
          IsDetailedResponse: 'true',
        },
        {
          timeout: 45000,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${basicAuth}`,
          },
        },
      );

      const hotels = response.data?.Hotels;
      if (Array.isArray(hotels) && hotels.length > 0) {
        return hotels;
      }

      const codeList = response.data?.HotelCodeList;
      if (Array.isArray(codeList) && codeList.length > 0) {
        return codeList;
      }

      return [];
    } catch (error: any) {
 this.logger.warn(` Static TBOHotelCodeList failed for city ${tboCityCode}: ${error?.message || error}`);
      return [];
    }
  }

  private async ensureCityAndHotelsInDb(cityInput: string | undefined, tboCityCode: string): Promise<void> {
    try {
      const [existingCity, existingMaster, existingDviHotel] = await Promise.all([
        this.prisma.dvi_cities.findFirst({
          where: { tbo_city_code: tboCityCode },
          select: { id: true },
        }),
        this.prisma.tbo_hotel_master.findFirst({
          where: { tbo_city_code: tboCityCode, status: 1 },
          select: { id: true },
        }),
        this.prisma.dvi_hotel.findFirst({
          where: { tbo_city_code: tboCityCode, deleted: false },
          select: { hotel_id: true },
        }),
      ]);

      if (!existingCity) {
 // dvi_cities requires state_id; we only backfill mapping if city row already exists by name/id.
        await this.tryBackfillCityCodeMapping(cityInput, tboCityCode);
      }

      if (existingMaster || existingDviHotel) {
        return;
      }

      const synced = await this.syncHotelsFromStaticApiToDb(tboCityCode);
 this.logger.log(` DB backfill from TBOHotelCodeList completed for city ${tboCityCode}: ${synced} hotel(s)`);
    } catch (error: any) {
 this.logger.warn(` ensureCityAndHotelsInDb failed for ${tboCityCode}: ${error?.message || error}`);
    }
  }

  private async tryBackfillCityCodeMapping(cityInput: string | undefined, tboCityCode: string): Promise<void> {
    const normalized = (cityInput || '').toString().trim();
    if (!normalized) {
      return;
    }

    try {
      const parsedId = Number(normalized);
      if (!Number.isNaN(parsedId) && Number.isInteger(parsedId)) {
        const cityById = await this.prisma.dvi_cities.findFirst({ where: { id: parsedId } });
        if (cityById && !cityById.tbo_city_code) {
          await this.prisma.dvi_cities.update({
            where: { id: cityById.id },
            data: { tbo_city_code: tboCityCode },
          });
 this.logger.log(` Backfilled dvi_cities.id=${cityById.id} with TBO city code ${tboCityCode}`);
          return;
        }
      }

      const cityByName = await this.prisma.dvi_cities.findFirst({
        where: { name: { equals: normalized } as any },
      });
      if (cityByName && !cityByName.tbo_city_code) {
        await this.prisma.dvi_cities.update({
          where: { id: cityByName.id },
          data: { tbo_city_code: tboCityCode },
        });
 this.logger.log(` Backfilled dvi_cities.name=${normalized} with TBO city code ${tboCityCode}`);
        return;
      }

      const staticCityName = await this.fetchCityNameFromStaticCityListByCode(tboCityCode);
      if (!staticCityName) {
        return;
      }

      const dbCityByStaticName = await this.prisma.dvi_cities.findFirst({
        where: { name: { equals: staticCityName } as any },
      });
      if (dbCityByStaticName && !dbCityByStaticName.tbo_city_code) {
        await this.prisma.dvi_cities.update({
          where: { id: dbCityByStaticName.id },
          data: { tbo_city_code: tboCityCode },
        });
 this.logger.log(` Backfilled dvi_cities.name=${staticCityName} with TBO city code ${tboCityCode}`);
      }
    } catch (error: any) {
 this.logger.warn(` City backfill skipped for ${tboCityCode}: ${error?.message || error}`);
    }
  }

  private async syncHotelsFromStaticApiToDb(tboCityCode: string): Promise<number> {
    const hotels = await this.fetchHotelsFromStaticApi(tboCityCode);
    if (!hotels.length) {
      return 0;
    }

    let synced = 0;
    for (const hotel of hotels) {
      const hotelCode = String(hotel?.HotelCode || hotel?.hotelCode || '').trim();
      if (!hotelCode) {
        continue;
      }

      const hotelName = String(hotel?.HotelName || hotel?.hotelName || '').trim() || null;
      const hotelAddress = String(hotel?.Address || hotel?.hotelAddress || '').trim() || null;
      const cityName = String(hotel?.CityName || hotel?.cityName || '').trim() || null;
      const city = await this.resolveStoredCityValue(cityName);
      const rating = this.parseStaticStarRating(hotel?.HotelRating || hotel?.hotelRating);
      const latitude = String(hotel?.Latitude || '').trim() || null;
      const longitude = String(hotel?.Longitude || '').trim() || null;
      const countryName = String(hotel?.CountryName || '').trim() || null;

      await this.prisma.tbo_hotel_master.upsert({
        where: { tbo_hotel_code: hotelCode },
        create: {
          tbo_hotel_code: hotelCode,
          tbo_city_code: tboCityCode,
          hotel_name: hotelName,
          hotel_address: hotelAddress,
          city_name: cityName,
          star_rating: rating,
          status: 1,
        },
        update: {
          tbo_city_code: tboCityCode,
          hotel_name: hotelName,
          hotel_address: hotelAddress,
          city_name: cityName,
          star_rating: rating,
          status: 1,
        },
      });

      const existingDviHotel = await this.prisma.dvi_hotel.findFirst({
        where: {
          tbo_hotel_code: hotelCode,
          tbo_city_code: tboCityCode,
        },
        select: { hotel_id: true },
      });

      if (existingDviHotel) {
        await this.prisma.dvi_hotel.update({
          where: { hotel_id: existingDviHotel.hotel_id },
          data: {
            hotel_name: hotelName,
            hotel_address: hotelAddress,
            hotel_city: city.cityId ?? cityName,
            hotel_country: countryName,
            hotel_latitude: latitude,
            hotel_longitude: longitude,
            hotel_category: rating,
            status: 1,
            deleted: false,
          },
        });
      } else {
        await this.prisma.dvi_hotel.create({
          data: {
            hotel_name: hotelName,
            hotel_code: hotelCode,
            tbo_hotel_code: hotelCode,
            tbo_city_code: tboCityCode,
            hotel_country: countryName,
            hotel_city: city.cityId ?? cityName,
            hotel_address: hotelAddress,
            hotel_latitude: latitude,
            hotel_longitude: longitude,
            hotel_category: rating,
            createdby: 0,
            status: 1,
            deleted: false,
          },
        });
      }

      synced += 1;
    }

    return synced;
  }

  private async fetchHotelCodesFromStaticApi(tboCityCode: string): Promise<string> {
    const hotels = await this.fetchHotelsFromStaticApi(tboCityCode);
    if (!hotels.length) {
      return '';
    }

    return hotels
      .map((h: any) => String(h?.HotelCode || h?.hotelCode || '').trim())
      .filter((c: string) => c.length > 0)
      .join(',');
  }

  async confirmBooking(
    bookingDetails: HotelConfirmationDTO,
  ): Promise<HotelConfirmationResult> {
    try {
 this.logger.log(
        `📋 Confirming booking for hotel: ${bookingDetails.hotelCode}`
      );

 // Step 1: Authenticate and get TokenId
      const tokenId = await this.authenticate();

 // Step 2: Validate search reference
      const searchRef = bookingDetails.searchReference;
      if (!searchRef) {
        throw new Error('Search reference is required for confirmation');
      }

 // Step 3: Build TBO PreBook request (from Postman collection)
 // PreBook is required before booking to lock the room
      const prebookRequest = {
        CheckInDate: this.formatDateToISO(bookingDetails.checkInDate),
        CheckOutDate: this.formatDateToISO(bookingDetails.checkOutDate),
        HotelCode: bookingDetails.hotelCode,
        RoomCode: bookingDetails.rooms[0]?.roomCode || '',
        RoomCount: bookingDetails.roomCount,
        TokenId: tokenId,
      };

 this.logger.debug(` PreBook request: ${JSON.stringify(prebookRequest)}`);

 // Step 4: Call PreBook API
      const prebookResponse = await this.http
        .post(`${this.SEARCH_API_URL}/PreBook`, prebookRequest, {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
          },
        });

      let prebookRefId = prebookResponse.data?.PreBookRefId;
      if (!prebookRefId) {
 this.logger.warn(
          `⚠️ PreBook status: ${prebookResponse.data?.Status?.Code}`
        );
 // If PreBook fails, continue with booking using original search reference
        prebookRefId = searchRef;
      } else {
 this.logger.log(` PreBook successful: ${prebookRefId}`);
      }

 // Step 5: Build TBO Book request (from Postman collection)
      const bookRequest = {
        PreBookRefId: prebookRefId,
        HotelCode: bookingDetails.hotelCode,
        GuestNationality: this.normalizeNationality(
          bookingDetails.guestNationality || bookingDetails.guests?.[0]?.nationality,
        ),
        GuestDetails: bookingDetails.guests.map((g) => ({
          FirstName: g.firstName,
          LastName: g.lastName,
          Email: g.email,
          MobileNo: g.phone,
          Title: resolveProviderPassengerTitle(g.title),
          PAN: g.pan || null,
          PassportNo: g.passportNo || null,
        })),
        ContactDetails: {
          Name: bookingDetails.contactName,
          EmailId: bookingDetails.contactEmail,
          MobileNo: bookingDetails.contactPhone,
        },
        TokenId: tokenId,
      };

 this.logger.debug(` Book request: ${JSON.stringify(bookRequest)}`);

 // Step 6: Call Book API
      const bookResponse = await this.http
        .post(`${this.BOOKING_API_URL}/HotelService.svc/rest/Book`, bookRequest, {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
          },
        });

 // Check response status
      const bookingStatus = bookResponse.data?.Status;
      if (!bookingStatus || bookingStatus.Code !== 200) {
        throw new Error(
          `Booking failed: ${bookingStatus?.Description || 'Unknown error'}`
        );
      }

      const bookingRefId = bookResponse.data?.BookingRefId;
 this.logger.log(` Booking confirmed with ref: ${bookingRefId}`);

 // Step 7: Return confirmation
      return {
        provider: 'tbo',
        providerDisplayName: 'VSR',
        confirmationReference: bookingRefId,
        hotelCode: bookingDetails.hotelCode,
 hotelName: bookingDetails.hotelCode, // Would come from API response
        checkIn: bookingDetails.checkInDate,
        checkOut: bookingDetails.checkOutDate,
        roomCount: bookingDetails.roomCount,
 totalPrice: 0, // Would come from PreBook/Book response
        priceBreadown: {
          roomCharges: 0,
          taxes: 0,
          discounts: 0,
        },
        cancellationPolicy: 'As per VSR policy',
        status: 'confirmed',
        bookingDeadline: new Date().toISOString(),
      };
    } catch (error) {
 this.logger.error(
        `❌ Booking Confirmation Error: ${error.message}`,
        error.stack
      );
      throw new InternalServerErrorException(
        `VSR confirmation failed: ${error.message || 'Unknown error'}`
      );
    }
  }

  async getConfirmation(
    confirmationRef: string,
  ): Promise<HotelConfirmationDetails> {
    try {
 this.logger.log(` Getting confirmation status for: ${confirmationRef}`);

 // Step 1: Authenticate and get TokenId
      const tokenId = await this.authenticate();

 // Step 2: Build GetBookingDetail request (from Postman collection)
      const request = {
        BookingRefId: confirmationRef,
        TokenId: tokenId,
      };

 this.logger.debug(` GetBookingDetail request: ${JSON.stringify(request)}`);

 // Step 3: Call GetBookingDetail API
      const response = await this.http
        .post(
          `${this.BOOKING_API_URL}/HotelService.svc/rest/Getbookingdetail`,
          request,
          {
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );

      const status = response.data?.Status;
      if (!status || status.Code !== 200) {
        throw new Error(
          `Failed to fetch booking: ${status?.Description || 'Unknown error'}`
        );
      }

 this.logger.log(` Booking details retrieved`);

      return {
        confirmationRef: confirmationRef,
        hotelName: response.data.HotelName || '',
        checkIn: response.data.CheckInDate,
        checkOut: response.data.CheckOutDate,
        roomCount: response.data.RoomCount || 1,
        totalPrice: parseFloat(response.data.TotalPrice) || 0,
        status: response.data.BookingStatus || 'confirmed',
        cancellationPolicy: response.data.CancellationPolicy || 'As per VSR',
      };
    } catch (error) {
 this.logger.error(
        `❌ Get Confirmation Error: ${error.message}`,
        error.stack
      );
      throw new InternalServerErrorException('Failed to get confirmation details');
    }
  }

  async cancelBooking(
    confirmationRef: string,
    reason: string,
  ): Promise<CancellationResult> {
    try {
 this.logger.log(
        `❌ Cancelling booking: ${confirmationRef}, Reason: ${reason}`
      );

 // Step 1: Authenticate and get TokenId
      const tokenId = await this.authenticate();

 // Step 2: Build SendChangeRequest with RequestType=4 (TBO Official Format)
      const request = {
        BookingMode: 5,
 RequestType: 4, // 4 = HotelCancel
        Remarks: reason,
 BookingId: parseInt(confirmationRef), // Must be Integer from Book Response
        EndUserIp: process.env.TBO_END_USER_IP || '134.209.145.185',
        TokenId: tokenId,
      };

 this.logger.debug(` Cancellation request: ${JSON.stringify(request)}`);

 // Step 3: Call SendChangeRequest API
      const response = await this.http
        .post(
          `${this.BOOKING_API_URL}/HotelService.svc/rest/SendChangeRequest`,
          request,
          {
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );

 this.logger.debug(` TBO Cancel Response: ${JSON.stringify(response.data)}`);

      const result = response.data?.HotelChangeRequestResult;
      if (!result || result.ResponseStatus !== 1) {
 this.logger.error(` TBO Cancel Error Details: ${JSON.stringify(result)}`);
        const recovered = await this.tryRecoverCancellationStatus(confirmationRef, result);
        if (recovered) {
          return recovered;
        }
        throw new Error(
          `Cancellation failed: ${result?.Error?.ErrorMessage || 'Unknown error'}`
        );
      }

 this.logger.log(` Booking cancelled successfully - ChangeRequestId: ${result.ChangeRequestId}`);

      return {
        cancellationRef: result.ChangeRequestId?.toString() || confirmationRef,
 refundAmount: 0, // TBO doesn't return refund in this response
        charges: 0,
        refundDays: 0,
      };
    } catch (error) {
 // Log detailed error response from TBO
      if (error.response) {
 this.logger.error(` TBO API Error Response Status: ${error.response.status}`);
 this.logger.error(` TBO API Error Response Body: ${JSON.stringify(error.response.data)}`);
      }

      const recovered = await this.tryRecoverCancellationStatus(confirmationRef, error);
      if (recovered) {
        return recovered;
      }

 this.logger.error(
        `❌ Cancel Booking Error: ${error.message}`,
        error.stack
      );
      throw new InternalServerErrorException('Failed to cancel booking');
    }
  }

  private async tryRecoverCancellationStatus(
    confirmationRef: string,
    context: any,
  ): Promise<CancellationResult | null> {
    try {
 this.logger.warn(
        `⚠️ Cancel request did not return success for booking ${confirmationRef}. Verifying final status via GetBookingDetail...`,
      );

      const detail = await this.getConfirmation(String(confirmationRef));
      const status = String(detail?.status || '').toLowerCase();
      const isCancelled =
        status.includes('cancel') ||
        status.includes('void') ||
        status.includes('refunded');

      if (!isCancelled) {
 this.logger.warn(
          `⚠️ Recovery check completed but booking is not cancelled. status=${detail?.status || 'unknown'}`,
        );
        return null;
      }

      const fallbackRef =
        String(context?.ChangeRequestId || context?.data?.HotelChangeRequestResult?.ChangeRequestId || confirmationRef);

 this.logger.warn(
        `✅ Cancellation recovered via BookingDetail for booking ${confirmationRef}. status=${detail.status}`,
      );

      return {
        cancellationRef: fallbackRef,
        refundAmount: 0,
        charges: 0,
        refundDays: 0,
      };
    } catch (recoveryError: any) {
 this.logger.error(
        `❌ Cancellation recovery check failed for booking ${confirmationRef}: ${recoveryError.message}`,
      );
      return null;
    }
  }

  private parseRating(ratingStr: string): number {
    const ratingMap: Record<string, number> = {
      OneStar: 1,
      TwoStar: 2,
      ThreeStar: 3,
      FourStar: 4,
      FiveStar: 5,
      All: 0,
    };
    return ratingMap[ratingStr] || 0;
  }

  private parseFacilities(facilities: any): string[] {
    if (!facilities) return [];

    if (Array.isArray(facilities)) {
      return facilities
        .flat()
        .filter((f) => f && typeof f === 'string')
        .map((f) => f.trim());
    }

    if (typeof facilities === 'string') {
      return facilities
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f);
    }

    return [];
  }

  private parseRoomTypes(roomsData: any[]): RoomType[] {
    if (!roomsData || !Array.isArray(roomsData)) return [];

    return roomsData.map((room) => ({
      roomCode: room.RoomCode || '',
      roomName: room.RoomName || '',
      bedType: room.BedType || 'Not specified',
      capacity: parseInt(room.Capacity) || 1,
      price: parseFloat(room.Price) || 0,
      cancellationPolicy: room.CancellationPolicy || 'Non-refundable',
    }));
  }

  private normalizeNationality(nationality?: string): string {
    const normalized = (nationality || '').trim().toUpperCase();
    if (normalized) {
      return normalized;
    }

    const fallback = (process.env.TBO_DEFAULT_GUEST_NATIONALITY || '').trim().toUpperCase();
    if (fallback) {
 this.logger.warn(
        `⚠️ GuestNationality missing in request. Falling back to configured default ${fallback}.`,
      );
      return fallback;
    }

    throw new Error(
      'GuestNationality is required. Provide guestNationality in request or set TBO_DEFAULT_GUEST_NATIONALITY.',
    );
  }

  private buildSearchPaxRooms(criteria: HotelSearchCriteria): Array<{
    Adults: number;
    Children: number;
    ChildrenAges: number[];
  }> {
 // DEFENSIVE VALIDATION: Ensure occupancies exist and comply with TBO limits
    if (!criteria.occupancies || criteria.occupancies.length === 0) {
      throw new InternalServerErrorException(
        'Occupancies must be defined before building PaxRooms. This indicates a bug in the service layer.',
      );
    }

    if (criteria.occupancies.length > TBOHotelProvider.MAX_ROOMS) {
      throw new InternalServerErrorException(
        `Number of rooms (${criteria.occupancies.length}) exceeds TBO limit of ${TBOHotelProvider.MAX_ROOMS}.`,
      );
    }

 // Validate each occupancy before building PaxRooms payload
    for (let i = 0; i < criteria.occupancies.length; i++) {
      const occ = criteria.occupancies[i];

      if (occ.adults > TBOHotelProvider.MAX_ADULTS_PER_ROOM || occ.adults < 0) {
        throw new InternalServerErrorException(
          `Occupancy[${i}].adults (${occ.adults}) violates TBO limit. ` +
          `Must be 0-${TBOHotelProvider.MAX_ADULTS_PER_ROOM}.`,
        );
      }

      if (occ.children > TBOHotelProvider.MAX_CHILDREN_PER_ROOM || occ.children < 0) {
        throw new InternalServerErrorException(
          `Occupancy[${i}].children (${occ.children}) violates TBO limit. ` +
          `Must be 0-${TBOHotelProvider.MAX_CHILDREN_PER_ROOM}.`,
        );
      }
    }

 // Build PaxRooms with validated occupancies
    return criteria.occupancies.map((occ) => ({
      Adults: Math.max(occ.adults || 1, 1),
      Children: Math.max(occ.children || 0, 0),
      ChildrenAges: (occ.childrenAges || []).map((age) => Number(age)).filter((age) => !Number.isNaN(age)),
    }));
  }

 /**
   * Fetch hotel codes dynamically from TBO GetHotels API
   * Falls back to database if API fails
   *
   * NEVER uses hardcoded values
 */
  private async fetchHotelsFromTBOApi(tboCityCode: string): Promise<string> {
    try {
 this.logger.log(` TBO API: Fetching hotels from GetHotels API for city: ${tboCityCode}`);

 // Get token for authentication
      const tokenId = await this.authenticate();

 // Build GetHotels request
      const getHotelsRequest = {
        CityCode: tboCityCode,
        TokenId: tokenId,
 StarRating: 0, // 0 = all ratings
      };

 this.logger.debug(` GetHotels request: ${JSON.stringify(getHotelsRequest)}`);

 // Call TBO GetHotels API
      const response = await this.http.post(
        `${this.SHARED_API_URL}/SharedData.svc/rest/GetHotels`,
        getHotelsRequest,
        {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const status = response.data?.Status;
      if (status !== 1) {
 this.logger.warn(` TBO API GetHotels returned status: ${status}. Falling back to database.`);
        return await this.getHotelCodesFromDbFallback(tboCityCode);
      }

      const hotels = response.data?.Hotels || [];
 this.logger.log(` TBO GetHotels returned ${hotels.length} hotels for city ${tboCityCode}`);

      if (hotels.length === 0) {
 this.logger.warn(` TBO API returned 0 hotels for city ${tboCityCode}. Falling back to database.`);
        return await this.getHotelCodesFromDbFallback(tboCityCode);
      }

 // Extract and return hotel codes
      const hotelCodes: string[] = [];
      for (const hotel of hotels) {
        hotelCodes.push(hotel.HotelCode);
      }

 this.logger.log(` Extracted ${hotelCodes.length} hotel codes from TBO GetHotels response`);
      return hotelCodes.join(',');
    } catch (error) {
      const err = error as Error;
 this.logger.error(` TBO API GetHotels failed: ${err.message}. Falling back to database.`);
      return await this.getHotelCodesFromDbFallback(tboCityCode);
    }
  }

 /**
   * Fallback hotel codes when TBO API is unavailable
   * Returns hardcoded popular hotels per city
 */
  private parseStarRating(categoryString: string): number {
 // Extract star rating from category string like "5-Star", "4-Star", etc.
    if (!categoryString) return 0;
    const match = categoryString.match(/(\d+)-Star/);
    return match ? parseInt(match[1], 10) : 0;
  }

 /**
   * Fetch hotel codes from database (tbo_hotel_master table)
   * This is the PRIMARY method - no hardcoding allowed
   *
   * Error Handling:
   * 1. If DB has hotels → Return them
   * 2. If DB empty → Log error & return empty string (forces error handling upstream)
   * 3. If DB query fails → Log error & return empty string
 */
  private async getHotelCodesFromDbFallback(tboCityCode: string): Promise<string> {
    try {
 this.logger.warn(` Fallback: Fetching hotel codes from tbo_hotel_master for city ${tboCityCode}`);

      if (!this.prisma) {
 this.logger.error(` CRITICAL: PrismaService is NULL/UNDEFINED - Cannot query database`);
        return '';
      }

      const hotels = await this.prisma.tbo_hotel_master.findMany({
        where: {
          tbo_city_code: tboCityCode,
 status: 1, // Active hotels only
        },
        select: {
          tbo_hotel_code: true,
        },
 take: 500, // Allow up to 500 hotels (batched into 100-code chunks by caller)
      });

      if (!hotels || hotels.length === 0) {
 this.logger.error(
          `❌ DATABASE ERROR: No hotels found in tbo_hotel_master for city ${tboCityCode}. ` +
          `Make sure to run hotel sync: POST /hotels/sync/all`
        );
        return '';
      }

      const hotelCodes = hotels
        .map((h) => h.tbo_hotel_code)
        .filter((code) => code && code.trim() !== '')
        .join(',');

 this.logger.warn(` Fallback Query SUCCESS: Found ${hotels.length} hotels in database`);
 this.logger.log(` Hotel codes from DB: ${hotelCodes.substring(0, 100)}...`);

      return hotelCodes;
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.error(
        `🔴 DATABASE QUERY ERROR: Failed to fetch hotels from tbo_hotel_master: ${errorMsg}`
      );
      return '';
    }
  }

 /**
   * Fetch hotel codes for a city from database
   * Queries tbo_hotel_master table (synced from TBO GetHotels API)
   *
   * PRIMARY FLOW:
   * 1. Try database first (tbo_hotel_master)
   * 2. If DB empty, return empty string (error handling)
   * 3. No hardcoding - database must be synced via POST /hotels/sync/all
 */
  private async getHotelCodesForCityFromDb(
    tboCityCode: string,
    selectedStarRatings: number[] = [],
  ): Promise<string> {
    try {
 this.logger.log(` PRIMARY: Querying tbo_hotel_master for city ${tboCityCode}`);

      if (!this.prisma) {
 this.logger.error(` CRITICAL: PrismaService is NULL/UNDEFINED`);
        throw new Error('PrismaService not available');
      }

 // Query tbo_hotel_master table (synced from TBO GetHotels API)
      const hotels = await this.prisma.tbo_hotel_master.findMany({
        where: {
          tbo_city_code: tboCityCode,
          status: 1,
          tbo_hotel_code: {
            not: '',
          },
        },
        select: {
          tbo_hotel_code: true,
          star_rating: true,
          is_priority: true,
        },
        orderBy: [
          { is_priority: 'desc' },
          { tbo_hotel_code: 'asc' },
        ],
      });

      if (!hotels || hotels.length === 0) {
 this.logger.warn(
          `⚠️ PRIMARY: No hotels in tbo_hotel_master for city ${tboCityCode}. ` +
          `Will try dvi_hotel fallback. If this city should be in master, sync city: POST /api/v1/hotels/sync/city/${tboCityCode}`
        );

 // Try fallback query from dvi_hotel table
 this.logger.log(` FALLBACK: Trying dvi_hotel table for city ${tboCityCode}`);
        const dviHotels = await this.prisma.dvi_hotel.findMany({
          where: {
            tbo_city_code: tboCityCode,
            deleted: false,
            status: 1,
            tbo_hotel_code: {
              not: null,
            },
          },
          select: {
            tbo_hotel_code: true,
            hotel_category: true,
          },
          orderBy: {
            tbo_hotel_code: 'asc',
          },
          take: TBOHotelProvider.MAX_MIXED_HOTEL_LIMIT,
        });

        if (dviHotels && dviHotels.length > 0) {
          const candidates: TboHotelCodeCandidate[] = dviHotels
            .map((hotel) => ({
              hotelCode: String(hotel.tbo_hotel_code || '').trim(),
              starRating: Number(hotel.hotel_category || 0),
              isPriority: false,
            }))
            .filter((hotel) => Boolean(hotel.hotelCode));
          const selected = selectedStarRatings.length > 0
            ? this.selectExplicitStarRatingHotels(candidates, selectedStarRatings)
            : this.selectHotelsByPercentage(candidates);
          const codes = selected.map((hotel) => hotel.hotelCode).join(',');

 this.logger.log(` FALLBACK: Found ${dviHotels.length} hotels in dvi_hotel`);
          this.logHotelMix(tboCityCode, candidates, selected);
          return codes;
        }

 this.logger.warn(
          `⚠️ FALLBACK FAILED: No hotels in dvi_hotel either for city ${tboCityCode}. ` +
          `Returning empty string so caller can continue to static API fallback.`
        );
        return '';
      }

      const candidates: TboHotelCodeCandidate[] = hotels
        .map((hotel) => ({
          hotelCode: String(hotel.tbo_hotel_code || '').trim(),
          starRating: Number(hotel.star_rating || 0),
          isPriority: Number(hotel.is_priority || 0) === 1,
        }))
        .filter((hotel) => Boolean(hotel.hotelCode));
      const selected = selectedStarRatings.length > 0
        ? this.selectExplicitStarRatingHotels(candidates, selectedStarRatings)
        : this.selectHotelsByPercentage(candidates);
      const hotelCodes = selected.map((hotel) => hotel.hotelCode).join(',');

 this.logger.log(` PRIMARY SUCCESS: Found ${hotels.length} hotels in tbo_hotel_master`);
      this.logHotelMix(tboCityCode, candidates, selected);

      return hotelCodes;
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.error(
        `🔴 DATABASE QUERY ERROR: ${errorMsg}`
      );
      return '';
    }
  }

  private selectHotelsByPercentage(
    candidates: TboHotelCodeCandidate[],
  ): TboHotelCodeCandidate[] {
    const requestedLimit = this.getMixedHotelLimit();
    const uniqueCandidates = this.uniqueHotelCandidates(candidates);
    const pools: Record<TboHotelMixSegment, TboHotelCodeCandidate[]> = {
      economy: uniqueCandidates.filter((hotel) => [1, 2].includes(hotel.starRating)),
      threeStar: uniqueCandidates.filter((hotel) => hotel.starRating === 3),
      fourStar: uniqueCandidates.filter((hotel) => hotel.starRating === 4),
      fiveStar: uniqueCandidates.filter((hotel) => hotel.starRating === 5),
    };
    const availableCount = Object.values(pools).reduce(
      (total, pool) => total + pool.length,
      0,
    );
    const targetCount = Math.min(requestedLimit, availableCount);

    if (targetCount === 0) {
      return [];
    }

    const quotas = this.calculateHotelMixQuotas(targetCount);
    const selected: TboHotelCodeCandidate[] = [];
    const selectedCodes = new Set<string>();
    const takeFromPool = (segment: TboHotelMixSegment, count: number): void => {
      if (count <= 0) return;

      for (const hotel of pools[segment]) {
        if (selected.length >= targetCount || count <= 0) break;
        if (selectedCodes.has(hotel.hotelCode)) continue;

        selected.push(hotel);
        selectedCodes.add(hotel.hotelCode);
        count -= 1;
      }
    };

    takeFromPool('economy', quotas.economy);
    takeFromPool('threeStar', quotas.threeStar);
    takeFromPool('fourStar', quotas.fourStar);
    takeFromPool('fiveStar', quotas.fiveStar);

    const redistributionOrder: TboHotelMixSegment[] = [
      'threeStar',
      'fourStar',
      'economy',
      'fiveStar',
    ];
    while (selected.length < targetCount) {
      const countBeforePass = selected.length;
      for (const segment of redistributionOrder) {
        takeFromPool(segment, 1);
        if (selected.length >= targetCount) break;
      }
      if (selected.length === countBeforePass) break;
    }

    return selected;
  }

  private selectExplicitStarRatingHotels(
    candidates: TboHotelCodeCandidate[],
    selectedStarRatings: number[],
  ): TboHotelCodeCandidate[] {
    const allowedRatings = new Set(selectedStarRatings);
    return this.uniqueHotelCandidates(candidates)
      .filter((hotel) => allowedRatings.has(hotel.starRating))
      .slice(0, this.getMixedHotelLimit());
  }

  private calculateHotelMixQuotas(
    total: number,
  ): Record<TboHotelMixSegment, number> {
    const segments: TboHotelMixSegment[] = [
      'economy',
      'threeStar',
      'fourStar',
      'fiveStar',
    ];
    const percentages = TBOHotelProvider.HOTEL_MIX_PERCENTAGES;
    const exactValues = segments.map((segment) => ({
      segment,
      exact: (total * percentages[segment]) / 100,
    }));
    const quotas = exactValues.reduce(
      (result, item) => {
        result[item.segment] = Math.floor(item.exact);
        return result;
      },
      {
        economy: 0,
        threeStar: 0,
        fourStar: 0,
        fiveStar: 0,
      } as Record<TboHotelMixSegment, number>,
    );
    let unallocated = total - Object.values(quotas).reduce(
      (sum, quota) => sum + quota,
      0,
    );
    const tieBreakOrder: TboHotelMixSegment[] = [
      'threeStar',
      'economy',
      'fourStar',
      'fiveStar',
    ];

    exactValues
      .sort((left, right) => {
        const remainderDifference =
          (right.exact - Math.floor(right.exact)) -
          (left.exact - Math.floor(left.exact));
        return remainderDifference ||
          tieBreakOrder.indexOf(left.segment) - tieBreakOrder.indexOf(right.segment);
      })
      .forEach((item) => {
        if (unallocated <= 0) return;
        quotas[item.segment] += 1;
        unallocated -= 1;
      });

    return quotas;
  }

  private uniqueHotelCandidates(
    candidates: TboHotelCodeCandidate[],
  ): TboHotelCodeCandidate[] {
    const unique = new Map<string, TboHotelCodeCandidate>();
    for (const candidate of candidates) {
      const hotelCode = String(candidate.hotelCode || '').trim();
      if (!hotelCode || unique.has(hotelCode)) continue;
      unique.set(hotelCode, { ...candidate, hotelCode });
    }

    return Array.from(unique.values()).sort(
      (left, right) =>
        Number(right.isPriority) - Number(left.isPriority) ||
        left.hotelCode.localeCompare(right.hotelCode),
    );
  }

  private getMixedHotelLimit(): number {
    const configuredLimit = Number(
      process.env.TBO_MIXED_HOTEL_LIMIT ||
        TBOHotelProvider.DEFAULT_MIXED_HOTEL_LIMIT,
    );
    if (!Number.isInteger(configuredLimit) || configuredLimit <= 0) {
      return TBOHotelProvider.DEFAULT_MIXED_HOTEL_LIMIT;
    }
    return Math.min(configuredLimit, TBOHotelProvider.MAX_MIXED_HOTEL_LIMIT);
  }

  private getMixSegment(starRating: number): TboHotelMixSegment | null {
    if (starRating === 1 || starRating === 2) return 'economy';
    if (starRating === 3) return 'threeStar';
    if (starRating === 4) return 'fourStar';
    if (starRating === 5) return 'fiveStar';
    return null;
  }

  private logHotelMix(
    cityCode: string,
    candidates: TboHotelCodeCandidate[],
    selected: TboHotelCodeCandidate[],
  ): void {
    const countBySegment = (items: TboHotelCodeCandidate[]): Record<string, number> =>
      items.reduce<Record<string, number>>((result, hotel) => {
        const segment = this.getMixSegment(hotel.starRating) || 'unknown';
        result[segment] = (result[segment] || 0) + 1;
        return result;
      }, {});

    this.logger.log(
      `TBO hotel mix for city ${cityCode}: ${JSON.stringify({
        configuredLimit: this.getMixedHotelLimit(),
        available: countBySegment(candidates),
        selected: countBySegment(selected),
        totalSelected: selected.length,
        selectedHotelCodes: selected.map((hotel) => hotel.hotelCode),
      })}`,
    );
  }

 /**
   * Get hotel master data from database
   * Queries dvi_hotel table for specific hotel
   * Matches PHP structure from cron_tbo_hotel_details_core_data.php
   * Returns: hotel_name, hotel_address, hotel_category (star rating)
 */
  private async getHotelMasterDataFromDb(hotelCode: string, cityCode?: string) {
    try {
 // Database stores tbo_hotel_code as base code (e.g., "1035259")
 // Search by tbo_hotel_code and optionally by tbo_city_code for city-aware lookup

      let hotel: any = null;

 // Strategy 1: If city code provided, search for this city's hotel first in dvi_hotel
      if (cityCode) {
        hotel = await this.prisma.dvi_hotel.findFirst({
          where: {
            tbo_hotel_code: hotelCode,
            tbo_city_code: cityCode,
            deleted: false,
          },
        });

        if (hotel) {
          if (this.verboseHotelLookupLogs) {
 this.logger.log(` Found hotel by code+city: ${hotelCode} (City: ${cityCode}) -> ${hotel.hotel_name}`);
          }
          return {
            hotel_name: hotel.hotel_name,
            hotel_address: hotel.hotel_address || '',
            hotel_latitude: hotel.hotel_latitude ?? null,
            hotel_longitude: hotel.hotel_longitude ?? null,
            star_rating: hotel.hotel_category || 0,
          };
        }

        if (this.verboseHotelLookupLogs) {
 this.logger.log(` Hotel ${hotelCode} not found in dvi_hotel for city ${cityCode}, searching globally...`);
        }
      }

 // Strategy 2: Search by hotel code only in dvi_hotel (global search)
      hotel = await this.prisma.dvi_hotel.findFirst({
        where: {
          tbo_hotel_code: hotelCode,
          deleted: false,
        },
      });

      if (hotel) {
        if (this.verboseHotelLookupLogs) {
 this.logger.log(` Found hotel by code in dvi_hotel: ${hotelCode} -> ${hotel.hotel_name}`);
        }
        return {
          hotel_name: hotel.hotel_name,
          hotel_address: hotel.hotel_address || '',
          hotel_latitude: hotel.hotel_latitude ?? null,
          hotel_longitude: hotel.hotel_longitude ?? null,
          star_rating: hotel.hotel_category || 0,
        };
      }

 // Strategy 3: Fallback to tbo_hotel_master table (synced from TBO GetHotels API)
      if (this.verboseHotelLookupLogs) {
 this.logger.log(` Hotel ${hotelCode} not found in dvi_hotel, checking tbo_hotel_master...`);
      }

      const tboHotel: any = await this.prisma.tbo_hotel_master.findFirst({
        where: {
          tbo_hotel_code: hotelCode,
          ...(cityCode ? { tbo_city_code: cityCode } : {}),
          status: 1,
        },
      });

      if (tboHotel) {
        if (this.verboseHotelLookupLogs) {
 this.logger.log(` Found hotel in tbo_hotel_master: ${hotelCode} -> ${tboHotel.hotel_name}`);
        }
        return {
          hotel_name: tboHotel.hotel_name || `Hotel ${hotelCode}`,
          hotel_address: tboHotel.hotel_address || '',
          hotel_latitude: tboHotel.hotel_latitude ?? null,
          hotel_longitude: tboHotel.hotel_longitude ?? null,
          star_rating: tboHotel.star_rating || 0,
        };
      }

 this.logger.warn(` Hotel ${hotelCode} not found in any database table`);
      return null;
    } catch (error) {
      const err = error as Error;
 this.logger.error(` Error querying hotel from database: ${err.message}`);
      return null;
    }
  }

  private formatDateToISO(dateStr: string): string {
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
 return `${year}-${month}-${day}`; // YYYY-MM-DD (ISO format)
  }

  private formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
 return `${day}/${month}/${year}`; // DD/MM/YYYY (for legacy support)
  }



  private generateCacheKey(criteria: HotelSearchCriteria): string {
    return `hotel_search_${criteria.cityCode}_${criteria.checkInDate}_${criteria.checkOutDate}_${criteria.roomCount}`;
  }

 /**
   * Split hotel codes into chunks of max size
   * Per TBO API documentation: send parallel searches for 100 hotel codes chunks
 */
  private chunkHotelCodes(hotelCodes: string | undefined, chunkSize: number = 100): string[] {
    if (!hotelCodes || hotelCodes.trim() === '') {
      return [];
    }

    const codes = hotelCodes.split(',').map(c => c.trim()).filter(c => c);
    const chunks: string[] = [];

    for (let i = 0; i < codes.length; i += chunkSize) {
      chunks.push(codes.slice(i, i + chunkSize).join(','));
    }

    return chunks;
  }

 /**
   * Execute a single TBO Search API request for a chunk of hotel codes
 */
  private async executeTBOSearch(
    searchRequest: any,
    basicAuth: string,
    description: string = ''
  ): Promise<any[]> {
    const requestStartedAt = Date.now();
    const requestUrl = `${this.SEARCH_API_URL}/Search`;
    const requestDetails = {
      endpoint: requestUrl,
      timeoutMs: this.SEARCH_TIMEOUT_MS,
      description,
      checkIn: searchRequest.CheckIn,
      checkOut: searchRequest.CheckOut,
      cityCode: searchRequest.CityCode,
      hotelCodeCount: searchRequest.HotelCodes
        ? searchRequest.HotelCodes.split(',').filter((code: string) => code.trim()).length
        : 0,
      guestNationality: searchRequest.GuestNationality,
      paxRooms: searchRequest.PaxRooms,
      noOfRoomsFilter: searchRequest.Filters?.NoOfRooms,
      mealTypeFilter: searchRequest.Filters?.MealType || '',
      starRatingFilter: searchRequest.Filters?.StarRating || 0,
    };
    HotelAvailabilityTimingLogger.log('TBO_SEARCH_REQUEST', requestDetails);
    try {
      const logFullPayload = (process.env.TBO_LOG_FULL_PAYLOAD || 'true').toLowerCase() === 'true';
 console.log(logFullPayload,'logFullPayload');

 this.logger.log(` TBO Search Request ${description}:`);
 this.logger.log(` - Check-in: ${searchRequest.CheckIn}`);
 this.logger.log(` - Check-out: ${searchRequest.CheckOut}`);
 this.logger.log(` - City Code: ${searchRequest.CityCode}`);
 this.logger.log(` - Hotel Codes: ${searchRequest.HotelCodes || '(All available hotels for city)'}`);
 this.logger.log(` - Guests: ${searchRequest.PaxRooms[0].Adults} adults`);
 this.logger.log(` - GuestNationality: ${searchRequest.GuestNationality}`);
 this.logger.log(` - NoOfRooms(Filter): ${searchRequest.Filters?.NoOfRooms}`);
      if (logFullPayload) {
 this.logger.log(` TBO Search Request JSON: ${JSON.stringify(searchRequest)}`);
      }

 // Log search request
      const hotelCodeList = searchRequest.HotelCodes
        ? searchRequest.HotelCodes.split(',').map((c:string) => c.trim())
        : [];

      const startTime = Date.now();
      const response = await this.http.post(`${this.SEARCH_API_URL}/Search`, searchRequest, {
        timeout: this.SEARCH_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${basicAuth}`,
        },
      });

      const responseTime = Date.now() - startTime;
      HotelAvailabilityTimingLogger.log('TBO_SEARCH_RESPONSE', {
        ...requestDetails,
        durationMs: responseTime,
        httpStatus: response.status,
        providerStatus: typeof response.data?.Status === 'object'
          ? response.data?.Status?.Code
          : response.data?.Status,
        providerStatusDescription: typeof response.data?.Status === 'object'
          ? response.data?.Status?.Description
          : undefined,
        hotelResultCount: Array.isArray(response.data?.HotelResult)
          ? response.data.HotelResult.length
          : 0,
      });
 this.logger.log(` TBO API Response Time ${description}: ${responseTime}ms`);
      await this.persistRawSearchResponse({
        endpoint: requestUrl,
        description,
        httpStatus: response.status,
        checkIn: searchRequest.CheckIn,
        checkOut: searchRequest.CheckOut,
        cityCode: searchRequest.CityCode,
        hotelCodeCount: requestDetails.hotelCodeCount,
      }, response.data);
      if (logFullPayload) {
 this.logger.log(` TBO API Response JSON: ${JSON.stringify(response.data)}`);
      } else {
        const statusObj = response.data?.Status;
        const statusCode = typeof statusObj === 'object' ? statusObj?.Code : statusObj;
      this.logger.debug(` TBO API response summary: status=${statusCode ?? 'unknown'}, hotels=${(response.data?.HotelResult || []).length}`);
      }

 // Check response status
      const statusObj = response.data?.Status;
      const statusCode = typeof statusObj === 'object' ? statusObj?.Code : statusObj;

      if (statusCode !== 200) {
        const statusDescription = typeof statusObj === 'object' ? statusObj?.Description : 'Unknown error';
 this.logger.warn(` TBO Search returned status: ${statusCode} - ${statusDescription}`);
        return [];
      }

      const hotels = response.data.HotelResult || [];
 this.logger.log(` This request returned ${hotels.length} hotels`);

      return hotels;
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      HotelAvailabilityTimingLogger.log('TBO_SEARCH_ERROR', {
        ...requestDetails,
        durationMs: Date.now() - requestStartedAt,
        errorName: error?.name,
        errorCode: error?.code,
        errorMessage: errorMsg,
        httpStatus: error?.response?.status,
        providerStatus: error?.response?.data?.Status,
      });
      this.logger.error(` TBO Search Error ${description}: ${errorMsg}`);

      return [];
    }
  }
}

