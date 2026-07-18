import { Prisma } from '@prisma/client';
import { HotelTravelBuilder } from './hotel-travel.builder';
import { RefreshmentBuilder } from './refreshment.builder';
import { TimeConverter } from './time-converter';
import { timeToSeconds } from './time.helper';

type Tx = Prisma.TransactionClient;

export interface TimelineHotelFirstInsertionCallbacks {
  logBookingRule: (...args: any[]) => void;
}

export interface TimelineHotelFirstInsertionInput {
  tx: Tx;
  planId: number;
  routeId: number;
  plan: any;
  currentTime: string;
  currentLocationName: string;
  currentCoords?: { lat: number; lon: number };
  destinationLocationName: string;
  destinationCoords?: { lat: number; lon: number };
  hotelInfo?: { hotelName?: string | null; coords?: { lat: number; lon: number } } | null;
  order: number;
  createdByUserId: number;
  isLastRoute: boolean;
  suppressHotelInsertionUntilEndOfDay: boolean;
  isEarlyArrivalPrevDayConfirmed: boolean;
  isSpecialDay1OnePmHotelFirstFlow: boolean;
  shouldHotelFirstByDistance: boolean;
  hotelDistanceFromArrivalKm: number | null;
  isArrivalAfterNoon: boolean;
}

export interface TimelineHotelFirstInsertionResult {
  rows: any[];
  order: number;
  currentTime: string;
  currentLocationName: string;
  currentCoords?: { lat: number; lon: number };
  didHotelFirstCheckin: boolean;
}

/** Inserts the optional Day-1 hotel-first travel, check-in and rest sequence. */
export class TimelineHotelFirstInsertionService {
  private callbacks!: TimelineHotelFirstInsertionCallbacks;

  constructor(
    private readonly hotelBuilder: HotelTravelBuilder = new HotelTravelBuilder(),
    private readonly refreshmentBuilder: RefreshmentBuilder = new RefreshmentBuilder(),
  ) {}

  setCallbacks(callbacks: TimelineHotelFirstInsertionCallbacks): void {
    this.callbacks = callbacks;
  }

  async insert(input: TimelineHotelFirstInsertionInput): Promise<TimelineHotelFirstInsertionResult> {
    const result: TimelineHotelFirstInsertionResult = {
      rows: [],
      order: input.order,
      currentTime: input.currentTime,
      currentLocationName: input.currentLocationName,
      currentCoords: input.currentCoords,
      didHotelFirstCheckin: false,
    };
    if (
      input.isLastRoute ||
      input.suppressHotelInsertionUntilEndOfDay ||
      (!input.isEarlyArrivalPrevDayConfirmed &&
        !input.isSpecialDay1OnePmHotelFirstFlow &&
        !input.shouldHotelFirstByDistance)
    ) return result;

    const sourceLocationName = input.currentLocationName.split('|')[0].trim();
    const resolvedHotelCoords = input.hotelInfo?.coords || input.destinationCoords || input.currentCoords;
    const { row: toHotelRow, nextTime: hotelArrivalTime } = await this.hotelBuilder.buildToHotel(input.tx, {
      planId: input.planId,
      routeId: input.routeId,
      order: result.order,
      startTime: result.currentTime,
      travelLocationType: 1,
      userId: input.createdByUserId,
      sourceLocationName,
      destinationLocationName: input.destinationLocationName,
      sourceCoords: input.currentCoords,
      destCoords: resolvedHotelCoords,
    });

    this.callbacks.logBookingRule({
      rule: 'HOTEL_FIRST_SELECTED',
      quoteId: input.plan?.quote_id ?? input.plan?.quoteId ?? input.plan?.quote_ID ?? null,
      planId: input.planId,
      routeId: input.routeId,
      hotelDistanceFromArrivalKm: input.hotelDistanceFromArrivalKm == null
        ? null : Number(input.hotelDistanceFromArrivalKm.toFixed(2)),
      arrivalAfterNoon: input.isArrivalAfterNoon,
      sameCityStay: true,
    });

    const checkInClampApplied =
      !input.isEarlyArrivalPrevDayConfirmed &&
      !input.isSpecialDay1OnePmHotelFirstFlow &&
      timeToSeconds(hotelArrivalTime) < timeToSeconds('14:00:00');
    const checkInTime = input.isSpecialDay1OnePmHotelFirstFlow
      ? '14:00:00'
      : (checkInClampApplied ? '14:00:00' : hotelArrivalTime);
    if (checkInClampApplied) {
      this.callbacks.logBookingRule({
        rule: 'CHECKIN_CLAMP_APPLIED',
        quoteId: input.plan?.quote_id ?? input.plan?.quoteId ?? input.plan?.quote_ID ?? null,
        planId: input.planId,
        routeId: input.routeId,
        clampTo: '14:00:00',
        context: 'hotel_first',
      });
    }

    result.rows.push({ ...toHotelRow, hotspot_end_time: TimeConverter.toDate(checkInTime) });
    const { row: hotelCheckinRow, nextTime: checkinCloseTime } =
      await this.hotelBuilder.buildReturnToHotel(input.tx, {
        planId: input.planId,
        routeId: input.routeId,
        order: result.order,
        startTime: checkInTime,
        userId: input.createdByUserId,
      });
    result.rows.push(hotelCheckinRow);
    result.order++;

    const restGap = input.isSpecialDay1OnePmHotelFirstFlow ? '01:00:00' : '02:00:00';
    const { row: restRow, nextTime: afterRestTime } = this.refreshmentBuilder.build(
      input.planId,
      input.routeId,
      result.order++,
      checkinCloseTime,
      restGap,
      input.createdByUserId,
    );
    result.rows.push(restRow);
    this.callbacks.logBookingRule({
      rule: 'REST_GAP_INSERTED',
      quoteId: input.plan?.quote_id ?? input.plan?.quoteId ?? input.plan?.quote_ID ?? null,
      planId: input.planId,
      routeId: input.routeId,
      restMinutes: input.isSpecialDay1OnePmHotelFirstFlow ? 60 : 120,
      insertedAfter: 'hotel_checkin',
      hotelCoordsResolved: !!resolvedHotelCoords,
    });
    result.currentTime = afterRestTime;
    result.currentLocationName = String(input.hotelInfo?.hotelName || '').trim() || 'Hotel';
    result.currentCoords = resolvedHotelCoords || input.currentCoords;
    result.didHotelFirstCheckin = true;
    return result;
  }
}
