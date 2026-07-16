import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../../hotels/hotel-rate-plans';

export interface HotelPreferenceFilterCallbacks {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

/** Applies configured category and meal-plan preferences to provider hotel results. */
@Injectable()
export class ItineraryHotelPreferenceFilterService {
  apply(
    hotelsByRoute: Map<number, HotelSearchResult[] | null>,
    preferredCategories: number[],
    preferredMealPlanCode: string | null,
    callbacks: HotelPreferenceFilterCallbacks = {},
  ): Map<number, HotelSearchResult[] | null> {
    const shouldFilterByCategory = preferredCategories.length > 0;
    const shouldFilterByMeal = !!preferredMealPlanCode;
    if (!shouldFilterByCategory && !shouldFilterByMeal) return hotelsByRoute;

    const preferredCategorySet = new Set(preferredCategories);
    const filteredMap = new Map<number, HotelSearchResult[] | null>();
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

        if (shouldFilterByCategory) {
          const categoryCandidates = this.categoryCandidates(hotel);
          const categoryMatch = categoryCandidates.some((category) => preferredCategorySet.has(category));
          const unknownResavenue = String((hotel as any).provider || '').toLowerCase() === 'resavenue' && categoryCandidates.length === 0;
          if (!categoryMatch && !unknownResavenue) {
            included = false;
            filterReason = `Category mismatch: ${categoryCandidates.join(',') || 'UNKNOWN'} not in ${preferredCategories.join(',')}`;
          } else if (unknownResavenue) {
            callbacks.debug?.(`Keeping ResAvenue hotel with unknown category: ${hotel.hotelName}`);
          }
        }

        if (included && shouldFilterByMeal) {
          const candidates = this.mealPlanCandidates(hotel);
          const hasMatchingMeal = candidates.includes(preferredMealPlanCode!);
          if (candidates.length > 0 && !hasMatchingMeal) {
            included = false;
            filterReason = `Meal plan mismatch: ${candidates.join(',')} != ${preferredMealPlanCode}`;
          } else if (hasMatchingMeal) {
            nextHotel = this.alignToMealPlan(hotel, preferredMealPlanCode!);
          }
        }

        if (!included && hotel.provider === 'resavenue') {
          callbacks.warn?.(`Filtering out ResAvenue: ${hotel.hotelName} - Reason: ${filterReason}`);
        }
        if (!included && hotel.provider === 'staah') {
          callbacks.warn?.(`[STAAH FILTERED] ${hotel.hotelName} (${hotel.hotelCode}) - ${filterReason}`);
        }
        if (included) filteredHotels.push(nextHotel);
      }

      callbacks.log?.(
        `Preference filter route ${routeId}: before=${hotels.length}, after=${filteredHotels.length}, ` +
          `category=${shouldFilterByCategory ? preferredCategories.join(',') : 'ANY'}, meal=${preferredMealPlanCode || 'ANY'}`,
      );
      filteredMap.set(routeId, filteredHotels);
    });
    return filteredMap;
  }

  private categoryCandidates(hotel: HotelSearchResult): number[] {
    const candidates = new Set<number>();
    const rating = Number((hotel as any).rating);
    if (Number.isFinite(rating) && rating > 0) candidates.add(Math.trunc(rating));
    const category = String((hotel as any).category ?? '').trim().match(/\d+/)?.[0];
    const categoryNumber = Number(category);
    if (Number.isFinite(categoryNumber) && categoryNumber > 0) candidates.add(Math.trunc(categoryNumber));
    return Array.from(candidates);
  }

  private mealPlanCandidates(hotel: HotelSearchResult): string[] {
    const candidates = new Set<string>();
    this.collectMealCodes((hotel as any).mealPlan, candidates);
    this.collectMealCodes((hotel as any).roomType, candidates);
    for (const roomType of hotel.roomTypes || []) this.collectMealCodes((roomType as any).roomName, candidates);
    return Array.from(candidates);
  }

  private collectMealCodes(rawValue: unknown, collector: Set<string>): void {
    const raw = String(rawValue ?? '').trim();
    if (!raw) return;
    const direct = inferCanonicalHotelRatePlanCode(raw);
    if (direct) collector.add(direct);
    const inferred = inferCanonicalHotelRatePlanCodeFromMealText(raw);
    if (inferred) collector.add(inferred);
  }

  private alignToMealPlan(hotel: HotelSearchResult, preferredMealPlanCode: string): HotelSearchResult {
    const roomTypes = Array.isArray(hotel.roomTypes) ? hotel.roomTypes : [];
    const matched = roomTypes.find((roomType) => {
      const candidates = new Set<string>();
      this.collectMealCodes((roomType as any).roomName, candidates);
      return candidates.has(preferredMealPlanCode);
    });
    if (!matched) return hotel;

    const roomName = String((matched as any).roomName || '').replace(/\s*-\s*(EP|CP|MAP|AP)\b.*$/i, '').trim();
    return {
      ...hotel,
      price: Number((matched as any).price || hotel.price || 0),
      roomType: roomName || hotel.roomType || String((matched as any).roomName || ''),
      mealPlan: preferredMealPlanCode,
      roomTypes: [matched, ...roomTypes.filter((roomType) => roomType !== matched)],
    };
  }
}
