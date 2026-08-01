// FILE: src/modules/itineraries/itinerary-hotel-details-tbo.service.ts

import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { HotelSearchService } from '../hotels/services/hotel-search.service';
import { HobseHotelProvider } from '../hotels/providers/hobse-hotel.provider';
import { HotelSearchResult } from '../hotels/interfaces/hotel-provider.interface';
import { OfflineHotelCatalogService } from './services/offline-hotel-catalog.service';
import {
  HotelRecommendationPackageService,
  resolveHotelRecommendationAlgorithm,
  type RecommendationPackage,
  type RecommendationHotel,
} from './services/hotel-recommendation-package.service';
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
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../hotels/hotel-rate-plans';
import {
  calculateStaahOccupancyAmount,
  type StaahPricingPaxInput,
} from './helpers/staah-occupancy-pricing';
import {
  hotelDisplaySnapshot,
  optionMatchesSelection,
  parseHotelSelectionSnapshot,
  selectionOriginFromRow,
} from './utils/hotel-selection-identity.util';

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

  private static readonly HOTEL_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly HOTEL_ROOM_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_CACHE_ENTRIES = 200;

  private parseBooleanEnv(name: string): boolean {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private isAxisOnlyFetchEnabled(): boolean {
    return this.parseBooleanEnv('HOTEL_FETCH_AXIS_ONLY');
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
          `[INFO] Comparing results -> First: ${firstSuccessCount}, Retry: ${retrySuccessCount}`,
        );

 // return whichever has more valid hotel data
        if (retrySuccessCount >= firstSuccessCount) {
 this.logger.log(' Using retry result (better or equal)');
          return retryResult;
        } else {
 this.logger.log(' Using first attempt result (better)');
          return hotelsByRoute;
        }
      }

      return hotelsByRoute;
    }
  private readonly logger = new Logger(ItineraryHotelDetailsTboService.name);

  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

  private isTboOnlyFetchEnabled(): boolean {
    return this.parseBooleanEnv('HOTEL_FETCH_TBO_ONLY');
  }

  private resolveHotelFetchMode(): {
    axisOnly: boolean;
    tboOnly: boolean;
  } {
    const axisOnly = this.isAxisOnlyFetchEnabled();
    const tboOnly = this.isTboOnlyFetchEnabled();

    if (axisOnly && tboOnly) {
      throw new BadRequestException(
        'HOTEL_FETCH_AXIS_ONLY and HOTEL_FETCH_TBO_ONLY cannot both be enabled.',
      );
    }

    return { axisOnly, tboOnly };
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

  private getHotelCategoryCandidates(hotel: HotelSearchResult): number[] {
    const candidates = new Set<number>();

    const ratingNum = Number((hotel as any).rating);
    if (Number.isFinite(ratingNum) && ratingNum > 0) {
      candidates.add(Math.trunc(ratingNum));
    }

    const categoryRaw = String((hotel as any).category ?? '').trim();
    if (categoryRaw) {
      const match = categoryRaw.match(/\d+/);
      if (match) {
        const categoryNum = Number(match[0]);
        if (Number.isFinite(categoryNum) && categoryNum > 0) {
          candidates.add(Math.trunc(categoryNum));
        }
      }
    }

    return Array.from(candidates);
  }

  private inferMealPlanCodeFromHotel(hotel: HotelSearchResult): string | null {
    const direct = inferCanonicalHotelRatePlanCode(String((hotel as any).mealPlan ?? ''));
    if (direct) return direct;
    return inferCanonicalHotelRatePlanCodeFromMealText(String((hotel as any).mealPlan ?? ''));
  }

  private collectMealPlanCodesFromText(
    rawValue: unknown,
    collector: Set<string>,
  ): void {
    const raw = String(rawValue ?? '').trim();
    if (!raw) return;

    const direct = inferCanonicalHotelRatePlanCode(raw);
    if (direct) collector.add(direct);

    const inferred = inferCanonicalHotelRatePlanCodeFromMealText(raw);
    if (inferred) collector.add(inferred);
  }

  private getMealPlanCandidatesFromHotel(hotel: HotelSearchResult): string[] {
    const candidates = new Set<string>();

    const rateOptions = Array.isArray((hotel as any).rateOptions)
      ? (hotel as any).rateOptions
      : [];
    if (rateOptions.length > 0) {
      rateOptions.forEach((option: any) => this.collectMealPlanValue(option?.mealPlan, candidates));
      return Array.from(candidates);
    }

    this.collectMealPlanValue((hotel as any).mealPlan, candidates);
    if (candidates.size > 0) return Array.from(candidates);

    // Legacy providers sometimes only expose a structured room label. Use it
    // only when no structured meal-plan value exists anywhere on the option.
    this.collectMealPlanValue((hotel as any).roomType, candidates);

    for (const roomType of hotel.roomTypes || []) {
      this.collectMealPlanValue((roomType as any).roomName, candidates);
    }

    return Array.from(candidates);
  }

  private collectMealPlanValue(rawValue: unknown, collector: Set<string>): void {
    const value = String(rawValue ?? '').trim();
    if (!value || value === '-' || value.toUpperCase() === 'UNKNOWN') return;
    this.collectMealPlanCodesFromText(value, collector);
  }

  private alignHotelToPreferredMealPlan(
    hotel: HotelSearchResult,
    preferredMealPlanCode: string,
  ): HotelSearchResult {
    const roomTypes = Array.isArray(hotel.roomTypes) ? hotel.roomTypes : [];
    const matchedRoomType = roomTypes.find((roomType) => {
      const roomCandidates = new Set<string>();
      this.collectMealPlanCodesFromText((roomType as any).roomName, roomCandidates);
      return roomCandidates.has(preferredMealPlanCode);
    });

    if (!matchedRoomType) {
      return hotel;
    }

    const normalizedRoomTypeName = String((matchedRoomType as any).roomName || '')
      .replace(/\s*-\s*(EP|CP|MAP|AP)\b.*$/i, '')
      .trim();

    return {
      ...hotel,
      price: Number((matchedRoomType as any).price || hotel.price || 0),
      roomType: normalizedRoomTypeName || hotel.roomType || String((matchedRoomType as any).roomName || ''),
      mealPlan: preferredMealPlanCode,
      roomTypes: [
        matchedRoomType,
        ...roomTypes.filter((roomType) => roomType !== matchedRoomType),
      ],
    };
  }

 private async applyPlanPreferenceFilters(
  hotelsByRoute: Map<number, HotelSearchResult[] | null>,
  preferredCategories: number[],
  preferredMealPlanCode: string | null,
  preferredFacilities: string[],
): Promise<Map<number, HotelSearchResult[] | null>> {
  const normalizeFacility = (value: unknown): string => {
    const rawValue = String(value ?? '').trim().toLowerCase();

    if (!rawValue) {
      return '';
    }

    const normalizedValue = rawValue
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (
      normalizedValue.includes('wifi') ||
      normalizedValue.includes('wi fi')
    ) {
      return 'wifi';
    }

    if (normalizedValue.includes('parking')) {
      return 'parking';
    }

    if (
      normalizedValue.includes('swimming pool') ||
      /\bpool\b/.test(normalizedValue)
    ) {
      return 'pool';
    }

    if (/\bspa\b/.test(normalizedValue)) {
      return 'spa';
    }

    if (normalizedValue.includes('restaurant')) {
      return 'restaurant';
    }

    if (
      normalizedValue.includes('business center') ||
      normalizedValue.includes('business centre')
    ) {
      return '24hr-business-center';
    }

    if (
      normalizedValue.includes('check in') ||
      normalizedValue.includes('checkin')
    ) {
      return '24hr-checkin';
    }

    if (
      normalizedValue.includes('front desk') ||
      normalizedValue.includes('frontdesk')
    ) {
      return '24hr-frontdesk';
    }

    if (normalizedValue.includes('room service')) {
      return '24hr-room-service';
    }

    if (
      normalizedValue.includes('fitness') ||
      normalizedValue.includes('gym')
    ) {
      return 'fitness-centre';
    }

    return normalizedValue;
  };

  const addFacilityValue = (
    collector: Set<string>,
    value: unknown,
  ): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        addFacilityValue(collector, item);
      }
      return;
    }

    if (value && typeof value === 'object') {
      const objectValue = value as any;

      addFacilityValue(
        collector,
        objectValue.name ??
          objectValue.title ??
          objectValue.description ??
          objectValue.code,
      );

      return;
    }

    const normalizedFacility = normalizeFacility(value);

    if (normalizedFacility) {
      collector.add(normalizedFacility);
    }
  };

  const getProviderKey = (
    hotel: HotelSearchResult,
  ): string => {
    const provider = String(
      (hotel as any).provider || '',
    )
      .trim()
      .toLowerCase();

    const hotelCode = String(
      (hotel as any).hotelCode || '',
    ).trim();

    return `${provider}|${hotelCode}`;
  };

  const normalizedPreferredFacilities = Array.from(
    new Set(
      (preferredFacilities || [])
        .map((facility) => normalizeFacility(facility))
        .filter(Boolean),
    ),
  );

  const shouldFilterByCategory =
    preferredCategories.length > 0;

   const shouldFilterByMeal =
    !!preferredMealPlanCode;

  const normalizedPreferredMealPlanCode =
    String(preferredMealPlanCode || '')
      .trim()
      .toUpperCase();

  const shouldFilterByFacilities =
    normalizedPreferredFacilities.length > 0;

  if (
    !shouldFilterByCategory &&
    !shouldFilterByMeal &&
    !shouldFilterByFacilities
  ) {
    return hotelsByRoute;
  }

  const preferredCategorySet =
    new Set(preferredCategories);

 /*
   * Collect the provider hotel codes so that live TBO/other-provider
   * results can be matched with dvi_hotel and dvi_hotel_amenities.
 */
  const allHotels = Array.from(
    hotelsByRoute.values(),
  ).flatMap((hotels) =>
    Array.isArray(hotels) ? hotels : [],
  );

  const tboCodes = Array.from(
    new Set(
      allHotels
        .filter(
          (hotel) =>
            String(hotel.provider || '')
              .trim()
              .toLowerCase() === 'tbo',
        )
        .map((hotel) =>
          String(hotel.hotelCode || '').trim(),
        )
        .filter(Boolean),
    ),
  );

  const resavenueCodes = Array.from(
    new Set(
      allHotels
        .filter(
          (hotel) =>
            String(hotel.provider || '')
              .trim()
              .toLowerCase() === 'resavenue',
        )
        .map((hotel) =>
          String(hotel.hotelCode || '').trim(),
        )
        .filter(Boolean),
    ),
  );

  const hobseCodes = Array.from(
    new Set(
      allHotels
        .filter(
          (hotel) =>
            String(hotel.provider || '')
              .trim()
              .toLowerCase() === 'hobse',
        )
        .map((hotel) =>
          String(hotel.hotelCode || '').trim(),
        )
        .filter(Boolean),
    ),
  );

  const axisroomsHotelIds = Array.from(
    new Set(
      allHotels
        .filter(
          (hotel) =>
            String(hotel.provider || '')
              .trim()
              .toLowerCase() === 'axisrooms',
        )
        .map((hotel) => Number(hotel.hotelCode))
        .filter(
          (hotelId) =>
            Number.isFinite(hotelId) && hotelId > 0,
        ),
    ),
  );

  const staahHotelIds = Array.from(
    new Set(
      allHotels
        .filter(
          (hotel) =>
            String(hotel.provider || '')
              .trim()
              .toLowerCase() === 'staah',
        )
        .map((hotel) => Number(hotel.hotelCode))
        .filter(
          (hotelId) =>
            Number.isFinite(hotelId) && hotelId > 0,
        ),
    ),
  );

  const hotelLookupConditions: any[] = [];

  if (tboCodes.length > 0) {
    hotelLookupConditions.push({
      tbo_hotel_code: {
        in: tboCodes,
      },
    });
  }

  if (resavenueCodes.length > 0) {
    hotelLookupConditions.push({
      resavenue_hotel_code: {
        in: resavenueCodes,
      },
    });
  }

  if (hobseCodes.length > 0) {
    hotelLookupConditions.push({
      hotel_code: {
        in: hobseCodes,
      },
    });
  }

  if (axisroomsHotelIds.length > 0) {
    hotelLookupConditions.push({
      hotel_id: {
        in: axisroomsHotelIds,
      },
    });
  }

  if (staahHotelIds.length > 0) {
    hotelLookupConditions.push({
      hotel_id: {
        in: staahHotelIds,
      },
    });
  }

  const hotelMasters =
    shouldFilterByFacilities &&
    hotelLookupConditions.length > 0
      ? await this.prisma.dvi_hotel.findMany({
          where: {
            status: 1,
            deleted: false,
            OR: hotelLookupConditions,
          },
          select: {
            hotel_id: true,
            tbo_hotel_code: true,
            resavenue_hotel_code: true,
            hotel_code: true,
          },
        })
      : [];

  const hotelIdByProviderKey =
    new Map<string, number>();

  for (const hotelMaster of hotelMasters as any[]) {
    const hotelId = Number(
      hotelMaster.hotel_id || 0,
    );

    if (hotelId <= 0) {
      continue;
    }

    const tboCode = String(
      hotelMaster.tbo_hotel_code || '',
    ).trim();

    const resavenueCode = String(
      hotelMaster.resavenue_hotel_code || '',
    ).trim();

    const hobseCode = String(
      hotelMaster.hotel_code || '',
    ).trim();

    if (tboCode) {
      hotelIdByProviderKey.set(
        `tbo|${tboCode}`,
        hotelId,
      );
    }

    if (resavenueCode) {
      hotelIdByProviderKey.set(
        `resavenue|${resavenueCode}`,
        hotelId,
      );
    }

    if (hobseCode) {
      hotelIdByProviderKey.set(
        `hobse|${hobseCode}`,
        hotelId,
      );
    }

    hotelIdByProviderKey.set(
      `axisrooms|${hotelId}`,
      hotelId,
    );

    hotelIdByProviderKey.set(
      `staah|${hotelId}`,
      hotelId,
    );
  }

  const hotelMasterIds = Array.from(
    new Set(hotelIdByProviderKey.values()),
  );

  const amenityRows =
    shouldFilterByFacilities &&
    hotelMasterIds.length > 0
      ? await this.prisma.dvi_hotel_amenities.findMany({
          where: {
            hotel_id: {
              in: hotelMasterIds,
            },
            status: 1,
            OR: [
              { deleted: 0 },
              { deleted: null },
            ],
          },
          select: {
            hotel_id: true,
            amenities_title: true,
            amenities_code: true,
          },
        })
      : [];

  const facilitiesByHotelId =
    new Map<number, Set<string>>();

  for (const amenityRow of amenityRows as any[]) {
    const hotelId = Number(
      amenityRow.hotel_id || 0,
    );

    if (hotelId <= 0) {
      continue;
    }

    const facilitySet =
      facilitiesByHotelId.get(hotelId) ||
      new Set<string>();

    addFacilityValue(
      facilitySet,
      amenityRow.amenities_title,
    );

    addFacilityValue(
      facilitySet,
      amenityRow.amenities_code,
    );

    facilitiesByHotelId.set(
      hotelId,
      facilitySet,
    );
  }

  const filteredMap =
    new Map<number, HotelSearchResult[] | null>();

  hotelsByRoute.forEach((hotels, routeId) => {
    if (!Array.isArray(hotels)) {
      filteredMap.set(routeId, hotels);
      return;
    }

    const filteredHotels: HotelSearchResult[] = [];

    for (const hotel of hotels) {
      let included = true;
      let filterReason = '';
      let nextHotel = hotel;

 // Keep priced offline options visible for manual approval even when
 // the itinerary's preferred category is narrower than the catalog.
      if (
        shouldFilterByCategory &&
        hotel.provider !== 'offline'
      ) {
        const categoryCandidates =
          this.getHotelCategoryCandidates(hotel);

        const categoryMatch =
          categoryCandidates.some((category) =>
            preferredCategorySet.has(category),
          );

        const isResavenueUnknownCategory =
          String(
            (hotel as any).provider || '',
          ).toLowerCase() === 'resavenue' &&
          categoryCandidates.length === 0;

        if (
          !categoryMatch &&
          !isResavenueUnknownCategory
        ) {
          included = false;
          filterReason =
            `Category mismatch: ` +
            `${categoryCandidates.join(',') || 'UNKNOWN'} ` +
            `not in ${preferredCategories.join(',')}`;
        } else if (isResavenueUnknownCategory) {
 this.logger.debug(
            `   ℹ️ Keeping ResAvenue hotel with unknown category: ${hotel.hotelName}`,
          );
        }
      }

           if (included && shouldFilterByMeal) {
        const mealPlanCandidates =
          this.getMealPlanCandidatesFromHotel(hotel);

        const hasMatchingMeal =
          mealPlanCandidates.includes(
            preferredMealPlanCode!,
          );

        if (!hasMatchingMeal) {
          included = false;
          filterReason =
            `Meal plan mismatch: ` +
            `${mealPlanCandidates.join(',')} != ` +
            `${preferredMealPlanCode}`;
        } else if (hasMatchingMeal) {
          nextHotel =
            this.alignHotelToPreferredMealPlan(
              hotel,
              preferredMealPlanCode!,
            );
        }
      }

 // Offline options are manual-approval candidates. Their catalog rows
 // may not carry the supplier amenity payload needed for this filter.
      if (
        included &&
        shouldFilterByFacilities &&
        hotel.provider !== 'offline'
      ) {
        const providerKey =
          getProviderKey(hotel);

        const hotelMasterId =
          hotelIdByProviderKey.get(providerKey);

      const availableFacilities =
  new Set<string>();

/*
 * Always include facilities returned by the live provider.
 * TBO results already contain facilities, amenities and
 * inclusions when that information is available.
 */
addFacilityValue(
  availableFacilities,
  (hotel as any).facilities,
);

addFacilityValue(
  availableFacilities,
  (hotel as any).amenities,
);

addFacilityValue(
  availableFacilities,
  (hotel as any).inclusions,
);

/*
 * When the provider hotel is mapped to dvi_hotel,
 * merge the locally saved amenities as well.
 */
if (hotelMasterId) {
  const databaseFacilities =
    facilitiesByHotelId.get(
      hotelMasterId,
    );

  for (
    const facility of
    databaseFacilities || []
  ) {
    availableFacilities.add(facility);
  }
}

        const missingFacilities =
          normalizedPreferredFacilities.filter(
            (requiredFacility) =>
              !availableFacilities.has(
                requiredFacility,
              ),
          );

        if (missingFacilities.length > 0) {
          included = false;
          filterReason =
            `Facility mismatch: missing ` +
            `${missingFacilities.join(',')}`;
        }
      }

      if (
        !included &&
        hotel.provider === 'resavenue'
      ) {
 this.logger.warn(
          `   ⚠️ Filtering out ResAvenue: ` +
            `${hotel.hotelName} - Reason: ` +
            `${filterReason}`,
        );
      }

      if (
        !included &&
        hotel.provider === 'staah'
      ) {
 this.logger.warn(
          `[STAAH FILTERED] ` +
            `${hotel.hotelName} ` +
            `(${hotel.hotelCode}) - ` +
            `${filterReason}`,
        );
      }

      if (
        !included &&
        shouldFilterByFacilities
      ) {
 this.logger.debug(
          `[HOTEL-FACILITY-FILTER] ` +
            `${hotel.hotelName} ` +
            `(${hotel.hotelCode}) rejected: ` +
            `${filterReason}`,
        );
      }

           if (included) {
        filteredHotels.push(nextHotel);
      }
    }

    const finalHotels = filteredHotels;

 this.logger.log(
      `   Preference filter route ${routeId}: ` +
        `before=${hotels.length}, ` +
        `after=${finalHotels.length}, ` +
        `category=${
          shouldFilterByCategory
            ? preferredCategories.join(',')
            : 'ANY'
        }, ` +
        `meal=${
          preferredMealPlanCode || 'ANY'
        }, ` +
        `facilities=${
          shouldFilterByFacilities
            ? normalizedPreferredFacilities.join(',')
            : 'ANY'
        }`,
    );

    filteredMap.set(routeId, finalHotels);
  });

  return filteredMap;
}

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelSearchService: HotelSearchService,
    private readonly hobseProvider: HobseHotelProvider,
    private readonly offlineHotelCatalogService: OfflineHotelCatalogService,
    private readonly hotelRecommendationPackageService: HotelRecommendationPackageService,
  ) {}

  private recommendationAlgorithm(): 'v1' | 'v2' {
    return resolveHotelRecommendationAlgorithm();
  }

  private recommendationGeneration(searchRunId?: string, generatedAt = new Date().toISOString()) {
    const version = this.recommendationAlgorithm();
    return {
      version,
      algorithm: version === 'v2' ? 'TARGET_PRICE_DIVERSITY_BEAM_SEARCH' as const : 'LEGACY_PRICE_PACKAGE' as const,
      ...(searchRunId ? { searchRunId } : {}),
      generatedAt,
      warnings: [],
    };
  }

  private getHotelMarginPercentage(hotel: any, globalMargin = 0): number {
    const hotelMargin = Number(
      hotel?._resolvedHotelMargin ??
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

    const configuredGlobalMargin = Number(globalMargin ?? 0);
    if (Number.isFinite(configuredGlobalMargin) && configuredGlobalMargin > 0) {
      return configuredGlobalMargin;
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

  private applyInvisibleHotelMargin(amount: number, hotel: any, globalMargin = 0): number {
    const baseAmount = Number(amount || 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return 0;
    }

    const marginPercentage = this.getHotelMarginPercentage(hotel, globalMargin);
    const amountWithMargin = baseAmount + (baseAmount * marginPercentage) / 100;
    return this.money(amountWithMargin);
  }

  private enrichHotelWithMasterMargin(
    hotel: any,
    hotelMasterByProviderCode: Map<string, any>,
    globalMargin = 0,
  ): any {
    const provider = String(hotel?.provider || 'tbo').trim().toLowerCase();
    const hotelCode = String(hotel?.hotelCode || '').trim();
    const master = hotelMasterByProviderCode.get(`${provider}|${hotelCode}`);

    const directMargin = Number(
      hotel?.hotel_margin ??
      hotel?.hotelMargin ??
      hotel?.marginPercentage ??
      hotel?.hotel_margin_percentage ??
      hotel?.hotelMarginPercentage ??
      0,
    );
    const masterMargin = Number(master?.hotel_margin ?? 0);
    const configuredGlobalMargin = Number(globalMargin ?? 0);
    const resolvedMargin =
      Number.isFinite(directMargin) && directMargin > 0
        ? directMargin
        : Number.isFinite(masterMargin) && masterMargin > 0
          ? masterMargin
          : Number.isFinite(configuredGlobalMargin) && configuredGlobalMargin > 0
            ? configuredGlobalMargin
            : 0;

    if (!master && resolvedMargin <= 0) return hotel;

    return {
      ...hotel,
      _resolvedHotelMargin: resolvedMargin,
      hotel_margin: resolvedMargin,
      hotel_margin_gst_type: Number(
        hotel?.hotel_margin_gst_type ?? master?.hotel_margin_gst_type ?? 0,
      ),
      hotel_margin_gst_percentage: Number(
        hotel?.hotel_margin_gst_percentage ?? master?.hotel_margin_gst_percentage ?? 0,
      ),
    };
  }

  private shouldShowHotelMargins(): boolean {
    const raw = String(process.env.SHOW_HOTEL_MARGINS || '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

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
    const nationalityId = Number((plan as any)?.nationality ?? 0);
    const rawNationality = String((plan as any)?.nationality ?? '')
      .trim()
      .toUpperCase();

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
            `[OK] Resolved guestNationality from country table: nationality=${nationalityId} -> ${iso2}`,
          );
          return iso2;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[WARN] Could not resolve country mapping from table dvi_countries for nationality=${nationalityId}: ${message}`,
        );
      }
    }

 // Fallback: legacy hardcoded dropdown used IDs 101-295 which differ from dvi_countries IDs.
 // Resolve by looking up the country name from the legacy map and then querying dvi_countries by name.
      if (nationalityId >= 101 && nationalityId <= 295) {
        const legacyName = ItineraryHotelDetailsTboService.LEGACY_NATIONALITY_NAME[nationalityId];
        if (legacyName) {
          try {
            const countryByName = await this.prisma.dvi_countries.findFirst({
              where: { name: { contains: legacyName }, deleted: 0, status: 1 },
              select: { shortname: true, name: true },
            });
            const iso2 = this.extractIso2FromCountryRow(countryByName);
            if (iso2) {
 this.logger.log(
                `[OK] Resolved guestNationality via legacy name lookup: nationality=${nationalityId} (${legacyName}) -> ${iso2}`,
              );
              return iso2;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
              this.logger.warn(`[WARN] Legacy name lookup failed for "${legacyName}": ${msg}`);
          }
        }
      }

 // Some records may directly store ISO-2 code instead of FK id.
    if (/^[A-Z]{2}$/.test(rawNationality)) {
      this.logger.warn(
        `[WARN] Using direct ISO-2 nationality from plan value: ${rawNationality}`,
      );
      return rawNationality;
    }

    const envFallback = String(
      process.env.TBO_DEFAULT_GUEST_NATIONALITY || '',
    )
      .trim()
      .toUpperCase();
    if (/^[A-Z]{2}$/.test(envFallback)) {
      this.logger.warn(
        `[WARN] Using TBO_DEFAULT_GUEST_NATIONALITY fallback: ${envFallback}`,
      );
      return envFallback;
    }

      this.logger.warn(
        '[WARN] Unable to resolve guestNationality from plan/country table/env. Falling back to IN.',
    );
    return 'IN';
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
    includeOffline = true,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const startTime = Date.now();
 this.logger.log(`\n TBO HOTEL PACKAGES: Fetching dynamic packages for quote: ${quoteId}`);

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
      this.logger.warn(`[WARN] Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

 // The unfiltered response is the authoritative rate snapshot used by the
 // temporary pricing preview. Keep it stable for the short supplier-rate
 // window so the card and preview cannot price different live searches.
    if (!hasCompatibilityFilters) {
      const cached = this.getCachedHotelDetails(quoteId);
      if (cached) return cached;
    }

 const planId = plan.itinerary_plan_ID;
const guestNationality = await this.resolveGuestNationality(plan);

const preferredCategories = this.normalizeNumberList(
  (plan as any).preferred_hotel_category,
);

const preferredFacilities = Array.from(
  new Set(
    String((plan as any).hotel_facilities || '')
      .split(',')
      .map((facility) => facility.trim())
      .filter(Boolean),
  ),
);

const explicitMealPlanCode =
  inferCanonicalHotelRatePlanCode(
    String((plan as any).meal_plan_code || ''),
  );

const mealPlanBreakfast =
  Number((plan as any).meal_plan_breakfast ?? 0)
    ? 1
    : 0;

const mealPlanLunch =
  Number((plan as any).meal_plan_lunch ?? 0)
    ? 1
    : 0;

const mealPlanDinner =
  Number((plan as any).meal_plan_dinner ?? 0)
    ? 1
    : 0;

const hasExplicitMealFlags =
  mealPlanBreakfast === 1 ||
  mealPlanLunch === 1 ||
  mealPlanDinner === 1;

const fallbackMealPlanCode =
  hasExplicitMealFlags
    ? inferCanonicalHotelRatePlanCodeFromMealFlags(
        mealPlanBreakfast,
        mealPlanLunch,
        mealPlanDinner,
      )
    : null;

const preferredMealPlanCode =
  explicitMealPlanCode ||
  fallbackMealPlanCode;

this.logger.log(
  `[OK] Found plan ID: ${planId}`,
);

this.logger.log(
  `ðŸŽ›ï¸ Plan hotel prefs: ` +
    `categories=${
      preferredCategories.length
        ? preferredCategories.join(',')
        : 'ANY'
    }, ` +
    `mealPlan=${
      preferredMealPlanCode || 'ANY'
    }, ` +
    `facilities=${
      preferredFacilities.length
        ? preferredFacilities.join(',')
        : 'ANY'
    }`,
);

 // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

 this.logger.log(` Routes Query Result: ${JSON.stringify({
      total: routes.length,
      routes: routes.map(r => ({ id: (r as any).itinerary_route_ID, location: (r as any).location_name, date: (r as any).itinerary_route_date }))
    })}`);

    if (routes.length === 0) {
      this.logger.warn(`[WARN] No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

 this.logger.log(` Found ${routes.length} routes to process`);

 // Get number of nights from plan to determine which routes need hotels
    const noOfNights = Number((plan as any).no_of_nights || 0);
 this.logger.log(` Plan has ${noOfNights} nights`);

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
 this.logger.log(` Child ages from travellers: [${planChildAges.join(', ')}]`);
    }

    const restrictedHotelsByRoute = new Map<number, HotelSearchResult[]>();
    const fetchMode = this.resolveHotelFetchMode();
    let hotelsByRoute = new Map<number, HotelSearchResult[] | null>();

    if (fetchMode.axisOnly) {
 this.logger.warn(
        'HOTEL_FETCH_AXIS_ONLY enabled: fetching Offline + AxisRooms only; skipping TBO/VSR, STAAH, ResAvenue and HOBSE.',
      );

      routes.forEach((route) => {
        const routeId = Number((route as any).itinerary_route_ID || 0);
        if (routeId > 0) {
          hotelsByRoute.set(routeId, []);
        }
      });

      if (includeOffline) {
        const offlineHotelsByRoute = await this.offlineHotelCatalogService.fetchOfflineHotelsForRoutes(
          routes,
          noOfNights,
          guestNationality,
          planRoomCount,
          planAdultCount,
          planChildCount,
          planChildAges,
        );
        offlineHotelsByRoute.forEach((offlineHotels, routeId) => {
          const existingHotels = hotelsByRoute.get(routeId) || [];
          hotelsByRoute.set(routeId, [...existingHotels, ...offlineHotels]);
        });
      }

      const savedMealPlansByRoute = await this.loadSavedMealPlansPerRoute(planId, routes);
      const axisroomsHotelsByRoute = await this.fetchAxisroomsHotelsForRoutes(
        routes,
        noOfNights,
        savedMealPlansByRoute,
        preferredMealPlanCode,
        planRoomCount,
      );
      axisroomsHotelsByRoute.forEach((axisroomsHotels, routeId) => {
        const existingHotels = hotelsByRoute.get(routeId) || [];
        const hotelStrs = existingHotels.map((h) => `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`);
        const newHotels = axisroomsHotels.filter(
          (h) => !hotelStrs.includes(`${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`),
        );
        if (newHotels.length > 0) {
 this.logger.log(` Added ${newHotels.length} new AxisRooms hotel(s) to route ${routeId}`);
        }
        hotelsByRoute.set(routeId, [...existingHotels, ...newHotels]);
      });
    } else {
 // Step 3: Fetch hotels from TBO for each route (except last route if it's departure day)
      hotelsByRoute = await this.fetchHotelsForRoutesWithRetry(
        routes,
        noOfNights,
        guestNationality,
        planRoomCount,
        planAdultCount,
        planChildCount,
        planChildAges,
      );

      // A failed supplier stay block is deliberately represented as null by
      // the retry layer so it can be retried/compared.  Downstream merging and
      // preference filtering operate on route hotel arrays; keep the failed
      // route empty without allowing it to abort successful routes.
      hotelsByRoute.forEach((hotels, routeId) => {
        if (!Array.isArray(hotels)) {
          this.logger.warn(`[HOTEL_SEARCH] Route ${routeId} returned no supplier data; continuing with an empty route.`);
          hotelsByRoute.set(routeId, []);
        }
      });

      const tboOnlyFetch = this.isTboOnlyFetchEnabled();
      if (tboOnlyFetch) {
      this.logger.warn(
        '[WARN] HOTEL_FETCH_TBO_ONLY enabled: skipping HOBSE/ResAvenue/AxisRooms provider fetch and returning only TBO hotels',
        );
      } else {
        if (includeOffline) {
          const offlineHotelsByRoute = await this.offlineHotelCatalogService.fetchOfflineHotelsForRoutes(
            routes,
            noOfNights,
            guestNationality,
            planRoomCount,
            planAdultCount,
            planChildCount,
            planChildAges,
          );
          offlineHotelsByRoute.forEach((offlineHotels, routeId) => {
            const existingHotels = hotelsByRoute.get(routeId) || [];
            const hotelKeys = new Set(
              existingHotels.map((hotel) => `${String(hotel.hotelCode)}|${String(hotel.provider).toLowerCase()}`),
            );
            const newHotels = offlineHotels.filter(
              (hotel) => !hotelKeys.has(`${String(hotel.hotelCode)}|${String(hotel.provider).toLowerCase()}`),
            );
            hotelsByRoute.set(routeId, [...existingHotels, ...newHotels]);
          });
        }

        if (this.isHobseSearchEnabled()) {
 // Step 3.5: Fetch HOBSE hotels and merge with TBO hotels
 // First, create a HOBSE-specific city code map using hobse_city_code
          let hobseHotelsByRoute = new Map<number, HotelSearchResult[]>();
          try {
            const hobseCityCodeMap = await this.batchMapDestinationsToHobseCityCodes(routes);
            hobseHotelsByRoute = await this.fetchHobseHotelsForRoutes(routes, noOfNights, hobseCityCodeMap);
          } catch (error) {
            this.logger.warn(
              `[HOBSE] Optional provider search skipped: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

 // Merge HOBSE hotels into the TBO hotel map
          hobseHotelsByRoute.forEach((hobseHotels, routeId) => {
            const existingHotels = hotelsByRoute.get(routeId) || [];
            hotelsByRoute.set(routeId, [...existingHotels, ...hobseHotels]);
          });
        } else {
          this.logger.warn('[WARN] HOBSE_SEARCH_ENABLED=0: skipping HOBSE hotel search results');
        }

 // Step 3.6: Fetch ResAvenue hotels explicitly (in case they weren't included in TBO search)
 this.logger.log(`\n STEP 3.6: Starting ResAvenue hotel fetch for ${routes.length} routes...`);
        let resavenueHotelsByRoute = new Map<number, HotelSearchResult[]>();
        try {
          resavenueHotelsByRoute = await this.fetchResavenueHotelsForRoutes(
            routes,
            noOfNights,
            guestNationality,
            planRoomCount,
            planAdultCount,
            planChildCount,
          );
        } catch (error) {
          this.logger.warn(
            `[RESAVENUE] Optional provider search skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

 // Debug: Check what ResAvenue returned
        let totalResavenueHotels = 0;
        resavenueHotelsByRoute.forEach((hotels, routeId) => {
          totalResavenueHotels += hotels.length;
          if (hotels.length > 0) {
 this.logger.log(` Route ${routeId} has ${hotels.length} ResAvenue hotels: ${hotels.map(h => `${h.hotelName} (${h.hotelCode})`).join(', ')}`);
          }
        });
 this.logger.log(` ResAvenue Total: ${totalResavenueHotels} hotels across all routes`);

 // Merge ResAvenue hotels into the hotel map
        resavenueHotelsByRoute.forEach((resavenueHotels, routeId) => {
          const existingHotels = hotelsByRoute.get(routeId) || [];
 // Avoid duplicates: check if hotel already exists by hotel code + provider
          const hotelStrs = existingHotels.map(h => `${h.hotelCode}|${h.provider}`);
          const newHotels = resavenueHotels.filter(h => !hotelStrs.includes(`${h.hotelCode}|${h.provider}`));
          if (newHotels.length > 0) {
 this.logger.log(` Added ${newHotels.length} new ResAvenue hotel(s) to route ${routeId}`);
            newHotels.forEach(h => {
 this.logger.log(` - ${h.hotelName} (${h.hotelCode}, Category: ${h.category}, Meal: ${h.mealPlan}, Price: ${h.price})`);
            });
          } else if (resavenueHotels.length > 0) {
 this.logger.log(` No new ResAvenue hotels (duplicates: ${resavenueHotels.length})`);
          }
          const merged = [...existingHotels, ...newHotels];
 this.logger.log(` Route ${routeId}: Total hotels now = ${merged.length}`);
          hotelsByRoute.set(routeId, merged);
        });

 // Step 3.7: Load saved meal plans per route for AxisRooms filtering
        const savedMealPlansByRoute = await this.loadSavedMealPlansPerRoute(planId, routes);

 // Step 3.8: Fetch AxisRooms-enabled hotels from local DB and merge with existing providers.
        let axisroomsHotelsByRoute = new Map<number, HotelSearchResult[]>();
        try {
          axisroomsHotelsByRoute = await this.fetchAxisroomsHotelsForRoutes(
            routes,
            noOfNights,
            savedMealPlansByRoute,
            preferredMealPlanCode,
            planRoomCount,
          );
        } catch (error) {
          this.logger.warn(
            `[AXISROOMS] Optional provider search skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        axisroomsHotelsByRoute.forEach((axisroomsHotels, routeId) => {
          const existingHotels = hotelsByRoute.get(routeId) || [];
          const hotelStrs = existingHotels.map((h) => `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`);
          const newHotels = axisroomsHotels.filter(
            (h) => !hotelStrs.includes(`${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`),
          );
          if (newHotels.length > 0) {
 this.logger.log(` Added ${newHotels.length} new AxisRooms hotel(s) to route ${routeId}`);
          }
          hotelsByRoute.set(routeId, [...existingHotels, ...newHotels]);
        });

        let staahHotelsByRoute = new Map<number, HotelSearchResult[]>();
        try {
          staahHotelsByRoute = await this.fetchStaahHotelsForRoutes(
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
        } catch (error) {
          this.logger.warn(
            `[STAAH] Optional provider search skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
 this.logger.log(` Added ${newHotels.length} new STAAH hotel(s) to route ${routeId}`);
          }
          hotelsByRoute.set(routeId, [...existingHotels, ...newHotels]);
        });
      }
    }

 this.logger.log(`[STAAH DEBUG] Counts before preference filters:`);
    Array.from(hotelsByRoute.entries()).forEach(([routeId, hotels]) => {
      const staahCount = Array.isArray(hotels) ? hotels.filter((h) => h.provider === 'staah').length : 0;
 this.logger.log(` Route ${routeId}: STAAH before filter = ${staahCount}`);
    });

  const filteredHotelsByRoute =
  await this.applyPlanPreferenceFilters(
    hotelsByRoute,
    preferredCategories,
    preferredMealPlanCode,
    preferredFacilities,
  );

 this.logger.log(`[STAAH DEBUG] Counts after preference filters:`);
    Array.from(filteredHotelsByRoute.entries()).forEach(([routeId, hotels]) => {
      const staahCount = Array.isArray(hotels) ? hotels.filter((h) => h.provider === 'staah').length : 0;
 this.logger.log(` Route ${routeId}: STAAH after filter = ${staahCount}`);
    });

 // Debug: Check if any hotels were found
    const hotelEntries = Array.from(filteredHotelsByRoute.entries());
 this.logger.log(`\n HOTEL FETCH RESULTS (ALL ENABLED PROVIDERS):`);
    hotelEntries.forEach(([routeId, hotels]) => {
      const tboCount = hotels.filter(h => h.provider === 'tbo').length;
      const hobseCount = hotels.filter(h => h.provider === 'hobse').length;
      const resavenueCount = hotels.filter(h => h.provider === 'resavenue').length;
      const axisroomsCount = hotels.filter(h => h.provider === 'axisrooms').length;
      const staahCount = hotels.filter(h => h.provider === 'staah').length;
 this.logger.log(` Route ${routeId}: ${hotels.length} hotels (TBO: ${tboCount}, HOBSE: ${hobseCount}, ResAvenue: ${resavenueCount}, AxisRooms: ${axisroomsCount}, STAAH: ${staahCount})`);
      if (hotels.length > 0) {
 // this.logger.log(` - ${hotels.map(h => `${h.hotelName} (${h.provider})`).join(', ')}`);
      }
    });

    if (hotelEntries.every(([_, hotels]) => hotels.length === 0)) {
 this.logger.warn(`\n WARNING: ALL ROUTES RETURNED ZERO HOTELS!\n`);
    }

 // this.logger.log(` Hotels by Route: ${JSON.stringify(Object.fromEntries(hotelsByRoute))}`);

 // Step 4: Generate recommendation packages. v1 remains the rollback path;
 // v2 selects complete logical-stay packages from real eligible options.
    const algorithm = this.recommendationAlgorithm();
    const packages = algorithm === 'v2'
      ? this.hotelRecommendationPackageService.generate({
          routes: routes as any,
          hotelsByRoute: filteredHotelsByRoute,
          noOfNights,
          preferredMealPlanCode,
          preferredCategories,
          maxDistanceKm: Number(process.env.MAX_RECOMMENDED_HOTEL_DISTANCE_KM || 15),
          requireKnownDistance: String(process.env.HOTEL_RECOMMENDATION_REQUIRE_DISTANCE || '').trim() === 'true',
        })
      : this.adaptLegacyPackages(this.generatePricePackages(filteredHotelsByRoute, routes), routes);
    // Keep v2 recommendation packages for the recommendation tabs, but expose
    // every fetched live/offline option in the hotel list. The legacy price
    // grouping is only used to assign the complete option set to the same four
    // display groups; it does not change the v2 recommendation selection.
    const allAvailabilityPackages = this.generatePricePackages(filteredHotelsByRoute, routes);
    this.logger.log(`[HOTEL_RECOMMENDATION] algorithm=${algorithm} planId=${planId} groups=${packages.length}`);

 // Step 5: Build response
    const response = await this.buildHotelDetailsResponse(
      quoteId,
      planId,
      packages,
      filteredHotelsByRoute,
      restrictedHotelsByRoute,
      routes,
      noOfNights,
      allAvailabilityPackages,
    );

    const duration = Date.now() - startTime;
 this.logger.log(` Generated ${packages.length} hotel packages`);
 this.logger.log(` Total TBO Service Time: ${duration}ms\n`);

    this.setCachedHotelDetails(quoteId, response);

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

 // OPTIMIZATION 1: Batch load ALL cities upfront instead of querying per route
    const cityCodeMap = await this.batchMapDestinationsToCityCodes(routes);
 this.logger.log(` Pre-loaded ${Object.keys(cityCodeMap).length} city codes for all routes`);

 // Build stay blocks so TBO search is done once per destination-stay window,
 // not once per day/route.
    const stayBlocks = this.buildStayBlocks(routes, noOfNights);
 this.logger.log(` Built ${stayBlocks.length} stay block(s) for consolidated TBO search`);

 // OPTIMIZATION 2: Prepare all hotel search tasks for parallel execution
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
              `[ERROR] HOTEL SEARCH ERROR for stay block ${block.destination} (${block.checkInDate} -> ${block.checkOutDate}): ${errorMsg}`,
            );
 block.routeIds.forEach((routeId) => hotelsByRoute.set(routeId, null)); // null = provider failure
          }),
      );
    }

 // OPTIMIZATION 3: Execute all searches in parallel instead of sequentially
 this.logger.log(` Starting ${searchTasks.length} parallel hotel searches...`);
    await Promise.all(searchTasks);
 this.logger.log(` All parallel searches completed`);

    return hotelsByRoute;
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
 this.logger.log(` Skipping route ${routeIndex + 1} (last route - departure day, no hotel needed)`);
        continue;
      }

      const routeId = Number((route as any).itinerary_route_ID);
      const destination = String((route as any).next_visiting_location || '').trim();
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
   * Reduces database queries from NÃ—3 (N routes Ã— 3 attempts) to 1 query
 */
  private async batchMapDestinationsToCityCodes(routes: any[]): Promise<Record<string, string>> {
    const cityCodeMap: Record<string, string> = {};
    const cityAliases: Record<string, string[]> = {
      cochin: ['kochi'],
      alleppey: ['alappuzha'],
      alleppe: ['alappuzha'],
      calicut: ['kozhikode'],
      trivandrum: ['thiruvananthapuram'],
      pondicherry: ['puducherry'],
      bangalore: ['bengaluru'],
    };

 // Extract unique destinations from all routes
    const uniqueDestinations = [...new Set(routes.map(r => (r as any).next_visiting_location))];
 this.logger.log(` Extracting city codes for ${uniqueDestinations.length} unique destinations`);

    if (uniqueDestinations.length === 0) return cityCodeMap;

 // Load ALL cities from database in ONE query instead of per-route queries
    const allCities = await this.prisma.dvi_cities.findMany({
      select: { id: true, name: true, tbo_city_code: true, status: true },
      orderBy: [{ status: 'desc' }, { id: 'asc' }],
    });
 this.logger.log(` Loaded ${allCities.length} cities from database in single query`);

 // Build a map for fast lookup
    const cityNameMap: Record<string, string> = {};
    const cityPrefixMap: Record<string, string> = {};

    allCities.forEach(city => {
      if (city.tbo_city_code) {
        const lowerName = city.name.toLowerCase();
        if (!cityNameMap[lowerName]) {
          cityNameMap[lowerName] = city.tbo_city_code;
        }
        const prefix = city.name.split(',')[0].trim().toUpperCase();
        if (!cityPrefixMap[prefix]) {
          cityPrefixMap[prefix] = city.tbo_city_code;
        }
      }
    });

 // Map each destination to city code
    uniqueDestinations.forEach(destination => {
      if (!destination) return;

      const rawDestination = String(destination).trim();
      const firstPart = rawDestination.split(/[,\(\-]/)[0].trim();
      const normalizedToken = this.normalizeCityToken(rawDestination);
      const aliasTokens = cityAliases[normalizedToken] || [];
      const lookupTerms = Array.from(
        new Set(
          [
            normalizedToken,
            ...aliasTokens,
            rawDestination.toLowerCase(),
            firstPart.toLowerCase(),
          ].filter(Boolean),
        ),
      );

      let cityCode = '';
      for (const term of lookupTerms) {
        cityCode = cityNameMap[term];
        if (cityCode) break;
      }

      if (!cityCode) {
        const prefixTerms = Array.from(
          new Set([firstPart, normalizedToken, ...aliasTokens].map((value) => value.toUpperCase())),
        );
        for (const prefix of prefixTerms) {
          cityCode = cityPrefixMap[prefix];
          if (cityCode) break;
        }
      }

      if (cityCode) {
        if (normalizedToken !== firstPart.toLowerCase() || aliasTokens.length > 0) {
 this.logger.log(
            `[OK] "${destination}" -> TBO Code: ${cityCode} (preferred lookup: ${[normalizedToken, ...aliasTokens].join(' -> ')})`,
          );
        } else {
 this.logger.log(` "${destination}" TBO Code: ${cityCode}`);
        }
        cityCodeMap[destination] = cityCode;
      } else {
 this.logger.warn(` No city code found for: "${destination}"`);
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

 this.logger.log(` Loading HOBSE city codes for ${uniqueDestinations.length} unique destinations`);
      if (uniqueDestinations.length === 0) return cityCodeMap;

      const allCities = await this.prisma.dvi_cities.findMany({
        select: { name: true, hobse_city_code: true } as any,
      });
 this.logger.log(` Loaded ${allCities.length} cities for HOBSE code lookup`);

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
 this.logger.log(` HOBSE "${destination}" -> code: ${code}`);
          cityCodeMap[destination] = code;
        } else {
 this.logger.warn(` No HOBSE city code found for: "${destination}"`);
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
        `[WARN] Stay block (${block.routeIds.join(',')}): No mapped TBO city code for "${destination}". Falling back to destination text lookup.`,
      );
    }

 // Use pax counts from the plan; guarantee at least 1 adult so TBO validation passes
    if (adultCount <= 0) {
      this.logger.warn(
        `[WARN] Stay block (${block.routeIds.join(',')}): adultCount is ${adultCount} (not saved in plan?) - defaulting to 1`,
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
      `[OK] Found ${hotels ? hotels.length : 0} hotels for stay block (${block.routeIds.join(',')}) (TBO only at this stage)`,
    );

    if (hotels && hotels.length > 0) {
 this.logger.log(` TBO Hotels for stay block (${block.routeIds.join(',')}):`);
      hotels.forEach((h, idx) => {
 // this.logger.log(` ${idx + 1}. ${h.hotelName} (${h.provider}) - ${h.price}`);
      });
    } else {
 this.logger.log(` WARNING: TBO search returned ZERO hotels for stay block (${block.routeIds.join(',')})!`);
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
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const totalRoutes = routes.length;

 this.logger.log(`\n HOBSE HOTEL FETCH: Attempting to fetch HOBSE hotels for ${routes.length} routes`);

    try {
      for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex];
        const routeId = (route as any).itinerary_route_ID;

 // Skip hotel generation for the last route (departure day) if routeIndex >= noOfNights
        const isLastRoute = routeIndex === totalRoutes - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
 this.logger.log(` Skipping HOBSE route ${routeIndex + 1} (last route - departure day)`);
          continue;
        }

        const destination = (route as any).next_visiting_location;
 // Get the HOBSE city code from the pre-built map
        const cityCode = cityCodeMap[destination];

        if (!cityCode) {
 this.logger.warn(` No HOBSE city code for destination "${destination}" - skipping HOBSE search`);
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
 this.logger.log(` HOBSE Route ${routeId}: Found ${hobseHotels.length} hotels in ${destination}`);
            hotelsByRoute.set(routeId, hobseHotels);
          } else {
 this.logger.log(` HOBSE Route ${routeId}: No hotels found in ${destination}`);
            hotelsByRoute.set(routeId, []);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.warn(` HOBSE Route ${routeId} search failed: ${errorMsg}`);
          hotelsByRoute.set(routeId, []);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.error(` HOBSE HOTEL FETCH FAILED: ${errorMsg}`);
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
    roomCount: number = 1,
    adultCount: number = 2,
    childCount: number = 0,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const totalRoutes = routes.length;

 this.logger.log(`\n RESAVENUE HOTEL FETCH: Attempting to fetch ResAvenue hotels for ${routes.length} routes`);

    try {
      const safeAdultCount = adultCount > 0 ? adultCount : 1;
      const safeChildCount = childCount >= 0 ? childCount : 0;
      const safeRoomCount = Math.max(Number(roomCount || 1), 1);
      const guestCount = safeAdultCount + safeChildCount;

      for (let routeIndex = 0; routeIndex < totalRoutes; routeIndex++) {
        const route = routes[routeIndex];
        const routeId = (route as any).itinerary_route_ID;

 // Skip hotel generation for the last route (departure day) if routeIndex >= noOfNights
        const isLastRoute = routeIndex === totalRoutes - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
 this.logger.log(` Skipping ResAvenue route ${routeIndex + 1} (last route - departure day)`);
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
            guestNationality,
 providers: ['resavenue'], // Only ResAvenue
          });

          if (resavenueHotels && resavenueHotels.length > 0) {
 this.logger.log(` ResAvenue Route ${routeId}: Found ${resavenueHotels.length} hotels in ${destination}`);
            hotelsByRoute.set(routeId, resavenueHotels);
          } else {
 this.logger.log(` ResAvenue Route ${routeId}: No hotels found in ${destination}`);
            hotelsByRoute.set(routeId, []);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.warn(` ResAvenue Route ${routeId} search failed: ${errorMsg}`);
          hotelsByRoute.set(routeId, []);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.error(` RESAVENUE HOTEL FETCH FAILED: ${errorMsg}`);
    }

    return hotelsByRoute;
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
    if (!Array.isArray(rows) || rows.length === 0) {
      return { blocked: false, reason: null, availableAgainFrom: null };
    }

    const checkInLabel = this.formatDateOnly(checkInDate);
    const checkOutLabel = this.formatDateOnly(checkOutDate);
    const stayEndDate = this.addDays(checkOutDate, -1);
    const stayEndLabel = this.formatDateOnly(stayEndDate);

    const overlapsStay = (row: any): boolean => {
      const rowStart = this.toIstDateOnly(row.start_date);
      const rowEnd = this.toIstDateOnly(row.end_date);
      return rowStart.getTime() <= stayEndDate.getTime() && rowEnd.getTime() >= checkInDate.getTime();
    };

    const activeOnDate = (row: any, date: Date): boolean => {
      const rowStart = this.toIstDateOnly(row.start_date);
      const rowEnd = this.toIstDateOnly(row.end_date);
      return rowStart.getTime() <= date.getTime() && rowEnd.getTime() >= date.getTime();
    };

    const numericValuesFor = (type: string, matcher: (row: any) => boolean): number[] =>
      rows
        .filter((row) => this.normalizeStaahRestrictionType(row.type) === type && matcher(row))
        .map((row) => Number(row.value))
        .filter((value) => Number.isFinite(value));

    for (const row of rows) {
      const type = this.normalizeStaahRestrictionType(row.type);
      if (!this.isStaahRestrictionTruthy(row.value)) continue;

      if ((type === 'stopsell' || type === 'status') && overlapsStay(row)) {
        return {
          blocked: true,
          reason:
            type === 'status'
              ? `status close active during stay ${checkInLabel} to ${stayEndLabel}`
              : `stop sell active during stay ${checkInLabel} to ${stayEndLabel}`,
          availableAgainFrom: this.getStaahRestrictionAvailableAgainFrom(row),
        };
      }

      if (type === 'cta' && activeOnDate(row, checkInDate)) {
        return {
          blocked: true,
          reason: `CTA active on check-in date ${checkInLabel}`,
          availableAgainFrom: this.getStaahRestrictionAvailableAgainFrom(row),
        };
      }

      if (type === 'ctd' && activeOnDate(row, checkOutDate)) {
        return {
          blocked: true,
          reason: `CTD active on check-out date ${checkOutLabel}`,
          availableAgainFrom: this.getStaahRestrictionAvailableAgainFrom(row),
        };
      }
    }

    const minStayValues = numericValuesFor('minstay', (row) => activeOnDate(row, checkInDate));
    if (minStayValues.length > 0) {
      const minStay = Math.max(...minStayValues);
      if (lengthOfStay < minStay) {
        return {
          blocked: true,
          reason: `minimum stay ${minStay} nights required for LOS ${lengthOfStay}`,
          availableAgainFrom: null,
        };
      }
    }

    const maxStayValues = numericValuesFor('maxstay', (row) => activeOnDate(row, checkInDate));
    if (maxStayValues.length > 0) {
      const maxStay = Math.min(...maxStayValues);
      if (lengthOfStay > maxStay) {
        return {
          blocked: true,
          reason: `maximum stay ${maxStay} nights allows LOS ${lengthOfStay}`,
          availableAgainFrom: null,
        };
      }
    }

    const minStayThroughValues = numericValuesFor('minstay_through', overlapsStay);
    if (minStayThroughValues.length > 0) {
      const minStayThrough = Math.max(...minStayThroughValues);
      if (lengthOfStay < minStayThrough) {
        return {
          blocked: true,
          reason: `minimum stay through ${minStayThrough} nights required for LOS ${lengthOfStay}`,
          availableAgainFrom: null,
        };
      }
    }

    const maxStayThroughValues = numericValuesFor('maxstay_through', overlapsStay);
    if (maxStayThroughValues.length > 0) {
      const maxStayThrough = Math.min(...maxStayThroughValues);
      if (lengthOfStay > maxStayThrough) {
        return {
          blocked: true,
          reason: `maximum stay through ${maxStayThrough} nights allows LOS ${lengthOfStay}`,
          availableAgainFrom: null,
        };
      }
    }

    return { blocked: false, reason: null, availableAgainFrom: null };
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
 this.logger.log(` Found ${mealPlansByRoute.size} routes with saved hotels`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
 this.logger.warn(` Failed to load saved hotel indicators: ${errorMsg}`);
    }

    return mealPlansByRoute;
  }

  private async fetchAxisroomsHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    savedMealPlansByRoute?: Map<number, string>,
    preferredMealPlanCode?: string | null,
    roomCount: number = 1,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const requiredRoomCount = Math.max(Number(roomCount || 1), 1);
    const totalRoutes = routes.length;

 this.logger.log(`\n AXISROOMS HOTEL FETCH: Attempting to fetch AxisRooms hotels for ${routes.length} routes`);

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
        axisrooms_property_id: true,
        hotel_cancel_policy: true,
      },
    });

    if (!axisroomsHotels.length) {
 this.logger.log(' No axisrooms-enabled hotels found in local DB');
      return hotelsByRoute;
    }

    const axisPropertyToHotelIds = new Map<string, Set<number>>();
    for (const hotel of axisroomsHotels as any[]) {
      const propertyId = String(hotel.axisrooms_property_id || '').trim();
      if (!propertyId) continue;
      const ids = axisPropertyToHotelIds.get(propertyId) || new Set<number>();
      ids.add(Number(hotel.hotel_id));
      axisPropertyToHotelIds.set(propertyId, ids);
    }
    const ambiguousAxisMappings = Array.from(axisPropertyToHotelIds.entries()).filter(([, ids]) => ids.size > 1);
    if (ambiguousAxisMappings.length > 0) {
      throw new BadRequestException({
        message: 'AxisRooms property mapping is ambiguous; each property must map to one canonical hotel.',
        properties: ambiguousAxisMappings.map(([propertyId, ids]) => ({ propertyId, hotelIds: Array.from(ids) })),
      });
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
 this.logger.log(` Skipping AxisRooms route ${routeIndex + 1} (last route - departure day)`);
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
 this.logger.log(` AxisRooms Route ${routeId}: No axisrooms hotels mapped for city ${destinationRaw}`);
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
        },
        select: {
          hotel_id: true,
          room_id: true,
          start_date: true,
          end_date: true,
          free: true,
          received_at: true,
        },
      });

      if (!availRows.length) {
        hotelsByRoute.set(routeId, []);
 this.logger.log(` AxisRooms Route ${routeId}: No available inventory for ${destinationRaw} on ${dateOnly.toISOString().split('T')[0]}`);
        continue;
      }

      // ARI sends broad validity ranges and later date-specific corrections.
      // Resolve one effective row per hotel/room before applying room-count
      // eligibility; otherwise an old broad row can mask a newer daily update.
      const effectiveAvailabilityByRoom = new Map<string, any>();
      for (const row of availRows as any[]) {
        const hotelId = Number(row.hotel_id);
        const roomId = Number(row.room_id);
        if (!Number.isFinite(hotelId) || hotelId <= 0 || !Number.isFinite(roomId) || roomId <= 0) {
          continue;
        }

        const startTime = new Date(row.start_date).getTime();
        const endTime = new Date(row.end_date).getTime();
        const rangeDays = Number.isFinite(startTime) && Number.isFinite(endTime)
          ? Math.max(0, Math.round((endTime - startTime) / ItineraryHotelDetailsTboService.ONE_DAY_MS))
          : Number.MAX_SAFE_INTEGER;
        const key = `${hotelId}|${roomId}`;
        const current = effectiveAvailabilityByRoom.get(key);
        const currentStart = current ? new Date(current.start_date).getTime() : Number.NaN;
        const currentEnd = current ? new Date(current.end_date).getTime() : Number.NaN;
        const currentRangeDays = current && Number.isFinite(currentStart) && Number.isFinite(currentEnd)
          ? Math.max(0, Math.round((currentEnd - currentStart) / ItineraryHotelDetailsTboService.ONE_DAY_MS))
          : Number.MAX_SAFE_INTEGER;
        const receivedAt = new Date(row.received_at).getTime();
        const currentReceivedAt = current ? new Date(current.received_at).getTime() : Number.NaN;

        if (
          !current ||
          rangeDays < currentRangeDays ||
          (rangeDays === currentRangeDays && receivedAt > currentReceivedAt)
        ) {
          effectiveAvailabilityByRoom.set(key, row);
        }
      }

      const effectiveAvailability = Array.from(effectiveAvailabilityByRoom.values());
      const eligibleAvailability = effectiveAvailability.filter(
        (row: any) => Number(row.free || 0) >= requiredRoomCount,
      );
      const roomIds = Array.from(
        new Set(
          eligibleAvailability
            .map((r: any) => Number(r.room_id))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      if (effectiveAvailability.length > eligibleAvailability.length) {
        this.logger.log(
          ` AxisRooms Route ${routeId}: filtered ${effectiveAvailability.length - eligibleAvailability.length} room(s) below required room count ${requiredRoomCount}`,
        );
      }

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
          start_date: true,
          end_date: true,
          received_at: true,
          source: true,
        },
      });

      const validOccupancyRows = occupancyRowsRaw.filter((row: any) => {
        const key = `${Number((row as any).hotel_id)}|${Number((row as any).room_id)}|${String((row as any).rateplan_id || '')}`;
        return validRatePlanKeySet.has(key);
      });
      const effectiveOccupancyByPlan = new Map<string, any>();
      for (const row of validOccupancyRows as any[]) {
        const startTime = new Date(row.start_date).getTime();
        const endTime = new Date(row.end_date).getTime();
        const rangeDays = Math.max(0, Math.round((endTime - startTime) / ItineraryHotelDetailsTboService.ONE_DAY_MS));
        const key = `${Number(row.hotel_id)}|${Number(row.room_id)}|${String(row.rateplan_id || '')}`;
        const current = effectiveOccupancyByPlan.get(key);
        const currentRangeDays = current
          ? Math.max(0, Math.round((new Date(current.end_date).getTime() - new Date(current.start_date).getTime()) / ItineraryHotelDetailsTboService.ONE_DAY_MS))
          : Number.MAX_SAFE_INTEGER;
        const receivedAt = new Date(row.received_at).getTime();
        const currentReceivedAt = current ? new Date(current.received_at).getTime() : Number.NaN;
        if (!current || rangeDays < currentRangeDays || (rangeDays === currentRangeDays && receivedAt > currentReceivedAt)) {
          effectiveOccupancyByPlan.set(key, row);
        }
      }
      const occupancyRows = Array.from(effectiveOccupancyByPlan.values());

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
      for (const row of eligibleAvailability as any[]) {
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
        `[WARN] AxisRooms Route ${routeId}: Hotel ${hid} - No valid rates found in any occupancy row for this hotel/room (checked ${occupancyRows.filter((o: any) => Number((o as any).hotel_id) === hid).length} rows)`,
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
          providerDisplayName: 'AxisRooms',
          canonicalHotelId: hid,
          providerHotelCode: String((hotel as any).axisrooms_property_id || hid),
          rateOptionId: `axisrooms:${hid}:${selectedRoomId}:${selectedRateplanId}:${dateOnly.toISOString().slice(0, 10)}`,
          // AxisRooms availability/rates are read from our ARI-synchronised
          // database. Booking remains supplier-bookable, but the displayed
          // price is not fetched from a live search request.
          bookingMode: 'LIVE_API',
          priceSource: 'DATABASE',
          isLiveRate: false,
          isLiveBookable: true,
          isSelectable: true,
          requiresHotelApproval: false,
          approvalStatus: 'NOT_REQUIRED',
          manualConfirmationStatus: 'NOT_STARTED',
          availabilityStatus: 'AVAILABLE',
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
        `[OK] AxisRooms Route ${routeId}: Found ${axisroomsRouteHotels.length} hotels in ${destinationRaw} (ratePlan-gated, droppedRows=${droppedByRatePlanGate})`,
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


  private adaptLegacyPackages(
    legacyPackages: Array<{ groupType: number; label: string; hotels: Array<HotelSearchResult & { routeId: number }> }>,
    routes: any[],
  ): RecommendationPackage[] {
    return legacyPackages.map((pkg) => {
      const hotels = pkg.hotels.map((hotel) => {
        const route = routes.find((candidate) => Number(candidate?.itinerary_route_ID || 0) === Number(hotel.routeId));
        const date = route?.itinerary_route_date
          ? new Date(route.itinerary_route_date).toISOString().slice(0, 10)
          : 'unknown';
        const nextDate = date === 'unknown'
          ? date
          : new Date(`${date}T00:00:00.000Z`);
        if (nextDate instanceof Date) nextDate.setUTCDate(nextDate.getUTCDate() + 1);
        const checkOut = nextDate instanceof Date ? nextDate.toISOString().slice(0, 10) : date;
        const offline = String(hotel.provider || '').trim().toLowerCase() === 'offline';
        return {
          ...hotel,
          routeId: Number(hotel.routeId),
          routeIds: [Number(hotel.routeId)],
          stayKey: `${Number(hotel.routeId)}|${date}|${checkOut}`,
          exactFullStayTotal: Number(hotel.totalStayPrice ?? hotel.price ?? 0),
          canonicalMealPlan: inferCanonicalHotelRatePlanCode(String((hotel as any).mealPlan || '')) || inferCanonicalHotelRatePlanCodeFromMealText(String((hotel as any).mealPlan || '')),
          availabilityState: offline ? 'OFFLINE_APPROVAL_REQUIRED' : 'AVAILABLE',
          distanceStatus: 'UNKNOWN',
          distanceReference: 'UNKNOWN',
          normalizedCategory: 'UNKNOWN',
        } as RecommendationHotel;
      });
      const totalPrice = this.money(hotels.reduce((sum, hotel) => sum + Number(hotel.exactFullStayTotal || 0), 0));
      return {
        groupType: pkg.groupType,
        label: pkg.label,
        hotels,
        totalPrice,
        partialTotal: totalPrice,
        targetPrice: null,
        complete: true,
        distinctFromPrevious: true,
        diversityScore: 0,
        repeatedHotelIds: [],
        repeatedAcrossGroupsHotelIds: [],
        sameOptionAcrossGroups: [],
        duplicateWithinPackageHotelIds: [],
        repeatedFromGroups: [],
        fallbackReasons: [],
        stayResults: hotels.map((hotel) => ({
          stayKey: hotel.stayKey,
          parentRouteId: hotel.routeId,
          routeIds: hotel.routeIds,
          destination: String(routes.find((route) => Number(route?.itinerary_route_ID || 0) === hotel.routeId)?.next_visiting_location || ''),
          checkInDate: hotel.stayKey.split('|')[1] || '',
          checkOutDate: hotel.stayKey.split('|')[2] || '',
          nights: 1,
          state: hotel.availabilityState === 'OFFLINE_APPROVAL_REQUIRED' ? 'OFFLINE_FALLBACK' : 'SELECTED',
          hotel,
          totalPrice: hotel.exactFullStayTotal,
        })),
      };
    });
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
 this.logger.log(`\n PRICE TIER GENERATION DEBUG (PER-DESTINATION):`);
 this.logger.log(` Total routes: ${routes.length}`);
    hotelsByRoute.forEach((hotels, routeId) => {
      const prices = hotels.map(h => h.price).join(', ');
 this.logger.log(` Route ${routeId}: ${hotels.length} hotels (Prices: ${prices})`);
    });

 // NEW LOGIC: Assign hotels to groups PER DESTINATION (per route)
 // Rule: If 1 hotel -> put in all 4 groups
 // If 2+ hotels -> distribute in ascending price order across groups

 // First pass: Determine groupType for each hotel based on its destination
 const hotelGroupAssignments = new Map<string, number>(); // key: "routeId-hotelCode" -> groupType

    for (const route of routes) {
      const routeId = (route as any).itinerary_route_ID;
      const availableHotels = hotelsByRoute.get(routeId);

      if (availableHotels === null) {
        this.logger.warn(`[WARN] Provider/system failure for route ${routeId} - skipping placeholder row. See previous logs for error.`);
        continue;
      }
      if (!Array.isArray(availableHotels) || availableHotels.length === 0) {
        this.logger.warn(`[WARN] No hotels available for route ${routeId}`);
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
 this.logger.debug(` Route ${routeId}: 1 hotel - "${hotel.hotelName}" (${hotel.price}) assigned to ALL groups`);
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

 this.logger.debug(` Route ${routeId}: ${numHotels} hotels - Distributed across groups by price order`);
        sortedHotels.forEach((h, i) => {
          const key = `${routeId}-${h.hotelCode || h.hotelName}`;
          let groupType = 1;
          if (numHotels <= 4) {
            groupType = Math.min(i + 1, 4);
          } else {
            groupType = Math.floor((i / numHotels) * 4) + 1;
            groupType = Math.min(groupType, 4);
          }
 // this.logger.debug(` "${h.hotelName}" (${h.price}) -> Group ${groupType}`);
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
        this.logger.warn(`[WARN] Provider/system failure for route ${routeId} - skipping placeholder row. See previous logs for error.`);
          continue;
        }
        if (!Array.isArray(availableHotels) || availableHotels.length === 0) {
 this.logger.debug(` Tier ${groupType}, Route ${routeId}: No hotels available`);
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
        const totalPrice = this.money(
          tieredHotels.reduce(
            (sum, h) => sum + this.applyInvisibleHotelMargin(Number(h.price || 0), h),
            0,
          ),
        );
        packages.push({
          groupType: groupType,
          label: labels[tier],
          hotels: tieredHotels,
        });
        this.logger.log(`Group ${groupType} (${labels[tier]}): ${tieredHotels.length} hotels total, INR ${totalPrice} combined`);
      } else {
 this.logger.log(` Group ${groupType} (${labels[tier]}): No hotels found for any route`);
      }
    }

 this.logger.log(` Generated ${packages.length} price tier packages\n`);
    return packages;
  }

 /**
   * Build the response DTO
 */
  private async buildHotelDetailsResponse(
    quoteId: string,
    planId: number,
    packages: RecommendationPackage[],
    hotelsByRoute: Map<number, HotelSearchResult[]>,
    restrictedHotelsByRoute: Map<number, HotelSearchResult[]>,
    routes: any[],
    noOfNights: number,
    allAvailabilityPackages: Array<{ groupType: number; hotels: any[] }> = packages,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      select: {
        hotel_rates_visibility: true,
        trip_start_date_and_time: true,
      },
    });

    const globalSettings = await this.prisma.dvi_global_settings.findFirst({
      where: { deleted: 0, status: 1 },
      orderBy: { global_settings_ID: 'asc' },
      select: { hotel_margin: true },
    });
    const globalHotelMargin = Number((globalSettings as any)?.hotel_margin || 0);

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
      const totalAmount = pkg.complete && pkg.totalPrice !== null
        ? this.money(pkg.totalPrice)
        : null;
      return {
        groupType: pkg.groupType,
        label: pkg.label,
        totalAmount,
        partialTotal: this.money(pkg.partialTotal || 0),
        targetAmount: pkg.targetPrice,
        complete: pkg.complete,
        diversityScore: pkg.diversityScore,
        repeatedAcrossGroupsHotelIds: pkg.repeatedAcrossGroupsHotelIds,
        sameOptionAcrossGroups: pkg.sameOptionAcrossGroups,
        duplicateWithinPackageHotelIds: pkg.duplicateWithinPackageHotelIds,
        repeatedFromGroups: pkg.repeatedFromGroups,
        stayResults: pkg.stayResults.map((stay) => ({
          stayKey: stay.stayKey,
          parentRouteId: stay.parentRouteId,
          routeIds: stay.routeIds,
          destination: stay.destination,
          checkInDate: stay.checkInDate,
          checkOutDate: stay.checkOutDate,
          nights: stay.nights,
          state: stay.state,
          reason: stay.reason,
          totalPrice: stay.totalPrice,
        })),
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
        hotel_required: true,
        hotel_check_in_date: true,
        actual_guest_arrival_at: true,
        hotel_check_out_date: true,
        early_checkin: true,
        early_checkin_extra_payment_applicable: true,
        early_checkin_payment_status: true,
        early_checkin_note: true,
        hotel_code: true,
        hotel_provider: true,
        selected_rate_option_id: true,
        selected_price_per_night: true,
        selected_total_price: true,
        selected_currency: true,
        selected_price_snapshot: true,
        requires_price_reacceptance: true,
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
        d,
      ])
    );

 // The details endpoint returns live supplier/package rows, so those rows
 // do not carry the policy columns themselves. Join the saved early-arrival
 // decision (or its previous-night marker) by route and recommendation.
    const earlyArrivalMap = new Map<string, any>();
    for (const detail of hotelDetailsInDb as any[]) {
      const routeId = Number(detail.itinerary_route_id || 0);
      const groupType = Number(detail.group_type || 0);
      if (!routeId || !groupType) continue;
      const isPreviousNightMarker = Number(detail.hotel_required || 0) === 2 && Number(detail.hotel_id || 0) === 0;
      const hasStructuredMetadata = Number(detail.early_checkin || 0) === 1;
      if (isPreviousNightMarker || hasStructuredMetadata) {
        earlyArrivalMap.set(`${routeId}-${groupType}`, detail);
      }
    }

    const toDateOnly = (value: unknown): string | null => {
      if (!value) return null;
      const parsed = value instanceof Date ? value : new Date(value as any);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
    };

    const toIsoDateTime = (value: unknown): string | null => {
      if (!value) return null;
      const parsed = value instanceof Date ? value : new Date(value as any);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    };

    const addUtcDays = (dateOnly: string, days: number): string => {
      const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
      parsed.setUTCDate(parsed.getUTCDate() + days);
      return parsed.toISOString().slice(0, 10);
    };

    const getRouteStartTime = (route: any): string => {
      const raw = route?.route_start_time;
      if (raw instanceof Date) return raw.toISOString().slice(11, 19);
      const text = String(raw || '').trim();
      const match = text.match(/(?:T|\s)(\d{2}:\d{2}(?::\d{2})?)/);
      return match?.[1]?.length === 5 ? `${match[1]}:00` : match?.[1] || '00:00:00';
    };

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
      const tboCode = String((hm as any).tbo_hotel_code || '').trim();
      const resavenueCode = String((hm as any).resavenue_hotel_code || '').trim();
      const hobseCode = String((hm as any).hotel_code || '').trim();
      const hotelId = Number((hm as any).hotel_id || 0);

      // The provider code is not the canonical dvi_hotel.hotel_id. Keep this
      // mapping even when coordinates are missing so live supplier rows can
      // still be selected and persisted with the canonical hotel identity.
      if (tboCode) hotelMasterByProviderCode.set(`tbo|${tboCode}`, hm);
      if (resavenueCode) hotelMasterByProviderCode.set(`resavenue|${resavenueCode}`, hm);
      if (hobseCode) hotelMasterByProviderCode.set(`hobse|${hobseCode}`, hm);
      if (hotelId > 0) hotelMasterByProviderCode.set(`axisrooms|${hotelId}`, hm);
      if (hotelId > 0) hotelMasterByProviderCode.set(`staah|${hotelId}`, hm);

      const lat = Number((hm as any).hotel_latitude ?? 0);
      const lon = Number((hm as any).hotel_longitude ?? 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) {
        continue;
      }

      if (tboCode) hotelCoordsByProviderCode.set(`tbo|${tboCode}`, { lat, lon });
      if (resavenueCode) hotelCoordsByProviderCode.set(`resavenue|${resavenueCode}`, { lat, lon });
      if (hobseCode) hotelCoordsByProviderCode.set(`hobse|${hobseCode}`, { lat, lon });
      if (hotelId > 0) hotelCoordsByProviderCode.set(`axisrooms|${hotelId}`, { lat, lon });
      if (hotelId > 0) hotelCoordsByProviderCode.set(`staah|${hotelId}`, { lat, lon });
    }

    const resolveCanonicalHotelId = (hotel: any, masterMap = hotelMasterByProviderCode): number => {
      const explicitId = Number(hotel?.canonicalHotelId || 0);
      if (Number.isFinite(explicitId) && explicitId > 0) return explicitId;

      const provider = String(hotel?.provider || 'tbo').trim().toLowerCase();
      const providerCode = String(hotel?.hotelCode || '').trim();
      const mappedId = Number(masterMap.get(`${provider}|${providerCode}`)?.hotel_id || 0);
      if (Number.isFinite(mappedId) && mappedId > 0) return mappedId;

      // AxisRooms/STAAH/offline rows already use the canonical ID as their
      // hotelId. A TBO code must never be persisted as dvi_hotel.hotel_id.
      const hotelId = Number(hotel?.hotelId || 0);
      return provider === 'tbo' ? 0 : (Number.isFinite(hotelId) && hotelId > 0 ? hotelId : 0);
    };

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
    const selectionRowsByRouteAndGroup = new Map<string, any[]>();
    for (const detail of hotelDetailsInDb as any[]) {
      const routeId = Number(detail?.itinerary_route_id || 0);
      const groupType = Number(detail?.group_type || 0);
      if (routeId <= 0 || groupType <= 0) continue;
      const canonicalHotelId = Number(detail?.hotel_id || 0);
      const hotelCode = String(detail?.hotel_code || '').trim();
      if (canonicalHotelId <= 0 && !hotelCode) continue;
      const key = `${routeId}-${groupType}`;
      const existing = selectionRowsByRouteAndGroup.get(key) || [];
      existing.push(detail);
      selectionRowsByRouteAndGroup.set(key, existing);
    }

    const decorateLiveSelection = (row: any, selection: any): any => {
      const snapshot = parseHotelSelectionSnapshot(selection);
      const selectionOrigin = selectionOriginFromRow(selection);
      return {
        ...row,
        isSelected: true,
        selectionOrigin,
        selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
        itineraryPlanHotelDetailsId:
          Number(selection.itinerary_plan_hotel_details_ID || 0) ||
          row.itineraryPlanHotelDetailsId,
        selectedRateOptionId:
          selection.selected_rate_option_id || row.rateOptionId || row.searchReference,
        selectedPricePerNight: selection.selected_price_per_night,
        selectedTotalPrice: selection.selected_total_price,
        selectedCurrency: selection.selected_currency,
        requiresPriceReacceptance: Boolean(selection.requires_price_reacceptance),
        selectedPriceSnapshot: selection.selected_price_snapshot || null,
        selectionStatus: 'AVAILABLE',
        selection: {
          ...hotelDisplaySnapshot({ ...selection, ...snapshot }),
          status: 'AVAILABLE',
          selectionOrigin,
          selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
        },
      };
    };

    const cleanIdentity = (value: unknown): string =>
      String(value ?? '').trim().toLowerCase();

    const normalizeMealIdentity = (value: unknown): string => {
      const normalized = cleanIdentity(value).replace(/[^a-z]/g, '');
      if (!normalized) return '';
      if (['cp', 'continentalplan', 'breakfast'].includes(normalized)) return 'cp';
      if (['ep', 'europeanplan', 'roomonly'].includes(normalized)) return 'ep';
      if (['map', 'modifiedamericanplan'].includes(normalized)) return 'map';
      if (['ap', 'americanplan', 'fullboard'].includes(normalized)) return 'ap';
      return normalized;
    };

    const fallbackSelectionMatches = (selection: any, row: any): boolean => {
      const snapshot = parseHotelSelectionSnapshot(selection);
      const selectionProvider = cleanIdentity(snapshot.provider || selection?.hotel_provider);
      const rowProvider = cleanIdentity(row?.provider);
      if (selectionProvider && rowProvider && selectionProvider !== rowProvider) return false;

      const selectionHotelCode = cleanIdentity(snapshot.hotelCode || selection?.hotel_code);
      const rowHotelCode = cleanIdentity(row?.hotelCode || row?.providerHotelCode);
      if (selectionHotelCode && rowHotelCode && selectionHotelCode !== rowHotelCode) return false;

      const selectionRoomType = cleanIdentity(snapshot.roomType || selection?.room_type);
      const rowRoomType = cleanIdentity(row?.roomType);
      if (selectionRoomType && rowRoomType && selectionRoomType !== rowRoomType) return false;

      const selectionMealPlan = normalizeMealIdentity(snapshot.mealPlan || selection?.meal_plan);
      const rowMealPlan = normalizeMealIdentity(row?.mealPlan);
      if (selectionMealPlan && rowMealPlan && selectionMealPlan !== rowMealPlan) return false;

      const selectionSearchReference = cleanIdentity(snapshot.searchReference || snapshot.bookingCode || selection?.selected_rate_option_id);
      const rowSearchReference = cleanIdentity(row?.searchReference || row?.bookingCode);
      if (selectionSearchReference && rowSearchReference) {
        return selectionSearchReference === rowSearchReference;
      }

      return false;
    };

    for (const pkg of allAvailabilityPackages) {
      for (const hotel of pkg.hotels) {
 // Find the route using the routeId attached to the hotel
        const route = routes.find((r: any) => r.itinerary_route_ID === hotel.routeId);
        if (!route) {
 this.logger.warn(` Route ${hotel.routeId} not found for hotel ${hotel.hotelName}`);
          continue;
        }

        const routeIndex = routes.indexOf(route);

 // Use next_visiting_location (where you're staying) for destination display
        const destination = (route as any).next_visiting_location || (route as any).location_name || '';

 // Use actual hotel name from TBO API response
        const displayHotelName = hotel.hotelName;

        const hotelId = resolveCanonicalHotelId(hotel);
        const routeId = (route as any).itinerary_route_ID;
        const dateLabel = new Date((route as any).itinerary_route_date).toISOString().split('T')[0];

 // Lookup hotel details ID and voucher status (only for TBO numeric IDs)
        const lookupKey = hotelId > 0 ? `${routeId}-${hotelId}-${pkg.groupType}` : '';
        const hotelDetails = lookupKey ? detailsMap.get(lookupKey) : undefined;
        const hotelDetailsId = Number((hotelDetails as any)?.itinerary_plan_hotel_details_ID || 0) || undefined;
        const voucherCancelled = hotelDetailsId ? (voucherStatusMap.get(hotelDetailsId) || false) : false;

        const earlyArrival = earlyArrivalMap.get(`${routeId}-${pkg.groupType}`);
        const earlyCheckIn = Boolean(earlyArrival);
        const previousDayDate = addUtcDays(dateLabel, -1);
        const fallbackActualArrivalAt = new Date(
          `${dateLabel}T${getRouteStartTime(route)}.000Z`,
        ).toISOString();
        const hotelCheckInDate = earlyCheckIn
          ? toDateOnly(earlyArrival?.hotel_check_in_date) || previousDayDate
          : null;
        const actualGuestArrivalAt = earlyCheckIn
          ? toIsoDateTime(earlyArrival?.actual_guest_arrival_at) || fallbackActualArrivalAt
          : null;
        const checkOutDate = earlyCheckIn
          ? toDateOnly(earlyArrival?.hotel_check_out_date) || addUtcDays(dateLabel, 1)
          : null;
        const earlyCheckInExtraPaymentApplicable = earlyCheckIn && (
          Number(earlyArrival?.early_checkin_extra_payment_applicable || 0) === 1 ||
          Number(earlyArrival?.hotel_required || 0) === 2
        );
        const earlyCheckInPaymentStatus = earlyCheckIn
          ? String(earlyArrival?.early_checkin_payment_status || 'EXTRA_PAYMENT_APPLICABLE')
          : null;
        const hotelierEarlyCheckInNote = earlyCheckIn
          ? String(earlyArrival?.early_checkin_note || '').trim() ||
            'Guest has opted for early morning check-in with extra payment. Room to be blocked from the previous night, with actual guest arrival/check-in on the next day early morning.'
          : null;

        let hotelDistance: string | null = null;
        const routeLocationId = Number((route as any).location_id || 0);
        const routeCoords = routeDestinationCoordsByLocationId.get(routeLocationId);
        const providerCodeKey = `${String(hotel.provider || 'tbo').trim().toLowerCase()}|${String(hotel.hotelCode || '').trim()}`;
        const hotelCoords = hotelCoordsByProviderCode.get(providerCodeKey);
        if (routeCoords && hotelCoords) {
          try {
            const distanceKm = haversineKm(
              routeCoords.lat,
              routeCoords.lon,
              hotelCoords.lat,
              hotelCoords.lon,
            );
            if (Number.isFinite(distanceKm) && distanceKm > 0) {
              hotelDistance = `${distanceKm.toFixed(2)} KM`;
            }
          } catch {
            hotelDistance = null;
          }
        }

        const pricedHotel = this.enrichHotelWithMasterMargin(
          hotel,
          hotelMasterByProviderCode,
          globalHotelMargin,
        );
        const baseHotelCost = Number(pricedHotel.price || 0);
        const marginPercentage = this.getHotelMarginPercentage(pricedHotel, globalHotelMargin);
        const hotelMarginAmount = this.money((baseHotelCost * marginPercentage) / 100);
        const totalHotelCost = this.applyInvisibleHotelMargin(
          baseHotelCost,
          pricedHotel,
          globalHotelMargin,
        );
        const billableHotelCost = earlyCheckInExtraPaymentApplicable
          ? this.money(totalHotelCost * 2)
          : totalHotelCost;
        const normalizedProvider = String(hotel.provider || 'tbo').trim().toLowerCase();
        const rawSearchReference = String(hotel.searchReference || '').trim();
        const parsedStaahReference = this.parseStaahSearchReference(
          rawSearchReference || (hotel as any).bookingCode || '',
        );
        const rawBookingCode =
          normalizedProvider === 'tbo'
            ? String(hotel.searchReference || hotel.roomTypes?.[0]?.roomCode || (hotel as any).bookingCode || '').trim()
            : normalizedProvider === 'staah'
              ? String(rawSearchReference || (hotel as any).bookingCode || '').trim()
              : String((hotel as any).bookingCode || hotel.searchReference || hotel.hotelCode || '').trim();
        const rawHotelCode = String(hotel.hotelCode || '').trim();
        const isNoHotelsAvailable =
          String(hotel.hotelName || '').trim().toLowerCase() === 'no hotels available' ||
          rawHotelCode === '0';
        const hasSupplierHotel =
          !isNoHotelsAvailable &&
          Boolean(rawHotelCode) &&
          rawHotelCode !== '0' &&
          Number.isFinite(baseHotelCost) &&
          baseHotelCost > 0;
        const hasLiveBookingCode =
          normalizedProvider !== 'tbo' || rawBookingCode.includes('!TB!');
        const isPrebookReady = hasSupplierHotel && hasLiveBookingCode;

        let hotelRow: ItineraryHotelRowDto & Record<string, any> = {
          groupType: pkg.groupType,
          itineraryRouteId: routeId,
          routeIds: Array.isArray((hotel as any).routeIds) && (hotel as any).routeIds.length > 0
            ? (hotel as any).routeIds
            : [routeId],
          stayKey: (hotel as any).stayKey,
          day: `Day ${routeIndex + 1} | ${dateLabel}`,
          destination: destination,
          hotelId: hotelId,
          canonicalHotelId: hotelId || null,
          hotelCode: rawHotelCode,
          hotelName: displayHotelName,
          category: Number((hotel as any).normalizedCategory || '').toString().startsWith('STAR_')
            ? Number(String((hotel as any).normalizedCategory).slice(5))
            : (hotel.rating ? parseInt(String(hotel.rating), 10) : 0),
          roomType: hotel.roomType || '',
          mealPlan: hotel.mealPlan || '',
          baseHotelCost,
          hotelMarginPercentage: marginPercentage,
          hotelMarginAmount: this.money(hotelMarginAmount * (earlyCheckInExtraPaymentApplicable ? 2 : 1)),
          hotelMarginGstAmount: 0,
          hotelRoomGstAmount: 0,
          hotelMealPlanCost: 0,
          hotelMealPlanGstAmount: 0,
          totalHotelCost: billableHotelCost,
          totalHotelTaxAmount: 0,
          searchReference: rawSearchReference || undefined,
          bookingCode: isPrebookReady ? rawBookingCode : undefined,
          roomId:
            normalizedProvider === 'staah'
              ? parsedStaahReference?.roomId || undefined
              : undefined,
          rateId:
            normalizedProvider === 'staah'
              ? parsedStaahReference?.rateId || undefined
              : undefined,
          provider: hasSupplierHotel ? normalizedProvider : 'external',
          providerDisplayName: normalizedProvider === 'offline'
            ? 'Offline'
            : normalizedProvider === 'axisrooms'
              ? 'AxisRooms'
              : normalizedProvider === 'tbo'
                ? 'VSR'
                : undefined,
          providerHotelCode: (hotel as any).providerHotelCode || rawHotelCode,
          rateOptionId: (hotel as any).rateOptionId || rawSearchReference || rawBookingCode || undefined,
          rateOptions: Array.isArray((hotel as any).rateOptions) && (hotel as any).rateOptions.length > 0
            ? (hotel as any).rateOptions
            : [{
                rateOptionId: (hotel as any).rateOptionId || rawSearchReference || rawBookingCode || undefined,
                canonicalHotelId: hotelId || null,
                provider: normalizedProvider,
                providerDisplayName: normalizedProvider === 'offline' ? 'Offline' : normalizedProvider === 'axisrooms' ? 'AxisRooms' : normalizedProvider === 'tbo' ? 'VSR' : undefined,
                providerHotelCode: (hotel as any).providerHotelCode || rawHotelCode,
                roomId: (hotel as any).roomId,
                roomTypeId: (hotel as any).roomTypeId ?? (hotel.roomTypes?.[0] as any)?.roomTypeId ?? hotel.roomTypes?.[0]?.roomCode,
                roomType: hotel.roomType || hotel.roomTypes?.[0]?.roomName,
                mealPlan: hotel.mealPlan,
                bookingCode: rawBookingCode || undefined,
                searchReference: rawSearchReference || undefined,
                bookingMode: (hotel as any).bookingMode || (normalizedProvider === 'offline' ? 'MANUAL_APPROVAL' : 'LIVE_API'),
                priceSource: (hotel as any).priceSource || (normalizedProvider === 'offline' || normalizedProvider === 'axisrooms' ? 'DATABASE' : 'LIVE_API'),
                pricePerNight: Number((hotel as any).pricePerNight ?? totalHotelCost),
                totalStayPrice: Number((hotel as any).totalStayPrice ?? billableHotelCost),
                currency: hotel.currency || 'INR',
                isLiveRate: (hotel as any).isLiveRate ?? (normalizedProvider !== 'offline' && normalizedProvider !== 'axisrooms'),
                isLiveBookable: normalizedProvider !== 'offline' && hasSupplierHotel,
                isSelectable: true,
                requiresHotelApproval: normalizedProvider === 'offline',
                approvalStatus: normalizedProvider === 'offline' ? 'NOT_REQUESTED' : 'NOT_REQUIRED',
              }],
          bookingMode: (hotel as any).bookingMode || (normalizedProvider === 'offline' ? 'MANUAL_APPROVAL' : 'LIVE_API'),
          priceSource: (hotel as any).priceSource || (normalizedProvider === 'offline' || normalizedProvider === 'axisrooms' ? 'DATABASE' : 'LIVE_API'),
          priceLabel: (hotel as any).priceLabel,
          pricePerNight: Number((hotel as any).pricePerNight ?? totalHotelCost),
          totalStayPrice: Number((hotel as any).exactFullStayTotal ?? (hotel as any).totalStayPrice ?? billableHotelCost * Math.max(Number((hotel as any).numberOfNights || noOfNights || 1), 1)),
          numberOfNights: Number((hotel as any).numberOfNights || noOfNights || 1),
          nightlyRates: (hotel as any).nightlyRates,
          requiresHotelApproval: normalizedProvider === 'offline',
          isLiveRate: (hotel as any).isLiveRate ?? (normalizedProvider !== 'offline' && normalizedProvider !== 'axisrooms'),
          isLiveBookable: normalizedProvider !== 'offline' && hasSupplierHotel,
          isSelectable: true,
          approvalStatus: normalizedProvider === 'offline' ? 'NOT_REQUESTED' : 'NOT_REQUIRED',
          manualConfirmationStatus: normalizedProvider === 'offline' ? 'NOT_STARTED' : 'NOT_STARTED',
          isBookable: (hotel as any).isLiveBookable === false ? false : hasSupplierHotel,
          externalStay: !hasSupplierHotel,
          availabilityStatus: (hotel as any).availabilityStatus || (hasSupplierHotel ? 'AVAILABLE' : 'NO_SUPPLIER_AVAILABILITY'),
          availabilityState: (hotel as any).availabilityState || (hasSupplierHotel ? 'AVAILABLE' : 'UNAVAILABLE'),
          distanceKm: Number.isFinite(Number((hotel as any).distanceKm)) ? Number((hotel as any).distanceKm) : null,
          distanceStatus: (hotel as any).distanceStatus || 'UNKNOWN',
          distanceReference: (hotel as any).distanceReference || 'UNKNOWN',
          selectionReason: (hotel as any).availabilityReason || null,
          availabilityMessage: hasSupplierHotel
            ? null
            : 'No supplier hotel rooms are available for this city/date. Customer must arrange stay manually.',
          voucherCancelled: voucherCancelled,
          itineraryPlanHotelDetailsId: hotelDetailsId || 0,
          date: dateLabel,
          hotelCheckInDate,
          actualGuestArrivalAt,
          checkOutDate,
          earlyCheckIn,
          earlyCheckInExtraPaymentApplicable,
          earlyCheckInPaymentStatus,
          hotelierEarlyCheckInNote,
          previousDayBillingSynthetic: false,
          hotelDistance,
          inclusions: hotel.inclusions && hotel.inclusions.length > 0 ? hotel.inclusions : (hotel.facilities && hotel.facilities.length > 0 ? hotel.facilities : undefined),
          amenities: hotel.amenities && hotel.amenities.length > 0 ? hotel.amenities : undefined,
          facilities: hotel.facilities && hotel.facilities.length > 0 ? hotel.facilities : undefined,
          rateConditions: hotel.rateConditions && hotel.rateConditions.length > 0 ? hotel.rateConditions : undefined,
          cancellationPolicy: Array.isArray((hotel as any).cancellationPolicy)
            ? (hotel as any).cancellationPolicy
            : (typeof (hotel as any).cancellationPolicy === 'string' && String((hotel as any).cancellationPolicy).trim()
              ? [String((hotel as any).cancellationPolicy).trim()]
              : undefined),
          supplementSummary: hotel.supplementSummary,
        };

        const candidateSelections = selectionRowsByRouteAndGroup.get(`${routeId}-${pkg.groupType}`) || [];
        const matchedSelection = candidateSelections.find((selection) =>
          optionMatchesSelection(selection, hotelRow) ||
          fallbackSelectionMatches(selection, hotelRow) ||
          (Array.isArray(hotelRow.rateOptions) &&
            hotelRow.rateOptions.some((option: any) =>
              optionMatchesSelection(selection, { ...hotelRow, ...option }) ||
              fallbackSelectionMatches(selection, { ...hotelRow, ...option }),
            )),
        );
        if (matchedSelection) {
          hotelRow = decorateLiveSelection(hotelRow, matchedSelection);
        }

        hotelRows.push(hotelRow);

 // Log HOBSE hotel codes for debugging
        if (hotel.provider === 'HOBSE') {
 this.logger.debug(` HOBSE Hotel Response: hotelCode="${hotel.hotelCode}", provider="${hotel.provider}"`);
        }
      }
    }

 // Preserve every unavailable logical stay in the response. An incomplete
 // package must not disappear just because one stay has no eligible option.
    for (const pkg of packages) {
      for (const stay of pkg.stayResults || []) {
        if (stay.state !== 'UNAVAILABLE') continue;
        const alreadyRendered = hotelRows.some((row: any) => row.groupType === pkg.groupType && row.stayKey === stay.stayKey);
        if (alreadyRendered) continue;
        const route = routes.find((candidate: any) => Number(candidate?.itinerary_route_ID || 0) === Number(stay.parentRouteId));
        if (!route) continue;
        const dateLabel = new Date(route.itinerary_route_date).toISOString().slice(0, 10);
        hotelRows.push({
          groupType: pkg.groupType,
          itineraryRouteId: stay.parentRouteId,
          routeIds: stay.routeIds,
          stayKey: stay.stayKey,
          day: `Day ${routes.indexOf(route) + 1} | ${dateLabel}`,
          destination: stay.destination,
          hotelId: 0,
          canonicalHotelId: null,
          hotelCode: '',
          hotelName: 'No hotel available',
          category: 0,
          roomType: '',
          mealPlan: '',
          totalHotelCost: 0,
          totalHotelTaxAmount: 0,
          provider: 'external',
          isBookable: false,
          isSelectable: false,
          externalStay: true,
          availabilityStatus: 'NO_SUPPLIER_AVAILABILITY',
          availabilityState: 'UNAVAILABLE',
          availabilityMessage: stay.reason || 'No eligible hotel is available for this stay.',
          selectionStatus: 'UNAVAILABLE',
          selectionReason: stay.reason || null,
          date: dateLabel,
          hotelCheckInDate: stay.checkInDate,
          checkOutDate: stay.checkOutDate,
          itineraryPlanHotelDetailsId: 0,
        } as any);
      }
    }

 // Override only matching routes with confirmed STAAH booking rows
    if (confirmedStaahByRouteId.size > 0) {
      for (let i = 0; i < hotelRows.length; i++) {
        const row: any = hotelRows[i];
        const routeId = Number(row?.itineraryRouteId || 0);
        const confirmedRow: any = confirmedStaahByRouteId.get(routeId);
        if (!confirmedRow) {
 console.log('[STAAH_OVERRIDE_MISSED]', {
            routeId,
            hotelId: row.hotelId,
          });
          continue;
        }

        const apiResponse: any = (confirmedRow as any).api_response || {};
        const isStaahVoucherCancelled = !!apiResponse?.cancellation;
        const reservation: any =
          apiResponse?.confirm?.request?.reservations?.reservation?.[0] || {};
        const reservationRoom: any = reservation?.room?.[0] || {};
        const reservationPrice: any = reservationRoom?.price?.[0] || {};

        // The confirmation row stores the provider property code, not the
        // canonical dvi_hotel.hotel_id. Preserve the canonical identity from
        // the already-normalized row and expose the STAAH code separately.
        const canonicalHotelId = Number(row.hotelId || row.canonicalHotelId || 0);
        const safeCheckIn = (confirmedRow as any).check_in_date
          ? new Date((confirmedRow as any).check_in_date).toISOString().split('T')[0]
          : row.date;

        const confirmedBookingCode = String((confirmedRow as any).booking_code || '').trim();
        const confirmedSearchReference =
          confirmedBookingCode.startsWith('STAAH-')
            ? confirmedBookingCode
            : '';
        const confirmedReferenceParts = this.parseStaahSearchReference(confirmedSearchReference);

        hotelRows[i] = {
          ...row,
          provider: 'staah',
          itineraryRouteId: routeId,
          hotelId: Number.isFinite(canonicalHotelId) ? canonicalHotelId : 0,
          canonicalHotelId: Number.isFinite(canonicalHotelId) ? canonicalHotelId : null,
          hotelCode: String((confirmedRow as any).staah_hotel_code || row.hotelCode || '').trim(),
          hotelName: String(reservation?.propertyname || 'STAAH Hotel'),
          roomType: String(reservationRoom?.room_name || ''),
          mealPlan: String(reservationPrice?.rate_name || ''),
          totalHotelCost: Number((confirmedRow as any).net_amount || 0),
          totalHotelTaxAmount: Number(reservation?.totaltax || 0),
          bookingCode: confirmedBookingCode || undefined,
          searchReference: confirmedSearchReference || undefined,
          roomId: confirmedReferenceParts?.roomId || undefined,
          rateId: confirmedReferenceParts?.rateId || undefined,
          voucherCancelled: isStaahVoucherCancelled,
          voucherStatus: isStaahVoucherCancelled ? 'cancelled' : 'active',
          itineraryPlanHotelDetailsId: 0,
          date: safeCheckIn,
          checkInDate: (confirmedRow as any).check_in_date || undefined,
          checkOutDate: (confirmedRow as any).check_out_date || undefined,
          numberOfRooms: Number((confirmedRow as any).number_of_rooms || 0),
          guestNationality: String((confirmedRow as any).guest_nationality || ''),
          totalGuests: Number((confirmedRow as any).total_guests || 0),
          isConfirmedBooking: true,
          voucherAvailable: true,
        } as any;

 this.logger.log(
          `[HOTEL_DETAILS_CONFIRMED_STAAH_OVERRIDE] quoteId=${quoteId} planId=${planId} routeId=${routeId} staahHotelCode=${String((confirmedRow as any).staah_hotel_code || '')} bookingReference=${String((confirmedRow as any).staah_booking_reference || '')}`,
        );
 console.log('[STAAH_OVERRIDE_APPLIED]', {
          routeId,
          staahHotelCode: confirmedRow.staah_hotel_code,
          bookingReference: confirmedRow.staah_booking_reference,
          voucherCancelled: isStaahVoucherCancelled,
        });
      }
    }

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

        restrictedHotelRows.push({
          groupType: this.getGroupTypeFromPrice(Number(hotel.price || 0), allPrices),
          itineraryRouteId: routeId,
          day: `Day ${routeIndex + 1} | ${dateLabel}`,
          destination,
          hotelId: resolveCanonicalHotelId(hotel),
          hotelName: String(hotel.hotelName || 'Hotel'),
          category: hotel.rating ? parseInt(String(hotel.rating), 10) : 0,
          roomType: String(hotel.roomType || ''),
          mealPlan: String(hotel.mealPlan || ''),
          baseHotelCost: Number(hotel.price || 0),
          hotelMarginPercentage: this.getHotelMarginPercentage(
            this.enrichHotelWithMasterMargin(hotel, hotelMasterByProviderCode, globalHotelMargin),
            globalHotelMargin,
          ),
          hotelMarginAmount: this.money(
            (Number(hotel.price || 0) * this.getHotelMarginPercentage(
              this.enrichHotelWithMasterMargin(hotel, hotelMasterByProviderCode, globalHotelMargin),
              globalHotelMargin,
            )) / 100,
          ),
          hotelMarginGstAmount: 0,
          hotelRoomGstAmount: 0,
          hotelMealPlanCost: 0,
          hotelMealPlanGstAmount: 0,
          hotelCode: String(hotel.hotelCode || '').trim(),
          totalHotelCost: this.applyInvisibleHotelMargin(
            Number(hotel.price || 0),
            this.enrichHotelWithMasterMargin(hotel, hotelMasterByProviderCode, globalHotelMargin),
            globalHotelMargin,
          ),
          totalHotelTaxAmount: 0,
          searchReference: String(hotel.searchReference || '').trim() || undefined,
          bookingCode: undefined,
          provider: String(hotel.provider || 'staah').trim().toLowerCase(),
          isBookable: false,
          externalStay: false,
          availabilityStatus: 'NOT_BOOKABLE',
          availabilityMessage: String((hotel as any).availabilityMessage || '').trim() || 'Restricted for the selected stay.',
          availableAgainFrom: String((hotel as any).availableAgainFrom || '').trim() || null,
          voucherCancelled: false,
          itineraryPlanHotelDetailsId: 0,
          date: dateLabel,
          hotelDistance,
          inclusions: hotel.inclusions && hotel.inclusions.length > 0 ? hotel.inclusions : undefined,
          amenities: hotel.amenities && hotel.amenities.length > 0 ? hotel.amenities : undefined,
          facilities: hotel.facilities && hotel.facilities.length > 0 ? hotel.facilities : undefined,
          rateConditions: hotel.rateConditions && hotel.rateConditions.length > 0 ? hotel.rateConditions : undefined,
          cancellationPolicy: Array.isArray(hotel.cancellationPolicy)
            ? hotel.cancellationPolicy
            : undefined,
          supplementSummary: hotel.supplementSummary,
        });
      });
    });

    const supplierRouteGroupKeys = new Set(
      hotelRows
        .filter((row) => row.isBookable !== false)
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
        !String(row.hotelName || '').toLowerCase().includes('previously selected hotel');

      return !(hasSupplierSibling && isStaleZeroCostExternal);
    });

    for (const [routeGroupKey, selections] of selectionRowsByRouteAndGroup.entries()) {
      const [routeIdRaw, groupTypeRaw] = routeGroupKey.split('-');
      const routeId = Number(routeIdRaw || 0);
      const groupType = Number(groupTypeRaw || 0);
      if (routeId <= 0 || groupType <= 0) continue;

      for (const selection of selections) {
        for (let index = 0; index < cleanedHotelRows.length; index++) {
          const row: any = cleanedHotelRows[index];
          if (Number(row?.itineraryRouteId || 0) !== routeId) continue;
          if (Number(row?.groupType || 0) !== groupType) continue;
          const matched =
            optionMatchesSelection(selection, row) ||
            fallbackSelectionMatches(selection, row) ||
            (Array.isArray(row?.rateOptions) &&
              row.rateOptions.some((option: any) =>
                optionMatchesSelection(selection, { ...row, ...option }) ||
                fallbackSelectionMatches(selection, { ...row, ...option }),
              ));
          if (!matched) continue;
          cleanedHotelRows[index] = decorateLiveSelection(row, selection);
        }
      }
    }

    const supplierHotelRows = cleanedHotelRows.filter((row) => row.isBookable !== false);

    const searchableRouteIds = routes
      .filter((route: any) => route?.hotelRequired !== false && route?.hotel_required !== false && !route?.isDeparture && !route?.isTransit && !route?.isActivityOnly)
      .map((route: any) => Number(route.itinerary_route_ID));

    const totalSearchRoutes = searchableRouteIds.length;
    const emptySearchRoutes = searchableRouteIds.filter((routeId) => {
      const routeHotels = hotelsByRoute.get(routeId) || [];
      return routeHotels.length === 0;
    }).length;

    const hasSupplierHotels = supplierHotelRows.length > 0;
    const availabilityMessage = hasSupplierHotels
        ? 'Live supplier hotels are available for the current itinerary selection.'
        : 'No live hotel options are available for one or more stays. Use Check Availability again after adjusting the itinerary.';

    return {
      quoteId,
      planId,
      showHotelMargins: this.shouldShowHotelMargins(),
      hotelRatesVisible,
      hotelTabs,
      recommendationAlgorithm: this.recommendationAlgorithm(),
      recommendationGeneration: this.recommendationGeneration(),
      hotels: cleanedHotelRows,
      restrictedHotels: restrictedHotelRows,
      totalRoomCount: cleanedHotelRows.length,
      hotelAvailability: {
        hasSupplierHotels,
        supplierHotelCount: supplierHotelRows.length,
        placeholderRowCount: 0,
        totalSearchRoutes,
        emptySearchRoutes,
        isPlaceholderOnly: false,
        message: availabilityMessage,
        recommendationAlgorithm: this.recommendationAlgorithm(),
        recommendationGeneration: this.recommendationGeneration(),
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
 this.logger.log(`\n FRESH ROOM DETAILS FROM TBO: Fetching live data for quote: ${quoteId}`);
    if (filterRouteId) {
 this.logger.log(` Filtering to route ID: ${filterRouteId}`);
    }

 // CHECK CACHE FIRST (per-route caching)
    const cachedResult = this.getCachedRoomDetails(quoteId, filterRouteId);
    if (cachedResult) {
      return cachedResult;
    }

 // Step 1: Get itinerary plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`[WARN] Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    const planId = plan.itinerary_plan_ID;
 this.logger.log(` Found plan ID: ${planId}`);

    const globalSettings = await this.prisma.dvi_global_settings.findFirst({
      where: { deleted: 0, status: 1 },
      orderBy: { global_settings_ID: 'asc' },
      select: { hotel_margin: true },
    });
    const globalHotelMargin = Number((globalSettings as any)?.hotel_margin || 0);

 // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    if (routes.length === 0) {
      this.logger.warn(`[WARN] No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

    const noOfNights = Number((plan as any).no_of_nights || 0);
 this.logger.log(` Plan has ${noOfNights} nights`);

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
 this.logger.warn(` Route ID ${filterRouteId} not found`);
        throw new BadRequestException(`Route ID ${filterRouteId} not found in this itinerary`);
      }
 this.logger.log(` Optimized: Fetching hotels for 1 route only (filtered)`);
    }

    const guestNationality = await this.resolveGuestNationality(plan);
    const fetchMode = this.resolveHotelFetchMode();
    let hotelsByRoute = new Map<number, HotelSearchResult[] | null>();

    if (fetchMode.axisOnly) {
 this.logger.warn(
        'HOTEL_FETCH_AXIS_ONLY enabled: fetching Offline + AxisRooms only; skipping TBO/VSR, STAAH, ResAvenue and HOBSE.',
      );

      routesToProcess.forEach((route) => {
        const routeId = Number((route as any).itinerary_route_ID || 0);
        if (routeId > 0) {
          hotelsByRoute.set(routeId, []);
        }
      });

      const offlineHotelsByRoute = await this.offlineHotelCatalogService.fetchOfflineHotelsForRoutes(
        routesToProcess,
        noOfNights,
        guestNationality,
        planRoomCount2,
        planAdultCount2,
        planChildCount2,
        planChildAges2,
      );
      offlineHotelsByRoute.forEach((offlineHotels, routeId) => {
        const existing = hotelsByRoute.get(routeId) || [];
        hotelsByRoute.set(routeId, [...existing, ...offlineHotels]);
      });

      const axisroomsHotelsByRoute = await this.fetchAxisroomsHotelsForRoutes(
        routesToProcess,
        noOfNights,
        undefined,
        undefined,
        planRoomCount2,
      );
      axisroomsHotelsByRoute.forEach((axisroomsHotels, routeId) => {
        const existing = hotelsByRoute.get(routeId) || [];
        const hotelStrs = existing.map(h => `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`);
        const newHotels = axisroomsHotels.filter(h => !hotelStrs.includes(`${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`));
        hotelsByRoute.set(routeId, [...existing, ...newHotels]);
      });
    } else {
      hotelsByRoute = await this.fetchHotelsForRoutes(
        routesToProcess,
        noOfNights,
        guestNationality,
        planRoomCount2,
        planAdultCount2,
        planChildCount2,
        planChildAges2,
      );

 // Merge non-TBO providers (HOBSE, ResAvenue, AxisRooms) same logic as getHotelDetails
      const tboOnlyFetch = this.isTboOnlyFetchEnabled();
      if (!tboOnlyFetch) {
        const offlineHotelsByRoute = await this.offlineHotelCatalogService.fetchOfflineHotelsForRoutes(
          routesToProcess,
          noOfNights,
          guestNationality,
          planRoomCount2,
          planAdultCount2,
          planChildCount2,
          planChildAges2,
        );
        offlineHotelsByRoute.forEach((offlineHotels, routeId) => {
          const existing = hotelsByRoute.get(routeId) || [];
          const hotelKeys = new Set(
            existing.map((hotel) => `${String(hotel.hotelCode)}|${String(hotel.provider).toLowerCase()}`),
          );
          const newHotels = offlineHotels.filter(
            (hotel) => !hotelKeys.has(`${String(hotel.hotelCode)}|${String(hotel.provider).toLowerCase()}`),
          );
          hotelsByRoute.set(routeId, [...existing, ...newHotels]);
        });

        if (this.isHobseSearchEnabled()) {
          const hobseCityCodeMap = await this.batchMapDestinationsToHobseCityCodes(routesToProcess);
          const hobseHotelsByRoute = await this.fetchHobseHotelsForRoutes(routesToProcess, noOfNights, hobseCityCodeMap);
          hobseHotelsByRoute.forEach((hobseHotels, routeId) => {
            const existing = hotelsByRoute.get(routeId) || [];
            hotelsByRoute.set(routeId, [...existing, ...hobseHotels]);
          });
        } else {
          this.logger.warn('[WARN] HOBSE_SEARCH_ENABLED=0: skipping HOBSE hotel search results');
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
        const axisroomsHotelsByRoute = await this.fetchAxisroomsHotelsForRoutes(
          routesToProcess,
          noOfNights,
          undefined,
          undefined,
          planRoomCount2,
        );
        axisroomsHotelsByRoute.forEach((axisroomsHotels, routeId) => {
          const existing = hotelsByRoute.get(routeId) || [];
          const hotelStrs = existing.map(h => `${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`);
          const newHotels = axisroomsHotels.filter(h => !hotelStrs.includes(`${String(h.hotelCode)}|${String(h.provider).toLowerCase()}`));
          hotelsByRoute.set(routeId, [...existing, ...newHotels]);
        });
      }
    }

      if (!fetchMode.axisOnly) {
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
 this.logger.debug(` Skipping route ${routeId} (filter: ${filterRouteId})`);
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

 // Resolve hotel-specific margins for the room-details path as well. This
 // path must not bypass the same master -> global -> environment hierarchy.
    const roomMarginProviderCodeSet = new Set<string>();
    for (const { hotel } of routeHotelRows) {
      const provider = String((hotel as any)?.provider || 'tbo').trim().toLowerCase();
      const code = String((hotel as any)?.hotelCode || '').trim();
      if (provider && code) roomMarginProviderCodeSet.add(`${provider}|${code}`);
    }
    const roomMarginTboCodes = Array.from(roomMarginProviderCodeSet)
      .filter((key) => key.startsWith('tbo|'))
      .map((key) => key.slice('tbo|'.length));
    const roomMarginResavenueCodes = Array.from(roomMarginProviderCodeSet)
      .filter((key) => key.startsWith('resavenue|'))
      .map((key) => key.slice('resavenue|'.length));
    const roomMarginHobseCodes = Array.from(roomMarginProviderCodeSet)
      .filter((key) => key.startsWith('hobse|'))
      .map((key) => key.slice('hobse|'.length));
    const roomMarginAxisroomsIds = Array.from(roomMarginProviderCodeSet)
      .filter((key) => key.startsWith('axisrooms|'))
      .map((key) => Number(key.slice('axisrooms|'.length)))
      .filter((id) => Number.isFinite(id) && id > 0);
    const roomMarginStaahIds = Array.from(roomMarginProviderCodeSet)
      .filter((key) => key.startsWith('staah|'))
      .map((key) => Number(key.slice('staah|'.length)))
      .filter((id) => Number.isFinite(id) && id > 0);
    const roomMarginMasters = roomMarginProviderCodeSet.size
      ? await this.prisma.dvi_hotel.findMany({
          where: {
            OR: [
              ...(roomMarginTboCodes.length ? [{ tbo_hotel_code: { in: roomMarginTboCodes } }] : []),
              ...(roomMarginResavenueCodes.length ? [{ resavenue_hotel_code: { in: roomMarginResavenueCodes } }] : []),
              ...(roomMarginHobseCodes.length ? [{ hotel_code: { in: roomMarginHobseCodes } }] : []),
              ...(roomMarginAxisroomsIds.length ? [{ hotel_id: { in: roomMarginAxisroomsIds } }] : []),
              ...(roomMarginStaahIds.length ? [{ hotel_id: { in: roomMarginStaahIds } }] : []),
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
    const roomMarginByProviderCode = new Map<string, any>();
    for (const master of roomMarginMasters as any[]) {
      const tboCode = String((master as any).tbo_hotel_code || '').trim();
      const resavenueCode = String((master as any).resavenue_hotel_code || '').trim();
      const hobseCode = String((master as any).hotel_code || '').trim();
      const hotelId = Number((master as any).hotel_id || 0);
      if (tboCode) roomMarginByProviderCode.set(`tbo|${tboCode}`, master);
      if (resavenueCode) roomMarginByProviderCode.set(`resavenue|${resavenueCode}`, master);
      if (hobseCode) roomMarginByProviderCode.set(`hobse|${hobseCode}`, master);
      if (hotelId > 0) roomMarginByProviderCode.set(`axisrooms|${hotelId}`, master);
      if (hotelId > 0) roomMarginByProviderCode.set(`staah|${hotelId}`, master);
    }

 // Build room entries from fresh TBO data
    routeHotelRows.forEach(({ routeId, hotel }) => {
      const route = routes.find(r => (r as any).itinerary_route_ID === routeId);
      if (!route) return;

 // FIXED: Use actual room type from TBO, not groupType
        const firstRoomType = hotel.roomTypes?.[0];
        const actualRoomTypeId = firstRoomType?.roomTypeId || 1;
 // For non-TBO providers use hotel.roomType which matches hotel_details; for TBO use roomTypes[0].roomName
        const actualRoomTypeName = String(hotel.provider || 'tbo').toLowerCase() !== 'tbo'
          ? (hotel.roomType || firstRoomType?.roomName || 'Standard Room')
          : (firstRoomType?.roomName || hotel.roomType || 'Standard Room');
        const pricedHotel = this.enrichHotelWithMasterMargin(hotel, roomMarginByProviderCode, globalHotelMargin);
        const baseHotelCost = Number(pricedHotel.price || 0);
        const marginPercentage = this.getHotelMarginPercentage(pricedHotel, globalHotelMargin);
        const hotelMarginAmount = this.money((baseHotelCost * marginPercentage) / 100);
        const totalHotelCost = this.applyInvisibleHotelMargin(baseHotelCost, pricedHotel, globalHotelMargin);
        const roomProvider = String(hotel.provider || 'tbo').trim().toLowerCase();
        const roomProviderCode = String(hotel.hotelCode || '').trim();
        const mappedRoomHotelId = Number(
          (roomMarginByProviderCode.get(`${roomProvider}|${roomProviderCode}`) as any)?.hotel_id || 0,
        );
        const canonicalRoomHotelId = Number((hotel as any).canonicalHotelId || 0) ||
          mappedRoomHotelId ||
          (roomProvider === 'tbo' ? 0 : Number((hotel as any).hotelId || 0));

        roomDetailsList.push({
          itineraryPlanId: planId,
          itineraryRouteId: routeId,
          itineraryPlanHotelRoomDetailsId: roomDetailsId++,
          hotelId: canonicalRoomHotelId,
          hotelCode: String(hotel.hotelCode || '').trim(),
          hotelName: hotel.hotelName || 'Hotel',
          hotelCategory: this.getCategoryFromRating(hotel.category || hotel.rating),
 groupType: hotel.groupType || 1, // ADD: Include groupType (tier: 1-4)
 roomTypeId: actualRoomTypeId, // FIXED: Use actual TBO room type ID
 roomTypeName: actualRoomTypeName, // FIXED: Use actual TBO room type name
          roomId:
            String(hotel.provider || 'tbo').toLowerCase() === 'staah'
              ? 0
              : canonicalRoomHotelId,
          provider: roomProvider,
          canonicalHotelId: canonicalRoomHotelId || null,
          providerHotelCode: (hotel as any).providerHotelCode || String(hotel.hotelCode || '').trim(),
          providerDisplayName:
            String(hotel.provider || 'tbo').toLowerCase() === 'tbo'
              ? 'VSR'
              : (hotel as any).providerDisplayName || undefined,
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
          rateOptionId: (hotel as any).rateOptionId || hotel.searchReference || (hotel as any).bookingCode || undefined,
          rateOptions: (hotel as any).rateOptions || undefined,
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
          bookingMode: (hotel as any).bookingMode || (String(hotel.provider || '').toLowerCase() === 'offline' ? 'MANUAL_APPROVAL' : 'LIVE_API'),
          priceSource: (hotel as any).priceSource || (['offline', 'axisrooms'].includes(String(hotel.provider || '').toLowerCase()) ? 'DATABASE' : 'LIVE_API'),
          priceLabel: (hotel as any).priceLabel,
          isLiveRate: (hotel as any).isLiveRate ?? !['offline', 'axisrooms'].includes(String(hotel.provider || '').toLowerCase()),
          isLiveBookable: (hotel as any).isLiveBookable ?? String(hotel.provider || '').toLowerCase() !== 'offline',
          isSelectable: (hotel as any).isSelectable ?? true,
          requiresHotelApproval: (hotel as any).requiresHotelApproval ?? String(hotel.provider || '').toLowerCase() === 'offline',
          approvalStatus: (hotel as any).approvalStatus || (String(hotel.provider || '').toLowerCase() === 'offline' ? 'NOT_REQUESTED' : 'NOT_REQUIRED'),
          manualConfirmationStatus: (hotel as any).manualConfirmationStatus || 'NOT_STARTED',
          externalStay: (hotel as any).externalStay ?? false,
          availabilityStatus: (hotel as any).availabilityStatus || 'AVAILABLE',
          availabilityMessage: (hotel as any).availabilityMessage || null,
          availableAgainFrom: (hotel as any).availableAgainFrom || null,
        } as any);
    });

    const duration = Date.now() - startTime;
 this.logger.log(` FRESH ROOM DETAILS GENERATED`);
 this.logger.log(` Room Entries: ${roomDetailsList.length}`);
    if (filterRouteId) {
 this.logger.log(` Filter Applied: Route ID ${filterRouteId}`);
    } else {
 this.logger.log(` All Routes Included`);
    }
 this.logger.log(` Duration: ${duration}ms\n`);

    const result = {
      quoteId: (plan as any).itinerary_quote_ID ?? '',
      planId,
      rooms: roomDetailsList,
    };

 // CACHE THE RESULT for future requests
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
 this.logger.debug(` [CACHE EXPIRED] Removed stale room cache for ${cacheKey}`);
        return null;
      }
 this.logger.log(` [CACHE HIT] Using cached data for ${cacheKey}`);
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
 this.logger.log(` [CACHE SET] Cached data for ${cacheKey}`);
  }

  private getCachedHotelDetails(quoteId: string): ItineraryHotelDetailsResponseDto | null {
    const cached = this.hotelDetailsCache.get(quoteId);
    if (!cached) {
      return null;
    }

    if (this.isCacheExpired(cached.timestamp, ItineraryHotelDetailsTboService.HOTEL_DETAILS_CACHE_TTL_MS)) {
      this.hotelDetailsCache.delete(quoteId);
 this.logger.debug(` [CACHE EXPIRED] Removed stale hotel details cache for ${quoteId}`);
      return null;
    }

 this.logger.log(` [CACHE HIT] Hotel details from cache for ${quoteId}`);
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
 this.logger.log(` [CACHE SET] Hotel details cached for ${quoteId}`);
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
 this.logger.log(` [CACHE CLEARED] Removed cache for ${key}`);
    }
    this.offlineHotelCatalogService.clearCache?.();
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

