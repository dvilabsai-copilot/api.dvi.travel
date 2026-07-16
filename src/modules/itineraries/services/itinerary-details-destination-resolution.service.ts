type DestinationResolutionContext = {
  hotspotMap: Map<number, any>;
  hotspotNameToIdMap: Map<string, number>;
  route: any;
  location: any;
  plan: any;
  normalizeLookupName: (value?: string | null) => string;
  isForcedManualConflictAttractionRow: (row: any) => boolean;
  getRouteHotelName: () => string;
};

/** Resolves semantic next stops and hotspot IDs from timeline display labels. */
export class ItineraryDetailsDestinationResolutionService {
  findNextSemanticDestinationName(
    rows: any[],
    currentIndex: number,
    context: DestinationResolutionContext,
  ): string | null {
    const {
      hotspotMap,
      route,
      location,
      plan,
      isForcedManualConflictAttractionRow,
      getRouteHotelName,
    } = context;
    for (let nextIndex = currentIndex + 1; nextIndex < rows.length; nextIndex++) {
      const nextRow = rows[nextIndex];
      const nextItemType = Number((nextRow as any).item_type ?? 0);

      if (nextItemType === 4) {
        if (isForcedManualConflictAttractionRow(nextRow)) continue;
        const nextMaster = nextRow.hotspot_ID ? hotspotMap.get(nextRow.hotspot_ID as number) || null : null;
        const nextHotspotName = nextMaster?.hotspot_name?.trim();
        if (nextHotspotName) return nextHotspotName;
        continue;
      }

      if (nextItemType === 5 || nextItemType === 6) continue;

      if (nextItemType === 2 || nextItemType === 7) {
        const nextLocationName = route.next_visiting_location ?? location?.destination_location ?? plan.departure_location ?? null;
        if (!nextLocationName) continue;
        return nextLocationName === 'Hotel' ? getRouteHotelName() : nextLocationName;
      }

      if (nextItemType === 3) {
        if (Number((nextRow as any).allow_break_hours ?? 0) === 1) continue;
        const nextViaLocationName = (nextRow as any).via_location_name?.trim();
        if (Number((nextRow as any).allow_via_route ?? 0) === 1 && nextViaLocationName) {
          return nextViaLocationName;
        }
        if (Number((nextRow as any).hotspot_ID ?? 0) === 0) {
          const nextLocationName = route.next_visiting_location ?? location?.destination_location ?? plan.departure_location ?? null;
          if (!nextLocationName) continue;
          return nextLocationName === 'Hotel' ? getRouteHotelName() : nextLocationName;
        }
      }
    }
    return null;
  }

  inferHotspotIdFromLabel(label: string | null | undefined, context: DestinationResolutionContext): number | null {
    const normalized = context.normalizeLookupName(label);
    if (!normalized) return null;
    const exact = context.hotspotNameToIdMap.get(normalized);
    if (exact && exact > 0) return exact;
    for (const [name, id] of context.hotspotNameToIdMap.entries()) {
      if (name.includes(normalized) || normalized.includes(name)) return id > 0 ? id : null;
    }
    return null;
  }
}
