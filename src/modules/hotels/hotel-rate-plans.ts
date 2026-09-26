export type CanonicalHotelRatePlanCode = 'CP' | 'EP' | 'MAP' | 'AP';

export type HotelMealComposition =
  | 'ROOM_ONLY'
  | 'BREAKFAST_ONLY'
  | 'BREAKFAST_PLUS_ONE_MAJOR'
  | 'ALL_MEALS';

export type TboMealType = 'Breakfast' | 'RoomOnly' | 'HalfBoard' | 'FullBoard';

export type HotelRatePlanDefinition = {
  code: CanonicalHotelRatePlanCode;
  defaultRateplanId: string;
  externalRateplanId: string;
  name: string;
  description: string;
  mealComposition: HotelMealComposition;
  tboMealType: TboMealType;
  includesBreakfast: number;
  includesLunch: number;
  includesDinner: number;
  sortOrder: number;
};

export const CANONICAL_HOTEL_RATE_PLANS: HotelRatePlanDefinition[] = [
  {
    code: 'CP',
    defaultRateplanId: 'CP_PLAN',
    externalRateplanId: '12',
    name: 'Continental Plan',
    description: 'Breakfast only',
    mealComposition: 'BREAKFAST_ONLY',
    tboMealType: 'Breakfast',
    includesBreakfast: 1,
    includesLunch: 0,
    includesDinner: 0,
    sortOrder: 1,
  },
  {
    code: 'EP',
    defaultRateplanId: 'EP_PLAN',
    externalRateplanId: '15',
    name: 'European Plan',
    description: 'Room only',
    mealComposition: 'ROOM_ONLY',
    tboMealType: 'RoomOnly',
    includesBreakfast: 0,
    includesLunch: 0,
    includesDinner: 0,
    sortOrder: 2,
  },
  {
    code: 'MAP',
    defaultRateplanId: 'MAP_PLAN',
    externalRateplanId: '13',
    name: 'Modified American Plan',
    description: 'Breakfast + one major meal (Lunch or Dinner)',
    mealComposition: 'BREAKFAST_PLUS_ONE_MAJOR',
    tboMealType: 'HalfBoard',
    includesBreakfast: 1,
    includesLunch: 0,
    includesDinner: 1,
    sortOrder: 3,
  },
  {
    code: 'AP',
    defaultRateplanId: 'AP_PLAN',
    externalRateplanId: '14',
    name: 'American Plan',
    description: 'Breakfast + Lunch + Dinner',
    mealComposition: 'ALL_MEALS',
    tboMealType: 'FullBoard',
    includesBreakfast: 1,
    includesLunch: 1,
    includesDinner: 1,
    sortOrder: 4,
  },
];

export const HOTEL_RATE_PLAN_BY_CODE = new Map(
  CANONICAL_HOTEL_RATE_PLANS.map((item) => [item.code, item]),
);

export function inferCanonicalHotelRatePlanCode(value?: string | null): CanonicalHotelRatePlanCode | null {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;

  // Supplier identities can namespace the authoritative plan code, e.g.
  // axisrooms:232:605:CP_PLAN:2026-08-12 or AX-232:605:MAP_PLAN:...
  const embeddedPlan = raw.match(/(?:^|[^A-Z0-9])(MAP|CP|AP|EP)_PLAN(?:$|[^A-Z0-9])/);
  if (embeddedPlan?.[1]) return embeddedPlan[1] as CanonicalHotelRatePlanCode;

  // Channel managers commonly place the canonical abbreviation inside a
  // descriptive rate-plan name, e.g. "Double Deluxe Room - OTA EP Plan".
  // Require the word PLAN so unrelated room/property names containing a
  // standalone two-letter token are not classified as meal plans.
  const embeddedNamedPlan = raw.match(
    /(?:^|[^A-Z0-9])(MAP|CP|AP|EP)[\s_-]*PLAN(?:$|[^A-Z0-9])/,
  );
  if (embeddedNamedPlan?.[1]) {
    return embeddedNamedPlan[1] as CanonicalHotelRatePlanCode;
  }

  if (raw === '12' || raw.startsWith('12')) return 'CP';
  if (raw === '13' || raw.startsWith('13')) return 'MAP';
  if (raw === '14' || raw.startsWith('14')) return 'AP';
  if (raw === '15' || raw.startsWith('15')) return 'EP';

  if (raw === 'CP' || raw === 'CP_PLAN' || raw.includes('CONTINENTAL')) return 'CP';
  if (raw === 'EP' || raw === 'EP_PLAN' || raw.includes('EUROPEAN') || raw.includes('ROOM ONLY')) return 'EP';
  if (raw === 'MAP' || raw === 'MAP_PLAN' || raw.includes('MODIFIED AMERICAN')) return 'MAP';
  if (raw === 'AP' || raw === 'AP_PLAN' || raw === 'AMERICAN PLAN' || raw.includes('BREAKFAST + LUNCH + DINNER')) return 'AP';

  return null;
}

export function inferCanonicalHotelRatePlanCodeFromMealFlags(
  breakfast?: number | null,
  lunch?: number | null,
  dinner?: number | null,
): CanonicalHotelRatePlanCode | null {
  const normalizedBreakfast = Number(breakfast ?? 0) ? 1 : 0;
  const normalizedLunch = Number(lunch ?? 0) ? 1 : 0;
  const normalizedDinner = Number(dinner ?? 0) ? 1 : 0;

  if (normalizedBreakfast === 0 && normalizedLunch === 0 && normalizedDinner === 0) return 'EP';
  if (normalizedBreakfast === 1 && normalizedLunch === 0 && normalizedDinner === 0) return 'CP';
  if (normalizedBreakfast === 1 && normalizedLunch === 1 && normalizedDinner === 1) return 'AP';
  // MAP is breakfast plus exactly one major meal. The legacy flags can
  // represent either lunch or dinner, so accept either form here. AP must be
  // checked first because it contains both major meals.
  if (
    normalizedBreakfast === 1 &&
    ((normalizedLunch === 1 && normalizedDinner === 0) ||
      (normalizedLunch === 0 && normalizedDinner === 1))
  ) return 'MAP';

  return null;
}

export type CanonicalMealPlanFlags = {
  all: boolean;
  breakfast: boolean;
  lunch: boolean;
  dinner: boolean;
};

/**
 * Converts a supplier/UI meal-plan value into the canonical package flags.
 * `meal_plan_code` remains the authoritative identity; these booleans are
 * retained only for legacy pricing/database compatibility.
 */
export function getCanonicalMealPlanFlags(value?: string | null): CanonicalMealPlanFlags {
  const code =
    inferCanonicalHotelRatePlanCode(value) ||
    inferCanonicalHotelRatePlanCodeFromMealText(value);
  const definition = code ? HOTEL_RATE_PLAN_BY_CODE.get(code) : null;

  return {
    all: code === 'AP',
    breakfast: Boolean(definition?.includesBreakfast),
    lunch: Boolean(definition?.includesLunch),
    dinner: Boolean(definition?.includesDinner),
  };
}

export function inferCanonicalHotelRatePlanCodeFromMealText(
  value?: string | null,
): CanonicalHotelRatePlanCode | null {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw || raw === '-') return null;
  const normalized = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized === 'ROOM ONLY') return 'EP';

 // Explicit supplier keywords should win over generic breakfast mentions.
  if (normalized.includes('ALL MEALS') || normalized.includes('FULL BOARD') || normalized.includes('FULLBOARD')) return 'AP';
  if (normalized.includes('HALF BOARD') || normalized.includes('HALFBOARD')) return 'MAP';

  const hasBreakfast = normalized.includes('BREAKFAST');
  const hasLunch = normalized.includes('LUNCH');
  const hasDinner = normalized.includes('DINNER');

  // TBO uses `Lunch/Dinner` to mean one of those two major meals, not both.
  if (
    hasBreakfast &&
    (normalized.includes('LUNCH/DINNER') || normalized.includes('LUNCH OR DINNER'))
  ) return 'MAP';

  if (hasBreakfast && hasLunch && hasDinner) return 'AP';
  if ((hasBreakfast && hasLunch) || (hasBreakfast && hasDinner) || (hasLunch && hasDinner)) return 'MAP';
  if (hasBreakfast) return 'CP';

  return null;
}

export function getCanonicalHotelRatePlanDefinition(
  value?: string | null,
): HotelRatePlanDefinition | null {
  const code = inferCanonicalHotelRatePlanCode(value);
  return code ? HOTEL_RATE_PLAN_BY_CODE.get(code) || null : null;
}

export function getTboMealTypeForCanonicalHotelRatePlan(
  value?: string | null,
): TboMealType | null {
  const definition = getCanonicalHotelRatePlanDefinition(value);
  return definition?.tboMealType || null;
}

export function getNormalizedMealPlanLabelFromMealText(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw || raw === '-') return 'UNKNOWN';

  const normalizedUpper = raw.toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Keep canonical codes and descriptive supplier text on the same parser so
  // TBO values such as `Half_Board` and `Breakfast & Lunch/Dinner` follow the
  // same rules.
  const directPlanCode = inferCanonicalHotelRatePlanCode(normalizedUpper);
  if (directPlanCode) return directPlanCode;

  const mealTextPlanCode = inferCanonicalHotelRatePlanCodeFromMealText(normalizedUpper);
  if (mealTextPlanCode) return mealTextPlanCode;

  // For noisy/non-meal inclusions (e.g. parking/wifi), use a clean fallback.
  return 'UNKNOWN';
}

/**
 * Normalize TBO's meal plan using the human-readable inclusion first.
 *
 * TBO sometimes returns a structured MealType that disagrees with the meals
 * listed in Inclusion (for example Room_Only with breakfast and dinner). The
 * inclusion describes what the guest actually receives, so it is authoritative
 * when it contains a recognizable meal plan. MealType is retained as a
 * fallback for empty/noisy inclusion text.
 */
export function getNormalizedMealPlanLabelFromMealSources(
  inclusion?: string | null,
  mealType?: string | null,
): string {
  const inclusionLabel = getNormalizedMealPlanLabelFromMealText(inclusion);
  if (inclusionLabel !== 'UNKNOWN') return inclusionLabel;
  return getNormalizedMealPlanLabelFromMealText(mealType);
}
