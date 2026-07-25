// FILE: src/modules/itineraries/services/itinerary-hotel-booking-fulfillment.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ConfirmQuotationDto } from '../dto/confirm-quotation.dto';
import { TboHotelBookingService } from './tbo-hotel-booking.service';
import { ResAvenueHotelBookingService } from './resavenue-hotel-booking.service';
import { HobseHotelBookingService } from './hobse-hotel-booking.service';
import { AxisRoomsBookingPushService } from './axisrooms-booking-push.service';
import { StaahBookingPushService } from './staah-booking-push.service';
import { normalizePassengerTitle } from '../../../common/utils/passenger-title.util';

type HotelBookingFulfillmentCallbacks = Partial<Record<
  'bookingKey'
  | 'isBookingResultSuccess'
  | 'filterAlreadySuccessfulBookings'
  | 'finalizeConfirmationFinancials'
  | 'getConfirmedItineraryDetails'
  | 'mergeConsecutiveSupplierHotelBookings'
  | 'pruneHotelBookingsCoveredByMultiNight'
  | 'getProviderBookableHotelBookings',
  (...args: any[]) => any
>>;


@Injectable()
export class ItineraryHotelBookingFulfillmentService {
  private callbacks: HotelBookingFulfillmentCallbacks = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly tboHotelBooking: TboHotelBookingService,
    private readonly resavenueHotelBooking: ResAvenueHotelBookingService,
    private readonly hobseHotelBooking: HobseHotelBookingService,
    private readonly axisroomsBookingPushService: AxisRoomsBookingPushService,
    private readonly staahBookingPushService: StaahBookingPushService,
  ) {}

  setCallbacks(callbacks: HotelBookingFulfillmentCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private call(name: keyof HotelBookingFulfillmentCallbacks, ...args: any[]) {
    const callback = this.callbacks[name];
    if (!callback) {
      throw new Error(`Hotel booking fulfillment callback is not configured: ${String(name)}`);
    }
    return callback(...args);
  }

  private bookingKey(...args: any[]) { return this.call('bookingKey', ...args); }
  private isBookingResultSuccess(...args: any[]) { return this.call('isBookingResultSuccess', ...args); }
  private filterAlreadySuccessfulBookings(...args: any[]) { return this.call('filterAlreadySuccessfulBookings', ...args); }
  private finalizeConfirmationFinancials(...args: any[]) { return this.call('finalizeConfirmationFinancials', ...args); }
  private getConfirmedItineraryDetails(...args: any[]) { return this.call('getConfirmedItineraryDetails', ...args); }
  private mergeConsecutiveSupplierHotelBookings(...args: any[]) { return this.call('mergeConsecutiveSupplierHotelBookings', ...args); }
  private pruneHotelBookingsCoveredByMultiNight(...args: any[]) { return this.call('pruneHotelBookingsCoveredByMultiNight', ...args); }
  private getProviderBookableHotelBookings(...args: any[]) { return this.call('getProviderBookableHotelBookings', ...args); }

  async processConfirmationWithTboBookings(
    baseResult: any,
    dto: ConfirmQuotationDto,
    endUserIp: string = process.env.TBO_END_USER_IP || '134.209.145.185',
  ) {
 const userId = 1; // TODO: Get from authenticated user
    const mergedHotelBookings = this.pruneHotelBookingsCoveredByMultiNight(
      this.mergeConsecutiveSupplierHotelBookings(dto.hotel_bookings || []),
    );

    const providerHotelBookings = this.getProviderBookableHotelBookings(mergedHotelBookings);
    const skippedExternalStayCount = (dto.hotel_bookings || []).length - providerHotelBookings.length;

 // If no supplier-bookable hotels are selected, still return DB-backed confirmed hotel details.
 // This covers cases where dto.hotel_bookings contains only external/self-arranged rows.
    if (providerHotelBookings.length === 0) {
 console.log(
        '[Hotel Booking] No supplier-bookable hotels to process. External/self-arranged stays skipped:',
        skippedExternalStayCount,
      );

      const confirmedPlanId = Number(baseResult?.confirmed_itinerary_plan_ID || 0);

      const confirmedHotelDetails = confirmedPlanId > 0
        ? await this.getConfirmedItineraryDetails(confirmedPlanId)
        : null;

      return {
        ...baseResult,
        success: true,
        message:
          baseResult?.message ||
          'Quotation confirmed successfully. External/self-arranged hotel rows were not sent to supplier booking.',
        confirmedHotelDetails,
      };
    }

 console.log('[CONFIRM_QUOTATION_DEBUG] [Hotel Booking] Processing', providerHotelBookings.length, 'hotel(s)');
 console.log(
      '[CONFIRM_QUOTATION_DEBUG] [Hotel Booking] Incoming supplier hotel_bookings:',
      JSON.stringify(
        providerHotelBookings.map((booking: any) => ({
          provider: booking?.provider || booking?.__provider,
          routeId: booking?.routeId,
          routeIds: booking?.routeIds,
          hotelCode: booking?.hotelCode,
          hotelName: booking?.hotelName,
          roomId: booking?.roomId,
          rateId: booking?.rateId,
          roomType: booking?.roomType,
          mealPlan: booking?.mealPlan,
          checkInDate: booking?.checkInDate,
          checkOutDate: booking?.checkOutDate,
          netAmount: booking?.netAmount,
          multiNightBooking: booking?.multiNightBooking,
          nights: booking?.nights,
          nightlyRates: booking?.nightlyRates,
          stayKey: booking?.stayKey,
        })),
        null,
        2,
      ),
    );

 // Group hotels by provider and skip bookings that are already successful in DB.
    const normalizedHotelBookings = providerHotelBookings.map((hotel) => ({
      ...hotel,
      __provider: String(hotel?.provider || '').trim().toLowerCase(),
    }));

    const { pendingBookings, alreadyConfirmedResults } =
      await this.filterAlreadySuccessfulBookings(baseResult.itinerary_plan_ID, normalizedHotelBookings);

    const tboHotels = pendingBookings.filter((h) => h.__provider === 'tbo');
    const resavenueHotels = pendingBookings.filter((h) => h.__provider === 'resavenue');
    const hobseHotels = pendingBookings.filter((h) => h.__provider === 'hobse');
    const axisroomsHotels = pendingBookings.filter((h) => h.__provider === 'axisrooms');
    const staahHotels = pendingBookings.filter((h) => h.__provider === 'staah');

 console.log(
      '[CONFIRM_QUOTATION_DEBUG] [Hotel Booking] Total:',
      normalizedHotelBookings.length,
      'Already success:',
      alreadyConfirmedResults.length,
      'Pending:',
      pendingBookings.length,
    );
 console.log('[CONFIRM_QUOTATION_DEBUG] Provider counts -> TBO:', tboHotels.length, 'ResAvenue:', resavenueHotels.length, 'HOBSE:', hobseHotels.length, 'AxisRooms:', axisroomsHotels.length, 'STAAH:', staahHotels.length);

    const allBookingResults: any[] = [...alreadyConfirmedResults];

    try {
 // Process TBO hotels if any
      if (tboHotels.length > 0) {
 console.log('[TBO Booking] Processing', tboHotels.length, 'hotel(s)');
        const selections = tboHotels.map((hotel) => ({
        routeId: hotel.routeId,
        selection: {
          hotelCode: hotel.hotelCode,
          bookingCode: hotel.bookingCode,
          roomType: hotel.roomType,
          checkInDate: hotel.checkInDate,
          checkOutDate: hotel.checkOutDate,
          numberOfRooms: hotel.numberOfRooms,
          guestNationality: hotel.guestNationality,
          netAmount: hotel.netAmount,
          searchInitiatedAt: (hotel as any).searchInitiatedAt,
          prebookContext: (hotel as any).prebookContext,
          occupancies: hotel.occupancies?.map((occ) => ({
            adults: occ.adults,
            children: occ.children,
            childrenAges: occ.childrenAges,
          })),
          passengers: hotel.passengers.map((p) => ({
            title: p.title,
            firstName: p.firstName,
            middleName: p.middleName,
            lastName: p.lastName,
            email: p.email,
            paxType: p.paxType,
            leadPassenger: p.leadPassenger,
            age: p.age,
            passportNo: p.passportNo,
            passportIssueDate: p.passportIssueDate,
            passportExpDate: p.passportExpDate,
            phoneNo: p.phoneNo,
            gstNumber: p.gstNumber,
            gstCompanyName: p.gstCompanyName,
            pan: p.pan || p.panNo,
          })),
        },
      }));

 // Call TBO booking service with group_type
        const tboBookingResults = await this.tboHotelBooking.confirmItineraryHotels(
          baseResult.confirmed_itinerary_plan_ID,
          baseResult.itinerary_plan_ID,
          selections,
          endUserIp || dto.endUserIp || process.env.TBO_END_USER_IP || '134.209.145.185',
          userId,
 Number(dto.hotel_group_type) || 1, // Pass the group_type
        );
        allBookingResults.push(
          ...tboBookingResults.map((result: any) => ({
            ...result,
            provider: String(result?.provider || 'tbo').trim().toLowerCase(),
          })),
        );
      }

 // Process ResAvenue hotels if any
      if (resavenueHotels.length > 0) {
 console.log('[ResAvenue Booking] Processing', resavenueHotels.length, 'hotel(s)');

        const resavenueSelections = resavenueHotels.map((hotel) => {
 // Note: invCode and rateCode should ideally be fetched from hotel detail table
 // For now, using fallback values that allow Rate Fetch API to be called
          const invCode = 1;
 const rateCode = 524; // Fallback rate code for Testing

 console.log(
            `[ResAvenue] Hotel ${hotel.hotelCode}: Using InvCode=${invCode}, RateCode=${rateCode}`,
          );

          return {
            routeId: hotel.routeId,
            selection: {
              hotelCode: hotel.hotelCode,
              bookingCode: hotel.bookingCode,
              roomType: hotel.roomType,
              checkInDate: hotel.checkInDate,
              checkOutDate: hotel.checkOutDate,
              numberOfRooms: hotel.numberOfRooms,
              guestNationality: hotel.guestNationality,
              netAmount: hotel.netAmount,
              guests: hotel.passengers.map((p) => ({
                firstName: p.firstName,
                lastName: p.lastName,
                email: p.email,
                phone: p.phoneNo,
              })),
            },
            invCode: invCode,
            rateCode: rateCode,
          };
        });

 // Call ResAvenue booking service
        const resavenueBookingResults = await this.resavenueHotelBooking.confirmItineraryHotels(
          baseResult.confirmed_itinerary_plan_ID,
          baseResult.itinerary_plan_ID,
          resavenueSelections,
          userId,
        );
        allBookingResults.push(
          ...resavenueBookingResults.map((result: any) => ({
            ...result,
            provider: String(result?.provider || 'resavenue').trim().toLowerCase(),
          })),
        );
      }

 // Process HOBSE hotels if any
      if (hobseHotels.length > 0) {
 console.log('[HOBSE Booking] Processing', hobseHotels.length, 'hotel(s)');

 // Call HOBSE booking service
        const hobseBookingResults = await this.hobseHotelBooking.confirmItineraryHotels(
          baseResult.itinerary_plan_ID,
          hobseHotels,
          {
            salutation:
              normalizePassengerTitle(
                (dto as any).primary_guest_salutation,
                (dto as any).title,
                providerHotelBookings?.[0]?.passengers?.find((p) => p.leadPassenger)?.title,
              ) || '',
            name: (dto as any).contactName || 'Guest',
            email: (dto as any).contactEmail || '',
            phone: (dto as any).contactPhone || '',
          }
        );
        allBookingResults.push(
          ...hobseBookingResults.map((result: any) => ({
            ...result,
            provider: String(result?.provider || 'hobse').trim().toLowerCase(),
          })),
        );
      }

 // Process AxisRooms hotels if any (outbound push to AxisRooms endpoint)
      if (axisroomsHotels.length > 0) {
 console.log('[AxisRooms Booking Push] Processing', axisroomsHotels.length, 'hotel(s)');

        const axisroomsPushResults = [];
        const processedAxisStayKeys = new Set<string>();
        for (const hotel of axisroomsHotels) {
          const stayKey = String(
            hotel?.stayKey ||
            `axisrooms:${hotel?.hotelCode || ''}:${hotel?.roomId || ''}:${hotel?.rateId || ''}:${hotel?.checkInDate || ''}_${hotel?.checkOutDate || ''}`,
          ).trim();
          if (hotel?.multiNightBooking && processedAxisStayKeys.has(stayKey)) {
            continue;
          }
          if (hotel?.multiNightBooking) {
            processedAxisStayKeys.add(stayKey);
          }

          const pushResult = await this.axisroomsBookingPushService.pushForHotelSelection({
            bookingStatus: 'confirmed',
            confirmedItineraryPlanId: baseResult.confirmed_itinerary_plan_ID,
            itineraryPlanId: baseResult.itinerary_plan_ID,
            hotel,
            fallbackBookedBy: (dto as any)?.primary_guest_name || 'DVI User',
            fallbackEmail: (dto as any)?.primary_guest_email_id || '',
            fallbackPhone: (dto as any)?.primary_guest_contact_no || '',
          });

          axisroomsPushResults.push({
            provider: 'axisrooms',
            routeId: hotel.routeId,
            hotelCode: hotel.hotelCode,
            ...pushResult,
          });
        }

        allBookingResults.push(...axisroomsPushResults);
      }

      if (staahHotels.length > 0) {
 console.log('[STAAH Booking Push] Processing', staahHotels.length, 'hotel(s)');
        const processedStaahStayKeys = new Set<string>();
        const staahBookingResults =
          await this.staahBookingPushService.confirmItineraryHotels({
            confirmedItineraryPlanId: baseResult.confirmed_itinerary_plan_ID,
            itineraryPlanId: baseResult.itinerary_plan_ID,
            hotels: staahHotels.filter((hotel: any) => {
              const stayKey = String(
                hotel?.stayKey ||
                `staah:${hotel?.hotelCode || ''}:${hotel?.roomId || ''}:${hotel?.rateId || ''}:${hotel?.checkInDate || ''}_${hotel?.checkOutDate || ''}`,
              ).trim();
              if (hotel?.multiNightBooking && processedStaahStayKeys.has(stayKey)) {
                return false;
              }
              if (hotel?.multiNightBooking) {
                processedStaahStayKeys.add(stayKey);
              }
              return true;
            }),
            fallbackBookedBy: (dto as any)?.primary_guest_name || 'DVI User',
            fallbackEmail: (dto as any)?.primary_guest_email_id || '',
            fallbackPhone: (dto as any)?.primary_guest_contact_no || '',
          });
        allBookingResults.push(...staahBookingResults);
      }

      const successKeySet = new Set(
        allBookingResults
          .filter((r) => this.isBookingResultSuccess(r))
          .flatMap((r) => {
            const provider = String(r?.provider || '').trim().toLowerCase();
            const routeIds = Array.isArray(r?.routeIds) && r.routeIds.length > 0
              ? r.routeIds
              : [Number(r?.routeId || 0)];
            return routeIds
              .map((routeId: any) => Number(routeId || 0))
              .filter((routeId: number) => Number.isFinite(routeId) && routeId > 0)
              .map((routeId: number) => this.bookingKey(provider, routeId));
          }),
      );

      const pendingAfterAttempt = normalizedHotelBookings
        .filter((b) => !successKeySet.has(this.bookingKey(b.__provider, Number(b.routeId || 0))))
        .map((b) => ({
          provider: b.__provider,
          routeId: Number(b.routeId || 0),
          hotelCode: String(b.hotelCode || ''),
          hotelName: String(b.hotelName || ''),
        }));

 console.log('[CONFIRM_QUOTATION_DEBUG] Final bookingResults before response:', JSON.stringify(allBookingResults, null, 2));

      if (pendingAfterAttempt.length > 0) {
        throw new BadRequestException({
          message: 'Partial booking success. Quotation remains unconfirmed. Retry will target only unsuccessful bookings.',
          itinerary_plan_ID: baseResult.itinerary_plan_ID,
          confirmed_itinerary_plan_ID: baseResult.confirmed_itinerary_plan_ID,
          bookingResults: allBookingResults,
          pendingBookings: pendingAfterAttempt,
        });
      }

      await this.finalizeConfirmationFinancials(baseResult, dto, userId);

      await this.prisma.dvi_itinerary_plan_details.update({
        where: { itinerary_plan_ID: baseResult.itinerary_plan_ID },
        data: {
          quotation_status: 1,
          updatedon: new Date(),
        },
      });

      await this.prisma.dvi_confirmed_itinerary_plan_details.update({
        where: {
          confirmed_itinerary_plan_ID: baseResult.confirmed_itinerary_plan_ID,
        },
        data: {
          status: 1,
          updatedon: new Date(),
        },
      });

      const confirmedHotelDetails = await this.getConfirmedItineraryDetails(
        Number(baseResult.confirmed_itinerary_plan_ID),
      );

      return {
        ...baseResult,
        success: true,
        message: 'Quotation confirmed successfully. All provider bookings succeeded.',
        bookingResults: allBookingResults,
        confirmedHotelDetails,
      };
    } catch (error) {
 console.error('[CONFIRM_QUOTATION_DEBUG] Error processing hotel bookings:', error);
 console.error('[STAAH_BOOKING_DEBUG] Error details:', {
        message: error?.message,
        status: error?.response?.status,
        body: error?.response?.data,
      });
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException({
        message: error.message || 'Hotel booking processing failed',
        itinerary_plan_ID: baseResult.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: baseResult.confirmed_itinerary_plan_ID,
      });
    }
  }

}
