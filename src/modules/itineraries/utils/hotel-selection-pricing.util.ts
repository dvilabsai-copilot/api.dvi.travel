export interface HotelSelectionPricingInput {
  totalPrice?: unknown;
  pricePerNight?: unknown;
  roomCount?: unknown;
}

export interface HotelSelectionPricing {
  roomCount: number;
  totalPrice: number;
  roomRate: number;
}

export interface OfflineHotelPayablePricingInput {
  baseTotalPrice?: unknown;
  extraBedAmount?: unknown;
  childWithBedAmount?: unknown;
  childWithoutBedAmount?: unknown;
  mealPlanCost?: unknown;
  marginPercentage?: unknown;
  taxAmount?: unknown;
}

export interface OfflineHotelPayablePricing {
  marginableBaseAmount: number;
  subtotal: number;
  mealPlanCost: number;
  marginPercentage: number;
  marginAmount: number;
  taxAmount: number;
  totalPrice: number;
}

export interface HotelOccupancyPricingInput {
  rates?: Record<string, unknown> | null;
  roomCount?: unknown;
  adultCount?: unknown;
  extraBedCount?: unknown;
  childWithBedCount?: unknown;
  childWithoutBedCount?: unknown;
  marginPercentage?: unknown;
}

export interface HotelSupplementPricingInput {
  count?: unknown;
  rate?: unknown;
  amount?: unknown;
  cost?: unknown;
}

export interface HotelSupplementPricing {
  count: number;
  rate: number;
  amount: number;
}

export interface HotelOccupancyPricing {
  roomOccupancy: 'SINGLE' | 'DOUBLE';
  roomRate: number;
  baseTotalPrice: number;
  extraBedCount: number;
  extraBedRate: number;
  extraBedAmount: number;
  childWithBedCount: number;
  childWithBedRate: number;
  childWithBedAmount: number;
  childWithoutBedCount: number;
  childWithoutBedRate: number;
  childWithoutBedAmount: number;
  hotelMarginBaseAmount: number;
  hotelMarginPercentage: number;
  hotelMarginAmount: number;
  totalPrice: number;
}

const money = (value: unknown): number => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
};

const nonNegative = (value: unknown): number => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

/**
 * Normalize one occupancy supplement for every selection flow.
 *
 * Supplier rows sometimes provide the aggregate supplement amount while the
 * matching unit-rate field is empty or belongs to an older row. The amount is
 * the payable source of truth; when it is present, expose a unit rate that
 * satisfies `unit rate * count = amount` so persisted snapshots and tooltips
 * cannot contradict the total.
 */
export function resolveHotelSupplementPricing(
  input: HotelSupplementPricingInput,
): HotelSupplementPricing {
  const count = Math.max(Math.trunc(nonNegative(input.count)), 0);
  const suppliedRate = nonNegative(input.rate);
  const amountValue = nonNegative(input.amount);
  const explicitAmount = amountValue > 0 ? amountValue : nonNegative(input.cost);
  const amount = money(explicitAmount > 0 ? explicitAmount : suppliedRate * count);
  const rate = count > 0 && amount > 0
    ? money(amount / count)
    : money(suppliedRate);

  return { count, rate, amount };
}

/**
 * Single source of truth for occupancy pricing. Callers provide the already
 * resolved database rate row; this function performs the same calculation
 * for reset, auto-selection, preview, and explicit selection.
 */
export function resolveHotelOccupancyPricing(input: HotelOccupancyPricingInput): HotelOccupancyPricing {
  const rates = input.rates || {};
  const roomCount = Math.max(Math.trunc(Number(input.roomCount || 1)), 1);
  const adults = Math.max(Math.trunc(Number(input.adultCount || 0)), 0);
  const roomOccupancy: 'SINGLE' | 'DOUBLE' = adults <= roomCount ? 'SINGLE' : 'DOUBLE';
  const roomRate = Math.max(Number(rates[roomOccupancy] || 0), 0);
  const extraBed = resolveHotelSupplementPricing({
    count: input.extraBedCount,
    rate: rates.EXTRABED ?? rates.EXTRAADULT,
  });
  const childWithBed = resolveHotelSupplementPricing({
    count: input.childWithBedCount,
    rate: rates.CHILD_WITH_BED,
  });
  const childWithoutBed = resolveHotelSupplementPricing({
    count: input.childWithoutBedCount,
    rate: rates.CHILD_WITHOUT_BED,
  });
  const { count: extraBedCount, rate: extraBedRate, amount: extraBedAmount } = extraBed;
  const { count: childWithBedCount, rate: childWithBedRate, amount: childWithBedAmount } = childWithBed;
  const { count: childWithoutBedCount, rate: childWithoutBedRate, amount: childWithoutBedAmount } = childWithoutBed;
  const baseTotalPrice = money(roomRate * roomCount);
  const hotelMarginBaseAmount = money(baseTotalPrice + extraBedAmount + childWithBedAmount + childWithoutBedAmount);
  const hotelMarginPercentage = Math.max(Number(input.marginPercentage || 0), 0);
  const hotelMarginAmount = money(hotelMarginBaseAmount * hotelMarginPercentage / 100);
  return {
    roomOccupancy, roomRate: money(roomRate), baseTotalPrice,
    extraBedCount, extraBedRate: money(extraBedRate), extraBedAmount,
    childWithBedCount, childWithBedRate: money(childWithBedRate), childWithBedAmount,
    childWithoutBedCount, childWithoutBedRate: money(childWithoutBedRate), childWithoutBedAmount,
    hotelMarginBaseAmount, hotelMarginPercentage, hotelMarginAmount,
    totalPrice: money(hotelMarginBaseAmount + hotelMarginAmount),
  };
}

/**
 * Price an offline hotel selection with an ordinary meal-plan supplement.
 *
 * Room and occupancy supplements are marginable. Offline MAP/AP/CP food is a
 * separate customer charge: it belongs in the subtotal and payable total, but
 * must not receive hotel margin. Keeping this rule here lets auto-selection,
 * manual selection, and the details reconciliation use the same calculation.
 */
export function resolveOfflineHotelPayablePricing(
  input: OfflineHotelPayablePricingInput,
): OfflineHotelPayablePricing {
  const marginableBaseAmount = money(
    Number(input.baseTotalPrice ?? 0) +
      Number(input.extraBedAmount ?? 0) +
      Number(input.childWithBedAmount ?? 0) +
      Number(input.childWithoutBedAmount ?? 0),
  );
  const mealPlanCost = money(input.mealPlanCost);
  const marginPercentage = Math.max(Number(input.marginPercentage || 0), 0);
  const marginAmount = money((marginableBaseAmount * marginPercentage) / 100);
  const taxAmount = money(input.taxAmount);
  const subtotal = money(marginableBaseAmount + mealPlanCost);

  return {
    marginableBaseAmount,
    subtotal,
    mealPlanCost,
    marginPercentage,
    marginAmount,
    taxAmount,
    totalPrice: money(subtotal + marginAmount + taxAmount),
  };
}

/** Normalize the payable total and per-room rate for a selected route. */
export function resolveHotelSelectionPricing(input: HotelSelectionPricingInput): HotelSelectionPricing {
  const roomCount = Math.max(Number(input.roomCount || 1), 1);
  const explicitTotal = Number(input.totalPrice || 0);
  const perRoomRate = Number(input.pricePerNight || 0);
  const totalPrice = explicitTotal > 0
    ? explicitTotal
    : perRoomRate > 0
      ? perRoomRate * roomCount
      : 0;

  return {
    roomCount,
    totalPrice: Number(totalPrice.toFixed(2)),
    roomRate: Number((totalPrice / roomCount).toFixed(2)),
  };
}
