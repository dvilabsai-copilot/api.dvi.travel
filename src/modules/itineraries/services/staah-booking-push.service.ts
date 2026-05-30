import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { Prisma, dvi_hotel } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';

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

  private async resolveHotel(hotelCode: string): Promise<dvi_hotel | null> {
    const raw = String(hotelCode || '').trim();
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) {
      const byId = await this.prisma.dvi_hotel.findFirst({ where: { hotel_id: asNumber } });
      if (byId) return byId;
    }
    return this.prisma.dvi_hotel.findFirst({ where: { hotel_code: raw } });
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
    const searchReference = String((hotel as any)?.searchReference || '').trim();
    if (searchReference.startsWith('STAAH-')) {
      const parts = searchReference.split('-');
      if (parts.length >= 5 && parts[2] && parts[3]) {
        notes.push('resolved_from_searchReference');
        return { roomId: parts[2], rateId: parts[3], rateName: '', notes };
      }
    }

    const payloadRoomId = String((hotel as any)?.roomId || '').trim();
    const payloadRateId = String((hotel as any)?.rateId || '').trim();
    if (payloadRoomId && payloadRateId) {
      notes.push('resolved_from_payload_room_rate');
      return { roomId: payloadRoomId, rateId: payloadRateId, rateName: '', notes };
    }

    const propertyid = String(hotelMaster?.staah_property_id || '').trim();
    if (propertyid) {
      const staahRatePlan = await this.prisma.staah_rateplan.findFirst({
        where: { staah_property_id: propertyid },
      });
      if (staahRatePlan?.room_id && staahRatePlan?.rateplan_id) {
        notes.push('resolved_from_staah_rateplan');
        return {
          roomId: String(staahRatePlan.room_id),
          rateId: String(staahRatePlan.rateplan_id),
          rateName: String(staahRatePlan.rateplan_name || ''),
          notes,
        };
      }
    }

    const hotelCode = String(hotel.hotelCode || '').trim();
    if (propertyid === 'STAAHTESTHOTEL1' || hotelCode === 'STAAHTESTHOTEL1') {
      notes.push('resolved_from_test_fallback');
      return { roomId: 'DELUXEROOM', rateId: 'CPPLAN', rateName: '', notes };
    }

    const hotelId = Number(hotel.hotelCode || 0);
    if (hotelId) {
      const room = await this.prisma.dvi_hotel_rooms.findFirst({
        where: { hotel_id: hotelId },
        select: { room_ref_code: true },
      });
      const rate = await this.prisma.dvi_hotel_room_rate_plan.findFirst({
        where: { hotel_id: hotelId },
        select: { rateplan_id: true, rateplan_name: true },
      });
      if (room?.room_ref_code && rate?.rateplan_id) {
        notes.push('resolved_from_legacy_hotel_rateplan_fallback');
        return {
          roomId: String(room.room_ref_code),
          rateId: String(rate.rateplan_id),
          rateName: String(rate.rateplan_name || ''),
          notes,
        };
      }
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
    const bookingTimeoutMs = Number(process.env.STAAH_BOOKING_TIMEOUT_MS || 60000);

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

        const { roomId, rateId, rateName, notes } = await this.resolveRoomRate(hotel, hotelMaster);
        const firstOcc = hotel.occupancies?.[0] || {};
        const adults = Number(firstOcc.adults || 1);
        const children = Number(firstOcc.children || 0);

        const passenger = hotel.passenger || hotel.primaryPassenger || hotel.passengers?.[0] || {};
        const netAmount = Number(hotel.netAmount || hotel.totalAmount || 0);
        const taxAmount = Number(hotel.taxAmount || hotel.totalTax || 0);
        const totalAmountAfterTax = netAmount + taxAmount;
        const baseAmountAfterTax = Math.max(netAmount, 0);

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
                    room_id: roomId,
                    room_name: hotel.roomType || '',
                    price: [
                      {
                        date: hotel.checkInDate,
                        rate_id: rateId,
                        rate_name: rateName || '',
                        amountaftertax: this.toMoneyString(baseAmountAfterTax),
                        extraGuests: {
                          extraAdult: '0',
                          extraChild: '0',
                          extraAdultRate: '0',
                          extraChildRate: '0',
                        },
                      },
                    ],
                    salutation: passenger.title || 'Mr.',
                    first_name: passenger.firstName || params.fallbackBookedBy || 'Guest',
                    last_name: passenger.lastName || '',
                    taxes: [
                      {
                        name: 'service charge',
                        value: this.toMoneyString(taxAmount),
                      },
                    ],
                    amountaftertax: this.toMoneyString(totalAmountAfterTax),
                    remarks: '',
                    GuestCount: [
                      {
                        AgeQualifyingCode: '10',
                        Count: String(adults),
                      },
                    ],
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
                ],
              },
            ],
          },
        };

        console.log('[STAAH_BOOKING_PUSH] Resolved identifiers', {
          routeId: hotel.routeId, hotelCode: hotel.hotelCode, propertyid, roomId, rateId, notes,
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
                hotelCode: hotel.hotelCode,
                confirmedItineraryPlanId: params.confirmedItineraryPlanId,
                itineraryPlanId: params.itineraryPlanId,
                failedAt: new Date().toISOString(),
              } as Prisma.InputJsonValue,
            },
          });

          results.push({
            provider: 'staah',
            routeId: hotel.routeId,
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

        // Persist confirmation row in staah_hotel_booking_confirmation
        try {
          await this.prisma.staah_hotel_booking_confirmation.create({
            data: {
              confirmed_itinerary_plan_ID: params.confirmedItineraryPlanId,
              itinerary_plan_ID: params.itineraryPlanId,
              itinerary_route_ID: Number(hotel.routeId || 0),
              staah_hotel_code: String(hotel.hotelCode || ''),
              staah_booking_reference: String(bookingId || ''),
              booking_code: String(hotel.bookingCode || ''),
              check_in_date: hotel.checkInDate ? new Date(hotel.checkInDate) : null,
              check_out_date: hotel.checkOutDate ? new Date(hotel.checkOutDate) : null,
              number_of_rooms: Number(hotel.numberOfRooms || 1),
              net_amount: Number(hotel.netAmount || 0),
              guest_nationality: String(hotel.guestNationality || ''),
              total_guests: Number((adults || 0) + (children || 0)),
              api_response: {
                confirm: {
                  request: typeof this.maskPayload === 'function' ? this.maskPayload(payload) : payload,
                  responseStatus,
                  response: responseBody,
                  error: null,
                  createdAt: new Date().toISOString(),
                },
              },
              createdby: 1,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });
        } catch (e) {
          console.error('Failed to persist STAAH confirmation:', e?.message || e);
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
                hotelCode: hotel?.hotelCode,
                confirmedItineraryPlanId: params.confirmedItineraryPlanId,
                itineraryPlanId: params.itineraryPlanId,
                failedAt: new Date().toISOString(),
              } as Prisma.InputJsonValue,
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

  private async cancelStaahBookingRow(row: any) {
    const cancelPayload = {
      bookingId: row.staah_booking_reference,
      bookingCode: row.booking_code,
      hotelCode: row.staah_hotel_code,
    };

    try {
      const cancelResult = await this.cancelBooking(cancelPayload as any);

      const oldResponse = row.api_response && typeof row.api_response === 'object' ? row.api_response : {};

      await this.prisma.staah_hotel_booking_confirmation.update({
        where: { staah_hotel_booking_confirmation_ID: row.staah_hotel_booking_confirmation_ID },
        data: {
          status: cancelResult?.success ? 0 : row.status,
          updatedon: new Date(),
          api_response: {
            ...oldResponse,
            cancellation: {
              request: cancelPayload,
              response: cancelResult?.response || cancelResult,
              error: cancelResult?.error || null,
              cancelledAt: new Date().toISOString(),
            },
          },
        },
      });
    } catch (error: any) {
      const oldResponse = row.api_response && typeof row.api_response === 'object' ? row.api_response : {};

      await this.prisma.staah_hotel_booking_confirmation.update({
        where: { staah_hotel_booking_confirmation_ID: row.staah_hotel_booking_confirmation_ID },
        data: {
          updatedon: new Date(),
          api_response: {
            ...oldResponse,
            cancellation_error: {
              request: cancelPayload,
              error: error?.message || String(error),
              failedAt: new Date().toISOString(),
            },
          },
        },
      });
    }
  }

  // Generic STAAH cancel helper - posts a cancellation request using same API pattern
  private async cancelBooking(payload: any): Promise<any> {
    try {
      const req = {
        propertyid: payload.propertyid || '',
        apikey: this.apiKey,
        action: 'reservation_cancel',
        version: '2',
        reservations: {
          reservation: [
            {
              bookingId: payload.bookingId,
              booking_code: payload.bookingCode,
              room_id: payload.roomId,
            },
          ],
        },
      };

      const resp = await axios.post(this.apiUrl, req, {
        timeout: 20000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        validateStatus: () => true,
      });

      return { success: resp.status >= 200 && resp.status < 300, response: resp.data, status: resp.status };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }
}
