import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { Prisma, dvi_hotel } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';

@Injectable()
export class StaahBookingPushService {
  private readonly apiUrl =
    process.env.STAAH_BOOKING_API_URL ||
    'https://channels-stage.staah.net/booking/getapi/reservation/v2';
  private readonly apiKey =
    process.env.STAAH_BOOKING_API_KEY || 'GeT-aPi-DemoY-U1V8-bdt-03gEp-u1D8a4Y';

  constructor(private readonly prisma: PrismaService) {}

  private maskPayload(payload: any): any {
    return { ...payload, apikey: '***MASKED***' };
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

  private async resolveRoomRate(hotel: any): Promise<{ roomId: string; rateId: string; notes: string[] }> {
    const notes: string[] = [];
    const searchReference = String((hotel as any)?.searchReference || '').trim();
    if (searchReference.startsWith('STAAH-')) {
      const parts = searchReference.split('-');
      if (parts.length >= 5) {
        notes.push('resolved_from_searchReference');
        return { roomId: parts[2], rateId: parts[3], notes };
      }
    }

    const hotelId = Number(hotel.hotelCode || 0);
    if (hotelId) {
      const room = await this.prisma.dvi_hotel_rooms.findFirst({
        where: { hotel_id: hotelId },
        select: { room_ref_code: true },
      });
      const rate = await this.prisma.dvi_hotel_room_rate_plan.findFirst({
        where: { hotel_id: hotelId },
        select: { rateplan_id: true },
      });
      if (room?.room_ref_code && rate?.rateplan_id) {
        notes.push('resolved_from_db_lookup');
        return { roomId: String(room.room_ref_code), rateId: String(rate.rateplan_id), notes };
      }
    }

    if (String(hotel.hotelCode || '') === '44674') {
      notes.push('resolved_from_test_fallback');
      return { roomId: 'DELUXE_ROOM', rateId: 'CP_PLAN', notes };
    }

    throw new Error('Unable to resolve STAAH room_id/rate_id');
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

        const { roomId, rateId, notes } = await this.resolveRoomRate(hotel);
        const firstOcc = hotel.occupancies?.[0] || {};
        const adults = Number(firstOcc.adults || 1);
        const children = Number(firstOcc.children || 0);

        const payload = {
          propertyid,
          apikey: this.apiKey,
          action: 'reservation_info',
          version: '2',
          reservations: {
            reservation: [
              {
                bookingId,
                room_id: roomId,
                rate_id: rateId,
                checkIn: hotel.checkInDate,
                checkOut: hotel.checkOutDate,
                adults,
                children,
                status: 'confirmed',
              },
            ],
          },
        };

        console.log('[STAAH_BOOKING_PUSH] Resolved identifiers', {
          routeId: hotel.routeId, hotelCode: hotel.hotelCode, propertyid, roomId, rateId, notes,
        });
        console.log('[STAAH_BOOKING_PUSH] Request URL', this.apiUrl);
        console.log('[STAAH_BOOKING_PUSH] Request payload', JSON.stringify(this.maskPayload(payload)));

        const resp = await axios.post(this.apiUrl, payload, {
          timeout: 20000,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          validateStatus: () => true,
        });
        responseStatus = resp.status;
        responseBody = resp.data;

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
              hotelCode: hotel.hotelCode,
              confirmedItineraryPlanId: params.confirmedItineraryPlanId,
              itineraryPlanId: params.itineraryPlanId,
            } as Prisma.InputJsonValue,
          },
        });

        if (isFailureLike) {
          results.push({
            provider: 'staah',
            routeId: hotel.routeId,
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

        results.push({
          provider: 'staah',
          routeId: hotel.routeId,
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
        console.error('[STAAH_BOOKING_PUSH] Failed', {
          routeId: hotel?.routeId,
          hotelCode: hotel?.hotelCode,
          message: error?.message,
          responseStatus,
          responseBody,
        });
        results.push({
          provider: 'staah',
          routeId: hotel?.routeId,
          hotelCode: hotel?.hotelCode,
          bookingId,
          success: false,
          status: 'failed',
          error: error?.message || 'STAAH booking push failed',
          responseStatus,
          responseBody,
        });
      }
    }

    return results;
  }
}
