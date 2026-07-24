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
  if (normalizedBreakfast === 1 && normalizedLunch === 0 && normalizedDinner === 1) return 'MAP';
  if (normalizedBreakfast === 1 && normalizedLunch === 1 && normalizedDinner === 1) return 'AP';

  return null;
}

export function inferCanonicalHotelRatePlanCodeFromMealText(
  value?: string | null,
): CanonicalHotelRatePlanCode | null {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw || raw === '-' || raw === 'ROOM ONLY') return 'EP';

 // Explicit supplier keywords should win over generic breakfast mentions.
  if (raw.includes('ALL MEALS') || raw.includes('FULL BOARD') || raw.includes('FULLBOARD')) return 'AP';
  if (raw.includes('HALF BOARD') || raw.includes('HALFBOARD')) return 'MAP';

  const hasBreakfast = raw.includes('BREAKFAST');
  const hasLunch = raw.includes('LUNCH');
  const hasDinner = raw.includes('DINNER');

  if (hasBreakfast && hasLunch && hasDinner) return 'AP';
  if ((hasBreakfast && hasLunch) || (hasBreakfast && hasDinner) || (hasLunch && hasDinner)) return 'MAP';
  if (hasBreakfast) return 'CP';

  return 'EP';
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
  if (!raw || raw === '-') return 'Room Only';

  const upper = raw.toUpperCase();

 // Canonical or known plan identifiers map directly to CP/EP/MAP/AP labels.
  const directPlanCode = inferCanonicalHotelRatePlanCode(upper);
  if (directPlanCode) return directPlanCode;

 // Supplier meal keywords in inclusion text.
  if (upper.includes('ALL MEALS') || upper.includes('FULL BOARD') || upper.includes('FULLBOARD')) return 'AP';
  if (upper.includes('HALF BOARD') || upper.includes('HALFBOARD')) return 'MAP';

  const hasBreakfast = upper.includes('BREAKFAST');
  const hasLunch = upper.includes('LUNCH');
  const hasDinner = upper.includes('DINNER');

  if (hasBreakfast && hasLunch && hasDinner) return 'AP';
  if ((hasBreakfast && hasLunch) || (hasBreakfast && hasDinner) || (hasLunch && hasDinner)) return 'MAP';
  if (hasBreakfast) return 'CP';

 // For noisy/non-meal inclusions (e.g. parking/wifi), use a clean fallback.
  return 'Room Only';
}