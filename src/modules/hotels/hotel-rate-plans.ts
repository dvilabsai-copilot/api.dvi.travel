export type CanonicalHotelRatePlanCode = 'CP' | 'EP' | 'MAP' | 'AP';

export type HotelRatePlanDefinition = {
  code: CanonicalHotelRatePlanCode;
  defaultRateplanId: string;
  externalRateplanId: string;
  name: string;
  description: string;
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
    description: 'Breakfast + Lunch or Dinner',
    includesBreakfast: 1,
    includesLunch: 1,
    includesDinner: 1,
    sortOrder: 3,
  },
  {
    code: 'AP',
    defaultRateplanId: 'AP_PLAN',
    externalRateplanId: '14',
    name: 'American Plan',
    description: 'Breakfast + Lunch + Dinner',
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

export function getCanonicalHotelRatePlanDefinition(
  value?: string | null,
): HotelRatePlanDefinition | null {
  const code = inferCanonicalHotelRatePlanCode(value);
  return code ? HOTEL_RATE_PLAN_BY_CODE.get(code) || null : null;
}