export interface IntercityDisplayDistanceInputs {
  viaRouteDistanceKm: number;
  storedIntercityDistanceKm: number;
  travelSegmentDistanceKm: number;
  sightseeingDistanceKm: number;
  hasHotspotSegments: boolean;
}

/**
 * Resolves the distance shown in the itinerary day header.
 *
 * A direct, non-sightseeing day has no separate sightseeing movement, so the
 * visible travel rows are the authoritative display distance. This prevents a
 * stale persisted route distance from disagreeing with the route shown below.
 * Hotspot days retain the existing via-route/stored-route precedence because
 * their travel rows also include sightseeing movement.
 */
export function resolveIntercityDisplayDistanceKm({
  viaRouteDistanceKm,
  storedIntercityDistanceKm,
  travelSegmentDistanceKm,
  sightseeingDistanceKm,
  hasHotspotSegments,
}: IntercityDisplayDistanceInputs): number {
  const hasDirectTimelineDistance =
    !hasHotspotSegments &&
    sightseeingDistanceKm <= 0 &&
    travelSegmentDistanceKm > 0;

  if (hasDirectTimelineDistance) return travelSegmentDistanceKm;
  if (viaRouteDistanceKm > 0) return viaRouteDistanceKm;
  if (storedIntercityDistanceKm > 0) return storedIntercityDistanceKm;
  return travelSegmentDistanceKm;
}
