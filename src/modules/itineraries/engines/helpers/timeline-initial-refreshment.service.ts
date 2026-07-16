import { Injectable } from '@nestjs/common';
import { TimeConverter } from './time-converter';

@Injectable()
export class TimelineInitialRefreshmentService {
  async apply(context: {
    tx: any;
    planId: number;
    route: any;
    isLastRoute: boolean;
    skipInitialRefreshmentForImmediateHotelCheckin: boolean;
    enforceStrictDay1EarlyArrivalDeferredFlow: boolean;
    firstSightseeingMovementTime: string | null;
    isTransferOnlyLastRouteByReportDeadline: boolean;
    currentTime: string;
    routeEndSeconds: number;
    order: number;
    createdByUserId: number;
    timeToSeconds: (value: string) => number;
    addSeconds: (value: string, seconds: number) => string;
  }): Promise<{ rows: any[]; currentTime: string; order: number }> {
    const {
      tx,
      planId,
      route,
      isLastRoute,
      skipInitialRefreshmentForImmediateHotelCheckin,
      enforceStrictDay1EarlyArrivalDeferredFlow,
      firstSightseeingMovementTime,
      isTransferOnlyLastRouteByReportDeadline,
      currentTime,
      routeEndSeconds,
      order,
      createdByUserId,
      timeToSeconds,
      addSeconds,
    } = context;
    let nextCurrentTime = currentTime;
    let nextOrder = order;
    const rows: any[] = [];

    if (!isLastRoute && !skipInitialRefreshmentForImmediateHotelCheckin) {
      const globalSettings = await tx.dvi_global_settings?.findFirst({
        where: { status: 1, deleted: 0 },
        select: { itinerary_common_buffer_time: true },
      });
      const bufferTime = enforceStrictDay1EarlyArrivalDeferredFlow
        ? '01:00:00'
        : (globalSettings?.itinerary_common_buffer_time
          ? (globalSettings.itinerary_common_buffer_time instanceof Date
            ? `${String(globalSettings.itinerary_common_buffer_time.getUTCHours()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCMinutes()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCSeconds()).padStart(2, '0')}`
            : String(globalSettings.itinerary_common_buffer_time))
          : '01:00:00');
      const bufferSeconds = timeToSeconds(bufferTime);
      const refreshmentEndTime = enforceStrictDay1EarlyArrivalDeferredFlow && firstSightseeingMovementTime
        ? firstSightseeingMovementTime
        : addSeconds(currentTime, bufferSeconds);
      if (timeToSeconds(refreshmentEndTime) <= routeEndSeconds) {
        rows.push({
          itinerary_plan_ID: planId,
          itinerary_route_ID: route.itinerary_route_ID,
          item_type: 1,
          hotspot_order: nextOrder++,
          hotspot_traveling_time: TimeConverter.toDate(bufferTime),
          hotspot_start_time: TimeConverter.toDate(currentTime),
          hotspot_end_time: TimeConverter.toDate(refreshmentEndTime),
          createdby: createdByUserId,
          status: 1,
          deleted: 0,
        });
        nextCurrentTime = refreshmentEndTime;
        if (enforceStrictDay1EarlyArrivalDeferredFlow && firstSightseeingMovementTime) {
          nextCurrentTime = firstSightseeingMovementTime;
        }
      }
    } else if (isLastRoute && !isTransferOnlyLastRouteByReportDeadline) {
      const globalSettings = await tx.dvi_global_settings?.findFirst({
        where: { status: 1, deleted: 0 },
        select: { itinerary_common_buffer_time: true },
      });
      const bufferTime = globalSettings?.itinerary_common_buffer_time
        ? (globalSettings.itinerary_common_buffer_time instanceof Date
          ? `${String(globalSettings.itinerary_common_buffer_time.getUTCHours()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCMinutes()).padStart(2, '0')}:${String(globalSettings.itinerary_common_buffer_time.getUTCSeconds()).padStart(2, '0')}`
          : String(globalSettings.itinerary_common_buffer_time))
        : '01:00:00';
      nextCurrentTime = addSeconds(currentTime, timeToSeconds(bufferTime));
    }

    return { rows, currentTime: nextCurrentTime, order: nextOrder };
  }
}
