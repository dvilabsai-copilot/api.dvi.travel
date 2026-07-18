import { Prisma } from '@prisma/client';
import {
  DEFAULT_TRANSPORT_EARLIEST_SIGHTSEEING_TIME,
  DEFAULT_TRANSPORT_HOTEL_REST_MINUTES,
  DEFAULT_TRANSPORT_REFRESHMENT_MINUTES,
  TransportEarlyArrivalOption,
  getTransportEarlyArrivalSetting,
  wallClockMinutes,
} from '../../transport-early-arrival';
import { secondsToTime, timeToSeconds } from './time.helper';
import { TimeConverter } from './time-converter';

type Tx = Prisma.TransactionClient;

export interface TransportEarlyArrivalTimelineResult {
  handled: boolean;
  rows: any[];
  currentTime: string;
  currentLocationName: string;
  skipGenericRefreshment: boolean;
  earliestSightseeingTime: string;
}

export class TransportEarlyArrivalTimelineService {
  async apply(options: {
    tx: Tx;
    planId: number;
    routeId: number;
    plan: any;
    isFirstRoute: boolean;
    isLastRoute: boolean;
    routeEndSeconds: number;
    currentTime: string;
    currentLocationName: string;
    order: number;
    createdByUserId: number;
  }): Promise<TransportEarlyArrivalTimelineResult> {
    const earliestSightseeingTime = getTransportEarlyArrivalSetting(
      'TRANSPORT_EARLIEST_SIGHTSEEING_TIME',
      DEFAULT_TRANSPORT_EARLIEST_SIGHTSEEING_TIME,
    );
    const earliestSightseeingSeconds = timeToSeconds(earliestSightseeingTime);
    const arrivalSeconds = this.planArrivalSeconds(options.plan, options.currentTime);
    const cutoffSeconds = (wallClockMinutes(
      getTransportEarlyArrivalSetting('TRANSPORT_EARLY_ARRIVAL_CUTOFF', '08:00'),
    ) ?? 8 * 60) * 60;
    const option = options.plan?.transport_early_arrival_option;

    if (
      !options.isFirstRoute ||
      Number(options.plan?.itinerary_preference || 0) !== 2 ||
      arrivalSeconds === null ||
      arrivalSeconds >= cutoffSeconds ||
      !Object.values(TransportEarlyArrivalOption).includes(option)
    ) {
      return {
        handled: false,
        rows: [],
        currentTime: options.currentTime,
        currentLocationName: options.currentLocationName,
        skipGenericRefreshment: false,
        earliestSightseeingTime,
      };
    }

    const configuredMinutes = option === TransportEarlyArrivalOption.HOTEL_REST
      ? Number(options.plan?.transport_early_arrival_rest_minutes || DEFAULT_TRANSPORT_HOTEL_REST_MINUTES)
      : Number(getTransportEarlyArrivalSetting(
          'TRANSPORT_DEFAULT_REFRESHMENT_MINUTES',
          String(DEFAULT_TRANSPORT_REFRESHMENT_MINUTES),
        ));
    const breakEndSeconds = Math.max(
      arrivalSeconds + Math.max(30, configuredMinutes) * 60,
      earliestSightseeingSeconds,
    );
    const boundedBreakEndSeconds = Math.min(breakEndSeconds, options.routeEndSeconds);
    const startTime = secondsToTime(arrivalSeconds);
    const endTime = secondsToTime(boundedBreakEndSeconds);
    const isHotelRest = option === TransportEarlyArrivalOption.HOTEL_REST;
    const hotelName = String(options.plan?.transport_early_arrival_hotel_name || '').trim();

    return {
      handled: true,
      rows: [{
        itinerary_plan_ID: options.planId,
        itinerary_route_ID: options.routeId,
        item_type: 3,
        hotspot_order: options.order,
        hotspot_ID: 0,
        hotspot_traveling_time: TimeConverter.toDate(
          secondsToTime(Math.max(0, boundedBreakEndSeconds - arrivalSeconds)),
        ),
        hotspot_start_time: TimeConverter.toDate(startTime),
        hotspot_end_time: TimeConverter.toDate(endTime),
        hotspot_travelling_distance: null,
        allow_break_hours: 1,
        allow_via_route: 0,
        via_location_name: isHotelRest
          ? hotelName
            ? `Visit to ${hotelName} for rest and refreshment`
            : 'Visit to Hotel for rest and refreshment'
          : 'Refreshment / waiting break before sightseeing',
        hotspot_plan_own_way: 0,
        createdby: options.createdByUserId,
        createdon: new Date(),
        updatedon: null,
        status: 1,
        deleted: 0,
      }],
      currentTime: endTime,
      currentLocationName: isHotelRest ? hotelName || options.currentLocationName : options.currentLocationName,
      skipGenericRefreshment: true,
      earliestSightseeingTime,
    };
  }

  private planArrivalSeconds(plan: any, fallback: string): number | null {
    const value = plan?.trip_start_date_and_time ?? plan?.trip_start_date;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.getUTCHours() * 3600 + value.getUTCMinutes() * 60 + value.getUTCSeconds();
    }
    const match = String(value || '').match(/(?:T|^)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
    }
    const fallbackSeconds = timeToSeconds(fallback);
    return Number.isFinite(fallbackSeconds) ? fallbackSeconds : null;
  }
}
