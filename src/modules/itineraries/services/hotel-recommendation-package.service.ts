import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
  type CanonicalHotelRatePlanCode,
} from '../../hotels/hotel-rate-plans';
import { HotelMealPlanPolicyService } from './hotel-meal-plan-policy.service';
import { hotelStayTotal } from '../utils/hotel-stay-pricing.util';

export type RecommendationAvailabilityState =
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'RESTRICTED'
  | 'STALE'
  | 'UNKNOWN'
  | 'OFFLINE_APPROVAL_REQUIRED';

export type RecommendationRoute = {
  itinerary_route_ID: number;
  itinerary_route_date: string | Date;
  location_name?: string | null;
  next_visiting_location?: string | null;
  location_id?: number | null;
  destinationId?: number | string | null;
  destination_id?: number | string | null;
  stayGroupId?: string | number | null;
  stay_group_id?: string | number | null;
  parentStayRouteId?: number | null;
  parent_stay_route_id?: number | null;
  checkInDate?: string | Date | null;
  checkOutDate?: string | Date | null;
  hotelCheckInDate?: string | Date | null;
  hotelCheckOutDate?: string | Date | null;
  hotelRequired?: boolean | number | null;
  hotel_required?: boolean | number | null;
  isDeparture?: boolean | null;
  isTransit?: boolean | null;
  isActivityOnly?: boolean | null;
  routeType?: string | null;
  route_type?: string | null;
  overnightRoute?: boolean | null;
  overnight_route?: boolean | null;
};

export type LogicalHotelStay = {
  stayKey: string;
  parentRouteId: number;
  routeIds: number[];
  destination: string;
  destinationId?: string | null;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
};

export type RecommendationHotel = HotelSearchResult & {
  routeId: number;
  routeIds: number[];
  stayKey: string;
  checkInDate?: string;
  checkOutDate?: string;
  numberOfNights?: number;
  exactFullStayTotal: number;
  canonicalMealPlan: CanonicalHotelRatePlanCode | null;
  availabilityState: RecommendationAvailabilityState;
  availabilityReason?: string;
  distanceStatus: 'WITHIN_RADIUS' | 'OUTSIDE_RADIUS' | 'UNKNOWN';
  distanceReference: 'HOTSPOT' | 'DESTINATION_CENTRE' | 'ROUTE_DESTINATION' | 'UNKNOWN';
  normalizedCategory: string;
  recommendationFallbackReason?: string;
};

export type RecommendationStayResult = {
  stayKey: string;
  parentRouteId: number;
  routeIds: number[];
  destination: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  state: 'SELECTED' | 'OFFLINE_FALLBACK' | 'UNAVAILABLE';
  hotel?: RecommendationHotel;
  totalPrice?: number;
  reason?: string;
  rejectedCandidates?: Array<{ optionKey: string; reason: string }>;
};

export type RecommendationPackage = {
  groupType: number;
  label: string;
  hotels: RecommendationHotel[];
  totalPrice: number | null;
  partialTotal: number;
  targetPrice: number | null;
  complete: boolean;
  distinctFromPrevious: boolean;
  diversityScore: number;
  repeatedHotelIds: string[];
  repeatedAcrossGroupsHotelIds: string[];
  sameOptionAcrossGroups: string[];
  duplicateWithinPackageHotelIds: string[];
  repeatedFromGroups: number[];
  fallbackReasons: string[];
  stayResults: RecommendationStayResult[];
};

export type RecommendationPackageInput = {
  routes: RecommendationRoute[];
  hotelsByRoute: Map<number, HotelSearchResult[] | null>;
  noOfNights?: number;
  preferredMealPlanCode?: string | null;
  preferredCategories?: number[];
  maxDistanceKm?: number;
  requireKnownDistance?: boolean;
  maxCandidatesPerStay?: number;
  maxCombinations?: number;
  beamWidth?: number;
  packageLimit?: number;
  belowTargetPenaltyMultiplier?: number;
};

type StayOption = {
  stay: LogicalHotelStay;
  hotel: RecommendationHotel;
  priceCents: number;
  optionKey: string;
  fallback: boolean;
  rejectedCandidates?: Array<{ optionKey: string; reason: string }>;
};

type StayEvaluation = {
  stay: LogicalHotelStay;
  options: StayOption[];
  rejectedCandidates: Array<{ optionKey: string; reason: string }>;
};

type SearchState = {
  options: StayOption[];
  totalCents: number;
};

const LABELS = ['Recommended #1', 'Recommended #2', 'Recommended #3', 'Recommended #4'];

export const resolveHotelRecommendationAlgorithm = (value = process.env.HOTEL_RECOMMENDATION_ALGORITHM): 'v1' | 'v2' =>
  String(value || 'v1').trim().toLowerCase() === 'v2' ? 'v2' : 'v1';

@Injectable()
export class HotelRecommendationPackageService {
  constructor(private readonly mealPlanPolicy: HotelMealPlanPolicyService) {}

  generate(input: RecommendationPackageInput): RecommendationPackage[] {
    const stays = this.buildLogicalStays(input.routes, input.noOfNights);
    if (stays.length === 0) return this.ensureFourPackages([], []);
    const evaluations = stays.map((stay) => this.buildOptions(stay, input));
    const hasUnavailableStay = evaluations.some((evaluation) => evaluation.options.length === 0);

    if (hasUnavailableStay) {
      const packageLimit = Math.min(Math.max(input.packageLimit ?? 4, 1), 4);
      const beamWidth = Math.max(input.beamWidth ?? 200, 1);
      const maxCandidates = Math.max(input.maxCandidatesPerStay ?? this.envNumber('HOTEL_RECOMMENDATION_CANDIDATES_PER_STAY', 20), 1);
      const availableEvaluations = evaluations
        .filter((evaluation) => evaluation.options.length > 0)
        .map((evaluation) => ({ ...evaluation, options: evaluation.options.slice(0, maxCandidates) }));
      if (availableEvaluations.length === 0) {
        return this.ensureFourPackages([this.toIncompletePackage(evaluations)], evaluations);
      }

      const states = this.beamSearch(
        availableEvaluations.map((evaluation) => evaluation.options),
        null,
        [],
        beamWidth,
        Math.max(packageLimit, 4),
      );
      const packages: RecommendationPackage[] = [];
      for (const state of states) {
        const candidate = this.toIncompletePackage(evaluations, state.options, packages.length + 1, packages);
        if (packages.some((existing) => this.packageKey(existing.hotels) === this.packageKey(candidate.hotels))) continue;
        packages.push(candidate);
        if (packages.length >= packageLimit) break;
      }
      return this.ensureFourPackages(
        packages.length > 0 ? packages : [this.toIncompletePackage(evaluations)],
        evaluations,
      );
    }

    const packages: RecommendationPackage[] = [];
    const packageLimit = Math.max(input.packageLimit ?? 1000, 1);
    const beamWidth = Math.max(input.beamWidth ?? 200, 1);
    const maxCandidates = Math.max(input.maxCandidatesPerStay ?? this.envNumber('HOTEL_RECOMMENDATION_CANDIDATES_PER_STAY', 20), 1);
    const normalizedEvaluations = evaluations.map((evaluation) => ({
      ...evaluation,
      options: evaluation.options.slice(0, maxCandidates),
    }));

    const groupMultipliers = [1, 1.2, 1.4, 1.6];
    for (let groupIndex = 0; groupIndex < 4; groupIndex += 1) {
      // Group 1 is the cheapest complete package. Later groups target the
      // same baseline with the documented 1.2x/1.4x/1.6x progression. The
      // itinerary budget remains the user's original value; it is not
      // mutated into a new budget for each recommendation group.
      const initialPackage = packages[0];
      const targetCents = groupIndex === 0 || !initialPackage
        ? null
        : Math.round(this.toCents(initialPackage.totalPrice || 0) * groupMultipliers[groupIndex]);
      const searchStates = this.beamSearch(
        normalizedEvaluations.map((evaluation) => evaluation.options),
        targetCents,
        packages,
        beamWidth,
        packageLimit,
      );
      const candidates = searchStates
        .map((state) => this.toPackage(state.options, groupIndex + 1, targetCents, packages, input))
        .filter((candidate) => {
          if (groupIndex === 0) return true;
          const previousTotal = Number(packages[packages.length - 1]?.totalPrice || 0);
          // Never wrap to a cheaper option for a later recommendation group.
          // If no unused option is more expensive, leave that group empty.
          return Number(candidate.totalPrice || 0) > previousTotal;
        })
        .filter((candidate) => !packages.some((existing) => this.packageKey(existing.hotels) === this.packageKey(candidate.hotels)))
        .sort((a, b) => this.packageScore(a, targetCents, packages, input) - this.packageScore(b, targetCents, packages, input));

      if (candidates.length === 0) break;
      packages.push(candidates[0]);
    }

    return this.ensureFourPackages(packages, evaluations);
  }

  /**
   * The hotel list contract always exposes four recommendation tabs. When
   * fewer than four distinct packages exist, keep the tab but leave it empty.
   * Repeating the last package makes an unavailable recommendation look like
   * a valid alternative and causes duplicate hotel cards in the UI.
   */
  private ensureFourPackages(
    packages: RecommendationPackage[],
    evaluations: StayEvaluation[],
  ): RecommendationPackage[] {
    const seenPackageKeys = new Set<string>();
    const distinctPackages = packages.filter((pkg) => {
      if (!Array.isArray(pkg.hotels) || pkg.hotels.length === 0) return false;
      const key = this.packageKey(pkg.hotels);
      if (seenPackageKeys.has(key)) return false;
      seenPackageKeys.add(key);
      return true;
    });
    const packageAmount = (pkg: RecommendationPackage): number => {
      const amount = pkg.totalPrice ?? pkg.partialTotal;
      return Number.isFinite(Number(amount)) ? Number(amount) : Number.POSITIVE_INFINITY;
    };
    const normalized = distinctPackages
      .sort((left, right) => packageAmount(left) - packageAmount(right))
      .slice(0, 4)
      .map((pkg, index) => ({
        ...pkg,
        groupType: index + 1,
        label: LABELS[index],
        hotels: [...pkg.hotels],
        stayResults: [...pkg.stayResults],
        distinctFromPrevious: true,
      }));

    if (normalized.length === 0) {
      normalized.push(this.toIncompletePackage(evaluations, [], 1));
    }

    while (normalized.length < 4) {
      const groupType = normalized.length + 1;
      normalized.push(this.emptyRecommendationPackage(groupType));
    }

    return normalized;
  }

  private emptyRecommendationPackage(groupType: number): RecommendationPackage {
    return {
      groupType,
      label: LABELS[groupType - 1] || `Recommended #${groupType}`,
      hotels: [],
      totalPrice: null,
      partialTotal: 0,
      targetPrice: null,
      complete: false,
      distinctFromPrevious: false,
      diversityScore: 0,
      repeatedHotelIds: [],
      repeatedAcrossGroupsHotelIds: [],
      sameOptionAcrossGroups: [],
      duplicateWithinPackageHotelIds: [],
      repeatedFromGroups: [],
      fallbackReasons: ['No distinct hotel package is available for this recommendation group.'],
      stayResults: [],
    };
  }

  buildLogicalStays(routes: RecommendationRoute[], noOfNights?: number): LogicalHotelStay[] {
    const hotelRoutes = [...routes]
      .filter((route) => this.isHotelStayRoute(route))
      .sort((a, b) => this.dateValue(a.itinerary_route_date) - this.dateValue(b.itinerary_route_date) || Number(a.itinerary_route_ID) - Number(b.itinerary_route_ID));
    // Route details include the departure/airport route, but the hotel plan
    // has one hotel stay per night. Keep recommendation packages scoped to
    // those hotel nights so the departure route cannot create an unavailable
    // third stay and force incomplete/zero fallback packages.
    const ordered = Number.isInteger(noOfNights) && Number(noOfNights) >= 0
      ? hotelRoutes.slice(0, Number(noOfNights))
      : hotelRoutes;
    const stays: LogicalHotelStay[] = [];
    let current: (LogicalHotelStay & { lastDate: string; stableGroup: string; destinationKey: string }) | null = null;

    for (const route of ordered) {
      const routeId = Number(route.itinerary_route_ID || 0);
      const date = this.dateOnly(route.itinerary_route_date);
      if (!routeId || !date) continue;

      const destination = String(route.next_visiting_location || route.location_name || '').trim();
      const destinationId = this.firstText(route.destinationId, route.destination_id, route.location_id);
      const destinationKey = destinationId || this.canonicalDestination(destination);
      const stableGroup = this.firstText(route.stayGroupId, route.stay_group_id) || '';
      const parentRouteId = Number(route.parentStayRouteId || route.parent_stay_route_id || routeId);
      const explicitCheckIn = this.dateOnly(route.checkInDate || route.hotelCheckInDate);
      const explicitCheckOut = this.dateOnly(route.checkOutDate || route.hotelCheckOutDate);
      const canMerge = Boolean(
        current &&
        (stableGroup ? current.stableGroup === stableGroup : current.destinationKey === destinationKey) &&
        this.addDays(current.lastDate, 1) === date &&
        (!explicitCheckIn || explicitCheckIn === current.checkInDate || explicitCheckIn === date),
      );

      if (!canMerge) {
        if (current) stays.push(this.withoutInternalFields(current));
        const checkInDate = explicitCheckIn || date;
        const checkOutDate = explicitCheckOut || this.addDays(date, 1);
        current = {
          stayKey: `${parentRouteId}|${checkInDate}|${checkOutDate}`,
          parentRouteId,
          routeIds: [routeId],
          destination,
          destinationId: destinationId || null,
          checkInDate,
          checkOutDate,
          nights: Math.max(this.daysBetween(checkInDate, checkOutDate), 1),
          lastDate: date,
          stableGroup,
          destinationKey,
        };
        continue;
      }

      current.routeIds.push(routeId);
      current.lastDate = date;
      current.checkOutDate = explicitCheckOut || this.addDays(date, 1);
      current.nights = Math.max(this.daysBetween(current.checkInDate, current.checkOutDate), current.routeIds.length);
      current.stayKey = `${current.parentRouteId}|${current.checkInDate}|${current.checkOutDate}`;
    }

    if (current) stays.push(this.withoutInternalFields(current));
    return stays;
  }

  private buildOptions(stay: LogicalHotelStay, input: RecommendationPackageInput): StayEvaluation {
    const sources: HotelSearchResult[] = [];
    const missingRoutes: number[] = [];
    for (const routeId of stay.routeIds) {
      const routeHotels = input.hotelsByRoute.get(routeId);
      if (!Array.isArray(routeHotels)) {
        missingRoutes.push(routeId);
        continue;
      }
      sources.push(...routeHotels);
    }

    const meal = this.normalizeMealPlan(input.preferredMealPlanCode);
    const categories = new Set((input.preferredCategories || []).map((value) => Number(value)).filter((value) => value > 0));
    const live: StayOption[] = [];
    const offline: StayOption[] = [];
    const rejectedCandidates: Array<{ optionKey: string; reason: string }> = missingRoutes.map((routeId) => ({ optionKey: `route:${routeId}`, reason: 'No availability snapshot for route.' }));
    const seen = new Set<string>();

    for (const routeId of stay.routeIds) {
      const routeHotels = input.hotelsByRoute.get(routeId);
      if (!Array.isArray(routeHotels)) continue;
      for (const source of routeHotels) {
      for (const candidate of this.expandRateOptions(source, stay, routeId)) {
        const optionKey = this.optionKey(candidate);
        if (seen.has(optionKey)) continue;
        seen.add(optionKey);

        if (Number((candidate as any).totalStayPrice || 0) <= 0) {
          rejectedCandidates.push({ optionKey, reason: 'Rate does not cover the full logical stay.' });
          continue;
        }

        const eligibility = this.eligibility(candidate, stay, meal, categories, input);
        if (eligibility.ok === false) {
          rejectedCandidates.push({ optionKey, reason: eligibility.reason });
          continue;
        }

        const fallback = this.isOffline(candidate);
        const hotel = this.toRecommendationHotel(candidate, stay, optionKey, fallback);
        const option: StayOption = {
          stay,
          hotel,
          priceCents: this.toCents(hotel.exactFullStayTotal),
          optionKey,
          fallback,
          rejectedCandidates,
        };
        (fallback ? offline : live).push(option);
      }
      }
    }

    const selected = (live.length > 0 ? live : offline).sort((a, b) => a.priceCents - b.priceCents || a.optionKey.localeCompare(b.optionKey));
    return { stay, options: selected, rejectedCandidates };
  }

  private expandRateOptions(base: HotelSearchResult, stay: LogicalHotelStay, sourceRouteId: number): HotelSearchResult[] {
    const isExpandedRateOption = Array.isArray(base.rateOptions) && base.rateOptions.length > 0;
    const rawOptions = isExpandedRateOption ? base.rateOptions : [base as unknown as Record<string, unknown>];
    return rawOptions.map((rawOption) => {
      const option = rawOption as any;
      const nightlyRates = Array.isArray(option.nightlyRates)
        ? option.nightlyRates
        : (isExpandedRateOption ? undefined : (base as any).nightlyRates);
      const total = this.resolveFullStayTotal(base, option, stay, nightlyRates, sourceRouteId, isExpandedRateOption);
      return {
        ...base,
        ...option,
        hotelCode: String(option.hotelCode || base.hotelCode || ''),
        hotelName: String(option.hotelName || base.hotelName || 'Hotel'),
        provider: String(option.provider || base.provider || ''),
        canonicalHotelId: option.canonicalHotelId ?? base.canonicalHotelId ?? null,
        providerHotelCode: option.providerHotelCode || base.providerHotelCode,
        rateOptionId: String(option.rateOptionId || base.rateOptionId || option.rateId || (base as any).rateId || base.searchReference || ''),
        rateId: String(option.rateId || (base as any).rateId || ''),
        roomId: option.roomId ?? base.roomId,
        roomType: option.roomType || base.roomType,
        mealPlan: option.mealPlan ?? base.mealPlan,
        bookingCode: option.bookingCode || base.bookingCode,
        searchReference: option.searchReference || base.searchReference,
        rateOptions: [option],
        nightlyRates,
        numberOfNights: option.numberOfNights ?? base.numberOfNights,
        totalStayPrice: total === null ? undefined : total,
        price: Number(option.price ?? option.pricePerNight ?? (isExpandedRateOption ? 0 : base.price) ?? 0),
        pricePerNight: Number(option.pricePerNight ?? option.price ?? (isExpandedRateOption ? 0 : base.pricePerNight ?? base.price) ?? 0),
      } as HotelSearchResult;
    });
  }

  private resolveFullStayTotal(
    base: HotelSearchResult,
    option: any,
    stay: LogicalHotelStay,
    nightlyRates: any[] | undefined,
    sourceRouteId: number,
    isExpandedRateOption: boolean,
  ): number | null {
    const optionCheckIn = this.dateOnly(option.checkInDate || option.check_in_date || (base as any).checkInDate);
    const optionCheckOut = this.dateOnly(option.checkOutDate || option.check_out_date || (base as any).checkOutDate);
    if (optionCheckIn && optionCheckIn !== stay.checkInDate) return null;
    if (optionCheckOut && optionCheckOut !== stay.checkOutDate) return null;

    if (nightlyRates?.length) {
      const byDate = new Map(nightlyRates.map((rate: any) => [this.dateOnly(rate.date || rate.stayDate), Number(rate.sellAmount ?? rate.totalAmount ?? rate.baseAmount ?? 0)]));
      const amounts = Array.from({ length: stay.nights }, (_, index) => byDate.get(this.addDays(stay.checkInDate, index)));
      if (amounts.every((amount) => Number.isFinite(amount) && Number(amount) > 0)) return this.money(amounts.reduce((sum, amount) => sum + Number(amount), 0));
      if (stay.nights > 1) return null;
    }

    const explicitTotal = Number(
      option.totalStayPrice ??
      option.totalPrice ??
      option.totalFare ??
      (isExpandedRateOption ? 0 : base.totalStayPrice) ??
      (isExpandedRateOption ? 0 : base.totalFare) ??
      0,
    );
    const price = Number(option.pricePerNight ?? option.price ?? (isExpandedRateOption ? 0 : base.pricePerNight) ?? (isExpandedRateOption ? 0 : base.price) ?? 0);
    const suppliedNights = Number(option.numberOfNights ?? (isExpandedRateOption ? 0 : base.numberOfNights) ?? 0);
    if (suppliedNights > 0 && suppliedNights !== stay.nights) {
      // Some supplier/base rows retain the itinerary-wide night count while
      // the expanded option is tied to a route-specific date span. Accept the
      // row only when its total is exactly that stale night-count multiple;
      // otherwise reject it rather than fabricating a stay total.
      const staleMultiple = price > 0 && explicitTotal > 0 && Math.abs(explicitTotal / price - suppliedNights) < 0.01;
      if (!(staleMultiple && suppliedNights > stay.nights)) return null;
      return this.money(price * stay.nights);
    }
    if (stay.nights > 1 && suppliedNights <= 0 && !nightlyRates?.length && sourceRouteId !== stay.parentRouteId) return null;
    if (explicitTotal > 0 || price > 0) {
      return this.money(hotelStayTotal({
        totalStayPrice: explicitTotal,
        pricePerNight: price,
        checkInDate: optionCheckIn || undefined,
        checkOutDate: optionCheckOut || undefined,
      }, stay.nights));
    }
    if (price <= 0) return null;
    return this.money(price * stay.nights);
  }

  private eligibility(
    candidate: HotelSearchResult,
    stay: LogicalHotelStay,
    preferredMeal: CanonicalHotelRatePlanCode | null,
    categories: Set<number>,
    input: RecommendationPackageInput,
  ): { ok: true } | { ok: false; reason: string } {
    const provider = String(candidate.provider || '').trim().toLowerCase();
    if (!provider || provider === 'external' || provider === 'none') return { ok: false, reason: 'Missing usable provider.' };
    const availability = this.normalizeAvailability(candidate);
    if (!availability.ok) return availability;

    const policy = this.mealPlanPolicy.resolve({
      destination: stay.destination,
      accommodationType: (candidate as any).accommodationType,
      providerPropertyType: (candidate as any).propertyType,
      hotelTags: (candidate as any).tags,
      hotelName: candidate.hotelName,
      itineraryMealPlan: preferredMeal,
    });
    const requiredMeal = policy.effectiveRequiredPlan;
    const exactMeal = this.exactMealPlan(candidate);
    if (requiredMeal && exactMeal !== requiredMeal) return { ok: false, reason: `Meal plan mismatch: required ${requiredMeal}, option is ${exactMeal || 'UNKNOWN'}.` };

    if (categories.size > 0) {
      const category = this.categoryNumber(candidate);
      if (!category || !categories.has(category)) return { ok: false, reason: `Category ${this.normalizedCategory(candidate)} is not in the requested category set.` };
    }

    const distance = this.normalizeDistance(candidate);
    const maxDistance = Number(input.maxDistanceKm ?? 15);
    if (distance.distanceStatus === 'OUTSIDE_RADIUS' || (Number.isFinite(distance.distanceKm) && distance.distanceKm > maxDistance)) {
      return { ok: false, reason: `Distance ${distance.distanceKm ?? 'UNKNOWN'} km exceeds ${maxDistance} km.` };
    }
    if (input.requireKnownDistance && distance.distanceStatus === 'UNKNOWN') return { ok: false, reason: 'Distance is unavailable.' };
    return { ok: true };
  }

  private normalizeAvailability(candidate: HotelSearchResult): { ok: true } | { ok: false; reason: string } {
    const raw = String((candidate as any).availabilityStatus || '').trim().toUpperCase();
    if (['RESTRICTED'].includes(raw)) return { ok: false, reason: 'Rate is restricted for this stay.' };
    if (['STALE'].includes(raw)) return { ok: false, reason: 'Availability snapshot is stale.' };
    if (['UNAVAILABLE', 'NO_AVAILABILITY', 'NO_SUPPLIER_AVAILABILITY', 'NOT_BOOKABLE'].includes(raw)) return { ok: false, reason: 'Supplier has no selectable availability.' };
    if (candidate.isSelectable === false) return { ok: false, reason: 'Rate is not selectable.' };

    const offline = this.isOffline(candidate);
    const hasIdentity = Boolean(candidate.rateOptionId || (candidate as any).rateId || candidate.bookingCode || candidate.searchReference || candidate.hotelCode);
    const price = Number((candidate as any).totalStayPrice ?? 0);
    if (!hasIdentity || !Number.isFinite(price) || price <= 0) return { ok: false, reason: 'Missing valid booking identity or positive price.' };
    if (candidate.expiresAt && new Date(candidate.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'Rate has expired.' };

    if (offline) {
      return { ok: true };
    }
    const hasExplicitAvailability = Boolean(raw);
    const hasExplicitBookability = candidate.isLiveBookable === true || candidate.isBookable === true;
    if (!hasExplicitAvailability && !hasExplicitBookability) {
      return { ok: false, reason: 'Live rate has no explicit availability or bookability signal.' };
    }
    if (candidate.isLiveBookable === false || candidate.isBookable === false) return { ok: false, reason: 'Live rate is not bookable.' };
    return { ok: true };
  }

  private toRecommendationHotel(candidate: HotelSearchResult, stay: LogicalHotelStay, optionKey: string, fallback: boolean): RecommendationHotel {
    const distance = this.normalizeDistance(candidate);
    const category = this.normalizedCategory(candidate);
    const exactTotal = hotelStayTotal(candidate, stay.nights);
    return {
      ...candidate,
      checkInDate: stay.checkInDate,
      checkOutDate: stay.checkOutDate,
      numberOfNights: stay.nights,
      routeId: stay.parentRouteId,
      routeIds: [...stay.routeIds],
      stayKey: stay.stayKey,
      exactFullStayTotal: this.money(exactTotal),
      totalStayPrice: this.money(exactTotal),
      canonicalMealPlan: this.exactMealPlan(candidate),
      availabilityState: fallback ? 'OFFLINE_APPROVAL_REQUIRED' : 'AVAILABLE',
      availabilityReason: fallback ? 'Live inventory unavailable; hotel approval is required.' : undefined,
      distanceKm: distance.distanceKm,
      distanceStatus: distance.distanceStatus,
      distanceReference: distance.distanceReference,
      normalizedCategory: category,
      recommendationFallbackReason: fallback ? 'LIVE inventory unavailable; offline approval required' : undefined,
      rateOptionId: candidate.rateOptionId || optionKey,
      requiresHotelApproval: fallback || candidate.requiresHotelApproval,
      isLiveBookable: fallback ? false : candidate.isLiveBookable !== false,
      isSelectable: candidate.isSelectable !== false,
      availabilityStatus: fallback ? 'OFFLINE_APPROVAL_REQUIRED' : 'AVAILABLE',
    };
  }

  private toIncompletePackage(
    evaluations: StayEvaluation[],
    selectedOptions: StayOption[] = evaluations.flatMap((evaluation) => evaluation.options.slice(0, 1)),
    groupType = 1,
    prior: RecommendationPackage[] = [],
  ): RecommendationPackage {
    const selectedByStay = new Map(selectedOptions.map((option) => [option.stay.stayKey, option]));
    const stayResults: RecommendationStayResult[] = evaluations.map((evaluation) => {
      const option = selectedByStay.get(evaluation.stay.stayKey);
      if (option) {
        return {
          ...this.staySummary(evaluation.stay),
          state: option.fallback ? 'OFFLINE_FALLBACK' as const : 'SELECTED' as const,
          hotel: option.hotel,
          totalPrice: option.hotel.exactFullStayTotal,
          rejectedCandidates: evaluation.rejectedCandidates,
        };
      }
      return {
        ...this.staySummary(evaluation.stay),
        state: 'UNAVAILABLE' as const,
        reason: evaluation.rejectedCandidates[0]?.reason || 'No eligible hotel is available for this stay.',
        rejectedCandidates: evaluation.rejectedCandidates,
      };
    });
    const hotels = stayResults.flatMap((result) => result.hotel ? [result.hotel] : []);
    const physicalIds = hotels.map((hotel) => `${hotel.stayKey}|${this.physicalIdentity(hotel)}`);
    const optionIds = hotels.map((hotel) => `${hotel.stayKey}|${this.optionKey(hotel)}`);
    const repeatedAcrossGroupsHotelIds = Array.from(new Set(physicalIds.filter((id) => prior.some((pkg) => pkg.hotels.some((hotel) => `${hotel.stayKey}|${this.physicalIdentity(hotel)}` === id)))));
    const sameOptionAcrossGroups = Array.from(new Set(optionIds.filter((id) => prior.some((pkg) => pkg.hotels.some((hotel) => `${hotel.stayKey}|${this.optionKey(hotel)}` === id)))));
    const repeatedFromGroups = prior.filter((pkg) => pkg.hotels.some((hotel) => physicalIds.includes(`${hotel.stayKey}|${this.physicalIdentity(hotel)}`))).map((pkg) => pkg.groupType);
    const diversityPenalty = repeatedAcrossGroupsHotelIds.length + sameOptionAcrossGroups.length * 2;
    return {
      groupType,
      label: LABELS[groupType - 1] || `Recommended #${groupType}`,
      hotels,
      totalPrice: null,
      partialTotal: this.money(stayResults.reduce((sum, result) => sum + Number(result.totalPrice || 0), 0)),
      targetPrice: null,
      complete: false,
      distinctFromPrevious: !prior.some((pkg) => this.packageKey(pkg.hotels) === this.packageKey(hotels)),
      diversityScore: Math.max(0, Number((1 - diversityPenalty / Math.max(hotels.length, 1)).toFixed(4))),
      repeatedHotelIds: [],
      repeatedAcrossGroupsHotelIds,
      sameOptionAcrossGroups,
      duplicateWithinPackageHotelIds: [],
      repeatedFromGroups,
      fallbackReasons: stayResults.filter((result) => result.state === 'OFFLINE_FALLBACK').map((result) => `${result.destination}: offline approval required`),
      stayResults,
    };
  }

  private beamSearch(optionsByStay: StayOption[][], targetCents: number | null, prior: RecommendationPackage[], beamWidth: number, packageLimit: number): SearchState[] {
    let states: SearchState[] = [{ options: [], totalCents: 0 }];
    for (let index = 0; index < optionsByStay.length; index += 1) {
      const next: SearchState[] = [];
      for (const state of states) {
        for (const option of optionsByStay[index]) {
          next.push({ options: [...state.options, option], totalCents: state.totalCents + option.priceCents });
        }
      }
      const remainingMinimum = optionsByStay.slice(index + 1).reduce((sum, options) => sum + (options[0]?.priceCents || 0), 0);
      next.sort((a, b) => this.partialScore(a, b, targetCents, remainingMinimum, prior));
      states = next.slice(0, Math.min(beamWidth, packageLimit));
    }
    return states.slice(0, packageLimit);
  }

  private partialScore(a: SearchState, b: SearchState, targetCents: number | null, remainingMinimum: number, prior: RecommendationPackage[]): number {
    const aValue = targetCents === null ? a.totalCents : Math.abs(a.totalCents + remainingMinimum - targetCents);
    const bValue = targetCents === null ? b.totalCents : Math.abs(b.totalCents + remainingMinimum - targetCents);
    if (aValue !== bValue) return aValue - bValue;
    const aKey = a.options.map((option) => this.physicalIdentity(option.hotel)).sort().join('|');
    const bKey = b.options.map((option) => this.physicalIdentity(option.hotel)).sort().join('|');
    const aIdentities = new Set(a.options.map((option) => this.physicalIdentity(option.hotel)));
    const bIdentities = new Set(b.options.map((option) => this.physicalIdentity(option.hotel)));
    const aPrior = prior.filter((pkg) => pkg.hotels.some((hotel) => aIdentities.has(this.physicalIdentity(hotel)))).length;
    const bPrior = prior.filter((pkg) => pkg.hotels.some((hotel) => bIdentities.has(this.physicalIdentity(hotel)))).length;
    return aPrior - bPrior || aKey.localeCompare(bKey);
  }

  private toPackage(options: StayOption[], groupType: number, targetCents: number | null, prior: RecommendationPackage[], input: RecommendationPackageInput): RecommendationPackage {
    const hotels = options.map((option) => option.hotel);
    const physicalIds = hotels.map((hotel) => `${hotel.stayKey}|${this.physicalIdentity(hotel)}`);
    const duplicateWithinPackageHotelIds = Array.from(new Set(physicalIds.filter((id, index) => physicalIds.indexOf(id) !== index)));
    const repeatedAcrossGroupsHotelIds = Array.from(new Set(physicalIds.filter((id) => prior.some((pkg) => pkg.hotels.some((hotel) => `${hotel.stayKey}|${this.physicalIdentity(hotel)}` === id)))));
    const optionIds = hotels.map((hotel) => `${hotel.stayKey}|${this.optionKey(hotel)}`);
    const sameOptionAcrossGroups = Array.from(new Set(optionIds.filter((id) => prior.some((pkg) => pkg.hotels.some((hotel) => `${hotel.stayKey}|${this.optionKey(hotel)}` === id)))));
    const repeatedFromGroups = prior.filter((pkg) => pkg.hotels.some((hotel) => `${hotel.stayKey}|${this.physicalIdentity(hotel)}` && physicalIds.includes(`${hotel.stayKey}|${this.physicalIdentity(hotel)}`))).map((pkg) => pkg.groupType);
    const targetPrice = targetCents === null ? null : this.fromCents(targetCents);
    const packageKey = this.packageKey(hotels);
    const identicalPackage = prior.some((pkg) => this.packageKey(pkg.hotels) === packageKey);
    const fallbackReasons = options.filter((option) => option.fallback).map((option) => `${option.stay.destination}: ${option.hotel.recommendationFallbackReason}`);
    const totalPrice = this.fromCents(options.reduce((sum, option) => sum + option.priceCents, 0));
    const diversityPenalty = duplicateWithinPackageHotelIds.length + repeatedAcrossGroupsHotelIds.length + sameOptionAcrossGroups.length * 2 + (identicalPackage ? 5 : 0);
    return {
      groupType,
      label: LABELS[groupType - 1],
      hotels,
      totalPrice,
      partialTotal: totalPrice,
      targetPrice,
      complete: true,
      distinctFromPrevious: !identicalPackage,
      diversityScore: Math.max(0, Number((1 - diversityPenalty / Math.max(hotels.length, 1)).toFixed(4))),
      repeatedHotelIds: duplicateWithinPackageHotelIds,
      repeatedAcrossGroupsHotelIds,
      sameOptionAcrossGroups,
      duplicateWithinPackageHotelIds,
      repeatedFromGroups,
      fallbackReasons,
      stayResults: options.map((option) => ({
        ...this.staySummary(option.stay),
        state: option.fallback ? 'OFFLINE_FALLBACK' as const : 'SELECTED' as const,
        hotel: option.hotel,
        totalPrice: option.hotel.exactFullStayTotal,
        rejectedCandidates: option.rejectedCandidates,
      })),
    };
  }

  private packageScore(pkg: RecommendationPackage, targetCents: number | null, prior: RecommendationPackage[], input: RecommendationPackageInput): number {
    const actualCents = this.toCents(pkg.totalPrice || 0);
    if (targetCents === null) return actualCents + pkg.diversityScore * 0.01;
    const difference = actualCents - targetCents;
    const belowPenalty = difference < 0 ? Math.abs(difference) * (input.belowTargetPenaltyMultiplier ?? 2) : 0;
    const repetitionPenalty = pkg.repeatedAcrossGroupsHotelIds.length * 500 + pkg.sameOptionAcrossGroups.length * 1000 + pkg.duplicateWithinPackageHotelIds.length * 2500;
    const identicalPenalty = prior.some((existing) => this.packageKey(existing.hotels) === this.packageKey(pkg.hotels)) ? 1_000_000 : 0;
    return Math.abs(difference) + belowPenalty + repetitionPenalty + identicalPenalty;
  }

  private staySummary(stay: LogicalHotelStay) {
    return {
      stayKey: stay.stayKey,
      parentRouteId: stay.parentRouteId,
      routeIds: [...stay.routeIds],
      destination: stay.destination,
      checkInDate: stay.checkInDate,
      checkOutDate: stay.checkOutDate,
      nights: stay.nights,
    };
  }

  private exactMealPlan(candidate: HotelSearchResult): CanonicalHotelRatePlanCode | null {
    const raw = String(candidate.mealPlan || '').trim();
    return inferCanonicalHotelRatePlanCode(raw) || inferCanonicalHotelRatePlanCodeFromMealText(raw);
  }

  private normalizedCategory(candidate: HotelSearchResult): string {
    const values = [(candidate as any).category, (candidate as any).categoryName, (candidate as any).starRating, (candidate as any).rating];
    for (const value of values) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) return `STAR_${value}`;
      const raw = String(value ?? '').trim();
      if (/^budget$/i.test(raw)) return 'BUDGET';
      const match = raw.match(/^([1-5])\s*(?:\*|star|stars)(?:\s*[- ]?.*)?$/i);
      if (match) return `STAR_${match[1]}`;
      if (/^[1-5]$/.test(raw)) return `STAR_${raw}`;
    }
    return 'UNKNOWN';
  }

  private categoryNumber(candidate: HotelSearchResult): number | null {
    const value = this.normalizedCategory(candidate).match(/^STAR_([1-5])$/);
    return value ? Number(value[1]) : null;
  }

  private normalizeDistance(candidate: HotelSearchResult): {
    distanceKm: number | null;
    distanceStatus: 'WITHIN_RADIUS' | 'OUTSIDE_RADIUS' | 'UNKNOWN';
    distanceReference: 'HOTSPOT' | 'DESTINATION_CENTRE' | 'ROUTE_DESTINATION' | 'UNKNOWN';
  } {
    const rawDistance = Number((candidate as any).distanceKm);
    const rawStatus = String((candidate as any).distanceStatus || '').trim().toUpperCase();
    const rawReference = String((candidate as any).distanceReference || (candidate as any).distanceSource || '').trim().toUpperCase();
    const reference = ['HOTSPOT', 'DESTINATION_CENTRE', 'ROUTE_DESTINATION'].includes(rawReference) ? rawReference as any : 'UNKNOWN';
    if (Number.isFinite(rawDistance) && rawDistance > 0) {
      return { distanceKm: rawDistance, distanceStatus: rawStatus === 'OUTSIDE_RADIUS' ? 'OUTSIDE_RADIUS' : 'WITHIN_RADIUS', distanceReference: reference };
    }
    if (rawStatus === 'OUTSIDE_RADIUS') return { distanceKm: Number.isFinite(rawDistance) ? rawDistance : null, distanceStatus: 'OUTSIDE_RADIUS', distanceReference: reference };
    return { distanceKm: null, distanceStatus: 'UNKNOWN', distanceReference: reference };
  }

  private isOffline(candidate: HotelSearchResult): boolean {
    return String(candidate.provider || '').trim().toLowerCase() === 'offline' || candidate.bookingMode === 'MANUAL_APPROVAL' || candidate.requiresHotelApproval === true;
  }

  private physicalIdentity(candidate: HotelSearchResult): string {
    const canonical = Number(candidate.canonicalHotelId || 0);
    if (canonical > 0) return `canonical:${canonical}`;
    return `${String(candidate.provider || '').trim().toLowerCase()}|${String(candidate.providerHotelCode || candidate.hotelCode || candidate.hotelName || '').trim().toLowerCase()}`;
  }

  private optionKey(candidate: HotelSearchResult): string {
    return [this.physicalIdentity(candidate), candidate.roomId, candidate.roomTypeId, candidate.roomType, (candidate as any).rateId, candidate.rateOptionId, candidate.bookingCode, candidate.searchReference, this.exactMealPlan(candidate)].map((value) => String(value || '').trim().toLowerCase()).join('|');
  }

  private packageKey(hotels: RecommendationHotel[]): string {
    return hotels.map((hotel) => `${hotel.stayKey}|${this.optionKey(hotel)}`).sort().join('||');
  }

  private withoutInternalFields(stay: LogicalHotelStay & { lastDate: string; stableGroup: string; destinationKey: string }): LogicalHotelStay {
    const { lastDate: _lastDate, stableGroup: _stableGroup, destinationKey: _destinationKey, ...result } = stay;
    return result;
  }

  private isHotelStayRoute(route: RecommendationRoute): boolean {
    if (route.hotelRequired === false || route.hotel_required === false || Number(route.hotelRequired) === 0 || Number(route.hotel_required) === 0) return false;
    if (route.isDeparture || route.isTransit || route.isActivityOnly) return false;
    const type = String(route.routeType || route.route_type || '').trim().toLowerCase();
    if (type && /departure|transit|activity.?only/.test(type) && route.hotelRequired !== true && Number(route.hotelRequired) !== 1) return false;
    return true;
  }

  private canonicalDestination(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (/alleppey|alappuzha/.test(normalized)) return 'alleppey';
    return normalized;
  }

  private firstText(...values: unknown[]): string | null {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return null;
  }

  private normalizeMealPlan(value?: string | null): CanonicalHotelRatePlanCode | null {
    const raw = String(value || '').trim();
    return inferCanonicalHotelRatePlanCode(raw) || inferCanonicalHotelRatePlanCodeFromMealText(raw);
  }

  private envNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private dateValue(value: string | Date): number {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? Number.MAX_SAFE_INTEGER : parsed.getTime();
  }

  private dateOnly(value: unknown): string {
    if (!value) return '';
    const parsed = new Date(value as any);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  }

  private addDays(value: string, days: number): string {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
  }

  private daysBetween(start: string, end: string): number {
    const difference = new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime();
    return Number.isFinite(difference) && difference > 0 ? Math.round(difference / 86_400_000) : 1;
  }

  private toCents(value: number): number {
    return Math.round((Number.isFinite(value) ? value : 0) * 100);
  }

  private fromCents(value: number): number {
    return Number((value / 100).toFixed(2));
  }

  private money(value: number): number {
    return this.fromCents(this.toCents(value));
  }
}
