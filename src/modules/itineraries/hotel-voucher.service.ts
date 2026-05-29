import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { TboHotelBookingService } from './services/tbo-hotel-booking.service';
import { ResAvenueHotelBookingService } from './services/resavenue-hotel-booking.service';
import { HobseHotelBookingService } from './services/hobse-hotel-booking.service';
import { AxisRoomsBookingPushService } from './services/axisrooms-booking-push.service';
import { StaahBookingPushService } from './services/staah-booking-push.service';
import { CancelHotelVouchersDto } from './dto/cancel-hotel-vouchers.dto';

export interface AddCancellationPolicyDto {
  itineraryPlanId: number;
  hotelId: number;
  cancellationDate: string;
  cancellationPercentage: number;
  description: string;
}

export interface CreateVoucherDto {
  itineraryPlanId: number;
  vouchers: Array<{
    routeId: number;
    hotelId: number;
    hotelDetailsIds: number[];
    routeDates: string[];
    confirmedBy: string;
    emailId: string;
    mobileNumber: string;
    status: string;
    invoiceTo: string;
    voucherTermsCondition: string;
  }>;
}

@Injectable()
export class HotelVoucherService {
  private readonly logger = new Logger(HotelVoucherService.name);

  constructor(
    private prisma: PrismaService,
    private tboHotelBooking: TboHotelBookingService,
    private resavenueHotelBooking: ResAvenueHotelBookingService,
    private hobseHotelBooking: HobseHotelBookingService,
    private axisroomsBookingPushService: AxisRoomsBookingPushService,
    private staahBookingPushService: StaahBookingPushService,
  ) {}

  /**
   * Get all cancellation policies for an itinerary
   */
  async getAllCancellationPolicies(itineraryPlanId: number) {
    const policies = await this.prisma.dvi_confirmed_itinerary_plan_hotel_cancellation_policy.findMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        deleted: 0,
      },
      orderBy: [{ hotel_id: 'asc' }, { cancellation_date: 'asc' }],
    });

    if (!policies.length) {
      return [];
    }

    const hotelIds = Array.from(new Set(policies.map((p) => Number(p.hotel_id)).filter((id) => id > 0)));
    const hotels = hotelIds.length
      ? await this.prisma.dvi_hotel.findMany({
          where: { hotel_id: { in: hotelIds } as any },
          select: { hotel_id: true, hotel_name: true },
        })
      : [];

    const hotelNameById = new Map<number, string>();
    for (const h of hotels as any[]) {
      hotelNameById.set(Number(h.hotel_id), String(h.hotel_name || ''));
    }

    return policies.map((p) => ({
      id: p.cnf_itinerary_plan_hotel_cancellation_policy_ID,
      hotelId: p.hotel_id,
      hotelName: hotelNameById.get(Number(p.hotel_id)) || '',
      cancellationDate: p.cancellation_date?.toISOString().split('T')[0],
      cancellationPercentage: p.cancellation_percentage,
      description: p.cancellation_descrption || '',
      itineraryPlanId: p.itinerary_plan_id,
    }));
  }

  /**
   * Get cancellation policies for a specific hotel
   */
  async getHotelCancellationPolicies(itineraryPlanId: number, hotelId: number) {
    const policies = await this.prisma.dvi_confirmed_itinerary_plan_hotel_cancellation_policy.findMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        hotel_id: hotelId,
        deleted: 0,
      },
      orderBy: {
        cancellation_date: 'asc',
      },
    });

    return policies.map((p) => ({
      id: p.cnf_itinerary_plan_hotel_cancellation_policy_ID,
      hotelId: p.hotel_id,
      cancellationDate: p.cancellation_date?.toISOString().split('T')[0],
      cancellationPercentage: p.cancellation_percentage,
      description: p.cancellation_descrption || '',
      itineraryPlanId: p.itinerary_plan_id,
    }));
  }

  /**
   * Add a new cancellation policy
   */
  async addCancellationPolicy(dto: AddCancellationPolicyDto, userId: number = 1) {
    this.logger.log(`Adding cancellation policy for hotel ${dto.hotelId} in plan ${dto.itineraryPlanId}`);

    const policy = await this.prisma.dvi_confirmed_itinerary_plan_hotel_cancellation_policy.create({
      data: {
        itinerary_plan_id: dto.itineraryPlanId,
        hotel_id: dto.hotelId,
        cancellation_date: new Date(dto.cancellationDate),
        cancellation_percentage: dto.cancellationPercentage,
        cancellation_descrption: dto.description,
        createdby: userId,
        createdon: new Date(),
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    return {
      success: true,
      data: {
        id: policy.cnf_itinerary_plan_hotel_cancellation_policy_ID,
        hotelId: policy.hotel_id,
        cancellationDate: policy.cancellation_date?.toISOString().split('T')[0],
        cancellationPercentage: policy.cancellation_percentage,
        description: policy.cancellation_descrption || '',
        itineraryPlanId: policy.itinerary_plan_id,
      },
    };
  }

  /**
   * Delete a cancellation policy
   */
  async deleteCancellationPolicy(policyId: number) {
    const policy = await this.prisma.dvi_confirmed_itinerary_plan_hotel_cancellation_policy.findUnique({
      where: {
        cnf_itinerary_plan_hotel_cancellation_policy_ID: policyId,
      },
    });

    if (!policy) {
      throw new NotFoundException('Cancellation policy not found');
    }

    await this.prisma.dvi_confirmed_itinerary_plan_hotel_cancellation_policy.update({
      where: {
        cnf_itinerary_plan_hotel_cancellation_policy_ID: policyId,
      },
      data: {
        deleted: 1,
        updatedon: new Date(),
      },
    });

    return { success: true };
  }

  /**
   * Get existing voucher data for a hotel
   */
  async getHotelVoucher(itineraryPlanId: number, hotelId: number) {
    const voucher = await this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.findFirst({
      where: {
        itinerary_plan_id: itineraryPlanId,
        hotel_id: hotelId,
        deleted: 0,
      },
    });

    if (!voucher) {
      return null;
    }

    // Map invoice_to integer to string
    const invoiceToMap: Record<number, string> = {
      1: 'gst_bill_against_dvi',
      2: 'hotel_direct',
      3: 'agent',
    };

    // Map hotel_booking_status integer to string
    const statusMap: Record<number, string> = {
      1: 'confirmed',
      2: 'cancelled',
      0: 'pending',
    };

    return {
      id: voucher.cnf_itinerary_plan_hotel_voucher_details_ID,
      itineraryPlanId: voucher.itinerary_plan_id,
      hotelId: voucher.hotel_id,
      confirmedBy: voucher.hotel_confirmed_by || '',
      emailId: voucher.hotel_confirmed_email_id || '',
      mobileNumber: voucher.hotel_confirmed_mobile_no || '',
      status: statusMap[voucher.hotel_booking_status] || 'pending',
      invoiceTo: invoiceToMap[voucher.invoice_to] || 'gst_bill_against_dvi',
      voucherTermsCondition: voucher.hotel_voucher_terms_condition || '',
    };
  }

  /**
   * Create hotel vouchers
   */
  async createHotelVouchers(dto: CreateVoucherDto, userId: number = 1) {
    this.logger.log(`Creating ${dto.vouchers.length} hotel vouchers for plan ${dto.itineraryPlanId}`);
    this.logger.debug(`Voucher data: ${JSON.stringify(dto.vouchers, null, 2)}`);

    // Map string values to integers for database
    const invoiceToMap: Record<string, number> = {
      gst_bill_against_dvi: 1,
      hotel_direct: 2,
      agent: 3,
    };

    const statusMap: Record<string, number> = {
      confirmed: 1,
      cancelled: 2,
      pending: 0,
    };

    const createdVouchers: Array<{
      recordId: number;
      routeId: number;
      hotelDetailsId: number;
      status: string;
    }> = [];
    const routeIdsToCancel = new Set<number>();

    for (const voucher of dto.vouchers) {
      // Validation: if status is 'cancelled' but routeId is missing/invalid, throw error
      if (voucher.status === 'cancelled' && (!voucher.routeId || typeof voucher.routeId !== 'number')) {
        throw new BadRequestException(
          `Voucher with status 'cancelled' must have a valid routeId. Received: ${voucher.routeId}`,
        );
      }

      // Create voucher for each route date and hotel details ID
      for (let i = 0; i < voucher.routeDates.length; i++) {
        const routeDate = voucher.routeDates[i];
        const hotelDetailsId = Number(voucher.hotelDetailsIds[i] || 0);

        this.logger.debug(`Processing voucher ${i}: routeId=${voucher.routeId}, routeDate=${routeDate}, hotelDetailsId=${hotelDetailsId}`);

        // Parse date - handle various formats
        let parsedDate: Date;
        if (!routeDate) {
          this.logger.warn(`Missing route date for voucher at index ${i}, skipping`);
          continue;
        }
        
        try {
          // Try parsing as ISO string first
          parsedDate = new Date(routeDate);
          if (isNaN(parsedDate.getTime())) {
            throw new Error('Invalid date');
          }
          this.logger.debug(`Parsed date: ${parsedDate.toISOString()}`);
        } catch (error) {
          this.logger.error(`Invalid date format: ${routeDate}, skipping voucher at index ${i}`);
          continue;
        }

        const created = await this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.create({
          data: {
            itinerary_plan_id: dto.itineraryPlanId,
            hotel_id: voucher.hotelId,
            itinerary_plan_hotel_details_ID: hotelDetailsId,
            itinerary_route_date: parsedDate,
            hotel_confirmed_by: voucher.confirmedBy,
            hotel_confirmed_email_id: voucher.emailId,
            hotel_confirmed_mobile_no: voucher.mobileNumber,
            invoice_to: invoiceToMap[voucher.invoiceTo] || 1,
            hotel_booking_status: statusMap[voucher.status] || 0,
            hotel_voucher_terms_condition: voucher.voucherTermsCondition,
            createdby: userId,
            createdon: new Date(),
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          },
        });

        createdVouchers.push({
          recordId: created.cnf_itinerary_plan_hotel_voucher_details_ID,
          routeId: Number(voucher.routeId),
          hotelDetailsId,
          status: voucher.status,
        });
      }

      // Collect route IDs that need cancellation
      if (voucher.status === 'cancelled') {
        routeIdsToCancel.add(voucher.routeId);
      }
    }

    // After all vouchers are created, cancel only the selected routes
    if (routeIdsToCancel.size > 0) {
      const routeIdsArray = Array.from(routeIdsToCancel);
      this.logger.log(
        `🚫 Cancelling selected route(s): ${routeIdsArray.join(',')} for itinerary ${dto.itineraryPlanId}`,
      );

      const reason = 'Hotel cancelled via voucher';

      // Cancel TBO bookings for selected routes
      try {
        const tboCancellationResults = await this.tboHotelBooking.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
          reason,
        );
        this.logger.log(`✅ TBO route cancellation completed: ${JSON.stringify(tboCancellationResults)}`);
      } catch (error) {
        this.logger.error(`❌ TBO route cancellation failed: ${error.message}`);
      }

      // Cancel ResAvenue bookings for selected routes
      try {
        const resavenueCancellationResults = await this.resavenueHotelBooking.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
          reason,
        );
        this.logger.log(`✅ ResAvenue route cancellation completed: ${JSON.stringify(resavenueCancellationResults)}`);
      } catch (error) {
        this.logger.error(`❌ ResAvenue route cancellation failed: ${error.message}`);
      }

      // Cancel HOBSE bookings for selected routes
      try {
        this.logger.log(`📤 HOBSE Cancellation Request: planId=${dto.itineraryPlanId}, routes=[${routeIdsArray.join(',')}]`);
        this.logger.debug(`HOBSE API Call Details: { planId: ${dto.itineraryPlanId}, routeIds: [${routeIdsArray.join(',')}], reason: '${reason}' }`);
        
        const hobseCancellationResults = await this.hobseHotelBooking.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
        );
        
        this.logger.log(`📥 HOBSE Cancellation Response: ${JSON.stringify(hobseCancellationResults)}`);
        this.logger.log(`✅ HOBSE route cancellation completed: ${hobseCancellationResults.successCount}/${hobseCancellationResults.totalBookings} successful`);
      } catch (error) {
        this.logger.error(`❌ HOBSE route cancellation failed: ${error.message}`);
        this.logger.error(`HOBSE Error Details: ${JSON.stringify(error.response?.data || error)}`);
      }

      // Cancel AxisRooms bookings for selected routes
      try {
        const axisCancellation = await this.axisroomsBookingPushService.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
        );
        this.logger.log(`✅ AxisRooms route cancellation completed: ${JSON.stringify(axisCancellation)}`);
      } catch (error) {
        this.logger.error(`❌ AxisRooms route cancellation failed: ${error.message}`);
      }

      // Cancel STAAH bookings for selected routes
      try {
        const staahCancellation = await this.staahBookingPushService.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
        );
        this.logger.log(`✅ STAAH route cancellation completed: ${JSON.stringify(staahCancellation)}`);
      } catch (error) {
        this.logger.error(`❌ STAAH route cancellation failed: ${error.message}`);
      }

      // Update voucher cancellation status in database only for cancelled routes
      const cancelledVoucherRecords = createdVouchers.filter((v) => routeIdsArray.includes(Number(v.routeId)));
      for (const voucherRecord of cancelledVoucherRecords) {
        await this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.update({
          where: {
            cnf_itinerary_plan_hotel_voucher_details_ID: voucherRecord.recordId,
          },
          data: {
            hotel_voucher_cancellation_status: 1,
            updatedon: new Date(),
          },
        });
      }

      await this.prisma.dvi_itinerary_plan_hotel_details.updateMany({
        where: {
          itinerary_plan_id: dto.itineraryPlanId,
          itinerary_route_id: { in: routeIdsArray } as any,
          deleted: 0,
        } as any,
        data: {
          hotel_cancellation_status: 1,
          updatedon: new Date(),
        } as any,
      });
    }

    return {
      success: true,
      message: `Successfully created ${createdVouchers.length} hotel voucher(s)`,
    };
  }

  /**
   * Cancel itinerary hotels in bulk or individually by selected routes/hotel detail ids
   */
  async cancelHotelsForItinerary(
    itineraryPlanId: number,
    dto: CancelHotelVouchersDto,
    userId: number = 1,
  ) {
    const reason = String(dto.reason || '').trim();
    if (!reason) {
      throw new BadRequestException('Cancellation reason is required');
    }

    const routeIds = Array.isArray(dto.route_ids)
      ? dto.route_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const hotelDetailsIds = Array.isArray(dto.hotel_details_ids)
      ? dto.hotel_details_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : [];

    if (!dto.cancel_all && routeIds.length === 0 && hotelDetailsIds.length === 0) {
      throw new BadRequestException('Provide route_ids or hotel_details_ids, or set cancel_all=true');
    }

    const where: any = {
      itinerary_plan_id: itineraryPlanId,
      deleted: 0,
    };

    if (!dto.cancel_all) {
      const OR: any[] = [];
      if (routeIds.length > 0) OR.push({ itinerary_route_id: { in: routeIds } as any });
      if (hotelDetailsIds.length > 0) OR.push({ itinerary_plan_hotel_details_ID: { in: hotelDetailsIds } as any });
      where.OR = OR;
    }

    const targetHotels = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: where as any,
      select: {
        itinerary_plan_hotel_details_ID: true,
        itinerary_route_id: true,
        hotel_id: true,
      } as any,
    });

    if (!targetHotels.length) {
      throw new NotFoundException('No matching hotels found for cancellation');
    }

    const targetHotelDetailIds = Array.from(
      new Set(targetHotels.map((h: any) => Number(h.itinerary_plan_hotel_details_ID)).filter((id) => id > 0)),
    );
    const targetRouteIds = Array.from(
      new Set(targetHotels.map((h: any) => Number(h.itinerary_route_id)).filter((id) => id > 0)),
    );

    const providerResults: Record<string, any> = {
      tbo: null,
      resavenue: null,
      hobse: null,
      axisrooms: null,
      staah: null,
    };

    // Provider cancellations should not block DB status updates for operational consistency.
    try {
      providerResults.tbo = await this.tboHotelBooking.cancelItineraryHotelsByRoutes(
        itineraryPlanId,
        targetRouteIds,
        reason,
      );
    } catch (error: any) {
      this.logger.error(`TBO scoped cancellation failed: ${error?.message || error}`);
      providerResults.tbo = { error: error?.message || 'Cancellation failed' };
    }

    try {
      providerResults.resavenue = await this.resavenueHotelBooking.cancelItineraryHotelsByRoutes(
        itineraryPlanId,
        targetRouteIds,
        reason,
      );
    } catch (error: any) {
      this.logger.error(`ResAvenue scoped cancellation failed: ${error?.message || error}`);
      providerResults.resavenue = { error: error?.message || 'Cancellation failed' };
    }

    try {
      providerResults.hobse = await this.hobseHotelBooking.cancelItineraryHotelsByRoutes(
        itineraryPlanId,
        targetRouteIds,
      );
    } catch (error: any) {
      this.logger.error(`HOBSE scoped cancellation failed: ${error?.message || error}`);
      providerResults.hobse = { error: error?.message || 'Cancellation failed' };
    }

      try {
        providerResults.axisrooms = await this.axisroomsBookingPushService.cancelItineraryHotelsByRoutes(
          itineraryPlanId,
          targetRouteIds,
        );
      } catch (error: any) {
        this.logger.error(`AxisRooms scoped cancellation failed: ${error?.message || error}`);
        providerResults.axisrooms = { error: error?.message || 'Cancellation failed' };
      }

      try {
        providerResults.staah = await this.staahBookingPushService.cancelItineraryHotelsByRoutes(
          itineraryPlanId,
          targetRouteIds,
        );
      } catch (error: any) {
        this.logger.error(`STAAH scoped cancellation failed: ${error?.message || error}`);
        providerResults.staah = { error: error?.message || 'Cancellation failed' };
      }

    await this.prisma.dvi_itinerary_plan_hotel_details.updateMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        itinerary_plan_hotel_details_ID: { in: targetHotelDetailIds } as any,
        deleted: 0,
      } as any,
      data: {
        hotel_cancellation_status: 1,
        updatedon: new Date(),
      } as any,
    });

    await this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.updateMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        itinerary_plan_hotel_details_ID: { in: targetHotelDetailIds } as any,
        deleted: 0,
      } as any,
      data: {
        hotel_voucher_cancellation_status: 1,
        updatedon: new Date(),
      } as any,
    });

    return {
      success: true,
      message: 'Hotel cancellation processed',
      data: {
        itineraryPlanId,
        cancelledHotels: targetHotelDetailIds.length,
        cancelledRoutes: targetRouteIds.length,
        cancelledHotelDetailIds: targetHotelDetailIds,
        cancelledRouteIds: targetRouteIds,
        cancelledBy: userId,
        reason,
        providerResults,
      },
    };
  }

  /**
   * Get default voucher terms from global settings
   */
  async getDefaultVoucherTerms(): Promise<string> {
    const settings = await this.prisma.dvi_global_settings.findFirst({
      where: { status: 1 },
    });

    return (
      settings?.hotel_voucher_terms_condition ||
      'Standard hotel voucher terms and conditions apply.'
    );
  }
}
