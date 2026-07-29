import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { Prisma, dvi_hotel } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  allocateStaahAmountAcrossRoutes,
  calculateStaahOccupancyAmount,
  type StaahOccupancyPricingBreakdown,
  type StaahPricingPaxInput,
} from '../helpers/staah-occupancy-pricing';

@Injectable()
export class StaahBookingPushService {
  private readonly apiUrl =
    process.env.STAAH_BOOKING_API_URL ||
 'https://reservation.otaswitch.com/getapi/reservation/v2';
  private readonly apiKey =  process.env.STAAH_API_KEY || '';

  constructor(private readonly prisma: PrismaService) {}

  private maskPayload(payload: any): any {
    return { ...payload, apikey: '***MASKED***' };
  }

  private deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  private normalizeStaahExternalId(value: unknown): string {
    return String(value ?? '').trim().replace(/_/g, '');
  }

  private toStaahOutboundId(value: unknown): string {
    return String(value ?? '').trim().replace(/_/g, '');
  }

  private normalizeLooseIdentifier(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private extractOccupancyAmount(occupancyRates: any, adults: number): number | null {
    const amount = calculateStaahOccupancyAmount(occupancyRates, {
      roomCount: 1,
      adults,
    }).finalCalculatedAmount;
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  private toMoneyNumber(value: unknown): number {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) {
      return 0;
    }

    return Number(amount.toFixed(2));
  }

  private parseDateOnlyAsUtc(value: string): Date | null {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const parsed = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private addDaysUtc(date: Date, days: number): Date {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private buildStaahPaxProfile(plan: any, hotel: any): StaahPricingPaxInput {
    const occupancies = Array.isArray(hotel?.occupancies) ? hotel.occupancies : [];
    const adultsFromOccupancies = occupancies.reduce(
      (sum: number, occ: any) => sum + Math.max(Number(occ?.adults || 0), 0),
      0,
    );
    const childrenFromOccupancies = occupancies.reduce(
      (sum: number, occ: any) => sum + Math.max(Number(occ?.children || 0), 0),
      0,
    );
    const roomCountFromOccupancies = occupancies.length;

    return {
      roomCount: Math.max(
        Number(plan?.preferred_room_count || 0),
        Number(hotel?.numberOfRooms || 0),
        roomCountFromOccupancies,
        1,
      ),
      adults: Math.max(Number(plan?.total_adult || 0), adultsFromOccupancies, 0),
      children: Math.max(Number(plan?.total_children || 0), childrenFromOccupancies, 0),
      extraBedCount: Math.max(Number(plan?.total_extra_bed || 0), 0),
      childWithBedCount: Math.max(Number(plan?.total_child_with_bed || 0), 0),
      childWithoutBedCount: Math.max(Number(plan?.total_child_without_bed || 0), 0),
    };
  }

  private getStaahGuestTotals(hotel: any, plan: any): { adults: number; children: number } {
    const occupancies = Array.isArray(hotel?.occupancies) ? hotel.occupancies : [];
    const adultsFromOccupancies = occupancies.reduce(
      (sum: number, occ: any) => sum + Math.max(Number(occ?.adults || 0), 0),
      0,
    );
    const childrenFromOccupancies = occupancies.reduce(
      (sum: number, occ: any) => sum + Math.max(Number(occ?.children || 0), 0),
      0,
    );

    return {
      adults: Math.max(Number(plan?.total_adult || 0), adultsFromOccupancies, Number(hotel?.occupancies?.[0]?.adults || 0), 1),
      children: Math.max(
        Number(plan?.total_children || 0),
        childrenFromOccupancies,
        Number(hotel?.occupancies?.[0]?.children || 0),
        0,
      ),
    };
  }

  private async calculateStaahAmountFromRateRows(params: {
    propertyId: string;
    roomIds: string[];
    rateIds: string[];
    checkInDate: string;
    checkOutDate: string;
    paxProfile: StaahPricingPaxInput;
  }): Promise<
    | (StaahOccupancyPricingBreakdown & {
        nightsPriced: number;
        matchedRoomId: string;
        matchedRateId: string;
      })
    | null
  > {
    const checkIn = this.parseDateOnlyAsUtc(params.checkInDate);
    const checkOut = this.parseDateOnlyAsUtc(params.checkOutDate);
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      return null;
    }

    const uniqueRoomIds = Array.from(
      new Set(
        (params.roomIds || [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );
    const uniqueRateIds = Array.from(
      new Set(
        (params.rateIds || [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );

    for (const roomId of uniqueRoomIds) {
      for (const rateId of uniqueRateIds) {
        const rateRows = await this.prisma.staah_rate.findMany({
          where: {
            staah_property_id: params.propertyId,
            room_id: roomId,
            rateplan_id: rateId,
            start_date: { lte: checkOut } as any,
            end_date: { gte: checkIn } as any,
          },
          select: {
            occupancy_rates: true,
            start_date: true,
            end_date: true,
            received_at: true,
          },
          orderBy: { received_at: 'desc' },
        });

        if (!rateRows.length) {
          continue;
        }

        const nightlyBreakdowns: StaahOccupancyPricingBreakdown[] = [];

        for (let night = new Date(checkIn); night < checkOut; night = this.addDaysUtc(night, 1)) {
          const nightlyRate = rateRows.find((row) => {
            const start = new Date(row.start_date);
            const end = new Date(row.end_date);
            return start <= night && end >= night;
          });

          if (!nightlyRate) {
            continue;
          }

          nightlyBreakdowns.push(
            calculateStaahOccupancyAmount(nightlyRate.occupancy_rates, params.paxProfile),
          );
        }

        if (!nightlyBreakdowns.length) {
          continue;
        }

        const first = nightlyBreakdowns[0];

        return {
          ...first,
          baseOccupancyKey: Array.from(new Set(nightlyBreakdowns.map((row) => row.baseOccupancyKey))).join('|'),
          baseOccupancyAmount: this.toMoneyNumber(
            nightlyBreakdowns.reduce((sum, row) => sum + row.baseOccupancyAmount, 0),
          ),
          extraBedAmount: this.toMoneyNumber(
            nightlyBreakdowns.reduce((sum, row) => sum + row.extraBedAmount, 0),
          ),
          childWithBedAmount: this.toMoneyNumber(
            nightlyBreakdowns.reduce((sum, row) => sum + row.childWithBedAmount, 0),
          ),
          childWithoutBedAmount: this.toMoneyNumber(
            nightlyBreakdowns.reduce((sum, row) => sum + row.childWithoutBedAmount, 0),
          ),
          extraChildAmount: this.toMoneyNumber(
            nightlyBreakdowns.reduce((sum, row) => sum + row.extraChildAmount, 0),
          ),
          finalCalculatedAmount: this.toMoneyNumber(
            nightlyBreakdowns.reduce((sum, row) => sum + row.finalCalculatedAmount, 0),
          ),
          nightsPriced: nightlyBreakdowns.length,
          matchedRoomId: roomId,
          matchedRateId: rateId,
        };
      }
    }

    return null;
  }

  private async buildStaahNightlyRatesFromRateRows(params: {
    propertyId: string;
    roomIds: string[];
    rateIds: string[];
    checkInDate: string;
    checkOutDate: string;
    paxProfile: StaahPricingPaxInput;
  }): Promise<Array<{
    date: string;
    amountAfterTax: number;
    baseAmount?: number;
    extraAdultCount?: number;
    extraChildCount?: number;
    extraAdultRate?: number;
    extraChildRate?: number;
  }>> {
    const checkIn = this.parseDateOnlyAsUtc(params.checkInDate);
    const checkOut = this.parseDateOnlyAsUtc(params.checkOutDate);
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      return [];
    }

    const uniqueRoomIds = Array.from(new Set((params.roomIds || []).map((value) => String(value || '').trim()).filter(Boolean)));
    const uniqueRateIds = Array.from(new Set((params.rateIds || []).map((value) => String(value || '').trim()).filter(Boolean)));

    for (const roomId of uniqueRoomIds) {
      for (const rateId of uniqueRateIds) {
        const rateRows = await this.prisma.staah_rate.findMany({
          where: {
            staah_property_id: params.propertyId,
            room_id: roomId,
            rateplan_id: rateId,
            start_date: { lte: checkOut } as any,
            end_date: { gte: checkIn } as any,
          },
          select: {
            occupancy_rates: true,
            start_date: true,
            end_date: true,
            received_at: true,
          },
          orderBy: { received_at: 'desc' },
        });

        if (!rateRows.length) {
          continue;
        }

        const nightlyRates: Array<{
          date: string;
          amountAfterTax: number;
          baseAmount?: number;
          extraAdultCount?: number;
          extraChildCount?: number;
          extraAdultRate?: number;
          extraChildRate?: number;
        }> = [];

        let valid = true;
        for (let night = new Date(checkIn); night < checkOut; night = this.addDaysUtc(night, 1)) {
          const nightlyRate = rateRows.find((row) => {
            const start = new Date(row.start_date);
            const end = new Date(row.end_date);
            return start <= night && end >= night;
          });

          if (!nightlyRate) {
            valid = false;
            break;
          }

          const breakdown = calculateStaahOccupancyAmount(nightlyRate.occupancy_rates, params.paxProfile);
          const extraAdultAmount = Number(
            (
              breakdown.finalCalculatedAmount
              - breakdown.baseOccupancyAmount
              - breakdown.extraBedAmount
              - breakdown.childWithBedAmount
              - breakdown.childWithoutBedAmount
              - breakdown.extraChildAmount
            ).toFixed(2),
          );
          const extraAdultCount = breakdown.baseOccupancyKey.includes('EXTRAADULT') ? 1 : 0;

          nightlyRates.push({
            date: night.toISOString().slice(0, 10),
            amountAfterTax: this.toMoneyNumber(breakdown.finalCalculatedAmount),
            baseAmount: this.toMoneyNumber(breakdown.baseOccupancyAmount),
            extraAdultCount,
            extraChildCount: Number(breakdown.extraChildCount || 0),
            extraAdultRate: extraAdultCount > 0 ? this.toMoneyNumber(extraAdultAmount) : 0,
            extraChildRate: Number(breakdown.extraChildCount || 0) > 0
              ? this.toMoneyNumber((breakdown.extraChildAmount || 0) / Math.max(Number(breakdown.extraChildCount || 0), 1))
              : this.toMoneyNumber(breakdown.extraChildRate || 0),
          });
        }

        if (valid && nightlyRates.length > 0) {
          return nightlyRates;
        }
      }
    }

    return [];
  }

  private async logStaahReservation(params: {
    type: string;
    staahPropertyId: string;
    reservationId: string;
    payload: any;
    requestJson?: any;
    responseJson?: any;
    errorMessage?: string | null;
    httpStatus?: number | null;
    source?: string | null;
  }) {
    try {
      await this.prisma.staah_reservation.create({
        data: {
          type: params.type,
          staah_property_id: params.staahPropertyId,
          reservation_id: params.reservationId,
          payload: params.payload as Prisma.InputJsonValue,
          request_json: (params.requestJson ?? null) as Prisma.InputJsonValue | null,
          response_json: (params.responseJson ?? null) as Prisma.InputJsonValue | null,
          error_message: params.errorMessage ?? null,
          http_status: params.httpStatus ?? null,
          source: params.source ?? null,
        },
      });
    } catch (error: any) {
 console.error('[STAAH_LOGGING_FAILED]', {
        type: params.type,
        staahPropertyId: params.staahPropertyId,
        reservationId: params.reservationId,
        message: error?.message || String(error),
      });
    }
  }

  private isCancellationSuccess(statusCode: number | null, responseBody: any): boolean {
    if (statusCode !== 200) return false;
    if (!Array.isArray(responseBody)) return false;
    return responseBody.some((item: any) =>
      String(item?.status || '').toLowerCase() === 'success'
      && String(item?.error_desc || '') === '',
    );
  }

  private async resolveHotel(hotelCode: string): Promise<dvi_hotel | null> {
    const raw = String(hotelCode || '').trim();
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) {
      const byId = await this.prisma.dvi_hotel.findFirst({ where: { hotel_id: asNumber } });
      if (byId) return byId;
    }
    return this.prisma.dvi_hotel.findFirst({ where: { hotel_code: raw } });
  }

  private extractStaahSearchReference(searchReference: string): {
    propertyId: string;
    roomId: string;
    rateId: string;
  } | null {
    const raw = String(searchReference || '').trim();
    if (!raw.startsWith('STAAH-')) return null;

    const parts = raw.split('-');
    if (parts.length < 5) return null;

    const propertyId = String(parts[1] || '').trim();
    const roomId = String(parts[2] || '').trim();
    const rateId = String(parts[3] || '').trim();
    if (!propertyId || !roomId || !rateId) return null;

    return { propertyId, roomId, rateId };
  }

  private extractStaahReferenceFromHotelSelection(hotel: any): {
    propertyId: string;
    roomId: string;
    rateId: string;
  } | null {
    const searchReference = this.extractStaahSearchReference(String((hotel as any)?.searchReference || '').trim());
    if (searchReference) {
      return searchReference;
    }

    return this.extractStaahSearchReference(String((hotel as any)?.bookingCode || '').trim());
  }

  private buildMissingStaahMappingResult(hotel: any) {
    return {
      provider: 'staah',
      routeId: hotel?.routeId,
      hotelCode: hotel?.hotelCode,
      success: false,
      status: 'failed',
      error: 'Missing STAAH room/rate mapping',
      received: {
        bookingCode: String(hotel?.bookingCode || '').trim() || null,
        searchReference: String(hotel?.searchReference || '').trim() || null,
        roomId: String(hotel?.roomId || '').trim() || null,
        rateId: String(hotel?.rateId || '').trim() || null,
      },
    };
  }

  private async resolveRoomRateFromHotelPayload(
    hotel: any,
    hotelMaster: dvi_hotel | null,
  ): Promise<{ roomId: string; rateId: string; rateName: string; notes: string[] } | null> {
    const hotelId = Number(hotelMaster?.hotel_id || 0);
    const propertyid = String(hotelMaster?.staah_property_id || '').trim();
    const roomType = String((hotel as any)?.roomType || '').trim();
    const checkInDate = String((hotel as any)?.checkInDate || '').trim();
    const checkOutDate = String((hotel as any)?.checkOutDate || '').trim();
    const adults = Number((hotel as any)?.occupancies?.[0]?.adults || 1);
    const netAmount = Number((hotel as any)?.netAmount || 0);

    if (!hotelId || !propertyid || !roomType || !checkInDate || !checkOutDate) {
      return null;
    }

    const normalizedRoomType = this.normalizeLooseIdentifier(roomType);
    const roomRows = await this.prisma.dvi_hotel_rooms.findMany({
      where: { hotel_id: hotelId, deleted: 0 } as any,
      select: { room_ref_code: true, room_title: true },
    });

    const matchedRoom = roomRows.find((row: any) => {
      const refCode = this.normalizeLooseIdentifier(row?.room_ref_code);
      const title = this.normalizeLooseIdentifier(row?.room_title);
      return (
        (!!refCode && (normalizedRoomType.includes(refCode) || refCode.includes(normalizedRoomType))) ||
        (!!title && (normalizedRoomType.includes(title) || title.includes(normalizedRoomType)))
      );
    });

    if (!matchedRoom) {
      return null;
    }

    const requestedRoomId = String((matchedRoom as any).room_ref_code || '').trim();
    if (!requestedRoomId) {
      return null;
    }

    const [ratePlans, rateRows] = await Promise.all([
      this.prisma.staah_rateplan.findMany({
        where: { staah_property_id: propertyid },
        select: { room_id: true, rateplan_id: true, rateplan_name: true },
      }),
      this.prisma.staah_rate.findMany({
        where: {
          staah_property_id: propertyid,
          start_date: { lte: new Date(checkOutDate) } as any,
          end_date: { gte: new Date(checkInDate) } as any,
        },
        select: {
          room_id: true,
          rateplan_id: true,
          occupancy_rates: true,
          start_date: true,
          end_date: true,
          received_at: true,
        },
      }),
    ]);

    const matchingRatePlans = ratePlans.filter(
      (row) => this.normalizeStaahExternalId(row.room_id) === this.normalizeStaahExternalId(requestedRoomId),
    );
    if (!matchingRatePlans.length) {
      return null;
    }

    const matchingRateRows = rateRows
      .filter(
        (row) =>
          this.normalizeStaahExternalId(row.room_id) === this.normalizeStaahExternalId(requestedRoomId) &&
          matchingRatePlans.some(
            (plan) =>
              this.normalizeStaahExternalId(plan.rateplan_id) === this.normalizeStaahExternalId(row.rateplan_id),
          ),
      )
      .map((row) => ({
        row,
        extractedAmount: this.extractOccupancyAmount((row as any).occupancy_rates, adults),
      }))
      .sort((a, b) => {
        const aDiff = Number.isFinite(a.extractedAmount) ? Math.abs(Number(a.extractedAmount) - netAmount) : Number.POSITIVE_INFINITY;
        const bDiff = Number.isFinite(b.extractedAmount) ? Math.abs(Number(b.extractedAmount) - netAmount) : Number.POSITIVE_INFINITY;
        if (aDiff !== bDiff) return aDiff - bDiff;
        return new Date((b.row as any).received_at).getTime() - new Date((a.row as any).received_at).getTime();
      });

    const bestRate = matchingRateRows[0]?.row;
    if (!bestRate) {
      return null;
    }

    const bestPlan = matchingRatePlans.find(
      (plan) =>
        this.normalizeStaahExternalId(plan.rateplan_id) === this.normalizeStaahExternalId((bestRate as any).rateplan_id),
    );

    return {
      roomId: String((bestRate as any).room_id || requestedRoomId),
      rateId: String((bestRate as any).rateplan_id || ''),
      rateName: String(bestPlan?.rateplan_name || ''),
      notes: ['resolved_from_room_type_and_rate_lookup'],
    };
  }

  private nowIstIsoSeconds(): string {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const y = ist.getFullYear();
    const m = String(ist.getMonth() + 1).padStart(2, '0');
    const d = String(ist.getDate()).padStart(2, '0');
    const hh = String(ist.getHours()).padStart(2, '0');
    const mm = String(ist.getMinutes()).padStart(2, '0');
    const ss = String(ist.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  }

  private toMoneyString(value: any): string {
    return Number(value || 0).toFixed(2);
  }

  private async resolveRoomRate(
    hotel: any,
    hotelMaster: dvi_hotel | null,
  ): Promise<{ roomId: string; rateId: string; rateName: string; notes: string[] }> {
    const notes: string[] = [];
    const propertyid = String(hotelMaster?.staah_property_id || '').trim();
    if (!propertyid) {
      throw new Error(`Missing staah_property_id for hotelCode=${hotel?.hotelCode}`);
    }

    const directRoomId = String((hotel as any)?.roomId || '').trim();
    const directRateId = String((hotel as any)?.rateId || '').trim();
    const parsedReference = this.extractStaahReferenceFromHotelSelection(hotel);

    let requestedRoomId = directRoomId;
    let requestedRateId = directRateId;
    if ((!requestedRoomId || !requestedRateId) && parsedReference) {
      if (parsedReference.propertyId && parsedReference.propertyId !== propertyid) {
        throw new Error(
          `STAAH booking property mismatch: propertyId=${propertyid} searchReferencePropertyId=${parsedReference.propertyId}`,
        );
      }
      requestedRoomId = requestedRoomId || parsedReference.roomId;
      requestedRateId = requestedRateId || parsedReference.rateId;
      notes.push('resolved_from_search_reference_or_booking_code');
    } else if (directRoomId && directRateId) {
      notes.push('resolved_from_selected_room_rate');
    }

    if ((!requestedRoomId || !requestedRateId) && hotelMaster) {
      const fallback = await this.resolveRoomRateFromHotelPayload(hotel, hotelMaster);
      if (fallback) {
        return fallback;
      }
    }

    if (!requestedRoomId || !requestedRateId) {
      throw new Error(`STAAH room/rate mapping not found for propertyId=${propertyid}`);
    }

    const ratePlans = await this.prisma.staah_rateplan.findMany({
      where: { staah_property_id: propertyid },
      select: { room_id: true, rateplan_id: true, rateplan_name: true },
    });

    const exactMatch = ratePlans.find(
      (row) => String(row.room_id) === requestedRoomId && String(row.rateplan_id) === requestedRateId,
    );
    const normalizedMatch = exactMatch
      ? exactMatch
      : ratePlans.find(
          (row) =>
            this.normalizeStaahExternalId(row.room_id) === this.normalizeStaahExternalId(requestedRoomId)
            && this.normalizeStaahExternalId(row.rateplan_id) === this.normalizeStaahExternalId(requestedRateId),
        );

    if (!normalizedMatch) {
      throw new Error(`STAAH room/rate mapping not found for propertyId=${propertyid}`);
    }

    return {
      roomId: String(normalizedMatch.room_id),
      rateId: String(normalizedMatch.rateplan_id),
      rateName: String(normalizedMatch.rateplan_name || ''),
      notes,
    };
  }

  private async resolveCancellationPropertyId(row: any): Promise<string> {
    const confirmRequest = row?.api_response?.confirm?.request;
    const requestPropertyId = String(confirmRequest?.propertyid || '').trim();
    if (requestPropertyId) return requestPropertyId;

    const hotelMaster = await this.resolveHotel(String(row?.staah_hotel_code || ''));
    const propertyId = String(hotelMaster?.staah_property_id || '').trim();
    if (propertyId) return propertyId;

    throw new Error(`Missing staah_property_id for hotelCode=${String(row?.staah_hotel_code || '')}`);
  }

  private buildStaahGuestCounts(adults: number, children: number): Array<{ AgeQualifyingCode: string; Count: string }> {
    const guestCounts: Array<{ AgeQualifyingCode: string; Count: string }> = [];
    const normalizedAdults = Math.max(Number(adults || 0), 0);
    const normalizedChildren = Math.max(Number(children || 0), 0);

    if (normalizedAdults > 0) {
      guestCounts.push({
        AgeQualifyingCode: '10',
        Count: String(normalizedAdults),
      });
    }

    if (normalizedChildren > 0) {
      guestCounts.push({
        AgeQualifyingCode: '8',
        Count: String(normalizedChildren),
      });
    }

    return guestCounts.length > 0
      ? guestCounts
      : [
          {
            AgeQualifyingCode: '10',
            Count: '1',
          },
        ];
  }

  async confirmItineraryHotels(params: {
    confirmedItineraryPlanId: number;
    itineraryPlanId: number;
    hotels: any[];
    fallbackBookedBy: string;
    fallbackEmail: string;
    fallbackPhone: string;
  }): Promise<any[]> {
 console.log('[STAAH_BOOKING_PUSH] Starting', { count: params.hotels?.length || 0 });
    const results: any[] = [];
    const bookingTimeoutMs = Number(process.env.STAAH_BOOKING_TIMEOUT_MS || 60000);
    const itineraryPlan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: {
        itinerary_plan_ID: params.itineraryPlanId,
        deleted: 0,
      } as any,
    });

    for (const hotel of params.hotels || []) {
      const bookingId = `DVI-${params.itineraryPlanId}-${params.confirmedItineraryPlanId}-${hotel.routeId}`;
      let responseStatus: number | null = null;
      let responseBody: any = null;
      try {
        const hotelMaster = await this.resolveHotel(String(hotel.hotelCode || ''));
        const propertyid = String(hotelMaster?.staah_property_id || '').trim();
        if (!propertyid) {
          throw new Error(`Missing staah_property_id for hotelCode=${hotel.hotelCode}`);
        }

        const directRoomId = String((hotel as any)?.roomId || '').trim();
        const directRateId = String((hotel as any)?.rateId || '').trim();
        const parsedSearchReference = this.extractStaahSearchReference(
          String((hotel as any)?.searchReference || '').trim(),
        );
        const parsedBookingCode = this.extractStaahSearchReference(
          String((hotel as any)?.bookingCode || '').trim(),
        );
        const hasStaahMapping =
          (!!directRoomId && !!directRateId) ||
          !!parsedSearchReference ||
          !!parsedBookingCode;

        if (!hasStaahMapping) {
          results.push(this.buildMissingStaahMappingResult(hotel));
          continue;
        }

        const { roomId, rateId, rateName, notes } = await this.resolveRoomRate(hotel, hotelMaster);
        const outboundRoomId = this.toStaahOutboundId(roomId);
        const outboundRateId = this.toStaahOutboundId(rateId);
        const guestTotals = this.getStaahGuestTotals(hotel, itineraryPlan);
        const adults = guestTotals.adults;
        const children = guestTotals.children;
        const guestCounts = this.buildStaahGuestCounts(adults, children);
        const paxProfile = this.buildStaahPaxProfile(itineraryPlan, hotel);
        const routeIds = Array.isArray(hotel.routeIds) && hotel.routeIds.length > 0
          ? hotel.routeIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
          : [Number(hotel.routeId || 0)].filter((id) => id > 0);
        const pricingRoomIds = Array.from(
          new Set(
            [
              parsedSearchReference?.roomId,
              parsedBookingCode?.roomId,
              directRoomId,
              roomId,
              outboundRoomId,
            ]
              .map((value) => String(value || '').trim())
              .filter(Boolean),
          ),
        );
        const pricingRateIds = Array.from(
          new Set(
            [
              parsedSearchReference?.rateId,
              parsedBookingCode?.rateId,
              directRateId,
              rateId,
              outboundRateId,
            ]
              .map((value) => String(value || '').trim())
              .filter(Boolean),
          ),
        );

        const passenger = hotel.passenger || hotel.primaryPassenger || hotel.passengers?.[0] || {};
        const recalculatedPricing = await this.calculateStaahAmountFromRateRows({
          propertyId: propertyid,
          roomIds: pricingRoomIds,
          rateIds: pricingRateIds,
          checkInDate: String(hotel.checkInDate || ''),
          checkOutDate: String(hotel.checkOutDate || ''),
          paxProfile,
        });
        const nightlyRates = Array.isArray(hotel.nightlyRates) && hotel.nightlyRates.length > 0
          ? hotel.nightlyRates
          : await this.buildStaahNightlyRatesFromRateRows({
              propertyId: propertyid,
              roomIds: pricingRoomIds,
              rateIds: pricingRateIds,
              checkInDate: String(hotel.checkInDate || ''),
              checkOutDate: String(hotel.checkOutDate || ''),
              paxProfile,
            });
        const roomAmountAfterTax = nightlyRates.length > 0
          ? nightlyRates.reduce((sum: number, night: any) => sum + Number(night?.amountAfterTax || 0), 0)
          : Number(
              recalculatedPricing?.finalCalculatedAmount ??
                hotel.totalAmountAfterTax ??
                hotel.netAmount ??
                hotel.totalAmount ??
                0,
            );
        const taxAmount = Number(hotel.taxAmount || hotel.totalTax || 0);
        const totalAmountAfterTax = roomAmountAfterTax + taxAmount;

        const payload = {
          propertyid,
          apikey: this.apiKey,
          action: 'reservation_info',
          version: '2',
          reservations: {
            reservation: [
              {
                reservation_datetime: this.nowIstIsoSeconds(),
                propertyname: hotel.hotelName || hotelMaster?.hotel_name || '',
                reservation_id: bookingId,
                payment_required: '15',
                payment_type: 'Hotel Collect',
                commissionamount: '0.00',
                discountamount: '0.00',
                deposit: '0.00',
                totalamountaftertax: this.toMoneyString(totalAmountAfterTax),
                totaltax: this.toMoneyString(taxAmount),
                currencycode: 'INR',
                status: 'Confirm',
                customer: {
                  address: '',
                  city: '',
                  country: hotel.guestNationality || 'India',
                  email: params.fallbackEmail || '',
                  salutation: passenger.title || 'Mr.',
                  first_name: passenger.firstName || params.fallbackBookedBy || 'Guest',
                  last_name: passenger.lastName || '',
                  remarks: '',
                  telephone: passenger.phoneNo || params.fallbackPhone || '',
                  zip: '',
                },
                room: [
                  {
                    arrival_date: hotel.checkInDate,
                    departure_date: hotel.checkOutDate,
                    room_id: outboundRoomId,
                    room_name: hotel.roomType || '',
                    price: (nightlyRates.length > 0 ? nightlyRates : [{
                      date: hotel.checkInDate,
                      amountAfterTax: roomAmountAfterTax,
                      extraAdultCount: 0,
                      extraChildCount: Number(recalculatedPricing?.extraChildCount || 0),
                      extraAdultRate: 0,
                      extraChildRate: Number(recalculatedPricing?.extraChildRate || 0),
                    }]).map((night: any) => ({
                      date: night.date,
                      rate_id: outboundRateId,
                      rate_name: rateName || '',
                      amountaftertax: this.toMoneyString(night.amountAfterTax || 0),
                      extraGuests: {
                        extraAdult: String(night.extraAdultCount || 0),
                        extraChild: String(night.extraChildCount || 0),
                        extraAdultRate: this.toMoneyString(night.extraAdultRate || 0),
                        extraChildRate: this.toMoneyString(night.extraChildRate || 0),
                      },
                    })),
                    salutation: passenger.title || 'Mr.',
                    first_name: passenger.firstName || params.fallbackBookedBy || 'Guest',
                    last_name: passenger.lastName || '',
                    taxes: [
                      {
                        name: 'service charge',
                        value: this.toMoneyString(taxAmount),
                      },
                    ],
                    amountaftertax: this.toMoneyString(roomAmountAfterTax),
                    remarks: '',
                    GuestCount: guestCounts,
                  },
                ],
                POS: 'DVI',
                extraData: [
                  {
                    name: 'itineraryPlanId',
                    value: String(params.itineraryPlanId),
                  },
                  {
                    name: 'routeId',
                    value: String(hotel.routeId || ''),
                  },
                  {
                    name: 'routeIds',
                    value: routeIds.join(','),
                  },
                  {
                    name: 'stayKey',
                    value: String(hotel.stayKey || ''),
                  },
                  {
                    name: 'nights',
                    value: String(hotel.nights || nightlyRates.length || 1),
                  },
                  {
                    name: 'multiNightBooking',
                    value: String(Boolean(hotel.multiNightBooking)),
                  },
                  {
                    name: 'baseOccupancyKey',
                    value: String(recalculatedPricing?.baseOccupancyKey || ''),
                  },
                  {
                    name: 'baseOccupancyAmount',
                    value: this.toMoneyString(recalculatedPricing?.baseOccupancyAmount || 0),
                  },
                  {
                    name: 'extraChildCount',
                    value: String(recalculatedPricing?.extraChildCount || 0),
                  },
                  {
                    name: 'extraChildAmount',
                    value: this.toMoneyString(recalculatedPricing?.extraChildAmount || 0),
                  },
                  {
                    name: 'extraBedAmount',
                    value: this.toMoneyString(recalculatedPricing?.extraBedAmount || 0),
                  },
                  {
                    name: 'finalCalculatedAmount',
                    value: this.toMoneyString(recalculatedPricing?.finalCalculatedAmount || roomAmountAfterTax),
                  },
                ],
              },
            ],
          },
        };

 console.log('[STAAH_BOOKING_PUSH] Resolved identifiers', {
          routeId: hotel.routeId, hotelCode: hotel.hotelCode, propertyid, roomId, rateId, outboundRoomId, outboundRateId, pricingRoomIds, pricingRateIds, adults, children, guestCounts, notes, recalculatedPricing,
        });
 console.log('[STAAH_BOOKING_PUSH] Request URL', this.apiUrl);
 console.log('[STAAH_BOOKING_PUSH] Request payload', JSON.stringify(this.maskPayload(payload)));

        if (!this.apiKey) {
          throw new Error('Missing  STAAH_API_KEY');
        }

        try {
          const resp = await axios.post(this.apiUrl, payload, {
            timeout: bookingTimeoutMs,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            validateStatus: () => true,
          });
          responseStatus = resp.status;
          responseBody = resp.data;
        } catch (error: any) {
          responseStatus = error?.response?.status || null;
          responseBody = error?.response?.data || null;

          const errorMessage =
            error?.code === 'ECONNABORTED'
              ? `STAAH booking timeout after ${bookingTimeoutMs}ms`
              : error?.message || 'STAAH booking request failed';

          await this.prisma.staah_reservation.create({
            data: {
              type: 'outbound_confirm_failed',
              staah_property_id: propertyid,
              reservation_id: bookingId,
              payload: {
                request: this.maskPayload(payload),
                responseStatus,
                responseBody,
                error: errorMessage,
                errorCode: error?.code || null,
                routeId: hotel.routeId,
                routeIds,
                stayKey: hotel.stayKey || null,
                hotelCode: hotel.hotelCode,
                confirmedItineraryPlanId: params.confirmedItineraryPlanId,
                itineraryPlanId: params.itineraryPlanId,
                failedAt: new Date().toISOString(),
              } as Prisma.InputJsonValue,
              request_json: this.maskPayload(payload) as Prisma.InputJsonValue,
              response_json: (responseBody ?? null) as Prisma.InputJsonValue | null,
              error_message: errorMessage,
              http_status: responseStatus ?? null,
              source: 'website_confirm_failed',
            },
          });

          results.push({
            provider: 'staah',
            routeId: hotel.routeId,
            routeIds,
            stayKey: hotel.stayKey || null,
            hotelCode: hotel.hotelCode,
            bookingId,
            success: false,
            status: 'failed',
            error: errorMessage,
            responseStatus,
            responseBody,
          });
          continue;
        }

 console.log('[STAAH_BOOKING_PUSH] Response status', responseStatus);
 console.log('[STAAH_BOOKING_PUSH] Response body', responseBody);

        const bodyAsText = typeof responseBody === 'string' ? responseBody.toLowerCase() : '';
        const isFailureLike =
          responseStatus < 200 ||
          responseStatus >= 300 ||
          bodyAsText.includes('<html') ||
          bodyAsText.includes('forbidden');

        await this.prisma.staah_reservation.create({
          data: {
            type: 'outbound_confirm',
            staah_property_id: propertyid,
            reservation_id: bookingId,
            payload: {
              request: this.maskPayload(payload),
              responseStatus,
              responseBody,
              routeId: hotel.routeId,
              routeIds,
              stayKey: hotel.stayKey || null,
              hotelCode: hotel.hotelCode,
              confirmedItineraryPlanId: params.confirmedItineraryPlanId,
              itineraryPlanId: params.itineraryPlanId,
            } as Prisma.InputJsonValue,
            request_json: this.maskPayload(payload) as Prisma.InputJsonValue,
            response_json: (responseBody ?? null) as Prisma.InputJsonValue | null,
            error_message: null,
            http_status: responseStatus ?? null,
            source: 'website_confirm',
          },
        });

        if (isFailureLike) {
          results.push({
            provider: 'staah',
            routeId: hotel.routeId,
            routeIds,
            stayKey: hotel.stayKey || null,
            hotelCode: hotel.hotelCode,
            bookingId,
            success: false,
            status: 'failed',
            error: `STAAH booking failed with status ${responseStatus}`,
            responseStatus,
            responseBody,
          });
          continue;
        }

 // Persist confirmation row in staah_hotel_booking_confirmation
        try {
          const routeAmounts = allocateStaahAmountAcrossRoutes(roomAmountAfterTax, nightlyRates, routeIds.length);
          for (const [routeIndex, routeId] of routeIds.entries()) {
            await this.prisma.staah_hotel_booking_confirmation.create({
              data: {
                confirmed_itinerary_plan_ID: params.confirmedItineraryPlanId,
                itinerary_plan_ID: params.itineraryPlanId,
                itinerary_route_ID: Number(routeId || 0),
                staah_hotel_code: String(hotel.hotelCode || ''),
                staah_booking_reference: String(bookingId || ''),
                booking_code: String(hotel.bookingCode || ''),
                check_in_date: hotel.checkInDate ? new Date(hotel.checkInDate) : null,
                check_out_date: hotel.checkOutDate ? new Date(hotel.checkOutDate) : null,
                number_of_rooms: Number(hotel.numberOfRooms || 1),
                net_amount: routeAmounts[routeIndex] ?? roomAmountAfterTax,
                guest_nationality: String(hotel.guestNationality || ''),
                total_guests: Number((adults || 0) + (children || 0)),
                api_response: {
                  confirm: {
                    request: typeof this.maskPayload === 'function' ? this.maskPayload(payload) : payload,
                    responseStatus,
                    response: responseBody,
                    error: null,
                    routeIds,
                    stayKey: hotel.stayKey || null,
                    createdAt: new Date().toISOString(),
                  },
                },
                createdby: 1,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          }
        } catch (e) {
 console.error('Failed to persist STAAH confirmation:', e?.message || e);
        }

        results.push({
          provider: 'staah',
          routeId: hotel.routeId,
          routeIds,
          stayKey: hotel.stayKey || null,
          hotelCode: hotel.hotelCode,
          bookingId,
          success: true,
          status: 'confirmed',
          responseStatus,
          responseBody,
        });
      } catch (error: any) {
        responseStatus = error?.response?.status ?? responseStatus;
        responseBody = error?.response?.data ?? responseBody;
        const propertyid = String((await this.resolveHotel(String(hotel?.hotelCode || '')))?.staah_property_id || '').trim();
        const errorMessage = error?.message || 'STAAH booking push failed';

        if (propertyid) {
          await this.prisma.staah_reservation.create({
            data: {
              type: 'outbound_confirm_failed',
              staah_property_id: propertyid,
              reservation_id: bookingId,
              payload: {
                responseStatus,
                responseBody,
                error: errorMessage,
                routeId: hotel?.routeId,
                routeIds: Array.isArray(hotel?.routeIds) ? hotel.routeIds : [Number(hotel?.routeId || 0)].filter((id: number) => id > 0),
                stayKey: hotel?.stayKey || null,
                hotelCode: hotel?.hotelCode,
                confirmedItineraryPlanId: params.confirmedItineraryPlanId,
                itineraryPlanId: params.itineraryPlanId,
                failedAt: new Date().toISOString(),
              } as Prisma.InputJsonValue,
              request_json: null,
              response_json: (responseBody ?? null) as Prisma.InputJsonValue | null,
              error_message: errorMessage,
              http_status: responseStatus ?? null,
              source: 'website_confirm_failed',
            },
          });
        }

 console.error('[STAAH_BOOKING_PUSH] Failed', {
          routeId: hotel?.routeId,
          hotelCode: hotel?.hotelCode,
          message: errorMessage,
          responseStatus,
          responseBody,
        });
        results.push({
          provider: 'staah',
          routeId: hotel?.routeId,
          routeIds: Array.isArray(hotel?.routeIds) ? hotel.routeIds : [Number(hotel?.routeId || 0)].filter((id: number) => id > 0),
          stayKey: hotel?.stayKey || null,
          hotelCode: hotel?.hotelCode,
          bookingId,
          success: false,
          status: 'failed',
          error: errorMessage,
          responseStatus,
          responseBody,
        });
      }
    }

    return results;
  }

  async cancelItineraryHotels(itineraryPlanId: number) {
    const rows = await this.prisma.staah_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
    });

    for (const row of rows) {
 // eslint-disable-next-line no-await-in-loop
      await this.cancelStaahBookingRow(row as any);
    }
  }

  async cancelItineraryHotelsByRoutes(itineraryPlanId: number, routeIds: number[]) {
    if (!routeIds?.length) return;

    const rows = await this.prisma.staah_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        itinerary_route_ID: { in: routeIds },
        status: 1,
        deleted: 0,
      },
    });

    for (const row of rows) {
 // eslint-disable-next-line no-await-in-loop
      await this.cancelStaahBookingRow(row as any);
    }
  }

  async cancelVoucherHotel(params: {
    itineraryPlanId: number;
    routeId: number;
    hotelId?: number | string | null;
  }) {
    const normalizedHotelId = String(params.hotelId ?? '').trim();
    const primaryWhere: any = {
      itinerary_plan_ID: params.itineraryPlanId,
      itinerary_route_ID: params.routeId,
      status: 1,
      deleted: 0,
    };

    if (normalizedHotelId && normalizedHotelId !== '0') {
      primaryWhere.staah_hotel_code = normalizedHotelId;
    }

    let row = await this.prisma.staah_hotel_booking_confirmation.findFirst({
      where: primaryWhere,
      orderBy: { staah_hotel_booking_confirmation_ID: 'desc' as any },
    });

    if (!row && primaryWhere.staah_hotel_code) {
      row = await this.prisma.staah_hotel_booking_confirmation.findFirst({
        where: {
          itinerary_plan_ID: params.itineraryPlanId,
          itinerary_route_ID: params.routeId,
          status: 1,
          deleted: 0,
        } as any,
        orderBy: { staah_hotel_booking_confirmation_ID: 'desc' as any },
      });
    }

    if (!row) {
 console.log('[STAAH_CANCEL_PUSH] No active STAAH confirmation found', {
        itineraryPlanId: params.itineraryPlanId,
        routeId: params.routeId,
        hotelId: normalizedHotelId || null,
        skipReason: 'no_active_confirmation',
      });
      return {
        provider: 'staah',
        attempted: false,
        skipped: true,
        success: false,
        reason: 'no_active_confirmation',
        itineraryPlanId: params.itineraryPlanId,
        routeId: params.routeId,
        hotelCode: normalizedHotelId || null,
      };
    }

 console.log('[STAAH_CANCEL_CONFIRMATION_ROW_RESOLVED]', {
      itineraryPlanId: params.itineraryPlanId,
      routeId: params.routeId,
      requestedHotelId: normalizedHotelId || null,
      confirmationId: row.staah_hotel_booking_confirmation_ID,
      hotelCode: row.staah_hotel_code || null,
      bookingCode: row.booking_code || null,
      bookingReference: row.staah_booking_reference || null,
      endpointUrl: this.apiUrl,
    });

    return this.cancelStaahBookingRow(row as any);
  }

  private async cancelStaahBookingRow(row: any) {
    const confirmRequest = row?.api_response?.confirm?.request;
    if (!confirmRequest || typeof confirmRequest !== 'object') {
      const oldResponse = row.api_response && typeof row.api_response === 'object' ? row.api_response : {};
      await this.prisma.staah_hotel_booking_confirmation.update({
        where: { staah_hotel_booking_confirmation_ID: row.staah_hotel_booking_confirmation_ID },
        data: {
          updatedon: new Date(),
          api_response: {
            ...oldResponse,
            cancellation_error: {
              request: null,
              error: 'Missing api_response.confirm.request for STAAH cancellation',
              failedAt: new Date().toISOString(),
            },
          },
        },
      });
 console.error('[STAAH_CANCEL_PUSH] Failed', {
        id: row.staah_hotel_booking_confirmation_ID,
        reason: 'missing_confirm_request',
      });
      return { success: false, error: 'Missing confirm request payload' };
    }

    const cancelPayload = this.deepClone(confirmRequest);
    cancelPayload.action = 'reservation_info';
    cancelPayload.apikey = this.apiKey;
    cancelPayload.propertyid = await this.resolveCancellationPropertyId(row);
    const reservation = cancelPayload?.reservations?.reservation?.[0];
    if (!reservation) {
      throw new Error('Invalid confirm request structure: reservations.reservation[0] missing');
    }
    reservation.status = 'Cancel';
    reservation.reservation_datetime = this.nowIstIsoSeconds();

 console.log('[STAAH_CANCEL_PAYLOAD_BUILT]', {
      itineraryPlanId: row.itinerary_plan_ID,
      confirmedItineraryPlanId: row.confirmed_itinerary_plan_ID,
      routeId: row.itinerary_route_ID,
      hotelCode: row.staah_hotel_code,
      bookingCode: row.booking_code || null,
      bookingReference: row.staah_booking_reference || null,
      confirmationId: row.staah_hotel_booking_confirmation_ID,
      endpointUrl: this.apiUrl,
      propertyid: cancelPayload.propertyid,
      reservationId: reservation?.reservation_id || null,
      roomId: reservation?.room?.[0]?.room_id || null,
      rateId: reservation?.room?.[0]?.price?.[0]?.rate_id || null,
      arrivalDate: reservation?.room?.[0]?.arrival_date || null,
      departureDate: reservation?.room?.[0]?.departure_date || null,
    });

 console.log('[STAAH_CANCEL_PUSH] Starting', {
      itineraryPlanId: row.itinerary_plan_ID,
      confirmedItineraryPlanId: row.confirmed_itinerary_plan_ID,
      routeId: row.itinerary_route_ID,
      hotelCode: row.staah_hotel_code,
      staahPropertyId: cancelPayload.propertyid,
      bookingReference: row.staah_booking_reference,
      confirmationId: row.staah_hotel_booking_confirmation_ID,
      cancelUrl: this.apiUrl,
    });
 console.log('[STAAH_CANCEL_PUSH] API key debug', {
      hasEnvApiKey: !!this.apiKey,
      apiKeyLength: this.apiKey ? this.apiKey.length : 0,
      cancelPayloadApiKeyLength: cancelPayload?.apikey ? String(cancelPayload.apikey).length : 0,
    });
 console.log('[STAAH_CANCEL_PUSH] Request payload', JSON.stringify(this.maskPayload(cancelPayload)));

    try {
      const cancelResult = await this.cancelBooking(cancelPayload as any);
      console.log('[STAAH_CANCEL_PUSH] Response status', cancelResult?.status ?? null);
      console.log('[STAAH_CANCEL_PUSH] Response body', cancelResult?.response ?? null);

      await this.logStaahReservation({
        type: cancelResult?.success ? 'outbound_cancel' : 'outbound_cancel_failed',
        staahPropertyId: String(cancelPayload.propertyid || ''),
        reservationId: String(row.staah_booking_reference || ''),
        payload: {
          source: 'website_voucher_cancel',
          endpointUrl: this.apiUrl,
          request: this.maskPayload(cancelPayload),
          responseStatus: cancelResult?.status ?? null,
          responseBody: cancelResult?.response ?? null,
          success: !!cancelResult?.success,
          error: cancelResult?.success ? null : cancelResult?.error || 'STAAH cancellation failed',
          itineraryPlanId: row.itinerary_plan_ID,
          routeId: row.itinerary_route_ID,
          hotelCode: row.staah_hotel_code,
          bookingReference: row.staah_booking_reference,
          confirmationId: row.staah_hotel_booking_confirmation_ID,
          triggeredAt: new Date().toISOString(),
        },
        requestJson: this.maskPayload(cancelPayload),
        responseJson: cancelResult?.response ?? null,
        errorMessage: cancelResult?.success ? null : cancelResult?.error || 'STAAH cancellation failed',
        httpStatus: cancelResult?.status ?? null,
        source: cancelResult?.success ? 'website_voucher_cancel' : 'website_voucher_cancel_failed',
      });

      const oldResponse = row.api_response && typeof row.api_response === 'object' ? row.api_response : {};

      await this.prisma.staah_hotel_booking_confirmation.update({
        where: { staah_hotel_booking_confirmation_ID: row.staah_hotel_booking_confirmation_ID },
        data: {
          status: row.status,
          updatedon: new Date(),
          api_response: {
            ...oldResponse,
            cancellation: {
              endpointUrl: this.apiUrl,
              request: this.maskPayload(cancelPayload),
              responseStatus: cancelResult?.status ?? null,
              response: cancelResult?.response || cancelResult,
              error: cancelResult?.error || null,
              cancelledAt: new Date().toISOString(),
            },
          },
        },
      });
 console.log('[STAAH_CANCEL_API_RESPONSE]', {
        itineraryPlanId: row.itinerary_plan_ID,
        confirmedItineraryPlanId: row.confirmed_itinerary_plan_ID,
        routeId: row.itinerary_route_ID,
        hotelCode: row.staah_hotel_code,
        bookingReference: row.staah_booking_reference || null,
        endpointUrl: this.apiUrl,
        success: !!cancelResult?.success,
        httpStatus: cancelResult?.status ?? null,
        response: cancelResult?.response ?? null,
        error: cancelResult?.error ?? null,
      });
 console.log('[STAAH_CANCEL_DB_UPDATED]', {
        itineraryPlanId: row.itinerary_plan_ID,
        confirmedItineraryPlanId: row.confirmed_itinerary_plan_ID,
        routeId: row.itinerary_route_ID,
        hotelCode: row.staah_hotel_code,
        bookingReference: row.staah_booking_reference || null,
        confirmationId: row.staah_hotel_booking_confirmation_ID,
      });
      return cancelResult;
    } catch (error: any) {
      await this.logStaahReservation({
        type: 'outbound_cancel_failed',
        staahPropertyId: String(cancelPayload?.propertyid || ''),
        reservationId: String(row?.staah_booking_reference || ''),
        payload: {
          source: 'website_voucher_cancel',
          endpointUrl: this.apiUrl,
          request: cancelPayload ? this.maskPayload(cancelPayload) : null,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          itineraryPlanId: row?.itinerary_plan_ID,
          routeId: row?.itinerary_route_ID,
          hotelCode: row?.staah_hotel_code,
          bookingReference: row?.staah_booking_reference,
          confirmationId: row?.staah_hotel_booking_confirmation_ID,
          failedAt: new Date().toISOString(),
        },
        requestJson: cancelPayload ? this.maskPayload(cancelPayload) : null,
        responseJson: null,
        errorMessage: error instanceof Error ? error.message : String(error),
        httpStatus: null,
        source: 'website_voucher_cancel_failed',
      });

      const oldResponse = row.api_response && typeof row.api_response === 'object' ? row.api_response : {};

      await this.prisma.staah_hotel_booking_confirmation.update({
        where: { staah_hotel_booking_confirmation_ID: row.staah_hotel_booking_confirmation_ID },
        data: {
          updatedon: new Date(),
          api_response: {
            ...oldResponse,
            cancellation_error: {
              endpointUrl: this.apiUrl,
              request: this.maskPayload(cancelPayload),
              error: error?.message || String(error),
              failedAt: new Date().toISOString(),
            },
          },
        },
      });
 console.error('[STAAH_CANCEL_PUSH] Failed', {
        itineraryPlanId: row.itinerary_plan_ID,
        confirmedItineraryPlanId: row.confirmed_itinerary_plan_ID,
        routeId: row.itinerary_route_ID,
        hotelCode: row.staah_hotel_code,
        staahPropertyId: cancelPayload?.propertyid || null,
        bookingReference: row?.staah_booking_reference || null,
        cancelUrl: this.apiUrl,
        message: error?.message || String(error),
      });
      return { success: false, error: error?.message || String(error) };
    }
  }

 // STAAH cancel helper - use certified flow: action=reservation_info with reservation.status=Cancel
  private async cancelBooking(payload: any): Promise<any> {
    try {
      const req = this.deepClone(payload);
      req.action = 'reservation_info';
      req.apikey = this.apiKey;
      const resp = await axios.post(this.apiUrl, req, {
        timeout: 20000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        validateStatus: () => true,
      });
      const success = this.isCancellationSuccess(resp.status, resp.data);
      return {
        success,
        response: resp.data,
        status: resp.status,
        error: success ? null : 'STAAH cancellation response not successful',
      };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }
}
