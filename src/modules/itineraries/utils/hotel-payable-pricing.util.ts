const money = (value: unknown): number => {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
};

const positive = (...values: unknown[]): number => {
  for (const value of values) {
    const amount = money(value);
    if (amount > 0) return amount;
  }
  return 0;
};

export interface StoredHotelPayablePricingInput {
  storedTotal?: unknown;
  baseTotal?: unknown;
  marginAmount?: unknown;
  marginPercentage?: unknown;
}

/** Normalize legacy persisted rows to the margin-inclusive payable amount. */
export function resolveStoredHotelPayablePricing(input: StoredHotelPayablePricingInput) {
  const storedTotal = money(input.storedTotal);
  const baseTotal = money(input.baseTotal);
  const explicitMargin = money(input.marginAmount);
  const marginPercentage = Math.max(Number(input.marginPercentage || 0), 0);
  const calculatedMargin = explicitMargin > 0
    ? explicitMargin
    : money((baseTotal * marginPercentage) / 100);
  const payableTotal = Math.max(storedTotal, money(baseTotal + calculatedMargin));

  return {
    baseTotal,
    marginAmount: calculatedMargin,
    payableTotal: money(payableTotal),
    marginPercentage: marginPercentage > 0
      ? marginPercentage
      : baseTotal > 0 && calculatedMargin > 0
        ? money((calculatedMargin / baseTotal) * 100)
        : 0,
  };
}

/**
 * Convert one supplier option from base cost to the authoritative payable
 * amount. The marker makes the operation idempotent so snapshot refresh,
 * preview, and persistence can safely share the same projection.
 */
export function projectHotelPayablePricing<T extends Record<string, any>>(
  option: T,
  effectiveMarginPercentage: number,
): T {
  const alreadyProjected = option?.amountIncludesHotelMargin === true ||
    option?.pricingIncludesHotelMargin === true;
  const configuredMargin = Math.max(Number(effectiveMarginPercentage || 0), 0);
  const existingMargin = Math.max(Number(option?.hotelMarginPercentage ?? option?.marginPercentage ?? 0), 0);
  const marginPercentage = existingMargin > 0 ? existingMargin : configuredMargin;
  const payableBeforeProjection = positive(
    option?.totalHotelCost,
    option?.totalAmountAfterTax,
    option?.totalStayPrice,
    option?.totalPrice,
    option?.totalAmount,
    option?.price,
    option?.pricePerNight,
  );
  const baseTotal = positive(
    option?.baseTotalPrice,
    option?.baseStayPrice,
    option?.baseHotelCost,
    option?.baseAmount,
    option?.basePricePerNight,
    alreadyProjected ? 0 : payableBeforeProjection,
  );
  const basePerNight = positive(
    option?.basePricePerNight,
    option?.baseAmountPerNight,
    baseTotal,
  );
  const marginTotal = alreadyProjected
    ? positive(option?.hotelMarginTotalAmount, option?.hotelMarginStayAmount, option?.hotelMarginAmount)
    : money((baseTotal * marginPercentage) / 100);
  const marginPerNight = alreadyProjected
    ? positive(option?.hotelMarginAmount, marginTotal)
    : money((basePerNight * marginPercentage) / 100);
  const payableTotal = alreadyProjected
    ? positive(payableBeforeProjection, money(baseTotal + marginTotal))
    : money(baseTotal + marginTotal);
  const payablePerNight = alreadyProjected
    ? positive(option?.pricePerNight, option?.price, payableTotal)
    : money(basePerNight + marginPerNight);

  const projected = {
    ...option,
    basePricePerNight: basePerNight,
    baseTotalPrice: baseTotal,
    hotelMarginPercentage: marginPercentage,
    hotelMarginAmount: marginPerNight,
    hotelMarginStayAmount: marginTotal,
    hotelMarginTotalAmount: marginTotal,
    price: payablePerNight,
    pricePerNight: payablePerNight,
    totalPrice: payableTotal,
    totalStayPrice: payableTotal,
    totalHotelCost: payableTotal,
    totalAmount: payableTotal,
    totalAmountAfterTax: payableTotal,
    amountIncludesHotelMargin: true,
    pricingIncludesHotelMargin: true,
  } as T;

  if (Array.isArray(option?.rateOptions)) {
    (projected as any).rateOptions = option.rateOptions.map((rateOption: Record<string, any>) =>
      projectHotelPayablePricing({
        ...rateOption,
        provider: rateOption.provider || option.provider,
        hotelId: rateOption.hotelId || option.hotelId,
        canonicalHotelId: rateOption.canonicalHotelId || option.canonicalHotelId,
        hotelCode: rateOption.hotelCode || option.hotelCode,
      }, marginPercentage),
    );
  }

  return projected;
}
