import { Injectable } from '@nestjs/common';

export interface DropOffProjection {
  toName: string;
  shouldSuppress: boolean;
  segment: {
    type: 'travel';
    from: string | null;
    to: string;
    timeRange: string | null;
    distance: string;
    duration: string;
    note: string;
    isConflict: boolean;
    conflictReason: unknown;
  };
}

@Injectable()
export class ItineraryDetailsDropOffService {
  build(context: {
    route: any;
    plan: any;
    previousStopName: string | null;
    startTimeText: string | null;
    endTimeText: string | null;
    travelDistance: string;
    travelDuration: any;
    routeEndMins: number;
    isConflict: boolean;
    conflictReason: unknown;
    quoteId: number;
    routeHotspotId: number;
    proofQuoteEnabled: boolean;
    timeToMinutes: (value: string | null | undefined) => number;
    getTravelTimeRangeWithDuration: (start: string | null, end: string | null, duration: any) => string | null;
    formatDuration: (value: any) => string;
  }): DropOffProjection {
    const {
      route,
      plan,
      previousStopName,
      startTimeText,
      endTimeText,
      travelDistance,
      travelDuration,
      routeEndMins,
      isConflict,
      conflictReason,
      quoteId,
      routeHotspotId,
      proofQuoteEnabled,
      timeToMinutes,
      getTravelTimeRangeWithDuration,
      formatDuration,
    } = context;
    const toName = route.next_visiting_location ?? plan.departure_location ?? 'Departure Point';
    const dropOffEndMins = endTimeText ? timeToMinutes(endTimeText) : 0;
    const shouldSuppress = dropOffEndMins > routeEndMins;
    if (shouldSuppress && proofQuoteEnabled) {
      console.log('[RouteEndValidation][DROPOFF_SUPPRESSED][PROOF]', {
        quoteId,
        routeId: route.itinerary_route_ID,
        routeHotspotId,
        dropOffEndTime: endTimeText,
        dropOffEndMins,
        routeEndMins,
        exceedsByMins: dropOffEndMins - routeEndMins,
        reason: 'DROP_OFF exceeds route end time - segment suppressed',
      });
    }

    return {
      toName,
      shouldSuppress,
      segment: {
        type: 'travel',
        from: previousStopName,
        to: toName,
        timeRange: getTravelTimeRangeWithDuration(startTimeText, endTimeText, travelDuration),
        distance: travelDistance,
        duration: formatDuration(travelDuration),
        note: 'This may vary due to traffic conditions',
        isConflict,
        conflictReason,
      },
    };
  }
}
