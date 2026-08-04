/**
 * Resolve a hotel amount for the actual logical stay represented by a row.
 *
 * Supplier payloads and legacy persisted rows may carry the itinerary-wide
 * number of nights even when the row covers only one route-night. When dates
 * are present, the date span is authoritative; this prevents a stale 2-night
 * total from being displayed for a 1-night hotel stay.
 */
export function hotelStayNights(row: any, fallbackNights = 1): number {
  const checkIn = hotelDateOnly(row?.checkInDate ?? row?.check_in_date ?? row?.hotel_check_in_date);
  const checkOut = hotelDateOnly(row?.checkOutDate ?? row?.check_out_date ?? row?.hotel_check_out_date);
  if (checkIn && checkOut) {
    const start = Date.parse(`${checkIn}T00:00:00Z`);
    const end = Date.parse(`${checkOut}T00:00:00Z`);
    const nights = Math.round((end - start) / 86400000);
    if (Number.isFinite(nights) && nights > 0) return nights;
  }
  const supplied = Number(row?.numberOfNights ?? row?.number_of_nights ?? row?.noOfNights ?? row?.no_of_nights ?? 0);
  return Number.isFinite(supplied) && supplied > 0
    ? Math.max(Math.round(supplied), 1)
    : Math.max(Math.round(Number(fallbackNights) || 1), 1);
}

export function hotelStayTotal(row: any, fallbackNights = 1): number {
  const hasExplicitStayDates = Boolean(
    hotelDateOnly(row?.checkInDate ?? row?.check_in_date ?? row?.hotel_check_in_date) &&
    hotelDateOnly(row?.checkOutDate ?? row?.check_out_date ?? row?.hotel_check_out_date),
  );
  const nights = hotelStayNights(row, fallbackNights);
  const total = firstPositive(
    row?.selectedTotalPrice,
    row?.selected_total_price,
    row?.totalStayPrice,
    row?.total_stay_price,
    row?.totalPrice,
    row?.total_price,
    row?.totalFare,
    row?.totalAmount,
    row?.total_hotel_cost,
    row?.totalHotelCost,
  );
  const nightly = firstPositive(
    row?.pricePerNight,
    row?.price_per_night,
    row?.selectedPricePerNight,
    row?.selected_price_per_night,
    row?.perNightAmount,
    row?.price,
  );

  if (nightly > 0 && total > 0) {
    const suppliedNights = total / nightly;
    // A total which is an exact multiple of the nightly price is normally a
    // supplier/legacy full-stay amount. Rebuild it when the actual date span
    // proves that the row covers a different number of nights.
    if (hasExplicitStayDates && Number.isFinite(suppliedNights) && Math.abs(suppliedNights - Math.round(suppliedNights)) < 0.01 && Math.round(suppliedNights) !== nights) {
      return money(nightly * nights);
    }
    return money(total);
  }
  if (total > 0) return money(total);
  return nightly > 0 ? money(nightly * nights) : 0;
}

export function hotelDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return 0;
}

function money(value: number): number {
  return Number(value.toFixed(2));
}
