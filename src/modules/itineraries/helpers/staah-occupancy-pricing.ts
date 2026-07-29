export type StaahPricingPaxInput = {
  roomCount?: number;
  adults?: number;
  children?: number;
  extraBedCount?: number;
  childWithBedCount?: number;
  childWithoutBedCount?: number;
};

export type StaahOccupancyPricingBreakdown = {
  normalizedOccupancyRates: Record<string, number>;
  roomAdultOccupancies: number[];
  effectiveAdultOccupancyKeys: string[];
  baseOccupancyKey: string;
  baseOccupancyAmount: number;
  extraBedCount: number;
  extraBedRate: number;
  extraBedAmount: number;
  childWithBedCount: number;
  childWithBedRate: number;
  childWithBedAmount: number;
  childWithoutBedCount: number;
  childWithoutBedRate: number;
  childWithoutBedAmount: number;
  extraChildCount: number;
  extraChildRate: number;
  extraChildAmount: number;
  finalCalculatedAmount: number;
};

const BASE_OCCUPANCY_KEYS = [
  'SINGLE',
  'DOUBLE',
  'TRIPLE',
  'QUAD',
  'PENTA',
  'HEXA',
  'HEPTA',
  'OCTA',
  'NONA',
  'DECA',
] as const;

const PERSON_KEY_TO_OCCUPANCY_KEY: Array<[string, string]> = [
  ['person1', 'SINGLE'],
  ['person2', 'DOUBLE'],
  ['person3', 'TRIPLE'],
  ['person4', 'QUAD'],
  ['person5', 'PENTA'],
  ['person6', 'HEXA'],
  ['person7', 'HEPTA'],
  ['person8', 'OCTA'],
  ['person9', 'NONA'],
  ['person10', 'DECA'],
];

const DIRECT_KEY_ALIASES: Record<string, string[]> = {
  SINGLE: ['SINGLE'],
  DOUBLE: ['DOUBLE'],
  TRIPLE: ['TRIPLE'],
  QUAD: ['QUAD'],
  PENTA: ['PENTA'],
  HEXA: ['HEXA'],
  HEPTA: ['HEPTA'],
  OCTA: ['OCTA'],
  NONA: ['NONA', 'NINE'],
  DECA: ['DECA', 'TEN'],
  EXTRABED: ['EXTRABED', 'EXTRA_BED'],
  CHILD_WITH_BED: ['CHILD_WITH_BED', 'CHILDWITHBED', 'EXTRACHILD_WITH_BED', 'EXTRACHILDWITHBED'],
  CHILD_WITHOUT_BED: ['CHILD_WITHOUT_BED', 'CHILDWITHOUTBED', 'EXTRACHILD_WITHOUT_BED', 'EXTRACHILDWITHOUTBED'],
  EXTRAADULT: ['EXTRAADULT'],
  EXTRAADULT2: ['EXTRAADULT2'],
  EXTRAADULT3: ['EXTRAADULT3'],
  EXTRACHILD: ['EXTRACHILD'],
  EXTRACHILD2: ['EXTRACHILD2'],
  EXTRACHILD3: ['EXTRACHILD3'],
};

function toNonNegativeNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function toPositiveNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function parseRawOccupancyRates(occupancyRates: unknown): Record<string, unknown> {
  if (typeof occupancyRates === 'string') {
    const raw = occupancyRates.trim();
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return occupancyRates && typeof occupancyRates === 'object' && !Array.isArray(occupancyRates)
    ? (occupancyRates as Record<string, unknown>)
    : {};
}

function normalizeDirectKey(rawKey: string): string | null {
  const compact = rawKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return null;

  for (const [canonicalKey, aliases] of Object.entries(DIRECT_KEY_ALIASES)) {
    if (aliases.some((alias) => alias.replace(/[^A-Z0-9]/g, '') === compact)) {
      return canonicalKey;
    }
  }

  return null;
}

export function normalizeStaahOccupancyRates(occupancyRates: unknown): Record<string, number> {
  const source = parseRawOccupancyRates(occupancyRates);
  const normalized: Record<string, number> = {};

  for (const [key, value] of Object.entries(source)) {
    const canonicalKey = normalizeDirectKey(key);
    const numericValue = toNonNegativeNumber(value);
    if (canonicalKey && numericValue !== null) {
      normalized[canonicalKey] = numericValue;
    }
  }

  const amountAfterTax =
    source.amountAfterTax && typeof source.amountAfterTax === 'object'
      ? (source.amountAfterTax as Record<string, unknown>)
      : null;
  const amountBeforeTax =
    source.amountBeforeTax && typeof source.amountBeforeTax === 'object'
      ? (source.amountBeforeTax as Record<string, unknown>)
      : null;
  const amountSource = amountAfterTax || amountBeforeTax;

  if (amountSource) {
    const obp =
      amountSource.obp && typeof amountSource.obp === 'object'
        ? (amountSource.obp as Record<string, unknown>)
        : {};

    for (const [personKey, occupancyKey] of PERSON_KEY_TO_OCCUPANCY_KEY) {
      const numericValue = toNonNegativeNumber(obp[personKey]);
      if (numericValue !== null && normalized[occupancyKey] === undefined) {
        normalized[occupancyKey] = numericValue;
      }
    }

    const baseRate = toNonNegativeNumber(amountSource.Rate);
    if (baseRate !== null && normalized.SINGLE === undefined) {
      normalized.SINGLE = baseRate;
    }

    const extraAdult = toNonNegativeNumber(amountSource.extraadult);
    if (extraAdult !== null && normalized.EXTRAADULT === undefined) {
      normalized.EXTRAADULT = extraAdult;
    }

    const extraChild = toNonNegativeNumber(amountSource.extrachild);
    if (extraChild !== null && normalized.EXTRACHILD === undefined) {
      normalized.EXTRACHILD = extraChild;
    }
  }

  return normalized;
}

function buildRoomAdultOccupancies(roomCount: number, adults: number): number[] {
  const normalizedRoomCount = Math.max(Math.trunc(roomCount || 1), 1);
  const normalizedAdults = Math.max(Math.trunc(adults || 0), 0);

  if (normalizedAdults <= 0) {
    return [1];
  }

  const occupiedRoomCount = Math.min(normalizedRoomCount, normalizedAdults);
  const occupancies = Array.from({ length: occupiedRoomCount }, () => 1);
  let remainingAdults = normalizedAdults - occupiedRoomCount;
  let roomIndex = 0;

  while (remainingAdults > 0) {
    occupancies[roomIndex] += 1;
    remainingAdults -= 1;
    roomIndex = (roomIndex + 1) % occupancies.length;
  }

  return occupancies;
}

function getBaseOccupancyKeyForAdults(adults: number): string {
  const index = Math.max(Math.trunc(adults || 1), 1) - 1;
  return BASE_OCCUPANCY_KEYS[Math.min(index, BASE_OCCUPANCY_KEYS.length - 1)];
}

function getExtraAdultKey(extraAdultCount: number): string | null {
  if (extraAdultCount <= 0) return null;
  if (extraAdultCount === 1) return 'EXTRAADULT';
  if (extraAdultCount === 2) return 'EXTRAADULT2';
  if (extraAdultCount === 3) return 'EXTRAADULT3';
  return null;
}

function getExtraChildKey(extraChildCount: number): string | null {
  if (extraChildCount <= 0) return null;
  if (extraChildCount === 1) return 'EXTRACHILD';
  if (extraChildCount === 2) return 'EXTRACHILD2';
  if (extraChildCount === 3) return 'EXTRACHILD3';
  return null;
}

export function calculateStaahOccupancyAmount(
  occupancyRates: unknown,
  pax: StaahPricingPaxInput,
): StaahOccupancyPricingBreakdown {
  const normalizedRates = normalizeStaahOccupancyRates(occupancyRates);
  const roomAdultOccupancies = buildRoomAdultOccupancies(
    Number(pax.roomCount || 1),
    Number(pax.adults || 0),
  );

  const totalChildren = Math.max(Math.trunc(Number(pax.children || 0)), 0);
  const childWithBedCount = Math.max(Math.trunc(Number(pax.childWithBedCount || 0)), 0);
  const childWithoutBedCount = Math.max(Math.trunc(Number(pax.childWithoutBedCount || 0)), 0);
  const unresolvedChildren = Math.max(totalChildren - childWithBedCount - childWithoutBedCount, 0);
  const extraBedCount = Math.max(Math.trunc(Number(pax.extraBedCount || 0)), 0);

  const extraBedRate = toPositiveNumber(normalizedRates.EXTRABED);
  const extraAdultRate = toPositiveNumber(normalizedRates.EXTRAADULT);
  const childWithBedSpecificRate = toPositiveNumber(normalizedRates.CHILD_WITH_BED);
  const childWithoutBedSpecificRate = toPositiveNumber(normalizedRates.CHILD_WITHOUT_BED);
  const extraChildRate = toPositiveNumber(normalizedRates.EXTRACHILD);
  const extraAdult2Rate = toPositiveNumber(normalizedRates.EXTRAADULT2);
  const extraAdult3Rate = toPositiveNumber(normalizedRates.EXTRAADULT3);
  const extraChild2Rate = toPositiveNumber(normalizedRates.EXTRACHILD2);
  const extraChild3Rate = toPositiveNumber(normalizedRates.EXTRACHILD3);

  const totalAdults = Math.max(Math.trunc(Number(pax.adults || 0)), 0);
  const canUseDoublePlusExtraAdult =
    roomAdultOccupancies.length === 1 &&
    totalAdults === 3 &&
    extraAdultRate > 0 &&
    toPositiveNumber(normalizedRates.DOUBLE) > 0;

  const effectiveAdultOccupancyKeys = roomAdultOccupancies.map((roomAdults) => getBaseOccupancyKeyForAdults(roomAdults));
  let baseOccupancyAmount = roomAdultOccupancies.reduce((sum, roomAdults) => {
    const baseKey = getBaseOccupancyKeyForAdults(roomAdults);
    return sum + toPositiveNumber(normalizedRates[baseKey]);
  }, 0);

  if (canUseDoublePlusExtraAdult) {
    effectiveAdultOccupancyKeys.splice(0, effectiveAdultOccupancyKeys.length, 'DOUBLE+EXTRAADULT');
    baseOccupancyAmount = toPositiveNumber(normalizedRates.DOUBLE);
  }

  const childWithBedUsesExtraChildRate = childWithBedCount > 0 && childWithBedSpecificRate <= 0 && extraChildRate > 0;
  const childWithoutBedUsesExtraChildRate =
    childWithoutBedCount > 0 && childWithoutBedSpecificRate <= 0 && extraChildRate > 0;

  const childWithBedAmount = childWithBedUsesExtraChildRate ? 0 : childWithBedCount * childWithBedSpecificRate;
  const childWithoutBedAmount = childWithoutBedUsesExtraChildRate
    ? 0
    : childWithoutBedCount * childWithoutBedSpecificRate;

  const extraChildCount =
    unresolvedChildren +
    (childWithBedUsesExtraChildRate ? childWithBedCount : 0) +
    (childWithoutBedUsesExtraChildRate ? childWithoutBedCount : 0);

  let extraAdultAmount = 0;
  if (canUseDoublePlusExtraAdult) {
    extraAdultAmount = extraAdultRate;
  }

  const resolvedExtraChildRate =
    extraChildCount === 3 && extraChild3Rate > 0
      ? extraChild3Rate
      : extraChildCount === 2 && extraChild2Rate > 0
        ? extraChild2Rate
        : extraChildRate;

  const candidateTripleAmount = toPositiveNumber(normalizedRates.TRIPLE);
  const shouldUseTripleForChildFallback =
    roomAdultOccupancies.length === 1 &&
    totalAdults === 2 &&
    totalChildren > 0 &&
    resolvedExtraChildRate <= 0 &&
    candidateTripleAmount > 0;

  let extraChildAmount = extraChildCount * resolvedExtraChildRate;
  if (shouldUseTripleForChildFallback) {
    effectiveAdultOccupancyKeys.splice(0, effectiveAdultOccupancyKeys.length, 'TRIPLE');
    baseOccupancyAmount = candidateTripleAmount;
    extraChildAmount = 0;
  }

  const extraBedAmount = extraBedCount * extraBedRate;
  const finalCalculatedAmount =
    baseOccupancyAmount +
    extraAdultAmount +
    extraBedAmount +
    childWithBedAmount +
    childWithoutBedAmount +
    extraChildAmount;

  return {
    normalizedOccupancyRates: normalizedRates,
    roomAdultOccupancies,
    effectiveAdultOccupancyKeys,
    baseOccupancyKey: effectiveAdultOccupancyKeys.join('+'),
    baseOccupancyAmount,
    extraBedCount,
    extraBedRate,
    extraBedAmount,
    childWithBedCount,
    childWithBedRate: childWithBedUsesExtraChildRate ? extraChildRate : childWithBedSpecificRate,
    childWithBedAmount,
    childWithoutBedCount,
    childWithoutBedRate: childWithoutBedUsesExtraChildRate ? extraChildRate : childWithoutBedSpecificRate,
    childWithoutBedAmount,
    extraChildCount,
    extraChildRate,
    extraChildAmount,
    finalCalculatedAmount,
  };
}

/**
 * A multi-night STAAH reservation is persisted once per itinerary route, while
 * the outbound reservation amount is for the complete stay. Keep each route's
 * stored amount aligned with the nightly price rows so confirmed-itinerary
 * details do not compare a stay total with a single night.
 */
export function allocateStaahAmountAcrossRoutes(
  totalAmount: number,
  nightlyRates: Array<{ amountAfterTax?: unknown }> = [],
  routeCount: number,
): number[] {
  const count = Math.max(Math.trunc(Number(routeCount || 0)), 0);
  if (count === 0) return [];

  const normalizedTotal = Number(Number(totalAmount || 0).toFixed(2));
  const nightlyAmounts = nightlyRates.slice(0, count).map((night) => Number(Number(night?.amountAfterTax || 0).toFixed(2)));
  const nightlyTotal = nightlyAmounts.reduce((sum, amount) => sum + amount, 0);

  if (
    nightlyAmounts.length === count &&
    nightlyAmounts.every((amount) => Number.isFinite(amount) && amount >= 0) &&
    Math.abs(nightlyTotal - normalizedTotal) <= 0.01
  ) {
    return nightlyAmounts;
  }

  const equalAmount = Number((normalizedTotal / count).toFixed(2));
  const allocated = Array.from({ length: count }, () => equalAmount);
  allocated[count - 1] = Number((normalizedTotal - equalAmount * (count - 1)).toFixed(2));
  return allocated;
}
