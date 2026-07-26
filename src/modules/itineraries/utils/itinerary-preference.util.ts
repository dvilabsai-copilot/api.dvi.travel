export function resolveItineraryPreference({
  rawPreference,
  hasRouteFamily,
  hasHotelRows,
  hasVehicleRows,
}: {
  rawPreference: unknown;
  hasRouteFamily: boolean;
  hasHotelRows: boolean;
  hasVehicleRows: boolean;
}): number {
  const preference = Number(rawPreference || 0);

  // An explicit preference is authoritative. Old hotel/vehicle rows can remain
  // after editing a plan, so row presence must not turn Vehicle Only (2) back
  // into Vehicle + Hotel (3).
  if (preference !== 0) return preference;

  // Legacy route-family variants may not have a preference persisted. Infer the
  // combined mode only for that missing-value case.
  return hasRouteFamily && hasHotelRows && hasVehicleRows ? 3 : preference;
}
