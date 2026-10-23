import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../../hotels/hotel-rate-plans';

export type TboMapFallbackConfig = {
  enabled: boolean;
  showEpHotels?: boolean;
  showHobseEpHotels?: boolean;
  dinnerRate3Star: number;
  dinnerRate4Star: number;
  dinnerRate5Star: number;
  lunchRate3Star: number;
  lunchRate4Star: number;
  lunchRate5Star: number;
};

export type TboMapFallbackContext = {
  preferredMealPlanCode?: string | null;
  adultCount: number;
  childCount: number;
  roomCount: number;
  numberOfNights?: number;
};

type TboFallbackMealPlan = 'MAP' | 'AP';

const positive = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

const money = (value: number): number => Number(Math.max(value, 0).toFixed(2));

const mealPlanCode = (value: unknown): string =>
  inferCanonicalHotelRatePlanCode(String(value ?? '')) ||
  inferCanonicalHotelRatePlanCodeFromMealText(String(value ?? '')) ||
  '';

const isMap = (option: any): boolean =>
  mealPlanCode(option?.mealPlanCode || option?.mealPlan || option?.ratePlanName) === 'MAP';

const isAp = (option: any): boolean =>
  mealPlanCode(option?.mealPlanCode || option?.mealPlan || option?.ratePlanName) === 'AP';

const isCp = (option: any): boolean =>
  mealPlanCode(option?.mealPlanCode || option?.mealPlan || option?.ratePlanName) === 'CP';

const optionIdentity = (option: any): string => String(
  option?.rateOptionId ||
  option?.rate_option_id ||
  option?.optionKey ||
  option?.option_key ||
  option?.searchReference ||
  option?.search_reference ||
  option?.bookingCode ||
  option?.booking_code ||
  option?.selectionKey ||
  'tbo-rate',
).trim();

export const getTboMapFallbackDinnerRate = (
  starRating: unknown,
  config: TboMapFallbackConfig,
): number => {
  if (!config.enabled) return 0;
  const stars = Number(starRating);
  if (!Number.isFinite(stars)) return 0;
  if (stars >= 5) return Math.max(Number(config.dinnerRate5Star || 0), 0);
  if (stars >= 4) return Math.max(Number(config.dinnerRate4Star || 0), 0);
  if (stars >= 3) return Math.max(Number(config.dinnerRate3Star || 0), 0);
  return 0;
};

export const getTboMapFallbackLunchRate = (
  starRating: unknown,
  config: TboMapFallbackConfig,
): number => {
  if (!config.enabled) return 0;
  const stars = Number(starRating);
  if (!Number.isFinite(stars)) return 0;
  if (stars >= 5) return Math.max(Number(config.lunchRate5Star || 0), 0);
  if (stars >= 4) return Math.max(Number(config.lunchRate4Star || 0), 0);
  if (stars >= 3) return Math.max(Number(config.lunchRate3Star || 0), 0);
  return 0;
};

const nightsFor = (option: any, context: TboMapFallbackContext): number => Math.max(
  Number(option?.numberOfNights || option?.nights || option?.stayNights || 0),
  Number(Array.isArray(option?.routeIds) ? option.routeIds.length : 0),
  Number(context.numberOfNights || 0),
  1,
);

const createFallbackOption = (
  source: any,
  context: TboMapFallbackContext,
  config: TboMapFallbackConfig,
): any => {
  const dinnerRate = getTboMapFallbackDinnerRate(source?.rating ?? source?.category, config);
  const configuredLunchRate = getTboMapFallbackLunchRate(source?.rating ?? source?.category, config);
  const targetMealPlan = mealPlanCode(context.preferredMealPlanCode) as TboFallbackMealPlan;
  const provider = String(source?.provider || source?.hotel_provider || '').trim().toLowerCase();
  if (
    !dinnerRate ||
    !isCp(source) ||
    source?.tboMapFallbackApplied === true ||
    !['MAP', 'AP'].includes(targetMealPlan) ||
    (targetMealPlan === 'AP' && !['tbo', 'vsr'].includes(provider))
  ) return null;

  const guests = Math.max(Number(context.adultCount || 0), 0) + Math.max(Number(context.childCount || 0), 0);
  const chargeableGuests = Math.max(guests, 1);
  const nights = nightsFor(source, context);
  const baseTotal = positive(
    source?.baseTotalPrice,
    source?.totalStayPrice,
    source?.totalPrice,
    source?.totalFare,
    source?.netAmount,
    source?.price,
  );
  if (!baseTotal) return null;

  const basePerNight = positive(
    source?.basePricePerNight,
    source?.pricePerNight,
    source?.perNightAmount,
  ) || money(baseTotal / nights);
  const dinnerPerNight = money(chargeableGuests * dinnerRate);
  const dinnerTotal = money(dinnerPerNight * nights);
  const lunchRate = targetMealPlan === 'AP' ? configuredLunchRate : 0;
  const lunchPerNight = targetMealPlan === 'AP' ? money(chargeableGuests * lunchRate) : 0;
  const lunchTotal = targetMealPlan === 'AP' ? money(lunchPerNight * nights) : 0;
  const mealPlanTotal = money(lunchTotal + dinnerTotal);
  const total = money(baseTotal + mealPlanTotal);
  const perNight = money(basePerNight + money(lunchPerNight + dinnerPerNight));
  const identity = optionIdentity(source);
  const fallbackIdentity = `${identity}:${targetMealPlan}_FALLBACK`;

  return {
    ...source,
    rateOptionId: fallbackIdentity,
    optionKey: fallbackIdentity,
    selectionKey: `${String(source?.selectionKey || identity)}:${targetMealPlan}_FALLBACK`,
    mealPlan: targetMealPlan,
    mealPlanCode: targetMealPlan,
    ratePlanName: targetMealPlan,
    supplierMealPlan: 'CP',
    tboMapFallbackApplied: true,
    tboMapFallbackSourceMealPlan: 'CP',
    tboMapFallbackTargetMealPlan: targetMealPlan,
    tboMapFallbackLunchRate: lunchRate,
    tboMapFallbackLunchPerPerson: lunchRate,
    tboMapFallbackLunchPerNight: lunchPerNight,
    tboMapFallbackLunchTotal: lunchTotal,
    tboMapFallbackDinnerComponentPerNight: dinnerPerNight,
    tboMapFallbackDinnerComponentTotal: dinnerTotal,
    tboMapFallbackDinnerRate: dinnerRate,
    tboMapFallbackDinnerPerPerson: dinnerRate,
    // Existing payable-price consumers use these legacy fields as the total
    // fallback supplement. Keep that contract for MAP and AP alike; AP's
    // actual dinner component remains available in the explicit component
    // fields below for the tooltip and overall-cost explanation.
    tboMapFallbackDinnerPerNight: targetMealPlan === 'AP'
      ? money(lunchPerNight + dinnerPerNight)
      : dinnerPerNight,
    tboMapFallbackDinnerTotal: mealPlanTotal,
    tboMapFallbackMealPlanTotal: mealPlanTotal,
    hotelMealPlanCost: mealPlanTotal,
    totalHotelMealPlanCost: mealPlanTotal,
    basePricePerNight: basePerNight,
    baseTotalPrice: baseTotal,
    price: total,
    netAmount: total,
    totalFare: total,
    pricePerNight: perNight,
    totalStayPrice: total,
    totalPrice: total,
    totalAmount: total,
    totalAmountAfterTax: total,
    roomTypes: Array.isArray(source?.roomTypes)
      ? source.roomTypes.map((roomType: any) => ({ ...roomType, price: total }))
      : source?.roomTypes,
    inclusions: Array.from(new Set([
      ...(Array.isArray(source?.inclusions) ? source.inclusions : []),
      ...(targetMealPlan === 'AP' ? ['Lunch'] : []),
      'Dinner',
    ])),
  };
};

const containsRealMap = (row: any): boolean => {
  if (isMap(row)) return true;
  return Array.isArray(row?.rateOptions) && row.rateOptions.some(isMap);
};

const containsCp = (row: any): boolean => {
  if (isCp(row)) return true;
  return Array.isArray(row?.rateOptions) && row.rateOptions.some(isCp);
};

const propertyKey = (row: any): string => [
  String(row?.provider || row?.hotel_provider || '').trim().toLowerCase(),
  String(row?.providerHotelCode || row?.hotelCode || row?.hotelId || '').trim().toLowerCase(),
  String(row?.hotelName || '').trim().toLowerCase(),
].join('|');

const isEp = (option: any): boolean =>
  mealPlanCode(option?.mealPlanCode || option?.mealPlan || option?.ratePlanName) === 'EP';

/** Remove EP options before recommendations and selection are calculated. */
export function filterEpRows<T extends Record<string, any>>(
  rows: T[],
  showEpHotels = false,
): T[] {
  if (showEpHotels) return rows;
  return rows.flatMap((row) => {
    const options = Array.isArray(row?.rateOptions) ? row.rateOptions : [];
    if (options.length > 0) {
      const retainedOptions = options.filter((option: any) => !isEp(option));
      return retainedOptions.length > 0 ? [{ ...row, rateOptions: retainedOptions }] : [];
    }
    return isEp(row) ? [] : [row];
  });
}

/**
 * Normalize the visible options for a MAP/AP request. A supplier's real
 * requested-plan rate is retained unchanged. A CP-only property remains
 * visible, but its CP rate is replaced by a synthetic option with the
 * configured meal supplement. AP uses the configured lunch rate once and the
 * configured dinner rate once.
 * This keeps raw CP/AP/EP options out of a MAP selection flow.
 *
 * The returned option retains the supplier's CP booking/search identity. The
 * synthetic identity is only used to distinguish the commercial MAP option
 * in the availability snapshot and selection workflow.
 */
export function applyMapDinnerFallbackToRows<T extends Record<string, any>>(
  rows: T[],
  context: TboMapFallbackContext,
  config: TboMapFallbackConfig,
  preserveSupplierOptions = false,
): T[] {
  const preferred = mealPlanCode(context.preferredMealPlanCode);
  if (!config.enabled || !['MAP', 'AP'].includes(preferred)) return rows;

  const cpProperties = new Set(
    rows.filter(containsCp).map(propertyKey),
  );
  const realPlanProperties = new Set(rows.filter((row) => preferred === 'MAP'
    ? containsRealMap(row)
    : Array.isArray(row?.rateOptions)
      ? row.rateOptions.some(isAp)
      : isAp(row)).map(propertyKey));

return rows.flatMap((row) => {
  const key = propertyKey(row);
  const options = Array.isArray(row?.rateOptions) ? row.rateOptions : [];

  // Editing an existing hotel must expose the supplier's original rate
  // options. The regular recommendation flow must remain unchanged.
  if (preserveSupplierOptions) {
    // Real supplier MAP rates and other supplier plans are already present.
    if (realPlanProperties.has(key) || !cpProperties.has(key)) {
      return [row];
    }

    // CP-only property with nested room/rate options:
    // keep the original CP options and add the existing MAP fallback.
    if (options.length > 0) {
      const fallbackOptions = options
        .filter(isCp)
        .map((option: any) =>
          createFallbackOption(
            { ...row, ...option },
            context,
            config,
          ),
        )
        .filter(Boolean)
        .map((option: any) => ({
          ...option,
          hotelCode: option.hotelCode || row.hotelCode,
          providerHotelCode:
            option.providerHotelCode || row.providerHotelCode,
        }));

      return [{
        ...row,
        rateOptions: [
          ...options,
          ...fallbackOptions,
        ],
      }];
    }

    // CP-only property represented as a flat supplier row.
    const fallback = createFallbackOption(row, context, config);

    return fallback ? [row, fallback] : [row];
  }

  // Existing MAP recommendation behavior remains unchanged.
  if (options.length > 0) {
      if (realPlanProperties.has(key)) {
        const planOptions = options.filter(preferred === 'MAP' ? isMap : isAp);
        return planOptions.length > 0 ? [{ ...row, rateOptions: planOptions }] : [];
      }

      if (!cpProperties.has(key)) return [];

      const fallbackOptions = options
        .filter(isCp)
        .map((option: any) => createFallbackOption({ ...row, ...option }, context, config))
        .filter(Boolean)
        .map((option: any) => ({
          ...option,
          // Keep the parent row's rate identity out of the nested synthetic
          // option; its supplier booking identity remains on the option.
          hotelCode: option.hotelCode || row.hotelCode,
          providerHotelCode: option.providerHotelCode || row.providerHotelCode,
        }));
      return fallbackOptions.length > 0
        ? [{ ...row, rateOptions: fallbackOptions }]
        : [];
    }

    if (realPlanProperties.has(key)) return (preferred === 'MAP' ? isMap(row) : isAp(row)) ? [row] : [];
    if (!cpProperties.has(key)) return [];

    const fallback = createFallbackOption(row, context, config);
    return fallback ? [fallback] : [];
  });
}

/** Backwards-compatible export for existing TBO call sites. */
export const applyTboMapFallbackToRows = applyMapDinnerFallbackToRows;
