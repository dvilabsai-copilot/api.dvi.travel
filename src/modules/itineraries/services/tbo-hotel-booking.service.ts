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
import { allocateTboBatchPassengers } from '../../hotels/utils/tbo-batch-passenger-allocation.util';
import {
  normalizePassengerTitle,
  resolveProviderPassengerTitle,
} from '../../../common/utils/passenger-title.util';
import { isTboInsufficientBalanceResponse } from '../utils/tbo-hold-eligibility.util';
import { createHash } from 'crypto';
import { validateTboCompleteBatchGroups } from '../../hotels/utils/tbo-complete-batch-validation.util';
import { TBO_SEARCH_SESSION_VALIDITY_MS } from '../../hotels/utils/tbo-search-session';

interface TboHotelSelection {
  batchIndex?: number;
startRoomIndex?: number;
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
  roomPassengerIndices?: number[][];
  prebookContext?: Record<string, any>;
  /**
   * TBO uses false for a supplier hold and true for immediate voucher booking.
   * Existing confirmation callers omit this field and therefore retain the
   * current voucher-booking behavior.
   */
  isVoucherBooking?: boolean;
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
  private static readonly DEFAULT_CHILD_AGE = 5;
  private static readonly PREBOOK_TIMEOUT_MS = 75_000;
  private readonly logger = new Logger(TboHotelBookingService.name);
  private readonly client: AxiosInstance;
  private tokenId: string | null = null;
  private tokenExpiry: Date | null = null;
  private readonly authTokenTtlMs = 10 * 60 * 1000;

private readonly TBO_USERNAME =
  process.env.TBO_API_USERNAME ||
  process.env.TBO_USERNAME ||
  '';

private readonly TBO_PASSWORD =
  process.env.TBO_API_PASSWORD ||
  process.env.TBO_PASSWORD ||
  '';

private readonly TBO_CLIENT_ID =
  process.env.TBO_CLIENT_ID || '';
 private readonly AUTH_URL = process.env.TBO_AUTH_URL || 'https://api.travelboutiqueonline.com/SharedAPI/SharedData.svc/rest/Authenticate';
 private readonly PREBOOK_URL = process.env.TBO_PREBOOK_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI/PreBook';
 private readonly BOOK_URL = process.env.TBO_BOOK_URL || 'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest/book';
 private readonly GENERATE_VOUCHER_URL = process.env.TBO_GENERATE_VOUCHER_URL || 'https://HotelBE.tektravels.com/hotelservice.svc/rest/GenerateVoucher';
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
 this.logger.warn(' TBO_USE_MOCK is enabled - Using mock TBO responses');
    }
  }

 /**
   * Execute PreBook API call for TBO hotel
   * This confirms the room availability and locks the price
 */
  async preBookHotel(
    selection: TboHotelSelection,
  ): Promise<PreBookResponse> {
    return this.preBookHotelInternal(selection, false);
  }

  /** Hold-only PreBook: status 300 is accepted for the unvouchered Book step. */
  async preBookHotelForHold(
    selection: TboHotelSelection,
  ): Promise<PreBookResponse> {
    return this.preBookHotelInternal(selection, true);
  }

  private async preBookHotelInternal(
    selection: TboHotelSelection,
    allowInsufficientBalanceForHold: boolean,
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

 this.logger.log(` Full PreBook Payload (JSON): ${JSON.stringify(payload)}`);

      const response = await this.client.post<PreBookResponse>(
        this.PREBOOK_URL,
        payload,
        {
          timeout: TboHotelBookingService.PREBOOK_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.data) {
 this.logger.error(' PreBook response.data is undefined');
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
 this.logger.log(` PreBook API snapshot: ${JSON.stringify(prebookSnapshot)}`);
 this.logger.log(
  `TBO PreBook response received: hotel=${selection.hotelCode}`,
);

      (response.data as any).__requestPayload = payload;

 // Handle TBO status response - it can be a number or object with Code/Description
      const statusCode = typeof response.data.Status === 'object' && response.data.Status
        ? (response.data.Status as any).Code
        : response.data.Status;

      const statusMessage = typeof response.data.Status === 'object' && response.data.Status
        ? (response.data.Status as any).Description || response.data.Message
        : response.data.Message;

      if (response.data.IsAvailable === false || this.isPrebookUnavailable(statusMessage)) {
        throw this.prebookUnavailable(selection);
      }

 // TBO PreBook uses Status.Code = 200 for success, other endpoints use Status.Code = 1
      const isHoldInsufficientBalance = allowInsufficientBalanceForHold
        && isTboInsufficientBalanceResponse(response.data as any);
      if (statusCode !== 1 && statusCode !== 200 && !isHoldInsufficientBalance) {
        const message = statusMessage || 'Unknown TBO error';
        const maybeSessionExpired = this.isSessionExpiredError(
          `${message} ${JSON.stringify(response.data || {})}`,
        );
        if (maybeSessionExpired) {
          throw new BadRequestException(
            'This hotel session has expired or rates changed. Please refresh hotel selection and run prebook again.',
          );
        }
 this.logger.error(` PreBook Status Code=${statusCode}: ${JSON.stringify(response.data)}`);
        throw new BadRequestException(
          `PreBook failed: ${message}`,
        );
      }

      if (isHoldInsufficientBalance) {
 this.logger.warn(' PreBook returned insufficient balance; continuing only for the explicit non-voucher hold flow.');
      } else {
 this.logger.log(
  `TBO PreBook successful: hotel=${selection.hotelCode}`,
);
      }
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
        errorMsg = `VSR API Error: ${JSON.stringify(error.response.data)}`;
      } else if (error?.message) {
        errorMsg = error.message;
      } else if (typeof error === 'string') {
        errorMsg = error;
      }

      const statusCode = error?.response?.status;

 this.logger.error(` PreBook error: ${errorMsg}`);
      if (statusCode) {
 this.logger.error(` HTTP Status: ${statusCode}`);
      }

      if (this.isPrebookUnavailable(errorMsg)) throw this.prebookUnavailable(selection);
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

  private isPrebookUnavailable(message: unknown): boolean {
    return /\b(?:sold out|no (?:rooms?|availability)|(?:hotel|room|rate) (?:is )?(?:not available|unavailable)|not available for (?:the )?(?:selected|requested) dates)\b/i.test(String(message || ''));
  }

  private prebookUnavailable(selection: TboHotelSelection): BadRequestException {
    return new BadRequestException({
      code: 'VSR_HOTEL_UNAVAILABLE',
      hotelName: selection.hotelName,
      message: 'Hotel is not available for the selected stay.',
    });
  }

 /**
   * Execute Book API call to confirm hotel booking with guest details
 */
  async bookHotel(
    preBookResponse: PreBookResponse,
    selection: TboHotelSelection,
    endUserIp: string = process.env.TBO_END_USER_IP || '134.209.145.185',
  ): Promise<BookResponse> {
    try {
      this.validateSelection(selection);

 // Map passengers to TBO format
const hotelRoomsDetails = selection.roomPassengerIndices !== undefined
  ? (() => {
      if (!selection.occupancies) {
        throw new BadRequestException(
          'Room occupancies are required for explicit TBO passenger assignments.',
        );
      }

      const assignedRooms = allocateTboBatchPassengers(
        selection.passengers,
        selection.occupancies,
        selection.roomPassengerIndices,
        [{
          batchIndex: 0,
          startRoomIndex: 0,
          roomCount: selection.numberOfRooms,
        }],
      );

      return assignedRooms[0].occupancies.map((_, roomIndex) => ({
        HotelPassenger: selection.roomPassengerIndices![roomIndex].map(
          (passengerIndex, indexInRoom) =>
            this.mapPassenger(selection.passengers[passengerIndex], indexInRoom),
        ),
      }));
    })()
  : this.mapPassengersToRooms(
      selection.passengers,
      selection.numberOfRooms,
      selection.occupancies,
    );
// Check if using mock mode for development
if (this.USE_MOCK_TBO) {
  return this.generateMockBookResponse(preBookResponse, selection);
}
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
        IsVoucherBooking: selection.isVoucherBooking ?? true,
        GuestNationality: this.normalizeNationality(selection.guestNationality),
        EndUserIp: endUserIp,
        RequestedBookingMode: 1,
        TraceId: preBookResponse?.TraceId || '',
        NetAmount: selection.netAmount,
        HotelRoomsDetails: hotelRoomsDetails,
      };

this.logger.log(
  `TBO Book request started: hotel=${selection.hotelCode}, rooms=${selection.numberOfRooms}`,
);

      const response = await this.client.post<BookResponse>(
        this.BOOK_URL,
        bookingPayload,
      );

      (response.data as any).meta = {
        ...(response.data as any).meta,
      };

 // Log full response for debugging
this.logger.log(
  `TBO Book response: status=${response.data?.BookResult?.Status}, ` +
  `responseStatus=${response.data?.BookResult?.ResponseStatus}`,
);

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
 this.logger.error(` Book Status Code=${statusCode}, ResponseStatus=${responseStatus}: ${JSON.stringify(response.data)}`);
        throw new BadRequestException(
          `Booking failed: ${errorMessage}`,
        );
      }

 this.logger.log(
  `TBO Book successful: hotel=${selection.hotelCode}`,
);
      return response.data;
    } catch (error: any) {
      const timeoutError = error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '');
      if (timeoutError) {
        const recovered = await this.tryRecoverBookingAfterTimeout(error);
        if (recovered) {
          return recovered;
        }
      }

 this.logger.error(` Booking error: ${error.message}`);
      if (error.response) {
 this.logger.error(` Book API Error Response: ${JSON.stringify(error.response.data)}`);
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
   * Place a refundable TBO/VSR rate on supplier hold without issuing a
   * voucher. This is intentionally separate from final confirmation, which
   * continues to use the default voucher-booking mode.
   */
  async holdHotel(
    preBookResponse: PreBookResponse,
    selection: TboHotelSelection,
    endUserIp: string = process.env.TBO_END_USER_IP || '134.209.145.185',
  ): Promise<BookResponse> {
    return this.bookHotel(
      preBookResponse,
      { ...selection, isVoucherBooking: false },
      endUserIp,
    );
  }

  /** Read the current supplier state of a VSR hold without changing it. */
  async getHoldStatus(confirmationReference: string, bookingId?: string | number) {
    const reference = String(confirmationReference || '').trim();
    if (!reference) throw new BadRequestException('A VSR booking reference is required.');
    return this.tboProvider.getConfirmation(reference, bookingId);
  }

  /** Generate a voucher for an already-paid TBO supplier hold. */
  async generateVoucher(bookingId: string | number, endUserIp = process.env.TBO_END_USER_IP || '134.209.145.185') {
    const id = Number(bookingId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BadRequestException('A valid TBO BookingId is required to generate the voucher.');
    }
    if (this.USE_MOCK_TBO) {
      return { voucherStatus: true, bookingStatus: 'Confirmed', bookingId: id, raw: { mock: true } };
    }

    const tokenId = await this.authenticate(endUserIp);
    const request = { EndUserIp: endUserIp, BookingId: id, TokenId: tokenId };
    try {
      const response = await this.client.post(this.GENERATE_VOUCHER_URL, request, { timeout: 30_000 });
      const result = response.data?.GenerateVoucherResult || response.data;
      const voucherStatus = result?.VoucherStatus === true || Number(result?.VoucherStatus) === 1;
      const responseStatus = Number(result?.ResponseStatus ?? 0);
      const bookingStatusCode = Number(result?.Status ?? 0);
      const errorMessage = String(result?.Error?.ErrorMessage || result?.ErrorMessage || '').trim();
      if (!voucherStatus || (responseStatus !== 0 && responseStatus !== 1) || [0, 6].includes(bookingStatusCode)) {
        throw new Error(errorMessage || `TBO GenerateVoucher was not successful (response ${responseStatus}, booking status ${bookingStatusCode}).`);
      }
      return {
        voucherStatus: true,
        bookingStatus: String(result?.HotelBookingStatus || result?.BookingStatus || 'Pending'),
        bookingId: id,
        bookingReference: result?.BookingRefNo || null,
        confirmationNumber: result?.ConfirmationNo || null,
        raw: response.data,
      };
    } catch (error: any) {
      const upstreamMessage = String(
        error?.response?.data?.GenerateVoucherResult?.Error?.ErrorMessage
        || error?.response?.data?.Error?.ErrorMessage
        || error?.response?.data?.Message
        || error?.message
        || 'Unknown TBO voucher error',
      );
      this.logger.error(`TBO GenerateVoucher failed for BookingId ${id}: ${upstreamMessage}`);
      throw new BadRequestException(`TBO voucher generation is pending: ${upstreamMessage}`);
    }
  }

  /** Releases an unpaid TBO Book hold using the existing supplier cancellation API and its BookingId contract. */
  async cancelHeldBooking(bookingId: string | number, reason = 'Unpaid DVi hotel hold expired') {
    const id = String(bookingId || '').trim();
    if (!/^\d+$/.test(id)) throw new BadRequestException('A valid TBO booking ID is required to release this hold.');
    return this.tboProvider.cancelBooking(id, reason);
  }

 /**
   * Map passengers to TBO hotel rooms format
   * Each room contains the passengers assigned to it
   *
   * IMPORTANT: TBO requires passenger count to match what was searched
     * Reject missing or mismatched passengers instead of duplicating them.
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

        if (roomAdults.length !== adultsNeeded) {
          throw new BadRequestException(
            `Insufficient adult passengers for TBO room ${i + 1}.`,
          );
        }
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

          if (matchedIndex < 0 || !childrenPool[matchedIndex]) {
            throw new BadRequestException(
              `Child passenger age does not match TBO room ${i + 1}.`,
            );
          }

          const [picked] = childrenPool.splice(matchedIndex, 1);
          roomChildren.push(picked);
        }
        if (roomChildren.length !== childrenNeeded) {
          throw new BadRequestException(
            `Insufficient child passengers for TBO room ${i + 1}.`,
          );
        }

        const roomPassengers: TboHotelPassenger[] = [...roomAdults, ...roomChildren];
        if (roomPassengers.length !== adultsNeeded + childrenNeeded) {
          throw new BadRequestException(
            `Passenger details do not match TBO room occupancy for room ${i + 1}.`,
          );
        }

        const mappedPassengers = roomPassengers.map(
          (p, idx) => this.mapPassenger(p, idx),
        );

        rooms.push({ HotelPassenger: mappedPassengers });
      }

      if (adultsPool.length > 0 || childrenPool.length > 0) {
        throw new BadRequestException(
          'TBO passenger count exceeds the selected room occupancies.',
        );
      }

      return rooms;
    }

    const roomsPerSize = Math.ceil(
      workingPassengers.length / safeRoomCount,
    );

    for (let i = 0; i < safeRoomCount; i++) {
      const startIdx = i * roomsPerSize;
      const endIdx = Math.min(
        startIdx + roomsPerSize,
        workingPassengers.length,
      );

      const roomPassengers = workingPassengers.slice(
        startIdx,
        endIdx,
      );

      const mappedPassengers = roomPassengers.map(
        (p, idx) => this.mapPassenger(p, idx),
      );

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
      Age: p.paxType === 2 ? this.resolvePassengerAge(p.age) : p.age,
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

      const childAges = this.getChildAgesFromSelection(selection);
      const passengerSnapshot = selection.passengers.map((p) => ({
        title: this.resolveTboPassengerTitle(p.title),
        paxType: p.paxType,
        age: p.age,
        firstName: p.firstName,
        lastName: p.lastName,
      }));


      // Reuse an existing confirmation for the same supplier booking.
      // This prevents a repeated save from creating another local record.
      const supplierBookingId = String(
        bookingResponse.BookResult.BookingId || '',
      ).trim();

      if (!supplierBookingId || supplierBookingId === '0') {
        throw new BadRequestException(
          'Cannot save TBO confirmation without a valid supplier BookingId.',
        );
      }

      const existingConfirmation =
        await this.prisma.tbo_hotel_booking_confirmation.findFirst({
          where: {
            itinerary_plan_ID: itineraryPlanId,
            itinerary_route_ID: routeId,
            tbo_booking_id: supplierBookingId,
            deleted: 0,
          },
          select: {
            tbo_hotel_booking_confirmation_ID: true,
          },
        });

      if (existingConfirmation) {
        this.logger.warn(
          `TBO confirmation already saved for BookingId ${supplierBookingId}. Reusing existing record.`,
        );

        return existingConfirmation;
      }

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
             bookResponse: {
              BookResult: bookingResponse.BookResult,
            },
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
 // NEW: normalized supplements for display/booking
              normalizedSupplements: preBookMeta?.normalizedSupplements || null,
              supplements: preBookMeta?.supplements || null,
                         passengerDocumentDetailsStored: false,
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
 this.logger.error(` Error saving booking confirmation: ${error.message}`);
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
    if (selections.length > 0) {
      const sourcePlan = await this.prisma.dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: itineraryPlanId },
        select: { preferred_room_count: true },
      });
      if (!sourcePlan) throw new BadRequestException('Itinerary plan not found for TBO confirmation.');
      const roomCount = Number(sourcePlan.preferred_room_count || 1);
      if (roomCount > 6) {
        const groupError = validateTboCompleteBatchGroups(
          selections.map(({ routeId, selection }) => ({ ...selection, routeId })),
          roomCount,
        );
        if (groupError) throw new BadRequestException(groupError);
      }
    }
    const lockedGuestNationality = await this.resolveBookingNationalityFromPlan(itineraryPlanId);
 this.logger.log(
      `🔐 TBO booking nationality locked to itinerary plan ${itineraryPlanId}: ${lockedGuestNationality}`,
    );
    // Validate every batch before the first supplier Book call.
const groups = new Map<string, typeof selections>();

for (const item of selections) {
  const { routeId, selection } = item;

  this.validateSelection(selection);

  if (!Number.isSafeInteger(routeId) || routeId <= 0) {
    throw new BadRequestException('Invalid TBO routeId.');
  }

  const code = String(selection.bookingCode || '').trim();
  const contextCode = String(
    selection.prebookContext?.bookingCode || '',
  ).trim();

  if (!contextCode || contextCode !== code) {
    throw new BadRequestException(
      'Every TBO batch requires its own matching PreBook BookingCode.',
    );
  }

  const amount = Number(
    selection.prebookContext?.prebookNetAmount,
  );

  if (
    selection.prebookContext?.prebookNetAmount == null ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new BadRequestException(
      'Every TBO batch requires a valid supplier PreBook NetAmount.',
    );
  }

  const key = [
    routeId,
    selection.hotelCode,
    selection.checkInDate,
    selection.checkOutDate,
  ].join('|');

  const existing = groups.get(key) || [];
  existing.push(item);
  groups.set(key, existing);
}

for (const group of groups.values()) {
  if (group.length <= 1) continue;

  const sorted = [...group].sort(
    (a, b) =>
      Number(a.selection.startRoomIndex) -
      Number(b.selection.startRoomIndex),
  );

  const usedCodes = new Set<string>();
  const usedIndices = new Set<number>();
  let nextRoom = 0;

  for (const { selection } of sorted) {
    const batchIndex = selection.batchIndex;
    const start = selection.startRoomIndex;

    if (
      !Number.isSafeInteger(batchIndex) ||
      !Number.isSafeInteger(start) ||
      start !== nextRoom
    ) {
      throw new BadRequestException(
        'TBO batches must cover consecutive rooms starting at zero.',
      );
    }

    if (usedIndices.has(batchIndex!)) {
      throw new BadRequestException(
        'Duplicate TBO batchIndex detected.',
      );
    }

    const code = String(selection.bookingCode).trim();

    if (usedCodes.has(code)) {
      throw new BadRequestException(
        'Two TBO batches cannot reuse the same supplier BookingCode.',
      );
    }

    usedIndices.add(batchIndex!);
    usedCodes.add(code);
    nextRoom += selection.numberOfRooms;
  }

  if (
    sorted.some(
      ({ selection }, index) => selection.batchIndex !== index,
    )
  ) {
    throw new BadRequestException(
      'TBO batch indexes must be sequential, starting from zero.',
    );
  }
}

    for (const { routeId, selection } of selections) {
  let supplierBookStarted = false;

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
          Number(preBookMeta.finalPrice) !== Number(selection.prebookContext?.savedSupplierAmount ?? selection.netAmount);

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

   const selectedCode = String(selection.bookingCode || '').trim();
const prebookCode = String(preBookResponse.BookingCode || '').trim();

if (!selectedCode || selectedCode !== prebookCode) {
  throw new BadRequestException(
    'TBO PreBook BookingCode does not match the selected batch. ' +
    'Run a fresh supplier search and PreBook.',
  );
}

const verifiedNetAmount = Number(preBookMeta.prebookNetAmount);

if (!Number.isFinite(verifiedNetAmount) || verifiedNetAmount <= 0) {
  throw new BadRequestException(
    'Invalid supplier PreBook NetAmount. Booking is blocked.',
  );
}

if (shouldReconfirmPrice) {
  throw new BadRequestException(
    'TBO price or cancellation policy changed. ' +
    'The revised supplier terms must be accepted before booking.',
  );
}

const bookingSelection: TboHotelSelection = {
  ...selection,
  guestNationality: lockedGuestNationality,
  netAmount: verifiedNetAmount,
};

        // Check previously saved supplier bookings before calling Book again.
        // Applies only to the same itinerary, route, hotel and BookingCode.
        const existingSupplierBooking =
          await this.prisma.tbo_hotel_booking_confirmation.findFirst({
            where: {
              confirmed_itinerary_plan_ID: confirmedPlanId,
              itinerary_plan_ID: itineraryPlanId,
              itinerary_route_ID: routeId,
              tbo_hotel_code: selection.hotelCode,
              booking_code: selection.bookingCode,
              status: 1,
              deleted: 0,
            },
            select: {
              tbo_hotel_booking_confirmation_ID: true,
              tbo_booking_id: true,
              number_of_rooms: true,
            },
          });

        if (existingSupplierBooking) {
          if (
            Number(existingSupplierBooking.number_of_rooms) !==
            selection.numberOfRooms
          ) {
            throw new BadRequestException(
              'An existing TBO booking has a different room count. Manual review required.',
            );
          }

          this.logger.warn(
            `Skipping duplicate TBO Book call for route ${routeId}; existing supplier BookingId ${existingSupplierBooking.tbo_booking_id}`,
          );

  results.push({
  routeId,
  hotelCode: selection.hotelCode,
  bookingCode: selection.bookingCode,
  batchIndex: selection.batchIndex ?? 0,
  startRoomIndex: selection.startRoomIndex ?? 0,
  bookingId: String(existingSupplierBooking.tbo_booking_id),
  status: 'confirmed',
  alreadyBooked: true,
  confirmation: {
    tbo_hotel_booking_confirmation_ID:
      existingSupplierBooking.tbo_hotel_booking_confirmation_ID,
  },
});

          continue;
        }

        const batchIndex = selection.batchIndex ?? 0;
        const startRoomIndex = selection.startRoomIndex ?? 0;

        if (
          !Number.isSafeInteger(batchIndex) ||
          batchIndex < 0 ||
          !Number.isSafeInteger(startRoomIndex) ||
          startRoomIndex < 0
        ) {
          throw new BadRequestException('Invalid TBO batch identity.');
        }

        const bookingCodeHash = createHash('sha256')
          .update(String(preBookResponse.BookingCode), 'utf8')
          .digest('hex');

        let attempt: { id: number };

        try {
          attempt = await this.prisma.tbo_hotel_booking_attempt.create({
            data: {
              confirmed_itinerary_plan_ID: confirmedPlanId,
              itinerary_plan_ID: itineraryPlanId,
              itinerary_route_ID: routeId,
              batch_index: batchIndex,
              start_room_index: startRoomIndex,
              number_of_rooms: selection.numberOfRooms,
              booking_code_hash: bookingCodeHash,
              state: 'CLAIMED',
            },
            select: { id: true },
          });
        } catch (error: any) {
          if (error?.code === 'P2002') {
            throw new BadRequestException(
              'This TBO batch was already attempted. ' +
              'Verify its saved supplier state before retrying.',
            );
          }
          throw error;
        }

let bookResponse: BookResponse;

try {
  supplierBookStarted = true;

  bookResponse = await this.bookHotel(
    preBookResponse,
    bookingSelection,
    endUserIp,
  );
} catch (error) {
  await this.prisma.tbo_hotel_booking_attempt.update({
    where: { id: attempt.id },
    data: { state: 'UNKNOWN' },
  });

  throw error;
}

const supplierBookingId = Number(
  bookResponse.BookResult?.BookingId,
);

if (
  !Number.isSafeInteger(supplierBookingId) ||
  supplierBookingId <= 0
) {
  await this.prisma.tbo_hotel_booking_attempt.update({
    where: { id: attempt.id },
    data: { state: 'UNKNOWN' },
  });

  throw new BadRequestException(
    'TBO BookingId is invalid. Supplier reconciliation is required.',
  );
}

await this.prisma.tbo_hotel_booking_attempt.update({
  where: { id: attempt.id },
  data: {
    state: 'BOOKED_UNPERSISTED',
    supplier_booking_id: String(supplierBookingId),
    supplier_booking_reference:
      bookResponse.BookResult.BookingRefNo || null,
  },
});

 // Step 3: Save confirmation to database
let savedConfirmation: {
  tbo_hotel_booking_confirmation_ID: number;
};

try {
  savedConfirmation = await this.saveTboBookingConfirmation(
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
} catch (error) {
  this.logger.error(
    `TBO BookingId ${supplierBookingId} was returned, ` +
    'but local confirmation persistence failed. ' +
    'Manual reconciliation is required; do not rebook.',
  );

  throw new BadRequestException(
    `Supplier booking ${supplierBookingId} requires reconciliation. ` +
    'Do not retry the supplier Book request.',
  );
}
await this.prisma.tbo_hotel_booking_attempt.update({
  where: { id: attempt.id },
  data: {
    state: 'CONFIRMED',
    confirmation_id:
      savedConfirmation.tbo_hotel_booking_confirmation_ID,
    supplier_booking_id: String(supplierBookingId),
    supplier_booking_reference:
      bookResponse.BookResult.BookingRefNo || null,
  },
});

        results.push({
          bookingCode: selection.bookingCode,
batchIndex,
startRoomIndex,
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
 // NEW: normalized supplements for display
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
  bookingCode: selection.bookingCode,
  batchIndex: selection.batchIndex ?? 0,
  startRoomIndex: selection.startRoomIndex ?? 0,
  status: supplierBookStarted
    ? 'requires_reconciliation'
    : 'failed',
  success: false,
  retryAllowed: false,
  error: error instanceof Error
    ? error.message
    : 'Unknown TBO booking error',
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
      'GuestNationality is required. Provide guestNationality in request or set the configured default guest nationality.',
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
        ChildrenAges: this.resolveChildAges(occ.children, occ.childrenAges),
      }));
    }

    const childrenAges = this.getChildAgesFromSelection(selection);
    const adults = selection.passengers.filter((p) => p.paxType === 1).length;
    const children = selection.passengers.filter((p) => p.paxType === 2).length;
    return [
      {
        Adults: Math.max(adults, 1),
        Children: Math.max(children, childrenAges.length),
        ChildrenAges: childrenAges,
      },
    ];
  }

  private getChildAgesFromSelection(selection: TboHotelSelection): number[] {
    const fromOccupancy = selection.occupancies?.flatMap((occ) =>
      this.resolveChildAges(occ.children, occ.childrenAges),
    ) || [];

    if (fromOccupancy.length > 0) {
      return fromOccupancy.filter((age) => !Number.isNaN(age));
    }

    return selection.passengers
      .filter((p) => p.paxType === 2)
      .map((p) => this.resolvePassengerAge(p.age));
  }

  private resolveChildAges(children: number, ages?: number[]): number[] {
    const childCount = Math.max(Number(children || 0), 0);
    return Array.from({ length: childCount }, (_, index) => {
      const rawAge = ages?.[index];
      if (rawAge === null || rawAge === undefined || String(rawAge).trim() === '') {
        return TboHotelBookingService.DEFAULT_CHILD_AGE;
      }
      const age = Number(rawAge);
      return Number.isFinite(age) ? age : TboHotelBookingService.DEFAULT_CHILD_AGE;
    });
  }

  private resolvePassengerAge(age: number | null | undefined): number {
    return age === null || age === undefined || String(age).trim() === ''
      ? TboHotelBookingService.DEFAULT_CHILD_AGE
      : Number(age);
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
    if (elapsedMs > TBO_SEARCH_SESSION_VALIDITY_MS) {
      throw new BadRequestException(
        'VSR search session exceeded 35 minutes. Please run a fresh hotel search before prebook/booking.',
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

 // ALSO extract any Supplements fields if present in prebook response
    const rawSupplements = rawRoomDetails
      .flatMap((room: any) => this.normalizeToArray(room?.Supplements))
      .filter(Boolean);

 // Normalize supplements using suppl ement normalizer service
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
 // Return both raw and normalized supplements
 mandatorySupplements: rawMandatorySupplements, // Raw mandatory supplements (kept for backward compat)
 supplements: rawSupplements, // Raw supplements (if present)
 normalizedSupplements: allNormalizedSupplements, // NEW: normalized supplements with metadata
      rawStatus: preBookResponse?.Status,
    };
  }

private async authenticate(endUserIp: string): Promise<string> {
  if (
    !this.TBO_USERNAME.trim() ||
    !this.TBO_PASSWORD.trim() ||
    !this.TBO_CLIENT_ID.trim()
  ) {
    throw new InternalServerErrorException(
      'TBO booking credentials are not configured. Set TBO_API_USERNAME, TBO_API_PASSWORD and TBO_CLIENT_ID.',
    );
  }

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
          `VSR authentication failed: ${response.data?.Error?.ErrorMessage || 'Unknown error'}`,
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
 this.logger.error(` TBO authentication failed: ${message}`);
      throw new InternalServerErrorException('Failed to authenticate with VSR before booking.');
    }
  }

  private async tryRecoverBookingAfterTimeout(error: any): Promise<BookResponse | null> {
    const bookingRef =
      error?.response?.data?.BookResult?.BookingRefNo ||
      error?.response?.data?.BookingRefNo ||
      error?.response?.data?.BookResult?.ConfirmationNo ||
      null;

    if (!bookingRef) {
 this.logger.warn(' Booking timeout recovery skipped: no booking reference returned by upstream');
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

      // A booking reference is not a supplier BookingId.
      // Never fabricate a confirmed booking from a reference alone.
      this.logger.warn(
        'TBO booking outcome requires reconciliation: ' +
        'supplier BookingId has not been verified.',
      );

      return null;
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
 this.logger.error(` Error cancelling itinerary hotels: ${error.message}`);
      throw new BadRequestException(
        `Failed to cancel VSR hotels: ${error.message}`,
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
 this.logger.error(` Error cancelling TBO hotel routes: ${error.message}`);
      throw new BadRequestException(
        `Failed to cancel VSR hotel routes: ${error.message}`,
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
