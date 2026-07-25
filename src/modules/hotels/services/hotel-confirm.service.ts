import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
// @ts-ignore - Database table names may not match exactly
import { PrismaService } from '../../../prisma.service';
import { IHotelProvider } from '../interfaces/hotel-provider.interface';
import { HotelConfirmationDTO } from '../dto/hotel.dto';
import { TBOHotelProvider } from '../providers/tbo-hotel.provider';
import { ResAvenueHotelProvider } from '../providers/resavenue-hotel.provider';

@Injectable()
export class HotelConfirmService {
  private providers: Map<string, IHotelProvider>;
  private readonly logger = new Logger(HotelConfirmService.name);
  private prisma: any;

  constructor(
    private readonly tboHotelProvider: TBOHotelProvider,
    private readonly resavenueHotelProvider: ResAvenueHotelProvider,
    prismaService: PrismaService,
    private tboProvider: TBOHotelProvider,
    private resavenueProvider: ResAvenueHotelProvider,
  ) {
    this.prisma = prismaService;
    this.providers = new Map<string, any>([
      ['tbo', this.tboProvider],
      ['resavenue', this.resavenueProvider],
 // Add HOBSE provider here when implemented
    ]);
  }

  async confirmHotelBooking(confirmationDTO: HotelConfirmationDTO) {
    try {
 this.logger.log(
        `Confirming hotel booking for itinerary: ${confirmationDTO.itineraryPlanId}`,
      );

 // Step 1: Validate search reference exists and is not expired
      const searchResult = await this.prisma.hotelSearchResults.findUnique({
        where: { search_reference: confirmationDTO.searchReference },
      });

      if (!searchResult) {
        throw new NotFoundException('Search reference not found');
      }

      if (new Date() > new Date(searchResult.expires_at)) {
 this.logger.warn(`Search reference expired: ${confirmationDTO.searchReference}`);
        throw new BadRequestException(
          'Search reference expired. Please search again.',
        );
      }

 this.logger.log(`Search reference valid, proceeding with confirmation`);

 // Step 2: Get provider and confirm booking
      const provider = this.providers.get(searchResult.provider);

      if (!provider) {
        throw new InternalServerErrorException(
          `Provider ${searchResult.provider} not found`,
        );
      }

      const confirmationResult = await provider.confirmBooking(confirmationDTO);

 this.logger.log(
        `Booking confirmed with reference: ${confirmationResult.confirmationReference}`,
      );

 // Step 3: Save confirmation to database
      const savedConfirmation = await this.prisma.dviHotelConfirmations.create({
        data: {
          itinerary_plan_id: confirmationDTO.itineraryPlanId,
          confirmation_reference: confirmationResult.confirmationReference,
          provider: searchResult.provider,
          hotel_code: confirmationDTO.hotelCode,
          hotel_name: confirmationResult.hotelName,
          search_reference: confirmationDTO.searchReference,
          check_in_date: new Date(confirmationDTO.checkInDate),
          check_out_date: new Date(confirmationDTO.checkOutDate),
          room_count: confirmationDTO.roomCount,
          total_price: confirmationResult.totalPrice,
          currency: 'INR',
          price_breakdown: JSON.stringify(confirmationResult.priceBreadown),
          cancellation_policy: confirmationResult.cancellationPolicy,
          guest_details: JSON.stringify(confirmationDTO.guests),
          status: 'pending_payment',
          booking_deadline: new Date(confirmationResult.bookingDeadline),
        },
      });

 this.logger.log(`Confirmation saved to database with ID: ${savedConfirmation.id}`);

      return {
        success: true,
        message: 'Hotel booking confirmed',
        data: {
          confirmationReference: confirmationResult.confirmationReference,
          hotelName: confirmationResult.hotelName,
          checkIn: confirmationDTO.checkInDate,
          checkOut: confirmationDTO.checkOutDate,
          roomCount: confirmationDTO.roomCount,
          totalPrice: confirmationResult.totalPrice,
          priceBreakdown: confirmationResult.priceBreadown,
          bookingDeadline: confirmationResult.bookingDeadline,
          nextStep: 'Complete payment to finalize booking',
        },
      };
    } catch (error) {
 this.logger.error(`Booking confirmation error: ${error.message}`, error.stack);
      throw error;
    }
  }

  async initiatePayment(confirmationReference: string) {
    try {
 this.logger.log(`Initiating payment for confirmation: ${confirmationReference}`);

 // Step 1: Verify confirmation exists
      const confirmation = await this.prisma.dviHotelConfirmations.findUnique({
        where: { confirmation_reference: confirmationReference },
      });

      if (!confirmation) {
        throw new NotFoundException('Confirmation not found');
      }

      if (confirmation.status !== 'pending_payment') {
        throw new BadRequestException('Booking already finalized or cancelled');
      }

 this.logger.log(`Confirmation found, proceeding with payment setup`);

 // Step 2: Create Razorpay order would happen in a separate service
 // For now, we'll return the structure needed for frontend to create order
      return {
        success: true,
        message: 'Payment order initiated',
        data: {
          confirmationReference: confirmation.confirmation_reference,
          amount: confirmation.total_price,
          currency: 'INR',
          hotelName: confirmation.hotel_name,
          checkIn: confirmation.check_in_date,
          checkOut: confirmation.check_out_date,
          roomCount: confirmation.room_count,
          guestCount: confirmation.guest_details
            ? JSON.parse(confirmation.guest_details).length
            : 0,
        },
      };
    } catch (error) {
 this.logger.error(`Payment initiation error: ${error.message}`, error.stack);
      throw error;
    }
  }

  async finalizePayment(confirmationReference: string, razorpayPaymentId: string) {
    try {
 this.logger.log(
        `Finalizing payment for confirmation: ${confirmationReference}`,
      );

 // Step 1: Verify confirmation exists
      const confirmation = await this.prisma.dviHotelConfirmations.findUnique({
        where: { confirmation_reference: confirmationReference },
      });

      if (!confirmation) {
        throw new NotFoundException('Confirmation not found');
      }

 // Step 2: Update confirmation with payment details
      const updated = await this.prisma.dviHotelConfirmations.update({
        where: { confirmation_reference: confirmationReference },
        data: {
          razorpay_payment_id: razorpayPaymentId,
          payment_status: 'completed',
          status: 'confirmed',
        },
      });

 this.logger.log(`Payment finalized, booking status updated to confirmed`);

 // Step 3: Update itinerary with hotel confirmation
      const hotelRecord = await this.prisma.dviHotel.findFirst({
        where: { tbo_hotel_code: confirmation.hotel_code },
      });

      if (hotelRecord) {
        await this.prisma.dviItineraryPlanHotel.upsert({
          where: {
            plan_id_city_id: {
              plan_id: confirmation.itinerary_plan_id,
              city_id: hotelRecord.hotel_city,
            },
          },
          update: {
            hotel_id: hotelRecord.hotel_id,
            tbo_confirmation_id: confirmation.confirmation_reference,
            booking_status: 'confirmed',
            confirmed_at: new Date(),
          },
          create: {
            plan_id: confirmation.itinerary_plan_id,
            hotel_id: hotelRecord.hotel_id,
            city_id: hotelRecord.hotel_city,
            tbo_confirmation_id: confirmation.confirmation_reference,
            booking_status: 'confirmed',
            confirmed_at: new Date(),
          },
        });
      }

      return {
        success: true,
        message: 'Payment successful. Hotel booking confirmed.',
        data: {
          confirmationReference: confirmation.confirmation_reference,
          status: 'confirmed',
          hotelName: confirmation.hotel_name,
          checkIn: confirmation.check_in_date,
          checkOut: confirmation.check_out_date,
        },
      };
    } catch (error) {
 this.logger.error(`Payment finalization error: ${error.message}`, error.stack);
      throw error;
    }
  }

  async getConfirmation(confirmationReference: string) {
    try {
 this.logger.log(`Fetching confirmation details: ${confirmationReference}`);

      const confirmation = await this.prisma.dviHotelConfirmations.findUnique({
        where: { confirmation_reference: confirmationReference },
      });

      if (!confirmation) {
        throw new NotFoundException('Confirmation not found');
      }

 // Get latest status from provider
      const provider = this.providers.get(confirmation.provider);

      let providerStatus = null;
      if (provider) {
        try {
          providerStatus = await provider.getConfirmation(confirmationReference);
        } catch (error) {
 this.logger.warn(`Failed to fetch provider status: ${error.message}`);
        }
      }

      return {
        success: true,
        data: {
          confirmationRef: confirmation.confirmation_reference,
          hotelName: confirmation.hotel_name,
          checkIn: confirmation.check_in_date,
          checkOut: confirmation.check_out_date,
          roomCount: confirmation.room_count,
          totalPrice: confirmation.total_price,
          paymentStatus: confirmation.payment_status,
          bookingStatus: confirmation.status,
          cancellationPolicy: confirmation.cancellation_policy,
          providerStatus: providerStatus,
        },
      };
    } catch (error) {
 this.logger.error(`Get confirmation error: ${error.message}`, error.stack);
      throw error;
    }
  }

  async cancelBooking(confirmationReference: string, reason: string) {
    try {
 this.logger.log(`Cancelling booking: ${confirmationReference}, Reason: ${reason}`);

      const confirmation = await this.prisma.dviHotelConfirmations.findUnique({
        where: { confirmation_reference: confirmationReference },
      });

      if (!confirmation) {
        throw new NotFoundException('Confirmation not found');
      }

      if (confirmation.status !== 'confirmed') {
        throw new BadRequestException('Can only cancel confirmed bookings');
      }

 // Call provider cancel
      const provider = this.providers.get(confirmation.provider);

      if (!provider) {
        throw new InternalServerErrorException(`Provider not found`);
      }

      const cancellationResult = await provider.cancelBooking(
        confirmationReference,
        reason,
      );

 // Record cancellation
      await this.prisma.hotelCancellations.create({
        data: {
          confirmation_id: confirmation.id,
          cancellation_reference: cancellationResult.cancellationRef,
          reason: reason,
          refund_amount: cancellationResult.refundAmount,
          cancellation_charges: cancellationResult.charges,
          status: 'pending',
        },
      });

 // Update confirmation
      await this.prisma.dviHotelConfirmations.update({
        where: { confirmation_reference: confirmationReference },
        data: { status: 'cancelled' },
      });

 this.logger.log(`Booking cancelled successfully: ${confirmationReference}`);

      return {
        success: true,
        message: 'Cancellation initiated',
        data: {
          cancellationReference: cancellationResult.cancellationRef,
          refundAmount: cancellationResult.refundAmount,
          estimatedRefundDays: cancellationResult.refundDays,
        },
      };
    } catch (error) {
 this.logger.error(`Cancellation error: ${error.message}`, error.stack);
      throw error;
    }
  }
}
