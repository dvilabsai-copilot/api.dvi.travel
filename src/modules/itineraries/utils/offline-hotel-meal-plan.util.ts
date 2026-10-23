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

const MEAL_PLAN_MEAL_KEYS = ['breakfast', 'lunch', 'dinner'] as const;
type MealKey = typeof MEAL_PLAN_MEAL_KEYS[number];

const money = (value: number): number => Number((Number(value || 0)).toFixed(2));
const CHARGEABLE_MEAL_RATE_THRESHOLD = 1;

/**
 * Normalize persisted meal components as well as newly calculated ones. Old
 * itinerary snapshots can contain an included value such as ₹0.60; keeping
 * that value in the subtotal makes the tooltip and payable total disagree.
 */
export function normalizeOfflineMealBreakdown(
  value: Partial<OfflineMealBreakdown> | null | undefined,
): Partial<OfflineMealBreakdown> {
  const hasComponentValues = MEAL_PLAN_MEAL_KEYS.some((meal) => {
    const suffix = `${meal[0].toUpperCase()}${meal.slice(1)}Cost` as keyof OfflineMealBreakdown;
    return value?.[`total${suffix}` as keyof OfflineMealBreakdown] !== undefined;
  });
  // Older snapshots stored only the already-calculated subtotal. There is no
  // component value to classify in that shape, so preserve it for backward
  // compatibility instead of silently removing a valid meal amount.
  if (!hasComponentValues) {
    return {
      ...value,
      totalMealPlanCost: money(Number(value?.totalMealPlanCost || 0)),
    };
  }
  const mealPlanCode = String(value?.mealPlanCode || '').trim().toUpperCase();
  const allowedMeals: MealKey[] = mealPlanCode === 'MAP'
    ? ['breakfast', 'dinner']
    : mealPlanCode === 'CP'
      ? ['breakfast']
      : mealPlanCode === 'AP'
        ? [...MEAL_PLAN_MEAL_KEYS]
        : [...MEAL_PLAN_MEAL_KEYS];
  const totalFor = (meal: MealKey) => {
    const amount = Number(value?.[`total${meal[0].toUpperCase()}${meal.slice(1)}Cost` as keyof OfflineMealBreakdown] || 0);
    const rateKey = `${meal}CostPerPerson` as keyof OfflineMealBreakdown;
    const hasRate = value?.[rateKey] !== undefined && value?.[rateKey] !== null;
    const rate = Number(value?.[rateKey] || 0);
    const isChargeable = hasRate
      ? rate >= CHARGEABLE_MEAL_RATE_THRESHOLD
      : amount >= CHARGEABLE_MEAL_RATE_THRESHOLD;
    return allowedMeals.includes(meal) && isChargeable ? money(amount) : 0;
  };
  const totalBreakfastCost = totalFor('breakfast');
  const totalLunchCost = totalFor('lunch');
  const totalDinnerCost = totalFor('dinner');
  return {
    ...value,
    totalBreakfastCost,
    totalLunchCost,
    totalDinnerCost,
    totalMealPlanCost: money(totalBreakfastCost + totalLunchCost + totalDinnerCost),
  };
}

/**
 * Resolve the legacy offline label from persisted flags and available prices.
 * A positive rate below ₹1 means the meal is included, so it still identifies
 * the plan but must not become a payable meal amount.
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
  const totalBreakfastCost = input.flags.breakfast && prices.breakfast >= CHARGEABLE_MEAL_RATE_THRESHOLD
    ? money(foodRequiredCount * prices.breakfast * roomQuantity)
    : 0;
  const totalLunchCost = input.flags.lunch && prices.lunch >= CHARGEABLE_MEAL_RATE_THRESHOLD
    ? money(foodRequiredCount * prices.lunch * roomQuantity)
    : 0;
  const totalDinnerCost = input.flags.dinner && prices.dinner >= CHARGEABLE_MEAL_RATE_THRESHOLD
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
