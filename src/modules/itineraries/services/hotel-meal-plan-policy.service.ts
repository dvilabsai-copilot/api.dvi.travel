import { Injectable } from '@nestjs/common';
import {
  inferCanonicalHotelRatePlanCode,
  type CanonicalHotelRatePlanCode,
} from '../../hotels/hotel-rate-plans';

export type HotelMealPlanPolicyResult = {
  effectiveRequiredPlan: CanonicalHotelRatePlanCode | null;
  permittedPlans: CanonicalHotelRatePlanCode[];
  policySource: 'ITINERARY' | 'HOUSEBOAT_STRUCTURED' | 'HOUSEBOAT_TAG' | 'HOUSEBOAT_PROVIDER' | 'HOUSEBOAT_LEGACY_NAME' | 'NONE';
  fallbackAllowed: boolean;
  reason: string;
};

@Injectable()
export class HotelMealPlanPolicyService {
  resolve(input: {
    destination?: string | null;
    accommodationType?: string | null;
    hotelName?: string | null;
    hotelTags?: unknown;
    providerPropertyType?: string | null;
    itineraryMealPlan?: string | null;
    transportOnly?: boolean;
  }): HotelMealPlanPolicyResult {
    if (input.transportOnly) {
      return { effectiveRequiredPlan: null, permittedPlans: [], policySource: 'NONE', fallbackAllowed: false, reason: 'Transport-only itinerary has no hotel meal-plan requirement.' };
    }

    const requested = inferCanonicalHotelRatePlanCode(input.itineraryMealPlan);
    const structured = this.normalize(input.accommodationType);
    const tags = this.flatten(input.hotelTags);
    const providerType = this.normalize(input.providerPropertyType);
    const destination = this.normalize(input.destination);
    const hotelName = this.normalize(input.hotelName);
    const isAlleppey = /alleppey|alappuzha/.test(destination);

    if (isAlleppey && this.isHouseboat(structured)) {
      return this.houseboat('HOUSEBOAT_STRUCTURED');
    }
    if (isAlleppey && tags.some((tag) => this.isHouseboat(tag))) {
      return this.houseboat('HOUSEBOAT_TAG');
    }
    if (isAlleppey && this.isHouseboat(providerType)) {
      return this.houseboat('HOUSEBOAT_PROVIDER');
    }
    if (isAlleppey && this.isHouseboat(hotelName) && !structured && !providerType && tags.length === 0) {
      return this.houseboat('HOUSEBOAT_LEGACY_NAME');
    }

    const permittedPlans = requested === 'MAP'
      ? ['MAP', 'CP', 'EP'] as CanonicalHotelRatePlanCode[]
      : requested ? [requested] : [];
    return {
      effectiveRequiredPlan: requested,
      permittedPlans,
      policySource: requested ? 'ITINERARY' : 'NONE',
      fallbackAllowed: requested === 'MAP',
      reason: requested === 'MAP'
        ? 'MAP is preferred; CP then EP are permitted when the requested plan is unavailable.'
        : requested ? `Itinerary meal plan ${requested} is required.` : 'No meal-plan requirement was configured.',
    };
  }

  private houseboat(source: HotelMealPlanPolicyResult['policySource']): HotelMealPlanPolicyResult {
    return {
      effectiveRequiredPlan: 'AP',
      permittedPlans: ['AP'],
      policySource: source,
      fallbackAllowed: false,
      reason: 'Alleppey houseboats require AP unless an explicit business override is introduced.',
    };
  }

  private isHouseboat(value: string): boolean {
    return /house\s*-?\s*boat|houseboat/.test(value);
  }

  private normalize(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private flatten(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap((entry) => this.flatten(entry));
    if (value && typeof value === 'object') return this.flatten((value as any).name || (value as any).title || (value as any).value);
    const normalized = this.normalize(value);
    return normalized ? [normalized] : [];
  }
}
