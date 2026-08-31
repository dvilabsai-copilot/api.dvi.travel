import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
  type CanonicalHotelRatePlanCode,
} from '../../hotels/hotel-rate-plans';
import { HotelMealPlanPolicyService } from './hotel-meal-plan-policy.service';
import { hotelStayTotal } from '../utils/hotel-stay-pricing.util';
import { normalizeHotelCategoryLabel, normalizeHotelCategory } from '../utils/hotel-category.util';

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
  requestedCategory?: number;
  selectedCategory?: number;
  categoryFallbackApplied?: boolean;
  categoryFallbackReason?: string;
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
  /** Occupancy counts used to reject rates that cannot price the request. */
  occupancy?: {
    extraBedCount?: number;
    childWithBedCount?: number;
    childWithoutBedCount?: number;
  };
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
  mealPlanRank: number;
  requestedCategory?: number;
  selectedCategory?: number;
  categoryFallbackApplied?: boolean;
  categoryFallbackReason?: string;
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

type CategorySlot = { category: number; multiplier: number };

const LABELS = ['Recommended #1', 'Recommended #2', 'Recommended #3', 'Recommended #4'];

export function mapHotelCategoryLabelToStar(value: unknown): number | null {
  return normalizeHotelCategory(value);
}

export const resolveHotelRecommendationAlgorithm = (value = process.env.HOTEL_RECOMMENDATION_ALGORITHM): 'v1' | 'v2' =>
  String(value || 'v1').trim().toLowerCase() === 'v2' ? 'v2' : 'v1';

@Injectable()
export class HotelRecommendationPackageService {
  constructor(private readonly mealPlanPolicy: HotelMealPlanPolicyService) {}

  private trace(stage: string, payload: Record<string, unknown>): void {
    if (String(process.env.HOTEL_RECOMMENDATION_TRACE || '').trim().toLowerCase() !== 'true') return;
    // Deliberately opt-in: recommendation responses can contain large hotel
    // inventories and must not be logged in normal production traffic.
    console.log(`[HOTEL_RECOMMENDATION_TRACE] ${stage} ${JSON.stringify(payload)}`);
  }

  generate(input: RecommendationPackageInput): RecommendationPackage[] {
    return this.generateCategoryPackages(input);
    /* istanbul ignore next -- retained below as a rollback reference while
       deployments converge; category allocation above is authoritative. */
    /*
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
        if (this.reusesHotelAcrossGroups(candidate.hotels, packages)) continue;
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
        .filter((candidate) => !this.reusesHotelAcrossGroups(candidate.hotels, packages))
        .filter((candidate) => !packages.some((existing) => this.packageKey(existing.hotels) === this.packageKey(candidate.hotels)))
        .sort((a, b) => this.packageScore(a, targetCents, packages, input) - this.packageScore(b, targetCents, packages, input));

      if (candidates.length === 0) break;
      packages.push(candidates[0]);
    }

    return this.ensureFourPackages(packages, evaluations);
    */
  }

  /**
   * Allocate semantic recommendation groups from the selected logical star
   * buckets. A group's identity is its category slot, never its payable total.
   */
  private generateCategoryPackages(input: RecommendationPackageInput): RecommendationPackage[] {
    const stays = this.buildLogicalStays(input.routes, input.noOfNights);
    this.trace('buildLogicalStays', {
      stays: stays.map((stay) => ({ stayKey: stay.stayKey, destination: stay.destination, routeIds: stay.routeIds, nights: stay.nights })),
    });
    this.trace('completeHotelsByRoute', {
      routes: Array.from(input.hotelsByRoute.entries()).map(([routeId, rows]) => ({ routeId, count: Array.isArray(rows) ? rows.length : 0 })),
    });
    if (stays.length === 0) return [1, 2, 3, 4].map((group) => this.emptyRecommendationPackage(group));
    const evaluations = stays.map((stay) => this.buildOptions(stay, input));
    this.trace('buildStayCandidates.aggregateNightlyStayCandidates.buildOptions', {
      stays: evaluations.map((evaluation) => ({
        stayKey: evaluation.stay.stayKey,
        destination: evaluation.stay.destination,
        eligibleOptionCount: evaluation.options.length,
        rejectedCandidateCount: evaluation.rejectedCandidates.length,
        rejectedCandidates: evaluation.rejectedCandidates.slice(0, 50),
        candidates: evaluation.options.slice(0, 50).map((option) => ({
          provider: option.hotel.provider,
          hotelName: option.hotel.hotelName,
          rateOptionId: option.hotel.rateOptionId,
          totalPrice: option.hotel.totalStayPrice,
        })),
      })),
    });
    let categories = Array.from(new Set((input.preferredCategories || [])
      .map(Number).filter((value) => value >= 1 && value <= 5))).sort((a, b) => a - b);
    if (categories.length === 0) {
      categories = Array.from(new Set(evaluations.flatMap((evaluation) => evaluation.options
        .map((option) => this.categoryNumber(option.hotel) || 0)
        .filter((value) => value > 0)))).sort((a, b) => a - b);
    }
    const slots = this.categorySlots(categories);
    const selectedByGroup = slots.map((slot) => new Map<string, StayOption>());

    evaluations.forEach((evaluation) => {
      // Diversity is scoped to one logical stay. A continuous Munnar stay
      // must consume distinct physical properties across G1..G4, while a
      // different destination/stay has its own independent inventory.
      const used = new Set<string>();
      slots.forEach((slot, groupIndex) => {
        const selected = this.selectCategoryOption(evaluation.options, slot, used);
        if (!selected) return;
        selectedByGroup[groupIndex].set(evaluation.stay.stayKey, selected);
        used.add(this.physicalIdentity(selected.hotel));
      });
    });

    // A recommendation group is a complete itinerary package, not an
    // independent inventory bucket. If a later category slot has no eligible
    // option for a stay, carry forward the closest earlier group's selection
    // for that same stay. This preserves the requested group ordering while
    // allowing G3/G4 to reuse an eligible G2/G3 hotel when inventory is thin.
    // The fallback is per logical stay, so one missing destination cannot be
    // silently filled with a hotel from another destination.
    for (let groupIndex = 1; groupIndex < slots.length; groupIndex += 1) {
      evaluations.forEach((evaluation) => {
        const stayKey = evaluation.stay.stayKey;
        if (selectedByGroup[groupIndex].has(stayKey)) return;
        for (let previousIndex = groupIndex - 1; previousIndex >= 0; previousIndex -= 1) {
          const previousSelection = selectedByGroup[previousIndex].get(stayKey);
          if (!previousSelection) continue;
          selectedByGroup[groupIndex].set(stayKey, {
            ...previousSelection,
            hotel: {
              ...previousSelection.hotel,
              recommendationFallbackReason:
                `Reused from recommendation group ${previousIndex + 1} because no distinct eligible hotel was available.`,
            },
          });
          break;
        }
      });
    }

    const packages = selectedByGroup.map((selection, index) =>
      this.packageFromSelections(evaluations, selection, index + 1),
    );
    this.trace('package.stayResults', {
      packages: packages.map((pkg) => ({
        groupType: pkg.groupType,
        totalPrice: pkg.totalPrice,
        stayResults: pkg.stayResults.map((result) => ({
          stayKey: result.stayKey,
          state: result.state,
          hotelName: result.hotel?.hotelName,
          provider: result.hotel?.provider,
          rateOptionId: result.hotel?.rateOptionId,
          totalPrice: result.totalPrice,
          reason: result.reason,
        })),
      })),
    });
    const hasGenuineGroup4 = packages[3].stayResults.some((result) => result.state !== 'UNAVAILABLE');
    if (hasGenuineGroup4) {
      const group3 = packages[2];
      packages[3] = this.packageWithG4Fallback(packages[3], group3);
    } else {
      packages[3] = this.emptyRecommendationPackage(4);
      packages[3].fallbackReasons = ['No eligible hotel is available for Group 4.'];
    }
    return packages;
  }

  /** Exact category first, then lower categories, then higher categories. */
  private categoryFallbackOrder(targetCategory: number): number[] {
    const supported = [2, 3, 4, 5];
    if (!supported.includes(targetCategory)) return supported;
    return [
      targetCategory,
      ...supported.filter((category) => category < targetCategory).sort((a, b) => b - a),
      ...supported.filter((category) => category > targetCategory),
    ];
  }

  private selectCategoryOption(options: StayOption[], slot: CategorySlot, used: Set<string>): StayOption | undefined {
    const orderedCategories = this.categoryFallbackOrder(slot.category);
    // Offline inventory is a fallback only. If any live offer is eligible for
    // this stay, it must remain the source pool for automatic selection even
    // when an offline offer is cheaper. Offline offers are still retained in
    // the returned pane for manual review/selection when no live offer wins.
    const liveOptions = options.filter((option) => !option.fallback);
    const selectableOptions = liveOptions.length > 0 ? liveOptions : options;

    // Pass 1: exhaust every unused physical property before permitting reuse.
    // Category preference remains stronger than meal-plan preference: for each
    // category, first look only at unused properties, then rank their rates.
    for (const category of orderedCategories) {
      const categoryCandidates = selectableOptions
        .filter((option) => this.categoryNumber(option.hotel) === category)
        .sort((a, b) => this.compareRecommendationOptions(a, b));
      if (categoryCandidates.length === 0) continue;

      const unusedCandidates = categoryCandidates.filter(
        (candidate) => !used.has(this.physicalIdentity(candidate.hotel)),
      );
      if (unusedCandidates.length === 0) continue;

      const selected = this.rankCategoryCandidates(unusedCandidates, slot, categoryCandidates);
      if (selected) return this.withCategoryMetadata(selected, slot, category);
    }

    // Pass 2: no unused usable property exists anywhere for this stay. Reuse
    // is now allowed, using the same category/meal/target ordering.
    for (const category of orderedCategories) {
      const categoryCandidates = selectableOptions
        .filter((option) => this.categoryNumber(option.hotel) === category)
        .sort((a, b) => this.compareRecommendationOptions(a, b));
      if (categoryCandidates.length === 0) continue;

      const selected = this.rankCategoryCandidates(categoryCandidates, slot, categoryCandidates);
      if (selected) return this.withCategoryMetadata(selected, slot, category);
    }
    return undefined;
  }

  private rankCategoryCandidates(candidates: StayOption[], slot: CategorySlot, allCategoryCandidates: StayOption[]): StayOption | undefined {
    if (candidates.length === 0) return undefined;

      // Meal-plan preference is evaluated inside the selected category. A
      // cheaper CP rate must not beat a valid MAP rate in the same category.
      // The multiplier is applied only after this meal-plan class is chosen.
      const bestMealPlanRank = Math.min(...candidates.map((candidate) => candidate.mealPlanRank));
      const mealCandidates = candidates.filter((candidate) => candidate.mealPlanRank === bestMealPlanRank);

      const base = allCategoryCandidates
        .filter((candidate) => candidate.mealPlanRank === bestMealPlanRank)
        .sort((a, b) => this.compareRecommendationOptions(a, b))[0]?.priceCents
        ?? mealCandidates[0].priceCents;
      const threshold = Math.ceil(base * slot.multiplier);
      return mealCandidates.find((candidate) => candidate.priceCents >= threshold) ||
        // The target is a preference, not a reason to reuse an already-used
        // property or mark an otherwise usable unused property unavailable.
        mealCandidates[0];
  }

  private withCategoryMetadata(selected: StayOption, slot: CategorySlot, category: number): StayOption {
    const applied = category !== slot.category;
    const rawSelectedCategory = Number(
      (selected.hotel as any).hotelCategory ??
      (selected.hotel as any).hotel_category ??
      (selected.hotel as any).rating ??
      0,
    );
    // Supplier 1★ is normalized to the internal 2★ bucket for ranking, but
    // the header must show the supplier's actual 1★ rating. Other ratings
    // already share the logical bucket and should keep the established text.
    const displayCategory = rawSelectedCategory === 1 && category === 2 ? 1 : category;
    const fallbackReason = applied
      ? `${displayCategory}* selected — ${slot.category}* not available`
      : undefined;
    return {
      ...selected,
      requestedCategory: slot.category,
      selectedCategory: category,
      categoryFallbackApplied: applied,
      categoryFallbackReason: fallbackReason,
      hotel: {
        ...selected.hotel,
        requestedCategory: slot.category,
        selectedCategory: category,
        categoryFallbackApplied: applied,
        categoryFallbackReason: fallbackReason,
        recommendationFallbackReason: fallbackReason || selected.hotel.recommendationFallbackReason,
      },
    };
  }

  private categorySlots(categories: number[]): CategorySlot[] {
    const [a, b, c, d] = categories;
    if (categories.length <= 1) return [1, 1.2, 1.4, 1.6].map((multiplier) => ({ category: a || 0, multiplier }));
    if (categories.length === 2) return [{ category: a, multiplier: 1 }, { category: a, multiplier: 1.5 }, { category: b, multiplier: 1 }, { category: b, multiplier: 1.5 }];
    if (categories.length === 3) return [{ category: a, multiplier: 1 }, { category: b, multiplier: 1 }, { category: b, multiplier: 1.5 }, { category: c, multiplier: 1 }];
    return [{ category: a, multiplier: 1 }, { category: b, multiplier: 1 }, { category: c, multiplier: 1 }, { category: d, multiplier: 1 }];
  }

  private packageFromSelections(evaluations: StayEvaluation[], selections: Map<string, StayOption>, groupType: number): RecommendationPackage {
    const stayResults = evaluations.map((evaluation) => {
      const option = selections.get(evaluation.stay.stayKey);
      return option ? {
        ...this.staySummary(evaluation.stay),
        state: option.fallback ? 'OFFLINE_FALLBACK' as const : 'SELECTED' as const,
        hotel: option.hotel,
        totalPrice: option.hotel.exactFullStayTotal,
        rejectedCandidates: evaluation.rejectedCandidates,
      } : {
        ...this.staySummary(evaluation.stay),
        state: 'UNAVAILABLE' as const,
        reason: evaluation.rejectedCandidates[0]?.reason || 'No eligible hotel is available for this stay.',
        rejectedCandidates: evaluation.rejectedCandidates,
      };
    });
    const hotels = stayResults.flatMap((result) => 'hotel' in result && result.hotel ? [result.hotel] : []);
    const total = this.money(stayResults.reduce((sum, result) => sum + Number('totalPrice' in result ? result.totalPrice || 0 : 0), 0));
    return {
      groupType, label: LABELS[groupType - 1], hotels,
      totalPrice: stayResults.every((result) => result.state !== 'UNAVAILABLE') ? total : null,
      partialTotal: total, targetPrice: null,
      complete: stayResults.length > 0 && stayResults.every((result) => result.state !== 'UNAVAILABLE'),
      distinctFromPrevious: true, diversityScore: 1, repeatedHotelIds: [],
      repeatedAcrossGroupsHotelIds: [], sameOptionAcrossGroups: [], duplicateWithinPackageHotelIds: [],
      repeatedFromGroups: [], fallbackReasons: stayResults.filter((result) => result.state === 'OFFLINE_FALLBACK').map((result) => `${result.destination}: offline approval required`),
      stayResults,
    };
  }

  private packageWithG4Fallback(group4: RecommendationPackage, group3: RecommendationPackage): RecommendationPackage {
    const fallbackByStay = new Map(group3.stayResults.filter((result): result is RecommendationStayResult & { hotel: RecommendationHotel; totalPrice?: number } => Boolean(result.hotel)).map((result) => [result.stayKey, result]));
    const stayResults = group4.stayResults.map((result) => result.state === 'UNAVAILABLE' && fallbackByStay.has(result.stayKey)
      ? {
        ...result,
        state: 'SELECTED' as const,
        hotel: this.cloneRecommendationHotel(fallbackByStay.get(result.stayKey)!.hotel),
        totalPrice: fallbackByStay.get(result.stayKey)!.totalPrice,
        reason: undefined,
      }
      : result);
    const hotels = stayResults.flatMap((result) => 'hotel' in result && result.hotel ? [result.hotel] : []);
    const total = this.money(stayResults.reduce((sum, result) => sum + Number('totalPrice' in result ? result.totalPrice || 0 : 0), 0));
    return { ...group4, hotels, stayResults, partialTotal: total, totalPrice: stayResults.every((result) => result.state !== 'UNAVAILABLE') ? total : null, complete: stayResults.every((result) => result.state !== 'UNAVAILABLE'), fallbackReasons: ['G4 fallback used only for stays without a genuine Group 4 option.'] };
  }

  private cloneRecommendationHotel(hotel: RecommendationHotel): RecommendationHotel {
    const selectedPriceSnapshot = (hotel as any).selectedPriceSnapshot;
    return {
      ...hotel,
      rateOptions: Array.isArray((hotel as any).rateOptions)
        ? (hotel as any).rateOptions.map((option: any) => ({ ...option }))
        : (hotel as any).rateOptions,
      ...(selectedPriceSnapshot ? { selectedPriceSnapshot: { ...selectedPriceSnapshot } } : {}),
    };
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
      // A destination id is route metadata, not a logical-stay boundary. The
      // same city can carry different destination/location ids on consecutive
      // route rows (as happens for Munnar 11275/11276). Logical stays must be
      // grouped by the canonical destination value; an explicit stay group
      // remains the stronger override for providers that intentionally use
      // different destination labels.
      const destinationKey = this.canonicalDestination(destination);
      const stableGroup = this.firstText(route.stayGroupId, route.stay_group_id) || '';
      const parentRouteId = Number(route.parentStayRouteId || route.parent_stay_route_id || routeId);
      const explicitCheckIn = this.dateOnly(route.checkInDate || route.hotelCheckInDate);
      const explicitCheckOut = this.dateOnly(route.checkOutDate || route.hotelCheckOutDate);
      // Route metadata is the authoritative way to join a stay when the
      // itinerary moves between labels/cities during one hotel booking. A
      // shared check-in/check-out window is equally strong evidence. Only
      // fall back to the legacy same-destination rule when neither is
      // present, so ordinary route changes remain separate stays.
      const linkedToCurrentStay = Boolean(
        current && (
          (parentRouteId > 0 && (
            parentRouteId === current.parentRouteId ||
            parentRouteId === current.routeIds[current.routeIds.length - 1]
          )) ||
          (explicitCheckIn && explicitCheckOut &&
            explicitCheckIn === current.checkInDate &&
            explicitCheckOut === current.checkOutDate)
        ),
      );
      const canMerge = Boolean(
        current &&
        (stableGroup
          ? current.stableGroup === stableGroup
          : linkedToCurrentStay || current.destinationKey === destinationKey) &&
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
    const missingRoutes = stay.routeIds.filter(
      (routeId) => {
        const rows = input.hotelsByRoute.get(routeId);
        return !Array.isArray(rows) || rows.length === 0;
      },
    );

    const meal = this.normalizeMealPlan(input.preferredMealPlanCode);
    const categories = new Set((input.preferredCategories || []).map((value) => Number(value)).filter((value) => value > 0));
    const live: StayOption[] = [];
    const offline: StayOption[] = [];
    const rejectedCandidates: Array<{ optionKey: string; reason: string }> = missingRoutes.map((routeId) => ({ optionKey: `route:${routeId}`, reason: 'No availability snapshot for route; full logical stay is unavailable.' }));
    const seen = new Set<string>();
    const permittedPlans = this.mealPlanPolicy.resolve({
      destination: stay.destination,
      itineraryMealPlan: meal,
    }).permittedPlans;
    const mealRank = (option: StayOption): number => {
      const code = this.exactMealPlan(option.hotel);
      const index = permittedPlans.indexOf(code as any);
      return index >= 0 ? index : permittedPlans.length;
    };

    for (const candidate of this.buildStayCandidates(stay, input)) {
        const optionKey = this.optionKey(candidate);

        if (Number((candidate as any).totalStayPrice || 0) <= 0) {
          rejectedCandidates.push({ optionKey, reason: 'Rate does not cover the full logical stay.' });
          continue;
        }

        // A rejected route-night representation must not prevent the verified
        // aggregated representation of the same commercial rate from being
        // evaluated.
        if (seen.has(optionKey)) continue;
        seen.add(optionKey);

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
          mealPlanRank: 0,
          rejectedCandidates,
        };
        option.mealPlanRank = mealRank(option);
        (fallback ? offline : live).push(option);
    }

    // Provider availability is not a category preference. Keep live and
    // offline/local offers in one comparable pool so category fallback is
    // evaluated across all providers. A live 4* must not displace a usable
    // offline 2* when the requested category is 3*.
    const selected = [...live, ...offline].sort((a, b) =>
      mealRank(a) - mealRank(b) ||
      a.priceCents - b.priceCents ||
      a.optionKey.localeCompare(b.optionKey),
    );
    return { stay, options: selected, rejectedCandidates };
  }

  /**
   * Build candidates at logical-stay scope. Provider responses are commonly
   * one physical route-night per row, while recommendation selection requires
   * one compatible rate covering every night in the stay.
   */
  private buildStayCandidates(
    stay: LogicalHotelStay,
    input: RecommendationPackageInput,
  ): HotelSearchResult[] {
    const directCandidates: HotelSearchResult[] = [];
    const nightlyByRoute = new Map<number, HotelSearchResult[]>();
    const routeDateById = new Map<number, string>(
      (input.routes || [])
        .map((route) => [
          Number(route.itinerary_route_ID || 0),
          this.dateOnly(route.itinerary_route_date),
        ] as const)
        .filter(([routeId, date]) => routeId > 0 && Boolean(date)),
    );

    for (const routeId of stay.routeIds) {
      const routeHotels = input.hotelsByRoute.get(routeId);
      if (!Array.isArray(routeHotels)) continue;

      const routeDate = routeDateById.get(routeId);
      if (!routeDate) continue;

      // Keep genuine supplier full-stay candidates. Their normal validation
      // still decides whether they really cover this complete stay.
      for (const source of routeHotels) {
        // A one-night row can incorrectly carry the complete logical stay in
        // copied metadata. Only accept an explicit full-stay row from the
        // anchor route; rows from later routes are aggregated below from
        // their actual physical night instead.
        const sourceCheckIn = this.dateOnly((source as any).checkInDate || (source as any).check_in_date);
        const sourceCheckOut = this.dateOnly((source as any).checkOutDate || (source as any).check_out_date);
        const hasExplicitFullStayDates = sourceCheckIn === stay.checkInDate && sourceCheckOut === stay.checkOutDate;
        const declaresFullStay = Number((source as any).numberOfNights || (source as any).nights || 0) === stay.nights;
        if (stay.nights > 1 && routeId !== stay.parentRouteId && hasExplicitFullStayDates) continue;
        // Physical route-night rows must be aggregated for a multi-night
        // stay. Copied check-in/check-out metadata is not proof of coverage.
        if (stay.nights <= 1) {
          directCandidates.push(...this.expandRateOptions(source, stay, routeId));
        } else if (
          (routeId === stay.parentRouteId && hasExplicitFullStayDates && this.hasFullStayNightlyRates(source, stay)) ||
          (declaresFullStay && !Array.isArray((source as any).routeIds))
        ) {
          directCandidates.push(...this.expandRateOptions(source, stay, routeId));
        }
      }

      if (stay.nights <= 1) continue;

      const oneNightStay: LogicalHotelStay = {
        stayKey: `${routeId}|${routeDate}|${this.addDays(routeDate, 1)}`,
        parentRouteId: routeId,
        routeIds: [routeId],
        destination: stay.destination,
        destinationId: stay.destinationId,
        checkInDate: routeDate,
        checkOutDate: this.addDays(routeDate, 1),
        nights: 1,
      };

      const nightly = routeHotels.flatMap((source) => {
        // A row can contain copied logical-stay dates/routeIds. Override the
        // date boundary for this physical route-night before expansion so
        // copied metadata cannot fabricate coverage.
        const physicalSource: HotelSearchResult = {
          ...source,
          itineraryRouteId: routeId,
          routeId,
          routeIds: [routeId],
          checkInDate: routeDate,
          checkOutDate: this.addDays(routeDate, 1),
          itineraryRouteDate: routeDate,
          date: routeDate,
          numberOfNights: 1,
          ...(Array.isArray(source.rateOptions)
            ? {
                rateOptions: source.rateOptions.map((option: any) => ({
                  ...option,
                  checkInDate: routeDate,
                  checkOutDate: this.addDays(routeDate, 1),
                  numberOfNights: 1,
                })),
              }
            : {}),
        } as HotelSearchResult;

        return this.expandRateOptions(physicalSource, oneNightStay, routeId)
          .filter((candidate) => Number(candidate.totalStayPrice || 0) > 0)
          .map((candidate) => ({
            ...candidate,
            itineraryRouteId: routeId,
            routeId,
            routeIds: [routeId],
            itineraryRouteDate: routeDate,
            date: routeDate,
            checkInDate: routeDate,
            checkOutDate: this.addDays(routeDate, 1),
            numberOfNights: 1,
          } as HotelSearchResult));
      });

      nightlyByRoute.set(routeId, [
        ...(nightlyByRoute.get(routeId) || []),
        ...nightly,
      ]);
    }

    if (stay.nights <= 1) return directCandidates;

    return [
      ...directCandidates,
      ...this.aggregateNightlyStayCandidates(stay, nightlyByRoute),
    ];
  }

  /**
   * Aggregate only physically present route-night rows. routeIds and
   * completeStayRouteIds are metadata and are deliberately not used as proof.
   */
  private aggregateNightlyStayCandidates(
    stay: LogicalHotelStay,
    nightlyByRoute: Map<number, HotelSearchResult[]>,
  ): HotelSearchResult[] {
    const grouped = new Map<string, Map<number, HotelSearchResult[]>>();

    for (const routeId of stay.routeIds) {
      for (const candidate of nightlyByRoute.get(routeId) || []) {
        const key = this.continuousStayRateKey(candidate);
        if (!key && String(candidate.provider || '').toLowerCase() === 'axisrooms') {
          this.trace('aggregateNightlyStayCandidates.axisroomsMissingStayKey', {
            routeId,
            hotelName: candidate.hotelName,
            canonicalHotelId: candidate.canonicalHotelId,
            providerHotelCode: candidate.providerHotelCode,
            roomId: candidate.roomId,
            roomTypeId: candidate.roomTypeId,
            roomType: candidate.roomType,
            mealPlan: candidate.mealPlan,
            mealPlanCode: (candidate as any).mealPlanCode,
            rateFamily: (candidate as any).rateFamily,
            ratePlanId: (candidate as any).ratePlanId,
            rateId: (candidate as any).rateId,
            rateOptionId: candidate.rateOptionId,
          });
        }
        if (!key) continue;
        const byRoute = grouped.get(key) || new Map<number, HotelSearchResult[]>();
        byRoute.set(routeId, [...(byRoute.get(routeId) || []), candidate]);
        grouped.set(key, byRoute);
      }
    }

    const aggregated: HotelSearchResult[] = [];
    for (const byRoute of grouped.values()) {
      if (!stay.routeIds.every((routeId) => (byRoute.get(routeId) || []).length > 0)) {
        continue;
      }

      const selected = stay.routeIds.map((routeId) =>
        [...(byRoute.get(routeId) || [])].sort(
          (left, right) => Number(left.totalStayPrice || 0) - Number(right.totalStayPrice || 0),
        )[0],
      );
      const nightlyRates = selected.map((candidate) => this.projectNightlyRate(candidate));
      const first = selected[0];
      const total = this.money(nightlyRates.reduce((sum, rate) => sum + Number(rate.sellAmount || 0), 0));
      aggregated.push({
        ...first,
        routeId: stay.parentRouteId,
        itineraryRouteId: stay.parentRouteId,
        routeIds: [...stay.routeIds],
        checkInDate: stay.checkInDate,
        checkOutDate: stay.checkOutDate,
        numberOfNights: stay.nights,
        nightlyRates,
        totalStayPrice: total,
        totalPrice: total,
        // Keep the scalar field semantically per-night. The logical total is
        // carried by totalStayPrice/totalPrice and nightlyRates; using the
        // full total as pricePerNight makes hotelStayTotal multiply it again.
        pricePerNight: Number(first.pricePerNight ?? first.price ?? nightlyRates[0]?.sellAmount ?? 0),
      } as any as HotelSearchResult);
    }
    return aggregated;
  }

  /**
   * Preserve the complete commercial identity of each physical night. The
   * recommendation algorithm selects one logical stay, but downstream reset
   * persistence needs the exact rate option for every route in that stay.
   * Keeping this data on nightlyRates prevents the anchor night's identity or
   * totals from being reused for later route rows.
   */
  private projectNightlyRate(candidate: HotelSearchResult): Record<string, unknown> {
    const source = candidate as any;
    const snapshot: Record<string, unknown> = {
      date: this.dateOnly(source.checkInDate || source.date),
      routeId: Number(source.routeId || source.itineraryRouteId || 0) || undefined,
      itineraryRouteId: Number(source.itineraryRouteId || source.routeId || 0) || undefined,
      itineraryRouteDate: source.itineraryRouteDate,
      provider: source.provider,
      providerDisplayName: source.providerDisplayName,
      canonicalHotelId: source.canonicalHotelId,
      providerHotelCode: source.providerHotelCode,
      hotelCode: source.hotelCode,
      hotelName: source.hotelName,
      roomId: source.roomId,
      roomTypeId: source.roomTypeId,
      roomType: source.roomType,
      mealPlan: source.mealPlan,
      mealPlanCode: source.mealPlanCode,
      rateFamily: source.rateFamily,
      ratePlanId: source.ratePlanId,
      rateId: source.rateId,
      rateOptionId: source.rateOptionId,
      bookingCode: source.bookingCode,
      searchReference: source.searchReference,
      selectionKey: source.selectionKey,
      bookingMode: source.bookingMode,
      priceSource: source.priceSource,
      pricePerNight: Number(source.pricePerNight ?? source.price ?? 0),
      totalPrice: Number(source.totalStayPrice ?? source.totalPrice ?? source.pricePerNight ?? source.price ?? 0),
      totalStayPrice: Number(source.totalStayPrice ?? source.totalPrice ?? source.pricePerNight ?? source.price ?? 0),
      basePricePerNight: Number(source.basePricePerNight ?? source.pricePerNight ?? source.price ?? 0),
      baseTotalPrice: Number(source.baseTotalPrice ?? source.basePricePerNight ?? source.pricePerNight ?? source.price ?? 0),
      extraBedCount: source.extraBedCount,
      extraBedRate: source.extraBedRate,
      extraBedAmount: source.extraBedAmount,
      childWithBedCount: source.childWithBedCount,
      childWithBedRate: source.childWithBedRate,
      childWithBedAmount: source.childWithBedAmount,
      childWithoutBedCount: source.childWithoutBedCount,
      childWithoutBedRate: source.childWithoutBedRate,
      childWithoutBedAmount: source.childWithoutBedAmount,
      extraChildCount: source.extraChildCount,
      extraChildRate: source.extraChildRate,
      extraChildAmount: source.extraChildAmount,
      hotelMarginPercentage: source.hotelMarginPercentage,
      hotelMarginAmount: source.hotelMarginAmount,
      hotelMarginStayAmount: source.hotelMarginStayAmount,
      hotelMarginTotalAmount: source.hotelMarginTotalAmount,
      amountIncludesHotelMargin: source.amountIncludesHotelMargin,
      pricingIncludesHotelMargin: source.pricingIncludesHotelMargin,
      isLiveRate: source.isLiveRate,
      isLiveBookable: source.isLiveBookable,
      isSelectable: source.isSelectable,
      isBookable: source.isBookable,
      availabilityStatus: source.availabilityStatus,
      availabilityMessage: source.availabilityMessage,
      availableDates: source.availableDates,
      unavailableDates: source.unavailableDates,
    };

    const baseAmount = Number(snapshot.basePricePerNight || 0);
    const sellAmount = Number(snapshot.totalStayPrice || 0);
    snapshot.baseAmount = baseAmount;
    snapshot.sellAmount = sellAmount;
    return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined));
  }

  private continuousStayRateKey(candidate: HotelSearchResult): string | null {
    const provider = String(candidate.provider || '').trim().toLowerCase();
    const hotel = this.physicalIdentity(candidate);
    const room = String(
      candidate.roomId ?? candidate.roomTypeId ?? candidate.roomType ?? '',
    ).trim().toLowerCase();
    const meal = this.exactMealPlan(candidate) || '';
    // Supplier rate-plan IDs are not a stable cross-night identity. In
    // particular, AxisRooms can expose a date-qualified ID (and can label
    // the underlying rate family differently from the canonical meal code)
    // for the same room on adjacent nights. Keep rate-plan variants in the
    // same stay bucket; the nightly price comparison below chooses the
    // cheapest valid variant for each night.
    if (!provider || !hotel || !room || !meal) return null;
    return [provider, hotel, room, meal].join('|');
  }

  private hasFullStayNightlyRates(source: HotelSearchResult, stay: LogicalHotelStay): boolean {
    const rates = Array.isArray((source as any).nightlyRates)
      ? (source as any).nightlyRates
      : Array.isArray((source as any).rateOptions)
        ? (source as any).rateOptions.flatMap((option: any) => Array.isArray(option?.nightlyRates) ? option.nightlyRates : [])
        : [];
    const dates = new Set(
      rates
        .map((rate: any) => this.dateOnly(rate?.date || rate?.stayDate))
        .filter(Boolean),
    );
    return Array.from({ length: stay.nights }, (_, index) => this.addDays(stay.checkInDate, index))
      .every((date) => dates.has(date));
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
        mealPlanCode: option.mealPlanCode ?? (base as any).mealPlanCode,
        rateFamily: option.rateFamily ?? (base as any).rateFamily,
        ratePlanId: option.ratePlanId ?? (base as any).ratePlanId,
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
    if (requiredMeal && !policy.permittedPlans.includes(exactMeal as any)) {
      return { ok: false, reason: `Meal plan mismatch: required ${requiredMeal}, option is ${exactMeal || 'UNKNOWN'}.` };
    }

    if (categories.size > 0) {
      const category = this.categoryNumber(candidate);
      if (!category) return { ok: false, reason: `Category ${this.normalizedCategory(candidate)} is not a supported star category.` };
    }

    // A recommendation is persisted only when every requested occupancy
    // component can be priced. Keep this check in the recommendation stage
    // as well; otherwise a rate can win here and then be discarded later by
    // snapshot reconciliation, leaving an empty recommendation group.
    const supplementError = this.requiredSupplementError(candidate, input.occupancy);
    if (supplementError) return { ok: false, reason: supplementError };

    // A room option is not usable merely because its supplements produce a
    // positive total.  Supplier/catalog payloads can contain a room with
    // extra-bed and child amounts but no SINGLE/DOUBLE base occupancy rate
    // (for example, Patio's Suite Room).  Reject that concrete option here so
    // it cannot become an automatic recommendation or a selectable rate.
    const baseRateError = this.baseOccupancyRateError(candidate);
    if (baseRateError) return { ok: false, reason: baseRateError };

    const distance = this.normalizeDistance(candidate);
    const maxDistance = Number(input.maxDistanceKm ?? 15);
    if (distance.distanceStatus === 'OUTSIDE_RADIUS' || (Number.isFinite(distance.distanceKm) && distance.distanceKm > maxDistance)) {
      return { ok: false, reason: `Distance ${distance.distanceKm ?? 'UNKNOWN'} km exceeds ${maxDistance} km.` };
    }
    if (input.requireKnownDistance && distance.distanceStatus === 'UNKNOWN') return { ok: false, reason: 'Distance is unavailable.' };
    return { ok: true };
  }

  private requiredSupplementError(
    candidate: HotelSearchResult,
    occupancy?: RecommendationPackageInput['occupancy'],
  ): string | null {
    const required = [
      {
        count: Number(occupancy?.extraBedCount || 0),
        rate: this.firstPositive(candidate, ['extraBedRate', 'extra_bed_rate']),
        amount: this.firstPositive(candidate, ['extraBedAmount', 'extra_bed_amount', 'totalExtraBedCost', 'total_extra_bed_cost']),
        label: 'extra bed',
      },
      {
        count: Number(occupancy?.childWithBedCount || 0),
        rate: this.firstPositive(candidate, ['childWithBedRate', 'child_with_bed_rate']),
        amount: this.firstPositive(candidate, ['childWithBedAmount', 'child_with_bed_amount', 'totalChildWithBedCost', 'total_childwith_bed_cost']),
        label: 'child with bed',
      },
      {
        count: Number(occupancy?.childWithoutBedCount || 0),
        rate: this.firstPositive(candidate, ['childWithoutBedRate', 'child_without_bed_rate']),
        amount: this.firstPositive(candidate, ['childWithoutBedAmount', 'child_without_bed_amount', 'totalChildWithoutBedCost', 'total_childwithout_bed_cost']),
        label: 'child without bed',
      },
    ];
    const missing = required.find((item) => item.count > 0 && item.rate <= 0 && item.amount <= 0);
    return missing ? `Required ${missing.label} rate is unavailable.` : null;
  }

  private firstPositive(source: any, keys: string[]): number {
    for (const key of keys) {
      const value = Number(source?.[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  private baseOccupancyRateError(candidate: HotelSearchResult): string | null {
    const option = candidate as any;
    const nestedOptions = Array.isArray(option.rateOptions) ? option.rateOptions : [];
    const sources = [option, ...nestedOptions];
    const baseKeys = [
      'basePricePerNight', 'baseTotalPrice', 'baseStayPrice',
      'baseHotelCost', 'roomRate', 'totalRoomCost',
      'singleRate', 'single_rate', 'single',
      'doubleRate', 'double_rate', 'double',
    ];
    const hasExplicitBaseSignal = sources.some((source) =>
      baseKeys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key)),
    );
    if (!hasExplicitBaseSignal) return null;

    const hasPositiveBaseRate = sources.some((source) => this.firstPositive(source, baseKeys) > 0);
    return hasPositiveBaseRate
      ? null
      : 'Base SINGLE/DOUBLE room rate is unavailable for this room option.';
  }

  private normalizeAvailability(candidate: HotelSearchResult): { ok: true } | { ok: false; reason: string } {
    const provider = String(candidate.provider || '').trim().toLowerCase();
    const raw = String((candidate as any).availabilityStatus || '').trim().toUpperCase();
    if (['RESTRICTED'].includes(raw)) return { ok: false, reason: 'Rate is restricted for this stay.' };
    if (['STALE'].includes(raw)) return { ok: false, reason: 'Availability snapshot is stale.' };
    if (['UNAVAILABLE', 'NO_AVAILABILITY', 'NO_SUPPLIER_AVAILABILITY', 'NOT_BOOKABLE'].includes(raw)) return { ok: false, reason: 'Supplier has no selectable availability.' };
    if (candidate.isSelectable === false) return { ok: false, reason: 'Rate is not selectable.' };

    const offline = this.isOffline(candidate);
    const hasIdentity = Boolean(candidate.rateOptionId || (candidate as any).rateId || candidate.bookingCode || candidate.searchReference || candidate.hotelCode);
    const price = Number((candidate as any).totalStayPrice ?? 0);
    if (!hasIdentity || !Number.isFinite(price) || price <= 0) return { ok: false, reason: 'Missing valid booking identity or positive price.' };
    const isDatabaseAuthoritativeAxisRate =
      provider === 'axisrooms' &&
      String((candidate as any).priceSource || '').trim().toUpperCase() === 'DATABASE';
    if (!isDatabaseAuthoritativeAxisRate && candidate.expiresAt && new Date(candidate.expiresAt).getTime() <= Date.now()) {
      return { ok: false, reason: 'Rate has expired.' };
    }

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
      requestedCategory: (candidate as any).requestedCategory,
      selectedCategory: (candidate as any).selectedCategory || this.categoryNumber(candidate) || undefined,
      categoryFallbackApplied: (candidate as any).categoryFallbackApplied,
      categoryFallbackReason: (candidate as any).categoryFallbackReason,
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

  /**
   * A recommendation group must offer a different physical property for the
   * same logical stay. Comparing the full rate/package key is insufficient:
   * one hotel can expose multiple rooms or rate options and would otherwise
   * be selected again as a different recommendation.
   */
  private reusesHotelAcrossGroups(hotels: RecommendationHotel[], prior: RecommendationPackage[]): boolean {
    const physicalIds = new Set(
      hotels.map((hotel) => `${hotel.stayKey}|${this.physicalIdentity(hotel)}`),
    );
    return prior.some((pkg) => pkg.hotels.some((hotel) =>
      physicalIds.has(`${hotel.stayKey}|${this.physicalIdentity(hotel)}`),
    ));
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
    const raw = String(candidate.mealPlan || (candidate as any).mealPlanCode || '').trim();
    return inferCanonicalHotelRatePlanCode(raw) || inferCanonicalHotelRatePlanCodeFromMealText(raw);
  }

  private normalizedCategory(candidate: HotelSearchResult): string {
    const values = [(candidate as any).category, (candidate as any).categoryName, (candidate as any).starRating, (candidate as any).rating];
    for (const value of values) {
      const normalized = normalizeHotelCategoryLabel(value);
      if (normalized !== 'UNKNOWN') return normalized;
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

  private compareRecommendationOptions(left: StayOption, right: StayOption): number {
    const priceDelta = left.priceCents - right.priceCents;
    if (priceDelta !== 0) return priceDelta;
    const providerRank = (provider: unknown): number => {
      const normalized = String(provider || '').trim().toLowerCase();
      if (normalized === 'axisrooms') return 0;
      if (normalized === 'tbo') return 1;
      if (normalized === 'staah') return 2;
      if (normalized === 'offline') return 3;
      return 4;
    };
    const providerDelta = providerRank(left.hotel.provider) - providerRank(right.hotel.provider);
    return providerDelta || left.optionKey.localeCompare(right.optionKey);
  }

  private physicalIdentity(candidate: HotelSearchResult): string {
    const canonical = Number(candidate.canonicalHotelId || 0);
    if (canonical > 0) return `canonical:${canonical}`;
    const normalizedName = String(candidate.hotelName || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    if (normalizedName) return `name:${normalizedName}`;
    return `${String(candidate.provider || '').trim().toLowerCase()}|${String(candidate.providerHotelCode || candidate.hotelCode || '').trim().toLowerCase()}`;
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
