// FILE: src/modules/itineraries/services/itinerary-cancellation.service.ts

import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { CancelItineraryDto } from '../dto/cancel-itinerary.dto';
import { TboHotelBookingService } from './tbo-hotel-booking.service';
import { ResAvenueHotelBookingService } from './resavenue-hotel-booking.service';
import { HobseHotelBookingService } from './hobse-hotel-booking.service';

@Injectable()
export class ItineraryCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tboHotelBooking: TboHotelBookingService,
    private readonly resavenueHotelBooking: ResAvenueHotelBookingService,
    private readonly hobseHotelBooking: HobseHotelBookingService,
  ) {}

  async cancelItinerary(dto: CancelItineraryDto) {
 const userId = 1; // TODO: Get from authenticated user

 // Validation
    if (!dto.itinerary_plan_ID) {
      throw new BadRequestException('Itinerary Plan ID is required');
    }

    if (!dto.reason) {
      throw new BadRequestException('Cancellation reason is required');
    }

 // Check if itinerary exists
    const confirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: dto.itinerary_plan_ID, deleted: 0 },
    });

    if (!confirmedPlan) {
      throw new NotFoundException(`Confirmed itinerary not found for Plan ID: ${dto.itinerary_plan_ID}`);
    }

 // Check if already cancelled
    const existingCancellation = await this.prisma.dvi_cancelled_itineraries.findFirst({
      where: {
        itinerary_plan_id: dto.itinerary_plan_ID,
        deleted: 0,
      },
    });

    if (existingCancellation) {
      throw new ConflictException(`Itinerary already cancelled. Cancellation ID: ${existingCancellation.cancelled_itinerary_ID}`);
    }

 // Determine cancellation options (backward compatibility)
    const cancellationOptions = dto.cancellation_options || {
      modify_hotspot: dto.cancel_hotspot ?? true,
      modify_hotel: dto.cancel_hotel ?? true,
      modify_vehicle: dto.cancel_vehicle ?? true,
      modify_guide: dto.cancel_guide ?? true,
      modify_activity: dto.cancel_activity ?? true,
    };

 // Calculate amounts
    const totalAmount = confirmedPlan.itinerary_total_net_payable_amount || 0;
    const percentage = Number(dto.cancellation_percentage) || 10;
    const cancellationCharge = Math.round((totalAmount * percentage) / 100);
    const refundAmount = Math.max(0, totalAmount - cancellationCharge);

 // Generate cancellation reference
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const cancellationReference = `CANCEL_${timestamp}_${dto.itinerary_plan_ID}`;

    try {
      return await this.prisma.$transaction(async (tx) => {
 // 1. Create cancellation record with selective options
        const cancellation = await tx.dvi_cancelled_itineraries.create({
          data: {
            itinerary_plan_id: Number(dto.itinerary_plan_ID),
            cancellation_reason: dto.reason,
            cancellation_reference: cancellationReference,
            modify_hotspot: cancellationOptions.modify_hotspot ? 1 : 0,
            modify_hotel: cancellationOptions.modify_hotel ? 1 : 0,
            modify_vehicle: cancellationOptions.modify_vehicle ? 1 : 0,
            modify_guide: cancellationOptions.modify_guide ? 1 : 0,
            modify_activity: cancellationOptions.modify_activity ? 1 : 0,
            cancelled_by: userId,
            cancelled_on: new Date(),
            cancellation_status: 'pending',
            total_cancelled_service_amount: totalAmount,
            total_cancellation_charge: cancellationCharge,
            total_refund_amount: Math.round(refundAmount),
            itinerary_cancellation_status: 1,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });

        const cancellationDetails = {
          hotspots_cancelled: 0,
          hotels_cancelled: 0,
          vehicles_cancelled: 0,
          guides_cancelled: 0,
          activities_cancelled: 0,
        };

 // 2. Process selective cancellations
 // Cancel hotspots
        if (cancellationOptions.modify_hotspot) {
          const hotspotCount = await this.cancelHotspots(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.hotspots_cancelled = hotspotCount;
        }

 // Cancel hotels
        if (cancellationOptions.modify_hotel) {
          const hotelCount = await this.cancelHotels(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.hotels_cancelled = hotelCount;
        }

 // Cancel vehicles
        if (cancellationOptions.modify_vehicle) {
          const vehicleCount = await this.cancelVehicles(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.vehicles_cancelled = vehicleCount;
        }

 // Cancel guides
        if (cancellationOptions.modify_guide) {
          const guideCount = await this.cancelGuides(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.guides_cancelled = guideCount;
        }

 // Cancel activities
        if (cancellationOptions.modify_activity) {
          const activityCount = await this.cancelActivities(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.activities_cancelled = activityCount;
        }

 // 3. Refund to wallet
        if (refundAmount > 0) {
          await tx.dvi_cash_wallet.create({
            data: {
              agent_id: confirmedPlan.agent_id,
              transaction_date: new Date(),
              transaction_amount: Math.round(refundAmount),
 transaction_type: 1, // Credit
              remarks: `Refund for Cancelled Itinerary: ${confirmedPlan.itinerary_quote_ID} - ${cancellationReference}`,
              transaction_id: confirmedPlan.itinerary_quote_ID,
              createdby: userId,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });

 // Log refund processing
          await this.logCancellationAction(
            tx,
            cancellation.cancelled_itinerary_ID,
            dto.itinerary_plan_ID,
            'refund_processed',
            `Refund amount: ${refundAmount}`,
            userId,
          );
        }

 // 4. Update plan statuses
        const isFullCancellation =
          cancellationOptions.modify_hotspot &&
          cancellationOptions.modify_hotel &&
          cancellationOptions.modify_vehicle;

        if (isFullCancellation) {
 // Full cancellation - update status to cancelled
          await tx.dvi_itinerary_plan_details.update({
            where: { itinerary_plan_ID: dto.itinerary_plan_ID },
            data: {
 quotation_status: 2, // Cancelled
              updatedon: new Date(),
            },
          });

          await tx.dvi_confirmed_itinerary_plan_details.update({
            where: { confirmed_itinerary_plan_ID: confirmedPlan.confirmed_itinerary_plan_ID },
            data: {
              itinerary_cancellation_status: 1,
              updatedon: new Date(),
            },
          });
        } else {
 // Partial cancellation - mark as partially cancelled
          await tx.dvi_confirmed_itinerary_plan_details.update({
            where: { confirmed_itinerary_plan_ID: confirmedPlan.confirmed_itinerary_plan_ID },
            data: {
 itinerary_cancellation_status: 2, // Partially cancelled
              updatedon: new Date(),
            },
          });
        }

 // 5. Update cancellation status to completed
        await tx.dvi_cancelled_itineraries.update({
          where: { cancelled_itinerary_ID: cancellation.cancelled_itinerary_ID },
          data: {
            cancellation_status: 'completed',
            updatedon: new Date(),
          },
        });

 // 6. Log completion
        await this.logCancellationAction(
          tx,
          cancellation.cancelled_itinerary_ID,
          dto.itinerary_plan_ID,
          'cancellation_completed',
          `Full: ${isFullCancellation}, Details: ${JSON.stringify(cancellationDetails)}`,
          userId,
        );

 // 7. Send notifications (async, don't wait)
        this.sendCancellationNotifications(
          confirmedPlan,
          cancellationReference,
          dto.reason,
          refundAmount,
          cancellationOptions,
        ).catch(err => {
 console.error('Error sending cancellation notifications:', err);
        });

        return {
          success: true,
          message: isFullCancellation
            ? 'Itinerary cancelled successfully'
            : 'Selected itinerary components cancelled successfully',
          data: {
            cancellation_id: cancellation.cancelled_itinerary_ID,
            itinerary_id: dto.itinerary_plan_ID,
            cancellation_reference: cancellationReference,
            status: 'completed',
            refund_amount: Math.round(refundAmount),
            cancellation_details: cancellationDetails,
            cancelled_on: cancellation.cancelled_on,
          },
        };
      }, {
        maxWait: 15000,
        timeout: 120000,
      });
    } catch (error) {
      if (error instanceof BadRequestException ||
          error instanceof NotFoundException ||
          error instanceof ConflictException) {
        throw error;
      }
 console.error('Cancellation processing error:', error);
      throw new Error(`Cancellation processing failed: ${error.message}`);
    }
  }

 // Helper methods for selective cancellation
  private async cancelHotspots(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const hotspots = await tx.dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      });

      if (hotspots.length > 0) {
        await tx.dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: itineraryPlanId,
            deleted: 0,
          },
          data: {
 status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'hotspot_cancelled',
          `${hotspots.length} hotspot(s) cancelled`,
          userId,
        );
      }

      return hotspots.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'hotspot_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelHotels(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const hotels = await tx.dvi_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: itineraryPlanId,
          deleted: 0,
        },
      });

      if (hotels.length > 0) {
        const supplierHotels = hotels.filter((hotel: any) => {
          const provider = String(hotel.hotel_provider || '').trim().toLowerCase();
          const bookingMode = String(hotel.hotel_booking_mode || '').trim().toUpperCase();
          return provider !== 'offline' && bookingMode !== 'MANUAL_APPROVAL';
        });
        if (supplierHotels.length > 0) {
 // Cancel TBO bookings via API BEFORE updating database
        try {
          const tboCancellationResults = await this.tboHotelBooking.cancelItineraryHotels(
            itineraryPlanId,
            'Itinerary cancelled by user',
          );

 console.log(`[TBO Cancellation] Results:`, tboCancellationResults);
        } catch (error) {
 console.error(`[TBO Cancellation] Failed but continuing with DB updates:`, error.message);
 // Continue with database updates even if TBO cancellation fails
        }

 // Cancel ResAvenue bookings via API
        try {
          const resavenueCancellationResults = await this.resavenueHotelBooking.cancelItineraryHotels(
            itineraryPlanId,
            'Itinerary cancelled by user',
          );

 console.log(`[ResAvenue Cancellation] Results:`, resavenueCancellationResults);
        } catch (error) {
 console.error(`[ResAvenue Cancellation] Failed but continuing with DB updates:`, error.message);
 // Continue with database updates even if ResAvenue cancellation fails
        }

 // Cancel HOBSE bookings via API
        try {
          await this.hobseHotelBooking.cancelItineraryHotels(itineraryPlanId);
 console.log(`[HOBSE Cancellation] Successfully processed`);
        } catch (error) {
 console.error(`[HOBSE Cancellation] Failed but continuing with DB updates:`, error.message);
 // Continue with database updates even if HOBSE cancellation fails
        }
        }

 // Mark hotels as cancelled
        await tx.dvi_itinerary_plan_hotel_details.updateMany({
          where: {
            itinerary_plan_id: itineraryPlanId,
            deleted: 0,
          },
          data: {
            hotel_cancellation_status: 1,
            updatedon: new Date(),
          },
        });

 // Copy to cancelled hotel details table if exists
        for (const hotel of hotels) {
          try {
            await tx.dvi_cancelled_itinerary_plan_hotel_details.create({
              data: {
                cancelled_itinerary_ID: cancellationId,
                itinerary_plan_hotel_details_ID: hotel.itinerary_plan_hotel_details_ID,
                itinerary_plan_id: itineraryPlanId,
                hotel_id: hotel.hotel_id || 0,
                itinerary_route_date: hotel.itinerary_route_date,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          } catch (err) {
 console.error('Error creating cancelled hotel record:', err);
          }
        }

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'hotel_cancelled',
          `${hotels.length} hotel(s) cancelled`,
          userId,
        );
      }

      return hotels.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'hotel_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelVehicles(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const vehicles = await tx.dvi_itinerary_plan_vehicle_details.findMany({
        where: {
          itinerary_plan_id: itineraryPlanId,
          deleted: 0,
        },
      });

      if (vehicles.length > 0) {
        await tx.dvi_itinerary_plan_vehicle_details.updateMany({
          where: {
            itinerary_plan_id: itineraryPlanId,
            deleted: 0,
          },
          data: {
 status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'vehicle_cancelled',
          `${vehicles.length} vehicle(s) cancelled`,
          userId,
        );
      }

      return vehicles.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'vehicle_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelGuides(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const guides = await tx.dvi_itinerary_route_guide_details.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      });

      if (guides.length > 0) {
        await tx.dvi_itinerary_route_guide_details.updateMany({
          where: {
            itinerary_plan_ID: itineraryPlanId,
            deleted: 0,
          },
          data: {
 status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'guide_cancelled',
          `${guides.length} guide(s) cancelled`,
          userId,
        );
      }

      return guides.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'guide_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelActivities(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const activities = await tx.dvi_itinerary_route_activity_details.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      });

      if (activities.length > 0) {
        await tx.dvi_itinerary_route_activity_details.updateMany({
          where: {
            itinerary_plan_ID: itineraryPlanId,
            deleted: 0,
          },
          data: {
 status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'activity_cancelled',
          `${activities.length} activit(y/ies) cancelled`,
          userId,
        );
      }

      return activities.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'activity_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  async logCancellationAction(
    tx: any,
    cancellationId: number,
    itineraryPlanId: number,
    actionType: string,
    actionDetails: string,
    userId: number,
    status: string = 'success',
    errorMessage?: string,
  ): Promise<void> {
    await tx.dvi_cancellation_logs.create({
      data: {
        cancellation_id: cancellationId,
        itinerary_plan_id: itineraryPlanId,
        action_type: actionType,
        action_details: actionDetails,
        status,
        error_message: errorMessage || null,
        created_by: userId,
        created_on: new Date(),
      },
    });
  }

  private async sendCancellationNotifications(
    confirmedPlan: any,
    cancellationReference: string,
    reason: string,
    refundAmount: number,
    cancellationOptions: any,
  ): Promise<void> {
 // TODO: Implement notification logic
 // This could send emails, SMS, push notifications, etc.
 console.log('Sending cancellation notifications:', {
      itineraryId: confirmedPlan.itinerary_plan_ID,
      agentId: confirmedPlan.agent_id,
      cancellationReference,
      reason,
      refundAmount,
      cancellationOptions,
    });

 // Example: Send email notification
 // await this.emailService.sendCancellationEmail({
 // to: confirmedPlan.customer_email,
 // subject: `Itinerary Cancellation - ${cancellationReference}`,
 // body: `Your itinerary has been cancelled. Refund amount: ${refundAmount}`,
 // });
  }

}
