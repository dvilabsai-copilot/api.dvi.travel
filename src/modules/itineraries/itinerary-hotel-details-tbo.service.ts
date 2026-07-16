// FILE: src/modules/itineraries/itinerary-hotel-details-tbo.service.ts

import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { HotelSearchService } from '../hotels/services/hotel-search.service';
import { HobseHotelProvider } from '../hotels/providers/hobse-hotel.provider';
import { HotelSearchResult } from '../hotels/interfaces/hotel-provider.interface';
import {
  ItineraryHotelTabDto,
  ItineraryHotelRowDto,
  ItineraryHotelDetailsResponseDto,
  ItineraryHotelRoomDetailsResponseDto,
  ItineraryHotelRoomDto,
} from './itinerary-hotel-details.service';
import { haversineKm } from './utils/distance-utils';
import {
  HOTEL_RATE_PLAN_BY_CODE,
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealFlags,
} from '../hotels/hotel-rate-plans';
import {
  calculateStaahOccupancyAmount,
  type StaahPricingPaxInput,
} from './helpers/staah-occupancy-pricing';
import { ItineraryHotelDetailsCacheService } from './services/itinerary-hotel-details-cache.service';
import { ItineraryHotelStayBlockService } from './services/itinerary-hotel-stay-block.service';
import { ItineraryHotelPricePackageService } from './services/itinerary-hotel-price-package.service';
import { ItineraryHotelCityCodeService } from './services/itinerary-hotel-city-code.service';
import { StaahRestrictionService } from './services/staah-restriction.service';
import { ItineraryHotelResponseRowService } from './services/itinerary-hotel-response-row.service';
import { StaahConfirmedBookingOverrideService } from './services/staah-confirmed-booking-override.service';
import { GuestNationalityService } from './services/guest-nationality.service';
import { ItineraryHotelPreferenceFilterService } from './services/itinerary-hotel-preference-filter.service';
import { ItineraryHotelSecondaryProviderFetchService } from './services/itinerary-hotel-secondary-provider-fetch.service';

/**
 * This service generates dynamic hotel packages from TBO API
 * instead of retrieving them from the database
 */
@Injectable()
export class ItineraryHotelDetailsTboService {
  private normalizeExactRoomCode(value: unknown): string {
    return String(value || '').trim().toUpperCase();
  }

  private normalizeLooseRoomCode(value: unknown): string {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private parseStaahSearchReference(reference: any): {
    propertyId: string;
    roomId: string;
    rateId: string;
  } | null {
    const raw = String(reference || '').trim();
    if (!raw.startsWith('STAAH-')) return null;
    const parts = raw.split('-');
    if (parts.length < 5) return null;

    const propertyId = String(parts[1] || '').trim();
    const roomId = String(parts[2] || '').trim();
    const rateId = String(parts[3] || '').trim();
    if (!propertyId || !roomId || !rateId) return null;

    return { propertyId, roomId, rateId };
  }

    /**
     * Fetch hotels for all routes, retrying ONCE if any provider/system failure (null) is detected.
     */
    private async fetchHotelsForRoutesWithRetry(
      routes: any[],
      noOfNights: number,
      guestNationality: string,
      roomCount: number = 1,
      adultCount: number = 2,
      childCount: number = 0,
      childAges: number[] = [],
    ): Promise<Map<number, HotelSearchResult[] | null>> {
      let hotelsByRoute = await this.fetchHotelsForRoutes(
        routes,
        noOfNights,
        guestNationality,
        roomCount,
        adultCount,
        childCount,
        childAges,
      );

      const hasProviderFailure = Array.from(hotelsByRoute.values()).some(
        (value) => value === null,
      );

      if (hasProviderFailure) {
        this.logger.warn(
          'ðŸš¨ Hotel search had provider/system failure on first attempt. Retrying once...'
        );

        // small delay to allow DB sync / provider readiness
        await new Promise((resolve) => setTimeout(resolve, 800));

        const retryResult = await this.fetchHotelsForRoutes(
          routes,
          noOfNights,
          guestNationality,
          roomCount,
          adultCount,
          childCount,
          childAges,
        );

        const retryStillFailed = Array.from(retryResult.values()).some(
          (value) => value === null,
        );

        // compare number of successful routes (non-empty arrays)
        const retrySuccessCount = Array.from(retryResult.values()).filter(
          (v) => Array.isArray(v) && v.length > 0,
        ).length;

        const firstSuccessCount = Array.from(hotelsByRoute.values()).filter(
          (v) => Array.isArray(v) && v.length > 0,
        ).length;

        this.logger.log(
          `ðŸ“Š Comparing results â†’ First: ${firstSuccessCount}, Retry: ${retrySuccessCount}`,
        );

        // return whichever has more valid hotel data
        if (retrySuccessCount >= firstSuccessCount) {
          this.logger.log('âœ… Using retry result (better or equal)');
          return retryResult;
        } else {
          this.logger.log('âš ï¸ Using first attempt result (better)');
          return hotelsByRoute;
        }
      }

      return hotelsByRoute;
    }
  private readonly logger = new Logger(ItineraryHotelDetailsTboService.name);

  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  private readonly hotelDetailsCacheService = new ItineraryHotelDetailsCacheService();
  private readonly stayBlockService = new ItineraryHotelStayBlockService();
  private readonly pricePackageService = new ItineraryHotelPricePackageService();
  private readonly cityCodeService = new ItineraryHotelCityCodeService();
  private readonly staahRestrictionService = new StaahRestrictionService();
  private readonly hotelResponseRowService = new ItineraryHotelResponseRowService();
  private readonly staahConfirmedBookingOverrideService = new StaahConfirmedBookingOverrideService();
  private readonly guestNationalityService = new GuestNationalityService();
  private readonly preferenceFilterService = new ItineraryHotelPreferenceFilterService();
  private readonly secondaryProviderFetchService = new ItineraryHotelSecondaryProviderFetchService();

  private isTboOnlyFetchEnabled(): boolean {
    const raw = String(process.env.HOTEL_FETCH_TBO_ONLY || '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private isHobseSearchEnabled(): boolean {
    const raw = String(process.env.HOBSE_SEARCH_ENABLED || '0').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private normalizeNumberList(value: unknown): number[] {
    if (Array.isArray(value)) {
      return value
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n));
    }

    const raw = String(value ?? '').trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n) && n > 0)
          .map((n) => Math.trunc(n));
      }
    } catch {
      // fall through to CSV parsing
    }

    return raw
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.trunc(n));
  }

  private applyPlanPreferenceFilters(
    hotelsByRoute: Map<number, HotelSearchResult[] | null>,
    preferredCategories: number[],
    preferredMealPlanCode: string | null,
  ): Map<number, HotelSearchResult[] | null> {
    return this.preferenceFilterService.apply(hotelsByRoute, preferredCategories, preferredMealPlanCode, {
      log: (message) => this.logger.log(message),
      warn: (message) => this.logger.warn(message),
      debug: (message) => this.logger.debug(message),
    });
  }



  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelSearchService: HotelSearchService,
    private readonly hobseProvider: HobseHotelProvider,
  ) {}

  private getHotelMarginPercentage(hotel: any): number {
    const hotelMargin = Number(
      hotel?.hotel_margin ??
        hotel?.hotelMargin ??
        hotel?.marginPercentage ??
        hotel?.hotel_margin_percentage ??
        hotel?.hotelMarginPercentage ??
        0,
    );

    if (Number.isFinite(hotelMargin) && hotelMargin > 0) {
      return hotelMargin;
    }

    const fallbackMargin = Number(process.env.HOTEL_MARGIN ?? 0);
    return Number.isFinite(fallbackMargin) && fallbackMargin > 0 ? fallbackMargin : 0;
  }

  private money(value: number): number {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) {
      return 0;
    }

    return Number(amount.toFixed(2));
  }

  private applyInvisibleHotelMargin(amount: number, hotel: any): number {
    const baseAmount = Number(amount || 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return 0;
    }

    const marginPercentage = this.getHotelMarginPercentage(hotel);
    const amountWithMargin = baseAmount + (baseAmount * marginPercentage) / 100;
    return this.money(amountWithMargin);
  }

  private enrichHotelWithMasterMargin(hotel: any, hotelMasterByProviderCode: Map<string, any>): any {
    const provider = String(hotel?.provider || 'tbo').trim().toLowerCase();
    const hotelCode = String(hotel?.hotelCode || '').trim();
    const master = hotelMasterByProviderCode.get(`${provider}|${hotelCode}`);

    if (!master) {
      return hotel;
    }

    return {
      ...hotel,
      hotel_margin: Number(hotel?.hotel_margin || master.hotel_margin || 0),
      hotel_margin_gst_type: Number(hotel?.hotel_margin_gst_type || master.hotel_margin_gst_type || 0),
      hotel_margin_gst_percentage: Number(hotel?.hotel_margin_gst_percentage || master.hotel_margin_gst_percentage || 0),
    };
  }

  private shouldShowHotelMargins(): boolean {
    const raw = String(process.env.SHOW_HOTEL_MARGINS || '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }


  // Legacy mapping: IDs 101-295 were used by the old hardcoded dropdown list.
  // These do not match dvi_countries IDs, so we map them to country names for name-based lookup.
  private static readonly LEGACY_NATIONALITY_NAME: Record<number, string> = {
    101: 'India', 102: 'Afghanistan', 103: 'Albania', 104: 'Algeria', 105: 'Andorra',
    106: 'Angola', 107: 'Antigua and Barbuda', 108: 'Argentina', 109: 'Armenia',
    110: 'Australia', 111: 'Austria', 112: 'Azerbaijan', 113: 'Bahamas', 114: 'Bahrain',
    115: 'Bangladesh', 116: 'Barbados', 117: 'Belarus', 118: 'Belgium', 119: 'Belize',
    120: 'Benin', 121: 'Bhutan', 122: 'Bolivia', 123: 'Bosnia and Herzegovina',
    124: 'Botswana', 125: 'Brazil', 126: 'Brunei', 127: 'Bulgaria', 128: 'Burkina Faso',
    129: 'Burundi', 130: 'Cabo Verde', 131: 'Cambodia', 132: 'Cameroon', 133: 'Canada',
    134: 'Central African Republic', 135: 'Chad', 136: 'Chile', 137: 'China',
    138: 'Colombia', 139: 'Comoros', 140: 'Congo', 141: 'Costa Rica', 142: 'Croatia',
    143: 'Cuba', 144: 'Cyprus', 145: 'Czech Republic',
    146: 'Democratic Republic of the Congo', 147: 'Denmark', 148: 'Djibouti',
    149: 'Dominica', 150: 'Dominican Republic', 151: 'Ecuador', 152: 'Egypt',
    153: 'El Salvador', 154: 'Equatorial Guinea', 155: 'Eritrea', 156: 'Estonia',
    157: 'Eswatini', 158: 'Ethiopia', 159: 'Fiji', 160: 'Finland', 161: 'France',
    162: 'Gabon', 163: 'Gambia', 164: 'Georgia', 165: 'Germany', 166: 'Ghana',
    167: 'Greece', 168: 'Grenada', 169: 'Guatemala', 170: 'Guinea', 171: 'Guinea-Bissau',
    172: 'Guyana', 173: 'Haiti', 174: 'Honduras', 175: 'Hungary', 176: 'Iceland',
    177: 'India', 178: 'Indonesia', 179: 'Iran', 180: 'Iraq', 181: 'Ireland',
    182: 'Israel', 183: 'Italy', 184: 'Jamaica', 185: 'Japan', 186: 'Jordan',
    187: 'Kazakhstan', 188: 'Kenya', 189: 'Kiribati', 190: 'Kuwait', 191: 'Kyrgyzstan',
    192: 'Laos', 193: 'Latvia', 194: 'Lebanon', 195: 'Lesotho', 196: 'Liberia',
    197: 'Libya', 198: 'Liechtenstein', 199: 'Lithuania', 200: 'Luxembourg',
    201: 'Madagascar', 202: 'Malawi', 203: 'Malaysia', 204: 'Maldives', 205: 'Mali',
    206: 'Malta', 207: 'Marshall Islands', 208: 'Mauritania', 209: 'Mauritius',
    210: 'Mexico', 211: 'Micronesia', 212: 'Moldova', 213: 'Monaco', 214: 'Mongolia',
    215: 'Montenegro', 216: 'Morocco', 217: 'Mozambique', 218: 'Myanmar', 219: 'Namibia',
    220: 'Nauru', 221: 'Nepal', 222: 'Netherlands', 223: 'New Zealand', 224: 'Nicaragua',
    225: 'Niger', 226: 'Nigeria', 227: 'North Korea', 228: 'North Macedonia',
    229: 'Norway', 230: 'Oman', 231: 'Pakistan', 232: 'Palau', 233: 'Panama',
    234: 'Papua New Guinea', 235: 'Paraguay', 236: 'Peru', 237: 'Philippines',
    238: 'Poland', 239: 'Portugal', 240: 'Qatar', 241: 'Romania', 242: 'Russia',
    243: 'Rwanda', 244: 'Saint Kitts and Nevis', 245: 'Saint Lucia',
    246: 'Saint Vincent and the Grenadines', 247: 'Samoa', 248: 'San Marino',
    249: 'Sao Tome and Principe', 250: 'Saudi Arabia', 251: 'Senegal', 252: 'Serbia',
    253: 'Seychelles', 254: 'Sierra Leone', 255: 'Singapore', 256: 'Slovakia',
    257: 'Slovenia', 258: 'Solomon Islands', 259: 'Somalia', 260: 'South Africa',
    261: 'South Korea', 262: 'South Sudan', 263: 'Spain', 264: 'Sri Lanka',
    265: 'Sudan', 266: 'Suriname', 267: 'Sweden', 268: 'Switzerland', 269: 'Syria',
    270: 'Taiwan', 271: 'Tajikistan', 272: 'Tanzania', 273: 'Thailand',
    274: 'Timor-Leste', 275: 'Togo', 276: 'Tonga', 277: 'Trinidad and Tobago',
    278: 'Tunisia', 279: 'Turkey', 280: 'Turkmenistan', 281: 'Tuvalu', 282: 'Uganda',
    283: 'Ukraine', 284: 'United Arab Emirates', 285: 'United Kingdom',
    286: 'United States', 287: 'Uruguay', 288: 'Uzbekistan', 289: 'Vanuatu',
    290: 'Vatican City', 291: 'Venezuela', 292: 'Vietnam', 293: 'Yemen',
    294: 'Zambia', 295: 'Zimbabwe',
  };

  private async resolveGuestNationality(plan: any): Promise<string> {
    return this.guestNationalityService.resolve(plan, {
      findById: (id) =>
        this.prisma.dvi_countries.findFirst({
          where: { id, deleted: 0, status: 1 },
          select: { shortname: true, name: true },
        }),
      findByLegacyName: (name) =>
        this.prisma.dvi_countries.findFirst({
          where: { name: { contains: name }, deleted: 0, status: 1 },
          select: { shortname: true, name: true },
        }),
      legacyNameForId: (id) => ItineraryHotelDetailsTboService.LEGACY_NATIONALITY_NAME[id],
      log: (message) => this.logger.log(message),
      warn: (message) => this.logger.warn(message),
    });
  }



  /**
   * Get hotel details with dynamic packages from TBO API
   * Creates 4 different price tier packages: Budget, Mid-Range, Premium, Luxury
   */
  async getHotelDetailsByQuoteIdFromTbo(
    quoteId: string,
    page?: number,
    pageSize?: number,
    groupType?: number,
    itineraryRouteId?: number,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const startTime = Date.now();
    this.logger.log(`\nðŸ“¡ TBO HOTEL PACKAGES: Fetching dynamic packages for quote: ${quoteId}`);

    const hasCompatibilityFilters =
      page !== undefined ||
      pageSize !== undefined ||
      groupType !== undefined ||
      itineraryRouteId !== undefined;

    // Step 1: Get itinerary plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`âš ï¸  Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    // CACHE DISABLED - Always fetch fresh data from database
    // const cached = this.getCachedHotelDetails(quoteId);
    // if (cached) {
    //   return hasCompatibilityFilters
    //     ? this.applyCompatibilityFilters(
    //         cached,
    //         page,
    //         pageSize,
    //         groupType,
    //         itineraryRouteId,
    //       )
    //     : cached;
    // }

    const planId = plan.itinerary_plan_ID;
    const guestNationality = await this.resolveGuestNationality(plan);
    const preferredCategories = this.normalizeNumberList((plan as any).preferred_hotel_category);
    const explicitMealPlanCode = inferCanonicalHotelRatePlanCode(String((plan as any).meal_plan_code || ''));
    const mealPlanBreakfast = Number((plan as any).meal_plan_breakfast ?? 0) ? 1 : 0;
    const mealPlanLunch = Number((plan as any).meal_plan_lunch ?? 0) ? 1 : 0;
    const mealPlanDinner = Number((plan as any).meal_plan_dinner ?? 0) ? 1 : 0;
    const hasExplicitMealFlags =
      mealPlanBreakfast === 1 || mealPlanLunch === 1 || mealPlanDinner === 1;
    const fallbackMealPlanCode = hasExplicitMealFlags
      ? inferCanonicalHotelRatePlanCodeFromMealFlags(
          mealPlanBreakfast,
          mealPlanLunch,
          mealPlanDinner,
        )
      : null;
    const preferredMealPlanCode = explicitMealPlanCode || fallbackMealPlanCode;

    this.logger.log(`âœ… Found plan ID: ${planId}`);
    this.logger.log(
      `ðŸŽ›ï¸ Plan hotel prefs: categories=${preferredCategories.length ? preferredCategories.join(',') : 'ANY'}, ` +
        `mealPlan=${preferredMealPlanCode || 'ANY'}`,
    );

    // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    this.logger.log(`ðŸ“… Routes Query Result: ${JSON.stringify({
      total: routes.length,
      routes: routes.map(r => ({ id: (r as any).itinerary_route_ID, location: (r as any).location_name, date: (r as any).itinerary_route_date }))
    })}`);

    if (routes.length === 0) {
      this.logger.warn(`âš ï¸  No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

    this.logger.log(`ðŸ“… Found ${routes.length} routes to process`);

    // Get number of nights from plan to determine which routes need hotels
    const noOfNights = Number((plan as any).no_of_nights || 0);
    this.logger.log(`ðŸŒ™ Plan has ${noOfNights} nights`);

    // Read pax counts saved by the user when creating the itinerary
    const planRoomCount = Math.max(Number((plan as any).preferred_room_count || 1), 1);
    const planAdultCount = Number((plan as any).total_adult || 0);
    const planChildCount = Number((plan as any).total_children || 0);
    this.logger.log(
      `ðŸ‘¥ Pax from plan: rooms=${planRoomCount}, adults=${planAdultCount}, children=${planChildCount}`,
    );

    // Fetch child ages from saved travellers so the TBO search uses actual ages, not defaults.
    let planChildAges: number[] = [];
    if (planChildCount > 0) {
      const childTravellers = await this.prisma.dvi_itinerary_traveller_details.findMany({
        where: { itinerary_plan_ID: planId, traveller_type: 2, deleted: 0 },
        orderBy: { traveller_details_ID: 'asc' },
      });
      planChildAges = childTravellers
        .map((t) => Math.trunc(Number((t as any).traveller_age)))
        .filter((age) => Number.isFinite(age) && age >= 0 && age <= 11);
      this.logger.log(`ðŸ‘¦ Child ages from travellers: [${planChildAges.join(', ')}]`);
    }

    const restrictedHotelsByRoute = new Map<number, HotelSearchResult[]>();

    // Step 3: Fetch hotels from TBO for each route (except last route if it's departure day)
    const hotelsByRoute = await this.fetchHotelsForRoutesWithRetry(
      routes,
      noOfNights,
      guestNationality,
      planRoomCount,
      planAdultCount,
      planChildCount,
      planChildAges,
    );
    
    const tboOnlyFetch = this.isTboOnlyFetchEnabled();
    if (tboOnlyFetch) {
      this.logger.warn(
        'âš ï¸ HOTEL_FETCH_TBO_ONLY enabled: skipping HOBSE/ResAvenue/AxisRooms provider fetch and returning only TBO hotels',
      );
    } else {
      if (this.isHobseSearchEnabled()) {
        // Step 3.5: Fetch HOBSE hotels and merge with TBO hotels
        // First, create a HOBSE-specific city code map using hobse_city_code
        const hobseCityCodeMap = await this.batchMapDestinationsToHobseCityCodes(routes);
        const hobseHotelsByRoute = await this.fetchHobseHotelsForRoutes(routes, noOfNights, hobseCityCodeMap);

        // Merge HOBSE hotels into the TBO hotel map
        hobseHotelsByRoute.forEach((hobseHotels, routeId) => {
          const existingHotels = hotelsByRoute.get(routeId) || [];
          hotelsByRoute.set(routeId, [...existingHotels, ...hobseHotels]);
        });
      } else {
        this.logger.warn('âš ï¸ HOBSE_SEARCH_ENABLED=0: skipping HOBSE hotel search results');
      }

      // Step 3.6: Fetch ResAvenue hotels explicitly (in case they weren't included in TBO search)
      this.logger.log(`\n🏨 STEP 3.6: Starting ResAvenue hotel fetch for ${routes.length} routes...`);
      const resavenueHotelsByRoute = await this.fetchResavenueHotelsForRoutes(
        routes,
        noOfNights,
        guestNationality,
        planRoomCount,
        planAdultCount,
        planChildCount,
      );
      
      // Debug: Check what ResAvenue returned
      let totalResavenueHotels = 0;
      resavenueHotelsByRoute.forEach((hotels, routeId) => {
        totalResavenueHotels += hotels.length;
        if (hotels.length > 0) {
          this.logger.log(`   ✅ Route ${routeId} has ${hotels.length} ResAvenue hotels: ${hotels.map(h => `${h.hotelName} (${h.hotelCode})`).join(', ')}`);
        }
      });
      this.logger.log(`🏨 ResAvenue Total: ${totalResavenueHotels} hotels across all routes`);

      // Merge ResAvenue hotels into the hotel map
      resavenueHotelsByRoute.forEach((resavenueHotels, routeId) => {
        const existingHotels = hotelsByRoute.get(routeId) || [];
        // Avoid duplicates: check if hotel already exists by hotel code + provider
        const hotelStrs = existingHotels.map(h => `${h.hotelCode}|${h.provider}`);
        const newHotels = resavenueHotels.filter(h => !hotelStrs.includes(`${h.hotelCode}|${h.provider}`));
        if (newHotels.length > 0) {
          this.logger.log(`   ✅ Added ${newHotels.length} new ResAvenue hotel(s) to route ${routeId}`);
          newHotels.forEach(h => {
            this.logger.log(`      - ${h.hotelName} (${h.hotelCode}, Category: ${h.category}, Meal: ${h.mealPlan}, Price: ₹${h.price})`);
          });
        } else if (resavenueHotels.length > 0) {
          this.logger.log(`   ℹ️  No new ResAvenue hotels (duplicates: ${resavenueHotels.length})`);
        }
        const merged = [...existingHotels, ...newHotels];
        this.logger.log(`   Route ${routeId}: Total hotels now = ${merged.length}`);
        hotelsByRoute.set(routeId, merged);
      });

      // Step 3.7: Load saved meal plans per route for AxisRooms filtering
      const savedMealPlansByRoute = await this.loadSavedMealPlansPerRoute(planId, routes);

      // Step 3.8: Fetch AxisRooms-enabled hotels from local DB and merge with existing providers.
      const axisroomsHotelsByRoute = await this.fetchAxisroomsHotelsForRoutes(
        routes,
        noOfNights,
        savedMealPlansByRoute,
        preferredMealPlanCode,
      );
      axisroomsHotelsByRoute.forEach((axisroomsHotels, routeId) => {
        const existingHotels = hotelsByRoute.get(routeId) || [];
        const hotelStrs = existingHotels.map((h) => `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`);
        const newHotels = axisroomsHotels.filter(
          (h) => !hotelStrs.includes(`${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`),
        );
        if (newHotels.length > 0) {
          this.logger.log(`   âœ… Added ${newHotels.length} new AxisRooms hotel(s) to route ${routeId}`);
        }
        hotelsByRoute.set(routeId, [...existingHotels, ...newHotels]);
      });

      const staahHotelsByRoute = await this.fetchStaahHotelsForRoutes(
        routes,
        noOfNights,
        savedMealPlansByRoute,
        preferredMealPlanCode,
        true,
        {
          roomCount: planRoomCount,
          adults: planAdultCount,
          children: planChildCount,
          extraBedCount: Number((plan as any).total_extra_bed || 0),
          childWithBedCount: Number((plan as any).total_child_with_bed || 0),
          childWithoutBedCount: Number((plan as any).total_child_without_bed || 0),
        },
      );
      staahHotelsByRoute.forEach((staahHotels, routeId) => {
        const existingHotels = hotelsByRoute.get(routeId) || [];
        const hotelStrs = existingHotels.map((h) =>
          String((h as any).searchReference || `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`).trim(),
        );
        const selectableStaahHotels = staahHotels.filter(
          (h) => String((h as any).availabilityStatus || '').trim().toUpperCase() !== 'NOT_BOOKABLE',
        );
        const restrictedStaahHotels = staahHotels.filter(
          (h) => String((h as any).availabilityStatus || '').trim().toUpperCase() === 'NOT_BOOKABLE',
        );
        if (restrictedStaahHotels.length > 0) {
          restrictedHotelsByRoute.set(routeId, restrictedStaahHotels);
        }
        const newHotels = selectableStaahHotels.filter(
          (h) =>
            !hotelStrs.includes(
              String((h as any).searchReference || `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`).trim(),
            ),
        );
        if (newHotels.length > 0) {
          this.logger.log(`   ✅ Added ${newHotels.length} new STAAH hotel(s) to route ${routeId}`);
        }
        hotelsByRoute.set(routeId, [...existingHotels, ...newHotels]);
      });
    }

    this.logger.log(`[STAAH DEBUG] Counts before preference filters:`);
    Array.from(hotelsByRoute.entries()).forEach(([routeId, hotels]) => {
      const staahCount = Array.isArray(hotels) ? hotels.filter((h) => h.provider === 'staah').length : 0;
      this.logger.log(`   Route ${routeId}: STAAH before filter = ${staahCount}`);
    });
    
    const filteredHotelsByRoute = this.applyPlanPreferenceFilters(
      hotelsByRoute,
      preferredCategories,
      preferredMealPlanCode,
    );

    this.logger.log(`[STAAH DEBUG] Counts after preference filters:`);
    Array.from(filteredHotelsByRoute.entries()).forEach(([routeId, hotels]) => {
      const staahCount = Array.isArray(hotels) ? hotels.filter((h) => h.provider === 'staah').length : 0;
      this.logger.log(`   Route ${routeId}: STAAH after filter = ${staahCount}`);
    });

    // Debug: Check if any hotels were found
    const hotelEntries = Array.from(filteredHotelsByRoute.entries());
    this.logger.log(`\nðŸ“Š HOTEL FETCH RESULTS (ALL ENABLED PROVIDERS):`);
    hotelEntries.forEach(([routeId, hotels]) => {
      const tboCount = hotels.filter(h => h.provider === 'tbo').length;
      const hobseCount = hotels.filter(h => h.provider === 'hobse').length;
      const resavenueCount = hotels.filter(h => h.provider === 'resavenue').length;
      const axisroomsCount = hotels.filter(h => h.provider === 'axisrooms').length;
      const staahCount = hotels.filter(h => h.provider === 'staah').length;
      this.logger.log(`   Route ${routeId}: ${hotels.length} hotels (TBO: ${tboCount}, HOBSE: ${hobseCount}, ResAvenue: ${resavenueCount}, AxisRooms: ${axisroomsCount}, STAAH: ${staahCount})`);
      if (hotels.length > 0) {
     //   this.logger.log(`      - ${hotels.map(h => `${h.hotelName} (${h.provider})`).join(', ')}`);
      }
    });
    
    if (hotelEntries.every(([_, hotels]) => hotels.length === 0)) {
      this.logger.warn(`\nâŒ WARNING: ALL ROUTES RETURNED ZERO HOTELS!\n`);
    }
    
   // this.logger.log(`ðŸ¨ Hotels by Route: ${JSON.stringify(Object.fromEntries(hotelsByRoute))}`);

    // Step 4: Generate 4 price tier packages
    const packages = this.generatePricePackages(filteredHotelsByRoute, routes);

    // Step 5: Build response
    const response = await this.buildHotelDetailsResponse(
      quoteId,
      planId,
      packages,
      filteredHotelsByRoute,
      restrictedHotelsByRoute,
      routes,
      noOfNights,
    );

    const duration = Date.now() - startTime;
    this.logger.log(`âœ… Generated ${packages.length} hotel packages`);
    this.logger.log(`â±ï¸  Total TBO Service Time: ${duration}ms\n`);

    // this.setCachedHotelDetails(quoteId, response);

    return hasCompatibilityFilters
      ? this.applyCompatibilityFilters(
          response,
          page,
          pageSize,
          groupType,
          itineraryRouteId,
        )
      : response;
  }

  // Backward-compatible alias used by older controllers/callers.
  clearHotelCacheForQuote(quoteId: string): void {
    this.clearCacheForQuote(quoteId);
  }

  private applyCompatibilityFilters(
    response: ItineraryHotelDetailsResponseDto,
    page?: number,
    pageSize?: number,
    groupType?: number,
    itineraryRouteId?: number,
  ): ItineraryHotelDetailsResponseDto {
    const normalizedGroupType = Number.isFinite(Number(groupType))
      ? Number(groupType)
      : undefined;
    const normalizedRouteId = Number.isFinite(Number(itineraryRouteId))
      ? Number(itineraryRouteId)
      : undefined;

    let filteredHotels = [...(response.hotels || [])];
    if (normalizedGroupType && normalizedGroupType >= 1 && normalizedGroupType <= 4) {
      filteredHotels = filteredHotels.filter((h) => Number(h.groupType) === normalizedGroupType);
    }
    if (normalizedRouteId && normalizedRouteId > 0) {
      filteredHotels = filteredHotels.filter((h) => Number(h.itineraryRouteId) === normalizedRouteId);
    }

    return {
      ...response,
      hotels: filteredHotels,
      pagination: undefined,
      routePagination: undefined,
    };
  }

  /**
   * Fetch available hotels from TBO for each route with OPTIMIZED city mapping
   * Uses batch city lookup and parallel processing instead of sequential queries
   */
  private async fetchHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    guestNationality: string,
    roomCount: number = 1,
    adultCount: number = 2,
    childCount: number = 0,
    childAges: number[] = [],
  ): Promise<Map<number, HotelSearchResult[] | null>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[] | null>();

    // ðŸ”¥ OPTIMIZATION 1: Batch load ALL cities upfront instead of querying per route
    const cityCodeMap = await this.batchMapDestinationsToCityCodes(routes);
    this.logger.log(`âœ… Pre-loaded ${Object.keys(cityCodeMap).length} city codes for all routes`);

    // Build stay blocks so TBO search is done once per destination-stay window,
    // not once per day/route.
    const stayBlocks = this.buildStayBlocks(routes, noOfNights);
    this.logger.log(`ðŸ§© Built ${stayBlocks.length} stay block(s) for consolidated TBO search`);

    // ðŸ”¥ OPTIMIZATION 2: Prepare all hotel search tasks for parallel execution
    const searchTasks: Promise<void>[] = [];

    for (const block of stayBlocks) {
      searchTasks.push(
        this.searchHotelsForStayBlock(
          block,
          cityCodeMap,
          guestNationality,
          roomCount,
          adultCount,
          childCount,
          childAges,
        )
          .then((hotels) => {
            block.routeIds.forEach((routeId) => hotelsByRoute.set(routeId, hotels || []));
          })
          .catch((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(
              `âŒ HOTEL SEARCH ERROR for stay block ${block.destination} (${block.checkInDate} -> ${block.checkOutDate}): ${errorMsg}`,
            );
            block.routeIds.forEach((routeId) => hotelsByRoute.set(routeId, null)); // null = provider failure
          }),
      );
    }

    // ðŸ”¥ OPTIMIZATION 3: Execute all searches in parallel instead of sequentially
    this.logger.log(`â³ Starting ${searchTasks.length} parallel hotel searches...`);
    await Promise.all(searchTasks);
    this.logger.log(`âœ… All parallel searches completed`);

    return hotelsByRoute;
  }

  private buildStayBlocks(routes: any[], noOfNights: number): Array<{ destination: string; checkInDate: string; checkOutDate: string; routeIds: number[] }> {
    return this.stayBlockService.build(routes, noOfNights, (message) => this.logger.log(message));
  }

  /**
   * Batch load city codes for all destinations in one pass
   * Reduces database queries from NÃ—3 (N routes Ã— 3 attempts) to 1 query
   */
  private async batchMapDestinationsToCityCodes(routes: any[]): Promise<Record<string, string>> {
    return this.cityCodeService.map(routes, {
      loadCities: () =>
        this.prisma.dvi_cities.findMany({
          select: { id: true, name: true, tbo_city_code: true, status: true },
          orderBy: [{ status: 'desc' }, { id: 'asc' }],
        }),
      log: (message) => this.logger.log(message),
      warn: (message) => this.logger.warn(message),
    });
  }



  /**
     * Batch load HOBSE city codes for all destinations using hobse_city_code field.
     */
  private async batchMapDestinationsToHobseCityCodes(routes: any[]): Promise<Record<string, string>> {
    return this.cityCodeService.mapHobse(routes, {
      loadCities: () =>
        this.prisma.dvi_cities.findMany({
          select: { name: true, hobse_city_code: true } as any,
        }) as any,
      log: (message) => this.logger.log(message),
      warn: (message) => this.logger.warn(message),
    });
  }



  /**
   * Search hotels for a single route (used in parallel execution)
   */
  private async searchHotelsForStayBlock(
    block: {
      destination: string;
      checkInDate: string;
      checkOutDate: string;
      routeIds: number[];
    },
    cityCodeMap: Record<string, string>,
    guestNationality: string,
    roomCount: number = 1,
    adultCount: number = 2,
    childCount: number = 0,
    childAges: number[] = [],
  ): Promise<HotelSearchResult[]> {
    const destination = block.destination;

    this.logger.log(
      `ðŸ” Stay block (${block.routeIds.join(',')}): Searching hotels for "${destination}" (${block.checkInDate} -> ${block.checkOutDate})`,
    );

    // Get city code from pre-loaded map (no database query!)
    const cityCode = cityCodeMap[destination];

    // Fallback: if dvi_cities mapping is missing, use destination text directly.
    const effectiveCityCode = cityCode || destination;
    if (!cityCode) {
      this.logger.warn(
        `âš ï¸ Stay block (${block.routeIds.join(',')}): No mapped TBO city code for "${destination}". Falling back to destination text lookup.`,
      );
    }

    // Use pax counts from the plan; guarantee at least 1 adult so TBO validation passes
    if (adultCount <= 0) {
      this.logger.warn(
        `âš ï¸ Stay block (${block.routeIds.join(',')}): adultCount is ${adultCount} (not saved in plan?) - defaulting to 1`,
      );
    }
    const safeAdultCount = adultCount > 0 ? adultCount : 1;
    const safeChildCount = childCount >= 0 ? childCount : 0;
    const guestCount = safeAdultCount + safeChildCount;
    const safeRoomCount = Math.max(Number(roomCount || 1), 1);

    const tboOnlyFetch = this.isTboOnlyFetchEnabled();
    const searchProviders = tboOnlyFetch ? ['tbo'] : ['tbo', 'resavenue'];

    const searchCriteria = {
      cityCode: effectiveCityCode,
      checkInDate: block.checkInDate,
      checkOutDate: block.checkOutDate,
      roomCount: safeRoomCount,
      guestCount,
      adultCount: safeAdultCount,
      childCount: safeChildCount,
      childAges: childAges.length > 0 ? childAges : undefined,
      guestNationality,
      providers: searchProviders,
    };

    this.logger.log(
      `   ðŸ¨ Searching hotels with cityCode: ${effectiveCityCode}, checkIn: ${block.checkInDate}, checkOut: ${block.checkOutDate}`,
    );
    const hotels = await this.hotelSearchService.searchHotels(searchCriteria);
    this.logger.log(
      `   âœ… Found ${hotels ? hotels.length : 0} hotels for stay block (${block.routeIds.join(',')}) (TBO only at this stage)`,
    );
    
    if (hotels && hotels.length > 0) {
      this.logger.log(`   ðŸ“‹ TBO Hotels for stay block (${block.routeIds.join(',')}):`);
      hotels.forEach((h, idx) => {
      //  this.logger.log(`      ${idx + 1}. ${h.hotelName} (${h.provider}) - â‚¹${h.price}`);
      });
    } else {
      this.logger.log(`   âš ï¸  WARNING: TBO search returned ZERO hotels for stay block (${block.routeIds.join(',')})!`);
    }

    return hotels || [];
  }

  /**
   * Fetch HOBSE hotels for each route
   * Maps destinations to HOBSE city codes and calls HOBSE provider
   */
  private async fetchHobseHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    cityCodeMap: Record<string, string>,
  ): Promise<Map<number, HotelSearchResult[]>> {
    return this.secondaryProviderFetchService.fetchHobse(routes, noOfNights, cityCodeMap, {
      searchHobse: (input) => this.hobseProvider.search(input),
      log: (message) => this.logger.log(message),
      warn: (message) => this.logger.warn(message),
      error: (message) => this.logger.error(message),
    });
  }

  private async fetchResavenueHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    guestNationality: string,
    roomCount: number = 1,
    adultCount: number = 2,
    childCount: number = 0,
  ): Promise<Map<number, HotelSearchResult[]>> {
    return this.secondaryProviderFetchService.fetchResavenue(
      routes,
      noOfNights,
      guestNationality,
      roomCount,
      adultCount,
      childCount,
      {
        searchResavenue: (input) => this.hotelSearchService.searchHotels(input),
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
        error: (message) => this.logger.error(message),
      },
    );
  }



  private normalizeCityToken(value: string): string {
    const token = String(value || '')
      .trim()
      .toLowerCase()
      .split(/[,(\-]/)[0]
      .trim();
    const aliases: Record<string, string> = {
      cochin: 'kochi',
      alleppey: 'alappuzha',
      alleppe: 'alappuzha',
      calicut: 'kozhikode',
      trivandrum: 'thiruvananthapuram',
      pondicherry: 'puducherry',
      bangalore: 'bengaluru',
    };
    return aliases[token] || token;
  }

  private toIstDateOnly(value: unknown): Date {
    const raw = new Date(String(value || ''));
    if (Number.isNaN(raw.getTime())) {
      throw new Error(`Invalid route date: ${String(value || '')}`);
    }

    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istMoment = new Date(raw.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(
      istMoment.getUTCFullYear(),
      istMoment.getUTCMonth(),
      istMoment.getUTCDate(),
      0,
      0,
      0,
      0,
    ));
  }

  private extractAxisroomsRate(occupancyRates: unknown): number {
    try {
      const data = occupancyRates as Record<string, unknown>;
      if (!data || typeof data !== 'object') return 0;

      const preferredKeys = ['SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD', 'EXTRABED'];
      for (const key of preferredKeys) {
        const value = Number(data[key]);
        if (Number.isFinite(value) && value > 0) return value;
      }

      for (const value of Object.values(data)) {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) return num;
      }
    } catch {
      return 0;
    }

    return 0;
  }

  private extractStaahRate(occupancyRates: unknown): number {
    return calculateStaahOccupancyAmount(occupancyRates, { roomCount: 1, adults: 1 }).finalCalculatedAmount;
  }

  private formatDateOnly(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private getStaahRestrictionAvailableAgainFrom(row: any): string | null {
    if (!row?.end_date) return null;
    return this.formatDateOnly(this.addDays(this.toIstDateOnly(row.end_date), 1));
  }

  private buildStaahRestrictionAvailabilityMessage(
    reason: string | null,
    availableAgainFrom: string | null,
  ): string {
    const rawReason = String(reason || '').trim();
    let baseReason = rawReason || 'This room is not available for the selected stay.';

    const ctaMatch = rawReason.match(/CTA active on check-in date\s+(\d{4}-\d{2}-\d{2})/i);
    if (ctaMatch) {
      baseReason = `This room cannot be booked for arrival on ${ctaMatch[1]}. Check-in is closed for that date.`;
    }

    const ctdMatch = rawReason.match(/CTD active on check-out date\s+(\d{4}-\d{2}-\d{2})/i);
    if (ctdMatch) {
      baseReason = `This room cannot be booked for departure on ${ctdMatch[1]}. Check-out is closed for that date.`;
    }

    if (/stopsell/i.test(rawReason)) {
      baseReason = 'This room is closed for sale for the selected stay dates.';
    }

    if (/minimum stay/i.test(rawReason)) {
      baseReason = rawReason;
    }

    if (!availableAgainFrom) {
      return baseReason;
    }
    return `${baseReason} You can try booking it again from ${availableAgainFrom}.`;
  }

  private isStaahRestrictionTruthy(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'close', 'closed'].includes(normalized);
  }

  private normalizeStaahRestrictionType(value: unknown): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'status') return 'status';
    if (normalized.includes('stopsell') || normalized.includes('stop_sell')) return 'stopsell';
    if (normalized === 'cta') return 'cta';
    if (normalized === 'ctd') return 'ctd';
    if (normalized === 'minstay') return 'minstay';
    if (normalized === 'maxstay') return 'maxstay';
    if (normalized === 'minstay_through') return 'minstay_through';
    if (normalized === 'maxstay_through') return 'maxstay_through';
    return normalized;
  }

  private getStaahStayWindow(
    routes: any[],
    routeIndex: number,
  ): { checkInDate: Date; checkOutDate: Date; lengthOfStay: number } {
    const currentRoute = routes[routeIndex];
    const checkInDate = this.toIstDateOnly((currentRoute as any).itinerary_route_date);

    const nextRoute = routes[routeIndex + 1];
    const nextRouteDate = nextRoute
      ? this.toIstDateOnly((nextRoute as any).itinerary_route_date)
      : this.addDays(checkInDate, 1);

    const diffMs = nextRouteDate.getTime() - checkInDate.getTime();
    const lengthOfStay = Math.max(Math.round(diffMs / 86400000), 1);

    return {
      checkInDate,
      checkOutDate: nextRouteDate,
      lengthOfStay,
    };
  }

  private evaluateStaahRestrictions(
    rows: any[],
    checkInDate: Date,
    checkOutDate: Date,
    lengthOfStay: number,
  ): { blocked: boolean; reason: string | null; availableAgainFrom: string | null } {
    return this.staahRestrictionService.evaluate(rows, checkInDate, checkOutDate, lengthOfStay);
  }



  /**
   * Load saved meal plan codes for each route in the itinerary
   * Maps route IDs to their configured meal plan codes (e.g., "AP", "CP", "EP", "MAP")
   */
  private async loadSavedMealPlansPerRoute(
    planId: number,
    routes: any[],
  ): Promise<Map<number, string>> {
    const mealPlansByRoute = new Map<number, string>();
    
    try {
      // Fetch saved hotel details with rateplan_id to determine meal plan
      const savedHotels = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: planId,
          deleted: 0,
        },
        select: {
          itinerary_route_id: true,
          group_type: true,
        },
      });

      // For now, just track that this route has a saved hotel (we'll filter by first rate plan found)
      for (const hotel of savedHotels as any[]) {
        const routeId = Number((hotel as any).itinerary_route_id || 0);
        if (routeId > 0) {
          mealPlansByRoute.set(routeId, 'SAVED'); // Mark as saved (not a fresh search)
        }
      }

      if (mealPlansByRoute.size > 0) {
        this.logger.log(`âœ… Found ${mealPlansByRoute.size} routes with saved hotels`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`âš ï¸ Failed to load saved hotel indicators: ${errorMsg}`);
    }

    return mealPlansByRoute;
  }

  private async fetchAxisroomsHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    savedMealPlansByRoute?: Map<number, string>,
    preferredMealPlanCode?: string | null,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const totalRoutes = routes.length;

    this.logger.log(`\nðŸ¨ AXISROOMS HOTEL FETCH: Attempting to fetch AxisRooms hotels for ${routes.length} routes`);

    const axisroomsHotels = await this.prisma.dvi_hotel.findMany({
      where: {
        axisrooms_enabled: 1,
        status: 1,
        OR: [{ deleted: false }, { deleted: null }],
      } as any,
      select: {
        hotel_id: true,
        hotel_name: true,
        hotel_city: true,
        hotel_address: true,
        hotel_category: true,
        hotel_cancel_policy: true,
      },
    });

    if (!axisroomsHotels.length) {
      this.logger.log('   â„¹ï¸  No axisrooms-enabled hotels found in local DB');
      return hotelsByRoute;
    }

    // hotel_city may be stored as a numeric city ID string (e.g. "1979") or a plain name.
    // Build a map from city id -> city name so both cases resolve correctly.
    const numericCityIds = Array.from(
      new Set(
        axisroomsHotels
          .map((h: any) => Number((h as any).hotel_city))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );
    const cityIdNameMap = new Map<number, string>();
    if (numericCityIds.length > 0) {
      const cityRows = await this.prisma.dvi_cities.findMany({
        where: { id: { in: numericCityIds } },
        select: { id: true, name: true },
      });
      for (const c of cityRows as any[]) {
        cityIdNameMap.set(Number((c as any).id), String((c as any).name || ''));
      }
    }

    for (let routeIndex = 0; routeIndex < totalRoutes; routeIndex++) {
      const route = routes[routeIndex];
      const routeId = Number((route as any).itinerary_route_ID);
      const isLastRoute = routeIndex === totalRoutes - 1;
      if (isLastRoute && routeIndex >= noOfNights) {
        this.logger.log(`   â­ï¸  Skipping AxisRooms route ${routeIndex + 1} (last route - departure day)`);
        continue;
      }

      const destinationRaw = String((route as any).next_visiting_location || '');
      const routeCityToken = this.normalizeCityToken(destinationRaw);
      const dateOnly = this.toIstDateOnly((route as any).itinerary_route_date);
      const dateStamp = dateOnly.toISOString().split('T')[0].replace(/-/g, '');

      const cityHotels = axisroomsHotels.filter((h: any) => {
        const rawCity = String((h as any).hotel_city || '');
        // Resolve: if it looks like a numeric ID, look up the actual city name
        const numId = Number(rawCity);
        const resolvedCity = (Number.isFinite(numId) && numId > 0 && cityIdNameMap.has(numId))
          ? cityIdNameMap.get(numId)!
          : rawCity;
        const hotelCityToken = this.normalizeCityToken(resolvedCity);
        return !!hotelCityToken && hotelCityToken === routeCityToken;
      });

      if (!cityHotels.length) {
        hotelsByRoute.set(routeId, []);
        this.logger.log(`   â„¹ï¸  AxisRooms Route ${routeId}: No axisrooms hotels mapped for city ${destinationRaw}`);
        continue;
      }

      const hotelIds = cityHotels.map((h: any) => Number((h as any).hotel_id)).filter((id) => Number.isFinite(id) && id > 0);

      const amenityRows = await this.prisma.dvi_hotel_amenities.findMany({
        where: {
          hotel_id: { in: hotelIds },
          deleted: 0,
          status: 1,
        } as any,
        select: {
          hotel_id: true,
          amenities_title: true,
        },
      });
      const amenitiesByHotel = new Map<number, string[]>();
      for (const amenity of amenityRows as any[]) {
        const hid = Number((amenity as any).hotel_id || 0);
        if (!hid) continue;
        const title = String((amenity as any).amenities_title || '').trim();
        if (!title) continue;
        if (!amenitiesByHotel.has(hid)) {
          amenitiesByHotel.set(hid, []);
        }
        amenitiesByHotel.get(hid)!.push(title);
      }
      const availRows = await this.prisma.dvi_hotel_room_availability.findMany({
        where: {
          hotel_id: { in: hotelIds },
          start_date: { lte: dateOnly },
          end_date: { gte: dateOnly },
          free: { gt: 0 },
        },
        select: {
          hotel_id: true,
          room_id: true,
          free: true,
        },
      });

      if (!availRows.length) {
        hotelsByRoute.set(routeId, []);
        this.logger.log(`   â„¹ï¸  AxisRooms Route ${routeId}: No available inventory for ${destinationRaw} on ${dateOnly.toISOString().split('T')[0]}`);
        continue;
      }

      const roomIds = Array.from(new Set(availRows.map((r) => Number((r as any).room_id)).filter((id) => Number.isFinite(id) && id > 0)));

      // AxisRooms gate: keep only rooms that have an active AxisRooms-mapped rate plan
      // (axisrooms_room_id NOT NULL = mapped from inbound AxisRooms room/rateplan setup).
      // Occupancy rows may be sourced from AxisRooms or manual admin updates; we do not hard-filter source here.
      const activeRatePlanRows = await this.prisma.dvi_hotel_room_rate_plan.findMany({
        where: {
          hotel_id: { in: hotelIds },
          room_id: { in: roomIds },
          axisrooms_room_id: { not: null },
          deleted: 0,
          status: 1,
        } as any,
        select: {
          hotel_id: true,
          room_id: true,
          rateplan_id: true,
          rateplan_name: true,
          meal_plan_description: true,
        },
      });

      const ratePlanMetaByHotelRoom = new Map<string, { rateConditions: string[]; inclusions: string[] }>();
      for (const rp of activeRatePlanRows as any[]) {
        const key = `${Number((rp as any).hotel_id)}|${Number((rp as any).room_id)}`;
        if (!ratePlanMetaByHotelRoom.has(key)) {
          ratePlanMetaByHotelRoom.set(key, { rateConditions: [], inclusions: [] });
        }
        const meta = ratePlanMetaByHotelRoom.get(key)!;
        const rateCondition = String((rp as any).rateplan_name || '').trim();
        const inclusion = String((rp as any).meal_plan_description || '').trim();
        if (rateCondition) {
          meta.rateConditions.push(rateCondition);
        }
        if (inclusion) {
          meta.inclusions.push(inclusion);
        }
      }
              const mealPlanByRatePlan = new Map<string, string>();
              for (const rp of activeRatePlanRows as any[]) {
                const rateplanId = String((rp as any).rateplan_id || '').trim();
                const mealPlanDesc = String((rp as any).meal_plan_description || '').trim();
                if (rateplanId && mealPlanDesc && !mealPlanByRatePlan.has(rateplanId)) {
                  mealPlanByRatePlan.set(rateplanId, mealPlanDesc);
                }
              }
              const validRatePlanKeySet = new Set<string>(
        activeRatePlanRows.map(
          (rp: any) => `${Number((rp as any).hotel_id)}|${Number((rp as any).room_id)}|${String((rp as any).rateplan_id || '')}`,
        ),
      );

      const occupancyRowsRaw = await this.prisma.dvi_hotel_occupancy_rate.findMany({
        where: {
          hotel_id: { in: hotelIds },
          room_id: { in: roomIds },
          start_date: { lte: dateOnly },
          end_date: { gte: dateOnly },
        },
        select: {
          hotel_id: true,
          room_id: true,
          rateplan_id: true,
          occupancy_rates: true,
        },
      });

      const occupancyRows = occupancyRowsRaw.filter((row: any) => {
        const key = `${Number((row as any).hotel_id)}|${Number((row as any).room_id)}|${String((row as any).rateplan_id || '')}`;
        return validRatePlanKeySet.has(key);
      });

      const roomMeta = await this.prisma.dvi_hotel_rooms.findMany({
        where: {
          room_ID: { in: roomIds as any },
          deleted: 0,
        } as any,
        select: {
          room_ID: true,
          room_title: true,
        },
      });
      const roomTitleMap = new Map<number, string>(
        roomMeta.map((r: any) => [Number((r as any).room_ID), String((r as any).room_title || 'Room')]),
      );

      const availableRoomByHotel = new Map<number, Set<number>>();
      for (const row of availRows as any[]) {
        const hid = Number((row as any).hotel_id);
        const rid = Number((row as any).room_id);
        if (!availableRoomByHotel.has(hid)) {
          availableRoomByHotel.set(hid, new Set<number>());
        }
        availableRoomByHotel.get(hid)!.add(rid);
      }

      const axisroomsRouteHotels: HotelSearchResult[] = [];

      for (const hotel of cityHotels as any[]) {
        const hid = Number((hotel as any).hotel_id);
        const roomSet = availableRoomByHotel.get(hid);
        if (!roomSet || roomSet.size === 0) {
          continue;
        }

        // Group occupancy rows by rateplan_id and extract rate from each plan
        const ratesByPlan = new Map<string, { rate: number; roomId: number }>();

        for (const occ of occupancyRows as any[]) {
          if (Number((occ as any).hotel_id) !== hid) continue;
          const rid = Number((occ as any).room_id);
          if (!roomSet.has(rid)) continue;

          const rateplanId = String((occ as any).rateplan_id || '').trim();
          if (!rateplanId) continue;

          // Only extract rate if we haven't found one for this rate plan yet
          if (!ratesByPlan.has(rateplanId)) {
            const extractedRate = this.extractAxisroomsRate((occ as any).occupancy_rates);
            if (extractedRate > 0) {
              ratesByPlan.set(rateplanId, { rate: extractedRate, roomId: rid });
            }
          }
        }

        if (ratesByPlan.size === 0) {
          this.logger.warn(
            `   ??  AxisRooms Route ${routeId}: Hotel ${hid} - No valid rates found in any occupancy row for this hotel/room (checked ${occupancyRows.filter((o: any) => Number((o as any).hotel_id) === hid).length} rows)`
          );
          continue; // No valid rates found for any meal plan
        }

        const preferredCode = String(preferredMealPlanCode || '').trim().toUpperCase();
        const preferredDef = preferredCode
          ? HOTEL_RATE_PLAN_BY_CODE.get(preferredCode as any)
          : undefined;
        const preferredRatePlanCandidates = [
          String(preferredDef?.defaultRateplanId || '').trim(),
          String(preferredDef?.externalRateplanId || '').trim(),
        ].filter((x) => !!x);

        let selectedRateplanId = '';
        let selectedRate = Number.POSITIVE_INFINITY;
        let selectedRoomId = 0;

        for (const candidate of preferredRatePlanCandidates) {
          const hit = ratesByPlan.get(candidate);
          if (hit) {
            selectedRateplanId = candidate;
            selectedRate = Number(hit.rate);
            selectedRoomId = Number(hit.roomId);
            break;
          }
        }

        // Fallback: if preferred meal plan isn't present for this hotel, pick the lowest available rate plan.
        if (!selectedRateplanId) {
          for (const [rpid, hit] of ratesByPlan.entries()) {
            const rateVal = Number(hit.rate);
            if (Number.isFinite(rateVal) && rateVal > 0 && rateVal < selectedRate) {
              selectedRateplanId = rpid;
              selectedRate = rateVal;
              selectedRoomId = Number(hit.roomId);
            }
          }
        }

        if (!selectedRateplanId || !Number.isFinite(selectedRate) || selectedRate <= 0 || !selectedRoomId) {
          continue;
        }

        const rate = selectedRate;

        const roomName = roomTitleMap.get(selectedRoomId) || 'Room';
        const hotelAmenities = Array.from(new Set(amenitiesByHotel.get(hid) || []));
        const rateMeta = ratePlanMetaByHotelRoom.get(`${hid}|${selectedRoomId}`) || {

          rateConditions: [],
          inclusions: [],
        };
        const rateConditions = Array.from(new Set(rateMeta.rateConditions));
        const inclusions = Array.from(new Set(rateMeta.inclusions));
        const cancelPolicyText = String((hotel as any).hotel_cancel_policy || '').trim();

        const selectedMealPlan = mealPlanByRatePlan.get(selectedRateplanId) || '-';

        axisroomsRouteHotels.push({
          provider: 'axisrooms',
          hotelCode: String(hid),
          hotelName: String((hotel as any).hotel_name || `Hotel ${hid}`),
          cityCode: String((hotel as any).hotel_city || destinationRaw),
          address: String((hotel as any).hotel_address || ''),
          rating: Number((hotel as any).hotel_category || 0),
          facilities: hotelAmenities,
          amenities: hotelAmenities,
          inclusions,
          rateConditions,
          cancellationPolicy: cancelPolicyText ? [cancelPolicyText] : [],
          images: [],
          price: Number(rate),
          currency: 'INR',
          roomTypes: [
            {
              roomCode: String(selectedRoomId),
              roomName,
              bedType: '',
              capacity: 0,
              price: Number(rate),
              cancellationPolicy: cancelPolicyText,
            },
          ],
          roomType: roomName,
          mealPlan: selectedMealPlan,
          searchReference: `AX-${hid}-${dateStamp}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });
      }

      hotelsByRoute.set(routeId, axisroomsRouteHotels);
      const droppedByRatePlanGate = Math.max(occupancyRowsRaw.length - occupancyRows.length, 0);
      this.logger.log(
        `   âœ… AxisRooms Route ${routeId}: Found ${axisroomsRouteHotels.length} hotels in ${destinationRaw} (ratePlan-gated, droppedRows=${droppedByRatePlanGate})`,
      );
    }

    return hotelsByRoute;
  }

  private async fetchStaahHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    savedMealPlansByRoute?: Map<number, string>,
    preferredMealPlanCode?: string | null,
    includeRestrictedForDisplay: boolean = false,
    paxProfile?: StaahPricingPaxInput,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    let staahHotels: any[] = [];
    try {
      staahHotels = await this.prisma.dvi_hotel.findMany({
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
          hotel_cancel_policy: true,
          staah_property_id: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
        },
      });
    } catch (error) {
      this.logger.error(`[STAAH] Failed loading STAAH-enabled hotels: ${error instanceof Error ? error.message : String(error)}`);
      return hotelsByRoute;
    }
    staahHotels = staahHotels.filter((hotel: any) => String(hotel?.staah_property_id || '').trim().length > 0);
    if (!staahHotels.length) return hotelsByRoute;
    const cityIds = Array.from(new Set(staahHotels.map((h: any) => Number((h as any).hotel_city)).filter((x) => Number.isFinite(x) && x > 0)));
    const cityRows = cityIds.length ? await this.prisma.dvi_cities.findMany({ where: { id: { in: cityIds } }, select: { id: true, name: true } }) : [];
    const cityMap = new Map<number, string>(cityRows.map((c: any) => [Number(c.id), String(c.name || '')]));

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      try {
        const route = routes[routeIndex];
        const routeId = Number((route as any).itinerary_route_ID);
        const isLastRoute = routeIndex === routes.length - 1;
        if (isLastRoute && routeIndex >= noOfNights) continue;
        const destinationRaw = String((route as any).next_visiting_location || '');
        const routeCityToken = this.normalizeCityToken(destinationRaw);
        const { checkInDate: dateOnly, checkOutDate, lengthOfStay } = this.getStaahStayWindow(routes, routeIndex);
        const dateStamp = dateOnly.toISOString().split('T')[0].replace(/-/g, '');
        const cityHotels = staahHotels.filter((h: any) => {
          const raw = String((h as any).hotel_city || '');
          const nid = Number(raw);
          const resolved = Number.isFinite(nid) && nid > 0 && cityMap.has(nid) ? cityMap.get(nid)! : raw;
          const hotelCityToken = this.normalizeCityToken(resolved);
          const cityMatch = !!hotelCityToken && hotelCityToken === routeCityToken;
          return cityMatch;
        });
        if (!cityHotels.length) {
          this.logger.log(`[STAAH DEBUG] routeId=${routeId} matched STAAH city hotels=0`);
          hotelsByRoute.set(routeId, []);
          continue;
        }
        const propertyIds = cityHotels.map((h: any) => String((h as any).staah_property_id || '').trim()).filter(Boolean);
        if (!propertyIds.length) {
          this.logger.debug(`[STAAH] routeId=${routeId} no valid propertyId found on STAAH-enabled hotels`);
          hotelsByRoute.set(routeId, []);
          continue;
        }
        const hotelIds = cityHotels
          .map((h: any) => Number(h.hotel_id || 0))
          .filter((id) => Number.isFinite(id) && id > 0);
        const activeAdminRooms = hotelIds.length
          ? await this.prisma.dvi_hotel_rooms.findMany({
              where: {
                hotel_id: { in: hotelIds },
                status: 1,
                deleted: 0,
              } as any,
              select: {
                hotel_id: true,
                room_ID: true,
                room_ref_code: true,
                room_title: true,
              } as any,
            })
          : [];
        const activeRoomCodesByHotelId = new Map<number, Set<string>>();
        const activeRoomLooseCodesByHotelId = new Map<number, Set<string>>();
        const activeRoomLooseExactCodesByHotelId = new Map<number, Map<string, Set<string>>>();
        const roomTitleByHotelAndCode = new Map<string, string>();
        for (const room of activeAdminRooms as any[]) {
          const hotelId = Number(room.hotel_id || 0);
          const exactCode = this.normalizeExactRoomCode(room.room_ref_code);
          const looseCode = this.normalizeLooseRoomCode(room.room_ref_code);
          const roomTitle = String(room.room_title || '').trim();
          if (!hotelId || !exactCode) continue;

          if (!activeRoomCodesByHotelId.has(hotelId)) {
            activeRoomCodesByHotelId.set(hotelId, new Set<string>());
          }
          if (!activeRoomLooseCodesByHotelId.has(hotelId)) {
            activeRoomLooseCodesByHotelId.set(hotelId, new Set<string>());
          }
          if (!activeRoomLooseExactCodesByHotelId.has(hotelId)) {
            activeRoomLooseExactCodesByHotelId.set(hotelId, new Map<string, Set<string>>());
          }

          activeRoomCodesByHotelId.get(hotelId)!.add(exactCode);
          activeRoomLooseCodesByHotelId.get(hotelId)!.add(looseCode);

          const looseMap = activeRoomLooseExactCodesByHotelId.get(hotelId)!;
          if (!looseMap.has(looseCode)) {
            looseMap.set(looseCode, new Set<string>());
          }
          looseMap.get(looseCode)!.add(exactCode);

          roomTitleByHotelAndCode.set(`${hotelId}|${exactCode}`, roomTitle);
          roomTitleByHotelAndCode.set(`${hotelId}|${looseCode}`, roomTitle);
        }
        const allowedRoomCodesByPropertyId = new Map<string, Set<string>>();
        const allowedLooseRoomCodesByPropertyId = new Map<string, Set<string>>();
        const allowedLooseExactCodesByPropertyId = new Map<string, Map<string, Set<string>>>();
        const hotelIdByPropertyId = new Map<string, number>();
        for (const hotel of cityHotels as any[]) {
          const propertyId = String(hotel.staah_property_id || '').trim();
          const hotelId = Number(hotel.hotel_id || 0);
          if (!propertyId || !hotelId) continue;

          hotelIdByPropertyId.set(propertyId, hotelId);
          allowedRoomCodesByPropertyId.set(
            propertyId,
            activeRoomCodesByHotelId.get(hotelId) || new Set<string>(),
          );
          allowedLooseRoomCodesByPropertyId.set(
            propertyId,
            activeRoomLooseCodesByHotelId.get(hotelId) || new Set<string>(),
          );
          allowedLooseExactCodesByPropertyId.set(
            propertyId,
            activeRoomLooseExactCodesByHotelId.get(hotelId) || new Map<string, Set<string>>(),
          );
        }
        const loggedStaahSkippedRooms = new Set<string>();
        const isAllowedStaahRoom = (propertyIdValue: unknown, roomIdValue: unknown): boolean => {
          const propertyId = String(propertyIdValue || '').trim();
          const roomIdExact = this.normalizeExactRoomCode(roomIdValue);
          const roomIdLoose = this.normalizeLooseRoomCode(roomIdValue);
          const logKey = `${propertyId}|${roomIdExact}`;
          const exactCodes = allowedRoomCodesByPropertyId.get(propertyId);
          const looseCodes = allowedLooseRoomCodesByPropertyId.get(propertyId);
          const looseExactCodes = allowedLooseExactCodesByPropertyId.get(propertyId);

          if (!exactCodes || exactCodes.size === 0) {
            if (!loggedStaahSkippedRooms.has(logKey)) {
              loggedStaahSkippedRooms.add(logKey);
              this.logger.warn(
                `[STAAH STALE ROOM SKIPPED] routeId=${routeId} propertyId=${propertyId} providerRoomId=${roomIdExact}. No active dvi_hotel_rooms.room_ref_code mapping found for hotel/property.`,
              );
            }
            return false;
          }

          if (exactCodes.has(roomIdExact)) {
            return true;
          }

          const looseMatches = looseExactCodes?.get(roomIdLoose);
          if (looseCodes?.has(roomIdLoose) && looseMatches && looseMatches.size === 1) {
            if (!loggedStaahSkippedRooms.has(logKey)) {
              loggedStaahSkippedRooms.add(logKey);
              this.logger.warn(
                `[STAAH STALE ROOM SKIPPED] routeId=${routeId} propertyId=${propertyId} providerRoomId=${roomIdExact}. Only normalized match found (${Array.from(looseMatches).join(', ')}); exact active room_ref_code required.`,
              );
            }
            return false;
          }

          if (!loggedStaahSkippedRooms.has(logKey)) {
            loggedStaahSkippedRooms.add(logKey);
            this.logger.warn(
              `[STAAH STALE ROOM SKIPPED] routeId=${routeId} propertyId=${propertyId} providerRoomId=${roomIdExact}. Not found in active dvi_hotel_rooms.room_ref_code.`,
            );
          }
          return false;
        };

        const [inventoryRowsRaw, ratePlanRowsRaw] = await Promise.all([
          (this.prisma as any).staah_inventory.findMany({ where: { staah_property_id: { in: propertyIds }, start_date: { lte: dateOnly }, end_date: { gte: dateOnly }, free: { gt: 0 } } }),
          (this.prisma as any).staah_rateplan.findMany({ where: { staah_property_id: { in: propertyIds } } }),
        ]);
        const inventoryRows = (inventoryRowsRaw as any[]).filter((row) =>
          isAllowedStaahRoom(row.staah_property_id, row.room_id),
        );
        const ratePlanRows = (ratePlanRowsRaw as any[]).filter((row) =>
          isAllowedStaahRoom(row.staah_property_id, row.room_id),
        );
        const roomIds = Array.from(new Set(inventoryRows.map((r: any) => String(r.room_id || '').trim()).filter(Boolean)));
        const ratePlanIds = Array.from(new Set(ratePlanRows.map((r: any) => String(r.rateplan_id || '').trim()).filter(Boolean)));
        if (!roomIds.length || !ratePlanIds.length) {
          this.logger.debug(
            `[STAAH] routeId=${routeId} propertyIds=${propertyIds.join(',')} inventory=${inventoryRows.length} rateplans=${ratePlanRows.length} rates=0`,
          );
          hotelsByRoute.set(routeId, []);
          continue;
        }
        const [rateRowsRaw, restrictionRows] = await Promise.all([
          (this.prisma as any).staah_rate.findMany({ where: { staah_property_id: { in: propertyIds }, room_id: { in: roomIds }, rateplan_id: { in: ratePlanIds }, start_date: { lte: dateOnly }, end_date: { gte: dateOnly } } }),
          (this.prisma as any).staah_restriction.findMany({ where: { staah_property_id: { in: propertyIds }, room_id: { in: roomIds }, rateplan_id: { in: ratePlanIds }, start_date: { lte: checkOutDate }, end_date: { gte: dateOnly } } }),
        ]);
        const rateRows = (rateRowsRaw as any[]).filter((row) =>
          isAllowedStaahRoom(row.staah_property_id, row.room_id),
        );
        const restrictionRowsByRateKey = new Map<string, any[]>();
        for (const row of restrictionRows as any[]) {
          const rateKey = `${row.staah_property_id}|${row.room_id}|${row.rateplan_id}`;
          if (!restrictionRowsByRateKey.has(rateKey)) {
            restrictionRowsByRateKey.set(rateKey, []);
          }
          restrictionRowsByRateKey.get(rateKey)!.push(row);
        }
        const results: HotelSearchResult[] = [];
        for (const hotel of cityHotels as any[]) {
          const propertyId = String((hotel as any).staah_property_id || '').trim();
          const hotelId = Number((hotel as any).hotel_id || 0);
          if (!propertyId) {
            this.logger.debug(`[STAAH] routeId=${routeId} hotelId=${String((hotel as any).hotel_id || '')} skipped: missing staah_property_id`);
            continue;
          }
          const propertyInventoryRows = (inventoryRows as any[]).filter((r) => String((r as any).staah_property_id || '') === propertyId);
          const propertyRatePlanRows = (ratePlanRows as any[]).filter((r) => String((r as any).staah_property_id || '') === propertyId);
          const rows = (rateRows as any[]).filter((r) => String((r as any).staah_property_id || '') === propertyId);
          this.logger.debug(
            `[STAAH] routeId=${routeId} propertyId=${propertyId} hotelId=${String((hotel as any).hotel_id || '')} inventory=${propertyInventoryRows.length} rateplans=${propertyRatePlanRows.length} rates=${rows.length}`,
          );
          if (!propertyInventoryRows.length || !propertyRatePlanRows.length || !rows.length) {
            continue;
          }
          let selected: any = null;
          let selectedMatchedPreferred = false;
          let selectedReason = 'no valid rate';
          let best = Number.POSITIVE_INFINITY;
          const validDisplayCandidates: Array<{
            rate: any;
            rp: any;
            price: number;
          }> = [];
          const blockedDisplayCandidates: Array<{
            rate: any;
            rp: any;
            price: number;
            reason: string;
            availableAgainFrom: string | null;
          }> = [];
          for (const rate of rows) {
            const rateKey = `${rate.staah_property_id}|${rate.room_id}|${rate.rateplan_id}`;
            const rp = (ratePlanRows as any[]).find(
              (x) =>
                String(x.staah_property_id) === String(rate.staah_property_id) &&
                String(x.rateplan_id) === String(rate.rateplan_id),
            );
            const roomId = String((rate as any).room_id || '');
            if (!isAllowedStaahRoom(propertyId, roomId)) {
              this.logger.warn(
                `[STAAH STALE ROOM SKIPPED IN RATE LOOP] routeId=${routeId} propertyId=${propertyId} roomId=${roomId}`,
              );
              continue;
            }
            const exactRoomCode = this.normalizeExactRoomCode(roomId);
            const looseRoomCode = this.normalizeLooseRoomCode(roomId);
            const roomName =
              roomTitleByHotelAndCode.get(`${hotelId}|${exactRoomCode}`) ||
              roomTitleByHotelAndCode.get(`${hotelId}|${looseRoomCode}`) ||
              `Room ${roomId}`;
            const rateplanId = String((rate as any).rateplan_id || '');
            const rateplanName = String((rp as any)?.rateplan_name || '').trim();
            const mealPlanDescription = String((rp as any)?.meal_plan_description || '').trim();
            const candidatePrice =
              paxProfile && Object.keys(paxProfile).length > 0
                ? calculateStaahOccupancyAmount((rate as any).occupancy_rates, paxProfile).finalCalculatedAmount
                : this.extractStaahRate((rate as any).occupancy_rates);
            const restrictionDecision = this.evaluateStaahRestrictions(
              restrictionRowsByRateKey.get(rateKey) || [],
              dateOnly,
              checkOutDate,
              lengthOfStay,
            );
            this.logger.debug(
              `[STAAH CANDIDATE] routeId=${routeId} propertyId=${propertyId} hotelId=${String((hotel as any).hotel_id || '')} roomId=${roomId} roomName="${roomName}" rateplanId=${rateplanId} rateplanName="${rateplanName}" mealPlan="${mealPlanDescription}" price=${candidatePrice} blocked=${restrictionDecision.blocked ? 'true' : 'false'} reason="${restrictionDecision.reason || ''}" availableAgainFrom=${restrictionDecision.availableAgainFrom || ''} searchReference=STAAH-${propertyId}-${roomId}-${rateplanId}-${dateStamp}`,
            );
            if (restrictionDecision.blocked) {
              selectedReason = restrictionDecision.reason || `restriction blocked rateplan ${String((rate as any).rateplan_id || '')}`;
              this.logger.warn(
                `[STAAH RESTRICTION] routeId=${routeId} propertyId=${propertyId} hotelId=${String((hotel as any).hotel_id || '')} roomId=${String((rate as any).room_id || '')} rateplanId=${String((rate as any).rateplan_id || '')} checkIn=${this.formatDateOnly(dateOnly)} checkOut=${this.formatDateOnly(checkOutDate)} los=${lengthOfStay} blocked=true reason="${selectedReason}"`,
              );
              if (includeRestrictedForDisplay) {
                blockedDisplayCandidates.push({
                  rate,
                  rp,
                  price: candidatePrice,
                  reason: selectedReason,
                  availableAgainFrom: restrictionDecision.availableAgainFrom,
                });
              }
              continue;
            }
            const price = candidatePrice;
            if (price <= 0) {
              selectedReason = `no positive price for rateplan ${String((rate as any).rateplan_id || '')}`;
              continue;
            }
            validDisplayCandidates.push({ rate, rp, price });
            const preferredCode = String(preferredMealPlanCode || '').trim().toUpperCase();
            const preferredDef = preferredCode ? HOTEL_RATE_PLAN_BY_CODE.get(preferredCode as any) : undefined;
            const preferredIds = [String(preferredDef?.defaultRateplanId || ''), String(preferredDef?.externalRateplanId || '')].filter(Boolean);
            const mealText = `${String((rp as any)?.rateplan_name || '')} ${String((rp as any)?.meal_plan_description || '')}`.toLowerCase();
            const preferHit = preferredCode && (preferredIds.includes(String((rate as any).rateplan_id || '')) || mealText.includes(preferredCode.toLowerCase()));
            if (preferHit || price < best) {
              if (!selected || price < best) {
                selected = { rate, rp, price };
                best = price;
                selectedMatchedPreferred = Boolean(preferHit);
                selectedReason = preferHit ? `matched preferred meal plan ${preferredCode}` : 'selected cheapest valid rate';
              }
            }
          }
          const preferredCode = String(preferredMealPlanCode || '').trim().toUpperCase();
          const preferredDef = preferredCode ? HOTEL_RATE_PLAN_BY_CODE.get(preferredCode as any) : undefined;
          const preferredIds = [
            String(preferredDef?.defaultRateplanId || ''),
            String(preferredDef?.externalRateplanId || ''),
          ].filter(Boolean);
          const preferredBlocked = blockedDisplayCandidates.find((candidate) => {
            if (!preferredCode) return false;
            const mealText = `${String(candidate.rp?.rateplan_name || '')} ${String(candidate.rp?.meal_plan_description || '')}`.toLowerCase();
            return preferredIds.includes(String((candidate.rate as any).rateplan_id || '')) || mealText.includes(preferredCode.toLowerCase());
          });
          const cheapestBlocked =
            blockedDisplayCandidates.length > 0
              ? [...blockedDisplayCandidates].sort((a, b) => {
                  const priceA = Number.isFinite(Number(a.price)) && Number(a.price) > 0 ? Number(a.price) : Number.POSITIVE_INFINITY;
                  const priceB = Number.isFinite(Number(b.price)) && Number(b.price) > 0 ? Number(b.price) : Number.POSITIVE_INFINITY;
                  return priceA - priceB;
                })[0]
              : null;
          const blockedCandidate =
            preferredBlocked ||
            cheapestBlocked;

          const shouldSurfaceBlockedPreferred =
            includeRestrictedForDisplay &&
            Boolean(blockedCandidate) &&
            (
              !selected ||
              (Boolean(preferredCode) && Boolean(preferredBlocked) && !selectedMatchedPreferred)
            );

          const shouldSurfaceBlockedVariant =
            includeRestrictedForDisplay &&
            !preferredCode &&
            Boolean(blockedCandidate) &&
            Boolean(selected);

          this.logger.debug(
            `[STAAH DECISION] routeId=${routeId} propertyId=${propertyId} hotelId=${String((hotel as any).hotel_id || '')} selectedRoomId=${String((selected as any)?.rate?.room_id || '')} selectedRateplanId=${String((selected as any)?.rate?.rateplan_id || '')} selectedMealPlan="${String((selected as any)?.rp?.meal_plan_description || (selected as any)?.rp?.rateplan_name || '').trim()}" selectedPrice=${Number((selected as any)?.price || 0)} selectedMatchedPreferred=${selectedMatchedPreferred ? 'true' : 'false'} blockedCandidateRoomId=${String((blockedCandidate as any)?.rate?.room_id || '')} blockedCandidateRateplanId=${String((blockedCandidate as any)?.rate?.rateplan_id || '')} blockedCandidateMealPlan="${String((blockedCandidate as any)?.rp?.meal_plan_description || (blockedCandidate as any)?.rp?.rateplan_name || '').trim()}" blockedCandidatePrice=${Number((blockedCandidate as any)?.price || 0)} shouldSurfaceBlockedPreferred=${shouldSurfaceBlockedPreferred ? 'true' : 'false'} shouldSurfaceBlockedVariant=${shouldSurfaceBlockedVariant ? 'true' : 'false'} selectedReason="${selectedReason}"`,
          );

          const pushedStaahResultKeys = new Set<string>();
          const pushStaahResult = (
            candidate: {
              rate: any;
              rp: any;
              price: number;
              reason?: string;
              availableAgainFrom?: string | null;
            },
            isBookable: boolean,
          ) => {
            const roomId = String((candidate.rate as any).room_id || '');
            const rateplanId = String((candidate.rate as any).rateplan_id || '');
            const resultKey = `${roomId}|${rateplanId}|${isBookable ? 'bookable' : 'restricted'}`;
            if (pushedStaahResultKeys.has(resultKey)) {
              return;
            }
            if (!isAllowedStaahRoom(propertyId, roomId)) {
              this.logger.warn(
                `[STAAH STALE ROOM SKIPPED IN RESULT PUSH] routeId=${routeId} propertyId=${propertyId} roomId=${roomId}`,
              );
              return;
            }
            pushedStaahResultKeys.add(resultKey);
            const cancellation = String((hotel as any).hotel_cancel_policy || '').trim();
            const mealPlan =
              String((candidate.rp as any)?.meal_plan_description || (candidate.rp as any)?.rateplan_name || '-').trim() || '-';
            const currency = String((candidate.rp as any)?.currency || 'INR').trim() || 'INR';
            const exactRoomCode = this.normalizeExactRoomCode(roomId);
            const looseRoomCode = this.normalizeLooseRoomCode(roomId);
            const hotelIdForProperty = hotelIdByPropertyId.get(propertyId) || hotelId;
            const roomName =
              roomTitleByHotelAndCode.get(`${hotelIdForProperty}|${exactRoomCode}`) ||
              roomTitleByHotelAndCode.get(`${hotelIdForProperty}|${looseRoomCode}`) ||
              `Room ${roomId}`;
            results.push({
              provider: 'staah',
              hotelCode: String((hotel as any).hotel_id),
              hotelName: String((hotel as any).hotel_name || ''),
              cityCode: String((hotel as any).hotel_city || destinationRaw),
              address: String((hotel as any).hotel_address || ''),
              rating: Number((hotel as any).hotel_category || 0),
              facilities: [],
              amenities: [],
              inclusions: [],
              rateConditions: [],
              cancellationPolicy: cancellation ? [cancellation] : [],
              images: [],
              price: Number(candidate.price || 0),
              currency,
              roomTypes: [{
                roomCode: roomId,
                roomName,
                bedType: '',
                capacity: 0,
                price: Number(candidate.price || 0),
                cancellationPolicy: cancellation,
              }],
              roomType: roomName,
              mealPlan,
              hotel_margin: Number((hotel as any).hotel_margin || 0),
              hotel_margin_gst_type: Number((hotel as any).hotel_margin_gst_type || 0),
              hotel_margin_gst_percentage: Number((hotel as any).hotel_margin_gst_percentage || 0),
              searchReference: `STAAH-${propertyId}-${roomId}-${rateplanId}-${dateStamp}`,
              expiresAt: new Date(Date.now() + 15 * 60 * 1000),
              isMappedAdminRoom: true,
              providerRoomId: roomId,
              isBookable,
              externalStay: false,
              availabilityStatus: isBookable ? 'AVAILABLE' : 'NOT_BOOKABLE',
              availabilityMessage: isBookable
                ? ''
                : this.buildStaahRestrictionAvailabilityMessage(
                    candidate.reason,
                    candidate.availableAgainFrom,
                  ),
              availableAgainFrom: candidate.availableAgainFrom ?? null,
            } as any);
          };

          if (shouldSurfaceBlockedPreferred && blockedCandidate) {
            pushStaahResult(blockedCandidate, false);
            continue;
          }

          if (shouldSurfaceBlockedVariant && blockedCandidate) {
            pushStaahResult(blockedCandidate, false);
          }

          if (!selected) {
            this.logger.debug(
              `[STAAH] routeId=${routeId} propertyId=${propertyId} hotelId=${String((hotel as any).hotel_id || '')} skipped: ${selectedReason}`,
            );
            continue;
          }
          for (const candidate of validDisplayCandidates) {
            pushStaahResult(candidate, true);
          }
        }
        hotelsByRoute.set(routeId, results);
      } catch (error) {
        const routeId = Number((routes[routeIndex] as any)?.itinerary_route_ID || 0);
        this.logger.error(`[STAAH] Route ${routeId} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (routeId > 0) hotelsByRoute.set(routeId, []);
      }
    }
    return hotelsByRoute;
  }


  private generatePricePackages(
    hotelsByRoute: Map<number, HotelSearchResult[] | null>,
    routes: any[],
  ): Array<{ groupType: number; label: string; hotels: Array<HotelSearchResult & { routeId: number }> }> {
    return this.pricePackageService.generate(hotelsByRoute, routes, {
      log: (message) => this.logger.log(message),
      warn: (message) => this.logger.warn(message),
      debug: (message) => this.logger.debug(message),
      money: (value) => this.money(value),
      applyInvisibleHotelMargin: (amount, hotel) =>
        this.applyInvisibleHotelMargin(amount, hotel),
    });
  }



  /**
   * Build the response DTO
   */
  private async buildHotelDetailsResponse(
    quoteId: string,
    planId: number,
    packages: Array<{ groupType: number; label: string; hotels: Array<HotelSearchResult & { routeId: number }> }>,
    hotelsByRoute: Map<number, HotelSearchResult[]>,
    restrictedHotelsByRoute: Map<number, HotelSearchResult[]>,
    routes: any[],
    noOfNights: number,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      select: { hotel_rates_visibility: true },
    });

    const hotelRatesVisible =
      Number((plan as any)?.hotel_rates_visibility || 0) === 1 ||
      (plan as any)?.hotel_rates_visibility === true;

    // Build hotel tabs (one per package with total cost)
    const marginProviderCodeSet = new Set<string>();
    for (const pkg of packages) {
      for (const hotel of pkg.hotels || []) {
        const provider = String((hotel as any)?.provider || 'tbo').trim().toLowerCase();
        const hotelCode = String((hotel as any)?.hotelCode || '').trim();
        if (provider && hotelCode) {
          marginProviderCodeSet.add(`${provider}|${hotelCode}`);
        }
      }
    }

    const marginTboCodes = Array.from(marginProviderCodeSet)
      .filter((k) => k.startsWith('tbo|'))
      .map((k) => k.slice('tbo|'.length));
    const marginResavenueCodes = Array.from(marginProviderCodeSet)
      .filter((k) => k.startsWith('resavenue|'))
      .map((k) => k.slice('resavenue|'.length));
    const marginHobseCodes = Array.from(marginProviderCodeSet)
      .filter((k) => k.startsWith('hobse|'))
      .map((k) => k.slice('hobse|'.length));
    const marginAxisroomsHotelIds = Array.from(marginProviderCodeSet)
      .filter((k) => k.startsWith('axisrooms|'))
      .map((k) => Number(k.slice('axisrooms|'.length)))
      .filter((id) => Number.isFinite(id) && id > 0);
    const marginStaahHotelIds = Array.from(marginProviderCodeSet)
      .filter((k) => k.startsWith('staah|'))
      .map((k) => Number(k.slice('staah|'.length)))
      .filter((id) => Number.isFinite(id) && id > 0);

    const marginHotelMasters = marginProviderCodeSet.size
      ? await this.prisma.dvi_hotel.findMany({
          where: {
            OR: [
              ...(marginTboCodes.length ? [{ tbo_hotel_code: { in: marginTboCodes } }] : []),
              ...(marginResavenueCodes.length ? [{ resavenue_hotel_code: { in: marginResavenueCodes } }] : []),
              ...(marginHobseCodes.length ? [{ hotel_code: { in: marginHobseCodes } }] : []),
              ...(marginAxisroomsHotelIds.length ? [{ hotel_id: { in: marginAxisroomsHotelIds } }] : []),
              ...(marginStaahHotelIds.length ? [{ hotel_id: { in: marginStaahHotelIds } }] : []),
            ],
          },
          select: {
            hotel_id: true,
            tbo_hotel_code: true,
            resavenue_hotel_code: true,
            hotel_code: true,
            hotel_margin: true,
            hotel_margin_gst_type: true,
            hotel_margin_gst_percentage: true,
          },
        })
      : [];

    const marginHotelMasterByProviderCode = new Map<string, any>();
    for (const hm of marginHotelMasters as any[]) {
      const tboCode = String((hm as any).tbo_hotel_code || '').trim();
      const resavenueCode = String((hm as any).resavenue_hotel_code || '').trim();
      const hobseCode = String((hm as any).hotel_code || '').trim();
      const hotelId = Number((hm as any).hotel_id || 0);

      if (tboCode) marginHotelMasterByProviderCode.set(`tbo|${tboCode}`, hm);
      if (resavenueCode) marginHotelMasterByProviderCode.set(`resavenue|${resavenueCode}`, hm);
      if (hobseCode) marginHotelMasterByProviderCode.set(`hobse|${hobseCode}`, hm);
      if (hotelId > 0) marginHotelMasterByProviderCode.set(`axisrooms|${hotelId}`, hm);
      if (hotelId > 0) marginHotelMasterByProviderCode.set(`staah|${hotelId}`, hm);
    }

    const hotelTabs: ItineraryHotelTabDto[] = packages.map((pkg) => {
      const totalAmount = this.money(
        pkg.hotels.reduce((sum, h) => {
          const pricedHotel = this.enrichHotelWithMasterMargin(h, marginHotelMasterByProviderCode);
          return sum + this.applyInvisibleHotelMargin(Number(pricedHotel.price || 0), pricedHotel);
        }, 0),
      );
      return {
        groupType: pkg.groupType,
        label: pkg.label,
        totalAmount,
      };
    });

    // Fetch all hotel details from database to get IDs and voucher status
    const hotelDetailsInDb = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0 },
      select: {
        itinerary_plan_hotel_details_ID: true,
        itinerary_route_id: true,
        hotel_id: true,
        group_type: true,
      },
    });

    // Fetch voucher cancellation statuses
    const hotelDetailsIds = hotelDetailsInDb.map(h => h.itinerary_plan_hotel_details_ID);
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

    // Create maps for quick lookup
    const detailsMap = new Map(
      hotelDetailsInDb.map(d => [
        `${d.itinerary_route_id}-${d.hotel_id}-${d.group_type}`,
        d.itinerary_plan_hotel_details_ID
      ])
    );
    
    const voucherStatusMap = new Map(
      voucherStatuses.map(v => [
        v.itinerary_plan_hotel_details_ID,
        v.hotel_voucher_cancellation_status === 1
      ])
    );

    // Preload route destination coordinates and hotel coordinates for distance calculation.
    const routeLocationIds = Array.from(
      new Set(
        routes
          .map((r: any) => Number((r as any).location_id || 0))
          .filter((id: number) => id > 0),
      ),
    );

    const storedLocations = routeLocationIds.length
      ? await this.prisma.dvi_stored_locations.findMany({
          where: { location_ID: { in: routeLocationIds }, deleted: 0 },
          select: {
            location_ID: true,
            destination_location_lattitude: true,
            destination_location_longitude: true,
          },
        })
      : [];

    const routeDestinationCoordsByLocationId = new Map<number, { lat: number; lon: number }>();
    for (const loc of storedLocations as any[]) {
      const lat = Number((loc as any).destination_location_lattitude ?? 0);
      const lon = Number((loc as any).destination_location_longitude ?? 0);
      if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
        routeDestinationCoordsByLocationId.set(Number((loc as any).location_ID), { lat, lon });
      }
    }

    const providerCodeSet = new Set<string>();
    for (const pkg of packages) {
      for (const h of pkg.hotels) {
        const provider = String((h as any).provider || 'tbo').trim().toLowerCase();
        const code = String((h as any).hotelCode || '').trim();
        if (!code) continue;
        providerCodeSet.add(`${provider}|${code}`);
      }
    }

    const tboCodes = Array.from(providerCodeSet)
      .filter((k) => k.startsWith('tbo|'))
      .map((k) => k.slice(4));
    const resavenueCodes = Array.from(providerCodeSet)
      .filter((k) => k.startsWith('resavenue|'))
      .map((k) => k.slice('resavenue|'.length));
    const hobseCodes = Array.from(providerCodeSet)
      .filter((k) => k.startsWith('hobse|'))
      .map((k) => k.slice(6));
    const axisroomsCodes = Array.from(providerCodeSet)
      .filter((k) => k.startsWith('axisrooms|'))
      .map((k) => k.slice('axisrooms|'.length));
    const axisroomsHotelIds = axisroomsCodes
      .map((code) => Number(code))
      .filter((id) => Number.isFinite(id) && id > 0);
    const staahHotelIds = Array.from(providerCodeSet)
      .filter((k) => k.startsWith('staah|'))
      .map((k) => Number(k.slice('staah|'.length)))
      .filter((id) => Number.isFinite(id) && id > 0);

    const hotelMasters = providerCodeSet.size
      ? await this.prisma.dvi_hotel.findMany({
          where: {
            OR: [
              ...(tboCodes.length
                ? [{ tbo_hotel_code: { in: tboCodes } }]
                : []),
              ...(resavenueCodes.length
                ? [{ resavenue_hotel_code: { in: resavenueCodes } }]
                : []),
              ...(hobseCodes.length
                ? [{ hotel_code: { in: hobseCodes } }]
                : []),
              ...(axisroomsHotelIds.length
                ? [{ hotel_id: { in: axisroomsHotelIds } }]
                : []),
              ...(staahHotelIds.length
                ? [{ hotel_id: { in: staahHotelIds } }]
                : []),
            ],
          },
          select: {
            hotel_id: true,
            tbo_hotel_code: true,
            resavenue_hotel_code: true,
            hotel_code: true,
            hotel_latitude: true,
            hotel_longitude: true,
            hotel_margin: true,
            hotel_margin_gst_type: true,
            hotel_margin_gst_percentage: true,
          },
        })
      : [];

    const hotelCoordsByProviderCode = new Map<string, { lat: number; lon: number }>();
    const hotelMasterByProviderCode = new Map<string, any>();
    for (const hm of hotelMasters as any[]) {
      const lat = Number((hm as any).hotel_latitude ?? 0);
      const lon = Number((hm as any).hotel_longitude ?? 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) {
        continue;
      }

      const tboCode = String((hm as any).tbo_hotel_code || '').trim();
      const resavenueCode = String((hm as any).resavenue_hotel_code || '').trim();
      const hobseCode = String((hm as any).hotel_code || '').trim();
      const hotelId = Number((hm as any).hotel_id || 0);

      if (tboCode) hotelCoordsByProviderCode.set(`tbo|${tboCode}`, { lat, lon });
      if (resavenueCode) hotelCoordsByProviderCode.set(`resavenue|${resavenueCode}`, { lat, lon });
      if (hobseCode) hotelCoordsByProviderCode.set(`hobse|${hobseCode}`, { lat, lon });
      if (hotelId > 0) hotelCoordsByProviderCode.set(`axisrooms|${hotelId}`, { lat, lon });
      if (hotelId > 0) hotelCoordsByProviderCode.set(`staah|${hotelId}`, { lat, lon });

      if (tboCode) hotelMasterByProviderCode.set(`tbo|${tboCode}`, hm);
      if (resavenueCode) hotelMasterByProviderCode.set(`resavenue|${resavenueCode}`, hm);
      if (hobseCode) hotelMasterByProviderCode.set(`hobse|${hobseCode}`, hm);
      if (hotelId > 0) hotelMasterByProviderCode.set(`axisrooms|${hotelId}`, hm);
      if (hotelId > 0) hotelMasterByProviderCode.set(`staah|${hotelId}`, hm);
    }

    // Fallback: TBO static master has wider code coverage than dvi_hotel in many environments.
    if (tboCodes.length > 0) {
      const tboMasterRows = await this.prisma.tbo_hotel_master.findMany({
        where: { tbo_hotel_code: { in: tboCodes } },
        select: {
          tbo_hotel_code: true,
          hotel_latitude: true,
          hotel_longitude: true,
        },
      });

      for (const row of tboMasterRows as any[]) {
        const code = String((row as any).tbo_hotel_code || '').trim();
        const lat = Number((row as any).hotel_latitude ?? 0);
        const lon = Number((row as any).hotel_longitude ?? 0);
        if (!code || !Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) {
          continue;
        }

        const key = `tbo|${code}`;
        if (!hotelCoordsByProviderCode.has(key)) {
          hotelCoordsByProviderCode.set(key, { lat, lon });
        }
      }
    }

    // STAAH confirmed booking override map (latest row per route)
    const confirmedStaahRows = await (this.prisma as any).staah_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: planId,
        status: 1,
        deleted: 0,
      },
      orderBy: { staah_hotel_booking_confirmation_ID: 'desc' },
    });
    const confirmedStaahByRouteId = new Map<number, any>();
    for (const row of confirmedStaahRows as any[]) {
      const routeId = Number((row as any).itinerary_route_ID || 0);
      if (routeId > 0 && !confirmedStaahByRouteId.has(routeId)) {
        confirmedStaahByRouteId.set(routeId, row);
      }
    }
    console.log('[STAAH_OVERRIDE_DEBUG]', {
      planId,
      confirmedStaahCount: confirmedStaahRows.length,
      rows: (confirmedStaahRows as any[]).map((r) => ({
        id: r.staah_hotel_booking_confirmation_ID,
        routeId: r.itinerary_route_ID,
        hotelCode: r.staah_hotel_code,
        bookingReference: r.staah_booking_reference,
        status: r.status,
        deleted: r.deleted,
        hasCancellation: !!(r.api_response as any)?.cancellation,
      })),
    });

    // Build hotel rows (detail rows for each package)
    const hotelRows: ItineraryHotelRowDto[] = [];

    for (const pkg of packages) {
      for (const hotel of pkg.hotels) {
        const route = routes.find((r: any) => r.itinerary_route_ID === hotel.routeId);
        if (!route) {
          this.logger.warn(`Route ${hotel.routeId} not found for hotel ${hotel.hotelName}`);
          continue;
        }

        const routeIndex = routes.indexOf(route);
        const isLastRoute = routeIndex === routes.length - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
          this.logger.log(`Skipping route ${hotel.routeId} from response (departure day)`);
          continue;
        }

        hotelRows.push(this.hotelResponseRowService.buildSupplierRow({
          route,
          routeIndex,
          groupType: pkg.groupType,
          hotel,
          detailsMap,
          voucherStatusMap,
          routeDestinationCoordsByLocationId,
          hotelCoordsByProviderCode,
          callbacks: {
            enrichHotelWithMasterMargin: (value) => this.enrichHotelWithMasterMargin(value, new Map()),
            applyInvisibleHotelMargin: (amount, value) => this.applyInvisibleHotelMargin(amount, value),
            getHotelMarginPercentage: (value) => this.getHotelMarginPercentage(value),
            parseStaahSearchReference: (reference) => this.parseStaahSearchReference(reference),
            getGroupTypeFromPrice: (price, prices) => this.getGroupTypeFromPrice(price, prices),
            debug: (message) => this.logger.debug(message),
          },
        }));
      }
    }



    // Override only matching routes with confirmed STAAH booking rows.
    this.staahConfirmedBookingOverrideService.apply(
      hotelRows,
      confirmedStaahByRouteId,
      quoteId,
      planId,
      {
        parseSearchReference: (reference) => this.parseStaahSearchReference(reference),
        log: (message) => this.logger.log(message),
        debug: (value) => console.log('[STAAH_OVERRIDE]', value),
      },
    );



    const restrictedHotelRows: ItineraryHotelRowDto[] = [];
    restrictedHotelsByRoute.forEach((restrictedHotels, routeId) => {
      const route = routes.find((r: any) => Number((r as any).itinerary_route_ID || 0) === routeId);
      if (!route) return;

      const routeIndex = routes.indexOf(route);
      const isLastRoute = routeIndex === routes.length - 1;
      if (isLastRoute && routeIndex >= noOfNights) {
        return;
      }

      const dateLabel = new Date((route as any).itinerary_route_date).toISOString().split('T')[0];
      const destination = (route as any).next_visiting_location || (route as any).location_name || '';
      const routeLocationId = Number((route as any).location_id || 0);
      const routeCoords = routeDestinationCoordsByLocationId.get(routeLocationId);
      const selectableHotelsForRoute = hotelsByRoute.get(routeId) || [];
      const allPrices = [...selectableHotelsForRoute, ...restrictedHotels]
        .map((hotel) => Number((hotel as any).price || 0))
        .filter((price) => Number.isFinite(price) && price > 0);

      restrictedHotels.forEach((hotel: any) => {
        const providerCodeKey = `${String(hotel.provider || 'staah').trim().toLowerCase()}|${String(hotel.hotelCode || '').trim()}`;
        const hotelCoords = hotelCoordsByProviderCode.get(providerCodeKey);
        let hotelDistance: string | null = null;
        if (routeCoords && hotelCoords) {
          try {
            const distanceKm = haversineKm(routeCoords.lat, routeCoords.lon, hotelCoords.lat, hotelCoords.lon);
            if (Number.isFinite(distanceKm) && distanceKm > 0) {
              hotelDistance = `${distanceKm.toFixed(2)} KM`;
            }
          } catch {
            hotelDistance = null;
          }
        }

        restrictedHotelRows.push(this.hotelResponseRowService.buildRestrictedRow({
          route,
          routeIndex,
          hotel,
          allPrices,
          routeDestinationCoordsByLocationId,
          hotelCoordsByProviderCode,
          callbacks: {
            enrichHotelWithMasterMargin: (value) => value,
            applyInvisibleHotelMargin: (amount, value) => this.applyInvisibleHotelMargin(amount, value),
            getHotelMarginPercentage: (value) => this.getHotelMarginPercentage(value),
            parseStaahSearchReference: (reference) => this.parseStaahSearchReference(reference),
            getGroupTypeFromPrice: (price, prices) => this.getGroupTypeFromPrice(price, prices),
          },
        }));
      });
    });

    const supplierRouteGroupKeys = new Set(
      hotelRows
        .filter(
          (row) =>
            row.isBookable !== false &&
            row.hotelName !== 'No Hotels Available',
        )
        .map((row) => `${row.itineraryRouteId}:${row.groupType}`),
    );

    const cleanedHotelRows = hotelRows.filter((row) => {
      const routeGroupKey = `${row.itineraryRouteId}:${row.groupType}`;
      const hasSupplierSibling = supplierRouteGroupKeys.has(routeGroupKey);
      const isStaleZeroCostExternal =
        row.externalStay === true &&
        row.provider === 'external' &&
        Number(row.totalHotelCost || 0) <= 0 &&
        Number(row.itineraryPlanHotelDetailsId || 0) <= 0 &&
        row.hotelName !== 'No Hotels Available';

      return !(hasSupplierSibling && isStaleZeroCostExternal);
    });

    const supplierHotelRows = cleanedHotelRows.filter(
      (row) => row.isBookable !== false && row.hotelName !== 'No Hotels Available',
    );
    const placeholderRows = cleanedHotelRows.filter(
      (row) => row.externalStay === true || row.hotelName === 'No Hotels Available' || row.isBookable === false,
    );

    const searchableRouteIds = routes
      .filter((route, index) => {
        const isLastRoute = index === routes.length - 1;
        return !(isLastRoute && index >= noOfNights);
      })
      .map((route: any) => Number(route.itinerary_route_ID));

    const totalSearchRoutes = searchableRouteIds.length;
    const emptySearchRoutes = searchableRouteIds.filter((routeId) => {
      const routeHotels = hotelsByRoute.get(routeId) || [];
      return routeHotels.length === 0;
    }).length;

    const hasSupplierHotels = supplierHotelRows.length > 0;
    const isPlaceholderOnly = !hasSupplierHotels && placeholderRows.length > 0;
    const availabilityMessage = isPlaceholderOnly
      ? 'Supplier search completed but no available rooms were returned for the selected city/date criteria.'
      : hasSupplierHotels
        ? 'Live supplier hotels are available for the current itinerary selection.'
        : 'No hotel data available yet. Try refreshing search or adjusting criteria.';

    return {
      quoteId,
      planId,
      showHotelMargins: this.shouldShowHotelMargins(),
      hotelRatesVisible,
      hotelTabs,
      hotels: cleanedHotelRows,
      restrictedHotels: restrictedHotelRows,
      totalRoomCount: cleanedHotelRows.length,
      hotelAvailability: {
        hasSupplierHotels,
        supplierHotelCount: supplierHotelRows.length,
        placeholderRowCount: placeholderRows.length,
        totalSearchRoutes,
        emptySearchRoutes,
        isPlaceholderOnly,
        message: availabilityMessage,
      },
    };
  }

  /**
   * Get fresh hotel room details from TBO API (no stale data)
   * Fetches real-time data and returns in room details format
   * Uses caching by route to minimize TBO API calls within a session
   * @param quoteId - The quote ID to fetch hotel rooms for
   * @param filterRouteId - Optional: Filter results to only this route ID
   */
  async getHotelRoomDetailsFromTbo(
    quoteId: string,
    filterRouteId?: number,
  ): Promise<ItineraryHotelRoomDetailsResponseDto> {
    const startTime = Date.now();
    this.logger.log(`\nðŸ“¡ FRESH ROOM DETAILS FROM TBO: Fetching live data for quote: ${quoteId}`);
    if (filterRouteId) {
      this.logger.log(`ðŸ” Filtering to route ID: ${filterRouteId}`);
    }

    // âœ… CHECK CACHE FIRST (per-route caching)
    const cachedResult = this.getCachedRoomDetails(quoteId, filterRouteId);
    if (cachedResult) {
      return cachedResult;
    }

    // Step 1: Get itinerary plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`âš ï¸  Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    const planId = plan.itinerary_plan_ID;
    this.logger.log(`âœ… Found plan ID: ${planId}`);

    // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    if (routes.length === 0) {
      this.logger.warn(`âš ï¸  No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

    const noOfNights = Number((plan as any).no_of_nights || 0);
    this.logger.log(`ðŸŒ™ Plan has ${noOfNights} nights`);

    const planRoomCount2 = Math.max(Number((plan as any).preferred_room_count || 1), 1);
    const planAdultCount2 = Number((plan as any).total_adult || 0);
    const planChildCount2 = Number((plan as any).total_children || 0);
    const explicitMealPlanCode2 = inferCanonicalHotelRatePlanCode(String((plan as any).meal_plan_code || ''));
    const mealPlanBreakfast2 = Number((plan as any).meal_plan_breakfast ?? 0) ? 1 : 0;
    const mealPlanLunch2 = Number((plan as any).meal_plan_lunch ?? 0) ? 1 : 0;
    const mealPlanDinner2 = Number((plan as any).meal_plan_dinner ?? 0) ? 1 : 0;
    const hasExplicitMealFlags2 =
      mealPlanBreakfast2 === 1 || mealPlanLunch2 === 1 || mealPlanDinner2 === 1;
    const fallbackMealPlanCode2 = hasExplicitMealFlags2
      ? inferCanonicalHotelRatePlanCodeFromMealFlags(
          mealPlanBreakfast2,
          mealPlanLunch2,
          mealPlanDinner2,
        )
      : null;
    const preferredMealPlanCode2 = explicitMealPlanCode2 || fallbackMealPlanCode2;

    let planChildAges2: number[] = [];
    if (planChildCount2 > 0) {
      const childTravellers2 = await this.prisma.dvi_itinerary_traveller_details.findMany({
        where: { itinerary_plan_ID: planId, traveller_type: 2, deleted: 0 },
        orderBy: { traveller_details_ID: 'asc' },
      });
      planChildAges2 = childTravellers2
        .map((t) => Math.trunc(Number((t as any).traveller_age)))
        .filter((age) => Number.isFinite(age) && age >= 0 && age <= 11);
    }

    // Step 3: Fetch FRESH hotels from TBO
    // OPTIMIZATION: If filterRouteId provided, only fetch hotels for that specific route
    let routesToProcess = routes;
    if (filterRouteId) {
      routesToProcess = routes.filter(r => (r as any).itinerary_route_ID === filterRouteId);
      if (routesToProcess.length === 0) {
        this.logger.warn(`âš ï¸  Route ID ${filterRouteId} not found`);
        throw new BadRequestException(`Route ID ${filterRouteId} not found in this itinerary`);
      }
      this.logger.log(`âœ… Optimized: Fetching hotels for 1 route only (filtered)`);
    }

    const guestNationality = await this.resolveGuestNationality(plan);
    const hotelsByRoute = await this.fetchHotelsForRoutes(
      routesToProcess,
      noOfNights,
      guestNationality,
      planRoomCount2,
      planAdultCount2,
      planChildCount2,
      planChildAges2,
    );

    // Merge non-TBO providers (HOBSE, ResAvenue, AxisRooms) â€” same logic as getHotelDetails
    const tboOnlyFetch = this.isTboOnlyFetchEnabled();
    if (!tboOnlyFetch) {
      if (this.isHobseSearchEnabled()) {
        const hobseCityCodeMap = await this.batchMapDestinationsToHobseCityCodes(routesToProcess);
        const hobseHotelsByRoute = await this.fetchHobseHotelsForRoutes(routesToProcess, noOfNights, hobseCityCodeMap);
        hobseHotelsByRoute.forEach((hobseHotels, routeId) => {
          const existing = hotelsByRoute.get(routeId) || [];
          hotelsByRoute.set(routeId, [...existing, ...hobseHotels]);
        });
      } else {
        this.logger.warn('âš ï¸ HOBSE_SEARCH_ENABLED=0: skipping HOBSE hotel search results');
      }

      // ResAvenue
      const resavenueHotelsByRoute = await this.fetchResavenueHotelsForRoutes(
        routesToProcess,
        noOfNights,
        guestNationality,
        planRoomCount2,
        planAdultCount2,
        planChildCount2,
      );
      resavenueHotelsByRoute.forEach((resavenueHotels, routeId) => {
        const existing = hotelsByRoute.get(routeId) || [];
        const hotelStrs = existing.map(h => `${h.hotelCode}|${h.provider}`);
        const newHotels = resavenueHotels.filter(h => !hotelStrs.includes(`${h.hotelCode}|${h.provider}`));
        hotelsByRoute.set(routeId, [...existing, ...newHotels]);
      });

      // AxisRooms
      const axisroomsHotelsByRoute = await this.fetchAxisroomsHotelsForRoutes(routesToProcess, noOfNights);
      axisroomsHotelsByRoute.forEach((axisroomsHotels, routeId) => {
        const existing = hotelsByRoute.get(routeId) || [];
        const hotelStrs = existing.map(h => `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`);
        const newHotels = axisroomsHotels.filter(h => !hotelStrs.includes(`${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`));
        hotelsByRoute.set(routeId, [...existing, ...newHotels]);
      });

      const savedMealPlansByRoute2 = await this.loadSavedMealPlansPerRoute(planId, routesToProcess);
      const staahHotelsByRoute = await this.fetchStaahHotelsForRoutes(
        routesToProcess,
        noOfNights,
        savedMealPlansByRoute2,
        preferredMealPlanCode2,
        true,
        {
          roomCount: planRoomCount2,
          adults: planAdultCount2,
          children: planChildCount2,
          extraBedCount: Number((plan as any).total_extra_bed || 0),
          childWithBedCount: Number((plan as any).total_child_with_bed || 0),
          childWithoutBedCount: Number((plan as any).total_child_without_bed || 0),
        },
      );
      staahHotelsByRoute.forEach((staahHotels, routeId) => {
        const existing = hotelsByRoute.get(routeId) || [];
        const hotelStrs = existing.map((h) =>
          String((h as any).searchReference || `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`).trim(),
        );
        const newHotels = staahHotels.filter(
          (h) =>
            !hotelStrs.includes(
              String((h as any).searchReference || `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`).trim(),
            ),
        );
        hotelsByRoute.set(routeId, [...existing, ...newHotels]);
      });
    }

    // Step 4: Transform fresh data into room details format
    const roomDetailsList: ItineraryHotelRoomDto[] = [];
    let roomDetailsId = 1;

    // Build route-scoped room candidates with group coverage fallback.
    // PHP behavior allows overlap fallback when a recommendation bucket would be empty.
    const routeHotelRows: Array<{ routeId: number; hotel: any }> = [];

    hotelsByRoute.forEach((hotelsForRoute, routeId) => {
      // FILTER: Only process this route if filterRouteId is not provided OR if it matches
      if (filterRouteId && routeId !== filterRouteId) {
        this.logger.debug(`ðŸ” Skipping route ${routeId} (filter: ${filterRouteId})`);
        return;
      }

      const allPrices = hotelsForRoute.map((h: HotelSearchResult) => h.price || 0);
      const sortedHotels = [...hotelsForRoute].sort((a, b) => (a.price || 0) - (b.price || 0));

      const byGroup = new Map<number, any[]>();

      hotelsForRoute.forEach((hotel: HotelSearchResult) => {
        const hotelPrice = hotel.price || 0;
        const groupType = this.getGroupTypeFromPrice(hotelPrice, allPrices);
        if (!byGroup.has(groupType)) byGroup.set(groupType, []);
        byGroup.get(groupType)!.push({ ...hotel, groupType, __fallbackAssigned: false });
      });

      // Ensure all 4 groups are represented when a route has at least one hotel.
      for (let groupType = 1; groupType <= 4; groupType++) {
        const groupHotels = byGroup.get(groupType) ?? [];
        if (groupHotels.length === 0 && sortedHotels.length > 0) {
          const fallbackIndex = Math.min(groupType - 1, sortedHotels.length - 1);
          const fallbackHotel = sortedHotels[fallbackIndex];
          if (fallbackHotel) {
            byGroup.set(groupType, [
              {
                ...fallbackHotel,
                groupType,
                __fallbackAssigned: true,
              },
            ]);
          }
        }
      }

      for (let groupType = 1; groupType <= 4; groupType++) {
        const groupHotels = byGroup.get(groupType) ?? [];
        groupHotels.forEach((hotel) => routeHotelRows.push({ routeId, hotel }));
      }
    });

    // Build room entries from fresh TBO data
    routeHotelRows.forEach(({ routeId, hotel }) => {
      const route = routes.find(r => (r as any).itinerary_route_ID === routeId);
      if (!route) return;

        // âœ… FIXED: Use actual room type from TBO, not groupType
        const firstRoomType = hotel.roomTypes?.[0];
        const actualRoomTypeId = firstRoomType?.roomTypeId || 1;
        // For non-TBO providers use hotel.roomType which matches hotel_details; for TBO use roomTypes[0].roomName
        const actualRoomTypeName = String(hotel.provider || 'tbo').toLowerCase() !== 'tbo'
          ? (hotel.roomType || firstRoomType?.roomName || 'Standard Room')
          : (firstRoomType?.roomName || hotel.roomType || 'Standard Room');
        const pricedHotel = this.enrichHotelWithMasterMargin(hotel, new Map());
        const baseHotelCost = Number(pricedHotel.price || 0);
        const totalHotelCost = this.applyInvisibleHotelMargin(baseHotelCost, pricedHotel);

        roomDetailsList.push({
          itineraryPlanId: planId,
          itineraryRouteId: routeId,
          itineraryPlanHotelRoomDetailsId: roomDetailsId++,
          hotelId: parseInt(hotel.hotelCode) || 0,
          hotelName: hotel.hotelName || 'Hotel',
          hotelCategory: this.getCategoryFromRating(hotel.category || hotel.rating),
          groupType: hotel.groupType || 1, // âœ… ADD: Include groupType (tier: 1-4)
          roomTypeId: actualRoomTypeId, // âœ… FIXED: Use actual TBO room type ID
          roomTypeName: actualRoomTypeName, // âœ… FIXED: Use actual TBO room type name
          roomId:
            String(hotel.provider || 'tbo').toLowerCase() === 'staah'
              ? 0
              : parseInt(hotel.hotelCode) || 0,
          provider: String(hotel.provider || 'tbo').toLowerCase(),
          availableRoomTypes: (hotel.roomTypes || []).map((rt, idx) => ({
            roomTypeId: rt.roomTypeId || idx + 1,
            roomTypeTitle: rt.roomName,
            bookingCode: rt.roomCode,
          })),
          bookingCode:
            String(hotel.provider || 'tbo').toLowerCase() === 'tbo'
              ? (firstRoomType?.roomCode || hotel.searchReference || undefined)
              : String(hotel.provider || 'tbo').toLowerCase() === 'staah'
                ? (hotel.searchReference || (hotel as any).bookingCode || undefined)
                : ((hotel as any).bookingCode || hotel.searchReference || hotel.hotelCode || undefined),
          searchReference:
            String(hotel.provider || 'tbo').toLowerCase() === 'staah'
              ? String(hotel.searchReference || (hotel as any).bookingCode || '').trim() || undefined
              : hotel.searchReference,
          rateId:
            String(hotel.provider || 'tbo').toLowerCase() === 'staah'
              ? this.parseStaahSearchReference(hotel.searchReference || (hotel as any).bookingCode)?.rateId || undefined
              : undefined,
          basePricePerNight: baseHotelCost,
          hotelMarginPercentage: this.getHotelMarginPercentage(pricedHotel),
          pricePerNight: totalHotelCost,
          numberOfNights: noOfNights,
          totalPrice: this.money(totalHotelCost * noOfNights),
          currency: hotel.currency || 'INR',
          mealPlan: hotel.mealPlan || 'Not Specified',
          facilities: hotel.facilities || [],
          amenities: hotel.amenities || [],
          inclusions: hotel.inclusions || [],
          rateConditions: (hotel.rateConditions || []) as string[],
          cancellationPolicy: Array.isArray((hotel as any).cancellationPolicy)
            ? (hotel as any).cancellationPolicy
            : (typeof (hotel as any).cancellationPolicy === 'string' && String((hotel as any).cancellationPolicy).trim()
              ? [String((hotel as any).cancellationPolicy).trim()]
              : (firstRoomType?.cancellationPolicy ? [String(firstRoomType.cancellationPolicy)] : [])),
          isBookable: (hotel as any).isBookable ?? true,
          externalStay: (hotel as any).externalStay ?? false,
          availabilityStatus: (hotel as any).availabilityStatus || 'AVAILABLE',
          availabilityMessage: (hotel as any).availabilityMessage || null,
          availableAgainFrom: (hotel as any).availableAgainFrom || null,
        } as any);
    });

    const duration = Date.now() - startTime;
    this.logger.log(`âœ… FRESH ROOM DETAILS GENERATED`);
    this.logger.log(`ðŸ“Š Room Entries: ${roomDetailsList.length}`);
    if (filterRouteId) {
      this.logger.log(`ðŸ” Filter Applied: Route ID ${filterRouteId}`);
    } else {
      this.logger.log(`ðŸ“… All Routes Included`);
    }
    this.logger.log(`â±ï¸  Duration: ${duration}ms\n`);

    const result = {
      quoteId: (plan as any).itinerary_quote_ID ?? '',
      planId,
      rooms: roomDetailsList,
    };

    // âœ… CACHE THE RESULT for future requests
    this.setCachedRoomDetails(quoteId, result, filterRouteId);

    return result;
  }

  /**
   * Determine group type (price tier) based on hotel price relative to all hotels
   * Distributes hotels across 4 tiers: Budget (1), Mid-Range (2), Premium (3), Luxury (4)
   */
  private getGroupTypeFromPrice(
    hotelPrice: number,
    allPrices: number[]
  ): number {
    if (allPrices.length === 0) return 1;
    if (allPrices.length === 1) return 1;

    // Sort prices to find quartiles
    const sortedPrices = [...allPrices].sort((a, b) => a - b);
    
    // Calculate quartile boundaries
    const q1 = sortedPrices[Math.floor(sortedPrices.length * 0.25)];
    const q2 = sortedPrices[Math.floor(sortedPrices.length * 0.50)];
    const q3 = sortedPrices[Math.floor(sortedPrices.length * 0.75)];

    // Assign tier based on price quartile
    if (hotelPrice <= q1) return 1; // Budget (bottom 25%)
    if (hotelPrice <= q2) return 2; // Mid-Range (25-50%)
    if (hotelPrice <= q3) return 3; // Premium (50-75%)
    return 4; // Luxury (top 25%)
  }

  /**
   * Convert rating/category string to numeric category (1-4)
   */
  private getCategoryFromRating(ratingOrCategory: string | number | undefined): number {
    if (!ratingOrCategory) return 2; // Default to Mid-Range
    
    const val = typeof ratingOrCategory === 'string' 
      ? parseInt(ratingOrCategory)
      : ratingOrCategory;
    
    if (val >= 5 || val === 4) return 4; // Luxury (5-star)
    if (val === 3) return 3; // Premium (3-star equivalent)
    if (val === 2) return 2; // Mid-Range (2-star)
    return 1; // Budget
  }

  /**
   * Generate cache key for hotel room details
   * Format: "quoteId" or "quoteId:routeId" if filtered
   */
  /**
   * Get cached hotel room details if available
   */
  private getCachedRoomDetails(quoteId: string, routeId?: number): ItineraryHotelRoomDetailsResponseDto | null {
    return this.hotelDetailsCacheService.getRoomDetails(quoteId, routeId);
  }

  /**
   * Store hotel room details in cache
   */
  private setCachedRoomDetails(
    quoteId: string,
    data: ItineraryHotelRoomDetailsResponseDto,
    routeId?: number,
  ): void {
    this.hotelDetailsCacheService.setRoomDetails(quoteId, data, routeId);
  }

  private getCachedHotelDetails(quoteId: string): ItineraryHotelDetailsResponseDto | null {
    return this.hotelDetailsCacheService.getHotelDetails(quoteId);
  }

  private setCachedHotelDetails(
    quoteId: string,
    data: ItineraryHotelDetailsResponseDto,
  ): void {
    this.hotelDetailsCacheService.setHotelDetails(quoteId, data);
  }

  /**
   * Clear cache for a specific quote (called on refresh/update)
   * Clears both general cache (quoteId) and route-specific caches (quoteId:routeId)
   */
  clearCacheForQuote(quoteId: string): void {
    this.hotelDetailsCacheService.clearForQuote(quoteId);
  }

  /**
   * Get current cache size and stats (for debugging)
   */
  getCacheStats(): { size: number; entries: string[] } {
    return this.hotelDetailsCacheService.getStats();
  }
}

