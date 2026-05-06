import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../../prisma.service';

type AxisRoomsPushStatus = 'confirmed' | 'modified' | 'cancelled';

@Injectable()
export class AxisRoomsBookingPushService {
  private readonly logger = new Logger(AxisRoomsBookingPushService.name);
  private readonly pushUrl =
    process.env.AXISROOMS_PUSH_BOOKING_URL ||
    'https://axisrooms.com/api/clientPushBookingNotif';

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

  private countGuests(passengers: any[] = []): { adults: number; children: number } {
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
  }): Promise<{ success: boolean; message: string; payload: any; response?: any; error?: string }> {
    const now = this.toTimestamp(new Date());
    const booking = input.hotel || {};
    const hotelCode = String(booking.hotelCode || '').trim();
    const passengers = Array.isArray(booking.passengers) ? booking.passengers : [];
    const { adults, children } = this.countGuests(passengers);

    const lead = passengers.find((p: any) => p?.leadPassenger) || passengers[0] || {};
    const leadName = [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim();

    const roomStayAmount = Number(booking?.netAmount || 0);
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

    const result = await this.pushBookingNotification(payload);
    return {
      success: result.success,
      message: result.message,
      payload,
      response: result.response,
      error: result.error,
    };
  }
}
