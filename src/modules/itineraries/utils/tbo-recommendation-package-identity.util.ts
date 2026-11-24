/**
 * Recommendation identity is a FULL route->hotel PACKAGE, not a single hotel.
 * A two-city itinerary legitimately has different hotels in its one package.
 * This helper only detects a second complete package that exactly repeats the
 * same hotel on every saved route; partial drafts are allowed while editing.
 */
export function findDuplicateHotelRecommendationPackage(
  groups: ReadonlyMap<number, ReadonlyMap<number, string>>,
  targetGroup: number,
  updatedRouteIds: readonly number[],
  updatedHotelCode: string,
): number | null {
  const target = new Map(groups.get(targetGroup) || []);
  const normalizedCode = String(updatedHotelCode || '').trim().toLowerCase();
  if (!normalizedCode || !Number.isInteger(targetGroup) || targetGroup < 1 || targetGroup > 4) return null;
  for (const routeId of updatedRouteIds) {
    if (!Number.isInteger(routeId) || routeId < 1) return null;
    target.set(routeId, normalizedCode);
  }
  const knownRoutes = new Set<number>(target.keys());
  for (const routes of groups.values()) {
    for (const routeId of routes.keys()) knownRoutes.add(routeId);
  }
  if (target.size !== knownRoutes.size) return null;
  for (const [otherGroup, routeHotels] of groups) {
    if (otherGroup === targetGroup || routeHotels.size !== target.size) continue;
    if ([...target].every(([routeId, code]) =>
      String(routeHotels.get(routeId) || '').trim().toLowerCase() === String(code).trim().toLowerCase()
    )) return otherGroup;
  }
  return null;
}
