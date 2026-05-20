interface SelectedHotspotLike {
  hotspot_ID: number;
}

export function queueDeferredMustVisitHotspot<T extends SelectedHotspotLike>(
  deferredHotspots: T[],
  deferredIds: Set<number>,
  hotspot: T,
  pass: number,
  isStageAPriority: boolean,
): boolean {
  if (pass !== 1 || !isStageAPriority) {
    return false;
  }

  const hotspotId = Number(hotspot?.hotspot_ID || 0);
  if (hotspotId <= 0 || deferredIds.has(hotspotId)) {
    return false;
  }

  deferredHotspots.push(hotspot);
  deferredIds.add(hotspotId);
  return true;
}