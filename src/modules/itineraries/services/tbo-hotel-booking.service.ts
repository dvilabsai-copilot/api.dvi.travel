import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotelSearchService } from '../../hotels/services/hotel-search.service';
import { TBOHotelProvider } from '../../hotels/providers/tbo-hotel.provider';
import axios, { AxiosInstance } from 'axios';
import {
  normalizePassengerTitle,
  resolveProviderPassengerTitle,
} from '../../../common/utils/passenger-title.util';

interface TboHotelSelection {
  hotelCode: string;
  bookingCode: string;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  numberOfRooms: number;
  guestNationality: string;
  netAmount: number;
  passengers: TboHotelPassenger[];
  occupancies?: TboRoomOccupancy[];
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
  };
}

@Injectable()
export class TboHotelBookingService {
  private static readonly MAX_ROOMS = 6;
  private static readonly MAX_ADULTS_PER_ROOM = 8;
  private static readonly MAX_CHILDREN_PER_ROOM = 4;
  private readonly logger = new Logger(TboHotelBookingService.name);
  private readonly client: AxiosInstance;

  private readonly TBO_USERNAME = process.env.TBO_API_USERNAME || 'Doview';
  private readonly TBO_PASSWORD = process.env.TBO_API_PASSWORD || 'Doview@12345';
  private readonly PREBOOK_URL = 'https://affiliate.tektravels.com/HotelAPI/PreBook';
  private readonly BOOK_URL = 'https://hotelbe.tektravels.com/hotelservice.svc/rest/book';
  private readonly USE_MOCK_TBO = process.env.TBO_USE_MOCK === 'true' || false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelSearchService: HotelSearchService,
    private readonly tboProvider: TBOHotelProvider,
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
      this.validateSelection(selection);
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

      const roomCount = this.resolveRoomCount(selection);

      // Keep payload backward compatible and include certification-safe occupancy metadata.
      const payload = {
        BookingCode: selection.bookingCode,
        PaymentMode: 'Limit',
        GuestNationality: this.normalizeNationality(selection.guestNationality),
        NoOfRooms: roomCount,
        PaxRooms: this.buildPaxRooms(selection),
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

      const bookingPayload = {
        BookingCode: preBookResponse.BookingCode || selection.bookingCode,
        IsVoucherBooking: false,
        GuestNationality: this.normalizeNationality(selection.guestNationality),
        EndUserIp: endUserIp,
        RequestedBookingMode: 1,
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
      let cursor = 0;

      for (let i = 0; i < occupancies.length; i++) {
        const occ = occupancies[i];
        const needed = (occ.adults || 0) + (occ.children || 0);
        const roomPassengers = workingPassengers.slice(cursor, cursor + needed);
        cursor += needed;

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
      Title: resolveProviderPassengerTitle(p.title),
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
      const childAges = this.getChildAgesFromSelection(selection);
      const passengerSnapshot = selection.passengers.map((p) => ({
        title: resolveProviderPassengerTitle(p.title),
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
            persistenceSnapshot: {
              childAges,
              passengerSnapshot,
              prebookAmount: preBookMeta?.finalPrice ?? null,
              bookedAmount: selection.netAmount,
              cancellationPolicy: preBookMeta?.cancellationPolicyText ?? null,
              rateConditions: preBookMeta?.rateConditions || null,
              roomPromotions: preBookMeta?.roomPromotions || null,
              mandatorySupplements: preBookMeta?.mandatorySupplements || null,
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

    for (const { routeId, selection } of selections) {
      try {
        this.validateSelection(selection);

        // Step 1: PreBook the hotel
        const preBookResponse = await this.preBookHotel(selection);
        const preBookMeta = this.extractPreBookMeta(preBookResponse, selection);

        const priceChangedAtPreBook =
          preBookMeta?.finalPrice !== null &&
          preBookMeta?.finalPrice !== undefined &&
          Number(preBookMeta.finalPrice) !== Number(selection.netAmount);

        const shouldReconfirmPrice =
          priceChangedAtPreBook ||
          Boolean(preBookMeta?.isPriceChanged) ||
          Boolean(preBookMeta?.isCancellationPolicyChanged);

        // Step 2: Book the hotel with guest details
        const bookResponse = await this.bookHotel(
          preBookResponse,
          selection,
          endUserIp,
        );

        // Step 3: Save confirmation to database
        const savedConfirmation = await this.saveTboBookingConfirmation(
          confirmedPlanId,
          itineraryPlanId,
          routeId,
          selection.hotelCode,
          bookResponse,
          preBookResponse,
          preBookMeta,
          selection,
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
    const children = selection.passengers.filter((p) => p.paxType !== 1 && Number(p.age) <= 17).length;
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

  private validateSelection(selection: TboHotelSelection): void {
    const bookingCode = String(selection.bookingCode || '').trim();
    if (!bookingCode || !bookingCode.includes('!TB!')) {
      throw new BadRequestException(
        'This hotel session has expired or booking code is invalid. Please run a fresh hotel search and prebook again.',
      );
    }

    if (!selection.guestNationality || !/^[A-Z]{2}$/i.test(selection.guestNationality.trim())) {
      throw new BadRequestException('guestNationality must be a valid ISO-2 country code');
    }

    if (selection.numberOfRooms < 1 || selection.numberOfRooms > TboHotelBookingService.MAX_ROOMS) {
      throw new BadRequestException(
        `numberOfRooms must be between 1 and ${TboHotelBookingService.MAX_ROOMS}`,
      );
    }

    if (!selection.passengers || selection.passengers.length === 0) {
      throw new BadRequestException('At least one passenger is required for booking');
    }

    for (let i = 0; i < selection.passengers.length; i++) {
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

      if (passenger.paxType === 2 && (passenger.age < 0 || passenger.age > 17)) {
        throw new BadRequestException(`Child passenger age at index ${i} must be between 0 and 17`);
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

        const hasInvalidChildAge = ages.some((age) => Number(age) < 0 || Number(age) > 17);
        if (hasInvalidChildAge) {
          throw new BadRequestException(`childrenAges must be between 0 and 17 for occupancy index ${i}`);
        }
      }
    }
  }

  private isSessionExpiredError(errorText: string): boolean {
    return /session expired|stale|availability changed|booking code invalid|price changed|reference invalid|expired booking code|invalid token|token expired|bookcode expired|bookcode invalid|bookingcode expired|bookingcode invalid/i.test(
      errorText,
    );
  }

  private extractPreBookMeta(preBookResponse: PreBookResponse, selection: TboHotelSelection) {
    const rawRoomDetails = preBookResponse?.HotelRoomsDetails || [];
    const mandatorySupplements = rawRoomDetails
      .flatMap((room: any) => room?.MandatorySupplements || room?.MandatorySupplement || [])
      .filter(Boolean);
    const roomPromotions = rawRoomDetails
      .flatMap((room: any) => room?.RoomPromotion || room?.RoomPromotions || [])
      .filter(Boolean);
    const rateConditions = rawRoomDetails
      .flatMap((room: any) => room?.RateConditions || [])
      .filter(Boolean);
    const cancellationPolicies = rawRoomDetails
      .flatMap((room: any) => room?.CancelPolicies || room?.CancellationPolicy || [])
      .filter(Boolean);

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
      mandatorySupplements,
      rawStatus: preBookResponse?.Status,
    };
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
      // Find all active TBO bookings for this itinerary
      const bookings = await this.prisma.tbo_hotel_booking_confirmation.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          status: 1,
          deleted: 0,
        },
      });

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

      // Find TBO bookings for specified routes
      const bookings = await this.prisma.tbo_hotel_booking_confirmation.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: { in: routeIds },
          status: 1,
          deleted: 0,
        },
      });

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
}
