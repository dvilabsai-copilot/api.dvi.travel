import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../../prisma.service';

type AxisRoomsPushStatus = 'confirmed' | 'modified' | 'cancelled';

@Injectable()
export class AxisRoomsBookingPushService {
  private readonly logger = new Logger(AxisRoomsBookingPushService.name);
  private readonly pushUrl =
    process.env.AXISROOMS_PUSH_BOOKING_URL ||
 'https://interstellar.axisrooms.com/v1/bookingNotification/accept/axisrooms';

  constructor(private readonly prisma: PrismaService) {}

  private toTimestamp(date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }

  private countGuests(
    passengers: any[] = [],
    occupancies: any[] = [],
  ): { adults: number; children: number } {
    const occupancyAdults = (occupancies || []).reduce(
      (sum: number, occupancy: any) => sum + Math.max(Number(occupancy?.adults || 0), 0),
      0,
    );
    const occupancyChildren = (occupancies || []).reduce(
      (sum: number, occupancy: any) => sum + Math.max(Number(occupancy?.children || 0), 0),
      0,
    );

    // Occupancy is the authoritative room booking count. Passenger details
    // can be incomplete in legacy/client payloads (for example, three adults
    // with only the lead passenger included), so use them only as a fallback.
    if (occupancyAdults > 0 || occupancyChildren > 0) {
      return { adults: occupancyAdults, children: occupancyChildren };
    }

    let adults = 0;
    let children = 0;
    for (const p of passengers || []) {
      const paxType = Number(p?.paxType || 0);
      if (paxType === 2) {
        children += 1;
      } else {
        adults += 1;
      }
    }
    return { adults, children };
  }

  private async resolveAxisroomsHotelId(hotelCode: string): Promise<string> {
    const raw = String(hotelCode || '').trim();
    if (!raw) return raw;

    const asNumeric = Number(raw);
    const row = Number.isFinite(asNumeric)
      ? await this.prisma.dvi_hotel.findFirst({
          where: { hotel_id: asNumeric, deleted: { not: true } },
          select: { hotel_id: true, axisrooms_property_id: true },
        })
      : await this.prisma.dvi_hotel.findFirst({
          where: {
            OR: [
              { axisrooms_property_id: raw },
              { hotel_code: raw },
            ],
            deleted: { not: true },
          },
          select: { hotel_id: true, axisrooms_property_id: true },
        });

    if (!row) {
      return raw;
    }

 // AxisRooms expects client-system hotel id. Prefer local numeric hotel_id.
    return String(row.hotel_id || raw).trim();
  }

  async pushBookingNotification(payload: Record<string, any>): Promise<{ success: boolean; message: string; response?: any; error?: string }> {
    const accessKey = String(process.env.AXISROOMS_PUSH_API_KEY || '').trim();
    const headerToken = String(process.env.AXISROOMS_PUSH_TOKEN || accessKey).trim();
    if (!accessKey) {
      const msg = 'AXISROOMS_PUSH_API_KEY is not configured';
 this.logger.error(msg);
      return { success: false, message: msg, error: msg };
    }

    try {
      const requestBody = {
        ...payload,
        accessKey,
      };

      const response = await axios.post(this.pushUrl, requestBody, {
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          token: headerToken,
        },
      });

      const status = String(response?.data?.status || '').toLowerCase();
      const message = String(response?.data?.message || 'AxisRooms push booking notification sent');

      if (status && status !== 'success') {
        return {
          success: false,
          message,
          response: response?.data,
          error: `AxisRooms returned status=${status}`,
        };
      }

      return {
        success: true,
        message,
        response: response?.data,
      };
    } catch (error: any) {
      const errorMessage =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        'AxisRooms push booking request failed';
 this.logger.error(`AxisRooms push booking failed: ${errorMessage}`);
      return { success: false, message: 'AxisRooms push failed', error: String(errorMessage) };
    }
  }

  async pushForHotelSelection(input: {
    bookingStatus: AxisRoomsPushStatus;
    confirmedItineraryPlanId: number;
    itineraryPlanId: number;
    hotel: any;
    fallbackBookedBy?: string;
    fallbackEmail?: string;
    fallbackPhone?: string;
  }): Promise<{ success: boolean; message: string; payload: any; response?: any; error?: string; routeIds?: number[]; stayKey?: string }> {
    const now = this.toTimestamp(new Date());
    const booking = input.hotel || {};
    const hotelCode = String(booking.hotelCode || '').trim();
    const passengers = Array.isArray(booking.passengers) ? booking.passengers : [];
    const occupancies = Array.isArray(booking.occupancies) ? booking.occupancies : [];
    const { adults, children } = this.countGuests(passengers, occupancies);
    const routeIds = Array.isArray(booking.routeIds) && booking.routeIds.length > 0
      ? booking.routeIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
      : [Number(booking.routeId || 0)].filter((id) => id > 0);
    const nightlyRates = Array.isArray(booking.nightlyRates) ? booking.nightlyRates : [];

    const lead = passengers.find((p: any) => p?.leadPassenger) || passengers[0] || {};
    const leadName = [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim();

    const roomStayAmount = nightlyRates.length > 0
      ? nightlyRates.reduce((sum: number, night: any) => sum + Number(night?.amountAfterTax || 0), 0)
      : Number(booking?.totalAmountAfterTax || booking?.netAmount || 0);
    const noOfUnits = String(Number(booking?.numberOfRooms || 1));

    const payload: Record<string, any> = {
      bookingStatus: input.bookingStatus,
      confirmationNo: `DVI-${input.confirmedItineraryPlanId}-${booking.routeId || 0}-${hotelCode || 'NA'}`,
      hotelId: await this.resolveAxisroomsHotelId(hotelCode),
      supplierAmount: String(roomStayAmount),
      taxes: '0',
      commission: '0',
      totalAmount: String(roomStayAmount),
      checkInDate: String(booking?.checkInDate || '').slice(0, 10),
      checkOutDate: String(booking?.checkOutDate || '').slice(0, 10),
      totalAdults: adults,
      totalChildren: children,
      bookedBy: input.fallbackBookedBy || leadName || 'DVI User',
      customerEmail: lead?.email || input.fallbackEmail || '',
      phoneNo: lead?.phoneNo || input.fallbackPhone || '',
      paymentStatus: 0,
      roomStays: [
        {
          rateId: String(booking?.prebookContext?.rateId || booking?.prebookContext?.ratePlanId || booking?.bookingCode || ''),
          rateName: String(booking?.prebookContext?.rateName || booking?.roomType || ''),
          roomId: String(booking?.prebookContext?.roomId || booking?.roomType || booking?.routeId || ''),
          noOfUnits,
          amount: String(roomStayAmount),
          totalAmount: String(roomStayAmount),
          guestDetails: {
            guestName: leadName || 'Guest',
            adults,
            children,
          },
        },
      ],
    };

    if (input.bookingStatus === 'confirmed') {
      payload.bookedTime = now;
    } else if (input.bookingStatus === 'modified') {
      payload.modifiedTime = now;
    } else if (input.bookingStatus === 'cancelled') {
      payload.cancelledTime = now;
    }

    payload.extraData = {
      multiNightBooking: Boolean(booking?.multiNightBooking),
      stayKey: String(booking?.stayKey || ''),
      routeIds,
      nights: Number(booking?.nights || nightlyRates.length || 1),
      nightlyRates,
    };

    const result = await this.pushBookingNotification(payload);
 // Persist confirmation for successful confirms
    try {
      if (input.bookingStatus === 'confirmed' && result.success) {
        const booking = input.hotel || {};
        const hotelCode = String(booking.hotelCode || '').trim();
        const passengers = Array.isArray(booking.passengers) ? booking.passengers : [];

        for (const routeId of routeIds) {
          await this.prisma.axisrooms_hotel_booking_confirmation.create({
            data: {
              confirmed_itinerary_plan_ID: input.confirmedItineraryPlanId,
              itinerary_plan_ID: input.itineraryPlanId,
              itinerary_route_ID: Number(routeId || 0),
              axisrooms_hotel_code: hotelCode,
              axisrooms_booking_reference: String(payload.confirmationNo || ''),
              booking_code: String(booking.bookingCode || ''),
              check_in_date: booking.checkInDate ? new Date(booking.checkInDate) : null,
              check_out_date: booking.checkOutDate ? new Date(booking.checkOutDate) : null,
              number_of_rooms: Number(booking.numberOfRooms || 1),
              net_amount: Number(roomStayAmount || 0),
              guest_nationality: String(booking.guestNationality || ''),
              total_guests: Array.isArray(passengers) ? passengers.length : 0,
              api_response: {
                confirm: {
                  request: payload,
                  response: result.response || result,
                  error: result.error || null,
                  stayKey: booking?.stayKey || null,
                  routeIds,
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
      }
    } catch (e) {
 this.logger.error('Failed to persist AxisRooms confirmation: ' + String(e?.message || e));
    }

    return {
      success: result.success,
      message: result.message,
      payload,
      response: result.response,
      error: result.error,
      routeIds,
      stayKey: booking?.stayKey,
    };
  }

  async cancelItineraryHotels(itineraryPlanId: number) {
    const rows = await this.prisma.axisrooms_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
    });

    for (const row of rows) {
 // eslint-disable-next-line no-await-in-loop
      await this.cancelAxisroomsBookingRow(row as any);
    }
  }

  async cancelItineraryHotelsByRoutes(itineraryPlanId: number, routeIds: number[]) {
    if (!routeIds?.length) return;

    const rows = await this.prisma.axisrooms_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        itinerary_route_ID: { in: routeIds },
        status: 1,
        deleted: 0,
      },
    });

    for (const row of rows) {
 // eslint-disable-next-line no-await-in-loop
      await this.cancelAxisroomsBookingRow(row as any);
    }
  }

  private async cancelAxisroomsBookingRow(row: any) {
    const cancelPayload = {
      confirmationNo: row.axisrooms_booking_reference,
      bookingCode: row.booking_code,
      hotelCode: row.axisrooms_hotel_code,
    };

    try {
      const cancelResult = await this.pushBookingNotification({
        ...cancelPayload,
        bookingStatus: 'cancelled',
      } as any);

      const oldResponse = row.api_response && typeof row.api_response === 'object' ? row.api_response : {};

      await this.prisma.axisrooms_hotel_booking_confirmation.update({
        where: {
          axisrooms_hotel_booking_confirmation_ID: row.axisrooms_hotel_booking_confirmation_ID,
        },
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

      await this.prisma.axisrooms_hotel_booking_confirmation.update({
        where: {
          axisrooms_hotel_booking_confirmation_ID: row.axisrooms_hotel_booking_confirmation_ID,
        },
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
}
