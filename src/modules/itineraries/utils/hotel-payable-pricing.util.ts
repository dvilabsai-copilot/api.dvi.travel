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
  const explicitBaseTotal = positive(
    option?.baseTotalPrice,
    option?.baseStayPrice,
    option?.baseHotelCost,
    option?.baseAmount,
  );
  const roomCount = Math.max(
    Number(option?.total_no_of_rooms ?? option?.noOfRooms ?? option?.roomCount ?? 1),
    1,
  );
  const baseTotal = explicitBaseTotal > 0
    ? explicitBaseTotal
    : positive(option?.basePricePerNight, alreadyProjected ? 0 : payableBeforeProjection);
  const rawBasePerNight = positive(
    option?.basePricePerNight,
    option?.baseAmountPerNight,
    baseTotal,
  );
  const basePerNight = explicitBaseTotal > 0 && roomCount > 1 &&
    Math.abs(rawBasePerNight - explicitBaseTotal) < 0.01
    ? money(explicitBaseTotal / roomCount)
    : rawBasePerNight;
  const supplementTotal = money(
    positive(option?.extraBedAmount, option?.extraBedCost, option?.total_extra_bed_cost) +
    positive(option?.childWithBedAmount, option?.childWithBedCost, option?.total_childwith_bed_cost) +
    positive(option?.childWithoutBedAmount, option?.childWithoutBedCost, option?.total_childwithout_bed_cost),
  );
  const marginBaseTotal = money(baseTotal + supplementTotal);
  const marginBasePerNight = money(basePerNight + supplementTotal);
  const marginTotal = alreadyProjected
    ? marginPercentage > 0
      ? money((marginBaseTotal * marginPercentage) / 100)
      : positive(option?.hotelMarginTotalAmount, option?.hotelMarginStayAmount, option?.hotelMarginAmount)
    : money((marginBaseTotal * marginPercentage) / 100);
  const marginPerNight = alreadyProjected
    ? marginPercentage > 0
      ? money((marginBasePerNight * marginPercentage) / 100)
      : positive(option?.hotelMarginAmount, marginTotal)
    : money((marginBasePerNight * marginPercentage) / 100);
  const reconstructedPayableTotal = money(marginBaseTotal + marginTotal);
  const reconstructedPayablePerNight = money(marginBasePerNight + marginPerNight);
  const payableTotal = alreadyProjected
    ? Math.max(payableBeforeProjection, reconstructedPayableTotal)
    : reconstructedPayableTotal;
  const payablePerNight = alreadyProjected
    ? Math.max(
        positive(option?.pricePerNight, option?.price, payableTotal),
        reconstructedPayablePerNight,
      )
    : reconstructedPayablePerNight;

  const projected = {
    ...option,
    basePricePerNight: basePerNight,
    baseTotalPrice: baseTotal,
    // Canonical room pricing is provider-neutral: the room rate is one
    // room's pure charge for one physical night, while totalRoomCost is the
    // room-only amount for the requested room count.  Supplier-specific
    // adapters may already provide these values, but legacy TBO/VSR rows do
    // not, so normalize them here instead of making React infer them.
    roomRate: positive(option?.roomRate, option?.room_rate, basePerNight),
    totalRoomCost: positive(option?.totalRoomCost, option?.total_room_cost, baseTotal),
    hotelMarginPercentage: marginPercentage,
    hotelMarginAmount: marginPerNight,
    hotelMarginStayAmount: marginTotal,
    hotelMarginTotalAmount: marginTotal,
    hotelMarginBaseAmount: marginBaseTotal,
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

  // Persisted selected rows expose a second price surface that the itinerary
  // table uses in preference to the generic total fields. Keep it aligned
  // with the projected payable amount; otherwise the card/tooltip can show
  // margin-inclusive pricing while the table still renders the old base rate.
  if (option?.isSelected === true || String(option?.selectionOrigin || '').trim()) {
    (projected as any).selectedTotalPrice = payableTotal;
    (projected as any).selected_total_price = payableTotal;
    (projected as any).selectedPricePerNight = payablePerNight;
    (projected as any).selected_price_per_night = payablePerNight;
  }

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
