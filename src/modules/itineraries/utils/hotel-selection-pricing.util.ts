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
