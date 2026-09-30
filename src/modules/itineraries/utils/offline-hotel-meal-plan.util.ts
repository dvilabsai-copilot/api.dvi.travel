import { getCanonicalMealPlanFlags, inferCanonicalHotelRatePlanCodeFromMealFlags } from '../../hotels/hotel-rate-plans';

export type OfflineMealFlags = {
  breakfast: boolean;
  lunch: boolean;
  dinner: boolean;
};

export type OfflineMealPrices = {
  breakfast: number;
  lunch: number;
  dinner: number;
};

export type OfflineMealBreakdown = OfflineMealFlags & {
  mealPlanCode: string;
  breakfastCostPerPerson: number;
  lunchCostPerPerson: number;
  dinnerCostPerPerson: number;
  foodRequiredCount: number;
  roomQuantity: number;
  totalBreakfastCost: number;
  totalLunchCost: number;
  totalDinnerCost: number;
  totalMealPlanCost: number;
};

const money = (value: number): number => Number((Number(value || 0)).toFixed(2));

/**
 * Resolve the legacy offline label from persisted flags and positive prices.
 * This deliberately requires breakfast for MAP/AP, matching the PHP output.
 */
export function resolveLegacyOfflineMealPlanCode(
  flags: OfflineMealFlags,
  prices: OfflineMealPrices,
): string {
  const breakfast = flags.breakfast && prices.breakfast > 0;
  const lunch = flags.lunch && prices.lunch > 0;
  const dinner = flags.dinner && prices.dinner > 0;

  if (breakfast && lunch && dinner) return 'AP';
  if (breakfast && (lunch || dinner)) return 'MAP';
  if (breakfast) return 'CP';
  return 'EP';
}

export function mealFlagsForOfflinePlan(value?: string | null): OfflineMealFlags {
  const flags = getCanonicalMealPlanFlags(value);
  return {
    breakfast: flags.breakfast,
    lunch: flags.lunch,
    dinner: flags.dinner,
  };
}

export function mealFlagsFromRoom(room: any, fallbackPlan?: string | null): OfflineMealFlags {
  const explicit = mealFlagsForOfflinePlan(fallbackPlan);
  if (fallbackPlan && inferCanonicalHotelRatePlanCodeFromMealFlags(
    explicit.breakfast ? 1 : 0,
    explicit.lunch ? 1 : 0,
    explicit.dinner ? 1 : 0,
  )) {
    return explicit;
  }
  return {
    breakfast: Number(room?.breakfast_included || 0) === 1,
    lunch: Number(room?.lunch_included || 0) === 1,
    dinner: Number(room?.dinner_included || 0) === 1,
  };
}

/**
 * Calculate one route-night's meal amounts using the same person/room rule as
 * the legacy PHP flow. Room/rate-plan pricing is intentionally outside this
 * helper so callers cannot accidentally add these amounts twice.
 */
export function calculateOfflineMealBreakdown(input: {
  flags: OfflineMealFlags;
  prices: OfflineMealPrices;
  fallbackMealPlanCode?: string;
  adultCount: number;
  childCount: number;
  roomCount: number;
  roomQuantity?: number;
}): OfflineMealBreakdown {
  const roomQuantity = Math.max(Number(input.roomQuantity ?? input.roomCount ?? 1), 1);
  const configuredRoomCount = Math.max(Number(input.roomCount || 1), 1);
  const foodRequiredCount = (Math.max(Number(input.adultCount || 0), 0) + Math.max(Number(input.childCount || 0), 0)) /
    configuredRoomCount;
  const prices = {
    breakfast: Math.max(Number(input.prices.breakfast || 0), 0),
    lunch: Math.max(Number(input.prices.lunch || 0), 0),
    dinner: Math.max(Number(input.prices.dinner || 0), 0),
  };
  const totalBreakfastCost = input.flags.breakfast
    ? money(foodRequiredCount * prices.breakfast * roomQuantity)
    : 0;
  const totalLunchCost = input.flags.lunch
    ? money(foodRequiredCount * prices.lunch * roomQuantity)
    : 0;
  const totalDinnerCost = input.flags.dinner
    ? money(foodRequiredCount * prices.dinner * roomQuantity)
    : 0;

  const hasPricebookValue = prices.breakfast > 0 || prices.lunch > 0 || prices.dinner > 0;
  return {
    ...input.flags,
    // A configured rate-plan label must not imply a meal when the date has no
    // valid pricebook value. Treat an empty date as room-only (EP).
    mealPlanCode: hasPricebookValue
      ? resolveLegacyOfflineMealPlanCode(input.flags, prices)
      : 'EP',
    breakfastCostPerPerson: money(prices.breakfast),
    lunchCostPerPerson: money(prices.lunch),
    dinnerCostPerPerson: money(prices.dinner),
    foodRequiredCount: money(foodRequiredCount),
    roomQuantity,
    totalBreakfastCost,
    totalLunchCost,
    totalDinnerCost,
    totalMealPlanCost: money(totalBreakfastCost + totalLunchCost + totalDinnerCost),
  };
}
