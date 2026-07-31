import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { TboHotelBookingService } from './services/tbo-hotel-booking.service';
import { ResAvenueHotelBookingService } from './services/resavenue-hotel-booking.service';
import { HobseHotelBookingService } from './services/hobse-hotel-booking.service';
import { AxisRoomsBookingPushService } from './services/axisrooms-booking-push.service';
import { StaahBookingPushService } from './services/staah-booking-push.service';
import { CancelHotelVouchersDto } from './dto/cancel-hotel-vouchers.dto';
import { ItineraryHotelApprovalService } from './services/itinerary-hotel-approval.service';

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

export interface ProviderCancellationResult {
  provider: string;
  attempted: boolean;
  success: boolean;
  skipped?: boolean;
  routeId?: number;
  hotelId?: number;
  hotelCode?: string | null;
  bookingId?: string | null;
  httpStatus?: number | null;
  responseBody?: any;
  error?: string | null;
  reason?: string | null;
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
    private hotelApprovalService: ItineraryHotelApprovalService,
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
    const selectionIds = dto.vouchers.flatMap((voucher) => voucher.hotelDetailsIds || []).map(Number).filter((id) => id > 0);
    const selectionModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    if (selectionIds.length === 0 && selectionModel?.findMany) {
      const resolvedRows = await selectionModel.findMany({
        where: {
          itinerary_plan_id: Number(dto.itineraryPlanId),
          deleted: 0,
          OR: dto.vouchers.flatMap((voucher) => [
            { itinerary_route_id: Number(voucher.routeId || 0) },
            { hotel_id: Number(voucher.hotelId || 0) },
          ]),
        },
        select: { itinerary_plan_hotel_details_ID: true },
      });
      selectionIds.push(...resolvedRows.map((row: any) => Number(row.itinerary_plan_hotel_details_ID)).filter((id: number) => id > 0));
    }
    await this.hotelApprovalService.assertSelectionsCanCreateVoucher(selectionIds);
 this.logger.debug(`Voucher data: ${JSON.stringify(dto.vouchers, null, 2)}`);
 this.logger.log(
      `[HOTEL_VOUCHER_CREATE_REQUEST] ${JSON.stringify({
        itineraryPlanId: dto.itineraryPlanId,
        voucherCount: dto.vouchers.length,
        vouchers: dto.vouchers.map((voucher) => ({
          routeId: Number(voucher.routeId || 0),
          hotelId: Number(voucher.hotelId || 0),
          hotelDetailsIds: Array.isArray(voucher.hotelDetailsIds)
            ? voucher.hotelDetailsIds.map((id) => Number(id || 0)).filter((id) => id > 0)
            : [],
          routeDates: Array.isArray(voucher.routeDates) ? voucher.routeDates : [],
          status: String(voucher.status || ''),
        })),
      })}`,
    );

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
    const hotelDetailsIdsToCancel = new Set<number>();
    const staahTargetsToCancel = new Map<string, { routeId: number; hotelId: number | null }>();
    const providerCancellation: ProviderCancellationResult[] = [];

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
        (voucher.hotelDetailsIds || [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
          .forEach((id) => hotelDetailsIdsToCancel.add(id));
        const routeId = Number(voucher.routeId || 0);
        const hotelId = Number(voucher.hotelId || 0);
        if (routeId > 0) {
          staahTargetsToCancel.set(`${routeId}:${hotelId > 0 ? hotelId : 0}`, {
            routeId,
            hotelId: hotelId > 0 ? hotelId : null,
          });
        }
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
 this.logger.log(` TBO route cancellation completed: ${JSON.stringify(tboCancellationResults)}`);
      } catch (error) {
 this.logger.error(` TBO route cancellation failed: ${error.message}`);
      }

 // Cancel ResAvenue bookings for selected routes
      try {
        const resavenueCancellationResults = await this.resavenueHotelBooking.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
          reason,
        );
 this.logger.log(` ResAvenue route cancellation completed: ${JSON.stringify(resavenueCancellationResults)}`);
      } catch (error) {
 this.logger.error(` ResAvenue route cancellation failed: ${error.message}`);
      }

 // Cancel HOBSE bookings for selected routes
      try {
 this.logger.log(` HOBSE Cancellation Request: planId=${dto.itineraryPlanId}, routes=[${routeIdsArray.join(',')}]`);
 this.logger.debug(`HOBSE API Call Details: { planId: ${dto.itineraryPlanId}, routeIds: [${routeIdsArray.join(',')}], reason: '${reason}' }`);

        const hobseCancellationResults = await this.hobseHotelBooking.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
        );

 this.logger.log(` HOBSE Cancellation Response: ${JSON.stringify(hobseCancellationResults)}`);
 this.logger.log(` HOBSE route cancellation completed: ${hobseCancellationResults.successCount}/${hobseCancellationResults.totalBookings} successful`);
      } catch (error) {
 this.logger.error(` HOBSE route cancellation failed: ${error.message}`);
 this.logger.error(`HOBSE Error Details: ${JSON.stringify(error.response?.data || error)}`);
      }

 // Cancel AxisRooms bookings for selected routes
      try {
        const axisCancellation = await this.axisroomsBookingPushService.cancelItineraryHotelsByRoutes(
          dto.itineraryPlanId,
          routeIdsArray,
        );
 this.logger.log(` AxisRooms route cancellation completed: ${JSON.stringify(axisCancellation)}`);
      } catch (error) {
 this.logger.error(` AxisRooms route cancellation failed: ${error.message}`);
      }

 // Cancel STAAH bookings only for selected (routeId, hotelId) voucher targets
      if (staahTargetsToCancel.size > 0) {
        for (const target of staahTargetsToCancel.values()) {
          try {
            const staahCancellation = await this.staahBookingPushService.cancelVoucherHotel({
              itineraryPlanId: dto.itineraryPlanId,
              routeId: target.routeId,
              hotelId: target.hotelId,
            });
            providerCancellation.push({
              provider: 'staah',
              attempted: !!staahCancellation?.attempted || !staahCancellation?.skipped,
              skipped: !!staahCancellation?.skipped,
              success: !!staahCancellation?.success,
              routeId: target.routeId,
              hotelId: target.hotelId ?? undefined,
              hotelCode: staahCancellation?.hotelCode ?? null,
              bookingId: staahCancellation?.bookingReference ?? staahCancellation?.bookingId ?? null,
              httpStatus: staahCancellation?.status ?? null,
              responseBody: staahCancellation?.response ?? null,
              error: staahCancellation?.error ?? null,
              reason: staahCancellation?.reason ?? null,
            });
 this.logger.log(
              `✅ STAAH voucher cancellation completed for route=${target.routeId}, hotel=${target.hotelId}: ${JSON.stringify(staahCancellation)}`,
            );
 this.logger.log(
              `[HOTEL_VOUCHER_STAAH_CANCEL_RESULT] ${JSON.stringify({
                itineraryPlanId: dto.itineraryPlanId,
                routeId: target.routeId,
                hotelId: target.hotelId,
                result: staahCancellation,
              })}`,
            );
          } catch (error: any) {
            providerCancellation.push({
              provider: 'staah',
              attempted: true,
              success: false,
              routeId: target.routeId,
              hotelId: target.hotelId ?? undefined,
              error: error?.message || String(error),
            });
 this.logger.error(
              `❌ STAAH voucher cancellation failed for route=${target.routeId}, hotel=${target.hotelId}: ${error?.message || error}`,
            );
          }
        }
      } else {
 this.logger.log('[STAAH_CANCEL_PUSH] No active STAAH confirmation found');
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

      const cancelledHotelDetailIds = Array.from(hotelDetailsIdsToCancel);

      if (cancelledHotelDetailIds.length > 0) {
        await this.prisma.dvi_itinerary_plan_hotel_details.updateMany({
          where: {
            itinerary_plan_id: dto.itineraryPlanId,
            itinerary_plan_hotel_details_ID: { in: cancelledHotelDetailIds } as any,
            deleted: 0,
          } as any,
          data: {
            hotel_cancellation_status: 1,
            updatedon: new Date(),
          } as any,
        });

        await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.updateMany({
          where: {
            itinerary_plan_id: dto.itineraryPlanId,
            itinerary_plan_hotel_details_ID: { in: cancelledHotelDetailIds } as any,
            deleted: 0,
          } as any,
          data: {
            hotel_cancellation_status: 1,
            updatedon: new Date(),
          } as any,
        });
      } else {
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

        await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.updateMany({
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
    }

    return {
      success: true,
      message: `Successfully created ${createdVouchers.length} hotel voucher(s)`,
      providerCancellation,
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

 this.logger.log(
      `[HOTEL_CANCEL_REQUEST_RECEIVED] ${JSON.stringify({
        itineraryPlanId,
        reason,
        routeIds,
        hotelDetailsIds,
        cancelAll: !!dto.cancel_all,
      })}`,
    );

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
        hotel_provider: true,
        hotel_booking_mode: true,
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
    const supplierTargetRouteIds = Array.from(
      new Set(
        targetHotels
          .filter((hotel: any) => {
            const provider = String(hotel.hotel_provider || '').trim().toLowerCase();
            const bookingMode = String(hotel.hotel_booking_mode || '').trim().toUpperCase();
            return provider !== 'offline' && bookingMode !== 'MANUAL_APPROVAL';
          })
          .map((hotel: any) => Number(hotel.itinerary_route_id))
          .filter((id) => id > 0),
      ),
    );

 this.logger.log(
      `[HOTEL_CANCEL_TARGET_ROWS_RESOLVED] ${JSON.stringify({
        itineraryPlanId,
        targetRouteIds,
        supplierTargetRouteIds,
        targetHotelDetailIds,
        targetHotels,
      })}`,
    );

    const providerResults: Record<string, any> = {
      tbo: null,
      resavenue: null,
      hobse: null,
      axisrooms: null,
      staah: null,
    };

 // Provider cancellations should not block DB status updates for operational consistency.
    if (supplierTargetRouteIds.length > 0) {
    try {
      providerResults.tbo = await this.tboHotelBooking.cancelItineraryHotelsByRoutes(
        itineraryPlanId,
        supplierTargetRouteIds,
        reason,
      );
    } catch (error: any) {
 this.logger.error(`TBO scoped cancellation failed: ${error?.message || error}`);
      providerResults.tbo = { error: error?.message || 'Cancellation failed' };
    }

    try {
      providerResults.resavenue = await this.resavenueHotelBooking.cancelItineraryHotelsByRoutes(
        itineraryPlanId,
        supplierTargetRouteIds,
        reason,
      );
    } catch (error: any) {
 this.logger.error(`ResAvenue scoped cancellation failed: ${error?.message || error}`);
      providerResults.resavenue = { error: error?.message || 'Cancellation failed' };
    }

    try {
      providerResults.hobse = await this.hobseHotelBooking.cancelItineraryHotelsByRoutes(
        itineraryPlanId,
        supplierTargetRouteIds,
      );
    } catch (error: any) {
 this.logger.error(`HOBSE scoped cancellation failed: ${error?.message || error}`);
      providerResults.hobse = { error: error?.message || 'Cancellation failed' };
    }

      try {
        providerResults.axisrooms = await this.axisroomsBookingPushService.cancelItineraryHotelsByRoutes(
          itineraryPlanId,
          supplierTargetRouteIds,
        );
      } catch (error: any) {
 this.logger.error(`AxisRooms scoped cancellation failed: ${error?.message || error}`);
        providerResults.axisrooms = { error: error?.message || 'Cancellation failed' };
      }

      try {
        providerResults.staah = await this.staahBookingPushService.cancelItineraryHotelsByRoutes(
        itineraryPlanId,
        supplierTargetRouteIds,
        );
      } catch (error: any) {
 this.logger.error(`STAAH scoped cancellation failed: ${error?.message || error}`);
      providerResults.staah = { error: error?.message || 'Cancellation failed' };
      }
    } else {
      providerResults.tbo = { skipped: true, reason: 'No supplier-bookable hotel targets' };
      providerResults.resavenue = { skipped: true, reason: 'No supplier-bookable hotel targets' };
      providerResults.hobse = { skipped: true, reason: 'No supplier-bookable hotel targets' };
      providerResults.axisrooms = { skipped: true, reason: 'No supplier-bookable hotel targets' };
      providerResults.staah = { skipped: true, reason: 'No supplier-bookable hotel targets' };
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

    await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.updateMany({
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
