import {
  resolveHotelSupplementPricing,
  resolveOfflineHotelPayablePricing,
} from './hotel-selection-pricing.util';
import { normalizeOfflineMealBreakdown } from './offline-hotel-meal-plan.util';

const money = (value: unknown): number => {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
};

const positive = (...values: unknown[]): number => {
  for (const value of values) {
    const amount = money(value);
    if (amount > 0) return amount;
  }
  return 0;
};

export interface StoredHotelPayablePricingInput {
  storedTotal?: unknown;
  baseTotal?: unknown;
  marginAmount?: unknown;
  marginPercentage?: unknown;
  taxAmount?: unknown;
  /** Use the persisted component breakdown as the source of truth. */
  preferCalculatedTotal?: boolean;
}

export interface HotelRouteNightPayableInput {
  marginBaseAmount?: unknown;
  marginPercentage?: unknown;
  fallbackMarginAmount?: unknown;
  taxAmount?: unknown;
  billingMultiplier?: unknown;
}

export interface HotelRouteNightPayableSourceInput {
  provider?: unknown;
  hasContinuousStayRouteNight?: boolean;
  marginBaseAmount?: unknown;
}

export interface SelectedHotelAmountInput {
  selectedRateTotal?: unknown;
  fallbackHotelAmount?: unknown;
  mealPlanCost?: unknown;
  selectedMealPlanCost?: unknown;
  tboMapFallbackDinnerCost?: unknown;
}

/**
 * Read an ordinary MAP/meal-plan amount from a component-priced hotel row.
 * TBO/VSR fares already include their supplier meal amount, so only the
 * database-priced providers may contribute this separate supplement.
 */
export function resolveOrdinaryMealPlanCost(option: Record<string, any> | null | undefined): number {
  const provider = String(
    option?.provider ?? option?.hotel_provider ?? '',
  ).trim().toLowerCase();
  if (!['offline', 'axisrooms'].includes(provider)) return 0;
  if (option?.tboMapFallbackApplied === true) return 0;
  const breakdown = normalizeOfflineMealBreakdown(option?.mealPlanBreakdown);
  return positive(
    breakdown?.totalMealPlanCost,
    option?.total_hotel_meal_plan_cost,
    option?.totalHotelMealPlanCost,
    option?.hotelMealPlanCost,
    option?.mealPlanCost,
    breakdown?.totalDinnerCost,
  );
}

/**
 * Resolve the ordinary meal-plan amount for one physical itinerary night.
 * Continuous offline stays can persist both an aggregate meal breakdown and
 * a per-night breakdown; row totals must use the matching nightly amount.
 */
export function resolveOrdinaryMealPlanCostForNight(input: {
  provider?: unknown;
  mealPlanBreakdown?: unknown;
  nightlyMealPlanBreakdown?: unknown;
  nightlyRates?: unknown;
  nightIndex?: number;
  routeDate?: unknown;
  totalHotelMealPlanCost?: unknown;
  hotelMealPlanCost?: unknown;
  mealPlanCost?: unknown;
  divideAggregateAcrossNights?: boolean;
  tboMapFallbackApplied?: boolean;
}): number {
  const nightlyMealPlanBreakdown = Array.isArray(input.nightlyMealPlanBreakdown)
    ? input.nightlyMealPlanBreakdown
    : [];
  const nightlyRates = Array.isArray(input.nightlyRates) ? input.nightlyRates : [];
  const routeDate = String(input.routeDate ?? '').slice(0, 10);
  const rateIndex = nightlyRates.findIndex((rate: any) =>
    String(rate?.date || rate?.itineraryRouteDate || '').slice(0, 10) === routeDate,
  );
  const nightIndex = Number.isInteger(input.nightIndex) && Number(input.nightIndex) >= 0
    ? Number(input.nightIndex)
    : rateIndex >= 0
      ? rateIndex
      : nightlyMealPlanBreakdown.length === 1
        ? 0
        : -1;
  const nightlyBreakdown = nightIndex >= 0
    ? nightlyMealPlanBreakdown[nightIndex]
    : undefined;

  if (nightlyBreakdown && typeof nightlyBreakdown === 'object') {
    return resolveOrdinaryMealPlanCost({
      ...input,
      mealPlanBreakdown: nightlyBreakdown,
    });
  }

  const aggregate = resolveOrdinaryMealPlanCost(input);
  return input.divideAggregateAcrossNights && nightlyRates.length > 1
    ? money(aggregate / nightlyRates.length)
    : aggregate;
}

/**
 * Reconcile a selected snapshot total with ordinary meal-plan charges.
 *
 * Selected snapshot totals contain the room/tax/margin components. Ordinary
 * MAP is persisted separately on the legacy hotel rows, while the TBO MAP
 * fallback is already part of the supplier payable total and must not be
 * added a second time.
 */
export function resolveSelectedHotelAmount(input: SelectedHotelAmountInput): number {
  const selectedRateTotal = money(input.selectedRateTotal);
  if (selectedRateTotal <= 0) return money(input.fallbackHotelAmount);

  const selectedMealPlanCost = money(input.selectedMealPlanCost);
  const ordinaryMealPlanCost = selectedMealPlanCost > 0
    ? selectedMealPlanCost
    : Math.max(
        money(input.mealPlanCost) - money(input.tboMapFallbackDinnerCost),
        0,
      );
  return money(selectedRateTotal + ordinaryMealPlanCost);
}

/**
 * Decide whether a route-night payable should be rebuilt from the API's
 * component breakdown. Database-priced rows can be route-night snapshots
 * without a nightlyRates array, so continuousStayRouteNight alone is not a
 * sufficient signal for them.
 */
export function shouldReconcileHotelRouteNightPayable(
  input: HotelRouteNightPayableSourceInput,
): boolean {
  if (input.hasContinuousStayRouteNight === true) return true;

  const provider = String(input.provider ?? '').trim().toLowerCase();
  const isDatabasePricedProvider = provider === 'offline' || provider === 'axisrooms';
  return isDatabasePricedProvider && money(input.marginBaseAmount) > 0;
}

/** Calculate the payable amount for one physical hotel night. */
export function calculateHotelRouteNightPayable(input: HotelRouteNightPayableInput): number {
  const marginBaseAmount = money(input.marginBaseAmount);
  const marginPercentage = Math.max(Number(input.marginPercentage || 0), 0);
  const marginAmount = marginPercentage > 0
    ? money((marginBaseAmount * marginPercentage) / 100)
    : money(input.fallbackMarginAmount);
  const billingMultiplier = Math.max(Number(input.billingMultiplier || 1), 1);
  const taxAmount = money(input.taxAmount) * billingMultiplier;

  return money(marginBaseAmount + marginAmount + taxAmount);
}

/** Normalize legacy persisted rows to the margin-inclusive payable amount. */
export function resolveStoredHotelPayablePricing(input: StoredHotelPayablePricingInput) {
  const storedTotal = money(input.storedTotal);
  const baseTotal = money(input.baseTotal);
  const explicitMargin = money(input.marginAmount);
  const marginPercentage = Math.max(Number(input.marginPercentage || 0), 0);
  const calculatedMargin = explicitMargin > 0
    ? explicitMargin
    : money((baseTotal * marginPercentage) / 100);
  const taxAmount = money(input.taxAmount);
  const calculatedTotal = money(baseTotal + calculatedMargin + taxAmount);
  // Component-priced providers must not retain a stale, larger selected total;
  // that makes the displayed room/supplement breakdown disagree with the
  // amount used in the itinerary total. Complete-fare providers continue to
  // use the stored supplier total through the default legacy behavior.
  const payableTotal = input.preferCalculatedTotal
    ? calculatedTotal
    : Math.max(storedTotal, calculatedTotal);

  return {
    baseTotal,
    marginAmount: calculatedMargin,
    payableTotal: money(payableTotal),
    marginPercentage: marginPercentage > 0
      ? marginPercentage
      : baseTotal > 0 && calculatedMargin > 0
        ? money((calculatedMargin / baseTotal) * 100)
        : 0,
  };
}

/**
 * Convert one supplier option from base cost to the authoritative payable
 * amount. The marker makes the operation idempotent so snapshot refresh,
 * preview, and persistence can safely share the same projection.
 */
export function projectHotelPayablePricing<T extends Record<string, any>>(
  option: T,
  effectiveMarginPercentage: number,
): T {
  const alreadyProjected = option?.amountIncludesHotelMargin === true ||
    option?.pricingIncludesHotelMargin === true;
  const configuredMargin = Math.max(Number(effectiveMarginPercentage || 0), 0);
  const existingMargin = Math.max(Number(option?.hotelMarginPercentage ?? option?.marginPercentage ?? 0), 0);
  const marginPercentage = existingMargin > 0 ? existingMargin : configuredMargin;
  const payableBeforeProjection = positive(
    option?.totalHotelCost,
    option?.totalAmountAfterTax,
    option?.totalStayPrice,
    option?.totalPrice,
    option?.totalAmount,
    option?.price,
    option?.pricePerNight,
  );
  const provider = String(option?.provider || option?.hotel_provider || '').trim().toLowerCase();
  const isCompleteFareProvider = provider === 'tbo' || provider === 'vsr';
  const componentRoomTotal = positive(option?.totalRoomCost, option?.total_room_cost);
  const explicitBaseTotal = positive(
    // Component-priced providers expose totalRoomCost as the room-only DB
    // amount. Prefer it over a stale aggregate baseTotalPrice, which may
    // already contain supplements or a previous payable total.
    !isCompleteFareProvider ? componentRoomTotal : 0,
    option?.baseTotalPrice,
    option?.baseStayPrice,
    option?.baseHotelCost,
    option?.baseAmount,
    isCompleteFareProvider ? componentRoomTotal : 0,
  );
  const roomCount = Math.max(
    Number(option?.total_no_of_rooms ?? option?.noOfRooms ?? option?.roomCount ?? 1),
    1,
  );
  // Legacy TBO/VSR snapshots can contain only the margin-inclusive payable
  // amount. Once a row is marked as projected, treating that payable value as
  // the base would calculate the margin twice and make the tooltip show an
  // inconsistent Total/Margin/Grand Total. Recover the supplier base from
  // the authoritative payable amount when the margin percentage is available.
  const inferredProjectedBase = alreadyProjected && explicitBaseTotal <= 0 &&
    marginPercentage > 0 && payableBeforeProjection > 0
    ? money(payableBeforeProjection / (1 + marginPercentage / 100))
    : 0;
  const baseTotal = explicitBaseTotal > 0
    ? explicitBaseTotal
    : inferredProjectedBase > 0
      ? inferredProjectedBase
      : positive(option?.basePricePerNight, alreadyProjected ? 0 : payableBeforeProjection);
  const rawBasePerNight = positive(
    option?.basePricePerNight,
    option?.baseAmountPerNight,
    baseTotal,
  );
  const basePerNight = explicitBaseTotal > 0 && roomCount > 1 &&
    Math.abs(rawBasePerNight - explicitBaseTotal) < 0.01
    ? money(explicitBaseTotal / roomCount)
    : rawBasePerNight;
  const extraBedPricing = resolveHotelSupplementPricing({
    count: option?.extraBedCount ?? option?.extra_bed_count ?? option?.total_extra_bed ?? option?.room_extra_bed_count,
    rate: option?.extraBedRate ?? option?.extra_bed_rate ?? option?.room_extra_bed_rate,
    amount: option?.extraBedAmount ?? option?.extra_bed_amount,
    cost: option?.extraBedCost ?? option?.totalExtraBedCost ?? option?.total_extra_bed_cost,
  });
  const childWithBedPricing = resolveHotelSupplementPricing({
    count: option?.childWithBedCount ?? option?.child_with_bed_count ?? option?.total_child_with_bed ?? option?.room_cwb_count,
    rate: option?.childWithBedRate ?? option?.child_with_bed_rate,
    amount: option?.childWithBedAmount ?? option?.child_with_bed_amount,
    cost: option?.childWithBedCost ?? option?.totalChildWithBedCost ?? option?.total_childwith_bed_cost,
  });
  const childWithoutBedPricing = resolveHotelSupplementPricing({
    count: option?.childWithoutBedCount ?? option?.child_without_bed_count ?? option?.total_child_without_bed ?? option?.room_cnb_count,
    rate: option?.childWithoutBedRate ?? option?.child_without_bed_rate,
    amount: option?.childWithoutBedAmount ?? option?.child_without_bed_amount,
    cost: option?.childWithoutBedCost ?? option?.totalChildWithoutBedCost ?? option?.total_childwithout_bed_cost ?? option?.extraChildAmount ?? option?.extra_child_amount,
  });
  const extraSupplementTotal = money(
    extraBedPricing.amount + childWithBedPricing.amount + childWithoutBedPricing.amount,
  );
  const numberOfNights = Math.max(Number(option?.numberOfNights ?? option?.nights ?? 1), 1);
  const tboMapFallbackDinnerTotal = option?.tboMapFallbackApplied === true
    ? positive(option?.tboMapFallbackDinnerTotal, option?.hotelMealPlanCost, option?.totalHotelMealPlanCost)
    : 0;
  const tboMapFallbackDinnerPerNight = option?.tboMapFallbackApplied === true
    ? positive(
        option?.tboMapFallbackDinnerPerNight,
        tboMapFallbackDinnerTotal > 0 ? tboMapFallbackDinnerTotal / numberOfNights : 0,
      )
    : 0;
  const ordinaryMealPlanTotal = resolveOrdinaryMealPlanCost(option);
  const offlinePricing = ['offline', 'axisrooms'].includes(provider)
    ? resolveOfflineHotelPayablePricing({
        baseTotalPrice: baseTotal,
        extraBedAmount: extraBedPricing.amount,
        childWithBedAmount: childWithBedPricing.amount,
        childWithoutBedAmount: childWithoutBedPricing.amount,
        mealPlanCost: ordinaryMealPlanTotal,
        marginPercentage,
        taxAmount: option?.totalHotelTaxAmount ?? option?.total_hotel_tax_amount,
      })
    : null;
  const supplementTotal = money(extraSupplementTotal + tboMapFallbackDinnerTotal + ordinaryMealPlanTotal);
  // MAP/meal-plan food is a payable supplement, not a hotel-marginable
  // occupancy charge. Keep it in the displayed subtotal and final payable,
  // but calculate the margin from room and occupancy components only.
  const marginableSupplementTotal = money(extraSupplementTotal + ordinaryMealPlanTotal);
  const marginableSupplementPerNight = money(
    (extraSupplementTotal + ordinaryMealPlanTotal) / numberOfNights,
  );
  const marginableBaseTotal = money(baseTotal + marginableSupplementTotal);
  const subtotalTotal = offlinePricing
    ? offlinePricing.subtotal
    : money(marginableBaseTotal + tboMapFallbackDinnerTotal);
  const marginBaseTotal = subtotalTotal;
  const marginBasePerNight = money(basePerNight + marginableSupplementPerNight);
  const marginTotal = offlinePricing
    ? offlinePricing.marginAmount
    : alreadyProjected
    ? marginPercentage > 0
      ? money((marginableBaseTotal * marginPercentage) / 100)
      : positive(option?.hotelMarginTotalAmount, option?.hotelMarginStayAmount, option?.hotelMarginAmount)
    : money((marginableBaseTotal * marginPercentage) / 100);
  const marginPerNight = offlinePricing
    ? money(offlinePricing.marginAmount / numberOfNights)
    : alreadyProjected
    ? marginPercentage > 0
      ? money((marginBasePerNight * marginPercentage) / 100)
      : positive(option?.hotelMarginAmount, marginTotal)
    : money((marginBasePerNight * marginPercentage) / 100);
  const reconstructedPayableTotal = offlinePricing
    ? offlinePricing.totalPrice
    : money(subtotalTotal + marginTotal);
  const reconstructedPayablePerNight = offlinePricing
    ? money(offlinePricing.totalPrice / numberOfNights)
    : money(marginBasePerNight + marginPerNight);
  const payableTotal = alreadyProjected
    ? Math.max(payableBeforeProjection, reconstructedPayableTotal)
    : reconstructedPayableTotal;
  const payablePerNight = alreadyProjected
    ? Math.max(
        positive(option?.pricePerNight, option?.price, payableTotal),
        reconstructedPayablePerNight,
      )
    : reconstructedPayablePerNight;

  const projected = {
    ...option,
    basePricePerNight: basePerNight,
    baseTotalPrice: baseTotal,
    // Canonical room pricing is provider-neutral: the room rate is one
    // room's pure charge for one physical night, while totalRoomCost is the
    // room-only amount for the requested room count.  Supplier-specific
    // adapters may already provide these values, but legacy TBO/VSR rows do
    // not, so normalize them here instead of making React infer them.
    roomRate: positive(option?.roomRate, option?.room_rate, basePerNight),
    totalRoomCost: positive(option?.totalRoomCost, option?.total_room_cost, baseTotal),
    extraBedCount: extraBedPricing.count,
    extraBedRate: extraBedPricing.rate,
    extraBedAmount: extraBedPricing.amount,
    totalExtraBedCost: extraBedPricing.amount,
    childWithBedCount: childWithBedPricing.count,
    childWithBedRate: childWithBedPricing.rate,
    childWithBedAmount: childWithBedPricing.amount,
    totalChildWithBedCost: childWithBedPricing.amount,
    childWithoutBedCount: childWithoutBedPricing.count,
    childWithoutBedRate: childWithoutBedPricing.rate,
    childWithoutBedAmount: childWithoutBedPricing.amount,
    totalChildWithoutBedCost: childWithoutBedPricing.amount,
    hotelMarginPercentage: marginPercentage,
    hotelMarginAmount: marginPerNight,
    hotelMarginStayAmount: marginTotal,
    hotelMarginTotalAmount: marginTotal,
    hotelMarginBaseAmount: offlinePricing?.subtotal ?? marginBaseTotal,
    price: payablePerNight,
    pricePerNight: payablePerNight,
    totalPrice: payableTotal,
    totalStayPrice: payableTotal,
    totalHotelCost: payableTotal,
    totalAmount: payableTotal,
    totalAmountAfterTax: payableTotal,
    hotelMealPlanCost: tboMapFallbackDinnerTotal > 0
      ? tboMapFallbackDinnerTotal
      : ordinaryMealPlanTotal,
    totalHotelMealPlanCost: tboMapFallbackDinnerTotal > 0
      ? tboMapFallbackDinnerTotal
      : ordinaryMealPlanTotal,
    tboMapFallbackDinnerTotal,
    tboMapFallbackDinnerPerNight,
    amountIncludesHotelMargin: true,
    pricingIncludesHotelMargin: true,
  } as T;

  // Persisted selected rows expose a second price surface that the itinerary
  // table uses in preference to the generic total fields. Keep it aligned
  // with the projected payable amount; otherwise the card/tooltip can show
  // margin-inclusive pricing while the table still renders the old base rate.
  if (option?.isSelected === true || String(option?.selectionOrigin || '').trim()) {
    (projected as any).selectedTotalPrice = payableTotal;
    (projected as any).selected_total_price = payableTotal;
    (projected as any).selectedPricePerNight = payablePerNight;
    (projected as any).selected_price_per_night = payablePerNight;
  }

  if (Array.isArray(option?.rateOptions)) {
    (projected as any).rateOptions = option.rateOptions.map((rateOption: Record<string, any>) =>
      projectHotelPayablePricing({
        ...rateOption,
        provider: rateOption.provider || option.provider,
        hotelId: rateOption.hotelId || option.hotelId,
        canonicalHotelId: rateOption.canonicalHotelId || option.canonicalHotelId,
        hotelCode: rateOption.hotelCode || option.hotelCode,
      }, marginPercentage),
    );
  }

  return projected;
}
