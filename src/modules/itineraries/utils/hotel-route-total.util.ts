type HotelSelectionLike = {
  selectedPriceSnapshot?: unknown;
  selected_price_snapshot?: unknown;
  pricingScope?: unknown;
  numberOfNights?: unknown;
  nights?: unknown;
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
  const numberOfNights = Number(selection.numberOfNights ?? selection.nights ?? 1);
  return numberOfNights > 1 &&
    !isRouteNightHotelSelection(selection) &&
    Number.isFinite(selectedDate) &&
    Number.isFinite(previousDate) &&
    selectedDate - Number(previousDate) === 24 * 60 * 60 * 1000;
}
