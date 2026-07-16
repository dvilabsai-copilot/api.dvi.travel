import { Injectable } from '@nestjs/common';

export interface AttractionTimingProjection {
  visitTimeDisplay: string | null;
  operatingHours: string;
  timingValidationExecuted: boolean;
  timingValidationPassed: boolean;
  timingValidationSkippedReason: string | null;
}

@Injectable()
export class ItineraryDetailsAttractionTimingService {
  build(context: {
    routeDate: Date | null | undefined;
    hotspotId: number | null | undefined;
    startTimeText: string | null;
    endTimeText: string | null;
    timings: any[];
    orderedTimeRange: (start: string | null, end: string | null) => string | null;
    timeToMinutes: (value: string | null | undefined) => number;
    formatTime: (value: any) => string;
  }): AttractionTimingProjection {
    const {
      routeDate,
      hotspotId,
      startTimeText,
      endTimeText,
      timings,
      orderedTimeRange,
      timeToMinutes,
      formatTime,
    } = context;
    const orderedVisitRange = orderedTimeRange(startTimeText, endTimeText);
    let visitTimeDisplay = orderedVisitRange;
    let timingValidationExecuted = false;
    let timingValidationPassed = false;
    let timingValidationSkippedReason: string | null = null;

    if (visitTimeDisplay && hotspotId && routeDate) {
      timingValidationExecuted = true;
      const dayOfWeek = (routeDate.getDay() + 6) % 7;
      const dayTimings = timings.filter((timing) => Number(timing.hotspot_timing_day) === dayOfWeek);
      const todayTimings = dayTimings.filter((timing) => timing.hotspot_closed !== 1);

      if (dayTimings.length > 0 && todayTimings.length === 0) {
        visitTimeDisplay = orderedVisitRange
          ? `${orderedVisitRange} (closed on this day)`
          : null;
      }

      if (todayTimings.length > 0) {
        const isOpenAllTime = todayTimings.some((timing) => timing.hotspot_open_all_time === 1);
        if (!isOpenAllTime) {
          const visitStartText = orderedVisitRange
            ? String(orderedVisitRange).split(' - ')[0]?.trim()
            : startTimeText;
          const visitEndText = orderedVisitRange
            ? String(orderedVisitRange).split(' - ')[1]?.trim()
            : endTimeText;
          const arrivalMins = timeToMinutes(visitStartText);
          const departureMins = timeToMinutes(visitEndText);
          const fitsInAnyWindow = todayTimings.some((timing) => {
            const opStart = timeToMinutes(formatTime(timing.hotspot_start_time as any));
            const opEnd = timeToMinutes(formatTime(timing.hotspot_end_time as any));
            return arrivalMins >= opStart && departureMins <= opEnd;
          });

          if (!fitsInAnyWindow) {
            const nextOpening = todayTimings
              .map((timing) => formatTime(timing.hotspot_start_time as any))
              .filter((openingTime) => timeToMinutes(openingTime) > arrivalMins)
              .sort((a, b) => timeToMinutes(a) - timeToMinutes(b))[0];
            visitTimeDisplay = nextOpening
              ? (orderedVisitRange ? `${orderedVisitRange} (opens at ${nextOpening})` : null)
              : (orderedVisitRange ? `${orderedVisitRange} (outside operating hours)` : null);
          }
          timingValidationPassed = fitsInAnyWindow;
        } else {
          timingValidationPassed = true;
        }
      } else {
        timingValidationSkippedReason = 'No open timings configured for the route day';
      }
    } else {
      timingValidationSkippedReason = 'Missing visit range, hotspot id, or route date';
    }

    const dayOfWeek = routeDate ? (routeDate.getDay() + 6) % 7 : 0;
    const dayTimings = timings.filter((timing) => Number(timing.hotspot_timing_day) === dayOfWeek);
    const todayTimings = dayTimings.filter((timing) => timing.hotspot_closed !== 1);
    let operatingHours = '';
    if (dayTimings.length > 0 && todayTimings.length === 0) {
      operatingHours = 'Closed';
    } else if (todayTimings.length > 0) {
      operatingHours = todayTimings.some((timing) => timing.hotspot_open_all_time === 1)
        ? 'Open 24 Hours'
        : todayTimings
            .map((timing) => `${formatTime(timing.hotspot_start_time as any)} - ${formatTime(timing.hotspot_end_time as any)}`)
            .join(', ');
    }

    return {
      visitTimeDisplay,
      operatingHours,
      timingValidationExecuted,
      timingValidationPassed,
      timingValidationSkippedReason,
    };
  }
}
