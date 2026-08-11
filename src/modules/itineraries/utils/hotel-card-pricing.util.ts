const money = (value: unknown): number => Math.round(Number(value || 0) * 100) / 100;

const positive = (...values: unknown[]): number => {
  for (const value of values) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) return money(amount);
  }
  return 0;
};

export function hotelCardPropertyKey(row: any): string {
  const canonicalId = Number(
    row?.canonicalHotelId ?? row?.canonical_hotel_id ?? row?.hotelId ?? row?.hotel_id ?? 0,
  );
  const providerIdentity = String(
    row?.providerHotelCode ?? row?.provider_hotel_code ?? row?.hotelCode ?? row?.hotel_code ?? '',
  ).trim().toLowerCase();
  const propertyIdentity = canonicalId > 0
    ? `canonical:${canonicalId}`
    : providerIdentity
      ? `provider:${providerIdentity}`
      : `name:${String(row?.hotelName || row?.hotel_name || '').trim().toLowerCase()}`;
  return [
    Number(row?.itineraryRouteId || row?.routeId || row?.itinerary_route_id || 0),
    Number(row?.groupType || row?.group_type || 0),
    String(row?.provider || row?.hotel_provider || '').trim().toLowerCase(),
    propertyIdentity,
  ].join('|');
}

export function hotelCardPayableAmount(row: any): number {
  return positive(
    row?.pricePerNight,
    row?.selectedPricePerNight,
    row?.selected_price_per_night,
    row?.totalPrice,
    row?.totalStayPrice,
    row?.totalHotelCost,
    row?.total_hotel_cost,
    row?.totalAmountAfterTax,
    row?.price,
  );
}

const hotelCardBaseAmount = (row: any): number => positive(
  row?.basePricePerNight,
  row?.baseHotelCost,
  row?.baseAmount,
);

/** Decorate card rows without changing row order or recommendation ownership. */
export function decorateHotelCardPricing(
  rows: any[],
  selectedPayableByRouteGroup: Map<string, number> = new Map(),
): any[] {
  const grouped = new Map<string, any[]>();
  for (const row of rows || []) {
    const key = hotelCardPropertyKey(row);
    const options = Array.isArray(row?.rateOptions) && row.rateOptions.length > 0
      ? row.rateOptions.map((option: any) => ({ ...row, ...option, rateOptions: undefined }))
      : [row];
    grouped.set(key, [...(grouped.get(key) || []), ...options]);
  }

  const pricing = new Map<string, { payable: number; base: number }>();
  grouped.forEach((options, key) => {
    const payableAmounts = options.map(hotelCardPayableAmount).filter((amount) => amount > 0);
    const baseAmounts = options.map(hotelCardBaseAmount).filter((amount) => amount > 0);
    pricing.set(key, {
      payable: payableAmounts.length ? Math.min(...payableAmounts) : 0,
      base: baseAmounts.length ? Math.min(...baseAmounts) : 0,
    });
  });

  return (rows || []).map((row) => {
    const card = pricing.get(hotelCardPropertyKey(row)) || { payable: 0, base: 0 };
    const routeGroupKey = `${Number(row?.itineraryRouteId || row?.routeId || 0)}-${Number(row?.groupType || 0)}`;
    const selectedPayable = Number(selectedPayableByRouteGroup.get(routeGroupKey) || 0);
    const decorate = (option: any) => ({
      ...option,
      startingFromAmount: card.payable,
      startingFromBaseAmount: card.base,
      priceDifference: selectedPayable > 0 ? money(hotelCardPayableAmount(option) - selectedPayable) : 0,
    });
    return {
      ...decorate(row),
      ...(Array.isArray(row?.rateOptions) ? { rateOptions: row.rateOptions.map(decorate) } : {}),
    };
  });
}

