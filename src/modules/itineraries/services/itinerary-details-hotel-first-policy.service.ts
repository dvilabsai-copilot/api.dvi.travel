type HotelFirstPolicyContext = {
  segments: any[];
  routeHotelName: string;
  normalizeName: (value?: string | null) => string;
  timeToMinutes: (value: string | null) => number;
};

/** Keeps the start/check-in order stable for hotel-first itinerary timelines. */
export class ItineraryDetailsHotelFirstPolicyService {
  apply(context: HotelFirstPolicyContext): any[] {
    const { segments, routeHotelName, normalizeName, timeToMinutes } = context;
    const getSegmentStartMinutes = (segment: any): number | null => {
      if (!segment) return null;
      let text: string | null = null;
      if (segment.type === 'start' || segment.type === 'travel' || segment.type === 'return' || segment.type === 'break') {
        text = segment.timeRange ? String(segment.timeRange).split(' - ')[0]?.trim() : null;
      } else if (segment.type === 'attraction') {
        text = segment.visitTime ? String(segment.visitTime).split(' - ')[0]?.trim() : null;
      } else if (segment.type === 'checkin') {
        text = segment.time ? String(segment.time).split(' - ')[0]?.trim() : null;
      }
      return text ? timeToMinutes(text) : null;
    };

    const routeHotelNameNormalized = normalizeName(routeHotelName);
    const startIndex = segments.findIndex((segment: any) => segment?.type === 'start');
    const checkinIndex = segments.findIndex((segment: any) => segment?.type === 'checkin');
    const firstHotelDepartureTravel = segments.find((segment: any) => {
      if (segment?.type !== 'travel') return false;
      const from = normalizeName(segment?.from);
      const to = normalizeName(segment?.to);
      return routeHotelNameNormalized.length > 0 && from === routeHotelNameNormalized && to !== routeHotelNameNormalized;
    });
    const checkinStart = checkinIndex >= 0 ? getSegmentStartMinutes(segments[checkinIndex]) : null;
    const departureStart = getSegmentStartMinutes(firstHotelDepartureTravel);
    const isHotelFirstFlow = checkinIndex >= 0 && !!firstHotelDepartureTravel && checkinStart !== null && departureStart !== null && checkinStart <= departureStart;

    if (isHotelFirstFlow && startIndex >= 0 && startIndex < checkinIndex) {
      const [startSegment] = segments.splice(startIndex, 1);
      const refreshedCheckinIndex = segments.findIndex((segment: any) => segment?.type === 'checkin');
      if (refreshedCheckinIndex >= 0) segments.splice(refreshedCheckinIndex, 0, startSegment);
      else segments.unshift(startSegment);
    }
    return segments;
  }
}
