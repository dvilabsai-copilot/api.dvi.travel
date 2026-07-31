import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
  type CanonicalHotelRatePlanCode,
} from '../../hotels/hotel-rate-plans';
import { HotelMealPlanPolicyService } from './hotel-meal-plan-policy.service';

export type RecommendationRoute = {
  itinerary_route_ID: number;
  itinerary_route_date: string | Date;
  location_name?: string | null;
  next_visiting_location?: string | null;
};

export type LogicalHotelStay = {
  stayKey: string;
  parentRouteId: number;
  routeIds: number[];
  destination: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
};

export type RecommendationHotel = HotelSearchResult & {
  routeId: number;
  routeIds?: number[];
  stayKey?: string;
  recommendationFallbackReason?: string;
};

export type RecommendationPackage = {
  groupType: number;
  label: string;
  hotels: RecommendationHotel[];
  totalPrice: number;
  targetPrice: number;
  complete: boolean;
  distinctFromPrevious: boolean;
  diversityScore: number;
  repeatedHotelIds: string[];
  fallbackReasons: string[];
};

export type RecommendationPackageInput = {
  routes: RecommendationRoute[];
  hotelsByRoute: Map<number, HotelSearchResult[] | null>;
  noOfNights: number;
  preferredMealPlanCode?: string | null;
  preferredCategories?: number[];
  maxDistanceKm?: number;
  requireKnownDistance?: boolean;
  maxCandidatesPerStay?: number;
  maxCombinations?: number;
};

type StayOption = {
  stay: LogicalHotelStay;
  hotel: RecommendationHotel;
  price: number;
  optionKey: string;
  fallback: boolean;
};

const LABELS = ['Recommended #1', 'Recommended #2', 'Recommended #3', 'Recommended #4'];

@Injectable()
export class HotelRecommendationPackageService {
  constructor(private readonly mealPlanPolicy: HotelMealPlanPolicyService) {}

  generate(input: RecommendationPackageInput): RecommendationPackage[] {
    const stays = this.buildLogicalStays(input.routes, input.noOfNights);
    const optionsByStay = stays.map((stay) => this.buildOptions(stay, input));
    const complete = optionsByStay.every((options) => options.length > 0);
    if (!complete) {
      return optionsByStay.length === 0
        ? []
        : [{
            groupType: 1,
            label: LABELS[0],
            hotels: [],
            totalPrice: 0,
            targetPrice: 0,
            complete: false,
            distinctFromPrevious: true,
            diversityScore: 0,
            repeatedHotelIds: [],
            fallbackReasons: optionsByStay.flatMap((options, index) => options.length ? [] : [`No eligible hotel for ${stays[index].destination}`]),
          }];
    }

    const combinations = this.enumerate(optionsByStay, input.maxCombinations ?? 5000);
    const packages: RecommendationPackage[] = [];
    let target = 0;

    for (let groupIndex = 0; groupIndex < 4; groupIndex += 1) {
      const previous = packages[groupIndex - 1];
      target = groupIndex === 0 ? 0 : this.money((previous?.totalPrice || 0) * 1.1);
      const candidates = combinations
        .filter((combination) => !packages.some((pkg) => this.packageKey(pkg.hotels) === this.packageKey(combination.map((option) => option.hotel))))
        .map((combination) => this.toPackage(combination, groupIndex + 1, target, previous));
      if (candidates.length === 0) break;
      candidates.sort((a, b) => this.packageScore(a, target, previous) - this.packageScore(b, target, previous));
      packages.push(candidates[0]);
    }

    return packages;
  }

  buildLogicalStays(routes: RecommendationRoute[], noOfNights: number): LogicalHotelStay[] {
    const ordered = [...routes].sort((a, b) => this.dateValue(a.itinerary_route_date) - this.dateValue(b.itinerary_route_date));
    const stays: LogicalHotelStay[] = [];
    let current: LogicalHotelStay & { lastDate: string } | null = null;
    const hotelNightLimit = Math.max(Number(noOfNights || 0), 0);

    ordered.forEach((route, index) => {
      if (index === ordered.length - 1 && index >= hotelNightLimit) return;
      const routeId = Number(route.itinerary_route_ID || 0);
      const date = this.dateOnly(route.itinerary_route_date);
      if (!routeId || !date) return;
      const destination = String(route.next_visiting_location || route.location_name || '').trim();
      if (!current || current.destination.toLowerCase() !== destination.toLowerCase() || this.addDays(current.lastDate, 1) !== date) {
        if (current) stays.push(this.withoutLastDate(current));
        current = {
          stayKey: `${routeId}:${date}`,
          parentRouteId: routeId,
          routeIds: [routeId],
          destination,
          checkInDate: date,
          checkOutDate: this.addDays(date, 1),
          nights: 1,
          lastDate: date,
        };
      } else {
        current.routeIds.push(routeId);
        current.checkOutDate = this.addDays(date, 1);
        current.nights += 1;
        current.stayKey = `${current.parentRouteId}:${current.checkInDate}:${current.checkOutDate}`;
        current.lastDate = date;
      }
    });
    if (current) stays.push(this.withoutLastDate(current));
    return stays;
  }

  private withoutLastDate(stay: LogicalHotelStay & { lastDate: string }): LogicalHotelStay {
    const { lastDate: _lastDate, ...result } = stay;
    return result;
  }

  private buildOptions(stay: LogicalHotelStay, input: RecommendationPackageInput): StayOption[] {
    const source = input.hotelsByRoute.get(stay.parentRouteId);
    if (!Array.isArray(source)) return [];
    const meal = this.normalizeMealPlan(input.preferredMealPlanCode);
    const categories = new Set((input.preferredCategories || []).map((value) => Number(value)).filter((value) => value > 0));
    const live: StayOption[] = [];
    const offline: StayOption[] = [];
    const seen = new Set<string>();

    for (const candidate of source) {
      const price = this.money(Number((candidate as any).totalStayPrice ?? candidate.price ?? 0));
      const optionKey = this.optionKey(candidate);
      if (seen.has(optionKey) || price <= 0 || !this.isEligible(candidate, stay, meal, categories, input)) continue;
      seen.add(optionKey);
      const fallback = String(candidate.provider || '').trim().toLowerCase() === 'offline';
      const hotel: RecommendationHotel = {
        ...candidate,
        routeId: stay.parentRouteId,
        routeIds: stay.routeIds,
        stayKey: stay.stayKey,
        ...(fallback ? { recommendationFallbackReason: 'LIVE inventory unavailable; offline approval required' } : {}),
      };
      (fallback ? offline : live).push({ stay, hotel, price, optionKey, fallback });
    }

    const options = live.length > 0 ? live : offline;
    return options
      .sort((a, b) => a.price - b.price || a.optionKey.localeCompare(b.optionKey))
      .slice(0, Math.max(input.maxCandidatesPerStay ?? 25, 1));
  }

  private isEligible(
    candidate: HotelSearchResult,
    stay: LogicalHotelStay,
    preferredMeal: CanonicalHotelRatePlanCode | null,
    categories: Set<number>,
    input: RecommendationPackageInput,
  ): boolean {
    const provider = String(candidate.provider || '').trim().toLowerCase();
    const status = String((candidate as any).availabilityStatus || '').trim().toUpperCase();
    if (!provider || provider === 'external' || provider === 'none') return false;
    if (candidate.isBookable === false || (candidate as any).isSelectable === false) return false;
    if (['NOT_BOOKABLE', 'NO_AVAILABILITY', 'NO_SUPPLIER_AVAILABILITY', 'STALE', 'UNKNOWN'].includes(status)) return false;
    if (candidate.expiresAt && new Date(candidate.expiresAt).getTime() <= Date.now()) return false;

    const policy = this.mealPlanPolicy.resolve({
      destination: stay.destination,
      accommodationType: (candidate as any).accommodationType,
      providerPropertyType: (candidate as any).propertyType,
      hotelTags: (candidate as any).tags,
      hotelName: candidate.hotelName,
      itineraryMealPlan: preferredMeal,
    });
    const requiredMeal = policy.effectiveRequiredPlan;
    if (requiredMeal && this.candidateMealPlans(candidate).includes(requiredMeal) === false) return false;
    if (categories.size > 0) {
      const category = this.category(candidate);
      if (!category || !categories.has(category)) return false;
    }

    const distance = this.distanceKm(candidate);
    const maxDistance = Number(input.maxDistanceKm ?? 15);
    if (Number.isFinite(distance) && distance > maxDistance) return false;
    if (input.requireKnownDistance && !Number.isFinite(distance)) return false;
    return true;
  }

  private candidateMealPlans(candidate: HotelSearchResult): CanonicalHotelRatePlanCode[] {
    const values: unknown[] = [];
    const rateOptions = Array.isArray(candidate.rateOptions) ? candidate.rateOptions : [];
    if (rateOptions.length > 0) values.push(...rateOptions.map((option) => (option as any).mealPlan));
    else values.push(candidate.mealPlan);
    const plans = new Set<CanonicalHotelRatePlanCode>();
    values.forEach((value) => {
      const direct = inferCanonicalHotelRatePlanCode(String(value || '')) || inferCanonicalHotelRatePlanCodeFromMealText(String(value || ''));
      if (direct) plans.add(direct);
    });
    return Array.from(plans);
  }

  private category(candidate: HotelSearchResult): number | null {
    const raw = String((candidate as any).category ?? candidate.rating ?? '').match(/[1-5]/);
    const value = Number(raw?.[0] || 0);
    return value >= 1 && value <= 5 ? value : null;
  }

  private distanceKm(candidate: HotelSearchResult): number {
    const value = Number((candidate as any).distanceKm ?? (candidate as any).hotelDistance);
    return Number.isFinite(value) ? value : Number((String((candidate as any).hotelDistance || '').match(/[0-9]+(?:\.[0-9]+)?/) || [])[0]);
  }

  private normalizeMealPlan(value?: string | null): CanonicalHotelRatePlanCode | null {
    const raw = String(value || '').trim();
    return inferCanonicalHotelRatePlanCode(raw) || inferCanonicalHotelRatePlanCodeFromMealText(raw);
  }

  private enumerate(optionsByStay: StayOption[][], maxCombinations: number): StayOption[][] {
    const result: StayOption[][] = [];
    const walk = (index: number, current: StayOption[]) => {
      if (result.length >= maxCombinations) return;
      if (index >= optionsByStay.length) {
        result.push([...current]);
        return;
      }
      for (const option of optionsByStay[index]) {
        current.push(option);
        walk(index + 1, current);
        current.pop();
        if (result.length >= maxCombinations) break;
      }
    };
    walk(0, []);
    return result;
  }

  private toPackage(combination: StayOption[], groupType: number, targetPrice: number, previous?: RecommendationPackage): RecommendationPackage {
    const hotels = combination.map((option) => option.hotel);
    const ids = hotels.map((hotel) => `${String(hotel.provider || '').toLowerCase()}|${String(hotel.hotelCode || hotel.hotelName).toLowerCase()}`);
    const repeatedHotelIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const previousIds = new Set((previous?.hotels || []).map((hotel) => `${String(hotel.provider || '').toLowerCase()}|${String(hotel.hotelCode || hotel.hotelName).toLowerCase()}`));
    const changed = hotels.filter((hotel) => !previousIds.has(`${String(hotel.provider || '').toLowerCase()}|${String(hotel.hotelCode || hotel.hotelName).toLowerCase()}`)).length;
    return {
      groupType,
      label: LABELS[groupType - 1],
      hotels,
      totalPrice: this.money(combination.reduce((sum, option) => sum + option.price, 0)),
      targetPrice,
      complete: true,
      distinctFromPrevious: !previous || this.packageKey(hotels) !== this.packageKey(previous.hotels),
      diversityScore: hotels.length ? changed / hotels.length : 0,
      repeatedHotelIds: Array.from(new Set(repeatedHotelIds)),
      fallbackReasons: combination.filter((option) => option.fallback).map((option) => `${option.stay.destination}: ${option.hotel.recommendationFallbackReason}`),
    };
  }

  private packageScore(pkg: RecommendationPackage, target: number, previous?: RecommendationPackage): number {
    const deviation = Math.abs(pkg.totalPrice - target);
    const identicalPenalty = previous && !pkg.distinctFromPrevious ? 1_000_000 : 0;
    const repetitionPenalty = pkg.repeatedHotelIds.length * 100;
    const belowTargetPenalty = target > 0 && pkg.totalPrice < target ? target - pkg.totalPrice : 0;
    return deviation + belowTargetPenalty + identicalPenalty + repetitionPenalty;
  }

  private packageKey(hotels: RecommendationHotel[]): string {
    return hotels.map((hotel) => `${hotel.stayKey}|${this.optionKey(hotel)}`).sort().join('||');
  }

  private optionKey(candidate: HotelSearchResult): string {
    return [candidate.provider, candidate.hotelCode, candidate.rateOptionId, candidate.roomId, candidate.roomType, this.candidateMealPlans(candidate).join(',')].map((value) => String(value || '').trim().toLowerCase()).join('|');
  }

  private dateValue(value: string | Date): number {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? Number.MAX_SAFE_INTEGER : parsed.getTime();
  }

  private dateOnly(value: string | Date): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  }

  private addDays(value: string, days: number): string {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
  }

  private money(value: number): number {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
  }
}
