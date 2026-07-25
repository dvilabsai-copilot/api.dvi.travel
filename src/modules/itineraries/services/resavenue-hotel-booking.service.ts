import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ResAvenueHotelProvider } from '../../hotels/providers/resavenue-hotel.provider';

interface ResAvenueHotelSelection {
  hotelCode: string;
  bookingCode: string;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  numberOfRooms: number;
  guestNationality: string;
  netAmount: number;
  guests: ResAvenueGuest[];
}

interface ResAvenueGuest {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

@Injectable()
export class ResAvenueHotelBookingService {
  private readonly logger = new Logger(ResAvenueHotelBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resavenueProvider: ResAvenueHotelProvider,
  ) {}

 /**
   * Confirm ResAvenue hotel booking
 */
  async confirmBooking(
    selection: ResAvenueHotelSelection,
    invCode: number,
    rateCode: number,
  ): Promise<any> {
    try {
 this.logger.log(
        `🏨 Booking ResAvenue Hotel ${selection.hotelCode}`,
      );

 // Call ResAvenue provider to book
      const bookingResult = await this.resavenueProvider.confirmBooking({
        hotelCode: selection.hotelCode,
        checkInDate: selection.checkInDate,
        checkOutDate: selection.checkOutDate,
        roomCount: selection.numberOfRooms,
        invCode,
        rateCode,
        guests: selection.guests.map(g => ({
          ...g,
          email: g.email || '',
          phone: g.phone || '',
        })),
 // Build rooms array required by provider
        rooms: [
          {
            roomCode: `${invCode}-${rateCode}`,
            quantity: selection.numberOfRooms,
            guestCount: selection.guests.length,
          },
        ],
 // Required fields for DTO
 itineraryPlanId: 0, // Will be set by service
        searchReference: selection.bookingCode || '',
        contactName: selection.guests[0]?.firstName + ' ' + selection.guests[0]?.lastName || '',
        contactEmail: selection.guests[0]?.email || '',
        contactPhone: selection.guests[0]?.phone || '',
      });

 this.logger.log(` ResAvenue booking confirmed: ${bookingResult.confirmationReference}`);
      return bookingResult;
    } catch (error) {
 this.logger.error(` ResAvenue booking error: ${error.message}`);
      throw new BadRequestException(
        `ResAvenue booking failed for hotel ${selection.hotelCode}: ${error.message}`,
      );
    }
  }

 /**
   * Save ResAvenue booking confirmation to database
 */
  async saveResAvenueBookingConfirmation(
    confirmedPlanId: number,
    itineraryPlanId: number,
    routeId: number,
    hotelCode: string,
    bookingResponse: any,
    selection: ResAvenueHotelSelection,
    userId: number,
  ) {
    try {
      const saved = await this.prisma.resavenue_hotel_booking_confirmation.create({
        data: {
          confirmed_itinerary_plan_ID: confirmedPlanId,
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: routeId,
          resavenue_hotel_code: hotelCode,
          resavenue_booking_reference: bookingResponse.confirmationReference || '',
          booking_code: selection.bookingCode,
          check_in_date: new Date(selection.checkInDate),
          check_out_date: new Date(selection.checkOutDate),
          number_of_rooms: selection.numberOfRooms,
          net_amount: selection.netAmount,
          guest_nationality: selection.guestNationality || 'IN',
          total_guests: selection.guests.length,
          api_response: JSON.stringify(bookingResponse),
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

 this.logger.log(
        `💾 Saved ResAvenue booking confirmation: ID ${saved.resavenue_hotel_booking_confirmation_ID}`,
      );
      return saved;
    } catch (error) {
 this.logger.error(` Error saving ResAvenue booking confirmation: ${error.message}`);
      throw new BadRequestException(
        `Failed to save ResAvenue booking confirmation: ${error.message}`,
      );
    }
  }

 /**
   * Confirm multiple ResAvenue hotel bookings for an itinerary
 */
  async confirmItineraryHotels(
    confirmedPlanId: number,
    itineraryPlanId: number,
    selections: Array<{
      routeId: number;
      selection: ResAvenueHotelSelection;
      invCode: number;
      rateCode: number;
    }>,
    userId: number,
  ) {
    const results = [];

    for (const { routeId, selection, invCode, rateCode } of selections) {
      try {
 // Book the hotel
        const bookResponse = await this.confirmBooking(
          selection,
          invCode,
          rateCode,
        );

 // Save confirmation to database
        const savedConfirmation = await this.saveResAvenueBookingConfirmation(
          confirmedPlanId,
          itineraryPlanId,
          routeId,
          selection.hotelCode,
          bookResponse,
          selection,
          userId,
        );

        results.push({
          routeId,
          hotelCode: selection.hotelCode,
          bookingRef: bookResponse.confirmationReference,
          status: 'confirmed',
          confirmation: savedConfirmation,
        });

 this.logger.log(
          `✅ ResAvenue hotel booking completed for route ${routeId}: ${bookResponse.confirmationReference}`,
        );
      } catch (error) {
 this.logger.error(
          `❌ Failed to book ResAvenue hotel for route ${routeId}: ${error.message}`,
        );
        results.push({
          routeId,
          hotelCode: selection.hotelCode,
          status: 'failed',
          error: error.message,
        });
      }
    }

    return results;
  }

 /**
   * Cancel ResAvenue hotel bookings for an itinerary
   * Calls ResAvenue API to cancel and updates database status
 */
  async cancelItineraryHotels(
    itineraryPlanId: number,
    reason: string = 'Itinerary cancelled by user',
  ) {
    try {
 // Find all active ResAvenue bookings for this itinerary
      const bookings = await this.prisma.resavenue_hotel_booking_confirmation.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          status: 1,
          deleted: 0,
        },
      });

      if (bookings.length === 0) {
 this.logger.log(`No active ResAvenue bookings found for itinerary ${itineraryPlanId}`);
        return [];
      }

 this.logger.log(`Found ${bookings.length} ResAvenue booking(s) to cancel`);

      const results = [];

      for (const booking of bookings) {
        try {
 // Call ResAvenue provider to cancel the booking
          const cancellationResult = await this.resavenueProvider.cancelBooking(
            booking.resavenue_booking_reference,
            reason,
          );

 // Update booking status in database
          await this.prisma.resavenue_hotel_booking_confirmation.update({
            where: {
              resavenue_hotel_booking_confirmation_ID: booking.resavenue_hotel_booking_confirmation_ID,
            },
            data: {
 status: 0, // Mark as cancelled
              updatedon: new Date(),
              api_response: {
                ...(booking.api_response as Record<string, any>),
                cancellation: cancellationResult as Record<string, any>,
                cancelledAt: new Date().toISOString(),
                cancelReason: reason,
              },
            },
          });

          results.push({
            bookingId: booking.resavenue_hotel_booking_confirmation_ID,
            resavenueBookingRef: booking.resavenue_booking_reference,
            status: 'cancelled',
            cancellationRef: cancellationResult.cancellationRef,
            refundAmount: cancellationResult.refundAmount,
            charges: cancellationResult.charges,
          });

 this.logger.log(
            `✅ Cancelled ResAvenue booking ${booking.resavenue_booking_reference}: ` +
            `Refund: ${cancellationResult.refundAmount}, Charges: ${cancellationResult.charges}`,
          );
        } catch (error) {
 this.logger.error(
            `❌ Failed to cancel ResAvenue booking ${booking.resavenue_booking_reference}: ${error.message}`,
          );

          results.push({
            bookingId: booking.resavenue_hotel_booking_confirmation_ID,
            resavenueBookingRef: booking.resavenue_booking_reference,
            status: 'failed',
            error: error.message,
          });
        }
      }

      return results;
    } catch (error) {
 this.logger.error(` Error cancelling ResAvenue itinerary hotels: ${error.message}`);
      throw new BadRequestException(
        `Failed to cancel ResAvenue hotels: ${error.message}`,
      );
    }
  }

 /**
   * Cancel ResAvenue hotel bookings for specific routes only
 */
  async cancelItineraryHotelsByRoutes(
    itineraryPlanId: number,
    routeIds: number[],
    reason: string = 'Hotel cancelled by user',
  ) {
    try {
      if (!routeIds || routeIds.length === 0) {
 this.logger.log(`No route IDs provided for cancellation`);
        return [];
      }

 // Find ResAvenue bookings for specified routes
      const bookings = await this.prisma.resavenue_hotel_booking_confirmation.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: { in: routeIds },
          status: 1,
          deleted: 0,
        },
      });

      if (bookings.length === 0) {
 this.logger.log(
          `No active ResAvenue bookings found for itinerary ${itineraryPlanId} and routes [${routeIds.join(',')}]`,
        );
        return [];
      }

 this.logger.log(
        `Found ${bookings.length} ResAvenue booking(s) to cancel for routes [${routeIds.join(',')}]`,
      );

      const results = [];

      for (const booking of bookings) {
        try {
 // Call ResAvenue provider to cancel the booking
          const cancellationResult = await this.resavenueProvider.cancelBooking(
            booking.resavenue_booking_reference,
            reason,
          );

 // Update booking status in database
          await this.prisma.resavenue_hotel_booking_confirmation.update({
            where: {
              resavenue_hotel_booking_confirmation_ID: booking.resavenue_hotel_booking_confirmation_ID,
            },
            data: {
 status: 0, // Mark as cancelled
              updatedon: new Date(),
              api_response: {
                ...(booking.api_response as Record<string, any>),
                cancellation: cancellationResult as Record<string, any>,
                cancelledAt: new Date().toISOString(),
                cancelReason: reason,
              },
            },
          });

          results.push({
            bookingId: booking.resavenue_hotel_booking_confirmation_ID,
            routeId: booking.itinerary_route_ID,
            resavenueBookingRef: booking.resavenue_booking_reference,
            status: 'cancelled',
            cancellationRef: cancellationResult.cancellationRef,
            refundAmount: cancellationResult.refundAmount,
            charges: cancellationResult.charges,
          });

 this.logger.log(
            `✅ Cancelled ResAvenue booking ${booking.resavenue_booking_reference} (Route ${booking.itinerary_route_ID}): ` +
            `Refund: ${cancellationResult.refundAmount}, Charges: ${cancellationResult.charges}`,
          );
        } catch (error) {
 this.logger.error(
            `❌ Failed to cancel ResAvenue booking ${booking.resavenue_booking_reference} (Route ${booking.itinerary_route_ID}): ${error.message}`,
          );

          results.push({
            bookingId: booking.resavenue_hotel_booking_confirmation_ID,
            routeId: booking.itinerary_route_ID,
            resavenueBookingRef: booking.resavenue_booking_reference,
            status: 'failed',
            error: error.message,
          });
        }
      }

      return results;
    } catch (error) {
 this.logger.error(` Error cancelling ResAvenue hotel routes: ${error.message}`);
      throw new BadRequestException(
        `Failed to cancel ResAvenue hotel routes: ${error.message}`,
      );
    }
  }
}
