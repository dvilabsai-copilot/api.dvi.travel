type HotelSelectionLike = {
  selectedPriceSnapshot?: unknown;
  selected_price_snapshot?: unknown;
  pricingScope?: unknown;
  numberOfNights?: unknown;
  nights?: unknown;
  pricePerNight?: unknown;
  selectedPricePerNight?: unknown;
  totalPrice?: unknown;
  selectedTotalPrice?: unknown;
  totalStayPrice?: unknown;
};

const parseSnapshot = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/** Route-night selections carry one payable amount for each itinerary night. */
export function isRouteNightHotelSelection(selection: HotelSelectionLike): boolean {
  const snapshot = parseSnapshot(selection.selectedPriceSnapshot ?? selection.selected_price_snapshot);
  return String(snapshot.pricingScope ?? selection.pricingScope ?? '').trim().toUpperCase() === 'ROUTE_NIGHT';
}

/** A selection is a full-stay amount only when the saved data says so. */
export function isFullStayHotelSelection(selection: HotelSelectionLike): boolean {
  if (isRouteNightHotelSelection(selection)) return false;

  const numberOfNights = Number(selection.numberOfNights ?? selection.nights ?? 1);
  if (numberOfNights > 1) return true;

  const perNight = Number(selection.pricePerNight ?? selection.selectedPricePerNight ?? 0);
  const stayTotal = Number(
    selection.totalStayPrice ??
    selection.selectedTotalPrice ??
    selection.totalPrice ??
    0,
  );
  return perNight > 0 && stayTotal > perNight + 0.009;
}

/**
 * A repeated date should be ignored only when the saved amount is explicitly
 * a continuous-stay amount. Route-night snapshots must keep every night even
 * when they share the same commercial hotel/rate identity.
 */
export function shouldSkipRepeatedHotelNight(
  selection: HotelSelectionLike,
  previousDate: number | undefined,
  selectedDate: number,
): boolean {
  return isFullStayHotelSelection(selection) &&
    Number.isFinite(selectedDate) &&
    Number.isFinite(previousDate) &&
    selectedDate - Number(previousDate) === 24 * 60 * 60 * 1000;
}
