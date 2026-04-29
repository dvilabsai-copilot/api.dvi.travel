// FILE: src/modules/itineraries/itinerary-hotel-details-tbo.service.ts

import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import axios from 'axios';
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
import {
  getTboMealTypeForCanonicalHotelRatePlan,
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealFlags,
} from '../hotels/hotel-rate-plans';

/**
 * This service generates dynamic hotel packages from TBO API
 * instead of retrieving them from the database
 */
@Injectable()
export class ItineraryHotelDetailsTboService {
  private static readonly HOTEL_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly HOTEL_ROOM_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_CACHE_ENTRIES = 200;
  /** 40-minute DB cache TTL before a live re-fetch is triggered */
  private static readonly DB_CACHE_TTL_MS = 40 * 60 * 1000;
  /** Placeholder-only rows should be retried sooner to self-heal temporary supplier misses */
  private static readonly PLACEHOLDER_ONLY_DB_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly PAGE_SIZE = 20;
  private static readonly GLOBAL_SETTING_CACHE_TTL_MS = 60 * 1000;
  private mealPlanSearchEnabledCache: { value: boolean; timestamp: number } | null = null;
  private static readonly STAR_RATING_PATTERN = /([1-5])\s*\*?/;
  private static readonly STD_OR_BUDGET_PATTERN = /\b(STD|STANDARD|BUDGET)\b/i;

  private parseSelectedCategoryIds(raw: unknown): number[] {
    if (Array.isArray(raw)) {
      return raw
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
    }

    const text = String(raw ?? '').trim();
    if (!text) return [];

    return text
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  private extractStarRatingFromCategoryRow(row: any): number | null {
    const candidates = [row?.hotel_category_title, row?.hotel_category_code];
    for (const candidate of candidates) {
      const text = String(candidate ?? '').trim();
      if (!text) continue;
      const match = ItineraryHotelDetailsTboService.STAR_RATING_PATTERN.exec(text);
      if (match) {
        const rating = Number(match[1]);
        if (rating >= 1 && rating <= 5) return rating;
      }
    }
    return null;
  }

  private async resolvePlanStarRatings(plan: any): Promise<number[]> {
    const selectedCategoryIds = this.parseSelectedCategoryIds((plan as any)?.preferred_hotel_category);
    if (selectedCategoryIds.length === 0) return [];

    try {
      const categories = await this.prisma.dvi_hotel_category.findMany({
        where: {
          hotel_category_id: { in: selectedCategoryIds },
          deleted: 0,
          status: 1,
        } as any,
        select: {
          hotel_category_id: true,
          hotel_category_title: true,
          hotel_category_code: true,
        } as any,
      });

      const ratings = Array.from(
        new Set(
          categories
            .map((row) => this.extractStarRatingFromCategoryRow(row))
            .filter((value): value is number => value !== null),
        ),
      ).sort((a, b) => a - b);

      if (ratings.length > 0) return ratings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`⚠️ Could not map preferred_hotel_category to star ratings: ${message}`);
    }

    // Safe fallback: when IDs are already star-like (1-5), use them directly.
    return Array.from(
      new Set(selectedCategoryIds.filter((value) => value >= 1 && value <= 5)),
    ).sort((a, b) => a - b);
  }

  private async resolvePlanCategoryPreferences(
    plan: any,
  ): Promise<{ starRatings: number[]; stdBudgetSelected: boolean }> {
    const selectedCategoryIds = this.parseSelectedCategoryIds((plan as any)?.preferred_hotel_category);
    if (selectedCategoryIds.length === 0) {
      return { starRatings: [], stdBudgetSelected: false };
    }

    try {
      const categories = await this.prisma.dvi_hotel_category.findMany({
        where: {
          hotel_category_id: { in: selectedCategoryIds },
          deleted: 0,
          status: 1,
        } as any,
        select: {
          hotel_category_id: true,
          hotel_category_title: true,
          hotel_category_code: true,
        } as any,
      });

      const starRatings = Array.from(
        new Set(
          categories
            .map((row) => this.extractStarRatingFromCategoryRow(row))
            .filter((value): value is number => value !== null),
        ),
      ).sort((a, b) => a - b);

      const stdBudgetSelected = categories.some((row) => {
        const title = String((row as any)?.hotel_category_title || '').trim();
        const code = String((row as any)?.hotel_category_code || '').trim();
        return (
          ItineraryHotelDetailsTboService.STD_OR_BUDGET_PATTERN.test(title)
          || ItineraryHotelDetailsTboService.STD_OR_BUDGET_PATTERN.test(code)
        );
      });

      return { starRatings, stdBudgetSelected };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`⚠️ Could not resolve category preferences from preferred_hotel_category: ${message}`);

      const starRatings = Array.from(
        new Set(selectedCategoryIds.filter((value) => value >= 1 && value <= 5)),
      ).sort((a, b) => a - b);

      return { starRatings, stdBudgetSelected: false };
    }
  }

  private normalizeStarValue(value: unknown): number {
    const raw = String(value ?? '').trim();
    if (!raw) return 0;

    const labelMatch = raw.match(/([1-5])\s*(?:\*|STAR)?/i);
    if (labelMatch) {
      const parsed = Number(labelMatch[1]);
      if (parsed >= 1 && parsed <= 5) return parsed;
    }

    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return 0;

    if (numeric >= 1 && numeric <= 5) {
      return Math.trunc(numeric);
    }

    const lastDigit = Math.trunc(numeric) % 10;
    if (numeric >= 10 && numeric < 100 && lastDigit >= 1 && lastDigit <= 5) {
      return lastDigit;
    }

    return 0;
  }

  private applyCategoryPreferenceFilter(
    hotels: HotelSearchResult[],
    preferences?: { starRatings?: number[]; stdBudgetSelected?: boolean },
  ): HotelSearchResult[] {
    const rows = Array.isArray(hotels) ? hotels : [];
    const selectedStars = (preferences?.starRatings || []).filter((s) => Number.isInteger(s) && s >= 1 && s <= 5);
    const stdBudgetSelected = Boolean(preferences?.stdBudgetSelected);

    if (rows.length === 0 || (!stdBudgetSelected && selectedStars.length === 0)) {
      return rows;
    }

    const rowsWithMeta = rows.map((hotel) => {
      const price = Number((hotel as any).price || 0);
      const star = this.normalizeStarValue((hotel as any).category ?? (hotel as any).rating);
      return { hotel, price: Number.isFinite(price) ? price : 0, star };
    });

    const stdBudgetCandidates = rowsWithMeta.filter((row) => row.star > 0 && row.star < 3);
    let stdBudgetThreshold = Number.POSITIVE_INFINITY;
    if (stdBudgetSelected && stdBudgetCandidates.length > 0) {
      const sortedPrices = [...stdBudgetCandidates]
        .map((row) => row.price)
        .sort((a, b) => a - b);
      // "Low price" is interpreted as bottom 50% among sub-3-star supplier options.
      stdBudgetThreshold = sortedPrices[Math.floor((sortedPrices.length - 1) / 2)];
    }

    const filtered = rowsWithMeta.filter((row) => {
      const matchesStarSelection = selectedStars.length > 0 && selectedStars.includes(row.star);
      const matchesStdBudget = stdBudgetSelected
        && row.star > 0
        && row.star < 3
        && row.price <= stdBudgetThreshold;
      return matchesStarSelection || matchesStdBudget;
    });

    return filtered.map((row) => row.hotel);
  }

    /**
     * Fetch hotels for all routes, retrying ONCE if any provider/system failure (null) is detected.
     */
    private async fetchHotelsForRoutesWithRetry(
      routes: any[],
      noOfNights: number,
      guestNationality: string,
      adultCount: number = 2,
      childCount: number = 0,
      childAges: number[] = [],
      roomCount: number = 1,
      searchPreferences?: {
        mealPlanCode?: string;
        tboMealType?: string;
        starRatings?: number[];
        stdBudgetSelected?: boolean;
      },
    ): Promise<Map<number, HotelSearchResult[] | null>> {
      let hotelsByRoute = await this.fetchHotelsForRoutes(
        routes,
        noOfNights,
        guestNationality,
        adultCount,
        childCount,
        childAges,
        roomCount,
        searchPreferences,
      );

      const hasProviderFailure = Array.from(hotelsByRoute.values()).some(
        (value) => value === null,
      );

      if (hasProviderFailure) {
        this.logger.warn(
          '🚨 Hotel search had provider/system failure on first attempt. Retrying once...'
        );

        // small delay to allow DB sync / provider readiness
        await new Promise((resolve) => setTimeout(resolve, 800));

        const retryResult = await this.fetchHotelsForRoutes(
          routes,
          noOfNights,
          guestNationality,
          adultCount,
          childCount,
          childAges,
          roomCount,
          searchPreferences,
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
          `📊 Comparing results → First: ${firstSuccessCount}, Retry: ${retrySuccessCount}`,
        );

        // return whichever has more valid hotel data
        if (retrySuccessCount >= firstSuccessCount) {
          this.logger.log('✅ Using retry result (better or equal)');
          return retryResult;
        } else {
          this.logger.log('⚠️ Using first attempt result (better)');
          return hotelsByRoute;
        }
      }

      return hotelsByRoute;
    }
  private readonly logger = new Logger(ItineraryHotelDetailsTboService.name);

  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  private async isMealPlanSearchEnabled(): Promise<boolean> {
    const cached = this.mealPlanSearchEnabledCache;
    const now = Date.now();
    if (
      cached
      && now - cached.timestamp <= ItineraryHotelDetailsTboService.GLOBAL_SETTING_CACHE_TTL_MS
    ) {
      return cached.value;
    }

    try {
      const columnCheck = await this.prisma.$queryRawUnsafe<any[]>(`
        SELECT COUNT(*) AS cnt
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'dvi_global_settings'
          AND COLUMN_NAME = 'meal_plan_search_enabled'
      `);

      const columnExists = Number((columnCheck?.[0] as any)?.cnt || 0) > 0;
      if (!columnExists) {
        // Backward-compatible default when column is not yet present.
        this.mealPlanSearchEnabledCache = { value: true, timestamp: now };
        return true;
      }

      const settingsRows = await this.prisma.$queryRawUnsafe<any[]>(`
        SELECT meal_plan_search_enabled
        FROM dvi_global_settings
        WHERE deleted = 0
        ORDER BY global_settings_ID DESC
        LIMIT 1
      `);

      const rawValue = (settingsRows?.[0] as any)?.meal_plan_search_enabled;
      const enabled = rawValue === undefined || rawValue === null
        ? true
        : Number(rawValue) === 1 || rawValue === true;

      this.mealPlanSearchEnabledCache = { value: enabled, timestamp: now };
      return enabled;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `⚠️ Could not read meal_plan_search_enabled toggle from global settings. Falling back to enabled=true. Error: ${message}`,
      );
      this.mealPlanSearchEnabledCache = { value: true, timestamp: now };
      return true;
    }
  }

  private resolvePlanMealPreference(plan: any): { mealPlanCode?: string; tboMealType?: string } {
    const explicitMealPlanCode = inferCanonicalHotelRatePlanCode((plan as any)?.meal_plan_code);
    const breakfast = Number((plan as any)?.meal_plan_breakfast ?? 0);
    const lunch = Number((plan as any)?.meal_plan_lunch ?? 0);
    const dinner = Number((plan as any)?.meal_plan_dinner ?? 0);
    const hasExplicitMealFlags = breakfast === 1 || lunch === 1 || dinner === 1;
    const mealPlanCode = explicitMealPlanCode
      || (hasExplicitMealFlags
        ? inferCanonicalHotelRatePlanCodeFromMealFlags(
            breakfast,
            lunch,
            dinner,
          )
        : null);

    if (!mealPlanCode) {
      return {};
    }

    return {
      mealPlanCode,
      tboMealType: getTboMealTypeForCanonicalHotelRatePlan(mealPlanCode) || undefined,
    };
  }

  // Cache for hotel details endpoint response (key = quoteId)
  private hotelDetailsCache = new Map<string, {
    data: ItineraryHotelDetailsResponseDto;
    timestamp: number;
  }>();
  
  // Cache structure: key = "quoteId:routeId" or "quoteId" (no route filter)
  // Stores the entire response to avoid re-fetching TBO data
  private hotelRoomDetailsCache = new Map<string, {
    data: ItineraryHotelRoomDetailsResponseDto;
    timestamp: number;
  }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelSearchService: HotelSearchService,
    private readonly hobseProvider: HobseHotelProvider,
  ) {}

  private extractIso2FromCountryRow(row: any): string | null {
    if (!row || typeof row !== 'object') return null;

    const candidates = [
      row.shortname,
      row.country_code,
      row.iso2,
      row.iso_code,
      row.sortname,
      row.alpha2,
      row.code,
    ];

    for (const value of candidates) {
      const normalized = String(value ?? '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  private normalizeGuestNationality(value: any): string | null {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!normalized) return null;

    if (/^[A-Z]{2}$/.test(normalized)) {
      return normalized;
    }

    // Common aliases from UI/integrations.
    const aliases: Record<string, string> = {
      UAE: 'AE',
      'UNITED ARAB EMIRATES': 'AE',
    };

    return aliases[normalized] ?? null;
  }

  private resolveLegacyNationalityId(nationalityId: number): string | null {
    // Some historical quotes store country IDs that no longer exist in dvi_countries.
    // Keep this map minimal and only for verified legacy IDs.
    const legacyMap: Record<number, string> = {
      284: 'AE',
    };

    return legacyMap[nationalityId] ?? null;
  }

  private async resolveGuestNationality(plan: any): Promise<string> {
    const rawNationality = (plan as any)?.nationality;
    const directIso = this.normalizeGuestNationality(rawNationality);
    const nationalityId = Number(rawNationality ?? 0);

    if (directIso && !Number.isFinite(nationalityId)) {
      this.logger.log(
        `✅ Resolved guestNationality directly from plan nationality value: ${rawNationality} -> ${directIso}`,
      );
      return directIso;
    }

    // Prefer master-country mapping from DB (as requested).
    if (nationalityId > 0) {
      try {
        const country = await this.prisma.dvi_countries.findFirst({
          where: {
            id: nationalityId,
            deleted: 0,
            status: 1,
          },
          select: {
            shortname: true,
            name: true,
          },
        });
        const iso2 = this.extractIso2FromCountryRow(country);
        if (iso2) {
          this.logger.log(
            `✅ Resolved guestNationality from country table: nationality=${nationalityId} -> ${iso2}`,
          );
          return iso2;
        }

        const legacyIso = this.resolveLegacyNationalityId(nationalityId);
        if (legacyIso) {
          this.logger.warn(
            `⚠️ Resolved guestNationality using verified legacy nationality mapping: nationality=${nationalityId} -> ${legacyIso}`,
          );
          return legacyIso;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `⚠️ Could not resolve country mapping from table dvi_countries for nationality=${nationalityId}: ${message}`,
        );
      }
    }

    const envFallback = String(
      process.env.TBO_DEFAULT_GUEST_NATIONALITY || '',
    )
      .trim()
      .toUpperCase();
    if (/^[A-Z]{2}$/.test(envFallback)) {
      this.logger.warn(
        `⚠️ Using TBO_DEFAULT_GUEST_NATIONALITY fallback: ${envFallback}`,
      );
      return envFallback;
    }

    throw new BadRequestException(
      'Unable to resolve guestNationality. Ensure country table mapping exists for plan nationality or set TBO_DEFAULT_GUEST_NATIONALITY.',
    );
  }

  /**
   * Get hotel details with dynamic packages from TBO API
   * Creates 4 different price tier packages: Budget, Mid-Range, Premium, Luxury
   */
  async getHotelDetailsByQuoteIdFromTbo(
    quoteId: string,
    page = 1,
    pageSize = ItineraryHotelDetailsTboService.PAGE_SIZE,
    requestedGroupType?: number,
    requestedRouteId?: number,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const startTime = Date.now();
    this.logger.log(`\n📡 TBO HOTEL PACKAGES: Fetching dynamic packages for quote: ${quoteId}`);
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Number(pageSize) || ItineraryHotelDetailsTboService.PAGE_SIZE);

    // Step 1: Get itinerary plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`⚠️  Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    const planId = plan.itinerary_plan_ID;
    this.logger.log(`✅ Found plan ID: ${planId}`);

    // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    this.logger.log(`📅 Routes Query Result: ${JSON.stringify({
      total: routes.length,
      routes: routes.map(r => ({ id: (r as any).itinerary_route_ID, location: (r as any).location_name, date: (r as any).itinerary_route_date }))
    })}`);

    if (routes.length === 0) {
      this.logger.warn(`⚠️  No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

    this.logger.log(`📅 Found ${routes.length} routes to process`);

    // Get number of nights from plan to determine which routes need hotels
    const noOfNights = Number((plan as any).no_of_nights || 0);
    const hotelRatesVisible =
      Number((plan as any)?.hotel_rates_visibility || 0) === 1 ||
      (plan as any)?.hotel_rates_visibility === true;
    const searchableRouteIds = this.getSearchableRouteIds(routes, noOfNights);
    const effectiveRouteIds =
      requestedRouteId && searchableRouteIds.includes(requestedRouteId)
        ? [requestedRouteId]
        : searchableRouteIds;

    // Fresh DB cache path: always serve paged response from DB (including page=1)
    const isStale = await this.isDbCacheStale(
      quoteId,
      effectiveRouteIds,
      requestedGroupType,
    );
    if (!isStale) {
      this.logger.log(`📦 DB cache fresh — serving page ${safePage} from DB for quote ${quoteId}`);
      return this.buildPagedResponseFromDb(
        quoteId,
        planId,
        hotelRatesVisible,
        safePage,
        safePageSize,
        requestedGroupType,
        effectiveRouteIds,
      );
    }

    const guestNationality = await this.resolveGuestNationality(plan);
    const mealPlanSearchEnabled = await this.isMealPlanSearchEnabled();
    const mealPreference = mealPlanSearchEnabled ? this.resolvePlanMealPreference(plan) : {};
    const categoryPreferences = await this.resolvePlanCategoryPreferences(plan);
    const starRatings = categoryPreferences.starRatings;
    this.logger.log(`🌙 Plan has ${noOfNights} nights`);
    this.logger.log(
      `🍽️ Global meal plan search toggle: ${mealPlanSearchEnabled ? 'ENABLED' : 'DISABLED'}`,
    );
    if (mealPlanSearchEnabled && mealPreference.mealPlanCode) {
      this.logger.log(
        `🍽️ Meal preference resolved from itinerary plan: ${mealPreference.mealPlanCode} (TBO=${mealPreference.tboMealType || 'n/a'})`,
      );
    } else if (!mealPlanSearchEnabled) {
      this.logger.log('🍽️ Meal plan filtering skipped due to global setting (meal_plan_search_enabled=0)');
    }
    if (starRatings.length > 0) {
      this.logger.log(`⭐ Hotel star filter resolved from preferred_hotel_category: [${starRatings.join(', ')}]`);
    }
    if (categoryPreferences.stdBudgetSelected) {
      this.logger.log('⭐ STD/Budget category selected: applying sub-3-star + low-price filter.');
    }

    // Read pax counts saved by the user when creating the itinerary
    const planAdultCount = Number((plan as any).total_adult || 0);
    const planChildCount = Number((plan as any).total_children || 0);
    const planChildAges = await this.resolvePlanChildAges(planId, planChildCount);
    const planRoomCount = Math.max(Number((plan as any).preferred_room_count || 1), 1);
    this.logger.log(`👥 Pax from plan: adults=${planAdultCount}, children=${planChildCount}`);

    // Step 3: Fetch hotels from TBO for each route (except last route if it's departure day)
    const hotelsByRoute = await this.fetchHotelsForRoutesWithRetry(
      routes,
      noOfNights,
      guestNationality,
      planAdultCount,
      planChildCount,
      planChildAges,
      planRoomCount,
      {
        ...mealPreference,
        starRatings,
        stdBudgetSelected: categoryPreferences.stdBudgetSelected,
      },
    );
    
    // Step 3.5: Fetch HOBSE hotels and merge with TBO hotels
    // First, create a HOBSE-specific city code map using hobse_city_code
    const hobseCityCodeMap = await this.batchMapDestinationsToHobseCityCodes(routes);
    const hobseHotelsByRoute = await this.fetchHobseHotelsForRoutes(routes, noOfNights, hobseCityCodeMap);
    
    // Merge HOBSE hotels into the TBO hotel map
    hobseHotelsByRoute.forEach((hobseHotels, routeId) => {
      const existingHotels = hotelsByRoute.get(routeId) || [];
      hotelsByRoute.set(routeId, [...existingHotels, ...hobseHotels]);
    });

    // Step 3.6: Fetch ResAvenue hotels explicitly (in case they weren't included in TBO search)
    const resavenueHotelsByRoute = await this.fetchResavenueHotelsForRoutes(
      routes,
      noOfNights,
      guestNationality,
      planAdultCount,
      planChildCount,
      planChildAges,
      planRoomCount,
    );
    
    // Merge ResAvenue hotels into the hotel map
    resavenueHotelsByRoute.forEach((resavenueHotels, routeId) => {
      const existingHotels = hotelsByRoute.get(routeId) || [];
      // Avoid duplicates: check if hotel already exists by hotel code + provider
      const hotelStrs = existingHotels.map(h => `${h.hotelCode}|${h.provider}`);
      const newHotels = resavenueHotels.filter(h => !hotelStrs.includes(`${h.hotelCode}|${h.provider}`));
      if (newHotels.length > 0) {
        this.logger.log(`   ✅ Added ${newHotels.length} new ResAvenue hotel(s) to route ${routeId}`);
      }
      hotelsByRoute.set(routeId, [...existingHotels, ...newHotels]);
    });
    
    // Debug: Check if any hotels were found
    const hotelEntries = Array.from(hotelsByRoute.entries());
    this.logger.log(`\n📊 HOTEL FETCH RESULTS (TBO + HOBSE):`);
    hotelEntries.forEach(([routeId, hotels]) => {
      const tboCount = hotels.filter(h => h.provider === 'tbo').length;
      const hobseCount = hotels.filter(h => h.provider === 'hobse').length;
      this.logger.log(`   Route ${routeId}: ${hotels.length} hotels (TBO: ${tboCount}, HOBSE: ${hobseCount})`);
      if (hotels.length > 0) {
        this.logger.log(`      - ${hotels.map(h => `${h.hotelName} (${h.provider})`).join(', ')}`);
      }
    });
    
    if (hotelEntries.every(([_, hotels]) => hotels.length === 0)) {
      this.logger.warn(`\n❌ WARNING: ALL ROUTES RETURNED ZERO HOTELS!\n`);
    }
    
    this.logger.log(`🏨 Hotels by Route: ${JSON.stringify(Object.fromEntries(hotelsByRoute))}`);

    // Step 4: Generate 4 price tier packages
    const packages = this.generatePricePackages(hotelsByRoute, routes);

    // Step 5: Build response
    const response = await this.buildHotelDetailsResponse(
      quoteId,
      planId,
      packages,
      hotelsByRoute,
      routes,
      noOfNights,
    );

    const duration = Date.now() - startTime;
    this.logger.log(`✅ Generated ${packages.length} hotel packages`);
    this.logger.log(`⏱️  Total TBO Service Time: ${duration}ms\n`);

    this.setCachedHotelDetails(quoteId, response);

    try {
      await this.syncToDb(quoteId, planId, response.hotels, routes, noOfNights);
      return this.buildPagedResponseFromDb(
        quoteId,
        planId,
        hotelRatesVisible,
        safePage,
        safePageSize,
        requestedGroupType,
        effectiveRouteIds,
        response.hotelAvailability,
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed DB sync/read pagination path. Falling back to in-memory pagination: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.paginateInMemoryResponse(response, safePage, safePageSize, requestedGroupType);
    }
  }

  private getSearchableRouteIds(routes: any[], noOfNights: number): number[] {
    return routes
      .filter((_, index) => {
        const isLastRoute = index === routes.length - 1;
        return !(isLastRoute && index >= noOfNights);
      })
      .map((route: any) => Number(route.itinerary_route_ID || 0))
      .filter((id: number) => id > 0);
  }

  private getGroupLabel(groupType: number): string {
    const labels: Record<number, string> = {
      1: 'Budget Hotels',
      2: 'Mid-Range Hotels',
      3: 'Premium Hotels',
      4: 'Luxury Hotels',
    };
    return labels[groupType] || `Group ${groupType}`;
  }

  private async buildPagedResponseFromDb(
    quoteId: string,
    planId: number,
    hotelRatesVisible: boolean,
    page: number,
    pageSize: number,
    requestedGroupType: number | undefined,
    searchableRouteIds: number[],
    hotelAvailability?: ItineraryHotelDetailsResponseDto['hotelAvailability'],
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const groups = requestedGroupType ? [requestedGroupType] : [1, 2, 3, 4];
    const hotels: ItineraryHotelRowDto[] = [];
    const pagination: Record<number, import('./itinerary-hotel-details.service').HotelPaginationMeta> = {};
    const routePagination: Record<string, import('./itinerary-hotel-details.service').HotelRoutePaginationMeta> = {};
    const previousDayBillingMarkers = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: planId,
        hotel_required: 2,
        hotel_id: 0,
        deleted: 0,
        group_type: { in: groups },
      },
      select: {
        itinerary_route_id: true,
        itinerary_route_date: true,
        itinerary_route_location: true,
        group_type: true,
      },
    });
    const previousDayBillingMarkerMap = new Map(
      previousDayBillingMarkers.map((marker: any) => [
        `${Number(marker.itinerary_route_id || 0)}-${Number(marker.group_type || 0)}`,
        {
          date: marker.itinerary_route_date,
          destination: String(marker.itinerary_route_location || '').trim(),
        },
      ]),
    );

    await Promise.all(
      groups.map(async (groupType) => {
        const { rows, total, hasMore, routeMeta } = await this.readPagedHotelsFromDb(
          quoteId,
          groupType,
          page,
          pageSize,
          searchableRouteIds,
        );

        for (const row of rows) {
          try {
            const payload = JSON.parse(row.full_payload || '{}') as ItineraryHotelRowDto;
            const normalizedPayload: ItineraryHotelRowDto = {
              ...payload,
              category: this.normalizeStarCategoryValue((payload as any).category),
            };
            const previousDayBillingMarker = previousDayBillingMarkerMap.get(
              `${Number(normalizedPayload.itineraryRouteId || 0)}-${groupType}`,
            );
            const payloadDayLabel = String(normalizedPayload.day || '');
            const payloadAlreadyPreviousDay = /\(Previous Day\)/i.test(payloadDayLabel);
            if (previousDayBillingMarker?.date && !payloadAlreadyPreviousDay) {
              const previousDayDate = new Date(previousDayBillingMarker.date as any)
                .toISOString()
                .split('T')[0];
              const baseDayLabel = payloadDayLabel
                .split('|')[0]
                .replace(/\(Previous Day\)/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
              hotels.push({
                ...normalizedPayload,
                day: `${baseDayLabel} (Previous Day) | ${previousDayDate}`,
                date: previousDayDate,
                destination: previousDayBillingMarker.destination || normalizedPayload.destination,
              });
            }
            hotels.push(normalizedPayload);
          } catch {
            hotels.push({
              groupType: row.group_type,
              itineraryRouteId: row.route_id,
              day: '',
              destination: '',
              hotelId: 0,
              hotelName: row.hotel_name,
              category: this.normalizeStarCategoryValue(row.rating),
              roomType: row.room_type || '',
              mealPlan: row.meal_plan || '-',
              totalHotelCost: Number(row.price || 0),
              totalHotelTaxAmount: 0,
              searchReference: row.search_reference || undefined,
              provider: row.provider || 'tbo',
            });
          }
        }

        pagination[groupType] = { page, pageSize, total, hasMore };
        for (const [routeId, meta] of Object.entries(routeMeta)) {
          const compositeKey = `${groupType}-${routeId}`;
          routePagination[compositeKey] = {
            page: meta.page,
            pageSize: meta.pageSize,
            total: meta.total,
            hasMore: meta.hasMore,
            groupType,
          };
        }
      }),
    );

    const tabGroups = [1, 2, 3, 4];
    const tabTotals = await Promise.all(
      tabGroups.map((groupType) =>
        this.prisma.dvi_itinerary_hotel_search_cache.aggregate({
          _sum: { price: true },
          where: {
            quote_id: quoteId,
            group_type: groupType,
            route_id: { in: searchableRouteIds },
            deleted: 0,
            status: 1,
            sort_rank: 1, // cheapest hotel per route only
          },
        }),
      ),
    );

    const hotelTabs: ItineraryHotelTabDto[] = tabGroups.map((groupType, index) => ({
      groupType,
      label: this.getGroupLabel(groupType),
      totalAmount: Number(tabTotals[index]?._sum?.price || 0),
    }));

    return {
      quoteId,
      planId,
      hotelRatesVisible,
      hotelTabs,
      hotels,
      totalRoomCount: hotels.length,
      hotelAvailability,
      pagination,
      routePagination,
    };
  }

  private paginateInMemoryResponse(
    response: ItineraryHotelDetailsResponseDto,
    page: number,
    pageSize: number,
    requestedGroupType?: number,
  ): ItineraryHotelDetailsResponseDto {
    const groups = requestedGroupType ? [requestedGroupType] : [1, 2, 3, 4];
    const pagedRows: ItineraryHotelRowDto[] = [];
    const pagination: Record<number, import('./itinerary-hotel-details.service').HotelPaginationMeta> = {};

    for (const groupType of groups) {
      const routeBuckets = new Map<number, ItineraryHotelRowDto[]>();
      response.hotels
        .filter((row) => Number(row.groupType) === groupType)
        .forEach((row) => {
          const routeId = Number(row.itineraryRouteId || 0);
          if (!routeBuckets.has(routeId)) routeBuckets.set(routeId, []);
          routeBuckets.get(routeId)!.push(row);
        });

      let groupTotal = 0;
      let groupHasMore = false;

      for (const [routeId, rows] of routeBuckets.entries()) {
        const sortedRows = [...rows].sort((a, b) => {
          const ratingDiff = Number(b.category || 0) - Number(a.category || 0);
          if (ratingDiff !== 0) return ratingDiff;
          const priceA = Number(a.totalHotelCost || 0) + Number(a.totalHotelTaxAmount || 0);
          const priceB = Number(b.totalHotelCost || 0) + Number(b.totalHotelTaxAmount || 0);
          return priceA - priceB;
        });
        groupTotal += sortedRows.length;
        if (page * pageSize < sortedRows.length) groupHasMore = true;

        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        pagedRows.push(...sortedRows.slice(start, end));
      }

      pagination[groupType] = {
        page,
        pageSize,
        total: groupTotal,
        hasMore: groupHasMore,
      };
    }

    return {
      ...response,
      hotels: pagedRows,
      totalRoomCount: pagedRows.length,
      pagination,
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
    adultCount: number = 2,
    childCount: number = 0,
    childAges: number[] = [],
    roomCount: number = 1,
    searchPreferences?: {
      mealPlanCode?: string;
      tboMealType?: string;
      starRatings?: number[];
      stdBudgetSelected?: boolean;
    },
  ): Promise<Map<number, HotelSearchResult[] | null>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[] | null>();

    // 🔥 OPTIMIZATION 1: Batch load ALL cities upfront instead of querying per route
    const cityCodeMap = await this.batchMapDestinationsToCityCodes(routes);
    this.logger.log(`✅ Pre-loaded ${Object.keys(cityCodeMap).length} city codes for all routes`);

    // Build stay blocks so TBO search is done once per destination-stay window,
    // not once per day/route.
    const stayBlocks = this.buildStayBlocks(routes, noOfNights);
    this.logger.log(`🧩 Built ${stayBlocks.length} stay block(s) for consolidated TBO search`);

    // 🔥 OPTIMIZATION 2: Prepare all hotel search tasks for parallel execution
    const searchTasks: Promise<void>[] = [];

    for (const block of stayBlocks) {
      searchTasks.push(
        this.searchHotelsForStayBlock(
          block,
          cityCodeMap,
          guestNationality,
          adultCount,
          childCount,
          childAges,
          roomCount,
          searchPreferences,
        )
          .then((hotels) => {
            block.routeIds.forEach((routeId) => hotelsByRoute.set(routeId, hotels || []));
          })
          .catch((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(
              `❌ HOTEL SEARCH ERROR for stay block ${block.destination} (${block.checkInDate} -> ${block.checkOutDate}): ${errorMsg}`,
            );
            block.routeIds.forEach((routeId) => hotelsByRoute.set(routeId, null)); // null = provider failure
          }),
      );
    }

    // 🔥 OPTIMIZATION 3: Execute all searches in parallel instead of sequentially
    this.logger.log(`⏳ Starting ${searchTasks.length} parallel hotel searches...`);
    await Promise.all(searchTasks);
    this.logger.log(`✅ All parallel searches completed`);

    return hotelsByRoute;
  }

  // Normalize destination labels (e.g. "Kanchipuram, Railway Station") to a searchable city token.
  private normalizeDestinationName(destination: string): string {
    const raw = String(destination || '').trim();
    if (!raw) return '';
    const firstPart = raw.split(/[,(\-]/)[0]?.trim() || raw;
    return firstPart.replace(/\s+/g, ' ').trim();
  }

  private buildStayBlocks(
    routes: any[],
    noOfNights: number,
  ): Array<{
    destination: string;
    checkInDate: string;
    checkOutDate: string;
    routeIds: number[];
  }> {
    const blocks: Array<{
      destination: string;
      checkInDate: string;
      checkOutDate: string;
      routeIds: number[];
    }> = [];

    const totalRoutes = routes.length;
    let currentBlock: {
      destination: string;
      checkInDate: string;
      checkOutDate: string;
      routeIds: number[];
      lastDate: Date;
    } | null = null;

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      const isLastRoute = routeIndex === totalRoutes - 1;
      if (isLastRoute && routeIndex >= noOfNights) {
        this.logger.log(`   ⏭️  Skipping route ${routeIndex + 1} (last route - departure day, no hotel needed)`);
        continue;
      }

      const routeId = Number((route as any).itinerary_route_ID);
      const destinationRaw = String(
        (route as any).next_visiting_location || (route as any).location_name || '',
      ).trim();
      const destination = this.normalizeDestinationName(destinationRaw);
      const routeDate = new Date((route as any).itinerary_route_date);
      const checkInDate = routeDate.toISOString().split('T')[0];
      const nextDay = new Date(routeDate.getTime() + ItineraryHotelDetailsTboService.ONE_DAY_MS);
      const checkOutDate = nextDay.toISOString().split('T')[0];

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
        routeDate.getTime() - currentBlock.lastDate.getTime() === ItineraryHotelDetailsTboService.ONE_DAY_MS;

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

  /**
   * Batch load city codes for all destinations in one pass
   * Reduces database queries from N×3 (N routes × 3 attempts) to 1 query
   */
  private async batchMapDestinationsToCityCodes(routes: any[]): Promise<Record<string, string>> {
    const cityCodeMap: Record<string, string> = {};
    
    // Extract unique destinations from all routes
    const uniqueDestinations = [...new Set(routes.map(r => (r as any).next_visiting_location))];
    this.logger.log(`📍 Extracting city codes for ${uniqueDestinations.length} unique destinations`);

    if (uniqueDestinations.length === 0) return cityCodeMap;

    // ⚡ Load ALL cities from database in ONE query instead of per-route queries
    const allCities = await this.prisma.dvi_cities.findMany({
      select: { name: true, tbo_city_code: true },
    });
    this.logger.log(`✅ Loaded ${allCities.length} cities from database in single query`);

    // Build a map for fast lookup
    const cityNameMap: Record<string, string> = {};
    const cityPrefixMap: Record<string, string> = {};
    
    allCities.forEach(city => {
      if (city.tbo_city_code) {
        cityNameMap[city.name.toLowerCase()] = city.tbo_city_code;
        const prefix = city.name.split(',')[0].trim().toUpperCase();
        cityPrefixMap[prefix] = city.tbo_city_code;
      }
    });

    // Map each destination to city code
    uniqueDestinations.forEach(destination => {
      if (!destination) return;

      const normalizedDestination = this.normalizeDestinationName(destination);

      // Try exact match (case-insensitive)
      let cityCode = cityNameMap[destination.toLowerCase()] || cityNameMap[normalizedDestination.toLowerCase()];
      
      if (!cityCode) {
        // Try partial match with first part
        const firstPart = this.normalizeDestinationName(destination);
        cityCode = cityNameMap[firstPart.toLowerCase()];
      }

      if (!cityCode) {
        // Try prefix match
        const prefix = this.normalizeDestinationName(destination).toUpperCase();
        cityCode = cityPrefixMap[prefix];
      }

      if (cityCode) {
        this.logger.log(`✅ "${destination}" → TBO Code: ${cityCode}`);
        cityCodeMap[destination] = cityCode;
        // Also index by normalized token because stay blocks use normalized destination labels.
        cityCodeMap[normalizedDestination] = cityCode;
      } else {
        this.logger.warn(`❌ No city code found for: "${destination}"`);
      }
    });

    return cityCodeMap;
  }

  /**
     * Batch load HOBSE city codes for all destinations using hobse_city_code field.
     */
    private async batchMapDestinationsToHobseCityCodes(routes: any[]): Promise<Record<string, string>> {
      const cityCodeMap: Record<string, string> = {};
      const uniqueDestinations = [...new Set(routes.map(r => (r as any).next_visiting_location))] as string[];

      this.logger.log(`📍 Loading HOBSE city codes for ${uniqueDestinations.length} unique destinations`);
      if (uniqueDestinations.length === 0) return cityCodeMap;

      const allCities = await this.prisma.dvi_cities.findMany({
        select: { name: true, hobse_city_code: true } as any,
      });
      this.logger.log(`✅ Loaded ${allCities.length} cities for HOBSE code lookup`);

      const cityNameMap: Record<string, string> = {};
      const cityPrefixMap: Record<string, string> = {};

      allCities.forEach((city: any) => {
        if (city.hobse_city_code) {
          cityNameMap[city.name.toLowerCase()] = String(city.hobse_city_code);
          const prefix = city.name.split(',')[0].trim().toLowerCase();
          cityPrefixMap[prefix] = String(city.hobse_city_code);
        }
      });

      uniqueDestinations.forEach(destination => {
        if (!destination) return;
        const lower = destination.toLowerCase();
        let code = cityNameMap[lower];

        if (!code) {
          const firstPart = destination.split(/[,\(\-]/)[0].trim().toLowerCase();
          code = cityNameMap[firstPart] || cityPrefixMap[firstPart];
        }

        if (code) {
          this.logger.log(`✅ HOBSE "${destination}" -> code: ${code}`);
          cityCodeMap[destination] = code;
          cityCodeMap[this.normalizeDestinationName(destination)] = code;
        } else {
          this.logger.warn(`❌ No HOBSE city code found for: "${destination}"`);
        }
      });

      return cityCodeMap;
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
    adultCount: number = 2,
    childCount: number = 0,
    childAges: number[] = [],
    roomCount: number = 1,
    searchPreferences?: {
      mealPlanCode?: string;
      tboMealType?: string;
      starRatings?: number[];
      stdBudgetSelected?: boolean;
    },
  ): Promise<HotelSearchResult[]> {
    const destination = this.normalizeDestinationName(block.destination);

    this.logger.log(
      `🔍 Stay block (${block.routeIds.join(',')}): Searching hotels for "${destination}" (${block.checkInDate} -> ${block.checkOutDate})`,
    );

    // Get city code from pre-loaded map (no database query!)
    const cityCode = cityCodeMap[block.destination] || cityCodeMap[destination];

    // Fallback: if dvi_cities mapping is missing, use destination text directly.
    const effectiveCityCode = cityCode || destination;
    if (!cityCode) {
      this.logger.warn(
        `⚠️ Stay block (${block.routeIds.join(',')}): No mapped TBO city code for "${destination}". Falling back to destination text lookup.`,
      );
    }

    // Use pax counts from the plan; guarantee at least 1 adult so TBO validation passes
    if (adultCount <= 0) {
      this.logger.warn(
        `⚠️ Stay block (${block.routeIds.join(',')}): adultCount is ${adultCount} (not saved in plan?) - defaulting to 1`,
      );
    }
    const safeAdultCount = adultCount > 0 ? adultCount : 1;
    const safeChildCount = childCount >= 0 ? childCount : 0;
    const safeChildAges = this.normalizeChildAges(childAges, safeChildCount);
    const safeRoomCount = Number.isFinite(Number(roomCount)) && Number(roomCount) > 0 ? Number(roomCount) : 1;
    const guestCount = safeAdultCount + safeChildCount;
    const destinationLower = String(destination || '').trim().toLowerCase();
    const forceTwoRoomsForDestination = destinationLower === 'kodaikanal';
    const effectiveRoomCount =
      safeRoomCount === 1 && (forceTwoRoomsForDestination || (safeChildCount > 0 && guestCount >= 5))
        ? 2
        : safeRoomCount;

    if (effectiveRoomCount !== safeRoomCount) {
      this.logger.log(
        `   🛏️  Auto-adjusting roomCount from ${safeRoomCount} to ${effectiveRoomCount} for occupancy adults=${safeAdultCount}, children=${safeChildCount}`,
      );
    }

    const searchCriteria = {
      cityCode: effectiveCityCode,
      checkInDate: block.checkInDate,
      checkOutDate: block.checkOutDate,
      roomCount: effectiveRoomCount,
      guestCount,
      adultCount: safeAdultCount,
      childCount: safeChildCount,
      childAges: safeChildCount > 0 ? safeChildAges : undefined,
      guestNationality,
      providers: ['tbo', 'resavenue'], // Only TBO + ResAvenue - HOBSE will be merged separately
      preferences:
        (searchPreferences?.mealPlanCode || (searchPreferences?.starRatings || []).length > 0)
          ? {
              mealPlanCode: searchPreferences?.mealPlanCode,
              tboMealType: searchPreferences?.tboMealType,
              starRatings: searchPreferences?.starRatings,
            }
          : undefined,
    };

    const attachRoomCountMeta = (rows: HotelSearchResult[], roomCountUsed: number): HotelSearchResult[] => {
      return (rows || []).map((h: any) => ({
        ...h,
        roomCountUsed,
      }));
    };

    this.logger.log(
      `   🏨 Searching hotels with cityCode: ${effectiveCityCode}, checkIn: ${block.checkInDate}, checkOut: ${block.checkOutDate}`,
    );
    const hotels = await this.hotelSearchService.searchHotels(searchCriteria);
    const filteredHotels = this.applyCategoryPreferenceFilter(hotels || [], searchPreferences);
    this.logger.log(
      `   ✅ Found ${filteredHotels.length} hotels for stay block (${block.routeIds.join(',')}) after category filters`,
    );

    if (filteredHotels.length === 0 && safeChildCount > 0) {
      if (safeRoomCount < 2) {
        this.logger.warn(
          `   ⚠️  No hotels for child-inclusive occupancy with ${safeRoomCount} room. Retrying with 2-room split for stay block (${block.routeIds.join(',')}).`,
        );

        const twoRoomCriteria = {
          ...searchCriteria,
          roomCount: 2,
        };

        const twoRoomHotels = await this.hotelSearchService.searchHotels(twoRoomCriteria);
        const filteredTwoRoomHotels = this.applyCategoryPreferenceFilter(twoRoomHotels || [], searchPreferences);
        this.logger.log(
          `   ✅ Two-room child-inclusive retry found ${filteredTwoRoomHotels.length} hotels for stay block (${block.routeIds.join(',')}) after category filters`,
        );

        if (filteredTwoRoomHotels.length > 0) {
          return attachRoomCountMeta(filteredTwoRoomHotels, 2);
        }
      }

      this.logger.warn(
        `   ⚠️  No hotels for child-inclusive occupancy (adults=${safeAdultCount}, children=${safeChildCount}, rooms=${safeRoomCount}) on stay block (${block.routeIds.join(',')}). Retrying with adult-only fallback.`,
      );

      const fallbackCriteria = {
        ...searchCriteria,
        guestCount: safeAdultCount,
        childCount: 0,
        childAges: undefined,
      };

      const fallbackHotels = await this.hotelSearchService.searchHotels(fallbackCriteria);
      const filteredFallbackHotels = this.applyCategoryPreferenceFilter(fallbackHotels || [], searchPreferences);
      this.logger.log(
        `   ✅ Adult-only fallback found ${filteredFallbackHotels.length} hotels for stay block (${block.routeIds.join(',')}) after category filters`,
      );

      if (filteredFallbackHotels.length > 0) {
        return attachRoomCountMeta(filteredFallbackHotels, effectiveRoomCount);
      }
    }
    
    if (filteredHotels.length > 0) {
      this.logger.log(`   📋 TBO Hotels for stay block (${block.routeIds.join(',')}):`);
      filteredHotels.forEach((h, idx) => {
        this.logger.log(`      ${idx + 1}. ${h.hotelName} (${h.provider}) - ₹${h.price}`);
      });
    } else {
      this.logger.log(`   ⚠️  WARNING: TBO search returned ZERO hotels for stay block (${block.routeIds.join(',')})!`);
    }

    return attachRoomCountMeta(filteredHotels, effectiveRoomCount);
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
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const totalRoutes = routes.length;

    this.logger.log(`\n🏨 HOBSE HOTEL FETCH: Attempting to fetch HOBSE hotels for ${routes.length} routes`);

    try {
      for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex];
        const routeId = (route as any).itinerary_route_ID;
        
        // Skip hotel generation for the last route (departure day) if routeIndex >= noOfNights
        const isLastRoute = routeIndex === totalRoutes - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
          this.logger.log(`   ⏭️  Skipping HOBSE route ${routeIndex + 1} (last route - departure day)`);
          continue;
        }
        
        const destination = (route as any).next_visiting_location;
        // Get the HOBSE city code from the pre-built map
        const cityCode = cityCodeMap[destination];
        
        if (!cityCode) {
          this.logger.warn(`   ⚠️  No HOBSE city code for destination "${destination}" - skipping HOBSE search`);
          hotelsByRoute.set(routeId, []);
          continue;
        }
        const routeDate = new Date((route as any).itinerary_route_date);
        const checkOutDate = new Date(routeDate);
        checkOutDate.setDate(checkOutDate.getDate() + 1);

        try {
          // Pass city code (number) instead of destination name (string)
          const hobseHotels = await this.hobseProvider.search({
            cityCode: cityCode,
            checkInDate: routeDate.toISOString().split('T')[0],
            checkOutDate: checkOutDate.toISOString().split('T')[0],
            roomCount: 1,
            guestCount: 2,
          });

          if (hobseHotels && hobseHotels.length > 0) {
            this.logger.log(`   ✅ HOBSE Route ${routeId}: Found ${hobseHotels.length} hotels in ${destination}`);
            hotelsByRoute.set(routeId, hobseHotels);
          } else {
            this.logger.log(`   ℹ️  HOBSE Route ${routeId}: No hotels found in ${destination}`);
            hotelsByRoute.set(routeId, []);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`   ⚠️  HOBSE Route ${routeId} search failed: ${errorMsg}`);
          hotelsByRoute.set(routeId, []);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ HOBSE HOTEL FETCH FAILED: ${errorMsg}`);
    }

    return hotelsByRoute;
  }

  /**
   * Fetch ResAvenue hotels for each route
   * Searches for properties using destination city names
   */
  private async fetchResavenueHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    guestNationality: string,
    adultCount: number = 2,
    childCount: number = 0,
    childAges: number[] = [],
    roomCount: number = 1,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const totalRoutes = routes.length;

    this.logger.log(`\n🏨 RESAVENUE HOTEL FETCH: Attempting to fetch ResAvenue hotels for ${routes.length} routes`);

    try {
      const safeAdultCount = adultCount > 0 ? adultCount : 1;
      const safeChildCount = childCount >= 0 ? childCount : 0;
      const safeChildAges = this.normalizeChildAges(childAges, safeChildCount);
      const safeRoomCount = Number.isFinite(Number(roomCount)) && Number(roomCount) > 0 ? Number(roomCount) : 1;
      const guestCount = safeAdultCount + safeChildCount;

      for (let routeIndex = 0; routeIndex < totalRoutes; routeIndex++) {
        const route = routes[routeIndex];
        const routeId = (route as any).itinerary_route_ID;
        
        // Skip hotel generation for the last route (departure day) if routeIndex >= noOfNights
        const isLastRoute = routeIndex === totalRoutes - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
          this.logger.log(`   ⏭️  Skipping ResAvenue route ${routeIndex + 1} (last route - departure day)`);
          continue;
        }
        
        const destination = (route as any).next_visiting_location;
        const routeDate = new Date((route as any).itinerary_route_date);
        const checkOutDate = new Date(routeDate);
        checkOutDate.setDate(checkOutDate.getDate() + 1);

        try {
          // Search ResAvenue hotels using city name directly
          const resavenueHotels = await this.hotelSearchService.searchHotels({
            cityCode: destination, // ResAvenue provider accepts city names
            checkInDate: routeDate.toISOString().split('T')[0],
            checkOutDate: checkOutDate.toISOString().split('T')[0],
            roomCount: safeRoomCount,
            guestCount,
            adultCount: safeAdultCount,
            childCount: safeChildCount,
            childAges: safeChildCount > 0 ? safeChildAges : undefined,
            guestNationality,
            providers: ['resavenue'], // Only ResAvenue
          });

          if (resavenueHotels && resavenueHotels.length > 0) {
            this.logger.log(`   ✅ ResAvenue Route ${routeId}: Found ${resavenueHotels.length} hotels in ${destination}`);
            hotelsByRoute.set(routeId, resavenueHotels);
          } else {
            this.logger.log(`   ℹ️  ResAvenue Route ${routeId}: No hotels found in ${destination}`);
            hotelsByRoute.set(routeId, []);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`   ⚠️  ResAvenue Route ${routeId} search failed: ${errorMsg}`);
          hotelsByRoute.set(routeId, []);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ RESAVENUE HOTEL FETCH FAILED: ${errorMsg}`);
    }

    return hotelsByRoute;
  }

  private async resolvePlanChildAges(planId: number, expectedChildCount: number): Promise<number[]> {
    if (expectedChildCount <= 0) return [];

    const travellers = await (this.prisma as any).dvi_itinerary_traveller_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        traveller_type: 2,
        deleted: 0,
      },
      orderBy: { traveller_details_ID: 'asc' },
      select: { traveller_age: true },
    });

    const parsedAges = (travellers || [])
      .map((t: any) => Number(t?.traveller_age))
      .filter((age: number) => Number.isFinite(age) && age >= 0 && age <= 11);

    const normalized = this.normalizeChildAges(parsedAges, expectedChildCount);
    this.logger.log(
      `👶 Child ages resolved for plan ${planId}: [${normalized.join(', ')}] (expected children=${expectedChildCount})`,
    );
    return normalized;
  }

  private normalizeChildAges(childAges: number[], expectedChildCount: number): number[] {
    if (expectedChildCount <= 0) return [];

    const validAges = (Array.isArray(childAges) ? childAges : [])
      .map((age) => Number(age))
      .filter((age) => Number.isFinite(age) && age >= 0 && age <= 11);

    if (validAges.length >= expectedChildCount) {
      return validAges.slice(0, expectedChildCount);
    }

    const fallbackAge = 8;
    return [...validAges, ...new Array(expectedChildCount - validAges.length).fill(fallbackAge)];
  }


  private generatePricePackages(
    hotelsByRoute: Map<number, HotelSearchResult[]>,
    routes: any[],
  ): Array<{ groupType: number; label: string; hotels: Array<HotelSearchResult & { routeId: number }> }> {
    const packages: Array<{
      groupType: number;
      label: string;
      hotels: Array<HotelSearchResult & { routeId: number }>;
    }> = [];

    const labels = [
      'Budget Hotels',
      'Mid-Range Hotels',
      'Premium Hotels',
      'Luxury Hotels',
    ];

    // Debug: Log all available hotels
    this.logger.log(`\n   📊 PRICE TIER GENERATION DEBUG (PER-DESTINATION):`);
    this.logger.log(`   Total routes: ${routes.length}`);
    hotelsByRoute.forEach((hotels, routeId) => {
      const prices = hotels.map(h => h.price).join(', ');
      this.logger.log(`   Route ${routeId}: ${hotels.length} hotels (Prices: ${prices})`);
    });

    // NEW LOGIC: Assign hotels to groups PER DESTINATION (per route)
    // Rule: If 1 hotel -> put in all 4 groups
    //       If 2+ hotels -> distribute in ascending price order across groups
    
    // First pass: Determine groupType for each hotel based on its destination
    const hotelGroupAssignments = new Map<string, number>(); // key: "routeId-hotelCode" -> groupType
    
    for (const route of routes) {
      const routeId = (route as any).itinerary_route_ID;
      const availableHotels = hotelsByRoute.get(routeId);

      if (availableHotels === null) {
        this.logger.warn(`      🚨 Provider/system failure for route ${routeId} — skipping placeholder row. See previous logs for error.`);
        continue;
      }
      if (!Array.isArray(availableHotels) || availableHotels.length === 0) {
        this.logger.warn(`      ⚠️  No hotels available for route ${routeId}`);
        continue;
      }

      // Sort hotels by price (ascending) for this destination
      const sortedHotels = [...availableHotels].sort((a, b) => a.price - b.price);

      if (sortedHotels.length === 1) {
        // Single hotel: assign to ALL 4 groups
        const hotel = sortedHotels[0];
        for (let groupType = 1; groupType <= 4; groupType++) {
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          hotelGroupAssignments.set(`${key}:${groupType}`, groupType);
        }
        this.logger.debug(`   Route ${routeId}: 1 hotel - "${hotel.hotelName}" (₹${hotel.price}) assigned to ALL groups`);
      } else {
        // Multiple hotels: distribute across groups by price order
        const numHotels = sortedHotels.length;
        const groupsNeeded = Math.min(numHotels, 4);
        
        sortedHotels.forEach((hotel, index) => {
          // Map hotels to groups in ascending price order
          let groupType = 1;
          if (numHotels <= 4) {
            // Fewer hotels than groups: distribute evenly
            groupType = Math.min(index + 1, 4);
          } else {
            // More hotels than groups: distribute proportionally
            groupType = Math.floor((index / numHotels) * 4) + 1;
            groupType = Math.min(groupType, 4);
          }
          
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          hotelGroupAssignments.set(`${key}:${groupType}`, groupType);
        });
        
        this.logger.debug(`   Route ${routeId}: ${numHotels} hotels - Distributed across groups by price order`);
        sortedHotels.forEach((h, i) => {
          const key = `${routeId}-${h.hotelCode || h.hotelName}`;
          let groupType = 1;
          if (numHotels <= 4) {
            groupType = Math.min(i + 1, 4);
          } else {
            groupType = Math.floor((i / numHotels) * 4) + 1;
            groupType = Math.min(groupType, 4);
          }
          this.logger.debug(`      "${h.hotelName}" (₹${h.price}) -> Group ${groupType}`);
        });
      }
    }

    // Second pass: Build packages from the assignments
    for (let tier = 0; tier < 4; tier++) {
      const groupType = tier + 1;
      const tieredHotels: Array<HotelSearchResult & { routeId: number }> = [];

      for (const route of routes) {
        const routeId = (route as any).itinerary_route_ID;
        const availableHotels = hotelsByRoute.get(routeId);

        if (availableHotels === null) {
          this.logger.warn(`   🚨 Provider/system failure for route ${routeId} — not inserting placeholder row. See previous logs for error.`);
          continue;
        }
        if (!Array.isArray(availableHotels) || availableHotels.length === 0) {
          this.logger.debug(`   Tier ${groupType}, Route ${routeId}: No hotels available`);
          // CREATE PLACEHOLDER FOR NO HOTELS - price 0
          const placeholderHotel: any = {
            hotelCode: '0',
            hotelName: 'No Hotels Available',
            roomType: '-',
            mealPlan: '-',
            price: 0,
            rating: 0,
            routeId: routeId
          };
          tieredHotels.push(placeholderHotel);
          continue;
        }

        let foundForGroup = false;

        // Get hotels that belong to this tier for this route
        for (const hotel of availableHotels) {
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          const assignedGroupType = hotelGroupAssignments.get(`${key}:${groupType}`);
          
          if (assignedGroupType === groupType) {
            const hotelWithRoute = { ...hotel, routeId } as HotelSearchResult & { routeId: number };
            tieredHotels.push(hotelWithRoute);
            foundForGroup = true;
          }
        }

        // Overlap fallback: if this route has hotels but none mapped to current tier,
        // pick deterministic fallback by sorted price index so every tier has data.
        if (!foundForGroup && availableHotels.length > 0) {
          const sortedHotels = [...availableHotels].sort((a, b) => (a.price || 0) - (b.price || 0));
          const fallbackIndex = Math.min(groupType - 1, sortedHotels.length - 1);
          const fallbackHotel = sortedHotels[fallbackIndex];
          if (fallbackHotel) {
            const fallbackWithRoute = {
              ...fallbackHotel,
              routeId,
              __fallbackAssigned: true,
            } as HotelSearchResult & { routeId: number };
            tieredHotels.push(fallbackWithRoute);
            this.logger.debug(
              `   Tier ${groupType}, Route ${routeId}: overlap fallback -> ${fallbackHotel.hotelName}`,
            );
          }
        }
      }

      // Add package with ALL matching hotels for this tier
      if (tieredHotels.length > 0) {
        const totalPrice = tieredHotels.reduce((sum, h) => sum + h.price, 0);
        packages.push({
          groupType: groupType,
          label: labels[tier],
          hotels: tieredHotels,
        });
        this.logger.log(`   ✅ Group ${groupType} (${labels[tier]}): ${tieredHotels.length} hotels total, ₹${totalPrice} combined`);
      } else {
        this.logger.log(`   ⚠️  Group ${groupType} (${labels[tier]}): No hotels found for any route`);
      }
    }

    this.logger.log(`📦 Generated ${packages.length} price tier packages\n`);
    return packages;
  }

  // ─── DB cache helpers ──────────────────────────────────────────────────────

  /** Soft-clear cached hotel rows for a quote so the next request does a fresh supplier fetch. */
  async clearHotelCacheForQuote(quoteId: string): Promise<number> {
    const result = await this.prisma.dvi_itinerary_hotel_search_cache.updateMany({
      where: { quote_id: quoteId, deleted: 0 },
      data: { deleted: 1 },
    });

    this.logger.log(
      `♻️ Cleared hotel cache for quote ${quoteId}: ${result.count} active row(s) marked deleted`,
    );
    return result.count;
  }

  /**
   * Returns true when cache should be refreshed.
   * - Normal cache rows: 40 minutes
   * - Placeholder-only cache rows: 5 minutes
   */
  private async isDbCacheStale(
    quoteId: string,
    routeIds: number[] = [],
    groupType?: number,
  ): Promise<boolean> {
    const scopeWhere: any = {
      quote_id: quoteId,
      deleted: 0,
    };

    if (Array.isArray(routeIds) && routeIds.length > 0) {
      scopeWhere.route_id = { in: routeIds };
    }

    if (groupType && Number(groupType) > 0) {
      scopeWhere.group_type = Number(groupType);
    }

    const [newest, totalRows, supplierRows] = await Promise.all([
      this.prisma.dvi_itinerary_hotel_search_cache.findFirst({
        where: scopeWhere,
        orderBy: { synced_at: 'desc' },
        select: { synced_at: true },
      }),
      this.prisma.dvi_itinerary_hotel_search_cache.count({
        where: scopeWhere,
      }),
      this.prisma.dvi_itinerary_hotel_search_cache.count({
        where: {
          ...scopeWhere,
          hotel_name: { not: 'No Hotels Available' },
        },
      }),
    ]);

    if (!newest || totalRows === 0) return true;

    // Guard against partial cache corruption: every searchable route must have
    // at least one cached row per expected group, otherwise force a rebuild.
    const normalizedRouteIds = Array.from(
      new Set(
        (routeIds || [])
          .map((id) => Number(id || 0))
          .filter((id) => id > 0),
      ),
    );

    if (normalizedRouteIds.length > 0) {
      const expectedGroups =
        groupType && Number(groupType) > 0 ? [Number(groupType)] : [1, 2, 3, 4];

      const coverageRows = await this.prisma.dvi_itinerary_hotel_search_cache.groupBy({
        by: ['route_id', 'group_type'],
        where: {
          quote_id: quoteId,
          deleted: 0,
          status: 1,
          route_id: { in: normalizedRouteIds },
          group_type: { in: expectedGroups },
        },
        _count: {
          _all: true,
        },
      });

      const coverageKeys = new Set(
        coverageRows.map((row: any) => `${Number(row.route_id || 0)}-${Number(row.group_type || 0)}`),
      );

      for (const routeId of normalizedRouteIds) {
        for (const expectedGroup of expectedGroups) {
          const key = `${routeId}-${expectedGroup}`;
          if (!coverageKeys.has(key)) {
            this.logger.warn(
              `Hotel cache incomplete for quote ${quoteId} (missing route=${routeId}, group=${expectedGroup}); forcing refresh.`,
            );
            return true;
          }
        }
      }
    }

    const ageMs = Date.now() - newest.synced_at.getTime();
    const isPlaceholderOnly = supplierRows === 0;

    if (isPlaceholderOnly) {
      return ageMs > ItineraryHotelDetailsTboService.PLACEHOLDER_ONLY_DB_CACHE_TTL_MS;
    }

    return ageMs > ItineraryHotelDetailsTboService.DB_CACHE_TTL_MS;
  }

  /** Write paginable hotel rows to DB, computing sort_rank per (route_id, group_type). */
  private async syncToDb(
    quoteId: string,
    planId: number,
    hotelRows: ItineraryHotelRowDto[],
    routes: any[],
    noOfNights: number,
  ): Promise<void> {
    const now = new Date();

    await this.prisma.dvi_itinerary_hotel_search_cache.updateMany({
      where: { quote_id: quoteId },
      data: { deleted: 1 },
    });

    const searchableRouteIds = new Set(this.getSearchableRouteIds(routes, noOfNights));
    const routeDateById = new Map<number, Date>();
    for (const route of routes) {
      const routeId = Number((route as any).itinerary_route_ID || 0);
      if (!routeId) continue;
      routeDateById.set(routeId, new Date((route as any).itinerary_route_date || now));
    }

    const buckets = new Map<string, ItineraryHotelRowDto[]>();
    for (const row of hotelRows) {
      const routeId = Number(row.itineraryRouteId || 0);
      const groupType = Number(row.groupType || 0);
      if (!routeId || !groupType || !searchableRouteIds.has(routeId)) continue;
      const key = `${groupType}:${routeId}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }

    const dbRows: any[] = [];
    for (const [key, rows] of buckets.entries()) {
      const [groupTypeStr, routeIdStr] = key.split(':');
      const groupType = Number(groupTypeStr);
      const routeId = Number(routeIdStr);
      const routeDate = routeDateById.get(routeId) || now;
      const checkOutDate = new Date(routeDate);
      checkOutDate.setDate(checkOutDate.getDate() + 1);

      const sortedRows = [...rows].sort((a, b) => {
        const ratingDiff = Number(b.category || 0) - Number(a.category || 0);
        if (ratingDiff !== 0) return ratingDiff;
        const priceA = Number(a.totalHotelCost || 0) + Number(a.totalHotelTaxAmount || 0);
        const priceB = Number(b.totalHotelCost || 0) + Number(b.totalHotelTaxAmount || 0);
        return priceA - priceB;
      });

      sortedRows.forEach((row, idx) => {
        const provider = String(row.provider || 'tbo').trim().toLowerCase();
        const codeBase = String(
          (row as any).bookingCode ||
          (row as any).searchReference ||
          row.hotelId ||
          row.hotelName ||
          `hotel-${routeId}-${groupType}-${idx + 1}`,
        ).trim();
        const hotelCode = `${codeBase}-${idx + 1}`.slice(0, 100);
        const price = Number(row.totalHotelCost || 0) + Number(row.totalHotelTaxAmount || 0);

        dbRows.push({
          quote_id: quoteId,
          plan_id: planId,
          route_id: routeId,
          group_type: groupType,
          hotel_code: hotelCode,
          provider: provider.slice(0, 30),
          hotel_name: String(row.hotelName || '').slice(0, 255),
          rating: Number(row.category || 0),
          price,
          room_type: String(row.roomType || '').slice(0, 255) || null,
          meal_plan: String(row.mealPlan || '').slice(0, 100) || null,
          search_reference: String(row.searchReference || '').slice(0, 65535) || null,
          full_payload: JSON.stringify(row),
          check_in_date: routeDate,
          check_out_date: checkOutDate,
          sort_rank: idx + 1,
          synced_at: now,
          status: 1,
          deleted: 0,
        });
      });
    }

    if (dbRows.length === 0) {
      this.logger.warn(`⚠️ No DB rows prepared for quote ${quoteId}.`);
      return;
    }

    const BATCH_SIZE = 500;
    for (let i = 0; i < dbRows.length; i += BATCH_SIZE) {
      const batch = dbRows.slice(i, i + BATCH_SIZE);
      await this.prisma.dvi_itinerary_hotel_search_cache.createMany({
        data: batch,
        skipDuplicates: true,
      });
    }

    this.logger.log(`✅ Synced ${dbRows.length} hotel rows to DB for quote ${quoteId}`);
  }

  /**
   * Read one page per route/day for a specific group.
   * Page size is applied independently for each route/day.
   */
  private async readPagedHotelsFromDb(
    quoteId: string,
    groupType: number,
    page: number,
    pageSize: number,
    routeIds: number[],
  ): Promise<{
    rows: any[];
    total: number;
    hasMore: boolean;
    routeMeta: Record<number, { page: number; pageSize: number; total: number; hasMore: boolean }>;
  }> {
    const rows: any[] = [];
    let total = 0;
    let hasMore = false;
    const routeMeta: Record<number, { page: number; pageSize: number; total: number; hasMore: boolean }> = {};

    for (const routeId of routeIds) {
      const where = {
        quote_id: quoteId,
        group_type: groupType,
        route_id: routeId,
        deleted: 0,
        status: 1,
      };
      const [routeTotal, routeRows] = await Promise.all([
        this.prisma.dvi_itinerary_hotel_search_cache.count({ where }),
        this.prisma.dvi_itinerary_hotel_search_cache.findMany({
          where,
          orderBy: { sort_rank: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);

      total += routeTotal;
      if (page * pageSize < routeTotal) {
        hasMore = true;
      }
      routeMeta[routeId] = {
        page,
        pageSize,
        total: routeTotal,
        hasMore: page * pageSize < routeTotal,
      };
      rows.push(...routeRows);
    }

    rows.sort((a, b) => {
      const routeDiff = Number(a.route_id || 0) - Number(b.route_id || 0);
      if (routeDiff !== 0) return routeDiff;
      return Number(a.sort_rank || 0) - Number(b.sort_rank || 0);
    });

    return { rows, total, hasMore, routeMeta };
  }

  /** Invalidate DB cache for a quote (e.g. when itinerary dates change) */
  async invalidateHotelCacheForQuote(quoteId: string): Promise<void> {
    await this.prisma.dvi_itinerary_hotel_search_cache.updateMany({
      where: { quote_id: quoteId },
      data: { deleted: 1 },
    });
    // Also clear in-memory cache
    this.hotelDetailsCache.delete(quoteId);
    this.logger.log(`🗑️  Invalidated hotel cache for quote ${quoteId}`);
  }

  /**
   * Build the response DTO
   */
  private async buildHotelDetailsResponse(
    quoteId: string,
    planId: number,
    packages: Array<{ groupType: number; label: string; hotels: Array<HotelSearchResult & { routeId: number }> }>,
    hotelsByRoute: Map<number, HotelSearchResult[]>,
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
    const hotelTabs: ItineraryHotelTabDto[] = packages.map((pkg) => {
      const totalAmount = pkg.hotels.reduce((sum, h) => sum + h.price, 0);
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
        itinerary_route_date: true,
        itinerary_route_location: true,
        hotel_id: true,
        hotel_required: true,
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
      hotelDetailsInDb
        .filter((d: any) => Number(d.hotel_required ?? 0) !== 2)
        .map(d => [
          `${d.itinerary_route_id}-${d.hotel_id}-${d.group_type}`,
          d.itinerary_plan_hotel_details_ID
        ])
    );

    const previousDayBillingMarkerMap = new Map(
      hotelDetailsInDb
        .filter((d: any) => Number(d.hotel_required ?? 0) === 2 && Number(d.hotel_id ?? 0) === 0)
        .map((d: any) => [
          `${d.itinerary_route_id}-${d.group_type}`,
          {
            itineraryRouteDate: d.itinerary_route_date,
            itineraryRouteLocation: d.itinerary_route_location,
          },
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
            ],
          },
          select: {
            tbo_hotel_code: true,
            resavenue_hotel_code: true,
            hotel_code: true,
            hotel_latitude: true,
            hotel_longitude: true,
          },
        })
      : [];

    const hotelCoordsByProviderCode = new Map<string, { lat: number; lon: number }>();
    for (const hm of hotelMasters as any[]) {
      const lat = Number((hm as any).hotel_latitude ?? 0);
      const lon = Number((hm as any).hotel_longitude ?? 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) {
        continue;
      }

      const tboCode = String((hm as any).tbo_hotel_code || '').trim();
      const resavenueCode = String((hm as any).resavenue_hotel_code || '').trim();
      const hobseCode = String((hm as any).hotel_code || '').trim();

      if (tboCode) hotelCoordsByProviderCode.set(`tbo|${tboCode}`, { lat, lon });
      if (resavenueCode) hotelCoordsByProviderCode.set(`resavenue|${resavenueCode}`, { lat, lon });
      if (hobseCode) hotelCoordsByProviderCode.set(`hobse|${hobseCode}`, { lat, lon });
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

    // Build hotel rows (detail rows for each package)
    const hotelRows: ItineraryHotelRowDto[] = [];
    const globalSettings = await this.prisma.dvi_global_settings.findFirst({
      where: { deleted: 0, status: 1 },
      select: {
        itinerary_local_speed_limit: true,
        itinerary_outstation_speed_limit: true,
      },
    });

    // Segment-origin context: prefer last attraction hotspot per route for hotel-leg distance.
    const routeIdsForHotspotLookup = routes.map((r: any) => Number((r as any).itinerary_route_ID || 0)).filter((id: number) => id > 0);
    const lastAttractionRows = routeIdsForHotspotLookup.length
      ? await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: { in: routeIdsForHotspotLookup },
            item_type: 4,
            deleted: 0,
            status: 1,
          },
          select: {
            itinerary_route_ID: true,
            hotspot_ID: true,
            hotspot_order: true,
          },
          orderBy: [
            { itinerary_route_ID: 'asc' },
            { hotspot_order: 'desc' },
          ],
        })
      : [];

    const lastHotspotIdByRouteId = new Map<number, number>();
    for (const row of lastAttractionRows as any[]) {
      const routeId = Number(row?.itinerary_route_ID || 0);
      const hotspotId = Number(row?.hotspot_ID || 0);
      if (routeId > 0 && hotspotId > 0 && !lastHotspotIdByRouteId.has(routeId)) {
        lastHotspotIdByRouteId.set(routeId, hotspotId);
      }
    }

    const hotspotIdsForLookup = Array.from(new Set(Array.from(lastHotspotIdByRouteId.values())));
    const hotspotMasters = hotspotIdsForLookup.length
      ? await this.prisma.dvi_hotspot_place.findMany({
          where: {
            hotspot_ID: { in: hotspotIdsForLookup },
            deleted: 0,
          },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_latitude: true,
            hotspot_longitude: true,
          },
        })
      : [];

    const hotspotMetaById = new Map<number, { name: string | null; lat: number; lon: number }>();
    for (const hotspot of hotspotMasters as any[]) {
      const lat = Number(hotspot?.hotspot_latitude ?? 0);
      const lon = Number(hotspot?.hotspot_longitude ?? 0);
      hotspotMetaById.set(Number(hotspot?.hotspot_ID || 0), {
        name: String(hotspot?.hotspot_name || '').trim() || null,
        lat,
        lon,
      });
    }

    const routeLastHotspotContext = new Map<number, { name: string | null; coords: { lat: number; lon: number } | null }>();
    for (const [routeId, hotspotId] of lastHotspotIdByRouteId.entries()) {
      const hotspotMeta = hotspotMetaById.get(hotspotId);
      if (!hotspotMeta) {
        routeLastHotspotContext.set(routeId, { name: null, coords: null });
        continue;
      }

      const hasCoords = Number.isFinite(hotspotMeta.lat) && Number.isFinite(hotspotMeta.lon) && hotspotMeta.lat !== 0 && hotspotMeta.lon !== 0;
      routeLastHotspotContext.set(routeId, {
        name: hotspotMeta.name,
        coords: hasCoords ? { lat: hotspotMeta.lat, lon: hotspotMeta.lon } : null,
      });
    }

    for (const pkg of packages) {
      for (const hotel of pkg.hotels) {
        // Find the route using the routeId attached to the hotel
        const route = routes.find((r: any) => r.itinerary_route_ID === hotel.routeId);
        if (!route) {
          this.logger.warn(`⚠️  Route ${hotel.routeId} not found for hotel ${hotel.hotelName}`);
          continue;
        }
        
        // Skip departure day (last route when routeIndex >= noOfNights)
        const routeIndex = routes.indexOf(route);
        const isLastRoute = routeIndex === routes.length - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
          this.logger.log(`   ⏭️  Skipping route ${hotel.routeId} from response (departure day)`);
          continue;
        }
        
        // Use next_visiting_location (where you're staying) for destination display
        const destination = (route as any).next_visiting_location || (route as any).location_name || '';
        
        // Use actual hotel name from TBO API response
        const displayHotelName = hotel.hotelName;
        
        // Handle both TBO (numeric) and HOBSE (UUID string) hotel codes
        const hotelId = isNaN(parseInt(hotel.hotelCode)) ? 0 : parseInt(hotel.hotelCode);
        const routeId = (route as any).itinerary_route_ID;
        const dateLabel = new Date((route as any).itinerary_route_date).toISOString().split('T')[0];
        
        // Lookup hotel details ID and voucher status (only for TBO numeric IDs)
        const lookupKey = hotelId > 0 ? `${routeId}-${hotelId}-${pkg.groupType}` : '';
        const hotelDetailsId = lookupKey ? detailsMap.get(lookupKey) : undefined;
        const voucherCancelled = hotelDetailsId ? (voucherStatusMap.get(hotelDetailsId) || false) : false;

        let hotelDistance: string | null = null;
        const routeLocationId = Number((route as any).location_id || 0);
        const routeCoords = routeDestinationCoordsByLocationId.get(routeLocationId);
        const segmentOriginContext = routeLastHotspotContext.get(routeId);
        const segmentOriginCoords = segmentOriginContext?.coords || routeCoords || null;
        const segmentOriginName =
          String(segmentOriginContext?.name || '').trim() ||
          String((route as any).next_visiting_location || (route as any).location_name || '').split('|')[0].trim();

        const providerLat = Number((hotel as any)?.latitude ?? 0);
        const providerLon = Number((hotel as any)?.longitude ?? 0);
        const providerCoords = Number.isFinite(providerLat) && Number.isFinite(providerLon) && providerLat !== 0 && providerLon !== 0
          ? { lat: providerLat, lon: providerLon }
          : null;

        const providerCodeKey = `${String(hotel.provider || 'tbo').trim().toLowerCase()}|${String(hotel.hotelCode || '').trim()}`;
        const masterCoords = hotelCoordsByProviderCode.get(providerCodeKey) || null;
        const hotelCoords = providerCoords || masterCoords;
        // When exact hotel coords unavailable, fall back to destination city coords as proxy
        const effectiveHotelCoords = hotelCoords || routeCoords || null;

        this.logger.log(`[HotelDistance] hotelCode=${String(hotel.hotelCode || '')} hotelName=${String(hotel.hotelName || '')} providerLat=${providerCoords?.lat ?? 'NA'} masterLat=${masterCoords?.lat ?? 'NA'} cityCoords=${routeCoords ? `${routeCoords.lat},${routeCoords.lon}` : 'NA'} segOrigin=${segmentOriginCoords ? `${segmentOriginCoords.lat},${segmentOriginCoords.lon}` : 'NA'}`);

        if (segmentOriginCoords && effectiveHotelCoords) {
          try {
            const result = this.calculateDistanceAndDuration(
              segmentOriginCoords.lat,
              segmentOriginCoords.lon,
              effectiveHotelCoords.lat,
              effectiveHotelCoords.lon,
              1,
              globalSettings,
            );
            if (Number.isFinite(result.distanceKm) && result.distanceKm > 0) {
              // Match PHP helper behavior: coordinate-based distance with correction factor.
              const distanceKm = result.distanceKm;
              hotelDistance = `${distanceKm.toFixed(2)} KM`;
            }
          } catch (e) {
            this.logger.warn(`[HotelDistance] coord calc error: ${String(e)}`);
            hotelDistance = null;
          }
        } else {
          // Fallback to Google road distance using textual origin/hotel name when coords are missing.
          const routeOriginName = segmentOriginName;
          const hotelDestinationName = [
            String(displayHotelName || '').trim(),
            String((hotel as any).address || '').trim(),
          ]
            .filter((v) => v.length > 0)
            .join(', ');

          this.logger.log(`[HotelDistance] Google fallback origin='${routeOriginName}' dest='${hotelDestinationName}'`);
          try {
            const matrix = await this.getDistanceAndDuration(routeOriginName, hotelDestinationName);
            this.logger.log(`[HotelDistance] Google result distanceText=${matrix?.distanceText ?? 'null'}`);
            if (matrix?.distanceText) {
              const parsedKm = this.parseDistanceKmText(matrix.distanceText);
              if (parsedKm != null && parsedKm > 0) {
                hotelDistance = `${parsedKm.toFixed(2)} KM`;
              }
            }
          } catch (e) {
            this.logger.warn(`[HotelDistance] Google API error: ${String(e)}`);
            hotelDistance = null;
          }
        }

        const baseHotelRow: ItineraryHotelRowDto = {
          groupType: pkg.groupType,
          itineraryRouteId: routeId,
          day: `Day ${routeIndex + 1} | ${dateLabel}`,
          destination: destination,
          hotelId: hotelId,
          hotelName: displayHotelName,
          category: this.normalizeStarCategoryValue((hotel as any).category ?? hotel.rating),
          roomType:
            Number((hotel as any).roomCountUsed || 1) > 1
              ? `${hotel.roomType || ''} (${Number((hotel as any).roomCountUsed)} Rooms)`
              : hotel.roomType || '',
          mealPlan: hotel.mealPlan || '-',
          totalHotelCost: Math.round(hotel.price),
          totalHotelTaxAmount: 0,
          noOfRooms: Math.max(Number((hotel as any).roomCountUsed || 1), 1),
          searchReference: hotel.searchReference,
          bookingCode:
            (hotel.provider || 'tbo').toLowerCase() === 'tbo'
              ? hotel.searchReference || hotel.roomTypes?.[0]?.roomCode || undefined
              : hotel.hotelCode,
          provider: hotel.provider || 'tbo',
          voucherCancelled: voucherCancelled,
          itineraryPlanHotelDetailsId: hotelDetailsId || 0,
          date: dateLabel,
          hotelDistance,
          facilities: this.normalizeSupplierStringList((hotel as any).facilities),
          amenities: this.normalizeSupplierStringList(
            (hotel as any).amenities ?? (hotel as any).Amenities,
          ),
          inclusions: this.normalizeSupplierStringList(
            (hotel as any).inclusions ??
            (hotel as any).Inclusions ??
            (hotel as any).inclusion ??
            (hotel as any).Inclusion ??
            (hotel as any)?.rooms?.[0]?.inclusion ??
            (hotel as any)?.rooms?.[0]?.Inclusion ??
            (hotel as any)?.Rooms?.[0]?.inclusion ??
            (hotel as any)?.Rooms?.[0]?.Inclusion,
          ),
          rateConditions: this.normalizeSupplierStringList(
            (hotel as any).rateConditions ??
            (hotel as any).RateConditions,
          ).map((item) => item.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean),
          mandatorySupplements: Array.isArray((hotel as any).mandatorySupplements)
            ? (hotel as any).mandatorySupplements
                .map((item: any) => String(item || '').trim())
                .filter(Boolean)
            : [],
          supplementSummary: (hotel as any).supplementSummary || undefined,
        };

        const previousDayBillingMarker = previousDayBillingMarkerMap.get(`${routeId}-${pkg.groupType}`);
        if (previousDayBillingMarker?.itineraryRouteDate) {
          const previousDayDate = new Date(previousDayBillingMarker.itineraryRouteDate as any)
            .toISOString()
            .split('T')[0];
          hotelRows.push({
            ...baseHotelRow,
            day: `Day ${routeIndex + 1} (Previous Day) | ${previousDayDate}`,
            destination: String(previousDayBillingMarker.itineraryRouteLocation || destination || '').trim(),
            date: previousDayDate,
          });
        }

        hotelRows.push(baseHotelRow);

        // Log HOBSE hotel codes for debugging
        if (hotel.provider === 'HOBSE') {
          this.logger.debug(`✅ HOBSE Hotel Response: hotelCode="${hotel.hotelCode}", provider="${hotel.provider}"`);
        }
      }
    }

    const supplierHotelRows = hotelRows.filter(
      (row) => row.hotelId > 0 && row.hotelName !== 'No Hotels Available',
    );
    const placeholderRows = hotelRows.filter(
      (row) => row.hotelName === 'No Hotels Available',
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
      hotelRatesVisible,
      hotelTabs,
      hotels: hotelRows,
      totalRoomCount: hotelRows.length,
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
   * PHP-equivalent coordinate distance helper.
   * Uses Haversine + correction factor and derives duration from speed settings.
   */
  private calculateDistanceAndDuration(
    startLatitude: number,
    startLongitude: number,
    endLatitude: number,
    endLongitude: number,
    travelLocationType: 1 | 2,
    globalSettings?: {
      itinerary_local_speed_limit?: number | null;
      itinerary_outstation_speed_limit?: number | null;
    } | null,
  ): { distanceKm: number; durationText: string } {
    const earthRadiusKm = 6371;

    const startLatRad = (startLatitude * Math.PI) / 180;
    const startLonRad = (startLongitude * Math.PI) / 180;
    const endLatRad = (endLatitude * Math.PI) / 180;
    const endLonRad = (endLongitude * Math.PI) / 180;

    const latDiff = endLatRad - startLatRad;
    const lonDiff = endLonRad - startLonRad;

    const a =
      Math.sin(latDiff / 2) * Math.sin(latDiff / 2) +
      Math.cos(startLatRad) * Math.cos(endLatRad) *
      Math.sin(lonDiff / 2) * Math.sin(lonDiff / 2);
    const baseDistance = 2 * earthRadiusKm * Math.asin(Math.sqrt(a));

    const correctionFactor = 1.5;
    const correctedDistance = baseDistance * correctionFactor;

    const localSpeed = Number(globalSettings?.itinerary_local_speed_limit || 40);
    const outstationSpeed = Number(globalSettings?.itinerary_outstation_speed_limit || 60);
    const avgSpeed = travelLocationType === 1 ? localSpeed : outstationSpeed;
    const durationHours = correctedDistance / Math.max(1, avgSpeed);
    const hourPart = Math.floor(durationHours);
    const minutePart = Math.round((durationHours - hourPart) * 60);

    const durationText = [
      hourPart > 0 ? `${hourPart} hour` : '',
      minutePart > 0 ? `${minutePart} mins` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim() || '0 mins';

    return {
      distanceKm: correctedDistance,
      durationText,
    };
  }

  /**
   * PHP-equivalent name-based Google Distance Matrix helper.
   */
  private async getDistanceAndDuration(
    origin: string,
    destination: string,
    travelMode: 'driving' | 'walking' | 'bicycling' | 'transit' = 'driving',
  ): Promise<{ distanceText: string; durationText: string } | null> {
    const apiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
    if (!apiKey || !origin || !destination) {
      return null;
    }

    const params = new URLSearchParams({
      origins: origin,
      destinations: destination,
      mode: travelMode,
      key: apiKey,
    });

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    let response: any = null;
    try {
      response = await axios.get(url, { timeout: 10000 });
    } catch (err) {
      this.logger.warn(`[HotelDistance] Google HTTP error: ${String(err)}`);
      return null;
    }
    const data = response?.data;

    if (String(data?.status || '') !== 'OK') {
      return null;
    }

    const element = data?.rows?.[0]?.elements?.[0];
    if (!element || String(element.status || '') !== 'OK') {
      return null;
    }

    const distanceText = String(element?.distance?.text || '').trim();
    const durationText = String(element?.duration?.text || '').trim();
    if (!distanceText) {
      return null;
    }

    return { distanceText, durationText };
  }

  private parseDistanceKmText(distanceText: string): number | null {
    const normalized = String(distanceText || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    if (normalized.endsWith('km')) {
      const value = parseFloat(normalized.replace(/[^0-9.]/g, ''));
      return Number.isFinite(value) ? value : null;
    }

    if (normalized.endsWith('m')) {
      const value = parseFloat(normalized.replace(/[^0-9.]/g, ''));
      return Number.isFinite(value) ? value / 1000 : null;
    }

    const value = parseFloat(normalized.replace(/[^0-9.]/g, ''));
    return Number.isFinite(value) ? value : null;
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
    this.logger.log(`\n📡 FRESH ROOM DETAILS FROM TBO: Fetching live data for quote: ${quoteId}`);
    if (filterRouteId) {
      this.logger.log(`🔍 Filtering to route ID: ${filterRouteId}`);
    }

    // ✅ CHECK CACHE FIRST (per-route caching)
    const cachedResult = this.getCachedRoomDetails(quoteId, filterRouteId);
    if (cachedResult) {
      return cachedResult;
    }

    // Step 1: Get itinerary plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`⚠️  Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    const planId = plan.itinerary_plan_ID;
    this.logger.log(`✅ Found plan ID: ${planId}`);

    // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    if (routes.length === 0) {
      this.logger.warn(`⚠️  No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

    const noOfNights = Number((plan as any).no_of_nights || 0);
    this.logger.log(`🌙 Plan has ${noOfNights} nights`);

    // Step 3: Fetch FRESH hotels from TBO
    // OPTIMIZATION: If filterRouteId provided, only fetch hotels for that specific route
    let routesToProcess = routes;
    if (filterRouteId) {
      routesToProcess = routes.filter(r => (r as any).itinerary_route_ID === filterRouteId);
      if (routesToProcess.length === 0) {
        this.logger.warn(`⚠️  Route ID ${filterRouteId} not found`);
        throw new BadRequestException(`Route ID ${filterRouteId} not found in this itinerary`);
      }
      this.logger.log(`✅ Optimized: Fetching hotels for 1 route only (filtered)`);
    }

    const guestNationality = await this.resolveGuestNationality(plan);
    const planAdultCount = Number((plan as any).total_adult || 0);
    const planChildCount = Number((plan as any).total_children || 0);
    const planChildAges = await this.resolvePlanChildAges(planId, planChildCount);
    const planRoomCount = Math.max(Number((plan as any).preferred_room_count || 1), 1);
    const hotelsByRoute = await this.fetchHotelsForRoutes(
      routesToProcess,
      noOfNights,
      guestNationality,
      planAdultCount,
      planChildCount,
      planChildAges,
      planRoomCount,
    );

    // Step 4: Transform fresh TBO data into room details format
    const roomDetailsList: ItineraryHotelRoomDto[] = [];
    let roomDetailsId = 1;

    // Build route-scoped room candidates with group coverage fallback.
    // PHP behavior allows overlap fallback when a recommendation bucket would be empty.
    const routeHotelRows: Array<{ routeId: number; hotel: any }> = [];

    hotelsByRoute.forEach((hotelsForRoute, routeId) => {
      // FILTER: Only process this route if filterRouteId is not provided OR if it matches
      if (filterRouteId && routeId !== filterRouteId) {
        this.logger.debug(`🔍 Skipping route ${routeId} (filter: ${filterRouteId})`);
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

        // ✅ FIXED: Use actual room type from TBO, not groupType
        const firstRoomType = hotel.roomTypes?.[0];
        const actualRoomTypeId = firstRoomType?.roomTypeId || 1;
        const actualRoomTypeName = firstRoomType?.roomName || 'Standard Room';
        const amenities = Array.isArray(hotel.amenities)
          ? hotel.amenities.map((item: any) => String(item || '').trim()).filter(Boolean)
          : [];
        const inclusions = Array.isArray(hotel.inclusions)
          ? hotel.inclusions.map((item: any) => String(item || '').trim()).filter(Boolean)
          : [];
        const rateConditions = (Array.isArray(hotel.rateConditions) ? hotel.rateConditions : [])
          .map((item: any) => String(item || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const facilities = Array.isArray(hotel.facilities)
          ? hotel.facilities.map((item: any) => String(item || '').trim()).filter(Boolean)
          : [];
        const mandatorySupplements = (Array.isArray(firstRoomType?.supplements) ? firstRoomType.supplements : [])
          .map((supplement: any) => String(supplement?.description || supplement?.type || '').trim())
          .filter(Boolean);

        roomDetailsList.push({
          itineraryPlanId: planId,
          itineraryRouteId: routeId,
          itineraryPlanHotelRoomDetailsId: roomDetailsId++,
          hotelId: parseInt(hotel.hotelCode) || 0,
          hotelName: hotel.hotelName || 'Hotel',
          hotelCategory: this.normalizeStarCategoryValue(hotel.category || hotel.rating),
          groupType: hotel.groupType || 1, // ✅ ADD: Include groupType (tier: 1-4)
          roomTypeId: actualRoomTypeId, // ✅ FIXED: Use actual TBO room type ID
          roomTypeName: actualRoomTypeName, // ✅ FIXED: Use actual TBO room type name
          roomId: parseInt(hotel.hotelCode) || 0,
          availableRoomTypes: (hotel.roomTypes || []).map((rt, idx) => ({
            roomTypeId: rt.roomTypeId || idx + 1,
            roomTypeTitle: rt.roomName,
            bookingCode: rt.roomCode,
          })),
          bookingCode: firstRoomType?.roomCode || hotel.searchReference || undefined,
          pricePerNight: Number(hotel.price || 0),
          numberOfNights: noOfNights,
          totalPrice: Number(hotel.price || 0) * noOfNights,
          currency: hotel.currency || 'INR',
          mealPlan: hotel.mealPlan || 'Not Specified',
          facilities,
          amenities,
          inclusions,
          rateConditions,
          supplementSummary: hotel.supplementSummary || undefined,
          mandatorySupplements,
        } as any);
    });

    const duration = Date.now() - startTime;
    this.logger.log(`✅ FRESH ROOM DETAILS GENERATED`);
    this.logger.log(`📊 Room Entries: ${roomDetailsList.length}`);
    if (filterRouteId) {
      this.logger.log(`🔍 Filter Applied: Route ID ${filterRouteId}`);
    } else {
      this.logger.log(`📅 All Routes Included`);
    }
    this.logger.log(`⏱️  Duration: ${duration}ms\n`);

    const result = {
      quoteId: (plan as any).itinerary_quote_ID ?? '',
      planId,
      rooms: roomDetailsList,
    };

    // ✅ CACHE THE RESULT for future requests
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

  private normalizeSupplierStringList(value: any): string[] {
    if (value == null) return [];

    const normalizeOne = (input: any): string[] => {
      if (input == null) return [];
      if (Array.isArray(input)) {
        return input.flatMap((item) => normalizeOne(item));
      }
      if (typeof input === 'string') {
        const text = input.trim();
        if (!text) return [];

        return text
          .split(/\r?\n|\||,|;/)
          .map((part) => String(part || '').trim())
          .filter(Boolean);
      }
      return [String(input).trim()].filter(Boolean);
    };

    return Array.from(new Set(normalizeOne(value)));
  }

  /**
   * Convert rating/category string to numeric category (1-4)
   */
  private normalizeStarCategoryValue(ratingOrCategory: string | number | undefined | null): number {
    const raw = String(ratingOrCategory ?? '').trim();
    if (!raw) return 0;

    // Supports "3*", "4-Star", "5 star" style labels.
    const labelMatch = raw.match(/([1-5])\s*(?:\*|STAR)?/i);
    if (labelMatch) {
      const parsed = Number(labelMatch[1]);
      if (parsed >= 1 && parsed <= 5) return parsed;
    }

    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return 0;

    if (numeric >= 1 && numeric <= 5) {
      return Math.trunc(numeric);
    }

    // Legacy category IDs can appear as 13/14/15 where last digit encodes stars.
    const lastDigit = Math.trunc(numeric) % 10;
    if (numeric >= 10 && numeric < 100 && lastDigit >= 1 && lastDigit <= 5) {
      return lastDigit;
    }

    return 0;
  }

  /**
   * Generate cache key for hotel room details
   * Format: "quoteId" or "quoteId:routeId" if filtered
   */
  private getCacheKey(quoteId: string, routeId?: number): string {
    if (routeId) {
      return `${quoteId}:${routeId}`;
    }
    return quoteId;
  }

  /**
   * Get cached hotel room details if available
   */
  private getCachedRoomDetails(quoteId: string, routeId?: number): ItineraryHotelRoomDetailsResponseDto | null {
    const cacheKey = this.getCacheKey(quoteId, routeId);
    const cached = this.hotelRoomDetailsCache.get(cacheKey);
    
    if (cached) {
      if (this.isCacheExpired(cached.timestamp, ItineraryHotelDetailsTboService.HOTEL_ROOM_DETAILS_CACHE_TTL_MS)) {
        this.hotelRoomDetailsCache.delete(cacheKey);
        this.logger.debug(`💾 [CACHE EXPIRED] Removed stale room cache for ${cacheKey}`);
        return null;
      }
      this.logger.log(`💾 [CACHE HIT] Using cached data for ${cacheKey}`);
      return cached.data;
    }
    
    return null;
  }

  /**
   * Store hotel room details in cache
   */
  private setCachedRoomDetails(
    quoteId: string,
    data: ItineraryHotelRoomDetailsResponseDto,
    routeId?: number,
  ): void {
    const cacheKey = this.getCacheKey(quoteId, routeId);
    this.evictOldestIfNeeded(this.hotelRoomDetailsCache);
    this.hotelRoomDetailsCache.set(cacheKey, {
      data,
      timestamp: Date.now(),
    });
    this.logger.log(`💾 [CACHE SET] Cached data for ${cacheKey}`);
  }

  private getCachedHotelDetails(quoteId: string): ItineraryHotelDetailsResponseDto | null {
    const cached = this.hotelDetailsCache.get(quoteId);
    if (!cached) {
      return null;
    }

    if (this.isCacheExpired(cached.timestamp, ItineraryHotelDetailsTboService.HOTEL_DETAILS_CACHE_TTL_MS)) {
      this.hotelDetailsCache.delete(quoteId);
      this.logger.debug(`💾 [CACHE EXPIRED] Removed stale hotel details cache for ${quoteId}`);
      return null;
    }

    this.logger.log(`💾 [CACHE HIT] Hotel details from cache for ${quoteId}`);
    return cached.data;
  }

  private setCachedHotelDetails(
    quoteId: string,
    data: ItineraryHotelDetailsResponseDto,
  ): void {
    this.evictOldestIfNeeded(this.hotelDetailsCache);
    this.hotelDetailsCache.set(quoteId, {
      data,
      timestamp: Date.now(),
    });
    this.logger.log(`💾 [CACHE SET] Hotel details cached for ${quoteId}`);
  }

  private isCacheExpired(timestamp: number, ttlMs: number): boolean {
    return Date.now() - timestamp > ttlMs;
  }

  private evictOldestIfNeeded<T extends { timestamp: number }>(cache: Map<string, T>): void {
    if (cache.size < ItineraryHotelDetailsTboService.MAX_CACHE_ENTRIES) {
      return;
    }

    let oldestKey: string | null = null;
    let oldestTs = Number.MAX_SAFE_INTEGER;

    cache.forEach((value, key) => {
      if (value.timestamp < oldestTs) {
        oldestTs = value.timestamp;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  /**
   * Clear cache for a specific quote (called on refresh/update)
   * Clears both general cache (quoteId) and route-specific caches (quoteId:routeId)
   */
  clearCacheForQuote(quoteId: string): void {
    const keysToDelete: string[] = [];

    this.hotelDetailsCache.delete(quoteId);
    
    for (const key of this.hotelRoomDetailsCache.keys()) {
      if (key.startsWith(`${quoteId}:`)) { // Matches "quoteId:routeId"
        keysToDelete.push(key);
      }
    }
    
    // Also delete the base key
    keysToDelete.push(quoteId);
    
    for (const key of keysToDelete) {
      this.hotelRoomDetailsCache.delete(key);
      this.logger.log(`🗑️  [CACHE CLEARED] Removed cache for ${key}`);
    }
  }

  /**
   * Get current cache size and stats (for debugging)
   */
  getCacheStats(): { size: number; entries: string[] } {
    const detailEntries = Array.from(this.hotelDetailsCache.keys()).map((k) => `details:${k}`);
    const roomEntries = Array.from(this.hotelRoomDetailsCache.keys()).map((k) => `rooms:${k}`);

    return {
      size: this.hotelDetailsCache.size + this.hotelRoomDetailsCache.size,
      entries: [...detailEntries, ...roomEntries],
    };
  }
}

