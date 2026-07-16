import { Injectable } from '@nestjs/common';

export type TerminalReturnSegment =
  | {
      type: 'travel';
      from: string | null;
      to: string;
      timeRange: string;
      distance: string;
      duration: string;
      note: string;
      isConflict: false;
      conflictReason: null;
    }
  | {
      type: 'return';
      time: string;
      note: null;
    };

@Injectable()
export class ItineraryDetailsTerminalReturnService {
  build(context: {
    emittedTerminalSegment: boolean;
    previousStopName: string | null;
    route: any;
    plan: any;
    formatTime: (value: any) => string;
    formatTravelDistance: (value: number | null) => string;
    formatDuration: (value: any) => string;
    formatDurationFromDisplayRange: (start: string, end: string) => string | null;
  }): TerminalReturnSegment | null {
    const {
      emittedTerminalSegment,
      previousStopName,
      route,
      plan,
      formatTime,
      formatTravelDistance,
      formatDuration,
      formatDurationFromDisplayRange,
    } = context;
    if (emittedTerminalSegment) return null;

    const dayStartTimeText = formatTime(route.route_start_time as any);
    const dayEndTimeText = formatTime(route.route_end_time as any);
    const terminalDestinationName = String(
      route.next_visiting_location ?? plan.departure_location ?? 'Departure Point',
    ).trim();
    const isTerminalDeparture =
      /(airport|air\s*port|railway|rail\s*way|station|bus\s*stand|bus\s*station|terminal|terminus|junction|stn)\b/i
        .test(terminalDestinationName);

    if (isTerminalDeparture) {
      return {
        type: 'travel',
        from: previousStopName,
        to: terminalDestinationName,
        timeRange:
          dayStartTimeText && dayEndTimeText
            ? `${dayStartTimeText} -> ${dayEndTimeText}`
            : dayEndTimeText || dayStartTimeText || '',
        distance: formatTravelDistance(Number(route.no_of_km ?? 0) || null),
        duration:
          dayStartTimeText && dayEndTimeText
            ? formatDurationFromDisplayRange(dayStartTimeText, dayEndTimeText) ?? formatDuration('00:00:00')
            : formatDuration('00:00:00'),
        note: 'Airport transfer',
        isConflict: false,
        conflictReason: null,
      };
    }

    return { type: 'return', time: dayEndTimeText, note: null };
  }
}
