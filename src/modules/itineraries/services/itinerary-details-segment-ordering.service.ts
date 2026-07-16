type SegmentOrderingContext = {
  parseDisplayTimeMinutesStrict: (value: string | null) => number | null;
  normalizeName: (value?: string | null) => string;
};

/** Sorts timeline segments while reinserting travel-anchor CTA rows. */
export class ItineraryDetailsSegmentOrderingService {
  order(segments: any[], context: SegmentOrderingContext): any[] {
    const { parseDisplayTimeMinutesStrict, normalizeName } = context;
    type CtaEntry = { cta: any; afterSegmentRef: any | null };
    const ctaEntries: CtaEntry[] = [];
    const nonCtaSegments: any[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment?.type === 'hotspot' && segment?.anchorType === 'after_travel') {
        let afterRef: any | null = null;
        for (let j = i - 1; j >= 0; j--) {
          if (!(segments[j]?.type === 'hotspot' && segments[j]?.anchorType === 'after_travel')) {
            afterRef = segments[j];
            break;
          }
        }
        ctaEntries.push({ cta: segment, afterSegmentRef: afterRef });
      } else {
        nonCtaSegments.push(segment);
      }
    }

    const getMinutes = (segment: any, end: boolean): number => {
      let timeText: string | null = null;
      if (segment.type === 'start' || segment.type === 'travel' || segment.type === 'return' || segment.type === 'break') {
        timeText = segment.timeRange ? String(segment.timeRange).split(' - ')[end ? 1 : 0] : null;
      } else if (segment.type === 'attraction') {
        timeText = segment.visitTime ? String(segment.visitTime).split(' - ')[end ? 1 : 0] : null;
      } else if (segment.type === 'checkin') {
        timeText = segment.time ? String(segment.time).split(' - ')[0] : null;
      }
      const normalized = timeText?.split('(')[0]?.trim() || null;
      const parsed = normalized ? parseDisplayTimeMinutesStrict(normalized) : null;
      return parsed === null ? 1440 : parsed;
    };

    const typeOrder: Record<string, number> = {
      start: 0,
      travel: 1,
      attraction: 2,
      break: 3,
      checkin: 4,
      return: 5,
    };
    nonCtaSegments.sort((a: any, b: any) => {
      const startDiff = getMinutes(a, false) - getMinutes(b, false);
      if (startDiff !== 0) return startDiff;
      const endDiff = getMinutes(a, true) - getMinutes(b, true);
      if (endDiff !== 0) return endDiff;

      if (a?.type === 'travel' && b?.type === 'attraction') {
        const aFrom = normalizeName(a?.from);
        const aTo = normalizeName(a?.to);
        const bName = normalizeName(b?.name);
        if (aFrom.length > 0 && bName.length > 0 && aFrom === bName) return 1;
        if (aTo.length > 0 && bName.length > 0 && aTo === bName) return -1;
      }
      if (a?.type === 'attraction' && b?.type === 'travel') {
        const bFrom = normalizeName(b?.from);
        const bTo = normalizeName(b?.to);
        const aName = normalizeName(a?.name);
        if (bFrom.length > 0 && aName.length > 0 && bFrom === aName) return -1;
        if (bTo.length > 0 && aName.length > 0 && bTo === aName) return 1;
      }
      return (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
    });

    for (const { cta, afterSegmentRef } of [...ctaEntries].reverse()) {
      let insertAt = nonCtaSegments.length;
      if (afterSegmentRef !== null) {
        const refIndex = nonCtaSegments.indexOf(afterSegmentRef);
        if (refIndex !== -1) insertAt = refIndex + 1;
      }
      nonCtaSegments.splice(insertAt, 0, cta);
    }
    return nonCtaSegments;
  }
}
