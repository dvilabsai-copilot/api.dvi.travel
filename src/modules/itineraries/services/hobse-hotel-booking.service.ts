import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HobseHotelProvider } from '../../hotels/providers/hobse-hotel.provider';
import { HotelSelectionDto } from '../dto/confirm-quotation.dto';
import { resolveProviderPassengerTitle } from '../../../common/utils/passenger-title.util';
import { resolveCityRecordByName } from '../utils/city-normalization.util';

@Injectable()
export class HobseHotelBookingService {
  private readonly logger = new Logger(HobseHotelBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hobseProvider: HobseHotelProvider,
  ) {}

  async confirmItineraryHotels(
    planId: number,
    hobseHotels: HotelSelectionDto[],
    primaryGuest: {
      salutation: string;
      name: string;
      phone: string;
      email?: string;
    },
  ): Promise<any[]> {
    this.logger.log(`🏨 HOBSE BOOKING: Plan ${planId}, hotels=${hobseHotels.length}`);

    const results: any[] = [];

    for (const sel of hobseHotels) {
      try {
        // 1) Find route city (needed for hobse city id)
        const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
          where: { itinerary_route_ID: sel.routeId },
          select: { next_visiting_location: true },
        });

        const cityName = route?.next_visiting_location;
        if (!cityName) throw new Error(`Route city not found for routeId=${sel.routeId}`);

        // 2) Map to hobse_city_code
        const city = await resolveCityRecordByName(this.prisma, cityName);
        const hobseCityId = city?.hobse_city_code;
        if (!hobseCityId) throw new Error(`City '${cityName}' not mapped to hobse_city_code`);

        // 3) Count pax
        const adults = sel.passengers?.filter((p) => p.paxType === 1).length || 1;
        const children = sel.passengers?.filter((p) => p.paxType === 2).length || 0;
        const infants = sel.passengers?.filter((p) => p.paxType === 3).length || 0;

        // 4) Guest split: use lead passenger if present, else primary guest
        const lead = sel.passengers?.find((p) => p.leadPassenger) || sel.passengers?.[0];

        const [firstName, ...rest] = (lead?.firstName || primaryGuest.name || 'Guest').split(' ');
        const lastName = (lead?.lastName || rest.join(' ') || '').trim();

        // 5) Unique channelBookingId (prevents duplicate error)
        const channelBookingId = `DVI-${planId}-${sel.routeId}-${Date.now()}`;

        // 6) Call provider booking
        const booking = await this.hobseProvider.createBookingFromItinerary({
          hotelId: sel.hotelCode,
          cityId: String(hobseCityId),
          checkInDate: sel.checkInDate,
          checkOutDate: sel.checkOutDate,
          adultCount: adults,
          childCount: children,
          infantCount: infants,
          channelBookingId,
          bookingDesc: sel.roomType || '',

          guest: {
            title: resolveProviderPassengerTitle(lead?.title, primaryGuest.salutation),
            firstName,
            lastName: lastName || 'Guest',
            mobileNumber: lead?.phoneNo || primaryGuest.phone,
            email: lead?.email || primaryGuest.email || '',
            address: '',
            state: '',
            city: cityName,
            country: 'India',
          },
        });

        // Extract HOBSE booking ID from response
        const hobseBookingId = booking?.apiResponse?.hobse?.response?.data?.[0]?.hobseBookingId || channelBookingId;
        this.logger.log(`📝 HOBSE Booking IDs - Channel: ${channelBookingId}, HOBSE: ${hobseBookingId}`);

        // 7) Save confirmation row
        const saved = await (this.prisma as any).hobse_hotel_booking_confirmation.create({
          data: {
            plan_id: planId,
            route_id: sel.routeId,
            hotel_code: sel.hotelCode,
            booking_id: hobseBookingId, // Store HOBSE's booking ID, not our channel ID
            check_in_date: new Date(sel.checkInDate),
            check_out_date: new Date(sel.checkOutDate),
            room_count: sel.numberOfRooms || 1,
            guest_count: sel.passengers?.length || 1,
            total_amount: Number(booking?.cost?.totalReservationCost || 0),
            currency: 'INR',
            booking_status: 'confirmed',
            api_response: booking as any,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });

        results.push({
          provider: 'HOBSE',
          routeId: sel.routeId,
          hotelId: sel.hotelCode,
          channelBookingId: hobseBookingId, // Return HOBSE's booking ID
          dbId: saved.hobse_hotel_booking_confirmation_ID,
          status: 'success',
        });
      } catch (e: any) {
        this.logger.error(`❌ HOBSE booking failed: ${e?.message}`);
        results.push({
          provider: 'HOBSE',
          routeId: sel.routeId,
          hotelId: sel.hotelCode,
          status: 'failed',
          error: e?.message,
        });
      }
    }

    return results;
  }

  /**
   * Cancel HOBSE bookings for specific routes
   * Pattern: Call API first → Update DB status only if success → Continue on error
   */
  async cancelItineraryHotelsByRoutes(
    planId: number,
    routeIds: number[],
  ): Promise<any> {
    this.logger.log(`🗑️ HOBSE CANCELLATION: Plan ${planId}, routes=${routeIds}`);

    const bookings = await (this.prisma as any).hobse_hotel_booking_confirmation.findMany({
      where: {
        plan_id: planId,
        route_id: { in: routeIds },
        booking_status: { not: 'cancelled' }, // Only cancel non-cancelled bookings
      },
    });

    this.logger.log(`Found ${bookings.length} HOBSE bookings to cancel`);

    const results = {
      totalBookings: bookings.length,
      successCount: 0,
      failureCount: 0,
      cancellations: [] as any[],
    };

    for (const booking of bookings) {
      try {
        this.logger.log(
          `📤 Calling HOBSE API to cancel: ${booking.booking_id} (Confirmation ID: ${booking.hobse_hotel_booking_confirmation_ID})`
        );
        this.logger.debug(`HOBSE Booking Details - BookingID: ${booking.booking_id}, HotelCode: ${booking.hotel_code}, GuestName: ${booking.guest_name}`);

        // Step 1: Call HOBSE API to cancel booking
        const cancellationResult = await this.hobseProvider.cancelBooking(
          booking.booking_id,
          'Route cancelled by user',
          booking.hotel_code // Pass hotel ID as required by HOBSE API
        );

        this.logger.log(
          `✅ HOBSE API Response: Booking ${booking.booking_id} cancelled successfully`
        );
        this.logger.debug(
          `HOBSE API Response Details: ${JSON.stringify(cancellationResult)}`
        );

        // Step 2: Update database status ONLY if API call succeeded
        await (this.prisma as any).hobse_hotel_booking_confirmation.update({
          where: {
            hobse_hotel_booking_confirmation_ID:
              booking.hobse_hotel_booking_confirmation_ID,
          },
          data: {
            booking_status: 'cancelled',
            cancellation_response: cancellationResult as any,
            updated_at: new Date(),
          },
        });

        this.logger.log(
          `✅ Database updated: HOBSE booking ${booking.booking_id} status = 'cancelled'`
        );

        results.successCount++;
        results.cancellations.push({
          bookingId: booking.booking_id,
          status: 'cancelled',
          cancellationRef: cancellationResult.cancellationRef,
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `❌ HOBSE cancellation failed for booking ${booking.booking_id}: ${errorMsg}`
        );
        this.logger.error(
          `HOBSE Error Details: bookingId=${booking.booking_id}, hotelCode=${booking.hotel_code}, guestName=${booking.guest_name}, error=${errorMsg}`
        );

        results.failureCount++;
        results.cancellations.push({
          bookingId: booking.booking_id,
          status: 'failed',
          error: errorMsg,
        });

        // Continue with next booking even if this one fails
      }
    }

    this.logger.log(
      `🗑️ HOBSE Route Cancellation Summary: ${results.successCount}/${results.totalBookings} successful`
    );

    return results;
  }

  /**
   * Cancel all HOBSE bookings for an itinerary
   * Pattern: Call API first → Update DB status only if success → Continue on error
   */
  async cancelItineraryHotels(planId: number): Promise<any> {
    this.logger.log(`🗑️ HOBSE FULL CANCELLATION: Plan ${planId}`);

    const bookings = await (this.prisma as any).hobse_hotel_booking_confirmation.findMany({
      where: {
        plan_id: planId,
        booking_status: { not: 'cancelled' }, // Only cancel non-cancelled bookings
      },
    });

    this.logger.log(`Found ${bookings.length} HOBSE bookings to cancel`);

    const results = {
      totalBookings: bookings.length,
      successCount: 0,
      failureCount: 0,
      cancellations: [] as any[],
    };

    for (const booking of bookings) {
      try {
        this.logger.log(
          `📤 Calling HOBSE API to cancel: ${booking.booking_id} (Confirmation ID: ${booking.hobse_hotel_booking_confirmation_ID})`
        );
        this.logger.debug(`HOBSE Booking Details - BookingID: ${booking.booking_id}, HotelCode: ${booking.hotel_code}, GuestName: ${booking.guest_name}`);

        // Step 1: Call HOBSE API to cancel booking
        const cancellationResult = await this.hobseProvider.cancelBooking(
          booking.booking_id,
          'Itinerary cancelled by user'
        );

        this.logger.log(
          `✅ HOBSE API Response: Booking ${booking.booking_id} cancelled successfully`
        );
        this.logger.debug(
          `HOBSE API Response Details: ${JSON.stringify(cancellationResult)}`
        );

        // Step 2: Update database status ONLY if API call succeeded
        await (this.prisma as any).hobse_hotel_booking_confirmation.update({
          where: {
            hobse_hotel_booking_confirmation_ID:
              booking.hobse_hotel_booking_confirmation_ID,
          },
          data: {
            booking_status: 'cancelled',
            cancellation_response: cancellationResult as any,
            updated_at: new Date(),
          },
        });

        this.logger.log(
          `✅ Database updated: HOBSE booking ${booking.booking_id} status = 'cancelled'`
        );

        results.successCount++;
        results.cancellations.push({
          bookingId: booking.booking_id,
          status: 'cancelled',
          cancellationRef: cancellationResult.cancellationRef,
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `❌ HOBSE cancellation failed for booking ${booking.booking_id}: ${errorMsg}`
        );
        this.logger.error(
          `HOBSE Error Details: bookingId=${booking.booking_id}, hotelCode=${booking.hotel_code}, guestName=${booking.guest_name}, error=${errorMsg}`
        );

        results.failureCount++;
        results.cancellations.push({
          bookingId: booking.booking_id,
          status: 'failed',
          error: errorMsg,
        });

        // Continue with next booking even if this one fails
      }
    }

    this.logger.log(
      `🗑️ HOBSE Full Cancellation Summary: ${results.successCount}/${results.totalBookings} successful`
    );

    return results;
  }
}
