import { Injectable } from '@nestjs/common';
import { HOTEL_RATE_PLAN_BY_CODE } from '../../hotels/hotel-rate-plans';

export interface StaahCandidateSelection {
  rate: any;
  rp: any;
  price: number;
  reason?: string;
  availableAgainFrom?: string | null;
}

export interface StaahCandidateSelectionResult {
  selected: StaahCandidateSelection | null;
  selectedMatchedPreferred: boolean;
  selectedReason: string;
  validDisplayCandidates: StaahCandidateSelection[];
  blockedDisplayCandidates: StaahCandidateSelection[];
  blockedCandidate: StaahCandidateSelection | null;
  shouldSurfaceBlockedPreferred: boolean;
  shouldSurfaceBlockedVariant: boolean;
}

export interface StaahCandidateSelectionCallbacks {
  isAllowedRoom: (propertyId: string, roomId: string) => boolean;
  roomName: (roomId: string) => string;
  calculatePrice: (rate: any) => number;
  evaluateRestrictions: (rateKey: string) => {
    blocked: boolean;
    reason: string | null;
    availableAgainFrom: string | null;
  };
  formatDate: (date: Date) => string;
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Selects valid STAAH rates and identifies restricted variants for display. */
@Injectable()
export class StaahCandidateSelectionService {
  select(input: {
    routeId: number;
    propertyId: string;
    hotel: any;
    rows: any[];
    ratePlanRows: any[];
    restrictionRowsByRateKey: Map<string, any[]>;
    preferredMealPlanCode?: string | null;
    includeRestrictedForDisplay: boolean;
    checkInDate: Date;
    checkOutDate: Date;
    lengthOfStay: number;
    dateStamp: string;
    callbacks: StaahCandidateSelectionCallbacks;
  }): StaahCandidateSelectionResult {
    const {
      routeId,
      propertyId,
      hotel,
      rows,
      ratePlanRows,
      restrictionRowsByRateKey,
      preferredMealPlanCode,
      includeRestrictedForDisplay,
      checkInDate,
      checkOutDate,
      lengthOfStay,
      dateStamp,
      callbacks,
    } = input;

    let selected: StaahCandidateSelection | null = null;
    let selectedMatchedPreferred = false;
    let selectedReason = 'no valid rate';
    let best = Number.POSITIVE_INFINITY;
    const validDisplayCandidates: StaahCandidateSelection[] = [];
    const blockedDisplayCandidates: StaahCandidateSelection[] = [];

    for (const rate of rows) {
      const rateKey = `${rate.staah_property_id}|${rate.room_id}|${rate.rateplan_id}`;
      const rp = ratePlanRows.find(
        (x) =>
          String(x.staah_property_id) === String(rate.staah_property_id) &&
          String(x.rateplan_id) === String(rate.rateplan_id),
      );
      const roomId = String(rate.room_id || '');
      if (!callbacks.isAllowedRoom(propertyId, roomId)) {
        callbacks.warn?.(
          `[STAAH STALE ROOM SKIPPED IN RATE LOOP] routeId=${routeId} propertyId=${propertyId} roomId=${roomId}`,
        );
        continue;
      }

      const rateplanId = String(rate.rateplan_id || '');
      const rateplanName = String(rp?.rateplan_name || '').trim();
      const mealPlanDescription = String(rp?.meal_plan_description || '').trim();
      const candidatePrice = callbacks.calculatePrice(rate);
      const restrictionDecision = callbacks.evaluateRestrictions(rateKey);
      callbacks.debug?.(
        `[STAAH CANDIDATE] routeId=${routeId} propertyId=${propertyId} hotelId=${String(hotel.hotel_id || '')} roomId=${roomId} roomName="${callbacks.roomName(roomId)}" rateplanId=${rateplanId} rateplanName="${rateplanName}" mealPlan="${mealPlanDescription}" price=${candidatePrice} blocked=${restrictionDecision.blocked ? 'true' : 'false'} reason="${restrictionDecision.reason || ''}" availableAgainFrom=${restrictionDecision.availableAgainFrom || ''} searchReference=STAAH-${propertyId}-${roomId}-${rateplanId}-${dateStamp}`,
      );

      if (restrictionDecision.blocked) {
        selectedReason =
          restrictionDecision.reason || `restriction blocked rateplan ${String(rate.rateplan_id || '')}`;
        callbacks.warn?.(
          `[STAAH RESTRICTION] routeId=${routeId} propertyId=${propertyId} hotelId=${String(hotel.hotel_id || '')} roomId=${String(rate.room_id || '')} rateplanId=${String(rate.rateplan_id || '')} checkIn=${callbacks.formatDate(checkInDate)} checkOut=${callbacks.formatDate(checkOutDate)} los=${lengthOfStay} blocked=true reason="${selectedReason}"`,
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
        selectedReason = `no positive price for rateplan ${String(rate.rateplan_id || '')}`;
        continue;
      }

      validDisplayCandidates.push({ rate, rp, price });
      const preferredCode = String(preferredMealPlanCode || '').trim().toUpperCase();
      const preferredDef = preferredCode ? HOTEL_RATE_PLAN_BY_CODE.get(preferredCode as any) : undefined;
      const preferredIds = [
        String(preferredDef?.defaultRateplanId || ''),
        String(preferredDef?.externalRateplanId || ''),
      ].filter(Boolean);
      const mealText = `${String(rp?.rateplan_name || '')} ${String(rp?.meal_plan_description || '')}`.toLowerCase();
      const preferHit =
        Boolean(preferredCode) &&
        (preferredIds.includes(String(rate.rateplan_id || '')) ||
          mealText.includes(preferredCode.toLowerCase()));
      if (preferHit || price < best) {
        if (!selected || price < best) {
          selected = { rate, rp, price };
          best = price;
          selectedMatchedPreferred = Boolean(preferHit);
          selectedReason = preferHit
            ? `matched preferred meal plan ${preferredCode}`
            : 'selected cheapest valid rate';
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
      return (
        preferredIds.includes(String(candidate.rate.rateplan_id || '')) ||
        mealText.includes(preferredCode.toLowerCase())
      );
    });
    const cheapestBlocked = blockedDisplayCandidates.length
      ? [...blockedDisplayCandidates].sort((a, b) => {
          const priceA = Number.isFinite(Number(a.price)) && Number(a.price) > 0 ? Number(a.price) : Number.POSITIVE_INFINITY;
          const priceB = Number.isFinite(Number(b.price)) && Number(b.price) > 0 ? Number(b.price) : Number.POSITIVE_INFINITY;
          return priceA - priceB;
        })[0]
      : null;
    const blockedCandidate = preferredBlocked || cheapestBlocked || null;
    const shouldSurfaceBlockedPreferred =
      includeRestrictedForDisplay &&
      Boolean(blockedCandidate) &&
      (!selected || (Boolean(preferredCode) && Boolean(preferredBlocked) && !selectedMatchedPreferred));
    const shouldSurfaceBlockedVariant =
      includeRestrictedForDisplay && !preferredCode && Boolean(blockedCandidate) && Boolean(selected);

    callbacks.debug?.(
      `[STAAH DECISION] routeId=${routeId} propertyId=${propertyId} hotelId=${String(hotel.hotel_id || '')} selectedRoomId=${String(selected?.rate?.room_id || '')} selectedRateplanId=${String(selected?.rate?.rateplan_id || '')} selectedMealPlan="${String(selected?.rp?.meal_plan_description || selected?.rp?.rateplan_name || '').trim()}" selectedPrice=${Number(selected?.price || 0)} selectedMatchedPreferred=${selectedMatchedPreferred ? 'true' : 'false'} blockedCandidateRoomId=${String(blockedCandidate?.rate?.room_id || '')} blockedCandidateRateplanId=${String(blockedCandidate?.rate?.rateplan_id || '')} blockedCandidateMealPlan="${String(blockedCandidate?.rp?.meal_plan_description || blockedCandidate?.rp?.rateplan_name || '').trim()}" blockedCandidatePrice=${Number(blockedCandidate?.price || 0)} shouldSurfaceBlockedPreferred=${shouldSurfaceBlockedPreferred ? 'true' : 'false'} shouldSurfaceBlockedVariant=${shouldSurfaceBlockedVariant ? 'true' : 'false'} selectedReason="${selectedReason}"`,
    );

    return {
      selected,
      selectedMatchedPreferred,
      selectedReason,
      validDisplayCandidates,
      blockedDisplayCandidates,
      blockedCandidate,
      shouldSurfaceBlockedPreferred,
      shouldSurfaceBlockedVariant,
    };
  }
}
