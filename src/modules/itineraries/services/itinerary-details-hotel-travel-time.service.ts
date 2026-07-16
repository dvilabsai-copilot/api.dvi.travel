import { Injectable } from '@nestjs/common';

export interface HotelTravelTimeProjection {
  timeRange: string | null;
  hotelArrivalTime: string | null;
}

@Injectable()
export class ItineraryDetailsHotelTravelTimeService {
  build(context: {
    startTimeText: string | null;
    endTimeText: string | null;
    travelDuration: any;
    quoteId: number;
    routeId: number;
    routeHotspotId: number;
    fromName: string;
    toName: string;
    proofQuoteEnabled: boolean;
    timeToMinutes: (value: string | null | undefined) => number;
    getTravelTimeRangeWithDuration: (start: string, end: string, duration: any) => string | null;
  }): HotelTravelTimeProjection {
    const {
      startTimeText,
      endTimeText,
      travelDuration,
      quoteId,
      routeId,
      routeHotspotId,
      fromName,
      toName,
      proofQuoteEnabled,
      timeToMinutes,
      getTravelTimeRangeWithDuration,
    } = context;
    let timeRange: string | null = null;
    let hotelArrivalTime: string | null = null;

    if (startTimeText && endTimeText) {
      const startMins = timeToMinutes(startTimeText);
      const endMins = timeToMinutes(endTimeText);
      if (startMins > endMins) {
        timeRange = `${endTimeText} - ${startTimeText}`;
        hotelArrivalTime = startTimeText;
        if (proofQuoteEnabled) {
          console.log('[Item5TimeReversal][PROOF]', {
            quoteId,
            routeId,
            routeHotspotId,
            storageOrder: `${startTimeText} - ${endTimeText}`,
            emitOrder: timeRange,
            fromLocation: fromName,
            toLocation: toName,
            storedHotelArrivalTime: hotelArrivalTime,
          });
        }
        console.log('[TravelMapping][PROOF] item_type=5 reversed time range normalised', {
          quoteId,
          routeHotspotId,
          from: fromName,
          to: toName,
          storedRange: `${startTimeText} - ${endTimeText}`,
          emittedRange: timeRange,
        });
      } else {
        timeRange = `${startTimeText} - ${endTimeText}`;
        hotelArrivalTime = endTimeText;
      }

      if (startMins === endMins) {
        const derivedRange = getTravelTimeRangeWithDuration(startTimeText, endTimeText, travelDuration);
        if (derivedRange) {
          timeRange = derivedRange;
          const parts = derivedRange.split(' - ');
          if (parts.length === 2) hotelArrivalTime = parts[1].trim();
        }
      }
    }

    return { timeRange, hotelArrivalTime };
  }
}
