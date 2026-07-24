// FILE: src/modules/itineraries/services/itinerary-confirmation.service.ts

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { ConfirmQuotationDto } from '../dto/confirm-quotation.dto';
import { ItineraryDetailsService } from '../itinerary-details.service';
import { HotelStayBlockValidationService } from './hotel-stay-block-validation.service';
import { normalizePassengerTitle } from '../../../common/utils/passenger-title.util';
import { ItineraryHotelApprovalService } from './itinerary-hotel-approval.service';

type ConfirmQuotationCallbacks = Partial<Record<
  'syncSelectedHotelDraftRowsForConfirmation'
  | 'getAgentWalletBalance'
  | 'formatDateOnly'
  | 'copyDraftToConfirmed',
  (...args: any[]) => any
>>;


@Injectable()
export class ItineraryConfirmationService {
  private callbacks: ConfirmQuotationCallbacks = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly itineraryDetails: ItineraryDetailsService,
    private readonly hotelStayBlockValidationService: HotelStayBlockValidationService,
    private readonly hotelApprovalService?: ItineraryHotelApprovalService,
  ) {}

  setCallbacks(callbacks: ConfirmQuotationCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private call(name: keyof ConfirmQuotationCallbacks, ...args: any[]) {
    const callback = this.callbacks[name];
    if (!callback) {
      throw new Error(`Itinerary confirmation callback is not configured: ${String(name)}`);
    }
    return callback(...args);
  }

  private syncSelectedHotelDraftRowsForConfirmation(...args: any[]) { return this.call('syncSelectedHotelDraftRowsForConfirmation', ...args); }
  private getAgentWalletBalance(...args: any[]) { return this.call('getAgentWalletBalance', ...args); }
  private formatDateOnly(...args: any[]) { return this.call('formatDateOnly', ...args); }
  private copyDraftToConfirmed(...args: any[]) { return this.call('copyDraftToConfirmed', ...args); }

  async confirmQuotation(dto: ConfirmQuotationDto) {
    const userId = 1; // TODO: Get from authenticated user

    // 1. Get plan details and cost breakdown
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: dto.itinerary_plan_ID },
    });

    if (!plan) {
      throw new NotFoundException('Itinerary plan not found');
    }

    if (plan.quotation_status === 1) {
      throw new BadRequestException('Quotation is already confirmed');
    }

    const existingConfirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: {
        itinerary_plan_ID: dto.itinerary_plan_ID,
        deleted: 0,
      },
      orderBy: {
        confirmed_itinerary_plan_ID: 'desc',
      },
      select: {
        confirmed_itinerary_plan_ID: true,
      },
    });

    if (existingConfirmedPlan) {
      return {
        success: true,
        message: 'Reusing existing confirmation context for pending hotel retries',
        itinerary_plan_ID: dto.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: existingConfirmedPlan.confirmed_itinerary_plan_ID,
        bookingResults: null,
        reusedConfirmedPlan: true,
      };
    }

    const quoteId = plan.itinerary_quote_ID;
    if (!quoteId) {
      throw new BadRequestException('Quote ID not found for this plan');
    }

    const shouldConfirmHotels = [1, 3].includes(Number(plan.itinerary_preference || 0));

    if (shouldConfirmHotels && Array.isArray((dto as any).hotel_bookings)) {
      (dto as any).hotel_bookings = this.pruneHotelBookingsCoveredByMultiNight(
        this.mergeConsecutiveSupplierHotelBookings((dto as any).hotel_bookings),
      );
    }

    const hotelSelectionState = shouldConfirmHotels
      ? await this.syncSelectedHotelDraftRowsForConfirmation(dto, userId)
      : {
          providerHotelBookings: [],
          selectedRouteIds: [],
          externalRouteIds: [],
          groupType: 0,
          skippedExternalStayCount: 0,
        };
    const {
      providerHotelBookings,
      selectedRouteIds,
      externalRouteIds,
      groupType,
      skippedExternalStayCount,
    } = hotelSelectionState;
    console.log('[CONFIRM_QUOTATION_HOTEL_SELECTION_SYNCED]', {
      planId: dto.itinerary_plan_ID,
      shouldConfirmHotels,
      groupType,
      supplierBookableHotels: providerHotelBookings.length,
      selectedRouteIds,
      externalRouteIds,
      skippedExternalStayCount,
    });
    console.log('[CONFIRM_QUOTATION_HOTELS_RECEIVED]', providerHotelBookings.map((h: any) => ({
      routeId: h.routeId,
      provider: h.provider,
      hotelCode: h.hotelCode,
      hotelName: h.hotelName,
      bookingCodePresent: Boolean(String(h.bookingCode || '').trim()),
      roomType: h.roomType,
      checkInDate: h.checkInDate,
      checkOutDate: h.checkOutDate,
      netAmount: h.netAmount,
      prebookNetAmount: h?.prebookContext?.prebookNetAmount,
    })));

    if (shouldConfirmHotels && providerHotelBookings.length > 0) {
      for (const hotel of providerHotelBookings) {
        const provider = String(hotel?.provider || hotel?.__provider || '').trim().toLowerCase();
        if (!['staah', 'axisrooms'].includes(provider)) {
          continue;
        }

        const routeId = Number(hotel?.routeId || 0);
        const checkInDate = this.formatDateOnly(hotel?.checkInDate);
        const hotelCode = String(hotel?.hotelCode || '').trim();
        if (!routeId || !checkInDate || !hotelCode) {
          throw new BadRequestException('Invalid multi-night hotel booking payload');
        }

        const preview = await this.hotelStayBlockValidationService.previewStayExtension({
          planId: dto.itinerary_plan_ID,
          routeId,
          provider: provider as 'staah' | 'axisrooms',
          hotelCode,
          hotelName: String(hotel?.hotelName || '').trim() || undefined,
          roomId: String(hotel?.roomId || '').trim() || undefined,
          rateId: String(hotel?.rateId || '').trim() || undefined,
          roomType: String(hotel?.roomType || '').trim() || undefined,
          mealPlan: String(hotel?.mealPlan || '').trim() || undefined,
          checkInDate,
        });

        const isMultiNightBooking = Boolean(hotel?.multiNightBooking);
        if (isMultiNightBooking && (preview.blocked || !preview.canBookMultiNight)) {
          throw new BadRequestException({
            message: 'Continuous stay booking is blocked for the selected hotel.',
            provider,
            routeId,
            stayKey: preview.stayKey,
            restrictionConflicts: preview.restrictionConflicts,
          });
        }

        if (!isMultiNightBooking && !preview.canBookSingleNight) {
          throw new BadRequestException({
            message: 'Selected hotel cannot be booked on the requested date.',
            provider,
            routeId,
            stayKey: preview.stayKey,
            restrictionConflicts: preview.restrictionConflicts,
          });
        }
      }
    }

    // Cost must be calculated only after stale hotel rows are deactivated.
    const details = await this.itineraryDetails.getItineraryDetails(quoteId);
    const requiresVehicleSelection = [2, 3].includes(Number(plan.itinerary_preference || 0));
    const selectedVehicleCount = Array.isArray((details as any)?.vehicles)
      ? (details as any).vehicles.filter((vehicle: any) => vehicle?.isAssigned === true).length
      : 0;
    const unavailableVehicleTypes = Array.isArray((details as any)?.vehicleRateAvailability)
      ? (details as any).vehicleRateAvailability.length
      : 0;
    if (
      requiresVehicleSelection &&
      (selectedVehicleCount === 0 || unavailableVehicleTypes > 0)
    ) {
      throw new BadRequestException(
        'A vehicle with valid local or outstation rates must be selected before confirming the quotation',
      );
    }
    const cost = details.costBreakdown;

    // 2. Check wallet balance
    const walletInfo = await this.getAgentWalletBalance(dto.agent);
    if (walletInfo.balance < cost.netPayable) {
      throw new BadRequestException(`Insufficient wallet balance. Required: ${cost.netPayable}, Available: ${walletInfo.balance}`);
    }

    // Parse arrival and departure dates
    const parseDateTime = (dateTimeStr: string) => {
      const raw = String(dateTimeStr || '').trim();
      if (!raw) {
        throw new BadRequestException('Arrival/Departure datetime is required');
      }

      // Support existing format: "12-12-2025 9:00 AM"
      const match = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (match) {
        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        let hours = Number(match[4]);
        const minutes = Number(match[5]);
        const meridiem = String(match[6] || '').toUpperCase();

        if (meridiem === 'PM' && hours !== 12) hours += 12;
        if (meridiem === 'AM' && hours === 12) hours = 0;

        const parsed = new Date(year, month - 1, day, hours, minutes);
        if (Number.isNaN(parsed.getTime())) {
          throw new BadRequestException(`Invalid datetime value: ${raw}`);
        }
        return parsed;
      }

      // Fallback for ISO-like inputs
      const fallback = new Date(raw);
      if (Number.isNaN(fallback.getTime())) {
        throw new BadRequestException(`Invalid datetime format: ${raw}`);
      }
      return fallback;
    };

    const arrivalDateTime = parseDateTime(dto.arrival_date_time);
    const departureDateTime = parseDateTime(dto.departure_date_time);

    const hasHotelBookings = shouldConfirmHotels && providerHotelBookings.length > 0;

    // 3. Start Transaction
    return await this.prisma.$transaction(async (tx) => {
      // A. Deduct wallet only when there are no provider bookings to run.
      // For hotel-booking flow this is deferred until all providers succeed.
      if (!hasHotelBookings) {
        const currentAgentWallet = await tx.dvi_agent.findUnique({
          where: { agent_ID: dto.agent },
          select: {
            total_cash_wallet: true,
          },
        });
        const storedCashBalance = Number(currentAgentWallet?.total_cash_wallet ?? 0);
        const resolvedCashBalance = storedCashBalance > 0 ? storedCashBalance : Number(walletInfo.balance || 0);
        const nextCashBalance = resolvedCashBalance - Number(cost.netPayable || 0);

        await tx.dvi_cash_wallet.create({
          data: {
            agent_id: dto.agent,
            transaction_date: new Date(),
            transaction_amount: cost.netPayable,
            transaction_type: 2, // Debit
            remarks: `Confirmed Itinerary: ${quoteId}`,
            transaction_id: quoteId,
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

      // B. Insert into dvi_confirmed_itinerary_plan_details
      const confirmedPlan = await tx.dvi_confirmed_itinerary_plan_details.create({
        data: {
          itinerary_plan_ID: plan.itinerary_plan_ID,
          agent_id: dto.agent,
          staff_id: plan.staff_id || 0,
          location_id: plan.location_id || 0n,
          arrival_location: plan.arrival_location,
          departure_location: plan.departure_location,
          itinerary_quote_ID: plan.itinerary_quote_ID,
          trip_start_date_and_time: plan.trip_start_date_and_time,
          trip_end_date_and_time: plan.trip_end_date_and_time,
          arrival_type: plan.arrival_type || 0,
          departure_type: plan.departure_type || 0,
          expecting_budget: plan.expecting_budget || 0,
          itinerary_type: plan.itinerary_type || 0,
          entry_ticket_required: plan.entry_ticket_required || 0,
          no_of_routes: plan.no_of_routes || 0,
          no_of_days: plan.no_of_days || 0,
          no_of_nights: plan.no_of_nights || 0,
          total_adult: plan.total_adult || 0,
          total_children: plan.total_children || 0,
          total_infants: plan.total_infants || 0,
          nationality: plan.nationality || 0,
          itinerary_preference: plan.itinerary_preference || 0,
          meal_plan_breakfast: plan.meal_plan_breakfast || 0,
          meal_plan_lunch: plan.meal_plan_lunch || 0,
          meal_plan_dinner: plan.meal_plan_dinner || 0,
          preferred_room_count: plan.preferred_room_count || 0,
          total_extra_bed: plan.total_extra_bed || 0,
          total_child_with_bed: plan.total_child_with_bed || 0,
          total_child_without_bed: plan.total_child_without_bed || 0,
          guide_for_itinerary: plan.guide_for_itinerary || 0,
          food_type: plan.food_type || 0,
          special_instructions: plan.special_instructions,
          transport_early_arrival_option: (plan as any).transport_early_arrival_option,
          transport_early_arrival_hotel_name: (plan as any).transport_early_arrival_hotel_name,
          transport_early_arrival_rest_minutes: (plan as any).transport_early_arrival_rest_minutes,
          pick_up_date_and_time: plan.pick_up_date_and_time,
          hotel_terms_condition: (plan as any).hotel_terms_condition,
          vehicle_terms_condition: (plan as any).vehicle_terms_condition,
          hotel_rates_visibility: plan.hotel_rates_visibility || 0,
          
          // Costs from breakdown
          total_hotspot_charges: cost.totalHotspotCost || 0,
          total_activity_charges: cost.totalActivityCost || 0,
          total_hotel_charges: cost.totalHotelAmount || 0,
          total_vehicle_charges: cost.totalVehicleAmount || 0,
          total_guide_charges: cost.totalGuideCost || 0,
          itinerary_sub_total: (cost.totalHotelAmount || 0) + (cost.totalVehicleAmount || 0),
          itinerary_agent_margin_charges: cost.agentMargin || 0,
          itinerary_gross_total_amount: cost.totalAmount || 0,
          itinerary_total_margin_cost: cost.additionalMargin || 0,
          itinerary_total_net_payable_amount: cost.netPayable,
          itinerary_total_paid_amount: cost.netPayable,
          itinerary_total_balance_amount: 0,
          
          createdby: userId,
          createdon: new Date(),
          // Keep provisional (status=0) until all provider bookings are successful.
          status: hasHotelBookings ? 0 : 1,
          deleted: 0,
        },
      });

      const confirmedPlanId = confirmedPlan.confirmed_itinerary_plan_ID;

      // C. Insert Primary Guest
      const primaryCustomerSalutation =
        normalizePassengerTitle(dto.primary_guest_salutation) || dto.primary_guest_salutation || '';
      const additionalAdultPassengerTitles =
        providerHotelBookings?.[0]?.passengers
          ?.filter((passenger) => Number(passenger.paxType) === 1 && !passenger.leadPassenger)
          .map((passenger) => normalizePassengerTitle(passenger.title) || '') || [];

      await tx.dvi_confirmed_itinerary_customer_details.create({
        data: {
          confirmed_itinerary_plan_ID: confirmedPlanId,
          itinerary_plan_ID: dto.itinerary_plan_ID,
          agent_id: dto.agent,
          primary_customer: 1,
          customer_type: 1, // Adult
          customer_salutation: primaryCustomerSalutation,
          customer_name: dto.primary_guest_name,
          customer_age: parseInt(dto.primary_guest_age) || 0,
          primary_contact_no: dto.primary_guest_contact_no,
          altenative_contact_no: dto.primary_guest_alternative_contact_no || '',
          email_id: dto.primary_guest_email_id || '',
          arrival_date_and_time: arrivalDateTime,
          arrival_place: dto.arrival_place,
          arrival_flight_details: dto.arrival_flight_details || '',
          departure_date_and_time: departureDateTime,
          departure_place: dto.departure_place,
          departure_flight_details: dto.departure_flight_details || '',
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      // D. Insert Additional Adults
      if (dto.adult_name && dto.adult_name.length > 0) {
        for (let i = 0; i < dto.adult_name.length; i++) {
          if (dto.adult_name[i]) {
            await tx.dvi_confirmed_itinerary_customer_details.create({
              data: {
                confirmed_itinerary_plan_ID: confirmedPlanId,
                itinerary_plan_ID: dto.itinerary_plan_ID,
                agent_id: dto.agent,
                primary_customer: 0,
                customer_type: 1, // Adult
                customer_salutation: additionalAdultPassengerTitles[i] || '',
                customer_name: dto.adult_name[i],
                customer_age: parseInt(dto.adult_age?.[i] || '0') || 0,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          }
        }
      }

      // E. Insert Children
      if (dto.child_name && dto.child_name.length > 0) {
        for (let i = 0; i < dto.child_name.length; i++) {
          if (dto.child_name[i]) {
            await tx.dvi_confirmed_itinerary_customer_details.create({
              data: {
                confirmed_itinerary_plan_ID: confirmedPlanId,
                itinerary_plan_ID: dto.itinerary_plan_ID,
                agent_id: dto.agent,
                primary_customer: 0,
                customer_type: 2, // Child
                customer_name: dto.child_name[i],
                customer_age: parseInt(dto.child_age?.[i] || '0') || 0,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          }
        }
      }

      // F. Insert Infants
      if (dto.infant_name && dto.infant_name.length > 0) {
        for (let i = 0; i < dto.infant_name.length; i++) {
          if (dto.infant_name[i]) {
            await tx.dvi_confirmed_itinerary_customer_details.create({
              data: {
                confirmed_itinerary_plan_ID: confirmedPlanId,
                itinerary_plan_ID: dto.itinerary_plan_ID,
                agent_id: dto.agent,
                primary_customer: 0,
                customer_type: 3, // Infant
                customer_name: dto.infant_name[i],
                customer_age: parseInt(dto.infant_age?.[i] || '0') || 0,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          }
        }
      }

      // G. Copy related tables (Travellers, Vehicles, Routes, Via Routes, Hotels, Hotspots, Activities)
      await this.copyDraftToConfirmed(tx, dto.itinerary_plan_ID, confirmedPlanId, userId, {
        copyHotels: shouldConfirmHotels,
        hotelGroupType: shouldConfirmHotels ? groupType : undefined,
        selectedHotelRouteIds: shouldConfirmHotels ? selectedRouteIds : [],
      });

      // H. Insert accounts row only when no provider bookings are pending.
      if (!hasHotelBookings) {
        await tx.dvi_accounts_itinerary_details.create({
          data: {
            itinerary_plan_ID: dto.itinerary_plan_ID,
            agent_id: dto.agent,
            staff_id: plan.staff_id || 0,
            confirmed_itinerary_plan_ID: confirmedPlanId,
            itinerary_quote_ID: plan.itinerary_quote_ID,
            trip_start_date_and_time: plan.trip_start_date_and_time,
            trip_end_date_and_time: plan.trip_end_date_and_time,
            total_billed_amount: cost.netPayable,
            total_received_amount: cost.netPayable,
            total_receivable_amount: 0,
            total_payable_amount: cost.totalAmount,
            total_payout_amount: 0,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }

      // I. Keep quotation unconfirmed when hotel bookings are present.
      // Final confirmation happens only after all provider bookings succeed.
      await tx.dvi_itinerary_plan_details.update({
        where: { itinerary_plan_ID: dto.itinerary_plan_ID },
        data: {
          quotation_status: hasHotelBookings ? 0 : 1,
          updatedon: new Date(),
        },
      });

      return {
        success: true,
        message:
          hasHotelBookings
            ? 'Confirmation context prepared. Quotation will be marked confirmed after all supplier hotel bookings succeed.'
            : 'Quotation confirmed successfully. External/self-arranged hotel rows were not sent to supplier booking.',
        itinerary_plan_ID: dto.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: confirmedPlanId,
        bookingResults: null, // Will be set after transaction
      };
    });
  }

  isBookingResultSuccess(result: any): boolean {
    const status = String(result?.status || '').trim().toLowerCase();
    const success = result?.success;
    const bookingStatus = String(result?.booking_status || '').trim().toLowerCase();

    return (
      success === true ||
      status === 'confirmed' ||
      status === 'success' ||
      status === 'already_confirmed' ||
      bookingStatus === 'confirmed'
    );
  }

  bookingKey(provider: string, routeId: number): string {
    return `${String(provider || '').trim().toLowerCase()}::${Number(routeId || 0)}`;
  }

  private isExternalOrUnavailableHotelBooking(hotel: any): boolean {
    const provider = String(hotel?.provider || '').trim().toLowerCase();
    const hotelName = String(hotel?.hotelName || '').trim().toLowerCase();
    const hotelCode = String(hotel?.hotelCode || '').trim();
    const bookingCode = String(hotel?.bookingCode || '').trim();
    const netAmount = Number(hotel?.netAmount || 0);

    const supportedProviders = new Set(['tbo', 'resavenue', 'hobse', 'axisrooms', 'staah']);

    if (!hotel) return true;
    if (hotel.externalStay === true) return true;
    if (hotel.isBookable === false) return true;
    if (provider === 'external' || provider === 'none' || provider === 'self-arranged') return true;
    if (hotelName === 'no hotels available') return true;
    if (!hotelCode || hotelCode === '0') return true;
    if (!supportedProviders.has(provider)) return true;
    if (!Number.isFinite(netAmount) || netAmount <= 0) return true;

    if (provider === 'tbo' && !bookingCode.includes('!TB!')) {
      return true;
    }

    return false;
  }

  getProviderBookableHotelBookings<T extends any>(hotelBookings?: T[]): T[] {
    return (hotelBookings || []).filter(
      (hotel: any) => !this.isExternalOrUnavailableHotelBooking(hotel),
    );
  }

  getConfirmHotelGroupType(dto: ConfirmQuotationDto): number {
    const groupType = Number(dto.hotel_group_type);
    return Number.isFinite(groupType) && groupType > 0 ? groupType : 1;
  }

  uniquePositiveNumbers(values: any[]): number[] {
    return Array.from(
      new Set(
        (values || [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    );
  }

  private addOneDateOnly(date: string): string {
    const raw = String(date || '').trim();
    if (!raw) return '';

    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime())) return '';

    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed.toISOString().slice(0, 10);
  }

  private getSupplierStayMergeKey(booking: any): string {
    return [
      String(booking?.provider || booking?.__provider || '').trim().toLowerCase(),
      String(booking?.hotelCode || '').trim().toLowerCase(),
      String(booking?.roomId || '').trim().toLowerCase(),
      String(booking?.rateId || '').trim().toLowerCase(),
      String(booking?.roomType || '').trim().toLowerCase(),
      this.normalizeHotelSelectionIdentity(booking?.mealPlan),
    ].join('|');
  }

  private canMergeSupplierStayBooking(booking: any): boolean {
    const provider = String(booking?.provider || booking?.__provider || '').trim().toLowerCase();

    if (provider !== 'staah' && provider !== 'axisrooms') {
      return false;
    }

    return Boolean(
      String(booking?.hotelCode || '').trim() &&
      String(booking?.roomId || '').trim() &&
      String(booking?.rateId || '').trim() &&
      String(booking?.checkInDate || '').trim(),
    );
  }

  mergeConsecutiveSupplierHotelBookings<T extends any>(bookings: T[]): T[] {
    const sortedBookings = [...(bookings || [])].sort((a: any, b: any) => {
      const dateA = String(a?.checkInDate || '').trim();
      const dateB = String(b?.checkInDate || '').trim();

      if (dateA !== dateB) {
        return dateA.localeCompare(dateB);
      }

      return Number(a?.routeId || 0) - Number(b?.routeId || 0);
    });

    const merged: any[] = [];
    const consumed = new Set<number>();

    for (let i = 0; i < sortedBookings.length; i += 1) {
      if (consumed.has(i)) {
        continue;
      }

      const first = sortedBookings[i] as any;

      if (!this.canMergeSupplierStayBooking(first)) {
        merged.push(first);
        consumed.add(i);
        continue;
      }

      const mergeKey = this.getSupplierStayMergeKey(first);
      const group = [first];
      let lastCheckOutDate =
        this.formatDateOnly(first.checkOutDate) ||
        this.addOneDateOnly(String(first.checkInDate || ''));

      for (let j = i + 1; j < sortedBookings.length; j += 1) {
        if (consumed.has(j)) {
          continue;
        }

        const next = sortedBookings[j] as any;

        if (!this.canMergeSupplierStayBooking(next)) {
          continue;
        }

        const nextKey = this.getSupplierStayMergeKey(next);
        const nextCheckInDate = this.formatDateOnly(next.checkInDate);

        if (nextKey !== mergeKey || nextCheckInDate !== lastCheckOutDate) {
          continue;
        }

        group.push(next);
        lastCheckOutDate =
          this.formatDateOnly(next.checkOutDate) ||
          this.addOneDateOnly(String(next.checkInDate || ''));
        consumed.add(j);
      }

      consumed.add(i);

      if (group.length === 1) {
        merged.push(first);
        continue;
      }

      const routeIds = this.uniquePositiveNumbers(group.map((booking: any) => booking.routeId));
      const nightlyRates = group.map((booking: any) => ({
        date: this.formatDateOnly(booking.checkInDate) || String(booking.checkInDate || '').trim(),
        amountAfterTax: Number(
          booking?.totalAmountAfterTax ??
            booking?.netAmount ??
            booking?.totalAmount ??
            booking?.totalHotelCost ??
            0,
        ),
      }));

      const totalAmountAfterTax = Number(
        nightlyRates.reduce((sum, night) => sum + Number(night.amountAfterTax || 0), 0).toFixed(2),
      );

      const checkInDate = this.formatDateOnly(group[0].checkInDate) || String(group[0].checkInDate || '').trim();
      const checkOutDate = lastCheckOutDate;

      merged.push({
        ...first,
        routeId: routeIds[0],
        checkInDate,
        checkOutDate,
        netAmount: totalAmountAfterTax,
        totalAmountAfterTax,
        totalAmount: totalAmountAfterTax,
        totalHotelCost: totalAmountAfterTax,
        multiNightBooking: true,
        routeIds,
        nights: routeIds.length,
        nightlyRates,
        stayKey: [
          String(first?.provider || first?.__provider || '').trim().toLowerCase(),
          String(first?.hotelCode || '').trim(),
          String(first?.roomId || '').trim(),
          String(first?.rateId || '').trim(),
          `${checkInDate}_to_${checkOutDate}`,
        ].join(':'),
      });
    }

    console.log('[SUPPLIER_HOTEL_BOOKINGS_MERGED_FOR_MULTI_NIGHT]', {
      before: bookings?.length || 0,
      after: merged.length,
      merged: merged
        .filter((booking: any) => Boolean(booking?.multiNightBooking))
        .map((booking: any) => ({
          provider: booking?.provider || booking?.__provider,
          routeId: booking?.routeId,
          routeIds: booking?.routeIds,
          hotelCode: booking?.hotelCode,
          roomId: booking?.roomId,
          rateId: booking?.rateId,
          checkInDate: booking?.checkInDate,
          checkOutDate: booking?.checkOutDate,
          nights: booking?.nights,
          totalAmountAfterTax: booking?.totalAmountAfterTax,
        })),
    });

    return merged as T[];
  }

  pruneHotelBookingsCoveredByMultiNight<T extends any>(bookings: T[]): T[] {
    const rows = bookings || [];

    const canonicalParents = new Map<string, {
      booking: any;
      routeIds: number[];
      canonicalRouteId: number;
    }>();

    for (const booking of rows as any[]) {
      const routeId = Number(booking?.routeId || 0);
      const routeIds = Array.isArray(booking?.routeIds)
        ? this.uniquePositiveNumbers(booking.routeIds)
        : [];

      if (
        !Boolean(booking?.multiNightBooking) ||
        !routeId ||
        routeIds.length <= 1
      ) {
        continue;
      }

      const canonicalRouteId = routeIds[0];
      const groupKey = [
        String(booking?.provider || booking?.__provider || '').trim().toLowerCase(),
        String(booking?.hotelCode || '').trim().toLowerCase(),
        String(booking?.roomId || '').trim().toLowerCase(),
        String(booking?.rateId || '').trim().toLowerCase(),
        routeIds.join(','),
      ].join('|');

      const existing = canonicalParents.get(groupKey);
      const normalizedParent = {
        ...booking,
        routeId: canonicalRouteId,
        routeIds,
        multiNightBooking: true,
      };

      if (!existing || routeId === canonicalRouteId) {
        canonicalParents.set(groupKey, {
          booking: normalizedParent,
          routeIds,
          canonicalRouteId,
        });
      }
    }

    if (canonicalParents.size === 0) {
      return rows;
    }

    const coveredRouteIdToGroupKey = new Map<number, string>();
    canonicalParents.forEach((parent, groupKey) => {
      parent.routeIds.forEach((routeId) => {
        coveredRouteIdToGroupKey.set(routeId, groupKey);
      });
    });

    const pruned: any[] = [];

    for (const booking of rows as any[]) {
      const routeId = Number(booking?.routeId || 0);
      const groupKey = coveredRouteIdToGroupKey.get(routeId);

      if (!groupKey) {
        pruned.push(booking);
        continue;
      }

      const parent = canonicalParents.get(groupKey);

      if (!parent) {
        pruned.push(booking);
        continue;
      }

      if (routeId === parent.canonicalRouteId) {
        const alreadyAdded = pruned.some((row: any) => row === parent.booking);
        if (!alreadyAdded) {
          pruned.push(parent.booking);
        }
      }
    }

    const deduped = pruned.filter((booking: any, index: number, list: any[]) => {
      const routeId = Number(booking?.routeId || 0);
      const routeIds = Array.isArray(booking?.routeIds)
        ? this.uniquePositiveNumbers(booking.routeIds)
        : [];

      const key = [
        String(booking?.provider || booking?.__provider || '').trim().toLowerCase(),
        String(booking?.hotelCode || '').trim().toLowerCase(),
        String(booking?.roomId || '').trim().toLowerCase(),
        String(booking?.rateId || '').trim().toLowerCase(),
        String(routeId),
        routeIds.join(','),
        String(Boolean(booking?.multiNightBooking)),
      ].join('|');

      return list.findIndex((candidate: any) => {
        const candidateRouteId = Number(candidate?.routeId || 0);
        const candidateRouteIds = Array.isArray(candidate?.routeIds)
          ? this.uniquePositiveNumbers(candidate.routeIds)
          : [];

        const candidateKey = [
          String(candidate?.provider || candidate?.__provider || '').trim().toLowerCase(),
          String(candidate?.hotelCode || '').trim().toLowerCase(),
          String(candidate?.roomId || '').trim().toLowerCase(),
          String(candidate?.rateId || '').trim().toLowerCase(),
          String(candidateRouteId),
          candidateRouteIds.join(','),
          String(Boolean(candidate?.multiNightBooking)),
        ].join('|');

        return candidateKey === key;
      }) === index;
    });

    if (deduped.length !== rows.length) {
      console.warn('[SUPPLIER_HOTEL_BOOKINGS_PRUNED_MULTI_NIGHT_CHILD_ROWS]', {
        before: rows.length,
        after: deduped.length,
        removed: (rows as any[])
          .filter((row: any) => !deduped.includes(row))
          .map((booking: any) => ({
            provider: booking?.provider || booking?.__provider,
            routeId: booking?.routeId,
            routeIds: booking?.routeIds,
            hotelCode: booking?.hotelCode,
            roomId: booking?.roomId,
            rateId: booking?.rateId,
            checkInDate: booking?.checkInDate,
            checkOutDate: booking?.checkOutDate,
            multiNightBooking: booking?.multiNightBooking,
            stayKey: booking?.stayKey,
          })),
        remaining: deduped.map((booking: any) => ({
          provider: booking?.provider || booking?.__provider,
          routeId: booking?.routeId,
          routeIds: booking?.routeIds,
          hotelCode: booking?.hotelCode,
          roomId: booking?.roomId,
          rateId: booking?.rateId,
          checkInDate: booking?.checkInDate,
          checkOutDate: booking?.checkOutDate,
          multiNightBooking: booking?.multiNightBooking,
          stayKey: booking?.stayKey,
        })),
      });
    }

    return deduped as T[];
  }

  private normalizeHotelSelectionIdentity(value: unknown): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  assertConsistentMultiNightHotelSelection(providerHotelBookings: any[]): void {
    /**
     * Business rule:
     * - Manual single-day selection may intentionally use a different room/meal plan.
     * - True continuous stay booking must use the same supplier room/rate/meal across all nights.
     *
     * So this guard only applies to rows explicitly marked as multiNightBooking.
     */
    const multiNightBookings = (providerHotelBookings || []).filter((booking: any) =>
      Boolean(booking?.multiNightBooking) &&
      Array.isArray(booking?.routeIds) &&
      booking.routeIds.length > 1,
    );

    for (const booking of multiNightBookings) {
      const bookingRouteIds = (booking?.routeIds || []).map((value: any) => Number(value));
      const selectedIdentity = [
        this.normalizeHotelSelectionIdentity(booking?.provider),
        this.normalizeHotelSelectionIdentity(booking?.hotelCode),
        this.normalizeHotelSelectionIdentity(booking?.roomId),
        this.normalizeHotelSelectionIdentity(booking?.rateId),
        this.normalizeHotelSelectionIdentity(booking?.roomType),
        this.normalizeHotelSelectionIdentity(booking?.mealPlan),
      ].join('|');

      const conflictingRows = providerHotelBookings.filter((candidate: any) => {
        const candidateRouteId = Number(candidate?.routeId || 0);

        if (!candidateRouteId || !bookingRouteIds.includes(candidateRouteId)) {
          return false;
        }

        const candidateIdentity = [
          this.normalizeHotelSelectionIdentity(candidate?.provider),
          this.normalizeHotelSelectionIdentity(candidate?.hotelCode),
          this.normalizeHotelSelectionIdentity(candidate?.roomId),
          this.normalizeHotelSelectionIdentity(candidate?.rateId),
          this.normalizeHotelSelectionIdentity(candidate?.roomType),
          this.normalizeHotelSelectionIdentity(candidate?.mealPlan),
        ].join('|');

        return candidateIdentity !== selectedIdentity;
      });

      if (conflictingRows.length > 0) {
        throw new BadRequestException({
          message: 'Continuous stay has inconsistent room/rate selections across routes.',
          stayKey: booking?.stayKey,
          routeIds: booking?.routeIds,
          expected: {
            provider: booking?.provider,
            hotelCode: booking?.hotelCode,
            roomId: booking?.roomId,
            rateId: booking?.rateId,
            roomType: booking?.roomType,
            mealPlan: booking?.mealPlan,
          },
          conflicts: conflictingRows.map((row: any) => ({
            routeId: row?.routeId,
            provider: row?.provider,
            hotelCode: row?.hotelCode,
            roomId: row?.roomId,
            rateId: row?.rateId,
            roomType: row?.roomType,
            mealPlan: row?.mealPlan,
          })),
        });
      }
    }
  }

}
