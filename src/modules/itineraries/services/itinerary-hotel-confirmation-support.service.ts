// FILE: src/modules/itineraries/services/itinerary-hotel-confirmation-support.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { ConfirmQuotationDto } from '../dto/confirm-quotation.dto';
import { ItineraryDetailsService } from '../itinerary-details.service';

type HotelConfirmationSupportCallbacks = Partial<Record<
  'mergeConsecutiveSupplierHotelBookings'
  | 'pruneHotelBookingsCoveredByMultiNight'
  | 'getProviderBookableHotelBookings'
  | 'getConfirmHotelGroupType'
  | 'uniquePositiveNumbers'
  | 'bookingKey'
  | 'assertConsistentMultiNightHotelSelection'
  | 'getAgentWalletBalance',
  (...args: any[]) => any
>>;


@Injectable()
export class ItineraryHotelConfirmationSupportService {
  private callbacks: HotelConfirmationSupportCallbacks = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly itineraryDetails: ItineraryDetailsService,
  ) {}

  setCallbacks(callbacks: HotelConfirmationSupportCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private call(name: keyof HotelConfirmationSupportCallbacks, ...args: any[]) {
    const callback = this.callbacks[name];
    if (!callback) {
      throw new Error(`Hotel confirmation support callback is not configured: ${String(name)}`);
    }
    return callback(...args);
  }

  private mergeConsecutiveSupplierHotelBookings(...args: any[]) { return this.call('mergeConsecutiveSupplierHotelBookings', ...args); }
  private pruneHotelBookingsCoveredByMultiNight(...args: any[]) { return this.call('pruneHotelBookingsCoveredByMultiNight', ...args); }
  private getProviderBookableHotelBookings(...args: any[]) { return this.call('getProviderBookableHotelBookings', ...args); }
  private getConfirmHotelGroupType(...args: any[]) { return this.call('getConfirmHotelGroupType', ...args); }
  private uniquePositiveNumbers(...args: any[]) { return this.call('uniquePositiveNumbers', ...args); }
  private bookingKey(...args: any[]) { return this.call('bookingKey', ...args); }
  private assertConsistentMultiNightHotelSelection(...args: any[]) { return this.call('assertConsistentMultiNightHotelSelection', ...args); }
  private getAgentWalletBalance(...args: any[]) { return this.call('getAgentWalletBalance', ...args); }

  async syncSelectedHotelDraftRowsForConfirmation(
    dto: ConfirmQuotationDto,
    userId: number,
  ): Promise<{
    providerHotelBookings: any[];
    selectedRouteIds: number[];
    externalRouteIds: number[];
    groupType: number;
    skippedExternalStayCount: number;
  }> {
 console.debug(
      `[CONFIRM_HOTELS] incoming hotel_bookings count=${dto.hotel_bookings?.length || 0}`,
    );
    const incomingHotelBookings = this.pruneHotelBookingsCoveredByMultiNight(
      this.mergeConsecutiveSupplierHotelBookings(dto.hotel_bookings || []),
    );
    (dto as any).hotel_bookings = incomingHotelBookings;
    const providerHotelBookings = this.getProviderBookableHotelBookings(incomingHotelBookings);
    const manualApprovalHotelBookings = incomingHotelBookings.filter((hotel: any) => {
      const provider = String(hotel?.provider || '').trim().toLowerCase();
      const bookingMode = String(hotel?.bookingMode || '').trim().toUpperCase();
      return provider === 'offline' || hotel?.requiresHotelApproval === true || bookingMode === 'MANUAL_APPROVAL';
    });
    const groupType = this.getConfirmHotelGroupType(dto);
 console.debug(
      `[CONFIRM_HOTELS] normalized hotel_bookings count=${incomingHotelBookings.length}`,
    );

    this.assertConsistentMultiNightHotelSelection(providerHotelBookings);

 // Confirmation must use the same backend-selected rate snapshot as the
 // draft preview. Monetary values sent by the browser are deliberately not
 // trusted for persistence or wallet calculations.
    const authoritativePreview = providerHotelBookings.length > 0
      ? await this.itineraryDetails.previewHotelSelectionCost({
          planId: dto.itinerary_plan_ID,
          selections: providerHotelBookings,
          groupType: this.getConfirmHotelGroupType(dto),
        })
      : null;
    const authoritativePricingByRoute = new Map<number, any>(
      (authoritativePreview?.selectedHotelBreakdown || []).map((row: any) => [
        Number(row.routeId || 0),
        row,
      ]),
    );

    const manualMismatchOverrideRows = providerHotelBookings.filter((booking: any) =>
      Boolean(booking?.manualRoomMealMismatchOverride),
    );

    if (manualMismatchOverrideRows.length > 0) {
 console.warn('[CONFIRM_QUOTATION_MANUAL_ROOM_MEAL_MISMATCH_OVERRIDE]', {
        planId: dto.itinerary_plan_ID,
        count: manualMismatchOverrideRows.length,
        rows: manualMismatchOverrideRows.map((booking: any) => ({
          routeId: booking?.routeId,
          provider: booking?.provider,
          hotelCode: booking?.hotelCode,
          hotelName: booking?.hotelName,
          roomId: booking?.roomId,
          rateId: booking?.rateId,
          roomType: booking?.roomType,
          mealPlan: booking?.mealPlan,
        })),
      });
    }

    const selectedRouteIds = this.uniquePositiveNumbers([
      ...((dto as any).selected_hotel_route_ids || []),
      ...providerHotelBookings.flatMap((hotel: any) => {
        const routeIds = Array.isArray(hotel?.routeIds) && hotel.routeIds.length > 0
          ? hotel.routeIds
          : [hotel?.routeId];

        return routeIds;
      }),
      ...manualApprovalHotelBookings.flatMap((hotel: any) => {
        const routeIds = Array.isArray(hotel?.routeIds) && hotel.routeIds.length > 0
          ? hotel.routeIds
          : [hotel?.routeId];

        return routeIds;
      }),
    ]);

    const externalRouteIds = this.uniquePositiveNumbers(
      (dto as any).external_stay_route_ids || [],
    ).filter((routeId) => !selectedRouteIds.includes(routeId));

    const skippedExternalStayCount =
      incomingHotelBookings.length - providerHotelBookings.length - manualApprovalHotelBookings.length;

    const explicitHotelStateProvided =
      selectedRouteIds.length > 0 ||
      externalRouteIds.length > 0 ||
      incomingHotelBookings.length > 0;

    if (explicitHotelStateProvided) {
      await this.prisma.dvi_itinerary_plan_hotel_details.updateMany({
        where: {
          itinerary_plan_id: dto.itinerary_plan_ID,
          deleted: 0,
          NOT: {
            group_type: groupType,
          },
        } as any,
        data: {
          deleted: 1,
          status: 0,
          updatedon: new Date(),
        } as any,
      });

      await this.prisma.dvi_itinerary_plan_hotel_room_details.updateMany({
        where: {
          itinerary_plan_id: dto.itinerary_plan_ID,
          deleted: 0,
          NOT: {
            group_type: groupType,
          },
        } as any,
        data: {
          deleted: 1,
          status: 0,
          updatedon: new Date(),
        } as any,
      });

      await this.prisma.dvi_itinerary_plan_hotel_room_amenities.updateMany({
        where: {
          itinerary_plan_id: dto.itinerary_plan_ID,
          deleted: 0,
          NOT: {
            group_type: groupType,
          },
        } as any,
        data: {
          deleted: 1,
          status: 0,
          updatedon: new Date(),
        } as any,
      });

      const staleWhere: any = {
        itinerary_plan_id: dto.itinerary_plan_ID,
        group_type: groupType,
        deleted: 0,
      };

      if (selectedRouteIds.length > 0) {
        staleWhere.itinerary_route_id = {
          notIn: selectedRouteIds,
        };
      } else if (externalRouteIds.length > 0) {
        staleWhere.itinerary_route_id = {
          in: externalRouteIds,
        };
      }

      if (selectedRouteIds.length > 0 || externalRouteIds.length > 0) {
        const staleHotelRows =
          await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
            where: staleWhere,
            select: {
              itinerary_plan_hotel_details_ID: true,
              itinerary_route_id: true,
            },
          });

        const staleHotelDetailsIds = this.uniquePositiveNumbers(
          staleHotelRows.map((row) => row.itinerary_plan_hotel_details_ID),
        );

        const staleRouteIds = this.uniquePositiveNumbers(
          staleHotelRows.map((row) => row.itinerary_route_id),
        );

        if (staleHotelDetailsIds.length > 0) {
          await this.prisma.dvi_itinerary_plan_hotel_details.updateMany({
            where: {
              itinerary_plan_hotel_details_ID: {
                in: staleHotelDetailsIds,
              },
            },
            data: {
              deleted: 1,
              status: 0,
              updatedon: new Date(),
            },
          });
        }

        if (staleHotelDetailsIds.length > 0 || staleRouteIds.length > 0) {
          await this.prisma.dvi_itinerary_plan_hotel_room_details.updateMany({
            where: {
              itinerary_plan_id: dto.itinerary_plan_ID,
              group_type: groupType,
              deleted: 0,
              OR: [
                ...(staleHotelDetailsIds.length > 0
                  ? [
                      {
                        itinerary_plan_hotel_details_id: {
                          in: staleHotelDetailsIds,
                        },
                      },
                    ]
                  : []),
                ...(staleRouteIds.length > 0
                  ? [
                      {
                        itinerary_route_id: {
                          in: staleRouteIds,
                        },
                      },
                    ]
                  : []),
              ],
            } as any,
            data: {
              deleted: 1,
              status: 0,
              updatedon: new Date(),
            } as any,
          });

          await this.prisma.dvi_itinerary_plan_hotel_room_amenities.updateMany({
            where: {
              itinerary_plan_id: dto.itinerary_plan_ID,
              group_type: groupType,
              deleted: 0,
              OR: [
                ...(staleHotelDetailsIds.length > 0
                  ? [
                      {
                        itinerary_plan_hotel_details_id: {
                          in: staleHotelDetailsIds,
                        },
                      },
                    ]
                  : []),
                ...(staleRouteIds.length > 0
                  ? [
                      {
                        itinerary_route_id: {
                          in: staleRouteIds,
                        },
                      },
                    ]
                  : []),
              ],
            } as any,
            data: {
              deleted: 1,
              status: 0,
              updatedon: new Date(),
            } as any,
          });
        }

 console.log('[CONFIRM_HOTEL_STALE_ROWS_DEACTIVATED]', {
          planId: dto.itinerary_plan_ID,
          groupType,
          selectedRouteIds,
          externalRouteIds,
          staleHotelDetailsIds,
          staleRouteIds,
        });
      }
    }

    const getNextDateOnly = (date: string): string => {
      const raw = String(date || '').trim();

      if (!raw) {
        return '';
      }

      const parsed = new Date(`${raw}T00:00:00.000Z`);

      if (Number.isNaN(parsed.getTime())) {
        return '';
      }

      parsed.setUTCDate(parsed.getUTCDate() + 1);
      return parsed.toISOString().slice(0, 10);
    };

    const selectedHotelBookingsForDraft = [
      ...providerHotelBookings,
      ...manualApprovalHotelBookings.filter((booking: any) => !providerHotelBookings.includes(booking)),
    ];

    const expandedDraftBookings = selectedHotelBookingsForDraft.flatMap((booking: any) => {
      const isMultiNightBooking = Boolean(booking?.multiNightBooking);

      const routeIds = isMultiNightBooking && Array.isArray(booking?.routeIds) && booking.routeIds.length > 0
        ? this.uniquePositiveNumbers(booking.routeIds)
        : this.uniquePositiveNumbers([booking?.routeId]);

      if (routeIds.length <= 1) {
        return [booking];
      }

      const nightlyRates = Array.isArray(booking?.nightlyRates)
        ? booking.nightlyRates
        : [];

      const fallbackTotal = Number(
        booking?.totalAmountAfterTax ??
          booking?.netAmount ??
          booking?.totalAmount ??
          booking?.totalHotelCost ??
          0,
      );

      const fallbackPerNight =
        routeIds.length > 0 && fallbackTotal > 0
          ? fallbackTotal / routeIds.length
          : fallbackTotal;

      return routeIds.map((routeId: number, index: number) => {
        const nightlyRate = nightlyRates[index];
        const checkInDate = String(
          nightlyRate?.date ||
            booking?.checkInDate ||
            '',
        ).trim();

        const amountAfterTax = Number(
          nightlyRate?.amountAfterTax ??
            nightlyRate?.baseAmount ??
            fallbackPerNight ??
            0,
        );

        return {
          ...booking,
          routeId,
          checkInDate,
          checkOutDate: getNextDateOnly(checkInDate),
          netAmount: amountAfterTax,
          totalAmount: amountAfterTax,
          totalHotelCost: amountAfterTax,
          totalAmountAfterTax: amountAfterTax,
          roomId: String(booking?.roomId || '').trim() || undefined,
          rateId: String(booking?.rateId || '').trim() || undefined,
          roomType: String(booking?.roomType || '').trim() || undefined,
          mealPlan: String(booking?.mealPlan || '').trim() || undefined,
          multiNightBooking: true,
          multiNightParentRouteId: Number(booking?.routeId || 0),
          routeIds,
          stayKey: booking?.stayKey,
        };
      });
    });

    for (const booking of expandedDraftBookings) {
      const normalizedProvider = String((booking as any).provider || '')
        .trim()
        .toLowerCase();
      const isManualApproval = normalizedProvider === 'offline' ||
        Boolean((booking as any).requiresHotelApproval) ||
        String((booking as any).bookingMode || '').trim().toUpperCase() === 'MANUAL_APPROVAL';

      const hotelCodeRaw = String((booking as any).hotelCode || '').trim();
      const providerUsesHotelCodeOnly = new Set([
        'tbo',
        'hobse',
        'resavenue',
        'axisrooms',
        'staah',
      ]);

      const shouldUseHotelCodeOnly =
        providerUsesHotelCodeOnly.has(normalizedProvider) || !hotelCodeRaw;
      const parsedHotelId = Number(hotelCodeRaw);
      const hotelId = shouldUseHotelCodeOnly
        ? 0
        : Number.isFinite(parsedHotelId) && parsedHotelId > 0
          ? parsedHotelId
          : 0;
      const hotelCodeForSave = shouldUseHotelCodeOnly ? hotelCodeRaw : null;

      let bookingAmount = Number(
        (booking as any).prebookContext?.prebookNetAmount ??
          (booking as any).prebookContext?.finalPrice ??
          (booking as any).netAmount ??
          (booking as any).totalAmount ??
          (booking as any).totalHotelCost ??
          0,
      );

      let bookingTaxAmount = Number(
        (booking as any).totalHotelTaxAmount ??
          (booking as any).taxAmount ??
          0,
      );

      const bookingRoomCount = Math.max(
        Number((booking as any).numberOfRooms ?? (booking as any).noOfRooms ?? 1),
        1,
      );

      const routeId = Number((booking as any).routeId || 0);
      if (!routeId) {
        continue;
      }

      const authoritativeRate = authoritativePricingByRoute.get(routeId);
      if (providerHotelBookings.length > 0 && !isManualApproval && !authoritativeRate) {
        throw new BadRequestException(`Selected hotel rate could not be revalidated for route ${routeId}`);
      }
      if (authoritativeRate) {
        const authoritativeTax = Number(authoritativeRate.roomGstAmount || 0)
          + Number(authoritativeRate.marginGstAmount || 0);
        bookingTaxAmount = Number(authoritativeTax.toFixed(2));
        bookingAmount = Number(
          Math.max(0, Number(authoritativeRate.totalAmount || 0) - authoritativeTax).toFixed(2),
        );
      }

      const route = await this.prisma.dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_plan_ID: dto.itinerary_plan_ID,
          itinerary_route_ID: routeId,
          deleted: 0,
        },
        select: {
          itinerary_route_date: true,
          location_name: true,
          next_visiting_location: true,
        },
      });

      const existing =
        await this.prisma.dvi_itinerary_plan_hotel_details.findFirst({
          where: {
            itinerary_plan_id: dto.itinerary_plan_ID,
            itinerary_route_id: routeId,
            group_type: groupType,
            hotel_required: { not: 2 },
            deleted: 0,
          } as any,
          orderBy: {
            itinerary_plan_hotel_details_ID: 'desc',
          } as any,
        });

      let selectedDraftHotelDetailsId = 0;

      const saveData: any = {
        group_type: groupType,
        itinerary_route_date: route?.itinerary_route_date || undefined,
        itinerary_route_location:
          route?.next_visiting_location || route?.location_name || undefined,
        total_hotel_cost: bookingAmount,
        total_hotel_tax_amount: bookingTaxAmount,
        total_room_cost: authoritativeRate
          ? Number(authoritativeRate.baseAmount || 0)
          : undefined,
        total_room_gst_amount: authoritativeRate
          ? Number(authoritativeRate.roomGstAmount || 0)
          : undefined,
        hotel_margin_rate: authoritativeRate
          ? Number(authoritativeRate.marginAmount || 0)
          : undefined,
        hotel_margin_rate_tax_amt: authoritativeRate
          ? Number(authoritativeRate.marginGstAmount || 0)
          : undefined,
        total_hotel_meal_plan_cost: 0,
        total_hotel_meal_plan_cost_gst_amount: 0,
        total_amenities_cost: 0,
        total_extra_bed_cost: 0,
        total_childwith_bed_cost: 0,
        total_childwithout_bed_cost: 0,
        total_no_of_rooms: bookingRoomCount,
        hotel_id: hotelId,
        hotel_code: hotelCodeForSave,
        hotel_provider: normalizedProvider || null,
        hotel_booking_mode: isManualApproval ? 'MANUAL_APPROVAL' : 'LIVE_API',
        price_source: isManualApproval ? String((booking as any).priceSource || 'DATABASE') : String((booking as any).priceSource || 'LIVE_API'),
        is_live_rate: !isManualApproval,
        selected_rate_option_id: (booking as any).selectedRateOptionId || (booking as any).rateOptionId || null,
        selected_price_per_night: (booking as any).selectedPricePerNight || (booking as any).pricePerNight || null,
        selected_total_price: (booking as any).selectedTotalPrice || (booking as any).totalStayPrice || bookingAmount,
        selected_currency: (booking as any).selectedCurrency || (booking as any).currency || 'INR',
        selected_price_snapshot: (booking as any).selectedPriceSnapshot || null,
        hotel_approval_status: isManualApproval
          ? existing?.hotel_approval_status || (booking as any).approvalStatus || 'PENDING_APPROVAL'
          : 'NOT_REQUIRED',
        hotel_approval_requested_at: isManualApproval
          ? existing?.hotel_approval_requested_at || new Date()
          : null,
        hotel_approval_requested_by: isManualApproval
          ? existing?.hotel_approval_requested_by || userId
          : null,
        manual_confirmation_status: isManualApproval
          ? existing?.manual_confirmation_status || (booking as any).manualConfirmationStatus || 'NOT_STARTED'
          : 'NOT_STARTED',
        hotel_required: 1,
        status: 1,
        deleted: 0,
        updatedon: new Date(),
      };

      if (existing) {
        const updated =
          await this.prisma.dvi_itinerary_plan_hotel_details.update({
            where: {
              itinerary_plan_hotel_details_ID:
                existing.itinerary_plan_hotel_details_ID,
            },
            data: saveData,
          });

        selectedDraftHotelDetailsId = Number(
          (updated as any).itinerary_plan_hotel_details_ID || 0,
        );
      } else {
        const created =
          await this.prisma.dvi_itinerary_plan_hotel_details.create({
            data: {
              itinerary_plan_id: dto.itinerary_plan_ID,
              itinerary_route_id: routeId,
              createdby: userId,
              createdon: new Date(),
              ...saveData,
            },
          });

        selectedDraftHotelDetailsId = Number(
          (created as any).itinerary_plan_hotel_details_ID || 0,
        );
      }

      await this.prisma.dvi_itinerary_plan_hotel_details.updateMany({
        where: {
          itinerary_plan_id: dto.itinerary_plan_ID,
          itinerary_route_id: routeId,
          group_type: groupType,
          deleted: 0,
          NOT: {
            itinerary_plan_hotel_details_ID: selectedDraftHotelDetailsId,
          },
        } as any,
        data: {
          deleted: 1,
          status: 0,
          updatedon: new Date(),
        } as any,
      });

 console.log('[CONFIRM_SELECTED_HOTEL_DRAFT_SYNCED]', {
        planId: dto.itinerary_plan_ID,
        routeId,
        provider: normalizedProvider,
        hotelId,
        hotelCode: hotelCodeForSave,
        hotelName: (booking as any).hotelName,
        roomType: (booking as any).roomType,
        mealPlan: (booking as any).mealPlan,
        checkInDate: (booking as any).checkInDate,
        checkOutDate: (booking as any).checkOutDate,
        bookingAmount,
        groupType,
        multiNightBooking: Boolean((booking as any).multiNightBooking),
        stayKey: (booking as any).stayKey,
        routeIds: (booking as any).routeIds,
      });
    }

    return {
      providerHotelBookings,
      selectedRouteIds,
      externalRouteIds,
      groupType,
      skippedExternalStayCount,
    };
  }

  async finalizeConfirmationFinancials(baseResult: any, dto: ConfirmQuotationDto, userId: number): Promise<void> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: baseResult.itinerary_plan_ID },
    });
    if (!plan?.itinerary_quote_ID) {
      throw new BadRequestException('Quote ID not found while finalizing confirmation financials');
    }

    const details = await this.itineraryDetails.getItineraryDetails(plan.itinerary_quote_ID);
    const cost = details.costBreakdown;
    const debitAmount = Number(cost?.netPayable || 0);
    const walletInfo = await this.getAgentWalletBalance(dto.agent);

    await this.prisma.$transaction(async (tx) => {
      const existingDebit = await tx.dvi_cash_wallet.findFirst({
        where: {
          transaction_id: plan.itinerary_quote_ID,
          transaction_type: 2,
          deleted: 0,
        },
      });

      if (!existingDebit) {
        const currentAgentWallet = await tx.dvi_agent.findUnique({
          where: { agent_ID: dto.agent },
          select: {
            total_cash_wallet: true,
          },
        });
        const storedCashBalance = Number(currentAgentWallet?.total_cash_wallet ?? 0);
        const resolvedCashBalance = storedCashBalance > 0 ? storedCashBalance : Number(walletInfo.balance || 0);
        const nextCashBalance = resolvedCashBalance - Number(debitAmount || 0);

        await tx.dvi_cash_wallet.create({
          data: {
            agent_id: dto.agent,
            transaction_date: new Date(),
            transaction_amount: debitAmount,
            transaction_type: 2,
            remarks: `Confirmed Itinerary: ${plan.itinerary_quote_ID}`,
            transaction_id: plan.itinerary_quote_ID,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });

        await tx.dvi_agent.update({
          where: { agent_ID: dto.agent },
          data: {
            total_cash_wallet: new Prisma.Decimal(nextCashBalance),
          },
        });
      }

      const existingAccount = await tx.dvi_accounts_itinerary_details.findFirst({
        where: {
          itinerary_plan_ID: baseResult.itinerary_plan_ID,
          confirmed_itinerary_plan_ID: baseResult.confirmed_itinerary_plan_ID,
          deleted: 0,
        },
      });

      if (!existingAccount) {
        await tx.dvi_accounts_itinerary_details.create({
          data: {
            itinerary_plan_ID: baseResult.itinerary_plan_ID,
            agent_id: dto.agent,
            staff_id: Number(plan.staff_id || 0),
            confirmed_itinerary_plan_ID: baseResult.confirmed_itinerary_plan_ID,
            itinerary_quote_ID: plan.itinerary_quote_ID,
            trip_start_date_and_time: plan.trip_start_date_and_time,
            trip_end_date_and_time: plan.trip_end_date_and_time,
            total_billed_amount: debitAmount,
            total_received_amount: debitAmount,
            total_receivable_amount: 0,
            total_payable_amount: Number(cost?.totalAmount || 0),
            total_payout_amount: 0,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }
    });
  }

  async filterAlreadySuccessfulBookings(itineraryPlanId: number, bookings: any[]) {
    const alreadySuccessKeys = new Set<string>();
    const alreadyConfirmedResults: any[] = [];

    const tboRows = await this.prisma.tbo_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        tbo_hotel_code: true,
        tbo_booking_reference_number: true,
      },
    });

    for (const row of tboRows) {
      const key = this.bookingKey('tbo', Number(row.itinerary_route_ID || 0));
      alreadySuccessKeys.add(key);
      alreadyConfirmedResults.push({
        provider: 'tbo',
        providerDisplayName: 'VSR',
        routeId: Number(row.itinerary_route_ID || 0),
        hotelCode: row.tbo_hotel_code,
        status: 'already_confirmed',
        success: true,
        bookingRef: row.tbo_booking_reference_number || null,
      });
    }

    const raRows = await this.prisma.resavenue_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        resavenue_hotel_code: true,
        resavenue_booking_reference: true,
      },
    });

    for (const row of raRows) {
      const key = this.bookingKey('resavenue', Number(row.itinerary_route_ID || 0));
      alreadySuccessKeys.add(key);
      alreadyConfirmedResults.push({
        provider: 'resavenue',
        routeId: Number(row.itinerary_route_ID || 0),
        hotelCode: row.resavenue_hotel_code,
        status: 'already_confirmed',
        success: true,
        bookingRef: row.resavenue_booking_reference || null,
      });
    }

    const hobseRows = await (this.prisma as any).hobse_hotel_booking_confirmation.findMany({
      where: {
        plan_id: itineraryPlanId,
        booking_status: 'confirmed',
      },
      select: {
        route_id: true,
        hotel_code: true,
        booking_id: true,
      },
    });

    for (const row of hobseRows) {
      const key = this.bookingKey('hobse', Number(row.route_id || 0));
      alreadySuccessKeys.add(key);
      alreadyConfirmedResults.push({
        provider: 'hobse',
        routeId: Number(row.route_id || 0),
        hotelCode: row.hotel_code,
        status: 'already_confirmed',
        success: true,
        bookingRef: row.booking_id || null,
      });
    }

 // Build a set that includes both provider::route and provider::route::bookingCode keys
    const successKeySet = new Set<string>(Array.from(alreadySuccessKeys));

 // AxisRooms
    const axisRows = await (this.prisma as any).axisrooms_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        booking_code: true,
        axisrooms_booking_reference: true,
      },
    });
    for (const row of axisRows) {
      const routeId = Number(row.itinerary_route_ID || 0);
      successKeySet.add(this.bookingKey('axisrooms', routeId));
      const code = String(row.booking_code || row.axisrooms_booking_reference || '').trim();
      if (code) successKeySet.add(`${String('axisrooms')}::${routeId}::${code}`);
      alreadyConfirmedResults.push({
        provider: 'axisrooms',
        routeId,
        hotelCode: String(row.axisrooms_booking_reference || ''),
        status: 'already_confirmed',
        success: true,
        bookingRef: String(row.booking_code || row.axisrooms_booking_reference || null),
      });
    }

 // STAAH
    const staahRows = await (this.prisma as any).staah_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        booking_code: true,
        staah_booking_reference: true,
      },
    });
    for (const row of staahRows) {
      const routeId = Number(row.itinerary_route_ID || 0);
      successKeySet.add(this.bookingKey('staah', routeId));
      const code = String(row.booking_code || row.staah_booking_reference || '').trim();
      if (code) successKeySet.add(`${String('staah')}::${routeId}::${code}`);
      alreadyConfirmedResults.push({
        provider: 'staah',
        routeId,
        hotelCode: String(row.staah_booking_reference || ''),
        status: 'already_confirmed',
        success: true,
        bookingRef: String(row.booking_code || row.staah_booking_reference || null),
      });
    }

    const pendingBookings = bookings.filter((hotel) => {
      const provider = String(hotel.__provider || '').trim().toLowerCase();
      const routeId = Number(hotel.routeId || 0);
      const bookingCode = String(hotel.bookingCode || hotel.booking_code || '').trim();
      const key = this.bookingKey(provider, routeId);
      const keyWithCode = bookingCode ? `${provider}::${routeId}::${bookingCode}` : null;
      if (keyWithCode && successKeySet.has(keyWithCode)) return false;
      return !successKeySet.has(key);
    });

    return { pendingBookings, alreadyConfirmedResults };
  }

}
