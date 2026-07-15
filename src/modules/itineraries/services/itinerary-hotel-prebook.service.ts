// FILE: src/modules/itineraries/services/itinerary-hotel-prebook.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ConfirmQuotationDto } from '../dto/confirm-quotation.dto';
import { TboHotelBookingService } from './tbo-hotel-booking.service';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import { SupplementNormalizerService } from '../../../modules/hotels/services/supplement-normalizer.service';

type HotelPrebookCallbacks = Partial<Record<
  'normalizeToArray'
  | 'normalizeToUniqueStrings'
  | 'inferMealPlanFromInclusions'
  | 'getProviderBookableHotelBookings',
  (...args: any[]) => any
>>;


@Injectable()
export class ItineraryHotelPrebookService {
  private callbacks: HotelPrebookCallbacks = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly tboHotelBooking: TboHotelBookingService,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
    private readonly supplementNormalizer: SupplementNormalizerService,
  ) {}

  setCallbacks(callbacks: HotelPrebookCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private call(name: keyof HotelPrebookCallbacks, ...args: any[]) {
    const callback = this.callbacks[name];
    if (!callback) {
      throw new Error(`Hotel prebook callback is not configured: ${String(name)}`);
    }
    return callback(...args);
  }

  private normalizeToArray(...args: any[]) { return this.call('normalizeToArray', ...args); }
  private normalizeToUniqueStrings(...args: any[]) { return this.call('normalizeToUniqueStrings', ...args); }
  private inferMealPlanFromInclusions(...args: any[]) { return this.call('inferMealPlanFromInclusions', ...args); }
  private getProviderBookableHotelBookings(...args: any[]) { return this.call('getProviderBookableHotelBookings', ...args); }

  async prebookHotels(payload: {
    itinerary_plan_ID: number;
    hotel_bookings: Array<{
      routeId: number;
      provider: string;
      hotelCode: string;
      hotelName?: string;
      bookingCode: string;
      roomType: string;
      checkInDate: string;
      checkOutDate: string;
      numberOfRooms: number;
      guestNationality: string;
      netAmount: number;
      searchInitiatedAt?: string;
      occupancies?: Array<{
        adults: number;
        children: number;
        childrenAges?: number[];
      }>;
      passengers: Array<{
        title: string;
        firstName: string;
        middleName?: string;
        lastName: string;
        email?: string;
        paxType: number;
        leadPassenger: boolean;
        age: number;
        pan?: string;
        panNo?: string;
        passportNo?: string;
        passportIssueDate?: string;
        passportExpDate?: string;
        phoneNo?: string;
        gstNumber?: string;
        gstCompanyName?: string;
      }>;
    }>;
    endUserIp?: string;
  }) {
    const incomingHotelBookings = payload?.hotel_bookings || [];
    const providerHotelBookings = this.getProviderBookableHotelBookings(incomingHotelBookings);
    const skippedExternalStayCount = incomingHotelBookings.length - providerHotelBookings.length;

    if (incomingHotelBookings.length === 0 || providerHotelBookings.length === 0) {
      return {
        success: true,
        message: 'No supplier-bookable hotels selected for prebook',
        itinerary_plan_ID: payload?.itinerary_plan_ID,
        hotels: [],
        skippedExternalStayCount,
        updatedTotalPrice: 0,
        finalPrice: 0,
        totalAmount: 0,
        cancellationPolicy: null,
        cancellationPoliciesText: null,
        roomPromotion: null,
        rateConditions: [],
        mandatorySupplements: [],
        normalizedSupplements: [],
      };
    }

    const tboHotels = providerHotelBookings.filter(
      (hotel) => String(hotel.provider || '').toLowerCase() === 'tbo',
    );

    if (tboHotels.length === 0) {
      return {
        success: true,
        message: 'No TBO hotels selected for prebook',
        itinerary_plan_ID: payload.itinerary_plan_ID,
        hotels: [],
        skippedExternalStayCount,
        updatedTotalPrice: 0,
        finalPrice: 0,
        totalAmount: 0,
        cancellationPolicy: null,
        cancellationPoliciesText: null,
        roomPromotion: null,
        rateConditions: [],
        mandatorySupplements: [],
        normalizedSupplements: [], // ✅ NEW
      };
    }

    const prebookResults: any[] = [];

    for (const hotel of tboHotels) {
      const resolvedBookingCode = await this.resolvePrebookBookingCode(
        payload.itinerary_plan_ID,
        hotel,
      );

      const selection = {
        hotelCode: hotel.hotelCode,
        bookingCode: resolvedBookingCode,
        roomType: hotel.roomType,
        checkInDate: hotel.checkInDate,
        checkOutDate: hotel.checkOutDate,
        numberOfRooms: hotel.numberOfRooms,
        guestNationality: hotel.guestNationality,
        netAmount: hotel.netAmount,
        searchInitiatedAt: hotel.searchInitiatedAt,
        occupancies: hotel.occupancies,
        passengers: (hotel.passengers || []).map((p) => ({
          title: p.title,
          firstName: p.firstName,
          middleName: p.middleName,
          lastName: p.lastName,
          email: p.email,
          paxType: p.paxType,
          leadPassenger: p.leadPassenger,
          age: p.age,
          pan: p.pan || p.panNo,
          passportNo: p.passportNo,
          passportIssueDate: p.passportIssueDate,
          passportExpDate: p.passportExpDate,
          phoneNo: p.phoneNo,
          gstNumber: p.gstNumber,
          gstCompanyName: p.gstCompanyName,
        })),
      };

      const prebookResponse = await this.tboHotelBooking.preBookHotel(selection as any);
      const prebookRequestPayload = (prebookResponse as any)?.__requestPayload || null;
      const rawRoomDetails = [
        ...this.normalizeToArray(prebookResponse?.HotelRoomsDetails),
        ...this.normalizeToArray(prebookResponse?.HotelResult)
          .flatMap((hotelResult: any) => this.normalizeToArray(hotelResult?.Rooms)),
      ].filter(Boolean);

      const prebookCancelPoliciesDebug = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.CancelPolicies ?? room?.CancellationPolicy))
        .filter(Boolean);
      console.log(
        '[ItinerariesService] 📥 PreBook API room snapshot:',
        JSON.stringify({
          routeId: hotel.routeId,
          hotelCode: hotel.hotelCode,
          status: prebookResponse?.Status,
          bookingCode: prebookResponse?.BookingCode || hotel.bookingCode,
          roomCount: rawRoomDetails.length,
          cancelPoliciesCount: prebookCancelPoliciesDebug.length,
          sampleCancelPolicy: prebookCancelPoliciesDebug[0] || null,
        }),
      );
      console.log(
        '[ItinerariesService] 📥 Full PreBook API response:',
        JSON.stringify(prebookResponse),
      );
      
      // Extract raw mandatory supplements
      const mandatorySupplements = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.MandatorySupplements ?? room?.MandatorySupplement))
        .filter(Boolean);
      
      // ✅ Extract raw supplements if present
      const rawSupplements = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.Supplements))
        .filter(Boolean);

      // ✅ Normalize all supplements for display
      const normalizedMandatorySupplements = this.supplementNormalizer.normalizeSupplements(
        mandatorySupplements,
        'prebook',
      );
      const normalizedSupplements = this.supplementNormalizer.normalizeSupplements(
        rawSupplements,
        'prebook',
      );
      const allNormalizedSupplements = [
        ...normalizedMandatorySupplements,
        ...normalizedSupplements,
      ];

      const hotelLevelResults = this.normalizeToArray(prebookResponse?.HotelResult);

      const roomPromotions = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) => this.normalizeToArray(room?.RoomPromotion ?? room?.RoomPromotions)),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(hotelResult?.RoomPromotion ?? hotelResult?.RoomPromotions),
        ),
      ]);
      const rateConditions = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.RateConditions ?? room?.rateConditions ?? room?.RateCondition),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.RateConditions ??
              hotelResult?.rateConditions ??
              hotelResult?.RateCondition ??
              hotelResult?.rateCondition,
          ),
        ),
      ]);
      const cancellationPolicies = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.CancelPolicies ?? room?.CancellationPolicy),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(hotelResult?.CancelPolicies ?? hotelResult?.CancellationPolicy),
        ),
      ]);
      const inclusions = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.Inclusion ?? room?.Inclusions ?? room?.inclusion ?? room?.inclusions),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.Inclusion ??
              hotelResult?.Inclusions ??
              hotelResult?.inclusion ??
              hotelResult?.inclusions,
          ),
        ),
      ]);
      const amenities = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.Amenities ?? room?.amenities ?? room?.Amenity),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.Amenities ?? hotelResult?.amenities ?? hotelResult?.Amenity ?? hotelResult?.facilities,
          ),
        ),
      ]);

      const mealTypeCandidates = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(
            room?.MealTypeName ??
              room?.MealType ??
              room?.mealTypeName ??
              room?.mealType ??
              room?.BoardBasis ??
              room?.boardBasis,
          ),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.MealTypeName ??
              hotelResult?.MealType ??
              hotelResult?.mealTypeName ??
              hotelResult?.mealType ??
              hotelResult?.BoardBasis ??
              hotelResult?.boardBasis,
          ),
        ),
      ]);
      const mealType = mealTypeCandidates[0] || this.inferMealPlanFromInclusions(inclusions) || null;

      const candidatePrices = [
        prebookResponse?.NetAmount,
        prebookResponse?.TotalFare,
        prebookResponse?.PriceVerification?.FinalPrice,
        ...rawRoomDetails.map((room: any) => room?.TotalFare),
      ];
      const finalPriceCandidate = candidatePrices.find(
        (price) => typeof price === 'number' || (typeof price === 'string' && price !== ''),
      );
      const finalPrice = finalPriceCandidate !== undefined ? Number(finalPriceCandidate) : 0;

      const prebookNetAmountCandidates = [
        prebookResponse?.NetAmount,
        ...rawRoomDetails.map((room: any) => room?.NetAmount),
      ];
      const prebookNetAmountCandidate = prebookNetAmountCandidates.find(
        (price) => typeof price === 'number' || (typeof price === 'string' && price !== ''),
      );
      const prebookNetAmount =
        prebookNetAmountCandidate !== undefined ? Number(prebookNetAmountCandidate) : null;

      prebookResults.push({
        routeId: hotel.routeId,
        hotelCode: hotel.hotelCode,
        hotelName: hotel.hotelName || null,
        bookingCode: prebookResponse?.BookingCode || hotel.bookingCode,
        updatedTotalPrice: finalPrice,
        finalPrice,
        totalAmount: finalPrice,
        cancellationPolicy: cancellationPolicies,
        cancellationPoliciesText: cancellationPolicies.length
          ? JSON.stringify(cancellationPolicies)
          : null,
        roomPromotion: roomPromotions.length ? roomPromotions.join(', ') : null,
        rateConditions,
        inclusions,
        amenities,
        mealType,
        mealPlan: mealType,
        mandatorySupplements,
        // ✅ NEW: include normalized supplements
        normalizedSupplements: allNormalizedSupplements,
        supplements: rawSupplements,
        isPriceChanged: Boolean(prebookResponse?.IsPriceChanged),
        isCancellationPolicyChanged: Boolean(prebookResponse?.IsCancellationPolicyChanged),
        rawStatus: prebookResponse?.Status,
        prebookContext: {
          hotelName: hotel.hotelName || null,
          bookingCode: prebookResponse?.BookingCode || hotel.bookingCode,
          traceId: prebookResponse?.TraceId || '',
          finalPrice,
          prebookNetAmount,
          isPriceChanged: Boolean(prebookResponse?.IsPriceChanged),
          isCancellationPolicyChanged: Boolean(prebookResponse?.IsCancellationPolicyChanged),
          cancellationPolicy: cancellationPolicies,
          cancellationPoliciesText: cancellationPolicies.length
            ? JSON.stringify(cancellationPolicies)
            : null,
          roomPromotion: roomPromotions.length ? roomPromotions.join(', ') : null,
          rateConditions,
          inclusions,
          amenities,
          mealType,
          mandatorySupplements,
          supplements: rawSupplements,
          normalizedSupplements: allNormalizedSupplements,
          rawStatus: prebookResponse?.Status,
        },
        certificationTrace: {
          guestNationality: selection.guestNationality,
          prebookRequest: prebookRequestPayload,
        },
      });
    }

    const totalAmount = prebookResults.reduce(
      (sum, item) => sum + Number(item.finalPrice || item.updatedTotalPrice || 0),
      0,
    );
    const cancellationPoliciesAll = prebookResults.flatMap((item) => item.cancellationPolicy || []);
    const roomPromotionsAll = prebookResults
      .flatMap((item) => (item.roomPromotion ? [item.roomPromotion] : []))
      .filter(Boolean);
    const rateConditionsAll = prebookResults.flatMap((item) => item.rateConditions || []);
    const inclusionsAll = prebookResults.flatMap((item) => item.inclusions || []);
    const amenitiesAll = prebookResults.flatMap((item) => item.amenities || []);
    const mandatorySupplementsAll = prebookResults.flatMap((item) => item.mandatorySupplements || []);
    // ✅ NEW: Extract normalized supplements from prebook results
    const normalizedSupplementsAll = prebookResults.flatMap((item) => item.normalizedSupplements || []);

    return {
      success: true,
      message: `Prebook completed for ${prebookResults.length} hotel(s)`,
      itinerary_plan_ID: payload.itinerary_plan_ID,
      hotels: prebookResults,
      skippedExternalStayCount,
      updatedTotalPrice: totalAmount,
      finalPrice: totalAmount,
      totalAmount,
      cancellationPolicy: cancellationPoliciesAll.length
        ? JSON.stringify(cancellationPoliciesAll)
        : null,
      cancellationPoliciesText: cancellationPoliciesAll.length
        ? JSON.stringify(cancellationPoliciesAll)
        : null,
      roomPromotion: roomPromotionsAll.length ? roomPromotionsAll.join(', ') : null,
      rateConditions: rateConditionsAll,
      inclusions: this.normalizeToUniqueStrings(inclusionsAll),
      amenities: this.normalizeToUniqueStrings(amenitiesAll),
      mandatorySupplements: mandatorySupplementsAll,
      // ✅ NEW: include normalized supplements for frontend display
      normalizedSupplements: normalizedSupplementsAll,
    };
  }

  private async resolvePrebookBookingCode(
    itineraryPlanId: number,
    hotel: {
      routeId: number;
      hotelCode: string;
      bookingCode?: string;
      roomType?: string;
    },
  ): Promise<string> {
    const incomingBookingCode = String(hotel.bookingCode || '').trim();
    if (incomingBookingCode.includes('!TB!')) {
      return incomingBookingCode;
    }

    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: itineraryPlanId },
      select: { itinerary_quote_ID: true },
    });

    const quoteId = String((plan as any)?.itinerary_quote_ID || '').trim();
    if (!quoteId) {
      throw new BadRequestException(
        'Unable to resolve itinerary quote for fresh hotel room validation. Please refresh hotel search and try prebook again.',
      );
    }

    // Force a fresh room search to avoid stale cached booking codes.
    this.hotelDetailsTboService.clearCacheForQuote(quoteId);
    const roomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
      quoteId,
      Number(hotel.routeId),
    );

    const hotelCode = String(hotel.hotelCode || '').trim();
    const requestedRoomType = String(hotel.roomType || '').trim().toLowerCase();

    const matchingRooms = (roomDetails?.rooms || []).filter(
      (room: any) =>
        Number(room.itineraryRouteId) === Number(hotel.routeId) &&
        String(room.hotelId || '') === hotelCode,
    );

    if (matchingRooms.length === 0) {
      throw new BadRequestException(
        'No fresh room options found for selected hotel. Please run hotel search again and select a room before prebook.',
      );
    }

    const roomTypeMatch = requestedRoomType
      ? matchingRooms.find((room: any) => {
          const roomTypeName = String(room.roomTypeName || '').toLowerCase();
          if (roomTypeName && roomTypeName === requestedRoomType) {
            return true;
          }

          const availableRoomTypes = Array.isArray(room.availableRoomTypes)
            ? room.availableRoomTypes
            : [];
          return availableRoomTypes.some(
            (rt: any) =>
              String(rt.roomTypeTitle || '').toLowerCase() === requestedRoomType,
          );
        })
      : undefined;

    const selectedRoom = roomTypeMatch || matchingRooms[0];
    const selectedBookingCode =
      String(selectedRoom?.bookingCode || '').trim() ||
      String(selectedRoom?.availableRoomTypes?.[0]?.bookingCode || '').trim();

    if (!selectedBookingCode || !selectedBookingCode.includes('!TB!')) {
      throw new BadRequestException(
        'Fresh room booking code not available for selected hotel. Please refresh hotel selection and prebook again.',
      );
    }

    return selectedBookingCode;
  }

  /**
   * After transaction completes, handle hotel bookings for all providers
   * This is done outside transaction to avoid locking issues with external API calls
   */
}

