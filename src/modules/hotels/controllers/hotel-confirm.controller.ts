import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { HotelConfirmService } from '../services/hotel-confirm.service';
import {
  HotelConfirmationDTO,
  HotelPaymentDTO,
  CancellationDTO,
} from '../dto/hotel.dto';

@Controller('hotels')
export class HotelConfirmController {
  private readonly logger = new Logger(HotelConfirmController.name);

  constructor(private hotelConfirmService: HotelConfirmService) {}

  @Post('confirm')
  @HttpCode(HttpStatus.CREATED)
  async confirmHotelBooking(@Body() dto: HotelConfirmationDTO) {
 this.logger.log(
      `Hotel confirmation request for itinerary: ${dto.itineraryPlanId}`,
    );

    try {
      const result = await this.hotelConfirmService.confirmHotelBooking(dto);
      return result;
    } catch (error) {
 this.logger.error(`Hotel confirmation error: ${(error as any).message}`, (error as any).stack);
      throw error;
    }
  }

  @Post('payment/initiate')
  @HttpCode(HttpStatus.OK)
  async initiatePayment(@Body() dto: HotelPaymentDTO) {
 this.logger.log(`Payment initiation for confirmation: ${dto.confirmationReference}`);

    try {
      const result = await this.hotelConfirmService.initiatePayment(
        dto.confirmationReference,
      );
      return result;
    } catch (error) {
 this.logger.error(`Payment initiation error: ${(error as any).message}`, (error as any).stack);
      throw error;
    }
  }

  @Post('payment/finalize/:ref')
  @HttpCode(HttpStatus.OK)
  async finalizePayment(
    @Param('ref') confirmationReference: string,
    @Body() dto: { razorpayPaymentId: string },
  ) {
 this.logger.log(`Payment finalization for confirmation: ${confirmationReference}`);

    try {
      const result = await this.hotelConfirmService.finalizePayment(
        confirmationReference,
        dto.razorpayPaymentId,
      );
      return result;
    } catch (error) {
 this.logger.error(`Payment finalization error: ${(error as any).message}`, (error as any).stack);
      throw error;
    }
  }

  @Get('confirmation/:ref')
  @HttpCode(HttpStatus.OK)
  async getConfirmation(@Param('ref') confirmationReference: string) {
 this.logger.log(`Fetching confirmation: ${confirmationReference}`);

    try {
      const result = await this.hotelConfirmService.getConfirmation(
        confirmationReference,
      );
      return result;
    } catch (error) {
 this.logger.error(`Get confirmation error: ${(error as any).message}`, (error as any).stack);
      throw error;
    }
  }

  @Post('cancel/:ref')
  @HttpCode(HttpStatus.OK)
  async cancelBooking(
    @Param('ref') confirmationReference: string,
    @Body() dto: CancellationDTO,
  ) {
 this.logger.log(
      `Cancellation request for confirmation: ${confirmationReference}`,
    );

    try {
      const result = await this.hotelConfirmService.cancelBooking(
        confirmationReference,
        dto.reason,
      );
      return result;
    } catch (error) {
 this.logger.error(`Cancellation error: ${(error as any).message}`, (error as any).stack);
      throw error;
    }
  }
}
