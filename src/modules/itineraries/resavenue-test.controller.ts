import { Controller, Post, Body, Logger, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ResAvenueHotelProvider } from '../hotels/providers/resavenue-hotel.provider';
import { ResAvenueHotelBookingService } from './services/resavenue-hotel-booking.service';

/**
 * Test endpoints for ResAvenue booking and cancellation
 * These endpoints allow direct testing of ResAvenue provider methods
 */

class TestBookingDto {
  hotelCode: string;
  checkInDate: string;
  checkOutDate: string;
  invCode: number;
  rateCode: number;
  numberOfRooms: number;
  guests: Array<{
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
  }>;
}

class TestCancellationDto {
  bookingReference: string;
  reason: string;
}

class TestConfirmationDto {
  bookingReference: string;
}

@ApiTags('ResAvenue Testing')
@Controller('api/v1/test/resavenue')
export class ResAvenueTestController {
  private readonly logger = new Logger(ResAvenueTestController.name);

  constructor(
    private readonly resavenueProvider: ResAvenueHotelProvider,
    private readonly resavenueBookingService: ResAvenueHotelBookingService,
  ) {}

  @Post('test-booking')
  @ApiOperation({
    summary: 'Test ResAvenue booking confirmation',
    description: 'Directly calls ResAvenue provider confirmBooking method for testing'
  })
  @ApiResponse({ status: 200, description: 'Booking confirmed successfully' })
  @ApiResponse({ status: 400, description: 'Booking failed' })
  async testBooking(@Body() bookingData: TestBookingDto) {
 this.logger.log(' Testing ResAvenue booking confirmation');

    try {
 // Call ResAvenue provider directly
      const result = await this.resavenueProvider.confirmBooking({
        hotelCode: bookingData.hotelCode,
        checkInDate: bookingData.checkInDate,
        checkOutDate: bookingData.checkOutDate,
        itineraryPlanId: 0,
        searchReference: '',
        roomCount: bookingData.numberOfRooms,
        contactName: bookingData.guests[0]?.firstName || 'Guest',
        contactEmail: bookingData.guests[0]?.email || '',
        contactPhone: bookingData.guests[0]?.phone || '',
        rooms: [
          {
            roomCode: `${bookingData.invCode}-${bookingData.rateCode}`,
            guestCount: bookingData.guests.length,
            quantity: bookingData.numberOfRooms,
          },
        ],
        guests: bookingData.guests.map(g => ({
          firstName: g.firstName,
          lastName: g.lastName,
          email: g.email || '',
          phone: g.phone || '',
        })),
      });

 this.logger.log(` Test booking successful: ${result.confirmationReference}`);

      return {
        success: true,
        message: 'ResAvenue booking test completed',
        data: {
          confirmationReference: result.confirmationReference,
          hotelCode: result.hotelCode,
          checkIn: result.checkIn,
          checkOut: result.checkOut,
          totalPrice: result.totalPrice,
          status: result.status,
          bookingDeadline: result.bookingDeadline,
          cancellationPolicy: result.cancellationPolicy,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
 this.logger.error(` Test booking failed: ${error.message}`);
      throw error;
    }
  }

  @Post('test-cancellation')
  @ApiOperation({
    summary: 'Test ResAvenue booking cancellation',
    description: 'Directly calls ResAvenue provider cancelBooking method for testing'
  })
  @ApiResponse({ status: 200, description: 'Cancellation successful' })
  @ApiResponse({ status: 400, description: 'Cancellation failed' })
  async testCancellation(@Body() cancellationData: TestCancellationDto) {
 this.logger.log(' Testing ResAvenue booking cancellation');

    try {
 // Call ResAvenue provider directly
      const result = await this.resavenueProvider.cancelBooking(
        cancellationData.bookingReference,
        cancellationData.reason,
      );

 this.logger.log(` Test cancellation successful: ${result.cancellationRef}`);

      return {
        success: true,
        message: 'ResAvenue cancellation test completed',
        data: {
          cancellationRef: result.cancellationRef,
          refundAmount: result.refundAmount,
          charges: result.charges,
          refundDays: result.refundDays,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
 this.logger.error(` Test cancellation failed: ${error.message}`);
      throw error;
    }
  }

  @Post('test-confirmation-details')
  @ApiOperation({
    summary: 'Test ResAvenue get confirmation details',
    description: 'Retrieves booking details from ResAvenue'
  })
  @ApiResponse({ status: 200, description: 'Details retrieved successfully' })
  @ApiResponse({ status: 400, description: 'Retrieval failed' })
  async testGetConfirmation(@Body() confirmationData: TestConfirmationDto) {
 this.logger.log(' Testing ResAvenue get confirmation details');

    try {
 // Call ResAvenue provider directly
      const result = await this.resavenueProvider.getConfirmation(
        confirmationData.bookingReference,
      );

 this.logger.log(` Test confirmation retrieval successful`);

      return {
        success: true,
        message: 'ResAvenue confirmation details test completed',
        data: result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
 this.logger.error(` Test confirmation retrieval failed: ${error.message}`);
      throw error;
    }
  }

  @Post('test-booking-service')
  @ApiOperation({
    summary: 'Test ResAvenue booking service confirm',
    description: 'Tests the ResAvenueHotelBookingService confirmBooking method'
  })
  @ApiResponse({ status: 200, description: 'Service booking test successful' })
  @ApiResponse({ status: 400, description: 'Service booking test failed' })
  async testBookingService(@Body() bookingData: TestBookingDto) {
 this.logger.log(' Testing ResAvenue booking service');

    try {
      const selection = {
        hotelCode: bookingData.hotelCode,
        bookingCode: `${bookingData.invCode}-${bookingData.rateCode}`,
        roomType: 'Test Room Type',
        checkInDate: bookingData.checkInDate,
        checkOutDate: bookingData.checkOutDate,
        numberOfRooms: bookingData.numberOfRooms,
        guestNationality: 'IN',
        netAmount: 5000,
        guests: bookingData.guests.map(g => ({
          firstName: g.firstName,
          lastName: g.lastName,
          email: g.email,
          phone: g.phone,
        })),
      };

      const result = await this.resavenueBookingService.confirmBooking(
        selection,
        bookingData.invCode,
        bookingData.rateCode,
      );

 this.logger.log(` Test booking service successful`);

      return {
        success: true,
        message: 'ResAvenue booking service test completed',
        data: result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
 this.logger.error(` Test booking service failed: ${error.message}`);
      throw error;
    }
  }

  @Post('health-check')
  @ApiOperation({
    summary: 'Health check for ResAvenue provider',
    description: 'Verifies ResAvenue provider is properly configured'
  })
  @ApiResponse({ status: 200, description: 'Health check passed' })
  async healthCheck() {
 this.logger.log(' ResAvenue provider health check');

    return {
      success: true,
      message: 'ResAvenue provider is configured',
      config: {
 baseUrl: process.env.RESAVENUE_BASE_URL || 'http://203.109.97.241:8080/ChannelController',
        username: process.env.RESAVENUE_USERNAME ? '✅ Set' : '❌ Not set',
        password: process.env.RESAVENUE_PASSWORD ? '✅ Set' : '❌ Not set',
        idContext: process.env.RESAVENUE_ID_CONTEXT || 'REV',
      },
      timestamp: new Date().toISOString(),
    };
  }
}

export default ResAvenueTestController;
