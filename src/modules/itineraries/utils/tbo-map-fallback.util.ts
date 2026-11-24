import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../../hotels/hotel-rate-plans';
import { getTboBatchSearchTotal, isFreshTboMultiBatchStay, makeTboMultiBatchStay, priceTboMultiBatchStay, type TboMultiBatchStaySnapshot, type TboStayBatch, type TboStayMealSupplement } from '../../hotels/utils/tbo-multi-batch-stay.util';

export type TboMapFallbackConfig = {
  enabled: boolean;
  showEpHotels?: boolean;
  showHobseEpHotels?: boolean;
  breakfastRate?: number;
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

type TboFallbackMealPlan = 'CP' | 'MAP' | 'AP';

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

const isEp = (option: any): boolean =>
  mealPlanCode(option?.mealPlanCode || option?.mealPlan || option?.ratePlanName) === 'EP';

/** Keep supplier EP rates available as source data only for CP/MAP fallback. */
export const isEpFallbackSourceForMealPlan = (requested: unknown, source: unknown): boolean =>
  ['CP', 'MAP'].includes(mealPlanCode(requested)) && mealPlanCode(source) === 'EP';

export const shouldKeepSupplierRateForMealPlan = (
  requested: unknown,
  actual: unknown,
  preserveMealPlanFallbackSource = false,
): boolean => {
  const requestedCode = mealPlanCode(requested);
  const actualCode = mealPlanCode(actual);
  return !requestedCode || requestedCode === actualCode ||
    (preserveMealPlanFallbackSource && (
      isEpFallbackSourceForMealPlan(requestedCode, actualCode) ||
      (requestedCode === 'MAP' && actualCode === 'CP')
    ));
};

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
  const breakfastRate = Math.max(Number(config.breakfastRate ?? 400), 0);
  const dinnerRate = getTboMapFallbackDinnerRate(source?.rating ?? source?.category, config);
  const configuredLunchRate = getTboMapFallbackLunchRate(source?.rating ?? source?.category, config);
  const targetMealPlan = mealPlanCode(context.preferredMealPlanCode) as TboFallbackMealPlan;
  const sourceMealPlan = isEp(source) ? 'EP' : isCp(source) ? 'CP' : '';
  const provider = String(source?.provider || source?.hotel_provider || '').trim().toLowerCase();
  const isEpFallback = sourceMealPlan === 'EP';
  if (
    (isEpFallback
      ? (!['tbo', 'vsr'].includes(provider) || !['CP', 'MAP'].includes(targetMealPlan))
      : (!dinnerRate || sourceMealPlan !== 'CP' || targetMealPlan === 'CP')) ||
    source?.tboMapFallbackApplied === true ||
    !['CP', 'MAP', 'AP'].includes(targetMealPlan) ||
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
  const fallbackBreakfastRate = isEpFallback ? breakfastRate : 0;
  const breakfastPerNight = money(chargeableGuests * fallbackBreakfastRate);
  const breakfastTotal = money(breakfastPerNight * nights);
  const includeDinner = targetMealPlan === 'MAP' || targetMealPlan === 'AP';
  const effectiveDinnerRate = includeDinner ? dinnerRate : 0;
  const dinnerPerNight = money(chargeableGuests * effectiveDinnerRate);
  const dinnerTotal = money(dinnerPerNight * nights);
  const lunchRate = targetMealPlan === 'AP' ? configuredLunchRate : 0;
  const lunchPerNight = targetMealPlan === 'AP' ? money(chargeableGuests * lunchRate) : 0;
  const lunchTotal = targetMealPlan === 'AP' ? money(lunchPerNight * nights) : 0;
  const mealPlanTotal = money(breakfastTotal + lunchTotal + dinnerTotal);
  const total = money(baseTotal + mealPlanTotal);
  const perNight = money(basePerNight + money(breakfastPerNight + lunchPerNight + dinnerPerNight));
  const tboRoomNightBreakdown = Array.isArray(source?.tboRoomNightBreakdown)
    ? source.tboRoomNightBreakdown.map((item: any) => {
        const roomGuests = Math.max(Number(item?.adults || 0), 0) + Math.max(Number(item?.children || 0), 0);
        const breakfastAmount = money(roomGuests * fallbackBreakfastRate);
        const lunchAmount = money(roomGuests * lunchRate);
        const dinnerAmount = money(roomGuests * effectiveDinnerRate);
        const fallbackMealPlanAmount = money(breakfastAmount + lunchAmount + dinnerAmount);
        const baseAmount = money(item?.allInAmount || 0);
        return {
          ...item,
          fallbackBreakfastAmount: breakfastAmount,
          fallbackLunchAmount: lunchAmount,
          fallbackDinnerAmount: dinnerAmount,
          fallbackMealPlanAmount,
          payableAmount: money(baseAmount + fallbackMealPlanAmount),
        };
      })
    : undefined;
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
    supplierMealPlan: sourceMealPlan,
    tboMapFallbackApplied: true,
    tboMapFallbackSourceMealPlan: sourceMealPlan,
    tboMapFallbackTargetMealPlan: targetMealPlan,
    tboMapFallbackBreakfastRate: fallbackBreakfastRate,
    tboMapFallbackBreakfastPerPerson: fallbackBreakfastRate,
    tboMapFallbackBreakfastPerNight: breakfastPerNight,
    tboMapFallbackBreakfastTotal: breakfastTotal,
    tboMapFallbackLunchRate: lunchRate,
    tboMapFallbackLunchPerPerson: lunchRate,
    tboMapFallbackLunchPerNight: lunchPerNight,
    tboMapFallbackLunchTotal: lunchTotal,
    tboMapFallbackDinnerComponentPerNight: dinnerPerNight,
    tboMapFallbackDinnerComponentTotal: dinnerTotal,
    tboMapFallbackDinnerRate: effectiveDinnerRate,
    tboMapFallbackDinnerPerPerson: effectiveDinnerRate,
    // Existing payable-price consumers use these legacy fields as the total
    // fallback supplement. Keep that contract for MAP and AP alike; AP's
    // actual dinner component remains available in the explicit component
    // fields below for the tooltip and overall-cost explanation.
    // Legacy payable-price consumers treat this as the complete nightly
    // fallback supplement, despite the historical Dinner field name.
    tboMapFallbackDinnerPerNight: money(breakfastPerNight + lunchPerNight + dinnerPerNight),
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
    ...(tboRoomNightBreakdown ? { tboRoomNightBreakdown } : {}),
    roomTypes: Array.isArray(source?.roomTypes)
      ? source.roomTypes.map((roomType: any) => ({ ...roomType, price: total }))
      : source?.roomTypes,
    inclusions: Array.from(new Set([
      ...(Array.isArray(source?.inclusions) ? source.inclusions : []),
      ...(isEpFallback ? ['Breakfast'] : []),
      ...(targetMealPlan === 'AP' ? ['Lunch'] : []),
      ...(includeDinner ? ['Dinner'] : []),
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

const containsEp = (row: any): boolean => {
  if (isEp(row)) return true;
  return Array.isArray(row?.rateOptions) && row.rateOptions.some(isEp);
};

const propertyKey = (row: any): string => [
  String(row?.provider || row?.hotel_provider || '').trim().toLowerCase(),
  String(row?.providerHotelCode || row?.hotelCode || row?.hotelId || '').trim().toLowerCase(),
  String(row?.hotelName || '').trim().toLowerCase(),
].join('|');

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

/** Normalize requested CP/MAP/AP rates while retaining supplier booking identity. */
export function applyMapDinnerFallbackToRows<T extends Record<string, any>>(
  rows: T[],
  context: TboMapFallbackContext,
  config: TboMapFallbackConfig,
  preserveSupplierOptions = false,
): T[] {
  const preferred = mealPlanCode(context.preferredMealPlanCode);
  if (!config.enabled || !['CP', 'MAP', 'AP'].includes(preferred)) return rows;

  const cpProperties = new Set(
    rows.filter(containsCp).map(propertyKey),
  );
  const epProperties = new Set(rows.filter(containsEp).map(propertyKey));
  const realPlanProperties = new Set(rows.filter((row) => preferred === 'CP'
    ? containsCp(row)
    : preferred === 'MAP'
      ? containsRealMap(row)
      : Array.isArray(row?.rateOptions)
        ? row.rateOptions.some(isAp)
        : isAp(row)).map(propertyKey));

  return rows.flatMap((row) => {
    const key = propertyKey(row);
    const options = Array.isArray(row?.rateOptions) ? row.rateOptions : [];
    const hasCp = cpProperties.has(key);
    const sourcePredicate = preferred === 'CP' || (preferred === 'MAP' && !hasCp) ? isEp : isCp;
    const canSynthesize = preferred === 'CP'
      ? epProperties.has(key) && ['tbo', 'vsr'].includes(String(row?.provider || row?.hotel_provider || '').trim().toLowerCase())
      : preferred === 'MAP'
        ? hasCp || epProperties.has(key)
        : hasCp;
    const requestedPredicate = preferred === 'CP' ? isCp : preferred === 'MAP' ? isMap : isAp;

    if (realPlanProperties.has(key)) {
      if (preserveSupplierOptions) return [row];
      if (options.length > 0) {
        const planOptions = options.filter(requestedPredicate);
        return planOptions.length > 0 ? [{ ...row, rateOptions: planOptions }] : [];
      }
      return requestedPredicate(row) ? [row] : [];
    }

    if (!canSynthesize) return preserveSupplierOptions ? [row] : [];

    const fallbackOptions = options
      .filter(sourcePredicate)
      .map((option: any) => createFallbackOption({ ...row, ...option }, context, config))
      .filter(Boolean)
      .map((option: any) => ({
        ...option,
        hotelCode: option.hotelCode || row.hotelCode,
        providerHotelCode: option.providerHotelCode || row.providerHotelCode,
      }));

    if (preserveSupplierOptions) {
      if (options.length === 0 && sourcePredicate(row)) {
        const fallback = createFallbackOption(row, context, config);
        return fallback ? [row, fallback] : [row];
      }
      if (fallbackOptions.length === 0) return [row];
      return [{ ...row, rateOptions: [...options, ...fallbackOptions] }];
    }

    if (options.length > 0) {
      return fallbackOptions.length > 0 ? [{ ...row, rateOptions: fallbackOptions }] : [];
    }
    const fallback = createFallbackOption(row, context, config);
    return fallback ? [fallback] : [];
  });
}

/** Backwards-compatible export for existing TBO call sites. */
export const applyTboMapFallbackToRows = applyMapDinnerFallbackToRows;

export function getTboStayMealSupplement(
  offer: { tboRoomBatches: TboStayBatch[]; rating?: unknown; category?: unknown },
  target: string,
  config: TboMapFallbackConfig,
): TboStayMealSupplement | undefined {
  const batches = offer.tboRoomBatches;
  const first = batches[0];
  if (!config.enabled || !first || first.currency.toUpperCase() !== 'INR' ||
      (target !== 'CP' && target !== 'MAP')) return;
  const occupancies = batches.flatMap(batch => batch.occupancies || []);
  const roomCount = batches.reduce((count, batch) => count + batch.roomCount, 0);
  if (occupancies.length !== roomCount || !roomCount) return;
  const result = createFallbackOption({
    provider: 'tbo', mealPlan: first.mealPlan, rating: offer.rating, category: offer.category,
    totalFare: batches.reduce((sum, batch) => sum + batch.supplierTotalFare, 0),
  }, {
    preferredMealPlanCode: target,
    adultCount: occupancies.reduce((sum, room) => sum + room.adults, 0),
    childCount: occupancies.reduce((sum, room) => sum + room.children, 0),
    roomCount, numberOfNights: 1,
  }, config);
  if (!result || (first.mealPlan === 'EP' && !(result.tboMapFallbackBreakfastRate > 0)) ||
      (target === 'MAP' && !(result.tboMapFallbackDinnerRate > 0))) return;
  return {
    mealPlan: target,
    breakfastRate: result.tboMapFallbackBreakfastRate,
    breakfastPerNight: result.tboMapFallbackBreakfastPerNight,
    dinnerRate: result.tboMapFallbackDinnerRate,
    dinnerPerNight: result.tboMapFallbackDinnerComponentPerNight,
  };
}

/** Use the existing snapshot fields so itinerary prices and meal labels reload together. */
export function tboStayMealNightFields(supplierMealPlan: string, supplement?: TboStayMealSupplement) {
  if (!supplement) return {};
  const { mealPlan, breakfastRate, breakfastPerNight, dinnerRate, dinnerPerNight } = supplement;
  const total = money(breakfastPerNight + dinnerPerNight);
  return {
    tboMapFallbackApplied: true as const,
    tboMapFallbackSourceMealPlan: supplierMealPlan,
    tboMapFallbackTargetMealPlan: mealPlan,
    tboMapFallbackBreakfastRate: breakfastRate,
    tboMapFallbackBreakfastPerPerson: breakfastRate,
    tboMapFallbackBreakfastPerNight: breakfastPerNight,
    tboMapFallbackBreakfastTotal: breakfastPerNight,
    tboMapFallbackDinnerRate: dinnerRate,
    tboMapFallbackDinnerPerPerson: dinnerRate,
    tboMapFallbackDinnerComponentPerNight: dinnerPerNight,
    tboMapFallbackDinnerComponentTotal: dinnerPerNight,
    tboMapFallbackDinnerPerNight: total,
    tboMapFallbackDinnerTotal: total,
    hotelMealPlanCost: total,
    totalHotelMealPlanCost: total,
  };
}

export function getTboBatchMealPlanQuotes(offer: any, nights: number, margin: number, config: TboMapFallbackConfig) {
  const supplierTotalFare = getTboBatchSearchTotal(offer);
  if (supplierTotalFare === null) return undefined;
  const supplierMealPlan = mealPlanCode(offer.tboRoomBatches[0].mealPlan);
  const currency = String(offer.currency || offer.tboRoomBatches[0].currency).toUpperCase();
  const routeIds = Array.from({ length: nights }, (_, index) => index);
  return Array.from(new Set([supplierMealPlan, 'CP', 'MAP'])).flatMap(mealPlan => {
    const supplement = mealPlan === supplierMealPlan ? undefined : getTboStayMealSupplement(offer, mealPlan, config);
    if (mealPlan !== supplierMealPlan && !supplement) return [];
    const totals = priceTboMultiBatchStay({ supplierTotalFare, routeIds, dviMealSupplement: supplement }, margin);
    return [{ mealPlan, amount: totals.totalPrice, currency, dviMealSupplement: money(totals.mealCostPerNight * nights) }];
  });
}

/** Materialize a full-stay recommendation only from the supplier's original search window. */
export function prepareTboBatchRecommendation(
  offer: any,
  stay: { parentRouteId: number; routeIds: number[]; checkInDate: string; checkOutDate: string },
  { roomCount, margin, config }: { roomCount: number; margin: number; config: TboMapFallbackConfig },
) {
  if (String(offer.checkInDate || '').slice(0, 10) !== stay.checkInDate ||
      String(offer.checkOutDate || '').slice(0, 10) !== stay.checkOutDate ||
      getTboBatchSearchTotal({ ...offer, itineraryRouteId: stay.parentRouteId }, roomCount) === null) return;

  const batches: TboStayBatch[] = offer.tboRoomBatches;
  const first = batches[0];
  const requestedMeal = mealPlanCode(offer.mealPlanCode || offer.mealPlan);
  const supplierMeal = mealPlanCode(first.mealPlan);
  const supplement = requestedMeal === supplierMeal ? undefined : getTboStayMealSupplement(offer, requestedMeal, config);
  if (!supplierMeal || (requestedMeal !== supplierMeal && !supplement)) return;

  let snapshot: TboMultiBatchStaySnapshot;
  try {
    snapshot = makeTboMultiBatchStay({
      hotelCode: String(offer.hotelCode), roomType: String(offer.roomType), mealPlan: first.mealPlan,
      currency: first.currency, isRefundable: first.isRefundable, anchorRouteId: stay.parentRouteId,
      routeIds: stay.routeIds, checkInDate: stay.checkInDate, checkOutDate: stay.checkOutDate,
      roomCount, batches, ...(supplement ? { dviMealSupplement: supplement } : {}),
    }, String(offer.supplierSearchCompletedAt || ''));
  } catch {
    return;
  }
  if (!isFreshTboMultiBatchStay(snapshot)) return;
  const pricing = priceTboMultiBatchStay(snapshot, margin);
  const rateOptionId = ['tbo-split', snapshot.hotelCode, snapshot.roomType, requestedMeal, snapshot.mealPlan,
    snapshot.currency, snapshot.isRefundable, snapshot.checkInDate, snapshot.checkOutDate].join(':');
  const nightlyRates = snapshot.routeIds.map((routeId, index) => {
    const date = new Date(Date.parse(snapshot.checkInDate) + index * 86400000).toISOString().slice(0, 10);
    return {
      routeId, date, baseAmount: pricing.baseByNight[index], sellAmount: pricing.payableByNight[index],
      marginAmount: pricing.marginByNight[index], rateOptionId, pricingIncludesHotelMargin: true,
    };
  });
  return {
    ...offer, rateOptionId, optionKey: rateOptionId, selectionKey: rateOptionId,
    itineraryRouteId: stay.parentRouteId, routeId: stay.parentRouteId, routeIds: stay.routeIds,
    checkInDate: stay.checkInDate, checkOutDate: stay.checkOutDate, numberOfNights: stay.routeIds.length,
    price: pricing.payableByNight[0], pricePerNight: pricing.payableByNight[0],
    totalPrice: pricing.totalPrice, totalStayPrice: pricing.totalPrice,
    baseTotalPrice: snapshot.supplierTotalFare, hotelMarginPercentage: margin,
    amountIncludesHotelMargin: true, pricingIncludesHotelMargin: true, nightlyRates,
    mealPlan: requestedMeal, mealPlanCode: requestedMeal, supplierMealPlan: supplierMeal,
    bookingMode: 'LIVE_API', priceSource: 'LIVE_API', availabilityMessage: undefined,
    tboMultiBatchStay: snapshot,
    isSelectable: true, isBookable: true, isLiveBookable: false,
    availabilityStatus: 'SEARCH_MATCH_SELECTED',
  };
}

export function projectTboBatchRecommendationNight(option: any, routeId: number) {
  const stay: TboMultiBatchStaySnapshot = option.tboMultiBatchStay;
  const index = stay.routeIds.indexOf(routeId);
  if (index < 0) return;
  const pricing = priceTboMultiBatchStay(stay, Number(option.hotelMarginPercentage || 0));
  const date = new Date(Date.parse(stay.checkInDate) + index * 86400000).toISOString().slice(0, 10);
  const checkOutDate = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
  const totalPrice = pricing.payableByNight[index];
  const baseTotalPrice = pricing.baseByNight[index];
  const hotelMarginAmount = pricing.marginByNight[index];
  return {
    ...option, ...tboStayMealNightFields(stay.mealPlan, stay.dviMealSupplement),
    routeId, itineraryRouteId: routeId, date, itineraryRouteDate: date, routeIds: [routeId],
    checkInDate: date, checkOutDate, numberOfNights: 1, nights: 1,
    selectedTotalPrice: totalPrice, selectedPricePerNight: totalPrice,
    totalPrice, totalStayPrice: totalPrice, totalHotelCost: totalPrice, totalAmountAfterTax: totalPrice,
    exactFullStayTotal: totalPrice, price: totalPrice, pricePerNight: totalPrice,
    totalRoomCost: baseTotalPrice, baseTotalPrice, baseHotelCost: baseTotalPrice,
    basePricePerNight: money(baseTotalPrice / stay.roomCount),
    hotelMarginBaseAmount: money(baseTotalPrice + pricing.mealCostPerNight), hotelMarginAmount,
    hotelMarginTotalAmount: hotelMarginAmount, roomCount: stay.roomCount, totalRooms: stay.roomCount,
    tboMapFallbackMealPlanTotal: pricing.mealCostPerNight,
    extraBedAmount: 0, childWithBedAmount: 0, childWithoutBedAmount: 0, totalHotelTaxAmount: 0,
    amountIncludesHotelMargin: true, pricingIncludesHotelMargin: true,
    isSelectable: true, isBookable: true, isLiveBookable: false,
    availabilityStatus: 'SEARCH_MATCH_SELECTED',
  };
}
