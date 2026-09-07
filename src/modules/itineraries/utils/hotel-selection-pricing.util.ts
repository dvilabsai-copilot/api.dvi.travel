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

export interface HotelOccupancyPricingInput {
  rates?: Record<string, unknown> | null;
  roomCount?: unknown;
  adultCount?: unknown;
  extraBedCount?: unknown;
  childWithBedCount?: unknown;
  childWithoutBedCount?: unknown;
  marginPercentage?: unknown;
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
  const extraBedCount = Math.max(Number(input.extraBedCount || 0), 0);
  const childWithBedCount = Math.max(Number(input.childWithBedCount || 0), 0);
  const childWithoutBedCount = Math.max(Number(input.childWithoutBedCount || 0), 0);
  const extraBedRate = Math.max(Number(rates.EXTRABED ?? rates.EXTRAADULT ?? 0), 0);
  const childWithBedRate = Math.max(Number(rates.CHILD_WITH_BED || 0), 0);
  const childWithoutBedRate = Math.max(Number(rates.CHILD_WITHOUT_BED || 0), 0);
  const extraBedAmount = money(extraBedRate * extraBedCount);
  const childWithBedAmount = money(childWithBedRate * childWithBedCount);
  const childWithoutBedAmount = money(childWithoutBedRate * childWithoutBedCount);
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
