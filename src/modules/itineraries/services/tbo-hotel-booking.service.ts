import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotelSearchService } from '../../hotels/services/hotel-search.service';
import { TBOHotelProvider } from '../../hotels/providers/tbo-hotel.provider';
import { SupplementNormalizerService } from '../../hotels/services/supplement-normalizer.service';
import axios, { AxiosInstance } from 'axios';
import {
  normalizePassengerTitle,
  resolveProviderPassengerTitle,
} from '../../../common/utils/passenger-title.util';

interface TboHotelSelection {
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
  passengers: TboHotelPassenger[];
  occupancies?: TboRoomOccupancy[];
  prebookContext?: Record<string, any>;
}

interface TboRoomOccupancy {
  adults: number;
  children: number;
  childrenAges?: number[];
}

interface TboHotelPassenger {
  title: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  email?: string;
  paxType: number; // 1 = Adult, 2 = Child
  leadPassenger: boolean;
  age: number;
  passportNo?: string;
  passportIssueDate?: string;
  passportExpDate?: string;
  phoneNo?: string;
  gstNumber?: string;
  gstCompanyName?: string;
  pan?: string;
}

interface PreBookResponse {
  Status: number | { Code?: number; Description?: string };
  Message?: string;
  TraceId?: string;
  Token?: string;
  BookingCode?: string;
  HotelCode?: string;
  HotelRoomsDetails?: any[];
  PriceVerification?: any;
  IsPriceChanged?: boolean;
  IsCancellationPolicyChanged?: boolean;
  [key: string]: any;
}

interface BookResponse {
  BookResult: {
    TBOReferenceNo: string | null;
    VoucherStatus: boolean;
    ResponseStatus: number;
    Error: {
      ErrorCode: number;
      ErrorMessage: string;
    };
    TraceId: string;
    Status: number;
    HotelBookingStatus: string | null;
    ConfirmationNo: string | null;
    BookingRefNo: string | null;
    BookingId: number;
    IsPriceChanged: boolean;
    IsCancellationPolicyChanged: boolean;
    [key: string]: any;
  };
  meta?: {
    recoveredFromTimeout?: boolean;
    recoveryMessage?: string;
    tokenId?: string;
    requestPayload?: Record<string, any>;
  };
}

interface TboAuthResponse {
  Status: number;
  TokenId?: string;
  Error?: {
    ErrorCode?: number;
    ErrorMessage?: string;
  };
  [key: string]: any;
}

interface TboCancellationBookingRow {
  tbo_hotel_booking_confirmation_ID: number;
  itinerary_route_ID: number | null;
  tbo_booking_id: string;
  tbo_booking_reference_number: string | null;
  api_response: Record<string, any> | null;
}

const normalizeMealTypeLabel = (value: any, inclusionFallbacks: any[] = []): string | null => {
  const raw = String(value ?? '').trim();
  const fallbackText = inclusionFallbacks
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  const haystack = `${raw} ${fallbackText}`.trim().toUpperCase();

  if (!haystack) return null;
  if (raw === '1' || haystack.includes('BREAKFAST') || haystack.includes('CONTINENTAL PLAN')) return 'Breakfast';
  if (raw === '2' || haystack.includes('LUNCH')) return 'Lunch';
  if (raw === '3' || haystack.includes('DINNER')) return 'Dinner';
  if (haystack.includes('FULL BOARD') || haystack.includes('ALL MEALS') || haystack.includes('AMERICAN PLAN')) {
    return 'Breakfast, Lunch, Dinner';
  }
  if (haystack.includes('HALF BOARD') || haystack.includes('MODIFIED AMERICAN PLAN')) {
    return 'Breakfast + 1 Meal';
  }
  if (haystack.includes('ROOM ONLY') || haystack.includes('EUROPEAN PLAN') || haystack.includes('NO MEAL')) {
    return 'Room Only';
  }

  return raw || null;
};

@Injectable()
export class TboHotelBookingService {
  private static readonly MAX_ROOMS = 6;
  private static readonly MAX_ADULTS_PER_ROOM = 8;
  private static readonly MAX_CHILDREN_PER_ROOM = 4;
  private static readonly SEARCH_SESSION_VALIDITY_MS = 35 * 60 * 1000;
  private readonly logger = new Logger(TboHotelBookingService.name);
  private readonly client: AxiosInstance;
  private tokenId: string | null = null;
  private tokenExpiry: Date | null = null;
  private readonly authTokenTtlMs = 10 * 60 * 1000;

  private readonly TBO_USERNAME = process.env.TBO_API_USERNAME || process.env.TBO_USERNAME || 'Doview';
  private readonly TBO_PASSWORD = process.env.TBO_API_PASSWORD || process.env.TBO_PASSWORD || 'Doview@12345';
  private readonly TBO_CLIENT_ID = process.env.TBO_CLIENT_ID || 'ApiIntegrationNew';
  private readonly AUTH_URL = 'https://sharedapi.tektravels.com/SharedData.svc/rest/Authenticate';
  private readonly PREBOOK_URL = 'https://affiliate.tektravels.com/HotelAPI/PreBook';
  private readonly BOOK_URL = 'https://hotelbe.tektravels.com/hotelservice.svc/rest/book';
  private readonly USE_MOCK_TBO = process.env.TBO_USE_MOCK === 'true' || false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelSearchService: HotelSearchService,
    private readonly tboProvider: TBOHotelProvider,
    private readonly supplementNormalizer: SupplementNormalizerService,
  ) {
    // Create axios client with explicit Authorization header (not auth object)
    const credentials = Buffer.from(`${this.TBO_USERNAME}:${this.TBO_PASSWORD}`).toString('base64');
    
    this.client = axios.create({
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${credentials}`,
      },
    });

    if (this.USE_MOCK_TBO) {
      this.logger.warn('⚠️  TBO_USE_MOCK is enabled - Using mock TBO responses');
    }
  }

  /**
   * Execute PreBook API call for TBO hotel
   * This confirms the room availability and locks the price
   */
  async preBookHotel(
    selection: TboHotelSelection,
  ): Promise<PreBookResponse> {
    try {
      this.validateSelection(selection, true);
      this.logger.log(
        `🏨 PreBook: Hotel ${selection.hotelCode}, Booking Code: ${selection.bookingCode}`,
      );
      this.logger.log(
        `📤 PreBook Payload: BookingCode=${selection.bookingCode}, PaymentMode=Limit`,
      );

      // Check if using mock mode for development
      if (this.USE_MOCK_TBO) {
        return this.generateMockPreBookResponse(selection);
      }

      const payload = {
        BookingCode: selection.bookingCode,
        PaymentMode: 'Limit',
      };

      this.logger.log(`📤 Full PreBook Payload (JSON): ${JSON.stringify(payload)}`);

      const response = await this.client.post<PreBookResponse>(
        this.PREBOOK_URL,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.data) {
        this.logger.error('❌ PreBook response.data is undefined');
        throw new BadRequestException('PreBook response is empty or undefined');
      }

      const prebookRooms = this.collectPreBookRooms(response.data);
      const prebookCancelPolicies = prebookRooms
        .flatMap((room: any) => this.normalizeToArray(room?.CancelPolicies ?? room?.CancellationPolicy))
        .filter(Boolean);
      const prebookSnapshot = {
        status: response.data?.Status,
        message: response.data?.Message,
        bookingCode: response.data?.BookingCode,
        roomCount: prebookRooms.length,
        cancelPoliciesCount: prebookCancelPolicies.length,
        sampleCancelPolicy: prebookCancelPolicies[0] || null,
      };
      this.logger.log(`📥 PreBook API snapshot: ${JSON.stringify(prebookSnapshot)}`);
      this.logger.log(`📥 PreBook API raw response: ${JSON.stringify(response.data)}`);

      (response.data as any).__requestPayload = payload;

      // Handle TBO status response - it can be a number or object with Code/Description
      const statusCode = typeof response.data.Status === 'object' && response.data.Status
        ? (response.data.Status as any).Code 
        : response.data.Status;
      
      const statusMessage = typeof response.data.Status === 'object' && response.data.Status
        ? (response.data.Status as any).Description || response.data.Message
        : response.data.Message;

      // TBO PreBook uses Status.Code = 200 for success, other endpoints use Status.Code = 1
      if (statusCode !== 1 && statusCode !== 200) {
        const message = statusMessage || 'Unknown TBO error';
        const maybeSessionExpired = this.isSessionExpiredError(
          `${message} ${JSON.stringify(response.data || {})}`,
        );
        if (maybeSessionExpired) {
          throw new BadRequestException(
            'This hotel session has expired or rates changed. Please refresh hotel selection and run prebook again.',
          );
        }
        this.logger.error(`❌ PreBook Status Code=${statusCode}: ${JSON.stringify(response.data)}`);
        throw new BadRequestException(
          `PreBook failed: ${message}`,
        );
      }

      this.logger.log(`✅ PreBook successful: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error: any) {
      // Extract meaningful error message
      let errorMsg = 'Unknown error';
      
      if (error instanceof BadRequestException) {
        throw error; // Re-throw our own exceptions
      }
      
      if (error?.response?.data?.Message) {
        errorMsg = error.response.data.Message;
      } else if (error?.response?.data) {
        errorMsg = `TBO API Error: ${JSON.stringify(error.response.data)}`;
      } else if (error?.message) {
        errorMsg = error.message;
      } else if (typeof error === 'string') {
        errorMsg = error;
      }
      
      const statusCode = error?.response?.status;
      
      this.logger.error(`❌ PreBook error: ${errorMsg}`);
      if (statusCode) {
        this.logger.error(`   HTTP Status: ${statusCode}`);
      }

      if (this.isSessionExpiredError(errorMsg)) {
        throw new BadRequestException(
          'This hotel session has expired or rates changed. Please refresh hotel selection and run prebook again.',
        );
      }
      
      throw new BadRequestException(
        `PreBook failed for hotel ${selection.hotelCode}: ${errorMsg}`,
      );
    }
  }

  /**
   * Execute Book API call to confirm hotel booking with guest details
   */
  async bookHotel(
    preBookResponse: PreBookResponse,
    selection: TboHotelSelection,
    endUserIp: string = '192.168.1.1',
  ): Promise<BookResponse> {
    try {
      this.validateSelection(selection);

      // Check if using mock mode for development
      if (this.USE_MOCK_TBO) {
        return this.generateMockBookResponse(preBookResponse, selection);
      }

      // Map passengers to TBO format
      const hotelRoomsDetails = this.mapPassengersToRooms(
        selection.passengers,
        selection.numberOfRooms,
        selection.occupancies,
      );

      const prebookBookingCode = String(
        preBookResponse?.BookingCode ||
          preBookResponse?.HotelResult?.[0]?.Rooms?.[0]?.BookingCode ||
          '',
      ).trim();
      if (!prebookBookingCode || !prebookBookingCode.includes('!TB!')) {
        throw new BadRequestException(
          'PreBook did not return a valid BookingCode. Please run a fresh search and prebook again before booking.',
        );
      }

      const tokenId = await this.authenticate(endUserIp);

      const bookingPayload = {
        BookingCode: prebookBookingCode,
        TokenId: tokenId,
        IsVoucherBooking: true,
        GuestNationality: this.normalizeNationality(selection.guestNationality),
        EndUserIp: endUserIp,
        RequestedBookingMode: 1,
        TraceId: preBookResponse?.TraceId || '',
        NetAmount: selection.netAmount,
        HotelRoomsDetails: hotelRoomsDetails,
      };

      this.logger.log(
        `📝 Booking: Hotel ${selection.hotelCode}, Payload: ${JSON.stringify(bookingPayload)}`,
      );

      const response = await this.client.post<BookResponse>(
        this.BOOK_URL,
        bookingPayload,
      );

      (response.data as any).meta = {
        ...(response.data as any).meta,
        tokenId: tokenId,
        requestPayload: bookingPayload,
      };

      // Log full response for debugging
      this.logger.log(`📥 Book API Response: ${JSON.stringify(response.data)}`);

      // Handle TBO status response - Book API returns BookResult.Status (1 for success)
      const bookResult = response.data.BookResult;
      const statusCode = bookResult.Status;
      const responseStatus = bookResult.ResponseStatus;

      // Check ResponseStatus (1 = success, 2 = error) or Status field
      if ((responseStatus && responseStatus !== 1) || (statusCode !== 1 && statusCode !== 200)) {
        const errorMessage = bookResult.Error?.ErrorMessage || 'Unknown error';
        const maybeSessionExpired = this.isSessionExpiredError(
          `${errorMessage} ${JSON.stringify(response.data || {})}`,
        );
        if (maybeSessionExpired) {
          throw new BadRequestException(
            'This hotel session has expired or rates changed. Please refresh hotel selection and run prebook again.',
          );
        }
        this.logger.error(`❌ Book Status Code=${statusCode}, ResponseStatus=${responseStatus}: ${JSON.stringify(response.data)}`);
        throw new BadRequestException(
          `Booking failed: ${errorMessage}`,
        );
      }

      this.logger.log(`✅ Booking successful: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error: any) {
      const timeoutError = error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '');
      if (timeoutError) {
        const recovered = await this.tryRecoverBookingAfterTimeout(error);
        if (recovered) {
          return recovered;
        }
      }

      this.logger.error(`❌ Booking error: ${error.message}`);
      if (error.response) {
        this.logger.error(`❌ Book API Error Response: ${JSON.stringify(error.response.data)}`);
      }

      const errorText = String(
        error?.response?.data?.BookResult?.Error?.ErrorMessage ||
          error?.response?.data?.Error?.ErrorMessage ||
          error?.message ||
          '',
      );

      if (this.isSessionExpiredError(errorText)) {
        throw new BadRequestException(
          'This hotel session has expired or rates changed. Please refresh hotel selection and run prebook again.',
        );
      }

      throw new BadRequestException(
        `Booking failed for hotel ${selection.hotelCode}: ${error.message}`,
      );
    }
  }

  /**
   * Map passengers to TBO hotel rooms format
   * Each room contains the passengers assigned to it
   * 
   * IMPORTANT: TBO requires passenger count to match what was searched
   * If user searched for 2 adults but only provides 1 passenger, duplicate it
   */
  private mapPassengersToRooms(
    passengers: TboHotelPassenger[],
    numberOfRooms: number,
    occupancies?: TboRoomOccupancy[],
  ) {
    const safeRoomCount = Math.max(numberOfRooms || 1, 1);
    const workingPassengers = [...passengers];
    const rooms = [];

    if (occupancies && occupancies.length > 0) {
      const adultsPool = workingPassengers.filter((p) => Number(p.paxType) === 1);
      const childrenPool = workingPassengers.filter((p) => Number(p.paxType) === 2);
      const infantsPool = workingPassengers.filter((p) => Number(p.paxType) === 3);

      const takeFromPool = (pool: TboHotelPassenger[], count: number): TboHotelPassenger[] => {
        const picked = pool.slice(0, Math.max(count, 0));
        pool.splice(0, picked.length);
        return picked;
      };

      // Build each room to exactly match searched occupancies (adults/children per room).
      // This avoids TBO HotelPassenger count mismatch errors caused by raw sequential slicing.
      for (let i = 0; i < occupancies.length; i++) {
        const occ = occupancies[i];
        const adultsNeeded = Math.max(Number(occ.adults || 0), 0);
        const childrenNeeded = Math.max(Number(occ.children || 0), 0);
        const expectedChildAges = (occ.childrenAges || [])
          .map((age) => Number(age))
          .filter((age) => Number.isFinite(age));

        const roomAdults = takeFromPool(adultsPool, adultsNeeded);
        const roomChildren: TboHotelPassenger[] = [];

        // Match child passengers by expected room-wise ages from confirm occupancies
        // so Book payload mirrors what user entered in popup for each room.
        for (let j = 0; j < childrenNeeded; j++) {
          const expectedAge = expectedChildAges[j];
          let matchedIndex = -1;
          if (Number.isFinite(expectedAge)) {
            matchedIndex = childrenPool.findIndex(
              (p) => Number((p as any)?.age) === Number(expectedAge),
            );
          }

          if (matchedIndex < 0) {
            matchedIndex = 0;
          }

          if (matchedIndex >= 0 && childrenPool[matchedIndex]) {
            const [picked] = childrenPool.splice(matchedIndex, 1);
            roomChildren.push(picked);
          }
        }

        const roomPassengers: TboHotelPassenger[] = [...roomAdults, ...roomChildren];

        // Keep room passenger count aligned even if upstream sent less data than occupancy.
        while (roomPassengers.length < adultsNeeded + childrenNeeded) {
          const fallback = adultsPool[0] || childrenPool[0] || infantsPool[0] || workingPassengers[0];
          if (!fallback) break;
          roomPassengers.push({ ...fallback });
        }

        const mappedPassengers = roomPassengers.map((p, idx) => this.mapPassenger(p, idx));
        rooms.push({ HotelPassenger: mappedPassengers });
      }

      return rooms;
    }

    const roomsPerSize = Math.ceil(workingPassengers.length / safeRoomCount);

    for (let i = 0; i < safeRoomCount; i++) {
      const startIdx = i * roomsPerSize;
      const endIdx = Math.min(startIdx + roomsPerSize, workingPassengers.length);
      const roomPassengers = workingPassengers.slice(startIdx, endIdx);

      // Mark first passenger in room as lead
      const mappedPassengers = roomPassengers.map((p, idx) => this.mapPassenger(p, idx));

      rooms.push({
        HotelPassenger: mappedPassengers,
      });
    }

    return rooms;
  }

  private mapPassenger(p: TboHotelPassenger, index: number) {
    return {
      Title: this.resolveTboPassengerTitle(p.title),
      FirstName: p.firstName,
      MiddleName: p.middleName || '',
      LastName: p.lastName,
      Email: p.email || null,
      PaxType: p.paxType,
      LeadPassenger: index === 0 ? true : false,
      Age: p.age,
      PassportNo: p.passportNo || null,
      PassportIssueDate: p.passportIssueDate || null,
      PassportExpDate: p.passportExpDate || null,
      Phoneno: p.phoneNo || null,
      PaxId: 0,
      GSTCompanyAddress: null,
      GSTCompanyContactNumber: null,
      GSTCompanyName: p.gstCompanyName || null,
      GSTNumber: p.gstNumber || null,
      GSTCompanyEmail: null,
      PAN: p.pan || null,
    };
  }

  /**
   * Save TBO booking confirmation to database
   */
  async saveTboBookingConfirmation(
    confirmedPlanId: number,
    itineraryPlanId: number,
    routeId: number,
    hotelCode: string,
    bookingResponse: BookResponse,
    preBookResponse: PreBookResponse,
    preBookMeta: any,
    selection: TboHotelSelection,
    userId: number,
  ) {
    try {
      const bookingMeta = (bookingResponse as any)?.meta || {};
      const tokenId =
        typeof bookingMeta.tokenId === 'string' && bookingMeta.tokenId.trim().length > 0
          ? bookingMeta.tokenId.trim()
          : null;

      const childAges = this.getChildAgesFromSelection(selection);
      const passengerSnapshot = selection.passengers.map((p) => ({
        title: this.resolveTboPassengerTitle(p.title),
        paxType: p.paxType,
        age: p.age,
        firstName: p.firstName,
        lastName: p.lastName,
      }));

      const saved = await this.prisma.tbo_hotel_booking_confirmation.create({
        data: {
          confirmed_itinerary_plan_ID: confirmedPlanId,
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: routeId,
          tbo_hotel_code: hotelCode,
          tbo_booking_id: String(bookingResponse.BookResult.BookingId || ''),
          tbo_booking_reference_number:
            bookingResponse.BookResult.BookingRefNo || '',
          tbo_trace_id: bookingResponse.BookResult.TraceId || '',
          booking_code: selection.bookingCode,
          check_in_date: new Date(selection.checkInDate),
          check_out_date: new Date(selection.checkOutDate),
          number_of_rooms: selection.numberOfRooms,
          net_amount: selection.netAmount,
          guest_nationality: this.normalizeNationality(selection.guestNationality),
          total_guests: selection.passengers.length,
          api_response: {
            preBookResponse: preBookResponse as Record<string, any>,
            preBookMeta: preBookMeta as Record<string, any>,
            bookResponse: bookingResponse as unknown as Record<string, any>,
            tokenId,
            tokenSource: tokenId ? 'authenticate' : 'unavailable',
            persistenceSnapshot: {
              childAges,
              passengerSnapshot,
              prebookAmount: preBookMeta?.prebookNetAmount ?? null,
              bookedAmount: selection.netAmount,
              cancellationPolicy: preBookMeta?.cancellationPolicyText ?? null,
              rateConditions: preBookMeta?.rateConditions || null,
              amenities: preBookMeta?.amenities || null,
              roomPromotions: preBookMeta?.roomPromotions || null,
              mandatorySupplements: preBookMeta?.mandatorySupplements || null,
              // ✅ NEW: normalized supplements for display/booking
              normalizedSupplements: preBookMeta?.normalizedSupplements || null,
              supplements: preBookMeta?.supplements || null,
              panDetails: selection.passengers.map((p) => p.pan).filter(Boolean),
              passportDetails: selection.passengers.map((p) => p.passportNo).filter(Boolean),
            },
          },
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
        select: {
          tbo_hotel_booking_confirmation_ID: true,
        },
      });

      this.logger.log(
        `💾 Saved TBO booking confirmation: ID ${saved.tbo_hotel_booking_confirmation_ID}`,
      );
      return saved;
    } catch (error) {
      this.logger.error(`❌ Error saving booking confirmation: ${error.message}`);
      throw new BadRequestException(
        `Failed to save booking confirmation: ${error.message}`,
      );
    }
  }

  /**
   * Confirm multiple hotel bookings for an itinerary
   */
  async confirmItineraryHotels(
    confirmedPlanId: number,
    itineraryPlanId: number,
    selections: Array<{
      routeId: number;
      selection: TboHotelSelection;
    }>,
    endUserIp: string,
    userId: number,
    groupType: number = 1, // Hotel group type (not used here - draft records already saved)
  ) {
    const results = [];
    const lockedGuestNationality = await this.resolveBookingNationalityFromPlan(itineraryPlanId);
    this.logger.log(
      `🔐 TBO booking nationality locked to itinerary plan ${itineraryPlanId}: ${lockedGuestNationality}`,
    );
    const processedBookingMap = new Map<
      string,
      {
        bookResponse: BookResponse;
        preBookResponse: PreBookResponse;
        preBookMeta: any;
        bookingSelection: TboHotelSelection;
      }
    >();

    for (const { routeId, selection } of selections) {
      try {
        this.validateSelection(selection);

        let preBookResponse: PreBookResponse;
        let preBookMeta: any;

        if (selection.prebookContext?.bookingCode) {
          preBookResponse = {
            Status: selection.prebookContext.rawStatus || { Code: 200, Description: 'Successful' },
            TraceId: selection.prebookContext.traceId || '',
            BookingCode: selection.prebookContext.bookingCode,
            HotelCode: selection.hotelCode,
          };
          preBookMeta = {
            finalPrice:
              selection.prebookContext.finalPrice !== null &&
              selection.prebookContext.finalPrice !== undefined
                ? Number(selection.prebookContext.finalPrice)
                : null,
            prebookNetAmount: selection.prebookContext.prebookNetAmount,
            originalSearchPrice: Number(selection.netAmount),
            isPriceChanged: Boolean(selection.prebookContext.isPriceChanged),
            isCancellationPolicyChanged: Boolean(selection.prebookContext.isCancellationPolicyChanged),
            cancellationPolicy: this.normalizeToArray(selection.prebookContext.cancellationPolicy),
            cancellationPolicyText: selection.prebookContext.cancellationPoliciesText || null,
            rateConditions: this.normalizeToArray(selection.prebookContext.rateConditions),
            roomPromotions: this.normalizeToArray(selection.prebookContext.roomPromotion),
            inclusions: this.normalizeToArray(selection.prebookContext.inclusions),
            amenities: this.normalizeToArray(selection.prebookContext.amenities),
            mealType: selection.prebookContext.mealType || null,
            mandatorySupplements: this.normalizeToArray(selection.prebookContext.mandatorySupplements),
            supplements: this.normalizeToArray(selection.prebookContext.supplements),
            normalizedSupplements: this.normalizeToArray(selection.prebookContext.normalizedSupplements),
            rawStatus: selection.prebookContext.rawStatus,
          };
          this.logger.log(
            `↪ Using confirm-popup prebook context for hotel ${selection.hotelCode}; skipping duplicate provider prebook`,
          );
        } else {
          throw new BadRequestException(
            `Prebook context missing for hotel ${selection.hotelCode}. Please run prebook in confirm modal before final booking.`,
          );
        }

        const priceChangedAtPreBook =
          preBookMeta?.finalPrice !== null &&
          preBookMeta?.finalPrice !== undefined &&
          Number(preBookMeta.finalPrice) !== Number(selection.netAmount);

        const shouldReconfirmPrice =
          priceChangedAtPreBook ||
          Boolean(preBookMeta?.isPriceChanged) ||
          Boolean(preBookMeta?.isCancellationPolicyChanged);

        if (
          preBookMeta?.prebookNetAmount === null ||
          preBookMeta?.prebookNetAmount === undefined ||
          String(preBookMeta.prebookNetAmount).trim() === ''
        ) {
          throw new BadRequestException(
            `Prebook NetAmount missing for hotel ${selection.hotelCode}. Please run prebook again before booking.`,
          );
        }

        const bookingSelection: TboHotelSelection = {
          ...selection,
          guestNationality: lockedGuestNationality,
          netAmount: Number(preBookMeta.prebookNetAmount),
        };

        const dedupeKey = [
          String(preBookResponse?.BookingCode || '').trim(),
          String(preBookResponse?.TraceId || '').trim(),
          String(selection.hotelCode || '').trim(),
        ].join('|');

        const alreadyProcessed = processedBookingMap.get(dedupeKey);
        let bookResponse: BookResponse;

        if (alreadyProcessed) {
          this.logger.warn(
            `↻ Reusing existing booking for duplicate BookingCode/TraceId on route ${routeId} (hotel ${selection.hotelCode})`,
          );
          bookResponse = alreadyProcessed.bookResponse;
        } else {
          // Step 2: Book the hotel with guest details
          bookResponse = await this.bookHotel(
            preBookResponse,
            bookingSelection,
            endUserIp,
          );

          processedBookingMap.set(dedupeKey, {
            bookResponse,
            preBookResponse,
            preBookMeta,
            bookingSelection,
          });
        }

        // Step 3: Save confirmation to database
        const savedConfirmation = await this.saveTboBookingConfirmation(
          confirmedPlanId,
          itineraryPlanId,
          routeId,
          selection.hotelCode,
          bookResponse,
          preBookResponse,
          preBookMeta,
          bookingSelection,
          userId,
        );

        results.push({
          routeId,
          hotelCode: selection.hotelCode,
          bookingId: String(bookResponse.BookResult.BookingId),
          status: 'confirmed',
          preBook: preBookMeta,
          bookingRequest: (bookResponse as any)?.meta?.requestPayload || null,
          priceChanged: shouldReconfirmPrice || Boolean(bookResponse.BookResult.IsPriceChanged),
          priceChangedMessage:
            shouldReconfirmPrice || bookResponse.BookResult.IsPriceChanged
              ? 'Price/cancellation policy changed during prebook. Reconfirmation required.'
              : null,
          mandatorySupplements: preBookMeta?.mandatorySupplements || [],
          // ✅ NEW: normalized supplements for display
          normalizedSupplements: preBookMeta?.normalizedSupplements || [],
          supplements: preBookMeta?.supplements || [],
          confirmation: savedConfirmation,
        });

        this.logger.log(
          `✅ Hotel booking completed for route ${routeId}: ${bookResponse.BookResult.BookingId}`,
        );
      } catch (error) {
        this.logger.error(
          `❌ Failed to book hotel for route ${routeId}: ${error.message}`,
        );
        results.push({
          routeId,
          hotelCode: selection.hotelCode,
          status: 'failed',
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Generate mock PreBook response for development/testing
   */
  private generateMockPreBookResponse(
    selection: TboHotelSelection,
  ): PreBookResponse {
    const mockResponse: PreBookResponse = {
      Status: 1,
      Message: 'PreBook Mock Successful',
      TraceId: `MOCK_TRACE_${Date.now()}`,
      Token: `MOCK_TOKEN_${selection.bookingCode}_${Date.now()}`,
      BookingCode: selection.bookingCode,
      HotelCode: selection.hotelCode,
      HotelRoomsDetails: [],
    };

    this.logger.log(
      `✅ [MOCK] PreBook successful: ${JSON.stringify(mockResponse)}`,
    );
    return mockResponse;
  }

  private normalizeNationality(nationality?: string): string {
    const normalized = (nationality || '').trim().toUpperCase();
    if (normalized) {
      return normalized;
    }

    const fallback = (process.env.TBO_DEFAULT_GUEST_NATIONALITY || '').trim().toUpperCase();
    if (fallback) {
      this.logger.warn(
        `⚠️ GuestNationality missing in itinerary booking payload. Falling back to configured default ${fallback}.`,
      );
      return fallback;
    }

    throw new BadRequestException(
      'GuestNationality is required. Provide guestNationality in request or set TBO_DEFAULT_GUEST_NATIONALITY.',
    );
  }

  private async resolveBookingNationalityFromPlan(itineraryPlanId: number): Promise<string> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: itineraryPlanId },
      select: { nationality: true } as any,
    });

    const raw = String((plan as any)?.nationality ?? '').trim();
    if (/^[A-Za-z]{2}$/.test(raw)) {
      return this.normalizeNationality(raw);
    }

    const nationalityId = Number(raw);
    if (Number.isFinite(nationalityId) && nationalityId > 0) {
      const country = await this.prisma.dvi_countries.findFirst({
        where: { id: nationalityId, deleted: 0, status: 1 },
        select: { shortname: true },
      });
      const iso2 = String(country?.shortname || '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(iso2)) {
        return this.normalizeNationality(iso2);
      }
    }

    this.logger.warn(
      `⚠️ Could not resolve plan nationality for itinerary_plan_ID=${itineraryPlanId}; using configured/default fallback for TBO booking payload.`,
    );
    return this.normalizeNationality();
  }

  private resolveTboPassengerTitle(title?: string): 'Mr' | 'Ms' | 'Mrs' {
    const normalized = resolveProviderPassengerTitle(title);
    if (normalized === 'Mrs' || normalized === 'Ms') {
      return normalized;
    }
    if (normalized === 'Miss') {
      return 'Ms';
    }
    return 'Mr';
  }

  private resolveRoomCount(selection: TboHotelSelection): number {
    return Math.max(selection.occupancies?.length || selection.numberOfRooms || 1, 1);
  }

  private buildPaxRooms(selection: TboHotelSelection): Array<{ Adults: number; Children: number; ChildrenAges: number[] }> {
    if (selection.occupancies && selection.occupancies.length > 0) {
      return selection.occupancies.map((occ) => ({
        Adults: Math.max(occ.adults || 1, 1),
        Children: Math.max(occ.children || 0, 0),
        ChildrenAges: (occ.childrenAges || []).map((age) => Number(age)).filter((age) => !Number.isNaN(age)),
      }));
    }

    const childrenAges = this.getChildAgesFromSelection(selection);
    const adults = selection.passengers.filter((p) => p.paxType === 1).length;
    const children = selection.passengers.filter((p) => p.paxType !== 1 && Number(p.age) <= 11).length;
    return [
      {
        Adults: Math.max(adults, 1),
        Children: Math.max(children, childrenAges.length),
        ChildrenAges: childrenAges,
      },
    ];
  }

  private getChildAgesFromSelection(selection: TboHotelSelection): number[] {
    const fromOccupancy =
      selection.occupancies?.flatMap((occ) => (occ.childrenAges || []).map((age) => Number(age))) || [];

    if (fromOccupancy.length > 0) {
      return fromOccupancy.filter((age) => !Number.isNaN(age));
    }

    return selection.passengers
      .filter((p) => p.paxType === 2)
      .map((p) => Number(p.age))
      .filter((age) => !Number.isNaN(age));
  }

  private validateSelection(selection: TboHotelSelection, skipPassengerValidation = false): void {
    const bookingCode = String(selection.bookingCode || '').trim();
    if (!bookingCode || !bookingCode.includes('!TB!')) {
      throw new BadRequestException(
        'This hotel session has expired or booking code is invalid. Please run a fresh hotel search and prebook again.',
      );
    }

    if (!selection.guestNationality || !/^[A-Z]{2}$/i.test(selection.guestNationality.trim())) {
      throw new BadRequestException('guestNationality must be a valid ISO-2 country code');
    }

    this.validateSearchSessionWindow(selection.searchInitiatedAt);

    if (selection.numberOfRooms < 1 || selection.numberOfRooms > TboHotelBookingService.MAX_ROOMS) {
      throw new BadRequestException(
        `numberOfRooms must be between 1 and ${TboHotelBookingService.MAX_ROOMS}`,
      );
    }

    if (!skipPassengerValidation && (!selection.passengers || selection.passengers.length === 0)) {
      throw new BadRequestException('At least one passenger is required for booking');
    }

    for (let i = 0; i < (selection.passengers || []).length; i++) {
      const passenger = selection.passengers[i];
      if (!passenger.title) {
        throw new BadRequestException(`Passenger title is required at index ${i}`);
      }

      const normalizedTitle = normalizePassengerTitle(passenger.title);
      if (!normalizedTitle) {
        throw new BadRequestException(`Passenger title is invalid at index ${i}`);
      }

      const firstName = String(passenger.firstName || '').trim();
      const lastName = String(passenger.lastName || '').trim();
      const nameRegex = /^[A-Za-z][A-Za-z\s'-]{1,24}$/;
      if (!nameRegex.test(firstName)) {
        throw new BadRequestException(
          `Passenger firstName at index ${i} must be 2-25 characters and contain only letters, spaces, apostrophe or hyphen`,
        );
      }
      if (!nameRegex.test(lastName)) {
        throw new BadRequestException(
          `Passenger lastName at index ${i} must be 2-25 characters and contain only letters, spaces, apostrophe or hyphen`,
        );
      }

      if (passenger.paxType === 1 && (passenger.age < 12 || passenger.age > 120)) {
        throw new BadRequestException(`Adult passenger age at index ${i} must be between 12 and 120`);
      }

      if (passenger.paxType === 2 && (passenger.age < 0 || passenger.age > 11)) {
        throw new BadRequestException(`Child passenger age at index ${i} must be between 0 and 11`);
      }

      if (passenger.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(passenger.pan)) {
        throw new BadRequestException(`Invalid PAN format for passenger index ${i}`);
      }

      if (passenger.passportNo && !/^[A-Z0-9]{6,20}$/i.test(passenger.passportNo)) {
        throw new BadRequestException(`Invalid passport number format for passenger index ${i}`);
      }
    }

    if (selection.occupancies && selection.occupancies.length > 0) {
      if (selection.occupancies.length !== selection.numberOfRooms) {
        throw new BadRequestException('occupancies length must match numberOfRooms');
      }

      for (let i = 0; i < selection.occupancies.length; i++) {
        const occ = selection.occupancies[i];
        if (occ.adults < 1 || occ.adults > TboHotelBookingService.MAX_ADULTS_PER_ROOM) {
          throw new BadRequestException(
            `occupancies[${i}].adults must be between 1 and ${TboHotelBookingService.MAX_ADULTS_PER_ROOM}`,
          );
        }
        if (occ.children < 0 || occ.children > TboHotelBookingService.MAX_CHILDREN_PER_ROOM) {
          throw new BadRequestException(
            `occupancies[${i}].children must be between 0 and ${TboHotelBookingService.MAX_CHILDREN_PER_ROOM}`,
          );
        }

        const ages = occ.childrenAges || [];
        if (occ.children > 0 && ages.length === 0) {
          throw new BadRequestException(`childrenAges is required for occupancy index ${i}`);
        }
        if (ages.length !== occ.children) {
          throw new BadRequestException(`childrenAges length must match children for occupancy index ${i}`);
        }

        const hasInvalidChildAge = ages.some((age) => Number(age) < 0 || Number(age) > 11);
        if (hasInvalidChildAge) {
          throw new BadRequestException(`childrenAges must be between 0 and 11 for occupancy index ${i}`);
        }
      }
    }
  }

  private validateSearchSessionWindow(searchInitiatedAt?: string): void {
    if (!searchInitiatedAt) {
      return;
    }

    const parsed = new Date(searchInitiatedAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('searchInitiatedAt must be a valid ISO datetime');
    }

    const elapsedMs = Date.now() - parsed.getTime();
    if (elapsedMs > TboHotelBookingService.SEARCH_SESSION_VALIDITY_MS) {
      throw new BadRequestException(
        'TBO search session exceeded 35 minutes. Please run a fresh hotel search before prebook/booking.',
      );
    }
  }

  private isSessionExpiredError(errorText: string): boolean {
    return /session expired|stale|availability changed|booking code invalid|price changed|reference invalid|expired booking code|invalid token|token expired|bookcode expired|bookcode invalid|bookingcode expired|bookingcode invalid/i.test(
      errorText,
    );
  }

  private normalizeToArray(value: any): any[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (value && typeof value === 'object') return [value];
    return [];
  }

  private collectPreBookRooms(preBookResponse: any): any[] {
    const roomDetails = this.normalizeToArray(preBookResponse?.HotelRoomsDetails);
    const hotelResultRooms = this.normalizeToArray(preBookResponse?.HotelResult)
      .flatMap((hotelResult: any) => this.normalizeToArray(hotelResult?.Rooms));

    return [...roomDetails, ...hotelResultRooms].filter(Boolean);
  }

  private extractPreBookMeta(preBookResponse: PreBookResponse, selection: TboHotelSelection) {
    const rawRoomDetails = this.collectPreBookRooms(preBookResponse);
    
    // Extract raw mandatory supplements from MandatorySupplements/MandatorySupplement fields
    const rawMandatorySupplements = rawRoomDetails
      .flatMap((room: any) => this.normalizeToArray(room?.MandatorySupplements ?? room?.MandatorySupplement))
      .filter(Boolean);
    
    // ✅ ALSO extract any Supplements fields if present in prebook response
    const rawSupplements = rawRoomDetails
      .flatMap((room: any) => this.normalizeToArray(room?.Supplements))
      .filter(Boolean);

    // ✅ Normalize supplements using suppl ement normalizer service
    // Mandatory supplements come from prebook and are authoritative
    const normalizedMandatorySupplements = this.supplementNormalizer.normalizeSupplements(
      rawMandatorySupplements,
      'prebook',
    );
    
    const normalizedSupplements = this.supplementNormalizer.normalizeSupplements(
      rawSupplements,
      'prebook',
    );

    // Merge both sources: normalized mandatory + any additional supplements
    const allNormalizedSupplements = [
      ...normalizedMandatorySupplements,
      ...normalizedSupplements,
    ];

    const hotelLevelResults = this.normalizeToArray(preBookResponse?.HotelResult);

    const roomPromotions = rawRoomDetails
      .flatMap((room: any) => this.normalizeToArray(room?.RoomPromotion ?? room?.RoomPromotions))
      .filter(Boolean);
    const rateConditions = [
      ...rawRoomDetails.flatMap((room: any) =>
        this.normalizeToArray(room?.RateConditions ?? room?.rateConditions),
      ),
      ...hotelLevelResults.flatMap((hotelResult: any) =>
        this.normalizeToArray(
          hotelResult?.RateConditions ??
            hotelResult?.rateConditions ??
            hotelResult?.RateCondition ??
            hotelResult?.rateCondition,
        ),
      ),
    ].filter(Boolean);
    const cancellationPolicies = rawRoomDetails
      .flatMap((room: any) => this.normalizeToArray(room?.CancelPolicies ?? room?.CancellationPolicy))
      .filter(Boolean);
    const inclusions = [
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
    ].filter(Boolean);
    const amenities = [
      ...rawRoomDetails.flatMap((room: any) =>
        this.normalizeToArray(room?.Amenities ?? room?.amenities),
      ),
      ...hotelLevelResults.flatMap((hotelResult: any) =>
        this.normalizeToArray(
          hotelResult?.Amenities ?? hotelResult?.amenities ?? hotelResult?.Amenity,
        ),
      ),
    ].filter(Boolean);
    const mealTypeCandidates = [
      ...rawRoomDetails.flatMap((room: any) =>
        this.normalizeToArray(
          room?.MealTypeName ?? room?.MealType ?? room?.mealTypeName ?? room?.mealType ?? room?.BoardBasis ?? room?.boardBasis,
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
    ].filter(Boolean);
    const mealType = normalizeMealTypeLabel(mealTypeCandidates[0], inclusions);

    const candidatePrices = [
      preBookResponse?.NetAmount,
      preBookResponse?.TotalFare,
      preBookResponse?.PriceVerification?.FinalPrice,
      ...rawRoomDetails.map((room: any) => room?.TotalFare),
    ];

    const finalPrice = candidatePrices.find((price) => typeof price === 'number' || (typeof price === 'string' && price !== ''));

    return {
      finalPrice: finalPrice !== undefined ? Number(finalPrice) : null,
      originalSearchPrice: Number(selection.netAmount),
      isPriceChanged: Boolean(preBookResponse?.IsPriceChanged),
      isCancellationPolicyChanged: Boolean(preBookResponse?.IsCancellationPolicyChanged),
      cancellationPolicy: cancellationPolicies,
      cancellationPolicyText: cancellationPolicies.length ? JSON.stringify(cancellationPolicies) : null,
      rateConditions,
      roomPromotions,
      inclusions,
      amenities,
      mealType,
      // ✅ Return both raw and normalized supplements
      mandatorySupplements: rawMandatorySupplements, // Raw mandatory supplements (kept for backward compat)
      supplements: rawSupplements, // Raw supplements (if present)
      normalizedSupplements: allNormalizedSupplements, // ✅ NEW: normalized supplements with metadata
      rawStatus: preBookResponse?.Status,
    };
  }

  private async authenticate(endUserIp: string): Promise<string> {
    const now = new Date();
    if (this.tokenId && this.tokenExpiry && this.tokenExpiry.getTime() > now.getTime()) {
      return this.tokenId;
    }

    const authPayload = {
      ClientId: this.TBO_CLIENT_ID,
      UserName: this.TBO_USERNAME,
      Password: this.TBO_PASSWORD,
      EndUserIp: endUserIp,
    };

    try {
      const response = await axios.post<TboAuthResponse>(this.AUTH_URL, authPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      if (response.data?.Status !== 1 || !response.data?.TokenId) {
        throw new InternalServerErrorException(
          `TBO authentication failed: ${response.data?.Error?.ErrorMessage || 'Unknown error'}`,
        );
      }

      this.tokenId = response.data.TokenId;
      this.tokenExpiry = new Date(now.getTime() + this.authTokenTtlMs);
      return this.tokenId;
    } catch (error: any) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }

      const message =
        error?.response?.data?.Error?.ErrorMessage ||
        error?.response?.data?.Message ||
        error?.message ||
        'Unknown error';
      this.logger.error(`❌ TBO authentication failed: ${message}`);
      throw new InternalServerErrorException('Failed to authenticate with TBO before booking.');
    }
  }

  private async tryRecoverBookingAfterTimeout(error: any): Promise<BookResponse | null> {
    const bookingRef =
      error?.response?.data?.BookResult?.BookingRefNo ||
      error?.response?.data?.BookingRefNo ||
      error?.response?.data?.BookResult?.ConfirmationNo ||
      null;

    if (!bookingRef) {
      this.logger.warn('⚠️ Booking timeout recovery skipped: no booking reference returned by upstream');
      return null;
    }

    try {
      const detail = await this.tboProvider.getConfirmation(String(bookingRef));
      const normalizedStatus = (detail?.status || '').toLowerCase();
      const confirmed =
        normalizedStatus.includes('confirm') ||
        normalizedStatus.includes('booked') ||
        normalizedStatus.includes('voucher');

      if (!confirmed) {
        return null;
      }

      this.logger.warn(
        `⚠️ Booking timeout recovered via GetBookingDetail. BookingRef=${bookingRef}, status=${detail.status}`,
      );

      return {
        BookResult: {
          TBOReferenceNo: null,
          VoucherStatus: true,
          ResponseStatus: 1,
          Error: {
            ErrorCode: 0,
            ErrorMessage: '',
          },
          TraceId: '',
          Status: 1,
          HotelBookingStatus: detail.status || 'Confirmed',
          ConfirmationNo: String(bookingRef),
          BookingRefNo: String(bookingRef),
          BookingId: Number(bookingRef) || 0,
          IsPriceChanged: false,
          IsCancellationPolicyChanged: false,
        },
        meta: {
          recoveredFromTimeout: true,
          recoveryMessage: 'Booking timeout recovered from booking detail API',
        },
      };
    } catch (recoveryError: any) {
      this.logger.error(
        `❌ Booking timeout recovery failed for reference ${bookingRef}: ${recoveryError.message}`,
      );
      return null;
    }
  }

  /**
   * Generate mock Book response for development/testing
   */
  private generateMockBookResponse(
    preBookResponse: PreBookResponse,
    selection: TboHotelSelection,
  ): BookResponse {
    const mockResponse: BookResponse = {
      BookResult: {
        TBOReferenceNo: null,
        VoucherStatus: false,
        ResponseStatus: 1,
        Error: {
          ErrorCode: 0,
          ErrorMessage: '',
        },
        TraceId: preBookResponse.TraceId,
        Status: 1,
        HotelBookingStatus: 'Confirmed',
        ConfirmationNo: `MOCK_CONF_${Date.now()}`,
        BookingRefNo: `MOCK_REF_${selection.hotelCode}_${Date.now()}`,
        BookingId: Date.now(),
        IsPriceChanged: false,
        IsCancellationPolicyChanged: false,
      },
    };

    this.logger.log(
      `✅ [MOCK] Book successful: ${JSON.stringify(mockResponse)}`,
    );
    return mockResponse;
  }

  /**
   * Cancel TBO hotel bookings for an itinerary
   * Calls TBO API to cancel and updates database status
   */
  async cancelItineraryHotels(
    itineraryPlanId: number,
    reason: string = 'Itinerary cancelled by user',
  ) {
    try {
      const bookings = await this.fetchActiveCancellationBookings(itineraryPlanId);

      if (bookings.length === 0) {
        this.logger.log(`No active TBO bookings found for itinerary ${itineraryPlanId}`);
        return [];
      }

      this.logger.log(`Found ${bookings.length} TBO booking(s) to cancel`);

      const results = [];

      for (const booking of bookings) {
        try {
          // Call TBO provider to cancel the booking
          // IMPORTANT: Pass tbo_booking_id (the numeric ID from TBO) not the reference
          const cancellationResult = await this.tboProvider.cancelBooking(
            booking.tbo_booking_id,
            reason,
          );

          // Update booking status in database
          await this.prisma.tbo_hotel_booking_confirmation.update({
            where: {
              tbo_hotel_booking_confirmation_ID: booking.tbo_hotel_booking_confirmation_ID,
            },
            data: {
              status: 0, // Mark as cancelled
              updatedon: new Date(),
              api_response: {
                ...(booking.api_response as Record<string, any>),
                cancellation: cancellationResult as Record<string, any>,
                cancelledAt: new Date().toISOString(),
                cancelReason: reason,
              },
            },
            select: {
              tbo_hotel_booking_confirmation_ID: true,
            },
          });

          results.push({
            bookingId: booking.tbo_hotel_booking_confirmation_ID,
            tboBookingRef: booking.tbo_booking_reference_number,
            status: 'cancelled',
            cancellationRef: cancellationResult.cancellationRef,
            refundAmount: cancellationResult.refundAmount,
            charges: cancellationResult.charges,
          });

          this.logger.log(
            `✅ Cancelled TBO booking ${booking.tbo_booking_reference_number}: ` +
            `Refund: ${cancellationResult.refundAmount}, Charges: ${cancellationResult.charges}`,
          );
        } catch (error) {
          this.logger.error(
            `❌ Failed to cancel TBO booking ${booking.tbo_booking_reference_number}: ${error.message}`,
          );

          results.push({
            bookingId: booking.tbo_hotel_booking_confirmation_ID,
            tboBookingRef: booking.tbo_booking_reference_number,
            status: 'failed',
            error: error.message,
          });
        }
      }

      return results;
    } catch (error) {
      this.logger.error(`❌ Error cancelling itinerary hotels: ${error.message}`);
      throw new BadRequestException(
        `Failed to cancel TBO hotels: ${error.message}`,
      );
    }
  }

  /**
   * Cancel TBO hotel bookings for specific routes only
   */
  async cancelItineraryHotelsByRoutes(
    itineraryPlanId: number,
    routeIds: number[],
    reason: string = 'Itinerary cancelled by user',
  ) {
    try {
      if (!routeIds || routeIds.length === 0) {
        this.logger.log(`No route IDs provided for cancellation`);
        return [];
      }

      const bookings = await this.fetchActiveCancellationBookings(itineraryPlanId, routeIds);

      if (bookings.length === 0) {
        this.logger.log(
          `No active TBO bookings found for itinerary ${itineraryPlanId} and routes [${routeIds.join(',')}]`,
        );
        return [];
      }

      this.logger.log(
        `Found ${bookings.length} TBO booking(s) to cancel for routes [${routeIds.join(',')}]`,
      );

      const results = [];

      for (const booking of bookings) {
        try {
          // Call TBO provider to cancel the booking
          // IMPORTANT: Pass tbo_booking_id (the numeric ID from TBO) not the reference
          const cancellationResult = await this.tboProvider.cancelBooking(
            booking.tbo_booking_id,
            reason,
          );

          // Update booking status in database
          await this.prisma.tbo_hotel_booking_confirmation.update({
            where: {
              tbo_hotel_booking_confirmation_ID: booking.tbo_hotel_booking_confirmation_ID,
            },
            data: {
              status: 0, // Mark as cancelled
              updatedon: new Date(),
              api_response: {
                ...(booking.api_response as Record<string, any>),
                cancellation: cancellationResult as Record<string, any>,
                cancelledAt: new Date().toISOString(),
                cancelReason: reason,
              },
            },
            select: {
              tbo_hotel_booking_confirmation_ID: true,
            },
          });

          results.push({
            bookingId: booking.tbo_hotel_booking_confirmation_ID,
            routeId: booking.itinerary_route_ID,
            tboBookingRef: booking.tbo_booking_reference_number,
            status: 'cancelled',
            cancellationRef: cancellationResult.cancellationRef,
            refundAmount: cancellationResult.refundAmount,
            charges: cancellationResult.charges,
          });

          this.logger.log(
            `✅ Cancelled TBO booking ${booking.tbo_booking_reference_number} (Route ${booking.itinerary_route_ID}): ` +
            `Refund: ${cancellationResult.refundAmount}, Charges: ${cancellationResult.charges}`,
          );
        } catch (error) {
          this.logger.error(
            `❌ Failed to cancel TBO booking ${booking.tbo_booking_reference_number} (Route ${booking.itinerary_route_ID}): ${error.message}`,
          );

          results.push({
            bookingId: booking.tbo_hotel_booking_confirmation_ID,
            routeId: booking.itinerary_route_ID,
            tboBookingRef: booking.tbo_booking_reference_number,
            status: 'failed',
            error: error.message,
          });
        }
      }

      return results;
    } catch (error) {
      this.logger.error(`❌ Error cancelling TBO hotel routes: ${error.message}`);
      throw new BadRequestException(
        `Failed to cancel TBO hotel routes: ${error.message}`,
      );
    }
  }

  private async fetchActiveCancellationBookings(
    itineraryPlanId: number,
    routeIds?: number[],
  ): Promise<TboCancellationBookingRow[]> {
    const safePlanId = Number(itineraryPlanId);
    if (!Number.isFinite(safePlanId) || safePlanId <= 0) {
      return [];
    }

    if (!routeIds || routeIds.length === 0) {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT tbo_hotel_booking_confirmation_ID, itinerary_route_ID, tbo_booking_id, tbo_booking_reference_number, api_response
         FROM tbo_hotel_booking_confirmation
         WHERE itinerary_plan_ID = ? AND status = 1 AND deleted = 0`,
        safePlanId,
      );
      return rows as TboCancellationBookingRow[];
    }

    const safeRouteIds = routeIds
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (safeRouteIds.length === 0) {
      return [];
    }

    const placeholders = safeRouteIds.map(() => '?').join(',');
    const rows = await this.prisma.$queryRawUnsafe(
      `SELECT tbo_hotel_booking_confirmation_ID, itinerary_route_ID, tbo_booking_id, tbo_booking_reference_number, api_response
       FROM tbo_hotel_booking_confirmation
       WHERE itinerary_plan_ID = ? AND itinerary_route_ID IN (${placeholders}) AND status = 1 AND deleted = 0`,
      safePlanId,
      ...safeRouteIds,
    );
    return rows as TboCancellationBookingRow[];
  }
}
