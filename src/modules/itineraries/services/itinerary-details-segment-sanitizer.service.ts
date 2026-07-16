type SegmentSanitizerContext = {
  segments: any[];
  excludedIds: Set<number>;
  hotspotMap: Map<number, any>;
  normalizePlaceLabel: (value: any) => string;
  isGenericHotelLabel: (value: any) => boolean;
  isSamePlaceLike: (a: any, b: any) => boolean;
};

/** Removes excluded hotspots and invalid no-op timeline travel rows. */
export class ItineraryDetailsSegmentSanitizerService {
  sanitize(context: SegmentSanitizerContext): any[] {
    const {
      segments,
      excludedIds,
      hotspotMap,
      normalizePlaceLabel,
      isGenericHotelLabel,
      isSamePlaceLike,
    } = context;
    const excludedNames = new Set<string>();
    for (const hotspotId of excludedIds.values()) {
      const master = hotspotMap.get(hotspotId);
      const normalized = normalizePlaceLabel(master?.hotspot_name || '');
      if (normalized) excludedNames.add(normalized);
    }

    const textMentionsExcluded = (...values: any[]): boolean => {
      const haystack = normalizePlaceLabel(values.filter(Boolean).join(' '));
      if (!haystack) return false;
      for (const excludedName of excludedNames.values()) {
        if (excludedName && haystack.includes(excludedName)) return true;
      }
      return false;
    };

    return (Array.isArray(segments) ? segments : []).filter((segment: any) => {
      const type = String(segment?.type || '').toLowerCase();
      if (type === 'attraction') {
        const segmentId = Number(segment?.hotspotId ?? segment?.locationId ?? 0);
        if (segmentId > 0 && excludedIds.has(segmentId)) return false;
        return !textMentionsExcluded(segment?.name, segment?.text, segment?.description);
      }
      if (type === 'hotspot') {
        return !textMentionsExcluded(segment?.anchorFrom, segment?.anchorTo, segment?.text, segment?.name);
      }
      if (type === 'travel') {
        if (textMentionsExcluded(
          segment?.from,
          segment?.to,
          segment?.fromName,
          segment?.toName,
          segment?.displayFromName,
          segment?.displayToName,
          segment?.text,
          segment?.name,
        )) return false;
        if (isGenericHotelLabel(segment?.from) && isGenericHotelLabel(segment?.to)) return false;
        if (isSamePlaceLike(segment?.from, segment?.to)) return false;
      }
      return true;
    });
  }
}
